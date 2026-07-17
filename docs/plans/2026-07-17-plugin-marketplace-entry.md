# Plugin Marketplace Entry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Make the real plugin marketplace available from the shared rail and from a `/plugins` chat slash command, while aligning the existing marketplace page with the supplied compact Apple-style prototype.

**Architecture:** Keep `PluginsView` as the single data/installation implementation. The canvas `/plugins` route continues to render it directly; a new chat `PluginsDialog` embeds the same view inside the existing dialog system. Rail and slash-command entry points only select a surface—they do not duplicate marketplace data or install logic.

**Tech Stack:** Next.js App Router, React, Zustand, TypeScript, Tailwind/shadcn dialog primitives, existing Open Design marketplace APIs and CSS tokens.

---

### Task 1: Add the slash-command dialog kind

**Files:**
- Modify: `apps/studio/src/chat/stores/dialogs.ts`
- Modify: `apps/studio/src/chat/runtime/FusionRuntimeProvider.tsx`

**Steps:**
1. Add `plugins` to `DialogKind`.
2. Map `/plugin` and `/plugins` to the new kind in `matchSlashCommand`.
3. Run the studio typecheck and confirm the new union member is handled.

### Task 2: Reuse the real marketplace in chat

**Files:**
- Create: `apps/studio/src/chat/components/dialogs/PluginsDialog.tsx`
- Modify: `apps/studio/src/chat/App.tsx`

**Steps:**
1. Build an accessible large-format dialog using `DialogShell`.
2. Render the existing `PluginsView` inside it so install, import, source, details, and refresh behavior stay real.
3. Mount it with the other slash-command dialogs.
4. Verify close, Escape, and nested marketplace modals.

### Task 3: Add a persistent rail entry

**Files:**
- Modify: `apps/studio/src/components/AppRail.tsx`

**Steps:**
1. Add a 插件 button beside the existing knowledge-base/new-project secondary entries.
2. Navigate with the canvas router to `{ kind: 'home', view: 'plugins' }` so both surfaces reach the canonical `/plugins` page.
3. Preserve the current surface-switch and keep-alive behavior.

### Task 4: Align the marketplace presentation with the prototype

**Files:**
- Modify: `apps/studio/src/canvas/components/plugins/PluginsView.tsx`
- Modify: `apps/studio/src/canvas/styles/home/plugins-view.css`

**Steps:**
1. Simplify the hero copy/action hierarchy and make the marketplace search/filter the primary interaction.
2. Replace heavy stat-card/tab chrome with compact segmented controls and restrained rows/cards.
3. Scope dialog-specific sizing and scrolling so the same component works in both contexts.
4. Check light/dark themes and narrow layouts.

### Task 5: Verify

**Files:**
- No production files added.

**Steps:**
1. Run `bun run --filter='@claude-desktop/studio' typecheck`.
2. Run the relevant studio test command if present.
3. Start the app/web renderer, open `/plugins`, then invoke `/plugins` from chat.
4. Inspect screenshots for layout, overflow, dark theme, and nested modal stacking.

