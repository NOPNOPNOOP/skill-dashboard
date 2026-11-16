import {
  Activity,
  AlertTriangle,
  ArrowDownCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Columns,
  Copy,
  Database,
  Eye,
  GitBranch,
  Layers,
  LayoutGrid,
  ListTree,
  Pin,
  Play,
  RefreshCw,
  Search,
  ShieldAlert,
  Sliders,
  Terminal,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  buildSkillReactiveArchitecture,
  buildTreeFromArbitraryData,
  computeGraphTopology,
  doesActionPatternMatch,
  evaluateActionPrecondition,
  extractImplicitDependencies,
  inferDataPrimitive,
  interpolateBoundTriggerArgs,
  projectRecordsToGraph,
  projectRecordsToList,
  projectRecordsToMatrix,
  projectRecordsToTree,
  resolveSelfSnapshotPath,
  type ReactiveArchEdgeKind,
} from "../interpolator.ts";
import type {
  ActionGroup,
  ActionItem,
  BindingFocusScope,
  BoundActionTrigger,
  CanonicalSkill,
  CommandEnvConfig,
  ContextField,
  DataNode,
  DataPrimitive,
  DataShape,
  DataSnapshot,
  GraphEdgeItem,
  GraphNodeItem,
  ManifestSymbolProvenance,
  TableColumn,
  TreeNodeItem,
} from "../types.ts";
import { ActionCard } from "./ActionCard.tsx";
import { CommandEnvEditor } from "./CommandEnvEditor.tsx";
import { ansiToHtml, highlightCodeToHtml } from "./highlight.ts";

interface StatusProbesBarProps {
  skillId: string;
  contextFields: ContextField[];
  dataNodes: DataNode[];
  actionGroups?: ActionGroup[];
  activeWorkspace: string;
  refreshTrigger: number;
  commandEnvOverrides?: Record<string, CommandEnvConfig>;
  skillProvenance?: ManifestSymbolProvenance;
  jumpDataNodeRequest?: { nodeId: string; seq: number } | null;
  onSkillUpdated?: (skill: CanonicalSkill) => void;
  onContextChanged?: (nextContext: Record<string, string | boolean>) => void;
  onSnapshotsChanged?: (snapshots: Record<string, DataSnapshot>) => void;
  onLocateActionInPlayground?: (actionId: string, formValues: Record<string, unknown>) => void;
  onExecute?: (params: {
    actionId?: string;
    adHocCommand?: string;
    adHocTitle?: string;
    formValues?: Record<string, unknown>;
    focusScope?: BindingFocusScope;
    runner: "web_terminal" | "external_terminal";
    terminalApp?: "Terminal" | "iTerm";
    humanApproved?: boolean;
  }) => Promise<void>;
  onExecuteBoundTrigger: (params: {
    actionId: string;
    mode: "run" | "prefill";
    formValues: Record<string, unknown>;
    focusScope?: BindingFocusScope;
  }) => Promise<void>;
}

interface ActiveBoundActionAudit {
  node: DataNode;
  triggerKind: "Row Action" | "Bulk Action" | "Quick Action" | "Cell Action" | "Node Action";
  trigger: BoundActionTrigger;
  resolvedArgs: Record<string, unknown>;
  focusScope: BindingFocusScope;
  scopeSummary?: string;
  seq: number;
}

export type DataScopeSelection =
  | { kind: "all" }
  | { kind: "category"; category: string }
  | { kind: "subgroup"; category: string; subgroup: string }
  | { kind: "node"; nodeId: string };

function getNodeCategoryAndSubgroup(node: DataNode): {
  category: string;
  subgroup?: string;
} {
  const rawCat = (node.category || "Data Nodes").trim();
  if (node.subgroup && node.subgroup.trim()) {
    return { category: rawCat || "Data Nodes", subgroup: node.subgroup.trim() };
  }
  if (rawCat.includes("/")) {
    const [c, ...rest] = rawCat.split("/");
    return {
      category: (c || "").trim() || "Data Nodes",
      subgroup: rest.join("/").trim() || undefined,
    };
  }
  return { category: rawCat || "Data Nodes", subgroup: undefined };
}

function getAvailableViewsForNode(
  node: DataNode,
  baseShape: DataShape,
  rawParsed: unknown
): DataShape[] {
  if (node.views && node.views.length > 0) {
    return node.views;
  }
  if (baseShape === "kv") return ["kv", "tree"];
  if (baseShape === "tree") {
    const isPlainObj =
      rawParsed !== null && typeof rawParsed === "object" && !Array.isArray(rawParsed);
    return isPlainObj ? ["tree", "kv"] : ["tree", "table"];
  }
  if (baseShape === "table" || baseShape === "matrix" || baseShape === "list") {
    const hasGraphSpec = Boolean(node.graphSpec?.dependsOnKey || node.graphSpec?.parentKey);
    return hasGraphSpec
      ? ["table", "matrix", "list", "tree", "graph"]
      : ["table", "matrix", "list", "tree"];
  }
  if (baseShape === "graph") {
    return ["graph", "table", "tree"];
  }
  return [];
}

function summarizeNodeSnapshot(node: DataNode, snap: DataSnapshot | undefined): string {
  if (!snap) return "Loading…";
  if (snap.status === "error") return "Error";
  const val = snap.value;
  if (val && Array.isArray(val.rows)) return `${val.rows.length} rows`;
  if (val && Array.isArray(val.nodes)) {
    return `${val.nodes.length} nodes · ${val.edges?.length || 0} edges`;
  }
  if (val && Array.isArray(val.roots)) return `${val.roots.length} roots`;
  if (val && Array.isArray(val.items)) return `${val.items.length} items`;
  if (val && Array.isArray(val.rowKeys)) {
    return `${val.rowKeys.length}×${val.colKeys?.length || 0} matrix`;
  }
  if (val && Array.isArray(val.entries)) return `${val.entries.length} keys`;
  if (val && val.value !== undefined && typeof val.value !== "object") {
    return `${val.value}${val.unit ? " " + val.unit : ""}`;
  }
  if (node.runtime === "passive" && !snap.stdout) return "Idle (passive)";
  return `${snap.durationMs}ms`;
}

function projectSnapshotToView(
  node: DataNode,
  snap: DataSnapshot | undefined,
  effectiveShape: DataShape
): any {
  if (!snap || !snap.value) return null;
  const baseShape = snap.shape || node.shape || "raw";
  if (effectiveShape === baseShape) return snap.value;

  const rawData = snap.rawParsed !== undefined ? snap.rawParsed : snap.value;

  // Extract flat records array for table / list / matrix / grouped-tree / graph projections
  const extractRows = (): Record<string, unknown>[] => {
    if (Array.isArray(snap.value?.rows)) return snap.value.rows;
    if (Array.isArray(snap.value?.nodes)) {
      return snap.value.nodes.map((n: GraphNodeItem) => ({
        id: n.id,
        label: n.label,
        value: n.value || n.id,
        layer: n.layer ?? 0,
        group: n.group || "default",
        upstreamCount: n.upstreamIds?.length || 0,
        downstreamCount: n.downstreamIds?.length || 0,
        downstreamIds: (n.downstreamIds || []).join(","),
        meta: n.meta || "",
      }));
    }
    if (Array.isArray(snap.value?.items)) {
      return snap.value.items.map((it: any) =>
        it.raw && typeof it.raw === "object"
          ? it.raw
          : { value: it.value, label: it.label, meta: it.meta }
      );
    }
    if (Array.isArray(rawData)) {
      return rawData.map((it) =>
        it && typeof it === "object" ? (it as Record<string, unknown>) : { value: it }
      );
    }
    if (snap.value?.rowKeys && snap.value?.colKeys && snap.value?.cells) {
      const out: Record<string, unknown>[] = [];
      for (const rk of snap.value.rowKeys) {
        for (const ck of snap.value.colKeys) {
          out.push({
            row: rk,
            col: ck,
            value: snap.value.cells?.[rk]?.[ck] ?? "—",
          });
        }
      }
      return out;
    }
    return [];
  };

  if (effectiveShape === "tree") {
    const rows = extractRows();
    if (rows.length > 0 && node.treeSpec?.groupBy && node.treeSpec.groupBy.length > 0) {
      return {
        roots: projectRecordsToTree(rows, node.treeSpec, node.primaryKey || "id"),
      };
    }
    return { roots: buildTreeFromArbitraryData(rawData) };
  }

  if (effectiveShape === "kv") {
    const rec: Record<string, unknown> =
      rawData && typeof rawData === "object" && !Array.isArray(rawData)
        ? (rawData as Record<string, unknown>)
        : { value: JSON.stringify(rawData) };
    const entries = Object.entries(rec).map(([k, v]) => {
      const isComplex = typeof v === "object" && v !== null;
      return {
        key: k,
        label: k,
        value: isComplex ? JSON.stringify(v) : (v as string | number | boolean),
        rawValue: isComplex ? v : undefined,
      };
    });
    return { entries, record: rec };
  }

  if (effectiveShape === "list") {
    const rows = extractRows();
    return { items: projectRecordsToList(rows, node.listSpec, node) };
  }

  if (effectiveShape === "table") {
    const rows = extractRows();
    const first = rows[0] || {};
    const columns: TableColumn[] =
      node.columns && node.columns.length > 0 && baseShape !== "graph"
        ? node.columns
        : Object.keys(first).map((k) => ({
            key: k,
            label: k,
            type:
              typeof first[k] === "boolean"
                ? "boolean"
                : typeof first[k] === "number"
                  ? "number"
                  : /status|state|tone|group/i.test(k)
                    ? "badge"
                    : /id|name|path|skill/i.test(k)
                      ? "code"
                      : "text",
          }));
    return {
      columns,
      rows,
      primaryKey: node.primaryKey || columns[0]?.key || "id",
    };
  }

  if (effectiveShape === "matrix") {
    if (baseShape === "matrix" && snap.value?.rowKeys && snap.value?.colKeys && snap.value?.cells) {
      return snap.value;
    }
    const rows = extractRows();
    return projectRecordsToMatrix(rows, node.pivot, node.primaryKey || "id");
  }

  if (effectiveShape === "graph") {
    if (
      Array.isArray((rawData as any)?.nodes) &&
      Array.isArray((rawData as any)?.edges)
    ) {
      return computeGraphTopology((rawData as any).nodes, (rawData as any).edges);
    }
    const rows = extractRows();
    return projectRecordsToGraph(rows, node.graphSpec, node.primaryKey || "id");
  }

  return snap.value;
}

export const StatusProbesBar: React.FC<StatusProbesBarProps> = ({
  skillId,
  contextFields,
  dataNodes,
  actionGroups = [],
  activeWorkspace,
  refreshTrigger,
  commandEnvOverrides,
  skillProvenance,
  jumpDataNodeRequest,
  onSkillUpdated,
  onContextChanged,
  onSnapshotsChanged,
  onLocateActionInPlayground,
  onExecute,
  onExecuteBoundTrigger,
}) => {
  const [contextState, setContextState] = useState<Record<string, string | boolean>>({});
  const [snapshots, setSnapshots] = useState<Record<string, DataSnapshot>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});
  const [tableSearch, setTableSearch] = useState<Record<string, string>>({});
  const [selectedRowKeys, setSelectedRowKeys] = useState<Record<string, Set<string>>>({});
  const [dataScope, setDataScope] = useState<DataScopeSelection>({ kind: "all" });
  const [expandedDataCategories, setExpandedDataCategories] = useState<Set<string>>(new Set());
  const [showIntermediates, setShowIntermediates] = useState<boolean>(false);
  const [openEnvNodeId, setOpenEnvNodeId] = useState<string | null>(null);
  const [inspectNodeId, setInspectNodeId] = useState<string | null>(null);
  const [inspectTabMap, setInspectTabMap] = useState<
    Record<string, "source" | "lineage" | "views" | "raw">
  >({});
  const [copiedSourceNodeId, setCopiedSourceNodeId] = useState<string | null>(null);
  const [activeAudit, setActiveAudit] = useState<ActiveBoundActionAudit | null>(null);
  const [viewModeOverride, setViewModeOverride] = useState<Record<string, DataShape>>({});
  const [expandedKvPaths, setExpandedKvPaths] = useState<Record<string, boolean>>({});
  const [collapsedTreeIds, setCollapsedTreeIds] = useState<Record<string, Set<string>>>({});
  const [activeGraphNodeId, setActiveGraphNodeId] = useState<Record<string, string | null>>({});
  const [workbenchLayout, setWorkbenchLayout] = useState<"split" | "accordion" | "grid">("split");
  const [scopeDisplayDensity, setScopeDisplayDensity] = useState<"cards" | "accordion" | "grid">(
    "cards"
  );
  const [pinnedNodeIds, setPinnedNodeIds] = useState<string[]>([]);
  const [expandedAccordionIds, setExpandedAccordionIds] = useState<Set<string>>(new Set());
  const [highlightedDataNodeId, setHighlightedDataNodeId] = useState<string | null>(null);
  const [archGraphOpen, setArchGraphOpen] = useState<boolean>(false);
  const [archEdgeFilter, setArchEdgeFilter] = useState<"all" | ReactiveArchEdgeKind>("all");
  const [selectedArchNodeId, setSelectedArchNodeId] = useState<string | null>(null);
  const skipNextRefreshTriggerRef = useRef<boolean>(false);

  useEffect(() => {
    onSnapshotsChanged?.(snapshots);
  }, [snapshots]);

  const actionsMap = useMemo(() => {
    const map = new Map<string, { action: ActionItem; groupName: string }>();
    for (const g of actionGroups || []) {
      for (const a of g.actions || []) {
        map.set(a.id, { action: a, groupName: g.name });
      }
      for (const sg of g.subgroups || []) {
        for (const a of sg.actions || []) {
          map.set(a.id, { action: a, groupName: `${g.name} / ${sg.name}` });
        }
      }
    }
    return map;
  }, [actionGroups]);

  useEffect(() => {
    if (!activeAudit) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setActiveAudit(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeAudit]);

  const intermediateNodes = (dataNodes || []).filter((n) => Boolean(n.intermediate || n.hidden));
  const primaryNodes = (dataNodes || []).filter((n) => !n.intermediate && !n.hidden);
  const activePool = showIntermediates ? (dataNodes || []) : primaryNodes;

  const scalarNodes = activePool.filter((n) => {
    const snap = snapshots[n.id];
    const baseShape = (snap?.shape || n.shape || "raw") as DataShape;
    const prim = snap?.primitive || inferDataPrimitive(baseShape, snap?.rawParsed);
    return (prim === "Scalar" || baseShape === "scalar") && !n.intermediate && !n.hidden;
  });

  const workbenchNodes = activePool.filter(
    (n) => !scalarNodes.some((sn) => sn.id === n.id)
  );

  // Build hierarchical Category -> Subgroup -> DataNode tree for workbenchNodes
  const dataHierarchyTree = useMemo(() => {
    const catMap = new Map<
      string,
      {
        category: string;
        nodes: DataNode[];
        subgroups: Map<string, DataNode[]>;
      }
    >();
    for (const n of workbenchNodes) {
      const { category, subgroup } = getNodeCategoryAndSubgroup(n);
      let entry = catMap.get(category);
      if (!entry) {
        entry = { category, nodes: [], subgroups: new Map() };
        catMap.set(category, entry);
      }
      entry.nodes.push(n);
      if (subgroup) {
        const sgList = entry.subgroups.get(subgroup) || [];
        sgList.push(n);
        entry.subgroups.set(subgroup, sgList);
      }
    }
    return Array.from(catMap.values());
  }, [workbenchNodes]);

  useEffect(() => {
    const nonScalarCount = (dataNodes || []).filter(
      (n) => !n.intermediate && !n.hidden && n.shape !== "scalar"
    ).length;
    setWorkbenchLayout(nonScalarCount >= 2 ? "split" : "grid");
    setScopeDisplayDensity("cards");
    const allCats = new Set<string>();
    for (const n of dataNodes || []) {
      allCats.add(getNodeCategoryAndSubgroup(n).category);
    }
    setExpandedDataCategories(allCats);

    const firstNonScalar = (dataNodes || []).find(
      (n) => !n.intermediate && !n.hidden && n.shape !== "scalar"
    );
    // Auto-pin the first master-detail node (with selectContextKey) if another node exists
    const masterNode = (dataNodes || []).find(
      (n) => Boolean(n.selectContextKey) && !n.intermediate && !n.hidden
    );
    if (masterNode && nonScalarCount >= 3) {
      setPinnedNodeIds([masterNode.id]);
      const firstDownstream = (dataNodes || []).find(
        (n) =>
          !n.intermediate &&
          !n.hidden &&
          n.shape !== "scalar" &&
          n.id !== masterNode.id
      );
      setDataScope(
        firstDownstream
          ? { kind: "node", nodeId: firstDownstream.id }
          : { kind: "all" }
      );
    } else {
      setPinnedNodeIds([]);
      setDataScope({ kind: "all" });
    }
    setExpandedAccordionIds(
      new Set(firstNonScalar ? [firstNonScalar.id] : [])
    );
  }, [skillId]);

  const jumpToDataNodeCard = (targetNodeId: string) => {
    const targetNode = (dataNodes || []).find((n) => n.id === targetNodeId);
    if (!targetNode) return;
    if (targetNode.intermediate || targetNode.hidden) {
      setShowIntermediates(true);
    }
    if (targetNode.shape !== "scalar") {
      setDataScope({ kind: "node", nodeId: targetNodeId });
      setExpandedAccordionIds((prev) => new Set([...prev, targetNodeId]));
    }
    setHighlightedDataNodeId(targetNodeId);
    setTimeout(() => {
      if (typeof document !== "undefined") {
        const el = document.querySelector(
          `[data-sd-pick-kind="data-node"][data-sd-pick-id="${targetNodeId}"]`
        );
        if (el && "scrollIntoView" in el) {
          (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }, 80);
    setTimeout(() => setHighlightedDataNodeId(null), 2400);
  };

  useEffect(() => {
    if (!jumpDataNodeRequest) return;
    jumpToDataNodeCard(jumpDataNodeRequest.nodeId);
  }, [jumpDataNodeRequest?.seq]);

  const togglePinNode = (nodeId: string) => {
    setPinnedNodeIds((prev) =>
      prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId]
    );
  };

  const reactiveArchGraph = useMemo(() => {
    return buildSkillReactiveArchitecture(
      {
        context: contextFields || [],
        data: dataNodes || [],
        actionGroups: actionGroups || [],
      },
      snapshots,
      skillProvenance
    );
  }, [contextFields, dataNodes, actionGroups, snapshots, skillProvenance]);

  const scopedWorkbenchNodes = useMemo(() => {
    if (dataScope.kind === "all") return workbenchNodes;
    if (dataScope.kind === "category") {
      return workbenchNodes.filter(
        (n) => getNodeCategoryAndSubgroup(n).category === dataScope.category
      );
    }
    if (dataScope.kind === "subgroup") {
      return workbenchNodes.filter((n) => {
        const parsed = getNodeCategoryAndSubgroup(n);
        return parsed.category === dataScope.category && parsed.subgroup === dataScope.subgroup;
      });
    }
    return workbenchNodes.filter((n) => n.id === dataScope.nodeId);
  }, [workbenchNodes, dataScope]);

  const scopeBreadcrumbText = useMemo(() => {
    if (dataScope.kind === "all") return `All Data Nodes (${workbenchNodes.length})`;
    if (dataScope.kind === "category")
      return `📁 ${dataScope.category} (${scopedWorkbenchNodes.length})`;
    if (dataScope.kind === "subgroup")
      return `📁 ${dataScope.category} / 📂 ${dataScope.subgroup} (${scopedWorkbenchNodes.length})`;
    const target = workbenchNodes.find((n) => n.id === dataScope.nodeId);
    return target ? `📄 ${target.title}` : `📄 ${dataScope.nodeId}`;
  }, [dataScope, workbenchNodes, scopedWorkbenchNodes]);

  const isAnyLoading = Object.values(loadingMap).some(Boolean);

  const loadAll = async (force = false, targetPool?: DataNode[]) => {
    const nodes = targetPool || activePool;
    const nextLoading: Record<string, boolean> = {};
    for (const n of nodes) nextLoading[n.id] = true;
    setLoadingMap((prev) => ({ ...prev, ...nextLoading }));

    try {
      const cRes = await fetch(
        `/api/skills/${encodeURIComponent(skillId)}/context${force ? "?invalidate=1" : ""}`
      );
      if (cRes.ok) {
        const cBody = await cRes.json();
        setContextState(cBody.context || {});
      }
    } catch {
      // ignore
    }

    await Promise.all(
      nodes.map(async (node) => {
        try {
          const res = await fetch(
            `/api/skills/${encodeURIComponent(skillId)}/data/${encodeURIComponent(node.id)}`
          );
          if (res.ok) {
            const snap = (await res.json()) as DataSnapshot;
            setSnapshots((prev) => ({ ...prev, [node.id]: snap }));
          } else {
            const errSnap: DataSnapshot = {
              nodeId: node.id,
              title: node.title,
              shape: node.shape || "raw",
              runtime: node.runtime || "zsh",
              status: "error",
              value: null,
              options: [],
              stdout: "",
              stderr: "Request failed",
              exitCode: 1,
              timedOut: false,
              durationMs: 0,
              updatedAt: Date.now(),
              fromCache: false,
              error: `HTTP ${res.status}`,
            };
            setSnapshots((prev) => ({ ...prev, [node.id]: errSnap }));
          }
        } catch (err: any) {
          const errSnap: DataSnapshot = {
            nodeId: node.id,
            title: node.title,
            shape: node.shape || "raw",
            runtime: node.runtime || "zsh",
            status: "error",
            value: null,
            options: [],
            stdout: "",
            stderr: String(err?.message || "Request failed"),
            exitCode: 1,
            timedOut: false,
            durationMs: 0,
            updatedAt: Date.now(),
            fromCache: false,
            error: String(err?.message || "Request failed"),
          };
          setSnapshots((prev) => ({ ...prev, [node.id]: errSnap }));
        } finally {
          setLoadingMap((prev) => ({ ...prev, [node.id]: false }));
        }
      })
    );
  };

  const refreshSingleNode = async (node: DataNode) => {
    setLoadingMap((prev) => ({ ...prev, [node.id]: true }));
    try {
      const res = await fetch(
        `/api/skills/${encodeURIComponent(skillId)}/data/${encodeURIComponent(node.id)}?force=1`
      );
      if (res.ok) {
        const snap = (await res.json()) as DataSnapshot;
        setSnapshots((prev) => ({ ...prev, [node.id]: snap }));
      } else {
        const errSnap: DataSnapshot = {
          nodeId: node.id,
          title: node.title,
          shape: node.shape || "raw",
          runtime: node.runtime || "zsh",
          status: "error",
          value: null,
          options: [],
          stdout: "",
          stderr: "Request failed",
          exitCode: 1,
          timedOut: false,
          durationMs: 0,
          updatedAt: Date.now(),
          fromCache: false,
          error: `HTTP ${res.status}`,
        };
        setSnapshots((prev) => ({ ...prev, [node.id]: errSnap }));
      }
    } catch (err: any) {
      const errSnap: DataSnapshot = {
        nodeId: node.id,
        title: node.title,
        shape: node.shape || "raw",
        runtime: node.runtime || "zsh",
        status: "error",
        value: null,
        options: [],
        stdout: "",
        stderr: String(err?.message || "Request failed"),
        exitCode: 1,
        timedOut: false,
        durationMs: 0,
        updatedAt: Date.now(),
        fromCache: false,
        error: String(err?.message || "Request failed"),
      };
      setSnapshots((prev) => ({ ...prev, [node.id]: errSnap }));
    } finally {
      setLoadingMap((prev) => ({ ...prev, [node.id]: false }));
    }
  };

  const updateContextField = async (key: string, value: string | boolean) => {
    setContextState((prev) => ({ ...prev, [key]: value }));
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}/context`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (res.ok) {
        const body = await res.json();
        setContextState(body.context || {});
        setSnapshots(body.snapshots || {});
        skipNextRefreshTriggerRef.current = true;
        onContextChanged?.(body.context || {});
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    setSnapshots({});
    setSelectedRowKeys({});
    setViewModeOverride({});
    setExpandedKvPaths({});
    setCollapsedTreeIds({});
    setActiveGraphNodeId({});
    setOpenEnvNodeId(null);
    setInspectNodeId(null);
    setActiveAudit(null);
    setSelectedArchNodeId(null);
    loadAll(false);
  }, [skillId, activeWorkspace]);

  useEffect(() => {
    if (refreshTrigger > 0) {
      if (skipNextRefreshTriggerRef.current) {
        skipNextRefreshTriggerRef.current = false;
        return;
      }
      loadAll(true);
    }
  }, [refreshTrigger]);

  // Foreground interval polling for nodes with sync.pollMs
  useEffect(() => {
    const timers: Array<ReturnType<typeof setInterval>> = [];
    for (const node of (dataNodes || []).filter((n) => !n.hidden)) {
      const pollMs = node.sync?.pollMs;
      if (pollMs && pollMs >= 1000) {
        const timer = setInterval(() => {
          if (typeof document === "undefined" || !document.hidden) {
            refreshSingleNode(node);
          }
        }, pollMs);
        timers.push(timer);
      }
    }
    return () => {
      for (const t of timers) clearInterval(t);
    };
  }, [skillId, activeWorkspace, JSON.stringify((dataNodes || []).map((n) => [n.id, n.sync?.pollMs]))]);

  if ((!contextFields || contextFields.length === 0) && (dataNodes || []).length === 0) {
    return null;
  }

  const triggerBound = (
    node: DataNode,
    triggerKind: ActiveBoundActionAudit["triggerKind"],
    trigger: BoundActionTrigger,
    scope: {
      row?: Record<string, unknown>;
      selectedRows?: Record<string, unknown>[];
      cell?: { rowKey: string; colKey: string; value: unknown; rawRow?: Record<string, unknown> };
      node?: {
        id: string;
        label?: string;
        value?: unknown;
        path?: string;
        upstreamIds?: string[];
        downstreamIds?: string[];
        rawRow?: Record<string, unknown>;
      };
      scopeSummary?: string;
    }
  ) => {
    const focusScope: BindingFocusScope = {
      hostNodeId: node.id,
      row: scope.row,
      selectedRows: scope.selectedRows,
      cell: scope.cell,
      node: scope.node,
    };
    const resolvedArgs = interpolateBoundTriggerArgs(trigger.args, {
      ...focusScope,
      contextValues: contextState,
      dataSnapshots: snapshots,
    });
    setActiveAudit({
      node,
      triggerKind,
      trigger,
      resolvedArgs,
      focusScope,
      scopeSummary: scope.scopeSummary,
      seq: Date.now(),
    });
  };

  const handleBoundTriggerLeftClick = (
    node: DataNode,
    triggerKind: ActiveBoundActionAudit["triggerKind"],
    trigger: BoundActionTrigger,
    scope: {
      row?: Record<string, unknown>;
      selectedRows?: Record<string, unknown>[];
      cell?: { rowKey: string; colKey: string; value: unknown; rawRow?: Record<string, unknown> };
      node?: {
        id: string;
        label?: string;
        value?: unknown;
        path?: string;
        upstreamIds?: string[];
        downstreamIds?: string[];
        rawRow?: Record<string, unknown>;
      };
      scopeSummary?: string;
    }
  ) => {
    const actionId = trigger.actionId || "";
    const targetInfo = actionsMap.get(actionId);
    const targetAction = targetInfo?.action;
    if (!targetAction) {
      triggerBound(node, triggerKind, trigger, scope);
      return;
    }

    const focusScope: BindingFocusScope = {
      hostNodeId: node.id,
      row: scope.row,
      selectedRows: scope.selectedRows,
      cell: scope.cell,
      node: scope.node,
    };

    const resolvedArgs = interpolateBoundTriggerArgs(trigger.args, {
      ...focusScope,
      contextValues: contextState,
      dataSnapshots: snapshots,
    });

    const mergedFormValues: Record<string, unknown> = {};
    for (const f of targetAction.form || []) {
      if (f.default !== undefined) mergedFormValues[f.key] = f.default;
      else if (f.type === "boolean") mergedFormValues[f.key] = false;
      else mergedFormValues[f.key] = "";
    }
    for (const [k, v] of Object.entries(resolvedArgs)) {
      if (v !== undefined && v !== "") {
        mergedFormValues[k] = v;
      }
    }

    const hasMissingRequired = (targetAction.form || []).some((f) => {
      if (!f.required) return false;
      if (f.when && mergedFormValues[f.when.field] !== f.when.equals) return false;
      const val = mergedFormValues[f.key];
      return val === undefined || val === null || val === "";
    });

    const hasFailedPrecondition = (targetAction.preconditions || []).some(
      (pre) => !evaluateActionPrecondition(pre, snapshots).passed
    );

    if (
      trigger.mode === "prefill" ||
      targetAction.danger === "warn" ||
      targetAction.danger === "danger" ||
      Boolean(targetAction.requiresHumanApprovalFlag) ||
      hasMissingRequired ||
      hasFailedPrecondition
    ) {
      triggerBound(node, triggerKind, trigger, scope);
      return;
    }

    void onExecuteBoundTrigger({
      actionId,
      mode: "run",
      formValues: mergedFormValues,
      focusScope,
    });
  };

  const renderBoundTriggerButton = (
    node: DataNode,
    triggerKind: ActiveBoundActionAudit["triggerKind"],
    trigger: BoundActionTrigger,
    scope: {
      row?: Record<string, unknown>;
      selectedRows?: Record<string, unknown>[];
      cell?: { rowKey: string; colKey: string; value: unknown; rawRow?: Record<string, unknown> };
      node?: {
        id: string;
        label?: string;
        value?: unknown;
        path?: string;
        upstreamIds?: string[];
        downstreamIds?: string[];
        rawRow?: Record<string, unknown>;
      };
      scopeSummary?: string;
    },
    key: React.Key,
    variant: "secondary" | "primary" = "secondary"
  ) => {
    const targetInfo = actionsMap.get(trigger.actionId);
    const targetAction = targetInfo?.action;
    const isMissing = actionGroups.length > 0 && !targetAction;
    const dangerLevel = targetAction?.danger || "safe";
    const hasApprovalFlag = Boolean(targetAction?.requiresHumanApprovalFlag);
    const resolvedArgs = interpolateBoundTriggerArgs(trigger.args, {
      ...scope,
      contextValues: contextState,
      dataSnapshots: snapshots,
    });
    const argsEntries = Object.entries(resolvedArgs);
    const argsTooltip =
      argsEntries.length > 0
        ? argsEntries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")
        : "(default parameters)";

    const tooltip = isMissing
      ? `❌ Missing Action ID "${trigger.actionId}" (not found in actionGroups)`
      : `Target: ${targetAction?.title || trigger.actionId} (${trigger.actionId}) · Mode: ${
          trigger.mode || "run"
        } · Safety: ${dangerLevel}\nResolved Args: ${argsTooltip}\nLeft-Click: Execute · Right-Click: Configure & Audit`;

    return (
      <button
        key={key}
        type="button"
        onClick={() => handleBoundTriggerLeftClick(node, triggerKind, trigger, scope)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          triggerBound(node, triggerKind, trigger, scope);
        }}
        title={tooltip}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all border ${
          isMissing
            ? "bg-rose-500/10 text-rose-600 dark:text-rose-300 border-rose-500/40 border-dashed"
            : variant === "primary"
              ? "bg-sky-600 hover:bg-sky-500 text-white border-sky-500 shadow-sm"
              : "st-btn-secondary hover:border-sky-500/50"
        }`}
      >
        {isMissing ? (
          <AlertTriangle className="w-3 h-3 text-rose-500 shrink-0" />
        ) : dangerLevel === "danger" ? (
          <ShieldAlert className="w-3 h-3 text-rose-500 shrink-0" />
        ) : dangerLevel === "warn" || hasApprovalFlag ? (
          <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0" />
        ) : (
          <Play className="w-2.5 h-2.5 text-sky-500 fill-current shrink-0" />
        )}
        <span>{trigger.label}</span>
      </button>
    );
  };

  const renderCellContent = (col: TableColumn, rawVal: unknown) => {
    if (rawVal === undefined || rawVal === null) {
      return <span className="st-text-muted">—</span>;
    }
    const strVal = String(rawVal);

    if (col.type === "boolean") {
      const truthy = rawVal === true || strVal === "true" || strVal === "1";
      return (
        <span
          className={`px-2 py-0.5 rounded-md text-[11px] font-semibold ${
            truthy
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
              : "bg-slate-500/15 st-text-muted"
          }`}
        >
          {truthy ? "Yes" : "No"}
        </span>
      );
    }

    if (col.type === "badge") {
      const mappedTone = col.toneMap?.[strVal];
      const lower = strVal.toLowerCase();
      const tone =
        mappedTone ||
        (/ok|running|ready|pass|active|healthy|mounted|auto_hub/.test(lower)
          ? "success"
          : /warn|pending|queued|modified/.test(lower)
            ? "warn"
            : /err|fail|crash|broken|danger/.test(lower)
              ? "danger"
              : "info");
      const cls =
        tone === "success"
          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
          : tone === "warn"
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
            : tone === "danger"
              ? "bg-rose-500/15 text-rose-600 dark:text-rose-300 border-rose-500/30"
              : "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30";
      return (
        <span className={`px-2 py-0.5 rounded-md text-[11px] font-semibold border ${cls}`}>
          {strVal}
        </span>
      );
    }

    if (col.type === "progress") {
      const num = Math.max(0, Math.min(100, Number(rawVal) || 0));
      return (
        <div className="flex items-center gap-2 min-w-[90px]">
          <div className="flex-1 h-2 rounded-full bg-slate-500/20 overflow-hidden">
            <div className="h-full bg-sky-500 rounded-full" style={{ width: `${num}%` }} />
          </div>
          <span className="text-[11px] font-mono st-text-muted">{num}%</span>
        </div>
      );
    }

    if (col.type === "code") {
      return <code className="font-mono text-xs text-sky-600 dark:text-sky-300">{strVal}</code>;
    }

    return <span className="text-xs st-text-primary">{strVal}</span>;
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 1. Global Reactive Context Toolbar */}
      {contextFields && contextFields.length > 0 && (
        <div className="st-card rounded-2xl px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 text-xs font-bold st-text-primary">
            <Sliders className="w-4 h-4 text-sky-500" />
            <span>Reactive Context</span>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {contextFields.map((field) => {
              const curVal = contextState[field.key];
              const dynamicOpts = field.fromData
                ? snapshots[field.fromData]?.options || []
                : [];
              const opts = dynamicOpts.length > 0 ? dynamicOpts : field.options || [];

              if (field.type === "toggle") {
                return (
                  <label
                    key={field.key}
                    data-sd-pick-kind="context"
                    data-sd-pick-id={field.key}
                    data-sd-pick-title={`Context: ${field.label}`}
                    className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl st-subcard text-xs font-semibold cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(curVal)}
                      onChange={(e) => updateContextField(field.key, e.target.checked)}
                      className="w-3.5 h-3.5 rounded accent-sky-600"
                    />
                    <span className="st-text-primary">{field.label}</span>
                  </label>
                );
              }

              if (field.type === "select" && opts.length > 0 && opts.length <= 4) {
                return (
                  <div
                    key={field.key}
                    data-sd-pick-kind="context"
                    data-sd-pick-id={field.key}
                    data-sd-pick-title={`Context: ${field.label}`}
                    className="flex items-center gap-2"
                  >
                    <span className="text-xs font-medium st-text-secondary">{field.label}:</span>
                    <div className="inline-flex rounded-xl p-0.5 st-subcard border st-border">
                      {opts.map((opt) => {
                        const active = String(curVal ?? "") === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => updateContextField(field.key, opt.value)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                              active
                                ? "bg-sky-600 text-white shadow-sm"
                                : "st-text-secondary hover:st-text-primary"
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={field.key}
                  data-sd-pick-kind="context"
                  data-sd-pick-id={field.key}
                  data-sd-pick-title={`Context: ${field.label}`}
                  className="flex items-center gap-2"
                >
                  <span className="text-xs font-medium st-text-secondary">{field.label}:</span>
                  {opts.length > 0 ? (
                    <select
                      value={String(curVal ?? "")}
                      onChange={(e) => updateContextField(field.key, e.target.value)}
                      className="px-2.5 py-1 rounded-xl st-input text-xs font-mono"
                    >
                      {opts.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={String(curVal ?? "")}
                      onChange={(e) => updateContextField(field.key, e.target.value)}
                      className="px-2.5 py-1 rounded-xl st-input text-xs font-mono w-36"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 2. Data Panel Control Bar (Scope Breadcrumb + Architecture Graph + Density Switcher + Intermediates + Refresh) */}
      {(dataNodes || []).length > 0 && (
        <div className="st-card rounded-2xl px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          {/* Left Side: Database Icon + Title + Active Scope Breadcrumb & Scope Refresh */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs font-bold st-text-primary">
              <Database className="w-4 h-4 text-sky-500" />
              <span>Reactive Data Workbench</span>
            </div>

            {workbenchNodes.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="px-2.5 py-1 rounded-lg text-xs font-mono font-semibold st-subcard border st-border st-text-primary">
                  {scopeBreadcrumbText}
                </span>
                {dataScope.kind !== "all" && (
                  <button
                    type="button"
                    onClick={() => setDataScope({ kind: "all" })}
                    className="px-2 py-1 rounded-lg text-[11px] font-semibold st-btn-secondary"
                    title="Reset scope to show all data nodes"
                  >
                    Show All
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Right Side: Architecture Graph Toggle + Workbench Layout Switcher + Intermediates Toggle + Refresh */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setArchGraphOpen((prev) => !prev)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold transition-all border ${
                archGraphOpen
                  ? "bg-indigo-500/15 border-indigo-500/50 text-indigo-700 dark:text-indigo-300 shadow-sm"
                  : "st-btn-secondary border-transparent"
              }`}
              title="Toggle 4-Swimlane Reactive Architecture Graph (Context ➔ Data ⇌ Actions)"
            >
              <GitBranch className="w-3.5 h-3.5 text-indigo-500" />
              <span>🕸️ Data ⇌ Action Graph ({reactiveArchGraph.edges.length})</span>
            </button>

            {workbenchNodes.length > 0 && (
              <div
                className="inline-flex items-center rounded-xl p-0.5 st-subcard border st-border"
                title="Switch Right-Canvas Scope Display Density (Cards / Accordion / 2-Col Grid)"
              >
                <button
                  type="button"
                  onClick={() => {
                    if (workbenchNodes.length >= 2) setWorkbenchLayout("split");
                    setScopeDisplayDensity("cards");
                  }}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                    scopeDisplayDensity === "cards"
                      ? "bg-sky-600 text-white shadow-sm"
                      : "st-text-secondary hover:st-text-primary"
                  }`}
                >
                  <Columns className="w-3.5 h-3.5" />
                  <span>Cards</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (workbenchNodes.length >= 2) setWorkbenchLayout("split");
                    setScopeDisplayDensity("accordion");
                  }}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                    scopeDisplayDensity === "accordion"
                      ? "bg-sky-600 text-white shadow-sm"
                      : "st-text-secondary hover:st-text-primary"
                  }`}
                >
                  <ListTree className="w-3.5 h-3.5" />
                  <span>Accordion</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (workbenchNodes.length >= 2) setWorkbenchLayout("split");
                    setScopeDisplayDensity("grid");
                  }}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                    scopeDisplayDensity === "grid"
                      ? "bg-sky-600 text-white shadow-sm"
                      : "st-text-secondary hover:st-text-primary"
                  }`}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  <span>Grid</span>
                </button>
              </div>
            )}

            {intermediateNodes.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  const nextVal = !showIntermediates;
                  setShowIntermediates(nextVal);
                  if (nextVal) {
                    const missing = intermediateNodes.filter((n) => !snapshots[n.id]);
                    if (missing.length > 0) {
                      loadAll(false, missing);
                    }
                  }
                }}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold transition-all border ${
                  showIntermediates
                    ? "bg-amber-500/15 border-amber-500/50 text-amber-700 dark:text-amber-300 shadow-sm"
                    : "st-btn-secondary border-transparent"
                }`}
                title="Shows/hides intermediate DAG source nodes"
              >
                <span>🔬 Intermediates ({intermediateNodes.length})</span>
              </button>
            )}

            {dataScope.kind !== "all" && scopedWorkbenchNodes.length > 0 && (
              <button
                type="button"
                onClick={() => loadAll(true, scopedWorkbenchNodes)}
                disabled={isAnyLoading}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl st-btn-secondary text-xs font-semibold transition-all"
                title="Refresh only the DataNodes in the currently selected scope"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 ${isAnyLoading ? "animate-spin text-sky-500" : ""}`}
                />
                <span>↻ Refresh Scope ({scopedWorkbenchNodes.length})</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => loadAll(true)}
              disabled={isAnyLoading}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl st-btn-secondary text-xs font-semibold transition-all"
              title="Refresh all live data nodes"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isAnyLoading ? "animate-spin text-sky-500" : ""}`} />
              <span>↻ Refresh All</span>
            </button>
          </div>
        </div>
      )}

      {/* 2a. Zero-Config Interactive 4-Swimlane Architecture Graph (Context ➔ Data ⇌ Actions) */}
      {archGraphOpen &&
        (() => {
          const allArchNodes = reactiveArchGraph.nodes;
          const filteredArchEdges = reactiveArchGraph.edges.filter(
            (e) => archEdgeFilter === "all" || e.kind === archEdgeFilter
          );
          const connectedNodeIds = new Set<string>();
          for (const e of filteredArchEdges) {
            connectedNodeIds.add(e.source);
            connectedNodeIds.add(e.target);
          }
          const visibleArchNodes = allArchNodes.filter(
            (n) =>
              n.symbolKind !== "action" ||
              connectedNodeIds.has(n.id) ||
              allArchNodes.filter((x) => x.symbolKind === "action").length <= 6
          );

          const layersMap = new Map<number, typeof visibleArchNodes>();
          for (const n of visibleArchNodes) {
            const l = n.layer ?? 0;
            const list = layersMap.get(l) || [];
            list.push(n);
            layersMap.set(l, list);
          }

          const COL_W = 215;
          const ROW_H = 68;
          const COL_GAP = 78;
          const ROW_GAP = 16;
          const PAD_X = 20;
          const PAD_Y = 38;

          const coords = new Map<string, { x: number; y: number; layer: number }>();
          let maxRows = 1;
          for (const l of [0, 1, 2, 3]) {
            const col = layersMap.get(l) || [];
            if (col.length > maxRows) maxRows = col.length;
            col.forEach((n, rIdx) => {
              coords.set(n.id, {
                x: PAD_X + l * (COL_W + COL_GAP),
                y: PAD_Y + rIdx * (ROW_H + ROW_GAP),
                layer: l,
              });
            });
          }

          const canvasW = Math.max(820, PAD_X * 2 + 4 * COL_W + 3 * COL_GAP);
          const canvasH = Math.max(240, PAD_Y + maxRows * (ROW_H + ROW_GAP) + 36);

          const selectedArchNode =
            visibleArchNodes.find((n) => n.id === selectedArchNodeId) || null;
          const upSet = new Set(selectedArchNode?.upstreamIds || []);
          const downSet = new Set(selectedArchNode?.downstreamIds || []);

          const swimlaneTitles: Array<{ layer: number; title: string; color: string }> = [
            { layer: 0, title: "0 · Context Inputs", color: "text-indigo-500" },
            { layer: 1, title: "1 · Source / Intermediate Data", color: "text-amber-500" },
            { layer: 2, title: "2 · View DataNodes", color: "text-emerald-500" },
            { layer: 3, title: "3 · Bound & Multi-Source Actions", color: "text-sky-500" },
          ];

          return (
            <div className="st-card rounded-2xl p-4 flex flex-col gap-3 border border-indigo-500/30">
              <div className="flex items-center justify-between gap-3 flex-wrap border-b st-border pb-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <GitBranch className="w-4 h-4 text-indigo-500" />
                  <span className="text-xs font-bold st-text-primary">
                    Reactive Architecture Topology (Context ➔ Data ⇌ Actions)
                  </span>
                  <span className="text-[11px] st-text-muted">
                    Click any node to highlight its upstream/downstream blast radius; solid lines = forward flow, dashed arcs = feedback/refresh loops.
                  </span>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">
                  {(
                    [
                      { id: "all", label: `All Edges (${reactiveArchGraph.edges.length})` },
                      { id: "data_dag", label: "Data DAG" },
                      { id: "trigger", label: "Action Triggers" },
                      { id: "multi_source_read", label: "Multi-Source Reads" },
                      { id: "feedback", label: "Feedback / Refresh Loops" },
                    ] as const
                  ).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setArchEdgeFilter(f.id)}
                      className={`px-2 py-0.5 rounded-lg text-[11px] font-semibold transition-colors ${
                        archEdgeFilter === f.id
                          ? "bg-indigo-600 text-white"
                          : "st-btn-secondary"
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                  {selectedArchNode && (
                    <button
                      type="button"
                      onClick={() => setSelectedArchNodeId(null)}
                      className="px-2 py-0.5 rounded-lg text-[11px] font-semibold bg-rose-500/15 text-rose-600 dark:text-rose-300"
                    >
                      Clear Focus ×
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setArchGraphOpen(false)}
                    className="p-1 rounded-lg st-btn-secondary"
                    title="Close Architecture Graph"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div className="rounded-xl border st-border st-code-surface overflow-x-auto overflow-y-auto max-h-[520px]">
                <div
                  className="relative select-none"
                  style={{ width: `${canvasW}px`, height: `${canvasH}px` }}
                >
                  {/* Swimlane Column Headers */}
                  {swimlaneTitles.map((sw) => (
                    <div
                      key={sw.layer}
                      style={{
                        left: `${PAD_X + sw.layer * (COL_W + COL_GAP)}px`,
                        top: `8px`,
                        width: `${COL_W}px`,
                      }}
                      className={`absolute text-[10.5px] font-mono font-bold uppercase tracking-wider ${sw.color}`}
                    >
                      {sw.title}
                    </div>
                  ))}

                  <svg
                    width={canvasW}
                    height={canvasH}
                    className="absolute inset-0 pointer-events-none"
                  >
                    <defs>
                      <marker
                        id="arch-arrow-forward"
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 1 L 10 5 L 0 9 z" fill="#0ea5e9" />
                      </marker>
                      <marker
                        id="arch-arrow-feedback"
                        viewBox="0 0 10 10"
                        refX="8"
                        refY="5"
                        markerWidth="6"
                        markerHeight="6"
                        orient="auto-start-reverse"
                      >
                        <path d="M 0 1 L 10 5 L 0 9 z" fill="#f59e0b" />
                      </marker>
                    </defs>

                    {filteredArchEdges.map((edge, idx) => {
                      const srcPos = coords.get(edge.source);
                      const tgtPos = coords.get(edge.target);
                      if (!srcPos || !tgtPos) return null;

                      const isFeedback = Boolean(edge.isFeedback || srcPos.layer >= tgtPos.layer);
                      let pathD: string;
                      let labelX: number;
                      let labelY: number;

                      if (!isFeedback) {
                        const x1 = srcPos.x + COL_W;
                        const y1 = srcPos.y + ROW_H / 2;
                        const x2 = tgtPos.x;
                        const y2 = tgtPos.y + ROW_H / 2;
                        const dx = Math.max(36, Math.abs(x2 - x1) * 0.45);
                        pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
                        labelX = (x1 + x2) / 2;
                        labelY = (y1 + y2) / 2 - 5;
                      } else {
                        // Feedback loop arc routing underneath cards back to target
                        const x1 = srcPos.x + COL_W / 2;
                        const y1 = srcPos.y + ROW_H;
                        const x2 = tgtPos.x + COL_W / 2;
                        const y2 = tgtPos.y + ROW_H;
                        const arcY = Math.max(y1, y2) + 34 + (idx % 3) * 10;
                        pathD = `M ${x1} ${y1} C ${x1} ${arcY}, ${x2} ${arcY}, ${x2} ${y2}`;
                        labelX = (x1 + x2) / 2;
                        labelY = arcY - 4;
                      }

                      const isHighlighted =
                        !selectedArchNode ||
                        edge.source === selectedArchNode.id ||
                        edge.target === selectedArchNode.id ||
                        (upSet.has(edge.source) && upSet.has(edge.target)) ||
                        (downSet.has(edge.source) && downSet.has(edge.target));

                      return (
                        <g
                          key={`${edge.source}->${edge.target}:${idx}`}
                          opacity={isHighlighted ? 0.95 : 0.18}
                        >
                          <path
                            d={pathD}
                            fill="none"
                            stroke={isFeedback ? "#f59e0b" : "#0ea5e9"}
                            strokeWidth={selectedArchNode && isHighlighted ? 2.2 : 1.5}
                            strokeDasharray={isFeedback ? "5 4" : undefined}
                            markerEnd={
                              isFeedback
                                ? "url(#arch-arrow-feedback)"
                                : "url(#arch-arrow-forward)"
                            }
                          />
                          {edge.label && (
                            <text
                              x={labelX}
                              y={labelY}
                              textAnchor="middle"
                              className={`text-[9.5px] font-mono ${
                                isFeedback
                                  ? "fill-amber-600 dark:fill-amber-400"
                                  : "fill-sky-600 dark:fill-sky-400"
                              }`}
                            >
                              {edge.label}
                            </text>
                          )}
                        </g>
                      );
                    })}
                  </svg>

                  {visibleArchNodes.map((an) => {
                    const pos = coords.get(an.id);
                    if (!pos) return null;
                    const isSelected = selectedArchNode?.id === an.id;
                    const isUp = upSet.has(an.id);
                    const isDown = downSet.has(an.id);
                    const isDimmed =
                      Boolean(selectedArchNode) && !isSelected && !isUp && !isDown;

                    return (
                      <div
                        key={an.id}
                        onClick={() =>
                          setSelectedArchNodeId((prev) => (prev === an.id ? null : an.id))
                        }
                        style={{
                          left: `${pos.x}px`,
                          top: `${pos.y}px`,
                          width: `${COL_W}px`,
                          height: `${ROW_H}px`,
                        }}
                        className={`absolute rounded-xl p-2.5 border flex flex-col justify-between cursor-pointer transition-all st-card ${
                          isSelected
                            ? "border-indigo-500 ring-2 ring-indigo-500/40 shadow-lg"
                            : isUp
                              ? "border-amber-500/70 bg-amber-500/5"
                              : isDown
                                ? "border-emerald-500/70 bg-emerald-500/5"
                                : an.intermediate
                                  ? "border-dashed border-amber-500/40"
                                  : "st-border hover:border-indigo-500/50"
                        } ${isDimmed ? "opacity-30" : "opacity-100"}`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase st-pill truncate">
                            {an.group}
                          </span>
                          <span className="text-[9.5px] font-mono st-text-muted shrink-0">
                            ↑{an.upstreamIds?.length || 0} · ↓{an.downstreamIds?.length || 0}
                          </span>
                        </div>
                        <div className="font-mono text-xs font-bold st-text-primary truncate">
                          {an.label}
                        </div>
                        <div className="text-[10px] font-mono st-text-secondary truncate">
                          {an.meta}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {selectedArchNode && (
                <div className="px-3.5 py-2.5 rounded-xl st-subcard border st-border flex items-center justify-between gap-3 flex-wrap text-xs">
                  <div className="flex items-center gap-2 flex-wrap font-mono">
                    <span className="px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 font-bold">
                      {selectedArchNode.group}: {selectedArchNode.label} ({selectedArchNode.rawId})
                    </span>
                    {selectedArchNode.definedIn && (
                      <span className="px-2 py-0.5 rounded st-pill">
                        source: {selectedArchNode.definedIn}
                      </span>
                    )}
                    <span className="st-text-secondary">
                      Upstream: {selectedArchNode.upstreamIds?.length || 0} · Downstream:{" "}
                      {selectedArchNode.downstreamIds?.length || 0}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedArchNode.symbolKind === "data" && (
                      <button
                        type="button"
                        onClick={() => jumpToDataNodeCard(selectedArchNode.rawId)}
                        className="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold"
                      >
                        ↗ Jump to DataNode Card
                      </button>
                    )}
                    {selectedArchNode.symbolKind === "action" && (
                      <button
                        type="button"
                        onClick={() =>
                          onLocateActionInPlayground?.(selectedArchNode.rawId, {})
                        }
                        className="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold"
                      >
                        ↗ Jump to Action Card
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

      {/* 2b. Top Compact Scalar KPI Strip */}
      {scalarNodes.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {scalarNodes.map((node) => {
            const snap = snapshots[node.id];
            const loading = Boolean(loadingMap[node.id]);
            const scalarVal = snap?.value;
            const tone = scalarVal?.tone || "neutral";
            const toneColor =
              tone === "success"
                ? "text-emerald-600 dark:text-emerald-400"
                : tone === "warn"
                  ? "text-amber-600 dark:text-amber-400"
                  : tone === "danger"
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-sky-600 dark:text-sky-400";
            return (
              <div
                key={node.id}
                data-sd-pick-kind="data-node"
                data-sd-pick-id={node.id}
                data-sd-pick-title={`Scalar KPI: ${node.title}`}
                className="st-card rounded-2xl px-4 py-3 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Activity className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span className="text-xs font-bold st-text-primary truncate">{node.title}</span>
                    <span className="px-1.5 py-0.5 rounded text-[9.5px] font-mono font-bold bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 shrink-0">
                      Scalar ➔ KPI
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        setInspectNodeId((prev) => (prev === node.id ? null : node.id))
                      }
                      className="p-1 rounded-lg st-btn-secondary"
                      title="Inspect Scalar KPI Node"
                    >
                      <Eye className="w-3 h-3 text-sky-500" />
                    </button>
                    <button
                      type="button"
                      onClick={() => refreshSingleNode(node)}
                      disabled={loading}
                      className="p-1 rounded-lg st-btn-secondary"
                      title="Refresh KPI"
                    >
                      <RefreshCw
                        className={`w-3 h-3 ${loading ? "animate-spin text-sky-500" : ""}`}
                      />
                    </button>
                  </div>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className={`text-xl font-extrabold font-mono ${toneColor}`}>
                    {loading && !snap ? "…" : String(scalarVal?.value ?? "—")}
                  </span>
                  {scalarVal?.unit && (
                    <span className="text-xs font-medium st-text-secondary">
                      {scalarVal.unit}
                    </span>
                  )}
                </div>
                {inspectNodeId === node.id && (
                  <div className="st-code-surface rounded-lg border st-border p-2 font-mono text-[11px] overflow-x-auto">
                    <div className="text-[10px] st-text-muted mb-1">
                      id: {node.id} · runtime: {node.runtime || "zsh"}
                    </div>
                    <pre className="whitespace-pre-wrap break-all">
                      {snap?.resolvedSource || node.code || node.command || ""}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 3. Reactive Data Workbench (Split Focus / Accordion / Grid) */}
      {(() => {
        const renderDataNodeCard = (node: DataNode) => {
            const snap = snapshots[node.id];
            const loading = Boolean(loadingMap[node.id]);
            const expanded = Boolean(expandedMap[node.id]);
            const baseShape = (snap?.shape || node.shape || "raw") as DataShape;
            const primitive: DataPrimitive =
              snap?.primitive || inferDataPrimitive(baseShape, snap?.rawParsed);
            const availableViews = getAvailableViewsForNode(node, baseShape, snap?.rawParsed);
            const shape = (viewModeOverride[node.id] || baseShape) as DataShape;
            const projectedValue = projectSnapshotToView(node, snap, shape);
            const isFullSpan =
              scopeDisplayDensity !== "grid" ||
              shape === "table" ||
              shape === "matrix" ||
              shape === "graph" ||
              shape === "tree";
            const isIntermediate = Boolean(node.intermediate || node.hidden);
            const isPinned = pinnedNodeIds.includes(node.id);
            const selectContextKey = snap?.selectContextKey || node.selectContextKey;
            const activeMasterContextVal = selectContextKey
              ? String(contextState[selectContextKey] ?? "all")
              : null;
            const handleMasterItemClick = (itemVal: string) => {
              if (!selectContextKey || !itemVal) return;
              const nextVal = activeMasterContextVal === itemVal ? "all" : itemVal;
              updateContextField(selectContextKey, nextVal);
            };
            const envSummary = snap?.resolvedEnv;
            const uiOverride = commandEnvOverrides?.[`data:${node.id}`];
            const isCustomEnv = Boolean(
              envSummary?.isCustom ||
              uiOverride ||
              node.cwd ||
              node.python ||
              node.envFile ||
              (node.env && Object.keys(node.env).length > 0)
            );

            return (
              <div
                key={node.id}
                data-sd-pick-kind="data-node"
                data-sd-pick-id={node.id}
                data-sd-pick-title={`Data Node: ${node.title}`}
                className={`st-card rounded-2xl p-4 flex flex-col gap-3 transition-all ${
                  isFullSpan ? "xl:col-span-2" : ""
                } ${isIntermediate ? "border-dashed border-amber-500/40" : ""} ${
                  highlightedDataNodeId === node.id
                    ? "ring-2 ring-sky-500 border-sky-500 shadow-lg"
                    : isPinned && workbenchLayout === "split"
                      ? "ring-1 ring-sky-500/40"
                      : ""
                }`}
              >
                {/* Header */}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    {shape === "graph" ? (
                      <GitBranch className="w-4 h-4 text-indigo-500 shrink-0" />
                    ) : shape === "tree" ? (
                      <ListTree className="w-4 h-4 text-amber-500 shrink-0" />
                    ) : shape === "table" || shape === "matrix" ? (
                      <Database className="w-4 h-4 text-sky-500 shrink-0" />
                    ) : (
                      <Activity className="w-4 h-4 text-emerald-500 shrink-0" />
                    )}
                    <h4 className="text-sm font-bold st-text-primary truncate">{node.title}</h4>
                    {/* Explicit 5-Primitive -> View Badge */}
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 shrink-0"
                      title={`Data Primitive: ${primitive} · Active UI View: ${shape.toUpperCase()} (${node.runtime || "zsh"})`}
                    >
                      {primitive} ➔ {shape.toUpperCase()}
                    </span>
                    {isIntermediate && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                        🔬 INTERMEDIATE · DAG SOURCE
                      </span>
                    )}
                    {selectContextKey && (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30"
                        title={`Master-Detail: clicking an item sets context.${selectContextKey}`}
                      >
                        <span>🔗 context.{selectContextKey}</span>
                        {activeMasterContextVal && activeMasterContextVal !== "all" && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              updateContextField(selectContextKey, "all");
                            }}
                            className="ml-0.5 px-1 rounded bg-indigo-500/25 hover:bg-indigo-500/40 font-bold"
                            title="Reset filter to 'all'"
                          >
                            ={activeMasterContextVal} ×
                          </button>
                        )}
                      </span>
                    )}
                    {isCustomEnv && (
                      <button
                        type="button"
                        onClick={() => {
                          setInspectNodeId(node.id);
                          setInspectTabMap((prev) => ({ ...prev, [node.id]: "source" }));
                          setOpenEnvNodeId(node.id);
                        }}
                        className="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30"
                        title={`Custom Env: cwd=${envSummary?.cwd || node.cwd || activeWorkspace}`}
                      >
                        ⚙️ {envSummary?.badgeText || "Custom Env"}
                      </button>
                    )}
                    {snap && (
                      <span className="text-[11px] font-mono st-text-muted shrink-0">
                        ({snap.durationMs}ms{snap.fromCache ? " · cached" : ""})
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                    {/* Decoupled In-Card View Switcher */}
                    {availableViews.length > 1 && (
                      <div
                        className="inline-flex items-center rounded-lg p-0.5 st-subcard border st-border"
                        title="Switch visual projection in-place without mutating backend data contracts"
                      >
                        {availableViews.map((vw) => {
                          const isActiveView = shape === vw;
                          return (
                            <button
                              key={vw}
                              type="button"
                              onClick={() =>
                                setViewModeOverride((prev) => ({ ...prev, [node.id]: vw }))
                              }
                              className={`px-2 py-0.5 rounded-md text-[10.5px] font-mono font-bold uppercase transition-colors ${
                                isActiveView
                                  ? "bg-sky-600 text-white shadow-sm"
                                  : "st-text-muted hover:st-text-primary"
                              }`}
                            >
                              {vw}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {(shape === "table" || shape === "list" || shape === "tree") && (
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 st-text-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={tableSearch[node.id] || ""}
                          onChange={(e) =>
                            setTableSearch((prev) => ({ ...prev, [node.id]: e.target.value }))
                          }
                          placeholder={`Filter ${shape}...`}
                          className="pl-7 pr-2.5 py-1 rounded-lg st-input text-xs w-36 focus:outline-none focus:border-sky-500"
                        />
                      </div>
                    )}

                    {workbenchLayout === "split" && (
                      <button
                        type="button"
                        onClick={() => togglePinNode(node.id)}
                        className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold transition-all border shrink-0 ${
                          isPinned
                            ? "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40"
                            : "st-btn-secondary border-transparent"
                        }`}
                        title={
                          isPinned
                            ? "Unpin from split-view canvas"
                            : "Pin this card in split-view canvas for side-by-side Master-Detail comparison"
                        }
                      >
                        <Pin className="w-3 h-3" />
                        <span>{isPinned ? "Pinned" : "Pin"}</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => {
                        setInspectNodeId((prev) => (prev === node.id ? null : node.id));
                      }}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold transition-all border shrink-0 ${
                        inspectNodeId === node.id
                          ? "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40 shadow-sm"
                          : "st-btn-secondary border-transparent"
                      }`}
                      title="White-box inspect DataNode execution source, Env, bound actions & raw payload"
                    >
                      <Eye className="w-3.5 h-3.5 text-sky-500" />
                      <span>
                        Inspect
                        {(() => {
                          const totalBound =
                            (node.quickActions?.length || 0) +
                            (node.rowActions?.length || 0) +
                            (node.bulkActions?.length || 0) +
                            (node.nodeActions?.length || 0) +
                            (node.cellAction ? 1 : 0);
                          return totalBound > 0 ? ` (${totalBound})` : "";
                        })()}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => refreshSingleNode(node)}
                      disabled={loading}
                      className="p-1.5 rounded-lg st-btn-secondary"
                      title="Refresh data node"
                    >
                      <RefreshCw
                        className={`w-3.5 h-3.5 ${loading ? "animate-spin text-sky-500" : ""}`}
                      />
                    </button>
                  </div>
                </div>

                {/* White-Box 4-Tab DataNode Inspector Panel (Source & Provenance / DAG Lineage & Action Bindings / Views & Payload / Raw Declaration) */}
                {inspectNodeId === node.id &&
                  (() => {
                    const activeInspectTab = inspectTabMap[node.id] || "source";
                    const setInspectTab = (
                      tab: "source" | "lineage" | "views" | "raw"
                    ) => setInspectTabMap((prev) => ({ ...prev, [node.id]: tab }));

                    const nodeProvenance =
                      skillProvenance?.dataSource?.[node.id] || "manifest.yaml";

                    const nodeTriggers: Array<{
                      kind: ActiveBoundActionAudit["triggerKind"];
                      trigger: BoundActionTrigger;
                    }> = [
                      ...(node.quickActions || []).map((t) => ({
                        kind: "Quick Action" as const,
                        trigger: t,
                      })),
                      ...(node.rowActions || []).map((t) => ({
                        kind: "Row Action" as const,
                        trigger: t,
                      })),
                      ...(node.bulkActions || []).map((t) => ({
                        kind: "Bulk Action" as const,
                        trigger: t,
                      })),
                      ...(node.nodeActions || []).map((t) => ({
                        kind: "Node Action" as const,
                        trigger: t,
                      })),
                      ...(node.cellAction
                        ? [{ kind: "Cell Action" as const, trigger: node.cellAction }]
                        : []),
                    ];

                    const rawYamlSource =
                      node.script ||
                      node.command ||
                      node.code ||
                      node.sql ||
                      (Array.isArray(node.pattern)
                        ? node.pattern.join("\n")
                        : node.pattern || node.filePath || "");
                    const resolvedSourceText =
                      snap?.resolvedSource || rawYamlSource || "(no execution source)";
                    const sampleRowForAudit: Record<string, unknown> =
                      Array.isArray(snap?.value?.rows) && snap.value.rows.length > 0
                        ? snap.value.rows[0]
                        : Object.fromEntries(
                            (node.columns || []).map((c) => [c.key, `<${c.key}>`])
                          );

                    // Compute complete DAG Lineage & Action Bindings for this DataNode
                    const nodeTextDeps = extractImplicitDependencies(
                      [
                        node.command || "",
                        node.script || "",
                        node.code || "",
                        node.sql || "",
                        node.transform?.code || "",
                      ].join("\n")
                    );
                    const upstreamContextKeys = Array.from(
                      new Set([
                        ...nodeTextDeps.contextKeys,
                        ...(node.sync?.dependsOn || [])
                          .filter((d) => d.startsWith("context."))
                          .map((d) => d.slice("context.".length)),
                      ])
                    );
                    const upstreamDataNodeIds = Array.from(
                      new Set([
                        ...nodeTextDeps.dataNodeIds.filter((d) => d !== node.id),
                        ...(node.sync?.dependsOn || []).filter((d) => !d.startsWith("context.")),
                      ])
                    );
                    const downstreamDataNodeIds = (dataNodes || [])
                      .filter((dn) => {
                        if (dn.id === node.id) return false;
                        if (dn.sync?.dependsOn?.includes(node.id)) return true;
                        const imp = extractImplicitDependencies(
                          [
                            dn.command || "",
                            dn.script || "",
                            dn.code || "",
                            dn.sql || "",
                            dn.transform?.code || "",
                          ].join("\n")
                        );
                        return imp.dataNodeIds.includes(node.id);
                      })
                      .map((dn) => dn.id);

                    const inboundActionConsumers: Array<{
                      actionId: string;
                      title: string;
                      reason: string;
                    }> = [];
                    const writerRefreshActions: Array<{
                      actionId: string;
                      title: string;
                      mode: "intoData" | "refreshData" | "refreshAfterActions";
                    }> = [];

                    const refreshPatterns = [
                      ...(node.sync?.refreshAfterActions || []),
                      ...(node.sync?.invalidateOnActions || []),
                    ];

                    for (const [actId, info] of actionsMap.entries()) {
                      const act = info.action;
                      const reasons: string[] = [];
                      for (const f of act.form || []) {
                        if (f.fromData === node.id) reasons.push(`fromData (${f.key})`);
                      }
                      for (const pre of act.preconditions || []) {
                        if (pre.dataNodeId === node.id) reasons.push(`precondition`);
                      }
                      const actImp = extractImplicitDependencies(act.script || act.command || "");
                      if (actImp.dataNodeIds.includes(node.id)) {
                        reasons.push(`{{data.${node.id}}}`);
                      }
                      if (reasons.length > 0) {
                        inboundActionConsumers.push({
                          actionId: actId,
                          title: act.title,
                          reason: reasons.join(" + "),
                        });
                      }

                      if (act.output?.intoData === node.id) {
                        writerRefreshActions.push({
                          actionId: actId,
                          title: act.title,
                          mode: "intoData",
                        });
                      } else if (act.output?.refreshData?.includes(node.id)) {
                        writerRefreshActions.push({
                          actionId: actId,
                          title: act.title,
                          mode: "refreshData",
                        });
                      } else if (
                        refreshPatterns.some((pat) => doesActionPatternMatch(pat, actId))
                      ) {
                        writerRefreshActions.push({
                          actionId: actId,
                          title: act.title,
                          mode: "refreshAfterActions",
                        });
                      }
                    }

                    const totalLineageCount =
                      upstreamContextKeys.length +
                      upstreamDataNodeIds.length +
                      downstreamDataNodeIds.length +
                      nodeTriggers.length +
                      inboundActionConsumers.length +
                      writerRefreshActions.length;

                    return (
                      <div className="st-subcard rounded-xl border border-sky-500/30 p-3.5 flex flex-col gap-3 text-xs">
                        <div className="flex items-center justify-between gap-2 flex-wrap border-b st-border pb-2">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <button
                              type="button"
                              onClick={() => setInspectTab("source")}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                                activeInspectTab === "source"
                                  ? "bg-sky-600 text-white"
                                  : "st-btn-secondary"
                              }`}
                            >
                              <Code2 className="w-3.5 h-3.5" />
                              <span>Source & Provenance</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setInspectTab("lineage")}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                                activeInspectTab === "lineage"
                                  ? "bg-sky-600 text-white"
                                  : "st-btn-secondary"
                              }`}
                            >
                              <GitBranch className="w-3.5 h-3.5" />
                              <span>DAG Lineage & Action Bindings ({totalLineageCount})</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setInspectTab("views")}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                                activeInspectTab === "views"
                                  ? "bg-sky-600 text-white"
                                  : "st-btn-secondary"
                              }`}
                            >
                              <Database className="w-3.5 h-3.5" />
                              <span>Views & Payload</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setInspectTab("raw")}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                                activeInspectTab === "raw"
                                  ? "bg-sky-600 text-white"
                                  : "st-btn-secondary"
                              }`}
                            >
                              <Terminal className="w-3.5 h-3.5" />
                              <span>Raw Declaration</span>
                            </button>
                          </div>

                          <button
                            type="button"
                            onClick={() => setInspectNodeId(null)}
                            className="p-1 rounded-lg st-btn-secondary"
                            title="Close inspector"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {activeInspectTab === "source" && (
                          <div className="flex flex-col gap-2.5">
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <div className="flex items-center gap-1.5 flex-wrap font-mono text-[11px]">
                                <span className="px-2 py-0.5 rounded st-pill">
                                  id: {node.id}
                                </span>
                                <span className="px-2 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30">
                                  source: {nodeProvenance}
                                </span>
                                <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 font-semibold">
                                  {primitive} ➔ {shape.toUpperCase()}
                                </span>
                                <span className="px-2 py-0.5 rounded st-pill">
                                  runtime: {node.runtime || "zsh"}
                                  {node.prelude ? " (prelude: true)" : ""}
                                </span>
                                {node.parse?.format && (
                                  <span className="px-2 py-0.5 rounded st-pill">
                                    parse: {node.parse.format}
                                  </span>
                                )}
                                <span className="px-2 py-0.5 rounded st-pill">
                                  cwd: {envSummary?.cwd || node.cwd || activeWorkspace}
                                </span>
                                {refreshPatterns.length > 0 && (
                                  <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                                    refreshAfterActions: {refreshPatterns.join(", ")}
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-1.5 flex-wrap">
                                <button
                                  type="button"
                                  onClick={() =>
                                    setOpenEnvNodeId((prev) => (prev === node.id ? null : node.id))
                                  }
                                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold transition-all border ${
                                    isCustomEnv
                                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40"
                                      : "st-btn-secondary border-transparent"
                                  }`}
                                  title={`cwd: ${envSummary?.cwd || activeWorkspace} · python: ${envSummary?.python || "auto"}`}
                                >
                                  <span>
                                    ⚙️ {isCustomEnv ? (envSummary?.badgeText || "Custom Env") : "Env"}
                                  </span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() => {
                                    navigator.clipboard.writeText(resolvedSourceText);
                                    setCopiedSourceNodeId(node.id);
                                    setTimeout(() => setCopiedSourceNodeId(null), 1600);
                                  }}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg st-btn-secondary font-semibold"
                                >
                                  {copiedSourceNodeId === node.id ? (
                                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                                  ) : (
                                    <Copy className="w-3.5 h-3.5" />
                                  )}
                                  <span>
                                    {copiedSourceNodeId === node.id ? "Copied" : "Copy Source"}
                                  </span>
                                </button>

                                {(node.runtime || "zsh") === "zsh" &&
                                  resolvedSourceText &&
                                  onExecute && (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        onExecute({
                                          adHocCommand: resolvedSourceText,
                                          adHocTitle: `Test DataNode: ${node.title} (${node.id})`,
                                          runner: "web_terminal",
                                        })
                                      }
                                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold"
                                      title="Execute this DataNode's resolved shell command in the Web Terminal to inspect raw output"
                                    >
                                      <Terminal className="w-3.5 h-3.5" />
                                      <span>Test in Web Terminal</span>
                                    </button>
                                  )}
                              </div>
                            </div>

                            <div className="st-code-surface rounded-xl border st-border p-3 font-mono text-xs overflow-x-auto max-h-56 overflow-y-auto">
                              <div className="text-[10.5px] st-text-muted mb-1">
                                Resolved Execution Source ({node.runtime || "zsh"}):
                              </div>
                              <pre
                                className="leading-relaxed whitespace-pre-wrap break-all select-all"
                                dangerouslySetInnerHTML={{
                                  __html: highlightCodeToHtml(
                                    resolvedSourceText,
                                    node.runtime === "python"
                                      ? "python"
                                      : node.runtime === "ts"
                                        ? "ts"
                                        : "bash",
                                    true
                                  ),
                                }}
                              />
                            </div>

                            {rawYamlSource && rawYamlSource !== resolvedSourceText && (
                              <div className="st-code-surface rounded-xl border st-border p-2.5 font-mono text-[11px] overflow-x-auto">
                                <div className="text-[10px] st-text-muted mb-1">
                                  YAML Template Declaration:
                                </div>
                                <pre className="whitespace-pre-wrap break-all st-text-secondary">
                                  {rawYamlSource}
                                </pre>
                              </div>
                            )}
                          </div>
                        )}

                        {activeInspectTab === "lineage" && (
                          <div className="flex flex-col gap-3">
                            {/* 1. Upstream & Downstream DAG Grid */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 font-mono text-[11px]">
                              <div className="p-2.5 rounded-lg st-code-surface border st-border flex flex-col gap-1.5">
                                <span className="st-text-muted text-[10px] font-sans font-bold uppercase">
                                  ⬅️ Upstream Data & Context
                                </span>
                                <div className="flex items-center gap-1 flex-wrap">
                                  {upstreamContextKeys.map((ck) => (
                                    <span
                                      key={`ctx:${ck}`}
                                      className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
                                    >
                                      context.{ck}
                                    </span>
                                  ))}
                                  {upstreamDataNodeIds.map((upId) => (
                                    <button
                                      key={upId}
                                      type="button"
                                      onClick={() => jumpToDataNodeCard(upId)}
                                      className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-300 hover:bg-sky-500/25 font-semibold"
                                      title="Jump to upstream DataNode"
                                    >
                                      data:{upId} ↗
                                    </button>
                                  ))}
                                  {upstreamContextKeys.length === 0 &&
                                    upstreamDataNodeIds.length === 0 && (
                                      <span className="st-text-muted italic">None (Root Node)</span>
                                    )}
                                </div>
                              </div>

                              <div className="p-2.5 rounded-lg st-code-surface border st-border flex flex-col gap-1.5">
                                <span className="st-text-muted text-[10px] font-sans font-bold uppercase">
                                  ➡️ Downstream Data & Context
                                </span>
                                <div className="flex items-center gap-1 flex-wrap">
                                  {selectContextKey && (
                                    <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-700 dark:text-indigo-300">
                                      sets context.{selectContextKey}
                                    </span>
                                  )}
                                  {downstreamDataNodeIds.map((dnId) => (
                                    <button
                                      key={dnId}
                                      type="button"
                                      onClick={() => jumpToDataNodeCard(dnId)}
                                      className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25 font-semibold"
                                      title="Jump to downstream DataNode"
                                    >
                                      data:{dnId} ↗
                                    </button>
                                  ))}
                                  {!selectContextKey && downstreamDataNodeIds.length === 0 && (
                                    <span className="st-text-muted italic">None</span>
                                  )}
                                </div>
                              </div>

                              <div className="p-2.5 rounded-lg st-code-surface border st-border flex flex-col gap-1.5">
                                <span className="st-text-muted text-[10px] font-sans font-bold uppercase">
                                  📥 Consumed By Actions
                                </span>
                                <div className="flex items-center gap-1 flex-wrap">
                                  {inboundActionConsumers.map((c) => (
                                    <button
                                      key={c.actionId}
                                      type="button"
                                      onClick={() => onLocateActionInPlayground?.(c.actionId, {})}
                                      className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-300 hover:bg-sky-500/25 font-semibold"
                                      title={`${c.title} (${c.reason}) — Click to jump to ActionCard`}
                                    >
                                      action:{c.actionId} ({c.reason}) ↗
                                    </button>
                                  ))}
                                  {inboundActionConsumers.length === 0 && (
                                    <span className="st-text-muted italic">None</span>
                                  )}
                                </div>
                              </div>

                              <div className="p-2.5 rounded-lg st-code-surface border st-border flex flex-col gap-1.5">
                                <span className="st-text-muted text-[10px] font-sans font-bold uppercase">
                                  🔄 Written / Refreshed By Actions
                                </span>
                                <div className="flex items-center gap-1 flex-wrap">
                                  {writerRefreshActions.map((w) => (
                                    <button
                                      key={`${w.mode}:${w.actionId}`}
                                      type="button"
                                      onClick={() => onLocateActionInPlayground?.(w.actionId, {})}
                                      className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25 font-semibold"
                                      title={`${w.title} (${w.mode}) — Click to jump to ActionCard`}
                                    >
                                      {w.mode} ⬅ {w.actionId} ↗
                                    </button>
                                  ))}
                                  {writerRefreshActions.length === 0 && (
                                    <span className="st-text-muted italic">None</span>
                                  )}
                                </div>
                              </div>
                            </div>

                            {/* 2. Hosted Bound Action Triggers (Ref & Isomorphic Inline Actions) */}
                            <div className="flex flex-col gap-1.5">
                              <div className="text-[11px] font-bold st-text-primary">
                                🎯 Hosted Bound Action Triggers ({nodeTriggers.length})
                              </div>
                              {nodeTriggers.length === 0 ? (
                                <div className="p-2.5 rounded-lg st-code-surface border st-border st-text-muted text-center">
                                  No bound actions (`quickActions`, `rowActions`, `bulkActions`, `nodeActions`, or `cellAction`) configured on this DataNode.
                                </div>
                              ) : (
                                <div className="rounded-xl border st-border overflow-x-auto">
                                  <table className="w-full text-left border-collapse text-xs">
                                    <thead>
                                      <tr className="border-b st-border st-surface-muted text-[11px] font-bold st-text-secondary uppercase">
                                        <th className="py-2 px-2.5">Slot</th>
                                        <th className="py-2 px-2.5">Label</th>
                                        <th className="py-2 px-2.5">Target / Inline Action</th>
                                        <th className="py-2 px-2.5">Args / Multi-Source Scope</th>
                                        <th className="py-2 px-2.5 text-right">Actions</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y st-border">
                                      {nodeTriggers.map(({ kind, trigger }, tIdx) => {
                                        const actId = trigger.actionId || "";
                                        const info = actionsMap.get(actId);
                                        const isInline = Boolean(
                                          info?.action.inlineHost || actId.startsWith("inline:")
                                        );
                                        return (
                                          <tr key={tIdx} className="hover:st-surface-muted">
                                            <td className="py-2 px-2.5 font-mono text-[11px] st-text-secondary">
                                              {kind}
                                            </td>
                                            <td className="py-2 px-2.5 font-semibold st-text-primary">
                                              {trigger.label}
                                            </td>
                                            <td className="py-2 px-2.5">
                                              {info ? (
                                                <div className="flex flex-col gap-0.5">
                                                  <div className="flex items-center gap-1.5 flex-wrap">
                                                    <code className="font-mono font-bold text-sky-600 dark:text-sky-400">
                                                      {actId}
                                                    </code>
                                                    <span
                                                      className={`px-1.5 py-0.2 rounded text-[10px] font-semibold ${
                                                        isInline
                                                          ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                                                          : info.action.intermediate
                                                            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                                                            : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                                      }`}
                                                    >
                                                      {isInline
                                                        ? "⚡ Inline Action"
                                                        : info.action.intermediate
                                                          ? "🔬 Intermediate"
                                                          : "Ref Action"}
                                                    </span>
                                                  </div>
                                                  <span className="text-[11px] st-text-secondary font-mono truncate max-w-xs">
                                                    {isInline
                                                      ? info.action.command
                                                      : `${info.action.title} (${info.groupName})`}
                                                  </span>
                                                </div>
                                              ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/15 text-rose-600 dark:text-rose-300 font-mono font-semibold">
                                                  ❌ {actId} (Not Found)
                                                </span>
                                              )}
                                            </td>
                                            <td className="py-2 px-2.5 font-mono text-[11px]">
                                              {trigger.args && Object.keys(trigger.args).length > 0 ? (
                                                <code className="break-all">
                                                  {JSON.stringify(trigger.args)}
                                                </code>
                                              ) : isInline ? (
                                                <span className="st-text-secondary">
                                                  Direct 4-Layer Scope (self/row/data/context)
                                                </span>
                                              ) : (
                                                <span className="st-text-muted">(default form)</span>
                                              )}
                                            </td>
                                            <td className="py-2 px-2.5 text-right whitespace-nowrap">
                                              <div className="inline-flex items-center gap-1.5">
                                                {info && (
                                                  <button
                                                    type="button"
                                                    onClick={() =>
                                                      onLocateActionInPlayground?.(actId, {})
                                                    }
                                                    className="px-2 py-1 rounded-lg st-btn-secondary font-semibold"
                                                    title="Jump to ActionCard in Playground"
                                                  >
                                                    ↗ Jump
                                                  </button>
                                                )}
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    triggerBound(node, kind, trigger, {
                                                      row: sampleRowForAudit,
                                                      selectedRows: [sampleRowForAudit],
                                                      scopeSummary:
                                                        Array.isArray(snap?.value?.rows) &&
                                                        snap.value.rows.length > 0
                                                          ? "Sampled from Row #1"
                                                          : "Sampled with column placeholders",
                                                    })
                                                  }
                                                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold"
                                                >
                                                  <Eye className="w-3 h-3" />
                                                  <span>Audit & Run</span>
                                                </button>
                                              </div>
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {activeInspectTab === "views" && (
                          <div className="flex flex-col gap-2.5">
                            <div className="flex items-center gap-2 flex-wrap font-mono text-[11px]">
                              <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-bold">
                                Primitive: {primitive}
                              </span>
                              <span className="px-2 py-0.5 rounded st-pill">
                                Default Shape: {baseShape} · Active View: {shape}
                              </span>
                              <span className="px-2 py-0.5 rounded st-pill">
                                Available Views: {availableViews.join(", ") || baseShape}
                              </span>
                              {node.pivot && (
                                <span className="px-2 py-0.5 rounded st-pill">
                                  pivot: rowKey={node.pivot.rowKey}
                                  {node.pivot.colKeys
                                    ? ` colKeys=[${node.pivot.colKeys.join(",")}]`
                                    : node.pivot.colKey
                                      ? ` colKey=${node.pivot.colKey}`
                                      : ""}
                                </span>
                              )}
                              {node.treeSpec?.groupBy && (
                                <span className="px-2 py-0.5 rounded st-pill">
                                  treeSpec.groupBy: [{node.treeSpec.groupBy.join(", ")}]
                                </span>
                              )}
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
                              <div className="st-code-surface rounded-xl border st-border p-2.5 font-mono text-[11px] max-h-52 overflow-y-auto">
                                <div className="text-[10px] st-text-muted mb-1 font-sans font-semibold">
                                  Normalized Payload (`snap.value`):
                                </div>
                                <pre className="whitespace-pre-wrap break-all">
                                  {JSON.stringify(snap?.value ?? null, null, 2)}
                                </pre>
                              </div>
                              <div className="st-code-surface rounded-xl border st-border p-2.5 font-mono text-[11px] max-h-52 overflow-y-auto">
                                <div className="text-[10px] st-text-muted mb-1 font-sans font-semibold">
                                  Raw Stdout / Stderr:
                                </div>
                                <pre className="whitespace-pre-wrap break-all">
                                  {snap?.stdout || snap?.stderr || "(empty)"}
                                </pre>
                              </div>
                            </div>
                          </div>
                        )}

                        {activeInspectTab === "raw" && (
                          <div className="flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] st-text-muted font-mono">
                                Raw DataNode Declaration (JSON · {nodeProvenance}):
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  navigator.clipboard.writeText(JSON.stringify(node, null, 2));
                                  setCopiedSourceNodeId(node.id);
                                  setTimeout(() => setCopiedSourceNodeId(null), 1500);
                                }}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded st-btn-secondary font-semibold"
                              >
                                {copiedSourceNodeId === node.id ? (
                                  <Check className="w-3 h-3 text-emerald-500" />
                                ) : (
                                  <Copy className="w-3 h-3" />
                                )}
                                <span>
                                  {copiedSourceNodeId === node.id ? "Copied" : "Copy JSON"}
                                </span>
                              </button>
                            </div>
                            <pre className="st-code-surface rounded-xl border st-border p-3 font-mono text-[11px] overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all select-all">
                              {JSON.stringify(node, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                {/* Command Execution Environment Editor Panel */}
                {openEnvNodeId === node.id && (
                  <CommandEnvEditor
                    skillId={skillId}
                    targetKind="data"
                    targetId={node.id}
                    targetTitle={node.title}
                    defaultWorkspace={activeWorkspace}
                    initialConfig={{
                      cwd: node.cwd,
                      python: node.python,
                      envFile: node.envFile,
                      env: node.env,
                      ...uiOverride,
                    }}
                    resolvedSummary={envSummary}
                    onSaved={(result) => {
                      if (result.skill) {
                        onSkillUpdated?.(result.skill);
                      }
                      if (result.snapshot) {
                        setSnapshots((prev) => ({ ...prev, [node.id]: result.snapshot! }));
                        const downstream = (dataNodes || []).filter(
                          (dn) =>
                            dn.id !== node.id &&
                            (dn.sync?.dependsOn?.includes(node.id) ||
                              snap?.consumedBy?.includes(dn.id) ||
                              snap?.consumedBy?.includes(`data:${dn.id}`))
                        );
                        for (const dn of downstream) {
                          refreshSingleNode(dn);
                        }
                      }
                    }}
                    onClose={() => setOpenEnvNodeId(null)}
                  />
                )}

                {node.description && (
                  <p className="text-xs st-text-secondary">{node.description}</p>
                )}

                {/* Referenced By Info Strip for Intermediates */}
                {isIntermediate && snap?.consumedBy && snap.consumedBy.length > 0 && (
                  <div className="px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-[11px] font-mono text-amber-700 dark:text-amber-300 flex items-center gap-1.5">
                    <span className="font-semibold">Referenced by:</span>
                    <span>{snap.consumedBy.join(", ")}</span>
                  </div>
                )}

                {/* Quick Actions Bar */}
                {node.quickActions && node.quickActions.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                    <span className="text-xs font-semibold st-text-muted mr-1">Quick Actions:</span>
                    {node.quickActions.map((qa, idx) =>
                      renderBoundTriggerButton(
                        node,
                        "Quick Action",
                        qa,
                        { scopeSummary: "Card Quick Action" },
                        idx,
                        "secondary"
                      )
                    )}
                  </div>
                )}

                {/* Body by Shape or Explicit Error State */}
                {loading && !snap ? (
                  <div className="st-code-surface rounded-xl border st-border p-3 text-xs st-text-muted">
                    Evaluating reactive node...
                  </div>
                ) : snap?.status === "error" ? (
                  <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 text-xs text-rose-600 dark:text-rose-300 flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 font-bold">
                        <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
                        <span>
                          Execution Failed {snap.exitCode !== undefined ? `(exit ${snap.exitCode})` : ""}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => refreshSingleNode(node)}
                        disabled={loading}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-700 dark:text-rose-200 font-semibold transition-colors"
                      >
                        <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
                        <span>↻ Retry</span>
                      </button>
                    </div>
                    <pre className="font-mono whitespace-pre-wrap break-words mt-1 max-h-40 overflow-y-auto">
                      {snap.error || snap.stderr || snap.stdout || "Execution failed"}
                    </pre>
                  </div>
                ) : shape === "scalar" && projectedValue ? (
                  <div className="st-subcard rounded-xl p-4 flex items-baseline gap-2.5">
                    <span
                      className={`text-2xl font-extrabold font-mono ${
                        projectedValue.tone === "success"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : projectedValue.tone === "warn"
                            ? "text-amber-600 dark:text-amber-400"
                            : projectedValue.tone === "danger"
                              ? "text-rose-600 dark:text-rose-400"
                              : "st-text-primary"
                      }`}
                    >
                      {String(projectedValue.value ?? "—")}
                    </span>
                    {projectedValue.unit && (
                      <span className="text-xs font-semibold st-text-secondary">
                        {projectedValue.unit}
                      </span>
                    )}
                  </div>
                ) : shape === "kv" && projectedValue?.entries ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {projectedValue.entries.map((entry: any) => {
                      const hasNested = entry.rawValue !== undefined && entry.rawValue !== null;
                      const kvKey = `${node.id}:${entry.key}`;
                      const isNestedOpen = Boolean(expandedKvPaths[kvKey]);
                      const nestedSummary = hasNested
                        ? Array.isArray(entry.rawValue)
                          ? `[${entry.rawValue.length} items]`
                          : `{${Object.keys(entry.rawValue).length} keys}`
                        : "";
                      return (
                        <div
                          key={entry.key}
                          className={`st-subcard rounded-xl px-3 py-2 flex flex-col gap-1.5 ${
                            hasNested && isNestedOpen ? "sm:col-span-2" : ""
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium st-text-secondary truncate">
                              {entry.label || entry.key}
                            </span>
                            {hasNested ? (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedKvPaths((prev) => ({
                                    ...prev,
                                    [kvKey]: !isNestedOpen,
                                  }))
                                }
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[11px] font-mono font-semibold bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30 hover:bg-sky-500/25 transition-colors"
                                title="Click to expand/collapse lossless nested JSON sub-tree"
                              >
                                {isNestedOpen ? (
                                  <ChevronDown className="w-3 h-3" />
                                ) : (
                                  <ChevronRight className="w-3 h-3" />
                                )}
                                <span>{nestedSummary}</span>
                              </button>
                            ) : (
                              <code className="text-xs font-mono font-semibold st-text-primary truncate">
                                {String(entry.value ?? "")}
                              </code>
                            )}
                          </div>
                          {hasNested && isNestedOpen && (
                            <div className="st-code-surface rounded-lg border st-border p-2.5 text-xs font-mono space-y-1 max-h-52 overflow-y-auto">
                              {buildTreeFromArbitraryData(entry.rawValue, entry.key).map((sub) => (
                                <div key={sub.id} className="flex flex-col gap-0.5">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-sky-600 dark:text-sky-400 font-semibold">
                                      {sub.label}:
                                    </span>
                                    <span className="st-text-primary break-all">
                                      {sub.value !== undefined
                                        ? String(sub.value)
                                        : sub.meta || ""}
                                    </span>
                                  </div>
                                  {sub.children && sub.children.length > 0 && (
                                    <div className="pl-3 border-l st-border space-y-0.5">
                                      {sub.children.map((ch) => (
                                        <div
                                          key={ch.id}
                                          className="flex items-center justify-between gap-2 text-[11px]"
                                        >
                                          <span className="st-text-secondary">{ch.label}:</span>
                                          <span className="st-text-primary break-all">
                                            {ch.value !== undefined
                                              ? String(ch.value)
                                              : JSON.stringify(ch.children || ch.meta)}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : shape === "list" && projectedValue?.items ? (
                  (() => {
                    const allItems: any[] = projectedValue.items || [];
                    const q = (tableSearch[node.id] || "").trim().toLowerCase();
                    const filteredItems = q
                      ? allItems.filter(
                          (it) =>
                            String(it.label ?? "")
                              .toLowerCase()
                              .includes(q) ||
                            String(it.value ?? "")
                              .toLowerCase()
                              .includes(q) ||
                            String(it.meta ?? "")
                              .toLowerCase()
                              .includes(q)
                        )
                      : allItems;
                    const itemActions = [
                      ...(node.rowActions || []),
                      ...(node.nodeActions || []),
                    ];
                    return (
                      <div className="flex flex-wrap gap-2 max-h-72 overflow-y-auto p-1">
                        {filteredItems.length === 0 ? (
                          <div className="w-full p-3 text-xs st-text-muted text-center">
                            No matching list items.
                          </div>
                        ) : (
                          filteredItems.map((it, idx) => {
                            const itemVal = String(it.value ?? idx);
                            const isSelectedMaster =
                              Boolean(selectContextKey) && activeMasterContextVal === itemVal;
                            const rawRow =
                              it.raw && typeof it.raw === "object"
                                ? (it.raw as Record<string, unknown>)
                                : { id: itemVal, value: itemVal, label: it.label, meta: it.meta };
                            return (
                              <div
                                key={`${itemVal}-${idx}`}
                                onClick={() => {
                                  if (selectContextKey) handleMasterItemClick(itemVal);
                                }}
                                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs transition-all ${
                                  selectContextKey ? "cursor-pointer" : ""
                                } ${
                                  isSelectedMaster
                                    ? "bg-sky-500/15 border-sky-500 text-sky-700 dark:text-sky-300 font-bold shadow-sm"
                                    : "st-subcard st-border hover:border-sky-500/40"
                                }`}
                              >
                                <code className="font-mono font-semibold st-text-primary">
                                  {it.label || itemVal}
                                </code>
                                {it.meta && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono st-pill">
                                    {it.meta}
                                  </span>
                                )}
                                {itemActions.map((act, aIdx) => (
                                  <span key={aIdx} onClick={(e) => e.stopPropagation()}>
                                    {renderBoundTriggerButton(
                                      node,
                                      "Row Action",
                                      act,
                                      {
                                        row: rawRow,
                                        node: {
                                          id: itemVal,
                                          label: String(it.label || itemVal),
                                          value: itemVal,
                                        },
                                        scopeSummary: `List Item ${it.label || itemVal}`,
                                      },
                                      aIdx,
                                      "secondary"
                                    )}
                                  </span>
                                ))}
                              </div>
                            );
                          })
                        )}
                      </div>
                    );
                  })()
                ) : shape === "tree" && projectedValue?.roots ? (
                  (() => {
                    const roots: TreeNodeItem[] = projectedValue.roots || [];
                    const q = (tableSearch[node.id] || "").trim().toLowerCase();
                    const defaultExpandDepth = node.treeSpec?.defaultExpandDepth;
                    const collectDepthCollapsedIds = (
                      items: TreeNodeItem[],
                      depth = 0
                    ): string[] => {
                      if (defaultExpandDepth === undefined) return [];
                      const ids: string[] = [];
                      for (const it of items) {
                        if (it.children && it.children.length > 0) {
                          if (depth + 1 >= defaultExpandDepth) {
                            ids.push(it.id);
                          }
                          ids.push(...collectDepthCollapsedIds(it.children, depth + 1));
                        }
                      }
                      return ids;
                    };
                    const collapsedSet =
                      collapsedTreeIds[node.id] || new Set<string>(collectDepthCollapsedIds(roots, 0));
                    const nodeActions = node.nodeActions || node.rowActions || [];

                    const collectExpandableIds = (items: TreeNodeItem[]): string[] => {
                      const ids: string[] = [];
                      for (const it of items) {
                        if (it.children && it.children.length > 0) {
                          ids.push(it.id);
                          ids.push(...collectExpandableIds(it.children));
                        }
                      }
                      return ids;
                    };

                    const matchesQuery = (it: TreeNodeItem): boolean => {
                      if (!q) return true;
                      if (
                        it.label.toLowerCase().includes(q) ||
                        String(it.value ?? "")
                          .toLowerCase()
                          .includes(q) ||
                        String(it.meta ?? "")
                          .toLowerCase()
                          .includes(q) ||
                        String(it.path ?? "")
                          .toLowerCase()
                          .includes(q)
                      ) {
                        return true;
                      }
                      return Boolean(it.children && it.children.some(matchesQuery));
                    };

                    const renderTreeNodes = (
                      items: TreeNodeItem[],
                      depth = 0
                    ): React.ReactNode => {
                      return items.filter(matchesQuery).map((item) => {
                        const hasChildren = Boolean(item.children && item.children.length > 0);
                        const isCollapsed = !q && collapsedSet.has(item.id);
                        const isSelectedMaster =
                          Boolean(selectContextKey) && activeMasterContextVal === item.id;
                        return (
                          <div key={item.id} className="flex flex-col">
                            <div
                              onClick={() => {
                                if (selectContextKey) {
                                  handleMasterItemClick(item.id);
                                } else if (hasChildren) {
                                  const next = new Set(collapsedSet);
                                  if (next.has(item.id)) next.delete(item.id);
                                  else next.add(item.id);
                                  setCollapsedTreeIds((prev) => ({
                                    ...prev,
                                    [node.id]: next,
                                  }));
                                }
                              }}
                              className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                                isSelectedMaster
                                  ? "bg-sky-500/15 border border-sky-500/40 font-bold"
                                  : "hover:st-surface-muted"
                              } ${selectContextKey || hasChildren ? "cursor-pointer" : ""}`}
                              style={{ paddingLeft: `${depth * 18 + 8}px` }}
                            >
                              <div className="flex items-center gap-2 min-w-0 flex-wrap">
                                {hasChildren ? (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const next = new Set(collapsedSet);
                                      if (next.has(item.id)) next.delete(item.id);
                                      else next.add(item.id);
                                      setCollapsedTreeIds((prev) => ({
                                        ...prev,
                                        [node.id]: next,
                                      }));
                                    }}
                                    className="p-0.5 rounded hover:bg-black/10"
                                  >
                                    {isCollapsed ? (
                                      <ChevronRight className="w-3.5 h-3.5 st-text-muted" />
                                    ) : (
                                      <ChevronDown className="w-3.5 h-3.5 text-sky-500" />
                                    )}
                                  </button>
                                ) : (
                                  <span className="w-4 inline-block text-center st-text-muted">
                                    •
                                  </span>
                                )}
                                <span className="font-mono font-semibold st-text-primary">
                                  {item.label}
                                </span>
                                {item.value !== undefined && (
                                  <code className="px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-700 dark:text-sky-300 font-mono text-[11px]">
                                    {String(item.value)}
                                  </code>
                                )}
                                {item.meta && (
                                  <span className="px-1.5 py-0.5 rounded text-[10.5px] font-mono st-pill">
                                    {item.meta}
                                  </span>
                                )}
                                {item.path && item.path !== item.label && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono st-text-muted bg-black/5 dark:bg-white/5">
                                    {item.path}
                                  </span>
                                )}
                              </div>

                              <div
                                className="flex items-center gap-1.5 shrink-0"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {item.actionId &&
                                  renderBoundTriggerButton(
                                    node,
                                    "Node Action",
                                    {
                                      label: item.label,
                                      actionId: item.actionId,
                                      mode: "run",
                                      args: item.args,
                                    },
                                    {
                                      row: item.rawRow || {
                                        id: item.id,
                                        label: item.label,
                                        value: item.value,
                                        path: item.path,
                                      },
                                      node: {
                                        id: item.id,
                                        label: item.label,
                                        value: item.value,
                                        path: item.path,
                                        rawRow: item.rawRow,
                                      },
                                      scopeSummary: `Tree Node ${item.path || item.id}`,
                                    },
                                    `tree-item-${item.id}`,
                                    "secondary"
                                  )}
                                {(item.rawRow || !hasChildren) &&
                                  nodeActions.map((na, nIdx) =>
                                    renderBoundTriggerButton(
                                      node,
                                      "Node Action",
                                      na,
                                      {
                                        row: item.rawRow || {
                                          id: item.value ?? item.id,
                                          label: item.label,
                                          value: item.value ?? item.id,
                                          path: item.path,
                                        },
                                        node: {
                                          id: item.id,
                                          label: item.label,
                                          value: item.value ?? item.id,
                                          path: item.path,
                                          rawRow: item.rawRow,
                                        },
                                        scopeSummary: `Tree Node ${item.path || item.id}`,
                                      },
                                      nIdx,
                                      "secondary"
                                    )
                                  )}
                              </div>
                            </div>
                            {hasChildren && !isCollapsed && (
                              <div className="flex flex-col">
                                {renderTreeNodes(item.children!, depth + 1)}
                              </div>
                            )}
                          </div>
                        );
                      });
                    };

                    return (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between gap-2 text-[11px] st-text-muted px-1">
                          <span>{roots.length} root node(s)</span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                setCollapsedTreeIds((prev) => ({
                                  ...prev,
                                  [node.id]: new Set(),
                                }))
                              }
                              className="px-2 py-0.5 rounded st-btn-secondary font-semibold"
                            >
                              Expand All
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setCollapsedTreeIds((prev) => ({
                                  ...prev,
                                  [node.id]: new Set(collectExpandableIds(roots)),
                                }))
                              }
                              className="px-2 py-0.5 rounded st-btn-secondary font-semibold"
                            >
                              Collapse All
                            </button>
                          </div>
                        </div>
                        <div className="rounded-xl border st-border st-subcard p-2 max-h-80 overflow-y-auto divide-y st-border/40">
                          {roots.length === 0 ? (
                            <div className="p-3 text-xs st-text-muted text-center">
                              Empty tree.
                            </div>
                          ) : (
                            renderTreeNodes(roots, 0)
                          )}
                        </div>
                      </div>
                    );
                  })()
                ) : shape === "graph" && projectedValue?.nodes ? (
                  (() => {
                    const gNodes: GraphNodeItem[] = projectedValue.nodes || [];
                    const gEdges: GraphEdgeItem[] = projectedValue.edges || [];
                    const nodeActions = node.nodeActions || node.rowActions || [];
                    const selectedNodeId = activeGraphNodeId[node.id] || null;
                    const focusedNode = gNodes.find((n) => n.id === selectedNodeId) || null;
                    const upstreamSet = new Set(focusedNode?.upstreamIds || []);
                    const downstreamSet = new Set(focusedNode?.downstreamIds || []);

                    // Group nodes by topological layer
                    const layersMap = new Map<number, GraphNodeItem[]>();
                    let maxLayer = 0;
                    for (const gn of gNodes) {
                      const l = gn.layer ?? 0;
                      if (l > maxLayer) maxLayer = l;
                      const list = layersMap.get(l) || [];
                      list.push(gn);
                      layersMap.set(l, list);
                    }

                    const COL_W = 216;
                    const COL_GAP = 76;
                    const ROW_H = 82;
                    const ROW_GAP = 18;
                    const PAD_X = 20;
                    const PAD_Y = 24;

                    let maxRowsInCol = 1;
                    for (const list of layersMap.values()) {
                      if (list.length > maxRowsInCol) maxRowsInCol = list.length;
                    }

                    const canvasW = Math.max(
                      520,
                      PAD_X * 2 + (maxLayer + 1) * COL_W + maxLayer * COL_GAP
                    );
                    const canvasH = Math.max(
                      200,
                      PAD_Y * 2 + maxRowsInCol * ROW_H + Math.max(0, maxRowsInCol - 1) * ROW_GAP
                    );

                    const coords = new Map<string, { x: number; y: number }>();
                    for (let l = 0; l <= maxLayer; l++) {
                      const colNodes = layersMap.get(l) || [];
                      colNodes.forEach((gn, idx) => {
                        coords.set(gn.id, {
                          x: PAD_X + l * (COL_W + COL_GAP),
                          y: PAD_Y + idx * (ROW_H + ROW_GAP),
                        });
                      });
                    }

                    return (
                      <div className="flex flex-col gap-2.5">
                        {/* Impact & Blast Radius Bar */}
                        <div className="flex items-center justify-between gap-2 flex-wrap px-3 py-2 rounded-xl st-subcard border st-border text-xs">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-semibold st-text-primary">
                              {gNodes.length} Nodes · {gEdges.length} Directed Edges ·{" "}
                              {maxLayer + 1} Topological Layer(s)
                            </span>
                            {focusedNode ? (
                              <>
                                <span className="px-2 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-300 font-mono font-bold">
                                  Selected: {focusedNode.label}
                                </span>
                                <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 font-mono">
                                  Upstream ({focusedNode.upstreamIds?.length || 0}):{" "}
                                  {focusedNode.upstreamIds?.join(", ") || "none"}
                                </span>
                                <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-mono">
                                  Impact Radius ({focusedNode.downstreamIds?.length || 0}):{" "}
                                  {focusedNode.downstreamIds?.join(", ") || "none"}
                                </span>
                              </>
                            ) : (
                              <span className="st-text-muted">
                                Click any node to highlight its upstream dependencies & downstream blast radius
                              </span>
                            )}
                          </div>

                          {focusedNode && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {focusedNode.actionId &&
                                renderBoundTriggerButton(
                                  node,
                                  "Node Action",
                                  {
                                    label: focusedNode.label,
                                    actionId: focusedNode.actionId,
                                    mode: "run",
                                    args: focusedNode.args,
                                  },
                                  {
                                    row: focusedNode.rawRow || {
                                      id: focusedNode.id,
                                      label: focusedNode.label,
                                      value: focusedNode.value || focusedNode.id,
                                    },
                                    node: focusedNode,
                                    scopeSummary: `Graph Node ${focusedNode.id} (per-node actionId)`,
                                  },
                                  `per-node-${focusedNode.id}`,
                                  "primary"
                                )}
                              {nodeActions.map((na, nIdx) =>
                                renderBoundTriggerButton(
                                  node,
                                  "Node Action",
                                  na,
                                  {
                                    row: focusedNode.rawRow || {
                                      id: focusedNode.id,
                                      label: focusedNode.label,
                                      value: focusedNode.value || focusedNode.id,
                                    },
                                    node: focusedNode,
                                    scopeSummary: `Graph Node ${focusedNode.id} (Impact: ${
                                      focusedNode.downstreamIds?.length || 0
                                    })`,
                                  },
                                  nIdx,
                                  "primary"
                                )
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  setActiveGraphNodeId((prev) => ({
                                    ...prev,
                                    [node.id]: null,
                                  }))
                                }
                                className="px-2 py-1 rounded-lg st-btn-secondary font-semibold"
                              >
                                Clear Focus
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Layered Directed Graph SVG + Card Canvas */}
                        <div className="rounded-xl border st-border st-code-surface overflow-x-auto overflow-y-auto max-h-[420px]">
                          <div
                            className="relative select-none"
                            style={{ width: `${canvasW}px`, height: `${canvasH}px` }}
                          >
                            <svg
                              width={canvasW}
                              height={canvasH}
                              className="absolute inset-0 pointer-events-none"
                            >
                              <defs>
                                <marker
                                  id={`arrow-${node.id}`}
                                  viewBox="0 0 10 10"
                                  refX="8"
                                  refY="5"
                                  markerWidth="6"
                                  markerHeight="6"
                                  orient="auto-start-reverse"
                                >
                                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#0ea5e9" />
                                </marker>
                              </defs>
                              {gEdges.map((edge, eIdx) => {
                                const srcPos = coords.get(edge.source);
                                const tgtPos = coords.get(edge.target);
                                if (!srcPos || !tgtPos) return null;
                                const x1 = srcPos.x + COL_W;
                                const y1 = srcPos.y + ROW_H / 2;
                                const x2 = tgtPos.x;
                                const y2 = tgtPos.y + ROW_H / 2;
                                const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
                                const pathD = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${
                                  x2 - dx
                                } ${y2}, ${x2} ${y2}`;

                                const isHighlighted =
                                  !focusedNode ||
                                  (edge.source === focusedNode.id &&
                                    downstreamSet.has(edge.target)) ||
                                  (edge.target === focusedNode.id &&
                                    upstreamSet.has(edge.source)) ||
                                  (upstreamSet.has(edge.source) &&
                                    upstreamSet.has(edge.target)) ||
                                  (downstreamSet.has(edge.source) &&
                                    downstreamSet.has(edge.target));

                                return (
                                  <g
                                    key={`${edge.source}->${edge.target}-${eIdx}`}
                                    opacity={isHighlighted ? 0.95 : 0.22}
                                  >
                                    <path
                                      d={pathD}
                                      fill="none"
                                      stroke="#0ea5e9"
                                      strokeWidth={
                                        focusedNode && isHighlighted ? 2.4 : 1.5
                                      }
                                      markerEnd={`url(#arrow-${node.id})`}
                                    />
                                    {edge.label && (
                                      <text
                                        x={(x1 + x2) / 2}
                                        y={(y1 + y2) / 2 - 6}
                                        textAnchor="middle"
                                        className="fill-sky-600 dark:fill-sky-400 text-[9.5px] font-mono"
                                      >
                                        {edge.label}
                                      </text>
                                    )}
                                  </g>
                                );
                              })}
                            </svg>

                            {gNodes.map((gn) => {
                              const pos = coords.get(gn.id);
                              if (!pos) return null;
                              const isSelected = selectedNodeId === gn.id;
                              const isUpstream = upstreamSet.has(gn.id);
                              const isDownstream = downstreamSet.has(gn.id);
                              const isDimmed =
                                Boolean(focusedNode) &&
                                !isSelected &&
                                !isUpstream &&
                                !isDownstream;

                              return (
                                <div
                                  key={gn.id}
                                  onClick={() => {
                                    setActiveGraphNodeId((prev) => ({
                                      ...prev,
                                      [node.id]: isSelected ? null : gn.id,
                                    }));
                                    if (selectContextKey) {
                                      handleMasterItemClick(gn.value || gn.id);
                                    }
                                  }}
                                  style={{
                                    left: `${pos.x}px`,
                                    top: `${pos.y}px`,
                                    width: `${COL_W}px`,
                                    height: `${ROW_H}px`,
                                  }}
                                  className={`absolute rounded-xl p-2.5 border flex flex-col justify-between cursor-pointer transition-all st-card ${
                                    isSelected
                                      ? "border-sky-500 ring-2 ring-sky-500/40 shadow-lg"
                                      : isUpstream
                                        ? "border-amber-500/70 bg-amber-500/5"
                                        : isDownstream
                                          ? "border-emerald-500/70 bg-emerald-500/5"
                                          : "st-border hover:border-sky-500/50"
                                  } ${isDimmed ? "opacity-35" : "opacity-100"}`}
                                >
                                  <div className="flex items-center justify-between gap-1.5">
                                    <span className="px-1.5 py-0.5 rounded text-[9.5px] font-mono uppercase st-pill truncate">
                                      {gn.group || `L${gn.layer ?? 0}`}
                                    </span>
                                    <span className="text-[10px] font-mono st-text-muted shrink-0">
                                      ↑{gn.upstreamIds?.length || 0} · ↓
                                      {gn.downstreamIds?.length || 0}
                                    </span>
                                  </div>
                                  <div className="font-mono text-xs font-bold st-text-primary truncate">
                                    {gn.label}
                                  </div>
                                  <div className="text-[10.5px] font-mono st-text-secondary truncate">
                                    {gn.meta || gn.id}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })()
                ) : (shape === "table" || (shape === "stream" && Array.isArray(projectedValue?.rows))) && projectedValue ? (
                  (() => {
                    const cols: TableColumn[] = projectedValue.columns || node.columns || [];
                    const allRows: Record<string, unknown>[] = projectedValue.rows || [];
                    const pk = projectedValue.primaryKey || node.primaryKey || cols[0]?.key || "id";
                    const q = (tableSearch[node.id] || "").trim().toLowerCase();
                    const filteredRows = q
                      ? allRows.filter((r) =>
                          Object.values(r).some((v) => String(v ?? "").toLowerCase().includes(q))
                        )
                      : allRows;
                    const rowActions = node.rowActions || [];
                    const bulkActions = node.bulkActions || [];
                    const hasBulk = true;
                    const selectedSet = selectedRowKeys[node.id] || new Set<string>();
                    const selectedRowsList = allRows.filter((r, i) =>
                      selectedSet.has(String(r[pk] ?? i))
                    );

                    return (
                      <div className="flex flex-col gap-2">
                        {selectedRowsList.length > 0 && (
                          <div className="flex items-center justify-between px-3 py-1.5 rounded-xl bg-sky-500/10 border border-sky-500/30 text-xs">
                            <span className="font-semibold text-sky-600 dark:text-sky-300">
                              {selectedRowsList.length} row(s) selected
                            </span>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {bulkActions.map((ba, bIdx) =>
                                renderBoundTriggerButton(
                                  node,
                                  "Bulk Action",
                                  ba,
                                  {
                                    selectedRows: selectedRowsList,
                                    scopeSummary: `${selectedRowsList.length} selected row(s)`,
                                  },
                                  bIdx,
                                  "primary"
                                )
                              )}
                              <button
                                type="button"
                                onClick={async () => {
                                  await fetch(`/api/units/${encodeURIComponent(skillId)}/events`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                      eventType: "decision_submitted",
                                      payload: {
                                        decision: "rows_selected",
                                        nodeId: node.id,
                                        selectedRows: selectedRowsList,
                                        submittedAt: new Date().toISOString(),
                                      },
                                    }),
                                  });
                                }}
                                className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
                                title="Send selected rows as a HITL decision to a waiting CLI Agent (manifest-cli wait)"
                              >
                                ✅ Submit Selected to Agent
                              </button>
                            </div>
                          </div>
                        )}

                        <div className="rounded-xl border st-border overflow-x-auto max-h-72 overflow-y-auto">
                          {filteredRows.length === 0 ? (
                            <div className="p-4 text-xs st-text-muted flex flex-col items-center gap-2.5 text-center">
                              <span>
                                {node.runtime === "passive"
                                  ? "Waiting for action output..."
                                  : "No matching rows."}
                              </span>
                              {rowActions.length > 0 && (
                                <div className="flex items-center justify-center gap-1.5 flex-wrap pt-2 border-t st-border w-full">
                                  <span className="text-[11px] font-semibold st-text-secondary mr-1">
                                    Bound Row Actions (click to audit):
                                  </span>
                                  {rowActions.map((ra, aIdx) => {
                                    const placeholderRow = Object.fromEntries(
                                      cols.map((c) => [c.key, `<${c.key}>`])
                                    );
                                    return renderBoundTriggerButton(
                                      node,
                                      "Row Action",
                                      ra,
                                      {
                                        row: placeholderRow,
                                        scopeSummary: "Empty table — using column placeholders",
                                      },
                                      aIdx,
                                      "secondary"
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          ) : (
                            <table className="w-full text-left border-collapse">
                              <thead>
                                <tr className="border-b st-border st-subcard text-[11px] font-bold st-text-secondary uppercase tracking-wider">
                                  {hasBulk && <th className="py-2 px-3 w-8" />}
                                  {cols.map((col) => (
                                    <th key={col.key} className="py-2 px-3">
                                      {col.label}
                                    </th>
                                  ))}
                                  {rowActions.length > 0 && (
                                    <th className="py-2 px-3 text-right">Actions</th>
                                  )}
                                </tr>
                              </thead>
                              <tbody className="divide-y st-border">
                                {filteredRows.map((row, rIdx) => {
                                  const rowKey = String(row[pk] ?? rIdx);
                                  const isChecked = selectedSet.has(rowKey);
                                  const isSelectedMaster =
                                    Boolean(selectContextKey) && activeMasterContextVal === rowKey;
                                  return (
                                    <tr
                                      key={rowKey}
                                      onClick={() => {
                                        if (selectContextKey) handleMasterItemClick(rowKey);
                                      }}
                                      className={`transition-colors ${
                                        selectContextKey ? "cursor-pointer" : ""
                                      } ${
                                        isSelectedMaster
                                          ? "bg-sky-500/15 font-semibold"
                                          : "hover:st-surface-muted"
                                      }`}
                                    >
                                      {hasBulk && (
                                        <td
                                          className="py-2 px-3"
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={isChecked}
                                            onChange={(e) => {
                                              const next = new Set(selectedSet);
                                              if (e.target.checked) next.add(rowKey);
                                              else next.delete(rowKey);
                                              setSelectedRowKeys((prev) => ({
                                                ...prev,
                                                [node.id]: next,
                                              }));
                                            }}
                                            className="w-3.5 h-3.5 rounded accent-sky-600"
                                          />
                                        </td>
                                      )}
                                      {cols.map((col) => (
                                        <td key={col.key} className="py-2 px-3">
                                          {renderCellContent(col, row[col.key])}
                                        </td>
                                      ))}
                                      {rowActions.length > 0 && (
                                        <td
                                          className="py-2 px-3 text-right whitespace-nowrap"
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          <div className="inline-flex items-center gap-1.5 justify-end">
                                            {rowActions.map((ra, aIdx) =>
                                              renderBoundTriggerButton(
                                                node,
                                                "Row Action",
                                                ra,
                                                {
                                                  row,
                                                  scopeSummary: `Row ${pk}=${rowKey}`,
                                                },
                                                aIdx,
                                                "secondary"
                                              )
                                            )}
                                          </div>
                                        </td>
                                      )}
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </div>
                    );
                  })()
                ) : shape === "matrix" && projectedValue ? (
                  (() => {
                    const matrixRowActions = node.rowActions || node.nodeActions || [];
                    return (
                      <div className="rounded-xl border st-border overflow-x-auto max-h-72 overflow-y-auto">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="border-b st-border st-subcard text-[11px] font-bold st-text-secondary">
                              <th className="py-2 px-3">Row \ Col</th>
                              {(projectedValue.colKeys || []).map((ck: string) => (
                                <th key={ck} className="py-2 px-3 text-center">
                                  {ck}
                                </th>
                              ))}
                              {!node.cellAction && matrixRowActions.length > 0 && (
                                <th className="py-2 px-3 text-right">Actions</th>
                              )}
                            </tr>
                          </thead>
                          <tbody className="divide-y st-border">
                            {(projectedValue.rowKeys || []).map((rk: string) => {
                              const rawRow =
                                projectedValue.rowRecordMap?.[rk] || { id: rk, value: rk };
                              const isSelectedMaster =
                                Boolean(selectContextKey) && activeMasterContextVal === rk;
                              return (
                                <tr
                                  key={rk}
                                  onClick={() => {
                                    if (selectContextKey) handleMasterItemClick(rk);
                                  }}
                                  className={`transition-colors ${
                                    selectContextKey ? "cursor-pointer" : ""
                                  } ${
                                    isSelectedMaster
                                      ? "bg-sky-500/15 font-semibold"
                                      : "hover:st-surface-muted"
                                  }`}
                                >
                                  <td className="py-2 px-3 font-mono font-semibold st-text-primary">
                                    {rk}
                                  </td>
                                  {(projectedValue.colKeys || []).map((ck: string) => {
                                    const cellVal = projectedValue.cells?.[rk]?.[ck];
                                    return (
                                      <td
                                        key={ck}
                                        className="py-2 px-3 text-center"
                                        onClick={(e) => {
                                          if (node.cellAction) e.stopPropagation();
                                        }}
                                      >
                                        {node.cellAction ? (
                                          <button
                                            type="button"
                                            onClick={() =>
                                              handleBoundTriggerLeftClick(
                                                node,
                                                "Cell Action",
                                                node.cellAction!,
                                                {
                                                  row: rawRow,
                                                  cell: {
                                                    rowKey: rk,
                                                    colKey: ck,
                                                    value: cellVal,
                                                    rawRow,
                                                  },
                                                  scopeSummary: `Cell [${rk}, ${ck}] = ${String(cellVal ?? "")}`,
                                                }
                                              )
                                            }
                                            onContextMenu={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              triggerBound(
                                                node,
                                                "Cell Action",
                                                node.cellAction!,
                                                {
                                                  row: rawRow,
                                                  cell: {
                                                    rowKey: rk,
                                                    colKey: ck,
                                                    value: cellVal,
                                                    rawRow,
                                                  },
                                                  scopeSummary: `Cell [${rk}, ${ck}] = ${String(cellVal ?? "")}`,
                                                }
                                              );
                                            }}
                                            className="px-2 py-0.5 rounded-md st-btn-secondary font-mono text-xs"
                                            title={`Target: ${node.cellAction.actionId} · Left-Click: Execute · Right-Click: Configure & Audit`}
                                          >
                                            {String(cellVal ?? "—")}
                                          </button>
                                        ) : (
                                          <span className="font-mono">
                                            {String(cellVal ?? "—")}
                                          </span>
                                        )}
                                      </td>
                                    );
                                  })}
                                  {!node.cellAction && matrixRowActions.length > 0 && (
                                    <td
                                      className="py-2 px-3 text-right whitespace-nowrap"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <div className="inline-flex items-center gap-1.5 justify-end">
                                        {matrixRowActions.map((ra, aIdx) =>
                                          renderBoundTriggerButton(
                                            node,
                                            "Row Action",
                                            ra,
                                            {
                                              row: rawRow,
                                              cell: {
                                                rowKey: rk,
                                                colKey: "",
                                                value: rk,
                                                rawRow,
                                              },
                                              scopeSummary: `Matrix Row ${rk}`,
                                            },
                                            aIdx,
                                            "secondary"
                                          )
                                        )}
                                      </div>
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    );
                  })()
                ) : (
                  (() => {
                    const rawOut = snap
                      ? snap.stdout || snap.stderr || "(Empty output)"
                      : "";
                    const lines = rawOut.split(/\r?\n/);
                    const hasMore = lines.length > 6;
                    const displayed = expanded ? rawOut : lines.slice(0, 6).join("\n");
                    return (
                      <div className="flex flex-col gap-1.5">
                        {hasMore && (
                          <div className="flex justify-end">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedMap((prev) => ({
                                  ...prev,
                                  [node.id]: !expanded,
                                }))
                              }
                              className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-lg text-[11px] st-btn-secondary"
                            >
                              <span>
                                {expanded ? "Collapse" : `Show all (${lines.length} lines)`}
                              </span>
                              {expanded ? (
                                <ChevronDown className="w-3 h-3" />
                              ) : (
                                <ChevronRight className="w-3 h-3" />
                              )}
                            </button>
                          </div>
                        )}
                        <div className="st-code-surface rounded-xl border st-border p-3 text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto">
                          <pre
                            className="leading-relaxed whitespace-pre-wrap break-words"
                            dangerouslySetInnerHTML={{ __html: ansiToHtml(displayed) }}
                          />
                        </div>
                      </div>
                    );
                  })()
                )}
              </div>
            );
        };

        if (workbenchNodes.length === 0) {
          if ((dataNodes || []).length > 0 && scalarNodes.length === 0) {
            return (
              <div className="st-card rounded-2xl p-6 text-center text-xs st-text-muted">
                No reactive data nodes match the current filter.
              </div>
            );
          }
          return null;
        }

        const renderNodeInAccordionRow = (n: DataNode) => {
          const isOpen = expandedAccordionIds.has(n.id);
          const nSnap = snapshots[n.id];
          const nBaseShape = (nSnap?.shape || n.shape || "raw") as DataShape;
          const nShape = (viewModeOverride[n.id] || nBaseShape) as DataShape;
          const nPrim = nSnap?.primitive || inferDataPrimitive(nBaseShape, nSnap?.rawParsed);
          const summaryText = summarizeNodeSnapshot(n, nSnap);

          return (
            <div
              key={n.id}
              className="st-card rounded-2xl overflow-hidden border st-border transition-all"
            >
              <div
                onClick={() =>
                  setExpandedAccordionIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(n.id)) next.delete(n.id);
                    else next.add(n.id);
                    return next;
                  })
                }
                className="px-4 py-3 flex items-center justify-between gap-3 cursor-pointer select-none hover:st-surface-muted"
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-sky-500 shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 st-text-muted shrink-0" />
                  )}
                  <span className="text-sm font-bold st-text-primary truncate">{n.title}</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25">
                    {nPrim} ➔ {nShape.toUpperCase()}
                  </span>
                  <span className="px-2 py-0.5 rounded text-[11px] font-mono st-pill">
                    {summaryText}
                  </span>
                </div>

                <div
                  className="flex items-center gap-1.5 shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  {(n.quickActions || []).map((qa, idx) =>
                    renderBoundTriggerButton(
                      n,
                      "Quick Action",
                      qa,
                      { scopeSummary: "Card Quick Action" },
                      idx,
                      "secondary"
                    )
                  )}
                  <button
                    type="button"
                    onClick={() => refreshSingleNode(n)}
                    className="p-1.5 rounded-lg st-btn-secondary"
                    title="Refresh data node"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 ${
                        loadingMap[n.id] ? "animate-spin text-sky-500" : ""
                      }`}
                    />
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="p-3 pt-0 border-t st-border">{renderDataNodeCard(n)}</div>
              )}
            </div>
          );
        };

        if (workbenchLayout === "split") {
          const pinnedNodes = workbenchNodes.filter((n) => pinnedNodeIds.includes(n.id));
          const pinnedSet = new Set(pinnedNodes.map((n) => n.id));
          const scopeNodes = scopedWorkbenchNodes.filter((n) => !pinnedSet.has(n.id));

          const renderTreeLeafItem = (n: DataNode) => {
            const nSnap = snapshots[n.id];
            const nBaseShape = (nSnap?.shape || n.shape || "raw") as DataShape;
            const nShape = (viewModeOverride[n.id] || nBaseShape) as DataShape;
            const nPrim = nSnap?.primitive || inferDataPrimitive(nBaseShape, nSnap?.rawParsed);
            const isFocusedLeaf = dataScope.kind === "node" && dataScope.nodeId === n.id;
            const isPinned = pinnedNodeIds.includes(n.id);
            const summaryText = summarizeNodeSnapshot(n, nSnap);

            return (
              <div
                key={n.id}
                onClick={() => setDataScope({ kind: "node", nodeId: n.id })}
                className={`group rounded-xl px-2.5 py-2 border transition-all cursor-pointer flex flex-col gap-1 ${
                  isFocusedLeaf
                    ? "bg-sky-500/15 border-sky-500/50 shadow-sm"
                    : isPinned
                      ? "st-subcard border-sky-500/30"
                      : "border-transparent hover:st-surface-muted"
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span
                    className={`text-xs truncate ${
                      isFocusedLeaf
                        ? "font-bold text-sky-700 dark:text-sky-300"
                        : "font-semibold st-text-primary"
                    }`}
                  >
                    {n.title}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePinNode(n.id);
                    }}
                    className={`p-1 rounded-md text-[10px] font-mono transition-colors shrink-0 ${
                      isPinned
                        ? "bg-sky-600 text-white"
                        : "opacity-60 group-hover:opacity-100 st-btn-secondary"
                    }`}
                    title={
                      isPinned
                        ? "Unpin from split-view canvas"
                        : "Pin card to keep visible at top of canvas while browsing other scopes"
                    }
                  >
                    <Pin className="w-3 h-3" />
                  </button>
                </div>

                <div className="flex items-center justify-between gap-1.5 text-[10.5px] font-mono">
                  <span className="px-1.5 py-0.5 rounded bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 font-semibold">
                    {nPrim} ➔ {nShape.toUpperCase()}
                  </span>
                  <span className="st-text-muted truncate">{summaryText}</span>
                </div>
              </div>
            );
          };

          return (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
              {/* Left 4-Level Clickable Data Scope Tree (All ➔ Category ➔ Subgroup ➔ Node) */}
              <aside className="lg:col-span-4 xl:col-span-3 st-card rounded-2xl p-3 flex flex-col gap-2 lg:sticky lg:top-4 max-h-[78vh] overflow-y-auto">
                <div className="flex items-center justify-between px-1 pb-2 border-b st-border">
                  <span className="text-xs font-bold st-text-primary flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5 text-sky-500" />
                    <span>Data Hierarchy</span>
                  </span>
                  {pinnedNodes.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold">
                      📌 {pinnedNodes.length} pinned
                    </span>
                  )}
                </div>

                {/* Level 0: All Data Nodes */}
                <button
                  type="button"
                  onClick={() => setDataScope({ kind: "all" })}
                  className={`w-full text-left px-3 py-2 rounded-xl text-xs font-semibold flex items-center justify-between transition-all ${
                    dataScope.kind === "all"
                      ? "bg-sky-600 text-white shadow-sm"
                      : "hover:st-surface-muted st-text-primary"
                  }`}
                >
                  <span>All Data Nodes</span>
                  <span className="text-[11px] font-mono opacity-80">{workbenchNodes.length}</span>
                </button>

                {/* Level 1: Category Headers (Clickable!) -> Level 2: Subgroup Headers (Clickable!) -> Level 3: Leaf Nodes */}
                <div className="flex flex-col gap-1.5">
                  {dataHierarchyTree.map((catEntry) => {
                    const isCatSelected =
                      dataScope.kind === "category" && dataScope.category === catEntry.category;
                    const isCatExpanded = expandedDataCategories.has(catEntry.category);
                    const hasSubgroups = catEntry.subgroups.size > 0;
                    const ungroupedNodes = catEntry.nodes.filter(
                      (n) => !getNodeCategoryAndSubgroup(n).subgroup
                    );

                    return (
                      <div key={catEntry.category} className="flex flex-col gap-1">
                        {dataHierarchyTree.length > 1 || hasSubgroups ? (
                          <div
                            onClick={() => {
                              setDataScope({ kind: "category", category: catEntry.category });
                              setExpandedDataCategories((prev) =>
                                new Set([...prev, catEntry.category])
                              );
                            }}
                            className={`flex items-center justify-between px-2.5 py-1.5 rounded-xl text-xs cursor-pointer transition-all ${
                              isCatSelected
                                ? "bg-sky-500/15 text-sky-700 dark:text-sky-300 font-bold border border-sky-500/40 shadow-sm"
                                : "hover:st-surface-muted st-text-primary font-bold"
                            }`}
                            title={`Click to display all ${catEntry.nodes.length} DataNode(s) in category "${catEntry.category}"`}
                          >
                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedDataCategories((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(catEntry.category)) next.delete(catEntry.category);
                                    else next.add(catEntry.category);
                                    return next;
                                  });
                                }}
                                className="p-0.5 rounded hover:bg-black/10 shrink-0"
                              >
                                {isCatExpanded ? (
                                  <ChevronDown className="w-3.5 h-3.5 st-text-muted" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5 st-text-muted" />
                                )}
                              </button>
                              <span className="truncate">📁 {catEntry.category}</span>
                            </div>
                            <span className="text-[11px] font-mono st-text-muted ml-1.5 shrink-0">
                              {catEntry.nodes.length}
                            </span>
                          </div>
                        ) : null}

                        {isCatExpanded && (
                          <div
                            className={
                              dataHierarchyTree.length > 1 || hasSubgroups
                                ? "pl-3 border-l st-border ml-2.5 flex flex-col gap-1"
                                : "flex flex-col gap-1"
                            }
                          >
                            {/* Subgroup headers */}
                            {Array.from(catEntry.subgroups.entries()).map(([sgName, sgNodes]) => {
                              const isSgSelected =
                                dataScope.kind === "subgroup" &&
                                dataScope.category === catEntry.category &&
                                dataScope.subgroup === sgName;
                              return (
                                <div key={sgName} className="flex flex-col gap-1">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setDataScope({
                                        kind: "subgroup",
                                        category: catEntry.category,
                                        subgroup: sgName,
                                      })
                                    }
                                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-[11.5px] flex items-center justify-between transition-all ${
                                      isSgSelected
                                        ? "bg-sky-600 text-white font-semibold shadow-sm"
                                        : "hover:st-surface-muted st-text-secondary font-semibold"
                                    }`}
                                    title={`Click to display all ${sgNodes.length} DataNode(s) in subgroup "${sgName}"`}
                                  >
                                    <span className="truncate">📂 {sgName}</span>
                                    <span className="text-[10.5px] font-mono opacity-80 ml-1">
                                      {sgNodes.length}
                                    </span>
                                  </button>
                                  <div className="pl-2.5 border-l st-border ml-2 flex flex-col gap-1">
                                    {sgNodes.map((n) => renderTreeLeafItem(n))}
                                  </div>
                                </div>
                              );
                            })}

                            {/* Ungrouped nodes directly under category */}
                            {ungroupedNodes.map((n) => renderTreeLeafItem(n))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </aside>

              {/* Right Active Canvas (Pinned Master Node(s) + Current Scope Nodes) */}
              <div className="lg:col-span-8 xl:col-span-9 flex flex-col gap-4 min-w-0">
                {pinnedNodes.map((n) => renderDataNodeCard(n))}

                {scopeNodes.length > 0 &&
                  (scopeDisplayDensity === "accordion" ? (
                    <div className="flex flex-col gap-2.5">
                      {scopeNodes.map((n) => renderNodeInAccordionRow(n))}
                    </div>
                  ) : scopeDisplayDensity === "grid" ? (
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                      {scopeNodes.map((n) => renderDataNodeCard(n))}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-4">
                      {scopeNodes.map((n) => renderDataNodeCard(n))}
                    </div>
                  ))}
              </div>
            </div>
          );
        }

        if (workbenchLayout === "accordion") {
          return (
            <div className="flex flex-col gap-2.5">
              {scopedWorkbenchNodes.map((n) => renderNodeInAccordionRow(n))}
            </div>
          );
        }

        return (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {scopedWorkbenchNodes.map((n) => renderDataNodeCard(n))}
          </div>
        );
      })()}

      {/* 4. In-Place Bound Action Audit & Execution Modal */}
      {activeAudit && (
        <BoundActionInspectorModal
          skillId={skillId}
          activeWorkspace={activeWorkspace}
          refreshTrigger={refreshTrigger}
          activeAudit={activeAudit}
          actionsMap={actionsMap}
          dataSnapshots={snapshots}
          commandEnvOverrides={commandEnvOverrides}
          onClose={() => setActiveAudit(null)}
          onSkillUpdated={onSkillUpdated}
          onLocateActionInPlayground={onLocateActionInPlayground}
          onExecute={onExecute}
          onExecuteBoundTrigger={onExecuteBoundTrigger}
        />
      )}
    </div>
  );
};

export interface BoundActionInspectorModalProps {
  skillId: string;
  activeWorkspace: string;
  refreshTrigger: number;
  activeAudit: ActiveBoundActionAudit;
  actionsMap: Map<string, { action: ActionItem; groupName: string }>;
  dataSnapshots?: Record<string, DataSnapshot | undefined>;
  commandEnvOverrides?: Record<string, CommandEnvConfig>;
  onClose: () => void;
  onSkillUpdated?: (skill: CanonicalSkill) => void;
  onLocateActionInPlayground?: (actionId: string, formValues: Record<string, unknown>) => void;
  onExecute?: StatusProbesBarProps["onExecute"];
  onExecuteBoundTrigger: StatusProbesBarProps["onExecuteBoundTrigger"];
}

export const BoundActionInspectorModal: React.FC<BoundActionInspectorModalProps> = ({
  skillId,
  activeWorkspace,
  refreshTrigger,
  activeAudit,
  actionsMap,
  dataSnapshots = {},
  commandEnvOverrides,
  onClose,
  onSkillUpdated,
  onLocateActionInPlayground,
  onExecute,
  onExecuteBoundTrigger,
}) => {
  const actId = activeAudit.trigger.actionId || "";
  const targetInfo = actionsMap.get(actId);
  const targetAction = targetInfo?.action;
  const isInline = Boolean(targetAction?.inlineHost || actId.startsWith("inline:"));
  const rawArgsObj = activeAudit.trigger.args || {};
  const rawArgEntries = Object.entries(rawArgsObj);
  const formFields = targetAction?.form || [];
  const formMap = new Map(formFields.map((f) => [f.key, f]));
  const hostSnap = activeAudit.focusScope.hostNodeId
    ? dataSnapshots[activeAudit.focusScope.hostNodeId]
    : undefined;
  const selfCountSummary = resolveSelfSnapshotPath(hostSnap, "count");
  const effectiveFocusRow =
    activeAudit.focusScope.row ||
    activeAudit.focusScope.node?.rawRow ||
    activeAudit.focusScope.cell?.rawRow;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="max-w-3xl w-full max-h-[90vh] overflow-y-auto rounded-2xl st-card p-5 shadow-2xl border st-border-strong flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header: Provenance & Controls */}
        <div className="flex items-start justify-between gap-3 border-b st-border pb-3">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-bold bg-sky-500/15 text-sky-600 dark:text-sky-300 border border-sky-500/30">
                <Eye className="w-3.5 h-3.5" />
                <span>
                  {isInline
                    ? "⚡ Inline Bound Action Audit & Execution"
                    : "Bound Action Audit & Execution"}
                </span>
              </span>
              <span className="px-2 py-0.5 rounded-md text-xs font-mono st-pill">
                {activeAudit.triggerKind}: "{activeAudit.trigger.label}"
              </span>
              <span className="px-2 py-0.5 rounded-md text-xs font-mono st-pill">
                mode: {activeAudit.trigger.mode || "run"}
              </span>
              {activeAudit.scopeSummary && (
                <span className="px-2 py-0.5 rounded-md text-xs font-mono bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20">
                  {activeAudit.scopeSummary}
                </span>
              )}
            </div>
            <div className="text-xs st-text-secondary flex items-center gap-1.5 flex-wrap mt-0.5">
              <span>Host DataNode:</span>
              <code className="font-mono font-semibold st-text-primary">
                {activeAudit.node.title} ({activeAudit.node.id})
              </code>
              <span>→ {isInline ? "Inline Action:" : "Target Action:"}</span>
              {targetAction ? (
                <code className="font-mono font-bold text-sky-600 dark:text-sky-400">
                  {targetAction.title} ({targetAction.id})
                </code>
              ) : (
                <code className="font-mono font-bold text-rose-500">
                  ❌ {actId} (Not Found)
                </code>
              )}
              {targetInfo?.groupName && (
                <span className="st-text-muted">in {targetInfo.groupName}</span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {targetAction && (
              <button
                type="button"
                onClick={() => {
                  const vals = activeAudit.resolvedArgs;
                  onClose();
                  if (onLocateActionInPlayground) {
                    onLocateActionInPlayground(targetAction.id, vals);
                  } else {
                    onExecuteBoundTrigger({
                      actionId: targetAction.id,
                      mode: "prefill",
                      formValues: vals,
                      focusScope: activeAudit.focusScope,
                    });
                  }
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold st-btn-secondary"
                title="Close modal and scroll to this action card in the Playground list below"
              >
                <ArrowDownCircle className="w-3.5 h-3.5 text-sky-500" />
                <span>Locate in Playground</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-xl st-btn-secondary"
              title="Close (Esc)"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Section 1: 4-Layer Scope & Argument Binding Audit */}
        <div className="flex flex-col gap-2">
          <div className="text-xs font-bold st-text-primary flex items-center justify-between">
            <span>
              1. 4-Layer Focus Scope (`self` / `row` / `node` / `cell`) & Argument Binding Audit
            </span>
            <span className="text-[11px] font-mono st-text-muted">
              {rawArgEntries.length} bound arg(s)
            </span>
          </div>

          {effectiveFocusRow && (
            <div className="px-3 py-2 rounded-xl st-code-surface border st-border text-[11px] font-mono flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-bold">
                  L4 Host Focus Scope
                </span>
                {selfCountSummary && (
                  <span className="st-text-secondary">self.count={selfCountSummary}</span>
                )}
                <span className="st-text-primary truncate max-w-md">
                  row={JSON.stringify(effectiveFocusRow)}
                </span>
              </div>
            </div>
          )}

          {rawArgEntries.length === 0 ? (
            <div className="px-3 py-2 rounded-xl st-subcard border st-border text-xs st-text-muted font-mono">
              {isInline
                ? "Inline Action interpolates {{self.*}}, {{row.*}}, {{data.<nodeId>.*}}, {{context.*}}, and {{form.*}} directly in its command template."
                : "No explicit `args` mapping on this trigger — using target action's default form parameters."}
            </div>
          ) : (
            <div className="rounded-xl border st-border overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b st-border st-subcard text-[11px] font-bold st-text-secondary uppercase">
                    <th className="py-1.5 px-3">Form Key</th>
                    <th className="py-1.5 px-3">YAML Binding Template</th>
                    <th className="py-1.5 px-3">Resolved Value</th>
                    <th className="py-1.5 px-3">Target Form Field Match</th>
                  </tr>
                </thead>
                <tbody className="divide-y st-border font-mono">
                  {rawArgEntries.map(([k, rawVal]) => {
                    const resolvedVal = activeAudit.resolvedArgs[k];
                    const matchedField = formMap.get(k);
                    const isEmptyRequired =
                      matchedField?.required &&
                      (resolvedVal === "" ||
                        resolvedVal === undefined ||
                        resolvedVal === null);
                    return (
                      <tr key={k} className="hover:st-surface-muted">
                        <td className="py-1.5 px-3 font-bold text-sky-600 dark:text-sky-400">
                          {k}
                        </td>
                        <td className="py-1.5 px-3 st-text-secondary break-all">
                          {String(rawVal)}
                        </td>
                        <td className="py-1.5 px-3 font-semibold st-text-primary break-all">
                          {JSON.stringify(resolvedVal)}
                        </td>
                        <td className="py-1.5 px-3 font-sans">
                          {!targetAction ? (
                            <span className="text-rose-500 font-semibold">
                              ❌ Target action missing
                            </span>
                          ) : !matchedField ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 font-semibold text-[11px]">
                              ⚠️ Unmatched key (not in target form)
                            </span>
                          ) : isEmptyRequired ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 font-semibold text-[11px]">
                              ⚠️ Required field resolved to empty ({matchedField.label})
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-semibold text-[11px]">
                              ✅ {matchedField.label} ({matchedField.type}
                              {matchedField.flag
                                ? ` · ${matchedField.flag}`
                                : matchedField.positional
                                  ? " · positional"
                                  : ""}
                              )
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Section 2: Interactive ActionCard or Missing Target Diagnostics */}
        {targetAction ? (
          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-bold st-text-primary">
              2. Interactive Parameter Form, Command Preview & Execution
            </div>
            <ActionCard
              key={`${targetAction.id}-${activeAudit.seq}`}
              skillId={skillId}
              action={targetAction}
              activeWorkspace={activeWorkspace}
              refreshTrigger={refreshTrigger}
              prefillValues={activeAudit.resolvedArgs}
              focusScope={activeAudit.focusScope}
              uiEnvOverride={commandEnvOverrides?.[`action:${targetAction.id}`]}
              dataSnapshots={dataSnapshots}
              inAuditModal={true}
              onExecuted={onClose}
              onSkillUpdated={onSkillUpdated}
              onTriggerFixAction={(fixId) => {
                onClose();
                onLocateActionInPlayground?.(fixId, {});
              }}
              onExecute={async (p) => {
                if (onExecute) {
                  await onExecute({ ...p, focusScope: activeAudit.focusScope });
                } else {
                  await onExecuteBoundTrigger({
                    actionId: p.actionId,
                    mode: "run",
                    formValues: p.formValues,
                    focusScope: activeAudit.focusScope,
                  });
                }
              }}
            />
          </div>
        ) : (
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-600 dark:text-rose-300 flex flex-col gap-2">
            <div className="font-bold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-rose-500" />
              <span>
                Broken Action Reference: `{activeAudit.trigger.actionId}` does not exist in `actionGroups`.
              </span>
            </div>
            <p>
              Available action IDs in this skill:{" "}
              <code className="font-mono">
                {[...actionsMap.keys()].join(", ") || "(none)"}
              </code>
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
