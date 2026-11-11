import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  GripHorizontal,
  Maximize2,
  Minimize2,
  Plus,
  Square,
  Terminal as TerminalIcon,
  X,
  XCircle,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import type { ExecutionRun, RunArtifact, RunStatus } from "../types.ts";

interface TerminalDrawerProps {
  runs: ExecutionRun[];
  activeRunId: string | null;
  onSelectRun: (runId: string) => void;
  onStopRun: (runId: string) => Promise<void>;
  onCloseRun: (runId: string) => Promise<void>;
  onStartInteractiveShell: () => Promise<void>;
  keepShellOpen: boolean;
  onToggleKeepShellOpen: (val: boolean) => void;
  onRunStatusChange: (
    runId: string,
    status: RunStatus,
    exitCode: number | null,
    artifacts: Array<string | RunArtifact>,
    artifactItems?: RunArtifact[]
  ) => void;
  isOpen: boolean;
  onToggleOpen: () => void;
}

export const TerminalDrawer: React.FC<TerminalDrawerProps> = ({
  runs,
  activeRunId,
  onSelectRun,
  onStopRun,
  onCloseRun,
  onStartInteractiveShell,
  keepShellOpen,
  onToggleKeepShellOpen,
  onRunStatusChange,
  isOpen,
  onToggleOpen,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem("skill_dashboard_pty_height"));
      if (Number.isFinite(saved) && saved >= 160 && saved <= 900) return saved;
    } catch {
      // ignore
    }
    return 340;
  });
  const [isDragging, setIsDragging] = useState(false);

  const termContainerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const activeRun = runs.find((r) => r.id === activeRunId) || runs[0] || null;
  const runningCount = runs.filter((r) => r.status === "running").length;

  // Handle Drag-to-Resize on Top Edge of PTY Drawer
  const startResizeDrag = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!isOpen) onToggleOpen();
    setIsMaximized(false);
    setIsDragging(true);

    const startY = e.clientY;
    const startHeight = drawerHeight;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY;
      const maxAllowed = Math.floor(window.innerHeight * 0.88);
      const nextHeight = Math.max(150, Math.min(maxAllowed, startHeight + deltaY));
      setDrawerHeight(nextHeight);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      try {
        localStorage.setItem("skill_dashboard_pty_height", String(drawerHeight));
      } catch {
        // ignore
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  useEffect(() => {
    if (!isOpen || !activeRun || !termContainerRef.current) return;

    const containerEl = termContainerRef.current;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      convertEol: false,
      theme: {
        background: "#12151c",
        foreground: "#e5e9f0",
        cursor: "#38bdf8",
        selectionBackground: "#2c3548",
        black: "#151922",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#f1f5f9",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    containerEl.innerHTML = "";
    term.open(containerEl);

    const viewport = containerEl.querySelector(".xterm-viewport") as HTMLElement | null;
    if (viewport) {
      viewport.style.overscrollBehavior = "contain";
    }

    const handleWheelGuard = (e: WheelEvent) => {
      e.stopPropagation();
      const vp = containerEl.querySelector(".xterm-viewport") as HTMLElement | null;
      if (!vp) return;
      const atTop = vp.scrollTop <= 0 && e.deltaY < 0;
      const atBottom =
        vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 1 && e.deltaY > 0;
      const notScrollable = vp.scrollHeight <= vp.clientHeight;
      if (atTop || atBottom || notScrollable) {
        e.preventDefault();
      }
    };

    containerEl.addEventListener("wheel", handleWheelGuard, { passive: false });

    try {
      fitAddon.fit();
    } catch {
      // ignore
    }

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${window.location.host}/ws/runs/${encodeURIComponent(activeRun.id)}?offset=0`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      try {
        fitAddon.fit();
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: term.cols || 120,
            rows: term.rows || 32,
          })
        );
      } catch {
        // ignore
      }
      term.focus();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "replay" || msg.type === "output") {
          term.write(msg.data);
        } else if (msg.type === "status") {
          const items: RunArtifact[] = msg.artifactItems || [];
          const targetRunId = msg.runId || activeRun.id;
          if (msg.status === "completed") {
            items.forEach((art, idx) => {
              if (art.onComplete === "open") {
                window.open(`/api/runs/${encodeURIComponent(targetRunId)}/artifacts/${idx}`, "_blank");
              } else if (art.onComplete === "download") {
                window.open(
                  `/api/runs/${encodeURIComponent(targetRunId)}/artifacts/${idx}?download=1`,
                  "_blank"
                );
              }
            });
          }
          onRunStatusChange(
            targetRunId,
            msg.status,
            msg.exitCode ?? null,
            msg.artifacts || [],
            items
          );
        }
      } catch {
        // ignore
      }
    };

    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            })
          );
        }
      } catch {
        // ignore
      }
    });

    resizeObserver.observe(containerEl);

    return () => {
      containerEl.removeEventListener("wheel", handleWheelGuard);
      resizeObserver.disconnect();
      dataSub.dispose();
      try {
        ws.close();
      } catch {
        // ignore
      }
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }, [isOpen, activeRun?.id]);

  // Refit terminal smoothly when maximizing/restoring or dragging height
  useEffect(() => {
    if (!isOpen || !fitAddonRef.current || !termRef.current) return;
    const timer = setTimeout(() => {
      try {
        fitAddonRef.current?.fit();
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && termRef.current) {
          wsRef.current.send(
            JSON.stringify({
              type: "resize",
              cols: termRef.current.cols,
              rows: termRef.current.rows,
            })
          );
        }
      } catch {
        // ignore
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [isMaximized, isOpen, drawerHeight]);

  const statusBadge = (status: RunStatus, exitCode: number | null) => {
    if (status === "running") {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-sky-500/20 text-sky-300 border border-sky-500/30">
          <span className="w-2 h-2 rounded-full bg-sky-400 animate-ping" />
          Running
        </span>
      );
    }
    if (status === "completed") {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
          <CheckCircle2 className="w-3 h-3" />
          Exit 0
        </span>
      );
    }
    if (status === "cancelled" || status === "interrupted") {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/20 text-amber-300 border border-amber-500/30">
          <Clock className="w-3 h-3" />
          {status}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-rose-500/20 text-rose-300 border border-rose-500/30">
        <XCircle className="w-3 h-3" />
        Exit {exitCode ?? 1}
      </span>
    );
  };

  const computedStyle: React.CSSProperties = !isOpen
    ? { height: "40px" }
    : isMaximized
      ? { height: "78vh" }
      : { height: `${drawerHeight}px` };

  return (
    <div
      style={computedStyle}
      className={`shrink-0 z-40 bg-[#12151c] text-slate-100 border-t border-slate-800 shadow-2xl flex flex-col overscroll-contain relative ${
        isDragging ? "" : "transition-[height] duration-150"
      }`}
    >
      {/* Top Drag-to-Resize Sash (when open) */}
      {isOpen && (
        <div
          onMouseDown={startResizeDrag}
          className="h-2 -mt-1 w-full cursor-ns-resize flex items-center justify-center group hover:bg-sky-500/30 transition-colors shrink-0 z-50"
          title="Drag up or down to resize PTY terminal height"
        >
          <GripHorizontal className="w-4 h-3 text-slate-600 group-hover:text-sky-400" />
        </div>
      )}

      {/* Top Bar of Terminal Drawer */}
      <div className="h-10 px-4 bg-[#171b24] border-b border-slate-800 flex items-center justify-between select-none shrink-0 gap-3">
        <div className="flex items-center gap-2.5 overflow-x-auto no-scrollbar min-w-0">
          <button
            onClick={onToggleOpen}
            className="flex items-center gap-2 text-xs font-semibold text-slate-200 hover:text-sky-400 transition-colors shrink-0"
          >
            <TerminalIcon className="w-4 h-4 text-sky-400" />
            <span>PTY Console</span>
            {runningCount > 0 && (
              <span className="px-1.5 py-0.5 text-[11px] rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/40">
                {runningCount} live
              </span>
            )}
          </button>

          {/* + Interactive Shell Button */}
          <button
            type="button"
            onClick={() => onStartInteractiveShell()}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-600/90 hover:bg-emerald-500 text-white shadow-sm transition-colors shrink-0"
            title="Spawn an interactive zsh session in the current skill's workspace with .venv activated"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Interactive Shell</span>
          </button>

          {/* Run Session Tabs with Close (×) Button */}
          <div className="flex items-center gap-1.5 pl-2 border-l border-slate-800 overflow-x-auto">
            {runs.slice(0, 8).map((r) => {
              const selected = activeRun?.id === r.id;
              return (
                <div
                  key={r.id}
                  onClick={() => {
                    onSelectRun(r.id);
                    if (!isOpen) onToggleOpen();
                  }}
                  className={`group flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded text-xs transition-all cursor-pointer shrink-0 ${
                    selected
                      ? "bg-slate-800 text-white border border-slate-700"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                  }`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      r.status === "running"
                        ? "bg-sky-400 animate-pulse"
                        : r.status === "completed"
                          ? "bg-emerald-400"
                          : r.status === "cancelled" || r.status === "interrupted"
                            ? "bg-amber-400"
                            : "bg-rose-400"
                    }`}
                  />
                  <span className="font-mono text-[11px] text-slate-400">{r.skillId}:</span>
                  <span className="max-w-[130px] truncate">{r.actionTitle}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseRun(r.id);
                    }}
                    className="p-0.5 rounded hover:bg-rose-500/30 text-slate-500 hover:text-rose-300 transition-colors ml-0.5"
                    title="Kill & close this session tab"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <label
            className="hidden md:inline-flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer select-none px-2 py-0.5 rounded bg-slate-800/70 border border-slate-700/80"
            title="When enabled, one-shot commands drop into an interactive zsh shell after completion"
          >
            <input
              type="checkbox"
              checked={keepShellOpen}
              onChange={(e) => onToggleKeepShellOpen(e.target.checked)}
              className="w-3.5 h-3.5 accent-emerald-500 rounded"
            />
            <span>Keep Shell Open</span>
          </label>

          {activeRun && (
            <>
              {statusBadge(activeRun.status, activeRun.exitCode)}
              {activeRun.status === "running" && (
                <button
                  onClick={() => onStopRun(activeRun.id)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white transition-colors"
                  title="Send SIGTERM to process group (-pgid)"
                >
                  <Square className="w-3 h-3 fill-current" />
                  Stop
                </button>
              )}
              <button
                onClick={() => onCloseRun(activeRun.id)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-medium bg-slate-800 hover:bg-rose-600/80 text-slate-300 hover:text-white border border-slate-700 transition-colors"
                title="Close & remove this PTY session"
              >
                <X className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Close Tab</span>
              </button>
            </>
          )}

          <button
            onClick={() => {
              if (!isOpen) onToggleOpen();
              setIsMaximized(!isMaximized);
            }}
            className="p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800"
            title={isMaximized ? "Restore height" : "Maximize terminal"}
          >
            {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={onToggleOpen}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-slate-300 hover:text-white rounded bg-slate-800 hover:bg-slate-700"
            title={isOpen ? "Collapse PTY drawer" : "Expand PTY drawer"}
          >
            {isOpen ? (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                <span>Hide</span>
              </>
            ) : (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                <span>Show</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Main Terminal Content */}
      {isOpen && (
        <div className="flex-1 flex flex-col min-h-0 bg-[#12151c] overscroll-contain">
          {activeRun ? (
            <>
              <div className="px-4 py-1.5 bg-[#161a23] border-b border-slate-800/80 flex items-center justify-between text-xs font-mono text-slate-400 shrink-0">
                <div className="truncate">
                  <span className="text-slate-500">cwd:</span>{" "}
                  <span className="text-slate-300">{activeRun.cwd}</span>{" "}
                  <span className="text-slate-600 mx-2">|</span>
                  <span className="text-sky-300">{activeRun.maskedCommand}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {((activeRun.artifactItems && activeRun.artifactItems.length > 0) ||
                    (activeRun.artifacts && activeRun.artifacts.length > 0)) && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-slate-500">Artifacts:</span>
                      {(activeRun.artifactItems && activeRun.artifactItems.length > 0
                        ? activeRun.artifactItems
                        : activeRun.artifacts.map((a) =>
                            typeof a === "string"
                              ? {
                                  label: a.split("/").pop() || a,
                                  path: a,
                                  filename: a.split("/").pop() || a,
                                  kind: "file" as const,
                                  sizeBytes: 0,
                                  onComplete: "badge" as const,
                                }
                              : a
                          )
                      ).map((art, idx) => {
                        const isDownload =
                          art.onComplete === "download" ||
                          (art.kind === "file" &&
                            /\.(xlsx|csv|zip|db|tar|gz)$/i.test(art.filename));
                        const href = `/api/runs/${encodeURIComponent(activeRun.id)}/artifacts/${idx}${
                          isDownload ? "?download=1" : ""
                        }`;
                        return (
                          <a
                            key={`${art.path}-${idx}`}
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25"
                            title={`${art.path} (${art.kind})`}
                          >
                            <ExternalLink className="w-3 h-3" />
                            <span>{art.label || art.filename}</span>
                          </a>
                        );
                      })}
                    </div>
                  )}
                  {activeRun.pid && (
                    <span className="text-slate-500">PID/PGID: {activeRun.pid}</span>
                  )}
                </div>
              </div>

              <div
                ref={termContainerRef}
                className="flex-1 p-2 min-h-0 w-full overflow-hidden overscroll-contain"
              />
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-sm gap-3">
              <span>Run any skill action above or open an interactive shell directly:</span>
              <button
                type="button"
                onClick={() => onStartInteractiveShell()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow"
              >
                <Plus className="w-4 h-4" />
                <span>Launch Interactive Zsh Shell (with .venv & SKILL_DIR)</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
