import { generate } from './generator.js';
import { verifyGenerated } from './verification.js';
import { scan } from './scan.js';

export function score(report) {
  const total = report.findings.length;
  const covered = report.findings.filter((item) => item.status === 'WRITTEN').length;
  const verified = report.findings.filter((item) => item.verified).length;
  const value = total === 0 ? 100 : Math.round(((covered + verified * 0.5) / total) * 100);
  return { score: Math.min(100, value), tier: value >= 80 ? 'production-ready' : value >= 60 ? 'review-needed' : 'edge-cases-uncovered', total, covered, verified };
}

export function report(root = '.', options = {}) {
  const result = scan(root, options);
  result.summary = score(result);
  return result;
}

export { scan, generate };
export { verifyGenerated };
