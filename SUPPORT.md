# Getting help

| You want to | Do this |
| --- | --- |
| Learn how to use quelltest | Start with the [README](README.md), then [docs/agents.md](docs/agents.md) (agents and CI), and, from 0.3.1, `docs/dependencies.md` (code that calls APIs and services). `npx quell --help` lists every command and option. |
| Ask a usage question | Open an issue with the `question` label (or a GitHub Discussion if the repository has Discussions enabled). Include the command you ran and a few lines of the code involved. |
| Report a wrong finding, a wrong generated test or a crash | Use the **Bug report** form. A false positive or a missed defect with a small example is the most useful report there is. |
| Suggest a rule, check or command | Use the **Feature request** form. |
| Report a security problem | Do not open an issue: follow [SECURITY.md](SECURITY.md). |
| Report abuse or harassment | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): conduct@quelltest.com. |
| Contribute | [CONTRIBUTING.md](CONTRIBUTING.md). |

## Before you ask

- Run `npx quell --version` and make sure you are on the latest release.
- If a result looks wrong, run the command again with `--json` and attach the relevant finding.
- For `verify`, remember that it runs your tests: a failing baseline means the test itself fails on the original code, and the message shows the command it ran.

This is a volunteer-maintained project. We read every issue, but cannot promise a response time.
