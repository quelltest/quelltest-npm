import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { childNodes, parseSource } from './ast.js';
import { BACKUP_SUFFIX, restoreIfInterrupted } from './backup.js';
import { applyMutant, mutantsWithStats } from './mutate.js';

const RUNNER_PACKAGES = {
  jest: { name: 'jest', args: (file) => ['--runTestsByPath', file] },
  vitest: { name: 'vitest', args: (file) => ['run', file] },
  mocha: { name: 'mocha', args: (file) => [file] },
};
const ASSERTION_ROOTS = new Set(['assert', 'expect', 't', 'should', 'chai']);
// Skipped only below the mirrored root and never when they hold the source or test (a source in src/build/ must be copied).
const MIRROR_SKIP = new Set(['node_modules', '.git', 'coverage', 'dist', 'build', '.next', '.cache', '.turbo']);
const MIRROR_LIMITS = { files: 20_000, bytes: 200 * 1024 * 1024 };

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
 * Result: `{ passed, command }`, or `{ passed: false, timedOut }`, `{ passed: false, infrastructure }` (the runner itself
 * could not run, which says nothing about the test), or `{ passed: false, error }` for a genuine test failure.
 */
export function runTest(testFile, { runner = 'node', cwd = path.dirname(testFile), timeoutMs = 60_000 } = {}) {
  const spawnOptions = { cwd, env: cleanEnv(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 };
  let result;
  let command;
  if (runner === 'node') {
    command = `node --test ${testFile}`;
    result = spawnSync(process.execPath, ['--test', testFile], spawnOptions);
  } else if (RUNNER_PACKAGES[runner]) {
    const entry = resolveRunnerEntry(runner, cwd);
    if (!entry) return { passed: false, infrastructure: true, command: runner, error: `${runner} is not installed in node_modules` };
    const args = RUNNER_PACKAGES[runner].args(testFile);
    command = `node ${entry} ${args.join(' ')}`;
    result = spawnSync(process.execPath, [entry, ...args], spawnOptions);
  } else throw new Error(`unsupported runner: ${runner}`);
  if (result.error?.code === 'ETIMEDOUT') return { passed: false, timedOut: true, command, error: 'timed out' };
  if (result.error) return { passed: false, infrastructure: true, command, error: result.error.message };
  if (result.signal) return { passed: false, interrupted: true, command, error: `terminated by ${result.signal}` };
  return result.status === 0 ? { passed: true, command } : { passed: false, command, error: result.stderr || result.stdout || `exit status ${result.status}` };
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

// --- isolation: verify in a throwaway copy so the real source is never modified --------------------------------

const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

function packageRoot(startDir) {
  for (let dir = startDir; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

function commonAncestor(a, b) {
  const left = a.split(path.sep);
  const right = b.split(path.sep);
  const shared = [];
  for (let i = 0; i < Math.min(left.length, right.length) && left[i] === right[i]; i += 1) shared.push(left[i]);
  return shared.join(path.sep) || path.sep;
}

const tooBroad = (dir) => dir === path.parse(dir).root || dir === os.homedir() || dir.split(path.sep).filter(Boolean).length < 2;

/** Directory to mirror: the package containing both files, else their common ancestor (never a filesystem root or home). */
function mirrorRoot(sourceFile, testPath) {
  const pkg = packageRoot(path.dirname(sourceFile));
  if (pkg && !tooBroad(pkg) && (testPath === pkg || isInside(pkg, testPath))) return pkg;
  const common = commonAncestor(path.dirname(sourceFile), path.dirname(testPath));
  return tooBroad(common) ? null : common;
}

function nearestNodeModules(root) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

/** Copy `root` (without node_modules/.git/build output) to a temp dir and link node_modules. Throws if the copy is too large. */
function createMirror(root, keep = []) {
  // Use the real path: jest and vitest crawl the project root and mis-handle symlinked (/var -> /private/var) or 8.3 short (RUNNER~1) temp paths.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'quell-verify-')));
  let files = 0;
  let bytes = 0;
  const cleanup = () => {
    const link = path.join(dir, 'node_modules');
    try {
      fs.unlinkSync(link);
    } catch {
      try { fs.rmdirSync(link); } catch { /* no link */ }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    // dereference: a symlinked source file must become a real file in the copy, or writing a mutant would write through the link.
    fs.cpSync(root, dir, {
      recursive: true,
      dereference: true,
      filter: (source) => {
        const holdsKept = keep.some((file) => file === source || isInside(source, file));
        if ((source !== root && MIRROR_SKIP.has(path.basename(source)) && !holdsKept) || source.endsWith(BACKUP_SUFFIX)) return false;
        const stat = fs.lstatSync(source);
        if (stat.isDirectory()) return true;
        files += 1;
        bytes += stat.size;
        if (files > MIRROR_LIMITS.files || bytes > MIRROR_LIMITS.bytes) throw new Error('project too large to mirror');
        return true;
      },
    });
    const modules = nearestNodeModules(root);
    if (modules) fs.symlinkSync(modules, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    cleanup();
    throw error;
  }
  return { dir, cleanup };
}

const excerpt = (run) => (run.error ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 4).join(' | ').slice(0, 400);

function outcomeOf(run) {
  if (run.timedOut) return 'timeout';
  if (run.infrastructure) return 'error';
  return run.passed ? 'survived' : 'killed';
}

const lineAt = (text, offset) => {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const end = text.indexOf('\n', offset);
  return text.slice(start, end < 0 ? undefined : end).trim();
};

/**
 * Verify that a test really protects the code under test.
 *
 * 1. The test must pass on the original source.
 * 2. It must contain an assertion that observes the code (not a placeholder).
 * 3. Mutants of `sourceFile` (optionally only `functions` / `lines`) are injected one at a time and the test
 *    must fail on at least one (and reach `minScore` percent of decided mutants, if given). Only genuine test
 *    failures count as kills: timeouts and runner errors are reported separately.
 *
 * Isolation: by default everything runs in a temporary copy of the project (node_modules is linked), so the real
 * source and test files are never touched. If the project cannot be mirrored (too large, no common root) or
 * `inPlace: true` is set, the source is mutated in place and always restored in a `finally`, with an on-disk backup so
 * a run killed outright is repaired on the next call (and by `scan`/`generate`). `result.isolation` says which was used.
 *
 * `testSource` is written to `testPath` for the run (in the copy when isolated) and removed afterwards; pass `null`
 * to verify a test file that already exists at `testPath`. Relative paths are resolved against the current directory.
 */
export function verifyGenerated(testSource, options = {}) {
  const { runner = 'node', functions, lines, maxMutants = 30, maxPerKind, timeoutMs, minScore = 0 } = options;
  const unverified = (reason, extra = {}) => ({ verified: false, reason, correctCode: { passed: false }, injectedBug: { passed: false }, mutants: [], killed: 0, total: 0, ignored: 0, mutationScore: null, ...extra });
  if (!options.sourceFile || !fs.existsSync(options.sourceFile)) return unverified('no source file to mutate: pass options.sourceFile');
  const sourceFile = path.resolve(options.sourceFile);
  restoreIfInterrupted(sourceFile);
  const ext = path.extname(sourceFile);
  const testPath = path.resolve(options.testPath ?? path.join(path.dirname(sourceFile), `${path.basename(sourceFile, ext)}.quelltest-verify.test${runner === 'node' ? '.mjs' : ext}`));
  const ownsTest = testSource !== null && testSource !== undefined;
  if (!ownsTest && !fs.existsSync(testPath)) return unverified(`test file not found: ${testPath}`);
  const original = fs.readFileSync(sourceFile, 'utf8');
  const source = ownsTest ? testSource : fs.readFileSync(testPath, 'utf8');

  const warnings = [];
  let root = null;
  let mirror = null;
  if (!options.inPlace) {
    root = mirrorRoot(sourceFile, testPath);
    if (root) {
      try {
        mirror = createMirror(root, [sourceFile, testPath]);
      } catch (error) {
        mirror = null;
        warnings.push(`could not mirror the project (${error.message}); mutating the source in place instead (restored afterwards)`);
      }
    }
  }
  const isolation = mirror ? 'copy' : 'in-place';
  const map = (file) => (mirror && (file === root || isInside(root, file)) ? path.join(mirror.dir, path.relative(root, file)) : file);
  const runSource = map(sourceFile);
  const runTestPath = map(testPath);
  const cwd = path.resolve(options.cwd ?? path.dirname(sourceFile));
  const runOptions = { runner, cwd: map(cwd), timeoutMs };

  // In place, writing `testSource` to an existing file would destroy it (the finally block deletes it afterwards).
  if (ownsTest && !mirror && fs.existsSync(runTestPath)) return unverified(`refusing to overwrite the existing file ${runTestPath}: pass testSource: null to verify it, or use another testPath`, { isolation, warnings });
  const breakLink = (file) => {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
    } catch { /* does not exist yet */ }
  };
  if (ownsTest) {
    fs.mkdirSync(path.dirname(runTestPath), { recursive: true });
    if (mirror) breakLink(runTestPath);
    fs.writeFileSync(runTestPath, testSource, 'utf8');
  }
  try {
    const correctCode = runTest(runTestPath, runOptions);
    if (!correctCode.passed) {
      const why = correctCode.infrastructure ? `test runner could not run: ${correctCode.error}` : `test fails on the original code (${correctCode.command}): ${excerpt(correctCode)}`;
      return unverified(why, { correctCode, isolation, warnings });
    }
    if (!hasMeaningfulAssertion(source)) return unverified('test has no assertion that observes the code under test', { correctCode, isolation });
    const { list: candidates, ignored } = mutantsWithStats(original, sourceFile, { functions, lines, max: maxMutants, maxPerKind });
    if (!candidates.length) return unverified('no applicable mutation in the code under test', { correctCode, isolation, ignored });
    const results = [];
    if (!mirror) fs.writeFileSync(sourceFile + BACKUP_SUFFIX, original, 'utf8');
    try {
      if (mirror) breakLink(runSource);
      for (const mutant of candidates) {
        const mutated = applyMutant(original, mutant);
        fs.writeFileSync(runSource, mutated, 'utf8');
        const run = runTest(runTestPath, runOptions);
        if (run.interrupted) throw new Error(`verification interrupted: ${run.error}`);
        const outcome = outcomeOf(run);
        results.push({
          description: mutant.description, kind: mutant.kind, line: mutant.line, function: mutant.function, outcome, killed: outcome === 'killed',
          before: lineAt(original, mutant.start), after: lineAt(mutated, mutant.start),
        });
      }
    } finally {
      if (!mirror) {
        fs.writeFileSync(sourceFile, original, 'utf8');
        fs.rmSync(sourceFile + BACKUP_SUFFIX, { force: true });
      } else if (fs.readFileSync(sourceFile, 'utf8') !== original) {
        // Defence in depth: isolation must never leave the real source changed.
        fs.writeFileSync(sourceFile, original, 'utf8');
        warnings.push('the real source file changed during verification and was restored');
      }
    }
    const killed = results.filter((item) => item.killed).length;
    const decided = results.filter((item) => item.outcome === 'killed' || item.outcome === 'survived').length;
    const inconclusive = results.length - decided;
    const mutationScore = decided ? Math.round((killed / decided) * 100) : null;
    let reason = null;
    if (killed === 0) reason = inconclusive ? `no mutant was killed (${inconclusive} timed out or could not run)` : 'test passes on every mutant of the code under test';
    else if (mutationScore < minScore) reason = `mutation score ${mutationScore}% is below the required ${minScore}%`;
    return {
      verified: reason === null, reason,
      correctCode, injectedBug: { passed: killed > 0 }, mutants: results, killed, total: results.length, inconclusive, ignored, mutationScore,
      isolation, sourceFile, testPath, warnings,
      byKind: Object.fromEntries([...new Set(results.map((item) => item.kind))].map((kind) => [kind, { total: results.filter((item) => item.kind === kind).length, killed: results.filter((item) => item.kind === kind && item.killed).length }])),
    };
  } finally {
    if (mirror) mirror.cleanup();
    else if (ownsTest) fs.rmSync(runTestPath, { force: true });
  }
}
