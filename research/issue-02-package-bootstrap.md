## Problem

The repository has no files, package metadata, tests, or release automation. Consumers need a runnable package with predictable Node and TypeScript compatibility.

## Scope

Create a small TypeScript package with ESM and CommonJS output, declaration files, a `quell` CLI, stable exit codes, and zero runtime network calls. Start with Node 20 and 22, and document Node 18 if compatibility is feasible.

## Acceptance criteria

- `npm install` and `npm test` work from a clean checkout.
- `npm run build` emits ESM, CJS, and `.d.ts`.
- `npx quell find .` and `npx quell score .` have `--json` and human-readable modes.
- `--help`, `--version`, and non-zero failure exit codes are covered by tests.
- CI covers supported Node versions and package packing.

## Research context

Package users value runnability, active maintenance, TypeScript support, and low dependency/security risk; see [npm package research](https://rabeabdalkareem.github.io/files/25-Mujahid_JSS2023.pdf).

