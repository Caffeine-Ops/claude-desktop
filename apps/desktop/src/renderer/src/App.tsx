import { useCallback, useEffect, useRef, useState } from 'react'

import { FusionRuntimeProvider } from './runtime/FusionRuntimeProvider'
import { ThreadView } from './components/chat/ThreadView'
import { ThreadListSidebar } from './components/chat/ThreadListSidebar'
import { TodoListPanel } from './components/todos/TodoListPanel'
import { PermissionBridge } from './components/permissions/PermissionBridge'
import { SkillsDialog } from './components/dialogs/SkillsDialog'
import { McpDialog } from './components/dialogs/McpDialog'
import { LogsDialog } from './components/dialogs/LogsDialog'
import { WorkspaceTreePanel } from './components/workspace/WorkspaceTreePanel'
import { ProposalDocPanel } from './components/workspace/ProposalDocPanel'
import { useChatStore } from './stores/chat'
import { useProposalForeground, useProposalWorkspace, useProposalStore } from './stores/proposal'
import { PaneSplitter } from './components/workspace/PaneSplitter'
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
 * Proposal-workspace mode (useProposalWorkspace): the chat-history rail is
 * hidden, ThreadView moves into a collapsible column (with a 返回 header and a
 * collapse toggle), a PaneSplitter sits between it and the widened
 * ProposalDocPanel, and a floating 返回/展开 cluster appears when collapsed.
 * ThreadView keeps a stable key so it never remounts across the mode toggle.
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

  // 方案模式下，方案草稿面板（w-96）会作为右栏出现。若同时保留 Todos+工作区
  // 那个 w-72 右栏，4 个固定列在常见窗宽（≈1280）下会把中间 ThreadView 挤到
  // 只剩 ~140px——composer 几乎没法输入（实测回归）。方案写作时 Todos 本就为空
  // （对话驱动不再写死章节）、工作区树也非重点，所以方案激活时隐藏这个右栏，让
  // 方案面板顶替成第 3 列，回到正常 3 列布局、composer 保持可用宽度。
  // 用 useProposalForeground（active + 绑定 sessionId === 前台 sessionId），而非裸
  // active：否则 tab 内切到别的会话后右栏仍被隐藏（评审 #8）。与 ProposalDocPanel
  // 同一门控，保证「藏右栏」与「显方案面板」同进同出。
  // 注意：此 hook 必须在下面任何提前 return 之前调用，否则加载态/无工作区态会少调
  // 一个 hook，触发 React「Rendered more hooks than during the previous render」。
  const proposalForeground = useProposalForeground()
  const proposalWorkspace = useProposalWorkspace()
  const setWorkspaceOpen = useProposalStore((s) => s.setWorkspaceOpen)
  const rowRef = useRef<HTMLDivElement | null>(null)

  // 对话列宽度/折叠：持久化到 localStorage（每 tab 一个 renderer，天然按 tab 隔离）。
  // 初值用惰性 initializer 读 localStorage，避免每次渲染重读。
  const [chatColWidth, setChatColWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('proposal:chatColWidth'))
    return Number.isFinite(v) && v >= 320 ? v : 420
  })
  const [chatCollapsed, setChatCollapsed] = useState<boolean>(
    () => localStorage.getItem('proposal:chatCollapsed') === '1'
  )
  useEffect(() => {
    localStorage.setItem('proposal:chatColWidth', String(chatColWidth))
  }, [chatColWidth])
  useEffect(() => {
    localStorage.setItem('proposal:chatCollapsed', chatCollapsed ? '1' : '0')
  }, [chatCollapsed])

  // 对话列宽钳制：[320, 行宽 - 纸面可用最小(480) - 留白(64) - 分隔条(7)]。拖动与挂载/
  // 缩放复位共用。预留的是纸面「可用最小宽」480 而非整页 A4(794)——纸面本身已能缩
  // （编辑态 w-[min(794,100%-48)]）/横滚（预览态 overflow-auto），故钳制只需保证纸面不
  // 窄到不可用即可。若仍硬留 794，窄窗口（行宽 < 320+794+71 ≈ 1185）会令 max 撞到 320
  // 下限、分隔条零行程、chat 被钉死（评审 #7）；降到 480 后死区阈值降到约 871px。
  const clampChatWidth = useCallback((w: number): number => {
    const row = rowRef.current
    if (!row) return Math.max(320, w)
    const max = Math.max(320, row.getBoundingClientRect().width - 480 - 64 - 7)
    return Math.max(320, Math.min(w, max))
  }, [])

  // 分隔条拖动：clientX → 对话列宽度（经 clampChatWidth 钳制）。
  function onSplitDrag(clientX: number): void {
    const row = rowRef.current
    if (!row) return
    setChatColWidth(clampChatWidth(clientX - row.getBoundingClientRect().left))
  }

  // 复位钳制：持久化的宽度只在拖动时被钳制——若在大窗口拖宽并存盘、再在小窗口启动或
  // 缩窗，存回的宽值不会自动收窄，会把 A4(794) 挤出可视区（评审 #4）。这里在进入工作台
  // 与窗口 resize 时各夹一次，把宽度复位进当前行宽的合法区间。宽度已合法时 clamp 返回
  // 原值、setState 同值 React 自动 bail，无重渲循环。
  useEffect(() => {
    if (!proposalWorkspace) return
    const reclamp = (): void => setChatColWidth((w) => clampChatWidth(w))
    reclamp()
    window.addEventListener('resize', reclamp)
    return () => window.removeEventListener('resize', reclamp)
  }, [proposalWorkspace, clampChatWidth])

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
          <div ref={rowRef} className="relative flex min-h-0 flex-1">
            {/* 左对话列表 — 固定 256px 常驻列。工作台模式下隐藏（方案面板
                铺满行宽，历史栏会把对话列挤垮），返回普通模式后复现。 */}
            {!proposalWorkspace && (
              <div className="h-full w-64 shrink-0">
                <ThreadListSidebar />
              </div>
            )}
            {/* ── 可折叠对话列 ──────────────────────────────────────────────────
                包裹 div 与 ThreadView key="main-thread" 在两种模式下都渲染于
                同一位置，仅切 className/宽度；稳定 key 保证工作台头部
                出现/消失时 ThreadView 原地协调（不重挂、不丢滚动位置）。
                ⚠️ 禁止写 proposalWorkspace ? <A/> : <B/>，会让 ThreadView
                  在两个父节点间漂移，触发 assistant-ui runtime 重连 + 历史
                  闪断（历史教训）。                                          */}
            <div
              className={
                proposalWorkspace
                  ? 'relative flex h-full min-h-0 flex-col overflow-hidden border-r border-border'
                  : 'flex min-h-0 flex-1 flex-col'
              }
              style={
                proposalWorkspace
                  ? {
                      width: chatCollapsed ? 0 : chatColWidth,
                      transition: 'width .26s cubic-bezier(.4,0,.2,1)'
                    }
                  : undefined
              }
            >
              {proposalWorkspace && (
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <button
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium hover:bg-muted"
                    onClick={() => setWorkspaceOpen(false)}
                  >
                    ← 返回
                  </button>
                  <button
                    className="grid size-7 place-items-center rounded-md border border-border text-muted-foreground hover:border-accent hover:text-accent"
                    title="折叠对话"
                    onClick={() => setChatCollapsed(true)}
                  >
                    «
                  </button>
                </div>
              )}
              <ThreadView key="main-thread" />
            </div>

            {/* 折叠态浮动簇：返回 + 展开对话，悬纸张左上角、不挡正文 */}
            {proposalWorkspace && chatCollapsed && (
              <div className="absolute left-0 top-12 z-30 flex flex-col gap-2 p-2">
                <button
                  className="grid size-9 place-items-center rounded-lg border border-border bg-card text-foreground shadow-lg hover:border-accent hover:text-accent"
                  title="返回"
                  onClick={() => setWorkspaceOpen(false)}
                >
                  ←
                </button>
                <button
                  className="grid size-9 place-items-center rounded-lg border border-border bg-card text-foreground shadow-lg hover:border-accent hover:text-accent"
                  title="展开对话"
                  onClick={() => setChatCollapsed(false)}
                >
                  ▤
                </button>
              </div>
            )}

            {/* 分隔条：仅工作台且未折叠 */}
            {proposalWorkspace && !chatCollapsed && <PaneSplitter onDrag={onSplitDrag} />}
            {/* 右栏 — 固定 288px 常驻列，纵向 50/50 分给代办（上）和工作区
                文件树（下）。两个面板都是 `section flex-1` 平分这一列；
                WorkspaceTreePanel 的 border-t 作为分隔线。
                方案模式下隐藏：让方案草稿面板顶替成右栏，避免 4 列挤垮 composer。 */}
            {!proposalForeground && (
              <aside className="flex h-full w-72 shrink-0 flex-col gap-4 bg-background/70 p-3.5 backdrop-blur-2xl backdrop-saturate-150 shadow-[inset_1px_0_0_rgba(0,0,0,0.06)] dark:shadow-[inset_1px_0_0_rgba(255,255,255,0.08)]">
                <TodoListPanel />
                <WorkspaceTreePanel />
              </aside>
            )}
            {/* 方案文档面板 — 仅当【当前前台会话是方案会话】时渲染（组件内部按
                useProposalForeground 返回 null，见 ProposalDocPanel）。方案前台时上面的
                右栏 aside 被隐藏，本面板顶替成第 3 列，不再形成会挤垮 composer 的第 4 列。
                宽度自适应：工作台模式（useProposalWorkspace）为 flex-1 吃满，返回态为 w-96
                靠右停靠——宽度切换在组件内部，故这里只挂组件、不传宽度。 */}
            <ProposalDocPanel />
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
