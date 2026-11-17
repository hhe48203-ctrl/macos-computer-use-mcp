import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CuaRepl } from '../src/repl.mjs';
import { createPolicy, readOrCreateToken, parseBrokerArguments, brokerMethods } from '../src/broker.mjs';
import { defaultBridge } from '../src/server.mjs';
import { RemoteBridge } from '../src/remote-bridge.mjs';
import { Bridge } from '../src/bridge.mjs';
import * as protocol from '../src/broker-protocol.mjs';
import { startBroker, rawClient, alive, until, token } from './broker-fixture.mjs';

test('mutual auth rejects a wrong token and accepts a matching RemoteBridge', async () => {
  const fx = await startBroker();
  try {
    const bad = rawClient(fx.port, { secret: protocol.createToken() });
    const revoked = await bad.next(m => m.type === 'revoked');
    assert.equal(revoked.error.code, 'AUTH_FAILED');
    await bad.waitClosed();

    const client = fx.client();
    assert.deepEqual(await client.request('apps'), { apps: [] });
    assert.ok(fx.helperPids().length >= 1);
    client.close();
    await fx.bridge.retiring;
  } finally { await fx.close(); }
});

test('only one authenticated session is active; a second client gets BROKER_BUSY', async () => {
  const fx = await startBroker();
  try {
    const first = fx.client();
    await first.start();
    const second = rawClient(fx.port);
    const revoked = await second.next(m => m.type === 'revoked');
    assert.equal(revoked.error.code, 'BROKER_BUSY');
    assert.deepEqual(await first.request('windows'), { windows: [] });
    first.close();
    await fx.bridge.retiring;
  } finally { await fx.close(); }
});

test('policy deny and schema validation stay on the host and never reach the helper', async () => {
  const fx = await startBroker({ deny: ['focus'] });
  try {
    const client = fx.client();
    await assert.rejects(client.request('focus', { pid: 1, windowId: 1 }), { code: 'METHOD_NOT_ALLOWED' });
    await assert.rejects(client.request('click', { pid: 1 }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(client.request('not_a_method', {}), { code: 'METHOD_NOT_ALLOWED' });
    assert.equal(fx.events().filter(([e]) => e.startsWith('call:')).length, 0);
    assert.deepEqual(await client.request('apps'), { apps: [] });
    client.close();
  } finally { await fx.close(); }
});

test('cancel and timeout stop the helper with SIGTERM and fence queued work', async () => {
  const fx = await startBroker({ helperTimeoutMs: 400 });
  try {
    const client = fx.client({ timeoutMs: 400 });
    const controller = new AbortController();
    const hanging = client.request('cursor_hide', {}, { signal: controller.signal });
    await until(() => fx.events().some(([e]) => String(e).includes('cursor_hide')), 4000, 'hanging call');
    controller.abort();
    await assert.rejects(hanging, { code: 'CANCELLED' });
    await until(() => fx.events().some(([e]) => e === 'sigterm'), 4000, 'helper SIGTERM after cancel');
    const [pid] = fx.helperPids().slice(-1);
    await until(() => !alive(pid), 4000, 'helper exit after cancel');

    const timed = fx.client({ timeoutMs: 200 });
    const results = await Promise.allSettled([
      timed.request('cursor_hide'),
      timed.request('apps'),
    ]);
    assert.equal(results[0].reason.code, 'NATIVE_TIMEOUT');
    assert.equal(results[1].reason.code, 'SESSION_CHANGED');
    await until(() => fx.events().filter(([e]) => e === 'sigterm').length >= 2, 4000, 'second SIGTERM');
    timed.close();
  } finally { await fx.close(); }
});

test('explicit release revokes the session and kills in-flight native work', async () => {
  const fx = await startBroker();
  try {
    const client = fx.client();
    const pending = client.request('cursor_hide');
    await until(() => fx.events().some(([e]) => String(e).includes('cursor_hide')), 4000, 'helper saw cursor_hide');
    const before = fx.helperPids().at(-1);
    assert.ok(alive(before));
    client.stop();
    await assert.rejects(pending, error => ['CANCELLED', 'BRIDGE_STOPPED', 'SESSION_RELEASED', 'BROKER_DISCONNECTED'].includes(error.code));
    await until(() => !alive(before), 4000, 'helper exit after release');
    assert.equal(fx.broker.session, null);

    const next = fx.client();
    assert.deepEqual(await next.request('apps'), { apps: [] });
    const after = fx.helperPids().at(-1);
    assert.notEqual(after, before);
    next.close();
  } finally { await fx.close(); }
});

test('a connection closing without release retires an in-flight helper', async () => {
  const fx = await startBroker({ leaseMs: 20000 });
  try {
    const raw = rawClient(fx.port);
    assert.ok(await raw.next(m => m.type === 'ready'));
    raw.send({ id: 1, method: 'cursor_hide', params: {} });
    await until(() => fx.events().some(([e]) => e === 'call:cursor_hide'));
    const pid = fx.helperPids().at(-1);
    assert.ok(alive(pid));
    raw.socket.destroy();
    await until(() => !alive(pid), 4000, 'helper exit before lease expiry');
    assert.equal(fx.broker.session, null);
  } finally { await fx.close(); }
});

test('lease expiry without heartbeats stops native work without an explicit cancel', async () => {
  const fx = await startBroker({ heartbeatMs: 100, leaseMs: 800 });
  try {
    const raw = rawClient(fx.port);
    await raw.next(m => m.type === 'ready');
    raw.send({ id: 1, method: 'cursor_hide', params: {} });
    await until(() => fx.events().some(([e]) => String(e).includes('cursor_hide')), 4000, 'hanging call accepted');
    const before = fx.helperPids().at(-1);
    assert.ok(alive(before));
    // Stay silent (no pings). The host lease must retire the helper without an explicit cancel.
    await until(() => fx.broker.session === null, 4000, 'lease expiry');
    await until(() => !alive(before), 4000, 'helper killed after lease expiry');
    assert.ok(raw.frames.some(m => m.type === 'revoked' && m.error?.code === 'SESSION_EXPIRED'));
    await raw.waitClosed();
  } finally { await fx.close(); }
});

test('helper crash revokes the broker session; a fresh client can observe again', async () => {
  const fx = await startBroker();
  try {
    const client = fx.client();
    await assert.rejects(client.request('request_permissions'), { code: 'BRIDGE_EXITED' });
    await until(() => fx.broker.session === null, 4000, 'session cleared after helper exit');
    const next = fx.client();
    assert.deepEqual(await next.request('apps'), { apps: [] });
    next.close();
  } finally { await fx.close(); }
});

test('stale request ids revoke the session', async () => {
  const fx = await startBroker();
  try {
    const raw = rawClient(fx.port);
    await raw.next(m => m.type === 'ready');
    raw.send({ id: 2, method: 'apps', params: {} });
    assert.ok(await raw.next(m => m.id === 2 && m.result));
    raw.send({ id: 1, method: 'apps', params: {} });
    const revoked = await raw.next(m => m.type === 'revoked');
    assert.equal(revoked.error.code, 'STALE_REQUEST');
    await raw.waitClosed();
  } finally { await fx.close(); }
});

test('a second outstanding request revokes the session before reaching the helper', async () => {
  const fx = await startBroker();
  try {
    const raw = rawClient(fx.port);
    assert.ok(await raw.next(m => m.type === 'ready'));
    raw.send({ id: 1, method: 'cursor_hide', params: {} });
    await until(() => fx.events().some(([e]) => e === 'call:cursor_hide'));
    const pid = fx.helperPids().at(-1);
    raw.send({ id: 2, method: 'apps', params: {} });
    const revoked = await raw.next(m => m.type === 'revoked');
    assert.equal(revoked?.error.code, 'PROTOCOL_VIOLATION');
    await raw.waitClosed();
    await until(() => !alive(pid), 4000, 'helper exit after protocol violation');
    assert.ok(!fx.events().some(([e]) => e === 'call:apps'));
  } finally { await fx.close(); }
});

test('CuaRepl reset waits for host helper exit over a graceful broker release', async () => {
  const fx = await startBroker({ helperShutdownDelayMs: 400 });
  const runtime = new CuaRepl(fx.client());
  try {
    assert.ok(!(await runtime.execute('await cua.listApps({emit:false})')).isError);
    const pid = fx.helperPids().at(-1);
    assert.ok(alive(pid));
    await runtime.reset();
    assert.ok(!alive(pid), 'reset returned before the host helper exited');
    assert.equal(fx.broker.session, null);
    assert.ok(!(await runtime.execute('await cua.listApps({emit:false})')).isError);
    assert.notEqual(fx.helperPids().at(-1), pid);
  } finally {
    await runtime.close();
    await fx.close();
  }
});

test('CuaRepl timeout and reset through RemoteBridge preserve the Bridge lifecycle contract', async () => {
  const fx = await startBroker({ helperTimeoutMs: 30000 });
  try {
    const bridge = fx.client({ timeoutMs: 35000 });
    const runtime = new CuaRepl(bridge);
    try {
      const ok = await runtime.execute('await cua.listApps({emit:false})');
      assert.ok(!ok.isError);
      const timed = await runtime.execute('await new Promise(()=>{})', { timeoutMs: 120 });
      assert.equal(timed.structuredContent.error.code, 'JS_TIMEOUT');
      await until(() => fx.events().some(([e]) => e === 'sigterm') || fx.broker.session === null, 4000, 'reset path stopped helper');
      const again = await runtime.execute('await cua.listApps({emit:false})');
      assert.ok(!again.isError);
      await runtime.reset();
    } finally { await runtime.close(); }
  } finally { await fx.close(); }
});

test('defaultBridge selects RemoteBridge only when CU_BROKER_URL is set and strips the token', () => {
  assert.ok(defaultBridge({}) instanceof Bridge);
  const env = { CU_BROKER_URL: 'tcp://127.0.0.1:9', CU_BROKER_TOKEN: token };
  const remote = defaultBridge(env);
  assert.ok(remote instanceof RemoteBridge);
  assert.equal(env.CU_BROKER_TOKEN, undefined);
});

test('brokerMethods covers every JS-facing native method the host must re-validate', () => {
  assert.ok(brokerMethods.has('apps'));
  assert.ok(brokerMethods.has('snapshot'));
  assert.ok(brokerMethods.has('cursor_hide'));
  assert.throws(() => createPolicy({ deny: ['not-real'] }), { code: 'INVALID_POLICY' });
});

test('token files are created mode 0600 and CLI parsing requires a token file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cu-token-'));
  try {
    const file = path.join(dir, 'token');
    const created = readOrCreateToken(file);
    assert.ok(protocol.validToken(created));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readOrCreateToken(file), created);
    assert.throws(() => parseBrokerArguments([]), { code: 'INVALID_ARGUMENT' });
    assert.deepEqual(parseBrokerArguments(['--token-file', file, '--port', '47001', '--deny', 'focus']), {
      port: 47001, tokenFile: file, deny: ['focus']
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('protocol helpers keep proofs role-bound and frames newline-delimited', () => {
  const a = protocol.createNonce(), b = protocol.createNonce();
  const client = protocol.proof(token, 'client', a, b);
  const broker = protocol.proof(token, 'broker', a, b);
  assert.notEqual(client, broker);
  assert.ok(protocol.sameProof(client, protocol.proof(token, 'client', a, b)));
  assert.equal(protocol.sameProof(client, broker), false);
  assert.equal(protocol.frame({ ok: true }), '{"ok":true}\n');
  assert.equal(protocol.parse('{"ok":true}').ok, true);
  assert.equal(protocol.parse('["no"]'), undefined);
});
