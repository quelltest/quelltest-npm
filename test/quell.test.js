import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { report, score } from '../src/index.js';
import { parseIstanbul, parseLcov, attachCoverage } from '../src/coverage.js';
import { parseDiff, filterToDiff } from '../src/diff.js';

test('finds deterministic edge-case evidence without executing source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-'));
  fs.writeFileSync(path.join(dir, 'payment.ts'), 'export function pay(amount: number) { if (amount <= 0) throw new Error("positive"); return amount; }\n');
  const first = report(dir, { coverage: false });
  const second = report(dir, { coverage: false });
  assert.ok(first.findings.some((item) => item.category === 'throws'));
  assert.ok(first.findings.some((item) => item.category === 'boundary'));
  assert.deepEqual(first.findings, second.findings);
});

test('score is a function of coverage evidence only and never of generated output', () => {
  assert.equal(score({ findings: [] }).score, null);
  assert.equal(score({ findings: [] }).tier, 'no-findings');
  const findings = [{ covered: true }, { covered: false, status: 'WRITTEN', verified: true }];
  assert.equal(score({ findings }).score, null);
  assert.equal(score({ findings }).tier, 'not-scored');
  assert.equal(score({ findings }, { kind: 'istanbul', source: 'x' }).score, 50);
  assert.equal(score({ findings: [{ covered: true }] }, { kind: 'lcov' }).tier, 'production-ready');
  assert.equal(score({ findings: [{ covered: false }] }, { kind: 'lcov' }).score, 0);
});

test('a hand-written suite with coverage scores above zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quelltest-cov-'));
  const file = path.join(dir, 'a.js');
  fs.writeFileSync(file, 'function f(x) {\n  if (x < 0) throw new Error("neg");\n  return x;\n}\n');
  const lcov = path.join(dir, 'lcov.info');
  fs.writeFileSync(lcov, `SF:${file}\nDA:1,1\nDA:2,4\nDA:3,2\nBRDA:2,0,0,1\nBRDA:2,0,1,3\nend_of_record\n`);
  const result = report(dir, { coverage: lcov });
  assert.ok(result.summary.score > 0);
  assert.equal(result.summary.coverageEvidence, 'lcov');
});

test('istanbul: branch findings need every side taken; unknown files are uncovered', () => {
  const finding = { file: 'a.js', line: 2, column: 7, endLine: 2, endColumn: 12, branch: true };
  const make = (counts) => parseIstanbul(JSON.stringify({
    [path.resolve('a.js')]: {
      statementMap: { 0: { start: { line: 2, column: 2 }, end: { line: 2, column: 40 } } },
      s: { 0: 5 },
      branchMap: { 0: { type: 'if', loc: { start: { line: 2, column: 2 }, end: { line: 2, column: 40 } } } },
      b: { 0: counts },
    },
  }));
  assert.equal(attachCoverage([finding], make([2, 3]))[0].covered, true);
  assert.equal(attachCoverage([finding], make([2, 0]))[0].covered, false);
  assert.equal(attachCoverage([{ ...finding, file: 'other.js' }], make([2, 3]))[0].covered, false);
  assert.equal(parseLcov('SF:/x.js\nDA:1,0\nBRDA:1,0,0,-\nend_of_record\n').files.size, 1);
});

test('parseDiff and filterToDiff map changed ranges to findings', () => {
  const ranges = parseDiff('+++ b/src/a.js\n@@ -1,0 +2,3 @@\n+x\n@@ -9 +20 @@\n+y\n@@ -5,2 +0,0 @@\n', '/repo');
  assert.deepEqual(ranges.get(path.resolve('/repo', 'src/a.js')), [[2, 4], [20, 20]]);
  const findings = [{ file: 'src/a.js', line: 3, endLine: 3 }, { file: 'src/a.js', line: 10, endLine: 10 }];
  assert.equal(filterToDiff(findings, ranges, '/repo').length, 1);
});
