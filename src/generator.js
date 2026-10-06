import fs from 'node:fs';
import path from 'node:path';

const forbidden = /\b(?:eval|Function|require\s*\(|child_process|exec\s*\(|spawn\s*\(|fetch\s*\(|XMLHttpRequest|process\.env|process\.exit)\b/;

export function securityGate(source) {
  return { passed: !forbidden.test(source), reason: forbidden.test(source) ? 'generated source contains a forbidden side effect' : null };
}

export function originalityGate(source, existing = '') {
  const normalized = source.replace(/\s+/g, ' ').trim();
  return { passed: normalized.length > 0 && !existing.replace(/\s+/g, ' ').includes(normalized), reason: 'generated test is empty or already present' };
}

export function scaffold(finding) {
  const name = `${finding.category} at ${finding.file}:${finding.line}`;
  return `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest(${JSON.stringify(name)}, async () => {\n  // TODO: import the unit under test and assert: ${finding.suggestion}.\n  // Evidence: ${finding.evidence}\n  assert.ok(true);\n});\n`;
}

export function generate(report, options = {}) {
  const destination = path.resolve(options.destination ?? 'tests/quelltest');
  const results = [];
  for (const finding of report.findings) {
    const source = scaffold(finding);
    const security = securityGate(source);
    const originality = originalityGate(source, options.existing ?? '');
    const status = security.passed && originality.passed ? 'SCAFFOLDED' : 'FLAGGED';
    const file = path.join(destination, `${finding.id}.test.js`);
    if (options.write && status === 'SCAFFOLDED') {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(file, source, 'utf8');
    }
    results.push({ ...finding, status, verified: false, gates: { security, originality, correctCode: 'PENDING', injectedBug: 'PENDING' }, output: options.write && status === 'SCAFFOLDED' ? file : null });
  }
  return results;
}
