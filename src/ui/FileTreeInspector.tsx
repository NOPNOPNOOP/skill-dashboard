import {
  ChevronDown,
  ChevronRight,
  Code,
  CornerLeftUp,
  Eye,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import React, { useEffect, useState } from "react";
import type { FileTreeNode } from "../types.ts";
import { highlightCodeToHtml } from "./highlight.ts";
import { MarkdownContentRenderer } from "./MarkdownViewer.tsx";

interface FileTreeInspectorProps {
  skillId: string;
  activeWorkspace: string;
  onExecuteAdHoc: (params: {
    adHocCommand: string;
    adHocTitle: string;
    formValues?: Record<string, unknown>;
    runner: "web_terminal" | "external_terminal";
    terminalApp?: "Terminal" | "iTerm";
    humanApproved?: boolean;
  }) => Promise<void>;
}

export const FileTreeInspector: React.FC<FileTreeInspectorProps> = ({
  skillId,
  activeWorkspace,
  onExecuteAdHoc,
}) => {
  const [currentDir, setCurrentDir] = useState<string>("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [treeNodes, setTreeNodes] = useState<FileTreeNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<{
    relativePath: string;
    content?: string;
    isBinary: boolean;
    mimeType: string;
    size: number;
  } | null>(null);
  const [mdPreviewMode, setMdPreviewMode] = useState<"rendered" | "raw">("rendered");

  const loadDirectoryTree = async (dirPath: string) => {
    const res = await fetch(
      `/api/skills/${encodeURIComponent(skillId)}/files?path=${encodeURIComponent(dirPath)}&recursive=1`
    );
    const data = await res.json();
    setCurrentDir(data.path || "");
    setParentPath(data.parentPath ?? null);
    const nodes: FileTreeNode[] = data.nodes || [];
    setTreeNodes(nodes);

    // Auto-expand first-level folders so tree hierarchy is immediately visible
    const initialExpanded = new Set<string>();
    for (const n of nodes) {
      if (n.type === "directory") {
        initialExpanded.add(n.relativePath);
      }
    }
    setExpandedDirs(initialExpanded);
  };

  useEffect(() => {
    setSelectedFile(null);
    loadDirectoryTree("");
  }, [skillId]);

  const handleSelectFile = async (relPath: string) => {
    const res = await fetch(
      `/api/skills/${encodeURIComponent(skillId)}/files?path=${encodeURIComponent(relPath)}&mode=read`
    );
    const data = await res.json();
    setSelectedFile(data);
    if (relPath.toLowerCase().endsWith(".md")) {
      setMdPreviewMode("rendered");
    }
  };

  const toggleExpandDir = (relPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const renderTreeRows = (nodes: FileTreeNode[], level = 0): React.ReactNode => {
    return nodes.map((node) => {
      const isDir = node.type === "directory";
      const isExpanded = expandedDirs.has(node.relativePath);
      const isSelected = selectedFile?.relativePath === node.relativePath;

      return (
        <React.Fragment key={node.relativePath}>
          <div
            style={{ paddingLeft: `${level * 16 + 8}px` }}
            className={`group flex items-center justify-between pr-2 py-1.5 rounded-lg text-[13px] transition-colors cursor-pointer select-none ${
              isSelected
                ? "bg-sky-500/15 text-sky-600 dark:text-sky-300 font-semibold"
                : "hover:st-surface-muted st-text-primary"
            }`}
            onClick={() => {
              if (isDir) {
                toggleExpandDir(node.relativePath);
              } else {
                handleSelectFile(node.relativePath);
              }
            }}
          >
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              {level > 0 && (
                <span className="w-1.5 h-4 border-l border-b st-border-strong inline-block mr-0.5 shrink-0 opacity-60" />
              )}
              {isDir ? (
                <>
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5 st-text-muted shrink-0" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 st-text-muted shrink-0" />
                  )}
                  {isExpanded ? (
                    <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
                  ) : (
                    <Folder className="w-4 h-4 text-amber-500 shrink-0" />
                  )}
                </>
              ) : node.name.toLowerCase().endsWith(".md") ? (
                <FileText className="w-4 h-4 text-sky-500 shrink-0 ml-4" />
              ) : (
                <FileCode className="w-4 h-4 text-indigo-500 shrink-0 ml-4" />
              )}
              <span className="truncate font-mono text-[12.5px]">{node.name}</span>
            </div>

            {isDir ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  loadDirectoryTree(node.relativePath);
                }}
                className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded text-[11px] font-mono st-btn-secondary transition-opacity shrink-0"
                title={`Enter folder /${node.relativePath}`}
              >
                cd →
              </button>
            ) : (
              node.size !== undefined && (
                <span className="text-[11px] st-text-muted font-mono shrink-0 ml-2">
                  {node.size < 1024
                    ? `${node.size}B`
                    : `${(node.size / 1024).toFixed(1)}KB`}
                </span>
              )
            )}
          </div>

          {isDir && isExpanded && node.children && node.children.length > 0 && (
            <div className="relative">{renderTreeRows(node.children, level + 1)}</div>
          )}
        </React.Fragment>
      );
    });
  };

  const isMarkdownFile = Boolean(
    selectedFile && selectedFile.relativePath.toLowerCase().endsWith(".md")
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 min-h-[540px]">
      {/* Left Pane: Hierarchical Indented File Tree + ../ Navigation */}
      <div className="lg:col-span-4 st-card rounded-2xl p-3.5 flex flex-col gap-2 max-h-[75vh]">
        {/* Current Path Breadcrumb Header */}
        <div className="flex items-center justify-between gap-2 pb-2.5 border-b st-border px-1">
          <div className="flex items-center gap-1.5 min-w-0 font-mono text-xs">
            <FolderOpen className="w-4 h-4 text-amber-500 shrink-0" />
            <button
              type="button"
              onClick={() => loadDirectoryTree("")}
              className="hover:underline font-semibold text-sky-600 dark:text-sky-400 shrink-0"
            >
              root
            </button>
            {currentDir &&
              currentDir.split("/").map((part, idx, arr) => {
                const sub = arr.slice(0, idx + 1).join("/");
                return (
                  <React.Fragment key={sub}>
                    <span className="st-text-muted">/</span>
                    <button
                      type="button"
                      onClick={() => loadDirectoryTree(sub)}
                      className="hover:underline truncate st-text-primary font-semibold"
                    >
                      {part}
                    </button>
                  </React.Fragment>
                );
              })}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => {
                const allDirs = new Set<string>();
                const collect = (ns: FileTreeNode[]) => {
                  for (const n of ns) {
                    if (n.type === "directory") {
                      allDirs.add(n.relativePath);
                      if (n.children) collect(n.children);
                    }
                  }
                };
                collect(treeNodes);
                setExpandedDirs(allDirs);
              }}
              className="px-1.5 py-0.5 rounded text-[11px] st-btn-secondary"
              title="Expand all subdirectories"
            >
              Expand
            </button>
            <button
              type="button"
              onClick={() => setExpandedDirs(new Set())}
              className="px-1.5 py-0.5 rounded text-[11px] st-btn-secondary"
              title="Collapse all subdirectories"
            >
              Collapse
            </button>
          </div>
        </div>

        {/* Tree Nodes List */}
        <div className="flex-1 overflow-y-auto space-y-0.5 pr-1">
          {/* Explicit ../ Row whenever inside a subdirectory */}
          {parentPath !== null && (
            <button
              type="button"
              onClick={() => loadDirectoryTree(parentPath)}
              className="w-full text-left px-2.5 py-2 mb-1 rounded-lg st-subcard hover:border-sky-500/50 flex items-center justify-between text-xs font-mono transition-all group"
            >
              <span className="flex items-center gap-2 font-bold text-sky-600 dark:text-sky-400">
                <CornerLeftUp className="w-4 h-4" />
                <span>../</span>
                <span className="font-sans font-normal st-text-secondary">
                  (Parent Directory: /{parentPath || "root"})
                </span>
              </span>
              <span className="text-[11px] st-text-muted group-hover:text-sky-500">
                Up one level
              </span>
            </button>
          )}

          {renderTreeRows(treeNodes, 0)}
        </div>
      </div>

      {/* Right Pane: Highlighted Code & Markdown Preview */}
      <div className="lg:col-span-8 st-card rounded-2xl p-5 flex flex-col min-h-[540px]">
        {selectedFile ? (
          <>
            <div className="flex items-center justify-between gap-3 pb-3 mb-3 border-b st-border flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-sm font-bold text-sky-600 dark:text-sky-400 truncate">
                  {selectedFile.relativePath}
                </span>
                <span className="text-xs font-mono st-text-muted">
                  ({selectedFile.size} bytes)
                </span>
              </div>

              <div className="flex items-center gap-2">
                {isMarkdownFile && !selectedFile.isBinary && (
                  <div className="inline-flex rounded-lg p-0.5 st-surface-muted border st-border">
                    <button
                      type="button"
                      onClick={() => setMdPreviewMode("rendered")}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
                        mdPreviewMode === "rendered"
                          ? "bg-sky-600 text-white shadow-sm"
                          : "st-text-secondary"
                      }`}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>Rendered Markdown</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMdPreviewMode("raw")}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
                        mdPreviewMode === "raw"
                          ? "bg-sky-600 text-white shadow-sm"
                          : "st-text-secondary"
                      }`}
                    >
                      <Code className="w-3.5 h-3.5" />
                      <span>Raw Source</span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            {selectedFile.isBinary ? (
              selectedFile.mimeType.startsWith("image/") ? (
                <div className="flex-1 flex items-center justify-center p-6 st-surface-muted rounded-xl">
                  <img
                    src={`/api/assets?skill=${encodeURIComponent(skillId)}&path=${encodeURIComponent(selectedFile.relativePath)}`}
                    alt={selectedFile.relativePath}
                    className="max-h-96 object-contain rounded-lg border st-border"
                  />
                </div>
              ) : (
                <div className="p-10 text-center st-text-secondary text-sm">
                  Binary asset ({selectedFile.mimeType}).{" "}
                  <a
                    href={`/api/assets?skill=${encodeURIComponent(skillId)}&path=${encodeURIComponent(selectedFile.relativePath)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-600 dark:text-sky-400 underline font-semibold"
                  >
                    Open / Download Asset
                  </a>
                </div>
              )
            ) : isMarkdownFile && mdPreviewMode === "rendered" ? (
              <div className="flex-1 overflow-y-auto">
                <MarkdownContentRenderer
                  skillId={skillId}
                  markdown={selectedFile.content || ""}
                  currentSource={selectedFile.relativePath}
                  activeWorkspace={activeWorkspace}
                  showSummaryBar={true}
                  onNavigateRelativeMd={(targetSource) => handleSelectFile(targetSource)}
                  onExecuteAdHoc={onExecuteAdHoc}
                />
              </div>
            ) : (
              <pre
                className="flex-1 overflow-auto p-4 rounded-xl st-code-surface border st-border text-[13px] font-mono leading-relaxed"
                dangerouslySetInnerHTML={{
                  __html: highlightCodeToHtml(
                    selectedFile.content || "",
                    selectedFile.relativePath.split(".").pop() || "text",
                    true
                  ),
                }}
              />
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center st-text-muted text-sm gap-2">
            <FileCode className="w-8 h-8 opacity-40" />
            <span>Select any file in the hierarchical tree on the left to inspect or run it.</span>
          </div>
        )}
      </div>
    </div>
  );
};
