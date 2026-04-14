import { useCallback, useEffect, useRef, useState } from 'react'

import { FusionRuntimeProvider } from './runtime/FusionRuntimeProvider'
import { ThreadView } from './components/chat/ThreadView'
import { ThreadListSidebar } from './components/chat/ThreadListSidebar'
import { TodoListPanel } from './components/todos/TodoListPanel'
import { PermissionDialog } from './components/permissions/PermissionDialog'
import { SkillsDialog } from './components/dialogs/SkillsDialog'
import { McpDialog } from './components/dialogs/McpDialog'
import { LogsDialog } from './components/dialogs/LogsDialog'
import { WorkspaceGate } from './components/workspace/WorkspaceGate'
import { WorkspaceTreePanel } from './components/workspace/WorkspaceTreePanel'
import { useChatStore } from './stores/chat'
import { useDialogStore } from './stores/dialogs'
import { useLogsStore } from './stores/logs'
import { useTodosStore } from './stores/todos'
import { useI18n, useT } from './i18n'
import { useApplyAppearance } from './stores/appearance.applier'
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
 * Workspace gate
 * --------------
 * Before the main layout mounts, we check `getWorkspace()`. If the
 * user has not yet picked a folder (`path === null`), we render
 * `<WorkspaceGate>` in place of the chat UI. The engine hard-rejects
 * `send()` until a workspace is set, and mounting FusionRuntimeProvider
 * prematurely would fire mount-time IPCs scoped to process.cwd() —
 * wrong on a packaged .app, and wasteful anywhere. So the gate is the
 * only thing on screen until the user drops a folder.
 */

/**
 * Tri-state workspace status:
 *   - 'loading'      → the initial getWorkspace() IPC has not resolved yet.
 *                      We show nothing during this window (a few ms) so
 *                      there's no flash of the gate for users on a warm
 *                      main process (HMR reload on top of an already-set
 *                      workspace).
 *   - null           → main replied with { path: null } — show the gate.
 *   - string         → workspace is set — render the real chat UI.
 */
type WorkspaceStatus = 'loading' | null | string

/**
 * Responsive breakpoints for auto-collapsing the two side rails.
 *
 * Left sidebar (chats) auto-hides below `LEFT_RAIL_MIN` because a
 * ~256px rail eats half the window on a sub-900px viewport; the chat
 * column needs the space more than the thread picker does.
 *
 * Right rail (todos + file tree) needs more elbow room — 288px + 256px
 * + a reasonable chat column = ~1180px, so that's where we draw the
 * line. Below it, the right rail collapses first while the user can
 * still keep the left sidebar around.
 *
 * The constants live next to App() so changes are one-liner diffs.
 */
const LEFT_RAIL_MIN = '(min-width: 860px)'
const RIGHT_RAIL_MIN = '(min-width: 1180px)'

/**
 * Tiny matchMedia hook. Kept inline (no util file) because App.tsx is
 * currently the only consumer. Initial value is read synchronously so
 * the first render already reflects the viewport — avoids a mount-time
 * layout flash on narrow windows.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    return window.matchMedia(query).matches
  })
  useEffect(() => {
    const mql = window.matchMedia(query)
    const handler = (e: MediaQueryListEvent): void => setMatches(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [query])
  return matches
}

function App(): React.JSX.Element {
  const [workspace, setWorkspace] = useState<WorkspaceStatus>('loading')

  // Both rails initialize to "open iff viewport is wide enough". This
  // handles the cold-boot case (user opens an already-narrow window)
  // without needing an extra effect — the very first render is correct.
  const wideEnoughForLeft = useMediaQuery(LEFT_RAIL_MIN)
  const wideEnoughForRight = useMediaQuery(RIGHT_RAIL_MIN)
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    typeof window === 'undefined'
      ? true
      : window.matchMedia(LEFT_RAIL_MIN).matches
  )
  const [rightRailOpen, setRightRailOpen] = useState<boolean>(() =>
    typeof window === 'undefined'
      ? true
      : window.matchMedia(RIGHT_RAIL_MIN).matches
  )

  // Auto-collapse on descent only — VSCode-style. We explicitly do NOT
  // auto-open on ascent: once the user has manually opened or closed a
  // rail, widening the window back shouldn't override that choice.
  // `useRef` tracks the previous breakpoint value so an effect that
  // runs on every render can fire exactly once per descending edge.
  const prevWideLeft = useRef(wideEnoughForLeft)
  useEffect(() => {
    if (prevWideLeft.current && !wideEnoughForLeft) {
      setSidebarOpen(false)
    }
    prevWideLeft.current = wideEnoughForLeft
  }, [wideEnoughForLeft])

  const prevWideRight = useRef(wideEnoughForRight)
  useEffect(() => {
    if (prevWideRight.current && !wideEnoughForRight) {
      setRightRailOpen(false)
    }
    prevWideRight.current = wideEnoughForRight
  }, [wideEnoughForRight])

  const openDialog = useDialogStore((s) => s.openDialog)
  const t = useT()
  useApplyAppearance()

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

  // "Show me the gate again so I can pick a different folder." Wipes
  // every renderer-side store that is keyed on the current workspace
  // (chat history, todos) and flips `workspace` back to null. The
  // engine's setWorkspace() will tear down the live runtime when the
  // gate completes; we don't pre-tear here so a cancelled drop leaves
  // the previous session intact.
  const handleChangeWorkspace = useCallback(() => {
    useChatStore.getState().reset()
    useTodosStore.setState({ todos: {} })
    setWorkspace(null)
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

  // Check workspace state on mount. Main's handler is trivial — it just
  // reads the in-memory engine field — so we don't need to debounce or
  // retry. On HMR reload the main process stays alive and will return
  // the path the user already picked, skipping the gate entirely.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.chatApi) return
    let cancelled = false
    window.chatApi
      .getWorkspace()
      .then((state) => {
        if (!cancelled) setWorkspace(state.path)
      })
      .catch((err) => {
        console.error('[App] getWorkspace failed', err)
        // Treat an IPC error the same as "not set" so the user gets a
        // visible gate instead of staring at a blank window forever.
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

  // Gate slice: no workspace yet. Render *only* the gate — we do NOT
  // mount FusionRuntimeProvider, because doing so would:
  //  - trigger the composer's mount-time getSessionMeta / listFileSuggestions
  //    IPCs, which would scan process.cwd() instead of the user's folder
  //  - risk a misclicked send() firing chat:send while workspaceDir is
  //    still null, which the engine would reject
  // The header badge is kept so the user still sees the version label.
  if (workspace === null) {
    return (
      <div className="app">
        <header className="header">
          <h1>{t('appTitle')}</h1>
        </header>
        <WorkspaceGate onReady={(path) => setWorkspace(path)} />
      </div>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <h1>{t('appTitle')}</h1>
        <button
          type="button"
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? t('collapseSidebar') : t('expandSidebar')}
          aria-label={sidebarOpen ? t('collapseSidebar') : t('expandSidebar')}
          aria-pressed={sidebarOpen}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="group inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="12" height="10" rx="1.75" />
            <line x1="6.25" y1="3" x2="6.25" y2="13" />
            {!sidebarOpen && <line x1="9" y1="6" x2="11.5" y2="8" />}
            {!sidebarOpen && <line x1="11.5" y1="8" x2="9" y2="10" />}
          </svg>
        </button>
        <button
          type="button"
          onClick={() => setRightRailOpen((v) => !v)}
          title={rightRailOpen ? t('collapseRightRail') : t('expandRightRail')}
          aria-label={
            rightRailOpen ? t('collapseRightRail') : t('expandRightRail')
          }
          aria-pressed={rightRailOpen}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="group inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          {/* Mirror of the left-sidebar folder-rect, flipped so the
              divider sits on the right. Reads as "right rail toggle". */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2" y="3" width="12" height="10" rx="1.75" />
            <line x1="9.75" y1="3" x2="9.75" y2="13" />
            {!rightRailOpen && <line x1="7" y1="6" x2="4.5" y2="8" />}
            {!rightRailOpen && <line x1="4.5" y1="8" x2="7" y2="10" />}
          </svg>
        </button>
        <button
          type="button"
          onClick={() => openDialog('logs')}
          title={t('openLogsTitle')}
          aria-label={t('openLogs')}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="group inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          {/* Clipboard-with-lines icon — intentionally distinct from
              the sidebar toggle's folder-rect. 3 horizontal lines
              read as "log entries" at 16px. */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="2.5" width="10" height="11" rx="1.5" />
            <line x1="5.5" y1="5.5" x2="10.5" y2="5.5" />
            <line x1="5.5" y1="8" x2="10.5" y2="8" />
            <line x1="5.5" y1="10.5" x2="8.5" y2="10.5" />
          </svg>
        </button>
      </header>
      <main className="main relative">
        {/* `key={workspace}` forces a full subtree remount whenever the
            user switches workspaces. The runtime provider's effects
            re-subscribe to chat events under the new sessionId, the
            sidebar refetches the new workspace's threads, and the file
            tree drops its cached scan. Cheaper than restarting Electron
            and avoids the window-flash. */}
        <FusionRuntimeProvider key={workspace}>
          {/* .main is flex-col; this inner row does the three-pane
              split (chats | thread | right rail). flex-1 + min-h-0
              lets it shrink correctly inside the outer column. */}
          <div className="flex min-h-0 flex-1">
            {/* Sidebar slide — width animates between 0 and 256px so
                the thread view smoothly reclaims the space. The inner
                ThreadListSidebar keeps its fixed w-64, and the wrapper
                clips it during the transition. AnimatePresence lets
                the exit animation run before unmount. `initial={false}`
                skips the entrance animation on first mount so the app
                doesn't slide in from zero on boot. */}
            {/* Sidebar slide — width animates between 0 and 256px so
                the thread view smoothly reclaims the space. The inner
                ThreadListSidebar is absolutely anchored to the right
                edge of this wrapper so its right border (see
                `border-r` on ThreadListPrimitive.Root) sits flush with
                the wrapper edge throughout the animation — otherwise
                the border would only appear when width reaches 256.
                Content slides in from behind the ThreadView instead
                of growing from the left. `initial={false}` skips the
                first-mount slide-in on boot. */}
            <AnimatePresence initial={false}>
              {sidebarOpen && (
                <motion.div
                  key="sidebar"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 256, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{
                    type: 'spring',
                    stiffness: 320,
                    damping: 34,
                    mass: 0.9
                  }}
                  className="relative h-full shrink-0 overflow-hidden"
                >
                  <div className="absolute inset-y-0 right-0 w-64">
                    <ThreadListSidebar
                      workspace={workspace}
                      onChangeWorkspace={handleChangeWorkspace}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <ThreadView />
            {/* Right rail — single 288px column whose vertical space
                is split 50/50 between the Todos (top) and the
                Workspace file tree (bottom). The rail owns the
                border + background chrome; both panels inside are
                `section flex-1` so they share the column equally.
                A border-t on WorkspaceTreePanel's root creates the
                visual divider.
                Wrapped in AnimatePresence so it can slide out smoothly
                on narrow windows (auto-collapse at < 1180px, manual
                toggle from the header button). The inner aside is
                absolutely anchored to the right edge of the animating
                wrapper — same pattern as the left sidebar — so the
                left border of the aside stays flush with the wrapper
                edge throughout the width animation instead of
                appearing only once width reaches 288px. */}
            <AnimatePresence initial={false}>
              {rightRailOpen && (
                <motion.div
                  key="right-rail"
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 288, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{
                    type: 'spring',
                    stiffness: 320,
                    damping: 34,
                    mass: 0.9
                  }}
                  className="relative h-full shrink-0 overflow-hidden"
                >
                  <aside className="absolute inset-y-0 right-0 flex h-full w-72 flex-col bg-background/45 backdrop-blur-xl backdrop-saturate-150">
                    <TodoListPanel />
                    <WorkspaceTreePanel />
                  </aside>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </FusionRuntimeProvider>
        {/* Settings overlay — `absolute inset-0` inside .main so it
            covers the chat row but leaves the title-bar header
            untouched. Renders null when the store says closed. */}
        <SettingsView />
      </main>
      {/* Permission dialog — `fixed inset-0` overlay, kept outside
          <main> so it covers the header and both panes. Listens to
          main-process permission requests via preload IPC, so it does
          not need an assistant-ui runtime context. */}
      <PermissionDialog />
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
