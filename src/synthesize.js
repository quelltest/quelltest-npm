import { literalSource, RELATIONAL_FLIP } from './unit.js';

export const BUILTIN_ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError']);
const BASE_VALUES = [1, 0, -1, 10, 'a', '', null, undefined, true, false];
const MAX_VALUES_PER_PARAM = 8;
const OPERATORS = {
  '<': (a, b) => a < b, '>': (a, b) => a > b, '<=': (a, b) => a <= b, '>=': (a, b) => a >= b,
  '===': (a, b) => a === b, '!==': (a, b) => a !== b,
  // eslint-disable-next-line eqeqeq
  '==': (a, b) => a == b,
  // eslint-disable-next-line eqeqeq
  '!=': (a, b) => a != b,
};

/** Render a JS value as source text. */
export function render(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function literalOf(node) {
  switch (node.type) {
    case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': return { value: node.value };
    case 'NullLiteral': return { value: null };
    case 'Identifier': return node.name === 'undefined' ? { value: undefined } : null;
    case 'UnaryExpression': return node.operator === '-' && node.argument.type === 'NumericLiteral' ? { value: -node.argument.value } : null;
    default: return null;
  }
}

function termOf(node, params) {
  const known = (id) => id?.type === 'Identifier' && params.has(id.name);
  if (node.type === 'BinaryExpression' && RELATIONAL_FLIP[node.operator]) {
    const { left, right } = node;
    if (left.type === 'UnaryExpression' && left.operator === 'typeof' && known(left.argument) && right.type === 'StringLiteral') {
      return { param: left.argument.name, kind: 'typeof', op: node.operator, value: right.value };
    }
    const rightLiteral = literalOf(right);
    if (known(left) && rightLiteral) return { param: left.name, kind: 'compare', op: node.operator, value: rightLiteral.value };
    const leftLiteral = literalOf(left);
    if (known(right) && leftLiteral) return { param: right.name, kind: 'compare', op: RELATIONAL_FLIP[node.operator], value: leftLiteral.value };
    return null;
  }
  if (node.type === 'UnaryExpression' && node.operator === '!' && known(node.argument)) return { param: node.argument.name, kind: 'falsy' };
  if (known(node)) return { param: node.name, kind: 'truthy' };
  return null;
}

const splitOr = (node) => (node.type === 'LogicalExpression' && node.operator === '||' ? [...splitOr(node.left), ...splitOr(node.right)] : [node]);

function evaluate(term, value) {
  if (term.kind === 'falsy') return !value;
  if (term.kind === 'truthy') return Boolean(value);
  if (term.kind === 'typeof') return OPERATORS[term.op](typeof value, term.value);
  return OPERATORS[term.op](value, term.value);
}

function candidatesFor(terms) {
  const derived = [];
  for (const term of terms) {
    if (term.kind !== 'compare') continue;
    if (typeof term.value === 'number') derived.push(term.value - 1, term.value, term.value + 1);
    else if (typeof term.value === 'string') derived.push(term.value, `${term.value}x`);
    else if (term.value === null || term.value === undefined) derived.push(null, undefined);
  }
  const seen = new Set();
  return [...derived, ...BASE_VALUES].filter((value) => {
    const key = `${typeof value}:${render(value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_VALUES_PER_PARAM);
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

function consequentOf(guard) {
  const statements = guard.consequent.type === 'BlockStatement' ? guard.consequent.body : [guard.consequent];
  const first = statements[0];
  if (first?.type === 'ThrowStatement' && first.argument?.type === 'NewExpression') {
    const callee = first.argument.callee;
    const message = first.argument.arguments.find((arg) => arg.type === 'StringLiteral');
    return { kind: 'throws', errorName: callee.type === 'Identifier' ? callee.name : null, message: message?.value ?? null };
  }
  if (first?.type === 'ReturnStatement' && first.argument) {
    const literal = literalOf(first.argument);
    if (literal) return { kind: 'returns', expected: render(literal.value) };
  }
  return null;
}

/**
 * Derive calls and expectations from a guard like `if (amount <= 0 || typeof name !== "string") throw new RangeError("m")`.
 * Each case varies one parameter around the constants in the condition while the others hold safe values.
 * Cases marked `optional` only assert that nothing else threw; they are dropped first if a run disagrees.
 * Returns null when the guard is not simple enough to reason about statically.
 */
export function guardCases(entry, guard, siblings = []) {
  const params = new Map(entry.params.filter((p) => p.name).map((p) => [p.name, p]));
  const terms = splitOr(guard.test).map((node) => termOf(node, params));
  if (!terms.length || terms.some((term) => !term)) return null;
  const consequent = consequentOf(guard);
  if (!consequent) return null;
  const byParam = new Map();
  for (const term of terms) byParam.set(term.param, [...(byParam.get(term.param) ?? []), term]);

  // Other analysable guards in the same function also constrain which values are "safe" for each parameter.
  const constraints = new Map(byParam);
  for (const other of siblings) {
    if (other === guard) continue;
    const otherTerms = splitOr(other.test).map((node) => termOf(node, params));
    if (otherTerms.some((term) => !term)) continue;
    for (const term of otherTerms) constraints.set(term.param, [...(constraints.get(term.param) ?? []), term]);
  }

  const safe = new Map();
  for (const param of entry.params) {
    const own = constraints.get(param.name);
    if (!own) { safe.set(param.name, defaultFor(param)); continue; }
    const options = candidatesFor(own);
    const index = options.findIndex((candidate) => own.every((term) => !evaluate(term, candidate)));
    if (index < 0) return null;
    const value = options[index];
    safe.set(param.name, render(value));
  }

  const cases = [];
  for (const [name, own] of byParam) {
    for (const value of candidatesFor(own)) {
      const violates = own.some((term) => evaluate(term, value));
      const args = entry.params.map((param) => (param.name === name ? render(value) : safe.get(param.name)));
      if (violates) cases.push({ args, ...consequent, optional: false, title: `${consequent.kind === 'throws' ? 'rejects' : 'handles'} ${name} = ${render(value)}` });
      else if (consequent.kind === 'throws') cases.push({ args, kind: 'ok', optional: true, title: `accepts ${name} = ${render(value)}` });
    }
  }
  const unique = [...new Map(cases.map((item) => [`${item.kind}|${item.args.join(',')}`, item])).values()];
  return unique.some((item) => !item.optional) ? unique : null;
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
