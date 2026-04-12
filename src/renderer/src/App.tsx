import { useEffect, useState } from 'react'

import { FusionRuntimeProvider } from './runtime/FusionRuntimeProvider'
import { ThreadView } from './components/chat/ThreadView'
import { ThreadListSidebar } from './components/chat/ThreadListSidebar'
import { TodoListPanel } from './components/todos/TodoListPanel'
import { PermissionDialog } from './components/permissions/PermissionDialog'
import { SkillsDialog } from './components/dialogs/SkillsDialog'
import { McpDialog } from './components/dialogs/McpDialog'
import { WorkspaceGate } from './components/workspace/WorkspaceGate'
import { WorkspaceTreePanel } from './components/workspace/WorkspaceTreePanel'
import { useChatStore } from './stores/chat'
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

function App(): React.JSX.Element {
  const [version, setVersion] = useState<string>('loading…')
  const [workspace, setWorkspace] = useState<WorkspaceStatus>('loading')
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true)

  useEffect(() => {
    if (typeof window !== 'undefined' && window.api) {
      setVersion(window.api.version)
    }
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
          <h1>Claude Desktop</h1>
          <span className="badge">v{version}</span>
          <span className="badge badge-stage">agent-sdk · long-session</span>
        </header>
        <WorkspaceGate onReady={(path) => setWorkspace(path)} />
      </div>
    )
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Claude Desktop</h1>
        <button
          type="button"
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? '收起聊天列表' : '展开聊天列表'}
          aria-label={sidebarOpen ? '收起聊天列表' : '展开聊天列表'}
          aria-pressed={sidebarOpen}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="group inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800/60 hover:text-zinc-100"
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
        <span className="badge">v{version}</span>
        <span className="badge badge-stage">agent-sdk · long-session</span>
      </header>
      <main className="main">
        <FusionRuntimeProvider>
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
                    <ThreadListSidebar workspace={workspace} />
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
                visual divider. */}
            <aside className="flex h-full w-72 shrink-0 flex-col border-l border-zinc-800/70 bg-[#0a0a0c]">
              <TodoListPanel />
              <WorkspaceTreePanel />
            </aside>
          </div>
        </FusionRuntimeProvider>
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

  return (
    <AnimatePresence>
      {sessionLoading && (
        <motion.div
          key="session-loading"
          role="status"
          aria-live="polite"
          aria-label="Opening session"
          initial={{ opacity: 0, y: 8, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 340, damping: 28 }}
          className="pointer-events-none fixed bottom-4 right-4 z-[60] flex items-center gap-2.5 rounded-full border border-zinc-800 bg-zinc-950/90 px-3.5 py-2 shadow-[0_4px_24px_rgba(0,0,0,0.4)] backdrop-blur-sm"
        >
          {/* Bouncing dots — shrunk from the old fullscreen version
              (size-2 → size-1.5, y: -6 → -3) so the pill stays tight. */}
          <div className="flex items-center gap-1">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                aria-hidden
                className="block size-1.5 rounded-full bg-zinc-200"
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
            className="text-[12px] font-medium tracking-wide text-zinc-200"
            animate={{ opacity: [0.7, 1, 0.7] }}
            transition={{
              duration: 1.8,
              repeat: Infinity,
              ease: 'easeInOut'
            }}
          >
            Opening session…
          </motion.span>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default App
