import fs from 'node:fs';
import { childNodes, parseSource } from './ast.js';

// Mock fidelity check. Mutation testing cannot tell whether a stub resembles the real service: a hand-made
// `{ data: { items } }` and the real `{ items }` score the same. This compares stubs you annotate with
// `// quell-mock GET /users/:id` against recorded examples (a HAR file, a JSON examples file, or OpenAPI response
// examples), in the spirit of consumer-driven contracts and of mocks built from values observed in production.

const ANNOTATION = /quell-mock\s+([A-Za-z]+)\s+(\S+)(?:\s+status=(\d{3}))?/;

/** Literal value of an AST node. Anything dynamic becomes `UNKNOWN`; objects with spreads are marked partial. */
export const UNKNOWN = Symbol('unknown');
const partial = new WeakSet();

function valueOf(node) {
  switch (node.type) {
    case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': return node.value;
    case 'NullLiteral': return null;
    case 'UnaryExpression': return node.operator === '-' && node.argument.type === 'NumericLiteral' ? -node.argument.value : UNKNOWN;
    case 'TemplateLiteral': return node.expressions.length === 0 ? node.quasis[0].value.cooked : UNKNOWN;
    case 'ArrayExpression': return node.elements.map((element) => (element && element.type !== 'SpreadElement' ? valueOf(element) : UNKNOWN));
    case 'ObjectExpression': {
      const object = {};
      for (const prop of node.properties) {
        if (prop.type !== 'ObjectProperty' || prop.computed) {
          partial.add(object);
          continue;
        }
        object[prop.key.name ?? prop.key.value] = valueOf(prop.value);
      }
      return object;
    }
    default: return UNKNOWN;
  }
}

function* walk(node, parent = null) {
  yield [node, parent];
  for (const child of childNodes(node)) yield* walk(child, node);
}

/** Stubs annotated with `// quell-mock METHOD /path [status=200]`: the first object or array literal after the comment. */
export function annotatedStubs(text, file = 'a.test.js') {
  const ast = parseSource(text, file);
  if (!ast) return [];
  const nodes = [...walk(ast.program)].filter(([node]) => node.type === 'ObjectExpression' || node.type === 'ArrayExpression');
  const stubs = [];
  for (const comment of ast.comments ?? []) {
    const match = ANNOTATION.exec(comment.value);
    if (!match) continue;
    const next = nodes.filter(([node]) => node.start >= comment.end && node.loc.start.line - comment.loc.end.line <= 8).sort((a, b) => a[0].start - b[0].start)[0];
    if (!next) {
      stubs.push({ file, line: comment.loc.start.line, method: match[1].toUpperCase(), route: match[2], missingLiteral: true });
      continue;
    }
    const [node, parent] = next;
    // `.reply(200, { ... })` carries the status as the first argument.
    const inferredStatus = parent?.type === 'CallExpression' && parent.arguments[0]?.type === 'NumericLiteral' && parent.arguments[1] === node ? parent.arguments[0].value : undefined;
    stubs.push({ file, line: node.loc.start.line, method: match[1].toUpperCase(), route: match[2], status: match[3] ? Number(match[3]) : inferredStatus, value: valueOf(node) });
  }
  return stubs;
}

const toRegExp = (route) => new RegExp(`^${route.replace(/[.+*?^$()|\\]/g, '\\$&').replace(/\{[^}]+\}|:[A-Za-z_]\w*/g, '[^/]+')}/?$`);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Recorded examples as `[{ method, path, status, body }]` from a HAR file, a JSON examples file, or OpenAPI (JSON). */
export function loadExamples(file) {
  const document = parseJson(fs.readFileSync(file, 'utf8'));
  if (document === undefined) throw new Error(`${file} is not valid JSON (YAML OpenAPI files must be converted to JSON first)`);
  const examples = [];
  if (document.log?.entries) {
    for (const entry of document.log.entries) {
      const body = parseJson(entry.response?.content?.text ?? '');
      if (body === undefined) continue;
      let pathname = entry.request?.url ?? '';
      try { pathname = new URL(pathname).pathname; } catch { /* already a path */ }
      examples.push({ method: String(entry.request?.method ?? '').toUpperCase(), path: pathname, status: entry.response?.status, body });
    }
  } else if (document.paths) {
    for (const [route, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const [status, response] of Object.entries(operation?.responses ?? {})) {
          const media = response?.content?.['application/json'];
          const body = media?.example ?? Object.values(media?.examples ?? {})[0]?.value ?? media?.schema?.example;
          if (body !== undefined) examples.push({ method: method.toUpperCase(), path: route, status: Number(status) || undefined, body });
        }
      }
    }
  } else {
    const list = Array.isArray(document) ? document : Object.entries(document).map(([key, value]) => {
      const [method, route] = key.split(/\s+/);
      return { method, path: route, ...(value && typeof value === 'object' && 'body' in value ? value : { body: value }) };
    });
    for (const item of list) examples.push({ method: String(item.method).toUpperCase(), path: item.path, status: item.status, body: item.body });
  }
  return examples;
}

const kindOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

/** Differences between a stub and a recorded body: keys only the example has, keys only the stub has, type mismatches. */
export function compareShape(stub, example, where = '') {
  if (stub === UNKNOWN) return [];
  const here = where || '(root)';
  const stubKind = kindOf(stub);
  const exampleKind = kindOf(example);
  if (stubKind !== exampleKind) return [{ path: here, kind: 'type', message: `stub has ${stubKind}, the recorded example has ${exampleKind}` }];
  if (stubKind === 'array') return stub.length && example.length ? compareShape(stub[0], example[0], `${where}[0]`) : [];
  if (stubKind !== 'object') return [];
  const issues = [];
  const isPartial = partial.has(stub);
  for (const key of Object.keys(example)) {
    if (!(key in stub)) {
      if (!isPartial) issues.push({ path: where ? `${where}.${key}` : key, kind: 'missing', message: 'the recorded example has this field, the stub does not' });
    } else issues.push(...compareShape(stub[key], example[key], where ? `${where}.${key}` : key));
  }
  for (const key of Object.keys(stub)) if (!(key in example)) issues.push({ path: where ? `${where}.${key}` : key, kind: 'extra', message: 'the stub invents this field, the recorded example does not have it' });
  return issues;
}

/**
 * Check every annotated stub in a test file against the examples for its route. For a route with several examples
 * (different statuses or recordings) the closest one is used.
 */
export function checkStubs(text, file, examples) {
  const problems = [];
  for (const stub of annotatedStubs(text, file)) {
    const base = { file, line: stub.line, route: `${stub.method} ${stub.route}` };
    if (stub.missingLiteral) {
      problems.push({ ...base, path: '(none)', kind: 'annotation', message: 'no object or array literal follows this quell-mock annotation' });
      continue;
    }
    const matcher = toRegExp(stub.route);
    const candidates = examples.filter((example) => example.method === stub.method && (matcher.test(example.path) || toRegExp(example.path).test(stub.route) || example.path === stub.route)
      && (stub.status === undefined || example.status === undefined || example.status === stub.status));
    if (!candidates.length) {
      problems.push({ ...base, path: '(none)', kind: 'no-example', message: `no recorded example for ${stub.method} ${stub.route}${stub.status ? ` with status ${stub.status}` : ''}` });
      continue;
    }
    const best = candidates.map((example) => compareShape(stub.value, example.body)).sort((a, b) => a.length - b.length)[0];
    for (const issue of best) problems.push({ ...base, ...issue });
  }
  return problems;
}
