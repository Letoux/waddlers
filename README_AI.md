# Waddlers — AI development setup

This directory contains the agent instructions for Waddlers.

## Files

- `CLAUDE.md` — global Claude Code instructions.
- `AGENTS.md` — orchestration and specialist-agent policy.
- `.claude/agents/` — specialist subagents.
- `.claude/commands/` — planning/review/verification workflows.
- `docs/ai/` — durable AI workflow context.
- `scripts/install-ai-skills.sh` — installs the selected skills.sh baseline.

## First setup

1. Put these files at the root of the Waddlers repository.
2. Keep the existing `specs.md` at repository root.
3. Run:

```bash
chmod +x scripts/install-ai-skills.sh
./scripts/install-ai-skills.sh
```

4. Start Claude Code from the Waddlers repository root.
5. Begin with `/plan`.

## Important

The agent system deliberately separates reasoning from execution:

- Opus 5.5: planning, architecture, review, security, test-gap reasoning.
- Sonnet 5.5: implementation, test writing, browser verification.

The model names are the project's requested policy. If Claude Code exposes different canonical identifiers, map the aliases to the requested models in the local Claude configuration.

Do not replace `specs.md` with these files. `specs.md` remains the product source of truth.
