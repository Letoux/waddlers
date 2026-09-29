# Waddlers — recommended development workflow

## Feature lifecycle

### A. Plan

Use `/plan`.

Expected output:
- requirement interpretation;
- architecture impact;
- task breakdown;
- test strategy;
- risks.

### B. Implement

Use `/implement`.

Execution agent should be Sonnet 5.5.

### C. Test

Use the test designer for meaningful behavioral tests.

### D. Review

Use `/review`.

Review agents should have fresh context.

### E. Security

Mandatory for:
- authentication;
- authorization;
- external API credentials;
- user isolation;
- session changes;
- sensitive data;
- new endpoints accepting user input.

### F. Verify

Use `/verify`.

## Recommended delegation sequence

```text
User request
    |
    v
Planner (Opus)
    |
    v
Architect (Opus) -- only when architecture/data impact exists
    |
    v
Implementer (Sonnet)
    |
    +--> Test Designer (Sonnet)
    |
    v
Code Reviewer (Opus)
    |
    +--> Security Auditor (Opus, when relevant)
    |
    +--> Coverage Analyst (Opus, when relevant)
    |
    +--> UI Verifier (Sonnet, for UI work)
    |
    v
Orchestrator
    |
    v
Final verification
```

## Parallelization

These can often run in parallel after implementation:
- code review;
- security audit;
- coverage analysis.

UI verification can run in parallel with static review if the application is available.

Do not parallelize two agents that edit the same files.

## Handoff format

Every agent should return:

```text
## Result
...

## Files changed
...

## Checks run
...

## Findings
...

## Remaining risks
...

## Next action
...
```

## Context reset

When a task becomes long or the agent starts repeating itself:
- summarize durable findings;
- write them to the appropriate project documentation/task record;
- start a fresh context;
- reload only the necessary documents.

Do not compensate for context loss by copying the entire repository into the prompt.
