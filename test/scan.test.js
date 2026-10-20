import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan } from '../src/index.js';
import { scanSource } from '../src/scan.js';
import { globToRegExp, isTestFile } from '../src/files.js';

const categories = (text, file = 'a.js') => scanSource(text, file).findings.map((f) => f.rule ?? f.category);

test('flags conditions that call a function before the comparison', () => {
  const found = scanSource('function f(b, s, t) { if (Number(b.accuracy) > 5) return 1; if (s.get("k") !== t) return 2; }', 'a.js').findings;
  assert.equal(found.filter((f) => f.category === 'boundary').length, 2);
});

test('reports per function with a bounded evidence snippet', () => {
  const long = `export function check(value) {\n  if (value < 0 || ${'value > 1 || '.repeat(80)}value > 2) throw new RangeError("out of range");\n}`;
  const [boundary] = scanSource(long, 'a.js').findings.filter((f) => f.category === 'boundary');
  assert.equal(boundary.function, 'check');
  assert.ok(boundary.evidence.length <= 160);
});

test('ignores initialisers and environment guards that are not edge cases', () => {
  const found = categories('const [a, setA] = useState(null); const r = useRef(null); if (process.env.NODE_ENV !== "test") {}\nfunction f() { return Promise.resolve(null); }');
  assert.deepEqual(found, []);
});

test('reports one async finding per async function, not per await', () => {
  const found = categories('async function f() { await a(); await b(); await c(); }').filter((c) => c === 'async');
  assert.equal(found.length, 1);
});

test('reads thrown error messages and JSDoc contracts', () => {
  const found = scanSource('/**\n * @param {number} n\n * @throws {Error} bad\n */\nexport function f(n) { throw new TypeError("n must be a number"); }', 'a.js').findings;
  assert.ok(found.some((f) => f.category === 'throws' && f.suggestion.includes('n must be a number')));
  assert.ok(found.some((f) => f.category === 'jsdoc'));
});

test('finding ids survive unrelated edits above the code', () => {
  const body = 'export function f(x) { if (x <= 0) throw new Error("positive"); }\n';
  const before = scanSource(body, 'a.js').findings.map((f) => f.id);
  const after = scanSource(`// header\n\n\nconst unrelated = 1;\n${body}`, 'a.js').findings.map((f) => f.id);
  assert.deepEqual(after, before);
  assert.equal(new Set(before).size, before.length);
});

test('repeated identical guards in one function get distinct ids', () => {
  const ids = scanSource('function f(x) { if (x < 1) return; if (x < 1) return; }', 'a.js').findings.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('rule pack flags defects that lack a guard', () => {
  const source = [
    'router.post("/x", async (req, res) => {',
    '  const a = Number(req.body.page) || 20;',
    '  const re = new RegExp(req.query.q);',
    '  const q = { name: { $regex: req.query.q } };',
    '  Object.assign(doc, req.body.changes);',
    '  jwt.verify(token, key);',
    '  data.items.map(render);',
    '  if (await User.exists({ a })) return;',
    '  await User.create({ a });',
    '});',
  ].join('\n');
  const rules = new Set(categories(source));
  for (const rule of ['falsy-fallback', 'regex-injection', 'mass-assignment', 'unguarded-call', 'unguarded-member-call', 'check-then-act', 'unhandled-async-route']) {
    assert.ok(rules.has(rule), `missing rule ${rule}`);
  }
});

test('rule pack stays quiet on guarded code', () => {
  const source = 'async function f(token) { try { return jwt.verify(token, key); } catch { return null; } }\nconst re = new RegExp(escapeRegExp(q));\nconst n = a ?? 20;';
  assert.deepEqual(categories(source).filter((c) => !['async', 'nullish'].includes(c)), []);
});

test('unparsable files are reported as skipped instead of crashing', () => {
  assert.equal(scanSource('function ((((', 'a.js').parsed, false);
});

test('parses TypeScript and JSX', () => {
  assert.ok(categories('export function f(n: number): void { if (n > 1) throw new Error("big"); }', 'a.ts').includes('throws'));
  assert.ok(categories('export const C = () => <div>{a?.b}</div>;', 'a.jsx').includes('nullish'));
});

test('directory scans skip tests, config and ignored paths; explicit files and flags override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-scan-'));
  const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
  const code = 'export function f(x) { if (x < 1) throw new Error("low"); }\n';
  write('src/a.js', code);
  write('src/a.test.js', code);
  write('tests/b.js', code);
  write('src/vendor/c.js', code);
  write('jest.config.js', code);
  write('.quellignore', 'src/vendor\n');
  const files = (options) => [...new Set(scan(dir, options).findings.map((f) => path.basename(f.file)))].sort();
  assert.deepEqual(files({}), ['a.js']);
  assert.deepEqual(files({ includeTests: true }), ['a.js', 'a.test.js', 'b.js']);
  assert.deepEqual(files({ exclude: ['a.js'] }), []);
  assert.deepEqual(files({ include: ['nothing/**'] }), []);
  assert.deepEqual([...new Set(scan(path.join(dir, 'src/a.test.js')).findings.map((f) => path.basename(f.file)))], ['a.test.js']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('glob and test-file helpers', () => {
  assert.ok(globToRegExp('**/*.js').test('a/b/c.js'));
  assert.ok(globToRegExp('vendor/').test('vendor/x.js'));
  assert.ok(globToRegExp('*.log').test('deep/dir/x.log'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(isTestFile('src/__tests__/a.js') && isTestFile('src/a.spec.ts') && !isTestFile('src/a.js'));
});
