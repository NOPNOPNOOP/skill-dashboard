# Issue 13: Agent-Driven `.dashboard/manifest.yaml` Incremental Sync, Generation Workflow & Live File Watch

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #8, #15, #17, #35, #36)

## What to build

Delegate all `.dashboard/manifest.yaml` authoring and updates to an AI Coding Agent (`Claude Code` / `Codex`) using a fast **Incremental Edit Protocol**—never brittle regex auto-merging—paired with automatic filesystem change detection:

1. **Agent Manifest Authoring & Incremental Sync Protocol (`skill-dashboard/SKILL.md` & `vsip/SKILL.md`)**:
   - Document the complete `.dashboard/manifest.yaml` schema contract and the **Fast Incremental Update Protocol** in `skill-dashboard/SKILL.md`:
     - **Init Mode** (when `<skill>/.dashboard/manifest.yaml` does not exist): Inspect `SKILL.md` and scripts/tools, and author a structured multi-level `manifest.yaml` (`Group` $\rightarrow$ `Subgroup` $\rightarrow$ `Action`, `defaultWorkspace`, `envVars`, `views`).
     - **Incremental Update Mode** (when `<skill>/.dashboard/manifest.yaml` already exists): Inspect only what changed in `SKILL.md` or `tools/` (via `git diff` or targeted section comparison) and use targeted `Edit` replacements on `.dashboard/manifest.yaml` without regenerating unchanged actions.
   - Add the maintenance rule to `vsip/SKILL.md` so any agent modifying `vsip` tools or `SKILL.md` synchronously updates `vsip/.dashboard/manifest.yaml`.
2. **UI `✨ Agent Sync Manifest` Action & Live Disk Refresh**:
   - Add an **`✨ Agent Sync Manifest`** button in the Skill Hero / Manifest Studio that can either:
     - Launch `claude` / `codex` directly in the Web PTY with a targeted prompt to initialize or incrementally sync `<skill>/.dashboard/manifest.yaml`, or
     - Copy the targeted Agent prompt to the clipboard.
   - Add lightweight filesystem `mtime` / `fs.watch` invalidation on the server so as soon as the Agent finishes editing `manifest.yaml` or `SKILL.md` on disk, the Dashboard automatically serves the fresh state without restarting.

## Acceptance criteria

- [x] `skill-dashboard/SKILL.md` documents the full `.dashboard/manifest.yaml` schema and the Incremental Edit Protocol for agents, and `vsip/SKILL.md` includes the synchronous manifest maintenance guideline.
- [x] Every skill in the UI exposes an `✨ Agent Sync Manifest` control (supporting one-click Web PTY agent invocation or prompt copy) tailored to whether the skill needs initial manifest generation or incremental sync.
- [x] Modifying `SKILL.md` or `.dashboard/manifest.yaml` on disk automatically invalidates the server's discovery cache so subsequent requests reflect the latest file contents immediately.
- [x] Automated tests in `tests/server.test.ts` verify automatic cache invalidation when `SKILL.md` or `.dashboard/manifest.yaml` is modified on disk and verify agent sync prompt/command generation.

## Blocked by

None - can start immediately
