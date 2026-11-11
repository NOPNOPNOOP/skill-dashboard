import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { basename, join, resolve } from "path";
import YAML from "yaml";
import type { DashboardConfig, UnconfiguredFolderAction } from "./types.ts";

export interface DashboardPaths {
  homeDir: string;
  configDir: string;
  configFile: string;
  overridesDir: string;
  dataDir: string;
  dbPath: string;
  logsDir: string;
  unitsDataRoot: string;
  artifactsRoot: string;
  cacheDir: string;
  scratchpadsRoot: string;
  unitsCacheRoot: string;
  runtimeDir: string;
  runtimeScriptsDir: string;
  daemonLogPath: string;
}

export interface UnitSandboxPaths {
  unitDataDir: string;
  unitCacheDir: string;
  unitArtifactsRoot: string;
  runArtifactsDir: string;
  latestArtifactsLink: string;
}

export function sanitizeUnitSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

export function resolveDashboardPaths(opts?: {
  homeDir?: string;
  configDir?: string;
  dataDir?: string;
  cacheDir?: string;
}): DashboardPaths {
  const home = opts?.homeDir || homedir();
  const configDir =
    opts?.configDir ||
    process.env.SD_CONFIG_DIR ||
    join(home, ".config/skill-dashboard");
  const dataDir =
    opts?.dataDir ||
    process.env.SD_DATA_DIR ||
    join(home, ".local/share/skill-dashboard");
  const cacheDir =
    opts?.cacheDir ||
    process.env.SD_CACHE_DIR ||
    join(home, ".cache/skill-dashboard");

  return {
    homeDir: home,
    configDir,
    configFile: join(configDir, "config.yaml"),
    overridesDir: join(configDir, "overrides"),
    dataDir,
    dbPath: join(dataDir, "dashboard.db"),
    logsDir: join(dataDir, "logs"),
    unitsDataRoot: join(dataDir, "units"),
    artifactsRoot: join(dataDir, "artifacts"),
    cacheDir,
    scratchpadsRoot: join(cacheDir, "scratchpads"),
    unitsCacheRoot: join(cacheDir, "units"),
    runtimeDir: join(cacheDir, "runtime"),
    runtimeScriptsDir: join(cacheDir, "runtime/scripts"),
    daemonLogPath: join(cacheDir, "runtime/daemon.log"),
  };
}

export function ensureDashboardDirectories(paths: DashboardPaths): void {
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.overridesDir, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  mkdirSync(paths.unitsDataRoot, { recursive: true });
  mkdirSync(paths.artifactsRoot, { recursive: true });
  mkdirSync(paths.cacheDir, { recursive: true });
  mkdirSync(paths.scratchpadsRoot, { recursive: true });
  mkdirSync(paths.unitsCacheRoot, { recursive: true });
  mkdirSync(paths.runtimeScriptsDir, { recursive: true });
}

export function ensureUnitSandboxPaths(
  paths: DashboardPaths,
  unitId: string,
  runId?: string
): UnitSandboxPaths {
  const seg = sanitizeUnitSegment(unitId);
  const unitDataDir = join(paths.unitsDataRoot, seg);
  const unitCacheDir = join(paths.unitsCacheRoot, seg);
  const unitArtifactsRoot = join(paths.artifactsRoot, seg);
  const latestArtifactsLink = join(unitArtifactsRoot, "latest");
  const runArtifactsDir = runId
    ? join(unitArtifactsRoot, sanitizeUnitSegment(runId))
    : latestArtifactsLink;

  mkdirSync(unitDataDir, { recursive: true });
  mkdirSync(unitCacheDir, { recursive: true });
  mkdirSync(unitArtifactsRoot, { recursive: true });
  if (runId) {
    mkdirSync(runArtifactsDir, { recursive: true });
  } else if (!existsSync(latestArtifactsLink)) {
    mkdirSync(latestArtifactsLink, { recursive: true });
  }

  return {
    unitDataDir,
    unitCacheDir,
    unitArtifactsRoot,
    runArtifactsDir,
    latestArtifactsLink,
  };
}

export function updateLatestArtifactsSymlink(
  paths: DashboardPaths,
  unitId: string,
  runId: string
): void {
  const seg = sanitizeUnitSegment(unitId);
  const unitArtifactsRoot = join(paths.artifactsRoot, seg);
  const latestLink = join(unitArtifactsRoot, "latest");
  const targetRel = sanitizeUnitSegment(runId);
  try {
    try {
      const st = lstatSync(latestLink);
      if (st.isSymbolicLink() || st.isDirectory() || st.isFile()) {
        rmSync(latestLink, { recursive: true, force: true });
      }
    } catch {
      // does not exist
    }
    symlinkSync(targetRel, latestLink);
  } catch {
    // ignore symlink error on restricted fs
  }
}

export function defaultDashboardConfig(): DashboardConfig {
  return {
    server: {
      port: 8766,
    },
    preferences: {
      unconfiguredFolderAction: "ask",
      scratchpadTtlDays: 7,
    },
    managedFolders: [],
    watchRoots: [],
  };
}

export function loadDashboardConfig(paths: DashboardPaths): DashboardConfig {
  const def = defaultDashboardConfig();
  if (!existsSync(paths.configFile)) {
    return def;
  }
  try {
    const raw = YAML.parse(readFileSync(paths.configFile, "utf-8"));
    if (!raw || typeof raw !== "object") return def;
    const prefAction = raw.preferences?.unconfiguredFolderAction;
    const validActions: UnconfiguredFolderAction[] = ["ask", "agent", "skeleton", "raw"];
    return {
      server: {
        port: typeof raw.server?.port === "number" ? raw.server.port : def.server?.port,
        defaultWorkspace:
          typeof raw.server?.defaultWorkspace === "string"
            ? raw.server.defaultWorkspace
            : undefined,
      },
      preferences: {
        unconfiguredFolderAction: validActions.includes(prefAction) ? prefAction : "ask",
        scratchpadTtlDays:
          typeof raw.preferences?.scratchpadTtlDays === "number"
            ? raw.preferences.scratchpadTtlDays
            : 7,
      },
      managedFolders: Array.isArray(raw.managedFolders)
        ? raw.managedFolders
            .filter((item: any) => item && typeof item.path === "string")
            .map((item: any) => ({
              path: item.path,
              label: typeof item.label === "string" ? item.label : undefined,
              addedAt: typeof item.addedAt === "string" ? item.addedAt : new Date().toISOString(),
            }))
        : [],
      watchRoots: Array.isArray(raw.watchRoots)
        ? raw.watchRoots.filter((r: any) => typeof r === "string")
        : [],
    };
  } catch {
    return def;
  }
}

export function saveDashboardConfig(paths: DashboardPaths, config: DashboardConfig): void {
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(paths.configFile, YAML.stringify(config, { lineWidth: 100 }), "utf-8");
}

export function deriveProjectSlug(projectPath: string): string {
  const resolved = resolve(projectPath);
  const base = basename(resolved)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "workspace";
}
