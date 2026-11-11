import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Database,
  Play,
  RefreshCw,
  Search,
  Sliders,
} from "lucide-react";
import React, { useEffect, useState } from "react";
import { interpolateBoundTriggerArgs } from "../interpolator.ts";
import type {
  BoundActionTrigger,
  ContextField,
  DataNode,
  DataSnapshot,
  TableColumn,
} from "../types.ts";
import { ansiToHtml } from "./highlight.ts";

interface StatusProbesBarProps {
  skillId: string;
  contextFields: ContextField[];
  dataNodes: DataNode[];
  activeWorkspace: string;
  refreshTrigger: number;
  onContextChanged?: (nextContext: Record<string, string | boolean>) => void;
  onExecuteBoundTrigger: (params: {
    actionId: string;
    mode: "run" | "prefill";
    formValues: Record<string, unknown>;
  }) => Promise<void>;
}

export const StatusProbesBar: React.FC<StatusProbesBarProps> = ({
  skillId,
  contextFields,
  dataNodes,
  activeWorkspace,
  refreshTrigger,
  onContextChanged,
  onExecuteBoundTrigger,
}) => {
  const [contextState, setContextState] = useState<Record<string, string | boolean>>({});
  const [snapshots, setSnapshots] = useState<Record<string, DataSnapshot>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});
  const [tableSearch, setTableSearch] = useState<Record<string, string>>({});
  const [selectedRowKeys, setSelectedRowKeys] = useState<Record<string, Set<string>>>({});
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [showIntermediates, setShowIntermediates] = useState<boolean>(false);

  const intermediateNodes = (dataNodes || []).filter((n) => Boolean(n.intermediate || n.hidden));
  const primaryNodes = (dataNodes || []).filter((n) => !n.intermediate && !n.hidden);
  const activePool = showIntermediates ? (dataNodes || []) : primaryNodes;
  const categories = [
    "all",
    ...Array.from(
      new Set(activePool.map((n) => n.category).filter((c): c is string => Boolean(c)))
    ),
  ];
  const visibleNodes = activePool.filter(
    (n) => selectedCategory === "all" || n.category === selectedCategory
  );

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
        onContextChanged?.(body.context || {});
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    setSelectedCategory("all");
    setSnapshots({});
    setSelectedRowKeys({});
    loadAll(false);
  }, [skillId, activeWorkspace]);

  useEffect(() => {
    if (refreshTrigger > 0) {
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
    trigger: BoundActionTrigger,
    scope: {
      row?: Record<string, unknown>;
      selectedRows?: Record<string, unknown>[];
      cell?: { rowKey: string; colKey: string; value: unknown };
    }
  ) => {
    const resolvedArgs = interpolateBoundTriggerArgs(trigger.args, {
      ...scope,
      contextValues: contextState,
      dataSnapshots: snapshots,
    });
    onExecuteBoundTrigger({
      actionId: trigger.actionId,
      mode: trigger.mode || "run",
      formValues: resolvedArgs,
    });
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

      {/* 2. Data Panel Control Bar (Categories + Intermediates Switch + Refresh Data) */}
      {(dataNodes || []).length > 0 && (
        <div className="st-card rounded-2xl px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
          {/* Left Side: Database Icon + Title + Category Filter Pills */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs font-bold st-text-primary">
              <Database className="w-4 h-4 text-sky-500" />
              <span>Reactive Data Graph</span>
            </div>

            {categories.length > 1 && (
              <div className="flex items-center gap-1.5 flex-wrap">
                {categories.map((cat) => {
                  const isAll = cat === "all";
                  const count = isAll
                    ? activePool.length
                    : activePool.filter((n) => n.category === cat).length;
                  const active = selectedCategory === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setSelectedCategory(cat)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                        active
                          ? "bg-sky-600 text-white shadow-sm"
                          : "st-btn-secondary hover:st-text-primary"
                      }`}
                    >
                      {isAll ? `All (${count})` : `${cat} (${count})`}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right Side: Intermediates Toggle + Refresh Data Button */}
          <div className="flex items-center gap-2 flex-wrap">
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

            <button
              type="button"
              onClick={() => loadAll(true)}
              disabled={isAnyLoading}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl st-btn-secondary text-xs font-semibold transition-all"
              title="Refresh all live data nodes"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isAnyLoading ? "animate-spin text-sky-500" : ""}`} />
              <span>↻ Refresh Data</span>
            </button>
          </div>
        </div>
      )}

      {/* 3. Reactive Data Nodes & Interactive Widgets Grid */}
      {visibleNodes.length > 0 ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {visibleNodes.map((node) => {
            const snap = snapshots[node.id];
            const loading = Boolean(loadingMap[node.id]);
            const expanded = Boolean(expandedMap[node.id]);
            const shape = snap?.shape || node.shape || "raw";
            const isFullSpan = shape === "table" || shape === "matrix";
            const isIntermediate = Boolean(node.intermediate || node.hidden);

            return (
              <div
                key={node.id}
                data-sd-pick-kind="data-node"
                data-sd-pick-id={node.id}
                data-sd-pick-title={`Data Node: ${node.title}`}
                className={`st-card rounded-2xl p-4 flex flex-col gap-3 transition-all ${
                  isFullSpan ? "xl:col-span-2" : ""
                } ${isIntermediate ? "border-dashed border-amber-500/40" : ""}`}
              >
                {/* Header */}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0 flex-wrap">
                    {shape === "table" || shape === "matrix" ? (
                      <Database className="w-4 h-4 text-sky-500 shrink-0" />
                    ) : (
                      <Activity className="w-4 h-4 text-emerald-500 shrink-0" />
                    )}
                    <h4 className="text-sm font-bold st-text-primary truncate">{node.title}</h4>
                    {node.category && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-500/10 text-sky-700 dark:text-sky-300 border border-sky-500/20">
                        {node.category}
                      </span>
                    )}
                    {isIntermediate && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                        🔬 INTERMEDIATE · DAG SOURCE
                      </span>
                    )}
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono st-pill uppercase">
                      {node.runtime || "zsh"} · {shape}
                    </span>
                    {snap && (
                      <span className="text-[11px] font-mono st-text-muted shrink-0">
                        ({snap.durationMs}ms{snap.fromCache ? " · cached" : ""})
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {shape === "table" && (
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 st-text-muted absolute left-2.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={tableSearch[node.id] || ""}
                          onChange={(e) =>
                            setTableSearch((prev) => ({ ...prev, [node.id]: e.target.value }))
                          }
                          placeholder="Filter rows..."
                          className="pl-7 pr-2.5 py-1 rounded-lg st-input text-xs w-40 focus:outline-none focus:border-sky-500"
                        />
                      </div>
                    )}

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
                    {node.quickActions.map((qa, idx) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => triggerBound(qa, {})}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold st-btn-secondary hover:border-sky-500/50 transition-colors"
                      >
                        <Play className="w-2.5 h-2.5 text-sky-500 fill-current" />
                        <span>{qa.label}</span>
                      </button>
                    ))}
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
                ) : shape === "scalar" && snap?.value ? (
                  <div className="st-subcard rounded-xl p-4 flex items-baseline gap-2.5">
                    <span
                      className={`text-2xl font-extrabold font-mono ${
                        snap.value.tone === "success"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : snap.value.tone === "warn"
                            ? "text-amber-600 dark:text-amber-400"
                            : snap.value.tone === "danger"
                              ? "text-rose-600 dark:text-rose-400"
                              : "st-text-primary"
                      }`}
                    >
                      {String(snap.value.value ?? "—")}
                    </span>
                    {snap.value.unit && (
                      <span className="text-xs font-semibold st-text-secondary">
                        {snap.value.unit}
                      </span>
                    )}
                  </div>
                ) : shape === "kv" && snap?.value?.entries ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {snap.value.entries.map((entry: any) => (
                      <div
                        key={entry.key}
                        className="st-subcard rounded-xl px-3 py-2 flex items-center justify-between gap-2"
                      >
                        <span className="text-xs font-medium st-text-secondary truncate">
                          {entry.label || entry.key}
                        </span>
                        <code className="text-xs font-mono font-semibold st-text-primary truncate">
                          {String(entry.value ?? "")}
                        </code>
                      </div>
                    ))}
                  </div>
                ) : (shape === "table" || (shape === "stream" && Array.isArray(snap?.value?.rows))) && snap?.value ? (
                  (() => {
                    const cols: TableColumn[] = snap.value.columns || node.columns || [];
                    const allRows: Record<string, unknown>[] = snap.value.rows || [];
                    const pk = snap.value.primaryKey || node.primaryKey || cols[0]?.key || "id";
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
                            <div className="flex items-center gap-1.5">
                              {bulkActions.map((ba, bIdx) => (
                                <button
                                  key={bIdx}
                                  type="button"
                                  onClick={() =>
                                    triggerBound(ba, { selectedRows: selectedRowsList })
                                  }
                                  className="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white font-semibold"
                                >
                                  {ba.label}
                                </button>
                              ))}
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
                            <div className="p-4 text-xs st-text-muted text-center">
                              {node.runtime === "passive"
                                ? "Waiting for action output..."
                                : "No matching rows."}
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
                                  return (
                                    <tr
                                      key={rowKey}
                                      className="hover:st-surface-muted transition-colors"
                                    >
                                      {hasBulk && (
                                        <td className="py-2 px-3">
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
                                        <td className="py-2 px-3 text-right whitespace-nowrap">
                                          <div className="inline-flex items-center gap-1.5 justify-end">
                                            {rowActions.map((ra, aIdx) => (
                                              <button
                                                key={aIdx}
                                                type="button"
                                                onClick={() => triggerBound(ra, { row })}
                                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold st-btn-secondary hover:border-sky-500/50 transition-colors"
                                              >
                                                <Play className="w-2.5 h-2.5 text-sky-500 fill-current" />
                                                <span>{ra.label}</span>
                                              </button>
                                            ))}
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
                ) : shape === "matrix" && snap?.value ? (
                  <div className="rounded-xl border st-border overflow-x-auto max-h-72 overflow-y-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b st-border st-subcard text-[11px] font-bold st-text-secondary">
                          <th className="py-2 px-3">Row \ Col</th>
                          {(snap.value.colKeys || []).map((ck: string) => (
                            <th key={ck} className="py-2 px-3 text-center">
                              {ck}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y st-border">
                        {(snap.value.rowKeys || []).map((rk: string) => (
                          <tr key={rk} className="hover:st-surface-muted">
                            <td className="py-2 px-3 font-mono font-semibold st-text-primary">
                              {rk}
                            </td>
                            {(snap.value.colKeys || []).map((ck: string) => {
                              const cellVal = snap.value.cells?.[rk]?.[ck];
                              return (
                                <td key={ck} className="py-2 px-3 text-center">
                                  {node.cellAction ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        triggerBound(node.cellAction!, {
                                          cell: { rowKey: rk, colKey: ck, value: cellVal },
                                        })
                                      }
                                      className="px-2 py-0.5 rounded-md st-btn-secondary font-mono text-xs"
                                    >
                                      {String(cellVal ?? "—")}
                                    </button>
                                  ) : (
                                    <span className="font-mono">{String(cellVal ?? "—")}</span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
          })}
        </div>
      ) : (dataNodes || []).length > 0 ? (
        <div className="st-card rounded-2xl p-6 text-center text-xs st-text-muted">
          No reactive data nodes match the current filter.
        </div>
      ) : null}
    </div>
  );
};
