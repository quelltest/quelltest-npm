import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generate, report } from '../src/index.js';
import { describeModule, exportOf } from '../src/unit.js';

function project(source, name = 'unit.mjs') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-synth-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', name), source);
  return { dir, src: path.join(dir, 'src'), out: path.join(dir, 'out') };
}
const run = (p, extra = {}) => generate(report(p.src, { coverage: false }), { destination: p.out, runner: 'node', write: true, ...extra });
const sources = (results) => results.filter((item) => item.output && item.kind === 'test').map((item) => fs.readFileSync(item.output, 'utf8')).join('\n');
const reasons = (results) => results.map((item) => item.reason ?? '').join('\n');

test('`if (!body) ...; if (body.lat > 90) ...` composes an object root instead of `true`', () => {
  const p = project("export function geo(body) {\n  if (!body) throw new TypeError('body required');\n  if (body.lat > 90) throw new RangeError('lat');\n  return true;\n}\n");
  const results = run(p, { verify: true });
  assert.ok(results.filter((item) => item.status === 'VERIFIED').length >= 2, JSON.stringify(results.map((r) => [r.line, r.status, r.reason])));
  const source = sources(results);
  assert.match(source, /geo\(\{ "lat": 91 \}\)/);
  assert.match(source, /message: "lat"/);
  assert.doesNotMatch(source, /assert\.throws\(\(\) => geo\(true\)/, 'a boolean root can never reach the property guard');
});

test('the same idiom on a dependency result gets an object stub', () => {
  const p = project('export async function g(get) {\n  const r = await get(1);\n  if (!r) return null;\n  if (r.status === 404) return { missing: true };\n  return r;\n}\n');
  const results = run(p, { verify: true });
  assert.ok(results.some((item) => item.status === 'VERIFIED'), JSON.stringify(results.map((r) => [r.line, r.status, r.reason])));
  assert.match(sources(results), /async \(\) => \(\{ "status": 404 \}\)/);
  assert.doesNotMatch(sources(results), /async \(\) => \(true\)/);
});

test('prototype-walking names never pollute the quell process or reach generated code', () => {
  const p = project('export async function f(db, body) {\n  const x = await db.__proto__.polluted3();\n  if (body.__proto__.polluted) throw new Error("e");\n  if (body["__proto__"]["polluted2"]) throw new Error("e");\n  if (x.constructor.name) throw new Error("e");\n}\n');
  const results = run(p);
  assert.equal(({}).polluted3, undefined);
  assert.equal(({}).polluted, undefined);
  assert.equal(({}).polluted2, undefined);
  assert.ok(!sources(results).includes('__proto__'));
});

test('guards that are not top-level statements are refused with a reason', () => {
  const cases = {
    'else-if': "export function f(x) {\n  if (x > 5) throw new Error('A');\n  else if (x > 3) throw new RangeError('B');\n}\n",
    'enclosing condition': "export function f(x, y) {\n  if (y) {\n    if (x < 0) throw new Error('neg');\n  }\n}\n",
    loop: "export function f(items) {\n  for (const n of items) {\n    if (n < 0) throw new Error('neg');\n  }\n}\n",
  };
  for (const [name, source] of Object.entries(cases)) {
    const results = run(project(source));
    const refused = results.filter((item) => /nested inside another condition, loop or else-branch/.test(item.reason ?? ''));
    assert.ok(refused.length >= 1, `${name}: ${reasons(results)}`);
    if (name === 'else-if') assert.doesNotMatch(sources(results), /RangeError|message: "B"/, 'the else-if branch must not get a test asserting its own outcome');
    else assert.ok(results.every((item) => item.kind === 'todo' || item.status === 'FLAGGED'), name);
  }
});

test('a reassigned parameter is refused: the guard no longer tests the argument', () => {
  const results = run(project("export function f(a) {\n  a = Math.abs(a);\n  if (a <= 0) throw new Error('zero');\n}\n"));
  assert.match(reasons(results), /parameter `a` is reassigned/);
  assert.ok(!results.some((item) => item.kind === 'test' && item.status !== 'FLAGGED'));
});

test('an unreadable earlier guard removes the "accepts" cases but keeps the violating ones', () => {
  const p = project("export function f(a, b, x) {\n  if (a && b) return 1;\n  if (x < 0) throw new Error('neg');\n  return 2;\n}\n");
  const results = run(p);
  const source = sources(results);
  assert.match(source, /assert\.throws/);
  assert.doesNotMatch(source, /doesNotThrow/);
});

test('a stubbed parameter that is also guarded keeps the guard case (db = "") out of the stub', () => {
  const p = project("export async function f(db, id) {\n  if (!db) throw new Error('no db');\n  const r = await db.find(id);\n  if (r.n > 3) throw new Error('many');\n  return r;\n}\n");
  const results = run(p, { verify: true });
  assert.ok(results.filter((item) => item.status === 'VERIFIED').length >= 1, JSON.stringify(results.map((r) => [r.line, r.status, r.reason])));
  const source = sources(results);
  assert.match(source, /f\((?:false|0|""|null|undefined), /);
  assert.match(source, /\{ "find": async \(\) => \(\{ "n": 4 \}\) \}/);
});

test('a call through a parameter and a method of it are both stubbed', () => {
  const p = project("export async function f(db) {\n  const a = await db(1);\n  const b = await db.q(2);\n  if (b.n > 3) throw new Error('many');\n  return a;\n}\n");
  const source = sources(run(p, { verify: true }));
  assert.match(source, /Object\.assign\(async \(\) => \(\{\}\), \{ "q": async \(\) => \(\{ "n": 4 \}\) \}\)/);
});

test('the same local name in two blocks is ambiguous: no guess about which call it came from', () => {
  const p = project("export async function f(a, b) {\n  { const res = await a(); if (res.x === 1) throw new Error('x'); }\n  { const res = await b(); if (res.y === 2) throw new Error('y'); }\n}\n");
  const results = run(p);
  assert.ok(!results.some((item) => item.kind === 'test' && item.status !== 'FLAGGED'), reasons(results));
});

test('an imported or local fetch is not the global fetch, and unstubbed network calls are refused', () => {
  const imported = run(project("import fetch from 'node-fetch';\nexport async function f(u) {\n  const r = await fetch(u);\n  if (!r.ok) throw new Error('bad');\n  return 1;\n}\n"));
  assert.ok(!imported.some((item) => item.kind === 'test' && item.status !== 'FLAGGED'));
  assert.match(reasons(imported), /without a stubbable result|reach the real network|not a comparison/);
  const bare = run(project("export async function f(u, n) {\n  await fetch(u);\n  if (n < 0) throw new Error('neg');\n}\n"));
  assert.match(reasons(bare), /reach the real network/);
  const viaClient = run(project("import axios from 'axios';\nexport async function f(n) {\n  if (n < 0) throw new Error('neg');\n  return axios.get('/x');\n}\n"));
  assert.match(reasons(viaClient), /reach the real network/);
});

test('computed export keys are not exported under the identifier name', () => {
  const dynamic = describeModule('function a() {}\nconst k = "x";\nexports[k] = a;\nmodule.exports = { [k]: a };\n', 'a.js');
  assert.equal(exportOf(dynamic, 'a'), null);
  const literal = describeModule('function a() {}\nexports["x"] = a;\n', 'a.js');
  assert.deepEqual(exportOf(literal, 'a'), { kind: 'named', name: 'x' });
});

test('optional calls (`fn?.(id)`) are recognised as dependency calls', () => {
  const p = project("export async function f(fn) {\n  const r = await fn?.(1);\n  if (r.status === 503) throw new Error('down');\n  return r;\n}\n");
  assert.match(sources(run(p, { verify: true })), /"status": 503/);
});
