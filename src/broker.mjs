#!/usr/bin/env node
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Bridge, NativeError } from './bridge.mjs';
import { tools } from './tools.mjs';
import * as protocol from './broker-protocol.mjs';

const fault = (code, message) => new NativeError(code, message);
const target = { pid: z.number().int().positive(), windowId: z.number().int().positive() };
const empty = z.object({}).strict();

/** Every native method the JS API issues, with the host-side schema it must pass. */
export const brokerMethods = new Map([
  ...tools.map(t => [t.method, t.schema]),
  ['cursor', z.object({ ...target, x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() }).strict()],
  ['cursor_state', empty],
  ['cursor_hide', empty],
]);

export function createPolicy({ deny = [] } = {}) {
  const denied = new Set(deny);
  for (const method of denied) if (!brokerMethods.has(method)) throw fault('INVALID_POLICY', `Unknown method in broker deny list: ${method}`);
  return Object.freeze({
    denied: Object.freeze([...denied]),
    check(method, params) {
      if (typeof method !== 'string' || !brokerMethods.has(method) || denied.has(method)) {
        throw fault('METHOD_NOT_ALLOWED', `Host broker policy rejects native method ${JSON.stringify(String(method).slice(0, 64))}`);
      }
      const parsed = brokerMethods.get(method).safeParse(params ?? {});
      if (!parsed.success) throw fault('INVALID_ARGUMENT', parsed.error.issues.map(i => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ').slice(0, 1000));
      return parsed.data;
    }
  });
}

/**
 * Host side of the container split. It owns the only Swift helper, accepts one
 * authenticated session at a time and ties the helper's lifetime to it. Session
 * revocation stops the helper with the same SIGTERM/SIGKILL path as local use.
 */
export class HostBroker {
  constructor({ token, bridge = new Bridge(), host = '127.0.0.1', port = 0, policy = createPolicy(), heartbeatMs = 2000, leaseMs = 10000,
    authTimeoutMs = 3000, maxFrameBytes = 2 * 1024 * 1024, maxHandshakes = 8, log = () => {} } = {}) {
    if (!protocol.validToken(token)) throw fault('BROKER_CONFIG', 'Broker token must be 32 to 512 characters');
    Object.assign(this, { token, bridge, host, port, policy, heartbeatMs, leaseMs, authTimeoutMs, maxFrameBytes, maxHandshakes, log });
    this.active = null;
    this.handshakes = new Set();
    this.connections = new Set();
    this.closed = false;
    this.server = net.createServer({ allowHalfOpen: true }, socket => this.#accept(socket));
    this.server.on('error', error => this.log(`broker server error: ${error.message}`));
  }
  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ host: this.host, port: this.port, exclusive: true }, () => {
        this.server.off('error', reject);
        this.lease = setInterval(() => this.#expire(), Math.max(50, Math.min(this.heartbeatMs, this.leaseMs / 2)));
        this.lease.unref();
        const { address, port } = this.server.address();
        resolve({ host: address, port });
      });
    });
  }
  get session() { return this.active ? { id: this.active.id, pending: this.active.pending } : null; }
  async close() {
    if (this.closed) return this.bridge.retiring;
    this.closed = true;
    clearInterval(this.lease);
    if (this.active) this.#revoke(this.active, fault('BROKER_CLOSED', 'Host broker stopped; native session ended'));
    const stopped = new Promise(resolve => this.server.close(() => resolve()));
    for (const connection of this.connections) if (!connection.session) connection.socket.destroy();
    this.bridge.close();
    await this.bridge.retiring;
    for (const connection of this.connections) connection.socket.destroy();
    await stopped;
  }
  #accept(socket) {
    if (this.closed || this.handshakes.size >= this.maxHandshakes) { socket.destroy(); return; }
    socket.setNoDelay(true);
    const connection = { socket, nonce: protocol.createNonce(), session: null };
    this.handshakes.add(connection);
    this.connections.add(connection);
    connection.timer = setTimeout(() => this.#refuse(connection, fault('AUTH_TIMEOUT', 'Broker handshake timed out')), this.authTimeoutMs);
    socket.on('data', protocol.lineReader(
      () => connection.session ? this.maxFrameBytes : protocol.handshakeFrameBytes,
      line => this.#receive(connection, line),
      () => connection.session ? this.#revoke(connection.session, fault('FRAME_TOO_LARGE', 'Broker request frame exceeded its size limit')) : socket.destroy()
    ));
    socket.on('error', () => {});
    const disconnect = () => {
      if (connection.session) this.#revoke(connection.session, fault('SESSION_DISCONNECTED', 'Container connection closed; native work stopped'), { notify: false });
    };
    // Hold our side open until retirement when the client sends release and FIN.
    // A bare FIN must also revoke the session now that Node no longer closes both sides.
    socket.on('end', () => {
      if (!connection.session) socket.destroy();
      else disconnect();
    });
    socket.on('close', () => {
      clearTimeout(connection.timer);
      this.handshakes.delete(connection);
      this.connections.delete(connection);
      disconnect();
    });
    socket.write(protocol.frame({ type: 'challenge', version: protocol.protocolVersion, nonce: connection.nonce }));
  }
  #refuse(connection, error) {
    clearTimeout(connection.timer);
    this.handshakes.delete(connection);
    if (!connection.socket.destroyed) connection.socket.end(protocol.frame({ type: 'revoked', error: protocol.wireError(error) }));
    setTimeout(() => connection.socket.destroy(), 500).unref();
    return false;
  }
  #receive(connection, line) {
    const message = protocol.parse(line);
    if (!connection.session) return this.#authenticate(connection, message);
    const session = connection.session;
    if (session.revoked) return false;
    session.lastSeen = Date.now();
    if (message?.type === 'ping') { this.#send(session, { type: 'pong' }); return true; }
    if (message?.type === 'release') { this.#revoke(session, fault('SESSION_RELEASED', 'Container released the native session'), { notify: false }); return false; }
    if (message && message.type === undefined && 'id' in message && 'method' in message) { void this.#request(session, message); return !session.revoked; }
    this.#revoke(session, fault('PROTOCOL_VIOLATION', 'Unexpected broker frame'));
    return false;
  }
  #authenticate(connection, message) {
    if (message?.type !== 'auth') { connection.socket.destroy(); return false; }
    if (message.version !== protocol.protocolVersion) return this.#refuse(connection, fault('PROTOCOL_VERSION', `Broker speaks protocol ${protocol.protocolVersion}`));
    if (!protocol.validNonce(message.nonce) || !protocol.sameProof(message.proof, protocol.proof(this.token, 'client', connection.nonce, message.nonce))) {
      this.log('rejected an unauthenticated broker connection');
      return this.#refuse(connection, fault('AUTH_FAILED', 'Broker authentication failed'));
    }
    if (this.closed) return this.#refuse(connection, fault('BROKER_CLOSED', 'Host broker is stopping'));
    if (this.active) return this.#refuse(connection, fault('BROKER_BUSY', `Another native session is active; it ends when that container disconnects or misses heartbeats for ${this.leaseMs} ms`));
    clearTimeout(connection.timer);
    this.handshakes.delete(connection);
    const session = { id: randomUUID(), connection, controller: new AbortController(), lastSeen: Date.now(), lastId: 0, pending: null, revoked: false };
    connection.session = session;
    this.active = session;
    this.log(`session ${session.id} started`);
    this.#send(session, { type: 'ready', version: protocol.protocolVersion, session: session.id, heartbeatMs: this.heartbeatMs, leaseMs: this.leaseMs,
      proof: protocol.proof(this.token, 'broker', connection.nonce, message.nonce) });
    return true;
  }
  async #request(session, message) {
    const { id, method, params } = message;
    if (!Number.isSafeInteger(id) || id <= session.lastId) return this.#revoke(session, fault('STALE_REQUEST', 'Native request ID was replayed or out of order; session revoked'));
    if (session.pending !== null) return this.#revoke(session, fault('PROTOCOL_VIOLATION', 'Only one native request may be outstanding; session revoked'));
    session.lastId = id;
    let checked;
    try { checked = this.policy.check(method, params); }
    catch (error) { this.#send(session, { id, error: protocol.wireError(error) }); return; }
    session.pending = id;
    const generation = this.bridge.generation;
    try {
      const result = await this.bridge.request(method, checked, { signal: session.controller.signal });
      if (!session.revoked) this.#send(session, { id, result });
    } catch (error) {
      if (session.revoked) return;
      // The helper stopped (timeout, exit, malformed output): its AX references died with it.
      if (this.bridge.generation !== generation) this.#revoke(session, error);
      else this.#send(session, { id, error: protocol.wireError(error) });
    } finally { session.pending = null; }
  }
  #send(session, value) {
    const { socket } = session.connection;
    if (!socket.destroyed && socket.writable) socket.write(protocol.frame(value));
  }
  #revoke(session, error, { notify = true } = {}) {
    if (session.revoked) return false;
    session.revoked = true;
    if (this.active === session) this.active = null;
    this.log(`session ${session.id} revoked: ${error.code}`);
    // The session owns the helper. Stopping it retires in-flight native work and its AX references.
    this.bridge.stop(error);
    session.controller.abort();
    if (notify) this.#send(session, { type: 'revoked', error: protocol.wireError(error) });
    const { socket } = session.connection;
    void Promise.resolve(this.bridge.retiring).then(() => {
      if (!socket.destroyed) socket.end();
      setTimeout(() => socket.destroy(), 1000).unref();
    });
    return false;
  }
  #expire() {
    const session = this.active;
    if (session && Date.now() - session.lastSeen > this.leaseMs) {
      this.#revoke(session, fault('SESSION_EXPIRED', `No heartbeat from the container for ${this.leaseMs} ms; native work stopped`));
    }
  }
}

export function readOrCreateToken(file) {
  if (existsSync(file)) {
    const token = readFileSync(file, 'utf8').trim();
    if (!protocol.validToken(token)) throw fault('BROKER_CONFIG', `${file} does not hold a valid broker token`);
    return token;
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const token = protocol.createToken();
  writeFileSync(file, token + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
  return token;
}

export function parseBrokerArguments(argv, env = process.env) {
  const options = { port: Number(env.CU_BROKER_PORT ?? 47123), tokenFile: env.CU_BROKER_TOKEN_FILE, deny: (env.CU_BROKER_DENY_METHODS ?? '').split(',').filter(Boolean) };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--port') { options.port = Number(value); i++; }
    else if (flag === '--token-file') { options.tokenFile = value; i++; }
    else if (flag === '--deny') { options.deny = value.split(',').filter(Boolean); i++; }
    else throw fault('INVALID_ARGUMENT', `Unknown broker argument: ${flag}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw fault('INVALID_ARGUMENT', 'Broker --port must be 1..65535');
  if (!options.tokenFile) throw fault('INVALID_ARGUMENT', 'Standalone broker requires --token-file or CU_BROKER_TOKEN_FILE');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const options = parseBrokerArguments(process.argv.slice(2));
  const log = text => process.stderr.write(`[broker] ${text}\n`);
  const broker = new HostBroker({ token: readOrCreateToken(options.tokenFile), port: options.port, policy: createPolicy({ deny: options.deny }), log });
  const { host, port } = await broker.listen();
  log(`listening on ${host}:${port}; containers use CU_BROKER_URL=tcp://host.docker.internal:${port} and the token in ${options.tokenFile}`);
  const shutdown = () => void broker.close().finally(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
