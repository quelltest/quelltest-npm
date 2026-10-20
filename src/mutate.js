import { FUNCTION_TYPES, childNodes, functionName, parseSource } from './ast.js';

const OPERATOR_SWAPS = {
  '<': '<=', '<=': '<', '>': '>=', '>=': '>',
  '===': '!==', '!==': '===', '==': '!=', '!=': '==',
  '+': '-', '-': '+', '*': '/',
  '&&': '||', '||': '&&',
};

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

/**
 * Enumerate deterministic source mutants: flipped comparison/arithmetic/logical operators,
 * removed guards (`if (c)` -> `if (false)`) and removed throws. Each mutant is a text splice.
 * `options.functions` limits mutation to the named functions; `options.max` caps the count.
 */
export function mutants(text, file, options = {}) {
  const ast = parseSource(text, file);
  if (!ast) return [];
  const wanted = options.functions?.length ? new Set(options.functions) : null;
  const out = [];
  const frames = [{ name: '<module>' }];
  const add = (node, start, end, replacement, description) => {
    if (wanted && !wanted.has(frames.at(-1).name)) return;
    out.push({ id: `${start}:${end}:${replacement}`, line: node.loc.start.line, start, end, replacement, description: `${description} (line ${node.loc.start.line})`, function: frames.at(-1).name });
  };
  const visit = (node, parent) => {
    const isFunction = FUNCTION_TYPES.has(node.type);
    if (isFunction) frames.push({ name: functionName(node, parent, frames.at(-1).name) });
    if ((node.type === 'BinaryExpression' || node.type === 'LogicalExpression') && OPERATOR_SWAPS[node.operator]) {
      const start = findOperator(text, node.left.end, node.right.start, node.operator);
      if (start >= 0) {
        add(node, start, start + node.operator.length, OPERATOR_SWAPS[node.operator], `${node.operator} -> ${OPERATOR_SWAPS[node.operator]}`);
      }
    }
    if (node.type === 'IfStatement') add(node, node.test.start, node.test.end, 'false', 'guard removed');
    if (node.type === 'ThrowStatement') add(node, node.start, node.end, ';', 'throw removed');
    for (const child of childNodes(node)) visit(child, node);
    if (isFunction) frames.pop();
  };
  visit(ast.program, null);
  const unique = [...new Map(out.map((m) => [m.id, m])).values()].sort((a, b) => a.start - b.start);
  return unique.slice(0, options.max ?? 30);
}

/** Apply one mutant to `text`. */
export function applyMutant(text, mutant) {
  return text.slice(0, mutant.start) + mutant.replacement + text.slice(mutant.end);
}
