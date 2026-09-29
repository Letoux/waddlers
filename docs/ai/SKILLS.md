# Waddlers — Skills.sh baseline

The project uses skills.sh skills as reusable procedural context.

Install from the repository root with the skills CLI.

## Recommended baseline

### Planning / reasoning
```bash
npx skills add https://github.com/davila7/claude-code-templates --skill planning
npx skills add https://github.com/abhattacherjee/claude-code-skills --skill spec-review
npx skills add https://github.com/borghei/claude-skills --skill senior-fullstack
```

### Frontend
```bash
npx skills add https://github.com/jezweb/claude-skills --skill nextjs
npx skills add https://github.com/frankxai/claude-skills-library --skill nextjs-react-expert
npx skills add https://github.com/alleneubank/claude-code --skill typescript-best-practices
```

### Testing
```bash
npx skills add https://github.com/openai/plugins --skill test-driven-development
npx skills add https://github.com/shinpr/claude-code-workflows --skill testing-principles
npx skills add https://github.com/anthropics/skills --skill webapp-testing
npx skills add https://github.com/valorvie/custom-skills --skill testing-guide
```

### Code review
```bash
npx skills add https://github.com/melodic-software/claude-code-plugins --skill code-reviewing
npx skills add https://github.com/jeffallan/claude-skills --skill code-reviewer
npx skills add https://github.com/davila7/claude-code-templates --skill code-review-checklist
```

### Security
```bash
npx skills add https://github.com/tartinerlabs/skills --skill security
npx skills add https://github.com/davila7/claude-code-templates --skill security-review
npx skills add https://github.com/davila7/claude-code-templates --skill security-best-practices
```

## Agent-to-skill mapping

| Agent | Model | Skills |
|---|---|---|
| planner | Opus 5.5 | planning, spec-review, senior-fullstack |
| architect | Opus 5.5 | planning, spec-review, senior-fullstack, typescript-best-practices |
| frontend-implementer | Sonnet 5.5 | nextjs, nextjs-react-expert, typescript-best-practices, webapp-testing |
| backend-implementer | Sonnet 5.5 | senior-fullstack, typescript-best-practices |
| test-designer | Sonnet 5.5 | test-driven-development, testing-principles, webapp-testing |
| coverage-analyst | Opus 5.5 | testing-principles, testing-guide, webapp-testing |
| code-reviewer | Opus 5.5 | code-reviewing, code-reviewer, code-review-checklist |
| security-auditor | Opus 5.5 | security, security-review, security-best-practices |
| ui-verifier | Sonnet 5.5 | webapp-testing, nextjs, nextjs-react-expert |

The skills listed here were selected from skills.sh based on their stated scope. The project should periodically re-check the selected skills because skills.sh content evolves.

## Important

Skills are procedural context, not project requirements.

`specs.md` remains the product source of truth.
