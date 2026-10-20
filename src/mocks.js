import path from 'node:path';
import { childNodes, parseSource, propertyName } from './ast.js';

const MOCK_OBJECTS = new Set(['jest', 'vi']);
const MOCK_METHODS = new Set(['mock', 'doMock', 'unstable_mockModule']);
const SPY_METHODS = new Set(['spyOn', 'stub', 'method', 'replace']);

function* walk(node) {
  yield node;
  for (const child of childNodes(node)) yield* walk(child);
}

const stripExtension = (file) => file.replace(/\.(?:[cm]?[jt]sx?|json)$/, '').replace(/[\\/]index$/, '');
const resolveSpec = (spec, fromFile) => (spec.startsWith('.') ? stripExtension(path.resolve(path.dirname(fromFile), spec)) : spec);

/** Module specifiers and object names a test replaces with doubles (`jest.mock('../User')`, `sinon.stub(User, 'find')`). */
function mocksInTest(testText, testFile) {
  const ast = parseSource(testText, testFile);
  const specs = new Set();
  const objects = new Set();
  if (!ast) return { specs, objects };
  for (const node of walk(ast.program)) {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') continue;
    const method = propertyName(node.callee);
    const owner = node.callee.object;
    const first = node.arguments[0];
    if (MOCK_METHODS.has(method) && owner.type === 'Identifier' && MOCK_OBJECTS.has(owner.name) && first?.type === 'StringLiteral') specs.add(resolveSpec(first.value, testFile));
    if (SPY_METHODS.has(method) && first?.type === 'Identifier') objects.add(first.name);
  }
  return { specs, objects };
}

/** Local names the source binds to modules (`import X from`, `const { a } = require()`). */
function bindingsInSource(sourceText, sourceFile) {
  const ast = parseSource(sourceText, sourceFile);
  const bindings = [];
  if (!ast) return bindings;
  const add = (spec, names) => bindings.push({ spec: resolveSpec(spec, sourceFile), names });
  for (const node of walk(ast.program)) {
    if (node.type === 'ImportDeclaration') add(node.source.value, node.specifiers.map((spec) => spec.local.name));
    if (node.type === 'VariableDeclarator' && node.init?.type === 'CallExpression' && node.init.callee.type === 'Identifier' && node.init.callee.name === 'require' && node.init.arguments[0]?.type === 'StringLiteral') {
      const names = [];
      if (node.id.type === 'Identifier') names.push(node.id.name);
      else if (node.id.type === 'ObjectPattern') for (const prop of node.id.properties) if (prop.value?.type === 'Identifier') names.push(prop.value.name);
      add(node.init.arguments[0].value, names);
    }
  }
  return bindings;
}

/**
 * Names used in the source that the test replaces with doubles. A surviving mutant on a line that uses one of them may
 * only be observable against the real dependency (a mocked model that resolves at once hides a removed `await`).
 */
export function mockedBindings({ testText, testFile, sourceText, sourceFile }) {
  const { specs, objects } = mocksInTest(testText, testFile);
  const names = new Set();
  for (const { spec, names: local } of bindingsInSource(sourceText, sourceFile)) if (specs.has(spec)) local.forEach((name) => names.add(name));
  for (const name of objects) names.add(name);
  return names;
}

/** The first mocked name that appears as a whole word in a line of source, or null. */
export function mockBoundaryOf(line, names) {
  for (const name of names) if (new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$')}(?![\\w$])`).test(line)) return name;
  return null;
}
