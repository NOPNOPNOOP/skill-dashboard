# Issue 08: Direct Interactive Shell Sessions (`+ New Shell`) & Persistent Shell Mode in Web PTY

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #25, #26, #28, #29, #30)

## What to build

Allow users to launch and use a full interactive login shell (`zsh` / `$SHELL`) directly inside the **Web PTY Operations Console** at any time—with the active workspace and `.venv` pre-activated—as well as keeping or opening a shell alongside action runs:

1. **Backend Interactive Shell Spawn (`POST /api/runs/shell` or `POST /api/runs` with `mode: "interactive_shell"`)**:
   - Spawns an interactive shell (`/bin/zsh -i` or `process.env.SHELL || "/bin/zsh"`) inside a native Bun PTY (`Bun.spawn({ terminal })`) with:
     - `cwd` set to `activeWorkspace` (or the selected skill's directory when requested);
     - `<activeWorkspace>/.venv/bin` automatically prepended to `PATH` and `VIRTUAL_ENV=<activeWorkspace>/.venv` set when a virtualenv exists in the active workspace;
     - `SKILL_DIR` set to the currently selected skill's `canonicalPath` so the user can immediately run `$SKILL_DIR/tools/...` or `python ...` interactively;
     - Full Tier-1/Tier-2/Tier-3 persistence and `-pgid` process group cleanup when stopped or exited.
2. **UI Controls in `TerminalDrawer`**:
   - Add a prominent **`+ Interactive Shell`** button in the `TerminalDrawer` top bar (and in the empty terminal state) so users can open a live interactive shell in 1 click without needing to click a predefined skill action first.
   - Add an optional **`Keep Shell Open after Action`** toggle (or quick `Open Shell Here` button in the terminal header) so after running a one-shot command, users can immediately type follow-up shell commands in the same workspace context.

## Acceptance criteria

- [x] Clicking `+ Interactive Shell` in the `TerminalDrawer` immediately opens the drawer and launches an interactive PTY shell (`zsh`/`bash`) in the current `ActiveWorkspace` with `<ActiveWorkspace>/.venv/bin` activated in `PATH` and `SKILL_DIR` exported.
- [x] Users can type arbitrary shell commands (`ls`, `which python`, `git status`, `python ...`), use Tab completion, Ctrl+C, and arrow keys directly in the Web PTY.
- [x] Enabling `Keep Shell Open` (or clicking `Drop into Shell`) allows seamless interactive shell usage after an action finishes.
- [x] Automated tests in `tests/server.test.ts` verify spawning an interactive shell session via the server seam, sending shell commands over WebSocket stdin, verifying `VIRTUAL_ENV`/`SKILL_DIR` environment injection, and clean termination.

## Blocked by

None - can start immediately
