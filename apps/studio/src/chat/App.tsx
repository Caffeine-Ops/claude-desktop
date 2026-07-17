import { useEffect, useState } from 'react'

import { FusionRuntimeProvider } from './runtime/FusionRuntimeProvider'
import { ThreadView } from './components/chat/ThreadView'
import { PermissionBridge } from './components/permissions/PermissionBridge'
import { SkillsDialog } from './components/dialogs/SkillsDialog'
import { McpDialog } from './components/dialogs/McpDialog'
import { LogsDialog } from './components/dialogs/LogsDialog'
import { SessionSearchDialog } from './components/dialogs/SessionSearchDialog'
import { useLogsStore } from './stores/logs'
import { useWorkspaceStore } from './stores/workspace'
import { useI18n } from './i18n'
import { useSettingsStore } from './stores/settings'
import { useDialogStore } from './stores/dialogs'
import { SettingsView } from './components/settings/SettingsView'
import { KbManagerView } from './components/kb/KbManagerView'
import { ChatLoadingSkeleton } from '@/src/components/ChatLoadingSkeleton'
import { MotionConfig } from 'motion/react'

/**
 * Root renderer component.
 *
 * Layout
 * ------
 *   .chat-app                   (flex column, 100vh；不叫 .app——canvas 的壳类同名，见 main.css 注释)
 *     header                    (window chrome — title + version badge)
 *     main                      (flex column, fills remaining height)
 *       FusionRuntimeProvider   (runtime context — no DOM)
 *         horizontal flex row
 *           ThreadListSidebar   (w-64, left rail — chats)
 *           ThreadView          (flex-1, main chat area)
 *
 * The horizontal flex row lives *inside* the runtime provider so both
 * the sidebar (ThreadListPrimitive) and the chat view (ThreadPrimitive)
 * share the same AssistantRuntime — otherwise the sidebar couldn't
 * resolve its context.
 *
 * The right rail (待办 TodoListPanel + 文件 WorkspaceTreePanel) was
 * removed — ThreadView now fills the full width to the right of the
 * chat list. Both component files still exist but are no longer mounted.
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

  // 现在 chat tab 内只剩两栏：左对话列表（常驻 256px）+ 右聊天区。右侧的
  // 代办 / 文件树面板已整列移除（用户不再需要）。更早以前 header 里有折叠
  // 按钮 + 随窗口宽度自动收起的逻辑（sidebarOpen / rightRailOpen state +
  // useMediaQuery + AnimatePresence），随面板一并删除；整条 .header--tab 也
  // 早已删了，chat 内容直接顶到 shell 左导航栏右侧。
  // 外观（applier + daemon/同 document 同步桥）已迁去 chat/AppearanceBridge，
  // 由 SurfaceHost 与两个面并列常驻挂载（2026-07-17）。原因：本组件**不是**
  // 常驻的——设置页/知识库页一开，SurfaceHost 的 chatShowing 翻 false 把
  // chat 面整棵撤掉，写手和 `od:theme-mode-applied` 监听器跟着消失，正是在
  // 「用户在设置页里切主题」这个最主要的场景下缺席。详见该文件头注释。

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
      } else if (action === 'open-search') {
        // Shell rail's 「搜索对话」 row (or its ⌘K). The dialog lives in
        // this renderer because the rail's 220px can't host a 580px panel.
        useDialogStore.getState().openDialog('search')
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

  // Mirror the workspace store's `current` into our React state (feeds
  // FusionRuntimeProvider's `key={workspace}`). 统一会话管理后 `current`
  // 只是默认工作区（桌面），启动后不再变化，所以这只是防御性同步 ——
  // 会话各有工作区（SessionRuntime.cwd），换目录不再走整窗 remount。
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

  // Loading slice: brief flash-prevention. `.chat-app` keeps the window
  // chrome / background consistent with the mounted state. 骨架接力：chunk
  // loading 已显示 ChatLoadingSkeleton，这里 getWorkspace() 未 resolve 的几 ms
  // 复用同一骨架，避免骨架倒退成纯空白再到内容（两段加载态无凹陷衔接）。
  if (workspace === 'loading') {
    return (
      <div className="chat-app">
        <ChatLoadingSkeleton />
      </div>
    )
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
    return <div className="chat-app" />
  }

  return (
    // reducedMotion="user": makes every Motion animation in this renderer
    // (session-switch fades, title intro, loading pill, message chrome)
    // actually honor macOS "Reduce motion" — mirrors the shell renderer's
    // wrapper so both webContents degrade consistently.
    <MotionConfig reducedMotion="user">
    <div className="chat-app">
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
          {/* chat tab is a single ThreadView. It splits ITSELF into a chat
              column + a right-hand 幻灯片/大纲/文件 workspace (SlidesWorkspace),
              but ONLY for sessions started in slides mode and once they have
              messages — that gating lives inside ThreadView (isSlidesMode),
              not here. Ordinary chats stay single-column.

              The session list moved OUT of this renderer into the shell's
              left nav rail (a separate webContents); clicks there reach this
              runtime via SHELL_SESSION_SWITCH (see FusionRuntimeProvider's
              useThreadListAdapter). The runtime provider stays mounted
              because it still owns the chat runtime + switch subscription. */}
          <div className="flex min-h-0 flex-1">
            <ThreadView />
          </div>
        </FusionRuntimeProvider>
        )}
        {/* Settings overlay — `absolute inset-0` inside .main so it
            covers the chat row but leaves the title-bar header
            untouched. Renders null when the store says closed. */}
        <SettingsView />
        {/* KB 托管仓库管理页 overlay——与 SettingsView 平级，靠 useKbStore.open 门控，关闭时 render null */}
        <KbManagerView />
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
      {/* PluginsDialog 已退役（2026-07-17）：插件市场改成 SurfaceHost 的第三个
          面（?market=1，rail 常驻 + 右侧换成市场），不再是弹窗。 */}
      <LogsDialog />
      {/* 会话搜索（⌘K / shell rail 的「搜索对话」）。常挂载：它自己订阅
          dialog store 并在关闭态渲染 null，⌘K 监听因此全程有效。 */}
      <SessionSearchDialog />
      {/* 右下角的「正在打开会话」toast 已退役（2026-07-07 用户要求去掉）。
          接棒它的顶部进度条也已退役（2026-07-17）：切换加载态改由 ThreadView
          的骨架屏承担（订阅 sessionSwitching，形状即目标页面）。交互闸门始终
          在别处、不受这些视觉件增删影响（composer 发送钮走 isLoading、侧栏行
          走 pointer-events-none）。 */}
    </div>
    </MotionConfig>
  )
}


export default App
