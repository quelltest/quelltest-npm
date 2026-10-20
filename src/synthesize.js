import { collectShallow, someShallow } from './ast.js';
import { literalSource, RELATIONAL_FLIP } from './unit.js';

const BASE_VALUES = [1, 0, -1, 10, 'a', '', null, undefined, true, false];
const MAX_VALUES_PER_KEY = 8;
// Member names that would walk into the prototype chain when a value is composed into an object.
const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const NETWORK_CALL = /^(?:axios|got|ky|http|https)(?:\.\w+)?$/;
const OPERATORS = {
  '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
  '===': (a, b) => a === b, '!==': (a, b) => a !== b,
  // eslint-disable-next-line eqeqeq
  '==': (a, b) => a == b,
  // eslint-disable-next-line eqeqeq
  '!=': (a, b) => a != b,
};

// `undefined` is a legitimate assigned value (`userId = undefined`), so "nothing assigned" needs its own marker.
const MISSING = Symbol('missing');
// "Some object": the root value of a subject whose properties are also tested (`if (!body) ...; if (body.lat > 90) ...`).
const OBJECT = Symbol('object');
// A local name that two declarations share; guards on it cannot be attributed to one call.
const AMBIGUOUS = Symbol('ambiguous');

/** Source text that must be emitted verbatim by `render`. */
class Raw {
  constructor(source) {
    this.source = source;
  }
}

/** Render a JS value (primitive, nested plain object, or `Raw` source) as source text. */
export function render(value) {
  if (value instanceof Raw) return value.source;
  if (value === OBJECT) return '{}';
  if (value === undefined) return 'undefined';
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length ? `{ ${entries.map(([key, inner]) => `${JSON.stringify(key)}: ${render(inner)}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(value);
}

// --- subjects: what a condition is about --------------------------------------------------------------------------
// A guard can test a parameter (`n < 5`), a property of one (`body.lat`, `branch.rules?.max`), or the result of a call
// to something the caller supplies (`res.status === 404` after `const res = await fetchUser(id)`). Following AS4UT and
// Pex, the result of such a call is treated as a symbolic variable: the guards on it are the path conditions, and a
// stub is built from values that satisfy them.

function memberName(node) {
  const name = node.computed
    ? (node.property.type === 'StringLiteral' || node.property.type === 'NumericLiteral' ? String(node.property.value) : null)
    : node.property.name;
  return name === null || UNSAFE_NAMES.has(name) ? null : name;
}

/** `{ root, path }` for `a`, `a.b`, `a?.b['c']`; null for anything else (including prototype-walking names). */
function chainOf(node) {
  const path = [];
  let current = node;
  while (current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression') {
    const name = memberName(current);
    if (name === null) return null;
    path.unshift(name);
    current = current.object;
  }
  return current.type === 'Identifier' ? { root: current.name, path } : null;
}

function subjectOf(node, ctx) {
  const chain = node.type === 'Identifier' ? { root: node.name, path: [] } : chainOf(node);
  if (!chain) return null;
  const result = ctx.results.get(chain.root);
  if (result === AMBIGUOUS) return null;
  if (result) {
    const path = [...result.prefix, ...chain.path];
    return { group: `d:${result.key}`, key: `d:${result.key}|${path.join('.')}`, path };
  }
  if (ctx.params.has(chain.root)) return { group: `p:${chain.root}`, key: `p:${chain.root}|${chain.path.join('.')}`, path: chain.path };
  return null;
}

const isCall = (node) => node?.type === 'CallExpression' || node?.type === 'OptionalCallExpression';

/**
 * Calls whose result the caller controls: a parameter (`fetchUser(id)`), a method of one (`User.findOne(q)`), or the
 * global `fetch` (only when the module does not declare or import its own). `captured` holds the call nodes that will be
 * stubbed; any other network call would hit the real network when the generated test runs.
 */
function collectDependencies(entry, params, declared) {
  const results = new Map(); // local variable -> { key, prefix } | AMBIGUOUS
  const deps = new Map(); // key -> { key, kind, root, chain, awaited, parent }
  const captured = new Set();
  const declarators = collectShallow(entry.node.body, (node) => node.type === 'VariableDeclarator' && node.init);
  const bind = (name, value) => {
    if (UNSAFE_NAMES.has(name)) return;
    results.set(name, results.has(name) ? AMBIGUOUS : value);
  };
  for (const declarator of declarators) {
    const awaited = declarator.init.type === 'AwaitExpression';
    const call = awaited ? declarator.init.argument : declarator.init;
    if (!isCall(call)) continue;
    let info = null;
    if (call.callee.type === 'Identifier') {
      if (params.has(call.callee.name)) info = { key: call.callee.name, kind: 'fn', root: call.callee.name, chain: [] };
      else if (call.callee.name === 'fetch' && !declared?.has('fetch')) info = { key: 'fetch', kind: 'global-fetch' };
    } else {
      const chain = chainOf(call.callee);
      if (chain && params.has(chain.root)) info = { key: `${chain.root}.${chain.path.join('.')}`, kind: 'method', root: chain.root, chain: chain.path };
      else if (chain && results.get(chain.root) && results.get(chain.root) !== AMBIGUOUS && chain.path.length === 1 && ['json', 'text'].includes(chain.path[0])) {
        const parent = results.get(chain.root).key;
        info = { key: `${parent}#body`, kind: 'body', parent };
      }
    }
    if (!info) continue;
    captured.add(call);
    deps.set(info.key, { ...info, awaited });
    if (declarator.id.type === 'Identifier') bind(declarator.id.name, { key: info.key, prefix: [] });
    else if (declarator.id.type === 'ObjectPattern') {
      for (const prop of declarator.id.properties) {
        const name = prop.key?.name ?? prop.key?.value;
        const local = prop.value?.type === 'AssignmentPattern' ? prop.value.left : prop.value;
        if (name && !UNSAFE_NAMES.has(name) && local?.type === 'Identifier') bind(local.name, { key: info.key, prefix: [name] });
      }
    }
  }
  return { results, deps, captured };
}

/** A call that would reach the real network when the generated test runs: unstubbed global fetch, or an HTTP client module. */
function unstubbedNetworkCall(entry, captured, declared) {
  let found = null;
  someShallow(entry.node.body, (node) => {
    if (!isCall(node) || captured.has(node)) return false;
    const callee = node.callee;
    const name = callee.type === 'Identifier' ? callee.name : chainOf(callee)?.root;
    if ((callee.type === 'Identifier' && name === 'fetch' && !declared?.has('fetch')) || (name && NETWORK_CALL.test(name))) found = name;
    return Boolean(found);
  });
  return found;
}

// --- terms ---------------------------------------------------------------------------------------------------------

function literalOf(node, text) {
  switch (node.type) {
    case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': return { value: node.value };
    case 'NullLiteral': return { value: null };
    case 'Identifier': return node.name === 'undefined' ? { value: undefined } : null;
    case 'UnaryExpression': return node.operator === '-' && node.argument.type === 'NumericLiteral' ? { value: -node.argument.value } : null;
    case 'ObjectExpression': case 'ArrayExpression': {
      const source = text ? literalSource(text.slice(node.start, node.end)) : null;
      return source ? { value: new Raw(source) } : null;
    }
    default: return null;
  }
}

function termOf(node, ctx) {
  const subject = (candidate) => subjectOf(candidate, ctx);
  if (node.type === 'BinaryExpression' && RELATIONAL_FLIP[node.operator]) {
    const { left, right } = node;
    if (left.type === 'UnaryExpression' && left.operator === 'typeof' && right.type === 'StringLiteral') {
      const target = subject(left.argument);
      return target ? { ...target, kind: 'typeof', op: node.operator, value: right.value } : null;
    }
    const rightLiteral = literalOf(right);
    const leftTarget = subject(left);
    if (leftTarget && rightLiteral) return { ...leftTarget, kind: 'compare', op: node.operator, value: rightLiteral.value };
    const leftLiteral = literalOf(left);
    const rightTarget = subject(right);
    if (rightTarget && leftLiteral) return { ...rightTarget, kind: 'compare', op: RELATIONAL_FLIP[node.operator], value: leftLiteral.value };
    return null;
  }
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    const target = subject(node.argument);
    return target ? { ...target, kind: 'falsy' } : null;
  }
  const target = subject(node);
  return target ? { ...target, kind: 'truthy' } : null;
}

const splitOr = (node) => (node.type === 'LogicalExpression' && node.operator === '||' ? [...splitOr(node.left), ...splitOr(node.right)] : [node]);

function evaluate(term, rawValue) {
  const value = rawValue === OBJECT ? {} : rawValue;
  if (term.kind === 'falsy') return !value;
  if (term.kind === 'truthy') return Boolean(value);
  if (term.kind === 'typeof') return OPERATORS[term.op](typeof value, term.value);
  return OPERATORS[term.op](value, term.value);
}

function candidatesFor(terms, hasChildren = false) {
  // A condition that only asks "is it truthy?" is best explored with real booleans first (`r.ok`, `user.active`).
  const booleanOnly = terms.every((term) => term.kind === 'truthy' || term.kind === 'falsy');
  const derived = booleanOnly ? [true, false] : [];
  for (const term of terms) {
    if (term.kind !== 'compare') continue;
    if (typeof term.value === 'number') derived.push(term.value - 1, term.value, term.value + 1);
    else if (typeof term.value === 'string') derived.push(term.value, `${term.value}x`);
    else if (term.value === null || term.value === undefined) derived.push(null, undefined);
  }
  // When properties of the subject are tested as well, the subject itself has to be an object to reach them.
  const seen = new Set();
  return [...(hasChildren ? [OBJECT] : []), ...derived, ...BASE_VALUES].filter((value) => {
    const key = `${typeof value}:${render(value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_VALUES_PER_KEY);
}

function defaultFor(param) {
  if (param.shape) return param.shape;
  if (param.hasDefault) return 'undefined';
  const name = param.name;
  if (/^(?:is|has|should|can)[A-Z]|flag|enabled/.test(name)) return 'true';
  if (/list|items|arr|array|names|ids|values|entries/i.test(name)) return '[]';
  if (/opts|options|config|data|obj|params|body|req|ctx|payload|user|input/i.test(name)) return '{}';
  if (/name|title|email|text|msg|message|str|label|key|token|path|url|id\b|code/i.test(name)) return '"abc"';
  return '1';
}

function consequentOf(guard, text) {
  const statements = guard.consequent.type === 'BlockStatement' ? guard.consequent.body : [guard.consequent];
  const first = statements[0];
  if (first?.type === 'ThrowStatement' && first.argument?.type === 'NewExpression') {
    const callee = first.argument.callee;
    const message = first.argument.arguments.find((arg) => arg.type === 'StringLiteral');
    return { kind: 'throws', errorName: callee.type === 'Identifier' ? callee.name : null, message: message?.value ?? null };
  }
  if (first?.type === 'ReturnStatement' && first.argument) {
    const literal = literalOf(first.argument, text);
    if (literal) return { kind: 'returns', expected: render(literal.value) };
  }
  return null;
}

// --- composing arguments ---------------------------------------------------------------------------------------------

/**
 * Build the value for one group (`p:name` or `d:key`) from assignments such as `body.lat = 1`, `status = 200`.
 * A group whose root is "some object" (or unassigned) becomes an object holding its properties; a root assigned a real
 * value (`''`, `null`, `0`) wins, because that is the case being tested.
 */
function composeValue(assignment, group, extras = {}) {
  const prefix = `${group}|`;
  let rootValue = MISSING;
  let tree;
  for (const [key, value] of assignment) {
    if (!key.startsWith(prefix)) continue;
    const path = key.slice(prefix.length);
    if (path === '') {
      rootValue = value;
      continue;
    }
    tree ??= Object.create(null);
    let cursor = tree;
    const parts = path.split('.');
    parts.slice(0, -1).forEach((part) => { cursor = (typeof cursor[part] === 'object' && cursor[part] !== null) ? cursor[part] : (cursor[part] = Object.create(null)); });
    cursor[parts.at(-1)] = value;
  }
  if (rootValue !== MISSING && rootValue !== OBJECT) return rootValue;
  const hasExtras = Object.keys(extras).length > 0;
  if (tree === undefined && !hasExtras) return rootValue === OBJECT ? {} : MISSING;
  return { ...(tree ?? {}), ...extras };
}

function depValue(assignment, dep, deps) {
  const body = [...deps.values()].find((other) => other.kind === 'body' && other.parent === dep.key);
  const bodyValue = body ? composeValue(assignment, `d:${body.key}`) : MISSING;
  const extras = body ? { json: new Raw(`async () => (${render(bodyValue === MISSING ? {} : bodyValue)})`) } : {};
  const value = composeValue(assignment, `d:${dep.key}`, extras);
  return value === MISSING ? {} : value;
}

const depStub = (dep, assignment, deps) => `${dep.awaited ? 'async ' : ''}() => (${render(depValue(assignment, dep, deps))})`;

function stubFor(paramName, assignment, deps) {
  const own = [...deps.values()].filter((dep) => dep.root === paramName);
  if (!own.length) return null;
  const direct = own.find((dep) => dep.kind === 'fn');
  const methods = own.filter((dep) => dep.kind === 'method');
  const tree = Object.create(null);
  for (const dep of methods) {
    let cursor = tree;
    dep.chain.slice(0, -1).forEach((part) => { cursor = cursor[part] ??= Object.create(null); });
    cursor[dep.chain.at(-1)] = new Raw(depStub(dep, assignment, deps));
  }
  if (direct && methods.length) return `Object.assign(${depStub(direct, assignment, deps)}, ${render(tree)})`;
  if (direct) return depStub(direct, assignment, deps);
  return render(tree);
}

/**
 * Derive calls and expectations from a guard like `if (amount <= 0 || typeof name !== "string") throw new RangeError("m")`,
 * a guard on a property (`if (typeof body.lat !== "number")`), or a guard on what a dependency returned
 * (`const res = await fetchUser(id); if (res.status === 404) return { plan: "free" }`).
 *
 * All guards in the function define the path conditions. A base assignment makes every guard false; then one subject at a
 * time is varied around the constants in the target guard, and the expected outcome is that of the first guard (in source
 * order) that fires. Cases marked `optional` only assert that nothing else threw; they are dropped first if a run disagrees.
 * Returns null when the guard is not simple enough to reason about statically (`why.reason` says why): it must be a
 * top-level statement of the function, no parameter may be reassigned, and no call may reach the real network unstubbed.
 */
export function guardCases(entry, guard, siblings = [], why = {}) {
  const params = new Map(entry.params.filter((p) => p.name).map((p) => [p.name, p]));
  const { results, deps, captured } = collectDependencies(entry, params, why.declared);
  const ctx = { params, results };
  const text = why.text;
  const sourceOf = (node) => (text ? text.slice(node.start, node.end).replace(/\s+/g, ' ').trim().slice(0, 80) : 'a term');

  const topLevel = entry.node.body.type === 'BlockStatement' ? entry.node.body.body : [];
  if (!topLevel.includes(guard)) {
    why.reason = 'the guard is nested inside another condition, loop or else-branch, so reaching it depends on more than the arguments';
    return null;
  }
  const reassigned = [...params.keys()].find((name) => someShallow(entry.node.body, (node) => node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && node.left.name === name));
  if (reassigned) {
    why.reason = `parameter \`${reassigned}\` is reassigned inside the function, so the guard no longer tests the argument`;
    return null;
  }
  const network = unstubbedNetworkCall(entry, captured, why.declared);
  if (network) {
    why.reason = `the function calls \`${network}\` without a stubbable result (the call must be \`const x = await ${network}(...)\` or go through a parameter), so a generated test would reach the real network`;
    return null;
  }

  const analyse = (node) => {
    const nodes = splitOr(node.test);
    const terms = nodes.map((candidate) => termOf(candidate, ctx));
    const unsupported = nodes.find((candidate, index) => !terms[index]);
    return unsupported ? { node, unsupported } : { node, terms, consequent: consequentOf(node, text) };
  };

  const target = analyse(guard);
  if (target.unsupported) {
    why.reason = `\`${sourceOf(target.unsupported)}\` is not a comparison of a parameter, its property or a dependency result with a literal, a typeof check or a truthiness check`;
    return null;
  }
  if (!target.consequent) {
    why.reason = 'the guard body does not start with `throw new Error(...)` or `return <literal>`';
    return null;
  }

  // Other analysable guards constrain which values are "safe"; the top-level ones also decide which guard fires first.
  const analysed = siblings.filter((other) => other !== guard).map(analyse).filter((item) => !item.unsupported);
  analysed.push(target);
  const ordered = analysed.filter((item) => topLevel.includes(item.node)).sort((a, b) => a.node.start - b.node.start);
  // An earlier top-level guard we cannot read may return first, so "nothing fires" can no longer be asserted.
  const targetIndex = topLevel.indexOf(guard);
  const unreadableBefore = topLevel.slice(0, targetIndex).some((statement) => statement.type === 'IfStatement' && !ordered.some((item) => item.node === statement));

  const termsByKey = new Map();
  for (const item of analysed) for (const term of item.terms) termsByKey.set(term.key, [...(termsByKey.get(term.key) ?? []), term]);
  const groupsWithChildren = new Set([...termsByKey.keys()].filter((key) => !key.endsWith('|')).map((key) => key.split('|')[0]));
  const candidates = (key) => candidatesFor(termsByKey.get(key), key.endsWith('|') && groupsWithChildren.has(key.split('|')[0]));

  const base = new Map();
  for (const [key, terms] of termsByKey) {
    const options = candidates(key);
    const index = options.findIndex((candidate) => terms.every((term) => !evaluate(term, candidate)));
    if (index < 0) {
      why.reason = 'the guards in this function cannot all be false at once, so no input reaches this one';
      return null;
    }
    base.set(key, options[index]);
  }

  const firing = (assignment) => ordered.find((item) => item.terms.some((term) => evaluate(term, assignment.get(term.key))));
  const argsFor = (assignment, varied) => entry.params.map((param) => {
    if (!param.name) return param.shape ?? 'undefined';
    // A real value assigned to the parameter itself is the case under test only when that is the subject being varied
    // (`db = ''`); otherwise the parameter is a dependency and gets its stub.
    const rootKey = `p:${param.name}|`;
    const stub = rootKey !== varied || assignment.get(rootKey) === OBJECT ? stubFor(param.name, assignment, deps) : null;
    if (stub) return stub;
    const value = composeValue(assignment, `p:${param.name}`);
    return value === MISSING ? defaultFor(param) : render(value);
  });
  const globalFetch = (assignment) => {
    const dep = deps.get('fetch');
    return dep ? depStub(dep, assignment, deps) : undefined;
  };
  const describe = (term) => (term.group.startsWith('p:') ? [term.group.slice(2), ...term.path] : [`${term.group.slice(2)} result`, ...term.path]).join('.');

  const cases = [];
  for (const key of new Set(target.terms.map((term) => term.key))) {
    const sample = termsByKey.get(key)[0];
    for (const value of candidates(key)) {
      const assignment = new Map(base).set(key, value);
      const fired = firing(assignment);
      const common = { args: argsFor(assignment, key), globalFetch: globalFetch(assignment) };
      const label = value === OBJECT ? 'an object' : render(value);
      if (fired === target) cases.push({ ...common, ...target.consequent, optional: false, title: `${target.consequent.kind === 'throws' ? 'rejects' : 'handles'} ${describe(sample)} = ${label}` });
      else if (!fired && !unreadableBefore && target.consequent.kind === 'throws') cases.push({ ...common, kind: 'ok', optional: true, title: `accepts ${describe(sample)} = ${label}` });
    }
  }
  const unique = [...new Map(cases.map((item) => [`${item.kind}|${item.args.join(',')}|${item.globalFetch ?? ''}`, item])).values()];
  if (!unique.some((item) => !item.optional)) {
    why.reason = 'no value of the inputs makes this guard the first one to fire';
    return null;
  }
  return unique.map((item) => ({ ...item, stubbed: deps.size > 0 }));
}

/** Turn `@example fn(1, 2) // => 3` JSDoc lines into equality cases. Only literal arguments/results are used. */
export function exampleCases(entry) {
  const cases = [];
  const pattern = new RegExp(`^${entry.name.replace(/[$()*+.?[\]\\^{|}]/g, '\\$&')}\\((.*)\\)\\s*(?:\\/\\/\\s*)?(?:=>|→|returns)\\s*(.+?)\\s*;?$`);
  for (const comment of entry.comments ?? []) {
    if (comment.type !== 'CommentBlock' || !comment.value.startsWith('*')) continue;
    let inExample = false;
    for (const raw of comment.value.split('\n')) {
      const line = raw.replace(/^\s*\*\s?/, '').trim();
      if (line.startsWith('@')) { inExample = line.startsWith('@example'); if (!inExample) continue; }
      const text = line.replace(/^@example\s*/, '');
      const match = inExample ? pattern.exec(text) : null;
      if (!match) continue;
      const args = literalSource(`[${match[1]}]`);
      const expected = literalSource(match[2]);
      if (args && expected) cases.push({ args: [match[1].trim()], kind: 'equal', expected, optional: false, title: `documented example ${entry.name}(${match[1].trim()})` });
    }
  }
  return cases;
}
