import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyGenerated } from '../src/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-smoke-'));
const sourceFile = path.join(dir, 'unit.mjs');
const testPath = path.join(dir, 'unit.check.test.mjs');
const source = 'export function positive(n) {\n  if (n <= 0) throw new RangeError("positive");\n  return n;\n}\n';
fs.writeFileSync(sourceFile, source);
const header = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { positive } from './unit.mjs';\n";

try {
  const real = verifyGenerated(`${header}test('positive', () => {\n  assert.equal(positive(1), 1);\n  assert.throws(() => positive(0), RangeError);\n});\n`, { sourceFile, testPath });
  assert.equal(real.verified, true, JSON.stringify(real));
  const placeholder = verifyGenerated(`${header}test('placeholder', () => {\n  assert.ok(true);\n});\n`, { sourceFile, testPath });
  assert.equal(placeholder.verified, false, JSON.stringify(placeholder));
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), source, 'source must be restored');
  console.log('verified: real test kills mutants; placeholder is rejected');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
