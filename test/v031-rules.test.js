import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanSource } from '../src/scan.js';
import { mutantsWithStats } from '../src/mutate.js';
import { report } from '../src/index.js';

const rulesOf = (code, file = 'a.js') => new Set(scanSource(code, file).findings.map((f) => f.rule ?? f.category));

test('a sanitiser applied through a variable keeps regex-injection quiet (the four false positives on real code)', () => {
  for (const code of [
    'const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");\nasync function f(req) {\n  const pattern = escapeRegex(req.query.q);\n  return User.find({ name: { $regex: pattern } });\n}',
    'function f(req) {\n  const re = String(req.query.q).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");\n  return new RegExp(re);\n}',
    'function f(req) {\n  const safe = escapeRegExp(req.query.q);\n  return new RegExp(safe, "i");\n}',
  ]) assert.ok(!rulesOf(code).has('regex-injection'), code);
  assert.ok(rulesOf('function f(req) {\n  const raw = req.query.q;\n  return new RegExp(raw);\n}').has('regex-injection'));
  assert.ok(rulesOf('async function f(req) {\n  const p = req.query.q;\n  return User.find({ name: { $regex: p } });\n}').has('regex-injection'));
});

test('a redirect checked with startsWith("/") earlier in the function is not an open redirect', () => {
  const guarded = "function f(req, res) {\n  const next = req.query.next;\n  if (!next.startsWith('/') || next.startsWith('//')) return res.redirect('/');\n  res.redirect(next);\n}";
  assert.ok(!rulesOf(guarded).has('open-redirect'));
  assert.ok(rulesOf('function f(req, res) {\n  const next = req.query.next;\n  res.redirect(next);\n}').has('open-redirect'));
});

test('inline literal secrets passed to jwt/hmac calls are flagged, env keys are not', () => {
  assert.ok(rulesOf('const t = jwt.sign({ id }, "super-secret-literal-1");').has('hard-coded-secret'));
  assert.ok(rulesOf('const h = crypto.createHmac("sha256", "literal-key-value");').has('hard-coded-secret'));
  assert.ok(!rulesOf('const t = jwt.sign({ id }, process.env.JWT_SECRET);').has('hard-coded-secret'));
  assert.ok(!rulesOf('const t = jwt.sign({ id }, secret);').has('hard-coded-secret'));
});

test('the plain missing-await form is flagged; awaited and query-builder uses are not', () => {
  assert.ok(rulesOf('async function f(id) {\n  const user = User.findById(id);\n  return user.name;\n}').has('missing-await'));
  assert.ok(!rulesOf('async function f(id) {\n  const user = await User.findById(id);\n  return user.name;\n}').has('missing-await'));
  assert.ok(!rulesOf('async function f(id) {\n  const q = User.find({ id });\n  return q.sort({ a: 1 }).lean().exec();\n}').has('missing-await'));
  assert.ok(!rulesOf('async function f(id) {\n  const p = User.findById(id);\n  const user = await p;\n  return user.name;\n}').has('missing-await'));
  assert.ok(!rulesOf('function f(id) {\n  const user = User.findById(id);\n  return user.name;\n}').has('missing-await'), 'only inside async functions');
});

test('mutants are capped per kind so awaits do not use the whole budget', () => {
  const awaits = Array.from({ length: 40 }, (_, i) => `  const v${i} = await get${i}();`).join('\n');
  const source = `export async function f(x) {\n${awaits}\n  if (x > 1) throw new Error("big");\n  return x ?? 0;\n}\n`;
  const { list } = mutantsWithStats(source, 'a.mjs');
  const count = (kind) => list.filter((m) => m.kind === kind).length;
  assert.equal(count('await'), 8);
  assert.ok(count('guard') >= 1 && count('throw') >= 1 && count('nullish') >= 1, JSON.stringify(list.map((m) => m.kind)));
  assert.equal(mutantsWithStats(source, 'a.mjs', { maxPerKind: 3 }).list.filter((m) => m.kind === 'await').length, 3);
});

test('findings carry a confidence label and can be filtered', () => {
  const found = scanSource('async function f(req) {\n  await g();\n  if (role === "ADMIN") return 1;\n  const a = x?.y.z();\n  return fs.readFileSync(req.query.f);\n}\n', 'a.js').findings;
  const conf = (predicate) => found.find(predicate).confidence;
  assert.equal(conf((f) => f.rule === 'path-traversal'), 'high');
  assert.equal(conf((f) => f.category === 'boundary'), 'low', 'enum-only boundary');
  assert.equal(conf((f) => f.category === 'async'), 'low');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-conf-'));
  const file = path.join(dir, 'a.js');
  fs.writeFileSync(file, 'async function f(req) {\n  if (role === "ADMIN") return 1;\n  return fs.readFileSync(req.query.f);\n}\n');
  const all = report(file, { coverage: false }).findings;
  const high = report(file, { coverage: false, minConfidence: 'high' }).findings;
  assert.ok(all.length > high.length && high.every((f) => f.confidence === 'high'));
  const cli = path.resolve('src/cli.js');
  assert.equal(spawnSync(process.execPath, [cli, 'find', file, '--min-confidence', 'bogus'], { encoding: 'utf8' }).status, 2);
  assert.match(spawnSync(process.execPath, [cli, 'find', file, '--min-confidence', 'high'], { encoding: 'utf8' }).stdout, /\(high\)/);
});
