import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { report, score } from '../src/index.js';

test('finds deterministic edge-case evidence without executing source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-'));
  fs.writeFileSync(path.join(dir, 'payment.ts'), 'export function pay(amount: number) { if (amount <= 0) throw new Error("positive"); return amount; }\n');
  const first = report(dir);
  const second = report(dir);
  assert.ok(first.findings.some((item) => item.category === 'throws'));
  assert.ok(first.findings.some((item) => item.category === 'boundary'));
  assert.deepEqual(first.findings, second.findings);
});

test('scores an empty project as safe and preserves score bounds', () => {
  assert.equal(score({ findings: [] }).score, 100);
  assert.equal(score({ findings: [{ status: 'WRITTEN', verified: true }] }).score, 100);
});
