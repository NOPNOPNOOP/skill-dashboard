# Issue 12: Upstream Skill Version Status & One-Click Update (`npx skills update` / `git pull`) with `.dashboard/` Guard

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #4, #8, #28)

## What to build

Enable users to see the upstream source/timestamp of any installed skill and pull the latest upstream version in one click while protecting local `.dashboard/` configurations from being overwritten:

1. **Upstream Update Strategy & Provenance Display**:
   - Determine each `CanonicalSkill`'s `updateStrategy`:
     - `"npx-lock"`: Skill is tracked in `~/.agents/.skill-lock.json` or `~/skills-lock.json` (46+ community skills). Display source repo (`source`, `sourceUrl`), short folder hash, and `updatedAt` timestamp.
     - `"git"`: Skill directory contains a `.git` repository.
     - `"local"`: Local authoring directory without remote lock entry.
2. **One-Click Single Skill Update & Global Update All (`POST /api/skills/:skillId/update` & `POST /api/skills/update-all`)**:
   - **`.dashboard/` Configuration Guard**: Before running `npx -y skills update <skillId> -g -y` (which may wipe and recreate the skill folder), snapshot any existing `<skillDir>/.dashboard/` directory into a temporary backup buffer and restore it automatically if the updater removes it.
   - Stream the update command inside the Web PTY console (`TerminalDrawer`) and automatically refresh the skill catalog upon completion.
   - Provide an `⬆ Update` button on updatable skill headers and an `⬆ Update All` button in the left catalog sidebar.

## Acceptance criteria

- [x] Skills tracked in `.skill-lock.json` or containing `.git` display their upstream source and `updatedAt` status in the Skill Hero header alongside an `⬆ Update` button.
- [x] Clicking `⬆ Update` runs the appropriate update command (`npx -y skills update <id> -g -y` or `git pull --ff-only`) in the Web PTY and preserves any existing `<skill>/.dashboard/` companion directory across the update.
- [x] Clicking `⬆ Update All` in the sidebar updates all global `npx skills` packages in the Web PTY.
- [x] Automated tests in `tests/server.test.ts` verify `updateStrategy` detection and `.dashboard/` backup-and-restore protection across simulated upstream folder replacement.

## Blocked by

None - can start immediately
