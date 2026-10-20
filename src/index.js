import path from 'node:path';
import { generate, generateWithLlm } from './generator.js';
import { verifyGenerated } from './verification.js';
import { scan } from './scan.js';
import { score } from './score.js';
import { attachCoverage, detectCoverage, loadCoverage } from './coverage.js';
import { changedLines, filterToDiff } from './diff.js';
import { toSarif } from './sarif.js';
import { gate, gateSarif } from './gate.js';
import { renderHandoff } from './handoff.js';

/**
 * Scan `root` and score it. Coverage evidence comes from `options.coverage` (a file path), or is
 * auto-detected under `./coverage`; pass `coverage: false` to disable. `options.diff` limits the
 * report to lines changed since the merge-base with a git ref.
 */
export function report(root = '.', options = {}) {
  const result = scan(root, options);
  const file = options.coverage === false ? null : (options.coverage || detectCoverage());
  let evidence = { kind: 'none' };
  if (file) {
    const coverage = loadCoverage(file);
    result.findings = attachCoverage(result.findings, coverage);
    evidence = { kind: coverage.kind, source: path.relative(process.cwd(), file).replaceAll('\\', '/') };
  }
  if (options.diff) result.findings = filterToDiff(result.findings, changedLines(options.diff));
  result.summary = score(result, evidence);
  return result;
}

export { scan, score, generate, generateWithLlm, verifyGenerated, toSarif, gate, gateSarif, renderHandoff };
