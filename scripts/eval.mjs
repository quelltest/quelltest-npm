import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scan } from '../src/index.js';

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = evaluate();
  console.log(JSON.stringify(result, null, 2));
  const minimum = Number(process.argv[2] ?? 0.5);
  if (result.recall < minimum || result.noise.length) process.exitCode = 1;
}
