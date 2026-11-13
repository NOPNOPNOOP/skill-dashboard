#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import YAML from "yaml";
import { loadAndLinkManifestFile } from "./cascade.ts";
import { DashboardDatabase } from "./db.ts";
import { discoverCanonicalSkills, expandHomePath, getDefaultAgentRoots } from "./discovery.ts";
import { extractImplicitDependencies } from "./interpolator.ts";
import {
  deriveProjectSlug,
  ensureDashboardDirectories,
  ensureUnitSandboxPaths,
  loadDashboardConfig,
  resolveDashboardPaths,
  sanitizeUnitSegment,
  saveDashboardConfig,
} from "./paths.ts";
import { ReactiveGraphEngine, rewriteStaticImportsToDynamic } from "./probes.ts";
import { type CanonicalSkill, SkillManifestSchema } from "./types.ts";

export interface SymbolReferenceEntry {
  kind: "context" | "data" | "action" | "view";
  id: string;
  title: string;
  definedIn: string;
  runtimeOrShape?: string;
  columns?: string[];
  dependsOn: string[];
  usedBy: string[];
  intermediate?: boolean;
  category?: string;
}

export interface ManifestSymbolGraph {
  skillId: string;
  canonicalPath: string;
  moduleFiles: string[];
  symbols: Record<string, SymbolReferenceEntry>;
}

export interface ManifestDiagnosticIssue {
  level: "L1-Schema" | "L2-Graph" | "L3-Runtime";
  severity: "error" | "warn";
  file: string;
  symbolId?: string;
  message: string;
  fixHint?: string;
}

export function buildManifestSymbolGraph(skill: CanonicalSkill): ManifestSymbolGraph {
  const prov = skill.layers.provenance;
  const symbols: Record<string, SymbolReferenceEntry> = {};

  for (const ctx of skill.manifest.context || []) {
    symbols[`context:${ctx.key}`] = {
      kind: "context",
      id: ctx.key,
      title: ctx.label,
      definedIn: prov?.contextSource?.[ctx.key] || "manifest.yaml",
      runtimeOrShape: ctx.type,
      dependsOn: ctx.fromData ? [`data:${ctx.fromData}`] : [],
      usedBy: [],
    };
  }

  for (const node of skill.manifest.data || []) {
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
    const imp = extractImplicitDependencies(texts);
    const deps = new Set<string>();
    for (const ck of imp.contextKeys) deps.add(`context:${ck}`);
    for (const dn of imp.dataNodeIds) if (dn !== node.id) deps.add(`data:${dn}`);
    for (const exp of node.sync?.dependsOn || []) {
      deps.add(exp.startsWith("context.") ? `context:${exp.slice(8)}` : `data:${exp}`);
    }

    symbols[`data:${node.id}`] = {
      kind: "data",
      id: node.id,
      title: node.title,
      definedIn: prov?.dataSource?.[node.id] || "manifest.yaml",
      runtimeOrShape: `${node.runtime}/${node.shape}`,
      columns: node.columns?.map((c) => c.key),
      dependsOn: [...deps],
      usedBy: [],
      intermediate: Boolean(node.intermediate || (node as any).hidden),
      category: node.category,
    };
  }

  const allActions = (skill.manifest.actionGroups || []).flatMap((g) => g.actions || []);
  for (const act of allActions) {
    const imp = extractImplicitDependencies(act.script || act.command || "");
    const deps = new Set<string>();
    for (const ck of imp.contextKeys) deps.add(`context:${ck}`);
    for (const dn of imp.dataNodeIds) deps.add(`data:${dn}`);
    for (const f of act.form || []) {
      if (f.fromData) deps.add(`data:${f.fromData}`);
    }
    for (const pre of act.preconditions || []) {
      if (pre.dataNodeId) deps.add(`data:${pre.dataNodeId}`);
    }
    symbols[`action:${act.id}`] = {
      kind: "action",
      id: act.id,
      title: act.title,
      definedIn: prov?.actionSource?.[act.id] || "manifest.yaml",
      runtimeOrShape: act.danger,
      dependsOn: [...deps],
      usedBy: [],
    };
  }

  for (const v of skill.manifest.views || []) {
    const deps = new Set<string>();
    if (v.type === "html") {
      const cleanSrc = v.source.replace(/^\.\//, "");
      const candA = resolve(skill.canonicalPath, cleanSrc);
      const candB = resolve(skill.canonicalPath, ".dashboard", cleanSrc);
      const htmlPath = existsSync(candA) ? candA : existsSync(candB) ? candB : null;
      if (htmlPath) {
        const htmlContent = readFileSync(htmlPath, "utf-8");
        for (const m of htmlContent.matchAll(/data-sd-widget=["']([^"']+)["']/g)) {
          deps.add(`data:${m[1]}`);
        }
        for (const m of htmlContent.matchAll(/data-sd-action=["']([^"']+)["']/g)) {
          deps.add(`action:${m[1]}`);
        }
        for (const m of htmlContent.matchAll(/SkillDashboard\.(?:data|subscribe)\(\s*["']([^"']+)["']/g)) {
          deps.add(`data:${m[1]}`);
        }
        for (const m of htmlContent.matchAll(/SkillDashboard\.(?:runAction|prefillAction)\(\s*["']([^"']+)["']/g)) {
          deps.add(`action:${m[1]}`);
        }
      }
    }
    symbols[`view:${v.id}`] = {
      kind: "view",
      id: v.id,
      title: v.title,
      definedIn: prov?.viewSource?.[v.id] || "manifest.yaml",
      runtimeOrShape: v.type,
      dependsOn: [...deps],
      usedBy: [],
    };
  }

  // Wire bidirectional usedBy edges (including rowActions/quickActions/bulkActions/cellAction/nodeActions, selectContextKey & output.intoData)
  for (const node of skill.manifest.data || []) {
    const triggers = [
      ...(node.quickActions || []),
      ...(node.rowActions || []),
      ...(node.bulkActions || []),
      ...(node.cellAction ? [node.cellAction] : []),
      ...(node.nodeActions || []),
    ];
    for (const tr of triggers) {
      const actEntry = symbols[`action:${tr.actionId}`];
      if (actEntry && !actEntry.usedBy.includes(`data:${node.id} (trigger)`)) {
        actEntry.usedBy.push(`data:${node.id} (trigger)`);
      }
    }
    if (node.selectContextKey) {
      const ctxEntry = symbols[`context:${node.selectContextKey}`];
      if (ctxEntry && !ctxEntry.usedBy.includes(`data:${node.id} (selectContextKey)`)) {
        ctxEntry.usedBy.push(`data:${node.id} (selectContextKey)`);
      }
    }
  }

  for (const act of allActions) {
    if (act.output?.intoData) {
      const targetData = symbols[`data:${act.output.intoData}`];
      if (targetData && !targetData.dependsOn.includes(`action:${act.id} (intoData)`)) {
        targetData.dependsOn.push(`action:${act.id} (intoData)`);
      }
    }
  }

  for (const [symKey, entry] of Object.entries(symbols)) {
    for (const depKey of entry.dependsOn) {
      const cleanDep = depKey.split(" ")[0]!;
      const target = symbols[cleanDep];
      if (target && !target.usedBy.includes(symKey)) {
        target.usedBy.push(symKey);
      }
    }
  }

  return {
    skillId: skill.id,
    canonicalPath: skill.canonicalPath,
    moduleFiles: prov?.moduleFiles?.length ? prov.moduleFiles : ["manifest.yaml"],
    symbols,
  };
}

const tsTranspiler = new Bun.Transpiler({ loader: "ts" });

function detectUnimportedPreludeUsage(code: string): string[] {
  const used: string[] = [];
  const helpers = ["fs", "path", "os", "Database", "YAML", "$"];
  for (const h of helpers) {
    const escaped = h === "$" ? "\\$" : h;
    const rxUse = new RegExp(`\\b${escaped}\\s*(?:\\.|\\(|\\\`)`);
    const rxImport = new RegExp(`import\\s+.*\\b${escaped}\\b.*from|const\\s+${escaped}\\s*=`);
    if (rxUse.test(code) && !rxImport.test(code)) {
      used.push(h);
    }
  }
  return used;
}

export function validateSkillManifest3Tier(skill: CanonicalSkill): ManifestDiagnosticIssue[] {
  const issues: ManifestDiagnosticIssue[] = [];
  const dashboardDir = join(skill.canonicalPath, ".dashboard");
  const manifestPath = skill.layers.companionPath;
  if (!existsSync(manifestPath)) return issues;

  // L1: Raw syntax + Legacy 1.0 Mistake Hints + Zod Schema
  const linked = loadAndLinkManifestFile(manifestPath, dashboardDir);
  if (!linked.rawParsed) {
    issues.push({
      level: "L1-Schema",
      severity: "error",
      file: "manifest.yaml",
      message: `Failed to parse YAML/JSON in ${manifestPath}`,
    });
    return issues;
  }

  if (Array.isArray(linked.rawParsed.probes)) {
    issues.push({
      level: "L1-Schema",
      severity: "error",
      file: "manifest.yaml",
      message: `Legacy 1.0 field "probes:" detected.`,
      fixHint: `Replace top-level "probes:" with "data:" nodes using runtime: zsh|ts|python|sqlite|glob|file and shape: table|scalar|kv|raw.`,
    });
  }

  const parsedRes = SkillManifestSchema.safeParse(linked.rawParsed);
  if (!parsedRes.success) {
    for (const zErr of parsedRes.error.issues) {
      issues.push({
        level: "L1-Schema",
        severity: "error",
        file: "manifest.yaml",
        message: `${zErr.path.join(".")}: ${zErr.message}`,
      });
    }
  }

  const prov = linked.provenance;
  const dataIds = new Set((skill.manifest.data || []).map((d) => d.id));
  const contextKeys = new Set((skill.manifest.context || []).map((c) => c.key));
  const allActions = (skill.manifest.actionGroups || []).flatMap((g) => g.actions || []);
  const actionIds = new Set(allActions.map((a) => a.id));

  // L2: Cross-File Symbol Reference Integrity & DAG Cycle Detection
  for (const node of skill.manifest.data || []) {
    const file = prov.dataSource[node.id] || "manifest.yaml";
    const triggers = [
      ...(node.quickActions || []),
      ...(node.rowActions || []),
      ...(node.bulkActions || []),
      ...(node.cellAction ? [node.cellAction] : []),
      ...(node.nodeActions || []),
    ];
    for (const tr of triggers) {
      if (!actionIds.has(tr.actionId)) {
        issues.push({
          level: "L2-Graph",
          severity: "error",
          file,
          symbolId: `data:${node.id}`,
          message: `Data node "${node.id}" trigger "${tr.label}" references non-existent actionId "${tr.actionId}".`,
          fixHint: `Available action IDs: ${[...actionIds].slice(0, 8).join(", ")}`,
        });
      }
    }
    if (node.selectContextKey && !contextKeys.has(node.selectContextKey)) {
      issues.push({
        level: "L2-Graph",
        severity: "error",
        file,
        symbolId: `data:${node.id}`,
        message: `Data node "${node.id}" declares selectContextKey "${node.selectContextKey}", which does not exist in context.`,
        fixHint: `Available context keys: ${[...contextKeys].join(", ")}`,
      });
    }
  }

  for (const act of allActions) {
    const file = prov.actionSource[act.id] || "manifest.yaml";
    for (const f of act.form || []) {
      if ((f as any).dataSource) {
        issues.push({
          level: "L1-Schema",
          severity: "error",
          file,
          symbolId: `action:${act.id}`,
          message: `Form field "${f.key}" in action "${act.id}" uses legacy 1.0 "dataSource".`,
          fixHint: `Use "fromData: <data_node_id>" referencing a node in "data:".`,
        });
      }
      if (f.fromData && !dataIds.has(f.fromData)) {
        issues.push({
          level: "L2-Graph",
          severity: "error",
          file,
          symbolId: `action:${act.id}`,
          message: `Form field "${f.key}" in action "${act.id}" has fromData: "${f.fromData}", which does not exist in data nodes.`,
          fixHint: `Available data node IDs: ${[...dataIds].join(", ")}`,
        });
      }
    }
    if (act.output?.intoData && !dataIds.has(act.output.intoData)) {
      issues.push({
        level: "L2-Graph",
        severity: "error",
        file,
        symbolId: `action:${act.id}`,
        message: `Action "${act.id}" pipes output.intoData to non-existent data node "${act.output.intoData}".`,
      });
    }
    for (const pre of act.preconditions || []) {
      if (!dataIds.has(pre.dataNodeId)) {
        issues.push({
          level: "L2-Graph",
          severity: "error",
          file,
          symbolId: `action:${act.id}`,
          message: `Action "${act.id}" precondition references non-existent dataNodeId "${pre.dataNodeId}".`,
        });
      }
      if (pre.fixActionId && !actionIds.has(pre.fixActionId)) {
        issues.push({
          level: "L2-Graph",
          severity: "error",
          file,
          symbolId: `action:${act.id}`,
          message: `Action "${act.id}" precondition references non-existent fixActionId "${pre.fixActionId}".`,
        });
      }
    }
    const imp = extractImplicitDependencies(act.script || act.command || "");
    for (const ck of imp.contextKeys) {
      if (!contextKeys.has(ck)) {
        issues.push({
          level: "L2-Graph",
          severity: "error",
          file,
          symbolId: `action:${act.id}`,
          message: `Action "${act.id}" interpolates "{{context.${ck}}}", which is not declared in context.`,
        });
      }
    }
    for (const dn of imp.dataNodeIds) {
      if (!dataIds.has(dn)) {
        issues.push({
          level: "L2-Graph",
          severity: "error",
          file,
          symbolId: `action:${act.id}`,
          message: `Action "${act.id}" interpolates "{{data.${dn}.*}}", which is not declared in data.`,
        });
      }
    }
  }

  for (const v of skill.manifest.views || []) {
    const file = prov.viewSource[v.id] || "manifest.yaml";
    const cleanSrc = v.source.replace(/^\.\//, "");
    const candA = resolve(skill.canonicalPath, cleanSrc);
    const candB = resolve(skill.canonicalPath, ".dashboard", cleanSrc);
    const viewFile = existsSync(candA) ? candA : existsSync(candB) ? candB : null;
    if (!viewFile) {
      issues.push({
        level: "L2-Graph",
        severity: "error",
        file,
        symbolId: `view:${v.id}`,
        message: `View "${v.id}" source file not found: "${v.source}".`,
      });
      continue;
    }
    if (v.type === "html") {
      const htmlContent = readFileSync(viewFile, "utf-8");
      for (const m of htmlContent.matchAll(/data-sd-widget=["']([^"']+)["']/g)) {
        if (!dataIds.has(m[1]!)) {
          issues.push({
            level: "L2-Graph",
            severity: "error",
            file: v.source,
            symbolId: `view:${v.id}`,
            message: `HTML view "${v.id}" mounts data-sd-widget="${m[1]}", which does not exist in data nodes.`,
          });
        }
      }
      for (const m of htmlContent.matchAll(/data-sd-action=["']([^"']+)["']/g)) {
        if (!actionIds.has(m[1]!)) {
          issues.push({
            level: "L2-Graph",
            severity: "error",
            file: v.source,
            symbolId: `view:${v.id}`,
            message: `HTML view "${v.id}" binds data-sd-action="${m[1]}", which does not exist in actions.`,
          });
        }
      }
    }
  }

  const graph = buildManifestSymbolGraph(skill);
  for (const node of skill.manifest.data || []) {
    const file = prov.dataSource[node.id] || "manifest.yaml";
    const sym = graph.symbols[`data:${node.id}`];
    for (const dep of sym?.dependsOn || []) {
      const cleanDep = dep.split(" ")[0]!;
      if (cleanDep.startsWith("data:")) {
        const depId = cleanDep.slice(5);
        if (!dataIds.has(depId)) {
          issues.push({
            level: "L2-Graph",
            severity: "error",
            file,
            symbolId: `data:${node.id}`,
            message: `Data node "${node.id}" depends on unknown data node "${depId}".`,
          });
        }
      }
    }

    const visiting = new Set<string>();
    const hasCycle = (currId: string): boolean => {
      if (visiting.has(currId)) return true;
      visiting.add(currId);
      const s = graph.symbols[`data:${currId}`];
      for (const d of s?.dependsOn || []) {
        const cd = d.split(" ")[0]!;
        if (cd.startsWith("data:") && hasCycle(cd.slice(5))) return true;
      }
      visiting.delete(currId);
      return false;
    };
    if (hasCycle(node.id)) {
      issues.push({
        level: "L2-Graph",
        severity: "error",
        file,
        symbolId: `data:${node.id}`,
        message: `Circular dependency detected in data DAG involving "${node.id}".`,
      });
    }

    if (node.runtime === "ts" && node.code) {
      try {
        const rewritten = rewriteStaticImportsToDynamic(node.code);
        tsTranspiler.transformSync(`async function __sd_check() {\n${rewritten}\n}`);
      } catch (err: any) {
        issues.push({
          level: "L3-Runtime",
          severity: "error",
          file,
          symbolId: `data:${node.id}`,
          message: `TypeScript syntax error in data node "${node.id}": ${err.message}`,
        });
      }
      const effectivePrelude = node.prelude ?? skill.manifest.tsPrelude ?? false;
      if (!effectivePrelude) {
        const usedPrelude = detectUnimportedPreludeUsage(node.code);
        if (usedPrelude.length > 0) {
          issues.push({
            level: "L3-Runtime",
            severity: "warn",
            file,
            symbolId: `data:${node.id}`,
            message: `Data node "${node.id}" uses prelude helper(s) [${usedPrelude.join(", ")}] without importing them or setting "prelude: true".`,
            fixHint: `Add "prelude: true" to data node "${node.id}" (recommended) or add explicit import statements.`,
          });
        }
      }
    }

    if (node.runtime === "python" && node.code) {
      const pyRes = Bun.spawnSync(["python3", "-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
        stdin: Buffer.from(node.code, "utf-8"),
      });
      if (pyRes.exitCode !== 0) {
        issues.push({
          level: "L3-Runtime",
          severity: "error",
          file,
          symbolId: `data:${node.id}`,
          message: `Python syntax error in data node "${node.id}": ${pyRes.stderr.toString().trim()}`,
        });
      }
    }

    if (node.transform?.code) {
      if (node.transform.runtime === "python") {
        const pyRes = Bun.spawnSync(["python3", "-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
          stdin: Buffer.from(node.transform.code, "utf-8"),
        });
        if (pyRes.exitCode !== 0) {
          issues.push({
            level: "L3-Runtime",
            severity: "error",
            file,
            symbolId: `data:${node.id}`,
            message: `Python transform syntax error in data node "${node.id}": ${pyRes.stderr.toString().trim()}`,
          });
        }
      } else {
        try {
          const rewritten = rewriteStaticImportsToDynamic(node.transform.code);
          tsTranspiler.transformSync(`async function __sd_check() {\n${rewritten}\n}`);
        } catch (err: any) {
          issues.push({
            level: "L3-Runtime",
            severity: "error",
            file,
            symbolId: `data:${node.id}`,
            message: `TypeScript transform syntax error in data node "${node.id}": ${err.message}`,
          });
        }
      }
    }
  }

  for (const act of allActions) {
    const file = prov?.actionSource?.[act.id] || "manifest.yaml";
    for (const rule of act.artifacts || []) {
      if (typeof rule === "object" && rule.fromStdout) {
        try {
          new RegExp(rule.fromStdout, "gm");
        } catch (err: any) {
          issues.push({
            level: "L3-Runtime",
            severity: "error",
            file,
            symbolId: `action:${act.id}`,
            message: `Invalid fromStdout regex in action "${act.id}": ${err.message}`,
          });
        }
      }
    }
  }

  return issues;
}

export function formatManifestMapReport(graph: ManifestSymbolGraph): string {
  const lines: string[] = [];
  lines.push(`Skill: ${graph.skillId} (${graph.canonicalPath}/.dashboard)`);
  lines.push(`Modules (${graph.moduleFiles.length}): ${graph.moduleFiles.join(" | ")}`);
  lines.push("----------------------------------------------------------------------");

  const entries = Object.values(graph.symbols);
  for (const kind of ["context", "data", "action", "view"] as const) {
    const sub = entries.filter((e) => e.kind === kind);
    if (sub.length === 0) continue;
    lines.push(`[${kind.toUpperCase()} (${sub.length})]`);
    for (const s of sub) {
      const intermediateStr = s.intermediate ? " [intermediate]" : "";
      const categoryStr = s.category ? ` [category: ${s.category}]` : "";
      const colsStr = s.columns && s.columns.length > 0 ? ` cols:{${s.columns.join(",")}}` : "";
      const depsStr = s.dependsOn.length > 0 ? ` <- deps:[${s.dependsOn.join(", ")}]` : "";
      const usedStr = s.usedBy.length > 0 ? ` -> usedBy:[${s.usedBy.join(", ")}]` : "";
      lines.push(
        `  - ${s.id.padEnd(28)} (${s.definedIn})${s.runtimeOrShape ? ` [${s.runtimeOrShape}]` : ""}${intermediateStr}${categoryStr}${colsStr}${depsStr}${usedStr}`
      );
    }
  }
  return lines.join("\n");
}

export function formatSymbolRefsReport(graph: ManifestSymbolGraph, symbolId: string): string {
  const matches = Object.entries(graph.symbols).filter(
    ([k, v]) => v.id === symbolId || k === symbolId
  );
  if (matches.length === 0) {
    return `Symbol "${symbolId}" not found in skill "${graph.skillId}".`;
  }
  const lines: string[] = [];
  for (const [fullKey, entry] of matches) {
    lines.push(`Symbol     : ${fullKey} (${entry.title})`);
    lines.push(`Defined In : .dashboard/${entry.definedIn}`);
    lines.push(`Type/Shape : ${entry.runtimeOrShape || entry.kind}`);
    if (entry.category) lines.push(`Category   : ${entry.category}`);
    if (entry.intermediate) lines.push(`Intermediate: true`);
    lines.push(`Depends On : ${entry.dependsOn.length > 0 ? entry.dependsOn.join(", ") : "(none)"}`);
    lines.push(`Used By    : ${entry.usedBy.length > 0 ? entry.usedBy.join(", ") : "(none)"}`);
  }
  return lines.join("\n");
}

export function splitMonolithicManifestToModules(skill: CanonicalSkill, writeToDisk = false): {
  rootYaml: string;
  modules: Record<string, string>;
} {
  const graph = buildManifestSymbolGraph(skill);
  const groups = skill.manifest.actionGroups || [];
  const dataNodes = skill.manifest.data || [];
  const assignedDataIds = new Set<string>();
  const modules: Record<string, string> = {};
  const includePaths: string[] = [];

  groups.forEach((grp, idx) => {
    const slug = grp.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    const modRel = `./modules/${String(idx + 1).padStart(2, "0")}-${slug || "group"}.yaml`;
    includePaths.push(modRel);

    const grpActionIds = new Set((grp.actions || []).map((a) => a.id));
    const relatedData = dataNodes.filter((dn) => {
      if (assignedDataIds.has(dn.id)) return false;
      const sym = graph.symbols[`data:${dn.id}`];
      const touchesGroup = (sym?.usedBy || []).some((u) => {
        const clean = u.split(" ")[0]!;
        return clean.startsWith("action:") && grpActionIds.has(clean.slice(7));
      });
      const triggersGroup = [
        ...(dn.quickActions || []),
        ...(dn.rowActions || []),
        ...(dn.bulkActions || []),
      ].some((tr) => grpActionIds.has(tr.actionId));
      return touchesGroup || triggersGroup;
    });

    for (const rd of relatedData) assignedDataIds.add(rd.id);

    const cleanGrp = {
      name: grp.name,
      ...(grp.description ? { description: grp.description } : {}),
      actions: grp.actions,
    };

    const modDoc: Record<string, any> = {};
    if (relatedData.length > 0) modDoc.data = relatedData;
    modDoc.actionGroups = [cleanGrp];
    modules[modRel.replace(/^\.\//, "")] = YAML.stringify(modDoc, { indent: 2, lineWidth: 100 });
  });

  const remainingData = dataNodes.filter((dn) => !assignedDataIds.has(dn.id));
  const rootDoc: Record<string, any> = {
    id: skill.manifest.id,
    name: skill.manifest.name,
    category: skill.manifest.category,
    description: skill.manifest.description,
    ...(skill.manifest.icon ? { icon: skill.manifest.icon } : {}),
    ...(skill.manifest.defaultWorkspace ? { defaultWorkspace: skill.manifest.defaultWorkspace } : {}),
    ...(skill.manifest.tsPrelude ? { tsPrelude: skill.manifest.tsPrelude } : {}),
    ...(skill.manifest.tags?.length ? { tags: skill.manifest.tags } : {}),
    ...(skill.manifest.defaultPrompt ? { defaultPrompt: skill.manifest.defaultPrompt } : {}),
    ...(skill.manifest.envVars?.length ? { envVars: skill.manifest.envVars } : {}),
    ...(skill.manifest.context?.length ? { context: skill.manifest.context } : {}),
    includes: includePaths,
    ...(remainingData.length > 0 ? { data: remainingData } : {}),
    ...(skill.manifest.views?.length ? { views: skill.manifest.views } : {}),
  };

  const rootYaml = YAML.stringify(rootDoc, { indent: 2, lineWidth: 100 });

  if (writeToDisk) {
    const dashDir = join(skill.canonicalPath, ".dashboard");
    mkdirSync(join(dashDir, "modules"), { recursive: true });
    for (const [relPath, yamlContent] of Object.entries(modules)) {
      const target = join(dashDir, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, yamlContent, "utf-8");
    }
    writeFileSync(join(dashDir, "manifest.yaml"), rootYaml, "utf-8");
  }

  return { rootYaml, modules };
}

export interface FolderInspectionReport {
  dirPath: string;
  folderName: string;
  hasManifest: boolean;
  hasSkillMd: boolean;
  hasReadme: boolean;
  hasGit: boolean;
  hasVenv: boolean;
  packageScripts: Record<string, string>;
  makefileTargets: string[];
  scriptFiles: string[];
  markdownFiles: string[];
  envKeys: string[];
}

export function inspectTargetDirectory(targetDir: string): FolderInspectionReport {
  const dirPath = resolve(targetDir);
  const folderName = basename(dirPath);
  const hasManifest =
    existsSync(join(dirPath, ".dashboard/manifest.yaml")) ||
    existsSync(join(dirPath, ".dashboard/manifest.json"));
  const hasSkillMd = existsSync(join(dirPath, "SKILL.md"));
  const hasReadme = existsSync(join(dirPath, "README.md"));
  const hasGit = existsSync(join(dirPath, ".git"));
  const hasVenv = existsSync(join(dirPath, ".venv/bin/python"));

  const packageScripts: Record<string, string> = {};
  const pkgPath = join(dirPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg?.scripts && typeof pkg.scripts === "object") {
        for (const [k, v] of Object.entries(pkg.scripts)) {
          packageScripts[k] = String(v);
        }
      }
    } catch {}
  }

  const makefileTargets: string[] = [];
  for (const mkName of ["Makefile", "makefile", "Justfile", "justfile"]) {
    const mkPath = join(dirPath, mkName);
    if (existsSync(mkPath)) {
      try {
        const raw = readFileSync(mkPath, "utf-8");
        for (const m of raw.matchAll(/^([a-zA-Z0-9_-]+)\s*:/gm)) {
          if (m[1] && !m[1].startsWith(".")) makefileTargets.push(m[1]);
        }
      } catch {}
    }
  }

  const scriptFiles: string[] = [];
  for (const sub of ["scripts", "tools", "bin", "."]) {
    const subDir = join(dirPath, sub);
    if (!existsSync(subDir) || !statSync(subDir).isDirectory()) continue;
    try {
      for (const f of readdirSync(subDir)) {
        if (f.startsWith(".")) continue;
        if (/\.(sh|py|ts|mjs|zsh)$/i.test(f)) {
          scriptFiles.push(sub === "." ? f : `${sub}/${f}`);
        }
      }
    } catch {}
  }

  const markdownFiles: string[] = [];
  for (const sub of [".", "docs", "references"]) {
    const subDir = join(dirPath, sub);
    if (!existsSync(subDir) || !statSync(subDir).isDirectory()) continue;
    try {
      for (const f of readdirSync(subDir)) {
        if (f.endsWith(".md")) {
          markdownFiles.push(sub === "." ? f : `${sub}/${f}`);
        }
      }
    } catch {}
  }

  const envKeys: string[] = [];
  for (const envFile of [".env.example", ".env.template", ".env.sample"]) {
    const ep = join(dirPath, envFile);
    if (existsSync(ep)) {
      try {
        const raw = readFileSync(ep, "utf-8");
        for (const m of raw.matchAll(/^([A-Z][A-Z0-9_]+)\s*=/gm)) {
          if (m[1] && !envKeys.includes(m[1])) envKeys.push(m[1]);
        }
      } catch {}
    }
  }

  return {
    dirPath,
    folderName,
    hasManifest,
    hasSkillMd,
    hasReadme,
    hasGit,
    hasVenv,
    packageScripts,
    makefileTargets,
    scriptFiles: scriptFiles.slice(0, 30),
    markdownFiles: markdownFiles.slice(0, 20),
    envKeys,
  };
}

export function initManifestInDirectory(
  targetDir: string,
  options?: { modular?: boolean; force?: boolean; title?: string }
): { manifestPath: string; created: boolean } {
  const info = inspectTargetDirectory(targetDir);
  const dashDir = join(info.dirPath, ".dashboard");
  const manifestPath = join(dashDir, "manifest.yaml");
  if (existsSync(manifestPath) && !options?.force) {
    return { manifestPath, created: false };
  }
  mkdirSync(dashDir, { recursive: true });
  if (options?.modular) {
    mkdirSync(join(dashDir, "modules"), { recursive: true });
  }

  const actions: any[] = [];
  for (const [scriptName, scriptCmd] of Object.entries(info.packageScripts).slice(0, 8)) {
    actions.push({
      id: `pkg-${scriptName.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      title: `Run ${scriptName}`,
      subgroup: "1.1 Package Scripts",
      description: scriptCmd,
      danger: /prod|deploy|drop|clean/i.test(scriptName) ? "warn" : "safe",
      cwd: "project_root",
      command: `bun run ${scriptName}`,
    });
  }
  for (const target of info.makefileTargets.slice(0, 6)) {
    actions.push({
      id: `make-${target}`,
      title: `make ${target}`,
      subgroup: "1.2 Makefile Targets",
      danger: "safe",
      cwd: "project_root",
      command: `make ${target}`,
    });
  }
  if (actions.length === 0) {
    actions.push({
      id: "workspace-status",
      title: "Inspect Directory Status",
      subgroup: "1.1 General",
      danger: "safe",
      cwd: "project_root",
      command: info.hasGit ? "git status -sb" : "ls -la",
    });
  }

  const views = info.markdownFiles.slice(0, 5).map((md, idx) => ({
    id: idx === 0 ? "overview" : md.replace(/[^a-zA-Z0-9_-]/g, "-"),
    title: md,
    type: "markdown",
    source: md,
  }));

  const doc: Record<string, any> = {
    id: info.folderName,
    name: options?.title || info.folderName,
    category: "Engineering Tools",
    description: `Interactive Studio console for ${info.folderName}`,
    defaultWorkspace: info.dirPath,
    tsPrelude: true,
    ...(info.envKeys.length > 0
      ? {
          envVars: info.envKeys.map((k) => ({ key: k, label: k })),
        }
      : {}),
    data: [
      {
        id: "workspace-summary",
        title: "Workspace Telemetry",
        runtime: "ts",
        prelude: true,
        shape: "kv",
        code: `const entries = fs.readdirSync(ctx.workspace);\nreturn {\n  "Workspace": ctx.workspace,\n  "Top-Level Entries": entries.length,\n  "Data Sandbox": ctx.dataDir,\n};`,
      },
    ],
    ...(views.length > 0 ? { views } : {}),
    actionGroups: [
      {
        name: "1. Workspace Operations",
        actions,
      },
    ],
  };

  writeFileSync(manifestPath, YAML.stringify(doc, { indent: 2, lineWidth: 100 }), "utf-8");
  return { manifestPath, created: true };
}

export function getManifestSchemaSnippet(section?: string): string {
  const templates: Record<string, string> = {
    data: `# Polyglot Data Node (Reactive 2.0) — Recommended: prelude: true for runtime: ts
data:
  - id: my-data-node
    title: "Live Data Table"
    runtime: ts # zsh | ts | python | sqlite | glob | file | passive
    prelude: true # Pre-injects { fs, path, os, Database, YAML, $ } in outer scope
    shape: table # scalar | kv | list | table | matrix | stream | raw
    primaryKey: "id"
    valueColumn: "id"
    code: |
      const files = fs.readdirSync(ctx.skillDir);
      return files.map((name) => ({ id: name, path: path.join(ctx.skillDir, name) }));
    rowActions:
      - label: "Inspect"
        actionId: my-action
        mode: prefill
        args: { target: "{{row.id}}" }`,
    includes: `# Explicit Modular .dashboard/manifest.yaml
id: my-skill
name: "My Modular Skill"
category: "Engineering Tools"
description: "Modular skill with explicit includes and defs"
tsPrelude: true
includes:
  - ./modules/01-domain-a.yaml
  - ./modules/02-domain-b.yaml
defs:
  envField:
    key: env
    label: "Target Env"
    type: select
    flag: "--env"
    default: "uat"`,
    action: `# ActionGroup & ActionItem (with fromData & output.intoData)
actionGroups:
  - name: "1. Core Operations"
    actions:
      - id: my-action
        title: "Run Operation"
        subgroup: "1.1 Subcommands"
        danger: safe # safe | warn | danger
        script: |
          echo "Running on {{form.target}} in {{context.target_env}}"
        form:
          - key: target
            label: "Target"
            type: select
            positional: true
            fromData: my-data-node`,
  };
  if (section && templates[section]) return templates[section]!;
  return Object.values(templates).join("\n\n---\n\n");
}

async function runCli() {
  const args = process.argv.slice(2);
  const sub = args[0] || "validate";
  const homeDir = process.env.HOME || homedir();
  const activeWorkspace = process.cwd();
  const paths = resolveDashboardPaths({ homeDir });
  ensureDashboardDirectories(paths);
  const dataDir = paths.dataDir;
  const config = loadDashboardConfig(paths);
  const lockfiles = [
    join(homeDir, ".agents/.skill-lock.json"),
    join(homeDir, "skills-lock.json"),
  ];

  if (sub === "schema") {
    console.log(getManifestSchemaSnippet(args[1]));
    return;
  }

  if (sub === "inspect") {
    const targetDir = expandHomePath(args[1] || process.cwd(), homeDir);
    const report = inspectTargetDirectory(targetDir);
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Directory       : ${report.dirPath}`);
      console.log(`Has .dashboard  : ${report.hasManifest ? "YES" : "NO"}`);
      console.log(`Git / Python    : git=${report.hasGit} | .venv=${report.hasVenv}`);
      console.log(`Package Scripts : ${Object.keys(report.packageScripts).join(", ") || "(none)"}`);
      console.log(`Makefile Targets: ${report.makefileTargets.join(", ") || "(none)"}`);
      console.log(`Scripts/Tools   : ${report.scriptFiles.join(", ") || "(none)"}`);
      console.log(`Markdown Docs   : ${report.markdownFiles.join(", ") || "(none)"}`);
      console.log(`Env Keys        : ${report.envKeys.join(", ") || "(none)"}`);
    }
    return;
  }

  if (sub === "init") {
    const targetDir = expandHomePath(args[1] || process.cwd(), homeDir);
    const modular = args.includes("--modular");
    const force = args.includes("--force");
    const res = initManifestInDirectory(targetDir, { modular, force });
    console.log(
      `${res.created ? "✅ Initialized" : "ℹ️  Already exists"}: ${res.manifestPath}`
    );
    return;
  }

  if (sub === "folder") {
    const action = args[1] || "list";
    if (action === "list") {
      console.log(JSON.stringify(config.managedFolders, null, 2));
      return;
    }
    const targetRaw = args[2] || process.cwd();
    const resolvedDir = resolve(expandHomePath(targetRaw, homeDir));
    if (action === "add") {
      if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
        console.error(`Directory not found: ${resolvedDir}`);
        process.exit(1);
      }
      if (!config.managedFolders.some((f) => resolve(expandHomePath(f.path, homeDir)) === resolvedDir)) {
        config.managedFolders.push({
          path: resolvedDir,
          addedAt: new Date().toISOString(),
        });
        saveDashboardConfig(paths, config);
      }
      if (args.includes("--init") || config.preferences.unconfiguredFolderAction === "skeleton") {
        initManifestInDirectory(resolvedDir);
      }
      console.log(`✅ Managed folder registered: ${resolvedDir}`);
      return;
    }
    if (action === "remove") {
      config.managedFolders = config.managedFolders.filter(
        (f) => resolve(expandHomePath(f.path, homeDir)) !== resolvedDir
      );
      saveDashboardConfig(paths, config);
      console.log(`🗑️  Removed managed folder: ${resolvedDir}`);
      return;
    }
  }

  if (sub === "scratchpad") {
    const action = args[1] || "list";
    if (action === "create") {
      let padId = "";
      let title = "";
      let projectRoot = activeWorkspace;
      let fromYaml = "";
      for (let i = 2; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--id" && args[i + 1]) padId = args[++i]!;
        else if (a === "--title" && args[i + 1]) title = args[++i]!;
        else if (a === "--project" && args[i + 1]) projectRoot = expandHomePath(args[++i]!, homeDir);
        else if (a === "--from" && args[i + 1]) fromYaml = expandHomePath(args[++i]!, homeDir);
        else if (!a.startsWith("--") && !padId) padId = a;
      }
      const slug = sanitizeUnitSegment(padId || `pad-${Date.now().toString(36)}`);
      const projectSlug = deriveProjectSlug(projectRoot);
      const padDir = join(paths.scratchpadsRoot, projectSlug, slug);
      const dashDir = join(padDir, ".dashboard");
      mkdirSync(dashDir, { recursive: true });

      writeFileSync(
        join(padDir, "meta.json"),
        JSON.stringify(
          {
            id: slug,
            title: title || slug,
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
      if (fromYaml && existsSync(fromYaml)) {
        const parsed = YAML.parse(readFileSync(fromYaml, "utf-8")) || {};
        parsed.id = parsed.id || slug;
        parsed.defaultWorkspace = parsed.defaultWorkspace || projectRoot;
        writeFileSync(manifestPath, YAML.stringify(parsed, { indent: 2, lineWidth: 100 }), "utf-8");
      } else if (!existsSync(manifestPath)) {
        const doc = {
          id: slug,
          name: title || `Scratchpad: ${slug}`,
          category: "Agent & Automation",
          description: `Ephemeral interactive Agent console bound to ${basename(projectRoot)}`,
          defaultWorkspace: projectRoot,
          tsPrelude: true,
          data: [
            {
              id: "pad-context",
              title: "Scratchpad Bound Context",
              runtime: "ts",
              prelude: true,
              shape: "kv",
              code: `return {\n  "Scratchpad ID": "${slug}",\n  "Bound Workspace": ctx.workspace,\n  "Data Dir": ctx.dataDir,\n};`,
            },
          ],
          actionGroups: [
            {
              name: "1. Interactive Actions",
              actions: [
                {
                  id: "verify-workspace",
                  title: "Check Bound Workspace Status",
                  subgroup: "1.1 Diagnostics",
                  danger: "safe",
                  cwd: "project_root",
                  command: "pwd && ls -la",
                },
              ],
            },
          ],
        };
        writeFileSync(manifestPath, YAML.stringify(doc, { indent: 2, lineWidth: 100 }), "utf-8");
      }

      const { skills: discoveredAfterCreate } = discoverCanonicalSkills({
        agentRoots: getDefaultAgentRoots(homeDir, activeWorkspace),
        lockfiles,
        dataDir,
        overridesDir: paths.overridesDir,
        scratchpadsRoot: paths.scratchpadsRoot,
        managedFolders: config.managedFolders,
        watchRoots: config.watchRoots,
        activeWorkspace,
        homeDir,
      });
      const createdUnit =
        discoveredAfterCreate.find((u) => u.canonicalPath === padDir) ||
        discoveredAfterCreate.find((u) => u.id === slug);
      const validationIssues = createdUnit ? validateSkillManifest3Tier(createdUnit) : [];
      const errors = validationIssues.filter((i) => i.severity === "error");
      if (errors.length > 0) {
        console.error(`Scratchpad validation failed (${errors.length} error(s)):`);
        for (const e of errors) console.error(`  - [${e.level}] ${e.message}`);
        process.exit(1);
      }

      const effectiveUnitId = createdUnit?.id || slug;
      const port = config.server?.port || Number(process.env.PORT || "8766");
      const deepLink = `http://127.0.0.1:${port}/?id=${encodeURIComponent(effectiveUnitId)}`;
      console.log(`Direct URL: ${deepLink}`);
      console.log(
        JSON.stringify(
          {
            ok: true,
            unitId: effectiveUnitId,
            projectSlug,
            padDir,
            manifestPath,
            deepLink,
            validated: true,
          },
          null,
          2
        )
      );
      return;
    }

    if (action === "list") {
      const { skills: allUnits } = discoverCanonicalSkills({
        agentRoots: getDefaultAgentRoots(homeDir, activeWorkspace),
        lockfiles,
        dataDir,
        overridesDir: paths.overridesDir,
        scratchpadsRoot: paths.scratchpadsRoot,
        managedFolders: config.managedFolders,
        watchRoots: config.watchRoots,
        activeWorkspace,
        homeDir,
      });
      const pads = allUnits.filter((u) => u.unitKind === "scratchpad");
      console.log(
        JSON.stringify(
          pads.map((p) => ({
            id: p.id,
            name: p.manifest.name,
            projectSlug: p.projectSlug,
            canonicalPath: p.canonicalPath,
            effectiveWorkspace: p.effectiveWorkspace,
          })),
          null,
          2
        )
      );
      return;
    }

    if (action === "promote") {
      const targetId = args[2];
      if (!targetId) {
        console.error("Usage: bun src/manifest-cli.ts scratchpad promote <id> [--to project|skill]");
        process.exit(1);
      }
      let toMode: "project" | "skill" = "project";
      const toIdx = args.indexOf("--to");
      if (toIdx !== -1 && args[toIdx + 1] === "skill") toMode = "skill";

      const { skills: allUnits } = discoverCanonicalSkills({
        agentRoots: getDefaultAgentRoots(homeDir, activeWorkspace),
        lockfiles,
        dataDir,
        overridesDir: paths.overridesDir,
        scratchpadsRoot: paths.scratchpadsRoot,
        managedFolders: config.managedFolders,
        watchRoots: config.watchRoots,
        activeWorkspace,
        homeDir,
      });
      const padUnit = allUnits.find((u) => u.id === targetId);
      if (!padUnit) {
        console.error(`Scratchpad not found: ${targetId}`);
        process.exit(1);
      }

      const srcDash = join(padUnit.canonicalPath, ".dashboard");
      let destRoot = "";
      let promotedId = "";
      if (toMode === "project") {
        destRoot = padUnit.effectiveWorkspace;
        promotedId = basename(destRoot);
        mkdirSync(join(destRoot, ".dashboard"), { recursive: true });
        if (existsSync(srcDash)) cpSync(srcDash, join(destRoot, ".dashboard"), { recursive: true });
        if (!config.managedFolders.some((f) => resolve(expandHomePath(f.path, homeDir)) === resolve(destRoot))) {
          config.managedFolders.push({ path: resolve(destRoot), addedAt: new Date().toISOString() });
          saveDashboardConfig(paths, config);
        }
      } else {
        promotedId = sanitizeUnitSegment(padUnit.id.replace(/^pad-[^-]+-/, ""));
        destRoot = join(homeDir, ".agents/skills", promotedId);
        mkdirSync(destRoot, { recursive: true });
        if (existsSync(srcDash)) cpSync(srcDash, join(destRoot, ".dashboard"), { recursive: true });
        const skillMd = join(destRoot, "SKILL.md");
        if (!existsSync(skillMd)) {
          writeFileSync(
            skillMd,
            `---\nname: ${promotedId}\ndescription: ${padUnit.manifest.description}\n---\n\n# ${padUnit.manifest.name}\n`,
            "utf-8"
          );
        }
      }

      const destManifestPath = join(destRoot, ".dashboard/manifest.yaml");
      if (existsSync(destManifestPath)) {
        try {
          const parsed = YAML.parse(readFileSync(destManifestPath, "utf-8")) || {};
          parsed.id = promotedId;
          writeFileSync(destManifestPath, YAML.stringify(parsed, { indent: 2, lineWidth: 100 }), "utf-8");
        } catch {}
      }

      const oldSandbox = ensureUnitSandboxPaths(paths, padUnit.id);
      const newSandbox = ensureUnitSandboxPaths(paths, promotedId);
      if (oldSandbox.unitDataDir !== newSandbox.unitDataDir && existsSync(oldSandbox.unitDataDir)) {
        cpSync(oldSandbox.unitDataDir, newSandbox.unitDataDir, { recursive: true });
      }
      rmSync(padUnit.canonicalPath, { recursive: true, force: true });
      console.log(JSON.stringify({ promoted: true, to: toMode, promotedId, destRoot }, null, 2));
      return;
    }

    if (action === "delete" || action === "clean") {
      const targetId = args[2];
      const { skills: allUnits } = discoverCanonicalSkills({
        agentRoots: getDefaultAgentRoots(homeDir, activeWorkspace),
        lockfiles,
        dataDir,
        overridesDir: paths.overridesDir,
        scratchpadsRoot: paths.scratchpadsRoot,
        managedFolders: config.managedFolders,
        watchRoots: config.watchRoots,
        activeWorkspace,
        homeDir,
      });
      const pads = allUnits.filter(
        (u) => u.unitKind === "scratchpad" && (!targetId || u.id === targetId)
      );
      for (const p of pads) {
        rmSync(p.canonicalPath, { recursive: true, force: true });
      }
      console.log(`🗑️  Cleaned ${pads.length} scratchpad(s).`);
      return;
    }
  }

  if (sub === "wait") {
    const unitId = args[1];
    if (!unitId) {
      console.error("Usage: bun src/manifest-cli.ts wait <unit_id> [--since <seq_or_ts>] [--timeout <sec>]");
      process.exit(1);
    }
    let sinceVal = 0;
    let timeoutSec = 120;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--since" && args[i + 1]) sinceVal = Number(args[++i]);
      else if (args[i] === "--timeout" && args[i + 1]) timeoutSec = Number(args[++i]);
    }
    const db = new DashboardDatabase(dataDir);
    const isSeq = sinceVal > 0 && sinceVal < 1_000_000_000;
    const startWait = Date.now();
    const effectiveSinceTs = sinceVal === 0 ? startWait - 500 : !isSeq ? sinceVal : undefined;
    const effectiveSinceId = isSeq ? sinceVal : undefined;

    try {
      while (Date.now() - startWait < timeoutSec * 1000) {
        const events = db.listUnitEvents({
          unitId,
          sinceId: effectiveSinceId,
          sinceTs: effectiveSinceTs,
          limit: 5,
        });
        if (events.length > 0) {
          console.log(JSON.stringify({ ok: true, event: events[0], events }, null, 2));
          return;
        }
        await Bun.sleep(150);
      }
      console.log(JSON.stringify({ ok: false, timedOut: true, unitId }, null, 2));
      process.exit(1);
    } finally {
      db.close();
    }
  }

  const { skills } = discoverCanonicalSkills({
    agentRoots: getDefaultAgentRoots(homeDir, activeWorkspace),
    lockfiles,
    dataDir,
    overridesDir: paths.overridesDir,
    scratchpadsRoot: paths.scratchpadsRoot,
    managedFolders: config.managedFolders,
    watchRoots: config.watchRoots,
    activeWorkspace,
    homeDir,
  });

  const findSkill = (id?: string) => {
    const s = skills.find((k) => k.id === id);
    if (!s) {
      console.error(`Skill not found: ${id}`);
      process.exit(1);
    }
    return s;
  };

  if (sub === "map") {
    const skill = findSkill(args[1]);
    const graph = buildManifestSymbolGraph(skill);
    if (args.includes("--json")) {
      console.log(JSON.stringify(graph, null, 2));
    } else {
      console.log(formatManifestMapReport(graph));
    }
    return;
  }

  if (sub === "refs") {
    const skill = findSkill(args[1]);
    const symId = args[2];
    if (!symId) {
      console.error("Usage: bun src/manifest-cli.ts refs <skill_id> <symbol_id>");
      process.exit(1);
    }
    const graph = buildManifestSymbolGraph(skill);
    console.log(formatSymbolRefsReport(graph, symId));
    return;
  }

  if (sub === "bundle") {
    const skill = findSkill(args[1]);
    console.log(YAML.stringify(skill.manifest, { indent: 2, lineWidth: 100 }));
    return;
  }

  if (sub === "split") {
    const skill = findSkill(args[1]);
    const write = args.includes("--write");
    const res = splitMonolithicManifestToModules(skill, write);
    console.log(
      `${write ? "✅ Wrote" : "🔍 Dry-Run"} modular split for ${skill.id}: root manifest.yaml + ${Object.keys(res.modules).length} module files (${Object.keys(res.modules).join(", ")})`
    );
    if (!write) {
      console.log("Pass --write to persist modular files under .dashboard/modules/");
    }
    return;
  }

  if (sub === "eval-data") {
    const skill = findSkill(args[1]);
    let nodeId: string | undefined;
    const engine = new ReactiveGraphEngine();
    for (let i = 2; i < args.length; i++) {
      const arg = args[i]!;
      if (arg.startsWith("--context=")) {
        const [k, v] = arg.slice(10).split("=");
        if (k && v !== undefined) engine.setContextValue(skill, k, v);
      } else if (arg === "--context" && args[i + 1]) {
        const [k, v] = args[++i]!.split("=");
        if (k && v !== undefined) engine.setContextValue(skill, k, v);
      } else if (!arg.startsWith("--") && !nodeId) {
        nodeId = arg;
      }
    }
    if (nodeId) {
      const snap = await engine.evaluateNode({ skill, nodeId, force: true });
      console.log(JSON.stringify(snap, null, 2));
      engine.closeAllWatchers();
      process.exit(snap.status === "error" ? 1 : 0);
    } else {
      const all = await engine.evaluateAllSkillData({ skill, force: true });
      for (const [id, snap] of Object.entries(all)) {
        console.log(
          `${snap.status === "ready" ? "✅" : "❌"} ${id.padEnd(28)} [${snap.runtime}/${snap.shape}] (${snap.durationMs}ms)${snap.error ? ` — ${snap.error}` : ""}`
        );
      }
      engine.closeAllWatchers();
      process.exit(0);
    }
    return;
  }

  // Default: validate [<skill_id>]
  const targetSkillId = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  const targets = targetSkillId
    ? [findSkill(targetSkillId)]
    : skills.filter((s) => s.layers.companion);

  let totalErrors = 0;
  for (const s of targets) {
    const issues = validateSkillManifest3Tier(s);
    const errs = issues.filter((i) => i.severity === "error");
    const warns = issues.filter((i) => i.severity === "warn");
    totalErrors += errs.length;
    const actCount = s.manifest.actionGroups.reduce((a, g) => a + g.actions.length, 0);
    const modCount = s.layers.moduleFiles?.length || 1;
    if (errs.length === 0 && warns.length === 0) {
      console.log(
        `✅ [${s.id.padEnd(20)}] L1/L2/L3 Passed! (${modCount} files, ${s.manifest.data.length} data, ${actCount} actions, ${s.manifest.views.length} views)`
      );
    } else {
      console.log(
        `${errs.length > 0 ? "❌" : "⚠️ "} [${s.id.padEnd(20)}] ${errs.length} error(s), ${warns.length} warning(s):`
      );
      for (const iss of issues) {
        console.log(
          `   [${iss.level}] (${iss.file}${iss.symbolId ? ` -> ${iss.symbolId}` : ""}): ${iss.message}`
        );
        if (iss.fixHint) console.log(`      💡 Fix: ${iss.fixHint}`);
      }
    }
  }
  if (totalErrors > 0) process.exit(1);
}

if (import.meta.main) {
  runCli();
}
