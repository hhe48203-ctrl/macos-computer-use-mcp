// Shared fixtures for broker tests: a fake Swift helper process and raw broker clients.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { HostBroker, createPolicy } from '../src/broker.mjs';
import { RemoteBridge } from '../src/remote-bridge.mjs';
import * as protocol from '../src/broker-protocol.mjs';

// cursor_hide hangs, request_permissions crashes, focus fails; other methods echo the helper PID.
const helperSource = `
const fs=require('node:fs');const log=m=>fs.appendFileSync(process.env.CU_FAKE_LOG,m+' '+process.pid+'\\n');log('start');
process.on('SIGTERM',()=>{
  log('sigterm');
  const delay=Number(process.env.CU_FAKE_SHUTDOWN_DELAY_MS);
  if(delay>0)setTimeout(()=>process.exit(0),delay);
  else process.exit(0);
});
require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);log('call:'+r.method);
  if(r.method==='cursor_hide')return;
  if(r.method==='request_permissions')process.exit(3);
  const reply=r.method==='focus'?{error:{code:'EXPECTED',message:'fixture'}}:{result:r.method==='windows'?{windows:[]}:r.method==='apps'?{apps:[]}:{method:r.method,pid:process.pid,params:r.params}};
  console.log(JSON.stringify({id:r.id,...reply}));});`;

export const token = protocol.createToken();
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(predicate, timeoutMs = 4000, message = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) { if (Date.now() > deadline) throw Error(`Timed out waiting for ${message}`); await sleep(20); }
}
export const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export async function startBroker({ helperTimeoutMs = 30000, helperShutdownDelayMs = 0, deny = [], ...options } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cu-broker-test-'));
  const executable = path.join(dir, 'helper');
  const log = path.join(dir, 'helper.log');
  writeFileSync(executable, `#!${process.execPath}\n${helperSource}`, { mode: 0o700 });
  const bridge = new Bridge({ executable, env: {
    ...process.env, CU_FAKE_LOG: log, CU_FAKE_SHUTDOWN_DELAY_MS: String(helperShutdownDelayMs)
  }, timeoutMs: helperTimeoutMs });
  const broker = new HostBroker({ token, bridge, policy: createPolicy({ deny }), ...options });
  const { port } = await broker.listen();
  const events = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => l.split(' ')) : [];
  return {
    broker, port, bridge, events, log, url: `tcp://127.0.0.1:${port}`,
    client: (extra = {}) => new RemoteBridge({ url: `tcp://127.0.0.1:${port}`, token, ...extra }),
    helperPids: () => events().filter(([e]) => e === 'start').map(([, pid]) => Number(pid)),
    async close() { await broker.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

/** A hand-driven client that can break the protocol in ways RemoteBridge never does. */
export function rawClient(port, { authenticate = true, secret = token } = {}) {
  const socket = net.connect({ port, host: '127.0.0.1' });
  const frames = []; let waiters = [];
  const clientNonce = protocol.createNonce();
  let closed = false;
  const deliver = () => { for (const w of waiters) w(); waiters = []; };
  socket.on('data', protocol.lineReader(() => 1 << 26, line => {
    const message = JSON.parse(line);
    if (message.type === 'challenge' && authenticate) socket.write(protocol.frame({ type: 'auth', version: 1, nonce: clientNonce, proof: protocol.proof(secret, 'client', message.nonce, clientNonce) }));
    frames.push(message); deliver();
  }, () => {}));
  socket.on('error', () => {});
  socket.on('close', () => { closed = true; deliver(); });
  return {
    socket, frames, get closed() { return closed; },
    send: value => socket.write(typeof value === 'string' ? value : protocol.frame(value)),
    async next(predicate, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = frames.find(predicate);
        if (found) return found;
        if (closed || Date.now() > deadline) return undefined;
        await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 50); });
      }
    },
    async waitClosed(timeoutMs = 4000) { await until(() => closed, timeoutMs, 'socket close'); }
  };
}
