# /verify

Perform final Waddlers verification.

1. Run the relevant unit/integration tests.
2. Run typecheck.
3. Run lint.
4. Run build when practical.
5. For UI changes, delegate to `waddlers-ui-verifier`.
6. For security-sensitive changes, delegate to `waddlers-security-auditor`.
7. Inspect the final diff.
8. Compare the result against specs.md.

Never claim a check passed unless it was executed.
