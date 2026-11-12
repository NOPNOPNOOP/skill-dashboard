---
name: skill-dashboard
description: >-
  Launch and manage the Multi-Agent Skill Dashboard & Interactive Operations Studio (Web UI + Native PTY + Agent HITL Console)
  for all local skills, managed project folders, and ephemeral Agent scratchpads across Claude Code, Codex, OpenCode, Pi, OpenClaw, and .agents.
  Use when the user mentions "skill-dashboard", "skill dashboard", "skills studio", asks to create/fix/sync a .dashboard/manifest.yaml,
  or needs an interactive Human-in-the-Loop (HITL) console / scratchpad in the browser.
---

# Skill Dashboard Studio (`skill-dashboard`)

A local full-stack Web Studio, Reactive Polyglot Compute Graph, Universal Local Operations Console (`Scratchpads / Workspaces / Skills`), and interactive PTY execution engine built on **TypeScript + Bun**.

---

## 1. Installation (`npx skills`) & Quick CLI Invocations

Install globally via `npx skills`:
```bash
npx skills add NOPNOPNOOP/skill-dashboard --skill skill-dashboard -g
```

Launch the Skill Dashboard server and open the browser UI (defaults to `http://127.0.0.1:8766` and reuses an existing running instance):

```bash
# 1. Start dashboard (or open browser if already running)
# Uses bunx zero-install, or globally installed `skill-dashboard`
bunx --bun skill-dashboard [--port 8766] [--workspace <path>] [--no-open]

# 2. Inspect & Scaffold Unconfigured Folders or Zero-Config Skills
bunx --bun manifest-cli inspect <dir_path> [--json]
bunx --bun manifest-cli init <dir_path> [--modular]

# 3. Manifest Symbol Graph, Cross-File Reference Tracker & 3-Tier Validator CLI
bunx --bun manifest-cli map <unit_id> [--json]
bunx --bun manifest-cli refs <unit_id> <symbol_id>
bunx --bun manifest-cli validate [<unit_id>]
bunx --bun manifest-cli eval-data <unit_id> [node_id] [--context=k=v]
bunx --bun manifest-cli split <unit_id> [--write]
bunx --bun manifest-cli bundle <unit_id>
bunx --bun manifest-cli schema [data|includes|action]

# 4. Ephemeral Agent HITL Scratchpads & Synchronous Wait
bunx --bun manifest-cli scratchpad create --id <slug> --title "<Title>" [--project <cwd>]
bunx --bun manifest-cli wait <unit_id> [--since <seq_or_ts>] [--timeout 120]
bunx --bun manifest-cli scratchpad promote <unit_id> --to project|skill
bunx --bun manifest-cli scratchpad list
bunx --bun manifest-cli scratchpad delete <unit_id>

# 5. Manage Controlled Workspace Folders (~/.config/skill-dashboard/config.yaml)
bunx --bun manifest-cli folder add <dir_path> [--label "<Name>"]
bunx --bun manifest-cli folder list
bunx --bun manifest-cli folder remove <dir_path>
```

---

## 2. Core Authoring Rules & Target Resolution Protocol

1. **Smart Target File Resolution (Existing First, Companion Fallback)**:
   - **If a configuration file already exists**: Edit the **existing** defining file in place (if the target symbol comes from a module file such as `.dashboard/modules/01-ops.yaml`, edit that module file directly; otherwise edit the existing override or `<unit_dir>/.dashboard/manifest.yaml`). **NEVER overwrite or flatten an existing manifest from scratch**—use targeted `Edit` operations.
   - **If no configuration file exists yet (Layer 0 Zero-Config)**: Create **`<unit_dir>/.dashboard/manifest.yaml`** (and optional `.dashboard/views/*.html` or `.dashboard/modules/*.yaml`).
2. **Mandatory 3-Tier Validation**:
   - Always run `bunx --bun manifest-cli validate <unit_id>` after creating or editing any manifest or module file until L1 (Zod schema), L2 (cross-file references & cycles), and L3 (TS/Python syntax, `prelude: true`, and `fromStdout` regexes) pass with `0` errors.
3. **Never Pollute `{{skill_dir}}` or `/tmp` with Runtime Outputs**:
   - Always write persistent state/backups to **`{{data_dir}}`** (`$SD_DATA_DIR` $\rightarrow$ `~/.local/share/skill-dashboard/units/<id>`), caches to **`{{cache_dir}}`** (`$SD_CACHE_DIR`), and per-run reports/exports to **`{{artifacts_dir}}`** (`$SD_ARTIFACTS_DIR` $\rightarrow$ `~/.local/share/skill-dashboard/artifacts/<id>/<run_id>`).
4. **Clean Multi-Line Scripts (`script: |`)**:
   - Never chain multi-line shell commands with `&& \`. Use `script: |` block scalars; the engine executes multi-line scripts in `~/.cache/skill-dashboard/runtime/scripts/sd-script-<runId>.sh` with `#!/bin/zsh` and `set -e` enabled automatically.
5. **Explicit `prelude: true` for TypeScript Data Nodes**:
   - Whenever authoring `runtime: ts` or `transform: ts` blocks that use `fs`, `path`, `os`, `Database`, `YAML`, or `$`, explicitly set `prelude: true` on the node (or `tsPrelude: true` at the manifest root).

---

## 3. Architecture Quick Reference

### 3.1 Top-Level `SkillManifest` Fields
| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Yes | Unique unit identifier matching the folder name (e.g. `vsip`, `jev`). |
| `name` | `string` | Yes | Human-readable display title in the Studio UI. |
| `category` | `string` | Yes | `Data & Platform` \| `Quality & Review` \| `Knowledge & Docs` \| `Agent & Automation` \| `Design & Visualization` \| `Engineering Tools`. |
| `description` | `string` | Yes | Concise 1–2 sentence summary. |
| `defaultWorkspace` | `string` | No | Default environment preference (`Default cwd:`). Commands inherit this unless overridden via per-command `cwd` or UI `⚙️ Env`. |
| `tsPrelude` | `boolean` | No | Default `prelude: true` for all TypeScript `data` nodes and `transform`s. |
| `includes` / `defs` | `string[]` / `object` | No | Explicit modular YAML includes and reusable `$ref: "#/defs/<key>"` definitions. |
| `envVars` | `SkillEnvVar[]` | No | Default environment variables preference (`Default Env (N)`), injected into commands unless overridden. |
| `context` | `ContextField[]` | No | Global reactive state switchers (`select`, `toggle`, `text`) rendered in the top toolbar (`{{context.<key>}}`). |
| `data` | `DataNode[]` | No | Polyglot reactive data nodes (`ts`, `python`, `sqlite`, `glob`, `file`, `zsh`, `passive`) producing `scalar`, `kv`, `list`, `table`, `matrix`, `stream`, or `raw` widgets. Supports `category` tabs, `intermediate: true` upstream DAG source nodes, and per-node `cwd`/`python`/`envFile`/`env`. |
| `views` | `SkillView[]` | No | Markdown docs (`type: markdown`) and Custom HTML App Views (`type: html` with `window.SkillDashboard` Bridge 2.0). |
| `actionGroups` | `ActionGroup[]` | No | Hierarchical operational groups (`Group` $\rightarrow$ `subgroup` $\rightarrow$ `ActionItem`). Supports per-action `cwd`/`python`/`envFile`/`env`. |

### 3.2 Template Variables & Flag Auto-Binding
- **`{{python}}`**: Auto-detects nearest `.venv/bin/python` from the command's own resolved `cwd` first (walking up to 4 parent dirs), before falling back to `<effectiveWorkspace>/.venv/bin/python` or `python3`.
- **`{{skill_dir}}`**: Canonical absolute path of the unit directory.
- **`{{project_root}}`**: Bound `effectiveWorkspace` (skill default preference).
- **`{{data_dir}}`** (`$SD_DATA_DIR`), **`{{cache_dir}}`** (`$SD_CACHE_DIR`), **`{{artifacts_dir}}`** (`$SD_ARTIFACTS_DIR`).
- **`{{context.<key>}}`** & **`{{data.<nodeId>.*}}`**.
- **`{{form.<key>}}`**:
  - Named `flag: "--env"` expands to `--env <escaped>` when non-empty and `""` when blank.
  - Boolean `flag: "--dry-run"` expands to `--dry-run` when `true` and `""` when `false`.
  - Positional `positional: true` expands to `<escaped>` directly.
  - Any `FormField` not explicitly referenced via `{{form.<key>}}` is automatically appended when non-empty.

### 3.3 Supported `FormField` Types
`text` | `number` | `boolean` | `select` (supports `options`, `fromData: "<dataNodeId>"`, or `dataSource`) | `multi-select` | `file` | `directory` | `env-secret` | `code` | `date`. Supports conditional visibility via `when: { field: "<other_key>", equals: <val> }`.

### 3.4 3-Channel Run Artifact Pipeline (`artifacts:`)
1. **Channel 1 (Explicit YAML `ActionItem.artifacts` Rules)**:
   - `path: "{{form.out}}"` (interpolated template) or `fromStdout: "Saved to (?<path>\\S+\\.html)"` (ANSI-stripped regex verified with `mtimeMs >= startedAt - 1000`), with `label`, `kind` (`html | file | json | image | markdown`), and `onComplete: "badge" | "open" | "download"`.
2. **Channel 2 (`::artifact` Stdout Marker)**: `::artifact path=/path/to/file.html label="Report" onComplete=open`.
3. **Channel 3 (`{{artifacts_dir}}` Directory Scan)**: Automatic collection of all files written to `$SD_ARTIFACTS_DIR`.

### 3.5 Per-Command Execution Environment & Default Workspace Preference Inheritance
- **Skill Default Preference**: Root `defaultWorkspace` and `envVars` establish the default workspace (`Default cwd:`) and environment variables (`Default Env`) for the skill.
- **Command-Level Overrides**: Every `ActionItem` and `DataNode` can declare its own execution environment:
  - `cwd`: Independent working directory (`"project_root"` \| `"skill_dir"` \| custom path with `~` / relative paths).
  - `python`: Custom Python executable or auto-detected `.venv/bin/python` relative to the command's own `cwd`.
  - `envFile`: Optional `.env` dotenv file relative to the command's `cwd`.
  - `env`: Key-value environment variable overrides specific to that command.
- **Interactive `⚙️ Env` Studio UI**:
  - Every Action card and DataNode card features a compact `⚙️ Env` button.
  - Displays `⚙️ Env` when inheriting defaults, and highlights with `⚙️ Custom Env` when overridden.
  - Inline `CommandEnvEditor` panel provides directory autocomplete, quick-fill chips, and controls to Apply, Save to `manifest.yaml`, Reset to Default, or set `cwd` as the Skill Default Preference.

## 4. Progressive Knowledge References (Deep-Dive Manuals)

Consult the modular reference manuals under `references/` for exhaustive schemas, `ctx` signatures, Bridge 2.0 APIs, and Agent playbooks:

1. **Manifest Schema, Action Groups, Forms, Interpolation & 3-Channel Artifacts**:
   [`references/01-manifest-and-actions-spec.md`](references/01-manifest-and-actions-spec.md)
   - Complete `SkillManifest`, `ActionItem`, and `FormField` property dictionaries, quote-aware interpolation rules, multi-line `script: |` execution, safety gates (`danger: safe|warn|danger`, `requiresHumanApprovalFlag`), and 3-channel artifact rules.
2. **Reactive Data Graph, Polyglot Runtimes, Parsers & Interactive Widgets**:
   [`references/02-reactive-data-graph-and-parsers.md`](references/02-reactive-data-graph-and-parsers.md)
   - Global `context:`, 7 `DataNode` runtimes (`ts` with `prelude: true`, `python` `def main(ctx):`, `sqlite` `$context_<key>`, `glob`, `file`, `zsh`, `passive`), the exact `ctx` object contract, `category` filter tabs, `intermediate: true` upstream DAG source nodes (with `sync.dependsOn` fan-out to `runtime: ts`), 9 `parse` formats, 7 `shape`s (`scalar`, `kv`, `list`, `table`, `matrix`, `stream`, `raw`), `rowActions`/`bulkActions`/`cellAction`, and `ActionItem.output.intoData` recursion.
3. **Custom HTML App Views (`type: html`) & `window.SkillDashboard` Bridge 2.0 SDK**:
   [`references/03-custom-html-views-and-bridge-sdk.md`](references/03-custom-html-views-and-bridge-sdk.md)
   - Zero-JS declarative HTML mounting (`data-sd-context-bar`, `data-sd-widget`, `data-sd-action`), full `window.SkillDashboard` JS SDK (`getContext`, `setContext`, `data`, `subscribe`, `runAction`, `prefillAction`, `runInTerminal`, `submitDecision`, `on`), theme adaptation, and a starter HTML template.
4. **Agent HITL Scratchpads, Managed Folders & Modular `.dashboard` CLI Guide**:
   [`references/04-agent-hitl-scratchpads-and-modular-cli.md`](references/04-agent-hitl-scratchpads-and-modular-cli.md)
   - Playbooks for creating ephemeral Agent HITL scratchpads (`scratchpad create` + deep links `/?id=...&tab=view:...&action=...` + synchronous `manifest-cli wait` + `scratchpad promote`), inspecting/initializing unconfigured folders (`inspect` / `init`), and splitting/linking modular `.dashboard/` configurations (`includes`, `$include`, `defs` + `$ref`, `map`, `refs`, `validate`).

---

## 5. Canonical Self-Hosted Reference Implementation

Inspect **`~/.agents/skills/skill-dashboard/.dashboard/manifest.yaml`** (and its modules `.dashboard/modules/01-service-and-build.yaml`, `.dashboard/modules/02-ecosystem-and-cli.yaml`, and custom HTML views `.dashboard/views/service_panel.html`, `.dashboard/views/ecosystem_matrix.html`) as the canonical production example of all Reactive 2.0 and Modular Manifest capabilities.
