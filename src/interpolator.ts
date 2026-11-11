import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import type { ActionItem, DataSnapshot, FormField } from "./types.ts";

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

export function resolvePythonExecutable(activeWorkspace: string): string {
  let curr = resolve(activeWorkspace);
  for (let i = 0; i < 4; i++) {
    const venvPy = join(curr, ".venv/bin/python");
    if (existsSync(venvPy)) {
      return shellEscape(venvPy);
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return "python3";
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

  let curr: any = snap.value;
  for (let i = 1; i < parts.length; i++) {
    const key = parts[i]!;
    if (curr === null || curr === undefined) return "";
    if (Array.isArray(curr) && /^\d+$/.test(key)) {
      curr = curr[Number(key)];
    } else if (typeof curr === "object" && key in curr) {
      curr = curr[key];
    } else if (snap.shape === "kv" && curr.record && typeof curr.record === "object" && key in curr.record) {
      curr = curr.record[key];
    } else if (snap.shape === "table" && Array.isArray(curr.rows) && /^\d+$/.test(key)) {
      curr = curr.rows[Number(key)];
    } else {
      return "";
    }
  }

  if (curr === null || curr === undefined) return "";
  return typeof curr === "object" ? JSON.stringify(curr) : String(curr);
}

export function interpolateBoundTriggerArgs(
  rawArgs: Record<string, unknown> | undefined,
  bindingScope: {
    row?: Record<string, unknown>;
    selectedRows?: Record<string, unknown>[];
    cell?: { rowKey: string; colKey: string; value: unknown };
    contextValues?: Record<string, unknown>;
    dataSnapshots?: Record<string, DataSnapshot | undefined>;
  }
): Record<string, unknown> {
  if (!rawArgs) return {};
  const out: Record<string, unknown> = {};
  const { row, selectedRows, cell, contextValues = {}, dataSnapshots = {} } = bindingScope;

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

  const pythonExec = resolvePythonExecutable(activeWorkspace);
  const resolvedCwd =
    !action.cwd || action.cwd === "project_root" || action.cwd === "."
      ? activeWorkspace
      : action.cwd === "skill_dir"
        ? skillDir
        : resolve(activeWorkspace, action.cwd);

  const env: Record<string, string> = {};
  if (dataDir) env.SD_DATA_DIR = dataDir;
  if (cacheDir) env.SD_CACHE_DIR = cacheDir;
  if (artifactsDir) env.SD_ARTIFACTS_DIR = artifactsDir;
  const maskedParams: Record<string, unknown> = {};
  const realTokens: Record<string, string> = {};
  const maskedTokens: Record<string, string> = {};
  const referencedInTemplate = new Set<string>();

  const replaceSandboxTokens = (val: string): string => {
    return val
      .replace(/\{\{\s*skill_dir\s*\}\}/g, skillDir)
      .replace(/\{\{\s*project_root\s*\}\}/g, activeWorkspace)
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
        env[envKey] = secretStr;
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

  const replaceTemplate = (tokenMap: Record<string, string>) => {
    let out = rawTemplate
      .replace(/\{\{\s*python\s*\}\}/g, pythonExec)
      .replace(/\{\{\s*skill_dir\s*\}\}/g, (_m, offset, str) =>
        escapeForTemplateOffset(str, offset, skillDir)
      )
      .replace(/\{\{\s*project_root\s*\}\}/g, (_m, offset, str) =>
        escapeForTemplateOffset(str, offset, activeWorkspace)
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
    cwd: resolvedCwd,
    env,
    maskedParams,
  };
}
