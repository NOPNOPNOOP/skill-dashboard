# 03. Custom HTML App Views (`type: html`) & `window.SkillDashboard` Bridge 2.0 SDK

When standard Playground forms and widgets are not enough—such as for side-by-side diff inspectors, 3-pane evaluation war rooms, interactive API playgrounds (like `jev`), or HITL approval boards—you can add custom HTML views under `.dashboard/views/*.html`.

---

## 1. Registering a Custom HTML View in `manifest.yaml`

```yaml
views:
  - id: control-center
    title: "🎛️ Interactive Control Center"
    type: html
    source: ".dashboard/views/control_center.html"
```

- Skill Dashboard serves the HTML at `/skill-app/<skillId>/<source>` (resolving relative CSS, JS, images, and fonts inside the skill directory automatically) and injects **`window.SkillDashboard`** into `<head>` before any page script runs.
- You can deep-link directly to any custom view via:
  `http://127.0.0.1:8766/?id=<unit_id>&tab=view:<view_id>`

---

## 2. Zero-JS Declarative HTML Mounting (`data-sd-*` Attributes)

Bridge 2.0 includes a `MutationObserver` runtime that automatically mounts live reactive widgets and action triggers onto declarative HTML attributes—requiring **zero custom JavaScript**:

### 2.1 Global Context Switcher Bar (`data-sd-context-bar`)
```html
<div data-sd-context-bar></div>
```
Renders the skill's `context:` controls (`select`, `toggle`, `text`). Changing a control updates the backend context and refreshes all mounted widgets on the page automatically.

### 2.2 Live Reactive Data Widgets (`data-sd-widget="<nodeId>"`)
```html
<div data-sd-widget="service-telemetry"></div>
<div data-sd-widget="skills-catalog-table"></div>
```
Automatically fetches and renders the `DataNode` (`scalar` KPI card, `kv` grid, `table` with `rowActions` buttons, `matrix` with clickable `cellAction` cells, `list`, or `raw`) and re-renders whenever `dataUpdated` or `runCompleted` fires.

### 2.3 Action Trigger Buttons (`data-sd-action="<actionId>"`)
```html
<!-- Execute action directly in Web PTY (enforces HumanApprovalGate if warn/danger) -->
<button
  data-sd-action="rebuild-and-restart"
  data-sd-args='{"fast": true}'
  data-sd-mode="run">
  🔄 Rebuild & Restart
</button>

<!-- Jump to Playground and pre-fill the action form -->
<button
  data-sd-action="sync-target-skill"
  data-sd-args='{"skill_id": "vsip"}'
  data-sd-mode="prefill">
  Configure & Run →
</button>
```

---

## 3. Programmatic JavaScript SDK (`window.SkillDashboard`)

For bespoke interactive UIs, call `window.SkillDashboard` directly from your `<script>`:

```ts
// 1. Read unit metadata, active workspace, python path, theme ("light"|"dark"), and context state
const ctx = await window.SkillDashboard.getContext();
// -> {
//   skillId, skillName, effectiveWorkspace, pythonExecutable,
//   configuredEnv, theme, context: { target_env: "uat" }, contextFields: [...]
// }

// 2. Update a global reactive context variable (triggers DAG recomputation)
await window.SkillDashboard.setContext("target_env", "local");

// 3. Evaluate or read a DataNode snapshot
const snapshot = await window.SkillDashboard.data("skills-catalog-table", { force: false });
// -> { id, shape: "table", status: "ok", value: { columns, rows, primaryKey }, durationMs }

// 4. Subscribe to live updates for a DataNode (calls callback immediately + on every refresh)
const unsubscribe = window.SkillDashboard.subscribe("service-telemetry", (snap) => {
  console.log("Updated telemetry:", snap.value);
});

// 5. Trigger a declared ActionItem in the host Web PTY
await window.SkillDashboard.runAction("doc-extract-backup", { name: "pre_release" });

// 6. Jump to Playground and pre-fill an ActionItem's form
await window.SkillDashboard.prefillAction("doc-extract-restore", { target: "backup.json" });

// 7. Run an ad-hoc shell command in the host Web PTY
await window.SkillDashboard.runInTerminal("pytest -q", "Run Pytest Suite");

// 8. Submit a structured HITL Decision to wake up `manifest-cli wait <unit_id>`
await window.SkillDashboard.submitDecision({
  decision: "approved",
  selectedIds: [101, 104],
  notes: "Reviewed and approved in custom HTML console",
});

// 9. Listen to host lifecycle events
window.SkillDashboard.on("runCompleted", (payload) => { /* ... */ });
window.SkillDashboard.on("dataUpdated", (payload) => { /* ... */ });
window.SkillDashboard.on("workspaceChanged", (payload) => { /* ... */ });
window.SkillDashboard.on("themeChanged", ({ theme }) => { /* "light" | "dark" */ });
```

---

## 4. Minimal Starter Template for `.dashboard/views/custom.html`

Bridge 2.0 automatically synchronizes `data-theme="light" | "dark"` on `document.documentElement` and provides default `.sd-*` widget styles:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Custom Operations Console</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --border: #e2e8f0;
      --accent: #0284c7;
    }
    html[data-theme="dark"] {
      --bg: #0f172a;
      --card: #1e293b;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --border: #334155;
      --accent: #38bdf8;
    }
    body {
      margin: 0;
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 16px; }
    .btn {
      background: var(--accent); color: #fff; border: none; border-radius: 8px;
      padding: 8px 14px; font-weight: 600; cursor: pointer;
    }
  </style>
</head>
<body>
  <div data-sd-context-bar style="margin-bottom: 16px;"></div>

  <div class="grid">
    <div class="card">
      <h3>Live Telemetry</h3>
      <div data-sd-widget="service-telemetry"></div>
    </div>
    <div class="card">
      <h3>Human-in-the-Loop Approval</h3>
      <button class="btn" id="approve-btn">✅ Approve & Resume Agent</button>
    </div>
  </div>

  <script>
    document.getElementById("approve-btn").addEventListener("click", async () => {
      await window.SkillDashboard.submitDecision({ decision: "approved", source: "custom-view" });
    });
  </script>
</body>
</html>
```
