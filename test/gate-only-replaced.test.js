import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTests } from '../src/gate.js';

const issuesOf = (base, head) => compareTests(base, head, 'a.test.js').map((issue) => `${issue.kind}:${issue.severity}`);
const BASE = "test('adds', () => {\n  assert.equal(add(1, 2), 3);\n  assert.equal(add(2, 2), 4);\n});\n";

test('a newly added test.only fails the gate even though it has no base test to pair with', () => {
  const head = `${BASE}test.only('extra', () => { assert.equal(sub(3, 1), 2); });\n`;
  assert.deepEqual(issuesOf(BASE, head), ['test-only:error']);
  assert.deepEqual(issuesOf(BASE, `${BASE}describe.only('suite', () => { it('x', () => { expect(f()).toBe(1); }); });\n`), ['test-only:error']);
  assert.deepEqual(issuesOf(BASE, `${BASE}test('extra', () => { assert.equal(sub(3, 1), 2); });\n`), [], 'a plain new test is fine');
  assert.deepEqual(issuesOf(BASE, `${BASE}// quell-allow-weaken\ntest.only('extra', () => { assert.equal(sub(3, 1), 2); // quell-allow-weaken\n});\n`), []);
});

test('a deleted-and-rewritten test is shown as a replacement, not a hard deletion', () => {
  const head = "test('adds numbers properly', () => {\n  assert.equal(add(1, 2), 3);\n  assert.equal(add(2, 2), 4);\n  assert.equal(add(0, 0), 0);\n});\n";
  const issues = compareTests(BASE, head, 'a.test.js');
  assert.deepEqual(issues.map((issue) => issue.kind), ['test-replaced']);
  assert.equal(issues[0].severity, 'review');
  assert.match(issues[0].message, /replaced by "adds numbers properly".*add/);
});

test('a replacement that is weaker is still an error', () => {
  const head = "test('adds numbers properly', () => {\n  assert.ok(add(1, 2));\n});\n";
  const kinds = issuesOf(BASE, head);
  assert.ok(kinds.includes('test-replaced:review'));
  assert.ok(kinds.includes('assertions-removed:error'), kinds.join(','));
});

test('an unrelated new test does not hide a deletion', () => {
  const head = "test('other thing', () => { assert.equal(sub(3, 1), 2); });\n";
  assert.deepEqual(issuesOf(BASE, head), ['test-deleted:error']);
});
