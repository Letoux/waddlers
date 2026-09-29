#!/usr/bin/env bash
set -euo pipefail

# Run from the Waddlers repository root.
# This installs the baseline skills selected for the Waddlers agent system.

skills=(
  "https://github.com/davila7/claude-code-templates --skill planning"
  "https://github.com/abhattacherjee/claude-code-skills --skill spec-review"
  "https://github.com/borghei/claude-skills --skill senior-fullstack"
  "https://github.com/jezweb/claude-skills --skill nextjs"
  "https://github.com/frankxai/claude-skills-library --skill nextjs-react-expert"
  "https://github.com/alleneubank/claude-code --skill typescript-best-practices"
  "https://github.com/openai/plugins --skill test-driven-development"
  "https://github.com/shinpr/claude-code-workflows --skill testing-principles"
  "https://github.com/anthropics/skills --skill webapp-testing"
  "https://github.com/valorvie/custom-skills --skill testing-guide"
  "https://github.com/melodic-software/claude-code-plugins --skill code-reviewing"
  "https://github.com/jeffallan/claude-skills --skill code-reviewer"
  "https://github.com/davila7/claude-code-templates --skill code-review-checklist"
  "https://github.com/tartinerlabs/skills --skill security"
  "https://github.com/davila7/claude-code-templates --skill security-review"
  "https://github.com/davila7/claude-code-templates --skill security-best-practices"
)

for skill in "${skills[@]}"; do
  # shellcheck disable=SC2086
  npx skills add $skill
done

echo "Waddlers baseline AI skills installed."
