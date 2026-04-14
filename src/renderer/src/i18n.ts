import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Tiny in-app i18n. Two languages, hand-maintained translation map,
 * persisted to localStorage so the choice survives reloads.
 *
 * Principle: every user-facing string that the app itself owns must
 * flow through `t()` / `tFormat()` so it re-renders when the language
 * flips. Strings that are deliberately brand / proper nouns (e.g.
 * "Claude Desktop", "Fusion Code Desktop") still go through a key so
 * the indirection is uniform — it just happens to resolve to the same
 * value in both locales.
 *
 * `setLang` also pushes the new language to the main process via
 * `window.chatApi.setLang` so the tray context menu (which lives in
 * the main process and has no access to this store) can rebuild its
 * labels in sync with the renderer.
 */

export type Lang = 'zh' | 'en'

interface I18nState {
  lang: Lang
  setLang: (lang: Lang) => void
}

export const useI18n = create<I18nState>()(
  persist(
    (set) => ({
      lang: 'zh',
      setLang: (lang) => {
        set({ lang })
        // Best-effort IPC push — guarded so the store stays usable in
        // non-electron contexts (tests, storybook) where `chatApi` is
        // not exposed on window.
        if (typeof window !== 'undefined' && window.chatApi?.setLang) {
          try {
            window.chatApi.setLang(lang)
          } catch (err) {
            console.warn('[i18n] setLang IPC push failed', err)
          }
        }
      }
    }),
    { name: 'claude-desktop:lang' }
  )
)

const STRINGS = {
  zh: {
    // Branding — intentionally identical in both locales; routed
    // through t() anyway so the lookup surface is uniform.
    appTitle: 'Claude Desktop',
    emptyStateTitle: 'Fusion Code Desktop',
    versionLabel: 'Claude Desktop · v{version}',

    // Settings / user-info menu
    settings: '设置',
    localUser: '本机用户',
    language: '语言',
    openClaudeDir: '打开 ~/.claude',
    expandSidebar: '展开聊天列表',
    collapseSidebar: '收起聊天列表',
    expandRightRail: '展开右侧栏',
    collapseRightRail: '收起右侧栏',
    openLogs: '打开引擎日志',
    openLogsTitle: '打开引擎日志 (timeline)',

    // Sidebar — chats column
    sidebarChats: '对话',
    sidebarNewChat: '新建对话',
    sidebarSwitchingSession: '正在切换会话…',
    openingSession: '正在打开会话…',
    switchWorkspaceTooltip: '点击切换 workspace',
    confirmSwitchWorkspace:
      '切换 workspace 会结束当前会话的进行中回合，未发送的草稿会丢失。确定继续吗？',

    // Rename flow
    renameChat: '重命名',
    renameChatPrompt: '为这个会话起一个新名字',
    renameChatFailed: '重命名失败',
    renameChatSave: '保存名称',

    // Thread empty state
    emptyStateHintBefore: '随便问点什么。试试 ',
    emptyStateHintMiddle: ' 或 ',
    emptyStateHintAfter: '。',
    emptyStateExampleAsk: '查看我电脑桌面有哪些文件夹',

    // Code block copy affordance
    codeBlockCopy: '复制',
    codeBlockCopied: '✓ 已复制',

    // Settings page
    theme: '主题',
    themeDesc: '使用浅色、深色、或匹配系统设置',
    themeLight: '浅色',
    themeDark: '深色',
    themeSystem: '系统',
    themeImport: '导入',
    themeCopy: '复制主题',
    themeReset: '重置',
    backToApp: '返回应用',
    catGeneral: '常规',
    catAppearance: 'Appearance',
    catConfiguration: '配置',
    catPersonalization: '个性化',
    catUsage: '使用情况',
    catMcpServers: 'MCP 服务器',
    catGit: 'Git',
    catEnvironment: '环境',
    catWorktrees: '工作树',
    catArchivedThreads: '已归档线程',
    usePointerCursor: '使用指针光标',
    usePointerCursorDesc: '悬停交互元素时切换为指针光标',
    uiFontSize: 'UI font size',
    uiFontSizeDesc: '调整 Claude Desktop 界面的基础字号',
    codeFontSize: 'Code font size',
    codeFontSizeDesc: '调整聊天和 diff 中代码的基础字号',

    // Right rail — Todos
    todosTitle: '待办',
    todosEmpty: '暂无待办事项',
    todosEmptyHintBefore: '让 Claude 使用 ',
    todosEmptyHintAfter: ' 创建',
    todosToggleStatus: '切换状态（当前 {status}）',
    todosStatusTitle: '状态：{status}',
    todoStatusPending: '待办',
    todoStatusInProgress: '进行中',
    todoStatusCompleted: '已完成',

    // Right rail — Workspace files
    filesTitle: '文件',
    filesLoading: '加载工作目录…',
    filesEmpty: '当前 workspace 下没有文件',
    filesCountLabel: '{count} 个文件',
    filesCountTruncated: '只显示前 {count} 个文件（workspace 中还有更多）',
    filesOpenHint: '{path} — 双击打开',

    // Workspace gate (first-run picker)
    gateTitle: '选择一个 workspace 开始',
    gateDescBefore: '从 Finder / 文件资源管理器拖一个文件夹到这个窗口，或点击下方浏览。Claude 会在这个目录里运行——它会成为本次会话所有工具调用的 ',
    gateDescAfter: '。',
    gateChecking: '正在检查文件夹…',
    gateReleaseToSet: '松开以设为 workspace',
    gateClickToBrowse: '点击浏览',
    gateOrDrop: '或把文件夹拖到窗口任意位置',
    gateSwitchHint: '随时可在侧边栏切换——无需重启',
    gateErrorDropFolder: '请把文件夹拖到窗口上。',
    gateErrorNotFile: '请拖文件夹，而不是文件。',
    gateErrorResolvePath: '无法解析文件夹路径，请从 Finder / 文件资源管理器拖入。',
    gateErrorRejected: '主进程没有接受这个 workspace。',

    // Composer
    composerPlaceholder: '随便问点什么…   ↵ 发送 · ⇧↵ 换行 · / 命令 · @ 文件',
    composerAttachImage: '附加图片',
    composerDictate: '语音输入',
    composerStopDictation: '停止语音输入',
    composerListening: '正在聆听…',
    composerCancelDictation: '取消语音输入',
    composerConfirmDictation: '结束并插入文字',
    composerNoMatchingCommands: '没有匹配的命令',
    composerLoadingFiles: '正在加载文件…',
    composerNoMatchingFiles: '没有匹配的文件',

    // Logs dialog
    logsDialogAria: '引擎日志时间线',
    logsTabEngine: 'Engine',
    logsTabUi: 'UI',
    logsHeaderEngine: '引擎时间线',
    logsHeaderUi: 'UI 事件',
    logsEngineEmpty: '暂无事件——开始一个对话以记录 cli 生命周期',
    logsUiEmpty: '暂无事件——与侧边栏 / 对话框交互以记录',
    logsEngineCount: '{count} 条引擎事件',
    logsUiCount: '{count} 条 UI 事件',
    logsClear: '清空',
    logsClearTitleEngine: '清空引擎日志',
    logsClearTitleUi: '清空 UI 日志',
    logsClose: '关闭',
    logsEmptyTitle: '时间线为空',
    logsEmptyHint:
      '事件会在引擎切换会话与启动 cli 时陆续到达。\n选择一个对话或发送一条消息来开始记录。',
    logsColTime: '时间',
    logsColDelta: 'Δ',
    logsColFromStart: 'T',
    logsColEvent: '事件',
    logsFooterHint:
      'close · 最新事件在底部 · Δ = 距上一条间隔 · T = 距首条偏移',
    logsFooterSpan: '总跨度 {span}',

    // Image preview lightbox
    imagePreviewAria: '图片预览',
    imagePreviewClose: '关闭预览',
    imageAttachedAlt: '附加图片',

    // Tray menu (main process mirrors these via its own tiny table)
    trayShowHide: '显示 / 隐藏',
    trayQuit: '退出',

    // Permission dialog
    permissionHeader: '需要授权',
    permissionAskHeader: '回答 Claude 的问题',
    permissionAriaLabel: '{toolName} 授权',
    permissionNoParams: '（无参数）',
    permissionPrompt: '是否继续？',
    permissionYes: '同意',
    permissionAllowSession: '同意，本次会话内允许 {scope}',
    permissionDeny: '不同意，继续对话',
    permissionFooterEsc: '取消',
    permissionFooterEnter: '同意',

    // Settings → General → CLI backend
    cliBackendTitle: 'CLI 后端',
    cliBackendDesc:
      '选择 Agent SDK 要启动哪个 CLI 二进制。切换后从下一次新建会话开始生效。',
    cliBackendBundled: '内置 fusion-code',
    cliBackendBundledDesc:
      '随应用打包的版本，已针对 prompt cache 和 MCP 工具做了优化',
    cliBackendSystem: '系统 Claude Code',
    cliBackendSystemDesc:
      '使用本机安装的 claude 命令（失去 fusion-code 的 token 优化，按 ~/.claude 配置运行）',
    cliBackendNotInstalled: '未检测到本机安装的 claude',
    cliBackendDetected: '已检测到',
    cliBackendVersion: '版本',
    cliBackendPath: '路径',
    cliBackendApplyHint: '切换将在下一次新建会话生效'
  },
  en: {
    appTitle: 'Claude Desktop',
    emptyStateTitle: 'Fusion Code Desktop',
    versionLabel: 'Claude Desktop · v{version}',

    settings: 'Settings',
    localUser: 'Local user',
    language: 'Language',
    openClaudeDir: 'Open ~/.claude',
    expandSidebar: 'Expand chat list',
    collapseSidebar: 'Collapse chat list',
    expandRightRail: 'Show right panel',
    collapseRightRail: 'Hide right panel',
    openLogs: 'Open engine logs',
    openLogsTitle: 'Open engine logs (timeline)',

    sidebarChats: 'Chats',
    sidebarNewChat: 'New chat',
    sidebarSwitchingSession: 'Switching session…',
    openingSession: 'Opening session…',
    switchWorkspaceTooltip: 'Click to switch workspace',
    confirmSwitchWorkspace:
      'Switching workspace will abort the in-flight turn and discard unsent drafts. Continue?',

    renameChat: 'Rename',
    renameChatPrompt: 'Enter a new name for this chat',
    renameChatFailed: 'Rename failed',
    renameChatSave: 'Save name',

    emptyStateHintBefore: 'Ask anything. Try ',
    emptyStateHintMiddle: ' or ',
    emptyStateHintAfter: '.',
    emptyStateExampleAsk: 'list folders on my desktop',

    codeBlockCopy: 'Copy',
    codeBlockCopied: '✓ Copied',

    theme: 'Theme',
    themeDesc: 'Use light, dark, or match the system setting',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeSystem: 'System',
    themeImport: 'Import',
    themeCopy: 'Copy theme',
    themeReset: 'Reset',
    backToApp: 'Back to app',
    catGeneral: 'General',
    catAppearance: 'Appearance',
    catConfiguration: 'Configuration',
    catPersonalization: 'Personalization',
    catUsage: 'Usage',
    catMcpServers: 'MCP servers',
    catGit: 'Git',
    catEnvironment: 'Environment',
    catWorktrees: 'Worktrees',
    catArchivedThreads: 'Archived threads',
    usePointerCursor: 'Use pointer cursor',
    usePointerCursorDesc:
      'Switch to a pointer cursor when hovering interactive elements',
    uiFontSize: 'UI font size',
    uiFontSizeDesc: 'Adjust the base size used for the Claude Desktop UI',
    codeFontSize: 'Code font size',
    codeFontSizeDesc:
      'Adjust the base size used for code across chats and diffs',

    todosTitle: 'Todos',
    todosEmpty: 'No todos yet',
    todosEmptyHintBefore: 'Ask Claude to use ',
    todosEmptyHintAfter: '',
    todosToggleStatus: 'Toggle status (currently {status})',
    todosStatusTitle: 'Status: {status}',
    todoStatusPending: 'pending',
    todoStatusInProgress: 'in progress',
    todoStatusCompleted: 'completed',

    filesTitle: 'Files',
    filesLoading: 'Loading workspace…',
    filesEmpty: 'No files in this workspace',
    filesCountLabel: '{count} files',
    filesCountTruncated: 'Showing first {count} files (workspace has more)',
    filesOpenHint: '{path} — double-click to open',

    gateTitle: 'Pick a workspace to start',
    gateDescBefore:
      'Drag a folder from Finder / File Explorer onto this window, or click below to browse. Claude will run inside that directory — it becomes the ',
    gateDescAfter: ' for every tool call in this session.',
    gateChecking: 'Checking folder…',
    gateReleaseToSet: 'Release to set workspace',
    gateClickToBrowse: 'Click to browse',
    gateOrDrop: 'or drop a folder anywhere on the window',
    gateSwitchHint: 'Switch anytime from the sidebar — no restart needed',
    gateErrorDropFolder: 'Drop a folder onto the window.',
    gateErrorNotFile: 'Drop a folder, not a file.',
    gateErrorResolvePath:
      'Could not resolve the folder path. Try dragging from Finder / File Explorer.',
    gateErrorRejected: 'Main process did not accept the workspace.',

    composerPlaceholder:
      'Ask anything…   ↵ send · ⇧↵ newline · / commands · @ files',
    composerAttachImage: 'Attach image',
    composerDictate: 'Voice input',
    composerStopDictation: 'Stop voice input',
    composerListening: 'Listening…',
    composerCancelDictation: 'Cancel voice input',
    composerConfirmDictation: 'Finish and insert',
    composerNoMatchingCommands: 'No matching commands',
    composerLoadingFiles: 'Loading files…',
    composerNoMatchingFiles: 'No matching files',

    logsDialogAria: 'Engine log timeline',
    logsTabEngine: 'Engine',
    logsTabUi: 'UI',
    logsHeaderEngine: 'Engine timeline',
    logsHeaderUi: 'UI events',
    logsEngineEmpty: 'No events yet — start a chat to record cli lifecycle',
    logsUiEmpty:
      'No events yet — interact with the sidebar / dialogs to record',
    logsEngineCount: '{count} engine events',
    logsUiCount: '{count} ui events',
    logsClear: 'Clear',
    logsClearTitleEngine: 'Clear engine log',
    logsClearTitleUi: 'Clear UI log',
    logsClose: 'Close',
    logsEmptyTitle: 'Timeline is empty',
    logsEmptyHint:
      'Events arrive as the engine switches sessions and spawns the cli.\nPick a chat or send a message to start recording.',
    logsColTime: 'Time',
    logsColDelta: 'Δ',
    logsColFromStart: 'T',
    logsColEvent: 'Event',
    logsFooterHint:
      'close · newest event at bottom · Δ = gap from previous event · T = offset from first event',
    logsFooterSpan: 'span {span}',

    imagePreviewAria: 'Image preview',
    imagePreviewClose: 'Close preview',
    imageAttachedAlt: 'Attached image',

    trayShowHide: 'Show / Hide',
    trayQuit: 'Quit',

    permissionHeader: 'Permission required',
    permissionAskHeader: "Answer Claude's question",
    permissionAriaLabel: '{toolName} permission',
    permissionNoParams: '(no parameters)',
    permissionPrompt: 'Do you want to proceed?',
    permissionYes: 'Yes',
    permissionAllowSession: 'Yes, allow {scope} during this session',
    permissionDeny: 'No, and keep going',
    permissionFooterEsc: 'cancel',
    permissionFooterEnter: 'yes',

    cliBackendTitle: 'CLI backend',
    cliBackendDesc:
      'Choose which CLI binary the Agent SDK spawns. Takes effect on the next new chat.',
    cliBackendBundled: 'Bundled fusion-code',
    cliBackendBundledDesc:
      'The CLI shipped with the app — tuned for prompt cache and MCP tool loading',
    cliBackendSystem: 'System Claude Code',
    cliBackendSystemDesc:
      'Use the claude binary installed on your machine (no fusion-code token optimizations; runs under your own ~/.claude config)',
    cliBackendNotInstalled: 'No system claude detected',
    cliBackendDetected: 'Detected',
    cliBackendVersion: 'Version',
    cliBackendPath: 'Path',
    cliBackendApplyHint: 'Will apply on the next new chat'
  }
} as const

export type StringKey = keyof (typeof STRINGS)['zh']

/**
 * Hook returning a translator pinned to the current language. Components
 * subscribe to the language via this hook so they re-render when the
 * user flips the picker — that's the whole point of routing through the
 * store rather than reading STRINGS directly.
 */
export function useT(): (key: StringKey) => string {
  const lang = useI18n((s) => s.lang)
  return (key) => STRINGS[lang][key]
}

/**
 * Sibling of `useT` for strings that need `{var}` interpolation (e.g.
 * `versionLabel: 'Claude Desktop · v{version}'`). Intentionally minimal —
 * no plural / select / ICU syntax, because the app's needs don't
 * warrant pulling in i18next.
 */
export function useTFormat(): (
  key: StringKey,
  vars: Record<string, string | number>
) => string {
  const lang = useI18n((s) => s.lang)
  return (key, vars) => {
    const template = STRINGS[lang][key]
    return template.replace(/\{(\w+)\}/g, (_, name) =>
      name in vars ? String(vars[name]) : `{${name}}`
    )
  }
}
