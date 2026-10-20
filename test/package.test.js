import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

test('the benchmark fixtures and script ship in the package so the README claims can be rerun', () => {
  for (const entry of ['src', 'docs', 'eval', 'scripts/eval.mjs', 'CHANGELOG.md', 'LICENSE']) assert.ok(pkg.files.includes(entry), `${entry} missing from "files"`);
  for (const dir of ['eval/defects', 'eval/clean', 'eval/gate', 'eval/matrix']) assert.ok(fs.existsSync(dir), dir);
  assert.ok(fs.existsSync('scripts/eval.mjs'));
});

test('the changelog documents the current version and the metadata is complete', () => {
  assert.match(fs.readFileSync('CHANGELOG.md', 'utf8'), new RegExp(`^## ${pkg.version.replaceAll('.', '\\.')}$`, 'm'));
  assert.equal(pkg.license, 'Apache-2.0');
  assert.match(pkg.repository.url, /quelltest\/quelltest-npm/);
});

test('quell eval runs the bundled benchmark and exits 0', () => {
  const run = spawnSync(process.execPath, [path.resolve('src/cli.js'), 'eval'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.rules.noise, []);
  assert.deepEqual(result.verifier.wrong, []);
  assert.ok(result.rules.recall >= 0.5);
});
