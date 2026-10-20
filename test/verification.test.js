import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyGenerated } from '../src/index.js';
import { hasMeaningfulAssertion } from '../src/verification.js';
import { mutants, findOperator } from '../src/mutate.js';
import { scan } from '../src/index.js';

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
  assert.equal(spawnSync(process.execPath, [cli, 'verify', testPath, '--source', sourceFile], { encoding: 'utf8' }).status, 4);
  assert.equal(spawnSync(process.execPath, [cli, 'verify', testPath], { encoding: 'utf8' }).status, 2);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), SOURCE);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('operator offsets skip comments inside the gap', () => {
  const text = 'a /* x - y */ - b';
  assert.equal(findOperator(text, 1, text.length - 1, '-'), text.lastIndexOf('-'));
  const source = 'export const f = (a, b) => a /* x - y */ - b;\n';
  const found = mutants(source, 'a.mjs');
  assert.equal(found.length, 1);
  assert.equal(found[0].start, source.lastIndexOf('-'));
});

test('a source file left mutated by a killed run is repaired by scan', () => {
  const { dir, sourceFile } = project();
  fs.writeFileSync(`${sourceFile}.quelltest-backup`, SOURCE);
  fs.writeFileSync(sourceFile, 'export const broken = 1;\n');
  const result = scan(dir, { includeTests: true });
  assert.equal(result.restored.length, 1);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), SOURCE);
  assert.equal(fs.existsSync(`${sourceFile}.quelltest-backup`), false);
});

test('runner that is not installed is an infrastructure error, not a kill', () => {
  const { sourceFile, testPath } = project();
  const result = verifyGenerated(STRONG, { sourceFile, testPath, runner: 'jest', cwd: os.tmpdir() });
  assert.equal(result.verified, false);
  assert.match(result.reason, /could not run/);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), SOURCE);
});

test('verification runs in an isolated copy: the real source is never written', async () => {
  const { sourceFile, testPath } = project();
  const before = fs.statSync(sourceFile);
  const result = verifyGenerated(STRONG, { sourceFile, testPath });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.isolation, 'copy');
  assert.equal(fs.statSync(sourceFile).mtimeMs, before.mtimeMs, 'source file was touched');
  assert.equal(fs.existsSync(testPath), false, 'test was written next to the real source');
  const inPlace = verifyGenerated(STRONG, { sourceFile, testPath, inPlace: true });
  assert.equal(inPlace.isolation, 'in-place');
  assert.equal(inPlace.verified, true);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), SOURCE);
});

test('the mirror links node_modules and never deletes the real one', () => {
  const { dir, sourceFile, testPath } = project();
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'package.json'), '{"name":"dep","type":"module","main":"index.js"}');
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'export const base = 1;\n');
  fs.writeFileSync(sourceFile, "import { base } from 'dep';\nexport function inc(n) {\n  if (n < 0) throw new RangeError('neg');\n  return n + base;\n}\n");
  const t = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { inc } from './unit.mjs';\ntest('inc', () => {\n  assert.equal(inc(1), 2);\n  assert.throws(() => inc(-1), RangeError);\n});\n";
  const result = verifyGenerated(t, { sourceFile, testPath });
  assert.equal(result.isolation, 'copy');
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'dep', 'index.js')), 'real node_modules was damaged');
});

test('relative test and source paths work like absolute ones, and failures show the command', () => {
  const { dir, sourceFile } = project();
  const testFile = path.join(dir, 'unit.check.test.mjs');
  fs.writeFileSync(testFile, STRONG);
  const cli = path.resolve('src/cli.js');
  const relative = spawnSync(process.execPath, [cli, 'verify', 'unit.check.test.mjs', '--source', 'unit.mjs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(relative.status, 0, relative.stdout + relative.stderr);
  assert.match(relative.stdout, /\[copy\]/);
  fs.writeFileSync(testFile, `${header}test('wrong', () => { assert.equal(clamp(1, 5), 99); });\n`);
  const failing = verifyGenerated(null, { sourceFile, testPath: testFile });
  assert.match(failing.reason, /fails on the original code \(node --test .*unit\.check\.test\.mjs\)/);
});

test('minScore requires a share of mutants to be killed', () => {
  const { sourceFile, testPath } = project();
  const partial = `${header}test('one thing', () => { assert.equal(clamp(1, 5), 2); });\n`;
  const lenient = verifyGenerated(partial, { sourceFile, testPath });
  assert.equal(lenient.verified, true);
  assert.ok(lenient.mutationScore < 100);
  const strict = verifyGenerated(partial, { sourceFile, testPath, minScore: 100 });
  assert.equal(strict.verified, false);
  assert.match(strict.reason, /below the required 100%/);
});

test('lines marked quell-ignore-mutant are not mutated and are counted', () => {
  const { sourceFile, testPath } = project('export function f(a) {\n  // quell-ignore-mutant equivalent: both branches return the same\n  if (a > 0) return a;\n  return a * 2;\n}\n');
  const t = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { f } from './unit.mjs';\ntest('f', () => { assert.equal(f(-1), -2); });\n";
  const result = verifyGenerated(t, { sourceFile, testPath });
  assert.ok(result.ignored >= 1);
  assert.ok(result.mutants.every((mutant) => mutant.line !== 3));
});

test('risk-aimed mutants: sanitiser unwrap, await removal and ?? swaps come first and survive weak tests', () => {
  const source = 'export async function find(raw, db, opts) {\n  const safe = escapeRe(raw);\n  const size = opts.size ?? 10;\n  const row = await db.get(safe);\n  return { row, size };\n}\nfunction escapeRe(s) {\n  return s.replace(/\\W/g, "");\n}\n';
  const kinds = mutants(source, 'a.mjs').map((m) => m.kind);
  assert.deepEqual(kinds.slice(0, 3).sort(), ['await', 'nullish', 'sanitizer']);
  const { sourceFile, testPath } = project(source);
  const weak = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { find } from './unit.mjs';\ntest('find', async () => {\n  const r = await find('a', { get: async (k) => k }, {});\n  assert.equal(r.size, 10);\n});\n";
  const result = verifyGenerated(weak, { sourceFile, testPath });
  const survivors = result.mutants.filter((m) => m.outcome === 'survived').map((m) => m.kind);
  assert.ok(survivors.includes('sanitizer'), JSON.stringify(result.mutants));
  assert.ok(survivors.includes('await'));
});

test('mutation can be scoped to scanner finding lines', () => {
  const found = mutants(SOURCE, 'unit.mjs', { lines: [[2, 2]] });
  assert.ok(found.length > 0 && found.every((m) => m.line === 2));
});

test('handoff report lists survivors with diff and a specific instruction', async () => {
  const { renderHandoff } = await import('../src/handoff.js');
  const { sourceFile, testPath } = project();
  const partial = `${header}test('one thing', () => { assert.equal(clamp(1, 5), 2); });\n`;
  const result = verifyGenerated(partial, { sourceFile, testPath });
  const markdown = renderHandoff(result, { sourceText: SOURCE });
  assert.match(markdown, /surviving mutant/);
  assert.match(markdown, /```diff/);
  assert.match(markdown, /\*\*What to do:\*\*/);
  assert.match(markdown, /quell-ignore-mutant/);
  const strongResult = verifyGenerated(STRONG, { sourceFile, testPath });
  const survivors = strongResult.mutants.filter((mutant) => mutant.outcome === 'survived').length;
  const clean = renderHandoff(strongResult, { sourceText: SOURCE });
  assert.match(clean, survivors ? new RegExp(`${survivors} surviving mutant`) : /No surviving mutants/);
  const cli = path.resolve('src/cli.js');
  const out = path.join(path.dirname(sourceFile), 'handoff.md');
  fs.writeFileSync(testPath, partial);
  const run = spawnSync(process.execPath, [cli, 'verify', testPath, '--source', sourceFile, '--handoff', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /# Quelltest handoff/);
  assert.equal(spawnSync(process.execPath, [cli, 'verify', testPath, '--source', sourceFile, '--min-score', '101'], { encoding: 'utf8' }).status, 2);
});

test('t.* style assertions count as meaningful', () => {
  assert.equal(hasMeaningfulAssertion('t.assert.equal(f(1), 2)'), true);
});
