## What and why

<!-- One or two sentences. Link the issue: "Closes #123". -->

## Checklist

- [ ] Targets the default branch (stacked PRs are blocked by the PR guard)
- [ ] `npm run test:ci` passes
- [ ] Tests or eval fixtures cover the change; no assertion was weakened (`node src/cli.js gate --diff origin/main`)
- [ ] `CHANGELOG.md` updated if the change is user-visible
- [ ] Docs updated (README, `docs/`) if behaviour changed
- [ ] No secrets, token files or generated output committed
