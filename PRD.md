# Quelltest npm — Product Requirements Document

## Summary

Quelltest npm is the JavaScript/TypeScript companion to the Python Quelltest package. It finds edge-case specifications already encoded in a codebase, produces machine-readable findings, and creates a trustworthy readiness signal while delegating execution to the project's existing test runner.

## User and problem

The target user is a Node or TypeScript maintainer who knows tests are missing but cannot see which guard clauses, error paths, schemas, and async contracts are uncovered. Existing tools are strong at running tests, generating inputs, or verifying API contracts, but they do not provide one offline, source-linked inventory of likely missing edge-case tests with a confidence/readiness signal.

## MVP

- Deterministic, non-executing scan of JS/TS source.
- Stable findings with file, line, category, evidence, and suggestion.
- Human and JSON CLI output.
- Production Readiness Score with a threshold exit code.
- ESM package with a typed public API and Node 20+ support.

## Follow-on milestones

1. Add framework adapters for Vitest and Node test, then Jest.
2. Add safe test generation with five gates: syntax, originality, security, pass-on-correct-code, fail-on-injected-mutation.
3. Add WRITTEN/SCAFFOLDED/FLAGGED outcomes, confidence, and temporary-copy mutation verification.
4. Add versioned JSON schema, GitHub Action, PR annotations, and an optional badge.

## Non-goals

Quelltest npm will not replace Vitest/Jest/Node test, fast-check, Pact, or a full security scanner. It will not send source code to a service by default and will not execute project code during discovery.

## Success metrics

- Clean install and test on supported Node versions.
- Stable output for the same source tree.
- Every finding links to an actionable source location.
- Generated tests, when introduced, pass the correct-code and injected-bug gates.
- CI consumers can enforce a threshold without parsing human output.

## Research basis

The proposal triangulates the Python product contract, the JavaScript testing ecosystem, and community complaints about noisy logs, flaky tests, maintenance cost, and slow CI. Sources are recorded in `research/README.md` and the five upstream GitHub issues.
