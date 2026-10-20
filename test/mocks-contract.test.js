import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { annotatedStubs, checkStubs, compareShape, loadExamples } from '../src/contract.js';

const EXAMPLES = [{ method: 'GET', path: '/users/:id', status: 200, body: { id: 1, name: 'Ada', roles: ['admin'], profile: { age: 36 } } }];

test('annotated stubs are read from the literal after the comment, with the status from reply()', () => {
  const text = "// quell-mock GET /users/:id\nconst stub = { id: 1, name: 'Ada' };\n// quell-mock POST /items status=201\nclient.post.mockResolvedValue({ ok: true });\nnock(host).get('/x')\n  // quell-mock GET /x\n  .reply(200, { total: 3 });\n";
  const stubs = annotatedStubs(text);
  assert.deepEqual(stubs.map((stub) => [stub.method, stub.route, stub.status]), [['GET', '/users/:id', undefined], ['POST', '/items', 201], ['GET', '/x', 200]]);
  assert.deepEqual(stubs[0].value, { id: 1, name: 'Ada' });
});

test('the report example: { data: { items } } against a real { items } is drift in both directions', () => {
  const issues = compareShape({ data: { items: [1] } }, { items: [1] });
  assert.deepEqual(issues.map((issue) => [issue.path, issue.kind]).sort(), [['data', 'extra'], ['items', 'missing']]);
});

test('missing fields, invented fields and type mismatches are reported; matching stubs pass', () => {
  const stub = "// quell-mock GET /users/42\nconst user = { id: 1, name: 'Ada', roles: 'admin', nickname: 'a' };\n";
  const issues = checkStubs(stub, 'a.test.js', EXAMPLES);
  const byPath = Object.fromEntries(issues.map((issue) => [issue.path, issue.kind]));
  assert.deepEqual(byPath, { roles: 'type', profile: 'missing', nickname: 'extra' });
  assert.equal(issues[0].route, 'GET /users/42');
  assert.deepEqual(checkStubs("// quell-mock GET /users/:id\nconst user = { id: 1, name: 'Ada', roles: ['admin'], profile: { age: 40 } };\n", 'a.test.js', EXAMPLES), []);
});

test('unknown (dynamic) values and spread objects do not produce false drift', () => {
  const dynamic = "// quell-mock GET /users/:id\nconst u = { id: makeId(), name: 'Ada', roles: [], profile: other };\n";
  assert.deepEqual(checkStubs(dynamic, 'a.test.js', EXAMPLES), []);
  const spread = "// quell-mock GET /users/:id\nconst u = { ...base, id: 1 };\n";
  assert.deepEqual(checkStubs(spread, 'a.test.js', EXAMPLES), []);
});

test('routes without an example, wrong statuses and orphan annotations are reported', () => {
  assert.equal(checkStubs("// quell-mock GET /orders\nconst o = {};\n", 'a.test.js', EXAMPLES)[0].kind, 'no-example');
  assert.equal(checkStubs("// quell-mock GET /users/:id status=404\nconst o = {};\n", 'a.test.js', EXAMPLES)[0].kind, 'no-example');
  assert.equal(checkStubs('// quell-mock GET /users/:id\n\n\n\n\n\n\n\n\n\n\nconst x = 1;\n', 'a.test.js', EXAMPLES)[0].kind, 'annotation');
});

function write(dir, name, content) {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  return path.join(dir, name);
}

test('examples load from HAR, a JSON map, a JSON list and OpenAPI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-ex-'));
  const har = write(dir, 'rec.har', { log: { entries: [{ request: { method: 'get', url: 'https://api.example.com/users/42?x=1' }, response: { status: 200, content: { text: '{"id":42}' } } }, { request: { method: 'GET', url: 'https://x/y' }, response: { status: 200, content: { text: 'not json' } } }] } });
  assert.deepEqual(loadExamples(har), [{ method: 'GET', path: '/users/42', status: 200, body: { id: 42 } }]);
  const map = write(dir, 'map.json', { 'GET /users/:id': { status: 200, body: { id: 1 } }, 'POST /items': { ok: true } });
  assert.deepEqual(loadExamples(map).map((e) => [e.method, e.path, e.status]), [['GET', '/users/:id', 200], ['POST', '/items', undefined]]);
  const list = write(dir, 'list.json', [{ method: 'get', path: '/a', status: 200, body: { a: 1 } }]);
  assert.equal(loadExamples(list)[0].method, 'GET');
  const openapi = write(dir, 'api.json', { paths: { '/users/{id}': { get: { responses: { 200: { content: { 'application/json': { example: { id: 1, name: 'Ada' } } } }, 404: { description: 'none' } } } } } });
  assert.deepEqual(loadExamples(openapi), [{ method: 'GET', path: '/users/{id}', status: 200, body: { id: 1, name: 'Ada' } }]);
  assert.throws(() => loadExamples(write(dir, 'api.yaml', 'openapi: 3.0.0')), /not valid JSON/);
  // HAR URLs and OpenAPI templates match annotated routes
  assert.deepEqual(checkStubs("// quell-mock GET /users/{id}\nconst u = { id: 1, name: 'Ada' };\n", 'a.test.js', loadExamples(openapi)), []);
  assert.deepEqual(checkStubs("// quell-mock GET /users/:id\nconst u = { id: 42 };\n", 'a.test.js', loadExamples(har)), []);
});

test('quell mocks reports drift with exit code 6 and passes clean stubs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-mocks-'));
  const examples = write(dir, 'examples.json', { 'GET /users/:id': { status: 200, body: { id: 1, name: 'Ada' } } });
  write(dir, 'tests/a.test.js', "// quell-mock GET /users/:id\nconst stub = { data: { id: 1, name: 'Ada' } };\n");
  const cli = path.resolve('src/cli.js');
  const bad = spawnSync(process.execPath, [cli, 'mocks', path.join(dir, 'tests'), '--examples', examples], { encoding: 'utf8' });
  assert.equal(bad.status, 6, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /Stub drift: 3 difference\(s\)/);
  assert.match(bad.stdout, /data — the stub invents this field/);
  assert.equal(JSON.parse(spawnSync(process.execPath, [cli, 'mocks', path.join(dir, 'tests'), '--examples', examples, '--json'], { encoding: 'utf8' }).stdout).problems.length, 3);
  write(dir, 'tests/a.test.js', "// quell-mock GET /users/:id\nconst stub = { id: 1, name: 'Ada' };\n");
  const good = spawnSync(process.execPath, [cli, 'mocks', path.join(dir, 'tests'), '--examples', examples], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stdout);
  assert.match(good.stdout, /No stub drift/);
  assert.equal(spawnSync(process.execPath, [cli, 'mocks', dir], { encoding: 'utf8' }).status, 2);
});
