# PRD: Multi-Agent Skill Dashboard & Interactive Operations Studio (`skill-dashboard`)

Status: ready-for-agent

---

## Problem Statement

Developers working across modern AI coding agents (`Claude Code`, `Codex`, `OpenCode`, `Pi`, `OpenClaw`, `Continue`, `Trae`) and community skill managers (`npx skills add` / `~/.agents/skills`) face severe fragmentation and cognitive overhead:

1. **Invisible Multi-Agent Topology & Broken Symlinks**: Dozens of skills (60+ on a typical machine) are scattered across `~/.agents/skills/`, `~/.claude/skills/`, `~/.codex/skills/.system/`, `~/.pi/agent/skills/`, `~/.openclaw/skills/`, and workspace-local `.claude/skills/`. Because agent folders rely heavily on relative symlinks into `~/.agents/skills/`, developers cannot easily see which skill is mounted in which agent, cannot toggle mounts visually, and silently suffer from broken symlinks (e.g., inside git worktrees).
2. **Complex Composite Skills Buried in Prose**: Heavyweight engineering toolsuites like `vsip` contain 20+ CLI operations, full-screen `prompt_toolkit` TUIs (`doc_extract_config.py tui`, `switch_roles.py`), safety-gated scripts (`sync_env_test_data.py --human-approved`), and 8+ modular architecture/RFC/playbook documents under `references/`. Remembering exact CLI flags, file paths, and environment options requires repeatedly grepping a 16KB `SKILL.md`.
3. **Lack of Zero-Config Introspection & Progressive Customization**: Most installed skills have no dedicated UI metadata. Without a zero-config engine that automatically exposes a skill's file tree, documentation, and runnable commands—paired with an optional progressive manifest protocol for rich UI forms, banners, images, and action groups—skills remain opaque text files.
4. **Fragile Execution & Lost Terminal State**: Running long data syncs, evaluations, or interactive TUIs from a naive web runner loses ANSI colors, breaks interactive keyboard input (`prompt_toolkit`), spawns unkillable orphan subprocess trees (`uv` -> `python`), or loses all output if the browser tab is accidentally closed or refreshed.
5. **Static UI Limitations & Disconnected Data/Actions**: A purely form-and-button dashboard cannot express live multi-dimensional operational state—such as querying data via Python/TypeScript/SQLite/CLI, parsing messy stdout (`kubectl get pods`, regex, CSV, JSON) into 0D scalars, 1D key-value cards, 2D interactive tables, or ND pivot matrices, watching local files (`fs.watch`), folding streaming NDJSON events, and referencing those named datasets across action forms (`fromData`), command templates (`{{data.*}}`), row-level actions (`rowActions`), and custom HTML apps (`<div data-sd-widget="id">`).
6. **Skills-Only Boundary, Scattered Runtime Files & Missing Agent HITL Loop**:
   - The reactive studio engine is equally valuable for **non-skill folders** (arbitrary git repositories, SRE incident runbooks, ETL data pipelines) and **ephemeral Agent Human-in-the-Loop (HITL) scratchpads** created mid-conversation by Claude Code or Codex, yet previously only scanned `SKILL.md` directories.
   - Configuration, SQLite databases, logs, and runtime outputs produced by dashboards were scattered across `~/.claude/skill-dashboard/`, `/tmp/`, or written directly inside skill source directories (`{{skill_dir}}`), risking git tree pollution and lost report artifacts.

---

## Solution

Build **Skill Dashboard Studio** (`skill-dashboard`)—a fast, zero-external-dependency local Web Studio, Reactive Compute & Action Graph engine, Universal Local Operations Console (`Scratchpads / Workspaces / Skills`), and self-hosted Meta-Skill built on **TypeScript + Bun**:

1. **Canonical Multi-Agent Skill Graph, Semantic Tagging & Mount Manager**: Scans all global and workspace agent directories, deduplicates physical skills via `realpath` into `CanonicalSkill` entities, infers multi-source semantic tags (with a collapsible left-sidebar tag filter), distinguishes `~/.agents/skills` auto-hub mounts (`Codex`, `OpenCode`, `Pi`) from symlink mounts (`Claude Code`, `OpenClaw`, `Workspace`), and supports one-click relative symlink mounting, broken-symlink repair, guarded `npx skills update` (preserving `.dashboard/`), and Agent-driven incremental manifest sync.
2. **4-Layer Config Cascade (`ZeroConfigHeuristic` $\rightarrow$ `CompanionManifest` $\rightarrow$ `GlobalOverride` $\rightarrow$ `WorkspaceOverride`)**:
   - **Zero-Config Default**: Automatically parses `SKILL.md` (or `README.md` for non-skill workspaces) frontmatter, headings, bash codeblocks, and CLI argument synopses into multi-level `ActionGroup`s and typed `FormField`s; exposes in-place executable shell blocks inside Markdown docs; and provides a hierarchical indented `FileTree` inspector with `../` parent navigation and syntax highlighting.
   - **Progressive Manifest & Visual Persistence**: Supports `.dashboard/manifest.yaml` (single-file or explicit modular `includes`) for custom SVG icons, eye-comfort themes (`Warm Light` & `Soft Dark`), per-skill bound `defaultWorkspace` and `envVars`, multi-line isolated `script: |` execution (`set -e` + `trap ... EXIT`), and bidirectional YAML persistence.
3. **Reactive Architecture 2.0 (Unified Polyglot Compute & Action Graph + Multi-Layer UI)**:
   - **Global Reactive Context (`context:`)**: Top-level skill state switchers (e.g. `target_env: local | uat | prod`) that automatically invalidate and recompute downstream `DataNode`s in topological order and interpolate `{{context.<key>}}` into commands.
   - **Polyglot Reactive Data Nodes (`data:`)**: First-class named operators supporting 7 runtimes (`zsh`, in-memory `Bun.Transpiler` `ts`, `.venv`-bound `python` with `def main(ctx)` structured return, zero-overhead `bun:sqlite` `sqlite`, `glob`, `file`, and `passive` nodes populated via `ActionItem.output.intoData`), 9 declarative parsers (`auto`, `json`, `jsonl`, `csv`, `tsv`, `whitespace-table`, `regex`, `kv`, `lines`, `raw`), programmable `ts`/`python` post-transforms, and 7 canonical shapes (`scalar`, `kv`, `list`, `table`, `matrix`, `stream`, `raw`).
   - **Reactivity & Sync Lifecycle (`sync:`)**: Single-Flight deduplication, TTL caching, implicit/explicit DAG dependency propagation (`dependsOn`), debounced local directory watching (`watchFiles`), post-action invalidation (`invalidateOnActions`), foreground polling (`pollMs`), and NDJSON stream folding.
   - **Universal Cross-Layer Referencing & Bridge 2.0**: Named `data` nodes are rendered natively as interactive widgets (`InteractiveDataTable` with `rowActions`/`bulkActions`, `PivotMatrix` with `cellAction`, `Scalar`/`KV` cards), referenced in form dropdowns (`fromData: "<nodeId>"`), interpolated in commands (`{{data.<nodeId>.rows.0.name}}`), and embedded in custom HTML views (`/skill-app/:skillId/*`) via zero-JS `<div data-sd-widget="id">` tags or `window.SkillDashboard.subscribe(id, cb)`.
4. **XDG 3-Tier Storage Governance, 3-Tier Unit Taxonomy (`Scratchpads / Workspaces / Skills`) & 3-Channel Run Artifacts**:
   - **XDG Storage Separation**: Cleanly partitions Config (`~/.config/skill-dashboard/config.yaml` + `overrides/`), Data (`~/.local/share/skill-dashboard/dashboard.db`, `logs/`, per-unit `{{data_dir}}` `units/<id>/`, and per-run `{{artifacts_dir}}` `artifacts/<id>/<runId>/`), and Cache (`~/.cache/skill-dashboard/scratchpads/<project>/<id>/`, per-unit `{{cache_dir}}` `units/<id>/`, and `runtime/`).
   - **Agent Ephemeral Scratchpads, Deep Links, HITL Sync & One-Click Promotion**: Enables CLI Agents to create project-scoped interactive consoles in `~/.cache/skill-dashboard/scratchpads/<project>/<id>/` without asking for a path, return a direct URL (`http://127.0.0.1:8766/?id=<id>`), block synchronously via `manifest-cli wait <id>` until the human submits a decision or completes an action, and promote useful scratchpads into `<project_root>/.dashboard/` or global `~/.agents/skills/<id>`.
   - **Managed Folders & Agent-Assisted `.dashboard` Generation**: Users can add arbitrary folders (`+ Add Folder` or `manifest-cli folder add`). If `.dashboard/manifest.yaml` is missing, the UI prompts whether to create one (with a "Don't ask again" preference stored in `config.yaml`) and invokes the CLI Agent with `manifest-cli inspect/init/validate` to generate a tailored `.dashboard`.
   - **Targeted Agent Fix Drawer (`AgentFixDrawer`), Click-to-Context & Multi-Line Layer 0 Aggregation**:
     - Layer 0 (`ZeroConfigHeuristic`) aggregates multi-line backslash continuations (`\`), multi-line quoted payloads (`-d '{ ... }'`), and heredocs into unified commands rather than splitting them into broken per-line actions.
     - A non-modal bottom-right floating **Fix / Ask Agent Drawer** lets users click any element on the page (`ActionGroup`, `ActionItem`, `DataNode`, `ContextField`, `SkillView`) into context chips, type specific instructions (or pick quick presets), automatically target the existing defining file (`SymbolProvenance` / active layer) or `<skill_dir>/.dashboard/manifest.yaml`, and either run `claude` / `codex` in the Web PTY or copy the assembled prompt.
   - **3-Channel Artifact Pipeline & Preview/Download Gateway**: Extracts run output files via YAML `artifacts` rules (`path` templates + `fromStdout` regex matchers), `::artifact` stdout markers, and `{{artifacts_dir}}` directory scans, exposing whitelisted in-app previews and downloads (`/api/runs/:runId/artifacts/:index`) with configurable `onComplete: "badge" | "open" | "download"`.
5. **Dual-Mode Execution Engine with Native Bun PTY & Interactive Shell**:
   - **Embedded Web Terminal (`xterm.js` + Bun Native PTY)**: Spawns commands and interactive `ZDOTDIR`-shimmed `/bin/zsh -i` shells inside `Bun.spawn({ terminal })` with streaming UTF-8 decoding (`{ stream: true }`), `convertEol: false` TUI fidelity, drag-to-resize drawer, and process-group termination (`kill(-pid)`).
   - **External Terminal & Clipboard Handoff**: One-click execution in `Terminal.app` / `iTerm2` or subshell-safe clipboard copy.
6. **Multi-Tier Run Persistence, Session Re-Attach & macOS Keep-Alive Daemon**: Persists runs across `HotRingBuffer` + disk `.log` + `bun:sqlite` `dashboard.db`, and installs a macOS `launchctl` Keep-Alive LaunchAgent (`~/Library/LaunchAgents/com.local.skill-dashboard.plist`) on port `8766`.

---

## User Stories

### Discovery, Canonical Deduplication & Multi-Agent Mount Management
1. As a multi-agent developer, I want the dashboard to scan `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills` (including `.system`), `~/.pi/agent/skills`, `~/.pi/skills`, `~/.openclaw/skills`, `~/.continue/skills`, `~/.trae/skills`, and workspace `.claude/skills` / `.agents/skills`, so that all my skills appear in one unified catalog.
2. As a developer who installs skills via `npx skills add`, I want symlinked skills across multiple agent folders to be deduplicated by their physical `realpath` into a single `CanonicalSkill`, so that I do not see 4 duplicate cards for the same skill.
3. As a developer, I want each `CanonicalSkill` card and detail header to display `AgentMount` badges (`claude`, `codex`, `pi`, `openclaw`, `workspace`, etc.), so that I immediately know which agents have access to that skill.
4. As a developer, I want to see `LockProvenance` metadata (GitHub repository source, commit/folder hash, installed/updated timestamps from `~/.agents/.skill-lock.json` and `~/skills-lock.json`), so that I know where each community skill came from.
5. As a developer, I want the dashboard to detect broken symlinks in any scanned agent directory (such as worktree-relative broken links in `./.claude/skills/`) and surface them in a "Health / Broken Mounts" diagnostic banner, so that silent broken skills are immediately visible.
6. As a developer, I want to repair a broken symlink (by re-pointing it to the matching skill in `~/.agents/skills/<name>` or removing the dead link) with one click in the UI, so that I can fix workspace skill mounts without manual terminal `ln -snf` commands.
7. As a developer, I want to toggle (mount/unmount via symlink) any `CanonicalSkill` into or out of `Claude Code`, `Pi`, `Codex`, or `OpenClaw` directly from the skill detail header, so that I can manage my agent skill loadout visually.
8. As a developer, I want the server to watch scanned skill directories and reload when skills or manifests are added or modified, so that I do not have to restart the server after editing a skill.

### Zero-Config Introspection & 4-Layer Config Cascade
9. As a developer opening a skill that has no `.dashboard/manifest.yaml`, I want the dashboard to automatically extract its `name` and `description` from `SKILL.md` YAML frontmatter (or first heading/paragraph), so that every skill is immediately readable.
10. As a Codex user, I want the zero-config parser to natively read `agents/openai.yaml` (`display_name`, `short_description`, `icon_small`, `icon_large`, `default_prompt`), so that Codex system skills render with their native icons and default prompts out of the box.
11. As a developer viewing an unconfigured skill, I want the zero-config parser to scan `SKILL.md` for `bash`/`sh` fenced code blocks, group them by their preceding Markdown headings (`##` / `###`), and extract runnable CLI command templates, so that any documented command is executable without writing YAML first.
12. As a developer viewing an unconfigured skill, I want the zero-config parser to heuristically infer typed `FormField` definitions from CLI synopsis patterns in `SKILL.md` (`--flag {a|b}` $\rightarrow$ `select`, `--file <x.xlsx>` $\rightarrow$ `file`, `[--flag EXAMPLE]` $\rightarrow$ `text`/`number`, `[--dry-run]` $\rightarrow$ `boolean`, `<positional.pdf>` $\rightarrow$ required `file`/`text`), so that even zero-config commands get interactive forms automatically.
13. As a developer viewing a skill with modular docs (like `vsip`), I want the zero-config parser to discover relative Markdown links (e.g., `references/architecture/spec_engine.md`) and expose them as navigable Document Views, so that progressive knowledge references are first-class tabs.
14. As a developer browsing any skill, I want a "Files" tab that displays the skill's directory structure (pruning noise directories like `.git`, `node_modules`, `__pycache__`, `.venv`, `.DS_Store`) and renders syntax-highlighted source code, Markdown, JSON/YAML, or image previews when I click a file, so that I can inspect all internal scripts and assets of a skill.
15. As a skill author, I want to place a `.dashboard/manifest.yaml` (and optional `.dashboard/assets/*`, `.dashboard/docs/*`) inside my skill directory (`Layer 1: CompanionManifest`), so that my custom UI layout, icons, banners, action groups, and form schemas travel with the skill repository.
16. As a user of third-party read-only skills, I want to place override configs in `~/.claude/skill-dashboard/configs/<skill_id>/manifest.yaml` (`Layer 2: GlobalOverride`) or `<workspace>/.claude/skill-dashboard/configs/<skill_id>/manifest.yaml` (`Layer 3: WorkspaceOverride`), so that I can customize actions or default parameters without dirtying the upstream skill's git working tree.
17. As a developer who tweaked form defaults or wants to customize a zero-config skill, I want a "Save / Export to Manifest" button in the UI that writes the effective or modified configuration to `.dashboard/manifest.yaml` (or the global/workspace override layer), so that configuration is a bidirectional closed loop.

### Rich UI Views, Documentation & Asset Proxy
18. As a developer, I want to search and filter the skill catalog by keyword (matching skill ID, name, description, tags, or action titles), ecosystem mount (`All`, `Claude`, `Codex`, `Pi`, `OpenClaw`, `Workspace`), and category, so that I can locate any tool in under a second.
19. As a developer reading a skill's Markdown documentation in the dashboard, I want relative links to other `.md` files or scripts inside the skill to open directly inside the dashboard's viewer with breadcrumb navigation (Back / Forward), rather than triggering a broken browser navigation.
20. As a developer reading Markdown docs or viewing skill banners/icons, I want relative image references (`./assets/banner.png`, `./assets/imagegen-small.svg`) to load securely through a backend whitelist asset proxy (`/api/assets`), so that local disk images render in the browser without exposing arbitrary filesystem paths (`Path Traversal` protection).
21. As a developer reading a playbook or runbook in the Docs tab, I want fenced `bash` code blocks to include quick action buttons (`Copy`, `Load into Playground`, `Run in Web Terminal`), so that documentation functions as an executable runbook.

### Dynamic Forms, Active Workspace & Safety Gates
22. As a developer running actions with parameters, I want support for comprehensive form field types (`text`, `number`, `boolean`, `select`, `multi-select`, `file`, `directory`, `env-secret`, `key-value`, `textarea`/`code`, `date`), including conditional visibility (`when: { field, equals }`), so that any CLI signature can be modeled ergonomically.
23. As a developer filling out a `file` or `directory` field, I want an in-app local path browser / autocomplete popover rooted at the `ActiveWorkspace` (or user home), so that I can pick `.xlsx`, `.pdf`, or `.json` files without typing long absolute paths by hand.
24. As a developer filling out an `ActionItem` form, I want a live "Command Preview" bar showing the exact shell-escaped command and target working directory (`cwd`) that will be executed, with any `env-secret` values masked as `********`, so that I have 100% transparency before clicking Run.
25. As a developer working across multiple repositories or git worktrees (such as `~/Projects/app-backend` vs `~/Projects/app-frontend`), I want an `ActiveWorkspace` switcher in the top header that auto-discovers recent workspaces and lets me switch the active `{{project_root}}`, so that workspace-dependent skills execute against the right codebase and `.venv`.
26. As a Python/FastAPI developer, I want the template variable `{{python}}` to automatically resolve to `<active_workspace>/.venv/bin/python` when a virtualenv exists in the active workspace (or fall back to `uv run python` / `python3`), so that skill scripts always run with the project's dependencies without manual venv activation.
27. As a developer invoking high-impact operations (such as `sync_env_test_data.py` or `clear-all --purge`), I want actions marked `danger: "warn"` to require an explicit confirmation popover, and actions marked `danger: "danger"` to require typing the action/target name to unlock, automatically injecting `--human-approved` only after human confirmation in the UI.

### Dual-Mode Execution, Interactive PTY & Multi-Tier Re-Attach
28. As a developer clicking "Run in Web Terminal", I want the command to run in a real Bun native PTY (`Bun.spawn({ terminal })`) streamed over WebSocket to `xterm.js`, so that ANSI colors, progress bars, and `isatty()` checks behave identically to a native terminal.
29. As a developer running interactive full-screen TUIs (such as `vsip`'s `doc_extract_config.py tui` or `switch_roles.py`), I want `xterm.js` keystrokes (`Tab`, arrow keys, `Space`, `/`, `q`) and terminal resize events (`cols`, `rows`) to forward bidirectionally to the Bun PTY, so that I can operate full-screen terminal UIs directly inside the browser.
30. As a developer, I want a "Stop / Kill" button on any running task that sends `SIGTERM` (followed by `SIGKILL` after a grace timeout) to the entire POSIX process group (`-pgid`), so that wrapper processes (`uv`, `sh`) and all their child Python workers are terminated cleanly with zero orphan processes.
31. As a developer who prefers running a command in my native macOS terminal or passing it to an AI agent, I want every Action card to offer secondary execution modes: "Launch in External Terminal (`Terminal.app` / `iTerm2`)", "Copy CLI Command", and "Copy Agent Prompt", so that I can choose the right execution surface for any workflow.
32. As a developer running long tasks, I want all execution runs to be persisted across three tiers (`HotRingBuffer` in memory + append-only `.log` file on disk + `bun:sqlite` metadata index), so that if I close the browser tab, refresh the page, or reopen the dashboard later, I can see active and historical runs, replay the full ANSI log output, and seamlessly re-attach to still-running tasks.
33. As a developer whose dashboard server was restarted while a subprocess was running, I want the server on startup to reconcile stale `status = 'running'` records in SQLite by checking if their `pid` is still alive and marking dead ones as `interrupted`, so that the UI never displays phantom running spinners.
34. As a developer running skills that generate output files (such as HTML evaluation War Room reports, JSON backups, or Excel diff sheets), I want the run console to detect file paths created/referenced in output (or declared in `ActionItem.artifacts`) and provide a one-click "Open / Preview Artifact" button, so that I can inspect generated HTML/JSON reports immediately.

### First-Class `vsip` Companion Configuration & Self-Hosted Skill
35. As a VSIP developer, I want a rich, production-ready `.dashboard/manifest.yaml` configured for `vsip` covering all 6 tool domains (`doc-extract`, `doc-extract config`, `doc-eval`, `program_init & env_sync`, `role_switcher`, `dc_ops`) and all 8 `references/` documents (`overview`, `spec_engine`, `doc_extract`, `release_runbook_uat_prod`, `ers_extraction_rules`, `dc_guid_binding`, `rfc_001`, `rfc_002`), so that all VSIP capabilities are immediately accessible via visual forms and tabs.
36. As a user of Claude Code / Pi / Codex, I want `skill-dashboard` itself to include a `SKILL.md` and `.dashboard/manifest.yaml` and be mounted into `~/.agents/skills/skill-dashboard` (and linked into `~/.claude/skills/skill-dashboard`), so that I can launch or manage the dashboard directly as a skill.

### Multi-Level Ergonomics, Per-Skill Isolation, Lifecycle Updates & Keep-Alive Daemon
37. As a developer reading long documentation and operating complex skills, I want eye-comfort `Warm Light` and `Soft Dark` themes, independent scroll panes (`h-screen overflow-hidden`) so scrolling the main workspace never scrolls the left skill sidebar, and an adaptive Multi-Level Action Tree (`Group` $\rightarrow$ `Subgroup` $\rightarrow$ compact accordion list), so that skills with 20+ actions remain scannable.
38. As a developer working inside the Web PTY drawer, I want `overscroll-behavior: contain` (so terminal scrolling never leaks to the page), drag-to-resize height handle, tab close (`×`) buttons, and a one-click `Shell` button that spawns `/bin/zsh -i` via a `ZDOTDIR` shim that preserves `<effectiveWorkspace>/.venv/bin` in `PATH` and exports `SKILL_DIR` and per-skill `envVars`, so that I have a full interactive terminal ready at any time.
39. As a developer managing skills across different repositories, I want each skill to bind its own `defaultWorkspace` and custom `envVars` (persisted in SQLite and/or `manifest.yaml`), so that switching between `vsip`, `refactor-review`, and `skill-dashboard` automatically switches `cwd` and `{{python}}`.
40. As a developer writing multi-step deployment or pod-sync operations in `manifest.yaml`, I want `script: |` (or multi-line `command: |`) to execute in an isolated temporary `/bin/zsh` script with `set -e` and `trap ... EXIT` support (and wrap in a subshell `(\nset -e\n...\n)` when copied to clipboard), so that I never have to chain lines with `&& \` or worry about `set -e` killing an interactive shell.
41. As a developer updating community skills via `npx skills update` or `git pull`, I want an "Update Skill" button that automatically backs up `<skill>/.dashboard/` before running the upstream updater and restores it afterward, paired with an "Agent Sync Manifest" button that launches Claude/Codex with an incremental edit prompt, so that companion Studio configs are never wiped by package updates.
42. As a developer organizing 60+ skills, I want multi-source semantic tag inference (`#python`, `#typescript`, `#git`, `#database`, `#excel`, `#code-review`, `#studio-ready`, etc.) and a collapsible Tag Filter bar in the left sidebar (collapsed by default) plus clickable `#tag` chips on skill cards, so that I can filter skills by domain or capability.
43. As a macOS developer, I want `skill-dashboard` to provide a `launchctl` Keep-Alive LaunchAgent (`~/Library/LaunchAgents/com.local.skill-dashboard.plist` via `src/service-manager.ts`), so that port `8766` stays permanently online across reboots and crashes.

### Reactive Architecture 2.0: Polyglot Data Graph, Parsers, Shapes & Multi-Layer UI
44. As a skill author, I want to declare skill-wide `context:` variables (such as `target_env: local | uat | prod`) rendered in a top `ContextToolbar`, so that switching a context variable automatically invalidates and recomputes all dependent `data` nodes in topological order and injects `{{context.<key>}}` into commands.
45. As a skill author, I want to declare named `data:` nodes that can execute in 7 runtimes—`zsh` (shell), `ts` (in-memory `Bun.Transpiler` TypeScript returning structured JS objects with zero subprocess overhead), `python` (workspace `.venv/bin/python` supporting `def main(ctx): return [...]`), `sqlite` (native `bun:sqlite` read-only queries with `$context` binding), `glob` (directory file metadata scanner), `file` (JSON/YAML/CSV/TSV reader), and `passive` (populated by an Action's output)—so that I can query data in whichever language or storage engine is most natural.
46. As a skill author extracting structured data from CLI stdout, I want declarative `parse:` formats (`auto`, `json` with noisy-log stripping and path extraction, `jsonl`, `csv`, `tsv`, `whitespace-table` for `kubectl`/`ps`-style aligned CLI tables, `regex` named capture groups, `kv`, `lines`, and `raw`) followed by an optional programmable `transform:` (`ts` or `python`), so that any raw command output can be turned into clean structured data without modifying the underlying CLI script.
47. As a skill author, I want `data:` nodes to normalize into 7 canonical `shape`s (`scalar`, `kv`, `list`, `table`, `matrix`, `stream`, `raw`) and automatically project into `FormFieldOption[]`, so that the same `table` node can simultaneously render as an interactive table widget and serve as the dropdown source for `FormField.fromData: "<nodeId>"`.
48. As a skill author, I want `data:` nodes to support DAG chaining (`dependsOn` and automatic extraction of `{{context.*}}`, `{{data.*}}`, and `ctx.data["*"]` references), so that derived `ts` or `python` nodes can compute metrics or filtered tables from an upstream node's snapshot without re-running slow CLI commands.
49. As a skill author, I want `data:` nodes to support reactive `sync:` lifecycles—including `onMount` with Single-Flight deduplication and `ttlMs` caching, debounced local directory watching (`watchFiles` via `fs.watch`), automatic invalidation when matching actions finish (`invalidateOnActions`), foreground interval polling (`pollMs`), and NDJSON event stream folding (`shape: "stream"` supporting `upsert`, `patch`, `delete`, `reset`)—so that the UI stays live and synchronized with local state.
50. As a developer using the Playground, I want `shape: "table"` nodes to render as an `InteractiveDataTable` with typed column formatting (`code`, `badge`, `bytes`, `datetime`, `progress`, `boolean`, `number`), instant row filtering, `rowActions` (injecting `{{row.<col>}}` into target actions), and multi-row `bulkActions` (injecting `{{selected.<col>}}`), and `shape: "matrix"` nodes to render as a `PivotMatrix` with clickable `cellAction` (`{{cell.rowKey}}`, `{{cell.colKey}}`), while enforcing `HumanApprovalGate` whenever a bound action has `danger: "warn" | "danger"` or `requiresHumanApprovalFlag`.
51. As a skill author, I want any `ActionItem` to optionally declare `output: { intoData: "<dataNodeId>", parse, transform, shape }`, so that running a parameterized action in the PTY automatically parses its stdout, updates the target `DataNode` snapshot, and invalidates any downstream derived nodes in the reactive graph (closing the `Action` $\rightarrow$ `Data` $\rightarrow$ `Widget` $\rightarrow$ `Action` recursive loop).
52. As a skill author building a custom HTML view (`type: "html"`), I want `window.SkillDashboard` Bridge 2.0 to support both zero-JS declarative HTML mounting (`<div data-sd-widget="nodeId">`, `<div data-sd-context-bar>`, `<button data-sd-action="actionId">`) and programmatic subscriptions (`SkillDashboard.subscribe(nodeId, cb)`, `SkillDashboard.data(nodeId)`, `SkillDashboard.setContext(key, val)`), so that custom web apps can reuse foundational tables, KPI cards, matrices, and actions with one line of HTML or JS.

### Explicit TypeScript `prelude`, Modular `.dashboard/` Linking & `manifest-cli` Authoring Toolsuite
53. As an AI agent or developer authoring `runtime: ts` or `transform: ts` code blocks, I want `prelude` to default to `false` (providing a pure TypeScript scope `{ ctx, Bun }` with automatic top-level `import ... from "..."` rewriting), while allowing explicit `prelude: true` (as recommended in `SKILL.md` and CLI templates) to pre-inject `{ fs, path, os, Database, YAML, $ }` in an outer closure scope that safely allows local variable shadowing (e.g., `const path = "..."`), so that the model always sees an explicit `prelude: true` signal when built-in helpers are in scope.
54. As a skill author maintaining a large skill (such as `vsip` with 24+ actions and multiple data nodes), I want `.dashboard/manifest.yaml` to support explicit modularization via top-level `includes: ["./modules/01-doc-extract.yaml", ...]` (vertical feature modules co-locating `data` and `actionGroups`), array-level `- $include: "./..."` items, and reusable `defs:` + `$ref: "#/defs/<key>"` templates—with zero hidden folder auto-scanning—so that `manifest.yaml` serves as a clear root index and modules can be edited independently.
55. As a skill author using modular `.dashboard/` files, I want the two-phase linker (`cascade.ts`) to first assemble all `includes` / `$include` / `$ref` into a unified `SkillManifest` symbol table (while recording `SymbolProvenance` for every `context`, `data`, `action`, and `view`) before `ReactiveGraphEngine` evaluates DAG dependencies, and I want `computeSkillsSignature` to track the `mtime` of all included module files, so that cross-file references (`fromData`, `rowActions`, `{{data.*}}`, `dependsOn`) and live hot-reload work seamlessly.
56. As a user editing a modular skill in the Web UI's `Manifest Studio` tab, I want a module file selector bar (`manifest.yaml`, `modules/01-doc-extract.yaml`, etc.) that reads and saves individual module files rather than overwriting the root `manifest.yaml` with the flattened bundle, so that saving in the UI never destroys modular structure.
57. As an AI agent or developer working on a modular skill, I want a dedicated CLI tool (`bun src/manifest-cli.ts`) with `map <skill_id>` and `refs <skill_id> <symbol_id>` commands that print a compact cross-file symbol index and bidirectional reference graph (showing which file defines each `context`/`data`/`action`/`view`, the columns of each table, and every `fromData`, `rowActions`, `dependsOn`, `{{data.*}}`, and `.html` `data-sd-widget` consumer across files), so that agents never get lost across multiple files.
58. As an AI agent or developer authoring or refactoring a manifest, I want `bun src/manifest-cli.ts` to provide `validate [<skill_id>]` (3-tier check: Zod schema + cross-file reference & cycle integrity + TS/Python compile & missing `prelude: true` detection), `eval-data <skill_id> [node_id] [--context k=v]` (terminal data node runner), `split <skill_id>` (automatic monolithic-to-modular splitter), `bundle <skill_id>`, and `schema [section]`, so that manifest authoring, debugging, and modularization form a fast, self-verifying closed loop.

### XDG 3-Tier Storage Governance, 3-Tier Unit Taxonomy (`Scratchpads / Workspaces / Skills`), Agent HITL Console & 3-Channel Run Artifacts
59. As a developer maintaining a clean workstation, I want Skill Dashboard to organize all files strictly under XDG 3-tier directories—Config (`~/.config/skill-dashboard/config.yaml` and `overrides/<id>/manifest.yaml`), Data (`~/.local/share/skill-dashboard/dashboard.db`, `logs/`, `units/<id>/`, `artifacts/<id>/<run_id>/`), and Cache (`~/.cache/skill-dashboard/scratchpads/<project>/<id>/`, `units/<id>/`, `runtime/scripts/`, `runtime/daemon.log`)—so that config is versionable, runtime data is persistent, and cache/scratchpads can be cleaned without polluting `~/.claude` or `/tmp`.
60. As a skill or workspace author whose operations generate backups, snapshots, caches, or report files, I want the engine to automatically allocate and inject `{{data_dir}}` (`$SD_DATA_DIR`), `{{cache_dir}}` (`$SD_CACHE_DIR`), and per-run `{{artifacts_dir}}` (`$SD_ARTIFACTS_DIR` with a `latest` symlink for preview/CLI commands) into all `data` nodes and `action` templates, so that generated files never pollute `{{skill_dir}}` source repositories or collide in `/tmp`.
61. As a user navigating `http://127.0.0.1:8766/`, I want the left sidebar categorized into three distinct top-level sections—**`⚡ Scratchpads`** (ephemeral Agent HITL consoles, pinned to the top when present), **`📁 Workspaces`** (explicitly managed project folders with a `+ Add Folder` button), and **`🧩 Agent Skills`** (canonical skills)—and I want deep-link URL routing (`/?id=<unit_id>&tab=<tab>&action=<action_id>`) so that clicking a link shared by an Agent opens and focuses the exact target console, view, or action immediately.
62. As a user chatting with an AI Agent (Claude Code / Codex), I want the Agent to be able to create an ephemeral interactive console on the fly without asking me for a folder path (via `bun src/manifest-cli.ts scratchpad create --id <slug> --title "..." [--project <cwd>]`), which automatically places the console under `~/.cache/skill-dashboard/scratchpads/<project_slug>/<slug>/`, binds its `defaultWorkspace` (`{{project_root}}` and `{{python}}`) to the current project directory, validates the manifest, and prints the direct URL `http://127.0.0.1:8766/?id=<unit_id>`.
63. As a user interacting with an Agent-created Scratchpad (or any unit) in the browser, I want to either execute PTY actions or click a **Submit Decision to Agent** control (also accessible to custom HTML views via `window.SkillDashboard.submitDecision(payload)` and table row selections), while the Agent in the terminal blocks synchronously via `bun src/manifest-cli.ts wait <unit_id> [--since <seq_or_ts>]` (backed by a race-free SQLite `unit_events` table) and wakes up within milliseconds with the structured JSON result of my action or selection.
64. As a user who finds an ephemeral Agent Scratchpad useful for recurring work, I want a one-click **`🌟 Promote`** button in the UI (and `bun src/manifest-cli.ts scratchpad promote <id> --to project|skill`) that promotes the scratchpad either into the bound project's `<project_root>/.dashboard/` (and registers `<project_root>` in `managedFolders`) or into a standalone global skill (`~/.agents/skills/<id>`), migrating its `{{data_dir}}` state seamlessly and removing the temporary cache entry.
65. As a user who wants to bring any local project or operations directory under Studio control, I want to click **`+ Add Folder`** in the `📁 Workspaces` section (or run `bun src/manifest-cli.ts folder add <path>`); if the folder does not yet have `.dashboard/manifest.yaml`, I want the UI to ask whether to create one (with a **"Remember my choice and don't ask again"** checkbox persisted to `config.yaml`'s `preferences.unconfiguredFolderAction: "ask" | "agent" | "skeleton" | "raw"`).
66. As a user who chooses to generate `.dashboard` for an unconfigured folder, I want the Studio to invoke the CLI Agent in the Web PTY (or copy the prompt) equipped with `bun src/manifest-cli.ts inspect <dir>` (which summarizes `package.json` scripts, `Makefile` targets, Python `.venv`/scripts, `.env.example`, and docs in one shot) and `bun src/manifest-cli.ts init <dir>`, so that the Agent crafts and validates a tailored `.dashboard/manifest.yaml` automatically.
67. As a user running actions that produce HTML diff reports, Excel audits, JSON snapshots, or images, I want a **3-Channel Run Artifact Pipeline** (`ActionItem.artifacts` supporting interpolated `path: "{{form.out}}"` and ANSI-stripped `fromStdout: "<regex>"` matchers with `mtime >= startedAt` verification, `::artifact path=...` stdout markers, and `{{artifacts_dir}}` directory auto-discovery, merged in strict priority order so fallback scans never overwrite explicit `label` or `onComplete: "badge" | "open" | "download"` settings) and a whitelisted gateway (`/api/runs/:runId/artifacts/:index`) for in-app previewing and one-click downloading.
68. As a user opening an unconfigured skill whose `SKILL.md` contains multi-line `bash` commands (such as `curl -X POST ... \` with multi-line single-quoted JSON `-d '{ ... }'` or heredocs `<<EOF`), I want Layer 0 (`ZeroConfigHeuristic`) to aggregate backslash continuations, unclosed multi-line quotes, and heredocs into a single cohesive `ActionItem` (filtering out standalone non-command JSON/output fragments), so that a single multi-line command is never shattered into 18 broken actions.
69. As a user who spots a broken or suboptimal manifest, action, data node, or view in the UI, I want a non-modal bottom-right **`🤖 Fix / Ask Agent` Floating Drawer** where I can toggle **`🎯 Pick on Page`** (or `Alt+Click`) to click any `ActionGroup`, `ActionItem`, `DataNode`, `ContextField`, or `SkillView` into context chips without cluttering cards with extra buttons, write a custom instruction (or pick a preset intent), have the system automatically target the existing defining module/layer file (or default to `<skill_dir>/.dashboard/manifest.yaml` when none exists), and either summon `claude` / `codex` directly in the Web PTY or copy the context-rich prompt to my clipboard.
70. As an AI Agent or developer installing and using `skill-dashboard` via `npx skills add <github-url>`, I want `SKILL.md` to use portable `~/.agents/skills/skill-dashboard/...` paths and organize its full specification hierarchically across **`SKILL.md`** and four deep-dive **`references/01..04-*.md`** manuals (`01-manifest-and-actions-spec.md`, `02-reactive-data-graph-and-parsers.md`, `03-custom-html-views-and-bridge-sdk.md`, `04-agent-hitl-scratchpads-and-modular-cli.md`, also exposed as Document Views in `skill-dashboard`'s own `.dashboard/manifest.yaml`), so that Agents have every schema, `ctx` field, parser, Bridge 2.0 API, and HITL Scratchpad playbook needed to exploit the dashboard to its fullest.
71. As a skill author whose skill needs multiple UI cards (e.g., a `kv` summary card and a `table` detail card) derived from a single expensive CLI / database query without unsafe implicit shell command merging, I want to declare explicit **`intermediate: true`** upstream `DataNode`s (alongside optional **`category: "<group>"`** tags on `DataNode`s) and have downstream `runtime: ts` nodes subscribe via `sync.dependsOn` and read `ctx.data["<upstream_id>"]` (exposing `rawParsed` structured output), while providing a **`🔬 Intermediates (N)`** toggle switch and category filter pills in the Data Panel so I can inspect intermediate DAG payloads and their reverse-dependents (`Referenced by: ...`) on demand.
72. As a developer loading or refreshing a complex skill like `vsip` with 10+ `DataNode`s, I want `evaluateAllSkillData` to evaluate the DAG concurrently (using node-level Single-Flight locks and a process concurrency semaphore rather than serial awaiting), `Bun.serve` to configure `idleTimeout: 60` so multi-second Python/DB queries are never killed at 10s, `executeInlineTypeScript` to inject `{ input, rawStdout, context, data, nodes }` into the `ts` scope, and the frontend `StatusProbesBar` to stream-load each visible `DataNode` independently with explicit error cards and `↻ Retry` buttons.
73. As a user clicking the top-right **Refresh** button in the Studio header, I want visible spinning feedback (`animate-spin`) and a full end-to-end refresh that simultaneously rescans disk manifests (`/api/bootstrap?refresh=1`), invalidates and re-evaluates all active `DataNode`s and `FormField.fromData` options (`refreshTrigger++`), and reloads the active `Manifest Studio` module file.
74. As a skill author or developer operating multi-repository or multi-environment workflows, I want the skill-level `workspace` (`defaultWorkspace` / header `Default cwd`) and `envVars` (`Default Env`) to act strictly as an inheritable **Default Environment Preference**, while every individual `ActionItem` and `DataNode` can declare its own independent **Command-Level Execution Environment** (`cwd`, `python`, `envFile`, and `env` key-values supporting `~`, `skill_dir`, `project_root`, `{{context.*}}`, and `{{form.*}}`), with `{{python}}`, `VIRTUAL_ENV`, and `PATH` automatically detected from that command's own resolved `cwd` (`resolveCommandEnvironment`) before falling back to the skill's default workspace preference.
75. As a user in the Studio UI, I want **every `ActionItem` card and every `DataNode` card** to include a compact **`⚙️ Env`** button (displaying `⚙️ Env` when inheriting the skill's default preference, or a highlighted `⚙️ Custom Env` badge when overridden in YAML or UI) that expands an inline **Command Execution Environment** configuration panel (`cwd` with local folder autocomplete, `python` runtime path with live auto-detected `.venv/bin/python` preview, `envFile` dotenv path, and per-command `env` key-value overrides), with actions to **Apply** (persisting to SQLite `cmd_env:<skillId>:action|data:<id>`), optionally **Write to Manifest** (via `SymbolProvenance`), **Reset to Default**, or **Apply as Skill Default**, immediately updating live command previews, `/api/fs/complete` roots, and cascading `DataNode` DAG evaluations.
76. As a user clicking any bound action button inside a `DataNode` (`rowActions` in a table row, `bulkActions` on selected rows, `quickActions` on a card, or `cellAction` in a matrix), I want an immediate **In-Place Action Audit & Execution Modal (`BoundActionInspectorModal`)** instead of a silent off-screen jump—displaying the trigger provenance (`DataNode` + trigger label + mode), a live **Argument Binding Audit Table** (`Form Key` | `YAML Template` | `Resolved Value` | `Form Field Match / Warning Status`), and an embedded, pre-filled `ActionCard` with live shell command preview, `⚙️ Env` inspection, one-click **`▶ Run in Web Terminal`** (with inline approval for `warn`/`danger` gates so modals never stack), and a **`↓ Locate in Playground`** button that smoothly scrolls to and highlights the action in the main Playground list.
77. As a user inspecting a `DataNode` table or card before clicking an action button, I want each bound action button (`rowActions`, `bulkActions`, `quickActions`) to visibly surface its target `→ <actionId>` badge, danger level indicator (`warn` / `danger` / `❌ Missing`), and hover tooltip showing the resolved arguments for that row, and when a table currently has `0` rows, I want a **`Bound Row Actions`** footer strip so I can still inspect and audit the table's configured row actions even when the table is empty.
78. As a user auditing how a `DataNode` produces its data and what actions it triggers, I want a **`🔍 Inspect`** button in every `DataNode` card header (next to `⚙️ Env` and `↻ Refresh`) that opens an inline **DataNode White-Box Inspector** with three views: (1) **`</> Execution Source`** showing the interpolated `resolvedSource` command/code/pattern/SQL alongside `📋 Copy` and **`▶ Test in Web Terminal`**, (2) **`⚡ Bound Actions (N)`** listing all `quickActions`/`rowActions`/`bulkActions`/`cellAction` with target action existence checks, `args` templates, and one-click `🔍 Audit Action`, and (3) **`📄 Raw Output & DAG`** showing the raw `stdout`/`stderr`, normalized `JSON` payload, `dependsOn`, and `invalidateOnActions`.

---

## Implementation Decisions

### 1. Runtime & Single-Process Full-Stack Architecture (`Bun` + `TypeScript`)
- The system runs on **Bun (`>= 1.3.x`)** using native APIs with zero native C++ addon dependencies (`node-pty` and `better-sqlite3` are explicitly avoided in favor of Bun built-ins):
  - **HTTP & WebSocket Server**: `Bun.serve` handles REST endpoints (`/api/*`), WebSocket streams (`/ws/runs/:runId`), static frontend assets, and whitelist-guarded skill media assets (`/api/assets`).
  - **Embedded Database**: `bun:sqlite` manages the `runs` and `workspaces` tables in `<data_dir>/dashboard.db`.
  - **Native Bidirectional PTY**: `Bun.spawn(cmd, { cwd, env, terminal: { cols, rows, data } })` allocates a real POSIX pseudo-terminal where `pid === pgid === sid`.
  - **Frontend Bundle**: React + Tailwind CSS + `xterm.js` (`@xterm/xterm` & `@xterm/addon-fit`) + Lucide icons, bundled via `Bun.build` into static assets served directly by `Bun.serve` for 100% offline, sub-50ms startup.

### 2. Modular Architecture & Single Highest Testing Seam
- The entire backend is instantiated through a single factory function `createDashboardServer(options: DashboardServerOptions)` which accepts injectable filesystem roots (`agentRoots`, `lockfiles`, `dataDir`, `defaultWorkspace`) and port (`0` for ephemeral test ports).
- Core internal modules behind the server factory:
  1. **Discovery & Mount Graph Module**: Scans configured `AgentMountRoot[]`, resolves symlinks via `lstat` + `realpath`, correlates `LockProvenance` from `.skill-lock.json` (v3) and `skills-lock.json` (v1), identifies `broken_symlink` entries, and executes symlink mount/unmount/repair actions.
  2. **4-Layer Config Cascade, Two-Phase Modular Linker & Zero-Config Heuristic Parser**:
     - Parses YAML frontmatter, Markdown headings, fenced bash blocks, CLI argument synopses, relative Markdown links (`references/**/*.md`), and Codex `agents/openai.yaml`.
     - **Two-Phase Explicit Modular Linker (`loadAndLinkManifestWithModules`)**:
       - Pass 1: Recursively loads root `.dashboard/manifest.yaml`, expands explicit top-level `includes: string[]` and array-level `- $include: "<path>"` entries (with cycle detection and `isPathInsideRoot` containment checks), collects all `defs:` into a unified definition map, and records `SymbolProvenance` (`moduleFiles`, and the defining relative file path for every `context`, `data`, `action`, and `view`).
       - Pass 2: Expands all `$ref: "#/defs/<key>"` references (merging base definitions with local property overrides) and merges `actionGroups` by group name.
     - Merges `Layer 0 (ZeroConfig)` $\leftarrow$ `Layer 1 (Linked Companion .dashboard/manifest.yaml + includes)` $\leftarrow$ `Layer 2 (GlobalOverride)` $\leftarrow$ `Layer 3 (WorkspaceOverride)`.
     - Persists user-edited manifests back to Layer 1/2/3 or individual module files (`GET/PUT /api/skills/:skillId/manifest-module`) without flattening modular skills.
  3. **Command Interpolator, Reactive Graph, Explicit `prelude` & Safety Engine**:
     - Resolves contextual variables (`{{skill_dir}}`, `{{project_root}}`, `{{python}}`, `{{context.<key>}}`, `{{data.<nodeId>.*}}`, `{{form.<key>}}`) and structured `FormField` flags.
     - Uses quote-aware escaping (`escapeForTemplateOffset`): if a placeholder is inside an unclosed double-quoted string `"..."` on the same line, only `"$`\\` characters are escaped so paths with spaces are not corrupted by nested single quotes; unquoted tokens use standard POSIX single-quote `shellEscape`.
     - Executes `DataNode`s across 7 runtimes (`zsh`, in-memory `Bun.Transpiler` `ts`, `.venv`-bound `python` receiving `ctx` via an isolated `SD_CTX_FILE` JSON file so `sys.stdin` remains untouched and `ARG_MAX` limits are never hit, `bun:sqlite` `sqlite`, `glob`, `file`, and `passive` nodes).
     - **Explicit `prelude` Contract for `runtime: ts` / `transform: ts`**: `prelude` defaults to `false` (pure `{ ctx, Bun }` scope with automatic top-level `import ... from "..."` rewriting to `await import(...)`). When `prelude: true` (or `manifest.tsPrelude: true`) is explicitly set, `{ fs, path, os, Database, YAML, $ }` are injected into the outer closure scope while user code runs inside an inner `async () => { ... }` closure so local variables (like `const path = ...`) can safely shadow outer helpers without `SyntaxError`.
     - Runs declarative parsers (`json`, `jsonl`, `whitespace-table`, `regex`, `csv`, `tsv`, `kv`, `lines`, `raw`) + NDJSON stream folding (`foldNdjsonStream` supporting `upsert`, `patch`, `delete`, `reset`), and embeds `quickActions`, `rowActions`, `bulkActions`, and `cellAction` directly inside `DataSnapshot`.
     - When an `ActionItem` with `output.intoData` finishes, invalidates all downstream derived nodes of the target `DataNode` before storing the new snapshot and skips self-deletion during `invalidateOnActions`.
     - Enforces `HumanApprovalGate` validation across all trigger surfaces (Action cards, table `rowActions`/`bulkActions`, matrix `cellAction`, and Custom HTML Bridge `runAction`) before executing `warn`/`danger` or `requiresHumanApprovalFlag` actions.
  6. **Manifest Symbol Graph & Diagnostics Engine (`manifest-cli`)**:
     - Provides `map <skill>`, `refs <skill> <id>`, `validate [<skill>]` (3-tier: Zod schema + cross-file reference/HTML widget/cycle verification + TS/Python compile & missing `prelude: true` hints), `eval-data <skill> [node]`, `split <skill>`, `bundle <skill>`, and `schema [section]`.
  4. **PTY Execution & Multi-Tier Persistence Engine**:
     - Manages active PTY subprocesses, window resizing, stdin writing, and process-group termination (`process.kill(-pid, "SIGTERM")` $\rightarrow$ grace timer $\rightarrow$ `process.kill(-pid, "SIGKILL")`).
     - Writes output chunks simultaneously to Tier 1 (`HotRingBuffer`), Tier 2 (`<dataDir>/logs/<runId>.log`), and updates Tier 3 (`bun:sqlite`).
     - Handles WebSocket `/ws/runs/:runId?offset=<byteOffset>` replay-then-live handoff and alternate screen buffer (`\x1b[?1049l`) cleanup on abnormal exit.
     - Runs startup reconciliation (`reconcileStaleRuns`) and log retention garbage collection.
  5. **Safe Asset & File Tree Inspector**:
     - Serves lazy directory listings (pruning `.git`, `node_modules`, `__pycache__`, `.venv`, `dist`, `build`, `.DS_Store`), text file contents, and binary media assets strictly validated against the canonical skill root whitelist (`realpath` containment check).

### 3. Canonical Data & Manifest Schema Contracts
The following TypeScript shapes (validated via `zod` and verified in our prototype spikes) encode the core contracts:

```typescript
// Provenance from ~/.agents/.skill-lock.json (v3) & ~/skills-lock.json (v1)
export interface LockProvenance {
  source: string;
  sourceType: string;
  sourceUrl?: string;
  skillPath?: string;
  skillFolderHash?: string;
  installedAt?: string;
  updatedAt?: string;
}

export type AgentEcosystem =
  | "agents-hub"
  | "claude"
  | "claude-workspace"
  | "agents-workspace"
  | "codex"
  | "codex-system"
  | "opencode"
  | "pi-agent"
  | "pi"
  | "openclaw"
  | "continue"
  | "trae"
  | "custom";

export interface AgentMount {
  agent: AgentEcosystem;
  mountPath: string;
  targetPath?: string;
  isSymlink: boolean;
  status: "mounted" | "standalone" | "broken_symlink";
}

export type FormFieldType =
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "multi-select"
  | "file"
  | "directory"
  | "env-secret"
  | "key-value"
  | "code"
  | "date";

export interface FormField {
  key: string;
  label: string;
  type: FormFieldType;
  flag?: string;           // e.g. "--env", "--file", "--dry-run"
  positional?: boolean;    // true if positional argument
  required?: boolean;
  default?: string | number | boolean | string[];
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string; meta?: string }>;
  fromData?: string;       // references a top-level DataNode.id for dynamic options
  valueColumn?: string;
  labelColumn?: string;
  metaColumn?: string;
  min?: number;
  max?: number;
  envVar?: string;         // for type === "env-secret", injected into process env
  when?: { field: string; equals: string | boolean | number };
}

export interface ContextField {
  key: string;
  label: string;
  type: "select" | "toggle" | "text";
  default?: string | boolean;
  options?: Array<{ label: string; value: string }>;
  fromData?: string;
}

export interface CommandEnvConfig {
  cwd?: "project_root" | "skill_dir" | string; // supports ~, absolute, relative, {{context.*}}, {{form.*}}
  python?: string;                             // optional explicit python binary; defaults to nearest .venv/bin/python from resolved cwd
  envFile?: string;                            // optional dotenv file path relative to resolved cwd (e.g. ".env.uat")
  env?: Record<string, string>;                // per-command environment variable overrides
}

export interface DataNode {
  id: string;
  title: string;
  description?: string;
  category?: string;       // optional Data Panel category grouping (e.g. "Document Extraction", "Identity & Roles")
  intermediate?: boolean;  // true for upstream DAG source nodes hidden by default and inspectable via "Show Intermediates" switch
  hidden?: boolean;
  runtime: "zsh" | "ts" | "python" | "sqlite" | "glob" | "file" | "passive";
  prelude?: boolean;       // default false; when true, pre-injects { fs, path, os, Database, YAML, $ }
  command?: string;
  script?: string;
  code?: string;
  entry?: string;
  db?: string;
  sql?: string;
  pattern?: string | string[];
  valueFormat?: "basename" | "relative" | "abspath";
  filePath?: string;
  cwd?: "project_root" | "skill_dir" | string;
  python?: string;
  envFile?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  parse?: {
    format: "auto" | "json" | "jsonl" | "csv" | "tsv" | "whitespace-table" | "regex" | "kv" | "lines" | "raw";
    path?: string;
    pattern?: string;
    delimiter?: string;
  };
  transform?: {
    runtime: "ts" | "python";
    prelude?: boolean;     // default false; when true, pre-injects { fs, path, os, Database, YAML, $ }
    code: string;
  };
  shape: "scalar" | "kv" | "list" | "table" | "matrix" | "stream" | "raw";
  primaryKey?: string;
  valueColumn?: string;
  labelColumn?: string;
  metaColumn?: string;
  columns?: Array<{
    key: string;
    label: string;
    type: "text" | "code" | "badge" | "bytes" | "datetime" | "progress" | "boolean" | "number";
  }>;
  pivot?: { rowKey: string; colKey: string; valueKey: string };
  quickActions?: BoundActionTrigger[];
  rowActions?: BoundActionTrigger[];
  bulkActions?: BoundActionTrigger[];
  cellAction?: BoundActionTrigger;
  sync?: {
    onMount?: boolean;
    ttlMs?: number;
    dependsOn?: string[];
    watchFiles?: string[];
    invalidateOnActions?: string[];
    pollMs?: number;
    stream?: boolean;
  };
}

export interface ActionItem {
  id: string;
  title: string;
  subgroup?: string;
  description?: string;
  danger: "safe" | "warn" | "danger";
  requiresHumanApprovalFlag?: string; // e.g. "--human-approved"
  interactive?: boolean;              // true for full-screen TUIs (prompt_toolkit, etc.)
  defaultRunner: "web_terminal" | "external_terminal" | "copy_command" | "copy_agent_prompt";
  cwd?: "project_root" | "skill_dir" | string;
  python?: string;
  envFile?: string;
  env?: Record<string, string>;
  command: string;                    // template supporting {{python}}, {{skill_dir}}, {{project_root}}, {{data_dir}}, {{cache_dir}}, {{artifacts_dir}}, {{context.*}}, {{data.*}}, {{form.*}}
  script?: string;                    // multi-line isolated script (`#!/bin/zsh\nset -e`)
  form?: FormField[];
  artifacts?: Array<string | ArtifactRule>; // structured 3-channel artifact extraction rules
  output?: {
    intoData?: string;                // pipes parsed action output back into a DataNode
    parse?: DataNode["parse"];
    transform?: DataNode["transform"];
    shape?: DataNode["shape"];
  };
}

export interface ArtifactRule {
  path?: string;                      // interpolated path template (e.g. "{{form.out}}" or "{{artifacts_dir}}/report.html")
  fromStdout?: string;                // regex with (?<path>...) or capture group $1 matched against ANSI-stripped stdout
  label?: string;
  kind?: "html" | "file" | "json" | "image" | "markdown";
  onComplete?: "badge" | "open" | "download"; // default "badge"
}

export interface RunArtifact {
  label: string;
  path: string;
  filename: string;
  kind: "html" | "file" | "json" | "image" | "markdown";
  sizeBytes: number;
  onComplete: "badge" | "open" | "download";
}

export type UnitKind = "skill" | "workspace" | "scratchpad";

export type UnconfiguredFolderAction = "ask" | "agent" | "skeleton" | "raw";

export interface DashboardConfig {
  server?: {
    port?: number;
    defaultWorkspace?: string;
  };
  preferences: {
    unconfiguredFolderAction: UnconfiguredFolderAction;
    scratchpadTtlDays: number;
  };
  managedFolders: Array<{
    path: string;
    label?: string;
    addedAt: string;
  }>;
  watchRoots: string[];
}

export interface UnitEvent {
  id: number;
  unitId: string;
  eventType: "run_completed" | "decision_submitted";
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface SkillView {
  id: string;
  title: string;
  type: "markdown" | "html" | "image" | "file";
  source: string; // path relative to skill root or .dashboard/
}

export interface SkillManifest {
  id: string;
  name: string;
  category: string;
  description: string;
  icon?: string;
  banner?: string;
  defaultWorkspace?: string;
  tsPrelude?: boolean;     // optional skill-wide default for ts prelude
  includes?: string[];     // explicit modular manifest file paths / globs
  defs?: Record<string, unknown>; // reusable field/object definitions referenced via $ref: "#/defs/<key>"
  envVars: SkillEnvVar[];
  context: ContextField[];
  data: DataNode[];
  tags: string[];
  defaultPrompt?: string;
  views: SkillView[];
  actionGroups: Array<{
    name: string;
    description?: string;
    subgroups?: ActionGroup[];
    actions: ActionItem[];
  }>;
}

export interface ManifestSymbolProvenance {
  moduleFiles: string[];
  defs: Record<string, string>;
  context: Record<string, string>;
  data: Record<string, string>;
  actions: Record<string, { file: string; group: string }>;
  views: Record<string, string>;
}

export interface AgentFixTarget {
  kind: "action-group" | "action" | "data-node" | "context" | "view" | "manifest";
  id: string;
  title: string;
  provenanceFile?: string;
  snippet?: unknown;
}

export interface AgentManifestSyncRequest {
  agentCli?: "claude" | "codex";
  userInstruction?: string;
  targets?: AgentFixTarget[];
  targetLayer?: "auto" | "companion" | "global_override" | "workspace_override";
}
```

### 4. REST API, Bridge 2.0 & WebSocket Protocol Contract
- `GET /api/bootstrap`: Returns `{ skills: CanonicalSkill[], brokenMounts: AgentMount[], activeWorkspace: string, pythonExecutable: string, recentWorkspaces: string[], agentTargets: AgentTargetInfo[], runs: ExecutionRun[] }`.
- `POST /api/workspace`: Sets `{ activeWorkspace: string, skillId?: string, saveToManifest?: boolean }` and re-evaluates workspace overrides and `{{python}}` resolution.
- `PUT /api/skills/:skillId/env`: Persists per-skill default environment variables (`Record<string, string>`).
- `PUT /api/skills/:skillId/command-env`: `{ targetKind: "action" | "data", targetId: string, envConfig: CommandEnvConfig | null, saveToManifest?: boolean, applyAsSkillDefault?: boolean }` — persists or clears a per-command execution environment override in SQLite (`cmd_env:<skillId>:<targetKind>:<targetId>`), optionally writes `cwd`/`python`/`envFile`/`env` back to the defining manifest module file via `SymbolProvenance`, or promotes `cwd` to the skill's default workspace preference; when `targetKind === "data"`, automatically invalidates the target `DataNode` and its downstream DAG dependents.
- `POST /api/mounts/toggle`: `{ skillId: string, agent: AgentEcosystem, enabled: boolean }` — creates clean relative symlinks (`../../.agents/skills/<id>`) or removes symlinks.
- `POST /api/mounts/repair`: `{ mountPath: string, action: "relink" | "remove", targetSkillId?: string }` — repairs or removes a broken symlink.
- `GET /api/skills/:skillId/files?path=<relPath>&mode=list|read&recursive=1`: Returns hierarchical directory entries or file content/metadata inside the skill's canonical directory.
- `GET /api/skills/:skillId/views?viewId=<id>&source=<relPath>`: Returns resolved Markdown/view content with rewritten asset URLs.
- `PUT /api/skills/:skillId/manifest`: `{ layer: "companion" | "global" | "workspace", manifest: Partial<SkillManifest> }` — persists manifest YAML to disk.
- `POST /api/skills/:skillId/update` & `POST /api/skills/update-all`: Runs guarded upstream skill update (`npx skills update` / `git pull`) while preserving `<skill>/.dashboard/`.
- `GET / POST /api/skills/:skillId/agent-sync`: Generates (`GET` or `POST` with `previewOnly: true`) or launches (`POST`) Agent-driven targeted `.dashboard` repair/authoring, accepting optional `userInstruction`, `targets: AgentFixTarget[]`, and `targetLayer`, and automatically resolving the write target to the existing defining module/layer file (`SymbolProvenance` / active override / companion) or `<skill_dir>/.dashboard/manifest.yaml`.
- `GET / PUT /api/skills/:skillId/context`: Reads or updates reactive `context` state and returns recomputed `snapshots`.
- `GET /api/skills/:skillId/data` & `GET /api/skills/:skillId/data/:nodeId?force=1`: Evaluates the polyglot reactive DAG and returns typed `DataSnapshot`s (including `rowActions`, `bulkActions`, `quickActions`, and `cellAction`).
- `GET /skill-app/:skillId/*`: Serves custom HTML app views with injected `<base href>` and `window.SkillDashboard` Bridge 2.0 (`getContext`, `setContext`, `data`, `subscribe`, `runAction`, `prefillAction`, `runInTerminal`, `submitDecision`, `<div data-sd-widget="id">`, `<div data-sd-context-bar>`, `<button data-sd-action="id">`).
- `POST /api/preview-command`: Interpolates `{{python}}`, `{{skill_dir}}`, `{{project_root}}`, `{{data_dir}}`, `{{cache_dir}}`, `{{artifacts_dir}}`, `{{context.*}}`, `{{data.*}}`, and `{{form.*}}` with secret masking.
- `GET /api/fs/complete?skillId=<id>&prefix=<path>&type=file|directory`: Local path autocomplete rooted at `effectiveWorkspace`.
- `POST /api/runs` & `DELETE /api/runs/:runId`: Pre-allocates `runId` and `{{artifacts_dir}}`, spawns tracked Bun PTY runs (single-line commands, isolated multi-line `#!/bin/zsh\nset -e` scripts in `~/.cache/skill-dashboard/runtime/scripts/`, or `ZDOTDIR`-shimmed interactive shells) or launches macOS `Terminal.app` / `iTerm2`, executes the 3-Channel Artifact Pipeline on process exit, records a `run_completed` `UnitEvent`, and pipes completed outputs into `ReactiveGraphEngine.onActionCompleted`.
- `GET /api/runs/:runId/artifacts/:index`: Whitelisted preview/download gateway serving files registered in `run.artifacts` (supports `?download=1`).
- `GET / PUT /api/config`: Reads or updates `~/.config/skill-dashboard/config.yaml` (including `preferences.unconfiguredFolderAction`, `managedFolders`, and storage tier stats).
- `POST / DELETE /api/folders`: Registers or removes a `ManagedFolder` (`workspace` unit); returns `{ unit, hasManifest, unconfiguredFolderAction }` so the UI can trigger the Agent `.dashboard` generation workflow when unconfigured.
- `POST /api/scratchpads` & `POST /api/scratchpads/:id/promote` & `DELETE /api/scratchpads/:id`: Creates an ephemeral Agent Scratchpad under `~/.cache/skill-dashboard/scratchpads/<project_slug>/<id>/`, promotes it into `<project_root>/.dashboard/` (`target: "project"`) or `~/.agents/skills/<id>` (`target: "skill"`), or deletes it.
- `GET / POST /api/units/:id/events`: Appends a `decision_submitted` HITL event (`POST`) or queries/long-polls (`GET ?since=<id_or_ts>&waitMs=<ms>`) for `manifest-cli wait <id>`.
- `WS /ws/runs/:runId?offset=<number>`: Replays historical Tier 2 ANSI bytes from `offset` and transitions to live Tier 1 streaming (`{ stream: true }` UTF-8 decoding).

---

## Testing Decisions

### 1. Philosophy: Good Tests Verify External Behavior at the Highest Seam
- All automated tests run via `bun test` against the **Single Server Seam (`createDashboardServer`)** and `src/manifest-cli.ts` subprocess execution.
- Tests construct isolated temporary directory trees in `os.tmpdir()` simulating XDG tiers (`configDir`, `dataDir`, `cacheDir`), multi-agent directories (`.agents/skills`, `.claude/skills`, `.codex/skills/.system`, `.skill-lock.json`, broken symlinks, and workspaces with `.venv/bin/python`) and drive the server purely through HTTP `fetch()` and standard `WebSocket` clients.
- Zero internal module mocking: SQLite persistence, log file streaming, symlink creation/repair, YAML manifest reading/writing, `ReactiveGraphEngine` polyglot execution (`zsh`, `ts`, `python`, `sqlite`, `glob`, `file`), 3-channel artifact extraction, HITL `unit_events` synchronization, and real Bun PTY subprocess execution (`Bun.spawn({ terminal })`) are tested end-to-end.

### 2. Modules & Scenarios Covered via the Server Seam
1. **Multi-Agent Discovery, Semantic Tags & Mount Graph**:
   - Deduplicates a canonical skill symlinked across `.agents`, `.claude`, and `.pi`; infers semantic tags; detects and repairs broken symlinks; creates clean relative symlinks (`../../.agents/skills/<id>`).
2. **4-Layer Config Cascade, Zero-Config Heuristic Inference & Multi-Level Hierarchy**:
   - Parses `SKILL.md` frontmatter, multi-level headings (`H2/H3/H4`), bash synopses, relative Markdown links, and Codex `agents/openai.yaml`; merges Layers 0–3 and persists edits via `PUT /api/skills/:id/manifest`.
3. **Command Interpolation, Per-Skill Workspaces, Multi-Line Isolated Scripts & Safety Gates**:
   - Resolves per-skill `{{python}}`, `{{data_dir}}`, `{{cache_dir}}`, `{{artifacts_dir}}`, `{{context.*}}`, `{{data.<nodeId>.*}}`, and `{{form.*}}`; executes multi-line `script: |` with `set -e` and `trap ... EXIT` in isolated script files; enforces `HumanApprovalGate` across all triggers.
4. **Native Bun PTY Execution, Interactive `ZDOTDIR` Shell, Process-Group Kill & Multi-Tier Re-Attach**:
   - Verifies streaming UTF-8 box-drawing characters across chunk boundaries, interactive `ZDOTDIR` `.venv` activation, process-group kill (`-pgid`), Tier 2/3 WebSocket replay, and stale run reconciliation.
5. **Upstream Skill Updater Guard & Live Disk Cache Invalidation**:
   - Verifies `.dashboard/` backup & restoration across destructive upstream updates and automatic `mtime` signature cache invalidation.
6. **Reactive Architecture 2.0 (`context`, Polyglot `data` Graph, `intoData` Recursion, Stream Folding & Bridge 2.0)**:
   - Verifies `glob` tables, `whitespace-table` parsing, in-memory `Bun.Transpiler` `ts` derived nodes, structured `python` `def main(ctx)` nodes, `context` switch cascading invalidation, `output.intoData` action-to-data feedback and downstream invalidation, NDJSON `stream` event folding (`upsert`/`patch`), and `/skill-app/:skillId/*` Bridge 2.0 injection.
7. **Explicit `prelude`, Two-Phase Modular `.dashboard/` Linker & `manifest-cli` Symbol Graph**:
   - Verifies `prelude: false` (default strictness + static `import ... from "..."` rewriting) vs `prelude: true` (outer-scope injection of `{ fs, path, os, Database, YAML, $ }` with inner-scope variable shadowing safety).
   - Verifies explicit modular linking (`includes: [...]`, `- $include: "..."`, `defs:` + `$ref: "#/defs/..."`), cross-file `fromData` & `rowActions` resolution, `SymbolProvenance` tracking, sub-module `mtime` hot-reload, per-module read/write via `/api/skills/:id/manifest-module`, and `manifest-cli` (`map`, `refs`, `validate`, `eval-data`, `split`).
8. **XDG 3-Tier Storage, 3-Tier Units (`Scratchpad / Workspace / Skill`), HITL Sync & 3-Channel Run Artifacts**:
   - Verifies XDG `configDir`, `dataDir`, and `cacheDir` isolation and `config.yaml` persistence (`managedFolders`, `unconfiguredFolderAction`).
   - Verifies adding unconfigured folders, inspecting via `manifest-cli inspect <dir>`, and initializing via `manifest-cli init <dir>`.
   - Verifies creating project-bound Agent Scratchpads (`manifest-cli scratchpad create`), deep-link discovery under `unitKind: "scratchpad"`, synchronous HITL feedback (`POST /api/units/:id/events` waking up `manifest-cli wait <id>`), and promoting a scratchpad into `<project_root>/.dashboard/` (`unitKind: "workspace"`) or `~/.agents/skills/<id>` (`unitKind: "skill"`).
   - Verifies 3-channel artifact extraction priority (explicit `path` and `fromStdout` regex with `onComplete: "open" | "download"` taking precedence over `::artifact` and `{{artifacts_dir}}` scans) and whitelisted retrieval via `GET /api/runs/:runId/artifacts/:index`.
9. **Multi-Line Zero-Config Bash Statement Aggregator, Targeted Agent Fix API & Progressive Skill References**:
   - Verifies Layer 0 (`parseZeroConfigSkill`) aggregates multi-line `curl -X POST ... \` commands containing multi-line single-quoted JSON payloads (`-d '{ ... }'`) and heredocs into single cohesive `ActionItem`s rather than per-line fragments.
   - Verifies `POST /api/skills/:id/agent-sync` incorporates custom `userInstruction` and clicked `targets: AgentFixTarget[]` snippets, resolves the target file to existing module/layer files when present or `<skill_dir>/.dashboard/manifest.yaml` when unconfigured, and validates all `references/01..04-*.md` views registered in `skill-dashboard/.dashboard/manifest.yaml`.
10. **Explicit Intermediate DAG DataNodes (`intermediate: true`), Category Grouping, Concurrent DAG Evaluation & Top-Level Refresh**:
   - Verifies `DataNode`s with `intermediate: true` and `category` execute their upstream command exactly once when multiple downstream `runtime: ts` nodes (`dependsOn: ["<upstream_id>"]`) evaluate concurrently, exposing `rawParsed` via `ctx.data["<upstream_id>"]` and top-level `{ input, rawStdout, data, context, nodes }` in `executeInlineTypeScript`.
   - Verifies `evaluateAllSkillData` runs DAG nodes concurrently without serial 10-second timeouts, and verifies `vsip`'s refactored intermediate DAG nodes pass `manifest-cli validate vsip`.
11. **Per-Command Execution Environment (`cwd` + `python` + `envFile` + `env`) & Default Workspace Preference Inheritance**:
   - Verifies that skill-level `workspace` and `envVars` act as default preferences inherited by `DataNode`s and `ActionItem`s, while any individual `DataNode` or `ActionItem` can override `cwd`, `python`, `envFile`, and `env` either declaratively in `manifest.yaml` or dynamically via `PUT /api/skills/:id/command-env`.
   - Verifies that `resolveCommandEnvironment` resolves `{{python}}`, `VIRTUAL_ENV`, and `PATH` from the command's own `cwd` `.venv/bin/python` first (falling back to the skill's default workspace `.venv/bin/python` and `python3`), loads `.env` files (`envFile`), masks secrets in command previews and `DataSnapshot.resolvedEnv`, cascades DAG invalidation when a `DataNode`'s environment changes, and roots `/api/fs/complete` at the command's resolved `cwd`.
12. **DataNode White-Box Source Inspection (`resolvedSource`) & Bound Action Argument Audit**:
   - Verifies that `DataSnapshot` returns `resolvedSource` containing the fully interpolated command, script, code, glob patterns, file path, or SQL query executed by `ReactiveGraphEngine`.
   - Verifies that bound triggers (`rowActions`, `bulkActions`, `quickActions`, `cellAction`) interpolate row/selection/context values cleanly into target `ActionItem` command previews (`POST /api/preview-command`) and that `vsip` data node `rowActions` (`eval-golden-docs`, `extraction-inbox`, `extraction-configs`, `extraction-backups`) resolve clean arguments and pass `manifest-cli validate vsip`.

---

## Out of Scope

- **Cloud / Remote Multi-Tenant Hosting**: Skill Dashboard is strictly a local developer workstation tool binding to `127.0.0.1` (`localhost`), not a multi-user cloud SaaS service (no OAuth/OIDC user login).
- **LLM Token Streaming / Chat Client Replacement**: The dashboard orchestrates, inspects, configures, and executes skills and scripts (or hands prompts off to agents); it does not replace Claude Code or Codex as an LLM chat client.
- **Cross-OS Native Terminal AppleScript Equivalents for Windows**: Native external terminal window launching (`osascript` for `Terminal.app` / `iTerm2`) targets macOS first; on non-macOS systems, the embedded Web Terminal (`xterm.js` + Bun PTY) and Clipboard Handoff serve as the primary execution modes.

---

## Further Notes

- **Port Selection & Single-Instance Ergonomics**: Default port is `8765` (configurable via `PORT` or `--port`). If `8765` is already running an active Skill Dashboard instance (`GET /api/health` returns `{ app: "skill-dashboard" }`), the CLI opener reuses the running instance and opens the browser URL rather than failing with `EADDRINUSE`.
- **Target Benchmarks**:
  - Cold start to listening server: `< 150ms` on Bun.
  - Full scan & canonical deduplication of 60+ skills across 11 agent directories: `< 50ms`.
