import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareTests } from '../src/gate.js';
import { verifyGenerated } from '../src/index.js';
import { checkStubs, compareShape, loadExamples } from '../src/contract.js';

const issuesOf = (base, head) => compareTests(base, head, 'a.test.js').map((issue) => `${issue.test}:${issue.kind}`);

test('gate: renames are paired for every test before any loose subject match, so none is stolen', () => {
  const base = "test('t1', () => { assert.equal(a(1), 1); });\ntest('t2', () => { assert.equal(b(2), 2); });\n";
  const head = "test('t2 renamed', () => { assert.equal(b(2), 2); });\n";
  assert.deepEqual(issuesOf(base, head), ['t1:test-deleted']);
});

test('gate: a generic shared callee (JSON.parse) does not make two unrelated tests a replacement', () => {
  const base = "test('validateEmail', () => { assert.equal(JSON.parse(validateEmail('a@b.c')).ok, true); });\n";
  const head = "test('config', () => { assert.equal(JSON.parse('{}').x, undefined); });\n";
  assert.deepEqual(issuesOf(base, head), ['validateEmail:test-deleted']);
  // Two specific shared subjects (add, sub) do count as the same subject.
  const old = "test('math', () => { assert.equal(add(1, 2), 3); assert.equal(sub(3, 1), 2); });\n";
  const rewritten = "test('arithmetic', () => { assert.equal(add(1, 2), 3); assert.equal(sub(3, 1), 2); assert.equal(add(0, 0), 0); });\n";
  assert.deepEqual(issuesOf(old, rewritten), ['math:test-replaced']);
});

// ---- verify --command --------------------------------------------------------------------------------------------

const SOURCE = 'export function clamp(value, max) {\n  if (value > max) throw new RangeError("big");\n  return value + 1;\n}\n';
const CHECK = "import assert from 'node:assert/strict';\nimport { clamp } from './unit.mjs';\nassert.equal(clamp(1, 5), 2);\nassert.throws(() => clamp(6, 5), RangeError);\n";

function project(dirName = 'p') {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-r2-')), dirName);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'unit.mjs'), SOURCE);
  fs.writeFileSync(path.join(dir, 'check.mjs'), CHECK);
  return { dir, sourceFile: path.join(dir, 'unit.mjs'), testPath: path.join(dir, 'check.mjs') };
}

test('--command passes the test path through the environment, so shell metacharacters in file names are inert', () => {
  const { dir, sourceFile, testPath } = project('weird $(echo hacked) `x` $HOME dir');
  const result = verifyGenerated(null, { sourceFile, testPath, command: 'node {test}' });
  assert.equal(result.verified, true, JSON.stringify(result.reason));
  assert.ok(!fs.existsSync(path.join(dir, 'hacked')));
});

test('exit codes reserved for environment failures are infrastructure errors, not kills', () => {
  const { sourceFile, testPath } = project();
  const result = verifyGenerated(null, { sourceFile, testPath, command: 'node -e "process.exit(99)" {test}', infraExitCodes: [99] });
  assert.equal(result.verified, false);
  assert.match(result.reason, /could not run: exit status 99 is reserved for environment failures/);
  const withoutReservation = verifyGenerated(null, { sourceFile, testPath, command: 'node -e "process.exit(99)" {test}' });
  assert.match(withoutReservation.reason, /fails on the original code/);
  const cli = spawnSync(process.execPath, [path.resolve('src/cli.js'), 'verify', testPath, '--source', sourceFile, '--command', 'node -e "process.exit(99)" {test}', '--infra-exit', '99'], { encoding: 'utf8' });
  assert.equal(cli.status, 4);
  assert.match(cli.stdout, /environment failures/);
  assert.equal(spawnSync(process.execPath, [path.resolve('src/cli.js'), 'verify', testPath, '--source', sourceFile, '--infra-exit', 'abc'], { encoding: 'utf8' }).status, 2);
});

// ---- contract ------------------------------------------------------------------------------------------------------

test('contract: routes with regex metacharacters never throw or hang', () => {
  const examples = [{ method: 'GET', path: '/files/[x]', status: 200, body: { a: 1 } }];
  assert.doesNotThrow(() => checkStubs("// quell-mock GET /files/[\nconst s = { a: 1 };\n", 'a.test.js', examples));
  assert.deepEqual(checkStubs("// quell-mock GET /files/[x]\nconst s = { a: 1 };\n", 'a.test.js', examples), []);
  const started = Date.now();
  const adjacent = `/x/${'{a}'.repeat(24)}`;
  checkStubs(`// quell-mock GET ${adjacent}\nconst s = {};\n`, 'a.test.js', [{ method: 'GET', path: '/x/zzzzzzzzzzzzzzzzzzzzzzzzzzzz!', body: {} }]);
  assert.ok(Date.now() - started < 1000, 'adjacent parameters must not backtrack');
});

test('contract: malformed example files give clear errors instead of TypeErrors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-r2c-'));
  const file = (name, content) => { fs.writeFileSync(path.join(dir, name), content); return path.join(dir, name); };
  assert.throws(() => loadExamples(file('null.json', 'null')), /must contain a HAR object/);
  assert.doesNotThrow(() => loadExamples(file('entries.json', '{"log":{"entries":{}}}')));
  assert.doesNotThrow(() => loadExamples(file('list.json', '[null, 1, {"method":"get","path":"/a","body":{}}]')));
  assert.doesNotThrow(() => loadExamples(file('paths.json', '{"paths":{"/x":null,"/y":{"get":null}}}')));
});

test('contract: inherited names (constructor, toString) are real fields, not type drift', () => {
  const issues = compareShape({}, JSON.parse('{"constructor": 1, "toString": "x"}'));
  assert.deepEqual(issues.map((issue) => [issue.path, issue.kind]).sort(), [['constructor', 'missing'], ['toString', 'missing']]);
  assert.deepEqual(compareShape(JSON.parse('{"constructor": 1}'), JSON.parse('{"constructor": 2}')), []);
});
