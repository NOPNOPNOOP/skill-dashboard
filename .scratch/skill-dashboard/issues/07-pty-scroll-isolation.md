# Issue 07: PTY Terminal Scroll Isolation & Overscroll Chaining Prevention

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #28, #29)

## What to build

Prevent mouse wheel / trackpad scrolling inside the **PTY Operations Console (`TerminalDrawer`)** from leaking (scroll-chaining) to the main dashboard page when the terminal buffer reaches the top or bottom boundary:

1. **CSS Overscroll Containment**:
   - Apply `overscroll-behavior: contain` on the `TerminalDrawer` root container, the `xterm.js` mount wrapper, and `.xterm-viewport`.
2. **Wheel Event Boundary Guard**:
   - Attach a non-passive `wheel` event listener on the terminal container that checks `.xterm-viewport`'s `scrollTop`, `scrollHeight`, and `clientHeight`. When scrolling up at `scrollTop <= 0` or scrolling down at `scrollTop + clientHeight >= scrollHeight` (or when `.xterm-viewport` is not scrollable, such as in alternate-screen TUI mode), stop propagation and prevent default browser page scroll chaining while still letting `xterm.js` handle terminal scrollback or mouse-reporting sequences.

## Acceptance criteria

- [x] `.xterm-viewport` and the terminal drawer container enforce `overscroll-behavior: contain`.
- [x] Scrolling to the very top or very bottom of the PTY terminal with a trackpad or mouse wheel never scrolls the underlying main page.
- [x] Scrolling inside full-screen interactive TUIs (`prompt_toolkit`, alternate screen) remains completely isolated from the main window scroll.

## Blocked by

None - can start immediately
