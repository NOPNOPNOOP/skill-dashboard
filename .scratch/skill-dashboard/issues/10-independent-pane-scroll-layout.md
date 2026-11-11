# Issue 10: Fixed Full-Viewport Split Layout with Independent Scroll Containers for Left Sidebar & Right Main Pane

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #18, #28)

## What to build

Lock the application shell into a fixed full-viewport (`h-screen overflow-hidden`) split layout so that scrolling in the right main workspace never scrolls or shifts the left skill catalog sidebar (and vice versa):

1. **App Shell Viewport Lock (`h-screen overflow-hidden flex flex-col`)**:
   - Replace `min-h-screen` document-level scrolling with a fixed-height `h-screen overflow-hidden` root container:
     - **Top Header**: Fixed height (`h-14 shrink-0`).
     - **Middle Workspace Split (`flex-1 flex min-h-0 overflow-hidden`)**:
       - **Left Sidebar (`aside`)**: `w-80 shrink-0 h-full overflow-y-auto overscroll-contain` — scrolls its skill list completely independently while keeping its search & filter header pinned at the top of the sidebar.
       - **Right Main Content (`main`)**: `flex-1 min-w-0 h-full overflow-y-auto overscroll-contain` — scrolls the selected skill's Playground / Docs / FileTree / Manifest views independently without ever affecting the left sidebar.

## Acceptance criteria

- [x] The root layout uses `h-screen overflow-hidden` so `window` / `body` never scrolls vertically.
- [x] Scrolling anywhere in the right main pane (Playground, long Markdown docs, File Tree, Manifest editor) leaves the left skill catalog sidebar 100% stationary.
- [x] Scrolling the left skill catalog sidebar leaves the right main pane 100% stationary, and keeps the sidebar search/filter controls pinned at the top of the sidebar.

## Blocked by

None - can start immediately
