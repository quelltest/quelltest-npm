import fs from 'node:fs';
import path from 'node:path';
import { FUNCTION_TYPES, childNodes, parseSource, propertyName } from './ast.js';
import { changedFiles } from './diff.js';
import { isTestFile } from './files.js';

const TEST_FUNCTIONS = new Set(['it', 'test', 'specify', 'xit', 'xtest']);
const SUITE_FUNCTIONS = new Set(['describe', 'context', 'suite', 'xdescribe']);
const SKIPPED_ROOTS = new Set(['xit', 'xtest', 'xdescribe']);
const WEAK_MATCHERS = new Set(['ok', 'toBeTruthy', 'toBeFalsy', 'toBeDefined', 'truthy', 'isTruthy', 'true']);
const NEGATED_WEAK = new Set(['toBeNull', 'toBeUndefined', 'toBeFalsy', 'toBeNaN']);
const ASSERT_ROOTS = new Set(['assert', 'expect', 't', 'should', 'chai']);
const ALLOW = /quell-allow-weaken/;

function rootOf(callee) {
  let current = callee;
  while (current?.type === 'MemberExpression' || current?.type === 'CallExpression') current = current.object ?? current.callee;
  return current?.type === 'Identifier' ? current.name : null;
}

function methodChain(callee) {
  const names = [];
  let current = callee;
  while (current?.type === 'MemberExpression' || current?.type === 'CallExpression') {
    if (current.type === 'MemberExpression') names.unshift(propertyName(current));
    current = current.object ?? current.callee;
  }
  return names;
}

function literalsIn(node) {
  const out = [];
  const visit = (current) => {
    if (['NumericLiteral', 'StringLiteral', 'BooleanLiteral'].includes(current.type)) out.push(current.value);
    else if (current.type === 'NullLiteral') out.push(null);
    for (const child of childNodes(current)) visit(child);
  };
  visit(node);
  return out;
}

function strengthOf(callNode) {
  const root = rootOf(callNode.callee);
  const chain = methodChain(callNode.callee);
  const method = chain.at(-1) ?? root;
  if (root === 'assert' && chain.length === 0) return 'weak';
  const negated = chain.includes('not');
  if (WEAK_MATCHERS.has(method) && !negated) return 'weak';
  if (negated && NEGATED_WEAK.has(method)) return 'weak';
  return 'strong';
}

const staticName = (node) => {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
};

/** Parse a test file into `Map<testPath, { assertions, skipped, only, line, endLine }>`. */
export function analyzeTests(text, file = 'a.test.js') {
  const ast = parseSource(text, file);
  if (!ast) return null;
  const tests = new Map();
  const lines = text.split('\n');

  const visit = (node, suites, suiteSkipped) => {
    if (node.type === 'CallExpression') {
      const root = rootOf(node.callee);
      const chain = methodChain(node.callee);
      const name = staticName(node.arguments[0]);
      const isTest = TEST_FUNCTIONS.has(root) && name !== null;
      const isSuite = SUITE_FUNCTIONS.has(root) && name !== null;
      if (isTest || isSuite) {
        const optionSkip = node.arguments.some((arg) => arg.type === 'ObjectExpression' && arg.properties.some((prop) => ['skip', 'todo'].includes(prop.key?.name) && prop.value?.value !== false));
        const skipped = suiteSkipped || SKIPPED_ROOTS.has(root) || chain.includes('skip') || chain.includes('todo') || optionSkip;
        const only = chain.includes('only');
        const body = [...node.arguments].reverse().find((arg) => FUNCTION_TYPES.has(arg.type));
        if (isSuite) {
          if (body) visit(body.body, [...suites, name], skipped);
          return;
        }
        const assertions = [];
        const collect = (current) => {
          if (current.type === 'CallExpression') {
            const inner = rootOf(current.callee);
            const innerChain = methodChain(current.callee);
            const isMatcherCall = inner === 'expect' ? innerChain.length > 0 : ASSERT_ROOTS.has(inner) && (innerChain.length > 0 || inner === 'assert');
            if (isMatcherCall && !(inner === 'expect' && current.callee.type === 'Identifier')) {
              // outermost call of a chain only: skip the inner `expect(x)` call itself
              assertions.push({ method: innerChain.at(-1) ?? inner, strength: strengthOf(current), literals: literalsIn(current), line: current.loc.start.line });
              return;
            }
          }
          for (const child of childNodes(current)) collect(child);
        };
        if (body) collect(body.body);
        const first = node.loc.start.line;
        const last = node.loc.end.line;
        tests.set([...suites, name].join(' > '), {
          assertions, skipped, only, line: first, endLine: last,
          allowed: lines.slice(first - 1, last).some((line) => ALLOW.test(line)),
        });
        return;
      }
    }
    for (const child of childNodes(node)) visit(child, suites, suiteSkipped);
  };
  visit(ast.program, [], false);
  return tests;
}

const signature = (test) => test.assertions.map((item) => `${item.method}:${JSON.stringify(item.literals)}`).join('|');

/**
 * Compare a test file before and after a change. Findings:
 * `test-deleted`, `test-skipped`, `test-only`, `assertions-removed`, `assertions-weakened` (errors) and
 * `expected-value-changed` (review: may be legitimate, but it is where "make the test match the bug" hides).
 * A test containing `// quell-allow-weaken <reason>` is exempt.
 */
export function compareTests(baseText, headText, file) {
  const issues = [];
  const base = analyzeTests(baseText, file);
  if (!base) return issues;
  if (headText === null) {
    for (const [name, test] of base) if (test.assertions.length) issues.push({ file, test: name, kind: 'test-file-deleted', severity: 'error', line: 1, message: `test file deleted (it had ${base.size} test(s))` });
    if (!issues.length && base.size) issues.push({ file, test: '*', kind: 'test-file-deleted', severity: 'error', line: 1, message: 'test file deleted' });
    return issues;
  }
  const head = analyzeTests(headText, file);
  if (!head) {
    issues.push({ file, test: '*', kind: 'unparsable', severity: 'review', line: 1, message: 'the changed test file could not be parsed' });
    return issues;
  }
  const unmatchedHead = new Map([...head].filter(([name]) => !base.has(name)));
  const pairs = [];
  for (const [name, test] of base) {
    if (head.has(name)) pairs.push([name, test, head.get(name)]);
    else {
      // A renamed test keeps its assertions; pair by signature before calling it deleted.
      const renamed = [...unmatchedHead].find(([, candidate]) => signature(candidate) === signature(test));
      if (renamed) {
        unmatchedHead.delete(renamed[0]);
        pairs.push([name, test, renamed[1]]);
      } else if (test.assertions.length || test.skipped === false) issues.push({ file, test: name, kind: 'test-deleted', severity: 'error', line: 1, message: 'test deleted' });
    }
  }
  for (const [name, before, after] of pairs) {
    if (after.allowed) continue;
    const add = (kind, severity, message) => issues.push({ file, test: name, kind, severity, line: after.line, message });
    if (after.skipped && !before.skipped) add('test-skipped', 'error', 'test is now skipped (skip/todo/x-prefixed)');
    if (after.only && !before.only) add('test-only', 'error', '`.only` silently skips every other test');
    if (after.assertions.length < before.assertions.length) add('assertions-removed', 'error', `assertions removed (${before.assertions.length} -> ${after.assertions.length})`);
    const weak = (test) => test.assertions.filter((item) => item.strength === 'weak').length;
    if (after.assertions.length >= before.assertions.length && weak(after) > weak(before)) add('assertions-weakened', 'error', `assertions weakened (${weak(before)} -> ${weak(after)} weak, e.g. equality replaced by ok/truthy/not-null)`);
    if (after.assertions.length === before.assertions.length) {
      before.assertions.forEach((item, index) => {
        const other = after.assertions[index];
        if (item.method === other.method && JSON.stringify(item.literals) !== JSON.stringify(other.literals)) {
          add('expected-value-changed', 'review', `expected value changed in assertion ${index + 1} (${JSON.stringify(item.literals)} -> ${JSON.stringify(other.literals)})`);
        }
      });
    }
  }
  return issues;
}

/**
 * Check every changed test file since the merge-base with `ref`. Returns `{ issues, ok, checked }`; `ok` is false when
 * any error is found (`strict` also fails on review items).
 */
export function gate(ref, { cwd = process.cwd(), strict = false } = {}) {
  const issues = [];
  let checked = 0;
  for (const entry of changedFiles(ref, cwd)) {
    const relative = entry.file.replaceAll('\\', '/');
    if (!/\.[cm]?[jt]sx?$/.test(relative) || !isTestFile(relative)) continue;
    if (entry.status === 'A') continue;
    checked += 1;
    const absolute = path.join(entry.root, entry.file);
    const head = entry.status === 'D' || !fs.existsSync(absolute) ? null : fs.readFileSync(absolute, 'utf8');
    issues.push(...compareTests(entry.base, head, relative));
  }
  const failing = issues.filter((item) => item.severity === 'error' || strict);
  return { issues, ok: failing.length === 0, checked };
}

/** SARIF 2.1.0 for gate issues. */
export function gateSarif(result, version = '0.0.0') {
  const rules = [...new Set(result.issues.map((item) => item.kind))].sort();
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'quelltest-gate', version, rules: rules.map((id) => ({ id, shortDescription: { text: id.replaceAll('-', ' ') } })) } },
      results: result.issues.map((item) => ({
        ruleId: item.kind,
        level: item.severity === 'error' ? 'error' : 'note',
        message: { text: `${item.test}: ${item.message}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: item.file }, region: { startLine: item.line } } }],
      })),
    }],
  };
}
