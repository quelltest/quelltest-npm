import { FUNCTION_TYPES, childNodes, functionName, parseSource, propertyName } from './ast.js';

const OPERATOR_SWAPS = {
  '<': '<=', '<=': '<', '>': '>=', '>=': '>',
  '===': '!==', '!==': '===', '==': '!=', '!=': '==',
  '+': '-', '-': '+', '*': '/',
  '&&': '||', '||': '&&', '??': '||',
};
// Protections the rule pack looks for: wrapping calls that sanitise untrusted input (tried first) or merely coerce it
// (`String(x)` is often an equivalent mutant, so it is tried later).
const SANITIZING_CALL = /^(?:escape\w*|sanitiz\w*|basename|encodeURI\w*|normalize)$/i;
const COERCING_CALL = /^(?:String|Number|parseInt|parseFloat)$/;
// Lower number = tried first when the cap cuts the list: mutants aimed at risky code come before generic operator flips.
const PRIORITY = { sanitizer: 0, await: 0, nullish: 1, guard: 2, throw: 2, operator: 3 };
const IGNORE_MUTANT = /quell-ignore-mutant/;

/** Index of `operator` between two operands, skipping comments that may sit in the gap; -1 if absent. */
export function findOperator(text, from, to, operator) {
  for (let i = from; i < to; i += 1) {
    if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      if (close < 0 || close >= to) return -1;
      i = close + 1;
    } else if (text.startsWith('//', i)) {
      const newline = text.indexOf('\n', i);
      if (newline < 0 || newline >= to) return -1;
      i = newline;
    } else if (text.startsWith(operator, i)) return i;
  }
  return -1;
}

const inRanges = (line, ranges) => ranges.some((range) => (Array.isArray(range) ? line >= range[0] && line <= range[1] : line === range));

/**
 * Enumerate deterministic source mutants. Each mutant is a text splice with a `kind`:
 * `sanitizer` (unwrap `escapeRegExp(x)`/`String(x)`/`path.basename(x)`), `await` (drop `await`), `nullish`
 * (`??` -> `||`, numeric `||` -> `??`), `guard` (`if (c)` -> `if (false)`), `throw` (removed) and `operator` flips.
 *
 * Options: `functions` limits mutation to named functions; `lines` (numbers or `[from, to]` ranges) limits it to
 * those source lines (e.g. scan findings); `max` caps the count after risk-aimed kinds are ordered first.
 * A line marked `// quell-ignore-mutant [reason]` (or the line after such a comment) is never mutated.
 * Returns `{ list, ignored }`.
 */
export function mutantsWithStats(text, file, options = {}) {
  const ast = parseSource(text, file);
  if (!ast) return { list: [], ignored: 0 };
  const wanted = options.functions?.length ? new Set(options.functions) : null;
  const lines = text.split('\n');
  const out = [];
  let ignored = 0;
  const frames = [{ name: '<module>' }];
  const add = (node, kind, start, end, replacement, description, priority = PRIORITY[kind]) => {
    if (wanted && !wanted.has(frames.at(-1).name)) return;
    const line = node.loc.start.line;
    if (options.lines && !inRanges(line, options.lines)) return;
    if (IGNORE_MUTANT.test(lines[line - 1] ?? '') || IGNORE_MUTANT.test(lines[line - 2] ?? '')) {
      ignored += 1;
      return;
    }
    out.push({ id: `${start}:${end}:${replacement}`, kind, priority, line, start, end, replacement, description: `${description} (line ${line})`, function: frames.at(-1).name });
  };
  const visit = (node, parent) => {
    const isFunction = FUNCTION_TYPES.has(node.type);
    if (isFunction) frames.push({ name: functionName(node, parent, frames.at(-1).name) });

    if ((node.type === 'BinaryExpression' || node.type === 'LogicalExpression') && OPERATOR_SWAPS[node.operator]) {
      const start = findOperator(text, node.left.end, node.right.start, node.operator);
      if (start >= 0) {
        const swap = OPERATOR_SWAPS[node.operator];
        add(node, node.operator === '??' ? 'nullish' : 'operator', start, start + node.operator.length, swap, `${node.operator} -> ${swap}`);
        if (node.operator === '||' && node.right.type === 'NumericLiteral') add(node, 'nullish', start, start + 2, '??', '|| -> ?? (0 no longer falls back)');
      }
    }
    if (node.type === 'IfStatement') add(node, 'guard', node.test.start, node.test.end, 'false', 'guard removed');
    if (node.type === 'ThrowStatement') add(node, 'throw', node.start, node.end, ';', 'throw removed');
    // `return await x` is equivalent to `return x` outside try/catch, so it is not worth a mutant.
    if (node.type === 'AwaitExpression' && frames.length > 1 && parent?.type !== 'ReturnStatement') {
      const end = node.argument.extra?.parenthesized ? node.argument.extra.parenStart : node.argument.start;
      add(node, 'await', node.start, end, '', 'await removed');
    }
    if (node.type === 'CallExpression' && node.arguments.length === 1 && node.arguments[0].type !== 'SpreadElement') {
      const callee = node.callee.type === 'Identifier' ? node.callee.name : (node.callee.type === 'MemberExpression' ? `${node.callee.object.name ?? ''}.${propertyName(node.callee)}` : '');
      const last = callee.split('.').pop();
      const argument = text.slice(node.arguments[0].start, node.arguments[0].end);
      if (SANITIZING_CALL.test(last)) add(node, 'sanitizer', node.start, node.end, argument, `sanitiser ${callee}() unwrapped`);
      else if (COERCING_CALL.test(last)) add(node, 'sanitizer', node.start, node.end, argument, `coercion ${callee}() unwrapped`, 1);
    }
    for (const child of childNodes(node)) visit(child, node);
    if (isFunction) frames.pop();
  };
  visit(ast.program, null);
  // A mutant that does not parse would make any runner fail and be miscounted as a kill (`a && b || 0` -> `a && b ?? 0`).
  const unique = [...new Map(out.map((m) => [m.id, m])).values()].filter((m) => parseSource(applyMutant(text, m), file));
  unique.sort((a, b) => a.priority - b.priority || a.start - b.start);
  return { list: unique.slice(0, options.max ?? 30), ignored };
}

/** Mutants only (see `mutantsWithStats`). */
export function mutants(text, file, options = {}) {
  return mutantsWithStats(text, file, options).list;
}

/** Apply one mutant to `text`. */
export function applyMutant(text, mutant) {
  return text.slice(0, mutant.start) + mutant.replacement + text.slice(mutant.end);
}
