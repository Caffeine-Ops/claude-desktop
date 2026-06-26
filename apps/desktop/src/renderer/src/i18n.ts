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
    emptyStateTitle: '不止聊天，搞定一切',
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
    chatHeaderSubtitle: '内容由 AI 生成',
    chatHeaderUntitled: '新对话',
    sidebarStatusRunning: '运行中',
    sidebarStatusAwaitingPermission: '等待授权',
    sidebarStatusIdle: '空闲',
    sidebarCloseRuntime: '停止后台运行',
    sidebarSwitchingSession: '正在切换会话…',

    // Sidebar — quick actions (TODO: wire to real dialogs)
    // Short forms for the single-row toolbar; full forms live in
    // `*Tooltip` keys and are shown on hover via the button title.
    quickActionSkills: '技能',
    quickActionSkillsTooltip: '技能市场',
    quickActionMcp: 'MCP',
    quickActionMcpTooltip: 'MCP 市场',
    quickActionPrompts: '提示词',
    quickActionPromptsTooltip: '提示词库',
    quickActionPlugins: '插件',
    quickActionPluginsTooltip: '插件市场',
    openingSession: '正在打开会话…',
    switchWorkspaceTooltip: '点击切换 workspace',
    confirmSwitchWorkspace:
      '切换 workspace 会结束当前会话的进行中回合，未发送的草稿会丢失。确定继续吗？',
    confirmInterruptStreaming:
      '当前对话还在进行中，继续将中断本次回合。确定吗？',

    // Rename flow
    renameChat: '重命名',
    renameChatPrompt: '为这个会话起一个新名字',
    renameChatFailed: '重命名失败',
    renameChatSave: '保存名称',

    // Thread empty state
    emptyStateHintBefore: '随便问点什么。试试 ',
    emptyStateHintMiddle: ' 或 ',
    emptyStateHintAfter: ' 查看所有命令。',
    emptyStateExampleAsk: '查看我电脑桌面有哪些文件夹',
    emptyStateScenarioHint: '本地运行、自主规划、安全可控的 AI 工作搭子',

    // Scenario cards (clickable starter prompts)
    scenarioPptTitle: '生成幻灯片',
    scenarioPptDesc: '现代风格的 PPT，包含封面、目录和内容页',
    scenarioPptPrompt:
      '帮我做一个关于 [主题] 的现代风格 PPT，包含封面、目录、5 页主要内容和总结页。每页给我 3-5 个 bullet 要点。',
    scenarioOfficeHoursTitle: '产品构思 (Office Hours)',
    scenarioOfficeHoursDesc: '用 /office-hours 跟我对谈，帮我把想法打磨清楚',
    scenarioOfficeHoursPrompt:
      '/office-hours 我想做一个 [想法]，帮我用 6 个核心问题挑战这个想法，把它打磨成可以动手的版本。',
    scenarioResumeTitle: '简历筛选',
    scenarioResumeDesc: '批量阅读当前文件夹里的简历，按岗位要求打分排序',
    scenarioResumePrompt:
      '岗位是 [岗位名称]，要求 [核心要求，例如 3 年以上后端经验 / 熟悉 Python]。帮我读一下当前 workspace 里的所有简历，输出一个表格：候选人姓名、最高学历、相关年限、亮点、不匹配项、综合评分（1-10）。最后按评分从高到低排序，前 3 名标红。',
    scenarioAnalyzeTitle: '看懂表格数据',
    scenarioAnalyzeDesc: '把当前文件夹里的 Excel 表格读一遍，告诉你重点和趋势',
    scenarioAnalyzePrompt:
      '帮我看一下当前文件夹里的 [文件名]。用大白话告诉我：1）这张表里有什么数据、有没有缺失或异常 2）最值得注意的 3 个发现 3）如果要做图给老板看，建议画哪几张。',

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
    filesCopyName: '复制名称',
    filesCopyNameCopied: '已复制',

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
    composerAttachFile: '附加文件或图片',
    composerDictate: '语音输入',
    composerStopDictation: '停止语音输入',
    composerListening: '正在聆听…',
    composerCancelDictation: '取消语音输入',
    composerConfirmDictation: '结束并插入文字',
    composerNoMatchingCommands: '没有匹配的命令',
    composerLoadingFiles: '正在加载文件…',
    composerNoMatchingFiles: '没有匹配的文件',

    // Workspace pill (inline switcher above the composer)
    workspacePillLabel: '在文件夹中工作',
    workspacePillEmpty: '未选择文件夹',
    workspacePillOpen: '切换文件夹',
    workspacePillSwitching: '正在切换',
    workspacePillRecent: '最近',
    workspacePillBrowse: '选择其他文件夹…',
    workspacePillDisconnect: '断开当前文件夹',
    workspacePillCurrent: '当前',
    workspaceDropRelease: '松开以使用此文件夹',
    workspaceDropHint: 'Claude 将在此目录运行',
    workspaceSwitchFailed: '切换文件夹失败',

    // Cold-start empty state (no workspace yet)
    emptyWorkspaceTitle: '选择一个文件夹开始',
    emptyWorkspaceDesc: 'Claude 会在这个目录里运行——它会成为本次会话所有工具调用的工作目录。',
    emptyWorkspaceButton: '选择文件夹',
    emptyWorkspaceDragHint: '或把文件夹拖到窗口任意位置',

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

    // Tool-call card — labels for the default input/output panes and
    // the raw-data toggle that friendly-view tool cards show at the
    // bottom for power users.
    toolPaneInputLabel: 'Input',
    toolPaneOutputLabel: 'Output',
    toolRawDataSummary: '原始数据',
    toolWorkflowTasksLabel: '子任务',
    toolStatusRunning: '运行中',
    toolStatusDone: '完成',
    toolStatusPending: '等待中',
    toolStatusFailed: '失败',
    toolStatusStopped: '已停止',
    toolWorkflowResultLabel: '结果',
    toolWorkflowAgentsLabel: 'agents',

    // Settings → General → CLI backend
    cliBackendTitle: 'CLI 后端',
    cliBackendDesc:
      '选择 Agent SDK 要启动哪个 CLI 二进制。切换立即生效——正在进行的对话回合会保持当前后端，下一回合起切换到新后端。',
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
    cliBackendApplyHint: '立即生效——正在进行的对话回合保持当前后端'
  },
  en: {
    appTitle: 'Claude Desktop',
    emptyStateTitle: 'More than chat — get things done',
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
    chatHeaderSubtitle: 'Generated by AI',
    chatHeaderUntitled: 'New chat',
    sidebarStatusRunning: 'Running',
    sidebarStatusAwaitingPermission: 'Awaiting permission',
    sidebarStatusIdle: 'Idle',
    sidebarCloseRuntime: 'Stop background runtime',
    sidebarSwitchingSession: 'Switching session…',

    // Sidebar — quick actions (TODO: wire to real dialogs)
    quickActionSkills: 'Skills',
    quickActionSkillsTooltip: 'Skills marketplace',
    quickActionMcp: 'MCP',
    quickActionMcpTooltip: 'MCP marketplace',
    quickActionPrompts: 'Prompts',
    quickActionPromptsTooltip: 'Prompt library',
    quickActionPlugins: 'Plugins',
    quickActionPluginsTooltip: 'Plugin marketplace',
    openingSession: 'Opening session…',
    switchWorkspaceTooltip: 'Click to switch workspace',
    confirmSwitchWorkspace:
      'Switching workspace will abort the in-flight turn and discard unsent drafts. Continue?',
    confirmInterruptStreaming:
      'A chat turn is still in progress. Continuing will interrupt it. Are you sure?',

    renameChat: 'Rename',
    renameChatPrompt: 'Enter a new name for this chat',
    renameChatFailed: 'Rename failed',
    renameChatSave: 'Save name',

    emptyStateHintBefore: 'Ask anything. Type ',
    emptyStateHintMiddle: ' or ',
    emptyStateHintAfter: ' to browse commands.',
    emptyStateExampleAsk: 'list folders on my desktop',
    emptyStateScenarioHint: 'A local-first, self-planning, safe AI work companion',

    // Scenario cards (clickable starter prompts)
    scenarioPptTitle: 'Generate slides',
    scenarioPptDesc: 'Modern slide deck with cover, agenda, and content',
    scenarioPptPrompt:
      'Make me a modern PPT about [topic] with a cover, agenda, 5 content slides and a summary. Give 3-5 bullet points per slide.',
    scenarioOfficeHoursTitle: 'Product brainstorm (Office Hours)',
    scenarioOfficeHoursDesc: 'Use /office-hours to pressure-test an idea with 6 questions',
    scenarioOfficeHoursPrompt:
      "/office-hours I want to build [idea]. Pressure-test it with 6 core questions and help me sharpen it into something I could actually start on.",
    scenarioResumeTitle: 'Screen resumes',
    scenarioResumeDesc: 'Bulk-read every resume in the folder and rank them against your role',
    scenarioResumePrompt:
      'The role is [role title], requiring [key requirements, e.g. 3+ years backend / strong Python]. Read every resume in my workspace and produce a table with: name, highest degree, years of relevant experience, highlights, gaps, overall score (1-10). Sort by score descending and flag the top 3.',
    scenarioAnalyzeTitle: 'Make sense of a spreadsheet',
    scenarioAnalyzeDesc: 'Read an Excel file in the folder and explain what matters in plain English',
    scenarioAnalyzePrompt:
      'Take a look at [file name] in my folder. In plain English, tell me: 1) what data is in this sheet and whether anything is missing or odd, 2) the 3 most important findings, 3) which charts I should make if I need to show this to my boss.',

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
    filesCopyName: 'Copy name',
    filesCopyNameCopied: 'Copied',

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
    composerAttachFile: 'Attach file or image',
    composerDictate: 'Voice input',
    composerStopDictation: 'Stop voice input',
    composerListening: 'Listening…',
    composerCancelDictation: 'Cancel voice input',
    composerConfirmDictation: 'Finish and insert',
    composerNoMatchingCommands: 'No matching commands',
    composerLoadingFiles: 'Loading files…',
    composerNoMatchingFiles: 'No matching files',

    // Workspace pill (inline switcher above the composer)
    workspacePillLabel: 'Work in a folder',
    workspacePillEmpty: 'No folder selected',
    workspacePillOpen: 'Switch folder',
    workspacePillSwitching: 'Switching',
    workspacePillRecent: 'Recent',
    workspacePillBrowse: 'Choose another folder…',
    workspacePillDisconnect: 'Disconnect current folder',
    workspacePillCurrent: 'Current',
    workspaceDropRelease: 'Release to use this folder',
    workspaceDropHint: 'Claude will run in this directory',
    workspaceSwitchFailed: 'Failed to switch folder',

    // Cold-start empty state (no workspace yet)
    emptyWorkspaceTitle: 'Pick a folder to start',
    emptyWorkspaceDesc: 'Claude runs inside this directory — it becomes the working directory for every tool call this session.',
    emptyWorkspaceButton: 'Choose folder',
    emptyWorkspaceDragHint: 'Or drop a folder anywhere in the window',

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

    toolPaneInputLabel: 'Input',
    toolPaneOutputLabel: 'Output',
    toolRawDataSummary: 'Raw data',
    toolWorkflowTasksLabel: 'Subtasks',
    toolStatusRunning: 'running',
    toolStatusDone: 'done',
    toolStatusPending: 'pending',
    toolStatusFailed: 'failed',
    toolStatusStopped: 'stopped',
    toolWorkflowResultLabel: 'Result',
    toolWorkflowAgentsLabel: 'agents',

    cliBackendTitle: 'CLI backend',
    cliBackendDesc:
      'Choose which CLI binary the Agent SDK spawns. Takes effect immediately — an in-flight turn keeps its current backend; the next turn switches.',
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
    cliBackendApplyHint: 'Applies immediately — an in-flight turn keeps its current backend'
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

// Tool-name display labels. Kept out of STRINGS because the key space is
// the tool registry (dozens of entries) rather than UI copy, and because
// unknown tools (e.g. MCP `mcp__server__name`) must fall through to the
// raw identifier instead of showing a `{toolName}`-style placeholder.
const TOOL_LABELS_ZH: Record<string, string> = {
  Agent: '子代理',
  AskUserQuestion: '询问用户',
  Bash: '运行命令',
  CronCreate: '创建定时任务',
  CronDelete: '删除定时任务',
  CronList: '定时任务列表',
  Edit: '编辑',
  EnterPlanMode: '进入规划模式',
  EnterWorktree: '进入 Worktree',
  ExitPlanMode: '退出规划模式',
  ExitWorktree: '退出 Worktree',
  Glob: '文件查找',
  Grep: '内容搜索',
  LSP: 'LSP',
  Monitor: '监控',
  MultiEdit: '批量编辑',
  NotebookEdit: 'Notebook 编辑',
  Read: '读取文件',
  RemoteTrigger: '远程触发',
  ScheduleWakeup: '计划唤醒',
  Skill: '技能',
  TaskCreate: '创建任务',
  TaskGet: '查询任务',
  TaskList: '任务列表',
  TaskOutput: '任务输出',
  TaskStop: '停止任务',
  TaskUpdate: '更新任务',
  TodoWrite: '待办事项',
  ToolSearch: '工具搜索',
  WebFetch: '网页获取',
  WebSearch: '网页搜索',
  Write: '写入文件'
}

/**
 * Resolve a tool name to its display label for the current language.
 * English keeps the raw identifier (tool names are proper-noun-ish);
 * Chinese looks up `TOOL_LABELS_ZH` and falls back to the raw name for
 * unknown tools (notably MCP tools, which follow `mcp__server__name`).
 */
export function useToolLabel(): (toolName: string) => string {
  const lang = useI18n((s) => s.lang)
  return (toolName) =>
    lang === 'zh' ? (TOOL_LABELS_ZH[toolName] ?? toolName) : toolName
}
