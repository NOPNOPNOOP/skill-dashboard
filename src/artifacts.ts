import { existsSync, readdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { basename, extname, isAbsolute, join, resolve } from "path";
import type {
  ArtifactKind,
  ArtifactOnComplete,
  ArtifactRule,
  ArtifactRuleObject,
  RunArtifact,
} from "./types.ts";

const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function inferArtifactKind(filePath: string, explicit?: ArtifactKind): ArtifactKind {
  if (explicit) return explicit;
  const ext = extname(filePath).toLowerCase();
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".json" || ext === ".jsonl") return "json";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext)) return "image";
  return "file";
}

function expandCandidatePath(rawPath: string, cwd: string, homeDir: string): string {
  const trimmed = rawPath.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) return "";
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/")) return join(homeDir, trimmed.slice(2));
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

function canonicalKey(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    return resolve(absPath);
  }
}

export function extractRunArtifacts(params: {
  rules?: ArtifactRule[];
  rawStdout: string;
  cwd: string;
  homeDir?: string;
  runArtifactsDir?: string;
  startedAt: number;
  interpolatePath?: (template: string) => string;
}): RunArtifact[] {
  const home = params.homeDir || homedir();
  const cleanStdout = stripAnsiCodes(params.rawStdout || "");
  const results = new Map<string, RunArtifact>();

  const registerArtifact = (
    absPath: string,
    opts?: {
      label?: string;
      kind?: ArtifactKind;
      onComplete?: ArtifactOnComplete;
      requireRecentMtime?: boolean;
    }
  ) => {
    if (!absPath || !existsSync(absPath)) return;
    let st;
    try {
      st = statSync(absPath);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    if (opts?.requireRecentMtime && st.mtimeMs < params.startedAt - 1000) {
      return;
    }

    const key = canonicalKey(absPath);
    if (results.has(key)) {
      // Preserve higher-priority rule metadata (Channel 1 > Channel 2 > Channel 3)
      return;
    }

    const filename = basename(absPath);
    results.set(key, {
      label: opts?.label || filename,
      path: key,
      filename,
      kind: inferArtifactKind(absPath, opts?.kind),
      sizeBytes: st.size,
      onComplete: opts?.onComplete || "badge",
    });
  };

  // Channel 1: Explicit YAML ActionItem.artifacts rules (highest priority)
  for (const rawRule of params.rules || []) {
    const rule: ArtifactRuleObject =
      typeof rawRule === "string" ? { path: rawRule } : rawRule;

    if (rule.path) {
      const interpolated = params.interpolatePath
        ? params.interpolatePath(rule.path)
        : rule.path;
      const abs = expandCandidatePath(interpolated, params.cwd, home);
      registerArtifact(abs, {
        label: rule.label,
        kind: rule.kind,
        onComplete: rule.onComplete || "badge",
        requireRecentMtime: false,
      });
    }

    if (rule.fromStdout) {
      try {
        const re = new RegExp(rule.fromStdout, "gm");
        for (const match of cleanStdout.matchAll(re)) {
          const captured =
            match.groups?.path ||
            (match.length > 1 ? match[1] : match[0]) ||
            "";
          const abs = expandCandidatePath(captured, params.cwd, home);
          registerArtifact(abs, {
            label: rule.label,
            kind: rule.kind,
            onComplete: rule.onComplete || "badge",
            requireRecentMtime: true,
          });
        }
      } catch {
        // invalid regex in rule; caught by L3 validator
      }
    }
  }

  // Channel 2: Explicit stdout marker `::artifact path=/path/to/file [label="..."] [onComplete=open]`
  for (const line of cleanStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("::artifact ")) continue;
    const pathMatch = trimmed.match(/\bpath=(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const rawPath = pathMatch?.[1] || pathMatch?.[2] || pathMatch?.[3] || "";
    if (!rawPath) continue;
    const labelMatch = trimmed.match(/\blabel=(?:"([^"]+)"|'([^']+)'|(\S+))/);
    const label = labelMatch?.[1] || labelMatch?.[2] || labelMatch?.[3];
    const onCompleteMatch = trimmed.match(/\bonComplete=(badge|open|download)\b/);
    const onComplete = (onCompleteMatch?.[1] as ArtifactOnComplete | undefined) || "badge";
    const abs = expandCandidatePath(rawPath, params.cwd, home);
    registerArtifact(abs, {
      label,
      onComplete,
      requireRecentMtime: false,
    });
  }

  // Channel 3: Automatic scan of the dedicated per-run {{artifacts_dir}} directory
  if (params.runArtifactsDir && existsSync(params.runArtifactsDir)) {
    try {
      const entries = readdirSync(params.runArtifactsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isFile()) {
          registerArtifact(join(params.runArtifactsDir, entry.name), {
            onComplete: "badge",
            requireRecentMtime: false,
          });
        }
      }
    } catch {
      // ignore directory read errors
    }
  }

  return [...results.values()];
}

export function normalizeStoredArtifacts(
  raw: unknown
): { paths: string[]; items: RunArtifact[] } {
  if (!Array.isArray(raw)) return { paths: [], items: [] };
  const paths: string[] = [];
  const items: RunArtifact[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      paths.push(entry);
      const filename = basename(entry);
      let sizeBytes = 0;
      try {
        if (existsSync(entry)) sizeBytes = statSync(entry).size;
      } catch {
        // ignore
      }
      items.push({
        label: filename,
        path: entry,
        filename,
        kind: inferArtifactKind(entry),
        sizeBytes,
        onComplete: "badge",
      });
    } else if (entry && typeof entry === "object" && typeof (entry as any).path === "string") {
      const it = entry as RunArtifact;
      paths.push(it.path);
      items.push({
        label: it.label || basename(it.path),
        path: it.path,
        filename: it.filename || basename(it.path),
        kind: inferArtifactKind(it.path, it.kind),
        sizeBytes: typeof it.sizeBytes === "number" ? it.sizeBytes : 0,
        onComplete: it.onComplete || "badge",
      });
    }
  }

  return { paths, items };
}
