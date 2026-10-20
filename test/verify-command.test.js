import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyGenerated } from '../src/index.js';

const SOURCE = 'export function clamp(value, max) {\n  if (value > max) throw new RangeError("big");\n  return value + 1;\n}\n';
// Not a test-runner file: a plain script a user command (integration suite, docker compose, ...) would run.
const CHECK = "import assert from 'node:assert/strict';\nimport { clamp } from './unit.mjs';\nassert.equal(clamp(1, 5), 2);\nassert.equal(clamp(5, 5), 6);\nassert.throws(() => clamp(6, 5), RangeError);\n";

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-cmd-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'unit.mjs'), SOURCE);
  fs.writeFileSync(path.join(dir, 'check.mjs'), CHECK);
  return { dir, sourceFile: path.join(dir, 'unit.mjs'), testPath: path.join(dir, 'check.mjs') };
}

test('a custom command decides kill or survive for the baseline and every mutant', () => {
  const { sourceFile, testPath } = project();
  const result = verifyGenerated(null, { sourceFile, testPath, command: 'node {test}' });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.isolation, 'copy');
  assert.ok(result.killed > 0);
  assert.match(result.correctCode.command, /^node ".*check\.mjs"$/);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), SOURCE);
});

test('a failing baseline command is reported with the command', () => {
  const { sourceFile, testPath } = project();
  fs.writeFileSync(testPath, "throw new Error('integration environment is down');\n");
  const result = verifyGenerated(null, { sourceFile, testPath, command: 'node {test}' });
  assert.equal(result.verified, false);
  assert.match(result.reason, /fails on the original code \(node ".*check\.mjs"\)/);
  assert.match(result.reason, /integration environment is down/);
});

test('a command that never fails on mutants does not verify', () => {
  const { sourceFile, testPath } = project();
  const result = verifyGenerated(null, { sourceFile, testPath, command: 'node -e "process.exit(0)" {test}' });
  assert.equal(result.verified, false);
});

test('quell verify --command and --timeout', () => {
  const { dir, sourceFile, testPath } = project();
  const cli = path.resolve('src/cli.js');
  const ok = spawnSync(process.execPath, [cli, 'verify', testPath, '--source', sourceFile, '--command', 'node {test}'], { encoding: 'utf8', cwd: dir });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Verified/);
  fs.writeFileSync(testPath, 'setTimeout(() => {}, 20000);\n');
  const slow = spawnSync(process.execPath, [cli, 'verify', testPath, '--source', sourceFile, '--command', 'node {test}', '--timeout', '1'], { encoding: 'utf8', cwd: dir });
  assert.equal(slow.status, 4);
  assert.match(slow.stdout, /timed out/);
  assert.equal(spawnSync(process.execPath, [cli, 'verify', testPath, '--source', sourceFile, '--timeout', '0'], { encoding: 'utf8' }).status, 2);
});
