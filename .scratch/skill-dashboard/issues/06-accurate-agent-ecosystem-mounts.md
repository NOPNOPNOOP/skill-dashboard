# Issue 06: Accurate Multi-Agent Ecosystem Mount Matrix (`Auto via ~/.agents` vs Symlink Toggle & Relative Symlinks)

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #1, #2, #3, #7, #18)

## What to build

Align the **Agent Ecosystem Mounts** model end-to-end with the ground-truth discovery rules of `Claude Code`, `Codex`, `OpenCode`, `Pi`, `OpenClaw`, and `npx skills`:

1. **Distinguish Universal Hub Auto-Loaded Agents from Symlink-Mounted Agents**:
   - **Auto-Loaded via `~/.agents/skills` (`agents-hub`)**: Because `Codex`, `OpenCode`, and `Pi` natively scan `~/.agents/skills/`, any skill whose canonical path (or hub mount) is inside `~/.agents/skills/` is automatically active in `Codex`, `OpenCode`, and `Pi` without needing redundant symlinks in `~/.codex/skills` or `~/.pi/skills`.
   - **Symlink-Toggleable Agents**:
     - `Claude Code` (`~/.claude/skills`)
     - `OpenClaw` (`~/.openclaw/skills`)
     - `Current Workspace` (`<activeWorkspace>/.claude/skills`)
     - Secondary/optional symlink targets (`Continue`, `Trae`, `OpenCode Specific ~/.config/opencode/skills`) tucked behind a collapsible `+ More` toggle so they do not clutter the primary bar.
2. **Relative Symlink Creation Matching `npx skills`**:
   - When toggling a mount on in `toggleSkillMount`, create clean relative symlinks (e.g., `../../.agents/skills/<name>`) when both paths are under `$HOME`, matching `npx skills add`.
3. **Accurate Sidebar Ecosystem Filtering**:
   - Filtering by `Codex`, `OpenCode`, or `Pi` in the left sidebar includes all skills auto-loaded via `~/.agents/skills` in addition to each agent's dedicated system/user directories (`~/.codex/skills/.system`, `~/.pi/agent/skills`, `~/.config/opencode/skills`).

## Acceptance criteria

- [x] Skills located in `~/.agents/skills` display `Codex`, `OpenCode`, and `Pi` as active (`Auto via ~/.agents`) rather than misleading gray "unmounted" buttons.
- [x] Primary symlink toggle buttons (`Claude Code`, `OpenClaw`, `Workspace (.claude)`) accurately reflect and toggle symlinks using clean relative paths.
- [x] Secondary agent mounts (`Continue`, `Trae`) are collapsed under a `+ More` toggle by default.
- [x] Sidebar filter pills (`All`, `Claude`, `Codex`, `OpenCode`, `Pi`, `OpenClaw`, `Workspace`) filter skills according to each agent's true loading rules.
- [x] Automated tests in `tests/server.test.ts` verify relative symlink creation and multi-agent availability resolution.

## Blocked by

None - can start immediately
