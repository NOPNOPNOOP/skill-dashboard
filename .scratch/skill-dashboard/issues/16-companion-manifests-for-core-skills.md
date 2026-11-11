# Issue 16: Production `.dashboard/manifest.yaml` Companion Configurations for `refactor-review` & `data-migration-guard`

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #15, #22, #34)

## What to build

Author rich `.dashboard/manifest.yaml` companion configurations for the two core engineering audit skills in `~/.agents/skills/`:

1. **`refactor-review/.dashboard/manifest.yaml`**:
   - Configure custom SVG icon, semantic tags (`refactor`, `code-review`, `diff`, `html-report`, `architecture`), live Git status probe, and actions for:
     - Single Function / Git Slice Side-by-Side HTML Diff (`code_diff_reporter.py --old-file ... --new-file ...`)
     - Batch Manifest Panorama HTML & JSON Diff Report (`code_diff_reporter.py --manifest ...`)
   - Expose `SKILL.md` and `references/diff_manifest.json` in `views`.
2. **`data-migration-guard/.dashboard/manifest.yaml`**:
   - Configure custom SVG icon, semantic tags (`data-migration`, `etl`, `excel`, `ast-audit`, `zero-trust`), and structured actions for:
     - Full 3-Layer Migration & AST Audit (`audit_data_migration.py`) with dynamic file pickers and sheet/key parameters
     - Standalone Python Script AST Anti-Tamper Scan

## Acceptance criteria

- [x] `~/.agents/skills/refactor-review/.dashboard/manifest.yaml` and `~/.agents/skills/data-migration-guard/.dashboard/manifest.yaml` pass schema & file-existence validation (`src/validate-manifests.ts`).
- [x] Both skills appear in Skill Dashboard with `Studio` badges, custom icons, rich tags, and structured Playground forms.

## Blocked by

None - can start immediately
