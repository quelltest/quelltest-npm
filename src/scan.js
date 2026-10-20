import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { discoverFiles } from './files.js';
import { restoreIfInterrupted } from './backup.js';
import { FUNCTION_TYPES, ROUTE_METHODS, childNodes, collectShallow, functionName, parseSource, propertyName, someShallow } from './ast.js';

const RELATIONAL = new Set(['<', '>', '<=', '>=']);
const EQUALITY = new Set(['==', '!=', '===', '!==']);
const SENSITIVE = /auth|login|token|password|payment|pay|billing|charge|refund|delete|remove|admin|permission|role|secret/i;
const WRITE_METHODS = new Set(['create', 'update', 'updateOne', 'updateMany', 'findByIdAndUpdate', 'findOneAndUpdate', 'set', 'merge', 'insertOne', 'insertMany']);
const QUERY_METHODS = new Set(['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments', 'exists', 'replaceOne']);
const PROMISE_METHODS = new Set(['save', 'create', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'insertOne', 'insertMany', 'findByIdAndUpdate', 'findOneAndUpdate', 'findByIdAndDelete', 'findOneAndDelete', 'replaceOne']);
const LOOKUP_METHODS = new Set(['exists', 'findOne', 'countDocuments']);
const FS_PATH_SINKS = /^(?:fs\.(?:promises\.)?(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync|unlink|unlinkSync|readdir|readdirSync|rm|rmSync)|(?:res|response)\.(?:sendFile|download)|path\.(?:join|resolve))$/;
const NETWORK_CALL = /^(?:fetch|axios|got|ky|(?:axios|got|ky|http|https)\.(?:get|post|put|patch|delete|request)|(?:axios|got|ky)\.(?:head|options))$/;
const ARRAY_METHODS = new Set(['map', 'filter', 'forEach', 'reduce', 'find', 'some', 'every', 'flatMap']);
const SCHEMA_CALLS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
const PRIVILEGED_FIELD = /^(?:status|role|roles|isAdmin|isActive|permissions|plan|type)$/;
const RESPONSE_ROOT = /^(data|res|resp|response|result|results|payload|body|json)$/i;
const REQUEST_ROOT = /^(?:req|request)$/;
const REQUEST_SOURCES = new Set(['body', 'query', 'params']);
const ASYNC_WRAPPERS = /^(?:asyncHandler|catchAsync|wrapAsync|asyncWrapper|expressAsyncHandler|tryCatch|catchErrors)$/;
// Which calls neutralise a request value depends on the sink: String() stops operator objects but not "../".
const SANITIZERS = {
  any: /(?:^|\.)(?:String|Number|Boolean|parseInt|parseFloat|encodeURIComponent|encodeURI|basename)$|escape|sanitiz|^validate/i,
  path: /(?:^|\.)basename$|sanitiz|^validate/i,
  regex: /escape|sanitiz/i,
  nosql: /(?:^|\.)(?:String|Number|Boolean|parseInt|parseFloat)$|escape|sanitiz|toString$/i,
};
const NUMERIC_NAME = /(?:hour|minute|second|count|index|idx|page|limit|offset|amount|total|qty|quantity|price|age|score|size|day|month|year)$/i;
const NUMERIC_CALL = /^(?:Number|parseInt|parseFloat|Math\.\w+)$/;
const QUERY_RETURNING = new Set(['find', 'findOne', 'findById', 'findByIdAndUpdate', 'findOneAndUpdate', 'findByIdAndDelete', 'findOneAndDelete', 'countDocuments', 'exists']);
// Reading these members off a query/promise is harmless (chaining a query builder, then/catch); reading data fields is the bug.
const QUERY_BUILDER = new Set(['then', 'catch', 'finally', 'exec', 'lean', 'populate', 'select', 'sort', 'limit', 'skip', 'where', 'session', 'collation', 'hint', 'maxTimeMS']);
const ORM_MENTION = /mongoose|sequelize|prisma|typeorm|mongodb|knex|objection|bookshelf|drizzle|\.populate\(|\bmodels?\b/i;
const SECRET_ARG_CALLS = /^(?:jwt\.sign|jwt\.verify|jsonwebtoken\.sign|jsonwebtoken\.verify|crypto\.createHmac|createHmac)$/;
const SECRET_NAME = /(?:secret|passw(?:or)?d|api[_-]?key|private[_-]?key|access[_-]?token|auth[_-]?token)$/i;

const BASE_RISK = { throws: 6, boundary: 4, schema: 5, jsdoc: 3, nullish: 3, async: 2 };
const RULE_RISK = {
  'mass-assignment': 10, 'regex-injection': 10, 'nosql-injection': 10, 'path-traversal': 10, 'eval-input': 10,
  'unguarded-call': 9, 'check-then-act': 9, 'hard-coded-secret': 9,
  'open-redirect': 8, 'missing-await': 8, 'unparsed-json': 7,
  'unguarded-network-call': 7, 'unguarded-member-call': 6, 'unhandled-async-route': 5, 'deep-response-chain': 5, 'falsy-fallback': 4,
};

// How much to trust a finding, from precision on the bundled benchmark (eval/) and on real code reviews.
export const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };
const RULE_CONFIDENCE = {
  'nosql-injection': 'high', 'path-traversal': 'high', 'eval-input': 'high', 'unparsed-json': 'high', 'hard-coded-secret': 'high', 'missing-await': 'high',
  'mass-assignment': 'high', 'unguarded-call': 'high',
  'regex-injection': 'medium', 'open-redirect': 'medium', 'unguarded-network-call': 'medium', 'deep-response-chain': 'medium', 'check-then-act': 'medium', 'unguarded-member-call': 'medium', 'unhandled-async-route': 'medium', 'falsy-fallback': 'medium',
};
const CATEGORY_CONFIDENCE = { throws: 'high', boundary: 'medium', schema: 'medium', jsdoc: 'medium', nullish: 'low', async: 'low' };

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
  'falsy-fallback': '`||` also replaces 0; test 0 and use `??` where 0 is valid',
  'unguarded-call': 'call throws on bad input outside try/catch; test expired, malformed and non-string input',
  'check-then-act': 'lookup followed by write is racy; test two simultaneous requests and map the duplicate-key error',
  'unhandled-async-route': 'async route handler has no error mapping; test that a rejected dependency does not hang or return 500',
  'unguarded-member-call': 'property chain is dereferenced without a guard; test the missing-property case',
  'nosql-injection': 'request value used as a query operand can be an operator object ({ "$ne": null }); test it and coerce with String()',
  'path-traversal': 'request value reaches a file path; test "../" and absolute paths and use path.basename or a base-directory check',
  'open-redirect': 'request value decides a redirect/URL target; test absolute and protocol-relative URLs against an allow-list',
  'missing-await': 'promise-returning call is not awaited; test that failures are reported and that the write finished before responding',
  'hard-coded-secret': 'secret-looking value is committed in source; load it from the environment and test the missing-config path',
  'eval-input': 'dynamic code evaluation with a non-literal argument; remove it or test hostile input',
  'unparsed-json': 'JSON.parse on request data outside try/catch throws on malformed input; test invalid JSON',
  'unguarded-network-call': 'network call can reject or hang and nothing handles it; test a rejected call, a non-2xx status and a timeout (stub the client)',
  'deep-response-chain': 'deep or indexed read on a response crashes when the shape differs; test an empty or missing field and read it with optional chaining',
};

function rootName(node) {
  let current = node;
  while (current?.type === 'MemberExpression' || current?.type === 'OptionalMemberExpression') current = current.object;
  return current?.type === 'Identifier' ? current.name : null;
}

function chainDepth(node) {
  let depth = 0;
  for (let current = node; current?.type === 'MemberExpression'; current = current.object) depth += 1;
  return depth;
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

/** Identifier names bound by function parameters or destructuring patterns. */
function patternNames(patterns) {
  const names = [];
  const visit = (pattern) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') names.push(pattern.name);
    else if (pattern.type === 'AssignmentPattern') visit(pattern.left);
    else if (pattern.type === 'RestElement') visit(pattern.argument);
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(visit);
    else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((prop) => visit(prop.value ?? prop.argument));
    else if (pattern.type === 'TSParameterProperty') visit(pattern.parameter);
  };
  patterns.forEach(visit);
  return names;
}

function directivesIn(comments) {
  const byLine = new Map();
  let fileWide = false;
  for (const comment of comments ?? []) {
    if (/quell-ignore-file/.test(comment.value)) fileWide = true;
    const match = /quell-ignore(?![\w-])(?:[ \t]+([\w,\- \t]+))?/.exec(comment.value);
    if (!match) continue;
    const rules = (match[1] ?? '').split(/[,\s]+/).filter(Boolean);
    for (const line of [comment.loc.end.line, comment.loc.end.line + 1]) byLine.set(line, [...(byLine.get(line) ?? []), rules]);
  }
  return { byLine, fileWide };
}

/** Scan one source text into candidate findings. Pure: does not touch the file system. */
export function scanSource(text, file, options = {}) {
  const ast = parseSource(text, file);
  if (!ast) return { findings: [], parsed: false, suppressed: 0 };
  const directives = directivesIn(ast.comments);
  if (directives.fileWide) return { findings: [], parsed: true, suppressed: 0 };
  const idFile = options.idFile ?? file;
  const mentionsZod = /\bzod\b/.test(text);
  const findings = [];
  const ordinals = new Map();
  const seen = new Set();
  const ancestors = [];
  const frames = [{ name: '<module>', node: ast.program, taint: new Map(), aliases: new Map(), safe: new Map() }];
  let suppressed = 0;

  const slice = (node, limit = 160) => {
    const raw = text.slice(node.start, node.end).replace(/\s+/g, ' ').trim();
    return raw.length > limit ? `${raw.slice(0, limit - 1)}…` : raw;
  };

  const ignored = (node, category, rule) => (directives.byLine.get(node.loc.start.line) ?? []).some((rules) => !rules.length || rules.includes(rule ?? category) || rules.includes(category));

  const emit = (node, category, { rule = null, evidence = slice(node), suggestion, branch = false, risk, confidence } = {}) => {
    if (ignored(node, category, rule)) { suppressed += 1; return; }
    const frame = frames.at(-1);
    const key = [idFile, frame.name, category, rule ?? '', evidence].join('|');
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    const sensitive = SENSITIVE.test(file) || SENSITIVE.test(frame.name);
    findings.push({
      id: crypto.createHash('sha1').update(`${key}|${ordinal}`).digest('hex').slice(0, 12),
      file, line: node.loc.start.line, column: node.loc.start.column + 1, endLine: node.loc.end.line, endColumn: node.loc.end.column,
      ...(branch ? { branch } : {}),
      function: frame.name, category, ...(rule ? { rule } : {}), confidence: confidence ?? (rule ? RULE_CONFIDENCE[rule] : CATEGORY_CONFIDENCE[category]), evidence,
      suggestion: suggestion ?? (rule ? RULES[rule] : SUGGESTIONS[category]),
      risk: (risk ?? (rule ? RULE_RISK[rule] : BASE_RISK[category])) + (sensitive ? 1 : 0),
    });
  };

  // --- one hop of intra-procedural data flow from req.body / req.query / req.params -------------------------
  // A scope entry may hold `null`: that is a shadowing parameter or a reassignment to a clean value.
  const lookupFrames = (map) => (name) => {
    for (let i = frames.length - 1; i >= 0; i -= 1) if (frames[i][map].has(name)) return frames[i][map].get(name);
    return null;
  };
  const taintOf = lookupFrames('taint'); // { kind: 'body' | 'query' | 'params', whole: boolean } | null
  const aliasOf = lookupFrames('aliases');
  const safeFor = lookupFrames('safe'); // name -> Set of sinks the value was already sanitised for

  /** The request member chain `req.<source>...` a node is (`{ kind, depth }`: properties after the source), or null. */
  const requestChain = (node) => {
    let depth = 0;
    for (let current = node; current?.type === 'MemberExpression' || current?.type === 'OptionalMemberExpression'; current = current.object) {
      if (current.object.type === 'Identifier' && REQUEST_ROOT.test(current.object.name) && REQUEST_SOURCES.has(propertyName(current))) return { kind: propertyName(current), depth };
      depth += 1;
    }
    return null;
  };

  /** Which request source (`body` | `query` | `params`) a value comes from, or null. Calls that sanitise for `rule` stop the flow. */
  const taintKind = (node, rule = 'any') => {
    if (!node) return null;
    const recur = (child) => taintKind(child, rule);
    switch (node.type) {
      case 'Identifier': return taintOf(node.name)?.kind ?? null;
      case 'MemberExpression': case 'OptionalMemberExpression': {
        const chain = requestChain(node);
        if (chain) return chain.kind;
        let current = node;
        while (current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression') current = current.object;
        return current.type === 'Identifier' ? taintOf(current.name)?.kind ?? null : null;
      }
      case 'AwaitExpression': case 'TSAsExpression': case 'TSNonNullExpression': return recur(node.argument ?? node.expression);
      case 'TemplateLiteral': return node.expressions.map((expression) => recur(expression)).find(Boolean) ?? null;
      case 'BinaryExpression': return node.operator === '+' ? recur(node.left) ?? recur(node.right) : null;
      case 'LogicalExpression': return recur(node.left) ?? recur(node.right);
      case 'ConditionalExpression': return recur(node.consequent) ?? recur(node.alternate);
      case 'CallExpression': {
        const callee = slice(node.callee, 60);
        if (callee === 'JSON.parse') return recur(node.arguments[0]);
        if (SANITIZERS[rule].test(callee)) return null;
        // Coercion and path helpers pass a request value through unchanged as far as traversal is concerned.
        if (/^(?:String|Number|decodeURIComponent|decodeURI)$|^path\.(?:normalize|join|resolve)$/.test(callee)) return node.arguments.map((argument) => recur(argument)).find(Boolean) ?? null;
        if (/\.(?:trim|toLowerCase|toUpperCase|slice|substring|concat)$/.test(callee) && node.callee.type === 'MemberExpression') return recur(node.callee.object);
        return null;
      }
      default: return null;
    }
  };

  /**
   * True for a value that carries a whole request body into a write: `req.body`, an alias of it, `{ ...req.body }`,
   * `{ $set: req.body }`. With `nested`, `req.body.changes` counts too (for `Object.assign(doc, req.body.changes)`).
   * Single fields (destructured values, `req.body.name`) are not whole.
   */
  const wholeBody = (node, nested = false) => {
    if (!node) return false;
    if (node.type === 'ObjectExpression') {
      return node.properties.some((prop) => (prop.type === 'SpreadElement' && wholeBody(prop.argument, nested))
        || (prop.type === 'ObjectProperty' && ['$set', '$setOnInsert'].includes(prop.key.name ?? prop.key.value) && wholeBody(prop.value, nested)));
    }
    if (node.type === 'Identifier') {
      const entry = taintOf(node.name);
      return Boolean(entry?.whole && entry.kind === 'body');
    }
    const chain = requestChain(node);
    return Boolean(chain && chain.kind === 'body' && (nested || chain.depth === 0));
  };

  const taintedOperand = (object) => object.properties.some((prop) => {
    if (prop.type !== 'ObjectProperty') return false;
    const kind = taintKind(prop.value, 'nosql');
    if (kind === 'body' || kind === 'query') return true;
    return prop.value.type === 'ObjectExpression' && taintedOperand(prop.value);
  });

  const bind = (target, value) => {
    const frame = frames.at(-1);
    if (target.type === 'Identifier') {
      const kind = wholeBody(value, true) ? 'body' : taintKind(value);
      frame.taint.set(target.name, kind ? { kind, whole: wholeBody(value, true) } : null);
      const aliased = value?.type === 'MemberExpression' && RESPONSE_ROOT.test(rootName(value) ?? '') && chainDepth(value) >= 2 && !hasOptional(value);
      frame.aliases.set(target.name, aliased ? true : null);
      frame.safe.set(target.name, sanitisedFor(value));
    } else if (target.type === 'ObjectPattern' || target.type === 'ArrayPattern') {
      const kind = taintKind(value);
      if (!kind) return;
      const visit = (pattern) => {
        if (pattern.type === 'Identifier') frame.taint.set(pattern.name, { kind, whole: false });
        else if (pattern.type === 'ObjectPattern') pattern.properties.forEach((prop) => visit(prop.value ?? prop.argument));
        else if (pattern.type === 'ArrayPattern') pattern.elements.filter(Boolean).forEach(visit);
        else if (pattern.type === 'AssignmentPattern') visit(pattern.left);
        else if (pattern.type === 'RestElement') visit(pattern.argument);
      };
      visit(target);
    }
  };

  /** Sinks a value is already sanitised for: `escapeRegex(q)` or `String(q).replace(/[...]/g, '\$&')` is safe in a regex. */
  const sanitisedFor = (value) => {
    if (value?.type !== 'CallExpression') return null;
    const callee = slice(value.callee, 80);
    const escapesRegex = SANITIZERS.regex.test(callee)
      || (propertyName(value.callee) === 'replace' && value.arguments[0]?.type === 'RegExpLiteral' && value.arguments[1]?.type === 'StringLiteral' && value.arguments[1].value.includes('$&'));
    return escapesRegex ? new Set(['regex']) : null;
  };
  const regexSafe = (node) => (node.type === 'Identifier' && safeFor(node.name)?.has('regex')) || SANITIZERS.regex.test(slice(node, 80));

  /** The redirect target was checked with `startsWith('/')` earlier in the same function. */
  const checkedSameSite = (node) => {
    const start = frames.at(-1).node.start;
    const before = text.slice(start, node.start);
    const target = slice(node, 80);
    // The standard pair is needed: `startsWith('/')` alone accepts `//evil.example`.
    const has = (prefix) => ["'", '"', '`'].some((quote) => before.includes(`${target}.startsWith(${quote}${prefix}${quote})`));
    return has('/') && has('//');
  };

  /** A redirect target with a fixed single-slash prefix stays on this site (`'/users/' + id`); `//host` does not. */
  const sameSiteTarget = (node) => {
    const prefix = node.type === 'BinaryExpression' && node.left.type === 'StringLiteral' ? node.left.value
      : (node.type === 'TemplateLiteral' ? node.quasis[0].value.cooked : '');
    return prefix.startsWith('/') && !prefix.startsWith('//');
  };

  const enclosingStatement = () => [...ancestors].reverse().find((n) => /(?:Statement|Declaration)$/.test(n.type) && n.type !== 'BlockStatement') ?? ast.program;
  const firstInStatement = (category) => {
    const key = `${category}:${enclosingStatement().start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };

  /** An optional chain that already sits inside a fallback or a guard is the fix, not the problem. */
  const alreadyGuarded = () => {
    for (let i = ancestors.length - 2; i >= 0; i -= 1) {
      const ancestor = ancestors[i];
      const child = ancestors[i + 1];
      if (/(?:Statement|Declaration)$/.test(ancestor.type) && ancestor.type !== 'ExpressionStatement') return ancestor.type === 'IfStatement' && ancestor.test === child;
      if (ancestor.type === 'LogicalExpression' && ancestor.left === child) return true;
      if (ancestor.type === 'ConditionalExpression' && ancestor.test === child) return true;
      if (ancestor.type === 'UnaryExpression' && ancestor.operator === '!') return true;
      if (ancestor.type === 'CallExpression' && ['Array.isArray', 'Boolean'].includes(slice(ancestor.callee, 40))) return true;
    }
    return false;
  };

  /** A network call is handled inside try/catch, a known async wrapper, or a promise chain that ends in `.catch`. */
  const networkHandled = () => inTryOrWrapper() || ancestors.slice(0, -1).some((n) => n.type === 'CallExpression' && propertyName(n.callee) === 'catch');

  /**
   * Handled where it matters: inside the `try` block (not its `catch`/`finally`), or inside a function handed to an async
   * wrapper. The walk stops at the first function boundary, so a callback created inside a `try` is not covered by it.
   */
  const inTryOrWrapper = () => {
    for (let i = ancestors.length - 2; i >= 0; i -= 1) {
      const ancestor = ancestors[i];
      if (ancestor.type === 'TryStatement' && ancestor.block === ancestors[i + 1]) return true;
      if (FUNCTION_TYPES.has(ancestor.type)) {
        const parent = ancestors[i - 1];
        return parent?.type === 'CallExpression' && ASYNC_WRAPPERS.test(parent.callee.name ?? propertyName(parent.callee) ?? '');
      }
    }
    return false;
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
    const others = comparisons.filter((c) => !nullChecks.includes(c));
    // `role === "ADMIN"`-style enum checks are the weakest boundary candidates.
    const enumOnly = others.length > 0 && others.every((c) => EQUALITY.has(c.operator) && (c.left.type === 'StringLiteral' || c.right.type === 'StringLiteral'));
    if (others.length) emit(node.test, 'boundary', { branch: true, risk: enumOnly ? 2 : undefined, confidence: enumOnly ? 'low' : undefined });
    if (nullChecks.length) emit(node.test, 'nullish', { branch: true });
  };

  const onCall = (node) => {
    const { callee } = node;
    const property = propertyName(callee);
    const calleeText = callee.type === 'MemberExpression' ? slice(callee, 80) : (callee.type === 'Identifier' ? callee.name : '');
    const [first] = node.arguments;
    const fn = frames.at(-1);

    if (mentionsZod && SCHEMA_CALLS.has(property)) emit(node, 'schema');
    if (mentionsZod && calleeText === 'z.object' && !ancestors.slice(0, -1).some((n) => n.type === 'CallExpression' && rootName(n.callee.object ?? n.callee) === 'z')) emit(node, 'schema');

    if ((calleeText === 'Object.assign' || WRITE_METHODS.has(property)) && node.arguments.some((arg) => wholeBody(arg, calleeText === 'Object.assign'))) emit(node, 'risk', { rule: 'mass-assignment' });
    if (/^(?:jwt|jsonwebtoken)\.verify$|^(?:bcrypt|bcryptjs)\.(?:compare|hash)$/.test(calleeText) && !inTryOrWrapper()) emit(node, 'risk', { rule: 'unguarded-call' });

    const objectNode = callee.type === 'MemberExpression' ? callee.object : null;
    if (ARRAY_METHODS.has(property) && objectNode) {
      const direct = objectNode.type === 'MemberExpression' && !callee.computed && !hasOptional(callee) && objectNode.object.type !== 'ThisExpression' && RESPONSE_ROOT.test(rootName(objectNode) ?? '');
      const aliased = objectNode.type === 'Identifier' && aliasOf(objectNode.name);
      if (direct || aliased) emit(node, 'risk', { rule: 'unguarded-member-call' });
    }

    if ((ROUTE_METHODS.has(property) || property === 'use') && /^(?:router|app|r|route)$/i.test(callee.object?.name ?? '')) {
      const handler = node.arguments.at(-1);
      if (handler && FUNCTION_TYPES.has(handler.type) && handler.async && !someShallow(handler.body, (n) => n.type === 'TryStatement')) {
        emit(handler, 'risk', { rule: 'unhandled-async-route', evidence: slice({ start: node.start, end: handler.body.start ?? node.end }, 120) });
      }
    }
    if (['create', 'save', 'insertOne'].includes(property) && fn.node !== ast.program && !text.slice(fn.node.start, fn.node.end).includes('11000')
      && someShallow(fn.node.body, (n) => n.type === 'CallExpression' && LOOKUP_METHODS.has(propertyName(n.callee)))) {
      emit(node, 'risk', { rule: 'check-then-act' });
    }

    if (NETWORK_CALL.test(calleeText) && !networkHandled(node)) {
      const options = node.arguments.find((arg) => arg.type === 'ObjectExpression');
      const hasLimit = options?.properties.some((prop) => ['signal', 'timeout'].includes(prop.key?.name));
      emit(node, 'risk', { rule: 'unguarded-network-call', suggestion: `${RULES['unguarded-network-call']}${hasLimit ? '' : '; set a timeout or signal'}` });
    }
    if (SECRET_ARG_CALLS.test(calleeText)) {
      const keyArg = node.arguments[1];
      if (keyArg?.type === 'StringLiteral' && keyArg.value.length >= 8 && !/\s/.test(keyArg.value)) emit(node, 'risk', { rule: 'hard-coded-secret', evidence: `${calleeText}(…, "…")` });
    }
    if (QUERY_METHODS.has(property) && first?.type === 'ObjectExpression' && taintedOperand(first)) emit(node, 'risk', { rule: 'nosql-injection' });
    if (FS_PATH_SINKS.test(calleeText) && node.arguments.some((arg) => taintKind(arg, 'path'))) emit(node, 'risk', { rule: 'path-traversal' });
    if (/^(?:res|response)\.redirect$/.test(calleeText) && node.arguments.some((arg) => taintKind(arg) && !sameSiteTarget(arg) && !checkedSameSite(arg))) emit(node, 'risk', { rule: 'open-redirect' });
    if ((calleeText === 'eval' || calleeText === 'vm.runInNewContext' || calleeText === 'vm.runInThisContext') && first && first.type !== 'StringLiteral') emit(node, 'risk', { rule: 'eval-input' });
    if (calleeText === 'JSON.parse' && taintKind(first) && !inTryOrWrapper()) emit(node, 'risk', { rule: 'unparsed-json' });
    if (['match', 'search'].includes(property) && first && taintKind(first, 'regex') && first.type !== 'RegExpLiteral') emit(node, 'risk', { rule: 'regex-injection' });
  };

  const onNew = (node) => {
    const name = node.callee.name;
    const [first] = node.arguments;
    if (name === 'RegExp' && first && first.type !== 'StringLiteral' && !regexSafe(first)) emit(node, 'risk', { rule: 'regex-injection' });
    if (name === 'Function' && first && first.type !== 'StringLiteral') emit(node, 'risk', { rule: 'eval-input' });
    if (name === 'URL' && first && taintKind(first) && !sameSiteTarget(first)) emit(node, 'risk', { rule: 'open-redirect' });
    if (/^[A-Z]/.test(name ?? '') && node.arguments.some((arg) => wholeBody(arg))) emit(node, 'risk', { rule: 'mass-assignment' });
  };

  const numericLooking = (node) => {
    if (node.type === 'CallExpression') return NUMERIC_CALL.test(slice(node.callee, 40));
    if (node.type === 'MemberExpression') return propertyName(node) === 'length' || NUMERIC_NAME.test(propertyName(node) ?? '');
    return node.type === 'Identifier' && NUMERIC_NAME.test(node.name);
  };

  const onFallback = (node) => {
    const { left, right } = node;
    if (left.type === 'LogicalExpression' || (left.type === 'MemberExpression' && isProcessEnv(left.object))) return;
    const numericDefault = (right.type === 'NumericLiteral' && right.value !== 0) || (right.type === 'Identifier' && /^[A-Z][A-Z0-9_]*$/.test(right.name) && numericLooking(left));
    const numericChain = left.type === 'MemberExpression' && right.type === 'MemberExpression' && (NUMERIC_NAME.test(propertyName(left) ?? '') || NUMERIC_NAME.test(propertyName(right) ?? ''));
    if ((numericDefault || numericChain) && firstInStatement('falsy-fallback')) emit(node, 'risk', { rule: 'falsy-fallback' });
  };

  const onSecret = (name, value, node) => {
    if (!name || value?.type !== 'StringLiteral' || value.value.length < 8 || /\s/.test(value.value)) return;
    if (!SECRET_NAME.test(name) || value.value.toLowerCase() === name.toLowerCase() || /^(?:your|change|xxx|<|\$\{|\*+$)/i.test(value.value)) return;
    // Route paths and i18n/page keys ('/reset-password', 'forgot-password-page') are not secrets.
    if (value.value.startsWith('/') || /^[a-z]+(?:-[a-z]+)+$/.test(value.value)) return;
    emit(node, 'risk', { rule: 'hard-coded-secret', evidence: `${name} = "…"` });
  };

  // `ctx.save()` is not a database write: require a Model-like receiver (`User.create`) or a module that uses an ORM/ODM.
  const mentionsOrm = ORM_MENTION.test(text);
  const looksLikeOrmCall = (callee) => mentionsOrm || /^[A-Z]/.test(rootName(callee.object) ?? '');

  /** `const user = User.findById(id); return user.name;` in an async function: the field is read off a promise. */
  const isUnawaitedQueryRead = (declarator) => {
    const frame = frames.at(-1);
    const { init, id } = declarator;
    if (!frame.node.async || id.type !== 'Identifier' || init?.type !== 'CallExpression' || init.callee.type !== 'MemberExpression') return false;
    if (!QUERY_RETURNING.has(propertyName(init.callee)) || init.callee.object.type === 'CallExpression' || !looksLikeOrmCall(init.callee)) return false;
    if (FUNCTION_TYPES.has(init.arguments[0]?.type)) return false; // Array.prototype.find(predicate)
    const name = id.name;
    const awaited = someShallow(frame.node.body, (n) => n.type === 'AwaitExpression' && n.argument.type === 'Identifier' && n.argument.name === name);
    const readsField = someShallow(frame.node.body, (n) => n.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === name && !QUERY_BUILDER.has(propertyName(n)));
    return !awaited && readsField;
  };

  /** `res.data.items[0].plan`: the outermost non-optional read with an index or four levels on a response-like value. */
  const isDeepResponseRead = (node) => {
    const parent = ancestors.at(-2);
    if ((parent?.type === 'MemberExpression' && parent.object === node) || (parent?.type === 'AssignmentExpression' && parent.left === node)) return false;
    if (hasOptional(node) || parent?.type === 'UnaryExpression') return false;
    let depth = 0;
    let indexed = false;
    let current = node;
    while (current.type === 'MemberExpression') {
      depth += 1;
      if (current.computed && current.property.type === 'NumericLiteral') indexed = true;
      current = current.object;
    }
    return current.type === 'Identifier' && /^(?:res|resp|response|r|result|payload|json)$/i.test(current.name) && ((indexed ? depth >= 3 : depth >= 4));
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
    if ((node.type === 'OptionalMemberExpression' || node.type === 'OptionalCallExpression') && !alreadyGuarded() && firstInStatement('nullish')) emit(enclosingStatement(), 'nullish');
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') onCall(node);
    if (node.type === 'NewExpression') onNew(node);

    if (node.type === 'ObjectProperty' && (node.key.name === '$regex' || node.key.value === '$regex')
      && !['StringLiteral', 'RegExpLiteral'].includes(node.value.type) && !regexSafe(node.value)) {
      emit(node, 'risk', { rule: 'regex-injection' });
    }
    if (node.type === 'VariableDeclarator') {
      bind(node.id, node.init);
      if (isUnawaitedQueryRead(node)) emit(node.init, 'risk', { rule: 'missing-await' });
      if (node.id.type === 'Identifier') onSecret(node.id.name, node.init, node);
    }
    if (node.type === 'ObjectProperty' && !node.computed) onSecret(node.key.name ?? node.key.value, node.value, node);
    if (node.type === 'AssignmentExpression' && node.operator === '=') {
      bind(node.left, node.right);
      if (node.left.type === 'MemberExpression' && PRIVILEGED_FIELD.test(propertyName(node.left) ?? '') && taintKind(node.right) === 'body') emit(node, 'risk', { rule: 'mass-assignment' });
      if (node.left.type === 'MemberExpression') onSecret(propertyName(node.left), node.right, node);
    }
    if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' && frames.at(-1).node.async
      && node.expression.callee.type === 'MemberExpression' && PROMISE_METHODS.has(propertyName(node.expression.callee)) && looksLikeOrmCall(node.expression.callee)) {
      emit(node.expression, 'risk', { rule: 'missing-await' });
    }
    if (node.type === 'LogicalExpression' && node.operator === '||') onFallback(node);
    if (node.type === 'MemberExpression' && isDeepResponseRead(node)) emit(node, 'risk', { rule: 'deep-response-chain' });
  };

  const traverse = (node, parent) => {
    ancestors.push(node);
    const isFunction = FUNCTION_TYPES.has(node.type);
    if (isFunction) {
      const frame = { name: functionName(node, parent, frames.at(-1).name), node, taint: new Map(), aliases: new Map(), safe: new Map() };
      // Parameters shadow outer tainted names: `[1].forEach((id) => fs.readFile(id))` is not the request `id`.
      for (const name of patternNames(node.params)) {
        frame.taint.set(name, null);
        frame.aliases.set(name, null);
      }
      frames.push(frame);
    }
    if (isFunction) onFunction(node);
    onVisit(node);
    for (const child of childNodes(node)) traverse(child, node);
    if (isFunction) frames.pop();
    ancestors.pop();
  };
  traverse(ast.program, null);
  return { findings, parsed: true, suppressed };
}

/** Scan files below `root`. Findings are ranked by risk, then location. */
export function scan(root = '.', options = {}) {
  const absolute = path.resolve(root);
  const scanRoot = fs.statSync(absolute).isFile() ? path.dirname(absolute) : absolute;
  const findings = [];
  const skipped = [];
  const restored = [];
  let suppressed = 0;
  for (const file of discoverFiles(absolute, options)) {
    const relative = path.relative(process.cwd(), file).replaceAll('\\', '/');
    if (restoreIfInterrupted(file)) restored.push(relative);
    const idFile = path.relative(scanRoot, file).replaceAll('\\', '/');
    const result = scanSource(fs.readFileSync(file, 'utf8'), relative, { idFile });
    if (!result.parsed) skipped.push(relative);
    suppressed += result.suppressed;
    findings.push(...result.findings);
  }
  const unique = [...new Map(findings.map((item) => [item.id, item])).values()];
  unique.sort((a, b) => b.risk - a.risk || a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return { version: 1, root: absolute, findings: unique, skipped, restored, suppressed };
}
