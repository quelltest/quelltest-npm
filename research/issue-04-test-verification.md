## Problem

Generated tests are only useful if they run on the correct code and demonstrate that they catch the intended defect. The Python product makes this a differentiator with five gates.

## Scope

Generate framework-neutral test drafts first, with adapters for Vitest and Node's built-in test runner. Add Jest compatibility once the adapter contract is stable. Implement gates for syntax/import safety, duplicate/originality checks, security policy, pass-on-correct-code, and fail-on-injected-mutation.

## Acceptance criteria

- Generated tests are never written over user files without an explicit `--fix`/API option.
- Dry-run output shows the proposed test and evidence.
- A mutation is narrowly scoped, reverted in a finally/temporary copy, and never runs against the user's working tree.
- Each result is WRITTEN, SCAFFOLDED, or FLAGGED with gate outcomes and confidence.
- Tests cover async code, ESM/CJS imports, and TypeScript transpilation boundaries.
- Security tests reject network calls, process mutation, shell execution, eval, and secret exfiltration in generated code.

## Related ecosystem

- [Vitest](https://vitest.dev/)
- [Node test runner](https://nodejs.org/api/test.html)
- [fast-check](https://github.com/dubzzz/fast-check)
- [Pact JS](https://github.com/pact-foundation/pact-js)

