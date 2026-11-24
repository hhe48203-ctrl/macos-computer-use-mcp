import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP starts through a symlink and exposes complete tool schemas', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cu-entry-test-'));
  const link = path.join(dir, 'server.mjs');
  symlinkSync(fileURLToPath(new URL('../src/server.mjs', import.meta.url)), link);
  const client = new Client({ name: 'symlink-regression', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [link], cwd: dir }));
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(t=>t.name), ['js','js_reset']);
    assert.deepEqual(list.tools.map(tool => tool.annotations), [
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    ]);
    const first=await client.callTool({name:'js',arguments:{code:'let counter = await Promise.resolve(41)'}});
    assert.ok(!first.isError);
    const next=await client.callTool({name:'js',arguments:{code:'counter += 1'}});
    assert.equal(next.content[0].text,'42');
    const reset = () => client.callTool({ name: 'js_reset', arguments: {} });
    const firstReset = await reset();
    assert.ok(!firstReset.isError);
    assert.deepEqual(await reset(), firstReset);
    const afterReset = await client.callTool({ name: 'js', arguments: { code: 'typeof counter === "undefined"' } });
    assert.ok(!afterReset.isError);
    assert.equal(afterReset.content.at(-1).text, 'true');
    assert.ok(list.tools.every(t => t.inputSchema.type === 'object'));
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
