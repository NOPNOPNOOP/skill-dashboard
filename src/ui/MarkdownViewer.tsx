import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Layout,
  Play,
  RefreshCw,
  Sliders,
  Terminal,
} from "lucide-react";
import { marked } from "marked";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { FormField, SkillView } from "../types.ts";
import { highlightCodeToHtml, splitMarkdownIntoSegments } from "./highlight.ts";

interface InlineExecutableCommandRowProps {
  skillId: string;
  rawCommand: string;
  commentHint?: string;
  activeWorkspace: string;
  onExecuteAdHoc: (params: {
    adHocCommand: string;
    adHocTitle: string;
    formValues: Record<string, unknown>;
    runner: "web_terminal" | "external_terminal";
    terminalApp?: "Terminal" | "iTerm";
    humanApproved?: boolean;
  }) => Promise<void>;
}

const InlineExecutableCommandRow: React.FC<InlineExecutableCommandRowProps> = ({
  skillId,
  rawCommand,
  commentHint,
  activeWorkspace,
  onExecuteAdHoc,
}) => {
  const [inferredForm, setInferredForm] = useState<FormField[]>([]);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [resolvedPreview, setResolvedPreview] = useState<string>(rawCommand);
  const [paramsExpanded, setParamsExpanded] = useState<boolean>(false);
  const [copied, setCopied] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // Initial fetch to infer form fields and initial preview
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preview-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId,
        adHocCommand: rawCommand,
        formValues: {},
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const fields: FormField[] = data.inferredForm || [];
        setInferredForm(fields);
        const initVals: Record<string, unknown> = {};
        let hasRequired = false;
        for (const f of fields) {
          if (f.default !== undefined) initVals[f.key] = f.default;
          else if (f.type === "boolean") initVals[f.key] = false;
          else initVals[f.key] = "";
          if (f.required && initVals[f.key] === "") hasRequired = true;
        }
        setFormValues(initVals);
        if (hasRequired) setParamsExpanded(true);
        if (data.maskedCommand) setResolvedPreview(data.maskedCommand);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [skillId, rawCommand, activeWorkspace]);

  // Update preview whenever formValues change
  useEffect(() => {
    if (inferredForm.length === 0) return;
    let cancelled = false;
    fetch("/api/preview-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId,
        adHocCommand: rawCommand,
        formValues,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.maskedCommand) {
          setResolvedPreview(data.maskedCommand);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [skillId, rawCommand, formValues, activeWorkspace]);

  const handleRun = async (
    runner: "web_terminal" | "external_terminal",
    terminalApp?: "Terminal" | "iTerm"
  ) => {
    setErrMsg(null);
    for (const f of inferredForm) {
      const v = formValues[f.key];
      if (f.required && (v === undefined || v === null || v === "")) {
        setParamsExpanded(true);
        setErrMsg(`Please fill required parameter: ${f.label || f.key}`);
        return;
      }
    }
    try {
      await onExecuteAdHoc({
        adHocCommand: rawCommand,
        adHocTitle: commentHint || rawCommand.slice(0, 56),
        formValues,
        runner,
        terminalApp,
        humanApproved: true,
      });
    } catch (err: any) {
      setErrMsg(err?.message || "Execution failed");
    }
  };

  return (
    <div className="st-subcard rounded-lg p-3 flex flex-col gap-2 transition-all">
      {/* Top Row: Comment Title + In-Place Execution Controls */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="px-1.5 py-0.5 rounded text-[11px] font-mono st-badge-accent shrink-0">
            bash
          </span>
          {commentHint && (
            <span className="text-xs font-semibold st-text-primary truncate">
              {commentHint}
            </span>
          )}
          {inferredForm.length > 0 && (
            <button
              type="button"
              onClick={() => setParamsExpanded(!paramsExpanded)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium st-pill hover:opacity-90"
            >
              <Sliders className="w-3 h-3" />
              <span>{inferredForm.length} params</span>
              {paramsExpanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
            </button>
          )}
        </div>

        {/* In-Place Execution Buttons */}
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          <button
            type="button"
            onClick={() => handleRun("web_terminal")}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white shadow-sm transition-colors"
            title="Execute in-place in Web PTY"
          >
            <Play className="w-3 h-3 fill-current" />
            <span>Run in PTY</span>
          </button>

          <button
            type="button"
            onClick={() => handleRun("external_terminal", "Terminal")}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium st-btn-secondary"
            title="Launch in macOS Terminal.app"
          >
            <Terminal className="w-3 h-3" />
            <span>Terminal</span>
          </button>

          <button
            type="button"
            onClick={() => handleRun("external_terminal", "iTerm")}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium st-btn-secondary"
            title="Launch in macOS iTerm2"
          >
            <ExternalLink className="w-3 h-3" />
            <span>iTerm2</span>
          </button>

          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(resolvedPreview);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium st-btn-secondary"
            title="Copy live workspace-resolved command"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </div>

      {/* Highlighted Original Synopsis */}
      <pre
        className="st-code-surface px-3 py-2 rounded-md text-[12.5px] font-mono overflow-x-auto leading-relaxed"
        dangerouslySetInnerHTML={{
          __html: highlightCodeToHtml(rawCommand, "bash", false),
        }}
      />

      {/* Inline Parameter Inputs (when command has <arg>, {a|b}, [--flag]) */}
      {inferredForm.length > 0 && paramsExpanded && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 pt-1.5 border-t st-border">
          {inferredForm.map((field) => {
            const val = formValues[field.key];
            if (field.type === "boolean") {
              return (
                <label
                  key={field.key}
                  className="flex items-center gap-2 px-2.5 py-1.5 rounded-md st-input cursor-pointer select-none text-xs"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(val)}
                    onChange={(e) =>
                      setFormValues((prev) => ({ ...prev, [field.key]: e.target.checked }))
                    }
                    className="w-3.5 h-3.5 accent-sky-600"
                  />
                  <span className="font-medium st-text-primary">{field.label}</span>
                </label>
              );
            }
            if (field.type === "select") {
              return (
                <div key={field.key} className="flex items-center gap-2 text-xs">
                  <span className="font-medium st-text-secondary shrink-0">
                    {field.label}
                    {field.required && <span className="text-rose-500">*</span>}:
                  </span>
                  <select
                    value={String(val ?? "")}
                    onChange={(e) =>
                      setFormValues((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    className="flex-1 px-2 py-1 rounded-md st-input text-xs font-mono"
                  >
                    {(field.options || []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            }
            return (
              <div key={field.key} className="flex items-center gap-2 text-xs">
                <span className="font-medium st-text-secondary shrink-0">
                  {field.label}
                  {field.required && <span className="text-rose-500">*</span>}:
                </span>
                <input
                  type={field.type === "number" ? "number" : "text"}
                  value={String(val ?? "")}
                  placeholder={field.placeholder || field.key}
                  onChange={(e) =>
                    setFormValues((prev) => ({
                      ...prev,
                      [field.key]:
                        field.type === "number" && e.target.value !== ""
                          ? Number(e.target.value)
                          : e.target.value,
                    }))
                  }
                  className="flex-1 px-2 py-1 rounded-md st-input text-xs font-mono min-w-0"
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Live Workspace-Resolved Command Footer */}
      {resolvedPreview !== rawCommand && (
        <div className="flex items-center gap-2 text-[11.5px] font-mono st-text-muted px-1">
          <span className="shrink-0 font-semibold text-sky-600 dark:text-sky-400">
            Live Resolved:
          </span>
          <code className="truncate select-all st-text-secondary" title={resolvedPreview}>
            $ {resolvedPreview}
          </code>
        </div>
      )}

      {errMsg && (
        <div className="px-2.5 py-1 rounded bg-rose-500/15 border border-rose-500/30 text-xs text-rose-500">
          {errMsg}
        </div>
      )}
    </div>
  );
};

interface MarkdownContentRendererProps {
  skillId: string;
  markdown: string;
  currentSource: string;
  activeWorkspace: string;
  showSummaryBar?: boolean;
  onNavigateRelativeMd?: (targetSource: string, title?: string) => void;
  onExecuteAdHoc: (params: {
    adHocCommand: string;
    adHocTitle: string;
    formValues?: Record<string, unknown>;
    runner: "web_terminal" | "external_terminal";
    terminalApp?: "Terminal" | "iTerm";
    humanApproved?: boolean;
  }) => Promise<void>;
}

export const MarkdownContentRenderer: React.FC<MarkdownContentRendererProps> = ({
  skillId,
  markdown,
  currentSource,
  activeWorkspace,
  showSummaryBar = true,
  onNavigateRelativeMd,
  onExecuteAdHoc,
}) => {
  const [summaryCollapsed, setSummaryCollapsed] = useState(true);
  const [copiedBlockIdx, setCopiedBlockIdx] = useState<number | null>(null);

  const segments = useMemo(() => splitMarkdownIntoSegments(markdown), [markdown]);

  const allRunnableCommands = useMemo(
    () =>
      segments.flatMap((seg) =>
        seg.type === "code" && seg.isExecutableShell ? seg.commands : []
      ),
    [segments]
  );

  const handleProseClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onNavigateRelativeMd) return;
    const target = (e.target as HTMLElement).closest("a");
    if (!target) return;
    const href = target.getAttribute("href");
    if (!href || href.startsWith("http://") || href.startsWith("https://") || href.startsWith("#")) {
      return;
    }
    if (href.endsWith(".md")) {
      e.preventDefault();
      const dirParts = currentSource.split("/").slice(0, -1);
      const relParts = href.replace(/^\.\//, "").split("/");
      const merged = [...dirParts];
      for (const p of relParts) {
        if (p === "..") merged.pop();
        else if (p !== ".") merged.push(p);
      }
      onNavigateRelativeMd(merged.join("/"), target.textContent || undefined);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Optional Collapsible Quick Summary Bar at Top */}
      {showSummaryBar && allRunnableCommands.length > 0 && (
        <div className="st-card rounded-xl p-3.5 flex flex-col gap-2.5">
          <button
            type="button"
            onClick={() => setSummaryCollapsed(!summaryCollapsed)}
            className="w-full flex items-center justify-between text-left"
          >
            <div className="flex items-center gap-2">
              {summaryCollapsed ? (
                <ChevronRight className="w-4 h-4 text-sky-500" />
              ) : (
                <ChevronDown className="w-4 h-4 text-sky-500" />
              )}
              <span className="text-xs font-bold st-text-primary">
                Quick Runbook Summary ({allRunnableCommands.length} executable commands in this doc)
              </span>
            </div>
            <span className="text-xs st-text-muted">
              {summaryCollapsed
                ? "Click to expand summary (all commands also have in-place controls below)"
                : "Click to collapse"}
            </span>
          </button>

          {!summaryCollapsed && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-2 border-t st-border max-h-56 overflow-y-auto">
              {allRunnableCommands.map((c, idx) => (
                <div
                  key={idx}
                  className="st-subcard px-3 py-2 rounded-lg flex items-center justify-between gap-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    {c.comment && (
                      <div className="font-semibold st-text-primary truncate">{c.comment}</div>
                    )}
                    <div className="font-mono text-[11.5px] st-text-secondary truncate">
                      {c.command}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      onExecuteAdHoc({
                        adHocCommand: c.command,
                        adHocTitle: c.comment || c.command.slice(0, 50),
                        runner: "web_terminal",
                        humanApproved: true,
                      })
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shrink-0"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    Run
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Main Interleaved Document Flow (Prose + In-Place Code Widgets) */}
      <div className="st-card rounded-2xl p-6 sm:p-8 flex flex-col gap-4">
        {segments.map((seg, idx) => {
          if (seg.type === "prose") {
            const html = marked.parse(seg.markdown, { async: false }) as string;
            return (
              <div
                key={idx}
                onClick={handleProseClick}
                className="markdown-body leading-relaxed"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          }

          // Code block segment: if it's an executable shell block, render In-Place Executable Widget!
          if (seg.isExecutableShell) {
            return (
              <div
                key={idx}
                className="my-2 rounded-xl border st-border overflow-hidden st-surface-muted p-3 flex flex-col gap-2.5"
              >
                <div className="flex items-center justify-between px-1">
                  <span className="text-xs font-semibold st-text-secondary flex items-center gap-1.5">
                    <Terminal className="w-3.5 h-3.5 text-sky-500" />
                    <span>
                      In-Place Executable Shell Block ({seg.commands.length}{" "}
                      {seg.commands.length === 1 ? "command" : "commands"})
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(seg.rawCode);
                      setCopiedBlockIdx(idx);
                      setTimeout(() => setCopiedBlockIdx(null), 1500);
                    }}
                    className="inline-flex items-center gap-1 text-xs st-text-muted hover:st-text-primary"
                  >
                    {copiedBlockIdx === idx ? (
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>Copy Full Block</span>
                  </button>
                </div>

                <div className="flex flex-col gap-2">
                  {seg.commands.map((cmdItem, cIdx) => (
                    <InlineExecutableCommandRow
                      key={cIdx}
                      skillId={skillId}
                      rawCommand={cmdItem.command}
                      commentHint={cmdItem.comment}
                      activeWorkspace={activeWorkspace}
                      onExecuteAdHoc={(p) => onExecuteAdHoc(p)}
                    />
                  ))}
                </div>
              </div>
            );
          }

          // Non-shell code block (Python, TypeScript, JSON, YAML, SQL, etc.): Syntax Highlighted with Line Numbers
          const highlightedHtml = highlightCodeToHtml(seg.rawCode, seg.lang, true);
          return (
            <div key={idx} className="my-2 rounded-xl border st-border overflow-hidden">
              <div className="px-3.5 py-1.5 st-surface-muted border-b st-border flex items-center justify-between text-xs">
                <span className="font-mono font-semibold st-text-secondary uppercase">
                  {seg.lang || "code"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(seg.rawCode);
                    setCopiedBlockIdx(idx);
                    setTimeout(() => setCopiedBlockIdx(null), 1500);
                  }}
                  className="inline-flex items-center gap-1 st-text-muted hover:st-text-primary"
                >
                  {copiedBlockIdx === idx ? (
                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  <span>{copiedBlockIdx === idx ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <pre
                className="st-code-surface p-3.5 text-[13px] font-mono overflow-x-auto leading-relaxed"
                dangerouslySetInnerHTML={{ __html: highlightedHtml }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

interface MarkdownViewerProps {
  skillId: string;
  skillName: string;
  views: SkillView[];
  initialViewId?: string | null;
  activeWorkspace: string;
  pythonExecutable: string;
  configuredEnv: Record<string, string>;
  theme: "light" | "dark";
  refreshTrigger: number;
  onContextChanged?: () => void;
  onExecuteActionById: (params: {
    actionId: string;
    formValues: Record<string, unknown>;
    runner: "web_terminal" | "external_terminal";
    humanApproved?: boolean;
  }) => Promise<void>;
  onPrefillActionJump: (actionId: string, formValues: Record<string, unknown>) => void;
  onExecuteAdHoc: (params: {
    adHocCommand: string;
    adHocTitle: string;
    formValues?: Record<string, unknown>;
    runner: "web_terminal" | "external_terminal";
    terminalApp?: "Terminal" | "iTerm";
    humanApproved?: boolean;
  }) => Promise<void>;
}

export const MarkdownViewer: React.FC<MarkdownViewerProps> = ({
  skillId,
  skillName,
  views,
  initialViewId,
  activeWorkspace,
  pythonExecutable,
  configuredEnv,
  theme,
  refreshTrigger,
  onContextChanged,
  onExecuteActionById,
  onPrefillActionJump,
  onExecuteAdHoc,
}) => {
  const [history, setHistory] = useState<
    Array<{ viewId?: string; source?: string; title: string; type?: string }>
  >(() => {
    const targetView =
      (initialViewId ? views.find((v) => v.id === initialViewId) : undefined) || views[0];
    return targetView
      ? [
          {
            viewId: targetView.id,
            source: targetView.source,
            title: targetView.title,
            type: targetView.type,
          },
        ]
      : [{ source: "SKILL.md", title: "SKILL.md", type: "markdown" }];
  });
  const [historyIdx, setHistoryIdx] = useState(0);
  const [content, setContent] = useState<string>("");
  const [currentSource, setCurrentSource] = useState<string>("SKILL.md");
  const [currentType, setCurrentType] = useState<string>("markdown");
  const [loading, setLoading] = useState(false);
  const [iframeReloadSeq, setIframeReloadSeq] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const targetView =
      (initialViewId ? views.find((v) => v.id === initialViewId) : undefined) || views[0];
    const initial = targetView
      ? {
          viewId: targetView.id,
          source: targetView.source,
          title: targetView.title,
          type: targetView.type,
        }
      : { source: "SKILL.md", title: "SKILL.md", type: "markdown" };
    setHistory([initial]);
    setHistoryIdx(0);
  }, [skillId, initialViewId]);

  const currentItem = history[historyIdx] || {
    source: "SKILL.md",
    title: "SKILL.md",
    type: "markdown",
  };

  useEffect(() => {
    const matchingView = currentItem.viewId
      ? views.find((v) => v.id === currentItem.viewId)
      : views.find((v) => v.source === currentItem.source);

    const viewType =
      matchingView?.type ||
      currentItem.type ||
      (currentItem.source?.endsWith(".html") ? "html" : "markdown");
    const relSource = (matchingView?.source || currentItem.source || "SKILL.md").replace(
      /^\.\//,
      ""
    );

    setCurrentType(viewType);
    setCurrentSource(relSource);

    if (viewType === "html") {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const qs = currentItem.viewId
      ? `viewId=${encodeURIComponent(currentItem.viewId)}`
      : `source=${encodeURIComponent(relSource)}`;

    fetch(`/api/skills/${encodeURIComponent(skillId)}/views?${qs}`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setContent(data.content || data.error || "");
          setCurrentSource(data.source || relSource);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skillId, currentItem.viewId, currentItem.source, currentItem.type]);

  // Broadcast themeChanged & workspaceChanged & runCompleted events to HTML App iframe
  useEffect(() => {
    if (currentType !== "html" || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      { type: "sd:event", event: "themeChanged", payload: { theme } },
      "*"
    );
  }, [theme, currentType]);

  useEffect(() => {
    if (currentType !== "html" || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      {
        type: "sd:event",
        event: "workspaceChanged",
        payload: { effectiveWorkspace: activeWorkspace, pythonExecutable },
      },
      "*"
    );
  }, [activeWorkspace, pythonExecutable, currentType]);

  useEffect(() => {
    if (refreshTrigger <= 0 || currentType !== "html" || !iframeRef.current?.contentWindow) return;
    iframeRef.current.contentWindow.postMessage(
      { type: "sd:event", event: "runCompleted", payload: { refreshTrigger } },
      "*"
    );
  }, [refreshTrigger, currentType]);

  // Handle window.SkillDashboard RPC messages from Custom HTML App View
  useEffect(() => {
    if (currentType !== "html") return;
    const onMessage = async (ev: MessageEvent) => {
      if (iframeRef.current?.contentWindow && ev.source !== iframeRef.current.contentWindow) {
        return;
      }
      const msg = ev.data;
      if (!msg || typeof msg !== "object" || msg.type !== "sd:rpc-request") return;
      const { id, method, payload } = msg;
      const reply = (result?: unknown, error?: string) => {
        iframeRef.current?.contentWindow?.postMessage(
          { type: "sd:rpc-response", id, result, error },
          "*"
        );
      };

      try {
        if (method === "getContext") {
          const ctxRes = await fetch(`/api/skills/${encodeURIComponent(skillId)}/context`);
          const ctxBody = ctxRes.ok ? await ctxRes.json() : { context: {}, fields: [] };
          reply({
            skillId,
            skillName,
            effectiveWorkspace: activeWorkspace,
            pythonExecutable,
            configuredEnv,
            theme,
            context: ctxBody.context || {},
            contextFields: ctxBody.fields || [],
          });
        } else if (method === "setContext") {
          const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}/context`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: payload.key, value: payload.value }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "setContext failed");
          iframeRef.current?.contentWindow?.postMessage(
            { type: "sd:event", event: "dataUpdated", payload: data },
            "*"
          );
          onContextChanged?.();
          reply(data);
        } else if (method === "getData") {
          const force = Boolean(payload?.force);
          const nodeId = payload?.nodeId;
          const res = await fetch(
            `/api/skills/${encodeURIComponent(skillId)}/data/${encodeURIComponent(nodeId)}${
              force ? "?force=1" : ""
            }`
          );
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Data node failed");
          reply(data);
        } else if (method === "runAction") {
          await onExecuteActionById({
            actionId: payload.actionId,
            formValues: payload.formValues || {},
            runner: "web_terminal",
            humanApproved: Boolean(payload.options?.humanApproved),
          });
          reply({ ok: true });
        } else if (method === "prefillAction") {
          onPrefillActionJump(payload.actionId, payload.formValues || {});
          reply({ ok: true });
        } else if (method === "runInTerminal") {
          await onExecuteAdHoc({
            adHocCommand: payload.command,
            adHocTitle: payload.title || "HTML App Command",
            runner: "web_terminal",
            humanApproved: true,
          });
          reply({ ok: true });
        } else if (method === "submitDecision") {
          const decRes = await fetch(`/api/units/${encodeURIComponent(skillId)}/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              eventType: "decision_submitted",
              payload: payload?.payload || payload || {},
            }),
          });
          const decBody = await decRes.json();
          if (!decRes.ok) throw new Error(decBody.error || "submitDecision failed");
          reply(decBody);
        } else {
          reply(undefined, `Unknown SkillDashboard method: ${method}`);
        }
      } catch (err: any) {
        reply(undefined, err?.message || "RPC failed");
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    currentType,
    skillId,
    skillName,
    activeWorkspace,
    pythonExecutable,
    configuredEnv,
    theme,
  ]);

  const navigateToSource = (source: string, title?: string, type?: string) => {
    const matchingView = views.find((v) => v.source === source || v.source === `./${source}`);
    const nextEntry = matchingView
      ? {
          viewId: matchingView.id,
          source: matchingView.source,
          title: matchingView.title,
          type: matchingView.type,
        }
      : {
          source,
          title: title || source.split("/").pop() || source,
          type: type || (source.endsWith(".html") ? "html" : "markdown"),
        };
    const nextHist = [...history.slice(0, historyIdx + 1), nextEntry];
    setHistory(nextHist);
    setHistoryIdx(nextHist.length - 1);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* View Switcher Pills + Breadcrumb Back */}
      <div className="flex items-center justify-between gap-2 flex-wrap border-b st-border pb-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          {historyIdx > 0 && (
            <button
              onClick={() => setHistoryIdx(historyIdx - 1)}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold st-btn-secondary mr-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back
            </button>
          )}
          {views.map((v) => {
            const active =
              currentItem.viewId === v.id ||
              currentSource === v.source.replace(/^\.\//, "");
            const isHtml = v.type === "html" || v.source.endsWith(".html");
            return (
              <button
                key={v.id}
                data-sd-pick-kind="view"
                data-sd-pick-id={v.id}
                data-sd-pick-title={`View: ${v.title}`}
                onClick={() => navigateToSource(v.source, v.title, v.type)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  active
                    ? "bg-sky-600 text-white shadow-sm"
                    : "st-btn-secondary"
                }`}
              >
                {isHtml ? (
                  <Layout className="w-3.5 h-3.5" />
                ) : (
                  <BookOpen className="w-3.5 h-3.5" />
                )}
                <span>{v.title}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {currentType === "html" && (
            <>
              <button
                type="button"
                onClick={() => setIframeReloadSeq((s) => s + 1)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs st-btn-secondary"
                title="Reload Custom HTML App View"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Reload App</span>
              </button>
              <a
                href={`/skill-app/${encodeURIComponent(skillId)}/${currentSource}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs st-btn-secondary"
                title="Open in new browser tab"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Pop Out</span>
              </a>
            </>
          )}
          <span className="text-xs font-mono st-text-muted flex items-center gap-1">
            <FileText className="w-3.5 h-3.5" />
            {currentSource}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center st-text-muted text-sm">Loading document...</div>
      ) : currentType === "html" ? (
        <div className="st-card rounded-2xl overflow-hidden border st-border">
          <iframe
            key={`${skillId}:${currentSource}:${iframeReloadSeq}`}
            ref={iframeRef}
            src={`/skill-app/${encodeURIComponent(skillId)}/${currentSource}`}
            title={currentItem.title}
            onLoad={() => {
              iframeRef.current?.contentWindow?.postMessage(
                { type: "sd:event", event: "themeChanged", payload: { theme } },
                "*"
              );
            }}
            className="w-full h-[680px] border-0 bg-transparent"
          />
        </div>
      ) : (
        <MarkdownContentRenderer
          skillId={skillId}
          markdown={content}
          currentSource={currentSource}
          activeWorkspace={activeWorkspace}
          showSummaryBar={true}
          onNavigateRelativeMd={(src, title) => navigateToSource(src, title, "markdown")}
          onExecuteAdHoc={onExecuteAdHoc}
        />
      )}
    </div>
  );
};
