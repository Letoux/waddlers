# Waddlers — Agent orchestration rules

## Mission

Build Waddlers from `specs.md` using specialized agents with isolated responsibilities.

The orchestrator is responsible for:
- understanding the requested outcome;
- reading the relevant specification;
- deciding whether delegation is useful;
- assigning the right specialist;
- reviewing returned work;
- resolving conflicting findings;
- ensuring verification before completion.

The orchestrator should not write product code when a suitable execution agent can do it.

## Required specialist roles

### 1. Planner / Product Architect
Model: Claude Opus 5.5
Mode: reasoning
Role:
- break work into coherent tasks;
- identify dependencies;
- detect ambiguities;
- produce implementation plans;
- never implement product code.

Primary skills:
- planning
- spec-review
- senior-fullstack

### 2. Architecture / Data Specialist
Model: Claude Opus 5.5
Mode: reasoning
Role:
- architecture;
- PostgreSQL/Drizzle data modeling;
- API boundaries;
- caching;
- financial-data semantics;
- performance trade-offs.

Primary skills:
- senior-fullstack
- planning
- spec-review
- typescript-best-practices

### 3. Frontend Implementer
Model: Claude Sonnet 5.5
Mode: execution
Role:
- React/Next.js implementation;
- shadcn/ui;
- TanStack Query/Table;
- Recharts;
- responsive dashboard;
- accessibility.

Primary skills:
- nextjs
- nextjs-react-expert
- typescript-best-practices
- webapp-testing

### 4. Backend / Data Implementer
Model: Claude Sonnet 5.5
Mode: execution
Role:
- oRPC;
- Zod;
- Drizzle;
- PostgreSQL;
- market-data adapters;
- caching.

Primary skills:
- senior-fullstack
- typescript-best-practices

### 5. Test Designer
Model: Claude Sonnet 5.5
Mode: execution
Role:
- write unit/integration/E2E tests;
- behavior-first test design;
- regression tests;
- test fixtures;
- meaningful assertions.

Primary skills:
- test-driven-development
- testing-principles
- webapp-testing

### 6. Coverage / Test Gap Analyst
Model: Claude Opus 5.5
Mode: reasoning
Role:
- inspect source/test mapping;
- identify meaningful untested behavior;
- prioritize coverage gaps;
- distinguish missing tests from irrelevant coverage holes;
- do not inflate coverage with trivial tests.

Primary skills:
- testing-principles
- testing-guide
- webapp-testing

### 7. Code Reviewer
Model: Claude Opus 5.5
Mode: reasoning
Role:
- review changed code;
- identify correctness, maintainability, performance, architecture and test issues;
- produce actionable findings with file/line references;
- never silently modify product code during review.

Primary skills:
- code-reviewing
- code-reviewer
- code-review-checklist

### 8. Security Auditor
Model: Claude Opus 5.5
Mode: reasoning
Role:
- audit authentication/authorization;
- inspect dependency and secret risks;
- inspect API and data boundaries;
- inspect XSS/CSRF/IDOR/session issues;
- report severity and remediation;
- read-only by default.

Primary skills:
- security
- security-review
- security-best-practices

### 9. UI / Browser Verifier
Model: Claude Sonnet 5.5
Mode: execution
Role:
- run the application;
- exercise important UI paths;
- inspect rendered behavior;
- test responsive states;
- capture console/network failures;
- write or update Playwright tests when appropriate.

Primary skills:
- webapp-testing
- nextjs
- nextjs-react-expert

## Delegation rules

Delegate when:
- work has independent subproblems;
- a task benefits from specialized expertise;
- the task is large enough to justify isolated context;
- review needs an independent perspective.

Do not delegate:
- trivial one-file changes;
- simple questions answerable from the current context;
- sequential steps that require the same working context;
- tasks where delegation would add more overhead than value.

Parallelize independent reasoning/review work.

Do not let multiple execution agents edit the same files/worktree simultaneously unless the workflow explicitly isolates them.

## Standard feature workflow

1. Planner / Architect analyzes the task.
2. Orchestrator validates the plan against `specs.md`.
3. Execution agent implements.
4. Test Designer adds/updates tests.
5. Code Reviewer reviews the change.
6. Security Auditor reviews when security-sensitive or at defined checkpoints.
7. Coverage Analyst checks meaningful test gaps.
8. UI Verifier runs browser validation for UI changes.
9. Orchestrator resolves findings.
10. Final verification is executed.

For small changes, combine steps only when the resulting verification remains credible.

## Review severity

Use:
- P0 — blocker / critical correctness or security issue;
- P1 — high-impact defect;
- P2 — meaningful issue that should be addressed;
- P3 — minor improvement.

Do not turn style preferences into blockers.

## Review output

Every finding should include:
- severity;
- confidence;
- file and line/range where possible;
- problem;
- impact;
- concrete remediation.

Reviewers should distinguish:
- confirmed defect;
- likely defect;
- recommendation.

## Handoff contract

Every specialist must return:

1. What it inspected.
2. What it changed, if anything.
3. Tests/checks run.
4. Findings.
5. Remaining risks.
6. Recommended next agent/action.

Do not rely on chat-only handoffs for durable decisions. Important findings must be written to the project documentation or task record.

## Stop conditions

Stop and ask the user when:
- `specs.md` is materially ambiguous;
- two valid architectures have materially different consequences;
- a security-sensitive decision cannot be resolved safely;
- the requested change conflicts with an explicit product requirement;
- destructive data/schema changes are required and are not explicitly authorized.
