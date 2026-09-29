# /review

Run an independent Waddlers review.

1. Read CLAUDE.md, AGENTS.md and specs.md.
2. Inspect the current git diff/status.
3. Delegate to `waddlers-code-reviewer`.
4. If security-sensitive, delegate to `waddlers-security-auditor`.
5. If tests changed or the feature is important, delegate to `waddlers-coverage-analyst`.
6. Synthesize findings.
7. Do not silently modify code while reviewing.

Return findings with severity, confidence, location, impact and remediation.
