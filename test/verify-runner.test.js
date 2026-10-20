import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generate, report, verifyGenerated } from '../src/index.js';
import { detectRunner, packageRunner } from '../src/runner.js';

// Runner selection and the runner's working directory for `quell verify`, under the real Jest, Mocha and Vitest.
// Projects live in os.tmpdir() and link the repository's node_modules (as verify itself does for its copy).
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const modules = fileURLToPath(new URL('../node_modules', import.meta.url));
const created = [];

const SOURCE = { esm: 'export function clamp(n, max) {\n  if (n > max) return max;\n  return n;\n}\n', cjs: 'function clamp(n, max) {\n  if (n > max) return max;\n  return n;\n}\nmodule.exports = { clamp };\n' };
const BODY = 'expect(clamp(5, 3)).toBe(3);\n  expect(clamp(2, 3)).toBe(2);';
const TESTS = {
  jest: (rel) => `const { clamp } = require('${rel}');\ntest('clamps', () => {\n  ${BODY}\n});\n`,
  vitest: (rel) => `import { it, expect } from 'vitest';\nimport { clamp } from '${rel}';\nit('clamps', () => {\n  ${BODY}\n});\n`,
  mocha: (rel) => `const assert = require('node:assert/strict');\nconst { clamp } = require('${rel}');\ndescribe('clamp', () => {\n  it('clamps', () => {\n    assert.equal(clamp(5, 3), 3);\n    assert.equal(clamp(2, 3), 2);\n  });\n});\n`,
  node: (rel) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { clamp } from '${rel}';\ntest('clamps', () => {\n  assert.equal(clamp(5, 3), 3);\n  assert.equal(clamp(2, 3), 2);\n});\n`,
};
const STYLE = { jest: 'cjs', mocha: 'cjs', vitest: 'esm', node: 'esm' };

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function link(dir) {
  fs.symlinkSync(modules, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}

function scratch() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-runner-')));
  created.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of created) {
    try { fs.unlinkSync(path.join(dir, 'node_modules')); } catch { /* not linked here */ }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

/** A project with src/add.js and the test in `testDir` ('tests' = outside the source folder, 'src' = colocated). */
function project(runner, { manifest, testDir = 'tests' } = {}) {
  const dir = scratch();
  const style = STYLE[runner];
  write(path.join(dir, 'package.json'), JSON.stringify({ ...(style === 'esm' ? { type: 'module' } : {}), ...(manifest === undefined ? { devDependencies: { [runner]: '*' } } : manifest) }));
  write(path.join(dir, 'src', 'add.js'), SOURCE[style]);
  const testFile = path.join(dir, testDir, 'add.test.js');
  write(testFile, TESTS[runner](testDir === 'src' ? './add.js' : '../src/add.js'));
  link(dir);
  return { dir, sourceFile: path.join(dir, 'src', 'add.js'), testFile };
}

function quell(dir, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: dir });
}

const verifyCli = (dir, testFile, sourceFile, ...extra) => quell(dir, 'verify', path.relative(dir, testFile), '--source', path.relative(dir, sourceFile), '--json', ...extra);

for (const runner of ['jest', 'vitest', 'mocha']) {
  test(`verify detects ${runner} from package.json and finds a test outside the source folder`, { timeout: 240_000 }, () => {
    const { dir, sourceFile, testFile } = project(runner);
    const run = verifyCli(dir, testFile, sourceFile);
    const result = JSON.parse(run.stdout || '{}');
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(result.verified, true, JSON.stringify(result));
    assert.equal(result.runner, runner);
    assert.equal(result.runnerSource, 'detected');
    assert.match(result.correctCode.command, new RegExp(runner));
    assert.ok(result.killed >= 1);
  });

  test(`verify --runner ${runner} finds a test outside the source folder and a colocated one`, { timeout: 240_000 }, () => {
    for (const testDir of ['tests', 'src']) {
      const { dir, sourceFile, testFile } = project(runner, { manifest: {}, testDir });
      const run = verifyCli(dir, testFile, sourceFile, '--runner', runner);
      const result = JSON.parse(run.stdout || '{}');
      assert.equal(run.status, 0, `${testDir}: ${run.stdout}${run.stderr}`);
      assert.equal(result.runner, runner);
      assert.equal(result.runnerSource, 'flag');
    }
  });
}

test('node:test verifies a test outside the source folder', { timeout: 120_000 }, () => {
  const { dir, sourceFile, testFile } = project('node', { manifest: {} });
  const run = verifyCli(dir, testFile, sourceFile);
  const result = JSON.parse(run.stdout || '{}');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual([result.runner, result.runnerSource], ['node', 'default']);
});

test('an explicit --runner wins over what package.json says', { timeout: 120_000 }, () => {
  const { dir, sourceFile, testFile } = project('node', { manifest: { type: 'module', devDependencies: { jest: '*' } } });
  assert.equal(detectRunner(dir), 'jest');
  const run = verifyCli(dir, testFile, sourceFile, '--runner', 'node');
  const result = JSON.parse(run.stdout || '{}');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual([result.runner, result.runnerSource], ['node', 'flag']);
});

test('text output says which runner was used and how', { timeout: 120_000 }, () => {
  const { dir, sourceFile, testFile } = project('mocha');
  const detected = quell(dir, 'verify', path.relative(dir, testFile), '--source', path.relative(dir, sourceFile));
  assert.equal(detected.status, 0, detected.stdout + detected.stderr);
  assert.match(detected.stdout, /^runner: mocha \(detected from package\.json\)$/m);
  const forced = quell(dir, 'verify', path.relative(dir, testFile), '--source', path.relative(dir, sourceFile), '--runner', 'mocha');
  assert.match(forced.stdout, /^runner: mocha \(--runner\)$/m);
  // The runner line also helps when the run fails.
  fs.writeFileSync(testFile, "throw new Error('boom');\n");
  const failing = quell(dir, 'verify', path.relative(dir, testFile), '--source', path.relative(dir, sourceFile));
  assert.equal(failing.status, 4);
  assert.match(failing.stdout, /^runner: mocha \(detected from package\.json\)$/m);
});

test('nothing detectable falls back to node:test, and a package.json above the project root is never consulted', { timeout: 120_000 }, () => {
  // Source and test live in different packages, so the project root is their common ancestor (packages/), not the repository.
  const dir = scratch();
  write(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { jest: '*' } }));
  write(path.join(dir, 'packages', 'a', 'package.json'), '{"name":"a","type":"module"}');
  write(path.join(dir, 'packages', 'a', 'src', 'add.js'), SOURCE.esm);
  write(path.join(dir, 'packages', 'b', 'tests', 'add.test.mjs'), TESTS.node('../../a/src/add.js'));
  const testFile = path.join(dir, 'packages', 'b', 'tests', 'add.test.mjs');
  const sourceFile = path.join(dir, 'packages', 'a', 'src', 'add.js');
  assert.equal(detectRunner(dir), 'jest');
  const run = verifyCli(dir, testFile, sourceFile);
  const result = JSON.parse(run.stdout || '{}');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual([result.runner, result.runnerSource], ['node', 'default']);
  assert.match(quell(dir, 'verify', path.relative(dir, testFile), '--source', path.relative(dir, sourceFile)).stdout, /^runner: node \(default: no runner found in package\.json\)$/m);
});

test('the package.json nearest to the test decides in a monorepo (source and test in different packages)', { timeout: 240_000 }, () => {
  const dir = scratch();
  write(path.join(dir, 'package.json'), JSON.stringify({ private: true, devDependencies: { jest: '*' } }));
  write(path.join(dir, 'packages', 'a', 'package.json'), '{"name":"a","type":"module"}');
  write(path.join(dir, 'packages', 'a', 'src', 'add.js'), SOURCE.esm);
  write(path.join(dir, 'packages', 'b', 'package.json'), JSON.stringify({ name: 'b', type: 'module', devDependencies: { vitest: '*' } }));
  write(path.join(dir, 'packages', 'b', 'tests', 'add.test.js'), TESTS.vitest('../../a/src/add.js'));
  link(dir);
  const run = verifyCli(dir, path.join(dir, 'packages', 'b', 'tests', 'add.test.js'), path.join(dir, 'packages', 'a', 'src', 'add.js'));
  const result = JSON.parse(run.stdout || '{}');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual([result.runner, result.runnerSource], ['vitest', 'detected']);
});

test('the runner runs in the root of the package that owns the test; --command keeps the source folder', { timeout: 120_000 }, () => {
  const dir = scratch();
  write(path.join(dir, 'package.json'), '{"type":"module"}');
  write(path.join(dir, 'src', 'add.js'), SOURCE.esm);
  // Passes only when the working directory holds package.json (the project root) and not src/.
  const rootTest = TESTS.node('../src/add.js').replace("import test from 'node:test';", "import test from 'node:test';\nimport fs from 'node:fs';") + "test('cwd', () => {\n  assert.equal(fs.existsSync('package.json'), true);\n});\n";
  write(path.join(dir, 'tests', 'add.test.js'), rootTest);
  const run = verifyCli(dir, path.join(dir, 'tests', 'add.test.js'), path.join(dir, 'src', 'add.js'));
  assert.equal(run.status, 0, run.stdout + run.stderr);
  // A custom command is the user's own: it still runs in the source file's folder.
  write(path.join(dir, 'tests', 'cmd.mjs'), "import fs from 'node:fs';\nimport assert from 'node:assert/strict';\nimport { clamp } from '../src/add.js';\nassert.equal(fs.existsSync('add.js'), true);\nassert.equal(clamp(5, 3), 3);\nassert.equal(clamp(2, 3), 2);\n");
  const command = verifyCli(dir, path.join(dir, 'tests', 'cmd.mjs'), path.join(dir, 'src', 'add.js'), '--command', 'node {test}');
  const result = JSON.parse(command.stdout || '{}');
  assert.equal(command.status, 0, command.stdout + command.stderr);
  assert.deepEqual([result.runner, result.runnerSource], [null, null]);
  assert.equal(quell(dir, 'verify', path.join('tests', 'cmd.mjs'), '--source', path.join('src', 'add.js'), '--command', 'node {test}').stdout.includes('runner:'), false);
});

test('the library detects the runner too, and an explicit runner is reported as given', { timeout: 120_000 }, () => {
  const { sourceFile, testFile } = project('mocha');
  const detected = verifyGenerated(null, { sourceFile, testPath: testFile });
  assert.equal(detected.verified, true, JSON.stringify(detected));
  assert.deepEqual([detected.runner, detected.runnerSource], ['mocha', 'detected']);
  const missing = verifyGenerated(null, { sourceFile, testPath: path.join(path.dirname(testFile), 'missing.test.js'), runner: 'mocha' });
  assert.equal(missing.verified, false);
  assert.match(missing.reason, /test file not found/);
});

// --- how package.json names a runner -------------------------------------------------------------------------------------

function manifestDir(manifest) {
  const dir = scratch();
  write(path.join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return dir;
}

const SCRIPT_ONLY = [
  ['jest --ci', 'jest'], ['jest', 'jest'], ['react-scripts test --watchAll=false', 'jest'], ['cross-env NODE_ENV=test jest --coverage', 'jest'], ['./node_modules/.bin/jest', 'jest'],
  ['vitest', 'vitest'], ['vitest run', 'vitest'], ['npx vitest run --coverage', 'vitest'],
  ['mocha', 'mocha'], ['c8 mocha "test/**/*.js"', 'mocha'], ['cross-env X=1 mocha --exit', 'mocha'],
  ['node --test', 'node'], ['node --import tsx --test test/', 'node'],
];

test('a runner named only in scripts.test is detected (no dependencies)', () => {
  for (const [script, expected] of SCRIPT_ONLY) {
    const dir = manifestDir({ scripts: { test: script } });
    assert.equal(packageRunner(dir), expected, script);
    assert.equal(detectRunner(dir), expected, script);
  }
});

test('names that only contain a runner name do not select it', () => {
  const quiet = [
    { devDependencies: { 'vitest-foo': '1' } }, { devDependencies: { '@vitest/ui': '1' } }, { devDependencies: { 'ts-jest': '1', 'jest-circus': '1', 'mocha-junit-reporter': '1' } },
    { scripts: { test: 'jest-circus-runner' } }, { scripts: { test: 'ts-jest-helper' } }, { scripts: { test: 'echo mocha-free' } }, { scripts: { test: 'echo @vitest/ui' } },
    { scripts: { test: 'node script.js' } }, { scripts: { test: 'node --test-reporter spec script.js' } },
  ];
  for (const manifest of quiet) {
    const dir = manifestDir(manifest);
    assert.equal(packageRunner(dir), null, JSON.stringify(manifest));
    assert.equal(detectRunner(dir), 'node', JSON.stringify(manifest));
  }
});

for (const [script, runner] of [['jest --ci', 'jest'], ['mocha', 'mocha'], ['vitest run', 'vitest']]) {
  test(`verify detects ${runner} when only scripts.test names it ("${script}")`, { timeout: 240_000 }, () => {
    const { dir, sourceFile, testFile } = project(runner, { manifest: { scripts: { test: script } } });
    const run = quell(dir, 'verify', path.relative(dir, testFile), '--source', path.relative(dir, sourceFile));
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp(`^runner: ${runner} \\(detected from package\\.json\\)$`, 'm'));
  });
}

test('a package.json that names no runner defers to the one above it, up to the project root and no further', { timeout: 240_000 }, () => {
  // tests/package.json is only a module-type marker; jest is named by the project's package.json.
  const marked = project('jest');
  write(path.join(marked.dir, 'tests', 'package.json'), '{"type":"commonjs"}');
  const run = verifyCli(marked.dir, marked.testFile, marked.sourceFile);
  const result = JSON.parse(run.stdout || '{}');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual([result.runner, result.runnerSource], ['jest', 'detected']);
  // The same walk serves generate's detectRunner and a workspace package that names no tooling of its own.
  assert.equal(detectRunner(path.join(marked.dir, 'tests')), 'jest');
  const workspace = scratch();
  write(path.join(workspace, 'package.json'), JSON.stringify({ private: true, devDependencies: { vitest: '*' } }));
  write(path.join(workspace, 'packages', 'a', 'package.json'), '{"name":"a"}');
  assert.equal(detectRunner(path.join(workspace, 'packages', 'a')), 'vitest');
  // A runner in a package.json above the project root is not used: the project is the package holding the source and the test.
  const outer = scratch();
  write(path.join(outer, 'package.json'), JSON.stringify({ devDependencies: { jest: '*' } }));
  const inner = path.join(outer, 'app');
  write(path.join(inner, 'package.json'), '{"name":"app","type":"module"}');
  write(path.join(inner, 'src', 'add.js'), SOURCE.esm);
  write(path.join(inner, 'tests', 'add.test.js'), TESTS.node('../src/add.js'));
  const bounded = verifyCli(inner, path.join(inner, 'tests', 'add.test.js'), path.join(inner, 'src', 'add.js'));
  const boundedResult = JSON.parse(bounded.stdout || '{}');
  assert.equal(bounded.status, 0, bounded.stdout + bounded.stderr);
  assert.deepEqual([boundedResult.runner, boundedResult.runnerSource], ['node', 'default']);
});

test('a package.json with a BOM is read; an unreadable one is reported as such, not as "no runner found"', { timeout: 120_000 }, () => {
  const bom = project('mocha', { manifest: {} });
  fs.writeFileSync(path.join(bom.dir, 'package.json'), `\uFEFF${JSON.stringify({ devDependencies: { mocha: '*' } })}`);
  assert.equal(packageRunner(bom.dir), 'mocha');
  // Mocha itself cannot parse a BOM package.json, so the run may fail; the point is which runner was chosen.
  const detected = verifyCli(bom.dir, bom.testFile, bom.sourceFile);
  assert.deepEqual([JSON.parse(detected.stdout).runner, JSON.parse(detected.stdout).runnerSource], ['mocha', 'detected']);

  const nodeProject = (packageJson) => {
    const dir = scratch();
    if (packageJson === 'directory') fs.mkdirSync(path.join(dir, 'package.json'));
    else write(path.join(dir, 'package.json'), packageJson);
    write(path.join(dir, 'src', 'add.mjs'), SOURCE.esm);
    write(path.join(dir, 'tests', 'add.test.mjs'), TESTS.node('../src/add.mjs'));
    return quell(dir, 'verify', path.join('tests', 'add.test.mjs'), '--source', path.join('src', 'add.mjs'));
  };
  const invalid = nodeProject('{ "devDependencies": ');
  assert.equal(invalid.status, 0, invalid.stdout + invalid.stderr);
  assert.match(invalid.stdout, /^runner: node \(default: could not read package\.json \(.+\)\)$/m);
  assert.doesNotMatch(invalid.stdout, /no runner found/);
  const directory = nodeProject('directory');
  assert.match(directory.stdout, /^runner: node \(default: could not read package\.json \(.+\)\)$/m);
  const quiet = nodeProject('{"name":"x"}');
  assert.match(quiet.stdout, /^runner: node \(default: no runner found in package\.json\)$/m);
});

test('a source and test path that differ in drive-letter case still run inside the copy (Windows)', { skip: process.platform !== 'win32' && 'drive letters exist only on Windows', timeout: 120_000 }, () => {
  const dir = scratch();
  write(path.join(dir, 'package.json'), '{"type":"module"}');
  write(path.join(dir, 'src', 'add.js'), SOURCE.esm);
  // Passes only when it runs in the throwaway copy (quell-verify-*), not in the real project.
  write(path.join(dir, 'tests', 'add.test.js'), `${TESTS.node('../src/add.js')}test('cwd', () => {\n  assert.match(process.cwd(), /quell-verify-/);\n});\n`);
  const lower = (file) => file.replace(/^[A-Z]:/, (drive) => drive.toLowerCase());
  const upper = (file) => file.replace(/^[a-z]:/, (drive) => drive.toUpperCase());
  const result = verifyGenerated(null, { sourceFile: upper(path.join(dir, 'src', 'add.js')), testPath: lower(path.join(dir, 'tests', 'add.test.js')) });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.isolation, 'copy');
  assert.equal(fs.readFileSync(path.join(dir, 'src', 'add.js'), 'utf8'), SOURCE.esm);
});

test('generate --verify says whether it detected the runner or was told', { timeout: 240_000 }, () => {
  const repo = process.cwd();
  for (const [options, expected] of [[{}, 'detected'], [{ runner: 'vitest' }, 'flag']]) {
    const dir = scratch();
    fs.cpSync(path.join(repo, 'eval', 'matrix', 'esm'), dir, { recursive: true });
    write(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vitest: '*' } }));
    link(dir);
    try {
      process.chdir(dir);
      const results = generate(report('src', { coverage: false }), { ...options, destination: path.join(dir, 'tests', 'quelltest'), verify: true });
      const verified = results.filter((item) => item.status === 'VERIFIED');
      assert.ok(verified.length >= 1, JSON.stringify(results.map((r) => [r.status, r.reason])));
      assert.deepEqual([verified[0].verification.runner, verified[0].verification.runnerSource], ['vitest', expected]);
    } finally {
      process.chdir(repo);
    }
  }
});
