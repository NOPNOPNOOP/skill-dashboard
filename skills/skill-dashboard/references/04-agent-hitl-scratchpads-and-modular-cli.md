# 04. Agent HITL Scratchpads, Managed Folders & Modular `.dashboard` CLI Guide

This guide covers the end-to-end workflows for AI Agents (`Claude Code`, `Codex`, `Pi`, `OpenCode`) using `manifest-cli` to spawn interactive Human-in-the-Loop (HITL) scratchpads, inspect and configure arbitrary project folders, and maintain modular multi-file manifests.

---

## 1. CLI Command Reference (`manifest-cli.ts`)

Always invoke `manifest-cli.ts` via Bun using the canonical path `~/.agents/skills/skill-dashboard/src/manifest-cli.ts`:

```bash
# 1. Inspect an unconfigured folder or skill (outputs scripts, Makefile targets, Python venv, docs, env keys)
bunx --bun manifest-cli inspect <dir_path> [--json]

# 2. Initialize a starter .dashboard/manifest.yaml in a directory
bunx --bun manifest-cli init <dir_path> [--modular]

# 3. Print cross-file symbol map & bidirectional dependency graph (context, data, actions, views)
bunx --bun manifest-cli map <unit_id> [--json]
bunx --bun manifest-cli refs <unit_id> <symbol_id>

# 4. Run 3-Tier Validation (L1: Zod Schema, L2: Cross-file references & cycles, L3: TS/Python syntax & regex check)
bunx --bun manifest-cli validate [<unit_id>]

# 5. Evaluate reactive data nodes directly in the terminal
bunx --bun manifest-cli eval-data <unit_id> [node_id] [--context=k=v]

# 6. Split a monolithic manifest into vertical domain modules or print the linked bundle
bunx --bun manifest-cli split <unit_id> [--write]
bunx --bun manifest-cli bundle <unit_id>
bunx --bun manifest-cli schema [data|includes|action]

# 7. Manage Controlled Workspace Folders (~/.config/skill-dashboard/config.yaml)
bunx --bun manifest-cli folder list
bunx --bun manifest-cli folder add <dir_path> [--label "<Name>"]
bunx --bun manifest-cli folder remove <dir_path>

# 8. Ephemeral Agent Scratchpads & Synchronous HITL Wait
bunx --bun manifest-cli scratchpad create --id <slug> --title "<Title>" [--project <cwd>] [--manifest <yaml_file>]
bunx --bun manifest-cli scratchpad list
bunx --bun manifest-cli scratchpad promote <unit_id> --to project|skill
bunx --bun manifest-cli scratchpad delete <unit_id>
bunx --bun manifest-cli wait <unit_id> [--since <seq_or_ts>] [--timeout <sec>]
```

---

## 2. Playbook A: Spawning an Ephemeral Agent HITL Scratchpad Mid-Conversation

When chatting with a user who needs to visually inspect data, compare diffs, run parameterized operations, or approve/select rows before you proceed:

1. **Do NOT ask the user where to save the temporary console.**
   Run `scratchpad create`, which automatically places the console under `~/.cache/skill-dashboard/scratchpads/<project_slug>/<id>/` and binds `defaultWorkspace` (`{{project_root}}` and `{{python}}`) to the current project:
   ```bash
   bunx --bun manifest-cli scratchpad create \
     --id migration-review \
     --title "Migration Diff & Approval Console" \
     --project "$(pwd)"
   ```
2. **Customize `.dashboard/manifest.yaml` (and optional `.dashboard/views/*.html`)** inside the created scratchpad directory (`~/.cache/skill-dashboard/scratchpads/<project_slug>/migration-review/.dashboard/manifest.yaml`), then run:
   ```bash
   bunx --bun manifest-cli validate migration-review
   ```
3. **Share the Direct Deep Link with the User**:
   - Playground link: `http://127.0.0.1:8766/?id=migration-review`
   - Specific Action link: `http://127.0.0.1:8766/?id=migration-review&action=apply-fix`
   - Specific Custom HTML View link: `http://127.0.0.1:8766/?id=migration-review&tab=view:diff-board`
4. **Block Synchronously for Human Decision or Action Completion (`wait`)**:
   ```bash
   bunx --bun manifest-cli wait migration-review --timeout 300
   ```
   When the user clicks **✅ Approve & Resume Agent**, **✅ Submit Selected to Agent** on a table, calls `SkillDashboard.submitDecision(payload)`, or finishes running an action in the Web PTY, `wait` exits immediately (`0`) and prints the structured `UnitEvent` JSON to stdout!
5. **One-Click Promotion (`promote`)**:
   If the user likes the console and wants to keep it permanently:
   - Promote to the project's `<project_root>/.dashboard/` (and register in `📁 Managed Workspaces`):
     `bunx --bun manifest-cli scratchpad promote migration-review --to project`
   - Promote to a standalone global skill (`~/.agents/skills/migration-review`):
     `bunx --bun manifest-cli scratchpad promote migration-review --to skill`
   Both modes automatically migrate any persistent files in `{{data_dir}}` to the promoted unit!

---

## 3. Playbook B: Generating or Fixing `.dashboard` for Any Skill or Folder

When summoned via the Studio's **`🤖 Fix / Ask Agent` Drawer** (or when asked to configure an unconfigured folder/skill):

1. **Inspect Target Directory & Existing Symbols**:
   ```bash
   bunx --bun manifest-cli inspect <target_dir>
   bunx --bun manifest-cli map <unit_id>
   ```
2. **Respect Target Resolution Rules**:
   - If the unit already has a `.dashboard/manifest.yaml`, module file (e.g. `.dashboard/modules/ops.yaml`), or active override file, **edit that existing file incrementally using `Edit`**—never overwrite unrelated groups or views.
   - If the unit has no `.dashboard/manifest.yaml` (pure Layer 0 zero-config), create `<target_dir>/.dashboard/manifest.yaml`.
3. **Validate Before Finishing**:
   Always run:
   ```bash
   bunx --bun manifest-cli validate <unit_id>
   ```
   Ensure all L1 (Zod schema), L2 (cross-file `fromData`/`rowActions`/`dependsOn`/HTML `data-sd-widget` references), and L3 (`runtime: ts`/`python` syntax, `prelude: true`, and `fromStdout` regex validity) checks pass with `0` errors.

---

## 4. Playbook C: Explicit Modular `.dashboard/` Architecture (`includes`, `$include`, `defs` + `$ref`)

For units with `> 10` actions or multiple domains, split `.dashboard/manifest.yaml` into explicit domain modules (there is **no** hidden folder auto-scanning):

1. **Top-Level `includes: string[]` in `.dashboard/manifest.yaml`**:
   ```yaml
   id: my-suite
   name: "My Engineering Suite"
   category: "Engineering Tools"
   description: "Modular operations console"
   tsPrelude: true
   includes:
     - ./modules/01-database-ops.yaml
     - ./modules/02-release-ops.yaml
   defs:
     envSelect:
       key: env
       label: "Target Env"
       type: select
       flag: "--env"
       default: "uat"
       options:
         - { label: "UAT", value: "uat" }
         - { label: "PROD", value: "prod" }
   ```
2. **Domain Module File (`.dashboard/modules/01-database-ops.yaml`)**:
   Each module can co-locate its own `data:`, `actionGroups:`, `context:`, and `views:`, and reference shared definitions via `$ref: "#/defs/<key>"`:
   ```yaml
   data:
     - id: db-backups
       title: "DB Backups"
       runtime: glob
       pattern: ["{{data_dir}}/backups/*.sql"]
       shape: table

   actionGroups:
     - name: "1. Database Operations"
       actions:
         - id: db-restore
           title: "Restore Database"
           command: "./scripts/restore.sh {{form.env}} {{form.file}}"
           form:
             - $ref: "#/defs/envSelect"
             - key: file
               label: "Backup File"
               type: select
               positional: true
               fromData: "db-backups"
   ```
3. **Array-Level `- $include: "<path>"`**:
   You can also include fragments directly inside `data:`, `views:`, or `actionGroups:` arrays.
