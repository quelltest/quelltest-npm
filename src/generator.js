import fs from 'node:fs';
import path from 'node:path';
import { childNodes, parseSource } from './ast.js';
import { allGuards, describeModule, exportOf, guardFor } from './unit.js';
import { exampleCases, guardCases } from './synthesize.js';
import { renderRequests, requestCases, routeFor } from './routes.js';
import { detectRunner, renderTest, testExtension, RUNNERS } from './runner.js';
import { verifyGenerated } from './verification.js';

const ALLOWED_MODULES = new Set(['node:test', 'node:assert', 'node:assert/strict', 'assert', 'assert/strict', 'vitest', '@jest/globals']);
// Generated tests only need the unit under test and an assertion library; anything that reaches the process, the
// network, the file system or code evaluation is rejected, including through aliases (`const p = process`).
const FORBIDDEN_IDENTIFIERS = new Set(['process', 'globalThis', 'global', 'module', 'eval', 'Function', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Deno', 'Bun']);

function* walk(node, parent = null) {
  yield [node, parent];
  for (const child of childNodes(node)) yield* walk(child, node);
}

const moduleAllowed = (specifier) => specifier.startsWith('.') || ALLOWED_MODULES.has(specifier);

/**
 * Gate on the generated code itself (this is defence in depth, not a sandbox): it must parse, import only
 * the unit under test (relative paths) and an assertion/test library, and not reference process, global,
 * module, eval, Function or network APIs. Comments and string contents (such as quoted evidence) are ignored.
 */
export function securityGate(source, file = 'generated.test.js') {
  const ast = parseSource(source, file);
  if (!ast) return { passed: false, reason: 'generated source does not parse' };
  const fail = (reason) => ({ passed: false, reason });
  for (const [node, parent] of walk(ast.program)) {
    if (node.type === 'ImportDeclaration' || ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source)) {
      if (!moduleAllowed(node.source.value)) return fail(`generated source imports ${node.source.value}`);
    }
    if (node.type === 'CallExpression' || node.type === 'NewExpression') {
      if (node.callee.type === 'Import') return fail('generated source uses dynamic import');
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
        const specifier = node.arguments[0];
        if (!(specifier?.type === 'StringLiteral' && moduleAllowed(specifier.value))) return fail('generated source requires a disallowed or dynamic module');
      }
    }
    if (node.type === 'Identifier' && FORBIDDEN_IDENTIFIERS.has(node.name)) {
      const isPropertyName = (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
        || (parent?.type === 'ObjectProperty' && parent.key === node && !parent.computed && !parent.shorthand);
      if (!isPropertyName) return fail(`generated source references ${node.name}`);
    }
  }
  return { passed: true, reason: null };
}

export function originalityGate(source, existing = '') {
  const normalized = source.replace(/\s+/g, ' ').trim();
  const passed = normalized.length > 0 && !existing.replace(/\s+/g, ' ').includes(normalized);
  return { passed, reason: passed ? null : 'generated test is empty or already present' };
}

function todoNote(finding, reason, requests = []) {
  const suggested = requests.length ? `\n## Suggested requests\n\n${requests.map((line) => `- ${line}`).join('\n')}\n` : '';
  return `# TODO: ${finding.category}${finding.rule ? ` (${finding.rule})` : ''} in \`${finding.function}\`\n\n`
    + `- Location: \`${finding.file}:${finding.line}\`\n- Suggestion: ${finding.suggestion}\n- Evidence: \`${finding.evidence.replaceAll('`', "'")}\`\n- Why no test was generated: ${reason}\n`
    + `${suggested}\nThis is a note, not a test: nothing here executes or asserts anything.\n`;
}

function toPosix(file) {
  return file.split(path.sep).join('/');
}

function declaredAnywhere(module, name) {
  for (const [node] of walk(module.ast.program)) {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) return true;
    if (node.type === 'VariableDeclarator' && node.id?.name === name && /Function/.test(node.init?.type ?? '')) return true;
  }
  return false;
}

/** Work out what can be tested for one finding, statically. Returns `{ plan }` or `{ reason, requests? }`. */
function plan(finding, cwd, cache) {
  const sourceFile = path.resolve(cwd, finding.file);
  if (!cache.has(sourceFile)) cache.set(sourceFile, describeModule(fs.readFileSync(sourceFile, 'utf8'), sourceFile));
  const module = cache.get(sourceFile);
  if (!module) return { reason: 'source file could not be parsed' };
  const name = finding.function;
  const entry = module.functions.get(name);
  if (!entry) {
    const route = routeFor(module.ast, finding);
    if (route) {
      const requests = renderRequests(requestCases(route));
      return {
        reason: `inside route handler ${route.method} ${route.path}, which cannot be called directly: ${requests.length ? `${requests.length} request case(s) are derived from its guards (see "Suggested requests"); ` : ''}extract the logic into a named, exported function to get a generated unit test`,
        requests,
      };
    }
    if (name === '<anonymous>' || name === '<module>' || /^[A-Z]+ /.test(name)) return { reason: 'inside an anonymous callback: extract the guard into a named function at module scope and export it' };
    if (declaredAnywhere(module, name)) return { reason: `\`${name}\` is declared inside another function: extract it to module scope and export it to test it` };
    return { reason: `\`${name}\` is not a top-level function declaration or arrow function, so its guards cannot be called from a test` };
  }
  const exportInfo = exportOf(module, name);
  if (!exportInfo) return { reason: `\`${name}\` is not exported: add \`export\` (or add it to module.exports) so a test can import it` };
  const why = { text: module.text };
  let cases = null;
  if (['boundary', 'nullish', 'throws'].includes(finding.category)) {
    const guard = guardFor(entry.node, finding);
    if (!guard) why.reason = 'no `if` guard was found at this location';
    cases = guard ? guardCases(entry, guard, allGuards(entry.node), why) : null;
    if (!cases) cases = exampleCases(entry);
  } else if (finding.category === 'jsdoc') cases = exampleCases(entry);
  else if (/\.[jt]sx$/.test(finding.file) || /^[A-Z]/.test(name)) return { reason: `\`${name}\` looks like a React component: test it with React Testing Library, or extract the logic into a plain exported function` };
  else return { reason: `no executable test rule for ${finding.rule ?? finding.category} findings yet` };
  if (!cases?.length) return { reason: `${why.reason ?? 'the guard could not be analysed'} (and there is no literal \`@example\` to use)` };
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
    // Verify a throwaway probe next to the final path. The final path may hold a test from an earlier run
    // (ids are deterministic), so it is never written or removed here unless the verified test is saved below.
    const dir = path.dirname(file);
    const dirExisted = fs.existsSync(dir);
    fs.mkdirSync(dir, { recursive: true });
    const probe = file.replace(/(\.test\.[^.]+)$/, '.quelltest-probe$1');
    const run = () => {
      fs.writeFileSync(probe, current, 'utf8');
      try {
        return verifyGenerated(null, { sourceFile, testPath: probe, runner, functions: [entry.name], cwd: options.cwd });
      } finally {
        removeFile(probe);
      }
    };
    const cleanup = () => {
      if (!dirExisted && !options.write) {
        try { fs.rmdirSync(dir); } catch { /* not empty: leave it */ }
      }
    };
    verification = run();
    if (!verification.correctCode.passed && rebuild) {
      const reduced = rebuild();
      if (reduced && reduced !== current) {
        current = reduced;
        const duplicate = originalityGate(current, [options.existing ?? '', ...seen].join('\n'));
        if (!duplicate.passed) {
          cleanup();
          return { status: 'FLAGGED', kind: 'test', verified: false, reason: duplicate.reason, gates: { ...gates, originality: duplicate }, output: null };
        }
        verification = run();
      }
    }
    gates.correctCode = verification.correctCode.passed ? 'PASSED' : 'FAILED';
    gates.injectedBug = verification.verified ? 'PASSED' : 'FAILED';
    cleanup();
    if (!verification.verified) {
      return { status: 'TODO', kind: 'todo', verified: false, reason: `not verified: ${verification.reason}`, gates, output: null, source: current };
    }
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
 * Statuses: SKIPPED (already covered by existing tests), GENERATED (test written/planned, not yet run), VERIFIED (passed on the original code and failed on a
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
    if (finding.covered && !options.includeCovered) {
      results.push({ ...base, status: 'SKIPPED', reason: 'already covered by existing tests (use includeCovered to generate anyway)' });
      continue;
    }
    const planned = plan(finding, options.cwd, cache);
    if (!planned.plan) {
      results.push(todo(base, planned.reason, options, planned.requests));
      continue;
    }
    const candidate = candidateFor(finding, planned.plan, options);
    const outcome = finalize(finding, candidate.source, candidate, options, seen);
    if (outcome.status === 'TODO') results.push(todo({ ...base, gates: outcome.gates }, outcome.reason, options));
    else results.push({ ...base, ...outcome });
  }
  return results;
}

function todo(base, reason, options, requests = []) {
  let output = null;
  if (options.write) {
    output = path.join(options.destination, `${base.id}.todo.md`);
    fs.mkdirSync(options.destination, { recursive: true });
    fs.writeFileSync(output, todoNote(base, reason, requests), 'utf8');
  }
  return { ...base, status: 'TODO', kind: 'todo', verified: false, reason, output, ...(requests.length ? { requests } : {}) };
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
