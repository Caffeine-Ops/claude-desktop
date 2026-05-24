import { useEffect, useState } from 'react'

import { FusionRuntimeProvider } from './runtime/FusionRuntimeProvider'
import { ThreadView } from './components/chat/ThreadView'
import { ThreadListSidebar } from './components/chat/ThreadListSidebar'
import { TodoListPanel } from './components/todos/TodoListPanel'
import { PermissionBridge } from './components/permissions/PermissionBridge'
import { SkillsDialog } from './components/dialogs/SkillsDialog'
import { McpDialog } from './components/dialogs/McpDialog'
import { LogsDialog } from './components/dialogs/LogsDialog'
import { WorkspaceTreePanel } from './components/workspace/WorkspaceTreePanel'
import { useChatStore } from './stores/chat'
import { useLogsStore } from './stores/logs'
import { useWorkspaceStore } from './stores/workspace'
import { useI18n, useT } from './i18n'
import { useSettingsStore } from './stores/settings'
import { useDialogStore } from './stores/dialogs'
import { useApplyAppearance } from './stores/appearance.applier'
import { hydrateAppearanceFromDaemon } from './stores/appearance'
import { SettingsView } from './components/settings/SettingsView'
import { AnimatePresence, motion } from 'motion/react'

/**
 * Root renderer component.
 *
 * Layout
 * ------
 *   .app                        (flex column, 100vh)
 *     header                    (window chrome — title + version badge)
 *     main                      (flex column, fills remaining height)
 *       FusionRuntimeProvider   (runtime context — no DOM)
 *         horizontal flex row
 *           ThreadListSidebar   (w-64, left rail — chats)
 *           ThreadView          (flex-1, main chat area)
 *           TodoListPanel       (w-72, right rail — todos)
 *
 * The horizontal flex row lives *inside* the runtime provider so both
 * the sidebar (ThreadListPrimitive) and the chat view (ThreadPrimitive)
 * share the same AssistantRuntime — otherwise the sidebar couldn't
 * resolve its context. TodoListPanel doesn't depend on the runtime, but
 * keeping it inside the row gives the three panes a single shared flex
 * parent for consistent full-height sizing.
 *
 * Workspace
 * ---------
 * Before the main layout mounts, we read `getWorkspace()`. The engine
 * defaults every tab to the OS Desktop, so this returns a real path on
 * cold start — there is no "pick a folder" gate anymore. We still wait
 * for the IPC to resolve before mounting FusionRuntimeProvider, because
 * its mount-time IPCs are scoped to that path and we don't want them
 * firing against a stale/null cwd.
 */

/**
 * Tri-state workspace status:
 *   - 'loading'      → the initial getWorkspace() IPC has not resolved yet.
 *                      We render an empty `.app` during this window (a few
 *                      ms) so there's no flash before the chat UI mounts.
 *   - null           → the getWorkspace() IPC errored. Should-never-happen
 *                      now that main always defaults to the Desktop; we
 *                      render an empty `.app` rather than a null-cwd runtime.
 *   - string          → workspace path is known — render the real chat UI.
 */
type WorkspaceStatus = 'loading' | null | string

function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState<WorkspaceStatus>('loading')

  // 三个工作区面板（左对话列表、右代办、右文件树）现在**默认常开、不可收起**。
  // 以前 header 里有两个折叠按钮 + 随窗口宽度自动收起的逻辑（sidebarOpen /
  // rightRailOpen state + useMediaQuery 断点 + AnimatePresence 滑入滑出），
  // 已全部移除——面板恒定渲染为固定宽度的静态列。整条 .header--tab 也一并删了，
  // chat 内容直接顶到顶部 shell tab 条下方。
  useApplyAppearance()

  // Adopt the daemon's shared appearance as the source of truth — once on
  // mount, then again every time main says it changed (APPEARANCE_CHANGED,
  // fired after ANY window edits appearance). The applier above has already
  // rendered the localStorage cache (no flash); the mount hydrate overwrites
  // it with the daemon copy when reachable, and the subscription keeps this
  // renderer in lockstep with a theme switch made in the settings overlay or
  // another tab — without it the change only landed here on a reload. No-op
  // when the daemon is offline (cache stays). main skips the window that made
  // the change, and hydrate's own isHydrating guard prevents an echo back.
  useEffect(() => {
    void hydrateAppearanceFromDaemon()
    if (!window.chatApi?.onAppearanceChanged) return
    return window.chatApi.onAppearanceChanged(() => {
      void hydrateAppearanceFromDaemon()
    })
  }, [])

  // Subscribe to settings-menu actions forwarded from the shell's tab-strip
  // menu (the menu used to live in this renderer's sidebar; it now lives in
  // the shell, a separate webContents). Each action maps onto a local store:
  // open the settings overlay, open the logs dialog, or toggle language.
  // Only the active chat tab receives these. We read/dispatch via getState so
  // this effect has no store deps and runs exactly once.
  useEffect(() => {
    if (!window.chatApi?.onShellMenuAction) return
    return window.chatApi.onShellMenuAction((action) => {
      if (action === 'open-settings') {
        useSettingsStore.getState().openSettings()
      } else if (action === 'open-logs') {
        useDialogStore.getState().openDialog('logs')
      } else if (action === 'toggle-lang') {
        const cur = useI18n.getState().lang
        useI18n.getState().setLang(cur === 'zh' ? 'en' : 'zh')
      }
    })
  }, [])

  // One-shot push of the persisted language to the main process. The
  // renderer's zustand store is the source of truth (it owns the
  // localStorage entry), but the tray menu lives in the main process
  // and has no access to localStorage. Pushing here on cold start
  // syncs main with whatever the user picked in a previous run; every
  // subsequent flip pushes again from inside `setLang` itself.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chatApi?.setLang) return
    try {
      window.chatApi.setLang(useI18n.getState().lang)
    } catch (err) {
      console.warn('[App] initial setLang push failed', err)
    }
  }, [])

  // Subscribe to main-process engine log events from the moment the
  // app mounts so the LogsDialog has a full history available the
  // first time the user opens it. Runs once per process lifetime —
  // even before the workspace gate is passed — because the engine
  // may emit log events on workspace setup that we don't want to
  // miss. `useLogsStore.getState().push` reads the current action
  // rather than subscribing, so this effect doesn't rerun on every
  // push.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chatApi) return
    const push = useLogsStore.getState().push
    const unsub = window.chatApi.onLogEvent((event) => {
      push({
        id: `${event.ts}_${Math.random().toString(36).slice(2, 7)}`,
        ts: event.ts,
        label: event.label,
        sessionId: event.sessionId,
        details: event.details
      })
    })
    return unsub
  }, [])

  // Mirror the workspace store's `current` into our React state so a
  // future "change folder" commit (via the store's `switchTo`) flows
  // into FusionRuntimeProvider's `key={workspace}` remount. Without this
  // subscription the store would update in isolation and the runtime
  // subtree would stay bound to the old cwd. Harmless no-op today since
  // there is no live switch entry point.
  useEffect(() => {
    const unsub = useWorkspaceStore.subscribe((state, prev) => {
      if (state.current === prev.current) return
      if (state.current !== null) {
        setWorkspace(state.current)
      }
    })
    return unsub
  }, [])

  // Read workspace state on mount. Main's handler is trivial — it just
  // reads the in-memory engine field, which is defaulted to the OS
  // Desktop at construction — so this resolves to a real path with no
  // debounce/retry needed. On HMR reload the main process stays alive
  // and returns the same path.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chatApi) return
    let cancelled = false
    window.chatApi
      .getWorkspace()
      .then((state) => {
        if (cancelled) return
        setWorkspace(state.path)
        if (state.path) {
          useWorkspaceStore.getState().setCurrent(state.path)
          useWorkspaceStore.getState().pushRecent(state.path)
        }
      })
      .catch((err) => {
        console.error('[App] getWorkspace failed', err)
        // Should-never-happen now that main always defaults to the
        // Desktop. On an IPC error we set null, which renders an empty
        // `.app` rather than mounting the runtime against an unknown cwd.
        if (!cancelled) setWorkspace(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Loading slice: brief flash-prevention. `.app` keeps the window
  // chrome / background consistent with the mounted state.
  if (workspace === 'loading') {
    return <div className="app" />
  }

  // No-workspace slice. The engine now defaults every tab to the OS
  // Desktop, so `getWorkspace()` returns a real path on cold start and
  // there is no "pick a folder" gate anymore. `workspace === null` can
  // therefore only mean the getWorkspace() IPC itself errored (handled
  // in the effect's catch) — a should-never-happen state. We render an
  // empty `.app` (same as the loading slice) rather than mount the
  // runtime with a null cwd, whose mount-time IPCs would scan the wrong
  // directory. `hasWorkspace` still gates FusionRuntimeProvider below as
  // defense-in-depth.
  const hasWorkspace = workspace !== null
  if (!hasWorkspace) {
    return <div className="app" />
  }

  return (
    <div className="app">
      {/* 旧的 .header--tab 整条已移除——它只承载左右面板的折叠按钮，而面板
          现在常开不可收起，按钮失去意义。chat 内容直接顶到顶部 shell tab 条
          （shell/ShellApp.tsx）下方，省掉一条横栏。 */}
      <main className="main relative">
        {/* `key={workspace}` keys the runtime subtree to the workspace
            path so it remounts cleanly if the bound path ever changes.
            The runtime provider's effects
            re-subscribe to chat events under the new sessionId, the
            sidebar refetches the new workspace's threads, and the file
            tree drops its cached scan. Cheaper than restarting Electron
            and avoids the window-flash. Not mounted at all until a
            workspace exists — see the comment on `hasWorkspace`. */}
        {hasWorkspace && (
        <FusionRuntimeProvider key={workspace}>
          {/* .main is flex-col; this inner row does the three-pane
              split (chats | thread | right rail). flex-1 + min-h-0
              lets it shrink correctly inside the outer column. */}
          <div className="flex min-h-0 flex-1">
            {/* 左对话列表 — 固定 256px 常驻列，不再可收起。以前包在
                AnimatePresence 里随窗口宽度滑入滑出，现已改为静态列：始终
                渲染。ThreadListSidebar 自带 w-64 + 右边框。 */}
            <div className="h-full w-64 shrink-0">
              <ThreadListSidebar />
            </div>
            <ThreadView />
            {/* 右栏 — 固定 288px 常驻列，纵向 50/50 分给代办（上）和工作区
                文件树（下）。同样去掉了 AnimatePresence 收起逻辑，始终渲染。
                两个面板都是 `section flex-1` 平分这一列；WorkspaceTreePanel
                的 border-t 作为分隔线。 */}
            <aside className="flex h-full w-72 shrink-0 flex-col gap-4 bg-background/70 p-3.5 backdrop-blur-2xl backdrop-saturate-150 shadow-[inset_1px_0_0_rgba(0,0,0,0.06)] dark:shadow-[inset_1px_0_0_rgba(255,255,255,0.08)]">
              <TodoListPanel />
              <WorkspaceTreePanel />
            </aside>
          </div>
        </FusionRuntimeProvider>
        )}
        {/* Settings overlay — `absolute inset-0` inside .main so it
            covers the chat row but leaves the title-bar header
            untouched. Renders null when the store says closed. */}
        <SettingsView />
      </main>
      {/* Permission bridge — headless component that subscribes the
          permission store to main-process IPC events. The actual
          decision UI lives inline inside each tool's ToolCallCard
          (see InlinePermissionPrompt), so this component renders
          nothing visible. Kept at App root so a single subscription
          serves every tool card in the tree. */}
      <PermissionBridge />
      {/* Slash-command dialogs. Each subscribes to the dialog store
          and renders only when its kind is open. They sit at the same
          level as PermissionDialog so they overlay everything. */}
      <SkillsDialog />
      <McpDialog />
      <LogsDialog />
      {/* Non-blocking session-loading toast — shown while main is
          spawning a fusion-code child (new chat / session switch).
          Kept as its own tiny component so the zustand subscription
          doesn't re-render the whole App tree on every flip. The
          composer's send button is already disabled during the switch
          via `useExternalStoreRuntime.isLoading`, so this toast only
          needs to *signal* the cold start — not block interaction. */}
      <SessionLoadingOverlay />
    </div>
  )
}

/**
 * Non-blocking toast shown in the bottom-right while `sessionLoading`
 * is true. Previously a fullscreen veil that hid the entire UI during
 * the ~8s fusion-code cli cold start — which also hid the chat history
 * the user just clicked to read. Now the parallelized `onSwitchToThread`
 * in FusionRuntimeProvider mounts history the instant `loadSession`
 * returns (~100ms), so this indicator only needs to *signal* that the
 * cli is still warming up. Interaction is gated elsewhere:
 *
 *  - Composer send button: `useExternalStoreRuntime.isLoading` in
 *    FusionRuntimeProvider — assistant-ui greys it out automatically.
 *  - Sidebar thread rows: `pointer-events-none opacity-60` in
 *    ThreadListSidebar when `sessionLoading` is true.
 *
 * Composition
 * -----------
 * - `pointer-events-none` so the toast itself never intercepts clicks
 *   at the corner (defensive; the target area rarely holds controls).
 * - `motion` spring entry + exit so the pill scales + translates in
 *   from the corner instead of snapping.
 * - Three staggered dots bounce in an infinite loop — a condensed
 *   version of the old fullscreen animation so the visual language
 *   survives the layout shrink.
 *
 * Motion respects `prefers-reduced-motion` by default, so users with
 * that setting still see a static pill.
 */
function SessionLoadingOverlay(): React.JSX.Element {
  const sessionLoading = useChatStore((s) => s.sessionLoading)
  const t = useT()
  // Strip the trailing ellipsis so screen readers don't read it aloud.
  const label = t('openingSession').replace(/[…\.]+$/, '')

  return (
    <AnimatePresence>
      {sessionLoading && (
        <motion.div
          key="session-loading"
          role="status"
          aria-live="polite"
          aria-label={label}
          initial={{ opacity: 0, y: 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 340, damping: 28 }}
          className="pointer-events-none fixed bottom-4 right-4 z-[60] flex items-center gap-2.5 rounded-full border border-border bg-background/90 px-3.5 py-2 shadow-[0_4px_24px_rgba(0,0,0,0.4)] backdrop-blur-sm"
        >
          {/* Bouncing dots — shrunk from the old fullscreen version
              (size-2 → size-1.5, y: -6 → -3) so the pill stays tight. */}
          <div className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                aria-hidden
                className="block size-1.5 rounded-full bg-foreground"
                animate={{ y: [0, -3, 0], opacity: [0.5, 1, 0.5] }}
                transition={{
                  duration: 1.1,
                  repeat: Infinity,
                  ease: 'easeInOut',
                  delay: i * 0.15
                }}
              />
            ))}
          </div>
          <motion.span
            className="text-[12px] font-medium tracking-wide text-foreground"
            animate={{ opacity: [0.7, 1, 0.7] }}
            transition={{
              duration: 1.8,
              repeat: Infinity,
              ease: 'easeInOut'
            }}
          >
            {t('openingSession')}
          </motion.span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default App
