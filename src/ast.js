import { parse } from '@babel/parser';

export const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);
const SKIPPED_KEYS = new Set(['leadingComments', 'trailingComments', 'innerComments', 'loc', 'extra']);
export const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export function parseSource(text, file) {
  const base = { sourceType: 'unambiguous', errorRecovery: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, attachComment: true };
  const attempts = /\.[cm]?tsx?$/.test(file) ? [['typescript', 'jsx'], ['typescript']] : [['jsx'], ['jsx', 'flow']];
  for (const plugins of attempts) {
    try {
      return parse(text, { ...base, plugins });
    } catch {
      // try the next plugin set; unparsable files are reported as skipped
    }
  }
  return null;
}

export function* childNodes(node) {
  for (const key of Object.keys(node)) {
    if (SKIPPED_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') yield item;
    } else if (value && typeof value.type === 'string') yield value;
  }
}

/** Depth-first search below `node`, not descending into nested functions. */
export function someShallow(node, predicate) {
  const visit = (current, isRoot) => {
    if (!isRoot && FUNCTION_TYPES.has(current.type)) return false;
    if (predicate(current)) return true;
    for (const child of childNodes(current)) if (visit(child, false)) return true;
    return false;
  };
  return visit(node, true);
}

export function collectShallow(node, predicate) {
  const out = [];
  someShallow(node, (current) => {
    if (predicate(current)) out.push(current);
    return false;
  });
  return out;
}

export function propertyName(callee) {
  return callee.type === 'MemberExpression' ? (callee.property.name ?? callee.property.value) : null;
}

export function routeName(call) {
  if (call?.type !== 'CallExpression' || call.callee.type !== 'MemberExpression') return null;
  const method = propertyName(call.callee);
  if (!ROUTE_METHODS.has(method) && method !== 'use') return null;
  const first = call.arguments[0];
  return `${method.toUpperCase()} ${first?.type === 'StringLiteral' ? first.value : '*'}`;
}

export function functionName(node, parent, enclosing) {
  const direct = node.id?.name ?? node.key?.name ?? node.key?.value;
  if (direct) return direct;
  if (parent?.type === 'VariableDeclarator' && parent.id?.name) return parent.id.name;
  if (parent?.type === 'ObjectProperty' && parent.key) return parent.key.name ?? parent.key.value ?? '<anonymous>';
  if (parent?.type === 'AssignmentExpression') {
    const { left } = parent;
    if (left.type === 'MemberExpression') return propertyName(left) ?? '<anonymous>';
    if (left.type === 'Identifier') return left.name;
  }
  return routeName(parent) ?? (enclosing === '<module>' ? '<anonymous>' : enclosing);
}

