import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderTree,
  LayoutGrid,
  ListTree,
  Play,
  ShieldAlert,
  Sliders,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import type { ActionGroup, ActionItem, ContextField, DataNode } from "../types.ts";
import { ActionCard } from "./ActionCard.tsx";
import { StatusProbesBar } from "./StatusProbesBar.tsx";

interface MultiLevelPlaygroundProps {
  skillId: string;
  contextFields: ContextField[];
  dataNodes: DataNode[];
  actionGroups: ActionGroup[];
  activeWorkspace: string;
  refreshTrigger: number;
  prefillRequest: { actionId: string; formValues: Record<string, unknown>; seq: number } | null;
  onPrefillJump: (actionId: string, formValues: Record<string, unknown>) => void;
  onContextChanged?: () => void;
  onExecute: (params: {
    actionId: string;
    formValues: Record<string, unknown>;
    runner: "web_terminal" | "external_terminal";
    terminalApp?: "Terminal" | "iTerm";
    humanApproved?: boolean;
  }) => Promise<void>;
}

export const MultiLevelPlayground: React.FC<MultiLevelPlaygroundProps> = ({
  skillId,
  contextFields,
  dataNodes,
  actionGroups,
  activeWorkspace,
  refreshTrigger,
  prefillRequest,
  onPrefillJump,
  onContextChanged,
  onExecute,
}) => {
  const totalActionCount = useMemo(
    () => actionGroups.reduce((acc, g) => acc + (g.actions?.length || 0), 0),
    [actionGroups]
  );

  const isComplexSkill = totalActionCount > 4 || actionGroups.length > 1;

  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [selectedSubgroup, setSelectedSubgroup] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [focusedActionId, setFocusedActionId] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<"hierarchy" | "cards">(
    isComplexSkill ? "hierarchy" : "cards"
  );

  useEffect(() => {
    setSelectedGroup(null);
    setSelectedSubgroup(null);
    setExpandedGroups(new Set(actionGroups.map((g) => g.name)));
    const firstAction = actionGroups[0]?.actions?.[0];
    setFocusedActionId(firstAction?.id || null);
    setLayoutMode(totalActionCount > 4 || actionGroups.length > 1 ? "hierarchy" : "cards");
  }, [skillId, totalActionCount, actionGroups.length]);

  // Handle Prefill Jump from HTML App View or Docs
  useEffect(() => {
    if (!prefillRequest) return;
    setSelectedGroup(null);
    setSelectedSubgroup(null);
    setFocusedActionId(prefillRequest.actionId);
  }, [prefillRequest?.seq]);

  const visibleGroups = useMemo(() => {
    return actionGroups
      .filter((g) => !selectedGroup || g.name === selectedGroup)
      .map((g) => {
        const rawSubgroups: ActionGroup[] =
          g.subgroups && g.subgroups.length > 0
            ? g.subgroups
            : [{ name: "Operations", actions: g.actions || [] }];

        const filteredSubgroups = rawSubgroups.filter(
          (sg) => !selectedSubgroup || sg.name === selectedSubgroup
        );
        return {
          ...g,
          resolvedSubgroups: filteredSubgroups,
        };
      });
  }, [actionGroups, selectedGroup, selectedSubgroup]);

  const toggleGroupExpand = (groupName: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  };

  const canQuickRun = (action: ActionItem): boolean => {
    if (action.danger === "danger" || action.danger === "warn" || action.requiresHumanApprovalFlag) {
      return false;
    }
    for (const f of action.form || []) {
      if (f.required && (f.default === undefined || f.default === "") && !f.fromData) {
        return false;
      }
    }
    return true;
  };

  const buildDefaultFormValues = (action: ActionItem): Record<string, unknown> => {
    const vals: Record<string, unknown> = {};
    for (const f of action.form || []) {
      if (f.default !== undefined) vals[f.key] = f.default;
      else if (f.type === "boolean") vals[f.key] = false;
      else vals[f.key] = "";
    }
    return vals;
  };

  const allActionsMap = useMemo(() => {
    const map = new Map<string, ActionItem>();
    for (const g of actionGroups) {
      for (const a of g.actions || []) map.set(a.id, a);
      for (const sg of g.subgroups || []) {
        for (const a of sg.actions || []) map.set(a.id, a);
      }
    }
    return map;
  }, [actionGroups]);

  return (
    <div className="flex flex-col gap-5">
      {/* Reactive Context Toolbar & Data Widgets Strip */}
      <StatusProbesBar
        skillId={skillId}
        contextFields={contextFields || []}
        dataNodes={dataNodes || []}
        activeWorkspace={activeWorkspace}
        refreshTrigger={refreshTrigger}
        onContextChanged={() => onContextChanged?.()}
        onExecuteBoundTrigger={async ({ actionId, mode, formValues }) => {
          const targetAction = allActionsMap.get(actionId);
          // If mode is prefill or the target action has warn/danger approval gate, jump to the action form with prefill!
          if (
            mode === "prefill" ||
            targetAction?.danger === "warn" ||
            targetAction?.danger === "danger" ||
            targetAction?.requiresHumanApprovalFlag
          ) {
            onPrefillJump(actionId, formValues);
            return;
          }
          await onExecute({
            actionId,
            formValues,
            runner: "web_terminal",
            humanApproved: false,
          });
        }}
      />

      {/* Simple Clean Mode for Small Skills (1-4 actions) */}
      {!isComplexSkill ? (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {actionGroups
            .flatMap((g) => g.actions || [])
            .map((action) => (
              <ActionCard
                key={action.id}
                skillId={skillId}
                action={action}
                activeWorkspace={activeWorkspace}
                refreshTrigger={refreshTrigger}
                prefillValues={
                  prefillRequest?.actionId === action.id ? prefillRequest.formValues : null
                }
                onExecute={onExecute}
              />
            ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Left Multi-Level Action Tree Navigator */}
          <aside className="lg:col-span-3 st-card rounded-2xl p-3.5 flex flex-col gap-2 lg:sticky lg:top-4">
            <div className="flex items-center justify-between pb-2 border-b st-border px-1">
              <span className="text-xs font-bold st-text-primary flex items-center gap-1.5">
                <FolderTree className="w-4 h-4 text-sky-500" />
                <span>Action Hierarchy</span>
              </span>
              <div className="inline-flex rounded-lg p-0.5 st-surface-muted border st-border">
                <button
                  type="button"
                  onClick={() => setLayoutMode("hierarchy")}
                  className={`p-1 rounded ${
                    layoutMode === "hierarchy" ? "bg-sky-600 text-white" : "st-text-muted"
                  }`}
                  title="Compact Multi-Level Accordion View (High Density)"
                >
                  <ListTree className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setLayoutMode("cards")}
                  className={`p-1 rounded ${
                    layoutMode === "cards" ? "bg-sky-600 text-white" : "st-text-muted"
                  }`}
                  title="Expanded Card View"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setSelectedGroup(null);
                setSelectedSubgroup(null);
              }}
              className={`w-full text-left px-3 py-2 rounded-xl text-[13px] font-semibold flex items-center justify-between transition-all ${
                selectedGroup === null
                  ? "bg-sky-600 text-white shadow-sm"
                  : "hover:st-surface-muted st-text-primary"
              }`}
            >
              <span>All Action Groups</span>
              <span className="text-xs font-mono opacity-80">{totalActionCount}</span>
            </button>

            <div className="space-y-1 max-h-[55vh] overflow-y-auto overscroll-contain pr-0.5">
              {actionGroups.map((grp) => {
                const isGroupSelected = selectedGroup === grp.name && selectedSubgroup === null;
                const isExpanded = expandedGroups.has(grp.name);
                const subgroups = grp.subgroups || [];

                return (
                  <div key={grp.name} className="flex flex-col gap-0.5">
                    <div
                      data-sd-pick-kind="action-group"
                      data-sd-pick-id={grp.name}
                      data-sd-pick-title={`Action Group: ${grp.name}`}
                      className={`flex items-center justify-between px-2.5 py-1.5 rounded-xl text-[13px] cursor-pointer transition-all ${
                        isGroupSelected
                          ? "bg-sky-500/15 text-sky-600 dark:text-sky-300 font-bold border border-sky-500/30"
                          : "hover:st-surface-muted st-text-primary font-medium"
                      }`}
                      onClick={() => {
                        setSelectedGroup(grp.name);
                        setSelectedSubgroup(null);
                        if (!isExpanded) toggleGroupExpand(grp.name);
                      }}
                    >
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        {subgroups.length > 0 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleGroupExpand(grp.name);
                            }}
                            className="p-0.5 rounded hover:bg-black/10 shrink-0"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3.5 h-3.5 st-text-muted" />
                            ) : (
                              <ChevronRight className="w-3.5 h-3.5 st-text-muted" />
                            )}
                          </button>
                        )}
                        <span className="truncate">{grp.name}</span>
                      </div>
                      <span className="text-[11px] font-mono st-text-muted ml-1.5 shrink-0">
                        {grp.actions.length}
                      </span>
                    </div>

                    {isExpanded && subgroups.length > 0 && (
                      <div className="pl-5 pr-1 py-0.5 space-y-0.5 border-l st-border ml-3.5">
                        {subgroups.map((sg) => {
                          const isSgSelected =
                            selectedGroup === grp.name && selectedSubgroup === sg.name;
                          return (
                            <button
                              key={sg.name}
                              type="button"
                              onClick={() => {
                                setSelectedGroup(grp.name);
                                setSelectedSubgroup(sg.name);
                              }}
                              className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between transition-all ${
                                isSgSelected
                                  ? "bg-sky-600 text-white font-semibold shadow-sm"
                                  : "hover:st-surface-muted st-text-secondary"
                              }`}
                            >
                              <span className="truncate">{sg.name}</span>
                              <span className="text-[10.5px] font-mono opacity-75 ml-1">
                                {sg.actions.length}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </aside>

          {/* Right Multi-Level Action Canvas */}
          <div className="lg:col-span-9 flex flex-col gap-5">
            {visibleGroups.map((group) => (
              <section
                key={group.name}
                data-sd-pick-kind="action-group"
                data-sd-pick-id={group.name}
                data-sd-pick-title={`Action Group: ${group.name}`}
                className="st-card rounded-2xl p-5 flex flex-col gap-4"
              >
                <div className="flex items-start justify-between gap-3 border-b st-border pb-3">
                  <div>
                    <h3 className="text-base font-bold st-text-primary">{group.name}</h3>
                    {group.description && (
                      <p className="text-[13px] st-text-secondary mt-0.5">{group.description}</p>
                    )}
                  </div>
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-mono st-pill shrink-0">
                    {group.actions.length} operations
                  </span>
                </div>

                <div className="flex flex-col gap-4">
                  {group.resolvedSubgroups.map((subgroup) => (
                    <div key={subgroup.name} className="flex flex-col gap-2">
                      {group.resolvedSubgroups.length > 1 || subgroup.name !== "Operations" ? (
                        <div className="flex items-center gap-2 px-1 pt-1">
                          <span className="text-xs font-bold uppercase tracking-wider text-sky-600 dark:text-sky-400">
                            {subgroup.name}
                          </span>
                          <div className="flex-1 h-px st-border border-t" />
                        </div>
                      ) : null}

                      {layoutMode === "cards" ? (
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                          {subgroup.actions.map((action) => (
                            <ActionCard
                              key={action.id}
                              skillId={skillId}
                              action={action}
                              activeWorkspace={activeWorkspace}
                              refreshTrigger={refreshTrigger}
                              prefillValues={
                                prefillRequest?.actionId === action.id
                                  ? prefillRequest.formValues
                                  : null
                              }
                              onExecute={onExecute}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {subgroup.actions.map((action) => {
                            const isFocused = focusedActionId === action.id;
                            const paramCount = action.form?.length || 0;
                            const quickRunnable = canQuickRun(action);

                            return (
                              <div
                                key={action.id}
                                data-sd-pick-kind="action"
                                data-sd-pick-id={action.id}
                                data-sd-pick-title={action.title}
                                className={`rounded-xl border transition-all ${
                                  isFocused
                                    ? "border-sky-500/60 shadow-md st-surface"
                                    : "st-border st-subcard hover:border-sky-500/40"
                                }`}
                              >
                                <div
                                  onClick={() =>
                                    setFocusedActionId(isFocused ? null : action.id)
                                  }
                                  className="px-4 py-3 flex items-center justify-between gap-3 cursor-pointer select-none"
                                >
                                  <div className="flex items-center gap-3 min-w-0 flex-1">
                                    {isFocused ? (
                                      <ChevronDown className="w-4 h-4 text-sky-500 shrink-0" />
                                    ) : (
                                      <ChevronRight className="w-4 h-4 st-text-muted shrink-0" />
                                    )}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[14px] font-bold st-text-primary">
                                          {action.title}
                                        </span>
                                        {action.interactive && (
                                          <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 border border-indigo-500/30">
                                            TUI
                                          </span>
                                        )}
                                        {action.danger === "warn" && (
                                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300">
                                            <AlertTriangle className="w-3 h-3" />
                                            Gate
                                          </span>
                                        )}
                                        {action.danger === "danger" && (
                                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-500/15 text-rose-600 dark:text-rose-300">
                                            <ShieldAlert className="w-3 h-3" />
                                            Danger
                                          </span>
                                        )}
                                      </div>
                                      {action.description && (
                                        <p className="text-[12.5px] st-text-secondary truncate mt-0.5">
                                          {action.description}
                                        </p>
                                      )}
                                    </div>
                                  </div>

                                  <div
                                    className="flex items-center gap-2 shrink-0"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <span className="px-2 py-1 rounded-md text-xs font-mono st-pill flex items-center gap-1">
                                      <Sliders className="w-3 h-3" />
                                      {paramCount === 0 ? "No params" : `${paramCount} params`}
                                    </span>

                                    {quickRunnable ? (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          onExecute({
                                            actionId: action.id,
                                            formValues: buildDefaultFormValues(action),
                                            runner: "web_terminal",
                                            humanApproved: false,
                                          })
                                        }
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white shadow-sm transition-colors"
                                        title="Quick Run with default parameters in Web PTY"
                                      >
                                        <Play className="w-3 h-3 fill-current" />
                                        <span>Quick Run</span>
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setFocusedActionId(isFocused ? null : action.id)
                                        }
                                        className="px-3 py-1.5 rounded-lg text-xs font-semibold st-btn-secondary"
                                      >
                                        Configure…
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {isFocused && (
                                  <div className="p-3 pt-0 border-t st-border">
                                    <ActionCard
                                      skillId={skillId}
                                      action={action}
                                      activeWorkspace={activeWorkspace}
                                      refreshTrigger={refreshTrigger}
                                      prefillValues={
                                        prefillRequest?.actionId === action.id
                                          ? prefillRequest.formValues
                                          : null
                                      }
                                      onExecute={onExecute}
                                    />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
