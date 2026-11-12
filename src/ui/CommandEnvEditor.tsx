import {
  FolderOpen,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import React, { useState } from "react";
import type {
  CanonicalSkill,
  CommandEnvConfig,
  DataSnapshot,
  ResolvedCommandEnvSummary,
} from "../types.ts";

export interface CommandEnvEditorProps {
  skillId: string;
  targetKind: "action" | "data";
  targetId: string;
  targetTitle: string;
  defaultWorkspace: string;
  initialConfig?: CommandEnvConfig; // merged from yaml + uiOverride
  resolvedSummary?: ResolvedCommandEnvSummary | null;
  onSaved: (result: { skill?: CanonicalSkill; snapshot?: DataSnapshot }) => void;
  onClose: () => void;
}

export const CommandEnvEditor: React.FC<CommandEnvEditorProps> = ({
  skillId,
  targetKind,
  targetId,
  targetTitle,
  defaultWorkspace,
  initialConfig,
  resolvedSummary,
  onSaved,
  onClose,
}) => {
  const [cwd, setCwd] = useState<string>(initialConfig?.cwd ?? "");
  const [python, setPython] = useState<string>(initialConfig?.python ?? "");
  const [envFile, setEnvFile] = useState<string>(initialConfig?.envFile ?? "");
  const [envPairs, setEnvPairs] = useState<Array<{ id: string; key: string; value: string }>>(() => {
    if (!initialConfig?.env) return [];
    return Object.entries(initialConfig.env).map(([k, v]) => ({
      id: Math.random().toString(36).slice(2),
      key: k,
      value: v,
    }));
  });

  const [saveToManifest, setSaveToManifest] = useState(false);
  const [applyAsSkillDefault, setApplyAsSkillDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Directory autocomplete state
  const [cwdSuggestions, setCwdSuggestions] = useState<
    Array<{ path: string; displayPath: string; type: string }>
  >([]);
  const [showCwdSuggestions, setShowCwdSuggestions] = useState(false);

  const fetchCwdSuggestions = async (prefix: string) => {
    try {
      const res = await fetch(
        `/api/fs/complete?skillId=${encodeURIComponent(skillId)}&type=directory&prefix=${encodeURIComponent(prefix)}`
      );
      if (res.ok) {
        const data = await res.json();
        setCwdSuggestions(data.suggestions || []);
      }
    } catch {
      // ignore
    }
  };

  const addEnvPair = () => {
    setEnvPairs((prev) => [
      ...prev,
      { id: Math.random().toString(36).slice(2), key: "", value: "" },
    ]);
  };

  const removeEnvPair = (id: string) => {
    setEnvPairs((prev) => prev.filter((p) => p.id !== id));
  };

  const updateEnvPair = (id: string, field: "key" | "value", text: string) => {
    setEnvPairs((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: text } : p))
    );
  };

  const buildEnvConfig = (): CommandEnvConfig => {
    const envObj: Record<string, string> = {};
    for (const pair of envPairs) {
      const k = pair.key.trim();
      if (k) envObj[k] = pair.value;
    }
    const config: CommandEnvConfig = {};
    if (cwd.trim()) config.cwd = cwd.trim();
    if (python.trim()) config.python = python.trim();
    if (envFile.trim()) config.envFile = envFile.trim();
    if (Object.keys(envObj).length > 0) config.env = envObj;
    return config;
  };

  const handleApply = async () => {
    setSaving(true);
    setErrorMsg(null);
    try {
      const envConfig = buildEnvConfig();
      const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}/command-env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetKind,
          targetId,
          envConfig,
          saveToManifest,
          applyAsSkillDefault: cwd.trim() ? applyAsSkillDefault : false,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to apply environment (${res.status})`);
      }
      const data = await res.json();
      onSaved(data);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to apply environment");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}/command-env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetKind,
          targetId,
          envConfig: null,
          saveToManifest,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to reset environment (${res.status})`);
      }
      const data = await res.json();
      onSaved(data);
      onClose();
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to reset environment");
    } finally {
      setResetting(false);
    }
  };

  const defaultWsDisplay = defaultWorkspace.split("/").slice(-2).join("/");

  return (
    <div className="rounded-xl border border-sky-500/40 bg-sky-500/[0.03] dark:bg-sky-500/[0.05] p-4 flex flex-col gap-4 text-xs">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b st-border pb-3">
        <div>
          <h5 className="text-[13px] font-bold st-text-primary flex items-center gap-1.5">
            <span>⚙️ Execution Environment for &ldquo;{targetTitle}&rdquo;</span>
          </h5>
          <p className="text-[11.5px] st-text-secondary mt-0.5">
            Inherits skill default preference ({defaultWsDisplay}) unless overridden below.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-lg hover:st-surface-muted st-text-muted hover:st-text-primary transition-colors"
          title="Close environment panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Form Fields Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {/* Working Directory (cwd) */}
        <div className="flex flex-col gap-1.5 relative md:col-span-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold st-text-primary flex items-center gap-1.5">
              <FolderOpen className="w-3.5 h-3.5 text-sky-500" />
              <span>Working Directory (cwd)</span>
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] st-text-muted">Quick fill:</span>
              <button
                type="button"
                onClick={() => setCwd("project_root")}
                className={`px-1.5 py-0.5 rounded text-[10.5px] font-mono border transition-colors ${
                  cwd === "project_root"
                    ? "bg-sky-500/20 text-sky-700 dark:text-sky-300 border-sky-500/40 font-bold"
                    : "st-subcard st-text-secondary hover:st-text-primary border-transparent"
                }`}
                title="Use active workspace / project root"
              >
                project_root
              </button>
              <button
                type="button"
                onClick={() => setCwd("skill_dir")}
                className={`px-1.5 py-0.5 rounded text-[10.5px] font-mono border transition-colors ${
                  cwd === "skill_dir"
                    ? "bg-sky-500/20 text-sky-700 dark:text-sky-300 border-sky-500/40 font-bold"
                    : "st-subcard st-text-secondary hover:st-text-primary border-transparent"
                }`}
                title="Use unit/skill canonical directory"
              >
                skill_dir
              </button>
            </div>
          </div>
          <input
            type="text"
            value={cwd}
            placeholder={`Default (${defaultWorkspace})`}
            onFocus={() => {
              setShowCwdSuggestions(true);
              fetchCwdSuggestions(cwd);
            }}
            onBlur={() => setTimeout(() => setShowCwdSuggestions(false), 200)}
            onChange={(e) => {
              const val = e.target.value;
              setCwd(val);
              fetchCwdSuggestions(val);
            }}
            className="px-3 py-1.5 rounded-lg st-input text-xs font-mono focus:outline-none focus:border-sky-500"
          />
          {showCwdSuggestions && cwdSuggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 z-30 mt-1 max-h-48 overflow-y-auto rounded-lg st-card border st-border shadow-xl py-1">
              {cwdSuggestions.map((s, idx) => (
                <button
                  key={idx}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setCwd(s.path);
                    setShowCwdSuggestions(false);
                  }}
                  className="w-full text-left px-3 py-1.5 hover:st-surface-muted text-xs font-mono flex items-center justify-between"
                >
                  <span className="truncate st-text-primary">{s.path}</span>
                  <span className="text-[10px] st-text-muted shrink-0 ml-2">directory</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Python / Runtime ({{python}}) */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold st-text-primary">
            Python / Runtime (<code className="font-mono text-sky-600 dark:text-sky-400">{"{{python}}"}</code>)
          </label>
          <input
            type="text"
            value={python}
            placeholder={`Auto-detect nearest .venv/bin/python from cwd (Currently: ${resolvedSummary?.python || "auto"})`}
            onChange={(e) => setPython(e.target.value)}
            className="px-3 py-1.5 rounded-lg st-input text-xs font-mono focus:outline-none focus:border-sky-500"
          />
        </div>

        {/* Dotenv File (envFile) */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-semibold st-text-primary">
            Dotenv File (<code className="font-mono text-sky-600 dark:text-sky-400">envFile</code>)
          </label>
          <input
            type="text"
            value={envFile}
            placeholder="Optional .env file relative to cwd (e.g. .env.uat)"
            onChange={(e) => setEnvFile(e.target.value)}
            className="px-3 py-1.5 rounded-lg st-input text-xs font-mono focus:outline-none focus:border-sky-500"
          />
        </div>
      </div>

      {/* Command-Specific Environment Variables (env) */}
      <div className="flex flex-col gap-2 pt-1 border-t st-border">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold st-text-primary">
            Command-Specific Environment Variables (<code className="font-mono text-sky-600 dark:text-sky-400">env</code>)
          </span>
          <button
            type="button"
            onClick={addEnvPair}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md st-btn-secondary text-[11px] font-semibold"
          >
            <Plus className="w-3 h-3 text-sky-500" />
            <span>Add Variable</span>
          </button>
        </div>

        {envPairs.length > 0 ? (
          <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto pr-1">
            {envPairs.map((pair) => (
              <div key={pair.id} className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="KEY"
                  value={pair.key}
                  onChange={(e) => updateEnvPair(pair.id, "key", e.target.value)}
                  className="w-1/3 px-2.5 py-1 rounded-lg st-input text-xs font-mono uppercase focus:outline-none focus:border-sky-500"
                />
                <span className="text-xs font-mono st-text-muted">=</span>
                <input
                  type="text"
                  placeholder="VALUE"
                  value={pair.value}
                  onChange={(e) => updateEnvPair(pair.id, "value", e.target.value)}
                  className="flex-1 px-2.5 py-1 rounded-lg st-input text-xs font-mono focus:outline-none focus:border-sky-500"
                />
                <button
                  type="button"
                  onClick={() => removeEnvPair(pair.id)}
                  className="p-1 rounded hover:bg-rose-500/10 text-rose-500"
                  title="Remove variable"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[11px] st-text-muted italic">
            No command-specific environment variables defined.
          </p>
        )}
      </div>

      {/* Checkboxes for Manifest and Default Workspace */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-2 border-t st-border flex-wrap">
        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={saveToManifest}
            onChange={(e) => setSaveToManifest(e.target.checked)}
            className="w-3.5 h-3.5 rounded accent-sky-600"
          />
          <span className="text-xs st-text-primary">Save to manifest.yaml</span>
        </label>

        {Boolean(cwd.trim()) && (
          <label className="inline-flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={applyAsSkillDefault}
              onChange={(e) => setApplyAsSkillDefault(e.target.checked)}
              className="w-3.5 h-3.5 rounded accent-sky-600"
            />
            <span className="text-xs text-amber-700 dark:text-amber-300 font-medium">
              Also set cwd as Skill Default Preference
            </span>
          </label>
        )}
      </div>

      {errorMsg && (
        <div className="px-3 py-1.5 rounded-lg bg-rose-500/15 border border-rose-500/30 text-rose-600 dark:text-rose-300 text-xs">
          {errorMsg}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center justify-between gap-2 pt-1 border-t st-border flex-wrap">
        <button
          type="button"
          onClick={handleReset}
          disabled={resetting || saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg st-btn-secondary text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 border-rose-500/30"
          title="Clear override and inherit skill default preference"
        >
          <RotateCcw className={`w-3.5 h-3.5 ${resetting ? "animate-spin" : ""}`} />
          <span>Reset to Default</span>
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg st-btn-secondary text-xs font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={saving || resetting}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-sm transition-colors"
          >
            <Save className={`w-3.5 h-3.5 ${saving ? "animate-spin" : ""}`} />
            <span>Apply Environment</span>
          </button>
        </div>
      </div>
    </div>
  );
};
