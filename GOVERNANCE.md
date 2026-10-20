# Governance

quelltest is a maintainer-led open-source project. This page says who decides what, so contributors know what to expect.

## Roles

- **Users and contributors** report problems, propose changes, send pull requests and review each other's work. Anyone can be one.
- **Maintainers** merge pull requests, cut releases, triage issues and enforce the [Code of Conduct](CODE_OF_CONDUCT.md). The current maintainer is Shashank Bindal ([@shashankbindal](https://github.com/shashankbindal)); the maintainers are listed in [`.github/CODEOWNERS`](.github/CODEOWNERS).

## How decisions are made

- Small changes (a fix, a docs improvement, a test): a maintainer reviews and merges the pull request.
- Larger changes (a new rule category, a new command, a behaviour or exit-code change, a new dependency): open an issue first. Discussion runs on the issue; the maintainers decide, aiming for consensus and giving their reasons. Silence for a week on a clearly scoped proposal is treated as no objection.
- Anything that affects the published interface (CLI options, exit codes, the JSON, SARIF and MCP outputs, the `index.d.ts` types) is called out in the [changelog](CHANGELOG.md) and follows semantic versioning once the project reaches 1.0; before 1.0, breaking changes are possible in a minor version and are always listed.
- Precision comes first: a rule or generator change that raises false positives on the bundled fixtures is not merged without a stated reason.

## Becoming a maintainer

Sustained, good contributions (reviews and fixes, not only features), a track record of respecting precision and the Code of Conduct, and an invitation from the existing maintainers. Maintainers who stop being active for a long time are moved to emeritus status with thanks.

## Conflicts and conduct

Disagreements about a technical decision are settled by the maintainers after discussion. Conduct issues follow the process in the Code of Conduct and go to conduct@quelltest.com, not to the issue tracker.

## Releases

Maintainers release by pushing a version tag; the release workflow checks, publishes and writes the notes ([docs/automation.md](docs/automation.md)).

## Scope of this repository

This repository contains the open-source core under the [Apache License 2.0](LICENSE). Commercial add-ons, if any, are developed outside this repository and plug in through the documented extension points (such as the `--llm` hook); the core does not depend on them and stays Apache-2.0.
