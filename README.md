# Quelltest for npm

Offline-first edge-case discovery for JavaScript and TypeScript projects. Quelltest complements Vitest, Jest, and Node's test runner: it finds contracts already present in source code and turns them into reviewable test candidates.

## Quick start

```bash
npm install
npx quell find src/
npx quell score src/ --threshold 60
npx quell find src/ --json
```

The 0.1 MVP is deterministic and never executes project source during scanning. It reports guard boundaries, thrown errors, nullish paths, JSDoc contracts, schema hints, and async paths with stable IDs and source locations.

## Product boundary

This package is an analyzer and verification layer, not a replacement for a test runner, property-testing framework, or API contract broker. The implementation plan and market research are in [`research/`](research/), mapped to issues 1–5 in the upstream repository.

## Development

```bash
npm test
npm run check
npm run pack:check
npm run test:ci
```

The CI workflow runs Node checks on Node 20, 22 and 24 (plus Windows and macOS on Node 22), and the PR report workflow runs quelltest on every pull request and posts the result to the job summary and a PR comment. Ruff and Flake8 are conditional quality jobs: they run only when Python files are added, so the npm package does not pull in unrelated Python tooling while mixed-language contributions remain covered.

Licensed under the [Apache License 2.0](LICENSE). Maintained by Shashank Bindal.
