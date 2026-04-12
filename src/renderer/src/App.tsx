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
        {/* Workspace badge — shows the basename so the user can glance
            and confirm they're talking to Claude in the right folder.
            Full path goes in the tooltip. */}
        <span
          className="badge badge-workspace"
          title={workspace}
        >
          {basename(workspace)}
        </span>
      </header>
      <main className="main">
        <FusionRuntimeProvider>
          {/* .main is flex-col; this inner row does the three-pane
              split (chats | thread | right rail). flex-1 + min-h-0
              lets it shrink correctly inside the outer column. */}
          <div className="flex min-h-0 flex-1">
            {sidebarOpen && <ThreadListSidebar />}
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
    </div>
  )
}

/**
 * Tiny path basename helper. Avoids pulling `path-browserify` for one
 * call — the workspace path from main is always absolute and either
 * POSIX or Windows-style, and we just want the trailing segment.
 */
function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return i >= 0 ? trimmed.slice(i + 1) : trimmed
}

export default App
