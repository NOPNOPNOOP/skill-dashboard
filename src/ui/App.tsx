import {
  AlertTriangle,
  ArrowUpCircle,
  BookOpen,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  Database,
  Folder,
  FolderGit2,
  GitBranch,
  KeyRound,
  Layers,
  Link2,
  Link2Off,
  Moon,
  Palette,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sliders,
  Sparkles,
  Sun,
  Tag,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import YAML from "yaml";
import type {
  AgentFixTarget,
  AgentMount,
  CanonicalSkill,
  DashboardConfig,
  ExecutionRun,
  RunArtifact,
  RunStatus,
  UnconfiguredFolderAction,
} from "../types.ts";
import { FileTreeInspector } from "./FileTreeInspector.tsx";
import { MarkdownViewer } from "./MarkdownViewer.tsx";
import { MultiLevelPlayground } from "./MultiLevelPlayground.tsx";
import { TerminalDrawer } from "./TerminalDrawer.tsx";

interface AgentTargetInfo {
  agent: string;
  label: string;
  path: string;
  scope: string;
  canToggleMount: boolean;
  primaryToggle?: boolean;
  sharedViaAgentsHub?: boolean;
}

function getSemanticSkillIconMeta(skill: CanonicalSkill): {
  Icon: React.FC<{ className?: string }>;
  colorClass: string;
  bgClass: string;
} {
  const text = `${skill.id} ${skill.manifest.category} ${skill.manifest.name}`.toLowerCase();
  if (/vsip|database|data|migration|sql|excel/.test(text)) {
    return {
      Icon: Database,
      colorClass: "text-sky-500",
      bgClass: "bg-sky-500/15 border-sky-500/30",
    };
  }
  if (/review|refactor|test|tdd|qa|bug|security|guard/.test(text)) {
    return {
      Icon: ShieldCheck,
      colorClass: "text-emerald-500",
      bgClass: "bg-emerald-500/15 border-emerald-500/30",
    };
  }
  if (/obsidian|markdown|writing|article|canvas|knap|defuddle|doc|prd|issue/.test(text)) {
    return {
      Icon: BookOpen,
      colorClass: "text-amber-500",
      bgClass: "bg-amber-500/15 border-amber-500/30",
    };
  }
  if (/orca|worktree|terminal|computer|crabbox|orchestrat|loop|open|tell|wait/.test(text)) {
    return {
      Icon: Terminal,
      colorClass: "text-indigo-500",
      bgClass: "bg-indigo-500/15 border-indigo-500/30",
    };
  }
  if (/design|ui|dataviz|artifact|diagram|image/.test(text)) {
    return {
      Icon: Palette,
      colorClass: "text-rose-500",
      bgClass: "bg-rose-500/15 border-rose-500/30",
    };
  }
  return {
    Icon: Bot,
    colorClass: "text-purple-500",
    bgClass: "bg-purple-500/15 border-purple-500/30",
  };
}

export const App: React.FC = () => {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("skill_dashboard_theme");
      if (saved === "dark" || saved === "light") return saved;
    } catch {
      // ignore
    }
    return "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
    try {
      localStorage.setItem("skill_dashboard_theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const [skills, setSkills] = useState<CanonicalSkill[]>([]);
  const [brokenMounts, setBrokenMounts] = useState<AgentMount[]>([]);
  const [globalWorkspace, setGlobalWorkspace] = useState<string>("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [agentTargets, setAgentTargets] = useState<AgentTargetInfo[]>([]);
  const [runs, setRuns] = useState<ExecutionRun[]>([]);

  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"playground" | "docs" | "files" | "manifest">(
    "playground"
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAgentFilter, setSelectedAgentFilter] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [showAllTags, setShowAllTags] = useState<boolean>(false);

  // More Agents toggle in Mount Bar (Issue 06)
  const [showMoreMounts, setShowMoreMounts] = useState(false);

  // Per-Skill Workspace & Environment Config Modal/Drawer (Issues 09 & 11)
  const [workspaceModalOpen, setWorkspaceModalOpen] = useState(false);
  const [customWorkspaceInput, setCustomWorkspaceInput] = useState("");
  const [saveWsToManifest, setSaveWsToManifest] = useState(false);

  const [envModalOpen, setEnvModalOpen] = useState(false);
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string }>>([]);
  const [envSaveStatus, setEnvSaveStatus] = useState<string | null>(null);

  // Broken mounts repair modal
  const [brokenModalOpen, setBrokenModalOpen] = useState(false);

  // Terminal drawer state
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [keepShellOpen, setKeepShellOpen] = useState(false);

  // Manifest Studio editor state
  const [manifestYamlText, setManifestYamlText] = useState("");
  const [selectedModuleFile, setSelectedModuleFile] = useState<string>("manifest.yaml");
  const [manifestSaveLayer, setManifestSaveLayer] = useState<"companion" | "global" | "workspace">(
    "companion"
  );
  const [manifestSaveStatus, setManifestSaveStatus] = useState<string | null>(null);
  const [copiedAgentSync, setCopiedAgentSync] = useState(false);

  // XDG Config, Managed Folder Modal & Scratchpad Promotion / HITL States
  const [dashboardConfig, setDashboardConfig] = useState<DashboardConfig | null>(null);
  const [addFolderModalOpen, setAddFolderModalOpen] = useState(false);
  const [newFolderInput, setNewFolderInput] = useState("");
  const [unconfiguredPromptTarget, setUnconfiguredPromptTarget] = useState<{
    unit: CanonicalSkill;
    rememberChoice: boolean;
  } | null>(null);
  const [promoteModalOpen, setPromoteModalOpen] = useState(false);
  const [promoteTargetMode, setPromoteTargetMode] = useState<"project" | "skill">("project");
  const [decisionNoteInput, setDecisionNoteInput] = useState("");
  const [decisionSentBanner, setDecisionSentBanner] = useState<string | null>(null);
  const [deepLinkViewId, setDeepLinkViewId] = useState<string | null>(null);

  // Bottom-Right Non-Modal "Fix / Ask Agent" Floating Drawer & Click-to-Context States
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
  const [agentPickMode, setAgentPickMode] = useState(false);
  const [pinnedFixTargets, setPinnedFixTargets] = useState<AgentFixTarget[]>([]);
  const [agentFixInstruction, setAgentFixInstruction] = useState("");
  const [agentFixTargetLayer, setAgentFixTargetLayer] = useState<
    "auto" | "companion" | "global_override" | "workspace_override"
  >("auto");
  const [agentFixPreview, setAgentFixPreview] = useState<{
    mode: "init" | "incremental";
    resolvedTargetFile: string;
    resolvedTargetLayer: string;
    targetExists: boolean;
    prompt: string;
  } | null>(null);

  // Refresh trigger counter incremented whenever a PTY run finishes (so Probes, DataSources, and HTML Views auto-refresh)
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [isRefreshingAll, setIsRefreshingAll] = useState(false);
  // Prefill & Jump state from HTML Views or Probes into Playground
  const [prefillRequest, setPrefillRequest] = useState<{
    actionId: string;
    formValues: Record<string, unknown>;
    seq: number;
  } | null>(null);

  const loadBootstrap = async (forceRefresh = false) => {
    const res = await fetch(`/api/bootstrap${forceRefresh ? "?refresh=1" : ""}`);
    const data = await res.json();
    const list: CanonicalSkill[] = data.skills || [];
    setSkills(list);
    setBrokenMounts(data.brokenMounts || []);
    setGlobalWorkspace(data.activeWorkspace || "");
    setRecentWorkspaces(data.recentWorkspaces || []);
    setAgentTargets(data.agentTargets || []);
    setRuns(data.runs || []);
    if (data.config) setDashboardConfig(data.config);

    // URL Deep-Link Routing: /?id=<unit_id>&tab=<tab>&action=<action_id>
    const params = new URLSearchParams(window.location.search);
    const urlId = params.get("id") || params.get("app") || params.get("skill");
    const urlTab = params.get("tab");
    const urlAction = params.get("action");

    if (urlId && list.some((s) => s.id === urlId)) {
      setSelectedSkillId(urlId);
    } else if (!selectedSkillId && list.length > 0) {
      setSelectedSkillId(list[0].id);
    }

    if (
      urlTab === "playground" ||
      urlTab === "docs" ||
      urlTab === "files" ||
      urlTab === "manifest"
    ) {
      setActiveTab(urlTab);
    } else if (urlTab && urlTab.startsWith("view:")) {
      setActiveTab("docs");
      setDeepLinkViewId(urlTab.slice(5));
    }

    if (urlAction) {
      setActiveTab("playground");
      setPrefillRequest({ actionId: urlAction, formValues: {}, seq: Date.now() });
    }
  };

  useEffect(() => {
    loadBootstrap(false);
  }, []);

  const selectedSkill = useMemo(
    () => skills.find((s) => s.id === selectedSkillId) || skills[0] || null,
    [skills, selectedSkillId]
  );

  const effectiveWorkspace = selectedSkill?.effectiveWorkspace || globalWorkspace;
  const effectivePython = selectedSkill?.pythonExecutable || "python3";

  const handleGlobalRefresh = async () => {
    if (isRefreshingAll) return;
    setIsRefreshingAll(true);
    try {
      await loadBootstrap(true);
      setRefreshTrigger((prev) => prev + 1);
      if (selectedSkill && selectedSkill.layers.companion && selectedModuleFile !== "__merged__") {
        const r = await fetch(
          `/api/skills/${encodeURIComponent(selectedSkill.id)}/manifest-module?file=${encodeURIComponent(selectedModuleFile)}`
        );
        if (r.ok) {
          const d = await r.json();
          if (typeof d.content === "string") setManifestYamlText(d.content);
        }
      }
    } finally {
      setTimeout(() => setIsRefreshingAll(false), 350);
    }
  };

  // Sync browser tab title & dynamic status with selected skill and active PTY runs
  useEffect(() => {
    const runningCount = runs.filter((r) => r.status === "running").length;
    const prefix = runningCount > 0 ? `⚡ (${runningCount} running) ` : "";
    const skillTitle = selectedSkill ? `${selectedSkill.manifest.name} · ` : "";
    document.title = `${prefix}${skillTitle}Skill Dashboard Studio`;
  }, [selectedSkill?.manifest.name, runs]);

  // Sync Manifest Editor, Workspace Input & Env Pairs when selectedSkill changes
  useEffect(() => {
    if (!selectedSkill) return;
    setSelectedModuleFile("manifest.yaml");
    setPinnedFixTargets([]);
    setAgentPickMode(false);
    setCustomWorkspaceInput(selectedSkill.effectiveWorkspace || globalWorkspace);
    if (selectedSkill.layers.companion) {
      fetch(
        `/api/skills/${encodeURIComponent(selectedSkill.id)}/manifest-module?file=manifest.yaml`
      )
        .then((r) => r.json())
        .then((d) => {
          if (typeof d.content === "string") setManifestYamlText(d.content);
        })
        .catch(() => {
          setManifestYamlText(YAML.stringify(selectedSkill.manifest, { indent: 2 }));
        });
    } else {
      setManifestYamlText(YAML.stringify(selectedSkill.manifest, { indent: 2 }));
    }

    const declaredKeys = new Set((selectedSkill.manifest.envVars || []).map((e) => e.key));
    const pairs: Array<{ key: string; value: string }> = [];
    for (const ev of selectedSkill.manifest.envVars || []) {
      pairs.push({
        key: ev.key,
        value: selectedSkill.configuredEnv?.[ev.key] ?? ev.default ?? "",
      });
    }
    for (const [k, v] of Object.entries(selectedSkill.configuredEnv || {})) {
      if (!declaredKeys.has(k)) {
        pairs.push({ key: k, value: v });
      }
    }
    setEnvPairs(pairs);
    setEnvSaveStatus(null);
  }, [selectedSkill?.id, selectedSkill?.effectiveWorkspace]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const s of skills) set.add(s.manifest.category);
    return ["all", ...Array.from(set)];
  }, [skills]);

  // Issue 14: Compute tag frequency cloud across all skills
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of skills) {
      for (const t of s.manifest.tags || []) {
        const clean = t.trim().toLowerCase();
        if (!clean) continue;
        counts.set(clean, (counts.get(clean) || 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [skills]);

  // Issue 06: Accurate Agent Ecosystem Filtering
  // Skills in ~/.agents/skills (s.inAgentsHub) are automatically available in Codex, OpenCode, and Pi!
  const isSkillAvailableInAgent = (skill: CanonicalSkill, filterId: string): boolean => {
    if (filterId === "all") return true;
    if (skill.unitKind === "scratchpad" || skill.unitKind === "workspace") return true;
    if (filterId === "codex") {
      return (
        skill.inAgentsHub ||
        skill.mounts.some((m) => m.agent === "codex" || m.agent === "codex-system")
      );
    }
    if (filterId === "opencode") {
      return (
        skill.inAgentsHub ||
        skill.mounts.some((m) => m.agent === "opencode" || m.agent === "claude")
      );
    }
    if (filterId === "pi") {
      return (
        skill.inAgentsHub ||
        skill.mounts.some((m) => m.agent === "pi-agent" || m.agent === "pi")
      );
    }
    return skill.mounts.some((m) => m.agent === filterId);
  };

  const filteredSkills = useMemo(() => {
    return skills.filter((s) => {
      if (!isSkillAvailableInAgent(s, selectedAgentFilter)) return false;
      if (selectedCategory !== "all" && s.manifest.category !== selectedCategory) {
        return false;
      }
      if (selectedTag) {
        const hasTag = (s.manifest.tags || []).some(
          (t) => t.toLowerCase() === selectedTag.toLowerCase()
        );
        if (!hasTag) return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const inId = s.id.toLowerCase().includes(q);
        const inName = s.manifest.name.toLowerCase().includes(q);
        const inDesc = s.manifest.description.toLowerCase().includes(q);
        const inTags = s.manifest.tags.some((t) => t.toLowerCase().includes(q));
        const inActions = s.manifest.actionGroups.some((g) =>
          g.actions.some(
            (a) =>
              a.title.toLowerCase().includes(q) ||
              a.command.toLowerCase().includes(q)
          )
        );
        return inId || inName || inDesc || inTags || inActions;
      }
      return true;
    });
  }, [skills, selectedAgentFilter, selectedCategory, selectedTag, searchQuery]);

  // Issue 09: Per-Skill Default Workspace Update
  const handleSwitchWorkspace = async (nextWs: string, forCurrentSkill = true) => {
    const res = await fetch("/api/workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        activeWorkspace: nextWs,
        skillId: forCurrentSkill && selectedSkill ? selectedSkill.id : undefined,
        saveToManifest: saveWsToManifest,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setSkills(data.skills || []);
      setBrokenMounts(data.brokenMounts || []);
      setWorkspaceModalOpen(false);
    } else {
      alert(data.error || "Failed to switch workspace");
    }
  };

  // Issue 11: Save Per-Skill Environment Variables
  const handleSaveSkillEnv = async () => {
    if (!selectedSkill) return;
    const envObj: Record<string, string> = {};
    for (const p of envPairs) {
      if (p.key.trim()) envObj[p.key.trim()] = p.value;
    }
    const res = await fetch(`/api/skills/${encodeURIComponent(selectedSkill.id)}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env: envObj }),
    });
    const data = await res.json();
    if (res.ok && data.skill) {
      setSkills((prev) => prev.map((s) => (s.id === selectedSkill.id ? data.skill : s)));
      setEnvSaveStatus("Saved environment variables for " + selectedSkill.id);
    }
  };

  const handleToggleMount = async (skillId: string, agent: string, enabled: boolean) => {
    const res = await fetch("/api/mounts/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId, agent, enabled }),
    });
    const data = await res.json();
    if (res.ok && data.skill) {
      setSkills((prev) => prev.map((s) => (s.id === skillId ? data.skill : s)));
      setBrokenMounts(data.brokenMounts || []);
    }
  };

  const handleRepairMount = async (mountPath: string, action: "relink" | "remove") => {
    const res = await fetch("/api/mounts/repair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mountPath, action }),
    });
    const data = await res.json();
    if (res.ok) {
      setSkills(data.skills || []);
      setBrokenMounts(data.brokenMounts || []);
    }
  };

  const handleExecuteAction = async (params: {
    actionId?: string;
    adHocCommand?: string;
    adHocTitle?: string;
    interactiveShell?: boolean;
    formValues?: Record<string, unknown>;
    runner: "web_terminal" | "external_terminal";
    terminalApp?: "Terminal" | "iTerm";
    humanApproved?: boolean;
  }) => {
    if (!selectedSkill) return;
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillId: selectedSkill.id,
        actionId: params.actionId,
        adHocCommand: params.adHocCommand,
        adHocTitle: params.adHocTitle,
        interactiveShell: params.interactiveShell,
        keepShellOpen,
        formValues: params.formValues || {},
        runner: params.runner,
        terminalApp: params.terminalApp,
        humanApproved: params.humanApproved,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Execution failed");
    }
    if (data.mode === "web_terminal" && data.run) {
      setRuns((prev) => [data.run, ...prev.filter((r) => r.id !== data.run.id)]);
      setActiveRunId(data.run.id);
      setTerminalOpen(true);
    }
  };

  const handleStartInteractiveShell = async () => {
    await handleExecuteAction({
      interactiveShell: true,
      runner: "web_terminal",
    });
  };

  const handleStopRun = async (runId: string) => {
    await fetch(`/api/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
  };

  const handleCloseRun = async (runId: string) => {
    await fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
    setRuns((prev) => {
      const remaining = prev.filter((r) => r.id !== runId);
      if (activeRunId === runId) {
        setActiveRunId(remaining[0]?.id || null);
      }
      if (remaining.length === 0) {
        setTerminalOpen(false);
      }
      return remaining;
    });
  };

  // Issue 12: Upstream Skill Update (Single Skill or Update All)
  const handleUpdateSkill = async (skillId: string) => {
    const res = await fetch(`/api/skills/${encodeURIComponent(skillId)}/update`, {
      method: "POST",
    });
    const data = await res.json();
    if (res.ok && data.run) {
      setRuns((prev) => [data.run, ...prev.filter((r) => r.id !== data.run.id)]);
      setActiveRunId(data.run.id);
      setTerminalOpen(true);
    }
  };

  const handleUpdateAllSkills = async () => {
    const res = await fetch("/api/skills/update-all", { method: "POST" });
    const data = await res.json();
    if (res.ok && data.run) {
      setRuns((prev) => [data.run, ...prev.filter((r) => r.id !== data.run.id)]);
      setActiveRunId(data.run.id);
      setTerminalOpen(true);
    }
  };

  // Issue 13 & 69: Agent-Driven Manifest Sync / Targeted Fix Drawer
  useEffect(() => {
    if (!selectedSkill || !agentDrawerOpen) return;
    let cancelled = false;
    fetch(`/api/skills/${encodeURIComponent(selectedSkill.id)}/agent-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        previewOnly: true,
        userInstruction: agentFixInstruction,
        targets: pinnedFixTargets,
        targetLayer: agentFixTargetLayer,
      }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.resolvedTargetFile) {
          setAgentFixPreview(data);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    selectedSkill?.id,
    agentDrawerOpen,
    agentFixInstruction,
    pinnedFixTargets,
    agentFixTargetLayer,
  ]);

  useEffect(() => {
    if (!agentPickMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAgentPickMode(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [agentPickMode]);

  const buildFixTargetFromElement = (
    kind: AgentFixTarget["kind"],
    id: string,
    title: string
  ): AgentFixTarget | null => {
    if (!selectedSkill) return null;
    const prov = selectedSkill.layers.provenance;
    if (kind === "action-group") {
      const grp = selectedSkill.manifest.actionGroups.find((g) => g.name === id);
      const firstActId = grp?.actions?.[0]?.id;
      return {
        kind,
        id,
        title,
        provenanceFile: firstActId ? prov?.actionSource?.[firstActId] : undefined,
        snippet: grp
          ? {
              name: grp.name,
              actionCount: grp.actions.length,
              actions: grp.actions.slice(0, 12).map((a) => ({
                id: a.id,
                title: a.title,
                command: a.command,
                subgroup: a.subgroup,
              })),
            }
          : undefined,
      };
    }
    if (kind === "action") {
      const act = selectedSkill.manifest.actionGroups
        .flatMap((g) => [
          ...(g.actions || []),
          ...(g.subgroups ? g.subgroups.flatMap((sg) => sg.actions) : []),
        ])
        .find((a) => a.id === id);
      return {
        kind,
        id,
        title,
        provenanceFile: prov?.actionSource?.[id],
        snippet: act,
      };
    }
    if (kind === "data-node") {
      const node = (selectedSkill.manifest.data || []).find((d) => d.id === id);
      return {
        kind,
        id,
        title,
        provenanceFile: prov?.dataSource?.[id],
        snippet: node,
      };
    }
    if (kind === "context") {
      const ctxField = (selectedSkill.manifest.context || []).find((c) => c.key === id);
      return {
        kind,
        id,
        title,
        provenanceFile: prov?.contextSource?.[id],
        snippet: ctxField,
      };
    }
    if (kind === "view") {
      const vw = (selectedSkill.manifest.views || []).find((v) => v.id === id);
      return {
        kind,
        id,
        title,
        provenanceFile: prov?.viewSource?.[id],
        snippet: vw,
      };
    }
    return { kind, id, title };
  };

  const handleMainClickCapture = (e: React.MouseEvent<HTMLElement>) => {
    if (!agentPickMode && !e.altKey) return;
    const targetEl = (e.target as HTMLElement).closest("[data-sd-pick-kind]") as HTMLElement | null;
    if (!targetEl) return;
    const kind = targetEl.getAttribute("data-sd-pick-kind") as AgentFixTarget["kind"] | null;
    const id = targetEl.getAttribute("data-sd-pick-id");
    const title = targetEl.getAttribute("data-sd-pick-title") || id || "";
    if (!kind || !id) return;

    e.preventDefault();
    e.stopPropagation();

    const built = buildFixTargetFromElement(kind, id, title);
    if (!built) return;

    setPinnedFixTargets((prev) => {
      const exists = prev.some((t) => t.kind === built.kind && t.id === built.id);
      if (exists) {
        return prev.filter((t) => !(t.kind === built.kind && t.id === built.id));
      }
      return [...prev, built];
    });
    setAgentDrawerOpen(true);
  };

  const handleAgentSyncManifest = async (mode: "pty-claude" | "pty-codex" | "copy") => {
    if (!selectedSkill) return;
    const payload = {
      userInstruction: agentFixInstruction.trim() || undefined,
      targets: pinnedFixTargets.length > 0 ? pinnedFixTargets : undefined,
      targetLayer: agentFixTargetLayer,
    };

    if (mode === "copy") {
      const res = await fetch(
        `/api/skills/${encodeURIComponent(selectedSkill.id)}/agent-sync`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, previewOnly: true }),
        }
      );
      const data = await res.json();
      if (data.prompt) {
        navigator.clipboard.writeText(data.prompt);
        setCopiedAgentSync(true);
        setTimeout(() => setCopiedAgentSync(false), 1800);
      }
      return;
    }

    const agentCli = mode === "pty-codex" ? "codex" : "claude";
    const res = await fetch(
      `/api/skills/${encodeURIComponent(selectedSkill.id)}/agent-sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, agentCli }),
      }
    );
    const data = await res.json();
    if (res.ok && data.run) {
      setAgentPickMode(false);
      setRuns((prev) => [data.run, ...prev.filter((r) => r.id !== data.run.id)]);
      setActiveRunId(data.run.id);
      setTerminalOpen(true);
    }
  };

  const handleRunStatusChange = (
    runId: string,
    status: RunStatus,
    exitCode: number | null,
    artifacts: Array<string | RunArtifact>,
    artifactItems?: RunArtifact[]
  ) => {
    setRuns((prev) =>
      prev.map((r) =>
        r.id === runId ? { ...r, status, exitCode, artifacts, artifactItems: artifactItems || r.artifactItems } : r
      )
    );
    if (status === "completed") {
      loadBootstrap(true);
      setRefreshTrigger((prev) => prev + 1);
    }
  };

  const handleAddManagedFolder = async (folderPath: string) => {
    const res = await fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folderPath }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Failed to add folder");
      return;
    }
    setSkills(data.skills || []);
    if (data.config) setDashboardConfig(data.config);
    setAddFolderModalOpen(false);
    setNewFolderInput("");

    if (data.unit) {
      setSelectedSkillId(data.unit.id);
      if (!data.hasManifest) {
        const pref: UnconfiguredFolderAction = data.unconfiguredFolderAction || "ask";
        if (pref === "ask") {
          setUnconfiguredPromptTarget({ unit: data.unit, rememberChoice: false });
        } else if (pref === "agent") {
          setTimeout(() => handleAgentSyncForUnit(data.unit.id, "pty-claude"), 80);
        }
      }
    }
  };

  const handleRemoveManagedFolder = async (folderPath: string) => {
    const res = await fetch("/api/folders", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folderPath }),
    });
    const data = await res.json();
    if (res.ok) {
      setSkills(data.skills || []);
      if (data.config) setDashboardConfig(data.config);
    }
  };

  const handleAgentSyncForUnit = async (unitId: string, mode: "pty-claude" | "pty-codex" | "copy") => {
    if (mode === "copy") {
      const res = await fetch(`/api/skills/${encodeURIComponent(unitId)}/agent-sync`);
      const data = await res.json();
      if (data.prompt) {
        navigator.clipboard.writeText(data.prompt);
        setCopiedAgentSync(true);
        setTimeout(() => setCopiedAgentSync(false), 1800);
      }
      return;
    }
    const agentCli = mode === "pty-codex" ? "codex" : "claude";
    const res = await fetch(`/api/skills/${encodeURIComponent(unitId)}/agent-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentCli }),
    });
    const data = await res.json();
    if (res.ok && data.run) {
      setRuns((prev) => [data.run, ...prev.filter((r) => r.id !== data.run.id)]);
      setActiveRunId(data.run.id);
      setTerminalOpen(true);
    }
  };

  const handleResolveUnconfiguredChoice = async (
    choice: "agent" | "skeleton" | "copy" | "raw"
  ) => {
    if (!unconfiguredPromptTarget) return;
    const { unit, rememberChoice } = unconfiguredPromptTarget;
    if (rememberChoice && (choice === "agent" || choice === "skeleton" || choice === "raw")) {
      await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unconfiguredFolderAction: choice }),
      });
    }
    setUnconfiguredPromptTarget(null);
    if (choice === "agent") {
      await handleAgentSyncForUnit(unit.id, "pty-claude");
    } else if (choice === "skeleton") {
      const res = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: unit.canonicalPath, initSkeleton: true }),
      });
      const data = await res.json();
      if (res.ok && data.skills) setSkills(data.skills);
    } else if (choice === "copy") {
      await handleAgentSyncForUnit(unit.id, "copy");
    }
  };

  const handlePromoteScratchpad = async () => {
    if (!selectedSkill) return;
    const res = await fetch(`/api/scratchpads/${encodeURIComponent(selectedSkill.id)}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: promoteTargetMode }),
    });
    const data = await res.json();
    if (res.ok) {
      setPromoteModalOpen(false);
      setSkills(data.skills || []);
      if (data.unit?.id) setSelectedSkillId(data.unit.id);
    } else {
      alert(data.error || "Failed to promote scratchpad");
    }
  };

  const handleDeleteScratchpad = async (unitId: string) => {
    const res = await fetch(`/api/scratchpads/${encodeURIComponent(unitId)}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (res.ok) {
      const nextList: CanonicalSkill[] = data.skills || [];
      setSkills(nextList);
      if (selectedSkillId === unitId) {
        setSelectedSkillId(nextList[0]?.id || null);
      }
    }
  };

  const handleSubmitDecisionToAgent = async (decision: "approved" | "rejected" | "note") => {
    if (!selectedSkill) return;
    const res = await fetch(`/api/units/${encodeURIComponent(selectedSkill.id)}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "decision_submitted",
        payload: {
          decision,
          note: decisionNoteInput,
          context: selectedSkill.id,
          submittedAt: new Date().toISOString(),
        },
      }),
    });
    if (res.ok) {
      setDecisionSentBanner(`Sent "${decision}" to waiting Agent!`);
      setDecisionNoteInput("");
      setTimeout(() => setDecisionSentBanner(null), 2500);
    }
  };

  const handlePrefillActionJump = (actionId: string, formValues: Record<string, unknown>) => {
    setActiveTab("playground");
    setPrefillRequest((prev) => ({
      actionId,
      formValues,
      seq: (prev?.seq || 0) + 1,
    }));
  };

  const handleSelectModuleFile = async (file: string) => {
    if (!selectedSkill) return;
    setSelectedModuleFile(file);
    setManifestSaveStatus(null);
    if (file === "__merged__") {
      setManifestYamlText(YAML.stringify(selectedSkill.manifest, { indent: 2 }));
      return;
    }
    const res = await fetch(
      `/api/skills/${encodeURIComponent(selectedSkill.id)}/manifest-module?file=${encodeURIComponent(file)}`
    );
    const data = await res.json();
    if (res.ok && typeof data.content === "string") {
      setManifestYamlText(data.content);
    }
  };

  const handleSaveManifest = async () => {
    if (!selectedSkill || selectedModuleFile === "__merged__") return;
    setManifestSaveStatus(null);
    try {
      if (manifestSaveLayer === "companion") {
        const res = await fetch(
          `/api/skills/${encodeURIComponent(selectedSkill.id)}/manifest-module`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              file: selectedModuleFile,
              content: manifestYamlText,
            }),
          }
        );
        const data = await res.json();
        if (res.ok && data.skill) {
          setSkills((prev) => prev.map((s) => (s.id === selectedSkill.id ? data.skill : s)));
          setManifestSaveStatus(`Saved module to ${data.savedPath}`);
        } else {
          setManifestSaveStatus(`Error: ${data.error}`);
        }
        return;
      }

      const parsed = YAML.parse(manifestYamlText);
      const res = await fetch(
        `/api/skills/${encodeURIComponent(selectedSkill.id)}/manifest`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            layer: manifestSaveLayer,
            manifest: parsed,
          }),
        }
      );
      const data = await res.json();
      if (res.ok && data.skill) {
        setSkills((prev) => prev.map((s) => (s.id === selectedSkill.id ? data.skill : s)));
        setManifestSaveStatus(`Saved to ${data.savedPath}`);
      } else {
        setManifestSaveStatus(`Error: ${data.error}`);
      }
    } catch (err: any) {
      setManifestSaveStatus(`YAML Error: ${err.message}`);
    }
  };

  const primaryMountTargets = agentTargets.filter(
    (t) => t.canToggleMount && t.primaryToggle && t.agent !== "agents-hub"
  );
  const secondaryMountTargets = agentTargets.filter(
    (t) => t.canToggleMount && !t.primaryToggle
  );

  return (
    /* Issue 10: Fixed Full-Viewport h-screen overflow-hidden Flex Layout so Left & Right Scroll Independently */
    <div className="h-screen overflow-hidden st-app flex flex-col transition-colors">
      {/* Top Studio Header (shrink-0) */}
      <header className="h-14 px-5 st-header border-b st-border flex items-center justify-between gap-4 shrink-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center shadow-sm">
            <Boxes className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <span className="font-bold text-base tracking-tight st-text-primary">
                Skill Dashboard Studio
              </span>
              <span className="px-2 py-0.5 rounded-full text-xs font-mono st-badge-accent">
                {skills.length} Skills
              </span>
            </div>
          </div>
        </div>

        {/* Center/Right: Per-Skill Workspace + Python + Env Config + Theme Switcher */}
        <div className="flex items-center gap-2 flex-wrap">
          {brokenMounts.length > 0 && (
            <button
              onClick={() => setBrokenModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-rose-500/15 hover:bg-rose-500/25 text-rose-600 dark:text-rose-300 border border-rose-500/30 transition-colors"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{brokenMounts.length} Broken Mounts</span>
            </button>
          )}

          {/* Per-Skill Bound Workspace Switcher (Issue 09) */}
          <button
            onClick={() => {
              setCustomWorkspaceInput(effectiveWorkspace);
              setWorkspaceModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl st-btn-secondary text-xs transition-colors"
            title={`Bound Workspace for ${selectedSkill?.id || "skill"}: ${effectiveWorkspace}`}
          >
            <FolderGit2 className="w-3.5 h-3.5 text-sky-500" />
            <span className="st-text-muted">{selectedSkill?.id} cwd:</span>
            <span className="font-mono font-semibold st-text-primary max-w-[200px] truncate">
              {effectiveWorkspace.split("/").slice(-2).join("/")}
            </span>
          </button>

          {/* Python Runtime Pill */}
          <div
            className="hidden xl:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl st-subcard text-xs font-mono text-emerald-700 dark:text-emerald-300"
            title={`Live Resolved {{python}}: ${effectivePython}`}
          >
            <Cpu className="w-3.5 h-3.5 text-emerald-500" />
            <span>{effectivePython.includes(".venv") ? ".venv/bin/python" : effectivePython}</span>
          </div>

          {/* Per-Skill Env Config Button (Issue 11) */}
          <button
            onClick={() => setEnvModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl st-btn-secondary text-xs font-semibold"
            title="Configure Environment Variables for this Skill"
          >
            <KeyRound className="w-3.5 h-3.5 text-amber-500" />
            <span>Env ({Object.keys(selectedSkill?.configuredEnv || {}).length})</span>
          </button>

          {/* Quick Interactive Shell Button in Header (Issue 08) */}
          <button
            onClick={handleStartInteractiveShell}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm"
            title="Open an interactive zsh shell in this skill's workspace"
          >
            <Terminal className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Shell</span>
          </button>

          {/* Eye-Comfort Theme Switcher */}
          <button
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl st-btn-secondary text-xs font-semibold"
            title="Switch between Warm Daylight (Paper Light) and Soft Slate (Low-Glare Dark)"
          >
            {theme === "light" ? (
              <>
                <Sun className="w-3.5 h-3.5 text-amber-500" />
                <span className="hidden md:inline">Warm Light</span>
              </>
            ) : (
              <>
                <Moon className="w-3.5 h-3.5 text-sky-400" />
                <span className="hidden md:inline">Soft Dark</span>
              </>
            )}
          </button>

          <button
            onClick={handleGlobalRefresh}
            className="p-1.5 rounded-xl st-btn-secondary"
            title="Refresh skills, manifest & all live data nodes"
          >
            <RefreshCw
              className={`w-4 h-4 ${isRefreshingAll ? "animate-spin text-sky-500" : ""}`}
            />
          </button>
        </div>
      </header>

      {/* Middle Split Area: flex-1 min-h-0 overflow-hidden guarantees independent left/right scrolling! */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Left Sidebar: Pinned Search Header + Independently Scrollable Skill List */}
        <aside className="w-80 shrink-0 border-r st-border st-sidebar flex flex-col h-full overflow-hidden">
          <div className="p-3.5 border-b st-border flex flex-col gap-2.5 shrink-0">
            <div className="relative">
              <Search className="w-4 h-4 st-text-muted absolute left-3 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search skills, commands, tags..."
                className="w-full pl-9 pr-3 py-2 rounded-xl st-input text-[13px] focus:outline-none focus:border-sky-500"
              />
            </div>

            {/* Accurate Ecosystem Filter Pills (Issue 06) */}
            <div className="flex items-center gap-1 overflow-x-auto pb-0.5 no-scrollbar">
              {[
                { id: "all", label: "All" },
                { id: "claude", label: "Claude" },
                { id: "codex", label: "Codex" },
                { id: "opencode", label: "OpenCode" },
                { id: "pi", label: "Pi" },
                { id: "openclaw", label: "OpenClaw" },
                { id: "claude-workspace", label: "Project" },
              ].map((eco) => (
                <button
                  key={eco.id}
                  onClick={() => setSelectedAgentFilter(eco.id)}
                  className={`px-2 py-1 rounded-lg text-xs font-semibold shrink-0 transition-colors ${
                    selectedAgentFilter === eco.id
                      ? "bg-sky-600 text-white shadow-sm"
                      : "st-btn-secondary"
                  }`}
                >
                  {eco.label}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5">
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="flex-1 px-2.5 py-1.5 rounded-xl st-input text-xs font-medium min-w-0"
              >
                {categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat === "all" ? "All Categories" : cat}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={handleUpdateAllSkills}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold st-btn-secondary shrink-0"
                title="Run npx skills update -g -y to update all global community skills"
              >
                <ArrowUpCircle className="w-3.5 h-3.5 text-sky-500" />
                <span>Update All</span>
              </button>
            </div>

            {/* Issue 14: Collapsible Tag Filter Bar in Sidebar (Collapsed by Default) */}
            {tagCounts.length > 0 && (
              <div className="flex flex-col gap-1.5 pt-1 border-t st-border">
                <div className="flex items-center justify-between text-[11px] st-text-muted px-0.5">
                  <button
                    type="button"
                    onClick={() => setShowAllTags(!showAllTags)}
                    className="inline-flex items-center gap-1 font-semibold hover:st-text-primary transition-colors"
                  >
                    {showAllTags ? (
                      <ChevronDown className="w-3.5 h-3.5 text-sky-500" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-sky-500" />
                    )}
                    <Tag className="w-3 h-3 text-sky-500" />
                    <span>
                      Tags ({tagCounts.length}) · {filteredSkills.length}/{skills.length}
                    </span>
                  </button>
                  <div className="flex items-center gap-2">
                    {selectedTag && (
                      <button
                        type="button"
                        onClick={() => setSelectedTag(null)}
                        className="px-1.5 py-0.5 rounded bg-sky-600 text-white font-mono text-[10.5px] font-semibold inline-flex items-center gap-1 shadow-sm hover:bg-rose-600 transition-colors"
                        title="Click to clear active tag filter"
                      >
                        <span>#{selectedTag}</span>
                        <X className="w-3 h-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setShowAllTags(!showAllTags)}
                      className="hover:st-text-primary"
                    >
                      {showAllTags ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>
                {showAllTags && (
                  <div className="flex items-center gap-1 flex-wrap max-h-36 overflow-y-auto overscroll-contain pr-0.5 pt-0.5">
                    {tagCounts.map(([tag, count]) => {
                      const active = selectedTag === tag;
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => setSelectedTag(active ? null : tag)}
                          className={`px-2 py-0.5 rounded-md text-[11px] font-mono transition-all ${
                            active
                              ? "bg-sky-600 text-white font-semibold shadow-sm"
                              : "st-pill hover:border-sky-500/50"
                          }`}
                        >
                          #{tag} <span className="opacity-70">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Independently Scrollable 3-Tier Unit Catalog (Scratchpads / Workspaces / Skills) */}
          <div className="flex-1 overflow-y-auto overscroll-contain p-2.5 space-y-3">
            {[
              {
                kind: "scratchpad" as const,
                title: "⚡ Scratchpads (Agent HITL)",
                items: filteredSkills.filter((s) => s.unitKind === "scratchpad"),
                hideIfEmpty: true,
              },
              {
                kind: "workspace" as const,
                title: "📁 Managed Workspaces",
                items: filteredSkills.filter((s) => s.unitKind === "workspace"),
                hideIfEmpty: false,
              },
              {
                kind: "skill" as const,
                title: "🧩 Agent Skills",
                items: filteredSkills.filter((s) => !s.unitKind || s.unitKind === "skill"),
                hideIfEmpty: false,
              },
            ].map((section) => {
              if (section.hideIfEmpty && section.items.length === 0) return null;
              return (
                <div key={section.kind} className="space-y-1">
                  <div className="flex items-center justify-between px-2 py-1 text-[11px] font-bold uppercase tracking-wider st-text-muted">
                    <span>
                      {section.title} ({section.items.length})
                    </span>
                    {section.kind === "workspace" && (
                      <button
                        type="button"
                        onClick={() => {
                          setNewFolderInput(effectiveWorkspace);
                          setAddFolderModalOpen(true);
                        }}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-[10.5px] font-semibold normal-case shadow-sm"
                        title="Add a local folder to Managed Workspaces"
                      >
                        <Plus className="w-3 h-3" />
                        <span>Add Folder</span>
                      </button>
                    )}
                  </div>

                  {section.items.length === 0 && section.kind === "workspace" && (
                    <div className="px-3 py-2 rounded-xl st-subcard text-[11.5px] st-text-muted flex items-center justify-between">
                      <span>No folders added yet.</span>
                      <button
                        type="button"
                        onClick={() => {
                          setNewFolderInput(effectiveWorkspace);
                          setAddFolderModalOpen(true);
                        }}
                        className="text-sky-500 font-semibold hover:underline"
                      >
                        + Add Folder
                      </button>
                    </div>
                  )}

                  {section.items.map((skill) => {
                    const selected = selectedSkill?.id === skill.id;
                    const actionCount = skill.manifest.actionGroups.reduce(
                      (acc, g) => acc + g.actions.length,
                      0
                    );
                    const isClaudeMounted = skill.mounts.some((m) => m.agent === "claude");

                    return (
                      <button
                        key={skill.id}
                        onClick={() => setSelectedSkillId(skill.id)}
                        className={`w-full text-left p-3 rounded-xl transition-all flex flex-col gap-1.5 border ${
                          selected
                            ? "st-skill-item-active shadow-sm"
                            : "border-transparent hover:st-surface-muted"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            {skill.manifest.icon &&
                            (skill.manifest.icon.endsWith(".svg") ||
                              skill.manifest.icon.endsWith(".png")) ? (
                              <img
                                src={`/api/assets?skill=${encodeURIComponent(skill.id)}&path=${encodeURIComponent(skill.manifest.icon)}`}
                                alt=""
                                className="w-5 h-5 rounded object-contain shrink-0"
                              />
                            ) : (
                              (() => {
                                const { Icon, colorClass } = getSemanticSkillIconMeta(skill);
                                return <Icon className={`w-4 h-4 shrink-0 ${colorClass}`} />;
                              })()
                            )}
                            <span className="font-bold text-[14px] st-text-primary truncate">
                              {skill.manifest.name}
                            </span>
                            {skill.unitKind === "scratchpad" && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-500/30 shrink-0">
                                {skill.projectSlug ? `PAD:${skill.projectSlug}` : "PAD"}
                              </span>
                            )}
                            {skill.layers.companion && (
                              <span
                                className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 shrink-0"
                                title="Configured with .dashboard/manifest.yaml"
                              >
                                Studio
                              </span>
                            )}
                          </div>
                          <span className="text-xs font-mono st-text-muted shrink-0">
                            {actionCount} act
                          </span>
                        </div>

                        <p className="text-[12.5px] st-text-secondary line-clamp-2 leading-relaxed">
                          {skill.manifest.description}
                        </p>

                        {/* Clean Mount Summary & Clickable Tag Pills */}
                        <div className="flex items-center gap-1 flex-wrap pt-0.5">
                          {isClaudeMounted && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium st-pill">
                              Claude
                            </span>
                          )}
                          {(skill.manifest.tags || []).slice(0, 3).map((tag) => {
                            const clean = tag.toLowerCase();
                            const isTagActive = selectedTag === clean;
                            return (
                              <span
                                key={clean}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedTag(isTagActive ? null : clean);
                                }}
                                className={`px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer transition-colors ${
                                  isTagActive
                                    ? "bg-sky-600 text-white font-semibold"
                                    : "st-badge-accent hover:opacity-80"
                                }`}
                                title={`Filter by #${clean}`}
                              >
                                #{clean}
                              </span>
                            );
                          })}
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </aside>

        {/* Right Main Detail Workspace: Independently Scrollable Container */}
        <main
          data-agent-pick-mode={agentPickMode ? "true" : "false"}
          onClickCapture={handleMainClickCapture}
          className="flex-1 min-w-0 h-full overflow-y-auto overscroll-contain p-6 sm:p-8"
        >
          {agentPickMode && (
            <style>{`
              [data-agent-pick-mode="true"] [data-sd-pick-kind] {
                cursor: crosshair !important;
                transition: outline 120ms ease, box-shadow 120ms ease;
              }
              [data-agent-pick-mode="true"] [data-sd-pick-kind]:hover {
                outline: 2px dashed #f59e0b !important;
                outline-offset: 2px;
                box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.14) !important;
              }
            `}</style>
          )}
          {selectedSkill ? (
            <div className="max-w-7xl mx-auto flex flex-col gap-6 pb-8">
              {/* Skill Hero Card */}
              <div className="st-card rounded-2xl p-6 flex flex-col gap-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex items-start gap-4">
                    {selectedSkill.manifest.icon &&
                    (selectedSkill.manifest.icon.endsWith(".svg") ||
                      selectedSkill.manifest.icon.endsWith(".png")) ? (
                      <img
                        src={`/api/assets?skill=${encodeURIComponent(selectedSkill.id)}&path=${encodeURIComponent(selectedSkill.manifest.icon)}`}
                        alt={selectedSkill.manifest.name}
                        className="w-14 h-14 rounded-2xl st-subcard p-2.5 object-contain shrink-0"
                      />
                    ) : (
                      (() => {
                        const { Icon, colorClass, bgClass } = getSemanticSkillIconMeta(selectedSkill);
                        return (
                          <div
                            className={`w-14 h-14 rounded-2xl border flex items-center justify-center shrink-0 ${bgClass}`}
                          >
                            <Icon className={`w-7 h-7 ${colorClass}`} />
                          </div>
                        );
                      })()
                    )}

                    <div>
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <h1 className="text-2xl font-bold st-text-primary">
                          {selectedSkill.manifest.name}
                        </h1>
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-mono st-pill">
                          {selectedSkill.id}
                        </span>
                        <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold st-badge-accent">
                          {selectedSkill.manifest.category}
                        </span>
                      </div>
                      <p className="text-[14px] st-text-secondary mt-2 max-w-4xl leading-relaxed">
                        {selectedSkill.manifest.description}
                      </p>

                      {/* Clickable Skill Tags Row in Hero */}
                      {selectedSkill.manifest.tags && selectedSkill.manifest.tags.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap mt-2.5">
                          {selectedSkill.manifest.tags.map((tag) => {
                            const clean = tag.toLowerCase();
                            const isTagActive = selectedTag === clean;
                            return (
                              <button
                                key={clean}
                                type="button"
                                onClick={() => setSelectedTag(isTagActive ? null : clean)}
                                className={`px-2 py-0.5 rounded-md text-xs font-mono transition-colors ${
                                  isTagActive
                                    ? "bg-sky-600 text-white font-semibold"
                                    : "st-pill hover:border-sky-500/50"
                                }`}
                                title={`Click to filter sidebar by #${clean}`}
                              >
                                #{clean}
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* Per-Skill Workspace & Path Info */}
                      <div className="flex items-center gap-3 mt-2.5 text-xs font-mono st-text-muted flex-wrap">
                        <span>Skill Path: {selectedSkill.canonicalPath}</span>
                        <span>·</span>
                        <button
                          type="button"
                          onClick={() => {
                            setCustomWorkspaceInput(effectiveWorkspace);
                            setWorkspaceModalOpen(true);
                          }}
                          className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400 hover:underline font-semibold"
                        >
                          <FolderGit2 className="w-3.5 h-3.5" />
                          <span>Workspace: {effectiveWorkspace}</span>
                        </button>
                        {selectedSkill.provenance && (
                          <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-medium">
                            <GitBranch className="w-3.5 h-3.5" />
                            <span>{selectedSkill.provenance.source}</span>
                            {selectedSkill.provenance.skillFolderHash && (
                              <span className="st-text-muted">
                                ({selectedSkill.provenance.skillFolderHash.slice(0, 7)})
                              </span>
                            )}
                            {selectedSkill.provenance.updatedAt && (
                              <span className="st-text-muted">
                                · Updated {selectedSkill.provenance.updatedAt.slice(0, 10)}
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right Hero Controls: Scratchpad Promote / Workspace Remove / Upstream Update + Agent Manifest Sync + Cascade Status */}
                  <div className="flex flex-col items-end gap-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      {selectedSkill.unitKind === "scratchpad" && (
                        <>
                          <button
                            type="button"
                            onClick={() => setPromoteModalOpen(true)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-sm transition-colors"
                            title="Promote this ephemeral Scratchpad into the bound project's .dashboard/ or a global Skill"
                          >
                            <Sparkles className="w-3.5 h-3.5" />
                            <span>🌟 Promote Scratchpad</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteScratchpad(selectedSkill.id)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-medium bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30 hover:bg-rose-500/25"
                            title="Delete this ephemeral scratchpad"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Discard</span>
                          </button>
                        </>
                      )}

                      {selectedSkill.unitKind === "workspace" && (
                        <button
                          type="button"
                          onClick={() => handleRemoveManagedFolder(selectedSkill.canonicalPath)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-medium st-btn-secondary text-rose-500"
                          title="Unregister folder from Managed Workspaces (keeps files on disk)"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Unmanage Folder</span>
                        </button>
                      )}

                      {(selectedSkill.updateStrategy === "npx-lock" ||
                        selectedSkill.updateStrategy === "git") &&
                        (!selectedSkill.unitKind || selectedSkill.unitKind === "skill") && (
                        <button
                          type="button"
                          onClick={() => handleUpdateSkill(selectedSkill.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white shadow-sm transition-colors"
                          title={
                            selectedSkill.updateStrategy === "npx-lock"
                              ? `Run npx skills update ${selectedSkill.id} -g -y (preserves .dashboard/)`
                              : "Run git pull --ff-only (preserves .dashboard/)"
                          }
                        >
                          <ArrowUpCircle className="w-3.5 h-3.5" />
                          <span>Update Skill</span>
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setAgentDrawerOpen((v) => !v)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                          agentDrawerOpen || pinnedFixTargets.length > 0
                            ? "bg-amber-500 text-slate-950 shadow-sm"
                            : "st-badge-accent hover:opacity-90"
                        }`}
                        title="Open the bottom-right Fix / Ask Agent drawer to pick targets on the page and summon Claude or Codex"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>
                          🤖 Fix / Ask Agent
                          {pinnedFixTargets.length > 0 ? ` (${pinnedFixTargets.length})` : ""}
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleAgentSyncManifest("copy")}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-medium st-btn-secondary"
                        title="Copy targeted fix / sync prompt for your active Claude/Codex session"
                      >
                        {copiedAgentSync ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                        <span>{copiedAgentSync ? "Prompt Copied" : "Copy Fix Prompt"}</span>
                      </button>
                    </div>

                    <div className="flex items-center gap-1.5 text-xs st-text-muted">
                      <Layers className="w-3.5 h-3.5" />
                      <span>Cascade:</span>
                      <span className="px-2 py-0.5 rounded st-pill font-mono">L0:Auto</span>
                      {selectedSkill.layers.companion && (
                        <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 font-mono font-semibold">
                          L1:.dashboard
                        </span>
                      )}
                      {selectedSkill.layers.globalOverride && (
                        <span className="px-2 py-0.5 rounded st-badge-accent font-mono">
                          L2:Global
                        </span>
                      )}
                      {selectedSkill.layers.workspaceOverride && (
                        <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 font-mono">
                          L3:Workspace
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Issue 06: Accurate Multi-Agent Ecosystem Mount Bar */}
                <div className="pt-3.5 border-t st-border flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold st-text-secondary flex items-center gap-1.5 mr-1">
                        <Link2 className="w-4 h-4 text-sky-500" />
                        Agent Ecosystem Mounts:
                      </span>

                      {/* 1. Universal Hub Status (Auto-loads in Codex, OpenCode, Pi) */}
                      {selectedSkill.inAgentsHub ? (
                        <span
                          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/35"
                          title="Located in ~/.agents/skills — automatically loaded by Codex, OpenCode, and Pi without extra symlinks"
                        >
                          <Check className="w-3.5 h-3.5 text-sky-500" />
                          <span>Auto-Loaded via ~/.agents: Codex · OpenCode · Pi</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            handleToggleMount(selectedSkill.id, "agents-hub", true)
                          }
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium st-btn-secondary"
                          title="Symlink into ~/.agents/skills so Codex, OpenCode, and Pi auto-load this skill"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Link to ~/.agents (Codex·OpenCode·Pi)</span>
                        </button>
                      )}

                      {/* 2. Primary Symlink Toggle Targets (Claude Code, OpenClaw, Project .claude/skills) */}
                      {primaryMountTargets.map((target) => {
                        const isMounted = selectedSkill.mounts.some(
                          (m) => m.agent === target.agent
                        );
                        return (
                          <button
                            key={target.agent}
                            type="button"
                            onClick={() =>
                              handleToggleMount(selectedSkill.id, target.agent, !isMounted)
                            }
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${
                              isMounted
                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40"
                                : "st-btn-secondary opacity-75 hover:opacity-100"
                            }`}
                            title={
                              isMounted
                                ? `Symlinked in ${target.path} (Click to unmount)`
                                : `Click to create relative symlink in ${target.path}`
                            }
                          >
                            <span
                              className={`w-2 h-2 rounded-full ${
                                isMounted ? "bg-emerald-500" : "bg-slate-400"
                              }`}
                            />
                            <span>{target.label}</span>
                          </button>
                        );
                      })}

                      {/* 3. Collapsible + More Targets (Continue, Trae, Dedicated overrides) */}
                      {secondaryMountTargets.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowMoreMounts(!showMoreMounts)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs st-text-muted hover:st-text-primary"
                        >
                          <span>{showMoreMounts ? "Hide extra targets" : "+ More targets"}</span>
                          {showMoreMounts ? (
                            <ChevronDown className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronRight className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>

                  {showMoreMounts && secondaryMountTargets.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap pt-1 pl-4 border-l-2 st-border">
                      <span className="text-[11px] st-text-muted">Dedicated / Secondary dirs:</span>
                      {secondaryMountTargets.map((target) => {
                        const isMounted = selectedSkill.mounts.some(
                          (m) => m.agent === target.agent
                        );
                        return (
                          <button
                            key={target.agent}
                            type="button"
                            onClick={() =>
                              handleToggleMount(selectedSkill.id, target.agent, !isMounted)
                            }
                            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs border transition-all ${
                              isMounted
                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40 font-semibold"
                                : "st-btn-secondary opacity-70"
                            }`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                isMounted ? "bg-emerald-500" : "bg-slate-400"
                              }`}
                            />
                            <span>{target.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Agent HITL Feedback / Decision Submission Bar (Available on any unit; wakes up `manifest-cli wait <id>`) */}
                <div className="pt-3 border-t st-border flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-bold text-amber-600 dark:text-amber-400">
                      ⚡ Agent HITL Sync:
                    </span>
                    <span className="st-text-secondary">
                      Submit approval or notes to wake up a waiting CLI Agent (`manifest-cli wait {selectedSkill.id}`).
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-1 max-w-xl justify-end">
                    <input
                      type="text"
                      value={decisionNoteInput}
                      onChange={(e) => setDecisionNoteInput(e.target.value)}
                      placeholder="Optional decision note or parameters for Agent..."
                      className="flex-1 px-3 py-1.5 rounded-xl st-input text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => handleSubmitDecisionToAgent("approved")}
                      className="px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shrink-0"
                    >
                      ✅ Approve & Resume Agent
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSubmitDecisionToAgent("rejected")}
                      className="px-2.5 py-1.5 rounded-xl bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/30 text-xs font-semibold shrink-0"
                    >
                      Reject
                    </button>
                  </div>
                  {decisionSentBanner && (
                    <div className="w-full px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs font-mono">
                      {decisionSentBanner}
                    </div>
                  )}
                </div>
              </div>

              {/* Navigation Tabs */}
              <div className="flex items-center gap-2 border-b st-border">
                {[
                  {
                    id: "playground" as const,
                    label: `Operations Playground (${selectedSkill.manifest.actionGroups.reduce((a, g) => a + g.actions.length, 0)})`,
                    icon: Play,
                  },
                  {
                    id: "docs" as const,
                    label: `Knowledge & Docs (${selectedSkill.manifest.views.length})`,
                    icon: BookOpen,
                  },
                  {
                    id: "files" as const,
                    label: "File Tree Inspector",
                    icon: Folder,
                  },
                  {
                    id: "manifest" as const,
                    label: "Manifest Studio (.dashboard)",
                    icon: Sliders,
                  },
                ].map((tab) => {
                  const Icon = tab.icon;
                  const active = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`flex items-center gap-2 px-4 py-3 text-[13.5px] font-bold border-b-2 transition-colors ${
                        active
                          ? "border-sky-600 text-sky-600 dark:text-sky-400 st-surface-muted rounded-t-xl"
                          : "border-transparent st-text-secondary hover:st-text-primary"
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Tab 1: Adaptive Multi-Level Operations Playground */}
              {activeTab === "playground" && (
                <MultiLevelPlayground
                  skillId={selectedSkill.id}
                  contextFields={selectedSkill.manifest.context || []}
                  dataNodes={selectedSkill.manifest.data || []}
                  actionGroups={selectedSkill.manifest.actionGroups}
                  activeWorkspace={effectiveWorkspace}
                  refreshTrigger={refreshTrigger}
                  prefillRequest={prefillRequest}
                  onPrefillJump={handlePrefillActionJump}
                  onContextChanged={() => setRefreshTrigger((prev) => prev + 1)}
                  onExecute={(p) => handleExecuteAction(p)}
                />
              )}

              {/* Tab 2: Knowledge, Docs & Custom HTML App Views */}
              {activeTab === "docs" && (
                <MarkdownViewer
                  skillId={selectedSkill.id}
                  skillName={selectedSkill.manifest.name}
                  views={selectedSkill.manifest.views}
                  initialViewId={deepLinkViewId}
                  activeWorkspace={effectiveWorkspace}
                  pythonExecutable={effectivePython}
                  configuredEnv={selectedSkill.configuredEnv || {}}
                  theme={theme}
                  refreshTrigger={refreshTrigger}
                  onContextChanged={() => setRefreshTrigger((prev) => prev + 1)}
                  onExecuteActionById={async (p) => {
                    const targetAction = selectedSkill.manifest.actionGroups
                      .flatMap((g) => [
                        ...(g.actions || []),
                        ...(g.subgroups ? g.subgroups.flatMap((sg) => sg.actions) : []),
                      ])
                      .find((a) => a.id === p.actionId);
                    if (
                      targetAction &&
                      (targetAction.danger === "warn" ||
                        targetAction.danger === "danger" ||
                        Boolean(targetAction.requiresHumanApprovalFlag)) &&
                      !p.humanApproved
                    ) {
                      handlePrefillActionJump(p.actionId, p.formValues || {});
                      return;
                    }
                    await handleExecuteAction(p);
                  }}
                  onPrefillActionJump={handlePrefillActionJump}
                  onExecuteAdHoc={(p) => handleExecuteAction(p)}
                />
              )}

              {/* Tab 3: Hierarchical Indented File Tree Inspector + ../ Navigation */}
              {activeTab === "files" && (
                <FileTreeInspector
                  skillId={selectedSkill.id}
                  activeWorkspace={effectiveWorkspace}
                  onExecuteAdHoc={(p) => handleExecuteAction(p)}
                />
              )}

              {/* Tab 4: Manifest Studio */}
              {activeTab === "manifest" && (
                <div className="st-card rounded-2xl p-6 flex flex-col gap-4">
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div>
                      <h3 className="text-base font-bold st-text-primary flex items-center gap-2">
                        <Code2 className="w-4 h-4 text-sky-500" />
                        Bidirectional Manifest Editor (`manifest.yaml`)
                      </h3>
                      <p className="text-xs st-text-secondary mt-0.5">
                        Edit or materialize the auto-inferred schema into `.dashboard/manifest.yaml`
                        or an override layer.
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <select
                        value={manifestSaveLayer}
                        onChange={(e) => setManifestSaveLayer(e.target.value as any)}
                        className="px-3 py-2 rounded-xl st-input text-xs"
                      >
                        <option value="companion">
                          Layer 1: Companion ({selectedSkill.id}/.dashboard/manifest.yaml)
                        </option>
                        <option value="global">
                          Layer 2: Global Override (~/.claude/skill-dashboard/configs/...)
                        </option>
                        <option value="workspace">
                          Layer 3: Workspace Override (.claude/skill-dashboard/configs/...)
                        </option>
                      </select>

                      <button
                        onClick={handleSaveManifest}
                        disabled={selectedModuleFile === "__merged__"}
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold shadow-sm"
                      >
                        <Save className="w-3.5 h-3.5" />
                        Save {selectedModuleFile === "__merged__" ? "Bundle (Read-Only)" : selectedModuleFile}
                      </button>
                    </div>
                  </div>

                  {/* Module File Selector Bar (Prevents flattening modular .dashboard/ files) */}
                  {(selectedSkill.layers.moduleFiles?.length || 0) > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t st-border">
                      <span className="text-[11px] font-mono uppercase tracking-wider st-text-muted mr-1">
                        Modules:
                      </span>
                      {(selectedSkill.layers.moduleFiles || ["manifest.yaml"]).map((modFile) => (
                        <button
                          key={modFile}
                          type="button"
                          onClick={() => handleSelectModuleFile(modFile)}
                          className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors ${
                            selectedModuleFile === modFile
                              ? "bg-sky-600 text-white font-semibold"
                              : "st-pill hover:border-sky-500/50"
                          }`}
                        >
                          {modFile}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => handleSelectModuleFile("__merged__")}
                        className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors ${
                          selectedModuleFile === "__merged__"
                            ? "bg-indigo-600 text-white font-semibold"
                            : "st-pill hover:border-indigo-500/50"
                        }`}
                      >
                        🔍 Linked Bundle (Read-Only Preview)
                      </button>
                    </div>
                  )}

                  {manifestSaveStatus && (
                    <div className="px-3.5 py-2 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-xs font-mono text-emerald-700 dark:text-emerald-300">
                      {manifestSaveStatus}
                    </div>
                  )}

                  <textarea
                    rows={22}
                    value={manifestYamlText}
                    onChange={(e) => setManifestYamlText(e.target.value)}
                    className="w-full p-4 rounded-xl st-code-surface border st-border font-mono text-[13px] focus:outline-none focus:border-sky-500 leading-relaxed"
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="p-12 text-center st-text-muted">Select a skill from the sidebar.</div>
          )}
        </main>
      </div>

      {/* Per-Skill Workspace Switcher Modal (Issue 09) */}
      {workspaceModalOpen && selectedSkill && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-lg w-full rounded-2xl st-card p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold st-text-primary flex items-center gap-2">
                <FolderGit2 className="w-4 h-4 text-sky-500" />
                Default Workspace for `{selectedSkill.manifest.name}`
              </h3>
              <button
                onClick={() => setWorkspaceModalOpen(false)}
                className="text-xs st-text-secondary hover:st-text-primary"
              >
                Close
              </button>
            </div>
            <p className="text-xs st-text-secondary">
              Each skill remembers its own independent default workspace (`&#123;&#123;project_root&#125;&#125;` and `.venv/bin/python`).
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={customWorkspaceInput}
                onChange={(e) => setCustomWorkspaceInput(e.target.value)}
                className="flex-1 px-3 py-2 rounded-xl st-input text-xs font-mono"
              />
              <button
                onClick={() => handleSwitchWorkspace(customWorkspaceInput, true)}
                className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shrink-0"
              >
                Bind to {selectedSkill.id}
              </button>
            </div>
            <label className="flex items-center gap-2 text-xs st-text-secondary cursor-pointer select-none">
              <input
                type="checkbox"
                checked={saveWsToManifest}
                onChange={(e) => setSaveWsToManifest(e.target.checked)}
                className="w-3.5 h-3.5 accent-sky-600 rounded"
              />
              <span>Also write `defaultWorkspace` into `{selectedSkill.id}/.dashboard/manifest.yaml`</span>
            </label>
            <div className="max-h-60 overflow-y-auto space-y-1 border-t st-border pt-2">
              {recentWorkspaces.map((ws) => (
                <button
                  key={ws}
                  onClick={() => handleSwitchWorkspace(ws, true)}
                  className={`w-full text-left px-3 py-2 rounded-xl text-xs font-mono flex items-center justify-between ${
                    ws === effectiveWorkspace
                      ? "bg-sky-500/15 text-sky-600 dark:text-sky-300 border border-sky-500/30 font-semibold"
                      : "hover:st-surface-muted st-text-primary"
                  }`}
                >
                  <span className="truncate">{ws}</span>
                  {ws === effectiveWorkspace && <Check className="w-3.5 h-3.5 shrink-0" />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Per-Skill Environment Variable Configuration Modal (Issue 11) */}
      {envModalOpen && selectedSkill && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-xl w-full rounded-2xl st-card p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold st-text-primary flex items-center gap-2">
                <Settings2 className="w-4 h-4 text-amber-500" />
                Environment Variables for `{selectedSkill.manifest.name}`
              </h3>
              <button
                onClick={() => setEnvModalOpen(false)}
                className="text-xs st-text-secondary hover:st-text-primary"
              >
                Close
              </button>
            </div>
            <p className="text-xs st-text-secondary">
              Variables configured here are persisted for `{selectedSkill.id}` and automatically injected into all Web PTY actions and Interactive Shell sessions.
            </p>

            <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
              {envPairs.map((pair, idx) => {
                const declaredMeta = (selectedSkill.manifest.envVars || []).find(
                  (e) => e.key === pair.key
                );
                const isSecret =
                  declaredMeta?.secret || /SECRET|TOKEN|PASSWORD|KEY/i.test(pair.key);

                return (
                  <div key={idx} className="st-subcard p-3 rounded-xl flex flex-col gap-1.5">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={pair.key}
                        placeholder="ENV_KEY"
                        onChange={(e) => {
                          const next = [...envPairs];
                          next[idx] = { ...pair, key: e.target.value };
                          setEnvPairs(next);
                        }}
                        className="w-44 px-2.5 py-1.5 rounded-lg st-input text-xs font-mono font-bold"
                      />
                      <span className="st-text-muted font-mono">=</span>
                      <input
                        type={isSecret ? "password" : "text"}
                        value={pair.value}
                        placeholder={declaredMeta?.placeholder || "value"}
                        onChange={(e) => {
                          const next = [...envPairs];
                          next[idx] = { ...pair, value: e.target.value };
                          setEnvPairs(next);
                        }}
                        className="flex-1 px-2.5 py-1.5 rounded-lg st-input text-xs font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setEnvPairs(envPairs.filter((_, i) => i !== idx))}
                        className="p-1.5 text-rose-500 hover:bg-rose-500/10 rounded-lg"
                        title="Remove variable"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {declaredMeta?.description && (
                      <div className="text-[11px] st-text-muted pl-1">
                        {declaredMeta.description}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {envSaveStatus && (
              <div className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs font-mono">
                {envSaveStatus}
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t st-border">
              <button
                type="button"
                onClick={() => setEnvPairs([...envPairs, { key: "", value: "" }])}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold st-btn-secondary"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Variable</span>
              </button>

              <button
                type="button"
                onClick={handleSaveSkillEnv}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm"
              >
                <Save className="w-3.5 h-3.5" />
                <span>Save Environment</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Broken Mounts Repair Modal */}
      {brokenModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-xl w-full rounded-2xl st-card p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-rose-500 flex items-center gap-2">
                <Link2Off className="w-4 h-4" />
                Broken Skill Symlinks Detected ({brokenMounts.length})
              </h3>
              <button
                onClick={() => setBrokenModalOpen(false)}
                className="text-xs st-text-secondary hover:st-text-primary"
              >
                Close
              </button>
            </div>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {brokenMounts.map((bm) => (
                <div
                  key={bm.mountPath}
                  className="p-3.5 rounded-xl st-subcard flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-bold st-text-primary">
                      {bm.skillName} <span className="st-text-muted">({bm.agent})</span>
                    </div>
                    <div className="text-[11.5px] font-mono st-text-secondary truncate">
                      {bm.mountPath} → {bm.targetPath || "missing"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {bm.suggestedRepairPath && (
                      <button
                        onClick={() => handleRepairMount(bm.mountPath, "relink")}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
                      >
                        <Wrench className="w-3 h-3" />
                        Relink to Hub
                      </button>
                    )}
                    <button
                      onClick={() => handleRepairMount(bm.mountPath, "remove")}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-medium"
                    >
                      <Trash2 className="w-3 h-3" />
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Add Managed Folder Modal */}
      {addFolderModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-lg w-full rounded-2xl st-card p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold st-text-primary flex items-center gap-2">
                <FolderGit2 className="w-4 h-4 text-sky-500" />
                Add Managed Folder (`📁 Workspaces`)
              </h3>
              <button
                onClick={() => setAddFolderModalOpen(false)}
                className="text-xs st-text-secondary hover:st-text-primary"
              >
                Close
              </button>
            </div>
            <p className="text-xs st-text-secondary">
              Register any local repository or folder. If `.dashboard/manifest.yaml` is missing, you can let the Agent generate one via `manifest-cli inspect`.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={newFolderInput}
                onChange={(e) => setNewFolderInput(e.target.value)}
                placeholder="~/Projects.self/my-repo"
                className="flex-1 px-3 py-2 rounded-xl st-input text-xs font-mono"
              />
              <button
                onClick={() => handleAddManagedFolder(newFolderInput)}
                className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shrink-0"
              >
                Add Folder
              </button>
            </div>
            <div className="max-h-52 overflow-y-auto space-y-1 border-t st-border pt-2">
              {recentWorkspaces.map((ws) => (
                <button
                  key={ws}
                  onClick={() => handleAddManagedFolder(ws)}
                  className="w-full text-left px-3 py-2 rounded-xl text-xs font-mono hover:st-surface-muted st-text-primary truncate"
                >
                  {ws}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Unconfigured Folder Prompt Modal (with "Remember my choice / Don't ask again" checkbox) */}
      {unconfiguredPromptTarget && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-lg w-full rounded-2xl st-card p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold st-text-primary flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-500" />
                No `.dashboard/manifest.yaml` Found in `{unconfiguredPromptTarget.unit.manifest.name}`
              </h3>
              <button
                onClick={() => setUnconfiguredPromptTarget(null)}
                className="text-xs st-text-secondary hover:st-text-primary"
              >
                Close
              </button>
            </div>
            <p className="text-xs st-text-secondary leading-relaxed">
              Would you like the CLI Agent to inspect `{unconfiguredPromptTarget.unit.canonicalPath}` using `manifest-cli inspect` and generate a tailored `.dashboard/manifest.yaml`?
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => handleResolveUnconfiguredChoice("agent")}
                className="w-full text-left px-4 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center justify-between"
              >
                <span>🤖 Launch Agent in Web PTY to Generate `.dashboard` (Recommended)</span>
                <Play className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleResolveUnconfiguredChoice("skeleton")}
                className="w-full text-left px-4 py-2.5 rounded-xl st-btn-secondary text-xs font-semibold flex items-center justify-between"
              >
                <span>📄 Initialize Minimal `.dashboard/manifest.yaml` Skeleton (`manifest-cli init`)</span>
                <Code2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleResolveUnconfiguredChoice("copy")}
                className="w-full text-left px-4 py-2.5 rounded-xl st-btn-secondary text-xs font-semibold flex items-center justify-between"
              >
                <span>📋 Copy Agent CLI Generation Prompt to Clipboard</span>
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => handleResolveUnconfiguredChoice("raw")}
                className="w-full text-left px-4 py-2.5 rounded-xl st-btn-secondary text-xs font-medium st-text-secondary"
              >
                📁 Mount Folder As-Is Without `.dashboard`
              </button>
            </div>
            <label className="flex items-center gap-2 text-xs st-text-secondary cursor-pointer select-none pt-1 border-t st-border">
              <input
                type="checkbox"
                checked={unconfiguredPromptTarget.rememberChoice}
                onChange={(e) =>
                  setUnconfiguredPromptTarget({
                    ...unconfiguredPromptTarget,
                    rememberChoice: e.target.checked,
                  })
                }
                className="w-3.5 h-3.5 accent-sky-600 rounded"
              />
              <span>Remember my choice and don't ask again (`~/.config/skill-dashboard/config.yaml`)</span>
            </label>
          </div>
        </div>
      )}

      {/* Promote Scratchpad Modal */}
      {promoteModalOpen && selectedSkill && selectedSkill.unitKind === "scratchpad" && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-lg w-full rounded-2xl st-card p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold st-text-primary flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-500" />
                🌟 Promote Ephemeral Scratchpad `{selectedSkill.manifest.name}`
              </h3>
              <button
                onClick={() => setPromoteModalOpen(false)}
                className="text-xs st-text-secondary hover:st-text-primary"
              >
                Close
              </button>
            </div>
            <p className="text-xs st-text-secondary">
              Graduate this scratchpad out of `~/.cache/skill-dashboard/scratchpads/` into a permanent Workspace or Global Skill (preserving `&#123;&#123;data_dir&#125;&#125;` state).
            </p>
            <div className="flex flex-col gap-2 text-xs">
              <label className="p-3 rounded-xl st-subcard flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="promoteMode"
                  checked={promoteTargetMode === "project"}
                  onChange={() => setPromoteTargetMode("project")}
                  className="mt-0.5 accent-sky-600"
                />
                <div>
                  <div className="font-bold st-text-primary">
                    Promote to Bound Project (`.dashboard/` in `{selectedSkill.effectiveWorkspace}`)
                  </div>
                  <div className="st-text-muted mt-0.5">
                    Copies `.dashboard/` into the project root and registers the project under `📁 Managed Workspaces`.
                  </div>
                </div>
              </label>
              <label className="p-3 rounded-xl st-subcard flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="promoteMode"
                  checked={promoteTargetMode === "skill"}
                  onChange={() => setPromoteTargetMode("skill")}
                  className="mt-0.5 accent-sky-600"
                />
                <div>
                  <div className="font-bold st-text-primary">
                    Promote to Global Agent Skill (`~/.agents/skills/{selectedSkill.id}`)
                  </div>
                  <div className="st-text-muted mt-0.5">
                    Creates a standalone reusable skill available across all projects and agents.
                  </div>
                </div>
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t st-border">
              <button
                type="button"
                onClick={handlePromoteScratchpad}
                className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold shadow-sm"
              >
                🌟 Confirm Promotion
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Non-Modal Bottom-Right "Fix / Ask Agent" Floating Drawer (Issue 69) */}
      {selectedSkill && !agentDrawerOpen && (
        <button
          type="button"
          onClick={() => setAgentDrawerOpen(true)}
          className={`fixed right-5 z-40 inline-flex items-center gap-2 px-3.5 py-2 rounded-full shadow-xl border text-xs font-bold transition-all ${
            terminalOpen ? "bottom-[320px]" : "bottom-12"
          } ${
            pinnedFixTargets.length > 0
              ? "bg-amber-500 text-slate-950 border-amber-400"
              : "st-card st-text-primary border-sky-500/40 hover:border-sky-500"
          }`}
          title="Open Fix / Ask Agent drawer (or hold Alt/Option and click any card on the page)"
        >
          <Bot className="w-4 h-4 text-sky-500" />
          <span>
            🤖 Fix / Ask Agent
            {pinnedFixTargets.length > 0 ? ` (${pinnedFixTargets.length})` : ""}
          </span>
        </button>
      )}

      {selectedSkill && agentDrawerOpen && (
        <aside
          className={`fixed right-5 z-40 w-[420px] max-w-[calc(100vw-2.5rem)] rounded-2xl st-card border-2 border-sky-500/40 shadow-2xl flex flex-col overflow-hidden transition-all ${
            terminalOpen ? "bottom-[320px] max-h-[calc(100vh-340px)]" : "bottom-12 max-h-[80vh]"
          }`}
        >
          {/* Drawer Header */}
          <div className="px-4 py-3 st-surface-muted border-b st-border flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Bot className="w-4 h-4 text-sky-500 shrink-0" />
              <span className="text-xs font-bold st-text-primary truncate">
                🤖 Fix / Customize `{selectedSkill.manifest.name}`
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setAgentPickMode((v) => !v)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all ${
                  agentPickMode
                    ? "bg-amber-500 text-slate-950 shadow-sm animate-pulse"
                    : "st-btn-secondary"
                }`}
                title="Toggle Pick Mode: click any Action Group, Action, Data Node, Context, or View on the page to add it to context (or hold Alt + Click anytime)"
              >
                {agentPickMode ? "🎯 Picking... (Esc)" : "🎯 Pick Target on Page"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAgentPickMode(false);
                  setAgentDrawerOpen(false);
                }}
                className="p-1 rounded-lg st-text-muted hover:st-text-primary"
                title="Minimize drawer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="p-4 overflow-y-auto space-y-3.5 text-xs">
            {/* 1. Smart Resolved Target File Badge & Layer Selector */}
            <div className="st-subcard rounded-xl p-2.5 flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold st-text-secondary">
                  Target Manifest Location:
                </span>
                <select
                  value={agentFixTargetLayer}
                  onChange={(e) => setAgentFixTargetLayer(e.target.value as any)}
                  className="px-2 py-0.5 rounded-lg st-input text-[11px] font-mono"
                >
                  <option value="auto">Auto (Existing File → .dashboard/manifest.yaml)</option>
                  <option value="companion">Companion ({selectedSkill.id}/.dashboard/manifest.yaml)</option>
                  <option value="global_override">Global Override (~/.config/skill-dashboard/overrides/)</option>
                  <option value="workspace_override">Workspace Override (.claude/skill-dashboard/configs/)</option>
                </select>
              </div>
              {agentFixPreview && (
                <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                  <span
                    className="truncate st-text-muted"
                    title={agentFixPreview.resolvedTargetFile}
                  >
                    {agentFixPreview.resolvedTargetFile}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold shrink-0 ${
                      agentFixPreview.targetExists
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                        : "bg-sky-500/15 text-sky-600 dark:text-sky-300"
                    }`}
                  >
                    {agentFixPreview.targetExists ? "EXISTING (Edit)" : "NEW (Create)"}
                  </span>
                </div>
              )}
            </div>

            {/* 2. Pinned Context Targets (Click-to-Context Chips) */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold st-text-secondary">
                  Pinned Page Targets ({pinnedFixTargets.length}):
                </span>
                {pinnedFixTargets.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setPinnedFixTargets([])}
                    className="text-[11px] text-rose-500 hover:underline"
                  >
                    Clear All
                  </button>
                )}
              </div>

              {pinnedFixTargets.length === 0 ? (
                <div className="px-3 py-2 rounded-xl border border-dashed st-border text-[11px] st-text-muted flex items-center justify-between gap-2">
                  <span>
                    Click <b>🎯 Pick Target</b> (or hold <kbd className="px-1 py-0.5 rounded st-subcard font-mono">Alt</kbd> + Click) on any card/group to attach it, or leave empty to target the whole manifest.
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 flex-wrap">
                  {pinnedFixTargets.map((t) => (
                    <span
                      key={`${t.kind}:${t.id}`}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 text-[11px] font-mono"
                    >
                      <span className="opacity-70 uppercase">{t.kind}:</span>
                      <span className="font-semibold truncate max-w-[180px]">{t.title}</span>
                      {t.provenanceFile && (
                        <span className="opacity-65 text-[10px]">({t.provenanceFile})</span>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setPinnedFixTargets((prev) =>
                            prev.filter((x) => !(x.kind === t.kind && x.id === t.id))
                          )
                        }
                        className="ml-0.5 hover:text-rose-500"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 3. Quick Intent Preset Capsules */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold st-text-secondary">Quick Fix Intents:</span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {[
                  {
                    label: "🛠️ 重构碎裂的零配置命令",
                    text: "当前零配置自动提取的命令碎裂或不够直观，请阅读 SKILL.md 生成结构化的 .dashboard/manifest.yaml，将命令整理为清晰分组与带参数表单的 Action。",
                  },
                  {
                    label: "🎨 新增交互式 HTML 工作台",
                    text: "为当前 Skill 设计并新增一个配套的 .dashboard/views/ 交互式 HTML 视图（使用 window.SkillDashboard Bridge 2.0），并在 manifest.yaml views 中注册。",
                  },
                  {
                    label: "🔌 抽取动态表单与 Data 节点",
                    text: "把硬编码的参数改造为带类型、默认值和 fromData 的 FormField，并补充配套的 polyglot data 节点（runtime: ts 使用 prelude: true）。",
                  },
                  {
                    label: "🩺 诊断并修复校验/运行问题",
                    text: "运行 manifest-cli inspect / map / validate 诊断当前配置或脚本问题，修复所有 schema、引用或命令模板错误。",
                  },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() =>
                      setAgentFixInstruction((prev) =>
                        prev.trim() ? `${prev.trim()}\n${preset.text}` : preset.text
                      )
                    }
                    className="px-2 py-1 rounded-lg st-subcard hover:border-sky-500/50 border st-border text-[11px] font-medium transition-colors"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 4. Custom Fix / Authoring Instruction Input */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-bold st-text-secondary">
                What should the Agent fix or build?
              </span>
              <textarea
                rows={4}
                value={agentFixInstruction}
                onChange={(e) => setAgentFixInstruction(e.target.value)}
                placeholder="Describe what to fix or customize (e.g. 'Turn this multi-line curl example into a parameterized evaluation action + interactive HTML tester')..."
                className="w-full p-2.5 rounded-xl st-input text-xs leading-relaxed focus:outline-none focus:border-sky-500"
              />
            </div>

            {/* 5. Dual-Channel Execution Bar (Web PTY Claude / Codex + Copy Prompt) */}
            <div className="flex items-center gap-2 pt-1 border-t st-border">
              <button
                type="button"
                onClick={() => handleAgentSyncManifest("pty-claude")}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold shadow-sm transition-colors"
                title="Spawn Claude Code in the bottom Web PTY to fix/update the target manifest automatically"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>⚡ Summon Claude</span>
              </button>
              <button
                type="button"
                onClick={() => handleAgentSyncManifest("pty-codex")}
                className="inline-flex items-center justify-center gap-1 px-2.5 py-2 rounded-xl st-btn-secondary text-xs font-semibold"
                title="Spawn Codex in the bottom Web PTY"
              >
                <Terminal className="w-3.5 h-3.5 text-indigo-500" />
                <span>Codex</span>
              </button>
              <button
                type="button"
                onClick={() => handleAgentSyncManifest("copy")}
                className="inline-flex items-center justify-center gap-1 px-2.5 py-2 rounded-xl st-btn-secondary text-xs font-semibold"
                title="Copy the full context-rich prompt to paste into your external terminal"
              >
                {copiedAgentSync ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                <span>{copiedAgentSync ? "Copied!" : "Copy"}</span>
              </button>
            </div>
          </div>
        </aside>
      )}

      {/* Flex-Docked Web PTY Terminal Drawer (shrink-0, pushes content instead of obscuring it) */}
      <TerminalDrawer
        runs={runs}
        activeRunId={activeRunId}
        onSelectRun={(id) => setActiveRunId(id)}
        onStopRun={handleStopRun}
        onCloseRun={handleCloseRun}
        onStartInteractiveShell={handleStartInteractiveShell}
        keepShellOpen={keepShellOpen}
        onToggleKeepShellOpen={(val) => setKeepShellOpen(val)}
        onRunStatusChange={handleRunStatusChange}
        isOpen={terminalOpen}
        onToggleOpen={() => setTerminalOpen(!terminalOpen)}
      />
    </div>
  );
};
