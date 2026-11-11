# Issue 03: Inline In-Place Executable Code Blocks in Knowledge & Docs with Live Workspace & `{{python}}` Resolution

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #21, #25, #26)

## What to build

Enhance the **Knowledge & Docs (`MarkdownViewer`)** experience so that executable shell code blocks (`bash`, `sh`, `zsh`) inside any Markdown document render **inline, in-place execution controls** right where the code block appears in the document flow (while keeping the top summary bar as a quick index):

1. **In-Place Executable Code Block Widget in Markdown Flow**:
   - Render every `bash`/`sh`/`zsh` fenced code block in the Markdown body with an embedded interactive toolbar and per-command runnable actions directly on the block itself:
     - **`▶ Run in Web PTY`**: Immediately executes the command in the dockable Web PTY drawer.
     - **`Terminal.app` / `iTerm2`**: Launches the command in the user's native macOS terminal at the current `ActiveWorkspace`.
     - **`Copy`**: Copies the command to the clipboard.
     - If a code block contains multiple distinct runnable commands (e.g., numbered steps in a playbook), allow clicking to run any individual command line in-place as well as copying/running the primary snippet.
2. **Real-Time `ActiveWorkspace` (`cwd`) & `{{python}}` Normalization for Ad-Hoc Doc Commands**:
   - When executing or previewing an ad-hoc command from a Markdown code block (e.g. `python ~/.agents/skills/vsip/tools/doc_extract/doc_extract_ops.py list` or `python local/tools/...`), automatically normalize `python`/`python3` and skill paths through `interpolateActionCommand` so that:
     - `python` dynamically resolves to `<ActiveWorkspace>/.venv/bin/python` (or fallback `python3`),
     - `~` and `{{skill_dir}}` resolve to the canonical skill path, and
     - execution runs with `cwd` set to the current `ActiveWorkspace`.

## Acceptance criteria

- [x] Every `bash`/`sh`/`zsh` fenced code block in Knowledge & Docs renders in-place execution controls (`Run in Web PTY`, `Terminal.app`, `iTerm2`, `Copy`) directly on the code block in the document body, alongside the top summary bar.
- [x] Multi-command `bash` code blocks in documentation expose in-place execution buttons for each runnable command inside the block.
- [x] Running a `python ...` command from a Markdown code block dynamically resolves the interpreter to `<ActiveWorkspace>/.venv/bin/python` and executes inside `<ActiveWorkspace>`.
- [x] Switching `ActiveWorkspace` immediately updates the resolved Python interpreter and `cwd` used by in-place Markdown code block executions.
- [x] End-to-end server seam tests (`bun test`) verify ad-hoc Markdown command normalization against `<ActiveWorkspace>/.venv/bin/python`.

## Blocked by

None - can start immediately
