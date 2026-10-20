import { FUNCTION_TYPES, ROUTE_METHODS, childNodes, propertyName } from './ast.js';

const SOURCES = new Set(['body', 'query', 'params']);
const RELATIONAL = new Set(['<', '>', '<=', '>=', '===', '!==', '==', '!=']);

function* descendants(node) {
  yield node;
  for (const child of childNodes(node)) yield* descendants(child);
}

const contains = (node, finding) => {
  const after = node.loc.start.line < finding.line || (node.loc.start.line === finding.line && node.loc.start.column + 1 <= finding.column);
  const before = node.loc.end.line > finding.endLine || (node.loc.end.line === finding.endLine && node.loc.end.column >= (finding.endColumn ?? 0));
  return after && before;
};

/** Find the `router.METHOD(path, ..., handler)` registration whose handler contains the finding, if any. */
export function routeFor(ast, finding) {
  let best = null;
  for (const node of descendants(ast.program)) {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') continue;
    const method = propertyName(node.callee);
    if (!ROUTE_METHODS.has(method) || !/^(?:router|app|r|route)$/i.test(node.callee.object?.name ?? '')) continue;
    const handler = [...node.arguments].reverse().find((arg) => FUNCTION_TYPES.has(arg.type) && contains(arg, finding));
    if (!handler) continue;
    const first = node.arguments[0];
    const candidate = { method: method.toUpperCase(), path: first?.type === 'StringLiteral' ? first.value : '*', handler };
    if (!best || handler.start > best.handler.start) best = candidate;
  }
  return best;
}

function requestField(node, fields) {
  if (node.type === 'Identifier') return fields.get(node.name) ?? null;
  let current = node;
  const chain = [];
  while (current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression') {
    chain.unshift(current.computed ? current.property.value : current.property.name);
    current = current.object;
  }
  if (current.type === 'Identifier' && /^(?:req|request)$/.test(current.name) && SOURCES.has(chain[0]) && chain[1]) return { source: chain[0], field: chain[1] };
  return null;
}

function literalValue(node) {
  if (node.type === 'NumericLiteral' || node.type === 'StringLiteral' || node.type === 'BooleanLiteral') return { value: node.value };
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'NumericLiteral') return { value: -node.argument.value };
  return null;
}

function statusOf(consequent) {
  for (const node of descendants(consequent)) {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && propertyName(node.callee) === 'status' && node.arguments[0]?.type === 'NumericLiteral') return node.arguments[0].value;
    if (node.type === 'NewExpression' && /Error$/.test(node.callee.name ?? '')) {
      const code = node.arguments.find((arg) => arg.type === 'NumericLiteral');
      if (code) return code.value;
    }
  }
  return null;
}

const splitOr = (node) => (node.type === 'LogicalExpression' && node.operator === '||' ? [...splitOr(node.left), ...splitOr(node.right)] : [node]);

/**
 * Derive the requests a route handler's guards imply, from conditions on `req.body.x`, `req.query.x`,
 * `req.params.x` (directly or through `const { x } = req.body`). Returns `[{ method, path, source, field, case, value?, expect }]`.
 * These are suggestions for a request-level test; nothing is executed.
 */
export function requestCases(route) {
  const fields = new Map();
  for (const node of descendants(route.handler.body)) {
    if (node.type !== 'VariableDeclarator' || !node.init) continue;
    const init = requestField(node.init, new Map());
    const whole = node.init.type === 'MemberExpression' && node.init.object.type === 'Identifier' && /^(?:req|request)$/.test(node.init.object.name) && SOURCES.has(propertyName(node.init));
    if (node.id.type === 'ObjectPattern' && whole) {
      for (const prop of node.id.properties) {
        const key = prop.key?.name ?? prop.key?.value;
        const local = prop.value?.type === 'AssignmentPattern' ? prop.value.left : prop.value;
        if (key && local?.type === 'Identifier') fields.set(local.name, { source: propertyName(node.init), field: key });
      }
    } else if (node.id.type === 'Identifier' && init) fields.set(node.id.name, init);
  }

  const cases = [];
  const add = (item) => cases.push({ method: route.method, path: route.path, ...item });
  for (const node of descendants(route.handler.body)) {
    if (node.type !== 'IfStatement') continue;
    const expect = statusOf(node.consequent) ?? 'a rejection (4xx)';
    for (const term of splitOr(node.test)) {
      if (term.type === 'UnaryExpression' && term.operator === '!') {
        const inner = term.argument;
        if (inner.type === 'CallExpression' && inner.callee.type === 'MemberExpression' && /Array\.isArray$/.test(`${inner.callee.object.name}.${propertyName(inner.callee)}`)) {
          const target = requestField(inner.arguments[0], fields);
          if (target) add({ ...target, case: 'wrong type', value: 'a string instead of an array', expect });
          continue;
        }
        const target = requestField(inner, fields);
        if (target) add({ ...target, case: 'missing', expect });
      } else if (term.type === 'BinaryExpression' && RELATIONAL.has(term.operator)) {
        const left = term.left;
        if (left.type === 'UnaryExpression' && left.operator === 'typeof' && term.right.type === 'StringLiteral') {
          const target = requestField(left.argument, fields);
          if (target) add({ ...target, case: 'wrong type', value: `a non-${term.right.value} value`, expect });
          continue;
        }
        const target = requestField(left, fields) ?? requestField(term.right, fields);
        const literal = literalValue(requestField(left, fields) ? term.right : left);
        if (target && literal && typeof literal.value === 'number') {
          for (const value of [literal.value - 1, literal.value, literal.value + 1]) add({ ...target, case: 'boundary', value, expect: `${expect} when the condition \`${term.operator} ${literal.value}\` holds` });
        } else if (target && literal) add({ ...target, case: 'boundary', value: literal.value, expect });
      }
    }
  }
  return cases;
}

/** Render cases as an HTTP request skeleton, one line per case. */
export function renderRequests(cases) {
  return cases.map((item) => {
    const where = item.source === 'body' ? 'body' : item.source === 'query' ? 'query' : 'path params';
    const what = item.case === 'missing' ? `${where} without \`${item.field}\`` : item.case === 'wrong type' ? `${where}.${item.field} = ${item.value}` : `${where}.${item.field} = ${JSON.stringify(item.value)}`;
    return `${item.method} ${item.path} with ${what} -> expect ${item.expect}`;
  });
}
