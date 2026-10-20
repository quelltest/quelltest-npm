# Quelltest

**The free, offline gate for AI-written tests.** Your agent says the tests pass. Quelltest proves they would fail if the code were wrong, and fails the build when a change weakens them.

It reads JavaScript and TypeScript with a real parser, aims mutants at the places where bugs hide (guards, sanitisers, `await`, `??` fallbacks, thrown errors), runs your own tests against them, and reports the mutants nobody caught. It works with Jest, Vitest, Mocha and `node:test`, never sends code anywhere, and needs no Docker.

```bash
npm install --save-dev quelltest
npx quell verify tests/pay.test.js --source src/pay.js     # would this test catch a bug?
npx quell gate --diff origin/main                          # did this change weaken the tests?
npx quell find src --diff origin/main --coverage coverage/lcov.info   # risky edges with no real test
```

## Why

Surveys and developer write-ups keep landing on the same problem: coverage tells you code ran, not that tests would notice a bug, and an agent that writes both code and tests will happily weaken an assertion to get a green check. Mutation testing is the independent check, but it has been slow, noisy and awkward to run on every change. Quelltest makes it fast (a few targeted mutants per test file), quiet (suppression, equivalent-mutant handling) and usable by agents (MCP server, survivor handoff).

## Commands

| Command | What it does |
| --- | --- |
| `verify TEST --source FILE` | Runs the test on the original source, then on mutants of that source (in a throwaway copy of the project). The test must pass first, must contain an assertion that observes the code, and must fail on at least one mutant (`--min-score N` also requires N% of decided mutants killed). Survivors are listed; `--handoff FILE` writes them as Markdown with the diff, context and a specific instruction. `--function NAME` and `--findings` aim the mutants; `--command` runs your own integration command instead of a runner (in the source file's folder); survivors on code your test mocks are labelled. The runner is `--runner` if given, else detected like `generate` does, from the nearest `package.json` at or above the test file that names a runner (Vitest, then Jest, then Mocha, else `node:test`; never above the project root, so a runner declared only above it is not used: pass `--runner`); it runs in the folder of the `package.json` that names the runner, else of the nearest `package.json`, so tests may live outside the source folder. The output says which runner was used (`runner: jest (detected from package.json)`; JSON has `runner` and `runnerSource`). |
| `gate --diff REF` | Compares changed test files with their version at the merge-base: deleted tests/files, skipped tests, `.only`, removed assertions, equality loosened to `ok`/truthy/not-null (errors, exit code 5), changed expected values (review items; `--strict` fails on them too). `--json` and `--sarif` available. |
| `find [PATH]` | Parses files and lists risk-ranked candidates per function: thrown errors, boundaries, nullish paths, JSDoc contracts, schema calls, and a rule pack for defects that *lack* a guard (regex built from request data, request body written to a document, NoSQL operator injection, path traversal, open redirects, `\|\|` that swallows `0`, unguarded `jwt.verify`/`bcrypt.compare`, check-then-create races, missing `await`, hard-coded secrets, `eval` of input, unparsed request JSON). One hop of data flow from `req.body/query/params` is tracked. `--diff REF` limits to changed lines, `--sarif` for code scanning. |
| `score [PATH]` | Share of candidates your tests execute, from Istanbul `coverage-final.json` or `lcov.info`. Without coverage evidence it prints `not scored`, never `0/100`. |
| `generate [PATH]` | Writes tests for guards it can analyse statically (a parameter or one of its properties compared with literals, `typeof`, truthiness, what an injected client, model or global `fetch` returns, JSDoc `@example`) for the detected runner; everything else becomes a TODO note, never a placeholder test. Route handlers get a list of request cases derived from their guards. Candidates your tests already cover are skipped. `--verify` keeps only tests that pass on the original and fail on a source mutant. |
| `mcp` | MCP server on stdio exposing `find`, `verify`, `gate` for coding agents. See [docs/agents.md](docs/agents.md). |
| `mocks [PATH] --examples FILE` | Compares stubs you annotate (`// quell-mock GET /users/:id`) with recorded examples (HAR, a JSON map, or OpenAPI JSON): fields only the recording has, fields only the stub invents, type mismatches. Exit code 6 on drift. See [docs/dependencies.md](docs/dependencies.md). |
| `eval` | Runs the bundled benchmark (rule recall on known defects, false positives on guarded code, verifier accuracy on strong vs weak tests). |

Findings are ranked by risk (injection and unsafe writes first, enum comparisons and numeric fallbacks last). Test files, config and generated output are skipped; `--include`, `--exclude`/`--ignore`, `--include-tests` and `.quellignore` adjust that. IDs hash the function name and the evidence, not the line number, so they survive unrelated edits.

### Exit codes

`0` ok · `6` `mocks` found stub drift · `1` score below `--threshold` · `2` usage or runtime error · `3` `--threshold` given but nothing to score from · `4` `verify` did not verify the test · `5` `gate` found weakened tests.

### Suppression

`// quell-ignore [rule]` (finding), `// quell-ignore-file`, `// quell-ignore-mutant <reason>` (equivalent mutant), `// quell-allow-weaken <reason>` (inside a test, for `gate`).

## How it compares

Facts as of 20 Oct 2026 from public pages and papers; check each project for current details.

| | Quelltest | Stryker (JS) | Flawd | LLM test generators (Qodo, Copilot, Cover-Agent) |
| --- | --- | --- | --- | --- |
| Price / licence | Free, Apache-2.0 | Free, open source | Paid, closed source | Paid or API-metered |
| Needs a model or network | No (an `--llm` hook is opt-in and runs your own code) | No | No | Yes |
| Aims mutants at specific risks | Yes (rule-driven) | Generic mutators, configurable | Mutates covered lines; `--diff` | n/a |
| Detects weakened tests in a change | Yes (`gate`) | No | Not documented | No |
| Isolation | Temporary project copy, no Docker | Sandbox copies | Docker/Podman per mutant | n/a |
| Agent interface | MCP server, handoff report | Reports | `handoff` Markdown | n/a |
| Full-suite mutation score | No (per test file / per change) | Yes | Yes | n/a |
| Writes tests | Simple guards only; notes otherwise | No | No | Yes, arbitrary code |

Choose Stryker for a complete mutation score across a suite. Choose an LLM generator when you need tests written for arbitrary code, and put `verify` and `gate` in front of what it writes.

## What it does not do

- It does not know whether your stubs resemble the real services. It verifies that tests notice changes in your code; `quell mocks` and `verify --command` narrow the gap, see [docs/dependencies.md](docs/dependencies.md).
- It does not generate tests for most real code. Generation handles named, exported functions with statically readable guards; Express handlers, React components and everything else become notes (route handlers also list the request cases their guards imply).
- Findings are review hints, not proof of defects. Line-level rules cannot see wrong business rules (`eval/defects.json` lists the known misses).
- `verify` runs your tests once per mutant (default cap 30), so it is slower than a plain test run. It mirrors the project into a temp directory; very large projects fall back to in-place mutation with a backup file (`--in-place` forces it).
- Statement coverage is matched to candidates by position; `lcov.info` is line-granular.
- It is young: see the changelog, and `npm run eval` for the measurements below.

## Measuring quelltest itself

`npm run eval` reports, on author-written fixtures (treat as regression guards, not independent benchmarks):

- **Rule recall** on 18 defects reported against a real code base: `eval/defects.json` (7 are documented known misses), and risk-rule false positives on guarded code in `eval/clean/`.
- **Verifier accuracy**: `eval/gate/` holds, per case, a strong test and weak variants (tautology, literal-only, no assertion, wrong target, happy-path only). The strong tests must be accepted and every weak one rejected at a 60% mutation-score floor.
- `test/matrix.test.js` generates and verifies tests under real Jest, Mocha, Vitest and `node:test` (CommonJS and ESM).

## Development

```bash
npm test
npm run check
npm run pack:check
npm run test:ci
```

quelltest needs Node 22.18+ or 24.11+. CI runs on Node 22 and 24 (plus Windows and macOS on Node 22). A PR workflow runs quelltest on every pull request, limited to changed lines, and publishes the report to the job summary and a PR comment.

## Community

- [Contributing](CONTRIBUTING.md): setup, how to add a rule, tests and pull requests
- [Code of Conduct](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1)
- [Security policy](SECURITY.md): report vulnerabilities privately
- [Support](SUPPORT.md): where to ask, what to include
- [Governance](GOVERNANCE.md): who decides what
- [Architecture](docs/architecture.md), [agents and CI](docs/agents.md), [repository automation](docs/automation.md), [changelog](CHANGELOG.md)

Licensed under the [Apache License 2.0](LICENSE). Maintained by Shashank Bindal.
