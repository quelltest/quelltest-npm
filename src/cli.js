#!/usr/bin/env node
import fs from 'node:fs';
import { report, generate, toSarif, verifyGenerated } from './index.js';
import { parseArgs, UsageError, COMMANDS } from './cli-args.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// Exit codes: 0 ok · 1 score below --threshold · 2 usage or runtime error · 3 --threshold set but nothing to score from · 4 verify: test not verified
const EXIT = { ok: 0, belowThreshold: 1, error: 2, notScored: 3, notVerified: 4 };

const HELP = `Usage: quell <${COMMANDS.join('|')}> [PATH] [options]
       quell verify TEST_FILE --source FILE [--function NAME] [--runner NAME]

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
  --include-tests        scan test files too
  --write                generate: write scaffolds to disk
  --source FILE          verify: source file to mutate (required)
  --function NAME        verify: only mutate this function (repeatable)
  --runner NAME          verify: node (default), jest, vitest or mocha
  -h, --help | -v, --version`;

function printFind(result, options) {
  const evidence = result.summary.coverageEvidence !== 'none';
  const pending = evidence && !options.all ? result.findings.filter((item) => !item.covered) : result.findings;
  const limit = options.all ? pending.length : (options.top ?? 10);
  const shown = pending.slice(0, limit);
  const covered = result.findings.length - pending.length;
  console.log(`Quell scan — ${pending.length} edge-case candidates${evidence ? ` not executed by tests (${covered} already covered)` : ''}, showing ${shown.length}`);
  for (const item of shown) console.log(`• ${item.file}:${item.line} [${item.rule ?? item.category}] ${item.function} — ${item.suggestion}`);
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
  const result = verifyGenerated(null, { sourceFile: options.source, testPath: testFile, runner: options.runner, functions: options.function });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(result.verified ? `Verified: test killed ${result.killed}/${result.total} mutants (${result.mutationScore}%)` : `Not verified: ${result.reason}`);
    for (const mutant of result.mutants.filter((item) => !item.killed)) console.log(`  survived: ${mutant.description}`);
  }
  return result.verified ? EXIT.ok : EXIT.notVerified;
}

function run(argv) {
  const { command, root, hasPath, options } = parseArgs(argv);
  if (options.help) { console.log(HELP); return EXIT.ok; }
  if (options.version) { console.log(VERSION); return EXIT.ok; }
  if (command === 'verify') {
    if (!hasPath) throw new UsageError('verify requires a TEST_FILE');
    return runVerify(root, options);
  }
  const scanOptions = { include: options.include, exclude: options.exclude, includeTests: options['include-tests'], coverage: options.coverage, diff: options.diff };
  const result = report(root, scanOptions);
  if (command === 'generate') {
    const generated = { ...result, findings: generate(result, { write: options.write }) };
    if (options.json) console.log(JSON.stringify(generated, null, 2));
    else console.log(`${options.write ? 'Generated' : 'Planned'} ${generated.findings.length} scaffolds`);
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
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  const hint = error instanceof UsageError ? '\nRun `quell --help` for usage.' : '';
  console.error(`quell: ${error.code === 'ENOENT' ? `no such file or directory: ${error.path}` : error.message}${hint}`);
  process.exitCode = EXIT.error;
}
