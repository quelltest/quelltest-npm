# Research notes

## Opportunity

The npm ecosystem already has excellent primitives: Vitest/Jest/Node test for execution, fast-check for property-based testing, and Pact JS for consumer-driven contracts. The opportunity is the missing connective layer: offline source inspection that identifies edge-case obligations and produces a consistent, reviewable readiness report across those tools.

## Repeated pain points

- Test maintenance and debugging cost more than writing the first test.
- CI output is noisy; failures lack source-linked, actionable context.
- Flaky and slow tests reduce trust in automation.
- Package consumers prioritize runnability, active maintenance, TypeScript support, and low dependency/security risk.

## Sources

- [Python product README](https://github.com/quelltest/quelltest-lib/blob/main/README.md)
- [Vitest](https://vitest.dev/)
- [Node test runner](https://nodejs.org/api/test.html)
- [fast-check](https://github.com/dubzzz/fast-check)
- [Pact JS](https://github.com/pact-foundation/pact-js)
- [State of JS testing](https://2023.stateofjs.com/en-US/libraries/testing/)
- [Reddit: CI pain points](https://www.reddit.com/r/javascript/comments/1pdxx20/askjs_whats_your_biggest_pain_point_with_cicd_for/)
- [Reddit: API testing wrapper discussion](https://www.reddit.com/r/node/comments/1hrtytj/test_api_librarywrapper_npm_package/)
- [NPM package quality research](https://rabeabdalkareem.github.io/files/25-Mujahid_JSS2023.pdf)
