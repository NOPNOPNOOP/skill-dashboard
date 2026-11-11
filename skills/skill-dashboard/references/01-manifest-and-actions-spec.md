# 01. Manifest Schema, Action Groups, Forms, Interpolation & 3-Channel Artifacts

This reference provides the complete specification for authoring `.dashboard/manifest.yaml` (and override layers) in **Skill Dashboard Studio**.

---

## 1. 4-Layer Config Cascade & XDG Storage Locations

Every managed unit (`skill`, `workspace`, or `scratchpad`) resolves its effective `SkillManifest` through a deterministic 4-layer cascade:

| Layer | Name | File Location | Purpose |
| :--- | :--- | :--- | :--- |
| **Layer 0** | `ZeroConfigHeuristic` | `<unit_dir>/SKILL.md` or `README.md` + `agents/openai.yaml` | Automatic zero-config extraction of frontmatter, headings, multi-line bash blocks, CLI argument synopses, and relative `.md` links. |
| **Layer 1** | `CompanionManifest` | `<unit_dir>/.dashboard/manifest.yaml` (+ explicit `includes`) | Primary companion configuration versioned alongside the skill or project folder. |
| **Layer 2** | `GlobalOverride` | `~/.config/skill-dashboard/overrides/<unit_id>/manifest.yaml` | User-level override for customizing third-party skills without modifying their repository. |
| **Layer 3** | `WorkspaceOverride` | `<active_workspace>/.claude/skill-dashboard/configs/<unit_id>/manifest.yaml` | Project/worktree-specific override. |

---

## 2. Top-Level `SkillManifest` Schema

```yaml
id: vsip
name: "VSIP Global Developer Suite"
category: "Data & Platform" # Data & Platform | Quality & Review | Knowledge & Docs | Agent & Automation | Design & Visualization | Engineering Tools
description: "Unified operations console and architecture hub for VSIP."
icon: ".dashboard/assets/icon.svg"     # Optional relative SVG/PNG icon
banner: ".dashboard/assets/banner.png" # Optional relative banner image
defaultWorkspace: "~/Projects/vsip-backend"
tsPrelude: true                        # Optional default prelude: true for all runtime: ts / transform: ts blocks
defaultPrompt: "/vsip "
tags:
  - vsip
  - python
  - database
  - studio-ready

# Optional explicit modular includes & reusable definitions (see 04-agent-hitl-scratchpads-and-modular-cli.md)
includes:
  - ./modules/01-doc-extract.yaml
defs:
  envField:
    key: env
    label: "Environment"
    type: select
    flag: "--env"
    default: "uat"
    options:
      - { label: "UAT", value: "uat" }
      - { label: "PROD", value: "prod" }

# Per-unit configurable environment variables (injected into all PTY runs and shells)
envVars:
  - key: TYPESAFE_API_KEY
    label: "TypeSafe API Key"
    secret: true
    placeholder: "ts_live_..."
    description: "Bearer token for SystemOne API requests"

context: []      # See 02-reactive-data-graph-and-parsers.md
data: []         # See 02-reactive-data-graph-and-parsers.md
views: []        # See 03-custom-html-views-and-bridge-sdk.md
actionGroups: [] # Detailed below
```

---

## 3. Action Hierarchy (`actionGroups` $\rightarrow$ `subgroup` $\rightarrow$ `ActionItem`)

- **Adaptive Playground Layout**:
  - Units with `<= 4` total actions across `1` group render as a clean 2-column card grid.
  - Units with `> 4` actions or multiple groups render with a **Left Multi-Level Hierarchy Tree (`Group` $\rightarrow$ `Subgroup`)** and a **High-Density Compact Accordion List** on the right.
- To place an `ActionItem` inside a subgroup, set `subgroup: "1.1 Subgroup Title"` directly on the action (or nest `subgroups: [...]` inside the `ActionGroup`).

### `ActionItem` Properties

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `id` | `string` | Required | Unique action ID across the manifest (used in deep links `/?id=<unit>&action=<id>`, `rowActions`, `data-sd-action`, and `danger` confirmation). |
| `title` | `string` | Required | Human-readable title displayed on the card/row. |
| `subgroup` | `string` | Optional | Second-level tree grouping (e.g. `"1.2 Snapshots & Backups"`). |
| `description` | `string` | Optional | Concise explanation of what the operation does. |
| `danger` | `"safe" \| "warn" \| "danger"` | `"safe"` | `safe` runs immediately (and enables `▶ Quick Run` when required fields have defaults); `warn` opens a confirmation modal; `danger` requires typing the exact `action.id` string to unlock. |
| `requiresHumanApprovalFlag` | `string` | Optional | E.g. `"--human-approved"`. Appended to the command **only** after the user explicitly approves the confirmation modal in the browser. |
| `interactive` | `boolean` | `false` | Set `true` for full-screen keyboard TUIs (`prompt_toolkit`, `fzf`, `htop`, `vim`) so the Web PTY drawer automatically expands and focuses keyboard input. |
| `defaultRunner` | `"web_terminal" \| "external_terminal" \| "copy_command" \| "copy_agent_prompt"` | `"web_terminal"` | Default execution surface. |
| `cwd` | `"project_root" \| "skill_dir" \| string` | `"project_root"` | Working directory for the process (`project_root` resolves to `effectiveWorkspace`; `skill_dir` resolves to the unit's canonical folder). |
| `command` | `string` | Required* | Single-line or multi-line command template (*or use `script: \|`). |
| `script` | `string` | Optional | Multi-line shell script executed in an isolated temporary `/bin/zsh` file with `set -e` enabled. |
| `form` | `FormField[]` | `[]` | Typed parameter inputs rendered in the Action Card. |
| `artifacts` | `Array<string \| ArtifactRule>` | `[]` | Post-run artifact extraction & preview/download rules (see Section 7). |
| `output` | `ActionOutputSpec` | Optional | Pipes stdout back into a reactive `DataNode` (`intoData: "<nodeId>"`). |

---

## 4. Template Variables & Quote-Aware Interpolation Rules

All `command`, `script`, `DataNode.command`, and `ArtifactRule.path` strings support dynamic interpolation:

| Variable | Environment Variable Equivalent | Resolves To |
| :--- | :--- | :--- |
| `{{python}}` | — | `<effectiveWorkspace>/.venv/bin/python` (walking up to 4 parent dirs), or `python3`. |
| `{{skill_dir}}` | `$SKILL_DIR` | Canonical physical directory of the unit (e.g. `~/.agents/skills/vsip`). |
| `{{project_root}}` | — | Bound `effectiveWorkspace` directory. |
| `{{data_dir}}` | `$SD_DATA_DIR` | `~/.local/share/skill-dashboard/units/<unit_id>` — persistent per-unit storage for backups, SQLite DBs, and state files. |
| `{{cache_dir}}` | `$SD_CACHE_DIR` | `~/.cache/skill-dashboard/units/<unit_id>` — disposable per-unit cache directory. |
| `{{artifacts_dir}}` | `$SD_ARTIFACTS_DIR` | `~/.local/share/skill-dashboard/artifacts/<unit_id>/<run_id>` during execution (and `.../latest` symlink during preview). Any file written here is automatically collected as a run artifact! |
| `{{context.<key>}}` | — | Current value of the global reactive `context` switcher `<key>`. |
| `{{data.<nodeId>.*}}` | — | Deep path into a reactive `DataNode` snapshot (e.g. `{{data.backups.rows.0.name}}`). |
| `{{form.<key>}}` | — | Value of the `FormField` with `key: <key>` (see auto-binding rules below). |

### `{{form.<key>}}` Flag Auto-Binding Rules
1. **Named Flag (`flag: "--env"`, `positional` not `true`)**:
   - When non-empty (`"uat"`), `{{form.env}}` expands to `--env uat` (or `--env 'value with spaces'`).
   - When left blank (`""`), `{{form.env}}` expands to `""` (omitting the flag completely!).
2. **Boolean Switch (`type: boolean`, `flag: "--dry-run"`)**:
   - Expands to `--dry-run` when `true`, and `""` when `false`.
3. **Positional Argument (`positional: true` or no `flag`)**:
   - Expands directly to the escaped value.
4. **Quote-Aware Escaping**:
   - If `{{form.payload}}` is placed inside double quotes in a script (e.g. `echo "{{form.payload}}"`), the interpolator escapes only `" $ \` \\` instead of wrapping in single quotes.
5. **Implicit Trailing Append**:
   - Any `FormField` defined in `form:` that is **not** explicitly referenced via `{{form.<key>}}` in `command`/`script` is automatically appended to the end of the command when non-empty.

---

## 5. Single-Line `command` vs Multi-Line `script: |`

- **Never chain multi-step commands with trailing `&& \`**. Use YAML block scalar `script: |`:
- When `script` or `command` contains `\n`, the engine writes it to `~/.cache/skill-dashboard/runtime/scripts/sd-script-<runId>.sh` with `#!/bin/zsh` and `set -e` enabled, and runs it as a child process:
  - `set -e` halts immediately on any non-zero exit code without killing an interactive shell.
  - Shell variables (`POD=$(...)`), functions, and `trap cleanup EXIT` work natively.
  - Clicking **Copy CLI Command** in the UI automatically wraps multi-line scripts in a subshell `(\nset -e\n...\n)`.

---

## 6. Supported `FormField` Control Types

| `type` | Description | Key Properties |
| :--- | :--- | :--- |
| `text` | Single-line text input | `flag`, `positional`, `required`, `default`, `placeholder`, `fromData`, `dataSource` |
| `number` | Numeric input | `flag`, `positional`, `required`, `default`, `min`, `max` |
| `boolean` | Checkbox toggle | `flag`, `default` (`true` / `false`) |
| `select` | Dropdown selector | `flag`, `positional`, `required`, `default`, `options: [{ label, value }]`, `fromData: "<dataNodeId>"`, `dataSource` |
| `multi-select` | Comma-joined multi-option selector | `flag`, `options`, `default: string[]` |
| `file` | Local file picker with live autocomplete rooted at `effectiveWorkspace` | `flag`, `positional`, `required`, `default`, `placeholder` |
| `directory` | Local directory picker with live autocomplete | `flag`, `positional`, `required`, `default`, `placeholder` |
| `env-secret` | Password-masked input (`********` in previews & logs); injected into process `env` | `envVar` (e.g. `API_TOKEN`), optional `flag` |
| `code` | Multi-line monospace editor for JSON/SQL/payloads | `flag`, `positional`, `required`, `default`, `placeholder` |
| `date` | Date picker (`YYYY-MM-DD`) | `flag`, `positional`, `required`, `default` |

- **Conditional Visibility (`when`)**:
  ```yaml
  when:
    field: mode
    equals: "custom"
  ```
- **Dynamic Options from Reactive Graph (`fromData`)**:
  Set `fromData: "<dataNodeId>"` on any `select` field to populate its options directly from a `DataNode` snapshot.

---

## 7. 3-Channel Run Artifact Pipeline & Whitelisted Gateway

When a PTY run exits, Skill Dashboard extracts output artifacts across **3 prioritized channels** (higher-priority channels are never overwritten by lower-priority scans) and serves them via `GET /api/runs/:runId/artifacts/:index[?download=1]`:

### Channel 1 (Highest Priority): Explicit YAML `ActionItem.artifacts` Rules
Supports both interpolated `path` templates and ANSI-stripped `fromStdout` regex matchers (verified with `mtimeMs >= run.startedAt - 1000`):

```yaml
actions:
  - id: generate-audit
    title: "Generate Migration Audit Report"
    command: "{{python}} {{skill_dir}}/scripts/audit.py --out {{form.out}}"
    form:
      - key: out
        label: "Output HTML Path"
        type: file
        default: "{{artifacts_dir}}/audit_report.html"
    artifacts:
      # 1a. Interpolated Path Template
      - path: "{{form.out}}"
        label: "Visual Diff Report"
        kind: html              # html | file | json | image | markdown
        onComplete: open        # badge (default) | open (auto-opens new tab) | download (auto-downloads)

      # 1b. Regex Extractor against ANSI-stripped stdout (named group (?<path>...) or $1)
      - fromStdout: "Excel report saved to:\\s+(?<path>\\S+\\.xlsx)"
        label: "Audit Workbook (.xlsx)"
        kind: file
        onComplete: download
```

### Channel 2: Zero-Config Stdout Protocol Marker (`::artifact`)
Any script can emit lines matching:
```text
::artifact path=/abs/or/rel/path/report.html label="HTML Report" kind=html onComplete=open
```

### Channel 3: Automatic `{{artifacts_dir}}` (`$SD_ARTIFACTS_DIR`) Directory Scan
Any file written into `$SD_ARTIFACTS_DIR` during the run is automatically discovered and surfaced as a clickable badge in the Terminal Drawer!
