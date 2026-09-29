# Waddlers — model policy

## Required model split

### Reasoning agents
Use Claude Opus 5.5 for:
- planning;
- architecture;
- code review;
- security review;
- test-gap analysis;
- complex debugging analysis;
- requirement/specification analysis.

### Execution agents
Use Claude Sonnet 5.5 for:
- implementation;
- test writing;
- browser verification;
- mechanical refactoring;
- migrations after an approved plan.

## Model identifier policy

The requested project policy is:

- reasoning: `opus` alias (Claude Opus 5.5, `claude-opus-5-5`)
- execution: `sonnet` alias (Claude Sonnet 5.5, `claude-sonnet-5-5`)

If the installed Claude Code version uses a different canonical model identifier, map the configured alias to the corresponding model instead of hard-coding an invalid identifier.

Do not silently replace Opus reasoning work with a cheaper model.

## Why

The goal is to spend the strongest reasoning capacity on decisions that affect the whole project, while using Sonnet for bounded implementation work with a precise handoff.
