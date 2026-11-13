# Issue 19: 5-Primitive Data Model & View Decoupling (`kv` Nested JSON, `tree`, `graph` Impact Radius, `list`, `matrix`), Master-Detail `selectContextKey`, Action `preconditions` & Full `skill-dashboard` Dogfooding

Status: completed
Parent: `.scratch/skill-dashboard/PRD.md` (User Stories #81, #82, #83)

## Problem Statement

1. **`kv` Truncates Nested JSON & `tree` / `list` Lack Dedicated Normalization/Rendering**:
   - `normalizeToShapeAndOptions` converts nested objects/arrays inside `shape: "kv"` into flat `JSON.stringify(v)` strings, losing structure, and `shape: "tree"` falls through to the `table` branch returning `rows: []` for object trees.
   - `StatusProbesBar.tsx` lacks dedicated UI renderers for `shape: "list"`, `shape: "tree"`, and `shape: "graph"`, and cards cannot switch visual projections in-place without editing YAML.
2. **No Graph-Shaped Data Primitive (`shape: "graph"`) with Topological Layering & Impact Radius**:
   - Pipeline lineage, service/tunnel topologies, and dependency impact networks (`{ nodes, edges }`) cannot be expressed as a first-class reactive data node with automatic Kahn layering, cycle/dangling-edge resilience, upstream/downstream blast-radius computation (`upstreamIds` / `downstreamIds`), and `{{node.downstreamIds}}` action binding.
3. **Missing Data-Layer Master-Detail Drill-Down (`selectContextKey`), Action `preconditions`, & Protected `passive` `intoData` Snapshots**:
   - Clicking an item in an upstream `table`/`list`/`tree`/`graph` cannot declaratively update a `context` variable (`selectContextKey`) to filter downstream nodes, and `StatusProbesBar.updateContextField` previously triggered a redundant full-skill `?invalidate=1` cache wipe via `refreshTrigger`.
   - `ActionItem` lacks declarative `preconditions` against upstream `DataNode` snapshots, and `MultiLevelPlayground` does not share `StatusProbesBar` snapshots with `ActionCard`.
   - `ReactiveGraphEngine.invalidateSkill` wipes `runtime: "passive"` snapshots during global refreshes (`?invalidate=1`), erasing data just written by `ActionItem.output.intoData`, and `executeNodeRuntime` re-evaluating a `passive` node passed `existing.value` instead of `existing.rawParsed`.
4. **Incomplete Shape & Data-Flow Dogfooding in `skills/skill-dashboard/.dashboard/`**:
   - `skill-dashboard`'s own `.dashboard/` only uses `scalar`, `kv`, `table`, and `raw`, leaving `tree`, `graph`, `matrix`, `list`, `passive` (`output.intoData`), multi-source SQLite + filesystem Join, `selectContextKey`, and `preconditions` unrepresented.

## Solution

1. **5-Primitive Data Model & Lossless `kv` / `tree` / `graph` Normalization (`src/types.ts`, `src/probes.ts`, `src/interpolator.ts`, `src/manifest-cli.ts`)**:
   - Add `"graph"` and `"auto"` to `DataShapeSchema`.
   - Preserve `rawValue?: unknown` on `KvEntry` when a field's value is a nested object or array so `kv` cards can render inline expandable sub-trees.
   - Implement `buildTreeFromArbitraryData` for `shape: "tree"` (supporting both arbitrary nested JSON objects/arrays and explicit `{ id, label, value, meta, tone, children }[]` nodes).
   - Implement `computeGraphTopology` for `shape: "graph"` (`{ nodes, edges }`), automatically synthesizing missing edge endpoints, computing `layer` (Kahn's longest-path layering with cycle fallback), `upstreamIds`, and `downstreamIds` for every node, and projecting `nodes` into `FormFieldOption[]`.
   - Enhance `resolveDataSnapshotPath` (`{{data.<nodeId>.<deep.path>}}`) to traverse `snap.rawParsed` at arbitrary JSON depth, and enhance `interpolateBoundTriggerArgs` to support `node` scope (`{{node.id}}`, `{{node.label}}`, `{{node.value}}`, `{{node.path}}`, `{{node.upstreamIds}}`, `{{node.downstreamIds}}`).
   - Preserve `runtime === "passive"` snapshots in `ReactiveGraphEngine.invalidateSkill(skillId, preservePassive = true)` and use `existing?.rawParsed` in `executeNodeRuntime` for `passive` nodes; fall back to `this.paths.dbPath` in `sqlite` runtime when `~/.local/share/skill-dashboard/dashboard.db` is absent in isolated sandboxes.
   - Validate `nodeActions`, `selectContextKey`, and `preconditions` (`dataNodeId` + `fixActionId`) in `manifest-cli.ts` (`buildManifestSymbolGraph` and `validateSkillManifest3Tier`).
2. **Decoupled UI View Switcher & `Graph` / `Tree` / `List` / Nested-`KV` Renderers (`src/ui/StatusProbesBar.tsx`, `src/ui/ActionCard.tsx`, `src/ui/MultiLevelPlayground.tsx`)**:
   - Add per-card **View Switcher** pills in `StatusProbesBar.tsx` (`KV ⇄ Tree`, `Table ⇄ Matrix ⇄ List ⇄ Tree`, `Graph ⇄ Table ⇄ Tree`) using in-place projection from `snap.rawParsed` / `snap.value` (with heuristic pivot fallback for `Table -> Matrix`) without mutating backend `ctx.data`.
   - Render inline expandable JSON sub-trees inside `kv` cells when `entry.rawValue` is an object/array.
   - Render `InteractiveTreeWidget` (`shape: "tree"`), `InteractiveListWidget` (`shape: "list"`), and deterministic-coordinate SVG + card `InteractiveGraphWidget` (`shape: "graph"`) with upstream/downstream impact highlighting and `nodeActions` / per-node `actionId` triggers.
   - Support `DataNode.selectContextKey` for one-click Master-Detail context filtering across `table`, `list`, `tree`, and `graph`, and skip redundant `?invalidate=1` reloads when `updateContextField` itself triggered `onContextChanged`.
   - Support `ActionItem.preconditions` in `ActionCard` and `BoundActionInspectorModal` (sharing `dataSnapshots` via `MultiLevelPlayground`) with live warning banners and one-click `fixActionId` buttons.
3. **Full Dogfooding in `skills/skill-dashboard/.dashboard/` & Documentation Sync (`SKILL.md`, `references/02-*.md`)**:
   - Add `focus_skill` context variable (`default: "all"`).
   - Enrich `service-telemetry` (`kv`) with nested `storagePaths` and `runtimeInfo` JSON objects.
   - Add `skills-run-stats-raw` (`intermediate: true`, `runtime: sqlite`) and join it with `skills-catalog-raw` inside `skills-catalog-table` (`selectContextKey: "focus_skill"`).
   - Add `ecosystem-mount-matrix` (`shape: "matrix"` with `cellAction`), `skill-reactive-graph` (`shape: "graph"` with `nodeActions`), `manifest-symbol-tree` (`shape: "tree"`), `architecture-issues-list` (`runtime: "glob"`, `shape: "list"`), and `last-symbol-map-output` (`runtime: "passive"`, populated by `manifest-cli-map`'s `output.intoData`), plus `preconditions` on `sync-target-skill`.
   - Update `SKILL.md` and `references/02-reactive-data-graph-and-parsers.md`.

## Acceptance Criteria

- [x] `shape: "kv"` preserves `rawValue` for nested objects/arrays and renders expandable sub-trees in UI; `resolveDataSnapshotPath` resolves deep nested paths (`{{data.node.a.b.c}}`).
- [x] `shape: "tree"` normalizes both arbitrary nested JSON and explicit tree nodes into `{ roots: TreeNodeItem[] }`.
- [x] `shape: "graph"` computes `layer`, `upstreamIds`, and `downstreamIds` for each node (handling cycles and dangling edges), and `interpolateBoundTriggerArgs` resolves `{{node.id}}`, `{{node.upstreamIds}}`, and `{{node.downstreamIds}}`.
- [x] `StatusProbesBar.tsx` renders `graph`, `tree`, `list`, `matrix`, `table`, and `kv` with in-place View Switcher controls and `selectContextKey` master-detail filtering (without triggering redundant full-skill cache wipes).
- [x] `ActionItem.preconditions` is validated in schema/L2-Graph and rendered in `ActionCard` and `BoundActionInspectorModal`.
- [x] `ReactiveGraphEngine.invalidateSkill` preserves `runtime: "passive"` snapshots populated by `output.intoData`.
- [x] `skills/skill-dashboard/.dashboard/` dogfoods all canonical shapes and passes `manifest-cli validate skill-dashboard` and `bun test` with 0 errors.
