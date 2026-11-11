# Issue 01: Markdown & Code Syntax Highlighting across Docs Viewer and File Tree Preview

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #13, #14, #19, #21)

## What to build

Deliver end-to-end syntax highlighting and rich Markdown formatting across both the **Knowledge & Docs (`SkillView`)** tab and the **File Tree Inspector** file preview pane:

1. **Syntax-Highlighted Code Blocks in Markdown Views**:
   - Enhance the Markdown rendering pipeline so fenced code blocks (`bash`, `sh`, `zsh`, `python`, `typescript`, `javascript`, `json`, `yaml`, `sql`, `html`, `diff`, etc.) render with full token syntax highlighting (keywords, strings, flags, comments, numbers, variables) and a language header bar with a one-click Copy button.
   - Enhance Markdown prose elements (headings, blockquotes/callouts, tables, inline code badges, task lists) with high-contrast dark-studio styling.
2. **Rendered Markdown & Highlighted Source Preview in File Tree Inspector**:
   - When a user selects a `.md` file in the File Tree Inspector, render it with the rich syntax-highlighted Markdown view by default and provide a toggle pill (`Preview` vs `Raw Source`).
   - When a user selects a code or config file (`.py`, `.ts`, `.tsx`, `.js`, `.sh`, `.json`, `.yaml`, `.yml`, `.sql`, `.toml`) in the File Tree Inspector, render the file content with syntax highlighting and line numbers.

## Acceptance criteria

- [x] Fenced code blocks inside `SKILL.md` and `references/**/*.md` render with distinct token-level syntax highlighting and language badges in the Knowledge & Docs tab.
- [x] Relative `.md` links and `/api/assets` image rewriting continue to work seamlessly inside syntax-highlighted Markdown documents.
- [x] Clicking a `.md` file in the File Tree Inspector displays a rendered, syntax-highlighted Markdown view with a toggle to switch between `Rendered Preview` and `Raw Source`.
- [x] Clicking source code files (`.py`, `.ts`, `.json`, `.yaml`, `.sh`) in the File Tree Inspector renders token-highlighted code with line numbers.
- [x] Frontend bundle (`bun run build:ui`) builds cleanly with zero external runtime failures, and server seam tests (`bun test`) pass.

## Blocked by

None - can start immediately
