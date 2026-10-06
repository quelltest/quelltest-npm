## Problem

The npm port needs a precise contract before implementation. The Python package currently promises offline edge-case discovery, five-gate verification, WRITTEN/SCAFFOLDED/FLAGGED outcomes, confidence, and a Production Readiness Score. JavaScript already has strong test runners (Vitest, Jest, Node test), property testing (fast-check), and contract testing (Pact), so the npm product should orchestrate existing runners instead of replacing them.

## Evidence

- [Quell Python README](https://github.com/quelltest/quelltest-lib/blob/main/README.md)
- [fast-check](https://github.com/dubzzz/fast-check)
- [Pact JS](https://github.com/pact-foundation/pact-js)
- [State of JS testing](https://2023.stateofjs.com/en-US/libraries/testing/)
- [Reddit: CI pain points](https://www.reddit.com/r/javascript/comments/1pdxx20/askjs_whats_your_biggest_pain_point_with_cicd_for/)

## Acceptance criteria

- A PRD states target users, non-goals, parity boundaries, supported runtimes, and success metrics.
- The first release is explicitly offline-first and dependency-light.
- The public API, CLI, output schema, and compatibility policy are versioned.
- No claims imply that Quell replaces Vitest, Jest, Node test, fast-check, or Pact.

