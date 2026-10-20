import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSource } from '../src/scan.js';

const count = (code, rule) => scanSource(code, 'a.js').findings.filter((f) => f.rule === rule).length;

test('missing-await needs a Model-like receiver or an ORM in the module: ctx.save() is not a database write', () => {
  assert.equal(count('async function f(ctx) {\n  ctx.save();\n}', 'missing-await'), 0);
  assert.equal(count('async function f(doc) {\n  doc.save();\n}', 'missing-await'), 0, 'lowercase receiver, no ORM in the file');
  assert.equal(count("import mongoose from 'mongoose';\nasync function f(doc) {\n  doc.save();\n}", 'missing-await'), 1);
  assert.equal(count('async function f(data) {\n  User.create(data);\n}', 'missing-await'), 1, 'Model-like receiver');
});

test('Array.prototype.find is not a database query', () => {
  assert.equal(count("import mongoose from 'mongoose';\nasync function f(users, id) {\n  const user = users.find((u) => u.id === id);\n  return user.name;\n}", 'missing-await'), 0);
  assert.equal(count("import mongoose from 'mongoose';\nasync function f(id) {\n  const user = User.findOne({ id });\n  return user.name;\n}", 'missing-await'), 1);
});

test('a startsWith("/") check alone does not make a redirect safe: it needs the // check too', () => {
  const one = "function f(req, res) {\n  const next = req.query.next;\n  if (next.startsWith('/')) res.redirect(next);\n}";
  assert.equal(count(one, 'open-redirect'), 1, '//evil.example passes startsWith("/")');
  const both = "function f(req, res) {\n  const next = req.query.next;\n  if (!next.startsWith('/') || next.startsWith('//')) return res.redirect('/');\n  res.redirect(next);\n}";
  assert.equal(count(both, 'open-redirect'), 0);
});

test('deep-response-chain ignores a single index: res.rows[0], result[0], r[0]', () => {
  for (const code of ['function f(res) { return res.rows[0]; }', 'function f(result) { return result[0]; }', 'function f(rs) { return rs.map((r) => r[0]); }']) assert.equal(count(code, 'deep-response-chain'), 0, code);
  assert.equal(count('function f(res) { return res.rows[0].id; }', 'deep-response-chain'), 1);
});

test('only the try block guards: catch, finally and detached callbacks do not', () => {
  assert.equal(count('async function f(u) { try { await fetch(u); } catch { return null; } }', 'unguarded-network-call'), 0);
  assert.equal(count('async function f(u) { try { return 1; } catch { await fetch(u); } }', 'unguarded-network-call'), 1);
  assert.equal(count('async function f(u) { try { return 1; } finally { await fetch(u); } }', 'unguarded-network-call'), 1);
  assert.equal(count('function f(u) { try { setTimeout(() => fetch(u), 10); } catch { return null; } }', 'unguarded-network-call'), 1);
  assert.equal(count('router.get("/", asyncHandler(async (req, res) => { await fetch(req.query.u); }));', 'unguarded-network-call'), 0);
  assert.equal(count('function f(t) { try { return 1; } catch { return jwt.verify(t, k); } }', 'unguarded-call'), 1);
});
