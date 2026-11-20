import net from 'node:net';
import { NativeError } from './bridge.mjs';
import * as protocol from './broker-protocol.mjs';

const fault = (code, message) => new NativeError(code, message);
const lost = 'take a new snapshot. No action was retried.';

/**
 * Container-side drop-in for Bridge. One authenticated broker connection stands
 * in for the helper's stdio pipes: closing it retires the host helper, and the
 * next request opens a fresh session, exactly as a respawned child would.
 */
export class RemoteBridge {
  static fromEnvironment(env = process.env, options = {}) {
    const { CU_BROKER_URL: url, CU_BROKER_TOKEN: token } = env;
    // Keep the secret out of the REPL worker's copied environment.
    delete env.CU_BROKER_TOKEN;
    return new RemoteBridge({ url, token, ...options });
  }
  constructor({ url, token, timeoutMs = 35000, connectTimeoutMs = 5000, retireMs = 3000, maxFrameBytes = 128 * 1024 * 1024 } = {}) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'tcp:' || !parsed.hostname || !parsed.port) throw Error();
      this.host = parsed.hostname.replace(/^\[|\]$/g, '');
      this.port = Number(parsed.port);
    } catch { this.configError = fault('BROKER_CONFIG', 'CU_BROKER_URL must look like tcp://host.docker.internal:47123'); }
    if (!protocol.validToken(token)) this.configError ??= fault('BROKER_CONFIG', 'CU_BROKER_TOKEN is missing or invalid');
    this.token = token;
    Object.assign(this, { timeoutMs, connectTimeoutMs, retireMs, maxFrameBytes });
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.socket = null;
    this.connecting = null;
    this.session = null;
    this.pending = null;
    this.closed = false;
    this.generation = 0;
    this.retiring = Promise.resolve();
  }
  async start() {
    if (this.closed) throw fault('BRIDGE_CLOSED', 'The bridge is closed');
    if (this.socket) return;
    if (this.configError) throw this.configError;
    await this.#open();
  }
  #open() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      const clientNonce = protocol.createNonce();
      let brokerNonce, settled = false;
      const fail = error => {
        if (settled) return false;
        settled = true; clearTimeout(timer);
        if (this.connecting?.socket === socket) this.connecting = null;
        socket.destroy(); reject(error);
        return false;
      };
      const timer = setTimeout(() => fail(fault('BROKER_UNAVAILABLE', 'Host broker handshake timed out')), this.connectTimeoutMs);
      this.connecting = { socket, fail };
      socket.on('data', protocol.lineReader(() => settled ? this.maxFrameBytes : protocol.handshakeFrameBytes, line => {
        if (settled) return this.#receive(socket, line);
        const message = protocol.parse(line);
        if (!brokerNonce) {
          if (message?.type !== 'challenge' || message.version !== protocol.protocolVersion || !protocol.validNonce(message.nonce)) return fail(fault('BROKER_PROTOCOL', 'Unexpected host broker greeting'));
          brokerNonce = message.nonce;
          socket.write(protocol.frame({ type: 'auth', version: protocol.protocolVersion, nonce: clientNonce, proof: protocol.proof(this.token, 'client', brokerNonce, clientNonce) }));
          return true;
        }
        if (message?.type === 'revoked') return fail(fault(protocol.wireError(message.error).code, protocol.wireError(message.error).message));
        if (message?.type !== 'ready' || !protocol.sameProof(message.proof, protocol.proof(this.token, 'broker', brokerNonce, clientNonce))) {
          return fail(fault('BROKER_AUTH_FAILED', 'Host broker failed mutual authentication'));
        }
        settled = true; clearTimeout(timer); this.connecting = null;
        this.#attach(socket, message);
        resolve();
        return true;
      }, () => settled ? this.#drop(socket, fault('INVALID_NATIVE_RESPONSE', 'Host broker frame exceeded its size limit')) : fail(fault('BROKER_PROTOCOL', 'Oversized host broker handshake'))));
      socket.on('error', error => { if (!settled) fail(fault('BROKER_UNAVAILABLE', `Host broker unavailable: ${error.message}`)); });
      socket.on('close', () => {
        if (!settled) fail(fault('BROKER_UNAVAILABLE', 'Host broker closed the connection during the handshake'));
        else this.#drop(socket, fault('BROKER_DISCONNECTED', `Host broker connection closed; native session ended. ${lost}`));
      });
    });
  }
  #attach(socket, ready) {
    this.socket = socket;
    this.session = typeof ready.session === 'string' ? ready.session : null;
    this.lastSeen = Date.now();
    const leaseMs = Number.isFinite(ready.leaseMs) ? Math.min(Math.max(ready.leaseMs, 200), 120000) : 10000;
    const heartbeatMs = Number.isFinite(ready.heartbeatMs) ? Math.min(Math.max(ready.heartbeatMs, 50), leaseMs / 2) : leaseMs / 4;
    this.heartbeat = setInterval(() => {
      if (this.socket !== socket) return;
      if (Date.now() - this.lastSeen > leaseMs) this.stop(fault('BROKER_UNRESPONSIVE', `Host broker sent nothing for ${leaseMs} ms; native session ended. ${lost}`));
      else socket.write(protocol.frame({ type: 'ping' }));
    }, heartbeatMs);
    this.heartbeat.unref();
  }
  #drop(socket, error) {
    if (this.socket === socket) this.stop(error);
    return false;
  }
  #receive(socket, line) {
    if (this.socket !== socket) return false;
    this.lastSeen = Date.now();
    const message = protocol.parse(line);
    if (!message) return this.#drop(socket, fault('INVALID_NATIVE_RESPONSE', 'Host broker returned invalid JSON'));
    if (message.type === 'pong') return true;
    if (message.type === 'revoked') {
      const { code, message: text } = protocol.wireError(message.error);
      return this.#drop(socket, fault(code, text));
    }
    const pending = this.pending;
    if (!pending || pending.id !== message.id) return this.#drop(socket, fault('INVALID_NATIVE_RESPONSE', 'Native response ID mismatch'));
    this.pending = null;
    clearTimeout(pending.timer);
    if (message.error) {
      const { code, message: text } = protocol.wireError(message.error);
      pending.reject(fault(code, text));
    }
    else if (message.result && typeof message.result === 'object') pending.resolve(message.result);
    else pending.reject(fault('INVALID_NATIVE_RESPONSE', 'Native response has no result'));
    return true;
  }
  stop(error = fault('BRIDGE_STOPPED', 'Native bridge stopped; take a fresh snapshot')) {
    const socket = this.socket;
    if (socket || this.pending) this.generation++;
    this.socket = null;
    this.session = null;
    clearInterval(this.heartbeat);
    this.connecting?.fail(error);
    if (this.pending) {
      const pending = this.pending; this.pending = null;
      clearTimeout(pending.timer); pending.reject(error);
    }
    // The broker closes its side after helper exit on graceful release.
    // A local socket deadline or transport failure can close this side sooner.
    if (socket && !socket.destroyed) {
      this.retiring = new Promise(resolve => {
        const timer = setTimeout(() => socket.destroy(), this.retireMs);
        timer.unref();
        socket.once('close', () => { clearTimeout(timer); resolve(); });
        socket.end(protocol.frame({ type: 'release' }));
      });
    }
  }
  request(method, params = {}, { signal } = {}) {
    const generation = this.generation;
    const run = async () => {
      await this.retiring;
      if (signal?.aborted) throw fault('CANCELLED', 'Cancelled before execution');
      if (generation !== this.generation) throw fault('SESSION_CHANGED', 'Helper session changed; retry after observing fresh state');
      await this.start();
      if (signal?.aborted) throw fault('CANCELLED', 'Cancelled before execution');
      if (generation !== this.generation || !this.socket) throw fault('SESSION_CHANGED', 'Helper session changed; retry after observing fresh state');
      return new Promise((resolve, reject) => {
        const id = this.nextId++;
        const abort = () => this.stop(fault('CANCELLED', 'Cancelled; native helper stopped. Action may have partially completed. Observe before retrying.'));
        const done = (fn, value) => { signal?.removeEventListener('abort', abort); fn(value); };
        const timer = setTimeout(() => this.stop(fault('NATIVE_TIMEOUT', 'Native operation timed out; helper stopped. Action may have partially completed. Observe before retrying.')), this.timeoutMs);
        this.pending = { id, timer, resolve: value => done(resolve, value), reject: error => done(reject, error) };
        signal?.addEventListener('abort', abort, { once: true });
        this.socket.write(protocol.frame({ id, method, params }));
      });
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }
  close() { this.closed = true; this.stop(fault('BRIDGE_CLOSED', 'Server closed')); }
}
