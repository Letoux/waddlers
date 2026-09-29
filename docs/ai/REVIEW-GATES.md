# Waddlers — quality gates

## Gate 1: Specification

Before implementation:
- requirement is understood;
- no conflict with specs.md;
- acceptance criteria are explicit.

## Gate 2: Implementation

After implementation:
- relevant tests exist;
- type safety preserved;
- no unrelated changes;
- external data boundaries respected.

## Gate 3: Code review

Reviewer must independently inspect the diff.

Block on:
- incorrect financial calculations;
- data leakage;
- authorization bypass;
- fabricated financial data;
- critical runtime failure;
- broken migration;
- severe performance regression.

## Gate 4: Security

Security review is required for security-sensitive changes.

## Gate 5: Test gap

Critical business behavior must have meaningful tests.

## Gate 6: UI

UI changes must be verified in a real browser when practical.

## Gate 7: Final verification

The final agent/orchestrator must report actual commands and results.

A green test suite does not automatically prove the feature meets the specification.
