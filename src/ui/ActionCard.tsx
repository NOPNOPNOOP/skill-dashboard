import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Database,
  ExternalLink,
  Eye,
  FolderOpen,
  Play,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { evaluateActionPrecondition } from "../interpolator.ts";
import type {
  ActionItem,
  BoundActionTrigger,
  CanonicalSkill,
  CommandEnvConfig,
  DataNode,
  DataSnapshot,
  FormField,
  ResolvedCommandEnvSummary,
} from "../types.ts";
import { CommandEnvEditor } from "./CommandEnvEditor.tsx";
import { highlightCodeToHtml } from "./highlight.ts";

interface ActionCardProps {
  skillId: string;
  action: ActionItem;
  activeWorkspace: string;
  refreshTrigger?: number;
  prefillValues?: Record<string, unknown> | null;
  uiEnvOverride?: CommandEnvConfig;
  dataSnapshots?: Record<string, DataSnapshot | undefined>;
  dataNodes?: DataNode[];
  actionProvenance?: string;
  inAuditModal?: boolean;
  onExecuted?: () => void;
  onSkillUpdated?: (skill: CanonicalSkill) => void;
  onTriggerFixAction?: (actionId: string) => void;
  onExecute: (params: {
    actionId: string;
    formValues: Record<string, unknown>;
    runner: "web_terminal" | "external_terminal";
    terminalApp?: "Terminal" | "iTerm";
    humanApproved?: boolean;
  }) => Promise<void>;
}

function isFieldVisible(field: FormField, values: Record<string, unknown>): boolean {
  if (!field.when) return true;
  return values[field.when.field] === field.when.equals;
}

export const ActionCard: React.FC<ActionCardProps> = ({
  skillId,
  action,
  activeWorkspace,
  refreshTrigger = 0,
  prefillValues,
  uiEnvOverride,
  dataSnapshots = {},
  dataNodes = [],
  actionProvenance,
  inAuditModal = false,
  onExecuted,
  onSkillUpdated,
  onTriggerFixAction,
  onExecute,
}) => {
  const [extraSnapshots, setExtraSnapshots] = useState<Record<string, DataSnapshot>>({});
  const [formValues, setFormValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const f of action.form || []) {
      if (f.default !== undefined) {
        initial[f.key] = f.default;
      } else if (f.type === "boolean") {
        initial[f.key] = false;
      } else {
        initial[f.key] = "";
      }
    }
    return initial;
  });

  useEffect(() => {
    const initial: Record<string, unknown> = {};
    for (const f of action.form || []) {
      if (f.default !== undefined) {
        initial[f.key] = f.default;
      } else if (f.type === "boolean") {
        initial[f.key] = false;
      } else {
        initial[f.key] = "";
      }
    }
    if (prefillValues) {
      Object.assign(initial, prefillValues);
    }
    setFormValues(initial);
    setErrorMsg(null);
  }, [action.id]);

  // Apply prefillValues when passed from external jump
  useEffect(() => {
    if (prefillValues && Object.keys(prefillValues).length > 0) {
      setFormValues((prev) => ({ ...prev, ...prefillValues }));
    }
  }, [prefillValues]);

  // Dynamic DataNode options per field key (fromData)
  const [dynamicOptions, setDynamicOptions] = useState<
    Record<string, Array<{ label: string; value: string }>>
  >({});
  const [loadingDs, setLoadingDs] = useState<Record<string, boolean>>({});

  const fetchFieldDataNode = async (field: FormField, force = false) => {
    if (!field.fromData) return;
    setLoadingDs((prev) => ({ ...prev, [field.key]: true }));
    try {
      const res = await fetch(
        `/api/skills/${encodeURIComponent(skillId)}/data/${encodeURIComponent(field.fromData)}${
          force ? "?force=1" : ""
        }`
      );
      if (res.ok) {
        const snap = await res.json();
        let opts: Array<{ label: string; value: string }> = snap.options || [];
        if (
          (field.valueColumn || field.labelColumn || field.metaColumn) &&
          snap.value &&
          Array.isArray(snap.value.rows)
        ) {
          const valCol = field.valueColumn || snap.value.primaryKey || "name";
          const lblCol = field.labelColumn || valCol;
          const metaCol = field.metaColumn;
          opts = snap.value.rows
            .map((r: any) => {
              const v = r[valCol];
              if (v === undefined || v === null) return null;
              const l = String(r[lblCol] ?? v);
              const m = metaCol && r[metaCol] !== undefined ? String(r[metaCol]) : undefined;
              return {
                value: String(v),
                label: m && !l.includes(m) ? `${l} (${m})` : l,
              };
            })
            .filter(Boolean);
        }
        setDynamicOptions((prev) => ({ ...prev, [field.key]: opts }));
        setFormValues((prev) => {
          if (
            (prev[field.key] === "" || prev[field.key] === undefined) &&
            opts.length > 0 &&
            field.required
          ) {
            return { ...prev, [field.key]: opts[0].value };
          }
          return prev;
        });
      }
    } catch {
      // ignore
    } finally {
      setLoadingDs((prev) => ({ ...prev, [field.key]: false }));
    }
  };

  useEffect(() => {
    for (const f of action.form || []) {
      if (f.fromData) {
        fetchFieldDataNode(f, refreshTrigger > 0);
      }
    }
    for (const pre of action.preconditions || []) {
      if (pre.dataNodeId && !dataSnapshots[pre.dataNodeId]) {
        fetch(
          `/api/skills/${encodeURIComponent(skillId)}/data/${encodeURIComponent(pre.dataNodeId)}${
            refreshTrigger > 0 ? "?force=1" : ""
          }`
        )
          .then((r) => (r.ok ? r.json() : null))
          .then((snap) => {
            if (snap && snap.nodeId) {
              setExtraSnapshots((prev) => ({ ...prev, [snap.nodeId]: snap }));
            }
          })
          .catch(() => {});
      }
    }
  }, [skillId, action.id, activeWorkspace, refreshTrigger]);

  const mergedSnapshots: Record<string, DataSnapshot | undefined> = {
    ...extraSnapshots,
    ...dataSnapshots,
  };
  const evaluatedPreconditions = (action.preconditions || []).map((pre) => ({
    pre,
    ...evaluateActionPrecondition(pre, mergedSnapshots),
  }));
  const failedPreconditions = evaluatedPreconditions.filter((p) => !p.passed);

  const [previewCmd, setPreviewCmd] = useState<string>(action.command);
  const [previewCwd, setPreviewCwd] = useState<string>(activeWorkspace);
  const [resolvedEnv, setResolvedEnv] = useState<ResolvedCommandEnvSummary | null>(null);
  const [envPanelOpen, setEnvPanelOpen] = useState(false);
  const [inspectOpen, setInspectOpen] = useState(false);
  const [inspectTab, setInspectTab] = useState<"template" | "bindings" | "raw">("template");
  const [copiedInspect, setCopiedInspect] = useState(false);
  const [copiedMode, setCopiedMode] = useState<"cmd" | "prompt" | null>(null);

  const upstreamBoundTriggers = useMemo(() => {
    const list: Array<{
      nodeId: string;
      nodeTitle: string;
      kind: string;
      trigger: BoundActionTrigger;
    }> = [];
    for (const dn of dataNodes || []) {
      for (const t of dn.quickActions || []) {
        if (t.actionId === action.id)
          list.push({ nodeId: dn.id, nodeTitle: dn.title, kind: "Quick Action", trigger: t });
      }
      for (const t of dn.rowActions || []) {
        if (t.actionId === action.id)
          list.push({ nodeId: dn.id, nodeTitle: dn.title, kind: "Row Action", trigger: t });
      }
      for (const t of dn.bulkActions || []) {
        if (t.actionId === action.id)
          list.push({ nodeId: dn.id, nodeTitle: dn.title, kind: "Bulk Action", trigger: t });
      }
      for (const t of dn.nodeActions || []) {
        if (t.actionId === action.id)
          list.push({ nodeId: dn.id, nodeTitle: dn.title, kind: "Node Action", trigger: t });
      }
      if (dn.cellAction && dn.cellAction.actionId === action.id) {
        list.push({
          nodeId: dn.id,
          nodeTitle: dn.title,
          kind: "Cell Action",
          trigger: dn.cellAction,
        });
      }
    }
    return list;
  }, [dataNodes, action.id]);
  const [approvalModalOpen, setApprovalModalOpen] = useState(false);
  const [dangerConfirmInput, setDangerConfirmInput] = useState("");
  const [pendingRunner, setPendingRunner] = useState<{
    runner: "web_terminal" | "external_terminal";
    terminalApp?: "Terminal" | "iTerm";
  } | null>(null);
  const [fileSuggestions, setFileSuggestions] = useState<
    Record<string, Array<{ path: string; displayPath: string; type: string }>>
  >({});
  const [focusedFileField, setFocusedFileField] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/preview-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId,
        actionId: action.id,
        formValues,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          if (data.maskedCommand) {
            setPreviewCmd(data.maskedCommand);
            setPreviewCwd(data.cwd || activeWorkspace);
          }
          if (data.resolvedEnv) {
            setResolvedEnv(data.resolvedEnv);
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    skillId,
    action.id,
    formValues,
    activeWorkspace,
    uiEnvOverride,
    action.cwd,
    action.python,
    action.envFile,
    action.env,
  ]);

  const fetchAutocomplete = async (fieldKey: string, prefix: string, type: string) => {
    try {
      const cwdParam = encodeURIComponent(previewCwd || activeWorkspace);
      const res = await fetch(
        `/api/fs/complete?skillId=${encodeURIComponent(skillId)}&prefix=${encodeURIComponent(prefix)}&type=${encodeURIComponent(type)}&cwd=${cwdParam}`
      );
      const data = await res.json();
      setFileSuggestions((prev) => ({ ...prev, [fieldKey]: data.suggestions || [] }));
    } catch {
      // ignore
    }
  };

  const triggerRun = async (
    runner: "web_terminal" | "external_terminal",
    terminalApp?: "Terminal" | "iTerm"
  ) => {
    setErrorMsg(null);
    for (const f of action.form || []) {
      if (!isFieldVisible(f, formValues)) continue;
      const val = formValues[f.key];
      if (f.required && (val === undefined || val === null || val === "")) {
        setErrorMsg(`Please fill required field: ${f.label || f.key}`);
        return;
      }
    }

    if (action.danger === "danger" || action.danger === "warn" || action.requiresHumanApprovalFlag) {
      if (inAuditModal) {
        if (action.danger === "danger" && dangerConfirmInput.trim() !== action.id) {
          setErrorMsg(`Please type "${action.id}" in the confirmation box to unlock execution.`);
          return;
        }
        try {
          await onExecute({
            actionId: action.id,
            formValues,
            runner,
            terminalApp,
            humanApproved: true,
          });
          onExecuted?.();
        } catch (err: any) {
          setErrorMsg(err?.message || "Execution failed");
        }
        return;
      }
      setPendingRunner({ runner, terminalApp });
      setDangerConfirmInput("");
      setApprovalModalOpen(true);
      return;
    }

    try {
      await onExecute({
        actionId: action.id,
        formValues,
        runner,
        terminalApp,
        humanApproved: false,
      });
      onExecuted?.();
    } catch (err: any) {
      setErrorMsg(err?.message || "Execution failed");
    }
  };

  const confirmAndRun = async () => {
    if (!pendingRunner) return;
    if (action.danger === "danger" && dangerConfirmInput.trim() !== action.id) {
      return;
    }
    setApprovalModalOpen(false);
    try {
      await onExecute({
        actionId: action.id,
        formValues,
        runner: pendingRunner.runner,
        terminalApp: pendingRunner.terminalApp,
        humanApproved: true,
      });
      onExecuted?.();
    } catch (err: any) {
      setErrorMsg(err?.message || "Execution failed");
    }
  };

  const copyText = (text: string, mode: "cmd" | "prompt") => {
    navigator.clipboard.writeText(text);
    setCopiedMode(mode);
    setTimeout(() => setCopiedMode(null), 1800);
  };

  const isMultiLine = previewCmd.includes("\n");
  const buildClipboardCommand = () => {
    if (!isMultiLine) return previewCmd;
    return `(\nset -e\n${previewCmd}\n)`;
  };
  const visibleFields = (action.form || []).filter((f) => isFieldVisible(f, formValues));

  const isCustomEnv = Boolean(
    resolvedEnv?.isCustom ||
    uiEnvOverride ||
    (action.cwd && action.cwd !== "project_root") ||
    action.python ||
    action.envFile ||
    (action.env && Object.keys(action.env).length > 0)
  );
  const customBadgeText = resolvedEnv?.badgeText || (isCustomEnv ? "Custom Env" : "Env");

  return (
    <div
      data-sd-pick-kind="action"
      data-sd-pick-id={action.id}
      data-sd-pick-title={action.title}
      className="st-card rounded-2xl p-5 flex flex-col gap-4 transition-all"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            {action.subgroup && (
              <span className="px-2 py-0.5 rounded-md text-xs font-medium st-pill">
                {action.subgroup}
              </span>
            )}
            <h4 className="text-base font-bold st-text-primary">{action.title}</h4>
            {action.interactive && (
              <span className="px-2 py-0.5 rounded-md text-xs font-medium bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 border border-indigo-500/30">
                Interactive TUI
              </span>
            )}
            {action.danger === "warn" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                <AlertTriangle className="w-3.5 h-3.5" />
                Approval Gate
              </span>
            )}
            {action.danger === "danger" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30">
                <ShieldAlert className="w-3.5 h-3.5" />
                Destructive / Prod
              </span>
            )}
          </div>
          {action.description && (
            <p className="text-[13.5px] st-text-secondary mt-1.5 leading-relaxed">
              {action.description}
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={() => setInspectOpen((prev) => !prev)}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-semibold transition-all border shrink-0 ${
            inspectOpen
              ? "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40 shadow-sm"
              : "st-btn-secondary border-transparent"
          }`}
          title="White-box inspect Action template, provenance, form & DataNode bindings"
        >
          <Eye className="w-3.5 h-3.5 text-sky-500" />
          <span>Inspect</span>
        </button>
      </div>

      {/* White-Box Action Inspector Panel (Template & Provenance / Form & Data Bindings / Raw Declaration) */}
      {inspectOpen && (
        <div className="st-subcard rounded-xl border border-sky-500/30 p-3.5 flex flex-col gap-3 text-xs">
          <div className="flex items-center justify-between gap-2 flex-wrap border-b st-border pb-2">
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => setInspectTab("template")}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                  inspectTab === "template" ? "bg-sky-600 text-white" : "st-btn-secondary"
                }`}
              >
                <Code2 className="w-3.5 h-3.5" />
                <span>Template & Provenance</span>
              </button>
              <button
                type="button"
                onClick={() => setInspectTab("bindings")}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                  inspectTab === "bindings" ? "bg-sky-600 text-white" : "st-btn-secondary"
                }`}
              >
                <Database className="w-3.5 h-3.5" />
                <span>
                  Form & Data Bindings ({(action.form?.length || 0) + upstreamBoundTriggers.length})
                </span>
              </button>
              <button
                type="button"
                onClick={() => setInspectTab("raw")}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg font-semibold transition-colors ${
                  inspectTab === "raw" ? "bg-sky-600 text-white" : "st-btn-secondary"
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                <span>Raw Declaration</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setInspectOpen(false)}
              className="p-1 rounded-lg st-btn-secondary"
              title="Close Action Inspector"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {inspectTab === "template" && (
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-1.5 flex-wrap font-mono text-[11px]">
                <span className="px-2 py-0.5 rounded st-pill">id: {action.id}</span>
                {actionProvenance && (
                  <span className="px-2 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30">
                    source: {actionProvenance}
                  </span>
                )}
                <span className="px-2 py-0.5 rounded st-pill">
                  danger: {action.danger || "safe"}
                </span>
                <span className="px-2 py-0.5 rounded st-pill">
                  cwd: {action.cwd || "project_root"}
                </span>
                {action.output?.intoData && (
                  <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                    intoData ➔ {action.output.intoData}
                  </span>
                )}
              </div>
              <div className="st-code-surface rounded-xl border st-border p-3 font-mono text-xs overflow-x-auto">
                <div className="text-[10.5px] st-text-muted mb-1">
                  Raw YAML {action.script ? "Multi-Line Script (`script: |`)" : "Command Template (`command`)"}:
                </div>
                <pre className="whitespace-pre-wrap break-all select-all leading-relaxed">
                  {action.script || action.command}
                </pre>
              </div>
            </div>
          )}

          {inspectTab === "bindings" && (
            <div className="flex flex-col gap-3">
              <div>
                <div className="text-[11px] font-bold st-text-primary mb-1.5">
                  Form Fields ({action.form?.length || 0})
                </div>
                {action.form && action.form.length > 0 ? (
                  <div className="overflow-x-auto rounded-lg border st-border">
                    <table className="w-full text-left border-collapse text-[11.5px]">
                      <thead>
                        <tr className="border-b st-border st-surface-muted st-text-muted">
                          <th className="py-1.5 px-2.5">Key</th>
                          <th className="py-1.5 px-2.5">Type</th>
                          <th className="py-1.5 px-2.5">Flag / Positional</th>
                          <th className="py-1.5 px-2.5">Default</th>
                          <th className="py-1.5 px-2.5">Data Source (`fromData`)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y st-border font-mono">
                        {action.form.map((f) => (
                          <tr key={f.key}>
                            <td className="py-1.5 px-2.5 font-bold text-sky-600 dark:text-sky-400">
                              {f.key}
                              {f.required ? " *" : ""}
                            </td>
                            <td className="py-1.5 px-2.5">{f.type}</td>
                            <td className="py-1.5 px-2.5">
                              {f.positional ? "positional" : f.flag || `--${f.key}`}
                            </td>
                            <td className="py-1.5 px-2.5">
                              {f.default !== undefined ? String(f.default) : "—"}
                            </td>
                            <td className="py-1.5 px-2.5">
                              {f.fromData ? (
                                <span className="px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-700 dark:text-indigo-300">
                                  data:{f.fromData}
                                </span>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-xs st-text-muted italic">No form parameters declared.</div>
                )}
              </div>

              <div>
                <div className="text-[11px] font-bold st-text-primary mb-1.5">
                  Upstream DataNode Bound Triggers ({upstreamBoundTriggers.length})
                </div>
                {upstreamBoundTriggers.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {upstreamBoundTriggers.map((ub, i) => (
                      <div
                        key={i}
                        className="px-2.5 py-1.5 rounded-lg st-code-surface border st-border flex items-center justify-between gap-2 flex-wrap font-mono text-[11px]"
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-300 font-semibold">
                            data:{ub.nodeId}
                          </span>
                          <span className="st-text-muted">({ub.kind})</span>
                          <span className="font-bold st-text-primary">"{ub.trigger.label}"</span>
                        </div>
                        <code className="st-text-secondary">
                          args: {JSON.stringify(ub.trigger.args || {})}
                        </code>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs st-text-muted italic">
                    No DataNode triggers reference this action.
                  </div>
                )}
              </div>
            </div>
          )}

          {inspectTab === "raw" && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] st-text-muted font-mono">
                  Normalized ActionItem Declaration (JSON):
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(action, null, 2));
                    setCopiedInspect(true);
                    setTimeout(() => setCopiedInspect(false), 1500);
                  }}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded st-btn-secondary font-semibold"
                >
                  {copiedInspect ? (
                    <Check className="w-3 h-3 text-emerald-500" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>{copiedInspect ? "Copied" : "Copy Declaration"}</span>
                </button>
              </div>
              <pre className="st-code-surface rounded-xl border st-border p-3 font-mono text-[11px] max-h-56 overflow-y-auto whitespace-pre-wrap break-all">
                {JSON.stringify(action, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Declarative Action Precondition Guards Banner */}
      {evaluatedPreconditions.length > 0 && (
        <div className="flex flex-col gap-2">
          {failedPreconditions.map(({ pre, actualSummary }, idx) => (
            <div
              key={idx}
              className="px-3.5 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/35 text-xs flex items-center justify-between gap-3 flex-wrap"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <div className="flex flex-col gap-0.5">
                  <span className="font-bold text-amber-700 dark:text-amber-300">
                    Precondition Warning: {pre.message}
                  </span>
                  <span className="font-mono text-[11px] st-text-secondary">
                    Source: <code>data:{pre.dataNodeId}{pre.field ? `.${pre.field}` : ""}</code> · Current: <code>{actualSummary}</code>
                  </span>
                </div>
              </div>
              {pre.fixActionId && (
                <button
                  type="button"
                  onClick={() => {
                    if (onTriggerFixAction) {
                      onTriggerFixAction(pre.fixActionId!);
                    } else {
                      onExecute({
                        actionId: pre.fixActionId!,
                        formValues: {},
                        runner: "web_terminal",
                      });
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-semibold shrink-0 shadow-sm"
                >
                  <Play className="w-3 h-3 fill-current" />
                  <span>Fix via {pre.fixActionId}</span>
                </button>
              )}
            </div>
          ))}
          {failedPreconditions.length === 0 && (
            <div className="px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-[11px] font-mono text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
              <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              <span>
                Preconditions Verified ({evaluatedPreconditions.length}):{" "}
                {evaluatedPreconditions
                  .map(
                    ({ pre, actualSummary }) =>
                      `${pre.dataNodeId}${pre.field ? `.${pre.field}` : ""}=${actualSummary}`
                  )
                  .join(", ")}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Dynamic Form Fields */}
      {visibleFields.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 pt-3 border-t st-border">
          {visibleFields.map((field) => {
            const val = formValues[field.key];
            const dsOpts = dynamicOptions[field.key];
            const mergedOptions = dsOpts && dsOpts.length > 0 ? dsOpts : field.options || [];

            if (field.type === "boolean") {
              return (
                <label
                  key={field.key}
                  className="flex items-center gap-3 p-2.5 rounded-xl st-subcard cursor-pointer select-none"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(val)}
                    onChange={(e) =>
                      setFormValues((prev) => ({ ...prev, [field.key]: e.target.checked }))
                    }
                    className="w-4 h-4 rounded accent-sky-600"
                  />
                  <div className="flex flex-col">
                    <span className="text-[13px] font-semibold st-text-primary">{field.label}</span>
                    {field.flag && (
                      <span className="text-xs font-mono st-text-muted">{field.flag}</span>
                    )}
                  </div>
                </label>
              );
            }

            if (field.type === "select" || Boolean(field.fromData)) {
              const isDataBacked = Boolean(field.fromData);
              return (
                <div key={field.key} className="flex flex-col gap-1.5">
                  <label className="text-[13px] font-semibold st-text-primary flex items-center justify-between">
                    <span>
                      {field.label}
                      {field.required && <span className="text-rose-500 ml-1">*</span>}
                    </span>
                    <div className="flex items-center gap-1.5">
                      {field.flag && (
                        <span className="text-xs font-mono st-text-muted">{field.flag}</span>
                      )}
                      {isDataBacked && (
                        <button
                          type="button"
                          onClick={() => fetchFieldDataNode(field, true)}
                          className="p-0.5 rounded hover:st-surface-muted st-text-muted hover:st-text-primary"
                          title={`Refresh options from data node "${field.fromData}"`}
                        >
                          <RefreshCw
                            className={`w-3 h-3 ${
                              loadingDs[field.key] ? "animate-spin text-sky-500" : ""
                            }`}
                          />
                        </button>
                      )}
                    </div>
                  </label>

                  {mergedOptions.length > 0 ? (
                    <div className="flex gap-1.5">
                      <select
                        value={String(val ?? "")}
                        onChange={(e) =>
                          setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                        className="flex-1 px-3 py-2 rounded-xl st-input text-[13px] font-mono focus:outline-none focus:border-sky-500 min-w-0"
                      >
                        {!field.required && <option value="">-- Optional --</option>}
                        {Boolean(val) &&
                          !mergedOptions.some((o) => o.value === String(val)) && (
                            <option value={String(val)}>{String(val)} (custom)</option>
                          )}
                        {mergedOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      {isDataBacked && (
                        <input
                          type="text"
                          value={String(val ?? "")}
                          placeholder="Or type custom..."
                          onChange={(e) =>
                            setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                          }
                          className="w-36 px-2.5 py-2 rounded-xl st-input text-xs font-mono focus:outline-none focus:border-sky-500"
                          title="Or type a custom value"
                        />
                      )}
                    </div>
                  ) : (
                    /* Fallback to text input if dynamic dataSource returned 0 items */
                    <input
                      type="text"
                      value={String(val ?? "")}
                      placeholder={field.placeholder || "Enter value..."}
                      onChange={(e) =>
                        setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                      }
                      className="px-3 py-2 rounded-xl st-input text-[13px] font-mono focus:outline-none focus:border-sky-500"
                    />
                  )}
                </div>
              );
            }

            if (field.type === "file" || field.type === "directory") {
              const suggestions = fileSuggestions[field.key] || [];
              return (
                <div key={field.key} className="flex flex-col gap-1.5 relative">
                  <label className="text-[13px] font-semibold st-text-primary flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <FolderOpen className="w-4 h-4 text-sky-500" />
                      {field.label}
                      {field.required && <span className="text-rose-500">*</span>}
                    </span>
                    <span className="text-xs font-mono st-text-muted">{field.type}</span>
                  </label>
                  <input
                    type="text"
                    value={String(val ?? "")}
                    placeholder={field.placeholder || "Type path or click to browse..."}
                    onFocus={() => {
                      setFocusedFileField(field.key);
                      fetchAutocomplete(field.key, String(val ?? ""), field.type);
                    }}
                    onBlur={() => setTimeout(() => setFocusedFileField(null), 180)}
                    onChange={(e) => {
                      const next = e.target.value;
                      setFormValues((prev) => ({ ...prev, [field.key]: next }));
                      fetchAutocomplete(field.key, next, field.type);
                    }}
                    className="px-3 py-2 rounded-xl st-input text-[13px] font-mono focus:outline-none focus:border-sky-500"
                  />
                  {focusedFileField === field.key && suggestions.length > 0 && (
                    <div className="absolute top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto rounded-xl st-card shadow-2xl z-30 border st-border-strong">
                      {suggestions.map((s) => (
                        <button
                          key={s.path}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            setFormValues((prev) => ({ ...prev, [field.key]: s.path }));
                            if (s.type === "directory") {
                              fetchAutocomplete(field.key, s.path, field.type);
                            } else {
                              setFocusedFileField(null);
                            }
                          }}
                          className="w-full text-left px-3 py-2 text-xs font-mono hover:st-surface-muted flex items-center justify-between st-text-primary"
                        >
                          <span className="truncate">{s.path}</span>
                          <span className="text-[11px] st-text-muted ml-2">{s.type}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            }

            if (field.type === "code") {
              return (
                <div key={field.key} className="flex flex-col gap-1.5 md:col-span-2">
                  <label className="text-[13px] font-semibold st-text-primary">
                    {field.label}
                    {field.required && <span className="text-rose-500 ml-1">*</span>}
                  </label>
                  <textarea
                    rows={3}
                    value={String(val ?? "")}
                    placeholder={field.placeholder}
                    onChange={(e) =>
                      setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    className="px-3 py-2 rounded-xl st-input text-[13px] font-mono focus:outline-none focus:border-sky-500"
                  />
                </div>
              );
            }

            return (
              <div key={field.key} className="flex flex-col gap-1.5">
                <label className="text-[13px] font-semibold st-text-primary flex items-center justify-between">
                  <span>
                    {field.label}
                    {field.required && <span className="text-rose-500 ml-1">*</span>}
                  </span>
                  {field.flag && (
                    <span className="text-xs font-mono st-text-muted">{field.flag}</span>
                  )}
                </label>
                <input
                  type={
                    field.type === "env-secret"
                      ? "password"
                      : field.type === "number"
                        ? "number"
                        : field.type === "date"
                          ? "date"
                          : "text"
                  }
                  value={String(val ?? "")}
                  placeholder={field.placeholder}
                  onChange={(e) =>
                    setFormValues((prev) => ({
                      ...prev,
                      [field.key]:
                        field.type === "number" && e.target.value !== ""
                          ? Number(e.target.value)
                          : e.target.value,
                    }))
                  }
                  className="px-3 py-2 rounded-xl st-input text-[13px] font-mono focus:outline-none focus:border-sky-500"
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Live Highlighted Command / Inline Script Preview Bar */}
      <div className="px-3.5 py-2.5 rounded-xl st-code-surface border st-border flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="text-[11px] font-mono st-text-muted mb-1.5 flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <span>
                {isMultiLine
                  ? "Live Workspace-Resolved Inline Script (subshell · set -e)"
                  : "Live Workspace-Resolved Command"}
              </span>
              <span className="text-[10.5px] px-1.5 py-0.5 rounded st-pill font-mono">
                cwd: {previewCwd.split("/").slice(-2).join("/")}
              </span>
              {resolvedEnv?.venvDir ? (
                <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 font-mono">
                  python: .venv
                </span>
              ) : resolvedEnv?.python && resolvedEnv.python !== "python3" ? (
                <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 font-mono">
                  python: {resolvedEnv.python.split("/").slice(-2).join("/")}
                </span>
              ) : null}
              {resolvedEnv?.customEnvKeys && resolvedEnv.customEnvKeys.length > 0 && (
                <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/30 font-mono">
                  +{resolvedEnv.customEnvKeys.length} env
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setEnvPanelOpen((prev) => !prev)}
              className={`px-2 py-0.5 rounded-lg text-[10.5px] font-semibold transition-all border shrink-0 ${
                isCustomEnv
                  ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/40"
                  : "st-btn-secondary border-transparent"
              }`}
              title={`cwd: ${previewCwd}, python: ${resolvedEnv?.python || "auto"}`}
            >
              ⚙️ {customBadgeText}
            </button>
          </div>
          {isMultiLine ? (
            <pre
              className="text-[12.5px] font-mono leading-relaxed select-all overflow-x-auto"
              dangerouslySetInnerHTML={{
                __html: highlightCodeToHtml(previewCmd, "bash", true),
              }}
            />
          ) : (
            <code
              className="text-[12.5px] font-mono break-all select-all"
              dangerouslySetInnerHTML={{
                __html: "$ " + highlightCodeToHtml(previewCmd, "bash", false),
              }}
            />
          )}
        </div>
        <button
          type="button"
          onClick={() => copyText(buildClipboardCommand(), "cmd")}
          className="p-1.5 st-btn-secondary rounded-lg shrink-0"
          title={
            isMultiLine
              ? "Copy as subshell-wrapped script (set -e safe for interactive terminals)"
              : "Copy CLI command"
          }
        >
          {copiedMode === "cmd" ? (
            <Check className="w-4 h-4 text-emerald-500" />
          ) : (
            <Copy className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Inline Command Execution Environment Editor (attached directly below the Command Preview Box) */}
      {envPanelOpen && (
        <CommandEnvEditor
          skillId={skillId}
          targetKind="action"
          targetId={action.id}
          targetTitle={action.title}
          defaultWorkspace={activeWorkspace}
          initialConfig={{
            cwd: action.cwd,
            python: action.python,
            envFile: action.envFile,
            env: action.env,
            ...uiEnvOverride,
          }}
          resolvedSummary={resolvedEnv}
          onSaved={(result) => {
            if (result.skill) {
              onSkillUpdated?.(result.skill);
            }
          }}
          onClose={() => setEnvPanelOpen(false)}
        />
      )}

      {inAuditModal && (action.danger === "danger" || action.requiresHumanApprovalFlag) && (
        <div className="px-3.5 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex flex-col gap-2 text-xs">
          {action.requiresHumanApprovalFlag && (
            <div className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              <span>
                Human Approval Gate: clicking Run will inject{" "}
                <code className="font-mono font-bold">{action.requiresHumanApprovalFlag}</code>.
              </span>
            </div>
          )}
          {action.danger === "danger" && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-rose-600 dark:text-rose-300 font-semibold">
                Destructive Gate — type <code className="font-mono font-bold">{action.id}</code> to unlock:
              </span>
              <input
                type="text"
                value={dangerConfirmInput}
                onChange={(e) => setDangerConfirmInput(e.target.value)}
                placeholder={action.id}
                className="px-2.5 py-1 rounded-lg st-input text-xs font-mono w-48"
              />
            </div>
          )}
        </div>
      )}

      {errorMsg && (
        <div className="px-3.5 py-2 rounded-lg bg-rose-500/15 border border-rose-500/30 text-xs text-rose-500 font-medium">
          {errorMsg}
        </div>
      )}

      {/* Execution Action Buttons */}
      <div className="flex items-center justify-between gap-2.5 pt-1 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => triggerRun("web_terminal")}
            className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-semibold text-white shadow-sm transition-colors ${
              action.danger === "danger"
                ? "bg-rose-600 hover:bg-rose-500"
                : action.danger === "warn"
                  ? "bg-amber-600 hover:bg-amber-500"
                  : "bg-sky-600 hover:bg-sky-500"
            }`}
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>
              {action.interactive
                ? "Launch Interactive TUI"
                : inAuditModal && (action.danger === "warn" || action.danger === "danger" || action.requiresHumanApprovalFlag)
                  ? "Approve & Run in Web Terminal"
                  : inAuditModal
                    ? "Run in Web Terminal"
                    : "Run in Web PTY"}
            </span>
          </button>

          <button
            type="button"
            onClick={() => triggerRun("external_terminal", "Terminal")}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium st-btn-secondary"
            title="Launch in macOS Terminal.app"
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Terminal.app</span>
          </button>

          <button
            type="button"
            onClick={() => triggerRun("external_terminal", "iTerm")}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium st-btn-secondary"
            title="Launch in macOS iTerm2"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>iTerm2</span>
          </button>
        </div>

        <button
          type="button"
          onClick={() =>
            copyText(
              `/${skillId} Please execute "${action.title}": \`${previewCmd}\``,
              "prompt"
            )
          }
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium st-badge-accent hover:opacity-90 transition-opacity"
          title="Copy formatted prompt for Claude Code / Codex"
        >
          {copiedMode === "prompt" ? (
            <Check className="w-3.5 h-3.5 text-emerald-500" />
          ) : (
            <Sparkles className="w-3.5 h-3.5" />
          )}
          <span>{copiedMode === "prompt" ? "Prompt Copied!" : "Copy Agent Prompt"}</span>
        </button>
      </div>

      {/* Human Approval Gate Modal */}
      {approvalModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full rounded-2xl st-card p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center gap-2.5 text-amber-500">
              <ShieldAlert className="w-5 h-5 shrink-0" />
              <h3 className="text-base font-bold st-text-primary">
                Human Approval Gate ({action.danger.toUpperCase()})
              </h3>
            </div>
            <p className="text-xs st-text-secondary leading-relaxed">
              You are about to execute <strong>{action.title}</strong> in workspace{" "}
              <code className="font-mono text-sky-600 dark:text-sky-400">{previewCwd}</code>:
            </p>
            <div className="p-3 rounded-xl st-code-surface border st-border font-mono text-xs break-all whitespace-pre-wrap max-h-48 overflow-y-auto">
              {previewCmd}
            </div>
            {action.requiresHumanApprovalFlag && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                Confirming this gate will inject{" "}
                <code className="font-mono">{action.requiresHumanApprovalFlag}</code>.
              </p>
            )}
            {action.danger === "danger" && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs st-text-secondary">
                  Type <code className="text-rose-500 font-mono font-bold">{action.id}</code> to
                  unlock execution:
                </label>
                <input
                  type="text"
                  value={dangerConfirmInput}
                  onChange={(e) => setDangerConfirmInput(e.target.value)}
                  placeholder={action.id}
                  className="px-3 py-2 rounded-lg st-input text-xs font-mono"
                />
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setApprovalModalOpen(false)}
                className="px-3.5 py-1.5 rounded-lg text-xs st-btn-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={action.danger === "danger" && dangerConfirmInput.trim() !== action.id}
                onClick={confirmAndRun}
                className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white"
              >
                Approve & Execute
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
