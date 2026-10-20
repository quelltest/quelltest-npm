import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scan, verifyGenerated } from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'eval');

/**
 * Measure recall on known defects and false positives on guarded ("clean") code.
 * Recall: a finding with the expected rule/category on the defect's line (±1).
 * Noise: any `risk` rule finding on the clean fixtures, which are written to be safe.
 */
export function evaluate() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'defects.json'), 'utf8'));
  const rows = manifest.defects.map((defect) => {
    if (!defect.file) return { ...defect, detected: false, knownMiss: true };
    const file = path.join(root, defect.file);
    const found = scan(file, { includeTests: true }).findings;
    const hit = found.some((item) => (item.rule ?? item.category) === defect.expect && Math.abs(item.line - defect.line) <= 1);
    return { ...defect, detected: hit, knownMiss: false };
  });
  const detectable = rows.filter((row) => !row.knownMiss);
  const detected = rows.filter((row) => row.detected).length;
  const cleanFindings = scan(path.join(root, 'clean'), { includeTests: true }).findings;
  const noise = cleanFindings.filter((item) => item.category === 'risk');
  return {
    total: rows.length,
    detected,
    recall: detected / rows.length,
    detectableRecall: detectable.length ? detected / detectable.length : 0,
    missedDetectable: detectable.filter((row) => !row.detected).map((row) => row.id),
    knownMisses: rows.filter((row) => row.knownMiss).map((row) => row.id),
    cleanFiles: fs.readdirSync(path.join(root, 'clean')).length,
    noise: noise.map((item) => `${item.file}:${item.line} ${item.rule ?? item.category}`),
  };
}

/**
 * Measure the verifier itself: for each case in eval/gate, the `strong` test must be accepted and every `weak-*` test
 * (tautology, literal-only, no assertion, wrong target, happy-path only) must be rejected at a 60% mutation-score floor.
 */
export function evaluateGate({ minScore = 60 } = {}) {
  const dir = path.join(root, 'gate');
  const rows = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const caseDir = path.join(dir, name);
    for (const file of fs.readdirSync(caseDir).filter((entry) => entry.endsWith('.check.mjs')).sort()) {
      const expected = file.startsWith('strong') ? 'accept' : 'reject';
      const result = verifyGenerated(null, { sourceFile: path.join(caseDir, 'unit.mjs'), testPath: path.join(caseDir, file), minScore });
      rows.push({ case: name, test: file.replace('.check.mjs', ''), expected, verified: result.verified, score: result.mutationScore, reason: result.reason, correct: result.verified === (expected === 'accept') });
    }
  }
  const strong = rows.filter((row) => row.expected === 'accept');
  const weak = rows.filter((row) => row.expected === 'reject');
  return {
    minScore,
    strong: strong.length, strongAccepted: strong.filter((row) => row.verified).length,
    weak: weak.length, weakRejected: weak.filter((row) => !row.verified).length,
    accuracy: rows.filter((row) => row.correct).length / rows.length,
    wrong: rows.filter((row) => !row.correct).map((row) => `${row.case}/${row.test} (${row.verified ? 'accepted' : 'rejected'}, score ${row.score}): ${row.reason ?? ''}`),
    rows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = evaluate();
  const gate = evaluateGate();
  console.log(JSON.stringify({ ...result, gate: { ...gate, rows: undefined } }, null, 2));
  const minimum = Number(process.argv[2] ?? 0.5);
  if (result.recall < minimum || result.noise.length || gate.wrong.length) process.exitCode = 1;
}
