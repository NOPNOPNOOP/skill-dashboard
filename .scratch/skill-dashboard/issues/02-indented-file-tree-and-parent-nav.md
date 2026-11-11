# Issue 02: Hierarchical Indented File Tree with Expandable Folders & `../` Parent Directory Row

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Story #14)

## What to build

Upgrade the **File Tree Inspector** end-to-end (from the `/api/skills/:skillId/files` endpoint to the UI tree component) to support a true hierarchical indented tree alongside quick `../` parent directory navigation:

1. **Hierarchical Tree API & Node Structure**:
   - Extend `GET /api/skills/:skillId/files` to support recursive tree retrieval (`depth` / `recursive=1`) returning nested `children?: FileTreeNode[]` while preserving strict directory pruning (`.git`, `node_modules`, `__pycache__`, `.venv`, `.DS_Store`, etc.) and path-traversal protection (`isPathInsideRoot`).
   - Also return `parentPath: string | null` for any non-root `path` query so clients know the exact parent directory.

```typescript
export interface FileTreeNode {
  name: string;
  relativePath: string;
  type: "file" | "directory";
  size?: number;
  extension?: string;
  children?: FileTreeNode[];
}
```

2. **Indented Tree View + `../` Parent Navigation in UI**:
   - Render directories and files as an indented tree (`paddingLeft` scaled by tree depth with subtle vertical guide lines and expand/collapse chevrons for folders).
   - Allow both inline folder expansion/collapse in the tree AND double-clicking / clicking a "Focus Folder" action (or navigating into a subfolder), and whenever the current root path is inside a subdirectory (`currentFileDir !== ""`), always render a prominent clickable **`../` (Parent Directory)** row at the very top of the tree list to jump up one level immediately.

## Acceptance criteria

- [x] `GET /api/skills/:skillId/files?path=<subDir>&recursive=1` returns nested `FileTreeNode` items with `children` for directories and `parentPath` metadata (`""` when one level deep, or `null` at root).
- [x] The File Tree Inspector renders nested directories and files with visual depth indentation, tree guide lines, and expand/collapse folder toggles.
- [x] Whenever viewing or focusing a subdirectory (`currentFileDir !== ""`), the first row in the directory list is an explicit clickable `../` item that navigates immediately to the parent directory.
- [x] Selecting any file at any indentation depth loads and previews its content in the right-hand inspector pane.
- [x] Automated tests in `tests/server.test.ts` verify recursive tree listing, `parentPath` calculation, and path traversal rejection.

## Blocked by

None - can start immediately
