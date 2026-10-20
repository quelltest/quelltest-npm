import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyGenerated, renderHandoff } from '../src/index.js';
import { mockedBindings, mockBoundaryOf } from '../src/mocks.js';

const SOURCE = [
  "import { User } from './model.mjs';",
  "import { log } from './logger.mjs';",
  'export async function find(email) {',
  "  if (typeof email !== 'string') throw new TypeError('email');",
  '  const u = await User.findOne({ email });',
  '  log(email);',
  '  return u;',
  '}',
  '',
].join('\n');

const TEST = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { find } from './unit.mjs';",
  '// Static markers a real jest suite would have; never executed here.',
  "function setupMocks() { jest.mock('./model.mjs'); }",
  "test('find', async () => {",
  "  await assert.rejects(() => find(1), TypeError);",
  "  assert.deepEqual(await find('a'), { id: 1 });",
  '});',
  '',
].join('\n');

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-mockb-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'model.mjs'), 'export const User = { findOne: async () => ({ id: 1 }) };\n');
  fs.writeFileSync(path.join(dir, 'logger.mjs'), 'export const log = () => {};\n');
  fs.writeFileSync(path.join(dir, 'unit.mjs'), SOURCE);
  fs.writeFileSync(path.join(dir, 'unit.check.test.mjs'), TEST);
  return { sourceFile: path.join(dir, 'unit.mjs'), testPath: path.join(dir, 'unit.check.test.mjs') };
}

test('mockedBindings finds modules replaced by jest.mock/vi.mock and objects replaced by spies and stubs', () => {
  const names = mockedBindings({ testText: TEST, testFile: '/p/unit.test.mjs', sourceText: SOURCE, sourceFile: '/p/unit.mjs' });
  assert.deepEqual([...names], ['User']);
  const cjs = "const { Order } = require('../models/order');\nconst db = require('./db');\n";
  const spied = "vi.mock('../models/order.js');\nsinon.stub(db, 'query');\n";
  assert.deepEqual([...mockedBindings({ testText: spied, testFile: '/p/tests/a.test.js', sourceText: cjs, sourceFile: '/p/src/a.js' })].sort(), ['Order', 'db']);
  assert.equal(mockedBindings({ testText: 'test("x", () => {});', testFile: 'a.test.js', sourceText: cjs, sourceFile: 'a.js' }).size, 0);
});

test('mockBoundaryOf matches whole words only', () => {
  assert.equal(mockBoundaryOf('const u = await User.findOne({ email });', new Set(['User'])), 'User');
  assert.equal(mockBoundaryOf('const u = await Users.list();', new Set(['User'])), null);
  assert.equal(mockBoundaryOf('const $db = 1; $db.x();', new Set(['$db'])), '$db');
});

test('survivors on mocked code are labelled and explained in the handoff', () => {
  const { sourceFile, testPath } = project();
  const result = verifyGenerated(null, { sourceFile, testPath });
  assert.deepEqual(result.mocked, ['User']);
  const survivor = result.mutants.find((mutant) => mutant.outcome === 'survived' && mutant.kind === 'await');
  assert.ok(survivor, JSON.stringify(result.mutants.map((m) => [m.description, m.outcome])));
  assert.equal(survivor.mockBoundary, 'User');
  assert.ok(result.survivorsOnMockedCode >= 1);
  const markdown = renderHandoff(result, { sourceText: SOURCE });
  assert.match(markdown, /On mocked code: \d+ of \d+ survivors touch `User`/);
  assert.match(markdown, /\*\*Mock boundary:\*\* this test mocks `User`/);
  for (const mutant of result.mutants.filter((item) => item.outcome === 'survived' && !/User/.test(item.before))) assert.equal(mutant.mockBoundary, null);
});
