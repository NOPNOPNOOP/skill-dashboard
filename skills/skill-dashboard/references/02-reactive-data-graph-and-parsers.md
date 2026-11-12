# 02. Reactive Data Graph, Polyglot Runtimes, Parsers & Interactive Widgets

Skill Dashboard Studio features a **Reactive Compute & Action Graph (`ReactiveGraphEngine`)** where global `context` variables, polyglot `data` nodes, `actionGroups`, and custom `views` form a live DAG.

---

## 1. Global Reactive Context (`context:`)

Declare skill-wide state switchers rendered in the top toolbar of the Playground (and mountable in custom HTML views via `<div data-sd-context-bar></div>`). Changing a context value automatically invalidates and recomputes all dependent `DataNode`s in topological order and interpolates `{{context.<key>}}` across commands and queries.

```yaml
context:
  - key: target_env
    label: "Target Environment"
    type: select # select | toggle | text
    default: "local"
    options:
      - { label: "Local Dev", value: "local" }
      - { label: "AWS UAT", value: "uat" }
      - { label: "AWS PROD", value: "prod" }
```

---

## 2. Polyglot Data Nodes (`data:`) — 7 Runtimes & `ctx` Contract

Every `DataNode` has a unique `id` and executes in one of 7 runtimes:

| `runtime` | Execution Engine | Primary Config Fields |
| :--- | :--- | :--- |
| `ts` | In-memory `Bun.Transpiler` TypeScript (zero subprocess overhead) | `code`, `prelude: true \| false` |
| `python` | Bound `<effectiveWorkspace>/.venv/bin/python` (or `python3`) | `code` (supports `def main(ctx): return ...`) |
| `sqlite` | Native read-only `bun:sqlite` query | `db` (supports `~`, `{{data_dir}}`, etc.), `sql` (supports `$context_<key>` bindings) |
| `glob` | Fast local directory file scanner | `pattern: string[]`, `valueFormat: "basename" \| "relative" \| "abspath"` |
| `file` | Structured file reader (JSON, YAML, CSV, TSV, raw) | `filePath` |
| `zsh` | Subprocess shell command | `command`, `cwd: "project_root" \| "skill_dir"` |
| `passive` | Populated on-demand by an Action's `output.intoData` | `shape`, `columns` |

### The `ctx` Object Passed to `runtime: ts`, `runtime: python`, and `transform`
Inside any `ts` or `python` node, `ctx` provides:
```ts
interface DataExecutionContext {
  skillId: string;                     // e.g. "vsip"
  skillDir: string;                    // canonical path of the unit
  workspace: string;                   // effectiveWorkspace ({{project_root}} skill default preference)
  cwd: string;                         // resolved working directory for this specific DataNode (inherits workspace unless overridden)
  python: string;                      // resolved python executable for this DataNode's cwd ({{python}})
  dataDir: string;                     // ~/.local/share/skill-dashboard/units/<id> ({{data_dir}})
  cacheDir: string;                    // ~/.cache/skill-dashboard/units/<id> ({{cache_dir}})
  artifactsDir: string;                // ~/.local/share/skill-dashboard/artifacts/<id>/latest ({{artifacts_dir}})
  context: Record<string, unknown>;    // current values of all context: fields
  data: Record<string, any>;           // evaluated values/rows of upstream dependsOn data nodes
  env: Record<string, string>;         // merged envVars + node envFile + node env overrides
}
```

> **Note on In-Scope Variables in TypeScript**: `executeInlineTypeScript` (`runtime: ts` and `transform: ts`) automatically exposes `{ input, rawStdout, context, data, nodes }` at the top level alongside `ctx`. You can reference `data["<upstream_id>"]` or `context["<key>"]` directly or via `ctx.data` / `ctx.context`.

### Node Categorization & Upstream Intermediate DAG Nodes (`category` & `intermediate`)

- **`category?: string`**: Groups `DataNode`s into filterable category tabs in the Studio Data Panel (e.g. `"1. Document Extraction"`, `"2. Extraction Config"`). Users can quickly switch between functional domains in complex skills.
- **`intermediate?: boolean`**: Declares explicit upstream DAG source nodes.
  - **Hidden by default** in the main Data Panel to keep operational dashboards clean and focused on user-facing metrics and tables.
  - **Inspectable via the `🔬 Intermediates` toggle switch** in the Data Panel, complete with reverse `Consumed by: [data:<downstream_id>, ...]` dependency badges.
  - **Single Execution & Direct Consumption**: Exposes its parsed output directly via `ctx.data["<upstream_id>"]` / `data["<upstream_id>"]` to downstream `runtime: ts` view nodes declared with `sync.dependsOn: ["<upstream_id>"]`.
  - **One CLI Execution, Multiple In-Memory Views**: When multiple UI widgets (e.g. a KPI summary card and a detailed table) need data from the same expensive CLI command or script (e.g. Python CLI with `--json`), refactor them into **1 explicit `intermediate: true` upstream shell node** plus **2 fast `runtime: ts` downstream view nodes**. The expensive CLI command only runs once, eliminating duplicate execution without unsafe implicit shell command merging.

### TypeScript `prelude: true` (Explicit Opt-In)
- **`prelude: false` (default)**: Pure `{ ctx, Bun }` scope. Standard top-level `import { readdirSync } from "node:fs"` statements are automatically rewritten to `await import(...)` and work out of the box.
- **`prelude: true` (Recommended — or set `tsPrelude: true` at root of `manifest.yaml`)**: Pre-injects `{ fs, path, os, Database, YAML, $ }` in an outer closure scope while wrapping your code in an inner `async () => { ... }` closure so local variables (such as `const path = ...`) can safely shadow outer helpers without `SyntaxError`:

```yaml
data:
  - id: service-health
    title: "Service Telemetry"
    runtime: ts
    prelude: true
    shape: kv
    code: |
      const dbPath = path.join(ctx.dataDir, "state.db");
      return {
        "Workspace": ctx.workspace,
        "Environment": String(ctx.context.target_env || "local"),
        "State DB Exists": fs.existsSync(dbPath) ? "YES" : "NO",
      };
```

### Python `def main(ctx):` Structured Return
For `runtime: python`, `ctx` is passed via an isolated temporary JSON file (`$SD_CTX_FILE`, leaving `sys.stdin` untouched and avoiding `ARG_MAX` limits). If your code defines `def main(ctx):`, its return value (dict, list of dicts, or scalar) is serialized directly as JSON:

```yaml
data:
  - id: alembic-heads
    title: "Alembic Migration Heads"
    runtime: python
    shape: table
    code: |
      import pathlib
      def main(ctx):
          versions_dir = pathlib.Path(ctx["workspace"]) / "alembic" / "versions"
          if not versions_dir.exists():
              return []
          return [
              {"file": p.name, "sizeBytes": p.stat().st_size}
              for p in sorted(versions_dir.glob("*.py"))
              if not p.name.startswith("__")
          ]
```

### Native SQLite (`runtime: sqlite`)
Queries SQLite databases directly in-process via `bun:sqlite` (`readonly: true`). All `context` fields are automatically bound as `$context_<key>`:

```yaml
data:
  - id: recent-runs
    title: "Recent Runs"
    runtime: sqlite
    db: "~/.local/share/skill-dashboard/dashboard.db"
    sql: "SELECT id, action_title, status, duration_ms FROM runs WHERE skill_id = $skillId ORDER BY started_at DESC LIMIT 10"
    shape: table
```

---

## 3. Declarative Parsers (`parse:`) & Post-Transforms (`transform:`)

When using `runtime: zsh` or `runtime: file` (or when `runtime: ts`/`python` returns a string), `parse:` converts raw text into structured data before optional `transform:` post-processing:

| `parse.format` | Behavior & Options |
| :--- | :--- |
| `auto` | Attempts JSON parse if output starts with `{` or `[`, otherwise falls back to raw/shape inference. |
| `json` | Parses JSON (strips leading noisy log lines automatically). Supports `path: "data.items"` dot-extraction. |
| `jsonl` | Parses newline-delimited JSON objects into an array of records. |
| `csv` / `tsv` | RFC-compliant quoted CSV/TSV parser (first row = headers) producing `Record<string, string>[]`. |
| `whitespace-table` | Parses aligned CLI tables (`kubectl get pods`, `docker ps`, `ps aux`) by detecting header column spans. |
| `regex` | Matches `pattern: "(?<id>\\S+)\\s+(?<status>\\S+)"` across lines; named capture groups become table columns! |
| `kv` | Parses `KEY=VALUE` or `Key: Value` lines into a key-value map (`delimiter: ":"`). |
| `lines` | Splits non-empty trimmed lines into `string[]`. |
| `raw` | Preserves raw ANSI/text string. |

### Programmable Post-Transform (`transform:`)
```yaml
parse:
  format: whitespace-table
transform:
  runtime: ts
  prelude: true
  code: |
    // `input` holds the parsed array/object
    return (input || []).filter((row: any) => row.STATUS !== "Completed");
```

---

## 4. The 7 Canonical Shapes (`shape:`) & Interactive Bindings

| `shape` | Expected Return / Value Structure | UI Widget Rendered |
| :--- | :--- | :--- |
| `scalar` | `{ value: string\|number, unit?: string, label?: string, tone?: "neutral"\|"info"\|"success"\|"warn"\|"danger" }` (or primitive) | High-contrast KPI metric card |
| `kv` | `Record<string, string\|number\|boolean>` or `{ entries: [{ key, label, value, tone }] }` | 2-column Key-Value status grid |
| `list` | `Array<string \| { label, value, meta }>` | Compact badge/item list + dropdown option source |
| `table` | `Array<Record<string, unknown>>` or `{ columns, rows, primaryKey }` | `InteractiveDataTable` with search, typed columns, `rowActions`, `bulkActions`, and HITL row submission |
| `matrix` | `{ rowAxis, colAxis, rows: [{ key, label, cells: Record<colKey, { value, tone }> }] }` | 2D `PivotMatrix` with clickable `cellAction` |
| `stream` | NDJSON stream events (`{ op: "upsert"\|"patch"\|"delete"\|"reset", key, row }`) | Live-folding table or log stream |
| `raw` | `string` (ANSI color codes supported) | Collapsible terminal-styled output card |

### `table` Column Types & Interactive Action Triggers
```yaml
data:
  - id: snapshots-table
    title: "Database Snapshots"
    runtime: glob
    pattern: ["{{data_dir}}/backups/*.json"]
    valueFormat: basename
    shape: table
    primaryKey: "name"
    valueColumn: "name"
    columns:
      - { key: "name", label: "Filename", type: "code" }       # text | code | badge | number | bytes | datetime | progress | boolean
      - { key: "sizeFormatted", label: "Size", type: "badge" }
      - { key: "mtimeIso", label: "Modified", type: "datetime" }
    rowActions:
      - label: "Restore"
        actionId: restore-snapshot
        mode: prefill # "run" | "prefill" (warn/danger actions automatically enforce HumanApprovalGate!)
        args:
          target: "{{row.name}}"
    bulkActions:
      - label: "Verify Selected"
        actionId: verify-snapshots
        mode: run
        args:
          files: "{{selected.name}}" # comma-joined list of selected row values
```

> **In-Place Bound Action Audit & White-Box `🔍 Inspect`**:
> - Every bound trigger button (`rowActions`, `bulkActions`, `quickActions`, `cellAction`) displays its target `→ <actionId>` badge and hover argument preview, and clicking it opens the **In-Place Bound Action Audit & Execution Modal** (showing the `Form Key` $\leftarrow$ `YAML Template` $\leftarrow$ `Resolved Row Value` mapping table and an embedded `ActionCard` with live command preview and one-click execution).
> - Every `DataNode` card header also includes a **`🔍 Inspect`** button exposing 3 white-box tabs: **`</> Execution Source`** (showing `DataSnapshot.resolvedSource` + **`▶ Test in Web Terminal`**), **`⚡ Bound Actions (N)`**, and **`📄 Raw Output & DAG`**.
> - **Best Practice for Formatted Table Columns**: If a `runtime: ts` table formats a column for UI display (e.g. `doc_id: "#597"`), also include the clean raw field in the row object (e.g. `raw_doc_id: "597"`) and reference `{{row.raw_doc_id}}` in `rowActions.args` so CLI flags receive `"597"` rather than `"#597"`.

---

## 5. Reactivity, DAG Chaining (`sync:`) & `output.intoData` Feedback Loop

```yaml
sync:
  onMount: true
  ttlMs: 15000                         # Cache TTL in ms
  pollMs: 10000                        # Optional foreground auto-polling interval
  dependsOn:                           # Upstream data nodes or "context.<key>"
    - "snapshots-table"
    - "context.target_env"
  watchFiles:                          # Local directories/files watched via debounced fs.watch
    - "{{data_dir}}/backups"
  invalidateOnActions:                 # Action IDs (or prefix globs "backup-*") that invalidate this node on completion
    - "create-backup"
    - "restore-*"
```

### Closing the Loop: `ActionItem.output.intoData`
Any action can pipe its stdout directly into a `DataNode` (and automatically trigger downstream `dependsOn` nodes):
```yaml
actions:
  - id: scan-candidates
    title: "Scan Candidates"
    command: "{{python}} {{skill_dir}}/tools/scan.py --json"
    output:
      intoData: "candidates-table"
      parse:
        format: json
      shape: table
```
