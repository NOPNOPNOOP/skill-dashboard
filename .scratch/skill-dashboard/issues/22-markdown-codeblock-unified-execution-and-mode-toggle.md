# Issue 22: Unified Whole-Block Execution for Markdown Shell Code Blocks with Per-Block Block/Split Mode Toggle

Status: completed
Parent: `.scratch/skill-dashboard/PRD.md` (User Stories #91–#95)

---

## Problem Statement

When viewing `SKILL.md` or `references/*.md` in **Knowledge & Docs** (or **FileTreeInspector** Markdown preview), every fenced shell code block (`bash`, `sh`, `zsh`, `shell`, `console`) is automatically split statement-by-statement and rendered as multiple stacked command cards inside an outer wrapper (`In-Place Executable Shell Block (N commands)`):

1. **Fragmented Code Block Semantics**: A single logical shell recipe in documentation (for example, setting variables, changing directories, and running two sequential commands) is broken into separate runnable rows, making one cohesive code block look cluttered and behave inconsistently.
2. **Silent Line Loss & Broken Context**: Because executable mode only renders extracted `commands[]` matching a fixed command-prefix allowlist, non-matching lines inside the block (`cd ...`, `FOO=bar`, `if`/`for` control flow, and intermediate comments) disappear from the rendered code view, and splitting statements breaks shared shell state across lines.
3. **Truncated Multi-Line Command Preview & Form Mis-Inference**: Multi-line ad-hoc commands lack full multi-line `Live Resolved` preview rendering, and multi-line shell syntax (comments containing `<example>`, shell redirections `< input.json`, heredocs `<<EOF`, or `[ ... ]` tests) can be mis-inferred as required `FormField`s that block direct execution.

## Solution

Make **Whole-Block Execution (`Block` mode)** the default presentation for every executable shell code block in Markdown documentation, while preserving a **per-block mode toggle** when a block contains multiple standalone statements:

1. **Unified Code Block Card (Default `Block` Mode)**:
   - Each executable shell code block renders as a single unified card displaying the complete, highlighted source code with line numbers (retaining every comment, `cd`, variable assignment, and control-flow statement) and one unified toolbar (`Run in PTY`, `Terminal`, `iTerm2`, `⚙️ Env`, `Copy`).
   - Multi-line clipboard copies wrap the resolved command in a subshell (`(\nset -e\n...\n)`), matching `ActionCard`.
   - `Live Resolved` previews render the full multi-line resolved script whenever template/environment normalization changes the command (no single-line truncation), and hide when identical to the raw block.
   - Block titles (`adHocTitle`) default to the leading `#` comment lines before the first command, falling back to a truncated first non-empty non-comment line.
2. **Per-Block Mode Switch (`整块 | 逐条 (N)`)**:
   - When a shell code block contains 2 or more independently extractable statements, its own header displays a compact toggle pill (`整块 | 逐条 (N)`), defaulting to `整块`.
   - Switching a specific block to `逐条 (N)` renders the per-statement `InlineExecutableCommandRow` cards for that block only (retaining `Copy Full Block`), and switching back restores the unified block card.
   - No global document-level toggle is added; control stays scoped to each multi-command block header, while the top `Quick Runbook Summary` bar dynamically reflects each block's active mode.
3. **Multi-Line Ad-Hoc Backend Normalization & Guarding**:
   - Multi-line `adHocCommand` payloads routed through `/api/preview-command` and `/api/runs` normalize `python`/`python3` and `~/.agents/skills/...` references across all non-comment, non-heredoc statements without mis-parsing shell comments, heredocs, redirections, or `[ ... ]` test expressions into spurious `FormField`s.
4. **Layer 0 Unchanged**:
   - `ZeroConfigHeuristic` (`SKILL.md` extraction into Operations Playground `ActionGroup`s) remains unchanged so zero-config skills keep their per-command Playground actions.

## User Stories

91. As a developer reading Markdown docs in Knowledge & Docs or FileTreeInspector, I want each executable shell code block to render and run as a single cohesive command card by default, so that multi-step scripts keep their full lines, comments, variables, and directory context intact.
92. As a developer reading a multi-line shell code block, I want its card title and run history label (`adHocTitle`) to be derived automatically from the leading `#` comment (or the first non-empty non-comment line if no leading comment exists), so that PTY tabs and SQLite run records remain descriptive without manual naming.
93. As a developer running a multi-line Markdown shell block whose `{{python}}`, `{{skill_dir}}`, or form parameters are interpolated, I want the `Live Resolved` preview area to display the full multi-line resolved script without single-line truncation, so that I can audit every line before executing or copying it.
94. As a developer reading a Markdown shell block that happens to list multiple independent example commands, I want a lightweight `[整块 | 逐条 (N)]` toggle in that block's own header (defaulting to `整块`), so that I can expand individual commands on demand without adding document-wide UI clutter.
95. As a developer executing a multi-line shell block containing `#` comments with `<placeholder>` examples, heredocs (`<<EOF`), or shell redirections (`< file`), I want ad-hoc parameter inference to ignore non-CLI syntax inside comments/heredocs/redirections while normalizing `python` across lines, so that valid shell blocks run immediately in one click without false required-form prompts.

## Implementation Decisions

- **Markdown Segment & Block Metadata Module**:
  - Extend the Markdown segment extraction interface so shell code segments carry a derived `blockTitle` (leading `#` comment before the first non-empty code line, or truncated first non-empty non-comment line) alongside `rawCode`, `isExecutableShell`, and `commands[]`.
  - Retain `extractExecutableCommandsFromShellBlock` to determine executability (`isExecutableShell`) and populate `commands[]` for the optional `逐条 (N)` view.
- **Markdown Renderer State & Presentation**:
  - Each executable shell code block maintains an independent local mode (`"block" | "split"`, defaulting to `"block"`).
  - In `"block"` mode, render a single card with full syntax-highlighted source with line numbers, the unified action toolbar (`Run in PTY`, `Terminal`, `iTerm2`, `⚙️ Env`, `Copy` with subshell wrapping for multi-line scripts), inline parameter inputs if applicable, and full multi-line `Live Resolved` output when `resolvedPreview !== rawCommand`.
  - Render the `[整块 | 逐条 (N)]` mode toggle inside the block header only when `commands.length > 1`.
  - Synchronize `Quick Runbook Summary` entries with each block's active mode (`1` entry when in `"block"` mode, `N` entries when toggled to `"split"` mode).
- **Ad-Hoc Synopsis Inference Module**:
  - Upgrade `inferFormAndTemplateFromSynopsis` to detect multi-line inputs and process them line/statement-safely: skip `#` comment lines and heredoc bodies when normalizing `python`/`python3` and extracting CLI form placeholders, and avoid interpreting shell redirections (`< path`) or bracketed test expressions (`[ -f ... ]`) as `FormField`s.
- **Preserved Layer 0 Behavior**:
  - Leave `ZeroConfigHeuristic` bash-block statement extraction untouched so zero-config `ActionGroup` generation in Operations Playground preserves existing behavior.

## Testing Decisions

- **Single Highest Backend Seam (`createDashboardServer` REST API) + Pure Segment Extraction Seam**:
  - Test end-to-end via `POST /api/preview-command` and `POST /api/runs` that multi-line `adHocCommand` shell blocks normalize `python`/`python3` and `~/.agents/skills/...` across lines, ignore `# <example>` comments, heredocs, and `< file` redirections during form inference, respect `action:adhoc-runbook` environment overrides, and execute cleanly as an isolated multi-line `ExecutionRun`.
  - Test `splitMarkdownIntoSegments` directly as a pure unit seam for `blockTitle` extraction, whole-block retention of non-command lines (`cd`, variable assignments), `isExecutableShell` detection, and multi-command `commands.length` counting used to gate the `[整块 | 逐条 (N)]` toggle.
  - Prior art: existing Test 6 (`splitMarkdownIntoSegments` + `adHocCommand` live preview) and Test 19 (`action:adhoc-runbook` command env override) in `tests/server.test.ts`.
  - UI rendering and interactive mode switching will be verified via `bun run build:ui` and live browser inspection against the running Studio instance.

## Out of Scope

- Changing Layer 0 (`ZeroConfigHeuristic`) `SKILL.md` action extraction for Operations Playground.
- Adding a global/document-wide `整块 / 逐条` switcher or persisting per-block toggle state across page reloads.
- Executing non-shell language blocks (`python`, `ts`, `yaml`, `json`).

## Further Notes

- Multi-line execution already leverages `ExecutionManager`'s isolated temporary script runner (`sd-script-<runId>.sh` with `#!/bin/zsh` and `set -e`) and `buildAppleScriptTerminalCommand`'s external terminal script support, so no PTY runner protocol changes are required.
