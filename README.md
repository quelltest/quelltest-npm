# Quelltest for npm

Offline-first edge-case discovery for JavaScript and TypeScript. Quelltest reads your source with a real parser (it never executes it), lists the guards, errors and risky patterns that deserve a test, tells you which of them your existing tests already run, and can generate tests that are checked against mutants of your own code before they are kept.

It complements Jest, Vitest, Mocha and `node:test`; it is not a replacement for a test runner.

## Quick start

```bash
npm install
npx quell find src/                      # ranked candidates, top 10
npx quell find src/ --diff origin/main   # only lines changed in this branch
npx quell score src/ --coverage coverage/coverage-final.json --threshold 60
npx quell generate src/ --write --verify # real tests, verified against source mutants
```

## What it does

| Command | Behaviour |
| --- | --- |
| `find [PATH]` | Parses files (directory or single file) and reports candidates per function: thrown errors, boundary conditions (including conditions that call functions), nullish paths, JSDoc contracts, schema calls, async functions, and a rule pack for defects that *lack* a guard (regex built from user input, `Object.assign(doc, req.body)`, `\|\|` that swallows `0`, unguarded `jwt.verify`/`bcrypt.compare`, check-then-create races, async routes without error mapping, unguarded `data.items.map`). |
| `score [PATH]` | Share of candidates your tests actually execute, from Istanbul `coverage-final.json` or `lcov.info` (auto-detected in `./coverage`). A boundary counts only when both branches ran. **Without coverage evidence it prints `not scored`**, never `0/100`. |
| `generate [PATH]` | Writes tests that import the unit, call it with boundary values and assert; JSDoc `@example fn(1) // => 2` lines become assertions. Anything it cannot reason about becomes a `.todo.md` note. |
| `verify TEST --source FILE` | Runs a test on the original source, then on mutants of that source (flipped operators, removed guards and throws); the test must fail on at least one. |

Test files, config, generated output and anything in `.quellignore` are skipped; use `--include`, `--exclude`/`--ignore` and `--include-tests` to adjust. Findings are ranked by risk; `--all` and `--top N` control the list. `--json` prints the full report, `--sarif` prints SARIF 2.1.0 for GitHub code scanning.

Finding IDs hash the function name and the normalised evidence, not the line number, so they survive unrelated edits.

### Generated tests

`generate` detects the runner (Vitest, Jest/react-scripts, Mocha, else `node:test`) and module system (ESM/CommonJS) and writes matching files into `tests/quelltest/` (change with `--destination`, override with `--runner`). Statuses:

- `GENERATED` — a real test, not run yet.
- `VERIFIED` — passed on the original code and failed on a source mutant (`--verify`).
- `TODO` — no test could be derived; a note is written instead. A note is not a test.
- `FLAGGED` — rejected by the security gate (which inspects the generated code, not quoted evidence) or as a duplicate.

Only simple guards (parameters compared with literals, `typeof`, truthiness, joined by `||`) are turned into tests today. `--llm MODULE` lets you plug in your own model for the rest: the module's default export receives the finding and the function source and returns test code, which must pass the same gates. quelltest itself never sends code anywhere. Note that accepted LLM-written tests are executed to verify them: the security gate (allowlisted imports, no `process`/`global`/`eval`/network references) is defence in depth, not a sandbox, so review model output as you would any code.

### Exit codes

`0` ok · `1` score below `--threshold` · `2` usage or runtime error · `3` `--threshold` given but there is no score (no coverage evidence) · `4` `verify` did not verify the test.

## Limitations

- Findings are review hints, not proof of defects. Line-level rules cannot see logic errors such as wrong business rules (see `eval/defects.json` for the known misses).
- Statement coverage is matched to candidates by position; `lcov.info` is line-granular.
- Mutation verification runs your tests once per mutant (up to 30 per test), so `--verify` is slower than a plain scan.

## Measuring quelltest itself

`npm run eval` scans `eval/defects/` (known defects from a real code base) and `eval/clean/` (guarded code) and prints recall and false positives; the test suite fails if recall drops below 50% or the clean files produce risk findings. The fixtures were written by the rule author, so treat this as a regression guard rather than an independent benchmark; it reports `recall` over all 18 defects and `detectableRecall` over the 11 that line-level rules can see.

## Development

```bash
npm test
npm run check
npm run pack:check
npm run test:ci
```

CI runs on Node 20, 22 and 24 (plus Windows and macOS on Node 22). A PR workflow runs quelltest on every pull request, limited to changed lines, and publishes the report to the job summary and a PR comment. Ruff and Flake8 are conditional jobs that only run when Python files are added.

Licensed under the [Apache License 2.0](LICENSE). Maintained by Shashank Bindal.
