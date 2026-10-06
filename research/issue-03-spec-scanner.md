## Problem

The Python analyzer reads guard clauses, docstrings, type annotations, and Pydantic constraints. The npm implementation needs equivalent sources of truth without requiring decorators or a new DSL.

## Scope

Implement a deterministic AST-based scanner for JavaScript and TypeScript that extracts guard clauses and thrown errors; nullish/optional access; boundary comparisons; discriminated unions and literal types; Zod/Valibot/ArkType schemas when present; JSDoc/TSDoc `@throws`, `@param`, and examples; and async error paths.

## Acceptance criteria

- Results include source file, line/column, category, evidence, and a stable candidate ID.
- Parsing supports `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, and `.tsx`.
- Parsing is syntax-safe and never executes project code.
- Findings are deterministic across repeated runs and have fixture coverage for positive/negative cases.
- Unsupported constructs become FLAGGED with a reason, not silently ignored.

## Research context

JavaScript teams report test maintenance and debugging as major CI costs; [community discussion](https://www.reddit.com/r/javascript/comments/1pdxx20/askjs_whats_your_biggest_pain_point_with_cicd_for/) supports prioritizing actionable source locations over noisy reports.

