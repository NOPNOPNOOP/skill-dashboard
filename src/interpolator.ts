import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import type {
  ActionItem,
  ActionPrecondition,
  CommandEnvConfig,
  DataShape,
  DataSnapshot,
  FormField,
  FormFieldOption,
  GraphEdgeItem,
  GraphNodeItem,
  ResolvedCommandEnvSummary,
  TreeNodeItem,
} from "./types.ts";

export function getDashboardEngineRoot(): string {
  return typeof import.meta.dir === "string" ? resolve(import.meta.dir, "..") : "";
}

export function getManifestCliPath(): string {
  return typeof import.meta.dir === "string" ? resolve(import.meta.dir, "manifest-cli.ts") : "";
}

export function shellEscape(val: string): string {
  if (val === "") return "''";
  if (/^[a-zA-Z0-9_./:@=-]+$/.test(val)) {
    return val;
  }
  return `'${val.replace(/'/g, "'\\''")}'`;
}

export function isOffsetInsideDoubleQuotes(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset) + 1;
  const before = text.slice(lineStart, offset);
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < before.length; i++) {
    const ch = before[i];
    if (ch === "\\" && !inSingle) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    }
  }
  return inDouble;
}

export function escapeForTemplateOffset(text: string, offset: number, val: string): string {
  if (isOffsetInsideDoubleQuotes(text, offset)) {
    return val.replace(/(["$`\\])/g, "\\$1");
  }
  return shellEscape(val);
}

export function parseDotenvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      line = line.slice(7).trim();
    }
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!key) continue;
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    } else {
      const commentIdx = val.indexOf(" #");
      if (commentIdx !== -1) {
        val = val.slice(0, commentIdx).trim();
      }
    }
    result[key] = val;
  }
  return result;
}

export function detectVenvAndPython(startDir: string): { pythonRaw: string; venvDir: string | null } {
  let curr = resolve(startDir);
  for (let i = 0; i < 4; i++) {
    const dotVenv = join(curr, ".venv");
    const dotVenvPy = join(dotVenv, "bin/python");
    if (existsSync(dotVenvPy)) {
      return { pythonRaw: dotVenvPy, venvDir: dotVenv };
    }
    const plainVenv = join(curr, "venv");
    const plainVenvPy = join(plainVenv, "bin/python");
    if (existsSync(plainVenvPy)) {
      return { pythonRaw: plainVenvPy, venvDir: plainVenv };
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return { pythonRaw: "python3", venvDir: null };
}

export function resolvePythonExecutable(activeWorkspace: string): string {
  const detected = detectVenvAndPython(activeWorkspace);
  return detected.pythonRaw === "python3" ? "python3" : shellEscape(detected.pythonRaw);
}

export interface ResolvedCommandEnvironment extends ResolvedCommandEnvSummary {
  pythonRaw: string; // unescaped path or "python3"
  pythonEscaped: string; // shell-escaped for {{python}}
  realEnv: Record<string, string>; // unmasked merged env for subprocess execution
}

export function resolveCommandEnvironment(params: {
  skillDir: string;
  defaultWorkspace: string;
  skillDefaultEnv?: Record<string, string>;
  secretKeys?: Set<string>;
  yamlConfig?: CommandEnvConfig;
  uiOverride?: CommandEnvConfig;
  interpolateToken?: (raw: string, baseCwd: string) => string;
}): ResolvedCommandEnvironment {
  const {
    skillDir,
    defaultWorkspace,
    skillDefaultEnv = {},
    secretKeys,
    yamlConfig,
    uiOverride,
    interpolateToken = (raw: string, _base: string) => raw,
  } = params;

  // 1. cwd
  const rawCwdSpec = uiOverride?.cwd?.trim() || yamlConfig?.cwd?.trim() || "project_root";
  const cwdSpec = interpolateToken(rawCwdSpec, defaultWorkspace).trim();
  let resolvedCwd: string;
  if (!cwdSpec || cwdSpec === "project_root" || cwdSpec === ".") {
    resolvedCwd = resolve(defaultWorkspace);
  } else if (cwdSpec === "skill_dir") {
    resolvedCwd = resolve(skillDir);
  } else if (cwdSpec === "~") {
    resolvedCwd = homedir();
  } else if (cwdSpec.startsWith("~/")) {
    resolvedCwd = join(homedir(), cwdSpec.slice(2));
  } else if (isAbsolute(cwdSpec)) {
    resolvedCwd = resolve(cwdSpec);
  } else {
    resolvedCwd = resolve(defaultWorkspace, cwdSpec);
  }

  // 2. pythonRaw & venvDir
  const rawPySpec = uiOverride?.python?.trim() || yamlConfig?.python?.trim() || "";
  let pythonRaw: string;
  let venvDir: string | null = null;

  if (rawPySpec) {
    if (rawPySpec === "python3" || rawPySpec === "python") {
      pythonRaw = rawPySpec;
      venvDir = null;
    } else {
      let expandedPy: string;
      if (rawPySpec === "~") {
        expandedPy = homedir();
      } else if (rawPySpec.startsWith("~/")) {
        expandedPy = join(homedir(), rawPySpec.slice(2));
      } else if (isAbsolute(rawPySpec)) {
        expandedPy = resolve(rawPySpec);
      } else {
        expandedPy = resolve(resolvedCwd, rawPySpec);
      }
      pythonRaw = expandedPy;
      const pyDir = dirname(pythonRaw);
      if (
        (pyDir.endsWith("/bin") || basename(pyDir) === "bin") &&
        (existsSync(join(pyDir, "activate")) || existsSync(join(dirname(pyDir), "pyvenv.cfg")))
      ) {
        venvDir = dirname(pyDir);
      } else {
        venvDir = null;
      }
    }
  } else {
    // First try detectVenvAndPython(resolvedCwd)
    const fromCwd = detectVenvAndPython(resolvedCwd);
    if (fromCwd.venvDir) {
      pythonRaw = fromCwd.pythonRaw;
      venvDir = fromCwd.venvDir;
    } else {
      const fromWs = detectVenvAndPython(defaultWorkspace);
      pythonRaw = fromWs.pythonRaw;
      venvDir = fromWs.venvDir;
    }
  }

  const pythonEscaped =
    pythonRaw === "python3" || pythonRaw === "python" ? pythonRaw : shellEscape(pythonRaw);

  // 3. realEnv & effectiveEnv (masked) & envFile
  const realEnv: Record<string, string> = { ...skillDefaultEnv };
  let resolvedEnvFile: string | undefined = undefined;
  const customEnvKeysSet = new Set<string>();

  const applyEnvFile = (spec?: string) => {
    if (!spec || !spec.trim()) return;
    const trimmedSpec = spec.trim();
    let resolvedPath = interpolateToken(trimmedSpec, resolvedCwd).trim();
    if (resolvedPath === "~") {
      resolvedPath = homedir();
    } else if (resolvedPath.startsWith("~/")) {
      resolvedPath = join(homedir(), resolvedPath.slice(2));
    } else if (!isAbsolute(resolvedPath)) {
      resolvedPath = resolve(resolvedCwd, resolvedPath);
    }
    if (existsSync(resolvedPath)) {
      const parsed = parseDotenvContent(readFileSync(resolvedPath, "utf-8"));
      for (const [k, v] of Object.entries(parsed)) {
        realEnv[k] = v;
        customEnvKeysSet.add(k);
      }
      resolvedEnvFile = trimmedSpec;
    }
  };

  // Merge in order:
  // 1. applyEnvFile(yamlConfig?.envFile)
  applyEnvFile(yamlConfig?.envFile);
  // 2. yamlConfig?.env (interpolating values via interpolateToken(String(v), resolvedCwd))
  if (yamlConfig?.env) {
    for (const [k, v] of Object.entries(yamlConfig.env)) {
      const interpolatedVal = interpolateToken(String(v), resolvedCwd);
      realEnv[k] = interpolatedVal;
      customEnvKeysSet.add(k);
    }
  }
  // 3. applyEnvFile(uiOverride?.envFile)
  applyEnvFile(uiOverride?.envFile);
  // 4. uiOverride?.env (interpolating values via interpolateToken(String(v), resolvedCwd))
  if (uiOverride?.env) {
    for (const [k, v] of Object.entries(uiOverride.env)) {
      const interpolatedVal = interpolateToken(String(v), resolvedCwd);
      realEnv[k] = interpolatedVal;
      customEnvKeysSet.add(k);
    }
  }

  const customEnvKeys = [...customEnvKeysSet];

  // Build effectiveEnv (masked copy of realEnv)
  const effectiveEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(realEnv)) {
    const isSecret = secretKeys?.has(k) || /SECRET|TOKEN|PASSWORD|KEY/i.test(k);
    if (isSecret && v !== "") {
      effectiveEnv[k] = "********";
    } else {
      effectiveEnv[k] = v;
    }
  }

  const hasUiOverride = Boolean(
    uiOverride &&
      (uiOverride.cwd?.trim() ||
        uiOverride.python?.trim() ||
        uiOverride.envFile?.trim() ||
        (uiOverride.env && Object.keys(uiOverride.env).length > 0))
  );

  const isCustom =
    hasUiOverride ||
    resolvedCwd !== resolve(defaultWorkspace) ||
    Boolean(rawPySpec) ||
    Boolean(resolvedEnvFile) ||
    customEnvKeys.length > 0;

  let badgeText: string;
  if (!isCustom) {
    badgeText = "Env";
  } else {
    const parts: string[] = [];
    const cwdShort = basename(resolvedCwd) || resolvedCwd;
    if (resolvedCwd !== resolve(defaultWorkspace) || uiOverride?.cwd) {
      parts.push(cwdShort);
    }
    if (rawPySpec) {
      parts.push("py");
    }
    if (resolvedEnvFile) {
      parts.push(resolvedEnvFile);
    }
    if (customEnvKeys.length > 0) {
      parts.push(`+${customEnvKeys.length} env`);
    }
    badgeText = parts.length > 0 ? parts.join(" · ") : "Custom Env";
  }

  return {
    cwd: resolvedCwd,
    python: pythonRaw,
    pythonRaw,
    pythonEscaped,
    venvDir,
    envFile: resolvedEnvFile,
    customEnvKeys,
    effectiveEnv,
    realEnv,
    rawOverride: uiOverride,
    isCustom,
    hasUiOverride,
    badgeText,
  };
}

export function isFieldVisible(field: FormField, values: Record<string, unknown>): boolean {
  if (!field.when) return true;
  const depVal = values[field.when.field];
  return depVal === field.when.equals;
}

export function extractImplicitDependencies(text: string): {
  contextKeys: string[];
  dataNodeIds: string[];
} {
  const contextKeys = new Set<string>();
  const dataNodeIds = new Set<string>();
  if (!text) return { contextKeys: [], dataNodeIds: [] };

  for (const m of text.matchAll(/\{\{\s*context\.([a-zA-Z0-9_-]+)\s*\}\}/g)) {
    if (m[1]) contextKeys.add(m[1]);
  }
  for (const m of text.matchAll(/\{\{\s*data\.([a-zA-Z0-9_-]+)(?:\.[^}]*)?\s*\}\}/g)) {
    if (m[1]) dataNodeIds.add(m[1]);
  }
  // Also detect ctx.data["nodeId"] or ctx.data.nodeId or ctx.nodes["nodeId"] in TS/Python code
  for (const m of text.matchAll(/ctx\.(?:data|nodes)\[(?:['"])([a-zA-Z0-9_-]+)(?:['"])\]/g)) {
    if (m[1]) dataNodeIds.add(m[1]);
  }
  for (const m of text.matchAll(/ctx\.(?:data|nodes)\.([a-zA-Z0-9_]+)\b/g)) {
    if (m[1]) dataNodeIds.add(m[1]);
  }

  return { contextKeys: [...contextKeys], dataNodeIds: [...dataNodeIds] };
}

export function resolveDataSnapshotPath(
  snapshots: Record<string, DataSnapshot | undefined>,
  expr: string
): string {
  const parts = expr.trim().split(".");
  const nodeId = parts[0] || "";
  const snap = snapshots[nodeId];
  if (!snap || !snap.value) return "";

  if (parts.length === 1) {
    if (snap.shape === "scalar") {
      return snap.value.value !== undefined && snap.value.value !== null
        ? String(snap.value.value)
        : "";
    }
    if (snap.shape === "raw") {
      return String(snap.value.stdout ?? snap.stdout ?? "").trim();
    }
    if (snap.shape === "list" && Array.isArray(snap.value.items)) {
      return snap.value.items.map((it: any) => it.value).join(",");
    }
    if (snap.shape === "table" && Array.isArray(snap.value.rows)) {
      const firstRow = snap.value.rows[0];
      if (!firstRow) return "";
      const firstKey = snap.value.primaryKey || Object.keys(firstRow)[0];
      return firstKey && firstRow[firstKey] !== undefined ? String(firstRow[firstKey]) : "";
    }
    return typeof snap.value === "object" ? JSON.stringify(snap.value) : String(snap.value);
  }

  const traversePath = (root: any): any => {
    let curr = root;
    for (let i = 1; i < parts.length; i++) {
      const key = parts[i]!;
      if (curr === null || curr === undefined) return undefined;
      if (Array.isArray(curr) && /^\d+$/.test(key)) {
        curr = curr[Number(key)];
      } else if (typeof curr === "object" && key in curr) {
        curr = curr[key];
      } else if (
        typeof curr === "object" &&
        curr.record &&
        typeof curr.record === "object" &&
        key in curr.record
      ) {
        curr = curr.record[key];
      } else if (typeof curr === "object" && Array.isArray(curr.rows) && /^\d+$/.test(key)) {
        curr = curr.rows[Number(key)];
      } else {
        return undefined;
      }
    }
    return curr;
  };

  let found = traversePath(snap.value);
  if (found === undefined && snap.rawParsed !== undefined) {
    found = traversePath(snap.rawParsed);
  }

  if (found === null || found === undefined) return "";
  return typeof found === "object" ? JSON.stringify(found) : String(found);
}

export function interpolateBoundTriggerArgs(
  rawArgs: Record<string, unknown> | undefined,
  bindingScope: {
    row?: Record<string, unknown>;
    selectedRows?: Record<string, unknown>[];
    cell?: { rowKey: string; colKey: string; value: unknown };
    node?: {
      id: string;
      label?: string;
      value?: unknown;
      path?: string;
      upstreamIds?: string[];
      downstreamIds?: string[];
    };
    contextValues?: Record<string, unknown>;
    dataSnapshots?: Record<string, DataSnapshot | undefined>;
  }
): Record<string, unknown> {
  if (!rawArgs) return {};
  const out: Record<string, unknown> = {};
  const { row, selectedRows, cell, node, contextValues = {}, dataSnapshots = {} } = bindingScope;

  for (const [k, v] of Object.entries(rawArgs)) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }

    let str = v;
    if (row) {
      str = str.replace(/\{\{\s*row\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, colKey) => {
        const val = row[colKey];
        return val !== undefined && val !== null ? String(val) : "";
      });
    }
    if (selectedRows) {
      str = str.replace(/\{\{\s*selected\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, colKey) => {
        return selectedRows
          .map((r) => r[colKey])
          .filter((val) => val !== undefined && val !== null)
          .map(String)
          .join(",");
      });
    }
    if (cell) {
      str = str
        .replace(/\{\{\s*cell\.rowKey\s*\}\}/g, String(cell.rowKey))
        .replace(/\{\{\s*cell\.colKey\s*\}\}/g, String(cell.colKey))
        .replace(/\{\{\s*cell\.value\s*\}\}/g, cell.value !== undefined && cell.value !== null ? String(cell.value) : "");
    }
    if (node) {
      str = str
        .replace(/\{\{\s*node\.id\s*\}\}/g, String(node.id ?? ""))
        .replace(/\{\{\s*node\.label\s*\}\}/g, String(node.label ?? node.id ?? ""))
        .replace(
          /\{\{\s*node\.value\s*\}\}/g,
          node.value !== undefined && node.value !== null ? String(node.value) : ""
        )
        .replace(/\{\{\s*node\.path\s*\}\}/g, String(node.path ?? node.id ?? ""))
        .replace(/\{\{\s*node\.upstreamIds\s*\}\}/g, (node.upstreamIds || []).join(","))
        .replace(/\{\{\s*node\.downstreamIds\s*\}\}/g, (node.downstreamIds || []).join(","));
    }
    str = str.replace(/\{\{\s*context\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, ctxKey) => {
      const val = contextValues[ctxKey];
      return val !== undefined && val !== null ? String(val) : "";
    });
    str = str.replace(/\{\{\s*data\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, expr) => {
      return resolveDataSnapshotPath(dataSnapshots, expr);
    });

    out[k] = str;
  }

  return out;
}

export interface InterpolatedCommandResult {
  command: string;
  maskedCommand: string;
  cwd: string;
  env: Record<string, string>;
  maskedParams: Record<string, unknown>;
  resolvedEnv: ResolvedCommandEnvSummary;
  venvDir?: string | null;
}

export function interpolateActionCommand(params: {
  action: ActionItem;
  skillDir: string;
  activeWorkspace: string;
  dataDir?: string;
  cacheDir?: string;
  artifactsDir?: string;
  formValues?: Record<string, unknown>;
  contextValues?: Record<string, unknown>;
  dataSnapshots?: Record<string, DataSnapshot | undefined>;
  skillDefaultEnv?: Record<string, string>;
  secretKeys?: Set<string>;
  uiEnvOverride?: CommandEnvConfig;
  humanApproved?: boolean;
  previewOnly?: boolean;
}): InterpolatedCommandResult {
  const {
    action,
    skillDir,
    activeWorkspace,
    dataDir = "",
    cacheDir = "",
    artifactsDir = "",
    formValues = {},
    contextValues = {},
    dataSnapshots = {},
    skillDefaultEnv,
    secretKeys,
    uiEnvOverride,
    humanApproved = false,
    previewOnly = false,
  } = params;

  if (!previewOnly) {
    if ((action.danger === "danger" || action.requiresHumanApprovalFlag) && !humanApproved) {
      throw new Error(
        `Action "${action.title}" requires explicit human approval before execution.`
      );
    }
  }

  const formEnvSecrets: Record<string, string> = {};
  const maskedParams: Record<string, unknown> = {};
  const realTokens: Record<string, string> = {};
  const maskedTokens: Record<string, string> = {};
  const referencedInTemplate = new Set<string>();

  const engineRoot = getDashboardEngineRoot();
  const manifestCliPath = getManifestCliPath();

  const replaceSandboxTokens = (val: string): string => {
    return val
      .replace(/\{\{\s*skill_dir\s*\}\}/g, skillDir)
      .replace(/\{\{\s*project_root\s*\}\}/g, activeWorkspace)
      .replace(/\{\{\s*dashboard_root\s*\}\}/g, engineRoot)
      .replace(/\{\{\s*manifest_cli\s*\}\}/g, `bun ${manifestCliPath}`)
      .replace(/\{\{\s*data_dir\s*\}\}/g, dataDir)
      .replace(/\{\{\s*cache_dir\s*\}\}/g, cacheDir)
      .replace(/\{\{\s*artifacts_dir\s*\}\}/g, artifactsDir);
  };

  const rawTemplate = action.script || action.command || "";
  for (const m of rawTemplate.matchAll(/\{\{\s*form\.([a-zA-Z0-9_-]+)\s*\}\}/g)) {
    referencedInTemplate.add(m[1]);
  }

  const rawFieldValues: Record<string, string> = {};
  const fields = action.form || [];
  for (const field of fields) {
    if (!isFieldVisible(field, formValues)) {
      realTokens[field.key] = "";
      maskedTokens[field.key] = "";
      continue;
    }

    const rawVal =
      formValues[field.key] !== undefined && formValues[field.key] !== ""
        ? formValues[field.key]
        : field.default;

    if (
      !previewOnly &&
      field.required &&
      (rawVal === undefined || rawVal === null || rawVal === "")
    ) {
      throw new Error(`Required parameter "${field.label || field.key}" is missing.`);
    }

    if (field.type === "env-secret") {
      const secretStr = rawVal !== undefined && rawVal !== null ? String(rawVal) : "";
      maskedParams[field.key] = secretStr ? "********" : "";
      if (secretStr) {
        const envKey = field.envVar || field.key.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
        formEnvSecrets[envKey] = secretStr;
        if (field.flag) {
          realTokens[field.key] = `${field.flag} ${shellEscape(secretStr)}`;
          maskedTokens[field.key] = `${field.flag} ********`;
        } else {
          realTokens[field.key] = "";
          maskedTokens[field.key] = "";
        }
      } else {
        realTokens[field.key] = "";
        maskedTokens[field.key] = "";
      }
      continue;
    }

    maskedParams[field.key] = rawVal;

    if (field.type === "boolean") {
      const truthy = rawVal === true || rawVal === "true" || rawVal === 1;
      const token = truthy ? field.flag || `--${field.key}` : "";
      realTokens[field.key] = token;
      maskedTokens[field.key] = token;
      continue;
    }

    if (rawVal === undefined || rawVal === null || rawVal === "") {
      realTokens[field.key] = "";
      maskedTokens[field.key] = "";
      continue;
    }

    if (field.type === "multi-select" && Array.isArray(rawVal)) {
      if (rawVal.length === 0) {
        realTokens[field.key] = "";
        maskedTokens[field.key] = "";
      } else {
        const joinedRaw = rawVal.map(String).join(",");
        rawFieldValues[field.key] = joinedRaw;
        const joined = shellEscape(joinedRaw);
        const token = field.flag ? `${field.flag} ${joined}` : joined;
        realTokens[field.key] = token;
        maskedTokens[field.key] = token;
      }
      continue;
    }

    const strVal = replaceSandboxTokens(String(rawVal).trim());
    if (!strVal) {
      realTokens[field.key] = "";
      maskedTokens[field.key] = "";
      continue;
    }

    rawFieldValues[field.key] = strVal;
    const escaped = shellEscape(strVal);
    const flagPrecedesRegex = new RegExp(
      `${field.flag ? field.flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "__NONE__"}\\s*=\\s*\\{\\{\\s*form\\.${field.key}\\s*\\}\\}|${field.flag ? field.flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "__NONE__"}\\s+\\{\\{\\s*form\\.${field.key}\\s*\\}\\}`
    );
    const includeFlag = Boolean(field.flag && !field.positional && !flagPrecedesRegex.test(rawTemplate));
    const token = includeFlag ? `${field.flag} ${escaped}` : escaped;
    realTokens[field.key] = token;
    maskedTokens[field.key] = token;
  }

  // Resolve command environment after computing rawFieldValues
  const interpolateToken = (raw: string, baseCwd: string): string => {
    let res = raw
      .replace(/\{\{\s*skill_dir\s*\}\}/g, skillDir)
      .replace(/\{\{\s*project_root\s*\}\}/g, baseCwd || activeWorkspace)
      .replace(/\{\{\s*dashboard_root\s*\}\}/g, engineRoot)
      .replace(/\{\{\s*manifest_cli\s*\}\}/g, `bun ${manifestCliPath}`)
      .replace(/\{\{\s*data_dir\s*\}\}/g, dataDir)
      .replace(/\{\{\s*cache_dir\s*\}\}/g, cacheDir)
      .replace(/\{\{\s*artifacts_dir\s*\}\}/g, artifactsDir);

    res = res.replace(/\{\{\s*context\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, k) => {
      const val = contextValues[k];
      return val !== undefined && val !== null ? String(val) : "";
    });

    res = res.replace(/\{\{\s*data\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, expr) => {
      return resolveDataSnapshotPath(dataSnapshots, expr);
    });

    res = res.replace(/\{\{\s*form\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, k) => {
      const val =
        rawFieldValues[k] !== undefined
          ? rawFieldValues[k]
          : formValues[k] !== undefined && formValues[k] !== null
            ? String(formValues[k])
            : "";
      return val;
    });

    return res;
  };

  const resolvedEnv = resolveCommandEnvironment({
    skillDir,
    defaultWorkspace: activeWorkspace,
    skillDefaultEnv,
    secretKeys,
    yamlConfig: {
      cwd: action.cwd,
      python: action.python,
      envFile: action.envFile,
      env: action.env,
    },
    uiOverride: uiEnvOverride,
    interpolateToken,
  });

  const env: Record<string, string> = {};
  if (dataDir) env.SD_DATA_DIR = dataDir;
  if (cacheDir) env.SD_CACHE_DIR = cacheDir;
  if (artifactsDir) env.SD_ARTIFACTS_DIR = artifactsDir;
  Object.assign(env, resolvedEnv.realEnv);
  // Layer 5 highest priority: form env-secret fields
  Object.assign(env, formEnvSecrets);

  const replaceTemplate = (tokenMap: Record<string, string>) => {
    let out = rawTemplate
      .replace(/\{\{\s*python\s*\}\}/g, (_m, offset, str) =>
        isOffsetInsideDoubleQuotes(str, offset)
          ? escapeForTemplateOffset(str, offset, resolvedEnv.pythonRaw)
          : resolvedEnv.pythonEscaped
      )
      .replace(/\{\{\s*skill_dir\s*\}\}/g, (_m, offset, str) =>
        escapeForTemplateOffset(str, offset, skillDir)
      )
      .replace(/\{\{\s*project_root\s*\}\}/g, (_m, offset, str) =>
        escapeForTemplateOffset(str, offset, activeWorkspace)
      )
      .replace(/\{\{\s*dashboard_root\s*\}\}/g, (_m, offset, str) =>
        escapeForTemplateOffset(str, offset, engineRoot)
      )
      .replace(/\{\{\s*manifest_cli\s*\}\}/g, (_m, offset, str) =>
        isOffsetInsideDoubleQuotes(str, offset)
          ? `bun ${escapeForTemplateOffset(str, offset, manifestCliPath)}`
          : `bun ${shellEscape(manifestCliPath)}`
      )
      .replace(/\{\{\s*data_dir\s*\}\}/g, (_m, offset, str) =>
        dataDir ? escapeForTemplateOffset(str, offset, dataDir) : ""
      )
      .replace(/\{\{\s*cache_dir\s*\}\}/g, (_m, offset, str) =>
        cacheDir ? escapeForTemplateOffset(str, offset, cacheDir) : ""
      )
      .replace(/\{\{\s*artifacts_dir\s*\}\}/g, (_m, offset, str) =>
        artifactsDir ? escapeForTemplateOffset(str, offset, artifactsDir) : ""
      );

    out = out.replace(/\{\{\s*context\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, k, offset, str) => {
      const ctxVal = contextValues[k];
      return ctxVal !== undefined && ctxVal !== null && ctxVal !== ""
        ? escapeForTemplateOffset(str, offset, String(ctxVal))
        : "";
    });

    out = out.replace(/\{\{\s*data\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, expr, offset, str) => {
      const resolved = resolveDataSnapshotPath(dataSnapshots, expr);
      return resolved !== "" ? escapeForTemplateOffset(str, offset, resolved) : "";
    });

    out = out.replace(/\{\{\s*form\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, k, offset, str) => {
      if (isOffsetInsideDoubleQuotes(str, offset)) {
        const unquoted =
          rawFieldValues[k] !== undefined
            ? rawFieldValues[k]
            : formValues[k] !== undefined && formValues[k] !== null
              ? String(formValues[k])
              : "";
        return escapeForTemplateOffset(str, offset, unquoted);
      }
      if (tokenMap[k] !== undefined) return tokenMap[k];
      const extra = formValues[k];
      return extra !== undefined && extra !== null && extra !== "" ? shellEscape(String(extra)) : "";
    });

    for (const field of fields) {
      if (!referencedInTemplate.has(field.key) && tokenMap[field.key]) {
        out += ` ${tokenMap[field.key]}`;
      }
    }

    if (action.requiresHumanApprovalFlag && (humanApproved || previewOnly)) {
      if (!out.includes(action.requiresHumanApprovalFlag)) {
        out += ` ${action.requiresHumanApprovalFlag}`;
      }
    }

    if (out.includes("\n")) {
      return out
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/g, ""))
        .join("\n")
        .trim();
    }

    return out.replace(/[ \t]+/g, " ").trim();
  };

  return {
    command: replaceTemplate(realTokens),
    maskedCommand: replaceTemplate(maskedTokens),
    cwd: resolvedEnv.cwd,
    env,
    maskedParams,
    resolvedEnv,
    venvDir: resolvedEnv.venvDir,
  };
}

export function isExplicitTreeNodeArray(data: unknown): boolean {
  return (
    Array.isArray(data) &&
    data.length > 0 &&
    data.every(
      (it) =>
        it &&
        typeof it === "object" &&
        "label" in it &&
        ("children" in it || "id" in it || "meta" in it || "tone" in it)
    )
  );
}

export function normalizeExplicitTreeNodes(nodes: any[], parentPath = ""): TreeNodeItem[] {
  return nodes.map((n, idx) => {
    const id = String(n.id ?? `${parentPath ? parentPath + "." : ""}${idx}`);
    const currentPath = n.path ? String(n.path) : parentPath ? `${parentPath}.${id}` : id;
    const children = Array.isArray(n.children)
      ? normalizeExplicitTreeNodes(n.children, currentPath)
      : undefined;
    return {
      id,
      label: String(n.label ?? id),
      value:
        typeof n.value === "string" || typeof n.value === "number" || typeof n.value === "boolean"
          ? n.value
          : undefined,
      meta: n.meta != null ? String(n.meta) : undefined,
      tone: n.tone,
      path: currentPath,
      actionId: n.actionId,
      args: n.args,
      children,
    };
  });
}

export function buildTreeFromArbitraryData(
  data: unknown,
  parentPath = "",
  maxDepth = 8,
  depth = 0
): TreeNodeItem[] {
  if (data === null || data === undefined) return [];
  if (depth >= maxDepth) {
    return [
      {
        id: parentPath || "leaf",
        label: JSON.stringify(data),
        path: parentPath || "leaf",
      },
    ];
  }
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Array.isArray((data as any).roots)
  ) {
    return normalizeExplicitTreeNodes((data as any).roots, parentPath);
  }
  if (isExplicitTreeNodeArray(data)) {
    return normalizeExplicitTreeNodes(data as any[], parentPath);
  }
  if (Array.isArray(data)) {
    return data.map((item, idx) => {
      const currentPath = parentPath ? `${parentPath}[${idx}]` : `[${idx}]`;
      if (item !== null && typeof item === "object") {
        const summary =
          (item as any).title ||
          (item as any).label ||
          (item as any).name ||
          (item as any).id ||
          `[${idx}]`;
        const nodeId = String((item as any).id ?? currentPath);
        return {
          id: nodeId,
          label: String(summary),
          path: currentPath,
          meta: Array.isArray(item)
            ? `${item.length} items`
            : `${Object.keys(item).length} keys`,
          children: buildTreeFromArbitraryData(item, currentPath, maxDepth, depth + 1),
        };
      }
      return {
        id: currentPath,
        label: `[${idx}]`,
        value: String(item),
        path: currentPath,
      };
    });
  }
  if (typeof data === "object") {
    return Object.entries(data as Record<string, unknown>).map(([k, v]) => {
      const currentPath = parentPath ? `${parentPath}.${k}` : k;
      if (v !== null && typeof v === "object") {
        const count = Array.isArray(v)
          ? `${v.length} items`
          : `${Object.keys(v).length} keys`;
        return {
          id: currentPath,
          label: k,
          path: currentPath,
          meta: count,
          children: buildTreeFromArbitraryData(v, currentPath, maxDepth, depth + 1),
        };
      }
      return {
        id: currentPath,
        label: k,
        value: v === null ? "null" : (v as string | number | boolean),
        path: currentPath,
      };
    });
  }
  return [{ id: parentPath || "root", label: String(data), path: parentPath || "root" }];
}

export function collectTreeLeafOptions(roots: TreeNodeItem[]): FormFieldOption[] {
  const out: FormFieldOption[] = [];
  const walk = (nodes: TreeNodeItem[]) => {
    for (const n of nodes) {
      if (n.children && n.children.length > 0) {
        walk(n.children);
      } else {
        const val = n.value !== undefined ? String(n.value) : n.id;
        out.push({
          value: val,
          label: n.path ? `${n.path}: ${n.label}` : n.label,
          meta: n.meta,
        });
      }
    }
  };
  walk(roots);
  return out;
}

export function computeGraphTopology(
  rawNodes: any[],
  rawEdges: any[]
): {
  nodes: GraphNodeItem[];
  edges: GraphEdgeItem[];
} {
  const nodeMap = new Map<string, GraphNodeItem>();
  for (const n of rawNodes || []) {
    if (!n || typeof n !== "object") continue;
    const id = String(n.id ?? n.name ?? n.value ?? "");
    if (!id) continue;
    nodeMap.set(id, {
      id,
      label: String(n.label ?? n.title ?? id),
      value: n.value != null ? String(n.value) : id,
      meta: n.meta != null ? String(n.meta) : undefined,
      group: n.group != null ? String(n.group) : undefined,
      tone: n.tone || "neutral",
      layer: typeof n.layer === "number" ? n.layer : undefined,
      actionId: n.actionId,
      args: n.args,
    });
  }

  const edges: GraphEdgeItem[] = [];
  for (const e of rawEdges || []) {
    if (!e || typeof e !== "object") continue;
    const source = String(e.source ?? e.from ?? "");
    const target = String(e.target ?? e.to ?? "");
    if (!source || !target) continue;
    if (!nodeMap.has(source)) {
      nodeMap.set(source, { id: source, label: source, value: source, tone: "neutral" });
    }
    if (!nodeMap.has(target)) {
      nodeMap.set(target, { id: target, label: target, value: target, tone: "neutral" });
    }
    edges.push({
      source,
      target,
      label: e.label != null ? String(e.label) : undefined,
      animated: Boolean(e.animated),
      tone: e.tone,
    });
  }

  const adjOut = new Map<string, Set<string>>();
  const adjIn = new Map<string, Set<string>>();
  for (const id of nodeMap.keys()) {
    adjOut.set(id, new Set());
    adjIn.set(id, new Set());
  }
  for (const e of edges) {
    if (e.source === e.target) continue;
    adjOut.get(e.source)!.add(e.target);
    adjIn.get(e.target)!.add(e.source);
  }

  const inDegree = new Map<string, number>();
  const computedLayer = new Map<string, number>();
  for (const [id, ins] of adjIn.entries()) {
    inDegree.set(id, ins.size);
    computedLayer.set(id, 0);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const visitedKahn = new Set<string>();
  while (queue.length > 0) {
    const u = queue.shift()!;
    visitedKahn.add(u);
    const uLayer = computedLayer.get(u) || 0;
    for (const v of adjOut.get(u) || []) {
      computedLayer.set(v, Math.max(computedLayer.get(v) || 0, uLayer + 1));
      const nextDeg = (inDegree.get(v) || 0) - 1;
      inDegree.set(v, nextDeg);
      if (nextDeg === 0) queue.push(v);
    }
  }

  let fallbackLayer = Math.max(0, ...computedLayer.values()) + 1;
  for (const id of nodeMap.keys()) {
    if (!visitedKahn.has(id)) {
      computedLayer.set(id, fallbackLayer++);
    }
  }

  const collectReachable = (startId: string, adj: Map<string, Set<string>>): string[] => {
    const visited = new Set<string>();
    const q = [...(adj.get(startId) || [])];
    while (q.length > 0) {
      const curr = q.shift()!;
      if (curr === startId || visited.has(curr)) continue;
      visited.add(curr);
      for (const nxt of adj.get(curr) || []) {
        if (!visited.has(nxt) && nxt !== startId) q.push(nxt);
      }
    }
    return [...visited];
  };

  const finalNodes: GraphNodeItem[] = [];
  for (const [id, node] of nodeMap.entries()) {
    finalNodes.push({
      ...node,
      layer: node.layer !== undefined ? node.layer : (computedLayer.get(id) ?? 0),
      upstreamIds: collectReachable(id, adjIn),
      downstreamIds: collectReachable(id, adjOut),
    });
  }

  return { nodes: finalNodes, edges };
}

export function inferAutoDataShape(data: unknown): Exclude<DataShape, "auto"> {
  if (data === null || data === undefined || typeof data === "string") return "raw";
  if (typeof data === "number" || typeof data === "boolean") return "scalar";
  if (typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.nodes) && Array.isArray(obj.edges)) return "graph";
    if (Array.isArray(obj.roots)) return "tree";
    if ("rowKeys" in obj && "colKeys" in obj && "cells" in obj) return "matrix";
    if ("value" in obj && Object.keys(obj).length <= 4 && typeof obj.value !== "object") {
      return "scalar";
    }
    const vals = Object.values(obj);
    const hasNestedObjectOrArray = vals.some((v) => v !== null && typeof v === "object");
    return hasNestedObjectOrArray ? "tree" : "kv";
  }
  if (Array.isArray(data)) {
    if (isExplicitTreeNodeArray(data)) return "tree";
    if (data.length > 0 && data.every((x) => typeof x !== "object" || x === null)) return "list";
    return "table";
  }
  return "raw";
}

export function evaluateActionPrecondition(
  pre: ActionPrecondition,
  snapshots: Record<string, DataSnapshot | undefined>
): { passed: boolean; actualSummary: string } {
  const snap = snapshots[pre.dataNodeId];
  if (!snap || snap.status === "loading" || snap.status === "idle") {
    return { passed: true, actualSummary: "loading" };
  }
  if (snap.status === "error") {
    return { passed: false, actualSummary: `DataNode "${pre.dataNodeId}" is in error state` };
  }

  if (pre.minRows !== undefined) {
    const rows = Array.isArray(snap.value?.rows)
      ? snap.value.rows.length
      : Array.isArray(snap.value?.items)
        ? snap.value.items.length
        : Array.isArray(snap.value?.nodes)
          ? snap.value.nodes.length
          : Array.isArray(snap.value?.roots)
            ? snap.value.roots.length
            : Array.isArray(snap.rawParsed)
              ? snap.rawParsed.length
              : 0;
    return {
      passed: rows >= pre.minRows,
      actualSummary: `${rows} row(s) (min ${pre.minRows})`,
    };
  }

  const targetVal = pre.field
    ? resolveDataSnapshotPath(snapshots, `${pre.dataNodeId}.${pre.field}`)
    : resolveDataSnapshotPath(snapshots, pre.dataNodeId);

  if (pre.notEmpty) {
    const rowsLen = Array.isArray(snap.value?.rows)
      ? snap.value.rows.length
      : Array.isArray(snap.value?.items)
        ? snap.value.items.length
        : Array.isArray(snap.value?.roots)
          ? snap.value.roots.length
          : Array.isArray(snap.value?.nodes)
            ? snap.value.nodes.length
            : undefined;
    if (rowsLen !== undefined && !pre.field) {
      return { passed: rowsLen > 0, actualSummary: `${rowsLen} items` };
    }
    const nonEmpty = targetVal.trim().length > 0 && targetVal !== "[]" && targetVal !== "{}";
    return { passed: nonEmpty, actualSummary: targetVal || "(empty)" };
  }

  if (pre.equals !== undefined) {
    return {
      passed: String(targetVal) === String(pre.equals),
      actualSummary: targetVal || "(empty)",
    };
  }

  if (pre.notEquals !== undefined) {
    return {
      passed: String(targetVal) !== String(pre.notEquals),
      actualSummary: targetVal || "(empty)",
    };
  }

  if (pre.contains !== undefined) {
    return {
      passed: String(targetVal).includes(pre.contains),
      actualSummary: targetVal || "(empty)",
    };
  }

  return { passed: true, actualSummary: targetVal };
}
