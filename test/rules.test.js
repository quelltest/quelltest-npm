import test from 'node:test';
import assert from 'node:assert/strict';
import { scanSource } from '../src/scan.js';

const rulesOf = (code, file = 'a.js') => new Set(scanSource(code, file).findings.map((f) => f.rule ?? f.category));
const route = (body) => `router.post('/x', asyncHandler(async (req, res) => {\n${body}\n}));`;

// Variants the 0.2.0 report said were missed (independent probe, 11 of 31) plus new rule classes.
const SHOULD_FLAG = [
  ['regex via match()', 'regex-injection', 'function f(req, text) { return text.match(req.query.term); }'],
  ['regex via search()', 'regex-injection', 'function f(req, text) { return text.search(req.query.term); }'],
  ['spread then create', 'mass-assignment', route('  const data = { ...req.body };\n  await User.create(data);')],
  ['spread inside create', 'mass-assignment', route('  await User.create({ ...req.body });')],
  ['$set with body', 'mass-assignment', route('  await User.findByIdAndUpdate(req.params.id, { $set: req.body });')],
  ['new Model(spread)', 'mass-assignment', route('  const u = new User({ ...req.body });\n  await u.save();')],
  ['aliased body', 'mass-assignment', route('  const body = req.body;\n  await User.create(body);')],
  ['numeric default via option', 'falsy-fallback', 'const DEFAULT_SIZE = 10;\nfunction f(options) { return options.size || DEFAULT_SIZE; }'],
  ['countDocuments then create', 'check-then-act', route('  if ((await User.countDocuments({ email: req.body.email })) > 0) return;\n  await User.create({ email: req.body.email });')],
  ['router.use async', 'unhandled-async-route', "router.use(async (req, res, next) => { await prepare(req); next(); });"],
  ['aliased property chain', 'unguarded-member-call', 'function f(response) {\n  const items = response.data.items;\n  return items.map((i) => i.id);\n}'],
  ['JSON.parse of body', 'unparsed-json', 'function f(req) { return JSON.parse(req.body.data); }'],
  ['new URL of query', 'open-redirect', 'function f(req) { return new URL(req.query.next); }'],
  ['res.redirect of query', 'open-redirect', 'function f(req, res) { res.redirect(req.query.next); }'],
  ['nosql operand from body', 'nosql-injection', route('  const user = await User.findOne({ email: req.body.email, password: req.body.password });\n  return user;')],
  ['nosql via destructure', 'nosql-injection', route('  const { email } = req.body;\n  return User.findOne({ email });')],
  ['path traversal readFile', 'path-traversal', "function f(req) { return fs.readFileSync('/data/' + req.query.name); }"],
  ['path traversal sendFile', 'path-traversal', 'function f(req, res) { res.sendFile(path.join(base, req.params.file)); }'],
  ['missing await', 'missing-await', "import mongoose from 'mongoose';\nasync function f(doc) {\n  doc.save();\n  return doc;\n}"],
  ['hard-coded secret', 'hard-coded-secret', "const jwtSecret = 'super-secret-value-123';"],
  ['hard-coded secret property', 'hard-coded-secret', "const config = { apiKey: 'abcd1234efgh5678' };"],
  ['eval of input', 'eval-input', 'function f(code) { return eval(code); }'],
  ['new Function of input', 'eval-input', 'function f(code) { return new Function(code); }'],
  ['status from body', 'mass-assignment', 'function f(req, user) { user.status = req.body.status; }'],
];

for (const [name, rule, code] of SHOULD_FLAG) {
  test(`flags: ${name}`, () => assert.ok(rulesOf(code).has(rule), `expected ${rule}, got ${[...rulesOf(code)].join(',')}`));
}

const SHOULD_STAY_QUIET = [
  ['escaped regex', 'mass-assignment', 'const re = new RegExp(escapeRegExp(req.query.q));'],
  ['picked fields', 'mass-assignment', route('  const { name, email } = req.body;\n  await User.create({ name, email });')],
  ['string-coerced operand', 'nosql-injection', route('  return User.findOne({ email: String(req.body.email) });')],
  ['params id in query', 'nosql-injection', route('  return User.findOne({ _id: req.params.id });')],
  ['basename sanitised path', 'path-traversal', 'function f(req) { return fs.readFileSync(path.join(base, path.basename(req.query.name))); }'],
  ['awaited save', 'missing-await', 'async function f(doc) {\n  await doc.save();\n}'],
  ['returned save', 'missing-await', 'async function f(doc) {\n  return doc.save();\n}'],
  ['env secret', 'hard-coded-secret', 'const jwtSecret = process.env.JWT_SECRET;'],
  ['label not secret', 'hard-coded-secret', "const passwordField = 'password';"],
  ['try-wrapped JSON.parse', 'unparsed-json', 'function f(req) { try { return JSON.parse(req.body.data); } catch { return null; } }'],
  ['literal redirect', 'open-redirect', "function f(res) { res.redirect('/home'); }"],
  ['literal eval', 'eval-input', "const x = eval('1 + 1');"],
  ['guarded chain', 'unguarded-member-call', 'function f(data) { return (data.items ?? []).map((i) => i); }'],
];

for (const [name, rule, code] of SHOULD_STAY_QUIET) {
  test(`stays quiet: ${name}`, () => assert.ok(!rulesOf(code).has(rule), `unexpected ${rule}`));
}

test('falsy-fallback ignores string fallbacks in display code (JSX)', () => {
  const code = 'export const A = ({ branch, role }) => <div>{branch.branchId || branch.name}{ROLE_LABELS[role] || role}{label || "n/a"}</div>;';
  assert.ok(!rulesOf(code, 'a.jsx').has('falsy-fallback'));
  assert.ok(rulesOf('const n = Number(req.query.limit) || 20;').has('falsy-fallback'));
  assert.ok(rulesOf('const k = bucket.date || bucket.hour;').has('falsy-fallback'));
  assert.ok(!rulesOf('const k = count || 0;').has('falsy-fallback'));
});

test('nullish does not flag code that already guards', () => {
  for (const guarded of [
    'const a = Array.isArray(x?.items) ? x.items : [];',
    'const b = x?.name || "";',
    'const c = x?.name ?? "";',
    'const d = items ?? [];',
    'if (user?.role) { run(); }',
  ]) assert.ok(!rulesOf(guarded).has('nullish'), guarded);
  assert.ok(rulesOf('const v = x?.a.b();').has('nullish'));
  assert.ok(rulesOf('function f(a) { if (a == null) return 1; }').has('nullish'));
});

test('unguarded-call respects central async wrappers but not bare functions', () => {
  assert.ok(!rulesOf('router.get("/", asyncHandler(async (req, res) => { const p = jwt.verify(req.t, k); res.json(p); }));').has('unguarded-call'));
  assert.ok(!rulesOf('const mw = catchAsync(async (req) => bcrypt.compare(req.body.p, h));').has('unguarded-call'));
  assert.ok(rulesOf('function f(t) { return jwt.verify(t, k); }').has('unguarded-call'));
});

test('findings are ranked by risk: injection first, enum comparisons and fallbacks last', () => {
  const code = [
    'function a(role) { if (role === "ADMIN") return 1; }',
    'const n = Number(q.limit) || 20;',
    'function c(req) { return new RegExp(req.query.q); }',
    'function d(x) { if (x < 5) throw new Error("small"); }',
  ].join('\n');
  const found = scanSource(code, 'a.js').findings;
  const risk = (rule) => found.find((f) => (f.rule ?? f.category) === rule).risk;
  assert.ok(risk('regex-injection') > risk('throws'));
  assert.ok(risk('throws') > risk('falsy-fallback'));
  const enumBoundary = found.find((f) => f.category === 'boundary' && /ADMIN/.test(f.evidence));
  const numericBoundary = found.find((f) => f.category === 'boundary' && /x < 5/.test(f.evidence));
  assert.ok(enumBoundary.risk < numericBoundary.risk);
});

test('quell-ignore suppresses by line, by rule, and for a whole file', () => {
  const same = 'const n = Number(q.limit) || 20; // quell-ignore falsy-fallback';
  assert.ok(!rulesOf(same).has('falsy-fallback'));
  const previous = '// quell-ignore\nconst n = Number(q.limit) || 20;';
  assert.ok(!rulesOf(previous).has('falsy-fallback'));
  const otherRule = '// quell-ignore regex-injection\nconst n = Number(q.limit) || 20;';
  assert.ok(rulesOf(otherRule).has('falsy-fallback'));
  const block = '/* quell-ignore falsy-fallback, nullish */\nconst n = Number(q.limit) || 20;';
  assert.ok(!rulesOf(block).has('falsy-fallback'));
  const fileWide = '// quell-ignore-file\nconst n = Number(q.limit) || 20;\nfunction f(x) { if (x < 1) throw new Error("e"); }';
  assert.equal(scanSource(fileWide, 'a.js').findings.length, 0);
  assert.equal(scanSource(same, 'a.js').suppressed, 1);
});
