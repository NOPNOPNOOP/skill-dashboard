import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import { resolveSkillCascade } from "./cascade.ts";
import { resolvePythonExecutable, shellEscape } from "./interpolator.ts";
import type {
  AgentFixTarget,
  AgentManifestSyncRequest,
  AgentMount,
  AgentMountRoot,
  CanonicalSkill,
  FileTreeNode,
  LockProvenance,
  ManagedFolderEntry,
  SkillUpdateStrategy,
  UnitKind,
} from "./types.ts";

export const PRUNED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  ".DS_Store",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);

export function getDefaultAgentRoots(homeDir: string, activeWorkspace: string): AgentMountRoot[] {
  return [
    {
      agent: "agents-hub",
      label: "Universal Hub (~/.agents/skills)",
      path: join(homeDir, ".agents/skills"),
      scope: "global",
      canToggleMount: true,
      primaryToggle: true,
      sharedViaAgentsHub: true,
    },
    {
      agent: "claude",
      label: "Claude Code",
      path: join(homeDir, ".claude/skills"),
      scope: "global",
      canToggleMount: true,
      primaryToggle: true,
    },
    {
      agent: "openclaw",
      label: "OpenClaw",
      path: join(homeDir, ".openclaw/skills"),
      scope: "global",
      canToggleMount: true,
      primaryToggle: true,
    },
    {
      agent: "claude-workspace",
      label: "Project (.claude/skills)",
      path: join(activeWorkspace, ".claude/skills"),
      scope: "workspace",
      canToggleMount: true,
      primaryToggle: true,
    },
    {
      agent: "codex-system",
      label: "Codex System",
      path: join(homeDir, ".codex/skills/.system"),
      scope: "global",
      canToggleMount: false,
      primaryToggle: false,
    },
    {
      agent: "codex",
      label: "Codex Dedicated (~/.codex/skills)",
      path: join(homeDir, ".codex/skills"),
      scope: "global",
      canToggleMount: true,
      primaryToggle: false,
      sharedViaAgentsHub: true,
    },
    {
      agent: "opencode",
      label: "OpenCode Dedicated (~/.config/opencode/skills)",
      path: join(homeDir, ".config/opencode/skills"),
      scope: "global",
      canToggleMount: true,
      primaryToggle: false,
      sharedViaAgentsHub: true,
    },
    {
      agent: "pi-agent",
      label: "Pi Dedicated (~/.pi/agent/skills)",
      path: join(homeDir, ".pi/agent/skills"),
      scope: "global",
      canToggleMount: true,
      primaryToggle: false,
      sharedViaAgentsHub: true,
    },
    {
      agent: "pi",
      label: "Pi (~/.pi/skills)",
      path: join(homeDir, ".pi/skills"),
      scope: "global",
      canToggleMount: true,
      primaryToggle: false,
      sharedViaAgentsHub: true,
    },
    {
      agent: "continue",
      label: "Continue (~/.continue/skills)",
      path: join(homeDir, ".continue/skills"),
      scope: "global",
      canToggleMount: true,
      primaryToggle: false,
    },
    {
      agent: "trae",
      label: "Trae (~/.trae/skills)",
      path: join(homeDir, ".trae/skills"),
      scope: "global",
      canToggleMount: true,
      primaryToggle: false,
    },
    {
      agent: "agents-workspace",
      label: "Project (.agents/skills)",
      path: join(activeWorkspace, ".agents/skills"),
      scope: "workspace",
      canToggleMount: true,
      primaryToggle: false,
    },
  ];
}

export function loadLockProvenanceMap(lockfiles: string[]): Record<string, LockProvenance> {
  const map: Record<string, LockProvenance> = {};
  for (const lf of lockfiles) {
    if (!existsSync(lf)) continue;
    try {
      const parsed = JSON.parse(readFileSync(lf, "utf-8"));
      const skillsObj = parsed?.skills || {};
      for (const [k, v] of Object.entries<any>(skillsObj)) {
        map[k] = {
          source: v.source || "unknown",
          sourceType: v.sourceType || "unknown",
          sourceUrl: v.sourceUrl,
          skillPath: v.skillPath,
          skillFolderHash: v.skillFolderHash || v.computedHash,
          installedAt: v.installedAt,
          updatedAt: v.updatedAt,
        };
      }
    } catch {
      // ignore corrupted lockfile
    }
  }
  return map;
}

export function expandHomePath(p: string, homeDir: string): string {
  if (p.startsWith("~/")) return join(homeDir, p.slice(2));
  if (p === "~") return homeDir;
  return resolve(p);
}

export function discoverCanonicalSkills(options: {
  agentRoots: AgentMountRoot[];
  lockfiles: string[];
  dataDir: string;
  overridesDir?: string;
  scratchpadsRoot?: string;
  managedFolders?: ManagedFolderEntry[];
  watchRoots?: string[];
  activeWorkspace: string;
  homeDir: string;
  getSkillWorkspaceOverride?: (skillId: string) => string | null;
  getSkillEnvOverride?: (skillId: string) => Record<string, string>;
}): {
  skills: CanonicalSkill[];
  brokenMounts: AgentMount[];
} {
  const lockMap = loadLockProvenanceMap(options.lockfiles);
  const byRealPath = new Map<string, CanonicalSkill>();
  const usedIds = new Set<string>();
  const brokenMounts: AgentMount[] = [];
  const agentsHubDir =
    options.agentRoots.find((r) => r.agent === "agents-hub")?.path ||
    join(options.homeDir, ".agents/skills");

  for (const root of options.agentRoots) {
    if (!existsSync(root.path)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root.path);
    } catch {
      continue;
    }

    for (const entryName of entries) {
      if (entryName.startsWith(".")) continue;
      const mountPath = join(root.path, entryName);
      let lstat;
      try {
        lstat = lstatSync(mountPath);
      } catch {
        continue;
      }

      const isSymlink = lstat.isSymbolicLink();
      let realPath: string;
      try {
        realPath = realpathSync(mountPath);
        if (!statSync(realPath).isDirectory()) continue;
      } catch {
        let rawTarget: string | undefined;
        try {
          rawTarget = readlinkSync(mountPath);
        } catch {
          rawTarget = undefined;
        }
        const hubCandidate = join(agentsHubDir, entryName);
        brokenMounts.push({
          agent: root.agent,
          label: root.label,
          mountPath,
          targetPath: rawTarget,
          isSymlink,
          status: "broken_symlink",
          skillName: entryName,
          suggestedRepairPath: existsSync(hubCandidate) ? hubCandidate : undefined,
        });
        continue;
      }

      let record = byRealPath.get(realPath);
      if (!record) {
        const baseId = basename(realPath);
        let id = baseId;
        if (usedIds.has(id)) {
          id = `${root.agent}-${baseId}`;
        }
        usedIds.add(id);

        // First pass cascade to read manifest.defaultWorkspace if any
        const initialCascade = resolveSkillCascade(
          id,
          realPath,
          options.dataDir,
          options.activeWorkspace,
          options.overridesDir
        );

        const dbWsOverride = options.getSkillWorkspaceOverride?.(id);
        const manifestDefaultWs = initialCascade.manifest.defaultWorkspace
          ? expandHomePath(initialCascade.manifest.defaultWorkspace, options.homeDir)
          : undefined;

        const effectiveWorkspace =
          (dbWsOverride && existsSync(dbWsOverride) ? dbWsOverride : undefined) ||
          (manifestDefaultWs && existsSync(manifestDefaultWs) ? manifestDefaultWs : undefined) ||
          options.activeWorkspace;

        // Re-evaluate cascade if effectiveWorkspace differs from global activeWorkspace (for Layer 3 override)
        const { manifest, layers } =
          effectiveWorkspace !== options.activeWorkspace
            ? resolveSkillCascade(id, realPath, options.dataDir, effectiveWorkspace, options.overridesDir)
            : initialCascade;

        // Build configuredEnv (manifest defaults + user overrides)
        const configuredEnv: Record<string, string> = {};
        for (const ev of manifest.envVars || []) {
          if (ev.default !== undefined) configuredEnv[ev.key] = ev.default;
        }
        const savedEnv = options.getSkillEnvOverride?.(id) || {};
        Object.assign(configuredEnv, savedEnv);

        const provenance = lockMap[baseId] || lockMap[id];
        if (provenance?.source) {
          const repoOwner = provenance.source.split("/")[0]?.toLowerCase();
          if (repoOwner && !manifest.tags.includes(repoOwner)) {
            manifest.tags.push(repoOwner);
          }
        }
        const updateStrategy: SkillUpdateStrategy = provenance
          ? "npx-lock"
          : existsSync(join(realPath, ".git"))
            ? "git"
            : "local";

        record = {
          id,
          unitKind: "skill",
          hasManifest: layers.companion,
          canonicalPath: realPath,
          inAgentsHub: false,
          updateStrategy,
          effectiveWorkspace,
          pythonExecutable: resolvePythonExecutable(effectiveWorkspace),
          configuredEnv,
          mounts: [],
          provenance,
          hasOpenAiYaml: existsSync(join(realPath, "agents/openai.yaml")),
          layers,
          manifest,
        };
        byRealPath.set(realPath, record);
      }

      if (root.agent === "agents-hub") {
        record.inAgentsHub = true;
      }

      record.mounts.push({
        agent: root.agent,
        label: root.label,
        mountPath,
        targetPath: realPath,
        isSymlink,
        status: isSymlink ? "mounted" : "standalone",
        skillName: entryName,
      });
    }
  }

  // Also check if a skill has a workspace mount inside its own effectiveWorkspace (if different from global activeWorkspace)
  for (const skill of byRealPath.values()) {
    if (skill.effectiveWorkspace !== options.activeWorkspace) {
      const wsClaudeMount = join(skill.effectiveWorkspace, ".claude/skills", basename(skill.canonicalPath));
      if (
        existsSync(wsClaudeMount) &&
        !skill.mounts.some((m) => m.agent === "claude-workspace")
      ) {
        try {
          if (realpathSync(wsClaudeMount) === skill.canonicalPath) {
            skill.mounts.push({
              agent: "claude-workspace",
              label: "Project (.claude/skills)",
              mountPath: wsClaudeMount,
              targetPath: skill.canonicalPath,
              isSymlink: lstatSync(wsClaudeMount).isSymbolicLink(),
              status: "mounted",
              skillName: basename(skill.canonicalPath),
            });
          }
        } catch {
          // ignore
        }
      }
    }
  }

  // 2. Discover Managed Folders (Workspaces) from config.yaml + watchRoots
  const registerNonSkillUnit = (params: {
    dirPath: string;
    unitKind: UnitKind;
    labelOverride?: string;
    projectSlug?: string;
    fallbackWorkspace?: string;
  }) => {
    const expanded = expandHomePath(params.dirPath, options.homeDir);
    if (!existsSync(expanded)) return;
    let realPath: string;
    try {
      realPath = realpathSync(expanded);
      if (!statSync(realPath).isDirectory()) return;
    } catch {
      return;
    }

    const existing = byRealPath.get(realPath);
    if (existing) {
      if (params.unitKind === "scratchpad") {
        existing.unitKind = "scratchpad";
        existing.projectSlug = params.projectSlug;
      } else if (params.unitKind === "workspace" && existing.unitKind === "skill") {
        existing.unitKind = "workspace";
      }
      return;
    }

    const baseId = basename(realPath);
    const initialProbe = resolveSkillCascade(
      baseId,
      realPath,
      options.dataDir,
      params.fallbackWorkspace || realPath,
      options.overridesDir
    );
    const preferredId = initialProbe.manifest.id || baseId;
    let id = preferredId;
    if (usedIds.has(id)) {
      const prefix =
        params.unitKind === "scratchpad"
          ? params.projectSlug
            ? `pad-${params.projectSlug}-`
            : "pad-"
          : "ws-";
      id = `${prefix}${preferredId}`;
      let seq = 2;
      while (usedIds.has(id)) {
        id = `${prefix}${preferredId}-${seq++}`;
      }
    }
    usedIds.add(id);

    const dbWsOverride = options.getSkillWorkspaceOverride?.(id);
    const manifestDefaultWs = initialProbe.manifest.defaultWorkspace
      ? expandHomePath(initialProbe.manifest.defaultWorkspace, options.homeDir)
      : undefined;
    const effectiveWorkspace =
      (dbWsOverride && existsSync(dbWsOverride) ? dbWsOverride : undefined) ||
      (manifestDefaultWs && existsSync(manifestDefaultWs) ? manifestDefaultWs : undefined) ||
      params.fallbackWorkspace ||
      realPath;

    const { manifest, layers } = resolveSkillCascade(
      id,
      realPath,
      options.dataDir,
      effectiveWorkspace,
      options.overridesDir
    );
    manifest.id = id;
    if (params.labelOverride && manifest.name === baseId) {
      manifest.name = params.labelOverride;
    }

    const configuredEnv: Record<string, string> = {};
    for (const ev of manifest.envVars || []) {
      if (ev.default !== undefined) configuredEnv[ev.key] = ev.default;
    }
    Object.assign(configuredEnv, options.getSkillEnvOverride?.(id) || {});

    byRealPath.set(realPath, {
      id,
      unitKind: params.unitKind,
      hasManifest: layers.companion,
      projectSlug: params.projectSlug,
      canonicalPath: realPath,
      inAgentsHub: false,
      updateStrategy: existsSync(join(realPath, ".git")) ? "git" : "local",
      effectiveWorkspace,
      pythonExecutable: resolvePythonExecutable(effectiveWorkspace),
      configuredEnv,
      mounts: [],
      hasOpenAiYaml: existsSync(join(realPath, "agents/openai.yaml")),
      layers,
      manifest,
    });
  };

  for (const folder of options.managedFolders || []) {
    registerNonSkillUnit({
      dirPath: folder.path,
      unitKind: "workspace",
      labelOverride: folder.label,
    });
  }

  for (const watchRoot of options.watchRoots || []) {
    const expandedWatch = expandHomePath(watchRoot, options.homeDir);
    if (!existsSync(expandedWatch)) continue;
    try {
      for (const child of readdirSync(expandedWatch, { withFileTypes: true })) {
        if (child.name.startsWith(".") || !child.isDirectory()) continue;
        const candidateDir = join(expandedWatch, child.name);
        if (
          existsSync(join(candidateDir, ".dashboard/manifest.yaml")) ||
          existsSync(join(candidateDir, ".dashboard/manifest.json"))
        ) {
          registerNonSkillUnit({
            dirPath: candidateDir,
            unitKind: "workspace",
          });
        }
      }
    } catch {
      // ignore unreadable watch root
    }
  }

  // 3. Discover Ephemeral Agent Scratchpads under ~/.cache/skill-dashboard/scratchpads/<projectSlug>/<padId>
  if (options.scratchpadsRoot && existsSync(options.scratchpadsRoot)) {
    try {
      for (const projEntry of readdirSync(options.scratchpadsRoot, { withFileTypes: true })) {
        if (projEntry.name.startsWith(".") || !projEntry.isDirectory()) continue;
        const projPath = join(options.scratchpadsRoot, projEntry.name);
        // Support both 2-level (<projectSlug>/<padId>) and 1-level (<padId>) layouts
        if (
          existsSync(join(projPath, ".dashboard/manifest.yaml")) ||
          existsSync(join(projPath, ".dashboard/manifest.json"))
        ) {
          registerNonSkillUnit({
            dirPath: projPath,
            unitKind: "scratchpad",
            projectSlug: "default",
            fallbackWorkspace: options.activeWorkspace,
          });
          continue;
        }
        for (const padEntry of readdirSync(projPath, { withFileTypes: true })) {
          if (padEntry.name.startsWith(".") || !padEntry.isDirectory()) continue;
          const padPath = join(projPath, padEntry.name);
          let fallbackWs = options.activeWorkspace;
          const metaPath = join(padPath, "meta.json");
          if (existsSync(metaPath)) {
            try {
              const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
              if (meta?.projectRoot && existsSync(meta.projectRoot)) {
                fallbackWs = meta.projectRoot;
              }
            } catch {}
          }
          registerNonSkillUnit({
            dirPath: padPath,
            unitKind: "scratchpad",
            projectSlug: projEntry.name,
            fallbackWorkspace: fallbackWs,
          });
        }
      }
    } catch {
      // ignore
    }
  }

  const kindRank: Record<string, number> = {
    scratchpad: 0,
    workspace: 1,
    skill: 2,
  };

  const skills = [...byRealPath.values()].sort((a, b) => {
    const ka = kindRank[a.unitKind || "skill"] ?? 2;
    const kb = kindRank[b.unitKind || "skill"] ?? 2;
    if (ka !== kb) return ka - kb;
    if (a.id === "vsip") return -1;
    if (b.id === "vsip") return 1;
    if (a.layers.companion !== b.layers.companion) return a.layers.companion ? -1 : 1;
    return a.manifest.name.localeCompare(b.manifest.name);
  });

  return { skills, brokenMounts };
}

export function computeCleanSymlinkTarget(
  canonicalPath: string,
  mountPath: string,
  homeDir: string
): string {
  try {
    const realHome = existsSync(homeDir) ? realpathSync(homeDir) : homeDir;
    const realCanon = existsSync(canonicalPath) ? realpathSync(canonicalPath) : canonicalPath;
    const parentDir = dirname(mountPath);
    const realParent = existsSync(parentDir) ? realpathSync(parentDir) : parentDir;

    if (realCanon.startsWith(realHome) && realParent.startsWith(realHome)) {
      const rel = relative(realParent, realCanon);
      if (rel && !rel.startsWith("../../../../..")) {
        return rel;
      }
    }
  } catch {
    // fallback to canonicalPath
  }
  return canonicalPath;
}

export function toggleSkillMount(params: {
  canonicalPath: string;
  skillId: string;
  targetRoot: AgentMountRoot;
  enabled: boolean;
  homeDir?: string;
}): { mounted: boolean; mountPath: string; linkTarget?: string } {
  const { canonicalPath, skillId, targetRoot, enabled, homeDir = "" } = params;
  const folderName = basename(canonicalPath) || skillId;
  const mountPath = join(targetRoot.path, folderName);

  if (enabled) {
    mkdirSync(targetRoot.path, { recursive: true });
    try {
      const st = lstatSync(mountPath);
      if (st.isSymbolicLink()) {
        unlinkSync(mountPath);
      } else {
        return { mounted: true, mountPath };
      }
    } catch {
      // does not exist yet
    }
    const linkTarget = homeDir
      ? computeCleanSymlinkTarget(canonicalPath, mountPath, homeDir)
      : canonicalPath;
    symlinkSync(linkTarget, mountPath, "dir");
    return { mounted: true, mountPath, linkTarget };
  } else {
    try {
      const st = lstatSync(mountPath);
      if (st.isSymbolicLink()) {
        unlinkSync(mountPath);
      } else {
        throw new Error(`Refusing to delete non-symlink standalone directory at ${mountPath}`);
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
    return { mounted: false, mountPath };
  }
}

export function repairBrokenMount(params: {
  mountPath: string;
  action: "relink" | "remove";
  targetPath?: string;
  homeDir?: string;
}): { ok: boolean; action: string; mountPath: string } {
  const { mountPath, action, targetPath, homeDir = "" } = params;
  try {
    const st = lstatSync(mountPath);
    if (st.isSymbolicLink()) {
      unlinkSync(mountPath);
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }

  if (action === "relink") {
    if (!targetPath || !existsSync(targetPath)) {
      throw new Error(`Target path for relink does not exist: ${targetPath}`);
    }
    const realTarget = realpathSync(targetPath);
    const linkTarget = homeDir
      ? computeCleanSymlinkTarget(realTarget, mountPath, homeDir)
      : realTarget;
    symlinkSync(linkTarget, mountPath, "dir");
  }

  return { ok: true, action, mountPath };
}

export function isPathInsideRoot(candidatePath: string, allowedRoot: string): boolean {
  try {
    const realCandidate = realpathSync(candidatePath);
    const realRoot = realpathSync(allowedRoot);
    const rel = relative(realRoot, realCandidate);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
  } catch {
    return false;
  }
}

export function computeParentPath(subPath: string): string | null {
  const clean = subPath.replace(/^\/+|\/+$/g, "");
  if (!clean || clean === ".") return null;
  const parent = dirname(clean);
  return parent === "." ? "" : parent;
}

export function listSkillDirectory(
  canonicalPath: string,
  subPath = "",
  recursive = false,
  depth = 0,
  maxDepth = 5
): FileTreeNode[] {
  const cleanSub = subPath.replace(/^\/+|\/+$/g, "");
  const targetDir = resolve(canonicalPath, cleanSub || ".");
  if (!isPathInsideRoot(targetDir, canonicalPath)) {
    throw new Error("Path traversal outside skill root is forbidden");
  }
  if (!existsSync(targetDir) || !statSync(targetDir).isDirectory()) {
    return [];
  }

  const entries = readdirSync(targetDir);
  const nodes: FileTreeNode[] = [];
  for (const name of entries) {
    if (PRUNED_DIRS.has(name)) continue;
    const full = join(targetDir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    const rel = relative(canonicalPath, full);
    if (st.isDirectory()) {
      nodes.push({
        name,
        relativePath: rel,
        type: "directory",
        depth,
        children:
          recursive && depth < maxDepth
            ? listSkillDirectory(canonicalPath, rel, true, depth + 1, maxDepth)
            : undefined,
      });
    } else if (st.isFile()) {
      nodes.push({
        name,
        relativePath: rel,
        type: "file",
        depth,
        size: st.size,
        extension: extname(name).toLowerCase(),
      });
    }
  }

  return nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function readSkillFileSafe(canonicalPath: string, relPath: string): {
  relativePath: string;
  size: number;
  isBinary: boolean;
  content?: string;
  mimeType: string;
} {
  const cleanRel = relPath.replace(/^\/+/, "");
  const fullPath = resolve(canonicalPath, cleanRel);
  if (!isPathInsideRoot(fullPath, canonicalPath)) {
    throw new Error("Path traversal outside skill root is forbidden");
  }
  const st = statSync(fullPath);
  if (!st.isFile()) {
    throw new Error("Requested path is not a regular file");
  }

  const ext = extname(fullPath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8",
    ".yml": "text/yaml; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
  };
  const mimeType = mimeMap[ext] || "text/plain; charset=utf-8";
  const isBinary = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".xlsx", ".zip"].includes(ext);

  if (isBinary) {
    return {
      relativePath: cleanRel,
      size: st.size,
      isBinary: true,
      mimeType,
    };
  }

  const maxBytes = 512 * 1024;
  const buf = readFileSync(fullPath);
  const slice = buf.byteLength > maxBytes ? buf.subarray(0, maxBytes) : buf;
  const content = new TextDecoder().decode(slice) + (buf.byteLength > maxBytes ? "\n\n... [Truncated at 512KB]" : "");

  return {
    relativePath: cleanRel,
    size: st.size,
    isBinary: false,
    content,
    mimeType,
  };
}

export function computeSkillsSignature(
  skills: CanonicalSkill[],
  lockfiles: string[],
  extraPaths: string[] = []
): string {
  const parts: string[] = [];
  for (const lf of [...lockfiles, ...extraPaths]) {
    try {
      if (existsSync(lf)) parts.push(`lf:${lf}:${statSync(lf).mtimeMs}`);
    } catch {
      // ignore
    }
  }
  for (const s of skills) {
    parts.push(`unit:${s.id}:${s.unitKind || "skill"}`);
    for (const rel of ["SKILL.md", "skill.md", "README.md", ".dashboard/manifest.yaml", ".dashboard/manifest.json"]) {
      const p = join(s.canonicalPath, rel);
      try {
        if (existsSync(p)) parts.push(`${s.id}:${rel}:${statSync(p).mtimeMs}`);
      } catch {
        // ignore
      }
    }
    for (const modRel of s.layers.moduleFiles || []) {
      const mp = join(s.canonicalPath, ".dashboard", modRel);
      try {
        if (existsSync(mp)) parts.push(`${s.id}:.dashboard/${modRel}:${statSync(mp).mtimeMs}`);
      } catch {
        // ignore
      }
    }
  }
  return parts.join("|");
}

export function buildGuardedSkillUpdateCommand(params: {
  skill: CanonicalSkill;
  customCommand?: string;
}): { command: string; maskedCommand: string; backupDir?: string } {
  const { skill, customCommand } = params;
  const dashboardDir = join(skill.canonicalPath, ".dashboard");
  let backupDir: string | undefined;

  if (existsSync(dashboardDir)) {
    const tmpBase = mkdtempSync(join(tmpdir(), `sd-guard-${skill.id}-`));
    backupDir = join(tmpBase, ".dashboard");
    cpSync(dashboardDir, backupDir, { recursive: true });
  }

  const baseCmd =
    customCommand ||
    (skill.updateStrategy === "npx-lock"
      ? `npx -y skills update ${shellEscape(skill.id)} -g -y`
      : skill.updateStrategy === "git"
        ? `git -C ${shellEscape(skill.canonicalPath)} pull --ff-only`
        : `echo "Skill '${skill.id}' is locally managed at ${skill.canonicalPath}"`);

  if (!backupDir) {
    return { command: baseCmd, maskedCommand: baseCmd };
  }

  const guardedCmd = `${baseCmd}; _EXIT=$?; if [ -d ${shellEscape(skill.canonicalPath)} ] && [ ! -d ${shellEscape(dashboardDir)} ] && [ -d ${shellEscape(backupDir)} ]; then cp -R ${shellEscape(backupDir)} ${shellEscape(dashboardDir)}; echo "[Skill Dashboard] Restored companion .dashboard/ configuration."; fi; rm -rf ${shellEscape(dirname(backupDir))}; exit $_EXIT`;
  return {
    command: guardedCmd,
    maskedCommand: `${baseCmd} (with .dashboard/ guard)`,
    backupDir,
  };
}

export function resolveAgentTargetFile(
  skill: CanonicalSkill,
  options?: Pick<AgentManifestSyncRequest, "targets" | "targetLayer">
): {
  resolvedTargetFile: string;
  resolvedTargetLayer: "companion" | "global_override" | "workspace_override";
  targetExists: boolean;
} {
  const companionPath = skill.layers.companionPath || join(skill.canonicalPath, ".dashboard/manifest.yaml");
  const globalPath = skill.layers.globalOverridePath;
  const workspacePath = skill.layers.workspaceOverridePath;

  if (options?.targetLayer === "workspace_override") {
    return {
      resolvedTargetFile: workspacePath,
      resolvedTargetLayer: "workspace_override",
      targetExists: existsSync(workspacePath),
    };
  }
  if (options?.targetLayer === "global_override") {
    return {
      resolvedTargetFile: globalPath,
      resolvedTargetLayer: "global_override",
      targetExists: existsSync(globalPath),
    };
  }
  if (options?.targetLayer === "companion") {
    return {
      resolvedTargetFile: companionPath,
      resolvedTargetLayer: "companion",
      targetExists: existsSync(companionPath),
    };
  }

  // Auto mode:
  // 1. Check if any pinned target maps to an existing submodule file (e.g. modules/ops.yaml) in .dashboard/
  const prov = skill.layers.provenance;
  const targets = options?.targets || [];
  for (const t of targets) {
    let relMod =
      t.provenanceFile ||
      (t.kind === "action" ? prov?.actionSource?.[t.id] : undefined) ||
      (t.kind === "data-node" ? prov?.dataSource?.[t.id] : undefined) ||
      (t.kind === "context" ? prov?.contextSource?.[t.id] : undefined) ||
      (t.kind === "view" ? prov?.viewSource?.[t.id] : undefined);
    if (!relMod && t.kind === "action-group") {
      const grp = skill.manifest.actionGroups.find((g) => g.name === t.id);
      const firstActId = grp?.actions?.[0]?.id;
      if (firstActId) relMod = prov?.actionSource?.[firstActId];
    }
    const cleanRel = relMod ? relMod.replace(/^\.?\//, "") : "";
    if (cleanRel && cleanRel !== "manifest.yaml" && cleanRel !== "manifest.json") {
      const candidate = join(skill.canonicalPath, ".dashboard", cleanRel);
      if (existsSync(candidate)) {
        return {
          resolvedTargetFile: candidate,
          resolvedTargetLayer: "companion",
          targetExists: true,
        };
      }
    }
  }

  // 2. Otherwise check existing active layer files (Workspace Override -> Global Override -> Companion)
  if (skill.layers.workspaceOverride && existsSync(workspacePath)) {
    return {
      resolvedTargetFile: workspacePath,
      resolvedTargetLayer: "workspace_override",
      targetExists: true,
    };
  }
  if (skill.layers.globalOverride && existsSync(globalPath)) {
    return {
      resolvedTargetFile: globalPath,
      resolvedTargetLayer: "global_override",
      targetExists: true,
    };
  }
  if (skill.layers.companion && existsSync(companionPath)) {
    return {
      resolvedTargetFile: companionPath,
      resolvedTargetLayer: "companion",
      targetExists: true,
    };
  }

  // 3. Fallback: create <skill_dir>/.dashboard/manifest.yaml
  return {
    resolvedTargetFile: companionPath,
    resolvedTargetLayer: "companion",
    targetExists: existsSync(companionPath),
  };
}

export function buildAgentManifestSyncPrompt(
  skill: CanonicalSkill,
  options?: AgentManifestSyncRequest
): {
  mode: "init" | "incremental";
  resolvedTargetFile: string;
  resolvedTargetLayer: "companion" | "global_override" | "workspace_override";
  targetExists: boolean;
  prompt: string;
  claudeCommand: string;
  codexCommand: string;
} {
  const { resolvedTargetFile, resolvedTargetLayer, targetExists } = resolveAgentTargetFile(
    skill,
    options
  );
  const skillMdPath = join(skill.canonicalPath, "SKILL.md");
  const readmePath = join(skill.canonicalPath, "README.md");
  const docTarget = existsSync(skillMdPath)
    ? skillMdPath
    : existsSync(readmePath)
      ? readmePath
      : skill.canonicalPath;
  const cliPath = resolve(import.meta.dir, "manifest-cli.ts");
  const skillGuidePath = resolve(import.meta.dir, "../SKILL.md");
  const mode: "init" | "incremental" = targetExists ? "incremental" : "init";

  const sections: string[] = [];

  if (options?.userInstruction && options.userInstruction.trim()) {
    sections.push(`User Goal / Fix Instruction:\n${options.userInstruction.trim()}`);
  }

  sections.push(
    `Target Unit: "${skill.id}" (${skill.manifest.name}) at ${skill.canonicalPath}\nSource Doc: ${docTarget}\nTarget Manifest File (${targetExists ? "EXISTING - edit in place" : "NEW - create file"}): ${resolvedTargetFile}`
  );

  if (options?.targets && options.targets.length > 0) {
    const formattedTargets = options.targets
      .map((t) => {
        const provNote = t.provenanceFile ? ` [file: .dashboard/${t.provenanceFile}]` : "";
        const snip =
          t.snippet !== undefined
            ? `\n  Current Definition: ${JSON.stringify(t.snippet)}`
            : "";
        return `- [${t.kind}] id="${t.id}" title="${t.title}"${provNote}${snip}`;
      })
      .join("\n");
    sections.push(`Pinned UI Context Targets (${options.targets.length}):\n${formattedTargets}`);
  } else if (!targetExists && skill.manifest.actionGroups.length > 0) {
    const zeroSummary = skill.manifest.actionGroups
      .map(
        (g) =>
          `Group "${g.name}": ${g.actions
            .slice(0, 8)
            .map((a) => `${a.id} ("${a.title}")`)
            .join(", ")}${g.actions.length > 8 ? ` ... (+${g.actions.length - 8} more)` : ""}`
      )
      .join(" | ");
    sections.push(`Current Layer-0 Zero-Config Heuristic Summary:\n${zeroSummary}`);
  }

  if (targetExists) {
    sections.push(
      `Workflow:\n1. Read ${skillGuidePath} (and its references/ docs if needed) and run \`bun ${cliPath} inspect ${shellEscape(skill.canonicalPath)}\` and \`bun ${cliPath} map ${shellEscape(skill.id)}\`.\n2. Using the skill-dashboard Incremental Edit Protocol, update ${resolvedTargetFile} (context switchers, polyglot data nodes with prelude: true for runtime: ts, shape: scalar|kv|list|table|matrix|stream|raw, rowActions, actions supporting {{data_dir}}/{{cache_dir}}/{{artifacts_dir}} and artifacts rules, form fields with fromData, or views) to fulfill the User Goal and fix the Pinned UI Context Targets.\n3. Verify with \`bun ${cliPath} validate ${shellEscape(skill.id)}\` until 0 errors remain.`
    );
  } else {
    sections.push(
      `Workflow:\n1. Read ${skillGuidePath} (and its references/ docs if needed) and run \`bun ${cliPath} inspect ${shellEscape(skill.canonicalPath)}\` and \`bun ${cliPath} init ${shellEscape(skill.canonicalPath)}\`.\n2. Create a structured ${resolvedTargetFile} following the skill-dashboard Reactive 2.0 SkillManifest schema (context switchers, polyglot data nodes with prelude: true for runtime: ts, actionGroups with subgroup tags, {{data_dir}}/{{cache_dir}}/{{artifacts_dir}} variables, artifacts rules, and views) fulfilling the User Goal.\n3. Verify with \`bun ${cliPath} validate ${shellEscape(skill.id)}\` until 0 errors remain.`
    );
  }

  const prompt = sections.join("\n\n");

  return {
    mode,
    resolvedTargetFile,
    resolvedTargetLayer,
    targetExists,
    prompt,
    claudeCommand: `claude --dangerously-skip-permissions ${shellEscape(prompt)}`,
    codexCommand: `codex ${shellEscape(prompt)}`,
  };
}

export function discoverCandidateWorkspaces(homeDir: string, defaultWorkspace: string): string[] {
  const set = new Set<string>([defaultWorkspace]);
  const roots = [
    join(homeDir, "orca/workspaces"),
    join(homeDir, "Projects"),
    join(homeDir, "Projects.self"),
  ];

  for (const r of roots) {
    if (!existsSync(r)) continue;
    try {
      for (const l1 of readdirSync(r)) {
        if (l1.startsWith(".")) continue;
        const p1 = join(r, l1);
        if (!statSync(p1).isDirectory()) continue;
        if (existsSync(join(p1, ".git")) || existsSync(join(p1, "pyproject.toml")) || existsSync(join(p1, "package.json"))) {
          set.add(p1);
        } else {
          try {
            for (const l2 of readdirSync(p1)) {
              if (l2.startsWith(".")) continue;
              const p2 = join(p1, l2);
              if (statSync(p2).isDirectory()) set.add(p2);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return [...set];
}
