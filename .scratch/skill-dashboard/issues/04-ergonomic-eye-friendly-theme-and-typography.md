# Issue 04: Eye-Friendly Theme System (Warm Paper Light & Soft Slate Dark) and Ergonomic Typography Hierarchy

Status: completed

## Parent

- `.scratch/skill-dashboard/PRD.md` (User Stories #15, #18)

## What to build

Redesign the visual ergonomics of the Skill Dashboard Studio to eliminate eye strain and visual clutter across long engineering sessions:

1. **Dual Eye-Comfort Theme System (`Warm Daylight` & `Soft Slate Dark`)**:
   - Provide a header theme toggle (`Warm Light` / `Soft Dark`) persisted in `localStorage` (defaulting to the eye-friendly `Warm Daylight` paper palette or soft low-glare slate):
     - **Warm Daylight (`light`)**: Warm paper background (`#f6f5f0`), crisp ivory card surfaces (`#ffffff`), soft stone borders (`#e4e2dd`), deep charcoal body text (`#1e293b`), and muted semantic accents—eliminating dark-mode halation/astigmatism fatigue when reading dense documentation and forms.
     - **Soft Slate (`dark`)**: Low-glare graphite surfaces (`#161920` / `#1e222b`) with softened borders (`#2a303c`) and warm-tinted off-white text (`#e2e8f0`) instead of pitch-black `#020617` high-contrast glare.
   - Synchronize `xterm.js` terminal theme and Markdown prose styling with the active theme.
2. **Ergonomic Typography, Spacing & Visual Decluttering**:
   - Increase base body, description, and form control font sizes from `11px–12px` to a comfortable `13px–15px` scale with generous line height (`1.6`).
   - De-emphasize secondary metadata (mount badges, raw paths, config layer indicators) using subtle pills and progressive disclosure so skill names, categories, and primary actions stand out cleanly.

## Acceptance criteria

- [x] A theme switcher in the header toggles seamlessly between `Warm Daylight` (eye-friendly warm light mode) and `Soft Slate` (low-glare dark mode), persisting the choice across reloads.
- [x] All panels (Skill Catalog sidebar, Skill Hero, Playground, Markdown Docs, File Tree, Manifest Studio, and Modals) adapt cleanly to both themes via CSS custom variables / semantic classes.
- [x] Typography across descriptions, form labels, inputs, and documentation uses an easy-to-read `13px–15px` scale with reduced border noise.
- [x] Frontend bundle builds cleanly (`bun run build:ui`) and all server seam tests (`bun test`) pass.

## Blocked by

None - can start immediately
