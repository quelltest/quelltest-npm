#!/usr/bin/env node
import { report, generate } from './index.js';

const args = process.argv.slice(2);
const command = args.find((arg) => !arg.startsWith('-')) || 'find';
const root = args.find((arg) => !arg.startsWith('-') && arg !== command) || '.';
const json = args.includes('--json');
const thresholdIndex = args.indexOf('--threshold');
const threshold = thresholdIndex >= 0 ? Number(args[thresholdIndex + 1]) : null;

if (args.includes('--help')) {
  console.log('Usage: quell <find|score|generate> [PATH] [--json] [--write] [--threshold N]');
  process.exit(0);
}
if (args.includes('--version')) {
  console.log('0.1.0');
  process.exit(0);
}

const result = report(root);
if (command === 'generate') {
  const generated = { ...result, findings: generate(result, { write: args.includes('--write') }) };
  if (json) console.log(JSON.stringify(generated, null, 2));
  else console.log(`${args.includes('--write') ? 'Generated' : 'Planned'} ${generated.findings.length} safe test scaffolds`);
}
else if (json) console.log(JSON.stringify(result, null, 2));
else if (command === 'score') console.log(`PRS ${result.summary.score}/100  ${result.summary.tier}  |  ${result.findings.length} edge-case candidates`);
else {
  console.log(`Quell scan — ${result.findings.length} edge-case candidates found`);
  for (const item of result.findings) console.log(`• ${item.file}:${item.line} [${item.category}] ${item.suggestion}`);
}
if (threshold !== null && result.summary.score < threshold) process.exitCode = 1;
