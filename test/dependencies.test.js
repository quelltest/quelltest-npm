import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generate, report } from '../src/index.js';
import { securityGate } from '../src/generator.js';

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-deps-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return { dir, src: path.join(dir, 'src'), out: path.join(dir, 'out') };
}

const run = (p, extra = {}) => generate(report(p.src, { coverage: false }), { destination: p.out, runner: 'node', write: true, verify: true, ...extra });
const nodeTest = (dir) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const files = fs.readdirSync(dir).filter((name) => /\.test\.[cm]?js$/.test(name)).map((name) => path.join(dir, name));
  return spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', env });
};
const sources = (results) => results.filter((item) => item.output && item.kind === 'test').map((item) => fs.readFileSync(item.output, 'utf8')).join('\n');

// ---- property guards ---------------------------------------------------------------------------------------------

const VALIDATOR = [
  'export function validateGeofence(body) {',
  "  if (typeof body.lat !== 'number') throw new TypeError('lat must be a number');",
  "  if (typeof body.lng !== 'number') throw new TypeError('lng must be a number');",
  "  if (body.lat < -90 || body.lat > 90) throw new RangeError('lat out of range');",
  '  return true;',
  '}',
  '',
].join('\n');

test('guards on object properties become verified tests with a composed argument', () => {
  const p = project({ 'src/validate.mjs': VALIDATOR });
  const results = run(p);
  const verified = results.filter((item) => item.status === 'VERIFIED');
  assert.ok(verified.length >= 2, JSON.stringify(results.map((r) => [r.line, r.status, r.reason])));
  const source = sources(results);
  assert.match(source, /validateGeofence\(\{ "lat": -?\d+, "lng": "a" \}\)/, 'varies body.lng while body.lat holds a safe number');
  assert.match(source, /validateGeofence\(\{ "lat": -91, "lng": \d+ \}\)/, 'varies body.lat while body.lng holds a safe number');
  assert.match(source, /"lat": 91/);
  assert.match(source, /message: "lat out of range"/);
  assert.equal(nodeTest(p.out).status, 0);
});

test('optional-chain length guards are handled', () => {
  const p = project({ 'src/branch.mjs': "export function needsGeofences(branch) {\n  if (!branch.geofences?.length) throw new Error('no geofences');\n  return true;\n}\n" });
  const results = run(p);
  assert.ok(results.some((item) => item.status === 'VERIFIED'), JSON.stringify(results.map((r) => r.reason)));
  assert.match(sources(results), /needsGeofences\(\{ "geofences": \{ "length": 0 \} \}\)/);
});

// ---- dependency results (AS4UT / Pex style stub synthesis) ---------------------------------------------------------

const LOAD_PLAN = [
  'export async function loadPlan(userId, fetchUser) {',
  '  if (!userId) throw new Error("userId required");',
  '  const res = await fetchUser(userId);',
  '  if (res.status === 404) return { plan: "free" };',
  '  if (res.status !== 200) throw new Error("upstream failed");',
  '  return { plan: res.data.items[0].plan };',
  '}',
  '',
].join('\n');

test('branches driven by an injected API client become tests with synthesised stubs', () => {
  const p = project({ 'src/plan.mjs': LOAD_PLAN });
  const results = run(p);
  const verified = results.filter((item) => item.status === 'VERIFIED');
  assert.ok(verified.length >= 3, JSON.stringify(results.map((r) => [r.line, r.status, r.reason])));
  const source = sources(results);
  assert.match(source, /async \(\) => \(\{ "status": 404 \}\)/, 'stub returns the 404 shape');
  assert.match(source, /deepStrictEqual\(await loadPlan\((?:true|"abc"|1), async \(\) => \(\{ "status": 404 \}\)\), \{ plan: "free" \}\)/);
  assert.match(source, /message: "upstream failed"/);
  assert.match(source, /Stubs below are derived from the guards in the source, not from the real service/);
  assert.equal(nodeTest(p.out).status, 0);
});

test('first-firing guard decides the expectation when conditions overlap (404 vs not-200)', () => {
  const p = project({ 'src/plan.mjs': LOAD_PLAN });
  const results = run(p);
  const blocks = sources(results).split(/\n\n(?=test\()/);
  assert.ok(blocks.some((block) => /upstream failed/.test(block)), 'the not-200 branch is tested');
  for (const block of blocks) assert.ok(!(/"status": 404/.test(block) && /upstream failed/.test(block)), 'a 404 must not be expected to throw "upstream failed"');
  assert.ok(blocks.some((block) => /upstream failed/.test(block) && /"status": (199|201|500|403|405)/.test(block)));
});

test('methods of an injected model are stubbed (User.findOne)', () => {
  const p = project({ 'src/find.mjs': "export async function findActive(User, email) {\n  if (typeof email !== 'string') throw new TypeError('email');\n  const u = await User.findOne({ email });\n  return u && u.active ? u : null;\n}\n" });
  const results = run(p);
  assert.ok(results.some((item) => item.status === 'VERIFIED'), JSON.stringify(results.map((r) => r.reason)));
  assert.match(sources(results), /findActive\(\{ "findOne": async \(\) => \(\{\s*\}\) \}, /);
  assert.equal(nodeTest(p.out).status, 0);
});

test('dependency results can be destructured', () => {
  const p = project({ 'src/d.mjs': 'export async function check(id, client) {\n  const { status } = await client.get(id);\n  if (status === 503) throw new Error("down");\n  return status;\n}\n' });
  const results = run(p);
  assert.ok(results.some((item) => item.status === 'VERIFIED'), JSON.stringify(results.map((r) => r.reason)));
  assert.match(sources(results), /"get": async \(\) => \(\{ "status": 503 \}\)/);
});

// ---- global fetch -----------------------------------------------------------------------------------------------

const REMOTE = [
  'export async function remoteTotal(url) {',
  '  const r = await fetch(url);',
  '  if (!r.ok) throw new Error("bad status");',
  '  const body = await r.json();',
  '  return body.total ?? 0;',
  '}',
  '',
].join('\n');

test('a guard on a global fetch response becomes a test that stubs and restores fetch', () => {
  const p = project({ 'src/remote.mjs': REMOTE });
  const results = run(p);
  const verified = results.find((item) => item.status === 'VERIFIED');
  assert.ok(verified, JSON.stringify(results.map((r) => [r.line, r.status, r.reason])));
  const source = fs.readFileSync(verified.output, 'utf8');
  assert.match(source, /const originalFetch = globalThis\.fetch;/);
  assert.match(source, /globalThis\.fetch = async \(\) => \(\{ "ok": false/);
  assert.match(source, /finally \{\s*globalThis\.fetch = originalFetch;/);
  assert.match(source, /message: "bad status"/);
  assert.equal(nodeTest(p.out).status, 0);
});

test('the security gate allows exactly the fetch-stub pattern and nothing else on globalThis', () => {
  const stub = "import test from 'node:test';\nconst originalFetch = globalThis.fetch;\nglobalThis.fetch = async () => ({ ok: false });\nglobalThis.fetch = originalFetch;\n";
  assert.equal(securityGate(stub).passed, true);
  const bad = [
    'globalThis.process.exit(1);', "globalThis['fetch'] = 1;", 'const g = globalThis;', 'globalThis.eval("1");', 'fetch("http://x");',
    "await globalThis.fetch('http://evil.example/x');", 'const g = globalThis.fetch; g("http://x");',
    "globalThis.fetch.constructor('return process')().exit(1);", 'const originalFetch = globalThis.fetch; originalFetch("http://x");',
  ];
  for (const code of bad) assert.equal(securityGate(code).passed, false, code);
});

test('TODO reasons name unsupported shapes precisely when a dependency is involved', () => {
  const p = project({ 'src/x.mjs': 'export async function f(client) {\n  const res = await client.get("x");\n  if (res.items.length > limit()) throw new Error("many");\n  return 1;\n}\n' });
  const reasons = generate(report(p.src, { coverage: false }), { destination: p.out, runner: 'node' }).map((item) => item.reason).join('\n');
  assert.match(reasons, /not a comparison of a parameter, its property or a dependency result with a literal/);
});
