# Waddlers — AI engineering system

This document explains how the repository's AI agents are expected to work.

## Context loading order

Every agent should load, in this order:

1. `CLAUDE.md`
2. `AGENTS.md`
3. `specs.md`
4. its role-specific prompt under `.claude/agents/`
5. the relevant skills
6. only then the source files relevant to the task

Do not load the entire repository into context by default.

## Context discipline

Agents should prefer:
- targeted file reads;
- targeted grep/search;
- relevant documentation;
- relevant tests;
- focused git diff.

Avoid:
- reading every source file;
- repeating large documents in prompts;
- copying source code into handoffs;
- carrying irrelevant history between agents.

## Reasoning versus execution

Reasoning agents produce:
- plans;
- architecture decisions;
- reviews;
- audits;
- test-gap analysis.

Execution agents produce:
- code;
- tests;
- configuration changes;
- migrations when authorized.

A reasoning agent must not quietly turn into an implementation agent.

## Fresh-context principle

Review agents should receive a fresh context whenever possible.

A reviewer should not simply approve the implementer's reasoning. It should independently inspect:
- the requirement;
- the changed code;
- the tests;
- relevant surrounding code.

## Financial-data invariant

The following are critical business invariants:

- currency is explicit;
- unavailable data is not zero;
- performance periods are well-defined;
- historical data must be date-consistent;
- cached data must have known freshness;
- provider failures must not create fabricated values;
- market-data source and timestamp must remain traceable.

## Test philosophy

Tests should prove behavior, not implementation details.

Prioritize:
1. financial calculations;
2. authorization/isolation;
3. market-data adapter behavior;
4. caching behavior;
5. API contracts;
6. core dashboard interactions;
7. edge cases.

Coverage percentage is not itself a quality target.

## Documentation updates

Update documentation when a task changes:
- architecture;
- data model;
- external integrations;
- caching policy;
- authentication/security model;
- important business rules.

Do not create documentation for trivial implementation details.
