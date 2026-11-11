# Issue 05: Multi-Level Action Hierarchy (Groups → Subgroups → Action Variants) & High-Density Master-Detail Playground

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #11, #15, #22, #35)

## What to build

Replace the flat, low-capacity 2-column card grid in the **Operations Playground** with a **Multi-Level Action Hierarchy** (`Group` $\rightarrow$ `Subgroup` $\rightarrow$ `ActionItem`) and a high-density **Master-Detail / Compact Tree Playground** capable of organizing dozens of actions effortlessly:

1. **Multi-Level Action Schema & Zero-Config Heading Hierarchy**:
   - Extend `ActionItem` with an optional `subgroup?: string` field and `ActionGroup` with optional nested `subgroups?: ActionGroup[]` so actions can be organized into 2 or 3 hierarchical levels:

```typescript
export interface ActionGroup {
  name: string;
  description?: string;
  subgroups?: ActionGroup[];
  actions: ActionItem[];
}
```

   - Update the `ZeroConfigHeuristic` parser (`src/cascade.ts`) so `## H2` headings define top-level `ActionGroup`s and `### H3` / `#### H4` headings populate nested `subgroups` (or `action.subgroup`).
   - Upgrade `vsip/.dashboard/manifest.yaml` to organize its 6 major tool domains into clean second-level subgroups (e.g., under `Document Extraction`: `Routine Inspection`, `Ingestion Pipeline`, `Snapshot & Backup`, `Destructive Reset`).

2. **High-Density Multi-Level Playground UI**:
   - **Left Multi-Level Tree Navigator (inside Playground)**: Displays Level-1 Groups and expandable Level-2 Subgroups with action counts. Users can view `All` or click any Group / Subgroup to scope the view.
   - **Compact Action List + Focused Inspector / Expandable Drawer (View Mode Toggle: `Split Inspector` vs `Compact Accordion`)**:
     - Actions render as high-density, scannable rows showing title, subgroup badge, 1-line description, parameter summary badge (`0 params` or `3 params`), and a direct **`▶ Quick Run`** button for zero-required-parameter actions.
     - Clicking an action opens/focuses its full interactive parameter form, live command preview, and multi-runner execution controls (`Run in Web PTY`, `Terminal.app`, `iTerm2`, `Copy Agent Prompt`) without cluttering neighboring actions.

## Acceptance criteria

- [x] `ActionGroupSchema` and `ActionItemSchema` support multi-level subgroups (`subgroups?: ActionGroup[]` and `action.subgroup?: string`), validated end-to-end.
- [x] Zero-config Markdown parsing preserves `## H2` $\rightarrow$ `### H3` hierarchy into multi-level action groups/subgroups.
- [x] `vsip/.dashboard/manifest.yaml` is organized with multi-level subgroups across its 6 operational domains.
- [x] The Playground UI provides a multi-level Group/Subgroup tree sidebar + high-density compact action list with focused parameter inspector / accordion expansion, fitting 20+ actions cleanly on a single screen without visual fatigue.
- [x] Automated tests in `tests/server.test.ts` verify multi-level action group/subgroup schema parsing and execution.

## Blocked by

None - can start immediately
