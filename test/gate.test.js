import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeTests, compareTests, gate, gateSarif } from '../src/gate.js';

const kinds = (base, head) => compareTests(base, head, 'a.test.js').map((issue) => issue.kind);
const BASE = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "test('adds', () => {",
  '  assert.equal(add(1, 2), 3);',
  '  assert.throws(() => add(), TypeError);',
  '});',
  "test('subtracts', () => {",
  '  assert.strictEqual(sub(3, 1), 2);',
  '});',
  '',
].join('\n');

test('an unchanged or strengthened test file passes', () => {
  assert.deepEqual(kinds(BASE, BASE), []);
  const stronger = BASE.replace("  assert.strictEqual(sub(3, 1), 2);", "  assert.strictEqual(sub(3, 1), 2);\n  assert.strictEqual(sub(0, 1), -1);");
  assert.deepEqual(kinds(BASE, stronger), []);
});

test('detects deleted tests and assertions', () => {
  assert.deepEqual(kinds(BASE, BASE.replace(/test\('subtracts'[\s\S]*$/, '')), ['test-deleted']);
  assert.deepEqual(kinds(BASE, BASE.replace("  assert.throws(() => add(), TypeError);\n", '')), ['assertions-removed']);
});

test('detects skipped tests in every spelling, and .only', () => {
  assert.deepEqual(kinds(BASE, BASE.replace("test('adds'", "test.skip('adds'")), ['test-skipped']);
  assert.deepEqual(kinds(BASE, BASE.replace("test('adds'", "xtest('adds'")), ['test-skipped']);
  assert.deepEqual(kinds(BASE, BASE.replace("test('adds', () =>", "test('adds', { skip: true }, () =>")), ['test-skipped']);
  assert.deepEqual(kinds(BASE, BASE.replace("test('adds'", "test.only('adds'")), ['test-only']);
  const suite = "describe('math', () => {\n  it('adds', () => { expect(add(1, 2)).toBe(3); });\n});\n";
  assert.deepEqual(kinds(suite, suite.replace('describe(', 'describe.skip(')), ['test-skipped']);
});

test('detects assertions loosened to ok / truthy / not-null', () => {
  assert.deepEqual(kinds(BASE, BASE.replace('assert.equal(add(1, 2), 3)', 'assert.ok(add(1, 2))')), ['assertions-weakened']);
  const jest = "it('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n";
  assert.deepEqual(kinds(jest, jest.replace('.toBe(3)', '.toBeTruthy()')), ['assertions-weakened']);
  assert.deepEqual(kinds(jest, jest.replace('.toBe(3)', '.not.toBeNull()')), ['assertions-weakened']);
  assert.deepEqual(kinds(jest, jest.replace('.toBe(3)', '.toBeDefined()')), ['assertions-weakened']);
});

test('flags changed expected values for review (the make-the-test-match-the-bug move)', () => {
  const issues = compareTests(BASE, BASE.replace('add(1, 2), 3', 'add(1, 2), 4'), 'a.test.js');
  assert.deepEqual(issues.map((issue) => [issue.kind, issue.severity]), [['expected-value-changed', 'review']]);
  assert.match(issues[0].message, /\[3\] -> \[4\]|3.*4/);
});

test('renamed tests are matched by their assertions, not reported as deleted', () => {
  assert.deepEqual(kinds(BASE, BASE.replace("test('adds'", "test('adds two numbers'")), []);
});

test('quell-allow-weaken exempts a test', () => {
  const head = BASE.replace('assert.equal(add(1, 2), 3);', 'assert.ok(add(1, 2)); // quell-allow-weaken flaky upstream, tracked in #12');
  assert.deepEqual(kinds(BASE, head), []);
});

test('a deleted test file is reported; an unparsable head is a review item', () => {
  assert.deepEqual(kinds(BASE, null), ['test-file-deleted', 'test-file-deleted']);
  assert.deepEqual(kinds(BASE, 'test((((('), ['unparsable']);
});

test('analyzeTests understands nested suites, node:test options and node assertions', () => {
  const tests = analyzeTests("describe('a', () => { describe('b', () => { it('c', () => { expect(x).toEqual(1); assert(y); }); }); });", 'a.test.js');
  assert.deepEqual([...tests.keys()], ['a > b > c']);
  assert.deepEqual(tests.get('a > b > c').assertions.map((item) => item.strength), ['strong', 'weak']);
});

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-gate-'));
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'test', 'math.test.js'), BASE);
  fs.writeFileSync(path.join(dir, 'math.js'), 'export const add = (a, b) => a + b;\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return { dir, git };
}

test('gate() compares changed test files against the merge-base', () => {
  const { dir } = repo();
  const file = path.join(dir, 'test', 'math.test.js');
  assert.equal(gate('HEAD', { cwd: dir }).ok, true);
  fs.writeFileSync(file, BASE.replace('assert.equal(add(1, 2), 3)', 'assert.ok(add(1, 2))'));
  const failed = gate('HEAD', { cwd: dir });
  assert.equal(failed.ok, false);
  assert.equal(failed.checked, 1);
  assert.deepEqual(failed.issues.map((item) => item.kind), ['assertions-weakened']);
  fs.writeFileSync(file, BASE.replace('add(1, 2), 3', 'add(1, 2), 4'));
  assert.equal(gate('HEAD', { cwd: dir }).ok, true, 'review items do not fail by default');
  assert.equal(gate('HEAD', { cwd: dir, strict: true }).ok, false);
  fs.rmSync(file);
  assert.equal(gate('HEAD', { cwd: dir }).issues[0].kind, 'test-file-deleted');
  assert.throws(() => gate('--oops', { cwd: dir }), /invalid git ref/);
  assert.equal(gateSarif({ issues: failed.issues }).runs[0].results.length, 1);
});

test('quell gate exits 5 on weakened tests, 0 otherwise, 2 without --diff', () => {
  const { dir } = repo();
  const cli = path.resolve('src/cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, 'gate', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(run('--diff', 'HEAD').status, 0);
  fs.writeFileSync(path.join(dir, 'test', 'math.test.js'), BASE.replace("test('adds'", "test.skip('adds'"));
  const failed = run('--diff', 'HEAD');
  assert.equal(failed.status, 5, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /test is now skipped/);
  assert.equal(JSON.parse(run('--diff', 'HEAD', '--json').stdout).ok, false);
  assert.equal(JSON.parse(run('--diff', 'HEAD', '--sarif').stdout).version, '2.1.0');
  assert.equal(run().status, 2);
});
