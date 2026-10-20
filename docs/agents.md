# Using quelltest with coding agents and CI

Agents that write the code also write the tests that judge it. Prompts asking them to be rigorous do not hold up, so quelltest gives them (and your CI) tools that cannot be talked around:

| Check | Question it answers | Command |
| --- | --- | --- |
| `verify` | Would this test fail if the code were wrong? | `quell verify TEST --source FILE` |
| `gate` | Did this change weaken the tests (deleted, skipped, loosened assertions)? | `quell gate --diff REF` |
| `find --diff` | Which risky edges in my change have no real test? | `quell find --diff REF --coverage coverage/lcov.info` |

## As an MCP server

`quell mcp` speaks MCP over stdio (newline-delimited JSON-RPC) and exposes three tools: `find`, `verify`, `gate`. `verify` returns surviving mutants as a handoff the agent can act on by strengthening the test.

```bash
claude mcp add quelltest -- npx -y quelltest mcp
```

Any MCP client can launch `npx -y quelltest mcp`. Tool schemas are returned by `tools/list`.

## As a hook that blocks "done"

Claude Code runs a `Stop` hook before the agent finishes; exit code 2 blocks the stop and feeds stderr back to the agent. Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "npx quell gate --diff origin/main || exit 2" }
        ]
      }
    ]
  }
}
```

On Windows `cmd` the same line works (`||` and `exit 2` are supported). `quell gate` exits 5 when it finds weakened tests; the `|| exit 2` turns that into a blocking result.

To also require that the changed tests really catch faults, run verify on the test you just touched:

```bash
npx quell verify tests/pay.test.js --source src/pay.js --min-score 60 --handoff quell-handoff.md || exit 2
```

> The hook and MCP recipes follow the documented Claude Code hook and MCP conventions but have only been exercised here through the unit tests (`test/mcp.test.js`, `test/gate.test.js`) and a scripted stdio client, not inside a live Claude Code session. Treat them as a starting point.

## In pull requests

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npm ci
- run: npx quell gate --diff "origin/${{ github.base_ref }}"
- run: npx quell find src --diff "origin/${{ github.base_ref }}" --coverage coverage/lcov.info --sarif > quell.sarif
```

`--sarif` output can be uploaded with `github/codeql-action/upload-sarif` for inline annotations.

## Escape hatches (keep noise low)

- `// quell-ignore [rule,...]` on the line (or the line before): suppress a finding.
- `// quell-ignore-file`: skip a file.
- `// quell-ignore-mutant <reason>`: never mutate this line (equivalent mutants).
- `// quell-allow-weaken <reason>` inside a test: exempt it from `quell gate`.

## What the gate does and does not catch

Caught: removed or reduced assertions, deleted tests and test files, `skip`/`todo`/`x`-prefixed/`{ skip: true }` tests, `.only`, equality loosened to `ok`/truthy/defined/not-null, and (as a review item) changed expected values. Not caught: a test rewritten from scratch under a new name with different assertions, weakening done by changing the source instead, or logic inside helper functions that the test calls.
