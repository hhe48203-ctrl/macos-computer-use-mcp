import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replWorkerExecArgv } from '../src/repl.mjs';

test('REPL Worker inherits only read permissions, not process or worker grants', () => {
  assert.deepEqual(replWorkerExecArgv([]), []);
  assert.deepEqual(replWorkerExecArgv([
    '--permission', '--allow-worker', '--allow-child-process',
    '--allow-fs-read=/app', '--allow-fs-write=/tmp', '--inspect'
  ]), ['--permission', '--allow-fs-read=/app']);
});

test('permissioned persistent REPL denies child-process APIs and keeps reset semantics', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const replUrl = new URL('../src/repl.mjs', import.meta.url).href;
  const probe = `
    import { CuaRepl } from ${JSON.stringify(replUrl)};
    const bridge = { retiring: Promise.resolve(), stop() {}, close() {} };
    const runtime = new CuaRepl(bridge);
    try {
      const check = await runtime.execute(\`
        var cp = await import('node:child_process');
        var outcomes = [];
        for (var name of ['spawn', 'spawnSync', 'execFile', 'fork']) {
          try { cp[name](process.execPath, ['--version']); outcomes.push(name + ':ALLOWED'); }
          catch (error) { outcomes.push(name + ':' + error.code); }
        }
        nodeRepl.write(JSON.stringify(outcomes));
      \`, { timeoutMs: 5000 });
      const persistent = await runtime.execute('outcomes.length', { timeoutMs: 5000 });
      await runtime.reset();
      const cleared = await runtime.execute('typeof outcomes', { timeoutMs: 5000 });
      console.log(JSON.stringify({ check, persistent, cleared }));
    } finally { await runtime.close(); }
  `;
  const processResult = spawnSync(process.execPath, [
    '--permission', '--allow-worker', `--allow-fs-read=${root}`,
    '--input-type=module', '--eval', probe
  ], { encoding: 'utf8', timeout: 20000 });
  assert.equal(processResult.status, 0, processResult.stderr || processResult.error?.message);
  const payload = JSON.parse(processResult.stdout.trim().split(String.fromCharCode(10)).at(-1));
  assert.equal(payload.check.isError, undefined, JSON.stringify(payload.check));
  const output = payload.check.content.map(x => x.text ?? '').join(' ');
  for (const name of ['spawn', 'spawnSync', 'execFile', 'fork']) {
    assert.ok(output.includes(`${name}:ERR_ACCESS_DENIED`), output);
  }
  assert.ok(payload.persistent.content.some(x => x.text?.includes('4')));
  assert.ok(payload.cleared.content.some(x => x.text?.includes('undefined')));
});
