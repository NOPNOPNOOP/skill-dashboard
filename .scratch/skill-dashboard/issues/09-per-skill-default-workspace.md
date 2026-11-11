# Issue 09: Per-Skill Default Workspace (`defaultWorkspace`) in Manifest & SQLite with Automatic Workspace Resolution

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #15, #17, #25, #26)

## What to build

Give every skill its own independent default workspace (`defaultWorkspace`) so that switching between skills (e.g., `vsip` vs `skill-dashboard` vs another repo's skill) automatically switches the effective `{{project_root}}` and `{{python}}` virtualenv without manual reconfiguration:

1. **Manifest & Persistence Support for Per-Skill Default Workspace**:
   - Extend `SkillManifestSchema` / `SkillManifest` with an optional `defaultWorkspace?: string` field (supporting absolute paths or `~/...`).
   - Store user-selected per-skill workspace overrides in SQLite (`settings` table keyed by `skill_workspace:<skillId>`) so changing the workspace while a skill is selected remembers that workspace specifically for that skill (with an option to also apply globally or save to `manifest.yaml`).
   - Resolution priority for a skill's effective workspace:
     1. User's saved per-skill workspace in SQLite (`skill_workspace:<skillId>`)
     2. `skill.manifest.defaultWorkspace` (from Layer 3 / Layer 2 / Layer 1 `.dashboard/manifest.yaml`)
     3. Server's global fallback `activeWorkspace`
2. **Automatic UI & Command Interpolation Binding**:
   - Each `CanonicalSkill` returned by `/api/bootstrap` includes its resolved `effectiveWorkspace` and `pythonExecutable`.
   - When the user clicks a different skill in the left sidebar, the header workspace badge and `{{python}}` indicator immediately reflect that skill's effective workspace, and all command previews, PTY executions, and interactive shells for that skill run inside its bound workspace.

## Acceptance criteria

- [x] `SkillManifestSchema` supports `defaultWorkspace?: string`, and `demo/.dashboard/manifest.yaml` sets `defaultWorkspace` to its workspace while `skill-dashboard/.dashboard/manifest.yaml` sets `defaultWorkspace` to `~/Projects/skill-dashboard`.
- [x] Selecting a skill in the UI automatically switches the active workspace and `{{python}}` indicator to that skill's bound workspace.
- [x] Changing the workspace in the UI binds the chosen directory to the currently selected skill in SQLite (persisting across restarts) and updates command previews and PTY execution immediately.
- [x] Automated tests in `tests/server.test.ts` verify that two different skills resolve and execute against two different default workspaces and `.venv/bin/python` interpreters independently.

## Blocked by

None - can start immediately
