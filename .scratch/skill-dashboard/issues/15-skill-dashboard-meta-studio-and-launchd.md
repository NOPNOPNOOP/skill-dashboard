# Issue 15: Self-Hosted Meta-Studio (`launchctl` Keep-Alive Service, Ecosystem Matrix HTML App, `npx skills` Package Ops & Manifest Validator)

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #1, #6, #7, #36)

## What to build

Upgrade `skill-dashboard` itself into a comprehensive self-hosted Meta-Skill for managing the entire local skill ecosystem and its own background daemon lifecycle:

1. **macOS `LaunchAgent` Keep-Alive Service (`com.local.skill-dashboard.plist`)**:
   - Provide a script (`src/service-manager.ts`) and Playground actions to install, status-check, restart, or uninstall a macOS `launchctl` user service (`~/Library/LaunchAgents/com.local.skill-dashboard.plist`) with `RunAtLoad: true` and `KeepAlive: true` on port `8766` so the dashboard never goes offline unexpectedly.
2. **All-Skills Ecosystem Mount Matrix HTML View (`.dashboard/views/ecosystem_matrix.html`)**:
   - Build an interactive HTML App view for `skill-dashboard` displaying a full-screen searchable matrix of all 64+ local skills, their tags, provenance, and one-click mount toggles across `Claude Code`, `~/.agents (Codex/OpenCode/Pi)`, `OpenClaw`, and `Project (.claude)`.
3. **Manifest Validator & `npx skills` Lifecycle Actions (`skill-dashboard/.dashboard/manifest.yaml`)**:
   - Add live status probes (Ecosystem Health Summary & Server/LaunchAgent/SQLite Storage Diagnostics).
   - Add actions for validating all `.dashboard/manifest.yaml` files across skills (`src/validate-manifests.ts`), searching/installing community skills (`npx skills find` / `npx skills add`), generating a Studio manifest for unconfigured skills with Agent, and pruning old run logs.

## Acceptance criteria

- [x] `skill-dashboard/.dashboard/manifest.yaml` includes live probes, multi-level lifecycle/package/daemon actions, and the `⚡ Ecosystem Mount Matrix` HTML App view.
- [x] `bun run src/validate-manifests.ts` validates all installed `.dashboard/manifest.yaml` files and verifies referenced view/script files exist.
- [x] `src/service-manager.ts` can install and verify the macOS `launchctl` Keep-Alive agent on port `8766`.

## Blocked by

None - can start immediately
