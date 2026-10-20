import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverFiles } from './files.js';
import { restoreIfInterrupted } from './backup.js';
import { FUNCTION_TYPES, ROUTE_METHODS, childNodes, collectShallow, functionName, parseSource, propertyName, someShallow } from './ast.js';

const RELATIONAL = new Set(['<', '>', '<=', '>=']);
const EQUALITY = new Set(['==', '!=', '===', '!==']);
const BASE_RISK = { risk: 9, throws: 6, boundary: 5, schema: 5, jsdoc: 4, nullish: 3, async: 3 };
const SENSITIVE = /auth|login|token|password|payment|pay|billing|charge|refund|delete|remove|admin|permission|role|secret/i;
const WRITE_METHODS = new Set(['create', 'update', 'updateOne', 'updateMany', 'findByIdAndUpdate', 'findOneAndUpdate', 'set', 'merge', 'insertOne']);
const ARRAY_METHODS = new Set(['map', 'filter', 'forEach', 'reduce', 'find', 'some', 'every', 'flatMap']);
const SCHEMA_CALLS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
const PRIVILEGED_FIELD = /^(?:status|role|roles|isAdmin|isActive|permissions|plan|type)$/;
const RESPONSE_ROOT = /^(data|res|resp|response|result|results|payload|body|json|req)$/i;

const SUGGESTIONS = {
  throws: 'assert the error type and message',
  boundary: 'test the boundary and its adjacent values',
  nullish: 'test null, undefined, and the populated path',
  jsdoc: 'turn the documented contract into an executable test',
  schema: 'test accepted, rejected, and boundary-shaped input',
  async: 'test resolve and reject behavior',
};

export const RULES = {
  'regex-injection': 'user-controlled text reaches a regular expression; test input such as "(" or ".*" and escape it',
  'mass-assignment': 'request body is written to a document unfiltered; test that unexpected fields are rejected or ignored',
  'falsy-fallback': '`||` also replaces 0 and ""; test 0 and use `??` where 0 is valid',
  'unguarded-call': 'call throws on bad input outside try/catch; test expired, malformed and non-string input',
  'check-then-act': 'lookup followed by write is racy; test two simultaneous requests and map the duplicate-key error',
  'unhandled-async-route': 'async route handler has no error mapping; test that a rejected dependency does not hang or return 500',
  'unguarded-member-call': 'property chain is dereferenced without a guard; test the missing-property case',
};

function rootName(node) {
  let current = node;
  while (current?.type === 'MemberExpression' || current?.type === 'OptionalMemberExpression') current = current.object;
  return current?.type === 'Identifier' ? current.name : null;
}

function hasOptional(node) {
  for (let current = node; current; current = current.object ?? current.callee) {
    if (current.optional || current.type.startsWith('Optional')) return true;
    if (!['MemberExpression', 'CallExpression'].includes(current.type)) return false;
  }
  return false;
}

function isProcessEnv(node) {
  return node.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === 'process' && node.property.name === 'env';
}

function isNullLike(node) {
  return node.type === 'NullLiteral' || (node.type === 'Identifier' && node.name === 'undefined')
    || (node.type === 'UnaryExpression' && (node.operator === 'void' || node.operator === 'typeof'));
}

function jsdocTags(comments = []) {
  const tags = [];
  for (const comment of comments) {
    if (comment.type !== 'CommentBlock' || !comment.value.startsWith('*')) continue;
    for (const match of comment.value.matchAll(/@(?:throws|param|example)\b[^\n]*/g)) tags.push(match[0].replace(/\s+/g, ' ').trim());
  }
  return tags;
}

/** Scan one source text into candidate findings. Pure: does not touch the file system. */
export function scanSource(text, file, options = {}) {
  const ast = parseSource(text, file);
  if (!ast) return { findings: [], parsed: false };
  const idFile = options.idFile ?? file;
  const mentionsZod = /\bzod\b/.test(text);
  const findings = [];
  const ordinals = new Map();
  const seen = new Set();
  const ancestors = [];
  const frames = [{ name: '<module>', node: ast.program }];

  const slice = (node, limit = 160) => {
    const raw = text.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
    return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw;
  };

  const emit = (node, category, { rule = null, evidence = slice(node), suggestion, branch = false } = {}) => {
    const frame = frames.at(-1);
    const key = [idFile, frame.name, category, rule ?? '', evidence].join('|');
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    const sensitive = SENSITIVE.test(file) || SENSITIVE.test(frame.name);
    findings.push({
      id: crypto.createHash('sha1').update(`${key}|${ordinal}`).digest('hex').slice(0, 12),
      file, line: node.loc.start.line, column: node.loc.start.column + 1, endLine: node.loc.end.line, endColumn: node.loc.end.column,
      ...(branch ? { branch } : {}),
      function: frame.name, category, ...(rule ? { rule } : {}), evidence,
      suggestion: suggestion ?? (rule ? RULES[rule] : SUGGESTIONS[category]),
      risk: BASE_RISK[category] + (sensitive ? 2 : 0),
    });
  };

  const enclosingStatement = () => [...ancestors].reverse().find((n) => /(?:Statement|Declaration)$/.test(n.type) && n.type !== 'BlockStatement') ?? ast.program;
  const firstInStatement = (category) => {
    const key = `${category}:${enclosingStatement().start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  const onFunction = (node) => {
    const tags = jsdocTags(node.leadingComments ?? ancestors.at(-2)?.leadingComments ?? ancestors.at(-3)?.leadingComments);
    if (tags.length) emit(node, 'jsdoc', { evidence: tags[0], suggestion: `${SUGGESTIONS.jsdoc} (${tags.length} tag${tags.length > 1 ? 's' : ''})` });
    if (node.async && someShallow(node.body, (child) => child.type === 'AwaitExpression')) {
      emit(node, 'async', { evidence: slice({ start: node.start, end: node.body.start ?? node.end }, 120) });
    }
  };

  const onCondition = (node) => {
    if (someShallow(node.test, isProcessEnv)) return;
    const comparisons = collectShallow(node.test, (n) => n.type === 'BinaryExpression' && (RELATIONAL.has(n.operator) || EQUALITY.has(n.operator)));
    const nullChecks = comparisons.filter((c) => EQUALITY.has(c.operator) && (isNullLike(c.left) || isNullLike(c.right)));
    if (comparisons.length > nullChecks.length) emit(node.test, 'boundary', { branch: true });
    if (nullChecks.length) emit(node.test, 'nullish', { branch: true });
  };

  const onCall = (node) => {
    const { callee } = node;
    const property = propertyName(callee);
    const calleeText = callee.type === 'MemberExpression' ? slice(callee, 80) : '';
    const within = (type) => ancestors.slice(0, -1).some((n) => n.type === type);

    if (mentionsZod && SCHEMA_CALLS.has(property)) emit(node, 'schema');
    if (mentionsZod && calleeText === 'z.object' && !ancestors.slice(0, -1).some((n) => n.type === 'CallExpression' && rootName(n.callee.object ?? n.callee) === 'z')) emit(node, 'schema');

    if ((calleeText === 'Object.assign' || WRITE_METHODS.has(property)) && node.arguments.some((arg) => /^req\.body(?:\.\w+)*$/.test(slice(arg, 80)))) {
      emit(node, 'risk', { rule: 'mass-assignment' });
    }
    if (/^(?:jwt|jsonwebtoken)\.verify$|^(?:bcrypt|bcryptjs)\.(?:compare|hash)$/.test(calleeText) && !within('TryStatement')) emit(node, 'risk', { rule: 'unguarded-call' });
    if (ARRAY_METHODS.has(property) && callee.object.type === 'MemberExpression' && !callee.computed && !hasOptional(callee)
      && callee.object.object.type !== 'ThisExpression' && RESPONSE_ROOT.test(rootName(callee.object) ?? '')) emit(node, 'risk', { rule: 'unguarded-member-call' });

    if (ROUTE_METHODS.has(property) && /^(?:router|app|r|route)$/i.test(callee.object.name ?? '')) {
      const handler = node.arguments.at(-1);
      if (handler && FUNCTION_TYPES.has(handler.type) && handler.async && !someShallow(handler.body, (n) => n.type === 'TryStatement')) {
        emit(handler, 'risk', { rule: 'unhandled-async-route', evidence: slice({ start: node.start, end: handler.body.start ?? node.end }, 120) });
      }
    }
    const fn = frames.at(-1);
    if (['create', 'save', 'insertOne'].includes(property) && fn.node !== ast.program && !text.slice(fn.node.start, fn.node.end).includes('11000')
      && someShallow(fn.node.body, (n) => n.type === 'CallExpression' && ['exists', 'findOne'].includes(propertyName(n.callee)))) {
      emit(node, 'risk', { rule: 'check-then-act' });
    }
  };

  const onVisit = (node) => {
    if (node.type === 'ThrowStatement' && node.argument?.type === 'NewExpression') {
      const callee = node.argument.callee;
      if (/(?:Error|Exception)$/.test(callee.name ?? callee.property?.name ?? '')) {
        const messages = node.argument.arguments.filter((arg) => arg.type === 'StringLiteral');
        const message = messages.find((arg) => arg.value.includes(' ')) ?? messages[0];
        emit(node, 'throws', { suggestion: message ? `${SUGGESTIONS.throws} (${JSON.stringify(message.value)})` : SUGGESTIONS.throws });
      }
    }
    if (node.type === 'IfStatement' || node.type === 'ConditionalExpression' || node.type === 'WhileStatement') onCondition(node);
    const nullish = node.type === 'OptionalMemberExpression' || node.type === 'OptionalCallExpression'
      || (node.type === 'LogicalExpression' && node.operator === '??') || (node.type === 'AssignmentExpression' && node.operator === '??=');
    if (nullish && firstInStatement('nullish')) emit(enclosingStatement(), 'nullish');
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') onCall(node);

    if (node.type === 'NewExpression' && node.callee.name === 'RegExp' && node.arguments[0] && node.arguments[0].type !== 'StringLiteral' && !/escape/i.test(slice(node.arguments[0], 80))) {
      emit(node, 'risk', { rule: 'regex-injection' });
    }
    if (node.type === 'ObjectProperty' && (node.key.name === '$regex' || node.key.value === '$regex')
      && !['StringLiteral', 'RegExpLiteral'].includes(node.value.type) && !/escape/i.test(slice(node.value, 80))) {
      emit(node, 'risk', { rule: 'regex-injection' });
    }
    if (node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'MemberExpression' && PRIVILEGED_FIELD.test(propertyName(node.left) ?? '')
      && /^req\.body(?:\.\w+)*$/.test(slice(node.right, 80))) {
      emit(node, 'risk', { rule: 'mass-assignment' });
    }
    if (node.type === 'LogicalExpression' && node.operator === '||') {
      const numeric = node.right.type === 'NumericLiteral' && node.left.type !== 'LogicalExpression';
      const chain = node.left.type === 'MemberExpression' && node.right.type === 'MemberExpression';
      if ((numeric || chain) && firstInStatement('falsy-fallback')) emit(node, 'risk', { rule: 'falsy-fallback' });
    }
  };

  const traverse = (node, parent) => {
    ancestors.push(node);
    const isFunction = FUNCTION_TYPES.has(node.type);
    if (isFunction) frames.push({ name: functionName(node, parent, frames.at(-1).name), node });
    if (isFunction) onFunction(node);
    onVisit(node);
    for (const child of childNodes(node)) traverse(child, node);
    if (isFunction) frames.pop();
    ancestors.pop();
  };
  traverse(ast.program, null);
  return { findings, parsed: true };
}

/** Scan files below `root`. Findings are ranked by risk, then location. */
export function scan(root = '.', options = {}) {
  const absolute = path.resolve(root);
  const scanRoot = fs.statSync(absolute).isFile() ? path.dirname(absolute) : absolute;
  const findings = [];
  const skipped = [];
  const restored = [];
  for (const file of discoverFiles(absolute, options)) {
    const relative = path.relative(process.cwd(), file).replaceAll('\\', '/');
    if (restoreIfInterrupted(file)) restored.push(relative);
    const idFile = path.relative(scanRoot, file).replaceAll('\\', '/');
    const result = scanSource(fs.readFileSync(file, 'utf8'), relative, { idFile });
    if (!result.parsed) skipped.push(relative);
    findings.push(...result.findings);
  }
  const unique = [...new Map(findings.map((item) => [item.id, item])).values()];
  unique.sort((a, b) => b.risk - a.risk || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return { version: 1, root: absolute, findings: unique, skipped, restored };
}
