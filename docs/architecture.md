# Architecture

quelltest is a small pipeline of independent modules that share one finding format. Everything is plain ES modules; the only runtime dependency is `@babel/parser`.

```
source files ──scan──▶ findings ──coverage/score──▶ "which are executed by tests?"
                          │
                          ├──generate──▶ tests (and TODO notes) ──verify──▶ kept only if they fail on a source mutant
                          │
test files ───gate (git diff vs merge-base)──▶ weakened / deleted / skipped tests
                          │
all of the above ──mcp──▶ tools for coding agents (find, verify, gate)
```

## Module map (`src/`)

| Module | Responsibility |
| --- | --- |
| `cli.js`, `cli-args.js` | Commands, option parsing and validation, help, exit codes. |
| `index.js`, `index.d.ts` | The library API and its types. `report()` = scan + coverage + diff + score. |
| `ast.js`, `files.js` | Parsing (Babel, JS/JSX/TS/TSX), function naming, file discovery (tests, config and generated output are skipped). |
| `scan.js` | The rule pack. One AST walk emitting findings with `rule`, `risk`, `confidence`, stable `id`; one hop of data flow from `req.body/query/params`; `quell-ignore` handling. |
| `coverage.js`, `score.js` | Istanbul and lcov readers, per-finding `covered`, the score (never computed without coverage evidence). |
| `diff.js` | Changed lines and changed files since the merge-base with a git ref. |
| `unit.js` | Static description of a module: top-level functions, ESM/CommonJS exports, guards. |
| `synthesize.js` | Turns guards into test cases: parameters, properties of parameters, and results of calls to injected dependencies (path conditions + a small solver). |
| `runner.js`, `generator.js` | Detects the runner (also used by `verify`, from the nearest package.json that names a runner) and module style, renders tests, gates them (security gate, originality), optional verification and writing. `routes.js` derives request cases for route handlers. |
| `mutate.js`, `verification.js` | Source mutants and the verifier: baseline must pass, an assertion must observe the code, at least one mutant must fail; runs in a temporary copy of the project. `mocks.js` labels survivors on mocked code, `handoff.js` renders them for agents, `backup.js` repairs an interrupted in-place run. |
| `gate.js` | Compares the test files of a change with their merge-base version. |
| `mcp.js` | MCP server over stdio (JSON-RPC lines): `find`, `verify`, `gate`. |
| `contract.js` | `quell mocks`: stubs annotated `// quell-mock` versus recorded examples. |
| `sarif.js`, `handoff.js` | Output formats. |

## Invariants (each is covered by a test)

1. **The real source tree is never modified by verification.** It works in a copy (symlinks are dereferenced, `node_modules` is linked and never deleted). The in-place fallback keeps a backup and restores it in a `finally`; `scan` and `generate` repair a backup left by a killed run.
2. **Only `verify` executes project code**, and only your tests or your own `--command`. Scanning and generation are static.
3. **Nothing leaves the machine.** The `--llm` hook runs a module you supply; quelltest sends no code to any service.
4. **A score is never invented.** No coverage evidence means `not scored`, never `0/100`.
5. **Only genuine test failures count as kills.** Timeouts, runner errors and reserved infrastructure exit codes are inconclusive; mutants that do not parse are never produced.
6. **Generated tests must be able to fail.** A placeholder is never emitted: what cannot be derived becomes a TODO note, and verified tests must fail on a source mutant.
7. **The security gate parses generated code** (imports, `process`, `eval`, `Function`, network, `globalThis` except the fetch-stub pattern); it is defence in depth, not a sandbox.
8. **Findings are deterministic**: the same source gives the same ids, ranking and output; ids do not depend on line numbers.

## Where the evidence lives

- `eval/defects` and `eval/clean`: rule recall on known defects and false positives on guarded code.
- `eval/gate`: the verifier must accept strong tests and reject tautologies, literal-only, no-assertion, wrong-target and happy-path-only tests.
- `eval/matrix`: generation and verification under Jest, Mocha, Vitest and `node:test` (CommonJS and ESM).
- `npm run eval` prints all of it.
