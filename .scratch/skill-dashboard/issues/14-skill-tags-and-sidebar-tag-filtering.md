# Issue 14: Rich Skill Tags, Semantic Tag Inference & Left Sidebar Tag Cloud / Filter

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #15, #18)

## What to build

Give every skill a rich, meaningful set of `tags` and allow users to filter the skill catalog by tag in the left sidebar (or by clicking any tag chip on a skill card):

1. **Multi-Source Semantic Tag Inference (`src/cascade.ts` & `src/discovery.ts`)**:
   - Combine explicit `manifest.tags` and `SKILL.md` frontmatter `tags` with semantic domain tags inferred from the skill's id, provenance source (e.g., `mattpocock`, `obsidian`, `orca`, `codex-system`), and content keywords (`python`, `git`, `database`, `excel`, `tui`, `review`, `refactor`, `testing`, `markdown`, `writing`, `automation`, `browser`, `architecture`).
2. **Left Sidebar Tag Filter Bar & Clickable Skill Tag Chips (`src/ui/App.tsx`)**:
   - Display a scrollable/expandable Tag Filter bar in the left sidebar showing tags sorted by frequency (`#tag (count)`), supporting selecting/toggling active tag filters alongside search, ecosystem, and category filters.
   - Render `#tag` badges on skill cards in the sidebar and in the Skill Hero header; clicking any `#tag` badge filters the sidebar to that tag immediately.

## Acceptance criteria

- [x] Every discovered skill (both companion-configured and zero-config) has a clean set of 2–6 semantic tags.
- [x] The left sidebar provides a Tag filter bar with skill counts per tag and clear-filter controls.
- [x] Clicking any tag in the sidebar filter bar or on a skill card filters the skill list to matching skills.
- [x] Automated tests in `tests/server.test.ts` verify semantic tag extraction and deduplication.

## Blocked by

None - can start immediately
