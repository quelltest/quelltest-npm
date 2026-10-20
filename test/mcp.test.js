import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { handleMessage } from '../src/mcp.js';

const call = (name, args, id = 10) => handleMessage({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-mcp-'));
  fs.writeFileSync(path.join(dir, 'unit.mjs'), 'export function clamp(v, max) {\n  if (v > max) throw new RangeError("big");\n  return v + 1;\n}\n');
  fs.writeFileSync(path.join(dir, 'unit.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from './unit.mjs';\ntest('clamp', () => {\n  assert.equal(clamp(1, 5), 2);\n  assert.equal(clamp(5, 5), 6);\n  assert.throws(() => clamp(6, 5), RangeError);\n});\n");
  return dir;
}

test('initialize, ping and tools/list follow the MCP handshake', () => {
  const init = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'quelltest');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual(handleMessage({ jsonrpc: '2.0', id: 2, method: 'ping' }).result, {});
  const tools = handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['find', 'verify', 'gate']);
  assert.ok(tools.every((tool) => tool.description && tool.inputSchema.type === 'object'));
});

test('unknown methods and tools are JSON-RPC errors', () => {
  assert.equal(handleMessage({ jsonrpc: '2.0', id: 4, method: 'nope' }).error.code, -32601);
  assert.equal(call('nope', {}).error.code, -32602);
});

test('find returns ranked candidates as text content', () => {
  const dir = project();
  const response = call('find', { path: path.join(dir, 'unit.mjs'), top: 2, coverage: false });
  const payload = JSON.parse(response.result.content[0].text);
  assert.ok(payload.candidates.length >= 1 && payload.candidates.length <= 2);
  assert.ok(payload.candidates[0].suggestion);
});

test('verify returns the verdict and a handoff for survivors', () => {
  const dir = project();
  const strong = call('verify', { test: path.join(dir, 'unit.test.mjs'), source: path.join(dir, 'unit.mjs') });
  assert.match(strong.result.content[0].text, /"verified": true/);
  fs.writeFileSync(path.join(dir, 'unit.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from './unit.mjs';\ntest('clamp', () => { assert.equal(clamp(1, 5), 2); });\n");
  const partial = call('verify', { test: path.join(dir, 'unit.test.mjs'), source: path.join(dir, 'unit.mjs') });
  assert.match(partial.result.content[0].text, /surviving mutant/);
  assert.match(partial.result.content[0].text, /What to do/);
});

test('tool failures come back as isError results, not crashes', () => {
  const response = call('gate', { diff: '--not-a-ref' });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /invalid git ref/);
});

test('the stdio server speaks newline-delimited JSON-RPC end to end', async () => {
  const child = spawn(process.execPath, [path.resolve('src/cli.js'), 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop();
    lines.push(...parts.filter(Boolean));
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  child.stdin.write('not json\n');
  child.stdin.end();
  await new Promise((resolve) => child.on('close', resolve));
  const responses = lines.map((line) => JSON.parse(line));
  assert.equal(responses.find((r) => r.id === 1).result.serverInfo.name, 'quelltest');
  assert.equal(responses.find((r) => r.id === 2).result.tools.length, 3);
  assert.equal(responses.find((r) => r.id === null).error.code, -32700);
  assert.equal(responses.length, 3, 'notifications must not get a response');
});
