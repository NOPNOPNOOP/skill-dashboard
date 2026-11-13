# Issue 20: Explicit 5-Primitive Typing, Declarative Multi-View Projection Specs (`pivot` Wide/Long, `treeSpec`, `listSpec`, `graphSpec`), Cross-View Action Inheritance, Left-Click Run / Right-Click Configure, Unified Command-Box `⚙️ Env`, Action `🔍 Inspect` & 3-Mode Data Workbench

Status: completed
Parent: `.scratch/skill-dashboard/PRD.md` (User Stories #84, #85, #86, #87)

## Problem Statement

1. **Implicit Data Primitive Identity & Missing Declarative Multi-View Projection Specs in `data:` Nodes**:
   - Users cannot immediately see which of the 5 Data Primitives (`Scalar`, `Records`, `Document`, `Graph`, `Raw`) a `DataNode` produces vs. which UI presentation (`shape`) is currently active.
   - When switching views on a `DataNode` (e.g., `Table ⇄ Matrix ⇄ List ⇄ Tree`), authors cannot declaratively configure per-view mapping rules (`treeSpec.groupBy`, wide-table `pivot.colKeys`, `listSpec`, `graphSpec`) in `manifest.yaml`, and switching a wide table (`skills-catalog-table`) to `Matrix` produces sparse `—` cells when using a long-table pivot heuristic.
   - Bound `rowActions` (`{{row.id}}`) defined on a `table` node do not carry over when the user switches the card to `tree`, `list`, `matrix`, or `graph`.
2. **Bound Action Trigger Friction & Visual Clutter (`→ <actionId>`)**:
   - Clicking a bound action button on a `DataNode` with left-click always opens `BoundActionInspectorModal` instead of executing safe `run`-mode actions immediately, and every button appends a noisy `→ <actionId>` code badge.
3. **Duplicate `⚙️ Env` Controls, Missing Markdown Code-Block `⚙️ Env`, & No White-Box `🔍 Inspect` on Actions**:
   - `ActionCard` renders `⚙️ Env` twice (once in the card title header and again inside the `Live Workspace-Resolved Command` box).
   - Executable bash blocks in `MarkdownViewer.tsx` (`Knowledge & Docs`) lack the `⚙️ Env` button in their command bar, and `/api/preview-command` ignores `action:adhoc-runbook` environment overrides when `actionId` is omitted.
   - `ActionCard` lacks a `🔍 Inspect` panel to inspect its defining YAML module file (`provenance`), raw command/script template, form `fromData` bindings, `preconditions`, and reverse-indexed upstream `DataNode` triggers.
4. **Cluttered DataNode Grid Layout**:
   - Mixing single-value `scalar` cards, `kv` cards, and full-width `table`/`matrix`/`graph`/`tree` cards in a single flat grid stretches the page vertically and makes Master-Detail (`selectContextKey`) interaction require scrolling up and down.

## Solution

1. **Explicit `DataPrimitive` & Declarative Multi-View Projection Specs (`src/types.ts`, `src/interpolator.ts`, `src/probes.ts`, `src/manifest-cli.ts`)**:
   - Add `DataPrimitiveSchema` (`"Scalar" | "Records" | "Document" | "Graph" | "Raw"`) and compute `primitive` in `normalizeToShapeAndOptions` and `DataSnapshot`.
   - Extend `MatrixPivotSchema` with optional `colKeys?: string[]` and `emptyValue?: string` (supporting both Long-Table Pivot and Wide-Table Attribute Matrix), and add `TreeSpecSchema` (`groupBy`, `labelKey`, `metaKey`, `valueKey`, `defaultExpandDepth`), `ListSpecSchema`, `GraphSpecSchema`, and `views?: DataShape[]` on `DataNodeSchema`.
   - Attach `rawRow?: Record<string, unknown>` to projected tree leaves, list items, matrix rows, and graph nodes, and unify `row` / `node` / `cell` scope fallback in `interpolateBoundTriggerArgs`.
2. **Left-Click Direct Run / Right-Click Configure & Clean Action Buttons (`src/ui/StatusProbesBar.tsx`)**:
   - Remove `→ <actionId>` badge from bound action buttons.
   - Left-click (`onClick`) executes immediately in Web Terminal when `mode !== "prefill"`, `danger === "safe"`, `!requiresHumanApprovalFlag`, all required form fields have values, and no `preconditions` fail; otherwise opens `BoundActionInspectorModal`.
   - Right-click (`onContextMenu`) prevents default context menu and opens `BoundActionInspectorModal`.
3. **Consolidated Command-Box `⚙️ Env` (Action + DataNode + Markdown) & Action `🔍 Inspect` (`src/ui/ActionCard.tsx`, `src/ui/MarkdownViewer.tsx`, `src/ui/MultiLevelPlayground.tsx`, `src/server.ts`)**:
   - Remove the duplicate top-right `⚙️ Env` button from `ActionCard` header (keeping it inside the `Live Workspace-Resolved Command` box header) and replace the top-right slot with **`🔍 Inspect`** (`Template & Provenance`, `Form & Data Bindings`, `Raw Declaration`).
   - Move `DataNode`'s `⚙️ Env` toggle into `Inspect -> Execution Source` command header (showing a compact clickable custom-env pill on the card header only when overridden).
   - Add `⚙️ Env` to `InlineExecutableCommandRow` in `MarkdownViewer.tsx` (`targetKind: "action", targetId: "adhoc-runbook"`) and honor `commandEnvOverrides["action:adhoc-runbook"]` in `/api/preview-command` and `/api/skills/:id/run`.
4. **Two-Tier Ergonomic Data Workbench (`Scalar Strip` + `Split Focus / Accordion / Grid` with `📌 Pin`)**:
   - Render `primitive === "Scalar"` nodes in a compact top KPI strip.
   - Add layout switcher (`Split Focus`, `Accordion`, `Grid`) to the Data Panel control bar; in `Split Focus` mode, provide a left categorized node navigator with `Primitive ➔ View` badges and `📌 Pin` toggles so pinned master tables and focused detail graphs/trees render together in a single viewport.

## Acceptance Criteria

- [x] `DataSnapshot.primitive` is populated (`Scalar`, `Records`, `Document`, `Graph`, `Raw`) and displayed as `Primitive ➔ View` in the UI and `🔍 Inspect`.
- [x] `DataNode` supports declarative `pivot` (both long-table `colKey/valueKey` and wide-table `colKeys`), `treeSpec` (`groupBy` multi-level directory tree), `listSpec`, `graphSpec`, and `views` whitelist, with cross-view `rawRow` action inheritance.
- [x] Bound action buttons on `DataNode`s omit `→ <actionId>`, execute directly on Left-Click (when safe & satisfied), and open `BoundActionInspectorModal` on Right-Click (`onContextMenu`).
- [x] `⚙️ Env` appears once inside the command preview box on `ActionCard`, inside `DataNode` `Inspect -> Execution Source`, and on executable bash blocks in `MarkdownViewer.tsx` (with `/api/preview-command` honoring `action:adhoc-runbook`).
- [x] `ActionCard` includes a `🔍 Inspect` panel showing YAML provenance, template, form/data bindings, upstream triggers, and raw declaration.
- [x] `StatusProbesBar.tsx` separates top `Scalar` KPI cards and provides `Split Focus` (with `📌 Pin` side-by-side master-detail view), `Accordion`, and `Grid` layouts.
- [x] `skills/skill-dashboard/.dashboard/` dogfoods multi-view specs (`pivot`, `treeSpec`, `listSpec`) and passes `manifest-cli validate skill-dashboard` and `bun test`.
