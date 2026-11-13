import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { interpolateBoundTriggerArgs, resolveDataSnapshotPath } from "../src/interpolator.ts";
import {
  buildManifestSymbolGraph,
  formatManifestMapReport,
  formatSymbolRefsReport,
  initManifestInDirectory,
  inspectTargetDirectory,
  validateSkillManifest3Tier,
} from "../src/manifest-cli.ts";
import { createDashboardServer, type DashboardServerInstance } from "../src/server.ts";
import type { AgentMountRoot } from "../src/types.ts";
import { highlightCodeToHtml, splitMarkdownIntoSegments } from "../src/ui/highlight.ts";

describe("Skill Dashboard — Single Server Seam End-to-End Suite", () => {
  let sandboxDir: string;
  let homeDir: string;
  let workspaceDir: string;
  let dataDir: string;
  let agentRoots: AgentMountRoot[];
  let lockfilePath: string;
  let instance: DashboardServerInstance | null = null;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "skill-dashboard-seam-"));
    homeDir = join(sandboxDir, "home");
    workspaceDir = join(sandboxDir, "workspace");
    dataDir = join(sandboxDir, "data");

    const agentsHub = join(homeDir, ".agents/skills");
    const claudeGlobal = join(homeDir, ".claude/skills");
    const claudeWorkspace = join(workspaceDir, ".claude/skills");
    const codexSystem = join(homeDir, ".codex/skills/.system");
    const piAgent = join(homeDir, ".pi/agent/skills");

    mkdirSync(agentsHub, { recursive: true });
    mkdirSync(claudeGlobal, { recursive: true });
    mkdirSync(claudeWorkspace, { recursive: true });
    mkdirSync(codexSystem, { recursive: true });
    mkdirSync(piAgent, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    // Create fake .venv/bin/python in workspaceDir that delegates to system python3
    const venvBin = join(workspaceDir, ".venv/bin");
    mkdirSync(venvBin, { recursive: true });
    const fakePython = join(venvBin, "python");
    writeFileSync(fakePython, "#!/bin/sh\nexec python3 \"$@\"\n", "utf-8");
    chmodSync(fakePython, 0o755);

    // 1. Create a Zero-Config complex skill in ~/.agents/skills/demo-ops
    const demoSkillDir = join(agentsHub, "demo-ops");
    mkdirSync(join(demoSkillDir, "references"), { recursive: true });
    mkdirSync(join(demoSkillDir, "assets"), { recursive: true });
    writeFileSync(
      join(demoSkillDir, "assets/diagram.svg"),
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"10\"/></svg>",
      "utf-8"
    );
    writeFileSync(
      join(demoSkillDir, "references/arch.md"),
      "# Demo Architecture\n\n![Diagram](../assets/diagram.svg)\n",
      "utf-8"
    );
    writeFileSync(
      join(demoSkillDir, "SKILL.md"),
      `---
name: Demo Operations
description: Zero-config multi-tool skill for testing synopsis inference
---

# Demo Operations Skill

See [Architecture Reference](references/arch.md) for details.

## 1. Data Sync & Extraction

### Sync Pipeline
\`\`\`bash
# Fetch remote snapshot
python ~/.agents/skills/demo-ops/sync.py fetch --env {uat|prod} --file <input.xlsx> [--limit 50] [--dry-run] --human-approved
\`\`\`
`,
      "utf-8"
    );

    // Symlink demo-ops into both claudeGlobal and piAgent
    symlinkSync(demoSkillDir, join(claudeGlobal, "demo-ops"), "dir");
    symlinkSync(demoSkillDir, join(piAgent, "demo-ops"), "dir");

    // 2. Create a broken symlink in workspace .claude/skills pointing to non-existent relative target,
    //    while a valid target with the same name exists in agentsHub!
    symlinkSync(
      join(sandboxDir, "non-existent/demo-ops"),
      join(claudeWorkspace, "demo-ops"),
      "dir"
    );

    // 3. Create a Codex skill with agents/openai.yaml
    const codexSkillDir = join(codexSystem, "image-maker");
    mkdirSync(join(codexSkillDir, "agents"), { recursive: true });
    mkdirSync(join(codexSkillDir, "assets"), { recursive: true });
    writeFileSync(join(codexSkillDir, "assets/icon.svg"), "<svg></svg>", "utf-8");
    writeFileSync(
      join(codexSkillDir, "agents/openai.yaml"),
      `interface:
  display_name: "Image Maker"
  short_description: "Generate assets with Codex"
  icon_small: "./assets/icon.svg"
  default_prompt: "Use $image-maker to generate an icon."
`,
      "utf-8"
    );

    // 4. Write lockfile
    lockfilePath = join(homeDir, ".agents/.skill-lock.json");
    writeFileSync(
      lockfilePath,
      JSON.stringify({
        version: 3,
        skills: {
          "demo-ops": {
            source: "acme/demo-skills",
            sourceType: "github",
            sourceUrl: "https://github.com/acme/demo-skills.git",
            skillFolderHash: "abc123456789",
          },
        },
      }),
      "utf-8"
    );

    agentRoots = [
      { agent: "agents-hub", label: "Agents Hub", path: agentsHub, scope: "global", canToggleMount: false },
      { agent: "claude", label: "Claude", path: claudeGlobal, scope: "global", canToggleMount: true },
      { agent: "claude-workspace", label: "Workspace", path: claudeWorkspace, scope: "workspace", canToggleMount: true },
      { agent: "codex-system", label: "Codex System", path: codexSystem, scope: "global", canToggleMount: false },
      { agent: "pi-agent", label: "Pi Agent", path: piAgent, scope: "global", canToggleMount: true },
    ];
  });

  afterEach(async () => {
    if (instance) {
      await instance.stop();
      instance = null;
    }
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  test("1. Multi-Agent Discovery, Deduplication, Lock Provenance, Broken Mount Repair & Toggle", async () => {
    instance = createDashboardServer({
      port: 0,
      homeDir,
      defaultWorkspace: workspaceDir,
      dataDir,
      agentRoots,
      lockfiles: [lockfilePath],
    });

    const res = await fetch(`${instance.url}/api/bootstrap`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    // Deduplicated: demo-ops (mounted in agents-hub, claude, pi-agent) + image-maker = 2 canonical skills
    expect(data.skills.length).toBe(2);

    const demo = data.skills.find((s: any) => s.id === "demo-ops");
    expect(demo).toBeDefined();
    expect(demo.mounts.map((m: any) => m.agent).sort()).toEqual(["agents-hub", "claude", "pi-agent"]);
    expect(demo.provenance?.source).toBe("acme/demo-skills");
    expect(demo.provenance?.skillFolderHash).toBe("abc123456789");

    // Broken symlink detected in claude-workspace
    expect(data.brokenMounts.length).toBe(1);
    expect(data.brokenMounts[0].agent).toBe("claude-workspace");
    expect(data.brokenMounts[0].skillName).toBe("demo-ops");
    expect(data.brokenMounts[0].suggestedRepairPath).toContain(".agents/skills/demo-ops");

    // Repair broken symlink via POST /api/mounts/repair
    const repairRes = await fetch(`${instance.url}/api/mounts/repair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mountPath: data.brokenMounts[0].mountPath,
        action: "relink",
      }),
    });
    expect(repairRes.status).toBe(200);
    const repaired = (await repairRes.json()) as any;
    expect(repaired.brokenMounts.length).toBe(0);

    const demoAfterRepair = repaired.skills.find((s: any) => s.id === "demo-ops");
    expect(demoAfterRepair.mounts.map((m: any) => m.agent).sort()).toEqual([
      "agents-hub",
      "claude",
      "claude-workspace",
      "pi-agent",
    ]);

    // Toggle mount off for pi-agent via POST /api/mounts/toggle
    const toggleRes = await fetch(`${instance.url}/api/mounts/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        agent: "pi-agent",
        enabled: false,
      }),
    });
    expect(toggleRes.status).toBe(200);
    const toggled = (await toggleRes.json()) as any;
    expect(toggled.skill.mounts.some((m: any) => m.agent === "pi-agent")).toBe(false);
    expect(existsSync(join(homeDir, ".pi/agent/skills/demo-ops"))).toBe(false);
  });

  test("2. Zero-Config Heuristic Inference, Codex openai.yaml & 4-Layer Cascade Persistence", async () => {
    instance = createDashboardServer({
      port: 0,
      homeDir,
      defaultWorkspace: workspaceDir,
      dataDir,
      agentRoots,
      lockfiles: [lockfilePath],
    });

    const boot = (await (await fetch(`${instance.url}/api/bootstrap`)).json()) as any;
    const demo = boot.skills.find((s: any) => s.id === "demo-ops");
    const codexSkill = boot.skills.find((s: any) => s.id === "image-maker");

    // Verify Codex openai.yaml extraction
    expect(codexSkill.manifest.name).toBe("Image Maker");
    expect(codexSkill.manifest.description).toBe("Generate assets with Codex");
    expect(codexSkill.manifest.icon).toBe("./assets/icon.svg");
    expect(codexSkill.manifest.defaultPrompt).toContain("$image-maker");

    // Verify Zero-Config views & CLI synopsis form inference on demo-ops
    expect(demo.manifest.views.length).toBe(2);
    expect(demo.manifest.views[1].source).toBe("references/arch.md");

    const syncGroup = demo.manifest.actionGroups[0];
    expect(syncGroup.name).toBe("Sync Pipeline");
    const syncAction = syncGroup.actions[0];
    expect(syncAction.title).toBe("Fetch remote snapshot");
    expect(syncAction.requiresHumanApprovalFlag).toBe("--human-approved");
    expect(syncAction.danger).toBe("danger"); // contains "prod"

    const fieldByKey = Object.fromEntries(syncAction.form.map((f: any) => [f.key, f]));
    expect(fieldByKey.env.type).toBe("select");
    expect(fieldByKey.env.options.map((o: any) => o.value)).toEqual(["uat", "prod"]);
    expect(fieldByKey.file.type).toBe("file");
    expect(fieldByKey.file.required).toBe(true);
    expect(fieldByKey.limit.type).toBe("number");
    expect(fieldByKey.limit.default).toBe(50);
    expect(fieldByKey.dry_run.type).toBe("boolean");

    // Verify Markdown view image path rewriting
    const viewRes = await fetch(
      `${instance.url}/api/skills/demo-ops/views?viewId=${encodeURIComponent(demo.manifest.views[1].id)}`
    );
    const viewData = (await viewRes.json()) as any;
    expect(viewData.content).toContain("/api/assets?skill=demo-ops&path=assets%2Fdiagram.svg");

    // Persist Companion Manifest (Layer 1) and Workspace Override (Layer 3)
    const putCompanion = await fetch(`${instance.url}/api/skills/demo-ops/manifest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        layer: "companion",
        manifest: {
          ...demo.manifest,
          name: "Demo Ops Companion Title",
        },
      }),
    });
    expect(putCompanion.status).toBe(200);
    const companionData = (await putCompanion.json()) as any;
    expect(companionData.skill.layers.companion).toBe(true);
    expect(companionData.skill.manifest.name).toBe("Demo Ops Companion Title");

    // Layer 3 Workspace Override takes precedence over Layer 1 Companion
    const putWorkspace = await fetch(`${instance.url}/api/skills/demo-ops/manifest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        layer: "workspace",
        manifest: {
          name: "Demo Ops Workspace Title",
        },
      }),
    });
    const wsData = (await putWorkspace.json()) as any;
    expect(wsData.skill.layers.workspaceOverride).toBe(true);
    expect(wsData.skill.manifest.name).toBe("Demo Ops Workspace Title");
  });

  test("3. Command Interpolation, .venv Python Resolution, Shell Escaping, Secret Masking & Human-Approval Gate", async () => {
    instance = createDashboardServer({
      port: 0,
      homeDir,
      defaultWorkspace: workspaceDir,
      dataDir,
      agentRoots,
      lockfiles: [lockfilePath],
    });

    // Save a custom action with env-secret and file path
    await fetch(`${instance.url}/api/skills/demo-ops/manifest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        layer: "companion",
        manifest: {
          actionGroups: [
            {
              name: "Test Group",
              actions: [
                {
                  id: "gated-sync",
                  title: "Gated Sync",
                  danger: "warn",
                  requiresHumanApprovalFlag: "--human-approved",
                  defaultRunner: "web_terminal",
                  cwd: "project_root",
                  command: "{{python}} -c 'import os, sys; print(\"ARGV:\", sys.argv[1:], \"SECRET:\", os.environ.get(\"API_SECRET\"))' {{form.file}} {{form.token}}",
                  form: [
                    { key: "file", label: "Excel File", type: "file", flag: "--file", required: true },
                    { key: "token", label: "Secret Token", type: "env-secret", envVar: "API_SECRET", flag: "--token" },
                  ],
                },
              ],
            },
          ],
        },
      }),
    });

    // 1. Preview command masks secret and resolves workspace .venv/bin/python
    const prevRes = await fetch(`${instance.url}/api/preview-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        actionId: "gated-sync",
        formValues: {
          file: "/tmp/my file with spaces.xlsx",
          token: "super-secret-123",
        },
      }),
    });
    const prev = (await prevRes.json()) as any;
    expect(prev.maskedCommand).toContain(join(workspaceDir, ".venv/bin/python"));
    expect(prev.maskedCommand).toContain("'\/tmp\/my file with spaces.xlsx'");
    expect(prev.maskedCommand).toContain("--token ********");
    expect(prev.maskedCommand).not.toContain("super-secret-123");

    // 2. Reject execution if humanApproved is false
    const deniedRes = await fetch(`${instance.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        actionId: "gated-sync",
        formValues: {
          file: "/tmp/my file with spaces.xlsx",
          token: "super-secret-123",
        },
        humanApproved: false,
      }),
    });
    expect(deniedRes.status).toBe(400);

    // 3. Approve execution -> runs and masks secret in SQLite record
    const okRes = await fetch(`${instance.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        actionId: "gated-sync",
        formValues: {
          file: "/tmp/my file with spaces.xlsx",
          token: "super-secret-123",
        },
        humanApproved: true,
      }),
    });
    expect(okRes.status).toBe(200);
    const runData = (await okRes.json()) as any;
    expect(runData.run.maskedCommand).toContain("--human-approved");
    expect(runData.run.maskedCommand).not.toContain("super-secret-123");
    expect(runData.run.paramsJson).toContain("********");
    expect(runData.run.paramsJson).not.toContain("super-secret-123");
  });

  test("4. Native Bun PTY Bidirectional I/O, Tier-2 Replay Re-Attach, Process Group Kill & Stale Reconciliation", async () => {
    instance = createDashboardServer({
      port: 0,
      homeDir,
      defaultWorkspace: workspaceDir,
      dataDir,
      agentRoots,
      lockfiles: [lockfilePath],
    });

    // A. Interactive PTY session over WebSocket
    const runRes = await fetch(`${instance.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        adHocTitle: "Interactive Prompt Test",
        adHocCommand: `python3 -c 'import sys; print("\\033[32mREADY_PROMPT\\033[0m", flush=True); line = sys.stdin.readline().strip(); print(f"GOT:{line}", flush=True)'`,
      }),
    });
    const { runId } = (await runRes.json()) as any;

    const wsUrl = instance.url.replace("http://", "ws://") + `/ws/runs/${runId}?offset=0`;
    const receivedChunks: string[] = [];
    let finalStatus = "";

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => rejectPromise(new Error("WS timeout")), 8000);
      let sentInput = false;

      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "replay" || msg.type === "output") {
          receivedChunks.push(msg.data);
          const combined = receivedChunks.join("");
          if (!sentInput && combined.includes("READY_PROMPT")) {
            sentInput = true;
            ws.send(JSON.stringify({ type: "resize", cols: 132, rows: 42 }));
            ws.send(JSON.stringify({ type: "input", data: "HELLO_PTY\n" }));
          }
        } else if (msg.type === "status" && msg.status !== "running") {
          finalStatus = msg.status;
          clearTimeout(timer);
          ws.close();
          resolvePromise();
        }
      };
    });

    const fullTranscript = receivedChunks.join("");
    expect(fullTranscript).toContain("\x1b[32mREADY_PROMPT\x1b[0m");
    expect(fullTranscript).toContain("GOT:HELLO_PTY");
    expect(finalStatus).toBe("completed");

    // B. Re-attach new WebSocket client with offset=0 and verify full Tier-2 disk replay
    const reattachedChunks: string[] = [];
    await new Promise<void>((resolvePromise) => {
      const ws2 = new WebSocket(wsUrl);
      ws2.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "replay") {
          reattachedChunks.push(msg.data);
        } else if (msg.type === "status") {
          ws2.close();
          resolvePromise();
        }
      };
    });
    expect(reattachedChunks.join("")).toContain("GOT:HELLO_PTY");

    // C. Process Group Kill (-pgid): spawn parent + child sleep and stop it
    const longRes = await fetch(`${instance.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        adHocTitle: "Long Running Process Tree",
        adHocCommand: `python3 -c 'import subprocess, time; p = subprocess.Popen(["sleep", "30"]); print("CHILD_PID:", p.pid, flush=True); time.sleep(30)'`,
      }),
    });
    const longRun = ((await longRes.json()) as any).run;
    await new Promise((r) => setTimeout(r, 250));

    const stopRes = await fetch(`${instance.url}/api/runs/${longRun.id}/stop`, {
      method: "POST",
    });
    expect(stopRes.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));

    const runsList = ((await (await fetch(`${instance.url}/api/runs`)).json()) as any).runs;
    const stoppedRun = runsList.find((r: any) => r.id === longRun.id);
    expect(stoppedRun.status).toBe("cancelled");

    // D. Stale Run Reconciliation on Startup
    const fakeStaleId = "run_stale_999999";
    const fakeLogPath = join(dataDir, "logs", `${fakeStaleId}.log`);
    writeFileSync(fakeLogPath, "started...", "utf-8");
    instance.db.insertRun({
      id: fakeStaleId,
      skillId: "demo-ops",
      actionId: "cmd-1",
      actionTitle: "Stale Task",
      status: "running",
      command: "sleep 999",
      maskedCommand: "sleep 999",
      cwd: workspaceDir,
      pid: 999998, // non-existent PID
      exitCode: null,
      startedAt: Date.now() - 10000,
      finishedAt: null,
      durationMs: null,
      paramsJson: "{}",
      logPath: fakeLogPath,
      artifacts: [],
      interactive: false,
    });

    const reconciledCount = instance.db.reconcileStaleRuns();
    expect(reconciledCount).toBe(1);
    expect(instance.db.getRun(fakeStaleId)?.status).toBe("interrupted");
  });

  test("5. Asset Proxy Whitelist & Path Traversal Defense", async () => {
    instance = createDashboardServer({
      port: 0,
      homeDir,
      defaultWorkspace: workspaceDir,
      dataDir,
      agentRoots,
      lockfiles: [lockfilePath],
    });

    // Valid skill asset
    const okAsset = await fetch(
      `${instance.url}/api/assets?skill=demo-ops&path=${encodeURIComponent("assets/diagram.svg")}`
    );
    expect(okAsset.status).toBe(200);
    expect(await okAsset.text()).toContain("<svg");

    // Traversal attack attempting to escape skill root
    const outsideFile = join(sandboxDir, "secret.txt");
    writeFileSync(outsideFile, "TOP_SECRET", "utf-8");

    const attackRes = await fetch(
      `${instance.url}/api/assets?skill=demo-ops&path=${encodeURIComponent("../../../secret.txt")}`
    );
    expect(attackRes.status).toBe(403);
  });

  test("6. Issues 01–05: Syntax Highlighting, Indented Recursive FileTree + ../, In-Place Doc Execution & Multi-Level Subgroups", async () => {
    instance = createDashboardServer({
      port: 0,
      homeDir,
      defaultWorkspace: workspaceDir,
      dataDir,
      agentRoots,
      lockfiles: [lockfilePath],
    });

    // A. Issue 01 & 03: Markdown segment splitting & token syntax highlighting
    const sampleMd = `# Guide\n\n\`\`\`bash\n# Run sync\npython ~/.agents/skills/demo-ops/sync.py fetch --env {uat|prod} [--dry-run]\n\`\`\`\n\n\`\`\`python\ndef compute(x: int):\n    return x + 42\n\`\`\``;
    const segments = splitMarkdownIntoSegments(sampleMd);
    expect(segments.length).toBe(3);
    expect(segments[1].type).toBe("code");
    if (segments[1].type === "code") {
      expect(segments[1].isExecutableShell).toBe(true);
      expect(segments[1].commands.length).toBe(1);
      expect(segments[1].commands[0].comment).toBe("Run sync");
    }
    const pyHighlighted = highlightCodeToHtml("def compute(x: int):\n  return 42", "python", true);
    expect(pyHighlighted).toContain("tok-keyword");
    expect(pyHighlighted).toContain("tok-number");
    expect(pyHighlighted).toContain("code-ln");

    // B. Issue 02: Recursive FileTree with children, depth & parentPath (for ../ navigation)
    const rootTreeRes = await fetch(
      `${instance.url}/api/skills/demo-ops/files?path=&recursive=1`
    );
    expect(rootTreeRes.status).toBe(200);
    const rootTree = (await rootTreeRes.json()) as any;
    expect(rootTree.parentPath).toBeNull();
    const refsDirNode = rootTree.nodes.find((n: any) => n.name === "references");
    expect(refsDirNode).toBeDefined();
    expect(refsDirNode.depth).toBe(0);
    expect(Array.isArray(refsDirNode.children)).toBe(true);
    expect(refsDirNode.children[0].name).toBe("arch.md");
    expect(refsDirNode.children[0].depth).toBe(1);

    const subTreeRes = await fetch(
      `${instance.url}/api/skills/demo-ops/files?path=references&recursive=1`
    );
    const subTree = (await subTreeRes.json()) as any;
    expect(subTree.path).toBe("references");
    expect(subTree.parentPath).toBe(""); // Clicking ../ returns to root ""

    // C. Issue 03: In-place Markdown adHocCommand live {{python}} resolution & inline form interpolation
    const adHocPrevRes = await fetch(`${instance.url}/api/preview-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        adHocCommand:
          "python ~/.agents/skills/demo-ops/sync.py fetch --env {uat|prod} --file <input.xlsx> [--dry-run]",
        formValues: {
          env: "uat",
          file: "my_report.xlsx",
          dry_run: true,
        },
      }),
    });
    expect(adHocPrevRes.status).toBe(200);
    const adHocPrev = (await adHocPrevRes.json()) as any;
    expect(adHocPrev.inferredForm.length).toBe(3);
    expect(adHocPrev.maskedCommand).toContain(join(workspaceDir, ".venv/bin/python"));
    expect(adHocPrev.maskedCommand).toContain(join(homeDir, ".agents/skills/demo-ops/sync.py"));
    expect(adHocPrev.maskedCommand).toContain("--env uat");
    expect(adHocPrev.maskedCommand).toContain("--file my_report.xlsx");
    expect(adHocPrev.maskedCommand).toContain("--dry-run");

    // D. Issue 05: Multi-Level ActionGroup subgroups normalization
    const putMultiLevel = await fetch(`${instance.url}/api/skills/demo-ops/manifest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        layer: "companion",
        manifest: {
          actionGroups: [
            {
              name: "1. Extraction Suite",
              actions: [
                {
                  id: "act-list",
                  title: "List Records",
                  subgroup: "1.1 Routine Inspection",
                  danger: "safe",
                  defaultRunner: "web_terminal",
                  command: "{{python}} -V",
                },
                {
                  id: "act-backup",
                  title: "Backup Snapshot",
                  subgroup: "1.2 Snapshots",
                  danger: "safe",
                  defaultRunner: "web_terminal",
                  command: "{{python}} -V",
                },
              ],
            },
          ],
        },
      }),
    });
    expect(putMultiLevel.status).toBe(200);
    const mlSkill = ((await putMultiLevel.json()) as any).skill;
    const grp = mlSkill.manifest.actionGroups[0];
    expect(grp.subgroups.length).toBe(2);
    expect(grp.subgroups[0].name).toBe("1.1 Routine Inspection");
    expect(grp.subgroups[1].name).toBe("1.2 Snapshots");
  });

  test("7. Issues 06–11: Relative Symlinks, Per-Skill Default Workspace, Per-Skill Env Injection & Interactive Shell", async () => {
    instance = createDashboardServer({
      port: 0,
      homeDir,
      defaultWorkspace: workspaceDir,
      dataDir,
      agentRoots,
      lockfiles: [lockfilePath],
    });

    // A. Issue 06: Relative Symlink Creation when mounting a skill under $HOME
    await fetch(`${instance.url}/api/mounts/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        agent: "claude",
        enabled: false,
      }),
    });
    const relToggleRes = await fetch(`${instance.url}/api/mounts/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        agent: "claude",
        enabled: true,
      }),
    });
    expect(relToggleRes.status).toBe(200);
    const relToggleData = (await relToggleRes.json()) as any;
    expect(relToggleData.linkTarget).toBe("../../.agents/skills/demo-ops");
    expect(readlinkSync(join(homeDir, ".claude/skills/demo-ops"))).toBe(
      "../../.agents/skills/demo-ops"
    );
    expect(relToggleData.skill.inAgentsHub).toBe(true);

    // B. Issue 09: Per-Skill Default Workspace binding with independent .venv/bin/python
    const secondWorkspace = join(sandboxDir, "workspace-two");
    const secondVenvBin = join(secondWorkspace, ".venv/bin");
    mkdirSync(secondVenvBin, { recursive: true });
    const fakePythonTwo = join(secondVenvBin, "python");
    writeFileSync(fakePythonTwo, "#!/bin/sh\nexec python3 \"$@\"\n", "utf-8");
    chmodSync(fakePythonTwo, 0o755);

    const wsBindRes = await fetch(`${instance.url}/api/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "image-maker",
        activeWorkspace: secondWorkspace,
      }),
    });
    expect(wsBindRes.status).toBe(200);
    const wsBindData = (await wsBindRes.json()) as any;
    const demoSkill = wsBindData.skills.find((s: any) => s.id === "demo-ops");
    const imageMakerSkill = wsBindData.skills.find((s: any) => s.id === "image-maker");

    // demo-ops stays on workspaceDir while image-maker uses secondWorkspace!
    expect(demoSkill.effectiveWorkspace).toBe(workspaceDir);
    expect(demoSkill.pythonExecutable).toContain(join(workspaceDir, ".venv/bin/python"));
    expect(imageMakerSkill.effectiveWorkspace).toBe(secondWorkspace);
    expect(imageMakerSkill.pythonExecutable).toContain(join(secondWorkspace, ".venv/bin/python"));

    // C. Issue 11: Per-Skill Environment Variable Configuration & Injection
    const envRes = await fetch(`${instance.url}/api/skills/demo-ops/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        env: {
          CUSTOM_SKILL_ENV: "ALPHA_99",
        },
      }),
    });
    expect(envRes.status).toBe(200);
    const envSkill = ((await envRes.json()) as any).skill;
    expect(envSkill.configuredEnv.CUSTOM_SKILL_ENV).toBe("ALPHA_99");

    // D. Issue 08: Interactive Shell Session with ZDOTDIR .venv activation + SKILL_DIR + CUSTOM_SKILL_ENV
    const shellRunRes = await fetch(`${instance.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        interactiveShell: true,
      }),
    });
    expect(shellRunRes.status).toBe(200);
    const { runId } = (await shellRunRes.json()) as any;

    const wsUrl = instance.url.replace("http://", "ws://") + `/ws/runs/${runId}?offset=0`;
    const shellChunks: string[] = [];

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => rejectPromise(new Error("Interactive shell WS timeout")), 8000);
      let commandSent = false;

      ws.onopen = () => {
        setTimeout(() => {
          if (!commandSent) {
            commandSent = true;
            ws.send(
              JSON.stringify({
                type: "input",
                data: "echo VENV_CHECK=$VIRTUAL_ENV ENV_CHECK=$CUSTOM_SKILL_ENV SKILL_CHECK=$SKILL_DIR; exit\n",
              })
            );
          }
        }, 350);
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "replay" || msg.type === "output") {
          shellChunks.push(msg.data);
        } else if (msg.type === "status" && msg.status !== "running") {
          clearTimeout(timer);
          ws.close();
          resolvePromise();
        }
      };
    });

    const shellTranscript = shellChunks.join("");
    expect(shellTranscript).toContain(`VENV_CHECK=${join(workspaceDir, ".venv")}`);
    expect(shellTranscript).toContain("ENV_CHECK=ALPHA_99");
    expect(shellTranscript).toContain("SKILL_CHECK=");
  });

  test("8. Issues 12 & 13: Upstream Skill Updater with .dashboard/ Guard, Agent Sync Prompt & Live Disk mtime Cache Invalidation", async () => {
    instance = createDashboardServer({
      port: 0,
      homeDir,
      defaultWorkspace: workspaceDir,
      dataDir,
      agentRoots,
      lockfiles: [lockfilePath],
    });

    // A. Verify updateStrategy detection (demo-ops is in .skill-lock.json -> npx-lock; image-maker -> local)
    const boot1 = (await (await fetch(`${instance.url}/api/bootstrap`)).json()) as any;
    const demo1 = boot1.skills.find((s: any) => s.id === "demo-ops");
    const img1 = boot1.skills.find((s: any) => s.id === "image-maker");
    expect(demo1.updateStrategy).toBe("npx-lock");
    expect(img1.updateStrategy).toBe("local");

    // B. Agent Manifest Sync Prompt (Init Mode when no .dashboard/manifest.yaml exists yet)
    const syncInitRes = await fetch(`${instance.url}/api/skills/demo-ops/agent-sync`);
    expect(syncInitRes.status).toBe(200);
    const syncInit = (await syncInitRes.json()) as any;
    expect(syncInit.mode).toBe("init");
    expect(syncInit.prompt).toContain("Create a structured");

    // C. Save a companion .dashboard/manifest.yaml, then verify Agent Sync switches to Incremental Mode
    await fetch(`${instance.url}/api/skills/demo-ops/manifest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        layer: "companion",
        manifest: {
          name: "Guarded Demo Skill",
          category: "Data & Platform",
        },
      }),
    });

    const syncIncRes = await fetch(`${instance.url}/api/skills/demo-ops/agent-sync`);
    const syncInc = (await syncIncRes.json()) as any;
    expect(syncInc.mode).toBe("incremental");
    expect(syncInc.prompt).toContain("Incremental Edit Protocol");

    // D. Issue 12: Simulate an upstream update that wipes and recreates the skill folder (deleting .dashboard/),
    //    and verify the .dashboard/ Guard automatically restores .dashboard/manifest.yaml!
    const demoSkillPath = join(homeDir, ".agents/skills/demo-ops");
    const simulatedDestructiveUpdateCmd = `rm -rf '${demoSkillPath}/.dashboard' && echo 'Simulated upstream overwrite'`;

    const updRes = await fetch(`${instance.url}/api/skills/demo-ops/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customCommand: simulatedDestructiveUpdateCmd,
      }),
    });
    expect(updRes.status).toBe(200);
    const updData = (await updRes.json()) as any;
    expect(updData.guarded).toBe(true);

    // Wait for update PTY run to finish
    const wsUrl = instance.url.replace("http://", "ws://") + `/ws/runs/${updData.runId}?offset=0`;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => rejectPromise(new Error("Update WS timeout")), 6000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "status" && msg.status !== "running") {
          clearTimeout(timer);
          ws.close();
          resolvePromise();
        }
      };
    });

    // Verify .dashboard/manifest.yaml survived the destructive update!
    expect(existsSync(join(demoSkillPath, ".dashboard/manifest.yaml"))).toBe(true);

    // E. Issue 13: Verify Live Disk mtime Cache Invalidation (modify manifest.yaml directly on disk without ?refresh=1)
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(
      join(demoSkillPath, ".dashboard/manifest.yaml"),
      `name: "Live Disk Modified Title"\ncategory: "Data & Platform"\n`,
      "utf-8"
    );

    const bootAfterDiskEdit = (await (await fetch(`${instance.url}/api/bootstrap`)).json()) as any;
    const demoAfterDiskEdit = bootAfterDiskEdit.skills.find((s: any) => s.id === "demo-ops");
    expect(demoAfterDiskEdit.manifest.name).toBe("Live Disk Modified Title");

    // F. Verify UTF-8 streaming decoder preserves multi-byte box-drawing characters (─ U+2500) across chunk boundaries
    const decoder = new TextDecoder();
    // "───" is 3 x [0xE2, 0x94, 0x80]. Split right inside the second character:
    const chunkA = new Uint8Array([0xe2, 0x94, 0x80, 0xe2]);
    const chunkB = new Uint8Array([0x94, 0x80, 0xe2, 0x94, 0x80]);
    const decoded = decoder.decode(chunkA, { stream: true }) + decoder.decode(chunkB, { stream: true });
    expect(decoded).toBe("───");

    // G. Verify Multi-Line Inline Script Action (`script: |` / `command: |`) preserves newlines,
    //    executes with `set -e` & `trap ... EXIT` in an isolated script file, and stops on first error
    await fetch(`${instance.url}/api/skills/demo-ops/manifest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        layer: "companion",
        manifest: {
          actionGroups: [
            {
              name: "Inline Script Group",
              actions: [
                {
                  id: "multi-line-script",
                  title: "Multi-Line Script with Trap",
                  danger: "safe",
                  defaultRunner: "web_terminal",
                  script: [
                    "trap 'echo TRAP_CLEANUP_EXECUTED' EXIT",
                    "STEP1=\"{{form.env}}\"",
                    "echo \"RUNNING_STEP_1:$STEP1\"",
                    "false",
                    "echo \"UNREACHABLE_TOKEN_\"\"AFTER_FALSE\"",
                  ].join("\n"),
                  form: [
                    { key: "env", label: "Env", type: "text", default: "uat" },
                  ],
                },
              ],
            },
          ],
        },
      }),
    });

    const scriptPreviewRes = await fetch(`${instance.url}/api/preview-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        actionId: "multi-line-script",
        formValues: { env: "uat" },
      }),
    });
    const scriptPreview = (await scriptPreviewRes.json()) as any;
    expect(scriptPreview.maskedCommand).toContain("STEP1=\"uat\"\necho \"RUNNING_STEP_1:$STEP1\"");

    const scriptRunRes = await fetch(`${instance.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        actionId: "multi-line-script",
        formValues: { env: "uat" },
      }),
    });
    const scriptRun = (await scriptRunRes.json()) as any;
    const scriptWsUrl = instance.url.replace("http://", "ws://") + `/ws/runs/${scriptRun.runId}?offset=0`;
    const scriptLogs: string[] = [];

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(scriptWsUrl);
      const timer = setTimeout(() => rejectPromise(new Error("Script WS timeout")), 6000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "replay" || msg.type === "output") {
          scriptLogs.push(msg.data);
        } else if (msg.type === "status" && msg.status !== "running") {
          clearTimeout(timer);
          ws.close();
          resolvePromise();
        }
      };
    });

    const combinedScriptLog = scriptLogs.join("");
    expect(combinedScriptLog).toContain("RUNNING_STEP_1:uat");
    expect(combinedScriptLog).toContain("TRAP_CLEANUP_EXECUTED");
    expect(combinedScriptLog).not.toContain("UNREACHABLE_TOKEN_AFTER_FALSE");
  });

  test("9. Dynamic Primitives: Glob & Cascading Command DataSources, Single-Flight Status Probes & Custom HTML Bridge Injection", async () => {
    instance = createDashboardServer({
      port: 0,
      homeDir,
      defaultWorkspace: workspaceDir,
      dataDir,
      agentRoots,
      lockfiles: [lockfilePath],
    });

    const demoSkillDir = join(homeDir, ".agents/skills/demo-ops");
    const backupsDir = join(demoSkillDir, "backups");
    mkdirSync(backupsDir, { recursive: true });
    writeFileSync(join(backupsDir, "snap_alpha.json"), '{"rows": 10}', "utf-8");
    writeFileSync(join(backupsDir, "snap_beta.json"), '{"rows": 25}', "utf-8");

    mkdirSync(join(demoSkillDir, ".dashboard/views"), { recursive: true });
    writeFileSync(
      join(demoSkillDir, ".dashboard/views/panel.html"),
      `<!DOCTYPE html><html><head><title>Custom Panel</title></head><body><h1>Hello Custom View</h1></body></html>`,
      "utf-8"
    );

    await fetch(`${instance.url}/api/skills/demo-ops/manifest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        layer: "companion",
        manifest: {
          context: [
            {
              key: "env",
              label: "Target Env",
              type: "select",
              default: "local",
              options: [
                { label: "Local", value: "local" },
                { label: "UAT", value: "uat" },
              ],
            },
          ],
          data: [
            {
              id: "backups-table",
              title: "Backups Table",
              runtime: "glob",
              pattern: ["{{skill_dir}}/backups/*.json"],
              valueFormat: "basename",
              shape: "table",
              primaryKey: "name",
              valueColumn: "name",
            },
            {
              id: "pods-table",
              title: "K8s Pods ({{context.env}})",
              runtime: "zsh",
              command:
                "printf 'NAME            READY   STATUS             RESTARTS\\npod-{{context.env}}-1   1/1     Running            0\\npod-{{context.env}}-2   0/1     CrashLoopBackOff   3 (1m ago)\\n'",
              parse: { format: "whitespace-table" },
              shape: "table",
              primaryKey: "NAME",
            },
            {
              id: "healthy-pods-scalar",
              title: "Healthy Pods Count",
              runtime: "ts",
              code: `
                const rows: any[] = ctx.data["pods-table"] || [];
                const ok = rows.filter((r) => r.STATUS === "Running").length;
                return { value: \`\${ok}/\${rows.length} in \${ctx.context.env}\`, unit: "pods", tone: "success" };
              `,
              shape: "scalar",
            },
            {
              id: "python-kv",
              title: "Python Structured KV",
              runtime: "python",
              code: `
def main(ctx):
    return {"env": ctx["context"]["env"], "backupCount": len(ctx["data"].get("backups-table", []))}
`,
              shape: "kv",
              sync: { dependsOn: ["backups-table"] },
            },
          ],
          views: [
            {
              id: "custom-panel",
              title: "Custom Panel",
              type: "html",
              source: ".dashboard/views/panel.html",
            },
          ],
          actionGroups: [
            {
              name: "Ops",
              actions: [
                {
                  id: "use-data-cmd",
                  title: "Command referencing data & context",
                  danger: "safe",
                  defaultRunner: "web_terminal",
                  command:
                    "echo ENV={{context.env}} LATEST={{data.backups-table.rows.0.name}} USER_ENV={{data.python-kv.env}}",
                },
              ],
            },
          ],
        },
      }),
    });

    // A. Test Glob Table Data Node & FormField Options Projection
    const globSnap = (await (
      await fetch(`${instance.url}/api/skills/demo-ops/data/backups-table`)
    ).json()) as any;
    expect(globSnap.shape).toBe("table");
    expect(globSnap.value.rows.length).toBe(2);
    expect(globSnap.options.map((o: any) => o.value).sort()).toEqual([
      "snap_alpha.json",
      "snap_beta.json",
    ]);

    // B. Test Whitespace-Table Parser + Derived TypeScript Scalar Node (DAG auto-evaluation)
    const scalarSnap1 = (await (
      await fetch(`${instance.url}/api/skills/demo-ops/data/healthy-pods-scalar`)
    ).json()) as any;
    expect(scalarSnap1.shape).toBe("scalar");
    expect(scalarSnap1.value.value).toBe("1/2 in local");
    expect(scalarSnap1.fromCache).toBe(false);

    // Second fetch hits TTL cache
    const scalarSnapCached = (await (
      await fetch(`${instance.url}/api/skills/demo-ops/data/healthy-pods-scalar`)
    ).json()) as any;
    expect(scalarSnapCached.fromCache).toBe(true);

    // C. Test Context Switch (local -> uat) automatically invalidates & recomputes downstream DAG nodes + Python structured runtime!
    const ctxSwitchRes = await fetch(`${instance.url}/api/skills/demo-ops/context`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "env", value: "uat" }),
    });
    expect(ctxSwitchRes.status).toBe(200);
    const ctxSwitchBody = (await ctxSwitchRes.json()) as any;
    expect(ctxSwitchBody.context.env).toBe("uat");
    expect(ctxSwitchBody.snapshots["healthy-pods-scalar"].value.value).toBe("1/2 in uat");
    expect(ctxSwitchBody.snapshots["python-kv"].value.record).toEqual({
      env: "uat",
      backupCount: 2,
    });

    // D. Test Command Interpolation with {{context.*}} and deep {{data.<nodeId>.*}} paths
    const previewRes = await fetch(`${instance.url}/api/preview-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        actionId: "use-data-cmd",
      }),
    });
    const previewData = (await previewRes.json()) as any;
    expect(previewData.maskedCommand).toBe(
      "echo ENV=uat LATEST=snap_alpha.json USER_ENV=uat"
    );

    // E. Test Custom HTML View route (/skill-app/:skillId/*) with injected Bridge 2.0 SDK & <base href>
    const htmlRes = await fetch(
      `${instance.url}/skill-app/demo-ops/.dashboard/views/panel.html`
    );
    expect(htmlRes.status).toBe(200);
    const htmlText = await htmlRes.text();
    expect(htmlText).toContain('<base href="/skill-app/demo-ops/.dashboard/views/" />');
    expect(htmlText).toContain("window.SkillDashboard =");
    expect(htmlText).toContain("subscribe: function(nodeId, handler)");
    expect(htmlText).toContain("Hello Custom View");

    // E. Issue 14: Verify Semantic Tag Inference (python, excel, devops-cloud, has-references, provenance repo owner)
    const bootRes = (await (await fetch(`${instance.url}/api/bootstrap?refresh=1`)).json()) as any;
    const demoSkill = bootRes.skills.find((s: any) => s.id === "demo-ops");
    expect(demoSkill.manifest.tags).toContain("python");
    expect(demoSkill.manifest.tags).toContain("excel");
    expect(demoSkill.manifest.tags).toContain("has-references");
    expect(demoSkill.manifest.tags).toContain("acme");
  });

  test("10. Reactive 2.0 Closures: NDJSON Stream Folding, Action output.intoData Downstream Invalidation, Built-in rowActions & Quote-Aware Interpolation", async () => {
    instance = createDashboardServer({
      port: 0,
      homeDir,
      defaultWorkspace: workspaceDir,
      dataDir,
      agentRoots,
      lockfiles: [lockfilePath],
    });

    await fetch(`${instance.url}/api/skills/demo-ops/manifest`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        layer: "companion",
        manifest: {
          data: [
            {
              id: "ndjson-stream-node",
              title: "Streaming Eval Fold",
              runtime: "zsh",
              command: [
                "printf '{\"op\":\"upsert\",\"row\":{\"id\":\"doc_1\",\"status\":\"running\",\"score\":0.4}}\\n'",
                "printf '{\"op\":\"upsert\",\"row\":{\"id\":\"doc_2\",\"status\":\"running\",\"score\":0.6}}\\n'",
                "printf '{\"op\":\"patch\",\"key\":\"doc_1\",\"patch\":{\"status\":\"done\",\"score\":0.95}}\\n'",
                "printf '{\"op\":\"delete\",\"key\":\"doc_2\"}\\n'",
              ].join(" && "),
              parse: { format: "jsonl" },
              shape: "stream",
              primaryKey: "id",
              rowActions: [
                { label: "Inspect Doc", actionId: "produce-audit", args: { target: "{{row.id}}" } },
              ],
            },
            {
              id: "audit-results",
              title: "Audit Results Table",
              runtime: "zsh",
              command: "echo '[{\"item\":\"init\",\"passed\":false}]'",
              parse: { format: "json" },
              shape: "table",
              primaryKey: "item",
            },
            {
              id: "audit-pass-count",
              title: "Passed Audit Count",
              runtime: "ts",
              code: `
                const rows: any[] = ctx.data["audit-results"] || [];
                const passed = rows.filter((r) => r.passed === true).length;
                return { value: \`\${passed}/\${rows.length} passed\`, tone: "success" };
              `,
              shape: "scalar",
            },
          ],
          actionGroups: [
            {
              name: "Audit Suite",
              actions: [
                {
                  id: "produce-audit",
                  title: "Produce Audit JSON into Data Graph",
                  danger: "safe",
                  defaultRunner: "web_terminal",
                  command:
                    "echo '[INFO] Starting audit...' && echo '[{\"item\":\"step_1\",\"passed\":true},{\"item\":\"step_2\",\"passed\":true}]'",
                  output: {
                    intoData: "audit-results",
                    parse: { format: "json" },
                    shape: "table",
                  },
                },
                {
                  id: "quoted-path-cmd",
                  title: "Double Quoted Path Action",
                  danger: "safe",
                  defaultRunner: "web_terminal",
                  command: 'cp "{{form.target}}" /tmp/out.json',
                  form: [
                    { key: "target", label: "Target", type: "text", positional: true },
                  ],
                },
              ],
            },
          ],
        },
      }),
    });

    // A. Verify NDJSON Stream Folding (upsert + patch + delete) & built-in rowActions in batch /data
    const allData1 = (await (
      await fetch(`${instance.url}/api/skills/demo-ops/data`)
    ).json()) as any;
    const streamSnap = allData1.snapshots["ndjson-stream-node"];
    expect(streamSnap.rowActions?.length).toBe(1);
    expect(streamSnap.value.rows).toEqual([
      { id: "doc_1", status: "done", score: 0.95 },
    ]);
    expect(allData1.snapshots["audit-pass-count"].value.value).toBe("0/1 passed");

    // B. Execute produce-audit Action with output.intoData: "audit-results" and verify it updates audit-results AND invalidates downstream audit-pass-count!
    const runRes = await fetch(`${instance.url}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: "demo-ops",
        actionId: "produce-audit",
      }),
    });
    const runBody = (await runRes.json()) as any;
    const wsUrl = instance.url.replace("http://", "ws://") + `/ws/runs/${runBody.runId}?offset=0`;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => rejectPromise(new Error("Audit WS timeout")), 6000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "status" && msg.status !== "running") {
          clearTimeout(timer);
          ws.close();
          resolvePromise();
        }
      };
    });

    const passCountAfter = (await (
      await fetch(`${instance.url}/api/skills/demo-ops/data/audit-pass-count`)
    ).json()) as any;
    expect(passCountAfter.value.value).toBe("2/2 passed");

    // C. Verify Quote-Aware Interpolation inside double quotes (no nested single quotes around spaces)
    const qPrev = (await (
      await fetch(`${instance.url}/api/preview-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillId: "demo-ops",
          actionId: "quoted-path-cmd",
          formValues: { target: "/Users/test/My Folder/file name.json" },
        }),
      })
    ).json()) as any;
    expect(qPrev.maskedCommand).toBe('cp "/Users/test/My Folder/file name.json" /tmp/out.json');

    // D. Verify Agent Sync Prompt includes Reactive 2.0 keywords (context, data)
    const syncInfo = (await (
      await fetch(`${instance.url}/api/skills/demo-ops/agent-sync`)
    ).json()) as any;
    expect(syncInfo.prompt).toContain("data");
  });

  test("11. Explicit Prelude (prelude: false vs true + Variable Shadowing + Static Import Rewriting), Explicit Modular Linker (includes, $include, $ref), Per-Module Editing & manifest-cli", async () => {
    const modSkillRoot = join(homeDir, ".agents/skills/demo-ops");
    const modSkillDir = join(modSkillRoot, ".dashboard");
    mkdirSync(join(modSkillRoot, "backups"), { recursive: true });
    writeFileSync(join(modSkillRoot, "backups/snap_alpha.json"), "{}");
    writeFileSync(join(modSkillRoot, "backups/snap_beta.json"), "{}");
    mkdirSync(join(modSkillDir, "modules"), { recursive: true });
    mkdirSync(join(modSkillDir, "fragments"), { recursive: true });

    // Root manifest with explicit includes: and defs:
    writeFileSync(
      join(modSkillDir, "manifest.yaml"),
      `
id: demo-ops
name: "Modular Demo Skill"
category: "Data & Platform"
description: "Tests explicit includes, $include, $ref, prelude, and manifest-cli"
includes:
  - ./modules/01-data-and-prelude.yaml
  - ./modules/02-actions.yaml
defs:
  sharedSnapField:
    key: target
    label: "Snapshot File"
    type: select
    positional: true
    fromData: "prelude-true-node"
context:
  - key: env
    label: "Env"
    type: select
    default: "uat"
    options:
      - { label: "UAT", value: "uat" }
      - { label: "Local", value: "local" }
`.trim()
    );

    // Module 01: Data nodes testing prelude: false (default), static import rewrite, and prelude: true with shadowing
    writeFileSync(
      join(modSkillDir, "modules/01-data-and-prelude.yaml"),
      `
data:
  - id: prelude-false-default-err
    title: "Default Prelude False (Unimported path fails)"
    runtime: ts
    shape: scalar
    code: |
      return path.join("a", "b");

  - id: prelude-false-static-import
    title: "Default Prelude False with Top-Level Static Import"
    runtime: ts
    shape: scalar
    code: |
      import { basename as bn } from "node:path";
      return { value: bn("/tmp/hello_world.json"), tone: "info" };

  - id: prelude-true-node
    title: "Explicit Prelude True with Outer-Scope Shadowing"
    runtime: ts
    prelude: true
    shape: table
    primaryKey: "name"
    valueColumn: "name"
    rowActions:
      - label: "Restore"
        actionId: mod-restore-action
        mode: prefill
        args: { target: "{{row.name}}" }
    code: |
      const dir = path.join(ctx.skillDir, "backups");
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
      // Shadow outer 'Database' helper safely inside inner closure!
      const Database = "shadowed_local_var";
      return files.map((f) => ({ name: f, tag: Database }));
`.trim()
    );

    // Fragment for array-level - $include
    writeFileSync(
      join(modSkillDir, "fragments/extra-action.yaml"),
      `
- id: fragment-included-action
  title: "Action from Array-Level $include"
  danger: safe
  command: "echo FRAGMENT_OK"
`.trim()
    );

    // Module 02: Actions referencing Module 01 data node via $ref: "#/defs/sharedSnapField" and array-level $include
    writeFileSync(
      join(modSkillDir, "modules/02-actions.yaml"),
      `
actionGroups:
  - name: "1. Modular Operations"
    actions:
      - id: mod-restore-action
        title: "Modular Restore"
        danger: safe
        command: "echo RESTORE {{form.target}} in {{context.env}}"
        form:
          - $ref: "#/defs/sharedSnapField"
            required: true
      - $include: "../fragments/extra-action.yaml"
`.trim()
    );

    instance = createDashboardServer({
      port: 0,
      homeDir,
      defaultWorkspace: workspaceDir,
      dataDir,
      agentRoots,
      lockfiles: [lockfilePath],
    });

    const boot = (await (await fetch(`${instance.url}/api/bootstrap?refresh=1`)).json()) as any;
    const skill = boot.skills.find((s: any) => s.id === "demo-ops");
    expect(skill).toBeDefined();
    expect(skill.layers.moduleFiles).toEqual([
      "manifest.yaml",
      "modules/01-data-and-prelude.yaml",
      "modules/02-actions.yaml",
      "fragments/extra-action.yaml",
    ]);
    expect(skill.manifest.actionGroups[0].actions.map((a: any) => a.id)).toEqual([
      "mod-restore-action",
      "fragment-included-action",
    ]);
    expect(skill.manifest.actionGroups[0].actions[0].form[0].fromData).toBe("prelude-true-node");
    expect(skill.manifest.actionGroups[0].actions[0].form[0].required).toBe(true);

    // A. Test prelude: false default throws ReferenceError on unimported `path`
    const errSnap = (await (
      await fetch(`${instance.url}/api/skills/demo-ops/data/prelude-false-default-err`)
    ).json()) as any;
    expect(errSnap.status).toBe("error");
    expect(errSnap.error).toContain("path");

    // B. Test prelude: false with top-level `import { basename as bn } from "node:path"` works!
    const impSnap = (await (
      await fetch(`${instance.url}/api/skills/demo-ops/data/prelude-false-static-import`)
    ).json()) as any;
    expect(impSnap.status).toBe("ready");
    expect(impSnap.value.value).toBe("hello_world.json");

    // C. Test prelude: true injects { fs, path } AND allows inner variable `const path = "shadowed_local_var"` without SyntaxError!
    const trueSnap = (await (
      await fetch(`${instance.url}/api/skills/demo-ops/data/prelude-true-node`)
    ).json()) as any;
    expect(trueSnap.status).toBe("ready");
    expect(trueSnap.value.rows.length).toBe(2);
    expect(trueSnap.value.rows[0].tag).toBe("shadowed_local_var");

    // D. Test Per-Module Read/Write API (/api/skills/:id/manifest-module) preserves modular structure & hot-reloads
    const modRead = (await (
      await fetch(
        `${instance.url}/api/skills/demo-ops/manifest-module?file=modules/02-actions.yaml`
      )
    ).json()) as any;
    expect(modRead.file).toBe("modules/02-actions.yaml");
    expect(modRead.content).toContain("mod-restore-action");

    const updatedModContent = modRead.content.replace("Modular Restore", "Modular Restore v2");
    const modSaveRes = await fetch(`${instance.url}/api/skills/demo-ops/manifest-module`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        file: "modules/02-actions.yaml",
        content: updatedModContent,
      }),
    });
    expect(modSaveRes.status).toBe(200);
    const modSaveData = (await modSaveRes.json()) as any;
    expect(modSaveData.skill.manifest.actionGroups[0].actions[0].title).toBe("Modular Restore v2");

    // E. Test manifest-cli Symbol Graph (`map`, `refs`) and 3-Tier Validator (`validateSkillManifest3Tier`)
    const graph = buildManifestSymbolGraph(modSaveData.skill);
    const mapText = formatManifestMapReport(graph);
    expect(mapText).toContain("prelude-true-node");
    expect(mapText).toContain("modules/01-data-and-prelude.yaml");

    const refsText = formatSymbolRefsReport(graph, "prelude-true-node");
    expect(refsText).toContain("Defined In : .dashboard/modules/01-data-and-prelude.yaml");
    expect(refsText).toContain("action:mod-restore-action");

    const issues = validateSkillManifest3Tier(modSaveData.skill);
    // Should warn on prelude-false-default-err using `path.` without `prelude: true`!
    expect(
      issues.some(
        (i) => i.symbolId === "data:prelude-false-default-err" && i.level === "L3-Runtime"
      )
    ).toBe(true);
  });

  test("12. XDG 3-Tier Storage, Sandbox Variables ({{data_dir}}/{{cache_dir}}/{{artifacts_dir}}), 3-Channel Run Artifacts, Managed Folders (inspect/init) & Agent Scratchpad HITL + Promote", async () => {
    const configDir = join(sandboxDir, "xdg-config");
    const xdgDataDir = join(sandboxDir, "xdg-data");
    const cacheDir = join(sandboxDir, "xdg-cache");

    instance = createDashboardServer({
      port: 0,
      homeDir,
      defaultWorkspace: workspaceDir,
      configDir,
      dataDir: xdgDataDir,
      cacheDir,
      agentRoots,
      lockfiles: [lockfilePath],
    });

    // A. Verify XDG paths & config endpoint
    const cfgRes = (await (await fetch(`${instance.url}/api/config`)).json()) as any;
    expect(cfgRes.paths.configDir).toBe(configDir);
    expect(cfgRes.paths.dataDir).toBe(xdgDataDir);
    expect(cfgRes.paths.cacheDir).toBe(cacheDir);
    expect(cfgRes.config.preferences.unconfiguredFolderAction).toBe("ask");

    // B. Add an unconfigured local repository folder (`POST /api/folders`), inspect & init via CLI helpers
    const extRepoDir = join(sandboxDir, "my-microservice");
    mkdirSync(extRepoDir, { recursive: true });
    writeFileSync(
      join(extRepoDir, "package.json"),
      JSON.stringify({ name: "my-microservice", scripts: { test: "bun test", build: "bun build" } })
    );
    writeFileSync(join(extRepoDir, "README.md"), "# My Microservice\n\nService docs.");

    const addFolderRes = (await (
      await fetch(`${instance.url}/api/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: extRepoDir,
          unconfiguredFolderAction: "agent",
        }),
      })
    ).json()) as any;
    expect(addFolderRes.hasManifest).toBe(false);
    expect(addFolderRes.unconfiguredFolderAction).toBe("agent");
    expect(addFolderRes.unit.unitKind).toBe("workspace");

    const inspected = inspectTargetDirectory(extRepoDir);
    expect(inspected.hasManifest).toBe(false);
    expect(inspected.packageScripts.test).toBe("bun test");

    const inited = initManifestInDirectory(extRepoDir);
    expect(inited.created).toBe(true);
    expect(existsSync(inited.manifestPath)).toBe(true);

    // C. Create an Ephemeral Agent Scratchpad (`POST /api/scratchpads`) with {{data_dir}}, {{artifacts_dir}}, and 3-Channel Artifact Rules
    const padRes = (await (
      await fetch(`${instance.url}/api/scratchpads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "order-fix-pad",
          title: "UAT Order Fix Console",
          projectRoot: workspaceDir,
          manifest: {
            category: "Data & Platform",
            description: "Scratchpad testing sandbox vars and 3-channel artifacts",
            tsPrelude: true,
            data: [
              {
                id: "sandbox-paths-probe",
                title: "Sandbox Paths Probe",
                runtime: "ts",
                prelude: true,
                shape: "kv",
                code: `return { dataDir: ctx.dataDir, cacheDir: ctx.cacheDir, workspace: ctx.workspace };`,
              },
            ],
            actionGroups: [
              {
                name: "1. Artifact Generators",
                actions: [
                  {
                    id: "gen-reports",
                    title: "Generate Multi-Channel Artifacts",
                    danger: "safe",
                    script: [
                      'echo "persisted" > "{{data_dir}}/state.txt"',
                      'echo "<h1>Diff Report</h1>" > "{{form.out_html}}"',
                      'echo "col1,col2" > "{{artifacts_dir}}/auto_scan.csv"',
                      'echo "Report written to {{artifacts_dir}}/stdout_matched.json"',
                      'echo "{\\"ok\\":true}" > "{{artifacts_dir}}/stdout_matched.json"',
                      'echo "::artifact path={{artifacts_dir}}/marker.txt label=\\"MarkerLog\\""',
                      'echo "marker" > "{{artifacts_dir}}/marker.txt"',
                    ].join("\n"),
                    form: [
                      {
                        key: "out_html",
                        label: "HTML Output",
                        type: "file",
                        default: "{{artifacts_dir}}/explicit_diff.html",
                      },
                    ],
                    artifacts: [
                      {
                        path: "{{form.out_html}}",
                        label: "Explicit Diff HTML",
                        kind: "html",
                        onComplete: "open",
                      },
                      {
                        fromStdout: "Report written to (?<path>\\S+\\.json)",
                        label: "Stdout Matched JSON",
                        kind: "json",
                        onComplete: "download",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      })
    ).json()) as any;

    expect(padRes.unitId).toBe("order-fix-pad");
    expect(padRes.unit.unitKind).toBe("scratchpad");
    expect(padRes.deepLink).toContain("/?id=order-fix-pad");

    // Verify sandbox-paths-probe data node receives ctx.dataDir & ctx.cacheDir
    const probeSnap = (await (
      await fetch(`${instance.url}/api/skills/order-fix-pad/data/sandbox-paths-probe`)
    ).json()) as any;
    expect(probeSnap.status).toBe("ready");
    expect(probeSnap.value.record.dataDir).toContain("units/order-fix-pad");
    expect(probeSnap.value.record.workspace).toBe(workspaceDir);

    // D. Run `gen-reports` action and verify 3-Channel Artifact Priority + Gateway
    const runRes = (await (
      await fetch(`${instance.url}/api/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillId: "order-fix-pad",
          actionId: "gen-reports",
          formValues: {},
        }),
      })
    ).json()) as any;

    const wsUrl = instance.url.replace("http://", "ws://") + `/ws/runs/${runRes.runId}?offset=0`;
    const statusMsg = await new Promise<any>((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => rejectPromise(new Error("Artifact WS timeout")), 6000);
      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "status" && msg.status !== "running") {
          clearTimeout(timer);
          ws.close();
          resolvePromise(msg);
        }
      };
    });

    expect(statusMsg.status).toBe("completed");
    const items: any[] = statusMsg.artifactItems || [];
    const htmlItem = items.find((i) => i.filename === "explicit_diff.html");
    const jsonItem = items.find((i) => i.filename === "stdout_matched.json");
    const markerItem = items.find((i) => i.filename === "marker.txt");
    const csvItem = items.find((i) => i.filename === "auto_scan.csv");

    expect(htmlItem).toBeDefined();
    // Priority check: Channel 1 `onComplete: "open"` and `label: "Explicit Diff HTML"` must NOT be overwritten by Channel 3 directory scan!
    expect(htmlItem.label).toBe("Explicit Diff HTML");
    expect(htmlItem.onComplete).toBe("open");

    expect(jsonItem).toBeDefined();
    expect(jsonItem.label).toBe("Stdout Matched JSON");
    expect(jsonItem.onComplete).toBe("download");

    expect(markerItem).toBeDefined();
    expect(markerItem.label).toBe("MarkerLog");
    expect(csvItem).toBeDefined();

    // Test whitelisted artifact gateway `/api/runs/:runId/artifacts/:index`
    const htmlIdx = items.findIndex((i) => i.filename === "explicit_diff.html");
    const gatewayRes = await fetch(
      `${instance.url}/api/runs/${runRes.runId}/artifacts/${htmlIdx}?download=1`
    );
    expect(gatewayRes.status).toBe(200);
    expect(gatewayRes.headers.get("Content-Disposition")).toContain("explicit_diff.html");
    expect(await gatewayRes.text()).toContain("<h1>Diff Report</h1>");

    // E. Test HITL Synchronous Wait & Decision Event (`/api/units/:id/events`)
    const waitPromise = fetch(
      `${instance.url}/api/units/order-fix-pad/events?sinceTs=${Date.now()}&waitMs=4000`
    ).then((r) => r.json());

    await Bun.sleep(80);
    const submitRes = await fetch(`${instance.url}/api/units/order-fix-pad/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "decision_submitted",
        payload: { decision: "approved", selectedIds: ["ORD-101", "ORD-102"] },
      }),
    });
    expect(submitRes.status).toBe(200);

    const waitData = (await waitPromise) as any;
    expect(waitData.events.length).toBeGreaterThanOrEqual(1);
    expect(waitData.events[0].eventType).toBe("decision_submitted");
    expect(waitData.events[0].payload.decision).toBe("approved");

    // F. Promote Scratchpad to Bound Project (`POST /api/scratchpads/order-fix-pad/promote`)
    const promoteRes = (await (
      await fetch(`${instance.url}/api/scratchpads/order-fix-pad/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "project" }),
      })
    ).json()) as any;
    expect(promoteRes.promoted).toBe(true);
    expect(existsSync(join(workspaceDir, ".dashboard/manifest.yaml"))).toBe(true);
    expect(promoteRes.unit.unitKind).toBe("workspace");
    // Verify {{data_dir}}/state.txt was migrated to the promoted unit's data_dir!
    const migratedStateFile = join(xdgDataDir, "units", promoteRes.unit.id, "state.txt");
    expect(existsSync(migratedStateFile)).toBe(true);
  });

  test("13. Layer 0 Multi-Line Bash Statement Aggregation & Targeted Agent Fix API (Click-to-Context + Smart Target Resolution)", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "sd-test13-"));
    const agentsHub = join(tmpBase, ".agents/skills");
    mkdirSync(agentsHub, { recursive: true });

    // 1. Create a zero-config skill with an 18-line curl command (backslash continuation + multi-line single-quoted JSON)
    const jevDir = join(agentsHub, "jev-mock");
    mkdirSync(jevDir, { recursive: true });
    writeFileSync(
      join(jevDir, "SKILL.md"),
      [
        "---",
        "name: jev-mock",
        "description: System One decision model skill",
        "---",
        "# Jev Mock",
        "## 4. API & Integration Reference",
        "### Direct HTTP Request",
        "```bash",
        "# Invoke SystemOne Evaluation API",
        "curl -X POST https://api.typesafe.ai/v1/systemone \\",
        "  -H \"Authorization: Bearer $TYPESAFE_API_KEY\" \\",
        "  -H \"Content-Type: application/json\" \\",
        "  -d '{",
        "    \"model\": \"jev-latest\",",
        "    \"state\": \"Database connection pool exhausted on prod-us-east-1\",",
        "    \"questions\": {",
        "      \"is_incident\": {",
        "        \"type\": \"noul\",",
        "        \"instructions\": \"Is this an active service disruption?\"",
        "      }",
        "    }",
        "  }'",
        "```",
      ].join("\n"),
      "utf-8"
    );

    // 2. Create a configured modular skill to verify smart target resolution onto existing files
    const modDir = join(agentsHub, "mod-configured");
    mkdirSync(join(modDir, ".dashboard/modules"), { recursive: true });
    writeFileSync(join(modDir, "SKILL.md"), "# Mod Configured\n", "utf-8");
    writeFileSync(
      join(modDir, ".dashboard/manifest.yaml"),
      Bun.YAML.stringify({
        id: "mod-configured",
        name: "Mod Configured",
        category: "Engineering Tools",
        description: "Modular skill",
        includes: ["./modules/ops.yaml"],
      }),
      "utf-8"
    );
    writeFileSync(
      join(modDir, ".dashboard/modules/ops.yaml"),
      Bun.YAML.stringify({
        actionGroups: [
          {
            name: "Ops",
            actions: [
              {
                id: "broken-act",
                title: "Broken Action",
                command: "echo broken",
              },
            ],
          },
        ],
      }),
      "utf-8"
    );

    symlinkSync(
      resolve(import.meta.dir, "../skills/skill-dashboard"),
      join(agentsHub, "skill-dashboard"),
      "dir"
    );

    const srv = createDashboardServer({
      port: 0,
      homeDir: tmpBase,
      defaultWorkspace: tmpBase,
      configDir: join(tmpBase, ".config/skill-dashboard"),
      dataDir: join(tmpBase, ".local/share/skill-dashboard"),
      cacheDir: join(tmpBase, ".cache/skill-dashboard"),
      agentRoots: [{ agent: "agents-hub", label: "Agents Hub", path: agentsHub, scope: "global" }],
      lockfiles: [],
    });

    try {
      const boot = (await (await fetch(`${srv.url}/api/bootstrap`)).json()) as any;
      const jev = boot.skills.find((s: any) => s.id === "jev-mock");
      expect(jev).toBeDefined();
      expect(jev.manifest.actionGroups.length).toBe(1);
      // Must aggregate the entire 13-line curl + JSON block into ONE cohesive action, not 13 broken actions!
      const jevActions = jev.manifest.actionGroups[0].actions;
      expect(jevActions.length).toBe(1);
      expect(jevActions[0].title).toBe("Invoke SystemOne Evaluation API");
      expect(jevActions[0].command).toContain("curl -X POST https://api.typesafe.ai/v1/systemone");
      expect(jevActions[0].command).toContain("\"model\": \"jev-latest\"");

      // 3. Test Targeted Agent Fix on unconfigured skill (jev-mock): should target <skill_dir>/.dashboard/manifest.yaml
      const fixZeroRes = (await (
        await fetch(`${srv.url}/api/skills/jev-mock/agent-sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            previewOnly: true,
            userInstruction: "Turn this curl request into a parameterized action with state and questions form fields.",
            targets: [
              {
                kind: "action",
                id: "cmd-1",
                title: "Invoke SystemOne Evaluation API",
                snippet: jevActions[0],
              },
            ],
          }),
        })
      ).json()) as any;

      expect(fixZeroRes.mode).toBe("init");
      expect(fixZeroRes.targetExists).toBe(false);
      expect(fixZeroRes.resolvedTargetFile).toContain("jev-mock/.dashboard/manifest.yaml");
      expect(fixZeroRes.claudeCommand).toContain("claude --dangerously-skip-permissions");
      expect(fixZeroRes.prompt).toContain("Turn this curl request into a parameterized action");
      expect(fixZeroRes.prompt).toContain("Invoke SystemOne Evaluation API");

      // 4. Test Targeted Agent Fix on configured modular skill: should auto-resolve actionSource["broken-act"] -> modules/ops.yaml!
      const fixModRes = (await (
        await fetch(`${srv.url}/api/skills/mod-configured/agent-sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            previewOnly: true,
            userInstruction: "Fix broken-act command flags",
            targets: [
              {
                kind: "action",
                id: "broken-act",
                title: "Broken Action",
                snippet: { id: "broken-act", command: "echo broken" },
              },
            ],
          }),
        })
      ).json()) as any;

      expect(fixModRes.mode).toBe("incremental");
      expect(fixModRes.targetExists).toBe(true);
      expect(fixModRes.resolvedTargetFile).toContain("mod-configured/.dashboard/modules/ops.yaml");
      expect(fixModRes.prompt).toContain("Fix broken-act command flags");
      expect(fixModRes.prompt).toContain("modules/ops.yaml");

      // 5. Verify skill-dashboard's own progressive references/01..04-*.md exist, are registered in .dashboard/manifest.yaml, and pass 3-tier validation
      const selfSkillMd = readFileSync(
        resolve(import.meta.dir, "../skills/skill-dashboard/SKILL.md"),
        "utf-8"
      );
      expect(selfSkillMd).toContain("references/01-manifest-and-actions-spec.md");
      expect(selfSkillMd).toContain("references/02-reactive-data-graph-and-parsers.md");
      expect(selfSkillMd).toContain("references/03-custom-html-views-and-bridge-sdk.md");
      expect(selfSkillMd).toContain("references/04-agent-hitl-scratchpads-and-modular-cli.md");
      expect(selfSkillMd).not.toContain("/Users/xandrezhu/");

      const selfManifestText = readFileSync(
        resolve(import.meta.dir, "../skills/skill-dashboard/.dashboard/manifest.yaml"),
        "utf-8"
      );
      for (const refFile of [
        "references/01-manifest-and-actions-spec.md",
        "references/02-reactive-data-graph-and-parsers.md",
        "references/03-custom-html-views-and-bridge-sdk.md",
        "references/04-agent-hitl-scratchpads-and-modular-cli.md",
      ]) {
        expect(
          existsSync(resolve(import.meta.dir, "../skills/skill-dashboard", refFile))
        ).toBe(true);
        expect(selfManifestText).toContain(refFile);
      }
      const selfSkill = boot.skills.find((s: any) => s.id === "skill-dashboard");
      expect(selfSkill).toBeDefined();
      const selfIssues = validateSkillManifest3Tier(selfSkill);
      expect(selfIssues.filter((i) => i.severity === "error").length).toBe(0);
      expect(selfSkill.manifest.views.some((v: any) => v.id === "ref-01-manifest")).toBe(true);
      expect(selfSkill.manifest.views.some((v: any) => v.id === "ref-04-hitl-cli")).toBe(true);
    } finally {
      srv.stop();
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test("14. Explicit Intermediate DAG DataNodes, Category Grouping, Top-Level TS Scope & Single-Execution Guarantee", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "sd-test-intermediate-dag-"));
    const agentsDir = join(tmpBase, ".agents/skills");
    const skillDir = join(agentsDir, "dag-skill");
    const counterFile = join(tmpBase, "upstream-runs.txt");
    mkdirSync(join(skillDir, ".dashboard"), { recursive: true });

    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: dag-skill\ndescription: Intermediate DAG test\n---\n# DAG Skill\n`,
      "utf-8"
    );

    const manifest = {
      id: "dag-skill",
      name: "DAG Skill",
      category: "Data & Platform",
      description: "Test intermediate DAG nodes and top-level TS variables",
      data: [
        {
          id: "upstream-raw",
          title: "Upstream Expensive Query",
          category: "1. Core Data",
          intermediate: true,
          runtime: "zsh",
          command: `python3 -c 'import json, pathlib; p = pathlib.Path("${counterFile}"); c = int(p.read_text() if p.exists() else "0") + 1; p.write_text(str(c)); print("2026-11-11 INFO sqlalchemy.engine.Engine BEGIN"); print(json.dumps({"runCount": c, "summary": {"total": 42}, "rows": [{"id": "r1", "name": "Alpha"}, {"id": "r2", "name": "Beta"}]}, indent=2)); print("2026-11-11 INFO sqlalchemy.engine.Engine ROLLBACK")'`,
          shape: "raw",
          parse: { format: "json" },
          sync: { onMount: true, ttlMs: 30000 },
        },
        {
          id: "summary-kv",
          title: "Derived Summary KV",
          category: "1. Core Data",
          runtime: "ts",
          prelude: true,
          shape: "kv",
          sync: { onMount: true, ttlMs: 30000, dependsOn: ["upstream-raw"] },
          // Uses top-level `data` directly without `ctx.` prefix!
          code: `
            const raw = data["upstream-raw"] || {};
            return {
              entries: [
                { key: "total", label: "Total Items", value: raw?.summary?.total ?? 0, tone: "success" },
                { key: "runs", label: "Upstream Runs", value: raw?.runCount ?? 0, tone: "info" },
              ],
              record: raw?.summary || {},
            };
          `,
        },
        {
          id: "items-table",
          title: "Derived Items Table",
          category: "1. Core Data",
          runtime: "ts",
          prelude: true,
          shape: "table",
          primaryKey: "id",
          sync: { onMount: true, ttlMs: 30000, dependsOn: ["upstream-raw"] },
          // Also exercises top-level `input` in a transform!
          code: `
            const raw = data["upstream-raw"] || {};
            return raw?.rows || [];
          `,
          transform: {
            runtime: "ts",
            prelude: true,
            code: `
              return (input || []).map((r: any) => ({ ...r, label: r.name.toUpperCase() }));
            `,
          },
        },
      ],
      actionGroups: [
        {
          name: "Ops",
          actions: [
            {
              id: "pick-item",
              title: "Pick Item",
              danger: "safe",
              command: "echo {{form.item}}",
              form: [
                {
                  key: "item",
                  label: "Item",
                  type: "select",
                  fromData: "items-table",
                },
              ],
            },
          ],
        },
      ],
    };

    writeFileSync(
      join(skillDir, ".dashboard/manifest.yaml"),
      JSON.stringify(manifest, null, 2),
      "utf-8"
    );

    const srv = createDashboardServer({
      port: 0,
      homeDir: tmpBase,
      configDir: join(tmpBase, ".config/skill-dashboard"),
      dataDir: join(tmpBase, ".local/share/skill-dashboard"),
      cacheDir: join(tmpBase, ".cache/skill-dashboard"),
      defaultWorkspace: tmpBase,
      agentRoots: [
        {
          agent: "agents-hub",
          label: "Agents Hub",
          path: agentsDir,
          scope: "global",
        },
      ],
    });

    try {
      // 1. Evaluate all data nodes concurrently via GET /api/skills/dag-skill/data
      const res = await fetch(`${srv.url}/api/skills/dag-skill/data`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as any;
      const snaps = body.snapshots;

      // Upstream intermediate node must have executed strictly ONCE despite 2 concurrent downstream consumers + direct evaluation!
      expect(existsSync(counterFile)).toBe(true);
      expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");

      expect(snaps["upstream-raw"].status).toBe("ready");
      expect(snaps["upstream-raw"].intermediate).toBe(true);
      expect(snaps["upstream-raw"].category).toBe("1. Core Data");
      expect(snaps["upstream-raw"].consumedBy).toContain("data:summary-kv");
      expect(snaps["upstream-raw"].consumedBy).toContain("data:items-table");

      expect(snaps["summary-kv"].status).toBe("ready");
      expect(snaps["summary-kv"].intermediate).toBe(false);
      expect(snaps["summary-kv"].category).toBe("1. Core Data");
      expect(snaps["summary-kv"].value.record.total).toBe(42);

      expect(snaps["items-table"].status).toBe("ready");
      expect(snaps["items-table"].consumedBy).toContain("action:pick-item");
      expect(snaps["items-table"].value.rows.length).toBe(2);
      expect(snaps["items-table"].value.rows[0].label).toBe("ALPHA");

      // 2. Test GET /api/skills/dag-skill/context?invalidate=1 followed by parallel per-node streaming requests
      const invRes = await fetch(`${srv.url}/api/skills/dag-skill/context?invalidate=1`);
      expect(invRes.ok).toBe(true);

      const [rUp, rKv, rTbl] = await Promise.all([
        fetch(`${srv.url}/api/skills/dag-skill/data/upstream-raw`).then((r) => r.json()),
        fetch(`${srv.url}/api/skills/dag-skill/data/summary-kv`).then((r) => r.json()),
        fetch(`${srv.url}/api/skills/dag-skill/data/items-table`).then((r) => r.json()),
      ]);

      expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");
      expect((rUp as any).status).toBe("ready");
      expect((rKv as any).value.entries.find((e: any) => e.key === "runs").value).toBe(2);
      expect((rTbl as any).value.rows.length).toBe(2);
    } finally {
      srv.stop();
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test("15. Per-Command Execution Environment (cwd + python + envFile + env) & Default Workspace Preference Inheritance", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "sd-test-cmd-env-"));
    const agentsDir = join(tmpBase, ".agents/skills");
    const skillDir = join(agentsDir, "env-skill");
    const wsDefault = join(tmpBase, "ws-default");
    const wsCustom = join(tmpBase, "ws-custom");

    mkdirSync(join(skillDir, ".dashboard"), { recursive: true });
    mkdirSync(join(wsDefault, ".venv/bin"), { recursive: true });
    mkdirSync(join(wsCustom, ".venv/bin"), { recursive: true });

    // Create distinct .venv/bin/python in wsDefault and wsCustom
    writeFileSync(
      join(wsDefault, ".venv/bin/python"),
      "#!/bin/sh\nexec python3 \"$@\"\n",
      { mode: 0o755 }
    );
    writeFileSync(
      join(wsCustom, ".venv/bin/python"),
      "#!/bin/sh\nexec python3 \"$@\"\n",
      { mode: 0o755 }
    );

    // Create a file in wsCustom for /api/fs/complete testing and a .env.uat file
    writeFileSync(join(wsCustom, "custom-target.xlsx"), "excel-bytes", "utf-8");
    writeFileSync(
      join(wsCustom, ".env.uat"),
      "STAGE=uat_from_dotenv\nAPI_TOKEN=\"top_secret_uat_token\"\nexport REGION='us-west-2'\n",
      "utf-8"
    );

    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: env-skill\ndescription: Per-command execution environment test\n---\n# Env Skill\n",
      "utf-8"
    );

    const manifest = {
      id: "env-skill",
      name: "Env Skill",
      category: "Engineering Tools",
      description: "Test command-level execution environments",
      defaultWorkspace: wsDefault,
      envVars: [
        { key: "STAGE", label: "Stage", default: "dev_default" },
        { key: "API_TOKEN", label: "API Token", secret: true },
      ],
      data: [
        {
          id: "probe-env",
          title: "Probe Active Environment",
          runtime: "zsh",
          // Inherits wsDefault initially
          command:
            "python3 -c 'import json, os; print(json.dumps({\"cwd\": os.getcwd(), \"stage\": os.environ.get(\"STAGE\"), \"region\": os.environ.get(\"REGION\", \"none\"), \"py\": \"{{python}}\"}))'",
          shape: "kv",
          parse: { format: "json" },
        },
        {
          id: "derived-stage",
          title: "Derived Stage Scalar",
          runtime: "ts",
          prelude: true,
          shape: "scalar",
          sync: { dependsOn: ["probe-env"] },
          code: "return { value: data['probe-env']?.stage || 'unknown', tone: 'info' };",
        },
      ],
      actionGroups: [
        {
          name: "Ops",
          actions: [
            {
              id: "act-inherit",
              title: "Inherited Default Action",
              danger: "safe",
              command: "{{python}} -m pytest",
            },
            {
              id: "act-yaml-custom",
              title: "YAML Custom Env Action",
              danger: "safe",
              cwd: wsCustom,
              envFile: ".env.uat",
              env: { CUSTOM_FLAG: "enabled" },
              command: "{{python}} run_audit.py {{form.target}}",
              form: [{ key: "target", label: "Target File", type: "file" }],
            },
          ],
        },
      ],
    };

    writeFileSync(
      join(skillDir, ".dashboard/manifest.yaml"),
      JSON.stringify(manifest, null, 2),
      "utf-8"
    );

    const srv = createDashboardServer({
      port: 0,
      homeDir: tmpBase,
      configDir: join(tmpBase, ".config/skill-dashboard"),
      dataDir: join(tmpBase, ".local/share/skill-dashboard"),
      cacheDir: join(tmpBase, ".cache/skill-dashboard"),
      defaultWorkspace: wsDefault,
      agentRoots: [
        {
          agent: "agents-hub",
          label: "Agents Hub",
          path: agentsDir,
          scope: "global",
        },
      ],
    });

    try {
      // 1. Preview `act-inherit`: should inherit wsDefault and resolve wsDefault/.venv/bin/python
      const prevInherit = (await (
        await fetch(`${srv.url}/api/preview-command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skillId: "env-skill", actionId: "act-inherit" }),
        })
      ).json()) as any;

      expect(prevInherit.cwd).toBe(wsDefault);
      expect(prevInherit.maskedCommand).toContain(join(wsDefault, ".venv/bin/python"));
      expect(prevInherit.resolvedEnv.isCustom).toBe(false);
      expect(prevInherit.resolvedEnv.effectiveEnv.STAGE).toBe("dev_default");

      // 2. Preview `act-yaml-custom`: should resolve wsCustom, auto-detect wsCustom/.venv/bin/python, load .env.uat, and mask API_TOKEN!
      const prevCustom = (await (
        await fetch(`${srv.url}/api/preview-command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            skillId: "env-skill",
            actionId: "act-yaml-custom",
            formValues: { target: "custom-target.xlsx" },
          }),
        })
      ).json()) as any;

      expect(prevCustom.cwd).toBe(wsCustom);
      expect(prevCustom.maskedCommand).toContain(join(wsCustom, ".venv/bin/python"));
      expect(prevCustom.resolvedEnv.isCustom).toBe(true);
      expect(prevCustom.resolvedEnv.effectiveEnv.STAGE).toBe("uat_from_dotenv");
      expect(prevCustom.resolvedEnv.effectiveEnv.REGION).toBe("us-west-2");
      expect(prevCustom.resolvedEnv.effectiveEnv.CUSTOM_FLAG).toBe("enabled");
      expect(prevCustom.resolvedEnv.effectiveEnv.API_TOKEN).toBe("********");

      // 3. Test /api/fs/complete rooted at action's custom cwd (wsCustom)
      const completeRes = (await (
        await fetch(
          `${srv.url}/api/fs/complete?skillId=env-skill&cwd=${encodeURIComponent(wsCustom)}&prefix=custom-`
        )
      ).json()) as any;
      expect(completeRes.suggestions.some((s: any) => s.path === "custom-target.xlsx")).toBe(true);

      // 4. Evaluate DataNodes initially: `probe-env` inherits wsDefault and STAGE=dev_default
      const initData = (await (await fetch(`${srv.url}/api/skills/env-skill/data`)).json()) as any;
      expect(initData.snapshots["probe-env"].value.record.cwd).toContain("ws-default");
      expect(initData.snapshots["probe-env"].value.record.stage).toBe("dev_default");
      expect(initData.snapshots["probe-env"].resolvedEnv.isCustom).toBe(false);
      expect(initData.snapshots["derived-stage"].value.value).toBe("dev_default");

      // 5. Override `probe-env` DataNode's execution environment via PUT /api/skills/env-skill/command-env
      // Should persist to SQLite, optionally write to manifest, and automatically invalidate downstream `derived-stage`!
      const updateNodeEnvRes = (await (
        await fetch(`${srv.url}/api/skills/env-skill/command-env`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetKind: "data",
            targetId: "probe-env",
            envConfig: {
              cwd: wsCustom,
              envFile: ".env.uat",
              env: { STAGE: "prod_override" },
            },
            saveToManifest: true,
          }),
        })
      ).json()) as any;

      expect(updateNodeEnvRes.snapshot.status).toBe("ready");
      expect(updateNodeEnvRes.snapshot.value.record.cwd).toContain("ws-custom");
      expect(updateNodeEnvRes.snapshot.value.record.stage).toBe("prod_override");
      expect(updateNodeEnvRes.snapshot.value.record.region).toBe("us-west-2");
      expect(updateNodeEnvRes.snapshot.value.record.py).toContain(join(wsCustom, ".venv/bin/python"));
      expect(updateNodeEnvRes.snapshot.resolvedEnv.isCustom).toBe(true);

      // Downstream `derived-stage` must have been invalidated and recomputed to "prod_override"!
      const downstreamSnap = (await (
        await fetch(`${srv.url}/api/skills/env-skill/data/derived-stage`)
      ).json()) as any;
      expect(downstreamSnap.value.value).toBe("prod_override");

      // Verify manifest.yaml on disk was updated with probe-env's envConfig
      const diskManifest = readFileSync(join(skillDir, ".dashboard/manifest.yaml"), "utf-8");
      expect(diskManifest).toContain("prod_override");

      // 6. Reset `probe-env` environment back to default preference (envConfig: null)
      const resetRes = (await (
        await fetch(`${srv.url}/api/skills/env-skill/command-env`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetKind: "data",
            targetId: "probe-env",
            envConfig: null,
            saveToManifest: true,
          }),
        })
      ).json()) as any;

      expect(resetRes.snapshot.value.record.cwd).toContain("ws-default");
      expect(resetRes.snapshot.value.record.stage).toBe("dev_default");
      expect(resetRes.snapshot.resolvedEnv.isCustom).toBe(false);
    } finally {
      srv.stop();
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test("16. DataNode White-Box Source Inspection (resolvedSource) & Bound Action Argument Audit", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "sd-test-16-"));
    const agentsDir = join(tmpBase, "agents");
    const skillDir = join(agentsDir, "audit-skill");
    const wsDir = join(tmpBase, "workspace");

    mkdirSync(join(skillDir, ".dashboard"), { recursive: true });
    mkdirSync(join(skillDir, "tools"), { recursive: true });
    mkdirSync(join(wsDir, ".venv/bin"), { recursive: true });

    const pyWrapper = join(wsDir, ".venv/bin/python");
    writeFileSync(
      pyWrapper,
      `#!/bin/sh\nexec python3 "$@"\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      join(skillDir, "tools/inspect_doc.py"),
      `import sys\nprint("INSPECT:", sys.argv[1:])\n`,
      { mode: 0o755 }
    );
    writeFileSync(
      join(skillDir, "tools/sample.json"),
      JSON.stringify([{ id: "660", title: "ERS-660" }])
    );
    const sqlitePath = join(skillDir, "tools/metrics.db");
    const testDb = new Database(sqlitePath);
    testDb.run("CREATE TABLE metrics (k TEXT, v INTEGER); INSERT INTO metrics VALUES ('acc', 100);");
    testDb.close();

    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: audit-skill\ndescription: Audit test skill\n---\n# Audit Skill\n`
    );

    const manifestYaml = `
id: audit-skill
name: Audit Skill
category: Engineering Tools
description: White-box inspection and bound action audit test
defaultWorkspace: "${wsDir}"
tsPrelude: true
context:
  - key: env_mode
    label: Env Mode
    type: select
    default: uat
    options:
      - { label: UAT, value: uat }
      - { label: PROD, value: prod }
data:
  - id: zsh-node
    title: Zsh Query Node
    runtime: zsh
    command: "{{python}} {{skill_dir}}/tools/inspect_doc.py --env {{context.env_mode}}"
    shape: raw
    quickActions:
      - label: Quick Inspect
        actionId: inspect-case
        mode: run
        args:
          doc_id: "999"
          field: "{{context.env_mode}}"
  - id: glob-node
    title: Glob Files Node
    runtime: glob
    pattern:
      - "{{skill_dir}}/tools/*.json"
    valueFormat: basename
    shape: table
    primaryKey: name
  - id: file-node
    title: File JSON Node
    runtime: file
    filePath: "{{skill_dir}}/tools/sample.json"
    shape: table
    primaryKey: id
  - id: sqlite-node
    title: SQLite Metrics Node
    runtime: sqlite
    db: "{{skill_dir}}/tools/metrics.db"
    sql: "SELECT k, v FROM metrics WHERE k = 'acc'"
    shape: table
    primaryKey: k
  - id: py-node
    title: Python Structured Node
    runtime: python
    shape: matrix
    code: |
      def main(ctx):
          return {
              "rowKeys": ["R1"],
              "colKeys": ["C1"],
              "cells": {"R1": {"C1": "val_1"}}
          }
    cellAction:
      label: Cell Inspect
      actionId: inspect-case
      mode: prefill
      args:
        doc_id: "{{cell.rowKey}}"
        field: "{{cell.colKey}}_{{cell.value}}"
  - id: docs-table
    title: Golden Docs Table
    runtime: ts
    prelude: true
    shape: table
    primaryKey: doc_id
    code: |
      return [
        { doc_id: "#660", raw_doc_id: "660", field: "discharge_specs" },
        { doc_id: "#664", raw_doc_id: "664", field: "charge_specs" }
      ];
    columns:
      - { key: doc_id, label: "Doc ID", type: code }
      - { key: field, label: "Field", type: text }
    rowActions:
      - label: Inspect Case
        actionId: inspect-case
        mode: prefill
        args:
          doc_id: "{{row.raw_doc_id}}"
          field: "{{row.field}}"
    bulkActions:
      - label: Bulk Inspect
        actionId: inspect-case
        mode: run
        args:
          doc_id: "{{selected.raw_doc_id}}"
          field: "bulk_mode"
actionGroups:
  - name: Diagnostics
    actions:
      - id: inspect-case
        title: Inspect Mismatch Case
        danger: warn
        command: "{{python}} {{skill_dir}}/tools/inspect_doc.py {{form.doc_id}} {{form.field}}"
        form:
          - key: doc_id
            label: Document ID
            type: text
            positional: true
            required: true
          - key: field
            label: Field Key
            type: text
            positional: true
            required: true
`;
    writeFileSync(join(skillDir, ".dashboard/manifest.yaml"), manifestYaml.trim() + "\n");

    const srv = createDashboardServer({
      port: 0,
      agentRoots: [{ agent: "agents-hub", label: "Universal", path: agentsDir, scope: "global" }],
      lockfiles: [],
      dataDir: join(tmpBase, "data"),
      configDir: join(tmpBase, "config"),
      cacheDir: join(tmpBase, "cache"),
      defaultWorkspace: wsDir,
      homeDir: tmpBase,
    });

    try {
      const dataRes = (await (await fetch(`${srv.url}/api/skills/audit-skill/data`)).json()) as any;
      const zshSnap = dataRes.snapshots["zsh-node"];
      const globSnap = dataRes.snapshots["glob-node"];
      const fileSnap = dataRes.snapshots["file-node"];
      const sqliteSnap = dataRes.snapshots["sqlite-node"];
      const pySnap = dataRes.snapshots["py-node"];
      const tsSnap = dataRes.snapshots["docs-table"];

      // 1. Verify resolvedSource is populated on DataSnapshot across all 6 active runtimes
      expect(typeof zshSnap.resolvedSource).toBe("string");
      expect(zshSnap.resolvedSource).toContain(join(wsDir, ".venv/bin/python"));
      expect(zshSnap.resolvedSource).toContain("--env uat");

      expect(typeof globSnap.resolvedSource).toBe("string");
      expect(globSnap.resolvedSource).toContain("audit-skill/tools/*.json");

      expect(typeof fileSnap.resolvedSource).toBe("string");
      expect(fileSnap.resolvedSource).toContain("audit-skill/tools/sample.json");

      expect(typeof sqliteSnap.resolvedSource).toBe("string");
      expect(sqliteSnap.resolvedSource).toContain("audit-skill/tools/metrics.db");
      expect(sqliteSnap.resolvedSource).toContain("SELECT k, v FROM metrics");

      expect(typeof pySnap.resolvedSource).toBe("string");
      expect(pySnap.resolvedSource).toContain("def main(ctx):");

      expect(typeof tsSnap.resolvedSource).toBe("string");
      expect(tsSnap.resolvedSource).toContain("raw_doc_id");

      // 2. Verify interpolateBoundTriggerArgs + /api/preview-command across rowActions, bulkActions, quickActions, and cellAction
      const row = tsSnap.value.rows[0];
      const rowTrigger = tsSnap.rowActions[0];
      const resolvedRowArgs = interpolateBoundTriggerArgs(rowTrigger.args, {
        row,
        contextValues: dataRes.context,
        dataSnapshots: dataRes.snapshots,
      });
      expect(resolvedRowArgs).toEqual({ doc_id: "660", field: "discharge_specs" });

      const prevRowRes = (await (
        await fetch(`${srv.url}/api/preview-command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            skillId: "audit-skill",
            actionId: rowTrigger.actionId,
            formValues: resolvedRowArgs,
          }),
        })
      ).json()) as any;
      expect(prevRowRes.maskedCommand).toContain("inspect_doc.py 660 discharge_specs");
      expect(prevRowRes.maskedCommand).not.toContain("#660");

      const bulkTrigger = tsSnap.bulkActions[0];
      const resolvedBulkArgs = interpolateBoundTriggerArgs(bulkTrigger.args, {
        selectedRows: tsSnap.value.rows,
        contextValues: dataRes.context,
      });
      expect(resolvedBulkArgs).toEqual({ doc_id: "660,664", field: "bulk_mode" });

      const quickTrigger = zshSnap.quickActions[0];
      const resolvedQuickArgs = interpolateBoundTriggerArgs(quickTrigger.args, {
        contextValues: dataRes.context,
      });
      expect(resolvedQuickArgs).toEqual({ doc_id: "999", field: "uat" });

      const cellTrigger = pySnap.cellAction;
      const resolvedCellArgs = interpolateBoundTriggerArgs(cellTrigger.args, {
        cell: { rowKey: "R1", colKey: "C1", value: "val_1" },
      });
      expect(resolvedCellArgs).toEqual({ doc_id: "R1", field: "C1_val_1" });

      // 3. Verify 3-tier manifest validation on audit-skill and vsip (when installed)
      const bootRes = (await (await fetch(`${srv.url}/api/bootstrap`)).json()) as any;
      const auditSkillObj = bootRes.skills.find((s: any) => s.id === "audit-skill");
      expect(validateSkillManifest3Tier(auditSkillObj)).toEqual([]);

      const vsipDir = join(homedir(), ".agents/skills/vsip");
      if (existsSync(join(vsipDir, ".dashboard/manifest.yaml"))) {
        const proc = Bun.spawnSync(["bun", "src/manifest-cli.ts", "validate", "vsip"], {
          cwd: process.cwd(),
        });
        expect(proc.exitCode).toBe(0);
        const evalMod = readFileSync(
          join(vsipDir, ".dashboard/modules/03-3-accuracy-war-room-doc-eval.yaml"),
          "utf-8"
        );
        expect(evalMod).toContain("raw_doc_id: String(d.doc_id)");
        expect(evalMod).toContain('doc_id: "{{row.raw_doc_id}}"');
      }
    } finally {
      srv.stop();
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test("17. Self-Hosted skill-dashboard Dogfooding (category, intermediate: true, {{manifest_cli}}, relative defaultWorkspace) & Agent Sync Prompt Integrity", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "sd-test-17-"));
    const agentsDir = join(tmpBase, "agents");
    mkdirSync(agentsDir, { recursive: true });

    // Symlink the real skills/skill-dashboard into our isolated test agentsDir
    const realSkillSubdir = resolve(process.cwd(), "skills/skill-dashboard");
    symlinkSync(realSkillSubdir, join(agentsDir, "skill-dashboard"));

    const srv = createDashboardServer({
      port: 0,
      agentRoots: [{ agent: "agents-hub", label: "Universal", path: agentsDir, scope: "global" }],
      lockfiles: [],
      dataDir: join(tmpBase, "data"),
      configDir: join(tmpBase, "config"),
      cacheDir: join(tmpBase, "cache"),
      defaultWorkspace: tmpBase,
      homeDir: tmpBase,
    });

    try {
      // 1. Verify skill-dashboard's relative defaultWorkspace ("../..") resolves to the engine repository root
      const bootRes = (await (await fetch(`${srv.url}/api/bootstrap`)).json()) as any;
      const selfSkill = bootRes.skills.find((s: any) => s.id === "skill-dashboard");
      expect(selfSkill).toBeDefined();
      expect(existsSync(join(selfSkill.effectiveWorkspace, "package.json"))).toBe(true);
      expect(existsSync(join(selfSkill.effectiveWorkspace, "src/manifest-cli.ts"))).toBe(true);

      // 2. Verify buildAgentManifestSyncPrompt (POST /api/skills/skill-dashboard/agent-sync with previewOnly: true)
      const syncRes = (await (
        await fetch(`${srv.url}/api/skills/skill-dashboard/agent-sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            previewOnly: true,
            userInstruction: "Verify agent guidance prompt",
          }),
        })
      ).json()) as any;

      const readMatch = syncRes.prompt.match(/Read\s+([^\s]+)\s+/);
      expect(readMatch).not.toBeNull();
      const guidePath = readMatch[1];
      expect(existsSync(guidePath)).toBe(true);
      expect(syncRes.prompt).toContain("intermediate: true");
      expect(syncRes.prompt).toContain("category");
      expect(syncRes.prompt).toContain("cwd");

      // 3. Verify all DataNodes of skill-dashboard evaluate with status === "ready", category tags, and intermediate: true DAG node
      const dataRes = (await (
        await fetch(`${srv.url}/api/skills/skill-dashboard/data`)
      ).json()) as any;
      const snaps = dataRes.snapshots;

      expect(snaps["ecosystem-health"].status).toBe("ready");
      expect(snaps["ecosystem-health"].category).toBe("1. Service & Runtime");
      expect(snaps["ecosystem-health"].resolvedSource).toContain("src/manifest-cli.ts");

      expect(snaps["service-telemetry"].status).toBe("ready");
      expect(snaps["service-telemetry"].category).toBe("1. Service & Runtime");

      expect(snaps["recent-runs-table"].status).toBe("ready");
      expect(snaps["recent-runs-table"].category).toBe("1. Service & Runtime");

      expect(snaps["skills-catalog-raw"]).toBeDefined();
      expect(snaps["skills-catalog-raw"].status).toBe("ready");
      expect(snaps["skills-catalog-raw"].intermediate).toBe(true);
      expect(snaps["skills-catalog-raw"].category).toBe("2. Skills & Ecosystem");
      expect(snaps["skills-catalog-raw"].consumedBy).toContain("data:skills-catalog-table");
      expect(snaps["skills-catalog-raw"].consumedBy).toContain("data:studio-coverage-kpi");

      expect(snaps["skills-catalog-table"].status).toBe("ready");
      expect(snaps["skills-catalog-table"].category).toBe("2. Skills & Ecosystem");
      expect(snaps["studio-coverage-kpi"].status).toBe("ready");
      expect(snaps["studio-coverage-kpi"].category).toBe("2. Skills & Ecosystem");

      // 4. Verify build-ui and manifest-cli-map actions preview with valid repo root cwd and {{manifest_cli}} expansion
      const prevBuild = (await (
        await fetch(`${srv.url}/api/preview-command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            skillId: "skill-dashboard",
            actionId: "build-ui",
            formValues: {},
          }),
        })
      ).json()) as any;
      expect(existsSync(join(prevBuild.cwd, "package.json"))).toBe(true);

      const prevMap = (await (
        await fetch(`${srv.url}/api/preview-command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            skillId: "skill-dashboard",
            actionId: "manifest-cli-map",
            formValues: { skill_id: "skill-dashboard" },
          }),
        })
      ).json()) as any;
      expect(prevMap.maskedCommand).toContain("src/manifest-cli.ts map skill-dashboard");

      // 5. Verify SKILL.md and references/01..04-*.md have no stale ~/.agents/skills/skill-dashboard/src/ paths
      const ref04 = readFileSync(
        join(realSkillSubdir, "references/04-agent-hitl-scratchpads-and-modular-cli.md"),
        "utf-8"
      );
      expect(ref04).not.toContain("~/.agents/skills/skill-dashboard/src/");
      const skillMd = readFileSync(join(realSkillSubdir, "SKILL.md"), "utf-8");
      expect(skillMd).toContain("intermediate: true");
      expect(skillMd).toContain("{{manifest_cli}}");

      // 6. Verify built frontend bundle (dist/app.js) does not contain server-only import.meta.dir calls
      const distAppJs = readFileSync(resolve(process.cwd(), "dist/app.js"), "utf-8");
      expect(distAppJs).not.toContain("import.meta.dir");
    } finally {
      srv.stop();
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test("18. 5-Primitive Data Model & View Decoupling (kv Nested JSON, tree, graph Kahn Layering & Impact Radius, list, matrix), selectContextKey, preconditions, Protected passive intoData & Full skill-dashboard Dogfooding", async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), "sd-test-18-"));
    const agentsDir = join(tmpBase, "agents");
    mkdirSync(agentsDir, { recursive: true });

    // 1. Symlink the real skills/skill-dashboard into our isolated test agentsDir
    const realSkillSubdir = resolve(process.cwd(), "skills/skill-dashboard");
    symlinkSync(realSkillSubdir, join(agentsDir, "skill-dashboard"));

    // 2. Also create a synthetic skill to test arbitrary JSON tree, graph cycle/dangling-edge resilience, and L2 validation of nodeActions/selectContextKey/preconditions
    const synthDir = join(agentsDir, "prim-lab");
    mkdirSync(join(synthDir, ".dashboard"), { recursive: true });
    writeFileSync(join(synthDir, "SKILL.md"), "---\nname: prim-lab\ndescription: Primitive Lab\n---\n# Prim Lab\n");
    writeFileSync(
      join(synthDir, ".dashboard/manifest.yaml"),
      [
        "id: prim-lab",
        'name: "Primitive Lab"',
        'category: "Engineering Tools"',
        'description: "Tests 5 primitives"',
        "tsPrelude: true",
        "context:",
        "  - key: selected_item",
        '    label: "Selected Item"',
        "    type: text",
        '    default: "all"',
        "data:",
        "  - id: deep-json-tree",
        '    title: "Arbitrary Nested JSON as Tree"',
        "    runtime: ts",
        "    shape: tree",
        '    selectContextKey: "selected_item"',
        "    nodeActions:",
        '      - label: "Inspect Node"',
        "        actionId: echo-node",
        "        args:",
        '          target_id: "{{node.id}}"',
        '          downstream: "{{node.downstreamIds}}"',
        "    code: |",
        "      return {",
        "        cluster: { region: 'us-west-2', replicas: 3 },",
        "        services: [{ id: 'svc-api', port: 8080 }, { id: 'svc-worker', port: 9090 }]",
        "      };",
        "  - id: cyclic-graph",
        '    title: "Graph with Cycle & Dangling Edge"',
        "    runtime: ts",
        "    shape: graph",
        "    nodeActions:",
        '      - label: "Blast Radius"',
        "        actionId: echo-node",
        "        args:",
        '          target_id: "{{node.id}}"',
        '          upstream: "{{node.upstreamIds}}"',
        '          downstream: "{{node.downstreamIds}}"',
        "    code: |",
        "      return {",
        "        nodes: [",
        "          { id: 'n_root', label: 'Root Source' },",
        "          { id: 'n_mid', label: 'Middle Transform' },",
        "          { id: 'n_leaf', label: 'Leaf Sink' },",
        "          { id: 'c_1', label: 'Cycle A' },",
        "          { id: 'c_2', label: 'Cycle B' }",
        "        ],",
        "        edges: [",
        "          { source: 'n_root', target: 'n_mid', label: 'feeds' },",
        "          { source: 'n_mid', target: 'n_leaf', label: 'derives' },",
        "          { source: 'n_leaf', target: 'n_dangling', label: 'implicit' },",
        "          { source: 'c_1', target: 'c_2' },",
        "          { source: 'c_2', target: 'c_1' }",
        "        ]",
        "      };",
        "actionGroups:",
        '  - name: "Lab Actions"',
        "    actions:",
        "      - id: echo-node",
        '        title: "Echo Node Impact"',
        "        danger: safe",
        '        command: "echo {{form.target_id}} {{form.upstream}} {{form.downstream}}"',
        "        preconditions:",
        "          - dataNodeId: deep-json-tree",
        "            notEmpty: true",
        '            message: "Tree must not be empty"',
        "            fixActionId: echo-node",
        "        form:",
        "          - key: target_id",
        '            label: "Target ID"',
        "            type: text",
        "          - key: upstream",
        '            label: "Upstream IDs"',
        "            type: text",
        "          - key: downstream",
        '            label: "Downstream IDs"',
        "            type: text",
      ].join("\n")
    );

    const srv = createDashboardServer({
      port: 0,
      agentRoots: [{ agent: "agents-hub", label: "Universal", path: agentsDir, scope: "global" }],
      lockfiles: [],
      dataDir: join(tmpBase, "data"),
      configDir: join(tmpBase, "config"),
      cacheDir: join(tmpBase, "cache"),
      defaultWorkspace: tmpBase,
      homeDir: tmpBase,
    });

    try {
      // A. Verify prim-lab arbitrary JSON tree & cyclic/dangling graph topology
      const labRes = (await (await fetch(`${srv.url}/api/skills/prim-lab/data`)).json()) as any;
      const treeSnap = labRes.snapshots["deep-json-tree"];
      expect(treeSnap.status).toBe("ready");
      expect(treeSnap.shape).toBe("tree");
      expect(treeSnap.selectContextKey).toBe("selected_item");
      expect(Array.isArray(treeSnap.value.roots)).toBe(true);
      expect(treeSnap.value.roots.length).toBe(2);
      expect(treeSnap.value.roots[0].label).toBe("cluster");
      expect(treeSnap.value.roots[0].children.length).toBe(2);
      expect(treeSnap.options.length).toBeGreaterThan(0);

      const graphSnap = labRes.snapshots["cyclic-graph"];
      expect(graphSnap.status).toBe("ready");
      expect(graphSnap.shape).toBe("graph");
      const gNodes: any[] = graphSnap.value.nodes;
      const rootNode = gNodes.find((n) => n.id === "n_root");
      const midNode = gNodes.find((n) => n.id === "n_mid");
      const danglingNode = gNodes.find((n) => n.id === "n_dangling");
      const cyc1 = gNodes.find((n) => n.id === "c_1");
      expect(rootNode.layer).toBe(0);
      expect(midNode.layer).toBe(1);
      expect(danglingNode).toBeDefined();
      expect(danglingNode.layer).toBe(3);
      expect(rootNode.downstreamIds).toEqual(["n_mid", "n_leaf", "n_dangling"]);
      expect(midNode.upstreamIds).toEqual(["n_root"]);
      expect(midNode.downstreamIds).toEqual(["n_leaf", "n_dangling"]);
      expect(cyc1.downstreamIds).toEqual(["c_2"]);

      // Verify interpolateBoundTriggerArgs with {{node.*}}
      const resolvedNodeArgs = interpolateBoundTriggerArgs(graphSnap.nodeActions[0].args, {
        node: rootNode,
      });
      expect(resolvedNodeArgs).toEqual({
        target_id: "n_root",
        upstream: "",
        downstream: "n_mid,n_leaf,n_dangling",
      });

      // B. Verify skill-dashboard dogfoods all canonical shapes & data-flow mechanisms
      const sdDataRes = (await (
        await fetch(`${srv.url}/api/skills/skill-dashboard/data`)
      ).json()) as any;
      const sdSnaps = sdDataRes.snapshots;

      // 1. kv with lossless nested rawValue + deep resolveDataSnapshotPath
      const telSnap = sdSnaps["service-telemetry"];
      expect(telSnap.status).toBe("ready");
      expect(telSnap.shape).toBe("kv");
      const storageEntry = telSnap.value.entries.find((e: any) => e.key === "Storage Paths");
      expect(storageEntry).toBeDefined();
      expect(storageEntry.rawValue).toBeDefined();
      expect(typeof storageEntry.rawValue.db).toBe("string");
      expect(
        resolveDataSnapshotPath(sdSnaps, "service-telemetry.Storage Paths.db")
      ).toContain("dashboard.db");

      // 2. Intermediate SQLite stats node + Multi-Source Join in skills-catalog-table + selectContextKey
      expect(sdSnaps["skills-run-stats-raw"]).toBeDefined();
      expect(sdSnaps["skills-run-stats-raw"].status).toBe("ready");
      expect(sdSnaps["skills-run-stats-raw"].intermediate).toBe(true);

      const catTable = sdSnaps["skills-catalog-table"];
      expect(catTable.status).toBe("ready");
      expect(catTable.selectContextKey).toBe("focus_skill");
      expect(catTable.value.columns.some((c: any) => c.key === "totalRuns")).toBe(true);

      // 3. Matrix, Graph, Tree, List, and Passive nodes in skill-dashboard
      expect(sdSnaps["ecosystem-mount-matrix"]).toBeDefined();
      expect(sdSnaps["ecosystem-mount-matrix"].status).toBe("ready");
      expect(sdSnaps["ecosystem-mount-matrix"].shape).toBe("matrix");
      expect(Array.isArray(sdSnaps["ecosystem-mount-matrix"].value.rowKeys)).toBe(true);

      expect(sdSnaps["skill-reactive-graph"]).toBeDefined();
      expect(sdSnaps["skill-reactive-graph"].status).toBe("ready");
      expect(sdSnaps["skill-reactive-graph"].shape).toBe("graph");
      expect(sdSnaps["skill-reactive-graph"].value.nodes.length).toBeGreaterThan(0);
      expect(sdSnaps["skill-reactive-graph"].value.edges.length).toBeGreaterThan(0);

      expect(sdSnaps["manifest-symbol-tree"]).toBeDefined();
      expect(sdSnaps["manifest-symbol-tree"].status).toBe("ready");
      expect(sdSnaps["manifest-symbol-tree"].shape).toBe("tree");
      expect(sdSnaps["manifest-symbol-tree"].value.roots.length).toBeGreaterThan(0);

      expect(sdSnaps["architecture-issues-list"]).toBeDefined();
      expect(sdSnaps["architecture-issues-list"].status).toBe("ready");
      expect(sdSnaps["architecture-issues-list"].shape).toBe("list");
      expect(sdSnaps["architecture-issues-list"].value.items.length).toBeGreaterThan(0);

      expect(sdSnaps["last-symbol-map-output"]).toBeDefined();
      expect(sdSnaps["last-symbol-map-output"].runtime).toBe("passive");

      // 4. Master-Detail context filtering via focus_skill
      const ctxPutRes = (await (
        await fetch(`${srv.url}/api/skills/skill-dashboard/context`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: "focus_skill", value: "skill-dashboard" }),
        })
      ).json()) as any;
      expect(ctxPutRes.context.focus_skill).toBe("skill-dashboard");
      expect(ctxPutRes.snapshots["manifest-symbol-tree"].status).toBe("ready");

      // 5. Execute manifest-cli-map and verify output.intoData -> last-symbol-map-output survives ?invalidate=1
      const runRes = (await (
        await fetch(`${srv.url}/api/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            skillId: "skill-dashboard",
            actionId: "manifest-cli-map",
            formValues: { skill_id: "skill-dashboard" },
            runner: "web_terminal",
          }),
        })
      ).json()) as any;
      expect(runRes.runId).toBeDefined();

      // Wait for run to complete
      for (let i = 0; i < 40; i++) {
        const b = (await (await fetch(`${srv.url}/api/bootstrap`)).json()) as any;
        const r = b.runs.find((x: any) => x.id === runRes.runId);
        if (r && r.status !== "running") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Simulate global refresh (?invalidate=1) triggered by UI after PTY run completes
      await fetch(`${srv.url}/api/skills/skill-dashboard/context?invalidate=1`);
      const passiveSnap = (await (
        await fetch(`${srv.url}/api/skills/skill-dashboard/data/last-symbol-map-output`)
      ).json()) as any;
      expect(passiveSnap.status).toBe("ready");
      expect(passiveSnap.stdout).toContain("skill-dashboard");

      // 6. Verify 3-tier manifest validation passes with 0 errors on both prim-lab and skill-dashboard
      const bootAfter = (await (await fetch(`${srv.url}/api/bootstrap`)).json()) as any;
      const primLabSkill = bootAfter.skills.find((s: any) => s.id === "prim-lab");
      const selfSkill = bootAfter.skills.find((s: any) => s.id === "skill-dashboard");
      expect(validateSkillManifest3Tier(primLabSkill)).toEqual([]);
      expect(validateSkillManifest3Tier(selfSkill)).toEqual([]);
    } finally {
      srv.stop();
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
