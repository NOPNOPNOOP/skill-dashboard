# Issue 21: Multi-Level Clickable Data Scope Tree (`All ➔ Category ➔ Subgroup ➔ Node`), 100% Isomorphic Inline & `intermediate` Actions, 4-Layer Multi-Source Scope (`focusScope`), Bidirectional Selective Refresh (`sync.refreshAfterActions` ⇌ `output.refreshData`), Holistic 4-Tab DataNode `🔍 Inspect` & Zero-Config `🕸️ Context ➔ Data ⇌ Action` Architecture Graph

Status: completed
Parent: `.scratch/skill-dashboard/PRD.md` (User Stories #88, #89, #90)

## Problem Statement

1. **Non-Clickable Data Category Headers & Single-Level Data Grouping**:
   - Unlike the Action Hierarchy Tree (`All Actions` $\rightarrow$ clickable `Group` $\rightarrow$ clickable `Subgroup` $\rightarrow$ `Action`), the Data Panel's left navigator renders `category` headers as static text labels. Users cannot click a `Category` or `Subgroup` header to display all `DataNode`s under that hierarchy level on the right canvas, and top-bar category pills duplicate the left tree state.
2. **Heavyweight Registration Required for Data-Bound Actions & Missing `focusScope` Propagation**:
   - Every `quickActions` / `rowActions` / `bulkActions` / `nodeActions` / `cellAction` button currently requires registering a separate top-level `ActionItem` in `actionGroups` and referencing it via `actionId`.
   - Internal helper actions that only make sense when invoked from a data row clutter the main Operations Playground because `ActionItem` lacks an `intermediate: true` flag.
   - When an action uses multi-source data (`{{data.<anyNodeId>.*}}`) alongside host focus variables (`{{self.*}}`, `{{row.*}}`, `{{node.*}}`, `{{cell.*}}`), `/api/preview-command` and `/api/runs` do not receive `focusScope`, preventing direct inline template interpolation in live previews and PTY runs.
3. **Thundering-Herd Action Refresh & Incomplete `DataNode` White-Box `🔍 Inspect`**:
   - `ReactiveGraphEngine.onActionCompleted` invalidates all non-passive `DataNode`s whenever any action completes unless `invalidateOnActions` is set, and `ActionItem.output` cannot declaratively specify `refreshData: string[]`.
   - `DataNode` `🔍 Inspect` lacks YAML module provenance, full upstream/downstream DAG & multi-source Action lineage (`fromData`, `preconditions`, `{{data.*}}`, `intoData`, `refreshData` / `refreshAfterActions`), and one-click `↗ Jump` navigation, and there is no top-level interactive `🕸️ Context ➔ Data ⇌ Action` architecture graph with feedback-loop arc rendering.

## Solution

1. **Multi-Level Clickable Data Scope Tree (`All ➔ Category ➔ Subgroup ➔ Node`) + Scope Density & `📌 Pin` (`src/types.ts`, `src/ui/StatusProbesBar.tsx`)**:
   - Add `subgroup?: string` to `DataNodeSchema` and `DataSnapshot` (also supporting `/` separation in `category: "Group / Subgroup"`).
   - Upgrade the left Data Navigator to support 4-level clickable scope selection (`all`, `category`, `subgroup`, `node`) with collapsible category/subgroup branches, `↻ Refresh Scope`, density switching (`Cards` / `Accordion` / `Grid`) for multi-node scopes, and persistent top `📌 Pinned` master nodes.
2. **100% Isomorphic Inline Actions, `ActionItem.intermediate: true`, & 4-Layer Multi-Source `focusScope` (`src/types.ts`, `src/cascade.ts`, `src/interpolator.ts`, `src/server.ts`, `src/ui/ActionCard.tsx`, `src/ui/MultiLevelPlayground.tsx`, `src/ui/StatusProbesBar.tsx`)**:
   - Extend `BoundActionTriggerSchema` to support both **Ref Mode** (`actionId`) and **Inline Mode** (`command` / `script` + isomorphic `ActionItem` fields: `cwd`, `python`, `envFile`, `env`, `danger`, `requiresHumanApprovalFlag`, `interactive`, `form`, `preconditions`, `artifacts`, `output`).
   - Normalize inline triggers during manifest loading with deterministic IDs (`inline:<nodeId>:<slot>:<slug(label)>`), `inlineHost` metadata, `intermediate: true`, and module provenance; provide `findSkillAction(manifest, actionId)` across `/api/preview-command`, `/api/runs`, `PUT /api/skills/:id/command-env`, and `manifest-cli`.
   - Pass `focusScope` (`{ hostNodeId, row, selectedRows, cell, node }`) through `BoundActionInspectorModal`, `ActionCard`, `/api/preview-command`, and `/api/runs`, resolving `{{self}}`, `{{self.<path>}}`, `{{row.*}}`, `{{node.*}}`, `{{cell.*}}`, and `{{selected.*}}` alongside `{{data.<anyNodeId>.*}}` and `{{context.*}}` with quote-aware shell escaping.
   - Add `🔬 Intermediates (N)` toggle to the Action Playground to show/hide `intermediate: true` actions.
3. **Bidirectional Selective Refresh (`sync.refreshAfterActions` $\rightleftharpoons$ `output.refreshData`), Holistic 4-Tab DataNode `🔍 Inspect`, & `🕸️ Context ➔ Data ⇌ Action` Architecture Graph (`src/probes.ts`, `src/interpolator.ts`, `src/manifest-cli.ts`, `src/ui/StatusProbesBar.tsx`, `src/ui/ActionCard.tsx`)**:
   - Add `refreshAfterActions?: string[]` to `DataSyncSchema` and `refreshData?: string[]` to `ActionOutputSchema`, updating `ReactiveGraphEngine.onActionCompleted` to selectively invalidate matched `DataNode`s and their downstream `dependsOn` subgraph.
   - Build `buildSkillReactiveArchitecture` with 4 semantic swimlanes (`0: Context`, `1: Source Data`, `2: View Data`, `3: Actions`), cyclic blast-radius reachability, and forward-curve / feedback-dashed-arc SVG rendering.
   - Upgrade `DataNode` `🔍 Inspect` to 4 tabs (`Source & Provenance`, `DAG Lineage & Action Bindings`, `Views & Payload`, `Raw Declaration`) and `ActionCard` `🔍 Inspect` with bidirectional `↗ Jump` navigation.

## Acceptance Criteria

- [x] Clicking `All Data Nodes`, a `📁 Category` header, a `📂 Subgroup` header, or a `📄 DataNode` leaf in the left Data Navigator filters the right canvas to that exact scope (with `Cards` / `Accordion` / `Grid` density switching, `↻ Refresh Scope`, and `📌 Pin` preservation).
- [x] `BoundActionTrigger` supports both Ref Mode (`actionId`) and 100% isomorphic Inline Mode (`command` / `script` + `ActionItem` fields), normalized with deterministic `inline:<nodeId>:<slot>:<slug>` IDs and validated by `manifest-cli validate`.
- [x] `interpolateActionCommand`, `/api/preview-command`, `/api/runs`, and `BoundActionInspectorModal` resolve the 4-layer multi-source scope stack (`{{context.*}}`, `{{data.<anyNodeId>.*}}`, `{{form.*}}`, and `focusScope` `{{self}}`/`{{self.*}}`/`{{row.*}}`/`{{node.*}}`/`{{cell.*}}`/`{{selected.*}}`).
- [x] `ActionItem.intermediate: true` hides internal/reusable actions from the default Action Playground view with a `🔬 Intermediates (N)` toggle.
- [x] `DataNode.sync.refreshAfterActions` and `ActionItem.output.refreshData` selectively invalidate and refresh targeted `DataNode`s and their downstream `dependsOn` dependents without invalidating unrelated probes.
- [x] `DataNode` `🔍 Inspect` provides 4 comprehensive tabs (`Source & Provenance`, `DAG Lineage & Action Bindings`, `Views & Payload`, `Raw Declaration`) with one-click `↗ Jump` between linked `DataNode`s and `ActionCard`s, and the Data Workbench includes a toggleable 4-swimlane `🕸️ Context ➔ Data ⇌ Action` Architecture Graph with feedback-loop arcs and blast-radius highlighting.
- [x] `skills/skill-dashboard/.dashboard/` dogfoods `subgroup`, isomorphic inline `rowActions`/`quickActions`, and `refreshAfterActions` / `output.refreshData`, passing `manifest-cli validate skill-dashboard` and `bun test`.
