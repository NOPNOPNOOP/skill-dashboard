# Skill Dashboard Studio ⚡

> **Multi-Agent Skill Dashboard & Interactive Operations Console**
> A local full-stack Web Studio, Reactive Polyglot Compute Graph, Universal Local Operations Hub (`Scratchpads / Workspaces / Skills`), and Interactive Web PTY built on **TypeScript + Bun**.

---

## Overview

Modern AI Agent ecosystems (**Claude Code**, **Codex**, **OpenCode**, **Pi**, **OpenClaw**, **.agents**) install and execute powerful skills directly on developer workstations. However, complex multi-step skills, full-screen TUIs, data migration guards, and architecture playbooks are often buried in prose inside lengthy `SKILL.md` files.

**Skill Dashboard Studio** bridges this gap: it scans your installed agent skills and managed project directories, providing a responsive local Web Studio with live status probes, parameterized visual action cards, reactive data pipelines, and a native terminal drawer—while preserving 100% compatibility with the `npx skills` portable standard.

---

## Quick Start

### 1. Launch Web Studio (Zero-Install)

Run with Bun (defaults to `http://127.0.0.1:8766` and auto-reuses existing running daemons):

```bash
bunx --bun skill-dashboard [--port 8766] [--workspace <path>] [--no-open]
```

Or install globally:

```bash
bun add -g skill-dashboard
# or: npm install -g skill-dashboard

skill-dashboard
```

### 2. Install Skill for AI Agents (`npx skills`)

Install the agent skill companion into your local Agent environment (`~/.agents/skills/skill-dashboard`):

```bash
npx skills add NOPNOPNOOP/skill-dashboard --skill skill-dashboard -g
```

> **Clean Distribution**: The skill package is isolated in `skills/skill-dashboard/`. Installing via `npx skills add` downloads only the lightweight specification and reference manuals—never bloating your agent directory with server source code or build artifacts.

---

## Key Features

- **⚡ Universal Unit Taxonomy**:
  - **Scratchpads (`⚡`)**: Ephemeral, on-the-fly Human-in-the-Loop (HITL) consoles created dynamically by agents for mid-task approvals and row selections.
  - **Workspaces (`📁`)**: Controlled project directories with `.dashboard/` companions, auto-detecting `.venv/bin/python`, scripts, and documentation.
  - **Agent Skills (`🧩`)**: Canonical skills discovered across `.agents/skills`, `.claude/skills`, `.codex/skills`, OpenCode, and Pi.
- **🔄 Reactive Polyglot Data Graph 2.0**:
  - Define `data:` nodes across 7 runtimes: `zsh`, `ts` (in-memory `Bun.Transpiler`), `python` (`.venv`), `sqlite` (`bun:sqlite`), `glob`, `file`, and `passive`.
  - Declarative output parsers (`auto`, `json`, `whitespace-table`, `regex`, `csv`, `tsv`, `kv`) with DAG chaining (`sync.dependsOn`).
  - **Explicit Intermediate Nodes (`intermediate: true`)**: Run expensive upstream CLI queries once, feeding multiple fast downstream TypeScript view cards without unsafe shell command deduplication.
- **🖥️ Native Bun PTY & Interactive Shell**:
  - Direct POSIX pseudo-terminals with bidirectional ANSI streaming via WebSocket.
  - Interactive `/bin/zsh -i` shell sessions with automatic `.venv` activation and skill environment variable injection.
  - Process-group isolation (`SIGTERM` $\rightarrow$ `SIGKILL`), preventing orphan child processes.
- **🛡️ Human-Approval Safety Gates**:
  - Declarative safety ratings (`danger: "safe" | "warn" | "danger"`) and `--human-approved` flags.
  - Live shell-escaped command preview with automatic secret masking (`env-secret`).
- **🧩 3-Tier XDG Storage Governance**:
  - Configuration in `~/.config/skill-dashboard/`
  - Persistent run history, logs, and SQLite index in `~/.local/share/skill-dashboard/`
  - Ephemeral scratchpads and runtime scripts in `~/.cache/skill-dashboard/`
- **🤖 Built-in `manifest-cli` Toolsuite**:
  - 3-tier validation (Zod schema, cross-file reference integrity, TypeScript/Python syntax).
  - Bidirectional symbol reference mapper (`manifest-cli map`, `manifest-cli refs`).
  - Synchronous HITL waiting (`manifest-cli wait <unit_id>`).

---

## CLI Reference (`manifest-cli`)

```bash
# Inspect and initialize .dashboard/manifest.yaml for any folder
bunx --bun manifest-cli inspect <dir_path>
bunx --bun manifest-cli init <dir_path> [--modular]

# Symbol graph & 3-tier validator
bunx --bun manifest-cli map <unit_id>
bunx --bun manifest-cli refs <unit_id> <symbol_id>
bunx --bun manifest-cli validate [<unit_id>]
bunx --bun manifest-cli eval-data <unit_id> [node_id]

# Ephemeral Agent HITL Scratchpad
bunx --bun manifest-cli scratchpad create --id <slug> --title "<Title>" [--project <cwd>]
bunx --bun manifest-cli wait <unit_id> [--timeout 300]
bunx --bun manifest-cli scratchpad promote <unit_id> --to project|skill
```

---

## Documentation

Comprehensive architecture manuals are maintained under `skills/skill-dashboard/references/`:

1. [📘 01. Manifest, Actions & Run Artifacts Specification](skills/skill-dashboard/references/01-manifest-and-actions-spec.md)
2. [📗 02. Reactive Polyglot Data Graph & Parser Engine](skills/skill-dashboard/references/02-reactive-data-graph-and-parsers.md)
3. [📙 03. Custom HTML Views & Bridge 2.0 SDK](skills/skill-dashboard/references/03-custom-html-views-and-bridge-sdk.md)
4. [📕 04. Ephemeral Agent Scratchpads & Modular CLI](skills/skill-dashboard/references/04-agent-hitl-scratchpads-and-modular-cli.md)

---

## Development

```bash
# Install dependencies
bun install

# Run test suite
bun test

# Build frontend bundle
bun run build:ui

# Start development server
bun run dev
```

---

## License

MIT © [nopnopnoop](https://github.com/NOPNOPNOOP)
