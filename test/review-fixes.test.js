import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyGenerated } from '../src/index.js';
import { mutants, applyMutant } from '../src/mutate.js';
import { parseSource } from '../src/ast.js';
import { compareTests, analyzeTests, gate } from '../src/gate.js';
import { handleMessage } from '../src/mcp.js';

const SOURCE = 'export function clamp(value, max) {\n  if (value > max) throw new RangeError("big");\n  return value + 1;\n}\n';
const header = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from './unit.mjs';\n";
const STRONG = `${header}test('clamp', () => {\n  assert.equal(clamp(1, 5), 2);\n  assert.equal(clamp(5, 5), 6);\n  assert.throws(() => clamp(6, 5), RangeError);\n});\n`;

function project(sub = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-fix-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"p","type":"module"}');
  const where = path.join(dir, sub);
  fs.mkdirSync(where, { recursive: true });
  fs.writeFileSync(path.join(where, 'unit.mjs'), SOURCE);
  return { dir, sourceFile: path.join(where, 'unit.mjs'), testPath: path.join(where, 'unit.check.test.mjs') };
}

test('a symlinked source file is never written through (mutants go to a copy)', (t) => {
  const { dir, testPath } = project();
  const shared = path.join(dir, '..', `shared-${path.basename(dir)}`);
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'lib.mjs'), SOURCE);
  try {
    fs.symlinkSync(path.join(shared, 'lib.mjs'), path.join(dir, 'unit.mjs.link'));
    fs.rmSync(path.join(dir, 'unit.mjs'));
    fs.symlinkSync(path.join(shared, 'lib.mjs'), path.join(dir, 'unit.mjs'));
  } catch {
    t.skip('cannot create symlinks on this machine');
    return;
  }
  const result = verifyGenerated(STRONG, { sourceFile: path.join(dir, 'unit.mjs'), testPath });
  assert.equal(result.isolation, 'copy');
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(shared, 'lib.mjs'), 'utf8'), SOURCE, 'the real target of the symlink was modified');
});

test('a source inside a build/ or dist/ directory is still mirrored', () => {
  const { sourceFile, testPath } = project('build');
  const result = verifyGenerated(STRONG, { sourceFile, testPath });
  assert.equal(result.isolation, 'copy');
  assert.equal(result.verified, true, result.reason);
});

test('mutants that do not parse are never produced (they would be counted as kills)', () => {
  const source = 'export const f = (a, b) => a && b || 0;\nexport const g = async (x) => { return await x; };\n';
  const list = mutants(source, 'a.mjs');
  assert.ok(list.length > 0);
  for (const mutant of list) assert.ok(parseSource(applyMutant(source, mutant), 'a.mjs'), `${mutant.description} does not parse`);
  assert.ok(!list.some((mutant) => mutant.kind === 'await'), '`return await x` is an equivalent mutant');
});

test('sanitisers are tried before plain coercions, and method-style sanitisers are recognised', () => {
  const source = 'export function f(x, h) {\n  const a = String(x);\n  const b = h.escapeHtml(x);\n  return a + b;\n}\n';
  const sanitizers = mutants(source, 'a.mjs').filter((mutant) => mutant.kind === 'sanitizer');
  assert.deepEqual(sanitizers.map((mutant) => mutant.description.split(' ')[0]), ['sanitiser', 'coercion']);
});

test('in-place verification refuses to overwrite an existing test file', () => {
  const { sourceFile, testPath } = project();
  fs.writeFileSync(testPath, STRONG);
  const result = verifyGenerated('// something else\n', { sourceFile, testPath, inPlace: true });
  assert.equal(result.verified, false);
  assert.match(result.reason, /refusing to overwrite/);
  assert.equal(fs.readFileSync(testPath, 'utf8'), STRONG);
});

// ---- gate ------------------------------------------------------------------------------------------------

const kinds = (base, head) => compareTests(base, head, 'a.test.js').map((issue) => issue.kind);

test('gate: describe.only is reported through the suite', () => {
  const base = "describe('s', () => { it('a', () => { expect(f(1)).toBe(2); }); });\n";
  assert.deepEqual(kinds(base, base.replace('describe(', 'describe.only(')), ['test-only']);
});

test('gate: template-literal and repeated test names are tracked', () => {
  const base = 'for (const n of [1, 2]) {\n  it(`works for ${n}`, () => { expect(f(n)).toBe(n + 1); });\n}\n';
  assert.deepEqual(kinds(base, base.replace('.toBe(n + 1)', '.toBeDefined()')), ['assertions-weakened']);
  const twice = "it('same', () => { expect(a()).toBe(1); });\nit('same', () => { expect(b()).toBe(2); });\n";
  assert.deepEqual([...analyzeTests(twice, 'a.test.js').keys()], ['same', 'same #2']);
  assert.deepEqual(kinds(twice, twice.replace('expect(b()).toBe(2);', '')), ['assertions-removed']);
});

test('gate: expect.assertions, mocks and plans are not assertions', () => {
  const base = "it('a', () => {\n  expect.assertions(1);\n  expect(f()).toBe(1);\n});\n";
  const head = "it('a', () => {\n  expect(f()).toBe(1);\n});\n";
  assert.deepEqual(kinds(base, head), [], 'removing expect.assertions is not removing an assertion');
  const node = "test('n', (t) => {\n  t.plan(1);\n  t.mock.method(o, 'm');\n  t.assert.equal(f(), 1);\n});\n";
  assert.equal(analyzeTests(node, 'a.test.js').get('n').assertions.length, 1);
});

test('gate: unparsable files are errors, not silent passes', () => {
  assert.equal(compareTests('test((((', "it('a', () => { expect(1).toBe(1); });", 'a.test.js')[0].severity, 'error');
  assert.equal(compareTests("it('a', () => { expect(1).toBe(1); });", 'test(((((', 'a.test.js')[0].severity, 'error');
});

test('gate: a moved test file is compared with its old content, not reported as deleted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-move-'));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'test'));
  const body = "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds', () => {\n  assert.equal(add(1, 2), 3);\n  assert.equal(add(2, 2), 4);\n});\n";
  fs.writeFileSync(path.join(dir, 'test', 'a.test.js'), body);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  fs.mkdirSync(path.join(dir, 'test', 'unit'));
  git('mv', 'test/a.test.js', 'test/unit/a.test.js');
  assert.deepEqual(gate('HEAD', { cwd: dir }).issues, []);
  fs.writeFileSync(path.join(dir, 'test', 'unit', 'a.test.js'), body.replace('  assert.equal(add(2, 2), 4);\n', ''));
  assert.deepEqual(gate('HEAD', { cwd: dir }).issues.map((issue) => issue.kind), ['assertions-removed']);
});

// ---- mcp -------------------------------------------------------------------------------------------------

test('mcp: malformed input never throws and notifications/responses get no reply', () => {
  assert.equal(handleMessage(null).error.code, -32600);
  assert.equal(handleMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }]).error.code, -32600);
  assert.equal(handleMessage('x').error.code, -32600);
  assert.equal(handleMessage({ jsonrpc: '2.0', id: 3, result: {} }), null);
  assert.equal(handleMessage({ jsonrpc: '2.0', id: 4 }).error.code, -32600);
  assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});
