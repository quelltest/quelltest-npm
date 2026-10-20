import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyGenerated } from '../src/index.js';
import { hasMeaningfulAssertion } from '../src/verification.js';
import { mutants } from '../src/mutate.js';

const SOURCE = [
  'export function clamp(value, max) {',
  '  if (value > max) throw new RangeError("too big");',
  '  return value + 1;',
  '}',
  'export function untouched(a) {',
  '  return a * 2;',
  '}',
  '',
].join('\n');

function project(source = SOURCE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-verify-'));
  const sourceFile = path.join(dir, 'unit.mjs');
  fs.writeFileSync(sourceFile, source);
  return { dir, sourceFile, testPath: path.join(dir, 'unit.check.test.mjs') };
}

const header = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp, untouched } from './unit.mjs';\n";
const STRONG = `${header}test('clamp', () => {\n  assert.equal(clamp(1, 5), 2);\n  assert.equal(clamp(5, 5), 6);\n  assert.throws(() => clamp(6, 5), RangeError);\n});\n`;

test('a test that observes the code and kills mutants is verified; source is restored', () => {
  const { sourceFile, testPath } = project();
  const result = verifyGenerated(STRONG, { sourceFile, testPath });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.ok(result.killed > 0 && result.total >= result.killed);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), SOURCE);
  assert.equal(fs.existsSync(`${sourceFile}.quelltest-backup`), false);
  assert.equal(fs.existsSync(testPath), false);
});

test('placeholder scaffolds are never verified', () => {
  const { sourceFile, testPath } = project();
  const scaffold = `${header}test('placeholder', () => {\n  assert.ok(true);\n});\n`;
  const result = verifyGenerated(scaffold, { sourceFile, testPath });
  assert.equal(result.verified, false);
  assert.match(result.reason, /no assertion/);
  assert.equal(result.injectedBug.passed, false);
});

test('a test with no assertion, or only literal assertions, is not verified', () => {
  const { sourceFile, testPath } = project();
  assert.equal(verifyGenerated(`${header}test('x', () => { clamp(1, 5); });\n`, { sourceFile, testPath }).verified, false);
  const literal = verifyGenerated(`${header}test('x', () => { assert.equal(1 + 1, 2); });\n`, { sourceFile, testPath });
  assert.equal(literal.verified, false);
  assert.match(literal.reason, /no assertion/);
});

test('a test that fails on the original code is not verified and no mutants run', () => {
  const { sourceFile, testPath } = project();
  const result = verifyGenerated(`${header}test('wrong', () => { assert.equal(clamp(1, 5), 99); });\n`, { sourceFile, testPath });
  assert.equal(result.verified, false);
  assert.match(result.reason, /fails on the original/);
  assert.equal(result.total, 0);
});

test('an assertion that survives every mutant is not verified', () => {
  const { sourceFile, testPath } = project('export function id(a) {\n  return a;\n}\nexport function noop(a) {\n  if (a > 1) { a = a; }\n  return a;\n}\n');
  const weak = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { id } from './unit.mjs';\ntest('id', () => { assert.equal(id(1), 1); });\n";
  const result = verifyGenerated(weak, { sourceFile, testPath });
  assert.equal(result.verified, false);
  assert.match(result.reason, /every mutant/);
});

test('no applicable mutation means not verified rather than caught', () => {
  const { sourceFile, testPath } = project('export const id = (a) => a;\n');
  const t = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { id } from './unit.mjs';\ntest('id', () => { assert.equal(id(1), 1); });\n";
  const result = verifyGenerated(t, { sourceFile, testPath });
  assert.equal(result.verified, false);
  assert.match(result.reason, /no applicable mutation/);
});

test('mutation can be scoped to specific functions', () => {
  assert.ok(mutants(SOURCE, 'unit.mjs').some((m) => m.function === 'untouched'));
  const scoped = mutants(SOURCE, 'unit.mjs', { functions: ['clamp'] });
  assert.ok(scoped.length > 0 && scoped.every((m) => m.function === 'clamp'));
});

test('an interrupted run is repaired from the on-disk backup', () => {
  const { sourceFile, testPath } = project();
  fs.writeFileSync(`${sourceFile}.quelltest-backup`, SOURCE);
  fs.writeFileSync(sourceFile, 'export function clamp() { throw new Error("corrupted"); }\n');
  const result = verifyGenerated(STRONG, { sourceFile, testPath });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), SOURCE);
});

test('missing source file or unsupported runner fails safely', () => {
  assert.equal(verifyGenerated(STRONG, {}).verified, false);
  const { sourceFile, testPath } = project();
  assert.throws(() => verifyGenerated(STRONG, { sourceFile, testPath, runner: 'nope' }), /unsupported runner/);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), SOURCE);
  assert.equal(fs.existsSync(testPath), false);
});

test('hasMeaningfulAssertion distinguishes real assertions from placeholders', () => {
  assert.equal(hasMeaningfulAssertion('assert.ok(true)'), false);
  assert.equal(hasMeaningfulAssertion('expect(true).toBe(true)'), false);
  assert.equal(hasMeaningfulAssertion('assert.equal(f(1), 2)'), true);
  assert.equal(hasMeaningfulAssertion('expect(f(1)).toBe(2)'), true);
  assert.equal(hasMeaningfulAssertion('assert.throws(() => f(), Error)'), true);
});

test('quell verify exits 0 for a verified test and 1 otherwise', () => {
  const { dir, sourceFile, testPath } = project();
  fs.writeFileSync(testPath, STRONG);
  const cli = path.resolve('src/cli.js');
  const ok = spawnSync(process.execPath, [cli, 'verify', testPath, '--source', sourceFile], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Verified/);
  fs.writeFileSync(testPath, `${header}test('p', () => { assert.ok(true); });\n`);
  assert.equal(spawnSync(process.execPath, [cli, 'verify', testPath, '--source', sourceFile], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync(process.execPath, [cli, 'verify', testPath], { encoding: 'utf8' }).status, 2);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), SOURCE);
  fs.rmSync(dir, { recursive: true, force: true });
});
