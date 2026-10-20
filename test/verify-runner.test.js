import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyGenerated } from '../src/index.js';
import { detectRunner } from '../src/runner.js';

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
