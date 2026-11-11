import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "path";
import YAML from "yaml";
import { inferFormAndTemplateFromSynopsis, saveSkillManifestLayer } from "./cascade.ts";
import { DashboardDatabase } from "./db.ts";
import { initManifestInDirectory } from "./manifest-cli.ts";
import {
  buildAgentManifestSyncPrompt,
  buildGuardedSkillUpdateCommand,
  computeParentPath,
  computeSkillsSignature,
  discoverCandidateWorkspaces,
  discoverCanonicalSkills,
  expandHomePath,
  getDefaultAgentRoots,
  isPathInsideRoot,
  listSkillDirectory,
  readSkillFileSafe,
  repairBrokenMount,
  toggleSkillMount,
} from "./discovery.ts";
import {
  launchExternalMacTerminal,
  RunExecutionManager,
  type WsClientData,
} from "./execution.ts";
import {
  extractImplicitDependencies,
  interpolateActionCommand,
  resolvePythonExecutable,
} from "./interpolator.ts";
import {
  deriveProjectSlug,
  ensureDashboardDirectories,
  ensureUnitSandboxPaths,
  loadDashboardConfig,
  resolveDashboardPaths,
  sanitizeUnitSegment,
  saveDashboardConfig,
  updateLatestArtifactsSymlink,
  type DashboardPaths,
} from "./paths.ts";
import { injectSkillDashboardBridge, ReactiveGraphEngine } from "./probes.ts";
import type {
  AgentMountRoot,
  CanonicalSkill,
  DashboardServerOptions,
  UnconfiguredFolderAction,
  UnitEvent,
} from "./types.ts";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".json": "application/json; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
};

function rewriteMarkdownImagePaths(md: string, skillId: string, mdSourceRelPath: string): string {
  const mdDir = dirname(mdSourceRelPath);
  let out = md.replace(/!\[([^\]]*)\]\((?!https?:\/\/|data:|\/)([^)]+)\)/g, (_m, alt, rawUrl) => {
    const cleanUrl = rawUrl.trim().split(/\s+/)[0];
    const resolvedRel = normalize(join(mdDir === "." ? "" : mdDir, cleanUrl));
    return `![${alt}](/api/assets?skill=${encodeURIComponent(skillId)}&path=${encodeURIComponent(resolvedRel)})`;
  });
  out = out.replace(/<img([^>]*?)\ssrc=["'](?!https?:\/\/|data:|\/)([^"']+)["']/gi, (_m, attrs, rawUrl) => {
    const resolvedRel = normalize(join(mdDir === "." ? "" : mdDir, rawUrl.trim()));
    return `<img${attrs} src="/api/assets?skill=${encodeURIComponent(skillId)}&path=${encodeURIComponent(resolvedRel)}"`;
  });
  return out;
}

export interface DashboardServerInstance {
  server: ReturnType<typeof Bun.serve<WsClientData>>;
  port: number;
  url: string;
  db: DashboardDatabase;
  paths: DashboardPaths;
  executionManager: RunExecutionManager;
  stop: () => Promise<void>;
}

export function createDashboardServer(options: DashboardServerOptions = {}): DashboardServerInstance {
  const homeDir = options.homeDir || homedir();
  const paths = resolveDashboardPaths({
    homeDir,
    configDir: options.configDir,
    dataDir: options.dataDir,
    cacheDir: options.cacheDir,
  });
  ensureDashboardDirectories(paths);

  const dataDir = paths.dataDir;
  const db = new DashboardDatabase(dataDir);

  db.reconcileStaleRuns();
  db.pruneOldRuns(200);

  const executionManager = new RunExecutionManager(db, paths.runtimeScriptsDir);
  const reactiveEngine = new ReactiveGraphEngine(15000, paths);

  const unitEventWaiters = new Map<string, Set<(ev: UnitEvent) => void>>();
  const emitUnitEvent = (params: {
    unitId: string;
    eventType: "run_completed" | "decision_submitted";
    payload: Record<string, unknown>;
  }): UnitEvent => {
    const ev = db.insertUnitEvent(params);
    const waiters = unitEventWaiters.get(params.unitId);
    if (waiters) {
      for (const fn of [...waiters]) {
        try {
          fn(ev);
        } catch {}
      }
    }
    return ev;
  };

  const savedWorkspace = db.getSetting("active_workspace");
  let activeWorkspace =
    options.defaultWorkspace ||
    (savedWorkspace && existsSync(savedWorkspace) ? savedWorkspace : process.cwd());

  const lockfiles = options.lockfiles || [
    join(homeDir, ".agents/.skill-lock.json"),
    join(homeDir, "skills-lock.json"),
  ];

  const getAgentRoots = (wsOverride?: string): AgentMountRoot[] => {
    const targetWs = wsOverride || activeWorkspace;
    if (options.agentRoots) {
      return options.agentRoots.map((r) =>
        r.scope === "workspace"
          ? {
              ...r,
              path:
                r.agent === "claude-workspace"
                  ? join(targetWs, ".claude/skills")
                  : join(targetWs, ".agents/skills"),
            }
          : r
      );
    }
    return getDefaultAgentRoots(homeDir, targetWs);
  };

  let cachedDiscovery: {
    skills: CanonicalSkill[];
    brokenMounts: ReturnType<typeof discoverCanonicalSkills>["brokenMounts"];
    signature: string;
  } | null = null;

  const refreshSkills = () => {
    const config = loadDashboardConfig(paths);
    const discovered = discoverCanonicalSkills({
      agentRoots: getAgentRoots(),
      lockfiles,
      dataDir,
      overridesDir: paths.overridesDir,
      scratchpadsRoot: paths.scratchpadsRoot,
      managedFolders: config.managedFolders,
      watchRoots: config.watchRoots,
      activeWorkspace,
      homeDir,
      getSkillWorkspaceOverride: (skillId) => db.getSkillWorkspace(skillId),
      getSkillEnvOverride: (skillId) => db.getSkillEnv(skillId),
    });
    cachedDiscovery = {
      ...discovered,
      signature: computeSkillsSignature(discovered.skills, lockfiles, [
        paths.configFile,
        paths.scratchpadsRoot,
      ]),
    };
    return cachedDiscovery;
  };

  const getSkillsState = () => {
    if (!cachedDiscovery) return refreshSkills();
    // Issue 13: Lightweight mtime signature check so disk edits to SKILL.md, manifest.yaml, config.yaml, or scratchpads auto-invalidate cache
    const currentSig = computeSkillsSignature(cachedDiscovery.skills, lockfiles, [
      paths.configFile,
      paths.scratchpadsRoot,
    ]);
    if (currentSig !== cachedDiscovery.signature) {
      return refreshSkills();
    }
    return cachedDiscovery;
  };

  const jsonResponse = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });

  const distDir = resolve(import.meta.dir, "../dist");

  const server = Bun.serve<WsClientData>({
    port: options.port ?? 8765,
    hostname: options.hostname || "127.0.0.1",
    idleTimeout: 60,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // 1. WebSocket upgrade for /ws/runs/:runId
      if (pathname.startsWith("/ws/runs/")) {
        const runId = decodeURIComponent(pathname.slice("/ws/runs/".length));
        const offset = Number(url.searchParams.get("offset") || "0");
        const upgraded = srv.upgrade(req, {
          data: { runId, offset: Number.isFinite(offset) && offset >= 0 ? offset : 0 },
        });
        if (upgraded) return undefined;
        return jsonResponse({ error: "WebSocket upgrade failed" }, 400);
      }

      try {
        // 2. Health check
        if (pathname === "/api/health" && req.method === "GET") {
          return jsonResponse({
            status: "ok",
            app: "skill-dashboard",
            activeWorkspace,
          });
        }

        // 3. Bootstrap state
        if (pathname === "/api/bootstrap" && req.method === "GET") {
          const forceRefresh = url.searchParams.get("refresh") === "1";
          const { skills, brokenMounts } = forceRefresh ? refreshSkills() : getSkillsState();
          const recentWorkspaces =
            options.candidateWorkspaces || discoverCandidateWorkspaces(homeDir, activeWorkspace);
          const agentRoots = getAgentRoots();
          const config = loadDashboardConfig(paths);

          return jsonResponse({
            skills,
            brokenMounts,
            activeWorkspace,
            pythonExecutable: resolvePythonExecutable(activeWorkspace),
            recentWorkspaces,
            config,
            paths: {
              configDir: paths.configDir,
              configFile: paths.configFile,
              dataDir: paths.dataDir,
              cacheDir: paths.cacheDir,
              scratchpadsRoot: paths.scratchpadsRoot,
            },
            agentTargets: agentRoots.map((r) => ({
              agent: r.agent,
              label: r.label,
              path: r.path,
              scope: r.scope,
              canToggleMount: Boolean(r.canToggleMount),
              primaryToggle: r.primaryToggle ?? Boolean(r.canToggleMount),
              sharedViaAgentsHub: Boolean(r.sharedViaAgentsHub),
            })),
            runs: db.listRuns(undefined, 30),
          });
        }

        // 4. Switch Global or Per-Skill Active Workspace
        if (pathname === "/api/workspace" && req.method === "POST") {
          const body = (await req.json()) as {
            activeWorkspace?: string;
            skillId?: string;
            saveToManifest?: boolean;
          };
          const rawWs = body.activeWorkspace?.trim();
          const targetWs = rawWs ? expandHomePath(rawWs, homeDir) : "";
          if (!targetWs || !existsSync(targetWs) || !statSync(targetWs).isDirectory()) {
            return jsonResponse({ error: `Workspace directory does not exist: ${rawWs}` }, 400);
          }

          if (body.skillId) {
            db.setSkillWorkspace(body.skillId, targetWs);
            if (body.saveToManifest) {
              const { skills } = getSkillsState();
              const sk = skills.find((s) => s.id === body.skillId);
              if (sk) {
                saveSkillManifestLayer(sk.canonicalPath, dataDir, targetWs, sk.id, "companion", {
                  ...sk.manifest,
                  defaultWorkspace: targetWs,
                });
              }
            }
          } else {
            activeWorkspace = targetWs;
            db.setSetting("active_workspace", activeWorkspace);
          }

          const { skills, brokenMounts } = refreshSkills();
          const updatedSkill = body.skillId ? skills.find((s) => s.id === body.skillId) : undefined;
          const effectiveWs = updatedSkill?.effectiveWorkspace || activeWorkspace;

          return jsonResponse({
            activeWorkspace: effectiveWs,
            pythonExecutable: resolvePythonExecutable(effectiveWs),
            skills,
            brokenMounts,
          });
        }

        // 4b. Save Per-Skill Environment Variables: PUT /api/skills/:skillId/env
        const envMatch = pathname.match(/^\/api\/skills\/([^/]+)\/env$/);
        if (envMatch && req.method === "PUT") {
          const skillId = decodeURIComponent(envMatch[1]);
          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${skillId}` }, 404);

          const body = (await req.json()) as { env?: Record<string, string> };
          const cleanedEnv: Record<string, string> = {};
          for (const [k, v] of Object.entries(body.env || {})) {
            const key = k.trim();
            if (key) cleanedEnv[key] = String(v ?? "");
          }
          db.setSkillEnv(skill.id, cleanedEnv);
          const refreshed = refreshSkills();
          return jsonResponse({
            skill: refreshed.skills.find((s) => s.id === skill.id),
          });
        }

        // 5. Toggle Agent Mount
        if (pathname === "/api/mounts/toggle" && req.method === "POST") {
          const body = (await req.json()) as {
            skillId: string;
            agent: string;
            enabled: boolean;
          };
          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === body.skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${body.skillId}` }, 404);

          const root = getAgentRoots(skill.effectiveWorkspace).find((r) => r.agent === body.agent);
          if (!root) return jsonResponse({ error: `Agent target not found: ${body.agent}` }, 404);

          const result = toggleSkillMount({
            canonicalPath: skill.canonicalPath,
            skillId: skill.id,
            targetRoot: root,
            enabled: Boolean(body.enabled),
            homeDir,
          });
          const refreshed = refreshSkills();
          return jsonResponse({
            ...result,
            skill: refreshed.skills.find((s) => s.id === skill.id),
            brokenMounts: refreshed.brokenMounts,
          });
        }

        // 6. Repair or Remove Broken Mount
        if (pathname === "/api/mounts/repair" && req.method === "POST") {
          const body = (await req.json()) as {
            mountPath: string;
            action: "relink" | "remove";
            targetPath?: string;
            targetSkillId?: string;
          };
          const { skills, brokenMounts } = getSkillsState();
          const broken = brokenMounts.find((b) => b.mountPath === body.mountPath);
          if (!broken) {
            return jsonResponse({ error: `Broken mount not found: ${body.mountPath}` }, 404);
          }

          let targetPath = body.targetPath || broken.suggestedRepairPath;
          if (!targetPath && body.targetSkillId) {
            targetPath = skills.find((s) => s.id === body.targetSkillId)?.canonicalPath;
          }

          const res = repairBrokenMount({
            mountPath: body.mountPath,
            action: body.action,
            targetPath,
            homeDir,
          });
          const refreshed = refreshSkills();
          return jsonResponse({
            ...res,
            skills: refreshed.skills,
            brokenMounts: refreshed.brokenMounts,
          });
        }

        // 7. Skill FileTree & File Reader: /api/skills/:skillId/files
        const filesMatch = pathname.match(/^\/api\/skills\/([^/]+)\/files$/);
        if (filesMatch && req.method === "GET") {
          const skillId = decodeURIComponent(filesMatch[1]);
          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${skillId}` }, 404);

          const relPath = (url.searchParams.get("path") || "").replace(/^\/+|\/+$/g, "");
          const mode = url.searchParams.get("mode") || "list";
          const recursive = url.searchParams.get("recursive") === "1";

          if (mode === "read") {
            const fileData = readSkillFileSafe(skill.canonicalPath, relPath);
            return jsonResponse(fileData);
          } else {
            const nodes = listSkillDirectory(skill.canonicalPath, relPath, recursive);
            return jsonResponse({
              path: relPath,
              parentPath: computeParentPath(relPath),
              nodes,
            });
          }
        }

        // 8. Skill View Loader: /api/skills/:skillId/views
        const viewsMatch = pathname.match(/^\/api\/skills\/([^/]+)\/views$/);
        if (viewsMatch && req.method === "GET") {
          const skillId = decodeURIComponent(viewsMatch[1]);
          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${skillId}` }, 404);

          const viewId = url.searchParams.get("viewId");
          const directSource = url.searchParams.get("source");
          const view = viewId
            ? skill.manifest.views.find((v) => v.id === viewId)
            : undefined;

          const relSource = (directSource || view?.source || "SKILL.md").replace(/^\.\//, "");
          const candidateA = resolve(skill.canonicalPath, relSource);
          const candidateB = resolve(skill.canonicalPath, ".dashboard", relSource);
          const resolvedFile = existsSync(candidateA) ? candidateA : candidateB;

          if (!isPathInsideRoot(resolvedFile, skill.canonicalPath) || !existsSync(resolvedFile)) {
            return jsonResponse({ error: `View source not found: ${relSource}` }, 404);
          }

          const actualRel = relative(skill.canonicalPath, resolvedFile);
          const fileData = readSkillFileSafe(skill.canonicalPath, actualRel);
          const content =
            fileData.content && actualRel.endsWith(".md")
              ? rewriteMarkdownImagePaths(fileData.content, skill.id, actualRel)
              : fileData.content || "";

          return jsonResponse({
            skillId: skill.id,
            viewId: view?.id || actualRel,
            title: view?.title || basename(actualRel),
            type: view?.type || (actualRel.endsWith(".md") ? "markdown" : "file"),
            source: actualRel,
            content,
            isBinary: fileData.isBinary,
          });
        }

        // 9. Save / Materialize Manifest: PUT /api/skills/:skillId/manifest
        const manifestMatch = pathname.match(/^\/api\/skills\/([^/]+)\/manifest$/);
        if (manifestMatch && req.method === "PUT") {
          const skillId = decodeURIComponent(manifestMatch[1]);
          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${skillId}` }, 404);

          const body = (await req.json()) as {
            layer?: "companion" | "global" | "workspace";
            manifest: Record<string, any>;
          };
          const layer = body.layer || "companion";
          const savedPath = saveSkillManifestLayer(
            skill.canonicalPath,
            dataDir,
            skill.effectiveWorkspace,
            skill.id,
            layer,
            body.manifest,
            paths.overridesDir
          );
          const refreshed = refreshSkills();
          return jsonResponse({
            savedPath,
            layer,
            skill: refreshed.skills.find((s) => s.id === skill.id),
          });
        }

        // 9a. Per-Module Manifest File Read/Write: GET or PUT /api/skills/:skillId/manifest-module
        const modMatch = pathname.match(/^\/api\/skills\/([^/]+)\/manifest-module$/);
        if (modMatch && (req.method === "GET" || req.method === "PUT")) {
          const skillId = decodeURIComponent(modMatch[1]);
          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${skillId}` }, 404);

          const dashboardRoot = resolve(skill.canonicalPath, ".dashboard");

          if (req.method === "GET") {
            const relFile = (url.searchParams.get("file") || "manifest.yaml").replace(/^\/+/, "");
            const targetFile = resolve(dashboardRoot, relFile);
            if (!targetFile.startsWith(dashboardRoot)) {
              return jsonResponse({ error: "Path outside .dashboard/ is forbidden" }, 403);
            }
            const content = existsSync(targetFile)
              ? readFileSync(targetFile, "utf-8")
              : YAML.stringify(skill.manifest, { indent: 2 });
            return jsonResponse({
              file: relFile,
              content,
              moduleFiles: skill.layers.moduleFiles || ["manifest.yaml"],
              provenance: skill.layers.provenance,
            });
          }

          const body = (await req.json()) as { file?: string; content?: string };
          const relFile = (body.file || "manifest.yaml").replace(/^\/+/, "");
          const targetFile = resolve(dashboardRoot, relFile);
          if (!targetFile.startsWith(dashboardRoot)) {
            return jsonResponse({ error: "Path outside .dashboard/ is forbidden" }, 403);
          }
          try {
            if (relFile.endsWith(".json")) {
              JSON.parse(body.content || "{}");
            } else {
              YAML.parse(body.content || "");
            }
          } catch (err: any) {
            return jsonResponse({ error: `Invalid syntax in ${relFile}: ${err.message}` }, 400);
          }

          mkdirSync(dirname(targetFile), { recursive: true });
          writeFileSync(targetFile, body.content || "", "utf-8");
          reactiveEngine.invalidateSkill(skill.id);
          const refreshed = refreshSkills();
          return jsonResponse({
            savedPath: targetFile,
            file: relFile,
            skill: refreshed.skills.find((s) => s.id === skill.id),
          });
        }

        // 9b. Upstream Skill Update (Single Skill or Update All): POST /api/skills/:skillId/update or /api/skills/update-all
        if (pathname === "/api/skills/update-all" && req.method === "POST") {
          const { skills } = getSkillsState();
          const firstSkill = skills[0];
          const cmd = "npx -y skills update -g -y";
          const run = executionManager.startPtyRun({
            skillId: firstSkill?.id || "global",
            skillDir: firstSkill?.canonicalPath || activeWorkspace,
            actionId: "update-all-skills",
            actionTitle: "Update All Global Skills (npx skills)",
            command: cmd,
            maskedCommand: cmd,
            cwd: activeWorkspace,
            maskedParams: {},
            interactive: false,
          });
          return jsonResponse({ mode: "web_terminal", runId: run.id, run });
        }

        const updateMatch = pathname.match(/^\/api\/skills\/([^/]+)\/update$/);
        if (updateMatch && req.method === "POST") {
          const skillId = decodeURIComponent(updateMatch[1]);
          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${skillId}` }, 404);

          let body: { customCommand?: string } = {};
          try {
            body = (await req.json()) as any;
          } catch {
            // empty body ok
          }

          const guarded = buildGuardedSkillUpdateCommand({
            skill,
            customCommand: body.customCommand,
          });

          const run = executionManager.startPtyRun({
            skillId: skill.id,
            skillDir: skill.canonicalPath,
            actionId: "upstream-update",
            actionTitle: `Update ${skill.manifest.name}`,
            command: guarded.command,
            maskedCommand: guarded.maskedCommand,
            cwd: skill.canonicalPath,
            env: skill.configuredEnv,
            maskedParams: {},
            interactive: false,
          });
          return jsonResponse({
            mode: "web_terminal",
            runId: run.id,
            run,
            updateStrategy: skill.updateStrategy,
            guarded: Boolean(guarded.backupDir),
          });
        }

        // 9c. Agent-Driven Manifest Sync / Targeted Fix: GET or POST /api/skills/:skillId/agent-sync
        const agentSyncMatch = pathname.match(/^\/api\/skills\/([^/]+)\/agent-sync$/);
        if (agentSyncMatch && (req.method === "GET" || req.method === "POST")) {
          const skillId = decodeURIComponent(agentSyncMatch[1]);
          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${skillId}` }, 404);

          if (req.method === "GET") {
            const syncInfo = buildAgentManifestSyncPrompt(skill);
            return jsonResponse(syncInfo);
          }

          let body: {
            agentCli?: "claude" | "codex";
            userInstruction?: string;
            targets?: any[];
            targetLayer?: "auto" | "companion" | "global_override" | "workspace_override";
            previewOnly?: boolean;
          } = {};
          try {
            body = (await req.json()) as any;
          } catch {
            // empty body ok
          }

          const syncInfo = buildAgentManifestSyncPrompt(skill, body);
          if (body.previewOnly) {
            return jsonResponse(syncInfo);
          }

          const cli = body.agentCli || "claude";
          const cmd = cli === "codex" ? syncInfo.codexCommand : syncInfo.claudeCommand;

          const runCwd =
            syncInfo.resolvedTargetLayer === "workspace_override"
              ? skill.effectiveWorkspace || activeWorkspace
              : skill.canonicalPath;

          const run = executionManager.startPtyRun({
            skillId: skill.id,
            skillDir: skill.canonicalPath,
            actionId: `agent-sync-${cli}`,
            actionTitle: body.userInstruction?.trim()
              ? `Agent Fix (${cli}): ${body.userInstruction.trim().slice(0, 36)}`
              : `Agent Sync Manifest (${cli})`,
            command: cmd,
            maskedCommand: `${cli} [Fix/Sync ${syncInfo.resolvedTargetFile}]`,
            cwd: runCwd,
            env: skill.configuredEnv,
            maskedParams: {
              mode: syncInfo.mode,
              agentCli: cli,
              resolvedTargetFile: syncInfo.resolvedTargetFile,
              targetsCount: body.targets?.length || 0,
            },
            interactive: true,
          });

          return jsonResponse({
            ...syncInfo,
            syncMode: syncInfo.mode,
            mode: "web_terminal",
            runId: run.id,
            run,
          });
        }

        // 9d. Reactive Context State API: GET or PUT /api/skills/:skillId/context
        const ctxMatch = pathname.match(/^\/api\/skills\/([^/]+)\/context$/);
        if (ctxMatch && (req.method === "GET" || req.method === "PUT")) {
          const skillId = decodeURIComponent(ctxMatch[1]);
          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${skillId}` }, 404);

          if (req.method === "GET") {
            if (url.searchParams.get("invalidate") === "1") {
              reactiveEngine.invalidateSkill(skill.id);
            }
            return jsonResponse({
              context: reactiveEngine.getContextState(skill),
              fields: skill.manifest.context || [],
            });
          }

          const body = (await req.json()) as {
            key?: string;
            value?: string | boolean;
            values?: Record<string, string | boolean>;
          };

          let updated = reactiveEngine.getContextState(skill);
          if (body.key !== undefined && body.value !== undefined) {
            updated = reactiveEngine.setContextValue(skill, body.key, body.value);
          } else if (body.values) {
            for (const [k, v] of Object.entries(body.values)) {
              updated = reactiveEngine.setContextValue(skill, k, v);
            }
          }
          const snapshots = await reactiveEngine.evaluateAllSkillData({ skill, force: false });
          return jsonResponse({ context: updated, snapshots });
        }

        // 9e. Reactive Data Graph API: GET /api/skills/:skillId/data or /api/skills/:skillId/data/:nodeId
        const allDataMatch = pathname.match(/^\/api\/skills\/([^/]+)\/data$/);
        if (allDataMatch && req.method === "GET") {
          const skillId = decodeURIComponent(allDataMatch[1]);
          const force = url.searchParams.get("force") === "1";
          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${skillId}` }, 404);

          const snapshots = await reactiveEngine.evaluateAllSkillData({ skill, force });
          return jsonResponse({
            context: reactiveEngine.getContextState(skill),
            snapshots,
          });
        }

        const nodeDataMatch = pathname.match(/^\/api\/skills\/([^/]+)\/data\/([^/]+)$/);
        if (nodeDataMatch && req.method === "GET") {
          const skillId = decodeURIComponent(nodeDataMatch[1]);
          const nodeId = decodeURIComponent(nodeDataMatch[2]);
          const force = url.searchParams.get("force") === "1";

          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${skillId}` }, 404);

          const node = (skill.manifest.data || []).find((n) => n.id === nodeId);
          if (!node) return jsonResponse({ error: `Data node not found: ${nodeId}` }, 404);

          const snapshot = await reactiveEngine.evaluateNode({
            skill,
            nodeId,
            force,
          });
          return jsonResponse({
            ...snapshot,
            rowActions: node.rowActions || [],
            bulkActions: node.bulkActions || [],
            quickActions: node.quickActions || [],
            cellAction: node.cellAction,
          });
        }

        // 9f. Custom HTML App View & Relative Asset Route: GET /skill-app/:skillId/*
        const skillAppMatch = pathname.match(/^\/skill-app\/([^/]+)\/(.+)$/);
        if (skillAppMatch && req.method === "GET") {
          const skillId = decodeURIComponent(skillAppMatch[1]);
          const rawRel = decodeURIComponent(skillAppMatch[2]).replace(/^\/+/, "");
          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${skillId}` }, 404);

          const candidateA = resolve(skill.canonicalPath, rawRel);
          const candidateB = resolve(skill.canonicalPath, ".dashboard", rawRel);
          const candidateWs = resolve(skill.effectiveWorkspace, rawRel);

          let targetFile = "";
          if (existsSync(candidateA) && isPathInsideRoot(candidateA, skill.canonicalPath)) {
            targetFile = candidateA;
          } else if (
            existsSync(candidateB) &&
            isPathInsideRoot(candidateB, skill.canonicalPath)
          ) {
            targetFile = candidateB;
          } else if (
            existsSync(candidateWs) &&
            isPathInsideRoot(candidateWs, skill.effectiveWorkspace)
          ) {
            targetFile = candidateWs;
          }

          if (!targetFile || !existsSync(targetFile) || !statSync(targetFile).isFile()) {
            return jsonResponse({ error: `App asset not found: ${rawRel}` }, 404);
          }

          const ext = extname(targetFile).toLowerCase();
          if (ext === ".html" || ext === ".htm") {
            const rawHtml = readFileSync(targetFile, "utf-8");
            const relDir = dirname(rawRel);
            const baseHref = `/skill-app/${encodeURIComponent(skill.id)}/${relDir === "." ? "" : relDir + "/"}`;
            const injected = injectSkillDashboardBridge(rawHtml, baseHref);
            return new Response(injected, {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
              },
            });
          }

          return new Response(Bun.file(targetFile), {
            headers: {
              "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream",
              "Cache-Control": "no-cache",
            },
          });
        }

        // 10. Live Command Preview: POST /api/preview-command
        if (pathname === "/api/preview-command" && req.method === "POST") {
          const body = (await req.json()) as {
            skillId: string;
            actionId?: string;
            adHocCommand?: string;
            formValues?: Record<string, unknown>;
          };
          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === body.skillId);
          if (!skill) return jsonResponse({ error: `Skill not found: ${body.skillId}` }, 404);

          let action = body.actionId
            ? skill.manifest.actionGroups
                .flatMap((g) => [
                  ...(g.actions || []),
                  ...(g.subgroups ? g.subgroups.flatMap((sg) => sg.actions) : []),
                ])
                .find((a) => a.id === body.actionId)
            : undefined;

          if (!action && body.adHocCommand) {
            const inferred = inferFormAndTemplateFromSynopsis(body.adHocCommand);
            action = {
              id: "adhoc-runbook",
              title: "Runbook Command",
              danger: inferred.danger,
              requiresHumanApprovalFlag: inferred.requiresHumanApprovalFlag,
              interactive: inferred.interactive,
              defaultRunner: "web_terminal",
              cwd: "project_root",
              command: inferred.commandTemplate,
              form: inferred.form.length > 0 ? inferred.form : undefined,
            };
          }

          if (!action) return jsonResponse({ error: `Action not found: ${body.actionId}` }, 404);

          const rawTmpl = action.script || action.command || "";
          const implicitDeps = extractImplicitDependencies(rawTmpl);
          const currentSnaps = reactiveEngine.getSkillSnapshots(skill.id);
          for (const depId of implicitDeps.dataNodeIds) {
            if (!currentSnaps[depId] && (skill.manifest.data || []).some((n) => n.id === depId)) {
              await reactiveEngine.evaluateNode({ skill, nodeId: depId, force: false });
            }
          }

          const sandbox = ensureUnitSandboxPaths(paths, skill.id);
          const preview = interpolateActionCommand({
            action,
            skillDir: skill.canonicalPath,
            activeWorkspace: skill.effectiveWorkspace,
            dataDir: sandbox.unitDataDir,
            cacheDir: sandbox.unitCacheDir,
            artifactsDir: sandbox.latestArtifactsLink,
            formValues: body.formValues || {},
            contextValues: reactiveEngine.getContextState(skill),
            dataSnapshots: reactiveEngine.getSkillSnapshots(skill.id),
            previewOnly: true,
          });
          return jsonResponse({
            maskedCommand: preview.maskedCommand,
            cwd: preview.cwd,
            inferredForm: action.form || [],
            danger: action.danger,
            requiresHumanApprovalFlag: action.requiresHumanApprovalFlag,
          });
        }

        // 11. Local File / Directory Autocomplete: GET /api/fs/complete
        if (pathname === "/api/fs/complete" && req.method === "GET") {
          const rawPrefix = url.searchParams.get("prefix") || "";
          const filterType = url.searchParams.get("type") || "all";
          const skillId = url.searchParams.get("skillId");
          const { skills } = getSkillsState();
          const skill = skillId ? skills.find((s) => s.id === skillId) : undefined;
          const baseWorkspace = skill?.effectiveWorkspace || activeWorkspace;

          const expandedPrefix = rawPrefix.startsWith("~")
            ? join(homeDir, rawPrefix.slice(1))
            : isAbsolute(rawPrefix)
              ? rawPrefix
              : join(baseWorkspace, rawPrefix);

          let searchDir = expandedPrefix;
          let nameFilter = "";
          if (!existsSync(expandedPrefix) || !statSync(expandedPrefix).isDirectory()) {
            searchDir = dirname(expandedPrefix);
            nameFilter = basename(expandedPrefix).toLowerCase();
          }

          if (!existsSync(searchDir) || !statSync(searchDir).isDirectory()) {
            return jsonResponse({ suggestions: [] });
          }

          const allowedCompleteRoots = [
            baseWorkspace,
            activeWorkspace,
            homeDir,
            ...skills.map((s) => s.canonicalPath),
            ...skills.map((s) => s.effectiveWorkspace),
          ];
          if (!allowedCompleteRoots.some((root) => isPathInsideRoot(searchDir, root))) {
            return jsonResponse({ suggestions: [] });
          }

          const entries = readdirSync(searchDir);
          const suggestions: Array<{ path: string; displayPath: string; type: "file" | "directory" }> = [];
          for (const entry of entries) {
            if (entry.startsWith(".") && !nameFilter.startsWith(".")) continue;
            if (nameFilter && !entry.toLowerCase().startsWith(nameFilter)) continue;
            const full = join(searchDir, entry);
            let st;
            try {
              st = statSync(full);
            } catch {
              continue;
            }
            const isDir = st.isDirectory();
            if (filterType === "directory" && !isDir) continue;
            const relToWs = relative(baseWorkspace, full);
            const displayPath =
              !relToWs.startsWith("..") && !isAbsolute(relToWs) && !rawPrefix.startsWith("/")
                ? relToWs || "."
                : full;
            suggestions.push({
              path: displayPath + (isDir && displayPath !== "." ? "/" : ""),
              displayPath: entry + (isDir ? "/" : ""),
              type: isDir ? "directory" : "file",
            });
            if (suggestions.length >= 25) break;
          }
          return jsonResponse({ suggestions });
        }

        // 12. Execute Action Run or Interactive Shell: POST /api/runs
        if (pathname === "/api/runs" && req.method === "POST") {
          const body = (await req.json()) as {
            skillId: string;
            actionId?: string;
            adHocCommand?: string;
            adHocTitle?: string;
            interactiveShell?: boolean;
            keepShellOpen?: boolean;
            formValues?: Record<string, unknown>;
            runner?: "web_terminal" | "external_terminal";
            terminalApp?: "Terminal" | "iTerm";
            humanApproved?: boolean;
            cols?: number;
            rows?: number;
          };

          const { skills } = getSkillsState();
          const skill = skills.find((s) => s.id === body.skillId) || skills[0];
          if (!skill) return jsonResponse({ error: `Skill not found: ${body.skillId}` }, 404);

          // Direct Interactive Shell Session (Issue 08)
          if (body.interactiveShell) {
            const run = executionManager.startPtyRun({
              skillId: skill.id,
              skillDir: skill.canonicalPath,
              actionId: "interactive-shell",
              actionTitle: `Interactive Shell (${basename(skill.effectiveWorkspace)})`,
              command: "/bin/zsh -i",
              maskedCommand: `zsh -i (venv & SKILL_DIR ready)`,
              cwd: skill.effectiveWorkspace,
              env: skill.configuredEnv,
              maskedParams: {},
              interactive: true,
              isInteractiveShell: true,
              cols: body.cols,
              rows: body.rows,
            });
            return jsonResponse({
              mode: "web_terminal",
              runId: run.id,
              run,
            });
          }

          let action = body.actionId
            ? skill.manifest.actionGroups
                .flatMap((g) => [
                  ...(g.actions || []),
                  ...(g.subgroups ? g.subgroups.flatMap((sg) => sg.actions) : []),
                ])
                .find((a) => a.id === body.actionId)
            : undefined;

          if (!action && body.adHocCommand) {
            const inferred = inferFormAndTemplateFromSynopsis(body.adHocCommand);
            action = {
              id: "adhoc-runbook",
              title: body.adHocTitle || "Runbook Command",
              danger: "safe",
              interactive: inferred.interactive,
              defaultRunner: "web_terminal",
              cwd: "project_root",
              command: inferred.commandTemplate,
              form: inferred.form.length > 0 ? inferred.form : undefined,
            };
          }

          if (!action) {
            return jsonResponse({ error: `Action not found: ${body.actionId}` }, 404);
          }

          const rawTmpl = action.script || action.command || "";
          const implicitDeps = extractImplicitDependencies(rawTmpl);
          const currentSnaps = reactiveEngine.getSkillSnapshots(skill.id);
          for (const depId of implicitDeps.dataNodeIds) {
            if (!currentSnaps[depId] && (skill.manifest.data || []).some((n) => n.id === depId)) {
              await reactiveEngine.evaluateNode({ skill, nodeId: depId, force: false });
            }
          }

          const preRunId = executionManager.allocateRunId();
          const sandbox = ensureUnitSandboxPaths(paths, skill.id, preRunId);
          const ctxState = reactiveEngine.getContextState(skill);
          const snapState = reactiveEngine.getSkillSnapshots(skill.id);

          let interpolated;
          try {
            interpolated = interpolateActionCommand({
              action,
              skillDir: skill.canonicalPath,
              activeWorkspace: skill.effectiveWorkspace,
              dataDir: sandbox.unitDataDir,
              cacheDir: sandbox.unitCacheDir,
              artifactsDir: sandbox.runArtifactsDir,
              formValues: body.formValues || {},
              contextValues: ctxState,
              dataSnapshots: snapState,
              humanApproved: Boolean(body.humanApproved),
              previewOnly: false,
            });
          } catch (validationErr: any) {
            return jsonResponse({ error: validationErr.message }, 400);
          }

          const mergedEnv = {
            SD_DATA_DIR: sandbox.unitDataDir,
            SD_CACHE_DIR: sandbox.unitCacheDir,
            SD_ARTIFACTS_DIR: sandbox.runArtifactsDir,
            ...skill.configuredEnv,
            ...interpolated.env,
          };

          const runner = body.runner || action.defaultRunner || "web_terminal";
          if (runner === "external_terminal") {
            const extRes = await launchExternalMacTerminal({
              command: interpolated.command,
              cwd: interpolated.cwd,
              terminalApp: body.terminalApp || "Terminal",
            });
            return jsonResponse({
              mode: "external_terminal",
              launched: extRes.launched,
              appleScript: extRes.appleScript,
              maskedCommand: interpolated.maskedCommand,
              cwd: interpolated.cwd,
            });
          }

          const interpolateArtifactPath = (tpl: string): string => {
            const formVals = body.formValues || {};
            return tpl
              .replace(/\{\{\s*skill_dir\s*\}\}/g, skill.canonicalPath)
              .replace(/\{\{\s*project_root\s*\}\}/g, skill.effectiveWorkspace)
              .replace(/\{\{\s*data_dir\s*\}\}/g, sandbox.unitDataDir)
              .replace(/\{\{\s*cache_dir\s*\}\}/g, sandbox.unitCacheDir)
              .replace(/\{\{\s*artifacts_dir\s*\}\}/g, sandbox.runArtifactsDir)
              .replace(/\{\{\s*context\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, k) =>
                ctxState[k] !== undefined ? String(ctxState[k]) : ""
              )
              .replace(/\{\{\s*form\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, k) => {
                if (formVals[k] !== undefined && formVals[k] !== "") return String(formVals[k]);
                const fDef = (action?.form || []).find((f) => f.key === k)?.default;
                if (fDef !== undefined && fDef !== null) {
                  return String(fDef)
                    .replace(/\{\{\s*skill_dir\s*\}\}/g, skill.canonicalPath)
                    .replace(/\{\{\s*project_root\s*\}\}/g, skill.effectiveWorkspace)
                    .replace(/\{\{\s*data_dir\s*\}\}/g, sandbox.unitDataDir)
                    .replace(/\{\{\s*cache_dir\s*\}\}/g, sandbox.unitCacheDir)
                    .replace(/\{\{\s*artifacts_dir\s*\}\}/g, sandbox.runArtifactsDir);
                }
                return "";
              });
          };

          const capturedAction = action;
          const run = executionManager.startPtyRun({
            runId: preRunId,
            skillId: skill.id,
            skillDir: skill.canonicalPath,
            actionId: action.id,
            actionTitle: action.title,
            command: interpolated.command,
            maskedCommand: interpolated.maskedCommand,
            cwd: interpolated.cwd,
            env: mergedEnv,
            maskedParams: interpolated.maskedParams,
            interactive: action.interactive,
            keepShellOpen: Boolean(body.keepShellOpen && !action.interactive),
            artifactRules: action.artifacts,
            runArtifactsDir: sandbox.runArtifactsDir,
            interpolateArtifactPath,
            cols: body.cols,
            rows: body.rows,
            onCompleted: ({ run: completedRun, rawStdout, artifactItems }) => {
              updateLatestArtifactsSymlink(paths, skill.id, completedRun.id);
              emitUnitEvent({
                unitId: skill.id,
                eventType: "run_completed",
                payload: {
                  runId: completedRun.id,
                  actionId: capturedAction.id,
                  actionTitle: capturedAction.title,
                  status: completedRun.status,
                  exitCode: completedRun.exitCode,
                  durationMs: completedRun.durationMs,
                  artifacts: artifactItems,
                  stdoutTail: rawStdout.slice(-2000),
                },
              });
              reactiveEngine.onActionCompleted({
                skill,
                actionId: capturedAction.id,
                outputConfig: capturedAction.output,
                rawStdout,
              });
            },
          });

          return jsonResponse({
            mode: "web_terminal",
            runId: run.id,
            run,
          });
        }

        // 13. List Runs: GET /api/runs
        if (pathname === "/api/runs" && req.method === "GET") {
          const skillId = url.searchParams.get("skillId") || undefined;
          const limit = Number(url.searchParams.get("limit") || "40");
          return jsonResponse({
            runs: db.listRuns(skillId, limit),
          });
        }

        // 14. Stop Run: POST /api/runs/:runId/stop
        const stopMatch = pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
        if (stopMatch && req.method === "POST") {
          const runId = decodeURIComponent(stopMatch[1]);
          const res = await executionManager.stopRun(runId);
          return jsonResponse(res);
        }

        // 14b. Close / Delete Run Session: DELETE /api/runs/:runId
        const deleteRunMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
        if (deleteRunMatch && req.method === "DELETE") {
          const runId = decodeURIComponent(deleteRunMatch[1]);
          await executionManager.stopRun(runId);
          db.deleteRun(runId);
          return jsonResponse({ deleted: true, runId });
        }

        // 14c. Whitelisted Run Artifact Gateway: GET /api/runs/:runId/artifacts/:index
        const runArtifactMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/(\d+)$/);
        if (runArtifactMatch && req.method === "GET") {
          const runId = decodeURIComponent(runArtifactMatch[1]);
          const idx = Number(runArtifactMatch[2]);
          const run = db.getRun(runId);
          if (!run) return jsonResponse({ error: `Run not found: ${runId}` }, 404);
          const item = (run.artifactItems || [])[idx];
          if (!item || !item.path || !existsSync(item.path) || !statSync(item.path).isFile()) {
            return jsonResponse({ error: "Artifact file not found" }, 404);
          }

          const download = url.searchParams.get("download") === "1";
          const ext = extname(item.path).toLowerCase();
          const mime = MIME_BY_EXT[ext] || "application/octet-stream";
          const headers: Record<string, string> = {
            "Content-Type": mime,
            "Cache-Control": "no-store",
          };
          if (download) {
            headers["Content-Disposition"] = `attachment; filename="${item.filename.replace(/"/g, "")}"`;
          }
          return new Response(Bun.file(item.path), { headers });
        }

        // 14d. XDG Config API: GET or PUT /api/config
        if (pathname === "/api/config" && (req.method === "GET" || req.method === "PUT")) {
          if (req.method === "GET") {
            return jsonResponse({
              config: loadDashboardConfig(paths),
              paths,
            });
          }
          const body = (await req.json()) as Partial<{
            unconfiguredFolderAction: UnconfiguredFolderAction;
            scratchpadTtlDays: number;
            watchRoots: string[];
          }>;
          const current = loadDashboardConfig(paths);
          if (body.unconfiguredFolderAction) {
            current.preferences.unconfiguredFolderAction = body.unconfiguredFolderAction;
          }
          if (typeof body.scratchpadTtlDays === "number") {
            current.preferences.scratchpadTtlDays = body.scratchpadTtlDays;
          }
          if (Array.isArray(body.watchRoots)) {
            current.watchRoots = body.watchRoots;
          }
          saveDashboardConfig(paths, current);
          const refreshed = refreshSkills();
          return jsonResponse({
            config: current,
            skills: refreshed.skills,
          });
        }

        // 14e. Managed Folders API: POST or DELETE /api/folders
        if (pathname === "/api/folders" && (req.method === "POST" || req.method === "DELETE")) {
          const body = (await req.json()) as {
            path?: string;
            label?: string;
            initSkeleton?: boolean;
            unconfiguredFolderAction?: UnconfiguredFolderAction;
          };
          const rawPath = (body.path || "").trim();
          const expanded = rawPath ? expandHomePath(rawPath, homeDir) : "";
          if (!expanded) return jsonResponse({ error: "Folder path is required" }, 400);

          const cfg = loadDashboardConfig(paths);

          if (req.method === "DELETE") {
            const normTarget = existsSync(expanded) ? resolve(expanded) : expanded;
            cfg.managedFolders = cfg.managedFolders.filter((f) => {
              const exp = expandHomePath(f.path, homeDir);
              return exp !== expanded && resolve(exp) !== normTarget && f.path !== rawPath;
            });
            saveDashboardConfig(paths, cfg);
            const refreshed = refreshSkills();
            return jsonResponse({
              removed: true,
              config: cfg,
              skills: refreshed.skills,
            });
          }

          if (!existsSync(expanded) || !statSync(expanded).isDirectory()) {
            return jsonResponse({ error: `Directory does not exist: ${rawPath}` }, 400);
          }

          if (body.unconfiguredFolderAction) {
            cfg.preferences.unconfiguredFolderAction = body.unconfiguredFolderAction;
          }

          const resolvedDir = realpathSync(expanded);
          if (!cfg.managedFolders.some((f) => resolve(expandHomePath(f.path, homeDir)) === resolvedDir)) {
            cfg.managedFolders.push({
              path: resolvedDir,
              label: body.label,
              addedAt: new Date().toISOString(),
            });
          }
          saveDashboardConfig(paths, cfg);

          if (body.initSkeleton || cfg.preferences.unconfiguredFolderAction === "skeleton") {
            initManifestInDirectory(resolvedDir);
          }

          const hasManifest =
            existsSync(join(resolvedDir, ".dashboard/manifest.yaml")) ||
            existsSync(join(resolvedDir, ".dashboard/manifest.json"));

          const refreshed = refreshSkills();
          const unit = refreshed.skills.find((s) => s.canonicalPath === resolvedDir);

          return jsonResponse({
            unit,
            hasManifest,
            unconfiguredFolderAction: cfg.preferences.unconfiguredFolderAction,
            config: cfg,
            skills: refreshed.skills,
          });
        }

        // 14f. Agent Scratchpads API: POST /api/scratchpads, POST /api/scratchpads/:id/promote, DELETE /api/scratchpads/:id
        if (pathname === "/api/scratchpads" && req.method === "POST") {
          const body = (await req.json()) as {
            id?: string;
            title?: string;
            description?: string;
            projectRoot?: string;
            manifestYaml?: string;
            manifest?: Record<string, unknown>;
          };
          const projectRoot = body.projectRoot
            ? expandHomePath(body.projectRoot, homeDir)
            : activeWorkspace;
          const projectSlug = deriveProjectSlug(projectRoot);
          const slug = sanitizeUnitSegment(
            body.id || `pad-${Date.now().toString(36)}`
          );
          const padDir = join(paths.scratchpadsRoot, projectSlug, slug);
          const dashDir = join(padDir, ".dashboard");
          mkdirSync(dashDir, { recursive: true });

          writeFileSync(
            join(padDir, "meta.json"),
            JSON.stringify(
              {
                id: slug,
                title: body.title || slug,
                projectRoot,
                projectSlug,
                createdAt: new Date().toISOString(),
              },
              null,
              2
            ),
            "utf-8"
          );

          const manifestPath = join(dashDir, "manifest.yaml");
          if (body.manifestYaml) {
            writeFileSync(manifestPath, body.manifestYaml, "utf-8");
          } else if (body.manifest) {
            writeFileSync(
              manifestPath,
              YAML.stringify(
                {
                  id: slug,
                  name: body.title || slug,
                  defaultWorkspace: projectRoot,
                  ...body.manifest,
                },
                { lineWidth: 100 }
              ),
              "utf-8"
            );
          } else if (!existsSync(manifestPath)) {
            const defaultManifest = {
              id: slug,
              name: body.title || `Scratchpad: ${slug}`,
              category: "Agent & Automation",
              description:
                body.description ||
                `Ephemeral interactive Agent console bound to ${basename(projectRoot)}`,
              defaultWorkspace: projectRoot,
              tsPrelude: true,
              data: [],
              actionGroups: [],
            };
            writeFileSync(manifestPath, YAML.stringify(defaultManifest, { lineWidth: 100 }), "utf-8");
          }

          const refreshed = refreshSkills();
          const realPadDir = existsSync(padDir) ? realpathSync(padDir) : padDir;
          const unit =
            refreshed.skills.find((s) => s.canonicalPath === realPadDir) ||
            refreshed.skills.find((s) => s.id === slug);
          const unitId = unit?.id || slug;
          return jsonResponse({
            unit,
            unitId,
            padDir,
            projectSlug,
            deepLink: `http://127.0.0.1:${srv.port}/?id=${encodeURIComponent(unitId)}`,
            skills: refreshed.skills,
          });
        }

        const promoteMatch = pathname.match(/^\/api\/scratchpads\/([^/]+)\/promote$/);
        if (promoteMatch && req.method === "POST") {
          const padUnitId = decodeURIComponent(promoteMatch[1]);
          const { skills } = getSkillsState();
          const padUnit = skills.find((s) => s.id === padUnitId);
          if (!padUnit) {
            return jsonResponse({ error: `Scratchpad not found: ${padUnitId}` }, 404);
          }

          const body = (await req.json()) as {
            target?: "project" | "skill";
            newId?: string;
            targetDir?: string;
          };
          const targetMode = body.target || "project";
          const srcDashDir = join(padUnit.canonicalPath, ".dashboard");

          let destRoot = "";
          let promotedId = "";

          if (targetMode === "project") {
            destRoot = body.targetDir
              ? expandHomePath(body.targetDir, homeDir)
              : padUnit.effectiveWorkspace;
            promotedId = body.newId || basename(destRoot);
            const destDashDir = join(destRoot, ".dashboard");
            mkdirSync(destDashDir, { recursive: true });
            if (existsSync(srcDashDir)) {
              cpSync(srcDashDir, destDashDir, { recursive: true });
            }
            const destManifestPath = join(destDashDir, "manifest.yaml");
            if (existsSync(destManifestPath)) {
              try {
                const parsed = YAML.parse(readFileSync(destManifestPath, "utf-8")) || {};
                parsed.id = promotedId;
                writeFileSync(destManifestPath, YAML.stringify(parsed, { lineWidth: 100 }), "utf-8");
              } catch {}
            }
            const cfg = loadDashboardConfig(paths);
            if (!cfg.managedFolders.some((f) => resolve(expandHomePath(f.path, homeDir)) === resolve(destRoot))) {
              cfg.managedFolders.push({
                path: resolve(destRoot),
                label: padUnit.manifest.name,
                addedAt: new Date().toISOString(),
              });
              saveDashboardConfig(paths, cfg);
            }
          } else {
            promotedId = sanitizeUnitSegment(body.newId || padUnit.id.replace(/^pad-[^-]+-/, ""));
            const agentsHub =
              getAgentRoots().find((r) => r.agent === "agents-hub")?.path ||
              join(homeDir, ".agents/skills");
            destRoot = join(agentsHub, promotedId);
            mkdirSync(destRoot, { recursive: true });
            if (existsSync(srcDashDir)) {
              cpSync(srcDashDir, join(destRoot, ".dashboard"), { recursive: true });
            }
            const skillMdPath = join(destRoot, "SKILL.md");
            if (!existsSync(skillMdPath)) {
              writeFileSync(
                skillMdPath,
                `---\nname: ${promotedId}\ndescription: ${padUnit.manifest.description || padUnit.manifest.name}\n---\n\n# ${padUnit.manifest.name}\n\nPromoted from Agent Scratchpad.\n`,
                "utf-8"
              );
            }
          }

          // Migrate {{data_dir}} state if present
          const oldSandbox = ensureUnitSandboxPaths(paths, padUnit.id);
          const newSandbox = ensureUnitSandboxPaths(paths, promotedId);
          if (oldSandbox.unitDataDir !== newSandbox.unitDataDir && existsSync(oldSandbox.unitDataDir)) {
            try {
              cpSync(oldSandbox.unitDataDir, newSandbox.unitDataDir, { recursive: true });
            } catch {}
          }

          // Remove temporary scratchpad directory if inside scratchpadsRoot
          if (isPathInsideRoot(padUnit.canonicalPath, paths.scratchpadsRoot)) {
            try {
              rmSync(padUnit.canonicalPath, { recursive: true, force: true });
            } catch {}
          }

          const refreshed = refreshSkills();
          const realDestRoot = existsSync(destRoot) ? realpathSync(destRoot) : resolve(destRoot);
          const promotedUnit =
            refreshed.skills.find((s) => s.canonicalPath === realDestRoot) ||
            refreshed.skills.find((s) => s.id === promotedId);

          return jsonResponse({
            promoted: true,
            target: targetMode,
            destRoot,
            unit: promotedUnit,
            skills: refreshed.skills,
          });
        }

        const deletePadMatch = pathname.match(/^\/api\/scratchpads\/([^/]+)$/);
        if (deletePadMatch && req.method === "DELETE") {
          const padUnitId = decodeURIComponent(deletePadMatch[1]);
          const { skills } = getSkillsState();
          const padUnit = skills.find((s) => s.id === padUnitId);
          if (!padUnit) return jsonResponse({ error: `Scratchpad not found: ${padUnitId}` }, 404);
          if (isPathInsideRoot(padUnit.canonicalPath, paths.scratchpadsRoot)) {
            rmSync(padUnit.canonicalPath, { recursive: true, force: true });
          }
          const refreshed = refreshSkills();
          return jsonResponse({
            deleted: true,
            unitId: padUnitId,
            skills: refreshed.skills,
          });
        }

        // 14g. HITL Unit Events & Synchronous Wait API: GET/POST /api/units/:id/events and POST /api/skills/:id/decision
        const decisionAliasMatch = pathname.match(/^\/api\/skills\/([^/]+)\/decision$/);
        if (decisionAliasMatch && req.method === "POST") {
          const unitId = decodeURIComponent(decisionAliasMatch[1]);
          const body = (await req.json()) as Record<string, unknown>;
          const ev = emitUnitEvent({
            unitId,
            eventType: "decision_submitted",
            payload: (body?.payload as Record<string, unknown>) || body || {},
          });
          return jsonResponse({ event: ev });
        }

        const unitEventsMatch = pathname.match(/^\/api\/units\/([^/]+)\/events$/);
        if (unitEventsMatch && (req.method === "GET" || req.method === "POST")) {
          const unitId = decodeURIComponent(unitEventsMatch[1]);
          if (req.method === "POST") {
            const body = (await req.json()) as {
              eventType?: "decision_submitted" | "run_completed";
              payload?: Record<string, unknown>;
            };
            const ev = emitUnitEvent({
              unitId,
              eventType: body.eventType || "decision_submitted",
              payload: body.payload || {},
            });
            return jsonResponse({ event: ev });
          }

          const sinceId = url.searchParams.get("sinceId")
            ? Number(url.searchParams.get("sinceId"))
            : undefined;
          const sinceTs = url.searchParams.get("sinceTs")
            ? Number(url.searchParams.get("sinceTs"))
            : undefined;
          const waitMs = Math.min(Number(url.searchParams.get("waitMs") || "0"), 120000);

          const existing = db.listUnitEvents({ unitId, sinceId, sinceTs, limit: 20 });
          if (existing.length > 0 || waitMs <= 0) {
            return jsonResponse({ events: existing });
          }

          const nextEvent = await new Promise<UnitEvent | null>((resolveWait) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const onEv = (ev: UnitEvent) => {
              if (timer) clearTimeout(timer);
              unitEventWaiters.get(unitId)?.delete(onEv);
              resolveWait(ev);
            };
            let set = unitEventWaiters.get(unitId);
            if (!set) {
              set = new Set();
              unitEventWaiters.set(unitId, set);
            }
            set.add(onEv);
            timer = setTimeout(() => {
              unitEventWaiters.get(unitId)?.delete(onEv);
              resolveWait(null);
            }, waitMs);
          });

          return jsonResponse({
            events: nextEvent ? [nextEvent] : [],
            timedOut: !nextEvent,
          });
        }

        // 15. Whitelisted Asset & Artifact Proxy: GET /api/assets
        if (pathname === "/api/assets" && req.method === "GET") {
          const skillId = url.searchParams.get("skill");
          const rawPath = url.searchParams.get("path") || "";

          if (!rawPath) {
            return jsonResponse({ error: "Missing asset path" }, 400);
          }

          const decodedPath = decodeURIComponent(rawPath);
          const { skills } = getSkillsState();

          let targetFile = "";
          let allowed = false;

          if (skillId) {
            const skill = skills.find((s) => s.id === skillId);
            if (!skill) return jsonResponse({ error: `Skill not found: ${skillId}` }, 404);

            const candidateA = resolve(skill.canonicalPath, decodedPath.replace(/^\/+/, ""));
            const candidateB = resolve(
              skill.canonicalPath,
              ".dashboard",
              decodedPath.replace(/^\/+/, "")
            );
            if (existsSync(candidateA) && isPathInsideRoot(candidateA, skill.canonicalPath)) {
              targetFile = candidateA;
              allowed = true;
            } else if (
              existsSync(candidateB) &&
              isPathInsideRoot(candidateB, skill.canonicalPath)
            ) {
              targetFile = candidateB;
              allowed = true;
            }
          } else {
            const candidate = isAbsolute(decodedPath)
              ? resolve(decodedPath)
              : resolve(activeWorkspace, decodedPath);

            const allowedRoots = [
              activeWorkspace,
              dataDir,
              ...skills.map((s) => s.canonicalPath),
              ...skills.map((s) => s.effectiveWorkspace),
            ];
            for (const root of allowedRoots) {
              if (existsSync(candidate) && isPathInsideRoot(candidate, root)) {
                targetFile = candidate;
                allowed = true;
                break;
              }
            }
          }

          if (!allowed || !targetFile || !existsSync(targetFile) || !statSync(targetFile).isFile()) {
            return jsonResponse({ error: "Forbidden: Asset outside allowed skill roots" }, 403);
          }

          const ext = extname(targetFile).toLowerCase();
          return new Response(Bun.file(targetFile), {
            headers: {
              "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream",
              "Cache-Control": "public, max-age=60",
            },
          });
        }

        // 16. Static Frontend UI assets
        if (pathname === "/" || pathname === "/index.html") {
          const indexPath = join(distDir, "index.html");
          if (existsSync(indexPath)) {
            return new Response(Bun.file(indexPath), {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          return new Response("Skill Dashboard UI not built yet.", { status: 503 });
        }

        const staticCandidate = resolve(distDir, pathname.replace(/^\/+/, ""));
        if (
          existsSync(distDir) &&
          existsSync(staticCandidate) &&
          isPathInsideRoot(staticCandidate, distDir) &&
          statSync(staticCandidate).isFile()
        ) {
          const ext = extname(staticCandidate).toLowerCase();
          return new Response(Bun.file(staticCandidate), {
            headers: {
              "Content-Type": MIME_BY_EXT[ext] || "application/octet-stream",
            },
          });
        }

        return jsonResponse({ error: `Not found: ${pathname}` }, 404);
      } catch (err: any) {
        return jsonResponse(
          { error: err?.message || "Internal server error" },
          err?.message?.includes("Forbidden") || err?.message?.includes("traversal") ? 403 : 500
        );
      }
    },
    websocket: {
      open(ws) {
        executionManager.attachClient(ws);
      },
      message(ws, message) {
        executionManager.handleClientMessage(
          ws,
          typeof message === "string" ? message : new TextDecoder().decode(message)
        );
      },
      close(ws) {
        executionManager.detachClient(ws);
      },
    },
  });

  const actualPort = server.port ?? (options.port || 8765);
  return {
    server,
    port: actualPort,
    url: `http://${options.hostname || "127.0.0.1"}:${actualPort}`,
    db,
    paths,
    executionManager,
    async stop() {
      reactiveEngine.closeAllWatchers();
      await executionManager.stopAllActiveRuns();
      server.stop(true);
      db.close();
    },
  };
}
