## Problem

Teams need a reviewable signal, not only a stream of generated tests. The Python package exposes a Production Readiness Score and CI threshold. The npm version should make the result easy to consume in GitHub Actions and other CI systems.

## Acceptance criteria

- Define a documented score formula based on candidate outcomes, confidence, and verification status.
- Emit a versioned JSON schema with findings, gate results, score, counts, and tool version.
- Support `quell score --threshold N` with a stable non-zero exit code on failure.
- Provide a GitHub Actions example that uploads JSON and optionally comments on a PR without sending source code off-machine.
- Include an SVG badge command only after the score schema is stable.
- Add golden fixtures to prevent score drift.

## Research context

Community feedback calls out noisy CI logs, flaky tests, slow pipelines, and weak diagnostics; [Reddit discussion](https://www.reddit.com/r/javascript/comments/1pdxx20/askjs_whats_your_biggest_pain_point_with_cicd_for/) supports machine-readable, location-linked output.

