import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generate, report } from '../src/index.js';
import { describeModule, exportOf } from '../src/unit.js';

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-v031-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return { dir, src: path.join(dir, 'src'), out: path.join(dir, 'out') };
}

const FN = 'function guard(n) {\n  if (n < 5) throw new Error("small");\n  return n;\n}\n';

test('every CommonJS export style is recognised (module.exports.x, exports.x, bracket form, Object.assign)', () => {
  const styles = {
    'module.exports.x': `${FN}module.exports.guard = guard;\n`,
    'exports.x': `${FN}exports.guard = guard;\n`,
    'module.exports["x"]': `${FN}module.exports["guard"] = guard;\n`,
    'Object.assign(module.exports)': `${FN}Object.assign(module.exports, { guard });\n`,
    'module.exports = { x }': `${FN}module.exports = { guard };\n`,
    'inline function': 'module.exports.guard = function guard(n) { if (n < 5) throw new Error("small"); return n; };\n',
  };
  for (const [name, source] of Object.entries(styles)) {
    const module = describeModule(source, 'a.js');
    assert.equal(module.style, 'cjs', name);
    assert.deepEqual(exportOf(module, 'guard'), { kind: 'named', name: 'guard' }, name);
  }
});

test('a function exported with module.exports.name gets a verified test', () => {
  const p = project({ 'src/g.js': `${FN}module.exports.guard = guard;\n` });
  const results = generate(report(p.src, { coverage: false }), { destination: p.out, runner: 'node', write: true, verify: true });
  assert.ok(results.some((item) => item.status === 'VERIFIED'), JSON.stringify(results.map((item) => item.reason)));
});

const ROUTE = [
  'const router = require("express").Router();',
  '__HANDLER__',
  'module.exports = router;',
  '',
].join('\n');
const BODY = '(async (req, res) => {\n  const { name, qty } = req.body;\n  if (!name) return res.status(422).json({ error: "name" });\n  if (qty < 1) return res.status(400).json({ error: "qty" });\n  res.json({ ok: true });\n})';

function requestsFor(handler) {
  const p = project({ 'src/routes.js': ROUTE.replace('__HANDLER__', handler) });
  const results = generate(report(p.src, { coverage: false }), { destination: p.out, runner: 'node' });
  // Each finding in a handler repeats the handler's list; compare the distinct lines.
  return [...new Set(results.flatMap((item) => item.requests ?? []))].join('\n');
}

test('route request cases are identical with and without handler wrappers', () => {
  const direct = requestsFor(`router.post("/items", ${BODY});`);
  assert.match(direct, /POST \/items with body without `name` -> expect 422/);
  assert.match(direct, /body\.qty = 0 -> expect 400/);
  for (const wrapper of ['asyncHandler', 'catchAsync', 'wrap']) {
    assert.equal(requestsFor(`router.post("/items", ${wrapper}(${BODY}));`), direct, wrapper);
  }
  assert.equal(requestsFor(`router.post("/items", auth, validate(schema), asyncHandler(${BODY}));`), direct, 'middleware chain');
  assert.equal(requestsFor(`router.post("/items", validate(schema)(${BODY}));`), direct, 'curried wrapper');
});
