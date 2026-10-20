import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { childNodes, parseSource } from './ast.js';
import { BACKUP_SUFFIX, restoreIfInterrupted } from './backup.js';
import { applyMutant, mutants } from './mutate.js';

const RUNNER_PACKAGES = {
  jest: { name: 'jest', args: (file) => ['--runTestsByPath', file] },
  vitest: { name: 'vitest', args: (file) => ['run', file] },
  mocha: { name: 'mocha', args: (file) => [file] },
};
const ASSERTION_ROOTS = new Set(['assert', 'expect', 't', 'should', 'chai']);

// A parent `node --test` sets NODE_TEST_CONTEXT, which makes a nested `node --test` report success regardless of failures.
function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** Locate a runner's JavaScript entry point in node_modules (so no shell or npx is involved on any platform). */
function resolveRunnerEntry(runner, cwd) {
  const { name } = RUNNER_PACKAGES[runner];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(manifest)) {
      const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const entry = typeof bin === 'string' ? bin : (bin?.[name] ?? Object.values(bin ?? {})[0]);
      if (entry) return path.join(dir, 'node_modules', name, entry);
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * Run one test file in a subprocess (never in-process: module caches would hide mutations).
 * Result: `{ passed }`, or `{ passed: false, timedOut }`, `{ passed: false, infrastructure }` (the runner itself
 * could not run, which says nothing about the test), or `{ passed: false, error }` for a genuine test failure.
 */
export function runTest(testFile, { runner = 'node', cwd = path.dirname(testFile), timeoutMs = 60_000 } = {}) {
  const spawnOptions = { cwd, env: cleanEnv(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 };
  let result;
  if (runner === 'node') {
    result = spawnSync(process.execPath, ['--test', testFile], spawnOptions);
  } else if (RUNNER_PACKAGES[runner]) {
    const entry = resolveRunnerEntry(runner, cwd);
    if (!entry) return { passed: false, infrastructure: true, error: `${runner} is not installed in node_modules` };
    result = spawnSync(process.execPath, [entry, ...RUNNER_PACKAGES[runner].args(testFile)], spawnOptions);
  } else throw new Error(`unsupported runner: ${runner}`);
  if (result.error?.code === 'ETIMEDOUT') return { passed: false, timedOut: true, error: 'timed out' };
  if (result.error) return { passed: false, infrastructure: true, error: result.error.message };
  if (result.signal) return { passed: false, interrupted: true, error: `terminated by ${result.signal}` };
  return result.status === 0 ? { passed: true } : { passed: false, error: result.stderr || result.stdout || `exit status ${result.status}` };
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
    if (node.type === 'CallExpression' && ASSERTION_ROOTS.has(rootOf(node.callee)) && node.arguments.some(observes)) found = true;
    for (const child of childNodes(node)) visit(child);
  };
  visit(ast.program);
  return found;
}

function outcomeOf(run) {
  if (run.timedOut) return 'timeout';
  if (run.infrastructure) return 'error';
  return run.passed ? 'survived' : 'killed';
}

/**
 * Verify that a test really protects the code under test.
 *
 * 1. The test must pass on the original source.
 * 2. It must contain an assertion that observes the code (not a placeholder).
 * 3. Mutants of `sourceFile` (optionally only `functions`) are injected one at a time and the test
 *    must fail on at least one. Only genuine test failures count as kills: timeouts and runner
 *    errors are reported separately. The source is always restored in a `finally`, with an on-disk
 *    backup so a run killed outright is repaired on the next call (and by `scan`/`generate`).
 *    A Ctrl-C that reaches the test subprocess aborts the run and restores the source.
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
    if (!correctCode.passed) return unverified(correctCode.infrastructure ? `test runner could not run: ${correctCode.error}` : 'test fails on the original code', { correctCode });
    if (!hasMeaningfulAssertion(source)) return unverified('test has no assertion that observes the code under test', { correctCode });
    const candidates = mutants(original, sourceFile, { functions, max: maxMutants });
    if (!candidates.length) return unverified('no applicable mutation in the code under test', { correctCode });
    const results = [];
    fs.writeFileSync(sourceFile + BACKUP_SUFFIX, original, 'utf8');
    try {
      for (const mutant of candidates) {
        fs.writeFileSync(sourceFile, applyMutant(original, mutant), 'utf8');
        const run = runTest(testPath, runOptions);
        if (run.interrupted) throw new Error(`verification interrupted: ${run.error}`);
        results.push({ description: mutant.description, line: mutant.line, function: mutant.function, outcome: outcomeOf(run), killed: outcomeOf(run) === 'killed' });
      }
    } finally {
      fs.writeFileSync(sourceFile, original, 'utf8');
      fs.rmSync(sourceFile + BACKUP_SUFFIX, { force: true });
    }
    const killed = results.filter((item) => item.killed).length;
    const decided = results.filter((item) => item.outcome === 'killed' || item.outcome === 'survived').length;
    const inconclusive = results.length - decided;
    let reason = null;
    if (killed === 0) reason = inconclusive ? `no mutant was killed (${inconclusive} timed out or could not run)` : 'test passes on every mutant of the code under test';
    return {
      verified: killed > 0, reason,
      correctCode, injectedBug: { passed: killed > 0 }, mutants: results, killed, total: results.length, inconclusive,
      mutationScore: decided ? Math.round((killed / decided) * 100) : null,
    };
  } finally {
    if (ownsTest) fs.rmSync(testPath, { force: true });
  }
}
