# Security policy

## Supported versions

Security fixes go into the latest minor release of the current major version (0.x while the project is pre-1.0). Please reproduce a problem on the latest published version of `quelltest` before reporting.

## Reporting a vulnerability

**Do not open a public issue.** Report privately by either:

- GitHub's private vulnerability reporting: <https://github.com/quelltest/quelltest-npm/security/advisories/new>, or
- email **security@quelltest.com**.

Include the version (`npx quell --version`), your Node version and OS, the command, and the smallest input that shows the problem. We aim to acknowledge a report within 3 working days, to tell you whether we consider it a vulnerability within 10, and to ship a fix or a mitigation for confirmed issues within 90 days. We will credit you in the release notes unless you prefer not to be named, and we ask you to keep the report private until a fix is released (coordinated disclosure).

## What is in scope

quelltest reads source code, copies projects into temporary directories, runs test commands and exposes tools to coding agents, so the interesting risks are:

- the verifier modifying, deleting or reading files outside the intended temporary copy (symlinks, path handling, cleanup);
- command or argument injection through file names, options, MCP tool arguments or examples files;
- the security gate on generated tests being bypassable (a generated test reaching the network, the process, the file system or code evaluation);
- prototype pollution or crashes of the long-running MCP server from crafted input;
- leaking secrets (for example into reports, SARIF files, handoff files or logs);
- the published package or its release workflow being tamperable.

## What is not a vulnerability

- **Running your own tests, or your `--command`, executes your code.** That is what `verify` is for. Do not run it on code you do not trust, the same as you would not run `npm test` on it.
- Wrong findings: false positives, missed defects and wrong generated tests are bugs, not vulnerabilities. Use the bug template.
- The `--llm` module and any model you connect: it is your code and your provider. quelltest itself sends nothing over the network.
- Findings about dependencies' dev-only advisories that do not ship in the package (we track them and update, but they are not exploitable through quelltest).

## How the project protects itself

CI runs on Linux, Windows and macOS; releases are created from tagged commits by a workflow with least-privilege permissions and, when the repository is public, npm provenance; no workflow uses `pull_request_target`; dependencies are updated through Dependabot. See [docs/automation.md](docs/automation.md).
