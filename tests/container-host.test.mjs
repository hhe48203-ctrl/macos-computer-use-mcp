import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerRunArguments, defaultImage } from '../src/container-host.mjs';

test('docker run arguments lock down the container and never put the token on argv', () => {
  const args = dockerRunArguments({ port: 47123, name: 'cu-mcp-test' });
  assert.equal(args[0], 'run');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes('--cap-drop'));
  assert.ok(args.includes('ALL'));
  assert.ok(args.includes('no-new-privileges'));
  assert.ok(args.includes('--user'));
  assert.ok(args.includes('node'));
  assert.ok(args.includes('--tmpfs'));
  assert.ok(args.some(a => a.startsWith('/tmp:')));
  assert.ok(args.includes('--pids-limit'));
  assert.ok(args.includes('--memory'));
  assert.ok(args.includes(`CU_BROKER_URL=tcp://host.docker.internal:47123`));
  assert.ok(args.includes('CU_BROKER_TOKEN'));
  assert.equal(args.includes('-v'), false);
  assert.equal(args.includes('--volume'), false);
  assert.equal(args.includes('--mount'), false);
  assert.equal(args.includes('--privileged'), false);
  assert.ok(!args.some(a => /CU_BROKER_TOKEN=/.test(a)), 'token value must not appear on the docker argv');
  assert.equal(args.at(-1), defaultImage);
});

test('docker run arguments reject bad ports and names', () => {
  assert.throws(() => dockerRunArguments({ port: 0, name: 'ok' }));
  assert.throws(() => dockerRunArguments({ port: 47123, name: '../escape' }));
  assert.throws(() => dockerRunArguments({ port: 47123, name: '' }));
});
