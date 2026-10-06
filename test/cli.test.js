import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const cli = path.resolve('src/cli.js');

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('CLI exposes help and version without loading a project', () => {
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /find\|score\|generate/);
  const version = run('--version');
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^0\.1\.0/);
});

test('CLI emits machine-readable score output and honors threshold failures', () => {
  const result = run('score', '.', '--json', '--threshold', '101');
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.summary.score >= 0 && parsed.summary.score <= 100);
  assert.equal(parsed.version, 1);
});

test('CLI generate remains dry-run unless --write is explicit', () => {
  const result = run('generate', '.', '--json');
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed.findings));
  assert.ok(parsed.findings.every((item) => item.output === null));
});
