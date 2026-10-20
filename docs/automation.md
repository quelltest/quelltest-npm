# Repository automation ("agents")

Small GitHub Actions workflows that do the routine work so a change goes from idea to release with fewer manual steps. Two kinds:

- **Deterministic agents** run today, need no secrets and never call a model.
- **Claude agents** answer `@claude` and review pull requests. They are **off until you switch them on** (below).

| Agent | Workflow | Trigger | What it does |
| --- | --- | --- | --- |
| Label issues | `agent-triage-issues.yml` | issue opened/edited | Labels an issue from its conventional-commit title (`fix(scan): ...` -> `bug`, `scan`) and assigns the maintainer. Creates missing labels. |
| Label pull requests | `agent-triage.yml` | PR opened/updated | Labels a PR from the paths it touches (`scan`, `generate`, `verify`, `gate`, `mcp`, `dependencies`, `cli`, `documentation`, `testing`, `ci`). Creates missing labels. |
| PR guard | `agent-pr-guard.yml` | PR opened/edited/updated | **Fails** when the PR targets a branch other than the default (a stacked PR merged into its base never reaches `main` and never closes its issues). Warns when there is no `Closes #n`, when `src/` changed without `CHANGELOG.md` or tests, and when the description carries an attribution line. |
| Quelltest gate and report | `pr-report.yml` | PR | Runs quelltest on changed lines, gates against weakened tests, comments the report. |
| Release | `agent-release.yml` | tag `v*` | Checks the tag against `package.json` and the changelog, runs `npm run test:ci`, publishes to npm if `NPM_TOKEN` exists (with provenance when the repo is public), creates the GitHub release from the changelog section. |
| Stale | `agent-stale.yml` | daily | Marks issues stale after 60 days and PRs after 21; exempts `P0`, `P1`, `security`, `tracking`, `pinned`. |
| Dependencies | `dependabot.yml` | weekly | npm and GitHub Actions updates, dev tooling grouped. |
| `@claude` | `agent-claude.yml` | `@claude` in an issue, PR or review comment; issue assigned to `claude` | Explains code, makes a fix on a branch, opens a PR, following the repo rules. |
| PR review | `agent-pr-review.yml` | PR opened/updated/ready | Reviews for correctness, vacuous or weakened tests, scanner precision and repo rules. Leaves approval to a human. |

Issue forms (`.github/ISSUE_TEMPLATE`), the PR template and `CODEOWNERS` keep reports and PRs consistent.

## Switching the Claude agents on

1. Install the Claude GitHub app and add the secret: in Claude Code run `/install-github-app` (needs repository admin), or add the `ANTHROPIC_API_KEY` secret by hand and install the app from the action's setup page.
2. Set the repository **variable** `CLAUDE_AGENTS_ENABLED` to `true` (Settings -> Secrets and variables -> Actions -> Variables). Until then both workflows skip.
3. Optional: set `DEFAULT_ASSIGNEE` (variable) if issues should be assigned to someone other than the repository owner.

To switch them off again, delete the variable or set it to anything but `true`.

## Releasing

```bash
# 1. bump version in package.json and package-lock.json, add "## X.Y.Z" to CHANGELOG.md, merge
git tag vX.Y.Z && git push upstream vX.Y.Z
```

The release agent does the rest. Add the repository secret `NPM_TOKEN` (a granular token with publish rights for `quelltest`; if your npm account enforces 2FA for publishing it must be a token that is allowed to bypass it). Without the secret it still creates the GitHub release and tells you to publish by hand.

## Protecting `main`

`.github/branch-protection.json` holds the recommended rules; apply them once (needs repository admin):

```bash
gh api -X PUT repos/quelltest/quelltest-npm/branches/main/protection --input .github/branch-protection.json
```

What it sets: no force-pushes, no deletion of `main`, changes must come through a pull request (zero approvals required, so a solo maintainer can still merge), and the Linux Node 22/24, Windows and Python checks must pass. Admins are not forced to follow the rules, so a hotfix is still possible.

It deliberately does **not** require the macOS job (GitHub-hosted macOS runners were short on capacity when this was written; a required job that never starts blocks every merge) or the PR guard (add `guard` to `contexts` once the guard workflow is on `main`). Add them to `required_status_checks.contexts` when you want them enforced. If you rename a CI job, update the names here: a required check that no longer exists blocks merging.

In the web UI the same thing is Settings -> Branches -> Add branch protection rule (or the "Protect this branch" button on the repository page): branch `main`, tick "Require a pull request before merging" (0 approvals), "Require status checks to pass before merging" and select the checks above, leave "Allow force pushes" and "Allow deletions" unticked.

## Safety design

- No workflow uses `pull_request_target`, and no privileged job checks out code from a fork. The Claude workflows skip fork PRs; the triage workflow skips them for the PR job.
- Every workflow declares its `permissions:` explicitly (least privilege), and every action is pinned to a major version.
- The Claude agents run with an allow-list of tools (read, search, edit, and a few `git`, `npm test` and `node src/cli.js` commands) and a system prompt that forbids publishing, merging, adding attribution lines and committing secrets. They cannot merge: merging stays a human decision.
- Agents propose; deterministic checks decide. The quelltest gate and CI results are the evidence a human reviews.

## Limits

- The Claude workflows follow the documented inputs of `anthropics/claude-code-action@v1` (`anthropic_api_key`, `prompt`, `claude_args`, `trigger_phrase`), but they have not been run against a live repository from here: expect to adjust them on first use, and watch the cost of the review agent on large PRs.
- `Agent: PR review` shows as **Skipped** on every pull request until you set the repository variable `CLAUDE_AGENTS_ENABLED=true` (and the `ANTHROPIC_API_KEY` secret). That is the opt-in switch working, not a failure. GitHub cannot hide a skipped job, and the variable cannot be read in a workflow trigger.
- The triage agent only understands conventional-commit titles. Anything else is left unlabelled.
- The release agent cannot create the tag and cannot get around npm's two-factor rules.
