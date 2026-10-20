# Contributing to quelltest

Thank you for helping. quelltest is a free, offline gate for AI-written tests: it proves tests would fail if the code were wrong, detects weakened tests in a change, and finds untested risky edges in JavaScript and TypeScript. This guide explains how to report problems, propose changes and get a pull request merged.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), never a public issue.

## Ways to contribute

- **Report a false positive or a missed defect.** These are the most valuable reports: a few lines of source that show the problem, the command you ran and what you expected. The bug template asks for exactly this.
- **Propose or improve a rule, mutator or check.** Open an issue first for anything beyond a small fix, with a flagged example and a safe twin that must stay quiet.
- **Improve the docs.** If you got stuck, the docs are wrong or missing something.
- **Fix an issue.** Look for `good first issue` and `help wanted`.

Search existing issues first. Use a conventional-commit title for new issues, for example `fix(scan): regex-injection fires on an escaped variable`; the triage agent labels them from it.

## Development setup

You need Node.js 22.18 or newer (22.18+ or 24.11+), the range `@babel/parser` 8 supports.

```bash
git clone https://github.com/quelltest/quelltest-npm.git
cd quelltest-npm
npm ci
npm test            # unit and integration tests (node:test)
npm run check       # syntax check of every source file
npm run eval        # rule recall, false positives, verifier accuracy on the bundled fixtures
npm run test:ci     # everything CI runs: tests, verifier smoke test, checks, pack dry-run
```

`npm ci --ignore-scripts` is what CI uses. The runner matrix test (`test/matrix.test.js`) generates and verifies tests under real Jest, Mocha and Vitest, so those are dev dependencies; the published package has one runtime dependency, `@babel/parser`.

Tests run on Linux, macOS and Windows in CI, so avoid POSIX-only assumptions: build paths with `path`, never assume `/tmp`, and clean up temp directories.

## How the code is organised

See [docs/architecture.md](docs/architecture.md) for the module map and the invariants. In short: `scan` finds candidates, `coverage` and `score` say which are executed, `generate` writes tests, `verify` proves a test catches faults by running it against mutants of the source in a throwaway copy, `gate` compares test files across a change, `mcp` exposes the three for agents, `mocks` compares stubs with recorded examples.

Rules of the road that tests enforce:

- Verification never writes to the real source tree (it works in a copy; the in-place fallback restores from a backup).
- The scanner and generator never execute project code; only `verify` runs tests.
- Nothing is sent over the network at runtime. A model is only ever involved through the opt-in `--llm` hook, which runs your own code.
- A finding or generated test must be explainable from the source: no heuristics that cannot say why.

## Adding a scanner rule

1. Add the rule id and its explanation to `RULES`, a weight to `RULE_RISK` and a level to `RULE_CONFIDENCE` in `src/scan.js`, then the detection.
2. Add **a flagged example and a safe twin** to a test file (`test/rules.test.js` is the pattern: `SHOULD_FLAG` and `SHOULD_STAY_QUIET`). A rule without a safe twin will not be merged.
3. If it should hold on real code, add a guarded file to `eval/clean/` (`npm run eval` fails on any risk finding there) and, for a known defect shape, an entry in `eval/defects.json`.
4. Update `README.md` (rule list), `CHANGELOG.md` and, for a new category, `src/index.d.ts` and `src/sarif.js`.

Precision is the product. A change that lowers recall or raises noise on the fixtures needs a reason in the PR description.

## Adding a mutation operator

Add it to `mutantsWithStats` in `src/mutate.js` with a `kind`, a priority and a guidance entry in `src/handoff.js`. Mutants that do not parse are dropped automatically; add a test that every produced mutant parses and one that a test pinning the behaviour kills it.

## Adding a command or option

`src/cli-args.js` (parsing and validation), `src/cli.js` (behaviour, help text, exit code), `src/index.d.ts` if it is also API, `README.md`, `CHANGELOG.md`, and a test in `test/cli.test.js` or next to the feature. Exit codes are part of the interface: pick the next free one and document it.

## Tests

- Use `node:test` and `node:assert/strict`. Every bug fix gets a regression test; every feature gets a positive and a negative test.
- Do not weaken an existing assertion to make a test pass. `quell gate --diff origin/main` checks for that, and CI runs it on your PR. If an expected value legitimately changes, say why in the PR.
- No real network. Use stubs, temp directories and the fixtures under `eval/`.
- Keep fixtures small; name them after the behaviour they pin.

## Style

- ES modules, no build step, no TypeScript source (types live in `src/index.d.ts`).
- Match the surrounding code: naming, comment density, small functions. Comments say why, not what.
- Do not add a dependency without discussing it in an issue first.
- Never commit secrets, tokens, `node_modules`, coverage output or generated tests.

## Commits and pull requests

- Branch from `main` and open the PR **against `main`**. Do not stack pull requests on other branches: merging one into its base never reaches `main` and never closes its issues (the PR guard fails such PRs).
- One logical change per PR. Conventional-commit title (`feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `test: ...`, `chore: ...`).
- Link the issue: `Closes #123`.
- Describe what changed and why, and what you verified. The pull request template has the checklist.
- Update `CHANGELOG.md` for anything a user can see, and the docs for anything whose behaviour changed.
- Do not add attribution trailers for tools (`Co-Authored-By`, "Generated with") to commits or PR text.

CI must pass on Linux and Windows (and macOS when its hosted runners are available). A maintainer reviews, may ask for changes, and merges. Expect a first response within a few working days; ping the PR if it goes quiet for a week.

### Using AI assistants

Use them if they help. You are responsible for what you submit: understand it, run the tests, and make sure the tests you (or the assistant) wrote can fail, which is what `quell verify` is for. Run it on your own tests before asking for review.

## Licensing of contributions

quelltest is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution you license it under the same terms (section 5 of the license: inbound = outbound), and you confirm that you have the right to do so. There is no CLA at the moment. A `Signed-off-by` line (`git commit -s`, the Developer Certificate of Origin) is welcome but not required.

## Releasing (maintainers)

See [docs/automation.md](docs/automation.md): bump the version, add the changelog section, merge, then push a `vX.Y.Z` tag and the release agent does the rest.

## Questions

See [SUPPORT.md](SUPPORT.md).
