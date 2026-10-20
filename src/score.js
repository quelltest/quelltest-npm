const TIERS = [
  [80, 'production-ready'],
  [60, 'review-needed'],
  [0, 'edge-cases-uncovered'],
];

/**
 * Production readiness score: the share of edge-case candidates that real tests execute.
 * It is a function of the codebase and its coverage evidence, never of quelltest's own output.
 * Returns `score: null` (not scored) when there is no evidence or nothing to score.
 */
export function score(report, evidence = { kind: 'none' }) {
  const findings = report.findings ?? [];
  const total = findings.length;
  const base = { total, coverageEvidence: evidence.kind, evidenceFile: evidence.source ?? null };
  if (total === 0) return { ...base, score: null, tier: 'no-findings', covered: 0, uncovered: 0 };
  if (evidence.kind === 'none') return { ...base, score: null, tier: 'not-scored', covered: null, uncovered: null };
  const covered = findings.filter((item) => item.covered).length;
  const value = Math.round((covered / total) * 100);
  return { ...base, score: value, tier: TIERS.find(([min]) => value >= min)[1], covered, uncovered: total - covered };
}
