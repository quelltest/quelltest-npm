import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { childNodes, parseSource } from './ast.js';
import { applyMutant, mutants } from './mutate.js';

const BACKUP_SUFFIX = '.quelltest-backup';
const NON_NODE_RUNNERS = {
  jest: (file) => ['jest', '--runTestsByPath', file],
  vitest: (file) => ['vitest', 'run', file],
  mocha: (file) => ['mocha', file],
};

// A parent `node --test` sets NODE_TEST_CONTEXT, which makes a nested `node --test` report success regardless of failures.
function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Run one test file in a subprocess (never in-process: module caches would hide mutations). */
export function runTest(testFile, { runner = 'node', cwd = path.dirname(testFile), timeoutMs = 60_000 } = {}) {
  let result;
  if (runner === 'node') {
    result = spawnSync(process.execPath, ['--test', testFile], { cwd, env: cleanEnv(), encoding: 'utf8', timeout: timeoutMs });
  } else if (NON_NODE_RUNNERS[runner]) {
    const windows = process.platform === 'win32';
    const args = NON_NODE_RUNNERS[runner](windows ? `"${testFile}"` : testFile);
    result = spawnSync(windows ? 'npx.cmd' : 'npx', ['--no-install', ...args], { cwd, env: cleanEnv(), encoding: 'utf8', timeout: timeoutMs, shell: windows });
  } else throw new Error(`unsupported runner: ${runner}`);
  if (result.error?.code === 'ETIMEDOUT' || result.signal) return { passed: false, timedOut: true, error: 'timed out' };
  return result.status === 0 ? { passed: true } : { passed: false, error: result.error?.message || result.stderr || result.stdout || `exit status ${result.status}` };
}

/**
 * True when the test contains an assertion that depends on something other than literals,
 * i.e. it can observe the code under test. `assert.ok(true)` and `assert.equal(1 + 1, 2)` do not count.
 */
export function hasMeaningfulAssertion(testSource) {
  const ast = parseSource(testSource, 'test.mjs');
  if (!ast) return false;
  const rootOf = (callee) => {
    let current = callee;
    while (current?.type === 'MemberExpression' || current?.type === 'CallExpression') current = current.object ?? current.callee;
    return current?.type === 'Identifier' ? current.name : null;
  };
  const observes = (node) => {
    if (node.type === 'CallExpression' || node.type === 'NewExpression' || node.type === 'AwaitExpression') return true;
    if (node.type === 'Identifier') return node.name !== 'undefined' && node.name !== 'NaN' && node.name !== 'Infinity';
    return [...childNodes(node)].some(observes);
  };
  let found = false;
  const visit = (node) => {
    if (node.type === 'CallExpression' && ['assert', 'expect'].includes(rootOf(node.callee)) && node.arguments.some(observes)) found = true;
    for (const child of childNodes(node)) visit(child);
  };
  visit(ast.program);
  return found;
}

function restoreIfInterrupted(sourceFile) {
  const backup = sourceFile + BACKUP_SUFFIX;
  if (fs.existsSync(backup)) {
    fs.copyFileSync(backup, sourceFile);
    fs.rmSync(backup);
  }
}

/**
 * Verify that a test really protects the code under test.
 *
 * 1. The test must pass on the original source.
 * 2. It must contain an assertion that observes the code (not a placeholder).
 * 3. Mutants of `sourceFile` (optionally only `functions`) are injected one at a time and the test
 *    must fail on at least one. The source is always restored in a `finally`, with an on-disk backup
 *    so an interrupted run is repaired on the next call.
 *
 * `testSource` is written to `testPath` for the run and removed afterwards; pass `null` to verify a
 * test file that already exists at `testPath`.
 */
export function verifyGenerated(testSource, options = {}) {
  const { sourceFile, runner = 'node', functions, maxMutants = 30, timeoutMs } = options;
  const unverified = (reason, extra = {}) => ({ verified: false, reason, correctCode: { passed: false }, injectedBug: { passed: false }, mutants: [], killed: 0, total: 0, mutationScore: null, ...extra });
  if (!sourceFile || !fs.existsSync(sourceFile)) return unverified('no source file to mutate: pass options.sourceFile');
  restoreIfInterrupted(sourceFile);
  const ext = path.extname(sourceFile);
  const testPath = options.testPath ?? path.join(path.dirname(sourceFile), `${path.basename(sourceFile, ext)}.quelltest-verify.test${runner === 'node' ? '.mjs' : ext}`);
  const ownsTest = testSource !== null && testSource !== undefined;
  const original = fs.readFileSync(sourceFile, 'utf8');
  const source = ownsTest ? testSource : fs.readFileSync(testPath, 'utf8');
  const runOptions = { runner, cwd: options.cwd ?? path.dirname(sourceFile), timeoutMs };

  if (ownsTest) fs.writeFileSync(testPath, testSource, 'utf8');
  try {
    const correctCode = runTest(testPath, runOptions);
    if (!correctCode.passed) return unverified('test fails on the original code', { correctCode });
    if (!hasMeaningfulAssertion(source)) return unverified('test has no assertion that observes the code under test', { correctCode });
    const candidates = mutants(original, sourceFile, { functions, max: maxMutants });
    if (!candidates.length) return unverified('no applicable mutation in the code under test', { correctCode });
    const results = [];
    fs.writeFileSync(sourceFile + BACKUP_SUFFIX, original, 'utf8');
    try {
      for (const mutant of candidates) {
        fs.writeFileSync(sourceFile, applyMutant(original, mutant), 'utf8');
        const run = runTest(testPath, runOptions);
        results.push({ description: mutant.description, line: mutant.line, function: mutant.function, killed: !run.passed });
      }
    } finally {
      fs.writeFileSync(sourceFile, original, 'utf8');
      fs.rmSync(sourceFile + BACKUP_SUFFIX, { force: true });
    }
    const killed = results.filter((item) => item.killed).length;
    return {
      verified: killed > 0, reason: killed > 0 ? null : 'test passes on every mutant of the code under test',
      correctCode, injectedBug: { passed: killed > 0 }, mutants: results, killed, total: results.length, mutationScore: Math.round((killed / results.length) * 100),
    };
  } finally {
    if (ownsTest) fs.rmSync(testPath, { force: true });
  }
}
