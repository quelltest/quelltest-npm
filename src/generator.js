import fs from 'node:fs';
import path from 'node:path';
import { childNodes, parseSource } from './ast.js';
import { allGuards, describeModule, exportOf, guardFor } from './unit.js';
import { exampleCases, guardCases } from './synthesize.js';
import { detectRunner, renderTest, testExtension, RUNNERS } from './runner.js';
import { verifyGenerated } from './verification.js';

const FORBIDDEN_CALLS = new Set(['eval', 'Function', 'exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork', 'fetch', 'XMLHttpRequest', 'WebSocket']);
const FORBIDDEN_MODULES = /^(?:node:)?(?:child_process|net|http|https|dgram|cluster|worker_threads|vm)$/;

function* walk(node) {
  yield node;
  for (const child of childNodes(node)) yield* walk(child);
}

/**
 * Gate on the generated code itself: it must parse, and must not call process/network/eval APIs
 * or import modules that can. Comments and string contents (such as quoted source evidence) are ignored.
 */
export function securityGate(source, file = 'generated.test.js') {
  const ast = parseSource(source, file);
  if (!ast) return { passed: false, reason: 'generated source does not parse' };
  for (const node of walk(ast.program)) {
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      const name = node.callee.type === 'Identifier' ? node.callee.name : null;
      if (name && FORBIDDEN_CALLS.has(name)) return { passed: false, reason: `generated source calls ${name}()` };
      if (name === 'require' && !(node.arguments[0]?.type === 'StringLiteral' && !FORBIDDEN_MODULES.test(node.arguments[0].value))) {
        return { passed: false, reason: 'generated source requires a forbidden or dynamic module' };
      }
      if (node.callee.type === 'Import' || (node.callee.type === 'Identifier' && node.callee.name === 'import')) return { passed: false, reason: 'generated source uses dynamic import' };
    }
    if (node.type === 'ImportDeclaration' && FORBIDDEN_MODULES.test(node.source.value)) return { passed: false, reason: `generated source imports ${node.source.value}` };
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'process' && ['env', 'exit', 'kill', 'binding'].includes(node.property.name)) {
      return { passed: false, reason: `generated source touches process.${node.property.name}` };
    }
  }
  return { passed: true, reason: null };
}

export function originalityGate(source, existing = '') {
  const normalized = source.replace(/\s+/g, ' ').trim();
  const passed = normalized.length > 0 && !existing.replace(/\s+/g, ' ').includes(normalized);
  return { passed, reason: passed ? null : 'generated test is empty or already present' };
}

function todoNote(finding, reason) {
  return `# TODO: ${finding.category}${finding.rule ? ` (${finding.rule})` : ''} in \`${finding.function}\`\n\n`
    + `- Location: \`${finding.file}:${finding.line}\`\n- Suggestion: ${finding.suggestion}\n- Evidence: \`${finding.evidence.replaceAll('`', "'")}\`\n- Why no test was generated: ${reason}\n\n`
    + 'This is a note, not a test: nothing here executes or asserts anything.\n';
}

function toPosix(file) {
  return file.split(path.sep).join('/');
}

/** Work out what can be tested for one finding, statically. Returns `{ plan }` or `{ reason }`. */
function plan(finding, cwd, cache) {
  const sourceFile = path.resolve(cwd, finding.file);
  if (!cache.has(sourceFile)) cache.set(sourceFile, describeModule(fs.readFileSync(sourceFile, 'utf8'), sourceFile));
  const module = cache.get(sourceFile);
  if (!module) return { reason: 'source file could not be parsed' };
  const entry = module.functions.get(finding.function);
  if (!entry) return { reason: 'finding is not inside a top-level named function' };
  const exportInfo = exportOf(module, finding.function);
  if (!exportInfo) return { reason: 'function is not exported, so a test cannot call it' };
  let cases = null;
  if (['boundary', 'nullish', 'throws'].includes(finding.category)) {
    const guard = guardFor(entry.node, finding);
    cases = guard ? guardCases(entry, guard, allGuards(entry.node)) : null;
    if (!cases) cases = exampleCases(entry);
  } else if (finding.category === 'jsdoc') cases = exampleCases(entry);
  else return { reason: `no executable test rule for ${finding.rule ?? finding.category} findings yet` };
  if (!cases?.length) return { reason: 'guard is too complex to derive inputs from statically (and no literal @example)' };
  return { plan: { sourceFile, module, entry, exportInfo, cases } };
}

function removeFile(file) {
  fs.rmSync(file, { force: true });
}

/** Gate, optionally verify against source mutants, and optionally write one candidate test. */
function finalize(finding, source, ctx, options, seen) {
  const { file, sourceFile, runner, entry, rebuild } = ctx;
  const gates = { security: securityGate(source, file), originality: originalityGate(source, [options.existing ?? '', ...seen].join('\n')), correctCode: 'PENDING', injectedBug: 'PENDING' };
  if (!gates.security.passed || !gates.originality.passed) return { status: 'FLAGGED', kind: 'test', verified: false, reason: gates.security.reason ?? gates.originality.reason, gates, output: null };
  let current = source;
  let verification = null;
  if (options.verify) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const run = () => {
      fs.writeFileSync(file, current, 'utf8');
      return verifyGenerated(null, { sourceFile, testPath: file, runner, functions: [entry.name], cwd: options.cwd });
    };
    verification = run();
    if (!verification.correctCode.passed && rebuild) {
      const reduced = rebuild();
      if (reduced && reduced !== current) {
        current = reduced;
        const duplicate = originalityGate(current, [options.existing ?? '', ...seen].join('\n'));
        if (!duplicate.passed) {
          removeFile(file);
          return { status: 'FLAGGED', kind: 'test', verified: false, reason: duplicate.reason, gates: { ...gates, originality: duplicate }, output: null };
        }
        verification = run();
      }
    }
    gates.correctCode = verification.correctCode.passed ? 'PASSED' : 'FAILED';
    gates.injectedBug = verification.verified ? 'PASSED' : 'FAILED';
    if (!verification.verified) {
      removeFile(file);
      return { status: 'TODO', kind: 'todo', verified: false, reason: `not verified: ${verification.reason}`, gates, output: null, source: current };
    }
    if (!options.write) removeFile(file);
  }
  if (options.write) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, current, 'utf8');
  }
  seen.add(current);
  return { status: options.verify ? 'VERIFIED' : 'GENERATED', kind: 'test', verified: Boolean(verification?.verified), reason: null, gates, output: options.write ? file : null, source: current, verification };
}

function resolveOptions(options) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const runner = options.runner ?? detectRunner(cwd);
  if (!RUNNERS.includes(runner)) throw new Error(`unsupported runner: ${runner} (expected ${RUNNERS.join(', ')})`);
  const destination = path.resolve(cwd, options.destination ?? 'tests/quelltest');
  if (fs.existsSync(destination) && !fs.statSync(destination).isDirectory()) throw new Error(`destination is not a directory: ${destination}`);
  return { ...options, cwd, runner, destination };
}

function candidateFor(finding, planned, options) {
  const { sourceFile, module, entry, exportInfo, cases } = planned;
  const ext = testExtension({ runner: options.runner, style: module.style, sourceExt: path.extname(sourceFile) });
  const file = path.join(options.destination, `${finding.id}${ext}`);
  const importPath = toPosix(path.relative(path.dirname(file), sourceFile));
  const make = (selected) => renderTest({
    runner: options.runner, style: module.style, importPath: importPath.startsWith('.') ? importPath : `./${importPath}`,
    exportInfo, functionName: entry.name, isAsync: entry.async, cases: selected,
  });
  const required = cases.filter((item) => !item.optional);
  return { file, sourceFile, runner: options.runner, entry, source: make(cases), rebuild: () => (required.length < cases.length ? make(required) : null) };
}

/**
 * Generate tests for findings. A finding becomes a real test (it imports the unit, calls it and asserts)
 * only when its guard can be analysed statically; everything else becomes a TODO note, never a placeholder test.
 *
 * Statuses: GENERATED (test written/planned, not yet run), VERIFIED (passed on the original code and failed on a
 * source mutant; needs `verify: true`), TODO (note only), FLAGGED (rejected by the security or originality gate).
 * Options: destination, write, runner, verify, existing, cwd.
 */
export function generate(report, rawOptions = {}) {
  const options = resolveOptions(rawOptions);
  const cache = new Map();
  const seen = new Set();
  const results = [];
  for (const finding of report.findings) {
    const base = { ...finding, kind: 'todo', verified: false, gates: { security: null, originality: null, correctCode: 'PENDING', injectedBug: 'PENDING' }, output: null };
    const planned = plan(finding, options.cwd, cache);
    if (!planned.plan) {
      results.push(todo(base, planned.reason, options));
      continue;
    }
    const candidate = candidateFor(finding, planned.plan, options);
    const outcome = finalize(finding, candidate.source, candidate, options, seen);
    if (outcome.status === 'TODO') results.push(todo({ ...base, gates: outcome.gates }, outcome.reason, options));
    else results.push({ ...base, ...outcome });
  }
  return results;
}

function todo(base, reason, options) {
  let output = null;
  if (options.write) {
    output = path.join(options.destination, `${base.id}.todo.md`);
    fs.mkdirSync(options.destination, { recursive: true });
    fs.writeFileSync(output, todoNote(base, reason), 'utf8');
  }
  return { ...base, status: 'TODO', kind: 'todo', verified: false, reason, output };
}

/**
 * Opt-in assist: for findings the rules could not handle, ask `options.llm(context)` for a test.
 * quelltest sends nothing anywhere itself; the callback is yours. The returned test must pass the same
 * gates (parses, security gate, passes on the original code, fails on a source mutant) or it is discarded.
 */
export async function generateWithLlm(report, options = {}) {
  if (typeof options.llm !== 'function') throw new TypeError('options.llm must be a function');
  const resolved = resolveOptions({ ...options, verify: true });
  const results = generate(report, { ...resolved, write: resolved.write });
  const seen = new Set(results.filter((item) => item.source).map((item) => item.source));
  const cache = new Map();
  for (let i = 0; i < results.length; i += 1) {
    const item = results[i];
    if (item.status !== 'TODO') continue;
    const sourceFile = path.resolve(resolved.cwd, item.file);
    if (!cache.has(sourceFile)) cache.set(sourceFile, describeModule(fs.readFileSync(sourceFile, 'utf8'), sourceFile));
    const module = cache.get(sourceFile);
    const entry = module?.functions.get(item.function);
    if (!entry) continue;
    const ext = testExtension({ runner: resolved.runner, style: module.style, sourceExt: path.extname(sourceFile) });
    const file = path.join(resolved.destination, `${item.id}${ext}`);
    const importPath = toPosix(path.relative(path.dirname(file), sourceFile));
    const unitSource = fs.readFileSync(sourceFile, 'utf8').slice(entry.node.start, entry.node.end);
    let candidate;
    try {
      candidate = await resolved.llm({ finding: item, unitSource, importPath: importPath.startsWith('.') ? importPath : `./${importPath}`, runner: resolved.runner, moduleStyle: module.style, exportInfo: exportOf(module, item.function) });
    } catch (error) {
      results[i] = { ...item, reason: `llm callback failed: ${error.message}` };
      continue;
    }
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const outcome = finalize(item, candidate, { file, sourceFile, runner: resolved.runner, entry }, resolved, seen);
    if (outcome.status === 'VERIFIED') {
      if (item.output) removeFile(item.output);
      results[i] = { ...item, ...outcome, llm: true };
    } else results[i] = { ...item, reason: `llm test rejected: ${outcome.reason}`, gates: outcome.gates };
  }
  return results;
}
