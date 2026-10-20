#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { report, generate, generateWithLlm, scan, toSarif, verifyGenerated } from './index.js';
import { renderHandoff } from './handoff.js';
import { gate, gateSarif } from './gate.js';
import { parseArgs, UsageError, COMMANDS } from './cli-args.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Exit codes: 0 ok · 1 score below --threshold · 2 usage or runtime error · 3 --threshold set but nothing to score from · 4 verify: test not verified · 5 gate: weakened tests found
const EXIT = { ok: 0, belowThreshold: 1, error: 2, notScored: 3, notVerified: 4, weakened: 5 };

const HELP = `Usage: quell <${COMMANDS.join('|')}> [PATH] [options]
       quell verify TEST_FILE --source FILE [--function NAME] [--runner NAME]
       quell gate --diff REF [--strict] [--json|--sarif]
       quell mcp                       (MCP server on stdio: tools find, verify, gate)
       quell eval                      (run the bundled benchmark: rule recall, false positives, verifier accuracy)

PATH may be a directory or a single file (default: .).

Options:
  --json                 print the full report as JSON
  --sarif                print SARIF 2.1.0 (for GitHub code scanning)
  --coverage FILE        coverage-final.json or lcov.info (default: ./coverage/*)
  --diff REF             only candidates on lines changed since the merge-base with REF
  --all                  show covered candidates and do not truncate the list
  --top N                number of candidates to print (default: 10)
  --threshold N          exit ${EXIT.belowThreshold} when the score is below N (${EXIT.notScored} when it cannot be scored)
  --include GLOB         only scan matching files (repeatable)
  --exclude GLOB         skip matching files (repeatable; alias --ignore; also .quellignore)
  --min-confidence L     only findings at least this trustworthy: low, medium or high
  --include-tests        scan test files too
  --write                generate: write tests (and TODO notes) to disk
  --destination DIR      generate: output directory (default: tests/quelltest)
  --include-covered      generate: also generate for candidates your tests already cover
  --verify               generate: run each test and require it to fail on a source mutant
  --llm MODULE           generate: ESM module whose default export writes tests for findings the rules cannot
  --source FILE          verify: source file to mutate (required)
  --function NAME        verify: only mutate this function (repeatable)
  --findings             verify: aim mutation at lines the scanner flagged
  --min-score N          verify: also require N% of mutants killed
  --handoff FILE         verify: write surviving mutants as Markdown an agent can act on
  --in-place             verify: mutate the source file itself instead of a temporary copy
  --strict               gate: also fail on 'expected value changed' review items
  --runner NAME          generate/verify: node, jest, vitest or mocha (generate default: detected from package.json)
  -h, --help | -v, --version`;

function printFind(result, options) {
  const evidence = result.summary.coverageEvidence !== 'none';
  const pending = evidence && !options.all ? result.findings.filter((item) => !item.covered) : result.findings;
  const limit = options.all ? pending.length : (options.top ?? 10);
  const shown = pending.slice(0, limit);
  const covered = result.findings.length - pending.length;
  console.log(`Quell scan — ${pending.length} edge-case candidates${evidence ? ` not executed by tests (${covered} already covered)` : ''}, showing ${shown.length}`);
  for (const item of shown) console.log(`• ${item.file}:${item.line} [${item.rule ?? item.category}] ${item.function} — ${item.suggestion} (${item.confidence})`);
  if (pending.length > shown.length) console.log(`… ${pending.length - shown.length} more (use --all or --top N)`);
  if (!evidence) console.log('Coverage evidence: none (pass --coverage FILE to hide candidates your tests already run)');
}

function printScore(result) {
  const { summary } = result;
  if (summary.score === null) console.log(`Score: not scored (${summary.tier === 'no-findings' ? 'no edge-case candidates found' : 'no coverage evidence'}) | ${summary.total} candidates`);
  else console.log(`Score: ${summary.score}/100 ${summary.tier} | ${summary.covered}/${summary.total} candidates executed by tests | coverage evidence: ${summary.coverageEvidence}`);
}

function runVerify(testFile, options) {
  if (!options.source) throw new UsageError('verify requires --source FILE');
  // --findings aims mutation at the lines the scanner flagged instead of the whole file.
  const lines = options.findings ? scan(options.source, { includeTests: true }).findings.map((item) => [item.line, item.endLine]) : undefined;
  const result = verifyGenerated(null, {
    sourceFile: options.source, testPath: testFile, runner: options.runner, functions: options.function, lines,
    inPlace: options['in-place'], minScore: options['min-score'],
  });
  if (options.handoff) fs.writeFileSync(options.handoff, renderHandoff(result, { sourceText: fs.existsSync(options.source) ? fs.readFileSync(options.source, 'utf8') : '' }), 'utf8');
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    const suffix = `${result.isolation ? ` [${result.isolation}]` : ''}${result.ignored ? `, ${result.ignored} ignored` : ''}${result.inconclusive ? `, ${result.inconclusive} inconclusive` : ''}`;
    console.log(result.verified ? `Verified: test killed ${result.killed}/${result.total} mutants (${result.mutationScore}%)${suffix}` : `Not verified: ${result.reason}${suffix}`);
    for (const mutant of result.mutants.filter((item) => item.outcome === 'survived')) console.log(`  survived: ${mutant.description}`);
    if (options.handoff) console.log(`Handoff written to ${options.handoff}`);
  }
  return result.verified ? EXIT.ok : EXIT.notVerified;
}

function runGate(options) {
  if (!options.diff) throw new UsageError('gate requires --diff REF');
  const result = gate(options.diff, { strict: options.strict });
  if (options.sarif) console.log(JSON.stringify(gateSarif(result, VERSION), null, 2));
  else if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(result.ok ? `Gate passed: ${result.checked} changed test file(s) checked, no weakened tests` : `Gate failed: ${result.issues.length} issue(s) in ${result.checked} changed test file(s)`);
    for (const item of result.issues) console.log(`  ${item.severity === 'error' ? '✖' : '?'} ${item.file} :: ${item.test} — ${item.message}`);
  }
  return result.ok ? EXIT.ok : EXIT.weakened;
}

async function run(argv) {
  const { command, root, hasPath, options } = parseArgs(argv);
  if (options.help) { console.log(HELP); return EXIT.ok; }
  if (options.version) { console.log(VERSION); return EXIT.ok; }
  if (command === 'eval') {
    const { evaluate, evaluateGate } = await import('../scripts/eval.mjs');
    const rules = evaluate();
    const verifier = evaluateGate();
    console.log(JSON.stringify({ rules, verifier: { ...verifier, rows: undefined } }, null, 2));
    return rules.noise.length || verifier.wrong.length ? EXIT.belowThreshold : EXIT.ok;
  }
  if (command === 'gate') return runGate(options);
  if (command === 'mcp') {
    const { serve } = await import('./mcp.js');
    await serve();
    return EXIT.ok;
  }
  if (command === 'verify') {
    if (!hasPath) throw new UsageError('verify requires a TEST_FILE');
    return runVerify(root, options);
  }
  const scanOptions = { include: options.include, exclude: options.exclude, includeTests: options['include-tests'], coverage: options.coverage, diff: options.diff, minConfidence: options['min-confidence'] };
  const result = report(root, scanOptions);
  if (command === 'generate') {
    const generateOptions = { write: options.write, destination: options.destination, runner: options.runner, verify: options.verify, includeCovered: options['include-covered'] };
    let findings;
    if (options.llm) {
      const { default: llm } = await import(pathToFileURL(path.resolve(options.llm)).href);
      findings = await generateWithLlm(result, { ...generateOptions, llm });
    } else findings = generate(result, generateOptions);
    if (options.json) console.log(JSON.stringify({ ...result, findings }, null, 2));
    else {
      const count = (status) => findings.filter((item) => item.status === status).length;
      const tests = count('GENERATED') + count('VERIFIED');
      console.log(`${options.write ? 'Wrote' : 'Planned'} ${tests} tests (${count('VERIFIED')} verified), ${count('TODO')} TODO notes, ${count('FLAGGED')} flagged, ${count('SKIPPED')} already covered`);
      for (const item of findings.filter((entry) => entry.status === 'TODO').slice(0, 5)) console.log(`  TODO ${item.file}:${item.line} — ${item.reason}`);
    }
  } else if (options.sarif) console.log(JSON.stringify(toSarif(result, VERSION), null, 2));
  else if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (command === 'score') printScore(result);
  else printFind(result, options);
  if (result.restored?.length) console.error(`quell: restored ${result.restored.length} source file(s) left mutated by an interrupted verification run`);
  if (result.skipped.length) console.error(`quell: skipped ${result.skipped.length} unparsable file(s): ${result.skipped.slice(0, 3).join(', ')}${result.skipped.length > 3 ? ', …' : ''}`);
  if (options.threshold === undefined) return EXIT.ok;
  if (result.summary.score === null) return result.summary.tier === 'no-findings' ? EXIT.ok : EXIT.notScored;
  return result.summary.score < options.threshold ? EXIT.belowThreshold : EXIT.ok;
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  const hint = error instanceof UsageError ? '\nRun `quell --help` for usage.' : '';
  console.error(`quell: ${error.code === 'ENOENT' ? `no such file or directory: ${error.path}` : error.message}${hint}`);
  process.exitCode = EXIT.error;
}
