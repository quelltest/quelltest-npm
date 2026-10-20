import { RULES } from './scan.js';

const DESCRIPTIONS = {
  throws: 'Thrown error without an asserting test',
  boundary: 'Boundary condition that needs adjacent-value tests',
  nullish: 'Nullish path that needs null/undefined tests',
  jsdoc: 'Documented contract that needs an executable test',
  schema: 'Schema validation that needs accepted/rejected inputs',
  async: 'Async function that needs resolve/reject tests',
};

/** Render a report as SARIF 2.1.0 for GitHub code scanning. */
export function toSarif(report, version = '0.0.0') {
  const ruleIds = [...new Set(report.findings.map((item) => item.rule ?? item.category))].sort();
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'quelltest', version, informationUri: 'https://github.com/quelltest/quelltest-npm',
          rules: ruleIds.map((id) => ({ id, shortDescription: { text: DESCRIPTIONS[id] ?? RULES[id] ?? id }, helpUri: 'https://github.com/quelltest/quelltest-npm#readme' })),
        },
      },
      results: report.findings.map((item) => ({
        ruleId: item.rule ?? item.category,
        level: item.category === 'risk' ? 'warning' : 'note',
        message: { text: `${item.suggestion} — ${item.evidence}` },
        partialFingerprints: { quelltestId: item.id },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: item.file },
            region: { startLine: item.line, startColumn: item.column, endLine: item.endLine },
          },
        }],
      })),
    }],
  };
}
