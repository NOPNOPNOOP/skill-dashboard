# Issue 17: DataNode White-Box Inspector & In-Place Bound Action Audit Modal

Status: completed
Parent: `.scratch/skill-dashboard/PRD.md` (User Stories #76, #77, #78)

## Problem Statement

1. **Silent Off-Screen Jump When Clicking Table / Card Actions**:
   - In `MultiLevelPlayground`, clicking a `rowAction` (e.g., `运行抽取 -> doc-extract-run` or `查看详情 -> config-show`), `bulkAction`, `quickAction`, or `cellAction` either calls `onPrefillJump(actionId, formValues)` (which silently sets `focusedActionId` in the accordion 1,500px below the viewport without visual feedback or scrolling) or runs blindly without letting the user inspect the interpolated command first.
2. **Black-Box Bound Action Buttons & Empty Table Blind Spot**:
   - Table action buttons only display a generic `▶ <label>` without surfacing the target `actionId`, its `danger` gate status (`warn` / `danger` / missing target), or the interpolated arguments for that row.
   - When a table has `0` rows, configured `rowActions` are completely invisible and cannot be audited.
3. **Black-Box `DataNode` Execution Source & Bindings**:
   - `DataNode` cards lack an inspection view (`🔍 Inspect`) to audit the node's own interpolated command/code/pattern/SQL (`resolvedSource`), its bound action triggers (`rowActions`, `bulkActions`, `quickActions`, `cellAction`), and its raw stdout / normalized JSON payload.
4. **Row Value Pollution in `vsip` `eval-golden-docs`**:
   - `eval-golden-docs` formats `doc_id` as `"#597"`, causing `{{row.doc_id}}` in `eval-inspect-case` and `eval-run` to pass `'#597'` instead of `'597'`.

## Solution

1. **In-Place Bound Action Audit & Execution Modal (`BoundActionInspectorModal`)**:
   - Clicking any `rowAction`, `bulkAction`, `quickAction`, or `cellAction` in `StatusProbesBar` opens an in-place modal right over the current viewport.
   - Displays a **Binding Provenance & Argument Mapping Audit Table** (`Form Key` | `YAML Template` | `Resolved Value` | `Form Field Match / Warning Status`).
   - Embeds the interactive `ActionCard` (`inAuditModal={true}`) pre-filled with the resolved row/context arguments (`key={`${actionId}-${seq}`}`), showing the syntax-highlighted shell command preview, `⚙️ Env` overrides, inline approval for `warn`/`danger` gates (no stacked modals), **`▶ Run in Web Terminal`** (which starts the PTY run and closes the modal), and **`↓ Locate in Playground`** (which closes the modal, expands the target action in the Playground list, and smoothly scrolls to it).
2. **Explicit Action Badges on Buttons & Empty-Table Binding Strip**:
   - Every bound action button in `StatusProbesBar` displays `[icon] <label> → <actionId>` with color-coded `warn`/`danger`/`missing` badges and a hover tooltip showing resolved row arguments.
   - When a table has `0` rows and `rowActions.length > 0`, renders a `Bound Row Actions` strip below the empty message so users can click and audit any bound row action at any time.
3. **DataNode `🔍 Inspect` White-Box Panel & `DataSnapshot.resolvedSource`**:
   - Backend `ReactiveGraphEngine` populates `resolvedSource` on `DataSnapshot` with the interpolated command (`zsh`), code (`ts`/`python`), expanded glob patterns (`glob`), file path (`file`), or DB + SQL (`sqlite`).
   - Every `DataNode` card header includes a **`🔍 Inspect`** button (next to `⚙️ Env` and `↻ Refresh`) with 3 tabs:
     1. `</> Execution Source`: shows `resolvedSource` + YAML source + `📋 Copy` + `▶ Test in Terminal` (for `zsh` nodes).
     2. `⚡ Bound Actions (N)`: lists all bound triggers on the node with target action existence verification, `args` template mapping, and a `🔍 Audit Action` button.
     3. `📄 Raw Output & DAG`: shows raw `stdout`/`stderr`, normalized `snap.value` JSON, `dependsOn`, and `invalidateOnActions`.
4. **Clean Row Argument Binding in `vsip`**:
   - Update `eval-golden-docs` in `vsip` so `raw_doc_id` holds the clean numeric ID (`"597"`) and `rowActions` pass `{{row.raw_doc_id}}`.

## Acceptance Criteria

- [x] `DataSnapshot` includes `resolvedSource?: string` populated across `zsh`, `ts`, `python`, `glob`, `file`, and `sqlite` runtimes.
- [x] Clicking any `rowAction`, `bulkAction`, `quickAction`, or `cellAction` opens the in-place `BoundActionInspectorModal` showing the Argument Binding Audit Table and embedded `ActionCard`.
- [x] `ActionCard` with `inAuditModal={true}` supports direct execution (including inline `warn`/`danger` approval without opening a second nested modal) and auto-closes the modal when `▶ Run in Web Terminal` is triggered.
- [x] Clicking `↓ Locate in Playground` inside the modal closes the modal, focuses/expands the target action in `MultiLevelPlayground`, and scrolls it into view with a highlight ring.
- [x] Every `DataNode` card header has a `🔍 Inspect` toggle button showing `</> Execution Source`, `⚡ Bound Actions (N)`, and `📄 Raw Output & DAG`.
- [x] Table `rowActions` buttons show `→ <actionId>` badges and resolved argument tooltips, and empty tables with `rowActions` display a clickable `Bound Row Actions` audit bar.
- [x] `vsip`'s `eval-golden-docs` passes clean numeric document IDs (`597` instead of `#597`) to `eval-inspect-case` and `eval-run`, and `bun test` passes all end-to-end tests.
