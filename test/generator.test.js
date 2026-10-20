import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { report, generate, generateWithLlm } from '../src/index.js';
import { securityGate, originalityGate } from '../src/generator.js';
import { renderTest, detectRunner } from '../src/runner.js';

const PAY = [
  'export function pay(amount, currency) {',
  '  if (amount <= 0) throw new RangeError("amount must be positive");',
  '  if (typeof currency !== "string") throw new TypeError("currency required");',
  '  return amount;',
  '}',
  '',
].join('\n');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-gen-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return { dir, src: path.join(dir, 'src'), out: path.join(dir, 'out') };
}

const options = (p, extra = {}) => ({ destination: p.out, runner: 'node', ...extra });
const nodeTest = (dir) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const files = fs.readdirSync(dir).filter((name) => /\.test\.[cm]?js$/.test(name)).map((name) => path.join(dir, name));
  return spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', env });
};

test('guards become real tests that import the unit, assert, and survive verification', () => {
  const p = project({ 'src/pay.mjs': PAY });
  const results = generate(report(p.src, { coverage: false }), options(p, { write: true, verify: true }));
  const tests = results.filter((item) => item.kind === 'test' && item.status !== 'FLAGGED');
  assert.ok(tests.length >= 2, JSON.stringify(results.map((r) => [r.category, r.status, r.reason])));
  assert.ok(tests.every((item) => item.status === 'VERIFIED' && item.verified && item.gates.injectedBug === 'PASSED'));
  for (const item of tests) {
    const source = fs.readFileSync(item.output, 'utf8');
    assert.match(source, /import \{ pay \} from/);
    assert.match(source, /assert\.throws\(/);
    assert.doesNotMatch(source, /assert\.ok\(true\)/);
    assert.match(item.output, /\.test\.mjs$/);
  }
  const run = nodeTest(p.out);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(fs.readFileSync(path.join(p.src, 'pay.mjs'), 'utf8'), PAY, 'source untouched');
});

test('boundary values around the constant are exercised', () => {
  const p = project({ 'src/pay.mjs': PAY });
  const results = generate(report(p.src, { coverage: false }), options(p, { write: true }));
  const source = fs.readFileSync(results.find((item) => item.category === 'throws' && item.output).output, 'utf8');
  for (const value of ['pay(-1,', 'pay(0,', 'pay(1,']) assert.ok(source.includes(value), `missing ${value}`);
  assert.match(source, /message: "amount must be positive"/);
  assert.match(source, /name: "RangeError"/);
});

test('dry run plans tests but writes nothing', () => {
  const p = project({ 'src/pay.mjs': PAY });
  const results = generate(report(p.src, { coverage: false }), options(p));
  assert.ok(results.some((item) => item.status === 'GENERATED'));
  assert.ok(results.every((item) => item.output === null));
  assert.equal(fs.existsSync(p.out), false);
});

test('CommonJS modules get require()-based .cjs tests', () => {
  const p = project({ 'src/guard.js': 'function guard(n) {\n  if (n < 5) throw new Error("small");\n  return n;\n}\nmodule.exports = { guard };\n' });
  const results = generate(report(p.src, { coverage: false }), options(p, { write: true, verify: true }));
  const item = results.find((entry) => entry.kind === 'test');
  assert.match(item.output, /\.test\.cjs$/);
  const source = fs.readFileSync(item.output, 'utf8');
  assert.match(source, /require\("\.\.\/src\/guard\.js"\)/);
  assert.equal(nodeTest(p.out).status, 0);
});

test('anything that cannot be tested becomes a TODO note, never a placeholder test', () => {
  const p = project({
    'src/internal.mjs': 'function hidden(n) {\n  if (n < 5) throw new Error("small");\n}\nexport const x = 1;\n',
    'src/asyncy.mjs': 'export async function load(a) {\n  await a();\n}\n',
  });
  const results = generate(report(p.src, { coverage: false }), options(p, { write: true }));
  assert.ok(results.length >= 2);
  assert.ok(results.every((item) => item.status === 'TODO' && item.kind === 'todo' && item.reason));
  assert.ok(results.some((item) => /not exported/.test(item.reason)));
  const files = fs.readdirSync(p.out);
  assert.ok(files.every((name) => name.endsWith('.todo.md')));
  assert.match(fs.readFileSync(path.join(p.out, files[0]), 'utf8'), /not a test/);
});

test('JSDoc @example lines become equality assertions', () => {
  const p = project({ 'src/add.mjs': '/**\n * @example\n * add(1, 2) // => 3\n * add(-1, 1) => 0\n */\nexport function add(a, b) {\n  return a + b;\n}\n' });
  const results = generate(report(p.src, { coverage: false }), options(p, { write: true, verify: true }));
  const item = results.find((entry) => entry.kind === 'test');
  assert.ok(item, JSON.stringify(results.map((r) => r.reason)));
  assert.match(fs.readFileSync(item.output, 'utf8'), /assert\.deepStrictEqual\(add\(1, 2\), 3\)/);
  assert.equal(item.status, 'VERIFIED');
});

test('duplicate guards are not emitted twice', () => {
  const p = project({ 'src/pay.mjs': PAY });
  const results = generate(report(p.src, { coverage: false }), options(p));
  const sources = results.filter((item) => item.kind === 'test' && item.status !== 'FLAGGED').map((item) => item.source);
  assert.equal(new Set(sources).size, sources.length);
  assert.ok(results.some((item) => item.status === 'FLAGGED' && /already present/.test(item.reason)));
});

test('tests are rendered for the detected runner and module system', () => {
  const base = { importPath: '../src/a.js', exportInfo: { kind: 'named', name: 'f' }, functionName: 'f', isAsync: false, cases: [{ args: ['1'], kind: 'throws', message: 'm', errorName: 'RangeError', title: 't' }, { args: ['2'], kind: 'ok', title: 'u' }] };
  const jestCjs = renderTest({ ...base, runner: 'jest', style: 'cjs' });
  assert.match(jestCjs, /const \{ f \} = require\("\.\.\/src\/a\.js"\);/);
  assert.match(jestCjs, /describe\("f"/);
  assert.match(jestCjs, /expect\(\(\) => f\(1\)\)\.toThrow\("m"\)/);
  assert.match(jestCjs, /\.not\.toThrow\(\)/);
  assert.doesNotMatch(jestCjs, /node:test/);
  const vitest = renderTest({ ...base, runner: 'vitest', style: 'cjs' });
  assert.match(vitest, /from 'vitest'/);
  assert.match(vitest, /import unit from/);
  const mocha = renderTest({ ...base, runner: 'mocha', style: 'esm' });
  assert.match(mocha, /import assert from 'node:assert\/strict'/);
  assert.match(mocha, /it\("t"/);
  const asyncJest = renderTest({ ...base, runner: 'jest', style: 'esm', isAsync: true });
  assert.match(asyncJest, /await expect\(f\(1\)\)\.rejects\.toThrow/);
});

test('detectRunner reads package.json', () => {
  const dev = (deps, extra = {}) => project({ 'package.json': JSON.stringify({ devDependencies: deps, ...extra }) }).dir;
  assert.equal(detectRunner(dev({ jest: '29' })), 'jest');
  assert.equal(detectRunner(dev({ 'react-scripts': '5' })), 'jest');
  assert.equal(detectRunner(dev({ vitest: '1', jest: '29' })), 'vitest');
  assert.equal(detectRunner(dev({ mocha: '10' })), 'mocha');
  assert.equal(detectRunner(dev({})), 'node');
});

test('security gate inspects code, not comments or quoted evidence', () => {
  assert.equal(securityGate('// process.env.NODE_ENV is mentioned\nconst s = "eval(x) fetch(y)";\n').passed, true);
  assert.equal(securityGate("const { f } = require('../src/a.js');\n").passed, true);
  for (const bad of ['eval("1")', 'fetch("http://x")', "require('child_process')", "import cp from 'node:child_process';", 'const x = process.env.SECRET;', 'new Function("return 1")', 'require(name)', 'process.exit(1)']) {
    assert.equal(securityGate(bad).passed, false, bad);
  }
  assert.equal(securityGate('function (((').passed, false);
  assert.equal(originalityGate('a  b', 'x a b y').passed, false);
  assert.equal(originalityGate('', '').passed, false);
});

test('invalid options fail loudly', () => {
  const p = project({ 'src/pay.mjs': PAY });
  const result = report(p.src, { coverage: false });
  assert.throws(() => generate(result, { runner: 'karma' }), /unsupported runner/);
  fs.writeFileSync(p.out, 'a file');
  assert.throws(() => generate(result, { destination: p.out, runner: 'node' }), /not a directory/);
});

test('optional LLM assist is gated: only verified tests are accepted', async () => {
  const p = project({ 'src/complex.mjs': 'export function f(a, b) {\n  if (a.x && b > 1) throw new Error("bad");\n  return 1;\n}\n' });
  const result = report(p.src, { coverage: false });
  const header = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { f } from '../src/complex.mjs';\n";
  const good = `${header}test('f', () => {\n  assert.throws(() => f({ x: 1 }, 2), { message: 'bad' });\n  assert.equal(f({ x: 0 }, 2), 1);\n});\n`;
  const accepted = await generateWithLlm(result, options(p, { write: true, llm: async () => good }));
  assert.ok(accepted.some((item) => item.llm && item.status === 'VERIFIED'));
  assert.equal(nodeTest(p.out).status, 0);

  const q = project({ 'src/complex.mjs': 'export function f(a, b) {\n  if (a.x && b > 1) throw new Error("bad");\n  return 1;\n}\n' });
  const calls = [];
  for (const candidate of [`${header}test('p', () => { assert.ok(true); });\n`, `${header}test('e', () => { eval("1"); assert.equal(f({}, 0), 1); });\n`, 'not javascript ((']) {
    const rejected = await generateWithLlm(report(q.src, { coverage: false }), options(q, { llm: async () => { calls.push(1); return candidate; } }));
    assert.ok(rejected.every((item) => item.status === 'TODO'), candidate);
    assert.ok(rejected.some((item) => /llm test rejected/.test(item.reason)), candidate);
  }
  const failing = await generateWithLlm(report(q.src, { coverage: false }), options(q, { llm: async () => { throw new Error('offline'); } }));
  assert.ok(failing.some((item) => /llm callback failed: offline/.test(item.reason)));
  await assert.rejects(() => generateWithLlm(result, {}), TypeError);
  assert.ok(calls.length >= 3);
});

test('CLI generate --write --verify writes verified tests to --destination', () => {
  const p = project({ 'src/pay.mjs': PAY });
  const cli = path.resolve('src/cli.js');
  const run = spawnSync(process.execPath, [cli, 'generate', p.src, '--write', '--verify', '--runner', 'node', '--destination', p.out, '--coverage', path.join(p.dir, 'none.json')], { encoding: 'utf8' });
  assert.equal(run.status, 2, 'missing coverage file is an error');
  const ok = spawnSync(process.execPath, [cli, 'generate', p.src, '--write', '--verify', '--runner', 'node', '--destination', p.out], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Wrote \d+ tests \(\d+ verified\)/);
  assert.ok(fs.readdirSync(p.out).some((name) => name.endsWith('.test.mjs')));
});

test('verification never deletes tests written by an earlier run', () => {
  const p = project({ 'src/pay.mjs': PAY });
  const first = generate(report(p.src, { coverage: false }), options(p, { write: true, verify: true }));
  const written = first.filter((item) => item.output && item.kind === 'test').map((item) => item.output);
  assert.ok(written.length >= 2);
  const before = written.map((file) => fs.readFileSync(file, 'utf8'));
  generate(report(p.src, { coverage: false }), options(p, { verify: true }));
  assert.deepEqual(written.map((file) => fs.readFileSync(file, 'utf8')), before);
  assert.equal(fs.readdirSync(p.out).filter((name) => name.includes('probe')).length, 0);
});

test('a dry-run verification leaves no directory or probe files behind', () => {
  const p = project({ 'src/pay.mjs': PAY });
  generate(report(p.src, { coverage: false }), options(p, { verify: true }));
  assert.equal(fs.existsSync(p.out), false);
});

test('security gate rejects aliasing, fs access and unlisted imports', () => {
  for (const bad of ['const p = process; p.exit(1);', 'globalThis["ev" + "al"]("1")', "import fs from 'node:fs';", "const fs = require('fs');", 'module.require("child_process")', "import x from 'left-pad';", 'process["env"].X']) {
    assert.equal(securityGate(bad).passed, false, bad);
  }
  assert.equal(securityGate("import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { f } from '../src/a.js';\nconst o = { process: 1 }; o.global;\n").passed, true);
});

test('export { f as default } is treated as a default export', async () => {
  const { describeModule, exportOf } = await import('../src/unit.js');
  const module = describeModule('function f(n) { if (n < 1) throw new Error("x"); }\nexport { f as default };\n', 'a.mjs');
  assert.deepEqual(exportOf(module, 'f'), { kind: 'default', name: 'f' });
});

test('examples work for function names containing regex characters', () => {
  const p = project({ 'src/dollar.mjs': '/**\n * @example\n * $add(1, 2) // => 3\n */\nexport function $add(a, b) {\n  return a + b;\n}\n' });
  const results = generate(report(p.src, { coverage: false }), options(p, { verify: true }));
  assert.ok(results.some((item) => item.status === 'VERIFIED'), JSON.stringify(results.map((r) => r.reason)));
});
