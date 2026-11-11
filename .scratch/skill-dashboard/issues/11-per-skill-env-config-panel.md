# Issue 11: Per-Skill Environment Variable Configuration Panel (`env` / Secret Presets & Dotenv Injection)

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #15, #17, #22, #25)

## What to build

Allow each skill to declare required or optional environment variables (`envVars`) in its manifest and provide a dedicated **Environment & Workspace Config Panel** in the UI where users can configure per-skill environment variables (persisted locally in SQLite) that are automatically injected into every PTY action run and interactive shell session for that skill:

1. **Manifest Schema & SQLite Storage for Per-Skill Environment Variables**:
   - Extend `SkillManifestSchema` with optional `envVars?: Array<{ key: string; label?: string; description?: string; default?: string; secret?: boolean; placeholder?: string }>`.
   - Store user-configured per-skill environment values in SQLite (`settings` table under `skill_env:<skillId>`) and allow adding arbitrary custom `KEY=VALUE` pairs per skill in the UI.
   - Automatically scan `SKILL.md` in `ZeroConfigHeuristic` for `export VAR=...` or `ENV_VAR` patterns to pre-populate helpful env variable hints.
2. **Automatic Subprocess & Interactive Shell Injection**:
   - Whenever an action or interactive shell runs for `skillId`, merge the skill's `manifest.envVars` defaults + user's saved `skill_env:<skillId>` overrides into the PTY process environment (and into the `ZDOTDIR` `.zshrc` shim for interactive shells).
   - Mask any variable marked `secret: true` (or matching `KEY|TOKEN|SECRET|PASSWORD`) in UI previews.

## Acceptance criteria

- [x] `SkillManifestSchema` supports `envVars` declarations, and `vsip/.dashboard/manifest.yaml` declares common VSIP environment controls (`ENV`, `DC_ENABLED`, `VSIP_WORKSPACE`).
- [x] The UI provides a Per-Skill Environment & Workspace Config drawer/panel where users can edit declared `envVars` and add custom `KEY=VALUE` pairs for the selected skill.
- [x] Saved per-skill environment variables persist in SQLite across restarts and are automatically injected into both action PTY runs and `+ Interactive Shell` sessions for that skill.
- [x] Automated tests in `tests/server.test.ts` verify saving per-skill environment variables via API and reading them inside a spawned PTY subprocess.

## Blocked by

None - can start immediately
