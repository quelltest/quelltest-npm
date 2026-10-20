import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSource } from '../src/scan.js';

const rulesOf = (code, file = 'a.js') => new Set(scanSource(code, file).findings.map((f) => f.rule ?? f.category));
const route = (body) => `router.post('/x', asyncHandler(async (req, res) => {\n${body}\n}));`;

test('single request fields are not "whole body" mass assignment', () => {
  const code = route("  const { name, createdAt } = req.body;\n  new Date(createdAt);\n  await User.update(name);\n  cache.set('k', req.body.value);");
  assert.ok(!rulesOf(code).has('mass-assignment'));
});

test('whole-body flows are still flagged (alias, nested Object.assign, spread)', () => {
  assert.ok(rulesOf(route('  const body = req.body;\n  await User.create(body);')).has('mass-assignment'));
  assert.ok(rulesOf('function f(req, doc) { Object.assign(doc, req.body.changes); }').has('mass-assignment'));
  assert.ok(rulesOf(route('  await User.create({ ...req.body });')).has('mass-assignment'));
});

test('route and page-key constants are not hard-coded secrets', () => {
  assert.ok(!rulesOf("const paths = { resetPassword: '/reset-password' };").has('hard-coded-secret'));
  assert.ok(!rulesOf("const keys = { forgotPassword: 'forgot-password-page' };").has('hard-coded-secret'));
  assert.ok(rulesOf("const apiKey = 'sk_live_abcdef123456';").has('hard-coded-secret'));
});

test('same-site redirects are safe, protocol-relative and request-controlled ones are not', () => {
  assert.ok(!rulesOf("function f(req, res) { res.redirect('/users/' + req.params.id); }").has('open-redirect'));
  assert.ok(!rulesOf('function f(req, res) { res.redirect(`/users/${req.params.id}`); }').has('open-redirect'));
  assert.ok(rulesOf('function f(req, res) { res.redirect(req.query.next); }').has('open-redirect'));
  assert.ok(rulesOf("function f(req, res) { res.redirect('//' + req.query.host); }").has('open-redirect'));
});

test('sanitisers are per sink: normalize and String do not stop path traversal, basename does', () => {
  assert.ok(rulesOf('function f(req) { return fs.readFileSync(path.normalize(req.query.f)); }').has('path-traversal'));
  assert.ok(rulesOf('function f(req) { return fs.readFileSync(String(req.query.f)); }').has('path-traversal'));
  assert.ok(!rulesOf('function f(req) { return fs.readFileSync(path.basename(req.query.f)); }').has('path-traversal'));
  assert.ok(!rulesOf("function f(req) { return User.findOne({ email: String(req.body.email) }); }").has('nosql-injection'));
});

test('taint is cleared on reassignment and shadowed by parameters', () => {
  assert.ok(!rulesOf("function f(req) {\n  let name = req.query.f;\n  name = 'fixed.txt';\n  return fs.readFileSync(name);\n}").has('path-traversal'));
  assert.ok(!rulesOf('function f(req) {\n  const id = req.query.id;\n  return [1].map((id) => fs.readFileSync(id));\n}').has('path-traversal'));
  assert.ok(rulesOf('function f(req) {\n  const id = req.query.id;\n  return fs.readFileSync(id);\n}').has('path-traversal'));
});

test('quell-ignore-mutant does not suppress scanner findings; quell-ignore does', () => {
  assert.ok(rulesOf('function f(code) { return eval(code); } // quell-ignore-mutant equivalent').has('eval-input'));
  assert.ok(!rulesOf('function f(code) { return eval(code); } // quell-ignore eval-input').has('eval-input'));
});

test('an environment-variable default is not a falsy-fallback finding', () => {
  assert.ok(!rulesOf('const port = process.env.PORT || 3000;').has('falsy-fallback'));
  assert.ok(rulesOf('const n = Number(q.limit) || 20;').has('falsy-fallback'));
});
