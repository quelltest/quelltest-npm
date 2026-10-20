import { FUNCTION_TYPES, childNodes, parseSource, propertyName } from './ast.js';

const RELATIONAL_FLIP = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '===': '===', '!==': '!==', '==': '==', '!=': '!=' };

function paramsOf(node) {
  return node.params.map((param) => {
    if (param.type === 'Identifier') return { name: param.name };
    if (param.type === 'AssignmentPattern' && param.left.type === 'Identifier') return { name: param.left.name, hasDefault: true };
    if (param.type === 'ObjectPattern') return { name: null, shape: '{}' };
    if (param.type === 'ArrayPattern') return { name: null, shape: '[]' };
    return { name: null, shape: 'undefined' };
  });
}

const isFunctionNode = (node) => node && FUNCTION_TYPES.has(node.type);

/**
 * Describe a module's top-level functions and how they are exported (ESM or CommonJS).
 * Purely static: nothing is executed.
 */
export function describeModule(text, file) {
  const ast = parseSource(text, file);
  if (!ast) return null;
  const functions = new Map();
  const exported = new Map(); // export name -> local function name
  let style = 'esm';
  let defaultExport = null;

  const register = (name, node, comments = []) => { if (name && isFunctionNode(node)) functions.set(name, { name, node, params: paramsOf(node), async: Boolean(node.async), comments: node.leadingComments ?? comments }); };
  const declare = (declaration, markExported, comments = declaration?.leadingComments) => {
    if (!declaration) return;
    if (declaration.type === 'FunctionDeclaration') {
      register(declaration.id?.name, declaration, comments);
      if (markExported && declaration.id) exported.set(declaration.id.name, declaration.id.name);
    } else if (declaration.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        if (item.id.type !== 'Identifier') continue;
        register(item.id.name, item.init, comments);
        if (markExported) exported.set(item.id.name, item.id.name);
      }
    }
  };

  for (const statement of ast.program.body) {
    if (statement.type === 'FunctionDeclaration' || statement.type === 'VariableDeclaration') declare(statement, false);
    else if (statement.type === 'ExportNamedDeclaration') {
      declare(statement.declaration, true, statement.leadingComments);
      for (const spec of statement.specifiers ?? []) {
        if (statement.source || !spec.local) continue;
        const exportName = spec.exported.name ?? spec.exported.value;
        if (exportName === 'default') defaultExport = spec.local.name;
        else exported.set(exportName, spec.local.name);
      }
    } else if (statement.type === 'ExportDefaultDeclaration') {
      declare(statement.declaration, false);
      if (statement.declaration.type === 'FunctionDeclaration' && statement.declaration.id) defaultExport = statement.declaration.id.name;
      else if (statement.declaration.type === 'Identifier') defaultExport = statement.declaration.name;
    } else if (statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression') {
      const { left, right } = statement.expression;
      const target = left.type === 'MemberExpression' ? `${left.object.name ?? left.object.object?.name ?? ''}.${propertyName(left)}` : '';
      if (target === 'module.exports' && left.object.name === 'module') {
        style = 'cjs';
        if (right.type === 'ObjectExpression') {
          for (const prop of right.properties) {
            if (prop.type !== 'ObjectProperty' && prop.type !== 'ObjectMethod') continue;
            const key = prop.key.name ?? prop.key.value;
            if (prop.type === 'ObjectMethod') { register(key, prop); exported.set(key, key); } else if (prop.value.type === 'Identifier') exported.set(key, prop.value.name);
            else if (isFunctionNode(prop.value)) { register(key, prop.value); exported.set(key, key); }
          }
        } else if (right.type === 'Identifier') defaultExport = right.name;
      } else if (/^(?:module\.exports|exports)\.\w+$/.test(target) || (left.type === 'MemberExpression' && left.object.name === 'exports')) {
        style = 'cjs';
        const key = propertyName(left);
        if (right.type === 'Identifier') exported.set(key, right.name);
        else if (isFunctionNode(right)) { register(key, right); exported.set(key, key); }
      }
    }
  }
  return { ast, text, style, functions, exported, defaultExport };
}

/** Find the export name for a local function: `{ kind: 'named' | 'default', name }` or null. */
export function exportOf(description, localName) {
  for (const [exportName, local] of description.exported) if (local === localName) return { kind: 'named', name: exportName };
  if (description.defaultExport === localName) return { kind: 'default', name: localName };
  return null;
}

function* descendants(node) {
  yield node;
  for (const child of childNodes(node)) yield* descendants(child);
}

const startsAt = (node, line, column) => node.loc.start.line === line && node.loc.start.column + 1 === column;
const contains = (node, line, column) => {
  const after = node.loc.start.line < line || (node.loc.start.line === line && node.loc.start.column + 1 <= column);
  const before = node.loc.end.line > line || (node.loc.end.line === line && node.loc.end.column >= column);
  return after && before;
};

/** All `if` statements directly in a function (not in nested functions). */
export function allGuards(functionNode) {
  const out = [];
  const visit = (node, isRoot) => {
    if (!isRoot && FUNCTION_TYPES.has(node.type)) return;
    if (node.type === 'IfStatement') out.push(node);
    for (const child of childNodes(node)) visit(child, false);
  };
  visit(functionNode.body, true);
  return out;
}

/** Locate the `if` statement a boundary/throws finding belongs to inside a function node. */
export function guardFor(functionNode, finding) {
  let best = null;
  for (const node of descendants(functionNode.body)) {
    if (node.type !== 'IfStatement') continue;
    if (startsAt(node.test, finding.line, finding.column) || (finding.category === 'throws' && contains(node.consequent, finding.line, finding.column))) {
      if (!best || node.start > best.start) best = node;
    }
  }
  return best;
}

/** Statically parse a literal-only expression text (numbers, strings, booleans, null, arrays, plain objects). */
export function literalSource(text) {
  const ast = parseSource(`(${text})`, 'literal.js');
  const expression = ast?.program.body[0]?.expression;
  const safe = (node) => {
    switch (node?.type) {
      case 'NumericLiteral': case 'StringLiteral': case 'BooleanLiteral': case 'NullLiteral': return true;
      case 'UnaryExpression': return node.operator === '-' && node.argument.type === 'NumericLiteral';
      case 'Identifier': return node.name === 'undefined';
      case 'ArrayExpression': return node.elements.every(safe);
      case 'ObjectExpression': return node.properties.every((p) => p.type === 'ObjectProperty' && !p.computed && safe(p.value));
      case 'TemplateLiteral': return node.expressions.length === 0;
      default: return false;
    }
  };
  return safe(expression) ? text.trim() : null;
}

export { RELATIONAL_FLIP };
