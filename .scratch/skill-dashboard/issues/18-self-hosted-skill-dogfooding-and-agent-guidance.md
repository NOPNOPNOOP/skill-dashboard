# Issue 18: Self-Hosted Skill Dogfooding (`category`, `intermediate: true`, `{{manifest_cli}}`, Relative `defaultWorkspace`) & Agent Sync Prompt Integrity

Status: completed
Parent: `.scratch/skill-dashboard/PRD.md` (User Stories #79, #80)

## Problem Statement

1. **`ecosystem-health` DataNode & `manifest-cli` Actions Fail with `bunx` Lookup Error**:
   - `skills/skill-dashboard/.dashboard/modules/01-service-and-build.yaml` and `02-ecosystem-and-cli.yaml` invoke `bunx --bun manifest-cli ...`. Because `manifest-cli` is a local CLI script (`src/manifest-cli.ts`) rather than a published NPM package, `bunx` attempts to download `manifest-cli@latest` from the NPM registry and fails with `error: Package "manifest-cli" with tag "latest" not found`.
2. **`skill-dashboard` Own Actions Run in Wrong `cwd` (`skills/skill-dashboard` Instead of Repo Root)**:
   - After isolating the distributable skill into `skills/skill-dashboard/`, `skill.canonicalPath` (`{{skill_dir}}`) resolves to `<repo>/skills/skill-dashboard` (which has no `package.json`), and `defaultWorkspace: "~/.agents/skills/skill-dashboard"` does not resolve to the engine repository root `<repo>`. Consequently, `build-ui`, `run-tests`, `install-launchd`, `rebuild-and-restart`, `prune-logs`, and `uninstall-launchd` fail to locate `package.json` or `./src/`.
3. **Broken `SKILL.md` Path in `buildAgentManifestSyncPrompt` (`🤖 Fix / Ask Agent`)**:
   - `src/discovery.ts` resolves `skillGuidePath` via `resolve(import.meta.dir, "../SKILL.md")`, which points to the removed root `SKILL.md` (`exists: false`) instead of `skills/skill-dashboard/SKILL.md`.
4. **Missing Dogfooding & Authoring Rules for `intermediate: true`, `category`, Clean `rowActions`, and Per-Command `cwd`/`env`**:
   - `skill-dashboard`'s own `.dashboard/` lacks `category` and `intermediate: true` DataNodes, so its Playground does not showcase category filter pills or the `🔬 Intermediates (N)` switch.
   - `SKILL.md` Section 2 (Core Authoring Rules) and `references/04-*.md` need explicit rules for `intermediate: true` DAG fan-out, clean `rowActions` raw field bindings, and two-tier command environments, plus removal of the stale `~/.agents/skills/skill-dashboard/src/manifest-cli.ts` path reference.

## Solution

1. **Engine-Level `{{manifest_cli}}` & `{{dashboard_root}}` Variables + Relative `defaultWorkspace` Resolution**:
   - In `src/interpolator.ts` and `src/probes.ts`, support `{{dashboard_root}}` (the running Skill Dashboard engine root `resolve(import.meta.dir, "..")`) and `{{manifest_cli}}` (`bun <dashboard_root>/src/manifest-cli.ts`).
   - In `src/discovery.ts`, enhance `expandHomePath(p, homeDir, baseDir)` so relative `defaultWorkspace` values (like `"../.."`) resolve against `realPath`, and if `skill-dashboard`'s `defaultWorkspace` does not contain `package.json`, automatically fall back to the running engine root `resolve(import.meta.dir, "..")`.
2. **Fix `buildAgentManifestSyncPrompt` in `src/discovery.ts`**:
   - Resolve `skillGuidePath` to `resolve(import.meta.dir, "../skills/skill-dashboard/SKILL.md")` (with fallback to `join(skill.canonicalPath, "SKILL.md")`).
   - Include explicit instructions in the generated prompt for `intermediate: true`, `category`, per-command `cwd`/`python`/`envFile`/`env`, and clean `rowActions` argument bindings.
3. **Upgrade `skills/skill-dashboard/.dashboard/` to Dogfood All Core Features**:
   - Set `defaultWorkspace: "../.."` in `skills/skill-dashboard/.dashboard/manifest.yaml`.
   - In `modules/01-service-and-build.yaml`: tag all nodes with `category: "1. Service & Runtime"`, replace `bunx --bun manifest-cli validate` with `{{manifest_cli}} validate`, and set `cwd: project_root` on `build-ui`, `run-tests`, `install-launchd`, `rebuild-and-restart`, `prune-logs`, and `uninstall-launchd`.
   - In `modules/02-ecosystem-and-cli.yaml`: tag nodes with `category: "2. Skills & Ecosystem"`, introduce `skills-catalog-raw` (`intermediate: true`, `runtime: ts`) as the upstream DAG source node, and have `skills-catalog-table` and `studio-coverage-kpi` consume `ctx.data["skills-catalog-raw"]` via `sync.dependsOn`. Use `{{manifest_cli}}` in `manifest-cli-map` and `sync-target-skill`.
4. **Update `SKILL.md` & `references/01..04-*.md`**:
   - Expand `SKILL.md` Section 2 to 8 Core Authoring Rules (adding Rule 6: `intermediate: true` + `category`, Rule 7: clean `rowActions` raw field bindings & white-box audit, Rule 8: two-tier execution environment `cwd`/`python`/`envFile`/`env`).
   - Document `{{manifest_cli}}` and `{{dashboard_root}}`, and remove the stale `~/.agents/skills/skill-dashboard/src/manifest-cli.ts` path in `references/04-agent-hitl-scratchpads-and-modular-cli.md`.

## Acceptance Criteria

- [x] `buildAgentManifestSyncPrompt` resolves `skillGuidePath` to an existing `SKILL.md` file (`existsSync(guidePath) === true`) and mentions `intermediate: true`, `category`, and per-command `cwd`/`env`.
- [x] `{{manifest_cli}}` and `{{dashboard_root}}` interpolate cleanly in both `ActionItem` commands and `DataNode` commands.
- [x] `skill-dashboard`'s own `.dashboard/manifest.yaml` resolves `effectiveWorkspace` to the repository root containing `package.json`.
- [x] Evaluating all `DataNode`s of `skill-dashboard` succeeds (`status === "ready"` for all 6 nodes, including `ecosystem-health` and `skills-catalog-raw` with `intermediate: true` and `category` tags).
- [x] `SKILL.md` and `references/01..04-*.md` contain zero stale `~/.agents/skills/skill-dashboard/src/` paths and codify the 8 Core Authoring Rules.
- [x] `bun test` and `bun src/manifest-cli.ts validate` pass with 0 errors.
