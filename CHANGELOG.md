# Changelog

## 0.3.0

Repositioned as the free, offline gate for AI-written tests (see `docs/agents.md`).

### Added
- `quell gate --diff REF`: detects deleted/skipped tests, `.only`, removed and loosened assertions and changed expected values in a change; `--json`, `--sarif`, `--strict`; exit code 5. `// quell-allow-weaken` exempts a test.
- `quell mcp`: MCP server on stdio with `find`, `verify` and `gate` tools.
- `verify`: survivor handoff report (`--handoff FILE`), `--min-score`, `--findings`, `--in-place`, `// quell-ignore-mutant`, relative path support, the failing command in error messages.
- Risk-aimed mutants: sanitiser unwrap, `await` removal, `??`/`||` swaps, ordered ahead of generic operator flips.
- Rules: `nosql-injection`, `path-traversal`, `open-redirect`, `missing-await`, `hard-coded-secret`, `eval-input`, `unparsed-json`; one hop of data flow from `req.body/query/params` (aliasing, spread, `$set`, destructuring, `JSON.parse`, `new URL`).
- `// quell-ignore [rule]` and `// quell-ignore-file`.
- `generate`: request cases for Express route handlers in TODO notes, actionable reasons (export / extract / unsupported expression), skips candidates already covered (`--include-covered` overrides).
- Verifier benchmark (`eval/gate`), runner fixture matrix for Jest, Mocha, Vitest and `node:test`.

### Changed
- `verify` and `generate --verify` run in a temporary copy of the project by default; the real source is never written (falls back to in-place with a backup for very large projects).
- Findings are ranked by per-rule risk; `falsy-fallback` fires only for numeric defaults; `nullish` ignores code that already has a fallback or guard; `unguarded-call` respects `asyncHandler`-style wrappers.
- README rewritten around the verifier; honest comparison with Stryker, Flawd and LLM generators.

### Fixed (from the independent review of this release)
- Verification can no longer write through a symlinked source file; sources under `build/`/`dist/` are mirrored; mutants that do not parse are dropped instead of counted as kills; `return await` and plain coercions are no longer prioritised equivalent mutants; refuses to overwrite an existing test in place; warns when it falls back to in-place.
- Scanner: per-sink sanitisers, whole-body vs single-field taint, reassignment and parameter shadowing, same-site redirects, route/i18n constants, `process.env` defaults; `quell-ignore-mutant` no longer suppresses scanner findings.
- Gate: git renames, `describe.only`, template-literal and repeated test names, `expect.assertions`/`t.mock`/`t.plan` no longer counted, unparsable files are errors; the PR workflow's gate step now fails the job.
- MCP: malformed messages, batches and stray responses are handled without crashing.
- Nothing in 0.2.0's behaviour was removed. New exit codes: 4 (`verify` not verified, 0.2.0) and 5 (`gate`).

## 0.2.0

AST scanner, coverage-based score, mutation-based verification, real test generation for the detected runner, `--diff`, SARIF, `--llm` hook, Apache-2.0 licence.

## 0.1.0

First release: regex scanner, placeholder scaffolds.
