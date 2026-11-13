import { Database } from "bun:sqlite";
import * as fsModule from "fs";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "fs";
import * as osModule from "os";
import { tmpdir } from "os";
import * as pathModule from "path";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "path";
import YAML from "yaml";
import {
  buildTreeFromArbitraryData,
  collectTreeLeafOptions,
  computeGraphTopology,
  extractImplicitDependencies,
  getDashboardEngineRoot,
  getManifestCliPath,
  inferAutoDataShape,
  resolveCommandEnvironment,
  resolveDataSnapshotPath,
  resolvePythonExecutable,
  shellEscape,
  type ResolvedCommandEnvironment,
} from "./interpolator.ts";

export {
  buildTreeFromArbitraryData,
  collectTreeLeafOptions,
  computeGraphTopology,
  inferAutoDataShape,
};
import {
  ensureUnitSandboxPaths,
  resolveDashboardPaths,
  type DashboardPaths,
} from "./paths.ts";
import type {
  ActionGroup,
  ActionItem,
  ActionOutput,
  CanonicalSkill,
  DataNode,
  DataParser,
  DataShape,
  DataSnapshot,
  DataTransform,
  FormFieldOption,
  TableColumn,
} from "./types.ts";

const tsTranspiler = new Bun.Transpiler({ loader: "ts" });

export function rewriteStaticImportsToDynamic(code: string): string {
  return code
    .replace(/^\s*import\s+type\s+[^\n;]+;?/gm, "")
    .replace(
      /^\s*import\s+\{\s*([^}]+)\s*\}\s*from\s*["']([^"']+)["']\s*;?/gm,
      (_m, specifiers, mod) => {
        const mapped = specifiers
          .split(",")
          .map((s: string) => s.trim().replace(/\btype\s+/g, ""))
          .filter(Boolean)
          .map((s: string) => s.replace(/\s+as\s+/g, ": "))
          .join(", ");
        return `const { ${mapped} } = await import(${JSON.stringify(mod)});`;
      }
    )
    .replace(
      /^\s*import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s*["']([^"']+)["']\s*;?/gm,
      (_m, ns, mod) => `const ${ns} = await import(${JSON.stringify(mod)});`
    )
    .replace(
      /^\s*import\s+([A-Za-z0-9_$]+)\s+from\s*["']([^"']+)["']\s*;?/gm,
      (_m, defName, mod) =>
        `const __mod_${defName} = await import(${JSON.stringify(mod)}); const ${defName} = __mod_${defName}.default ?? __mod_${defName};`
    );
}

export async function executeInlineTypeScript(params: {
  code: string;
  ctxObj: Record<string, any>;
  prelude: boolean;
}): Promise<any> {
  const rewritten = rewriteStaticImportsToDynamic(params.code);
  const wrappedTs = `async function __sd_inner() {\n${rewritten}\n}\n`;
  const jsCode = tsTranspiler.transformSync(wrappedTs) + "\nreturn await __sd_inner();";
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  if (params.prelude) {
    const fn = new AsyncFunction(
      "ctx",
      "Bun",
      "__sd_p",
      `const { fs, path, os, Database, YAML, $ } = __sd_p;\nconst { input, rawStdout, context, data, nodes } = ctx || {};\n${jsCode}`
    );
    return await fn(params.ctxObj, Bun, {
      fs: fsModule,
      path: pathModule,
      os: osModule,
      Database,
      YAML,
      $: Bun.$,
    });
  }

  const fn = new AsyncFunction(
    "ctx",
    "Bun",
    `const { input, rawStdout, context, data, nodes } = ctx || {};\n${jsCode}`
  );
  return await fn(params.ctxObj, Bun);
}

export function parseWhitespaceTable(raw: string): {
  columns: string[];
  rows: Record<string, string>[];
} {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { columns: [], rows: [] };

  const headerLine = lines[0]!;
  // Split columns by 2+ spaces when present so multi-word cells (like "3 (1m ago)") stay intact
  if (/\s{2,}/.test(headerLine)) {
    const columns = headerLine
      .trim()
      .split(/\s{2,}/)
      .map((s) => s.trim())
      .filter(Boolean);
    const rows = lines.slice(1).map((line) => {
      const parts = line
        .trim()
        .split(/\s{2,}/)
        .map((s) => s.trim());
      const rec: Record<string, string> = {};
      columns.forEach((col, i) => {
        rec[col] = i === columns.length - 1 ? parts.slice(i).join(" ") : (parts[i] ?? "");
      });
      return rec;
    });
    return { columns, rows };
  }

  const columns = headerLine.trim().split(/\s+/);
  const rows = lines.slice(1).map((line) => {
    const parts = line.trim().split(/\s+/);
    const rec: Record<string, string> = {};
    columns.forEach((col, i) => {
      rec[col] = i === columns.length - 1 ? parts.slice(i).join(" ") : (parts[i] ?? "");
    });
    return rec;
  });
  return { columns, rows };
}

export function extractJsonRobust(raw: string, subPath?: string): any {
  const trimmed = raw.trim();
  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/);
    let found = false;
    // Try stripping leading log lines first, and also trailing log lines (e.g. SQLAlchemy ROLLBACK after closing brace)
    let endIdx = lines.length - 1;
    while (
      endIdx >= 0 &&
      !lines[endIdx]!.trim().endsWith("}") &&
      !lines[endIdx]!.trim().endsWith("]")
    ) {
      endIdx--;
    }
    const candidateEndIndices =
      endIdx >= 0 && endIdx < lines.length - 1 ? [lines.length - 1, endIdx] : [lines.length - 1];

    outer: for (const lastLine of candidateEndIndices) {
      for (let i = lastLine; i >= 0; i--) {
        const lineTrim = lines[i]!.trim();
        if (lineTrim.startsWith("[") || lineTrim.startsWith("{")) {
          const candidate = lines.slice(i, lastLine + 1).join("\n").trim();
          try {
            parsed = JSON.parse(candidate);
            found = true;
            break outer;
          } catch {}
        }
      }
    }

    if (!found) {
      const objStart = trimmed.indexOf("{");
      const objEnd = trimmed.lastIndexOf("}");
      if (objStart !== -1 && objEnd > objStart) {
        try {
          parsed = JSON.parse(trimmed.slice(objStart, objEnd + 1));
          found = true;
        } catch {}
      }
    }
    if (!found) {
      const arrStart = trimmed.indexOf("[");
      const arrEnd = trimmed.lastIndexOf("]");
      if (arrStart !== -1 && arrEnd > arrStart) {
        try {
          parsed = JSON.parse(trimmed.slice(arrStart, arrEnd + 1));
          found = true;
        } catch {}
      }
    }
    if (!found) throw new Error("No valid JSON found in output");
  }

  if (subPath && parsed && typeof parsed === "object") {
    for (const part of subPath.split(".").filter(Boolean)) {
      parsed = parsed?.[part];
    }
  }
  return parsed;
}

export function parseDelimitedTable(raw: string, delimiter = ","): Record<string, string>[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const splitLine = (line: string) =>
    line.split(delimiter).map((cell) => cell.trim().replace(/^["']|["']$/g, ""));
  const headers = splitLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const cells = splitLine(line);
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      rec[h] = cells[i] ?? "";
    });
    return rec;
  });
}

export function foldNdjsonStream(raw: string, primaryKey = "id"): Record<string, unknown>[] {
  const map = new Map<string, Record<string, unknown>>();
  const unkeyed: Record<string, unknown>[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (!obj || typeof obj !== "object") {
        unkeyed.push({ value: obj });
        continue;
      }
      if (obj.op === "reset" && Array.isArray(obj.rows)) {
        map.clear();
        unkeyed.length = 0;
        for (const r of obj.rows) {
          if (r && typeof r === "object" && r[primaryKey] != null) {
            map.set(String(r[primaryKey]), r);
          } else {
            unkeyed.push(r);
          }
        }
      } else if (obj.op === "upsert" && obj.row && typeof obj.row === "object") {
        const k = String(obj.row[primaryKey] ?? obj.key ?? "");
        if (k) map.set(k, { ...(map.get(k) || {}), ...obj.row });
        else unkeyed.push(obj.row);
      } else if (obj.op === "patch" && obj.key != null && obj.patch && typeof obj.patch === "object") {
        const k = String(obj.key);
        map.set(k, { [primaryKey]: obj.key, ...(map.get(k) || {}), ...obj.patch });
      } else if (obj.op === "delete" && obj.key != null) {
        map.delete(String(obj.key));
      } else if (obj[primaryKey] != null) {
        const k = String(obj[primaryKey]);
        map.set(k, { ...(map.get(k) || {}), ...obj });
      } else {
        unkeyed.push(obj);
      }
    } catch {
      unkeyed.push({ line: t });
    }
  }
  return [...map.values(), ...unkeyed];
}

export function parseRawOutput(raw: string, parser?: DataParser, primaryKey = "id"): any {
  const format = parser?.format || "auto";
  const trimmed = raw.trim();

  if (format === "raw") return raw;
  if (format === "lines") {
    return trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  if (format === "json") {
    return extractJsonRobust(trimmed, parser?.path);
  }
  if (format === "jsonl") {
    return foldNdjsonStream(trimmed, primaryKey);
  }
  if (format === "csv") return parseDelimitedTable(trimmed, parser?.delimiter || ",");
  if (format === "tsv") return parseDelimitedTable(trimmed, "\t");
  if (format === "whitespace-table") return parseWhitespaceTable(trimmed).rows;
  if (format === "kv") {
    const sep = parser?.delimiter || "=";
    const rec: Record<string, string> = {};
    for (const line of trimmed.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#")) continue;
      const idx = clean.indexOf(sep) !== -1 ? clean.indexOf(sep) : clean.indexOf(":");
      if (idx > 0) {
        const k = clean.slice(0, idx).trim();
        const v = clean.slice(idx + 1).trim();
        rec[k] = v;
      }
    }
    return rec;
  }
  if (format === "regex" && parser?.pattern) {
    const rx = new RegExp(parser.pattern);
    const matches: Record<string, string>[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const m = rx.exec(line);
      if (m) {
        if (m.groups && Object.keys(m.groups).length > 0) {
          matches.push({ ...m.groups } as Record<string, string>);
        } else {
          const rec: Record<string, string> = { match: m[0] };
          m.slice(1).forEach((g, idx) => {
            rec[`group_${idx + 1}`] = g ?? "";
          });
          matches.push(rec);
        }
      }
    }
    return matches;
  }

  // auto mode
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try {
      return extractJsonRobust(trimmed, parser?.path);
    } catch {}
  }
  return raw;
}

export function inferTableColumns(rows: Record<string, unknown>[], declared?: TableColumn[]): TableColumn[] {
  if (declared && declared.length > 0) return declared;
  const first = rows[0];
  if (!first || typeof first !== "object") return [];
  return Object.keys(first).map((key) => {
    const sample = first[key];
    const lower = key.toLowerCase();
    const type =
      typeof sample === "boolean"
        ? "boolean"
        : typeof sample === "number" && /progress|percent|ratio/i.test(lower)
          ? "progress"
          : typeof sample === "number"
            ? "number"
            : /status|state|tone|env|badge|sizeformatted/i.test(lower)
              ? "badge"
              : /time|date|updated|created|mtime/i.test(lower)
                ? "datetime"
                : /name|id|file|path|pod|cmd|slice/i.test(lower)
                  ? "code"
                  : "text";
    return {
      key,
      label: key.replace(/([A-Z])/g, " $1").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()),
      type,
    };
  });
}

export function normalizeToShapeAndOptions(params: {
  data: any;
  rawStdout: string;
  rawStderr: string;
  exitCode: number;
  shape: DataShape;
  node?: Partial<DataNode>;
}): { value: any; options: FormFieldOption[]; resolvedShape: DataShape } {
  const { data, rawStdout, rawStderr, exitCode, shape: rawShape, node } = params;
  const shape: DataShape = rawShape === "auto" ? inferAutoDataShape(data) : rawShape;
  const valCol = node?.valueColumn || node?.primaryKey || "value";
  const lblCol = node?.labelColumn || "label";
  const metaCol = node?.metaColumn;

  if (shape === "raw") {
    const text = typeof data === "string" ? data : rawStdout || JSON.stringify(data, null, 2);
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      value: { stdout: text, stderr: rawStderr, exitCode },
      options: lines.map((l) => ({ label: l, value: l })),
      resolvedShape: "raw",
    };
  }

  if (shape === "stream") {
    if (Array.isArray(data)) {
      const columns = inferTableColumns(data as Record<string, unknown>[], node?.columns);
      const pk = node?.primaryKey || columns[0]?.key || "id";
      return {
        value: {
          stdout: rawStdout,
          stderr: rawStderr,
          exitCode,
          columns,
          rows: data,
          primaryKey: pk,
        },
        options: data
          .map((r: any) => (r && r[pk] != null ? { label: String(r[pk]), value: String(r[pk]) } : null))
          .filter(Boolean) as FormFieldOption[],
        resolvedShape: "stream",
      };
    }
    const text = typeof data === "string" ? data : rawStdout || JSON.stringify(data, null, 2);
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      value: { stdout: text, stderr: rawStderr, exitCode },
      options: lines.map((l) => ({ label: l, value: l })),
      resolvedShape: "stream",
    };
  }

  if (shape === "scalar") {
    if (data && typeof data === "object" && !Array.isArray(data) && "value" in data) {
      const sv = String(data.value ?? "");
      return {
        value: {
          value: data.value,
          unit: data.unit,
          label: data.label || node?.title,
          tone: data.tone || "neutral",
        },
        options: sv ? [{ label: sv, value: sv }] : [],
        resolvedShape: "scalar",
      };
    }
    const prim =
      typeof data === "number" || typeof data === "boolean"
        ? data
        : String(data ?? rawStdout).trim();
    return {
      value: { value: prim, label: node?.title, tone: "neutral" },
      options: String(prim) ? [{ label: String(prim), value: String(prim) }] : [],
      resolvedShape: "scalar",
    };
  }

  if (shape === "kv") {
    const hasCustomEntries =
      data && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.entries);
    const rec: Record<string, unknown> =
      data && typeof data === "object" && !Array.isArray(data)
        ? "record" in data && data.record && typeof data.record === "object"
          ? data.record
          : hasCustomEntries
            ? Object.fromEntries(data.entries.map((e: any) => [String(e.key), e.value]))
            : data
        : { output: String(data ?? rawStdout).trim() };
    const entries = hasCustomEntries
      ? data.entries.map((e: any) => {
          const isComplex = typeof e.value === "object" && e.value !== null;
          return {
            key: String(e.key ?? ""),
            label: String(e.label ?? e.key ?? ""),
            value: isComplex ? JSON.stringify(e.value) : (e.value as string | number | boolean),
            rawValue: isComplex ? e.value : e.rawValue,
            tone: e.tone,
          };
        })
      : Object.entries(rec).map(([k, v]) => {
          const isComplex = typeof v === "object" && v !== null;
          return {
            key: k,
            label: k,
            value: isComplex ? JSON.stringify(v) : (v as string | number | boolean),
            rawValue: isComplex ? v : undefined,
          };
        });
    return {
      value: { entries, record: rec },
      options: entries.map((e: any) => ({
        label: `${e.label || e.key}: ${e.value}`,
        value: String(e.value),
      })),
      resolvedShape: "kv",
    };
  }

  if (shape === "tree") {
    const roots = buildTreeFromArbitraryData(data);
    const options = collectTreeLeafOptions(roots);
    return {
      value: { roots },
      options,
      resolvedShape: "tree",
    };
  }

  if (shape === "graph") {
    const rawNodes = Array.isArray(data?.nodes)
      ? data.nodes
      : Array.isArray(data)
        ? data
        : [];
    const rawEdges = Array.isArray(data?.edges) ? data.edges : [];
    const topo = computeGraphTopology(rawNodes, rawEdges);
    return {
      value: topo,
      options: topo.nodes.map((n) => ({
        value: n.value || n.id,
        label: n.meta && !n.label.includes(n.meta) ? `${n.label} (${n.meta})` : n.label,
        meta: n.meta,
      })),
      resolvedShape: "graph",
    };
  }

  if (shape === "list") {
    const arr = Array.isArray(data)
      ? data
      : typeof data === "string"
        ? data
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    const items = arr.map((it: any) => {
      if (typeof it === "object" && it !== null) {
        const v = String(it[valCol] ?? it.value ?? it.name ?? it.id ?? JSON.stringify(it));
        const l = String(it[lblCol] ?? it.label ?? it.title ?? v);
        const m = metaCol && it[metaCol] !== undefined ? String(it[metaCol]) : it.meta ? String(it.meta) : undefined;
        return { value: v, label: l, meta: m, raw: it };
      }
      return { value: String(it), label: String(it) };
    });
    return {
      value: { items },
      options: items.map((it) => ({
        value: it.value,
        label: it.meta ? `${it.label} (${it.meta})` : it.label,
        meta: it.meta,
      })),
      resolvedShape: "list",
    };
  }

  if (shape === "matrix") {
    if (data && typeof data === "object" && "rowKeys" in data && "colKeys" in data && "cells" in data) {
      return {
        value: data,
        options: Array.isArray(data.rowKeys)
          ? data.rowKeys.map((rk: string) => ({ label: String(rk), value: String(rk) }))
          : [],
        resolvedShape: "matrix",
      };
    }
    const rows: Record<string, any>[] = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
    const rKey = node?.pivot?.rowKey || "row";
    const cKey = node?.pivot?.colKey || "col";
    const vKey = node?.pivot?.valueKey || "value";
    const rowSet = new Set<string>();
    const colSet = new Set<string>();
    const cells: Record<string, Record<string, unknown>> = {};
    for (const r of rows) {
      const rk = String(r[rKey] ?? "");
      const ck = String(r[cKey] ?? "");
      if (!rk || !ck) continue;
      rowSet.add(rk);
      colSet.add(ck);
      cells[rk] = cells[rk] || {};
      cells[rk]![ck] = r[vKey];
    }
    return {
      value: { rowKeys: [...rowSet], colKeys: [...colSet], cells },
      options: [...rowSet].map((rk) => ({ label: rk, value: rk })),
      resolvedShape: "matrix",
    };
  }

  // Default to "table"
  let rows: Record<string, unknown>[] = [];
  if (Array.isArray(data)) {
    rows = data.map((item) =>
      item && typeof item === "object" ? (item as Record<string, unknown>) : { value: item }
    );
  } else if (data && typeof data === "object" && Array.isArray(data.rows)) {
    rows = data.rows;
  } else if (typeof data === "string" && data.trim()) {
    rows = parseWhitespaceTable(data).rows;
  }

  const columns = inferTableColumns(rows, node?.columns);
  const firstColKey = columns[0]?.key || "value";
  const effectiveValCol = node?.valueColumn || node?.primaryKey || firstColKey;
  const effectiveLblCol = node?.labelColumn || effectiveValCol;

  const options: FormFieldOption[] = rows
    .map((r) => {
      const v = r[effectiveValCol] ?? r[firstColKey];
      if (v === undefined || v === null) return null;
      const valStr = String(v);
      const lblStr = String(r[effectiveLblCol] ?? valStr);
      const metaStr = metaCol && r[metaCol] !== undefined ? String(r[metaCol]) : undefined;
      return {
        value: valStr,
        label: metaStr && !lblStr.includes(metaStr) ? `${lblStr} (${metaStr})` : lblStr,
        meta: metaStr,
      };
    })
    .filter(Boolean) as FormFieldOption[];

  return {
    value: {
      columns,
      rows,
      primaryKey: node?.primaryKey || firstColKey,
    },
    options,
    resolvedShape: "table",
  };
}

export class ReactiveGraphEngine {
  private inFlight = new Map<string, Promise<DataSnapshot>>();
  private snapshots = new Map<string, Map<string, DataSnapshot>>();
  private contextState = new Map<string, Record<string, string | boolean>>();
  private watchers = new Map<string, FSWatcher[]>();
  private defaultTtlMs: number;
  private paths: DashboardPaths;
  private maxConcurrentProcesses = 4;
  private activeProcesses = 0;
  private processQueue: Array<() => void> = [];

  private async acquireProcessSlot(): Promise<void> {
    if (this.activeProcesses < this.maxConcurrentProcesses) {
      this.activeProcesses++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.processQueue.push(resolve);
    });
  }

  private releaseProcessSlot(): void {
    if (this.processQueue.length > 0) {
      const next = this.processQueue.shift();
      next?.();
    } else {
      this.activeProcesses = Math.max(0, this.activeProcesses - 1);
    }
  }

  constructor(defaultTtlMs = 15000, paths?: DashboardPaths) {
    this.defaultTtlMs = defaultTtlMs;
    this.paths = paths || resolveDashboardPaths();
  }

  public getContextState(skill: CanonicalSkill): Record<string, string | boolean> {
    const existing = this.contextState.get(skill.id) || {};
    const merged: Record<string, string | boolean> = {};
    for (const field of skill.manifest.context || []) {
      if (existing[field.key] !== undefined) {
        merged[field.key] = existing[field.key]!;
      } else if (field.default !== undefined) {
        merged[field.key] = field.default;
      } else if (field.options && field.options.length > 0) {
        merged[field.key] = field.options[0]!.value;
      } else {
        merged[field.key] = "";
      }
    }
    for (const [k, v] of Object.entries(existing)) {
      if (merged[k] === undefined) merged[k] = v;
    }
    this.contextState.set(skill.id, merged);
    return merged;
  }

  public setContextValue(
    skill: CanonicalSkill,
    key: string,
    value: string | boolean
  ): Record<string, string | boolean> {
    const current = { ...this.getContextState(skill), [key]: value };
    this.contextState.set(skill.id, current);
    this.invalidateByContextKey(skill, key);
    return current;
  }

  public getSkillSnapshots(skillId: string): Record<string, DataSnapshot> {
    const map = this.snapshots.get(skillId);
    if (!map) return {};
    return Object.fromEntries(map.entries());
  }

  public invalidateSkill(skillId: string, preservePassive = true): void {
    if (!preservePassive) {
      this.snapshots.delete(skillId);
      return;
    }
    const skillMap = this.snapshots.get(skillId);
    if (!skillMap) return;
    for (const [nodeId, snap] of skillMap.entries()) {
      if (snap.runtime !== "passive") {
        skillMap.delete(nodeId);
      }
    }
  }

  public invalidateByContextKey(skill: CanonicalSkill, contextKey: string): void {
    const skillMap = this.snapshots.get(skill.id);
    if (!skillMap) return;
    for (const node of skill.manifest.data || []) {
      const deps = this.getNodeDependencies(node);
      if (deps.contextKeys.includes(contextKey)) {
        this.invalidateNodeAndDownstream(skill, node.id);
      }
    }
  }

  public invalidateNodeAndDownstream(skill: CanonicalSkill, nodeId: string, visited = new Set<string>()): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const skillMap = this.snapshots.get(skill.id);
    skillMap?.delete(nodeId);
    for (const n of skill.manifest.data || []) {
      const deps = this.getNodeDependencies(n);
      if (deps.dataNodeIds.includes(nodeId)) {
        this.invalidateNodeAndDownstream(skill, n.id, visited);
      }
    }
  }

  public async onActionCompleted(params: {
    skill: CanonicalSkill;
    actionId: string;
    outputConfig?: ActionOutput;
    rawStdout: string;
  }): Promise<void> {
    const { skill, actionId, outputConfig, rawStdout } = params;
    const intoDataId = outputConfig?.intoData;

    for (const node of skill.manifest.data || []) {
      if (intoDataId && node.id === intoDataId) continue;
      const patterns = node.sync?.invalidateOnActions;
      if (!patterns || patterns.length === 0) {
        if (node.runtime !== "passive") {
          this.invalidateNodeAndDownstream(skill, node.id);
        }
        continue;
      }
      const matched = patterns.some((pat) => {
        if (pat === "*") return true;
        if (pat.endsWith("*")) return actionId.startsWith(pat.slice(0, -1));
        return pat === actionId;
      });
      if (matched) {
        this.invalidateNodeAndDownstream(skill, node.id);
      }
    }

    if (intoDataId) {
      this.invalidateNodeAndDownstream(skill, intoDataId);
      const targetNode = (skill.manifest.data || []).find((n) => n.id === intoDataId);
      const shape = outputConfig.shape || targetNode?.shape || "table";
      try {
        let parsed = parseRawOutput(
          rawStdout,
          outputConfig.parse || targetNode?.parse,
          targetNode?.primaryKey || "id"
        );
        const transform = outputConfig.transform || targetNode?.transform;
        if (transform) {
          parsed = await this.runTransform(skill, transform, parsed, rawStdout);
        }
        const normalized = normalizeToShapeAndOptions({
          data: parsed,
          rawStdout,
          rawStderr: "",
          exitCode: 0,
          shape,
          node: targetNode || { id: intoDataId, title: intoDataId, shape },
        });
        const snap: DataSnapshot = {
          nodeId: intoDataId,
          title: targetNode?.title || intoDataId,
          description: targetNode?.description,
          category: targetNode?.category,
          intermediate: Boolean(targetNode?.intermediate || (targetNode as any)?.hidden),
          rawParsed: parsed,
          consumedBy: this.getReverseConsumers(skill, intoDataId),
          resolvedSource: `(populated by action: ${actionId})`,
          shape: normalized.resolvedShape || shape,
          runtime: targetNode?.runtime || "passive",
          status: "ready",
          value: normalized.value,
          options: normalized.options,
          selectContextKey: targetNode?.selectContextKey,
          quickActions: targetNode?.quickActions || [],
          rowActions: targetNode?.rowActions || [],
          bulkActions: targetNode?.bulkActions || [],
          cellAction: targetNode?.cellAction,
          nodeActions: targetNode?.nodeActions || [],
          stdout: rawStdout,
          stderr: "",
          exitCode: 0,
          timedOut: false,
          durationMs: 0,
          updatedAt: Date.now(),
          fromCache: false,
        };
        let skillMap = this.snapshots.get(skill.id);
        if (!skillMap) {
          skillMap = new Map();
          this.snapshots.set(skill.id, skillMap);
        }
        skillMap.set(intoDataId, snap);
      } catch {}
    }
  }

  public getNodeDependencies(node: DataNode): { contextKeys: string[]; dataNodeIds: string[] } {
    const texts = [
      node.command || "",
      node.script || "",
      node.code || "",
      node.sql || "",
      node.db || "",
      node.filePath || "",
      ...(Array.isArray(node.pattern) ? node.pattern : node.pattern ? [node.pattern] : []),
      node.transform?.code || "",
    ].join("\n");

    const implicit = extractImplicitDependencies(texts);
    const contextKeys = new Set(implicit.contextKeys);
    const dataNodeIds = new Set(implicit.dataNodeIds);

    for (const dep of node.sync?.dependsOn || []) {
      if (dep.startsWith("context.")) {
        contextKeys.add(dep.slice("context.".length));
      } else {
        dataNodeIds.add(dep);
      }
    }

    dataNodeIds.delete(node.id);
    return { contextKeys: [...contextKeys], dataNodeIds: [...dataNodeIds] };
  }

  public getReverseConsumers(skill: CanonicalSkill, nodeId: string): string[] {
    const consumers = new Set<string>();

    for (const otherNode of skill.manifest.data || []) {
      if (
        otherNode.id !== nodeId &&
        this.getNodeDependencies(otherNode).dataNodeIds.includes(nodeId)
      ) {
        consumers.add(`data:${otherNode.id}`);
      }
    }

    for (const cf of skill.manifest.context || []) {
      if (cf.fromData === nodeId) {
        consumers.add(`context:${cf.key}`);
      }
    }

    const collectActions = (groups: ActionGroup[]): ActionItem[] => {
      const result: ActionItem[] = [];
      for (const g of groups) {
        if (g.actions) result.push(...g.actions);
        if (g.subgroups) result.push(...collectActions(g.subgroups));
      }
      return result;
    };

    const allActions = collectActions(skill.manifest.actionGroups || []);
    for (const action of allActions) {
      const hasFromData = (action.form || []).some((f) => f.fromData === nodeId);
      const hasPrecondition = (action.preconditions || []).some((p) => p.dataNodeId === nodeId);
      const scriptText = action.script || action.command || "";
      const hasImplicit = extractImplicitDependencies(scriptText).dataNodeIds.includes(nodeId);
      if (hasFromData || hasPrecondition || hasImplicit) {
        consumers.add(`action:${action.id}`);
      }
    }

    return Array.from(consumers);
  }

  public ensureSkillWatchers(skill: CanonicalSkill): void {
    if (this.watchers.has(skill.id)) return;
    const list: FSWatcher[] = [];
    for (const node of skill.manifest.data || []) {
      const watchPatterns = node.sync?.watchFiles || [];
      for (const rawPat of watchPatterns) {
        const expanded = this.interpolateText(skill, rawPat);
        const targetDir = existsSync(expanded) && statSync(expanded).isDirectory() ? expanded : dirname(expanded);
        if (!existsSync(targetDir)) continue;
        try {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const w = watch(targetDir, () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              this.invalidateNodeAndDownstream(skill, node.id);
            }, 150);
          });
          list.push(w);
        } catch {}
      }
    }
    this.watchers.set(skill.id, list);
  }

  public closeAllWatchers(): void {
    for (const list of this.watchers.values()) {
      for (const w of list) {
        try {
          w.close();
        } catch {}
      }
    }
    this.watchers.clear();
  }

  public async evaluateNode(params: {
    skill: CanonicalSkill;
    nodeId: string;
    force?: boolean;
    visited?: Set<string>;
  }): Promise<DataSnapshot> {
    const { skill, nodeId, force = false, visited = new Set() } = params;
    const node = (skill.manifest.data || []).find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Data node not found: ${nodeId}`);
    }

    if (visited.has(nodeId)) {
      return {
        nodeId: node.id,
        title: node.title,
        description: node.description,
        category: node.category,
        intermediate: Boolean(node.intermediate || (node as any).hidden),
        rawParsed: undefined,
        consumedBy: this.getReverseConsumers(skill, node.id),
        shape: node.shape,
        runtime: node.runtime,
        status: "error",
        value: { stdout: "", stderr: "Circular dependency detected", exitCode: 1 },
        options: [],
        stdout: "",
        stderr: "Circular dependency detected",
        exitCode: 1,
        timedOut: false,
        durationMs: 0,
        updatedAt: Date.now(),
        fromCache: false,
        error: `Circular dependency detected involving "${nodeId}"`,
      };
    }

    this.ensureSkillWatchers(skill);

    const ttlMs = node.sync?.ttlMs ?? this.defaultTtlMs;
    const skillMap = this.snapshots.get(skill.id);
    const cached = skillMap?.get(node.id);
    const now = Date.now();

    if (
      !force &&
      cached &&
      cached.status !== "error" &&
      (node.runtime === "passive" || now - cached.updatedAt < ttlMs)
    ) {
      return { ...cached, fromCache: true };
    }

    const nodeEnv = this.resolveNodeEnvironment(skill, node);
    const ctxState = this.getContextState(skill);
    const flightKey = `${skill.id}:data:${node.id}:${skill.effectiveWorkspace}:${JSON.stringify(ctxState)}:${JSON.stringify({ cwd: nodeEnv.cwd, py: nodeEnv.pythonRaw, env: nodeEnv.realEnv })}`;
    if (this.inFlight.has(flightKey)) {
      return this.inFlight.get(flightKey)!;
    }

    const promise = (async (): Promise<DataSnapshot> => {
      const t0 = performance.now();
      try {
        // 1. Evaluate upstream data dependencies first
        const deps = this.getNodeDependencies(node);
        const nextVisited = new Set(visited);
        nextVisited.add(node.id);

        for (const depId of deps.dataNodeIds) {
          if ((skill.manifest.data || []).some((n) => n.id === depId)) {
            const depSnap = await this.evaluateNode({
              skill,
              nodeId: depId,
              force: force && visited.size === 0,
              visited: nextVisited,
            });
            if (depSnap.error?.includes("Circular dependency")) {
              throw new Error(depSnap.error);
            }
          }
        }

        // 2. Execute runtime
        const execOut = await this.executeNodeRuntime(skill, node);

        // 3. Parse + Transform
        let structuredData = execOut.structured !== undefined
          ? execOut.structured
          : parseRawOutput(execOut.stdout, node.parse, node.primaryKey || "id");

        if (node.transform) {
          structuredData = await this.runTransform(skill, node.transform, structuredData, execOut.stdout);
        }

        const normalized = normalizeToShapeAndOptions({
          data: structuredData,
          rawStdout: execOut.stdout,
          rawStderr: execOut.stderr,
          exitCode: execOut.exitCode,
          shape: node.shape || "raw",
          node,
        });

        const snapshot: DataSnapshot = {
          nodeId: node.id,
          title: node.title,
          description: node.description,
          category: node.category,
          intermediate: Boolean(node.intermediate || (node as any).hidden),
          rawParsed: structuredData,
          consumedBy: this.getReverseConsumers(skill, node.id),
          resolvedEnv: {
            cwd: nodeEnv.cwd,
            python: nodeEnv.python,
            venvDir: nodeEnv.venvDir,
            envFile: nodeEnv.envFile,
            customEnvKeys: nodeEnv.customEnvKeys,
            effectiveEnv: nodeEnv.effectiveEnv,
            rawOverride: nodeEnv.rawOverride,
            isCustom: nodeEnv.isCustom,
            hasUiOverride: nodeEnv.hasUiOverride,
            badgeText: nodeEnv.badgeText,
          },
          resolvedSource: execOut.resolvedSource,
          shape: normalized.resolvedShape || node.shape || "raw",
          runtime: node.runtime || "zsh",
          status: execOut.exitCode === 0 ? "ready" : "error",
          value: normalized.value,
          options: normalized.options,
          selectContextKey: node.selectContextKey,
          quickActions: node.quickActions || [],
          rowActions: node.rowActions || [],
          bulkActions: node.bulkActions || [],
          cellAction: node.cellAction,
          nodeActions: node.nodeActions || [],
          stdout: execOut.stdout,
          stderr: execOut.stderr,
          exitCode: execOut.exitCode,
          timedOut: execOut.timedOut,
          durationMs: Math.round(performance.now() - t0),
          updatedAt: Date.now(),
          fromCache: false,
          error: execOut.exitCode !== 0 ? execOut.stderr || `Exited with code ${execOut.exitCode}` : undefined,
        };

        let map = this.snapshots.get(skill.id);
        if (!map) {
          map = new Map();
          this.snapshots.set(skill.id, map);
        }
        map.set(node.id, snapshot);
        return snapshot;
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        const fallbackSource = this.interpolateText(
          skill,
          node.script ||
            node.command ||
            node.code ||
            node.sql ||
            (Array.isArray(node.pattern) ? node.pattern.join("\n") : node.pattern || node.filePath || ""),
          (node.runtime || "zsh") === "zsh",
          nodeEnv
        );
        const errSnap: DataSnapshot = {
          nodeId: node.id,
          title: node.title,
          description: node.description,
          category: node.category,
          intermediate: Boolean(node.intermediate || (node as any).hidden),
          rawParsed: undefined,
          consumedBy: this.getReverseConsumers(skill, node.id),
          resolvedEnv: {
            cwd: nodeEnv.cwd,
            python: nodeEnv.python,
            venvDir: nodeEnv.venvDir,
            envFile: nodeEnv.envFile,
            customEnvKeys: nodeEnv.customEnvKeys,
            effectiveEnv: nodeEnv.effectiveEnv,
            rawOverride: nodeEnv.rawOverride,
            isCustom: nodeEnv.isCustom,
            hasUiOverride: nodeEnv.hasUiOverride,
            badgeText: nodeEnv.badgeText,
          },
          resolvedSource: fallbackSource || undefined,
          shape: node.shape || "raw",
          runtime: node.runtime || "zsh",
          status: "error",
          value: { stdout: "", stderr: errMsg, exitCode: 1 },
          options: [],
          stdout: "",
          stderr: errMsg,
          exitCode: 1,
          timedOut: false,
          durationMs: Math.round(performance.now() - t0),
          updatedAt: Date.now(),
          fromCache: false,
          error: errMsg,
        };
        let map = this.snapshots.get(skill.id);
        if (!map) {
          map = new Map();
          this.snapshots.set(skill.id, map);
        }
        map.set(node.id, errSnap);
        return errSnap;
      } finally {
        this.inFlight.delete(flightKey);
      }
    })();

    this.inFlight.set(flightKey, promise);
    return promise;
  }

  public async evaluateAllSkillData(params: {
    skill: CanonicalSkill;
    force?: boolean;
  }): Promise<Record<string, DataSnapshot>> {
    const { skill, force = false } = params;
    const nodes = skill.manifest.data || [];
    if (force) {
      this.invalidateSkill(skill.id);
    }
    await Promise.all(
      nodes.map((n) => this.evaluateNode({ skill, nodeId: n.id, force: false }))
    );
    return this.getSkillSnapshots(skill.id);
  }

  public resolveNodeEnvironment(skill: CanonicalSkill, node: DataNode): ResolvedCommandEnvironment {
    const skillDefaultEnv: Record<string, string> = {};
    for (const ev of skill.manifest.envVars || []) {
      if (ev.default !== undefined) skillDefaultEnv[ev.key] = ev.default;
    }
    Object.assign(skillDefaultEnv, skill.configuredEnv);
    const secretKeys = new Set((skill.manifest.envVars || []).filter((e) => e.secret).map((e) => e.key));
    const uiOverride = skill.commandEnvOverrides?.[`data:${node.id}`];

    return resolveCommandEnvironment({
      skillDir: skill.canonicalPath,
      defaultWorkspace: skill.effectiveWorkspace,
      skillDefaultEnv,
      secretKeys,
      yamlConfig: {
        cwd: node.cwd,
        python: node.python,
        envFile: node.envFile,
        env: node.env,
      },
      uiOverride,
      interpolateToken: (raw) => this.interpolateText(skill, raw, false),
    });
  }

  private resolveCwd(skill: CanonicalSkill, cwdSpec?: string): string {
    if (!cwdSpec || cwdSpec === "project_root" || cwdSpec === ".") return skill.effectiveWorkspace;
    if (cwdSpec === "skill_dir") return skill.canonicalPath;
    return resolve(skill.effectiveWorkspace, cwdSpec);
  }

  public interpolateText(
    skill: CanonicalSkill,
    rawText: string,
    escapeTokens = false,
    nodeEnv?: ResolvedCommandEnvironment
  ): string {
    if (!rawText) return "";
    const py = nodeEnv
      ? (escapeTokens ? nodeEnv.pythonEscaped : nodeEnv.pythonRaw)
      : resolvePythonExecutable(skill.effectiveWorkspace);
    const projectRoot = nodeEnv ? nodeEnv.cwd : skill.effectiveWorkspace;
    const ctxState = this.getContextState(skill);
    const snaps = this.getSkillSnapshots(skill.id);
    const sandbox = ensureUnitSandboxPaths(this.paths, skill.id);
    const wrap = (v: string) => (escapeTokens ? shellEscape(v) : v);

    return rawText
      .replace(/\{\{\s*python\s*\}\}/g, py)
      .replace(/\{\{\s*skill_dir\s*\}\}/g, wrap(skill.canonicalPath))
      .replace(/\{\{\s*project_root\s*\}\}/g, wrap(skill.effectiveWorkspace))
      .replace(/\{\{\s*dashboard_root\s*\}\}/g, wrap(getDashboardEngineRoot()))
      .replace(
        /\{\{\s*manifest_cli\s*\}\}/g,
        escapeTokens ? `bun ${shellEscape(getManifestCliPath())}` : `bun ${getManifestCliPath()}`
      )
      .replace(/\{\{\s*data_dir\s*\}\}/g, wrap(sandbox.unitDataDir))
      .replace(/\{\{\s*cache_dir\s*\}\}/g, wrap(sandbox.unitCacheDir))
      .replace(/\{\{\s*artifacts_dir\s*\}\}/g, wrap(sandbox.latestArtifactsLink))
      .replace(/\{\{\s*context\.([a-zA-Z0-9_-]+)\s*\}\}/g, (_m, k) => {
        const val = ctxState[k];
        return val !== undefined && val !== null ? wrap(String(val)) : "";
      })
      .replace(/\{\{\s*data\.([a-zA-Z0-9_.-]+)\s*\}\}/g, (_m, expr) => {
        const val = resolveDataSnapshotPath(snaps, expr);
        return val !== "" ? wrap(val) : "";
      });
  }

  private buildExecutionContext(
    skill: CanonicalSkill,
    extra: Record<string, any> = {},
    nodeEnv?: ResolvedCommandEnvironment
  ) {
    const snaps = this.getSkillSnapshots(skill.id);
    const sandbox = ensureUnitSandboxPaths(this.paths, skill.id);
    const dataValues: Record<string, any> = {};
    for (const [k, s] of Object.entries(snaps)) {
      if (s.intermediate && s.rawParsed !== undefined) {
        dataValues[k] = s.rawParsed;
      } else if (s.shape === "table") {
        dataValues[k] = s.value?.rows || [];
      } else if (s.shape === "kv") {
        dataValues[k] =
          s.value?.record || (s.rawParsed && typeof s.rawParsed === "object" ? s.rawParsed : {});
      } else if (s.shape === "scalar") {
        dataValues[k] = s.value?.value;
      } else if (s.shape === "list") {
        dataValues[k] = s.value?.items || [];
      } else if (s.rawParsed !== undefined) {
        dataValues[k] = s.rawParsed;
      } else {
        dataValues[k] = s.value;
      }
    }
    const cwd = nodeEnv ? nodeEnv.cwd : skill.effectiveWorkspace;
    const python = nodeEnv ? nodeEnv.pythonRaw : resolvePythonExecutable(skill.effectiveWorkspace);
    return {
      skillId: skill.id,
      skillDir: skill.canonicalPath,
      workspace: skill.effectiveWorkspace,
      cwd,
      dataDir: sandbox.unitDataDir,
      cacheDir: sandbox.unitCacheDir,
      artifactsDir: sandbox.latestArtifactsLink,
      python,
      context: this.getContextState(skill),
      data: dataValues,
      nodes: snaps,
      env: {
        SD_DATA_DIR: sandbox.unitDataDir,
        SD_CACHE_DIR: sandbox.unitCacheDir,
        SD_ARTIFACTS_DIR: sandbox.latestArtifactsLink,
        ...skill.configuredEnv,
        ...(nodeEnv ? nodeEnv.realEnv : {}),
      },
      ...extra,
    };
  }

  private async executeNodeRuntime(
    skill: CanonicalSkill,
    node: DataNode
  ): Promise<{
    structured?: any;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    resolvedSource?: string;
  }> {
    const runtime = node.runtime || "zsh";
    const nodeEnv = this.resolveNodeEnvironment(skill, node);
    const cwd = nodeEnv.cwd;
    const timeoutMs = node.timeoutMs || 15000;
    const sandbox = ensureUnitSandboxPaths(this.paths, skill.id);
    const sandboxEnv = {
      SD_DATA_DIR: sandbox.unitDataDir,
      SD_CACHE_DIR: sandbox.unitCacheDir,
      SD_ARTIFACTS_DIR: sandbox.latestArtifactsLink,
    };

    if (runtime === "passive") {
      const existing = this.snapshots.get(skill.id)?.get(node.id);
      return {
        structured: existing?.rawParsed !== undefined ? existing.rawParsed : existing?.value,
        stdout: existing?.stdout || "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        resolvedSource:
          existing?.resolvedSource || "(passive node — populated via Action output.intoData)",
      };
    }

    if (runtime === "glob") {
      const rawPatterns = Array.isArray(node.pattern)
        ? node.pattern
        : node.pattern
          ? [node.pattern]
          : [];
      const valueFormat = node.valueFormat || "basename";
      const rows: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const resolvedGlobPaths: string[] = [];

      for (const rawPat of rawPatterns) {
        const expanded = this.interpolateText(skill, rawPat, false, nodeEnv);
        const resolvedPath = expanded.startsWith("~/")
          ? join(osModule.homedir(), expanded.slice(2))
          : isAbsolute(expanded)
            ? expanded
            : resolve(cwd, expanded);
        resolvedGlobPaths.push(resolvedPath);
        const dirPath = dirname(resolvedPath);
        const fileGlob = basename(resolvedPath);
        if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) continue;

        const rxStr =
          "^" +
          fileGlob
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".") +
          "$";
        const rx = new RegExp(rxStr, "i");

        for (const entry of readdirSync(dirPath).sort()) {
          if (entry.startsWith(".") || !rx.test(entry)) continue;
          const full = join(dirPath, entry);
          let st;
          try {
            st = statSync(full);
          } catch {
            continue;
          }
          if (!st.isFile()) continue;
          const val =
            valueFormat === "abspath"
              ? full
              : valueFormat === "relative"
                ? relative(cwd, full)
                : entry;
          if (seen.has(val)) continue;
          seen.add(val);
          const sizeFormatted =
            st.size >= 1024 * 1024
              ? `${(st.size / 1024 / 1024).toFixed(1)} MB`
              : `${(st.size / 1024).toFixed(1)} KB`;
          rows.push({
            name: entry,
            value: val,
            path: full,
            relPath: relative(cwd, full),
            size: st.size,
            sizeFormatted,
            updatedAt: new Date(st.mtimeMs).toISOString().replace("T", " ").slice(0, 19),
            mtimeMs: st.mtimeMs,
          });
        }
      }
          return {
            structured: rows,
            stdout: JSON.stringify(rows),
            stderr: "",
            exitCode: 0,
            timedOut: false,
            resolvedSource: resolvedGlobPaths.join("\n"),
          };
    }

    if (runtime === "file") {
      const rawExpanded = this.interpolateText(skill, node.filePath || "", false, nodeEnv);
      const expandedPath = rawExpanded.startsWith("~/")
        ? join(osModule.homedir(), rawExpanded.slice(2))
        : rawExpanded;
      const target = isAbsolute(expandedPath) ? expandedPath : resolve(cwd, expandedPath);
      if (!existsSync(target) || !statSync(target).isFile()) {
        return { stdout: "", stderr: `File not found: ${expandedPath}`, exitCode: 1, timedOut: false, resolvedSource: target };
      }
      const raw = readFileSync(target, "utf-8");
      const ext = extname(target).toLowerCase();
      if (ext === ".json") {
        return { structured: JSON.parse(raw), stdout: raw, stderr: "", exitCode: 0, timedOut: false, resolvedSource: target };
      }
      if (ext === ".yaml" || ext === ".yml") {
        return { structured: YAML.parse(raw), stdout: raw, stderr: "", exitCode: 0, timedOut: false, resolvedSource: target };
      }
      if (ext === ".csv") {
        return { structured: parseDelimitedTable(raw, ","), stdout: raw, stderr: "", exitCode: 0, timedOut: false, resolvedSource: target };
      }
      if (ext === ".tsv") {
        return { structured: parseDelimitedTable(raw, "\t"), stdout: raw, stderr: "", exitCode: 0, timedOut: false, resolvedSource: target };
      }
      return { stdout: raw, stderr: "", exitCode: 0, timedOut: false, resolvedSource: target };
    }

    if (runtime === "sqlite") {
      const rawDb = this.interpolateText(skill, node.db || "", false, nodeEnv);
      const dbRaw = rawDb.startsWith("~/")
        ? join(osModule.homedir(), rawDb.slice(2))
        : rawDb;
      let dbPath = isAbsolute(dbRaw) ? dbRaw : resolve(cwd, dbRaw);
      if (
        !existsSync(dbPath) &&
        dbRaw.endsWith("skill-dashboard/dashboard.db") &&
        this.paths?.dbPath &&
        existsSync(this.paths.dbPath)
      ) {
        dbPath = this.paths.dbPath;
      }
      const sqlText = this.interpolateText(skill, node.sql || "", false, nodeEnv);
      const sqliteSummary = `-- db: ${dbPath}\n${sqlText}`;
      if (!existsSync(dbPath)) {
        if (dbRaw.endsWith("skill-dashboard/dashboard.db")) {
          return {
            structured: [],
            stdout: "[]",
            stderr: "",
            exitCode: 0,
            timedOut: false,
            resolvedSource: sqliteSummary,
          };
        }
        return { stdout: "", stderr: `SQLite DB not found: ${dbRaw}`, exitCode: 1, timedOut: false, resolvedSource: sqliteSummary };
      }
      const sqldb = new Database(dbPath, { readonly: true });
      try {
        const ctxState = this.getContextState(skill);
        const bindParams: Record<string, any> = {};
        for (const [k, v] of Object.entries(ctxState)) {
          if (sqlText.includes(`$${k}`)) bindParams[`$${k}`] = v;
        }
        const rows = sqldb.query(sqlText).all(bindParams) as Record<string, unknown>[];
        return {
          structured: rows,
          stdout: JSON.stringify(rows),
          stderr: "",
          exitCode: 0,
          timedOut: false,
          resolvedSource: sqliteSummary,
        };
      } finally {
        sqldb.close();
      }
    }

    if (runtime === "ts") {
      const rawCode = node.code
        ? node.code
        : node.entry
          ? readFileSync(resolve(cwd, this.interpolateText(skill, node.entry, false, nodeEnv)), "utf-8")
          : "";
      const interpolatedCode = this.interpolateText(skill, rawCode, false, nodeEnv);
      const ctxObj = this.buildExecutionContext(skill, {}, nodeEnv);
      const effectivePrelude = node.prelude ?? skill.manifest.tsPrelude ?? false;
      const res = await executeInlineTypeScript({
        code: interpolatedCode,
        ctxObj,
        prelude: Boolean(effectivePrelude),
      });
      return {
        structured: res,
        stdout: typeof res === "string" ? res : JSON.stringify(res),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        resolvedSource: interpolatedCode,
      };
    }

    if (runtime === "python") {
      const rawCode = node.code
        ? node.code
        : node.entry
          ? readFileSync(resolve(cwd, this.interpolateText(skill, node.entry, false, nodeEnv)), "utf-8")
          : "";
      const interpolatedCode = this.interpolateText(skill, rawCode, false, nodeEnv);
      const ctxObj = this.buildExecutionContext(skill, {}, nodeEnv);
      const pyRes = await this.execPythonStructured({
        pythonBin: nodeEnv.pythonRaw,
        code: interpolatedCode,
        ctxObj,
        cwd: nodeEnv.cwd,
        venvDir: nodeEnv.venvDir,
        env: { ...sandboxEnv, ...nodeEnv.realEnv },
        timeoutMs,
      });
      return {
        ...pyRes,
        resolvedSource: interpolatedCode,
      };
    }

    // Default runtime === "zsh"
    const rawCmd = node.script || node.command || "";
    const command = this.interpolateText(skill, rawCmd, true, nodeEnv);
    const zshRes = await this.execFastShell({
      command,
      cwd: nodeEnv.cwd,
      venvDir: nodeEnv.venvDir,
      env: {
        ...sandboxEnv,
        ...nodeEnv.realEnv,
      },
      timeoutMs,
    });
    return {
      ...zshRes,
      resolvedSource: command,
    };
  }

  private async runTransform(
    skill: CanonicalSkill,
    transform: DataTransform,
    inputData: any,
    rawStdout: string
  ): Promise<any> {
    const ctxObj = this.buildExecutionContext(skill, { input: inputData, rawStdout });
    if (transform.runtime === "python") {
      const pyBin = resolvePythonExecutable(skill.effectiveWorkspace).replace(/^'|'$/g, "");
      const res = await this.execPythonStructured({
        pythonBin: pyBin,
        code: transform.code,
        ctxObj,
        cwd: skill.effectiveWorkspace,
        env: skill.configuredEnv,
        timeoutMs: 10000,
      });
      return res.structured !== undefined ? res.structured : res.stdout;
    }

    const effectivePrelude = transform.prelude ?? skill.manifest.tsPrelude ?? false;
    return await executeInlineTypeScript({
      code: transform.code,
      ctxObj,
      prelude: Boolean(effectivePrelude),
    });
  }

  private async execPythonStructured(params: {
    pythonBin: string;
    code: string;
    ctxObj: Record<string, any>;
    cwd: string;
    venvDir?: string | null;
    env?: Record<string, string>;
    timeoutMs: number;
  }): Promise<{
    structured?: any;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
  }> {
    await this.acquireProcessSlot();
    const ctxFilePath = join(
      tmpdir(),
      `sd-pyctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    );
    try {
      writeFileSync(ctxFilePath, JSON.stringify(params.ctxObj), "utf-8");

      const wrapper = `
import json, os, sys
with open(os.environ["SD_CTX_FILE"], "r", encoding="utf-8") as _sd_f:
    ctx = json.load(_sd_f)
${params.code}
if 'main' in globals() and callable(globals()['main']):
    _sd_res = main(ctx)
    print("\\n__SD_JSON_START__")
    print(json.dumps(_sd_res, default=str))
    print("__SD_JSON_END__")
`;
      const basePath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
      const proc = Bun.spawn([params.pythonBin, "-c", wrapper], {
        cwd: params.cwd,
        env: {
          ...process.env,
          LANG: process.env.LANG || "en_US.UTF-8",
          LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
          PYTHONUNBUFFERED: "1",
          SD_CTX_FILE: ctxFilePath,
          ...(params.venvDir
            ? {
                VIRTUAL_ENV: params.venvDir,
                PATH: `${params.venvDir}/bin:${basePath}`,
              }
            : {}),
          ...(params.env || {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {}
      }, params.timeoutMs);

      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        clearTimeout(timer);

        const startIdx = stdout.indexOf("__SD_JSON_START__");
        const endIdx = stdout.indexOf("__SD_JSON_END__");
        if (startIdx !== -1 && endIdx !== -1) {
          const jsonSlice = stdout.slice(startIdx + "__SD_JSON_START__".length, endIdx).trim();
          const cleanOut = stdout.slice(0, startIdx).trimEnd();
          try {
            return {
              structured: JSON.parse(jsonSlice),
              stdout: cleanOut || jsonSlice,
              stderr: stderr.trimEnd(),
              exitCode: exitCode ?? 0,
              timedOut,
            };
          } catch {}
        }

        return {
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          exitCode: exitCode ?? -1,
          timedOut,
        };
      } finally {
        clearTimeout(timer);
        try {
          rmSync(ctxFilePath, { force: true });
        } catch {}
      }
    } finally {
      this.releaseProcessSlot();
    }
  }

  private async execFastShell(params: {
    command: string;
    cwd: string;
    venvDir?: string | null;
    env?: Record<string, string>;
    timeoutMs: number;
  }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut: boolean;
    durationMs: number;
  }> {
    await this.acquireProcessSlot();
    try {
      const t0 = performance.now();
      const basePath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
      const proc = Bun.spawn(["/bin/zsh", "-c", params.command], {
        cwd: params.cwd,
        env: {
          ...process.env,
          LANG: process.env.LANG || "en_US.UTF-8",
          LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
          PYTHONUNBUFFERED: "1",
          ...(params.venvDir
            ? {
                VIRTUAL_ENV: params.venvDir,
                PATH: `${params.venvDir}/bin:${basePath}`,
              }
            : {}),
          ...(params.env || {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          proc.kill();
        } catch {}
      }, params.timeoutMs);

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);

      return {
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: exitCode ?? -1,
        timedOut,
        durationMs: Math.round(performance.now() - t0),
      };
    } finally {
      this.releaseProcessSlot();
    }
  }
}

export function injectSkillDashboardBridge(rawHtml: string, baseHref: string): string {
  const bridgeTag = `<base href="${baseHref}" />
<script>
(function() {
  const pending = new Map();
  const listeners = new Map();
  const dataSubs = new Map();
  let reqId = 1;

  function rpc(method, payload) {
    return new Promise(function(resolve, reject) {
      const id = reqId++;
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ type: "sd:rpc-request", id, method, payload: payload || {} }, "*");
    });
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderWidgetDom(el, snap) {
    if (!el || !snap) return;
    const shape = snap.shape || "raw";
    if ((shape === "table" || shape === "stream") && snap.value && Array.isArray(snap.value.rows)) {
      const cols = snap.value.columns || [];
      const rows = snap.value.rows || [];
      const rowActions = snap.rowActions || [];
      if (!rows.length) {
        el.innerHTML = '<div style="padding:10px;opacity:0.65;font-size:12px;">No rows found.</div>';
        return;
      }
      let h = '<table style="width:100%;border-collapse:collapse;font-size:12px;text-align:left;"><thead><tr style="border-bottom:1px solid rgba(148,163,184,0.25);opacity:0.75;font-size:11px;">';
      cols.forEach(function(c) { h += '<th style="padding:6px 8px;">' + esc(c.label || c.key) + '</th>'; });
      if (rowActions.length) h += '<th style="padding:6px 8px;text-align:right;">Actions</th>';
      h += '</tr></thead><tbody>';
      rows.forEach(function(r, rIdx) {
        h += '<tr style="border-bottom:1px solid rgba(148,163,184,0.14);">';
        cols.forEach(function(c) {
          h += '<td style="padding:7px 8px;">' + esc(r[c.key] != null ? String(r[c.key]) : '') + '</td>';
        });
        if (rowActions.length) {
          h += '<td style="padding:7px 8px;text-align:right;white-space:nowrap;">';
          rowActions.forEach(function(act, aIdx) {
            h += '<button type="button" data-r="' + rIdx + '" data-a="' + aIdx + '" style="margin-left:4px;padding:3px 8px;border-radius:6px;border:1px solid rgba(14,165,233,0.4);background:rgba(14,165,233,0.12);color:inherit;cursor:pointer;font-size:11px;font-weight:600;">' + esc(act.label) + '</button>';
          });
          h += '</td>';
        }
        h += '</tr>';
      });
      h += '</tbody></table>';
      el.innerHTML = h;
      el.querySelectorAll("button[data-r]").forEach(function(btn) {
        btn.addEventListener("click", function() {
          const row = rows[Number(btn.getAttribute("data-r"))] || {};
          const act = rowActions[Number(btn.getAttribute("data-a"))];
          if (!act) return;
          const args = {};
          Object.entries(act.args || {}).forEach(function([k, v]) {
            args[k] = typeof v === "string" ? v.replace(/\\{\\{\\s*row\\.([a-zA-Z0-9_.-]+)\\s*\\}\\}/g, function(_, ck) { return row[ck] != null ? String(row[ck]) : ""; }) : v;
          });
          if (act.mode === "prefill") window.SkillDashboard.prefillAction(act.actionId, args);
          else window.SkillDashboard.runAction(act.actionId, args);
        });
      });
    } else if (shape === "scalar" && snap.value) {
      el.innerHTML = '<div style="font-size:18px;font-weight:700;">' + esc(snap.value.value ?? "") + (snap.value.unit ? ' <span style="font-size:12px;opacity:0.7;">' + esc(snap.value.unit) + '</span>' : '') + '</div>';
    } else if (shape === "kv" && snap.value && Array.isArray(snap.value.entries)) {
      let kh = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;font-size:12px;">';
      snap.value.entries.forEach(function(e) {
        kh += '<div style="padding:6px 10px;border-radius:8px;border:1px solid rgba(148,163,184,0.2);display:flex;justify-content:space-between;gap:8px;"><span style="opacity:0.7;">' + esc(e.label || e.key) + '</span><code style="font-weight:600;">' + esc(e.value) + '</code></div>';
      });
      kh += '</div>';
      el.innerHTML = kh;
    } else if (shape === "matrix" && snap.value) {
      const rks = snap.value.rowKeys || [];
      const cks = snap.value.colKeys || [];
      const cellAct = snap.cellAction;
      let mh = '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr><th style="padding:6px 8px;">Row \\ Col</th>';
      cks.forEach(function(ck) { mh += '<th style="padding:6px 8px;text-align:center;">' + esc(ck) + '</th>'; });
      mh += '</tr></thead><tbody>';
      rks.forEach(function(rk) {
        mh += '<tr style="border-top:1px solid rgba(148,163,184,0.15);"><td style="padding:6px 8px;font-weight:600;">' + esc(rk) + '</td>';
        cks.forEach(function(ck) {
          const cv = snap.value.cells && snap.value.cells[rk] ? snap.value.cells[rk][ck] : "";
          const label = esc(cv != null ? cv : "—");
          if (cellAct) {
            mh += '<td style="padding:6px 8px;text-align:center;"><button type="button" data-rk="' + esc(rk) + '" data-ck="' + esc(ck) + '" data-cv="' + esc(cv ?? "") + '" style="padding:2px 8px;border-radius:6px;border:1px solid rgba(14,165,233,0.4);background:rgba(14,165,233,0.12);color:inherit;cursor:pointer;font-family:monospace;font-size:11px;">' + label + '</button></td>';
          } else {
            mh += '<td style="padding:6px 8px;text-align:center;font-family:monospace;">' + label + '</td>';
          }
        });
        mh += '</tr>';
      });
      mh += '</tbody></table>';
      el.innerHTML = mh;
      if (cellAct) {
        el.querySelectorAll("button[data-rk]").forEach(function(btn) {
          btn.addEventListener("click", function() {
            const rk = btn.getAttribute("data-rk") || "";
            const ck = btn.getAttribute("data-ck") || "";
            const cv = btn.getAttribute("data-cv") || "";
            const args = {};
            Object.entries(cellAct.args || {}).forEach(function([k, v]) {
              args[k] = typeof v === "string"
                ? v.replace(/\\{\\{\\s*cell\\.rowKey\\s*\\}\\}/g, rk).replace(/\\{\\{\\s*cell\\.colKey\\s*\\}\\}/g, ck).replace(/\\{\\{\\s*cell\\.value\\s*\\}\\}/g, cv)
                : v;
            });
            if (cellAct.mode === "prefill") window.SkillDashboard.prefillAction(cellAct.actionId, args);
            else window.SkillDashboard.runAction(cellAct.actionId, args);
          });
        });
      }
    } else {
      const txt = (snap.value && snap.value.stdout) || snap.stdout || JSON.stringify(snap.value, null, 2);
      el.innerHTML = '<pre style="margin:0;font-family:monospace;font-size:11.5px;white-space:pre-wrap;">' + esc(txt) + '</pre>';
    }
  }

  function refreshAllDeclarativeWidgets(force) {
    document.querySelectorAll("[data-sd-context-bar]").forEach(function(el) {
      rpc("getContext", {}).then(function(ctxInfo) {
        const fields = (ctxInfo && ctxInfo.contextFields) || [];
        const cur = (ctxInfo && ctxInfo.context) || {};
        if (!fields.length) { el.innerHTML = ""; return; }
        let ch = '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;">';
        fields.forEach(function(f) {
          ch += '<label style="display:inline-flex;align-items:center;gap:6px;font-weight:600;"><span>' + esc(f.label) + ':</span><select data-ctx-key="' + esc(f.key) + '" style="padding:4px 8px;border-radius:8px;border:1px solid rgba(148,163,184,0.3);background:transparent;color:inherit;font-size:12px;">';
          (f.options || []).forEach(function(o) {
            const sel = String(cur[f.key] ?? "") === String(o.value) ? " selected" : "";
            ch += '<option value="' + esc(o.value) + '"' + sel + '>' + esc(o.label) + '</option>';
          });
          ch += '</select></label>';
        });
        ch += '</div>';
        el.innerHTML = ch;
        el.querySelectorAll("select[data-ctx-key]").forEach(function(sel) {
          sel.addEventListener("change", function() {
            window.SkillDashboard.setContext(sel.getAttribute("data-ctx-key"), sel.value);
          });
        });
      }).catch(function() {});
    });
    document.querySelectorAll("[data-sd-widget]").forEach(function(el) {
      const nodeId = el.getAttribute("data-sd-widget");
      if (!nodeId) return;
      rpc("getData", { nodeId: nodeId, force: Boolean(force) }).then(function(snap) {
        renderWidgetDom(el, snap);
      }).catch(function() {});
    });
    dataSubs.forEach(function(callbacks, nodeId) {
      rpc("getData", { nodeId: nodeId, force: Boolean(force) }).then(function(snap) {
        callbacks.forEach(function(cb) { try { cb(snap); } catch(e) {} });
      }).catch(function() {});
    });
  }

  window.addEventListener("message", function(ev) {
    const msg = ev.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "sd:rpc-response" && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.result);
    } else if (msg.type === "sd:event") {
      if (msg.event === "themeChanged" && msg.payload && msg.payload.theme) {
        document.documentElement.setAttribute("data-theme", msg.payload.theme);
        document.documentElement.classList.toggle("dark", msg.payload.theme === "dark");
      }
      if (msg.event === "runCompleted" || msg.event === "workspaceChanged" || msg.event === "dataUpdated") {
        refreshAllDeclarativeWidgets(true);
      }
      const handlers = listeners.get(msg.event) || [];
      for (const fn of handlers) {
        try { fn(msg.payload); } catch (e) {}
      }
    }
  });

  window.SkillDashboard = {
    getContext: function() { return rpc("getContext", {}); },
    setContext: function(key, value) { return rpc("setContext", { key: key, value: value }); },
    data: function(nodeId, options) { return rpc("getData", { nodeId: nodeId, force: Boolean(options && options.force) }); },
    subscribe: function(nodeId, handler) {
      const list = dataSubs.get(nodeId) || [];
      list.push(handler);
      dataSubs.set(nodeId, list);
      rpc("getData", { nodeId: nodeId, force: false }).then(function(snap) {
        try { handler(snap); } catch (e) {}
      }).catch(function() {});
      return function() {
        const cur = dataSubs.get(nodeId) || [];
        dataSubs.set(nodeId, cur.filter(function(h) { return h !== handler; }));
      };
    },
    run: function(actionId, formValues, options) { return rpc("runAction", { actionId: actionId, formValues: formValues || {}, options: options || {} }); },
    runAction: function(actionId, formValues, options) { return rpc("runAction", { actionId: actionId, formValues: formValues || {}, options: options || {} }); },
    prefillAction: function(actionId, formValues) { return rpc("prefillAction", { actionId: actionId, formValues: formValues || {} }); },
    runInTerminal: function(command, title) { return rpc("runInTerminal", { command: command, title: title }); },
    submitDecision: function(payload) { return rpc("submitDecision", { payload: payload || {} }); },
    on: function(event, handler) {
      const list = listeners.get(event) || [];
      list.push(handler);
      listeners.set(event, list);
      return function() {
        const cur = listeners.get(event) || [];
        listeners.set(event, cur.filter(function(h) { return h !== handler; }));
      };
    }
  };

  window.addEventListener("DOMContentLoaded", function() {
    refreshAllDeclarativeWidgets(false);
    document.addEventListener("click", function(e) {
      const btn = e.target && e.target.closest ? e.target.closest("[data-sd-action]") : null;
      if (!btn) return;
      const actionId = btn.getAttribute("data-sd-action");
      const rawArgs = btn.getAttribute("data-sd-args");
      const mode = btn.getAttribute("data-sd-mode") || "run";
      const args = rawArgs ? JSON.parse(rawArgs) : {};
      if (mode === "prefill") window.SkillDashboard.prefillAction(actionId, args);
      else window.SkillDashboard.runAction(actionId, args);
    });
  });
})();
</script>`;

  if (/<head[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<head[^>]*>/i, (match) => `${match}\n${bridgeTag}`);
  }
  if (/<html[^>]*>/i.test(rawHtml)) {
    return rawHtml.replace(/<html[^>]*>/i, (match) => `${match}\n<head>${bridgeTag}</head>`);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>${bridgeTag}</head><body>${rawHtml}</body></html>`;
}










