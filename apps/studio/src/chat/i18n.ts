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
    // 顶栏徽标短文案——原「内容由 AI 生成」副行在 2026-07-04 顶栏化改版中
    // 收敛成一枚右端胶囊徽标（docs/ui-prototype-tool-card.html 定稿）。
    chatHeaderAiBadge: 'AI 生成',
    chatHeaderUntitled: '新对话',
    // 顶栏「输出」按钮：弹出本会话所有产出物（幻灯片/文档/表格/图片…）的
    // 聚合列表，复用与消息内成果卡片相同的类型识别（2026-07-10）。
    chatHeaderOutputs: '输出',
    chatHeaderOutputsEmpty: '本次对话还没有产出物',
    chatHeaderOutputsEmptyHint: '生成图片、文档或表格后，会自动出现在这里',
    // 输出面板 v2（docs/ui-prototype-outputs-panel-v2.html 方案 C 定稿）：
    // 图像收三列网格、其余走行式，两组并存时的分组标签。
    outputsGroupImages: '图像',
    outputsGroupFiles: '文件',
    sidebarStatusRunning: '运行中',
    // 两类挂起二分文案（2026-07-07）：权限门=「等待批准」，AskUserQuestion=
    // 「等待回答」——AI 在等回答时写「等待批准」语义就是错的（用户实锤）。
    sidebarStatusAwaitingPermission: '等待批准',
    sidebarStatusAwaitingAnswer: '等待回答',
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
    chatHeaderMenu: '会话操作',

    // Replay（会话演示回放）
    replayExportMenu: '导出为演示',
    replayOpenFile: '打开演示文件…',
    replayBadge: '演示回放',
    replayPlay: '播放',
    replayPause: '暂停',
    replaySpeed: '倍速',
    replayExit: '退出回放',
    replayDone: '演示已结束',
    replayOpenFailed: '打开演示文件失败',
    demoShowcaseTitle: '看看它能做什么',
    demoShowcaseHint: '每段不到 1 分钟，都是真实使用过程的回放',
    demoShowcasePlay: '播放演示',
    demoShowcaseTag: '演示回放',
    demoShowcaseFallbackDesc: '轮真实对话 · 过程回放',
    replaySlidesTitle: '幻灯片',
    replaySlidesEmpty: '幻灯片生成中…',
    searchChats: '搜索对话',
    searchChatsPlaceholder: '搜索对话标题和内容…',
    searchRecent: '最近对话',
    searchNoResults: '没有找到相关对话',
    searchWhoUser: '你：',
    searchWhoAi: 'AI：',
    searchHitCountPrefix: '共 ',
    searchHitCountSuffix: ' 条消息命中',
    searchKbdSelect: '选择',
    searchKbdOpen: '打开',
    searchKbdClose: '关闭',
    searchResultSuffix: ' 条结果',

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
    scenarioProposalTitle: '写方案',
    scenarioProposalDesc: '基于公司知识库，对话式生成建设方案草稿',
    scenarioProposalPrompt:
      '要写哪个产品的方案、给哪个客户或什么场景用；想分成哪几部分、每部分重点写什么。',

    catKnowledgeBase: '方案知识库',

    // EmptyState 场景导航（ScenarioRail）：分类 tab 标签。chip 上的技能名来自
    // skillChipRegistry（单一真源），推荐 prompt 是中文内容配置（与 promo
    // banner 同等对待，不进翻译表）——这里只放 chrome 文案。
    scenarioCatDaily: '日常办公',
    scenarioCatCode: '代码开发',
    scenarioCatDesign: '设计创意',

    // Settings — Configuration category — 出图 API（编辑器内 P 图功能的凭据配置）
    imageApiTitle: '出图 API',
    imageApiDesc: '配置图像生成/改图接口凭据，供编辑器内「出图」「改图」使用；未配置时对应入口置灰。',
    imageApiKeyLabel: 'API Key',
    imageApiKeyPlaceholderConfigured: '••••',
    imageApiKeyPlaceholderEmpty: '未配置',
    imageApiKeyClear: '清除已保存的 Key',
    imageApiBaseUrlLabel: 'Base URL',
    imageApiBaseUrlPlaceholder: 'https://api.example.com/v1',
    imageApiModelLabel: '默认模型',
    imageApiSave: '保存',
    imageApiSaving: '保存中…',
    imageApiSaved: '已保存',
    // Settings — Knowledge Base category — 「写方案」检索资料来源（本地目录 / 远程同步）
    kbSourceTitle: '知识库来源',
    kbSourceDesc: '「写方案」检索资料的出处。远程模式由服务器统一构建、自动同步到本机。',
    kbSourceLocal: '本地目录',
    kbSourceLocalDesc: '选择本机源目录，需在本机执行索引构建（依赖 markitdown / LibreOffice）',
    kbSourceRemote: '远程服务器',
    kbSourceRemoteDesc: '填入公司知识库服务器地址，如 http://10.0.0.5:8080',
    kbPickFolder: '选择目录…',
    kbRemoteUrl: '服务器地址',
    kbRemoteApply: '保存并同步',
    kbSyncNow: '立即同步',
    kbSyncing: '同步中…',
    kbLastSync: '上次同步',
    kbVersion: '知识库版本',
    kbSyncFailed: '同步失败',
    kbNeverSynced: '尚未同步',

    // KB 托管仓库管理页（P2）
    kbManageOpen: '打开方案知识库',
    kbManageTitle: '方案知识库',
    kbManageEmpty: '知识库还没有文档，点「导入」添加。',
    kbManageLoading: '正在加载知识库…',
    kbManageReadOnly: '本库由主编机管理，此处仅供浏览。',
    kbColTitle: '文档',
    kbStatusIndexed: '已索引',
    kbStatusFailed: '转换失败',
    kbImport: '导入',
    kbNewLine: '新建产品线',
    kbNewProduct: '新建产品',
    kbRename: '重命名',
    kbDelete: '删除',
    kbMove: '移动',
    kbOpenSource: '打开原件',
    kbPreview: '预览',
    kbRetry: '重试',
    kbToolingMissing: '未检测到 markitdown，无法导入 Office 文档。安装：pipx install markitdown',
    kbBuilding: '正在构建索引',
    kbConfirmDeleteDoc: '删除文档「{title}」？原件、镜像与索引会一并移除。',
    kbConfirmDeleteCat: '删除分类「{name}」及其下全部文档？',
    kbPromptOk: '确定',
    kbPromptCancel: '取消',
    kbConflictPrompt: '{n} 个同名文档已存在，覆盖为新版本？',
    kbMigrateCta: '从旧资料文件夹批量导入',
    kbMigrateDone: '已导入 {n} 个文档',
    kbSyncLocal: '同步本地文件夹',
    kbSyncLocalHint: '把知识库对齐成本地源文件夹的当前状态（新增/删除/改名都会同步，只重转变动的文件）',
    kbSyncDone: '同步完成：新增 {a} · 更新 {u} · 删除 {d}',
    kbSyncConfirm: '本次同步将：新增 {a} 个 · 更新 {u} 个 · 删除 {d} 个。\n\n将从知识库删除以下文件（你本地文件夹里的原件不受影响）：\n{list}\n\n提示：若某个文件是你改名时把扩展名也改了（如 .docx 改成 .doc），它会因不受支持而被当作「删除」。确认继续同步吗？',
    kbSyncMore: '\n…等共 {n} 个',
    kbSyncCancelled: '已取消同步，知识库未改动。',

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
    composerPlaceholderStreaming: '正在回复中 — 消息将加入队列，回复完成后自动发送…',
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

    // Context usage chip (popover above the composer)
    contextUsageLabel: '上下文',
    contextUsageTitle: '上下文用量',
    contextUsageUsed: '已用',
    contextUsageWindow: '上下文窗口',
    contextUsageInput: '输入',
    contextUsageCacheRead: '缓存命中',
    contextUsageCacheWrite: '缓存新写入',
    contextUsageOutput: '本轮输出',

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

    // Permission — floating card (docked above the composer) + the
    // wait anchor left inside the tool card. The old inline three-button
    // prompt's keys (permissionHeader/Prompt/Deny/FooterEsc/FooterEnter/
    // AskHeader/AllowSession) retired with it, 2026-07-07.
    permissionAriaLabel: '{toolName} 授权',
    permissionNoParams: '（无参数）',
    permissionYes: '同意',
    permissionFloatTitle: '允许{tool}吗？',
    permissionFloatQueued: '还有 {count} 个等待',
    permissionFloatAllowSession: '同意，本次会话内不再问',
    permissionFloatDenyFeedback: '不同意，告诉它下一步怎么做',
    permissionFloatFeedbackPlaceholder: '例如：先别写桌面，放到 Downloads 里…',
    permissionFloatHint: '数字键直选，↑↓ 切换',
    permissionFloatSkip: '跳过',
    permissionFloatSubmit: '提交',
    permissionWaitAnchor: '需要你的授权才能继续',
    permissionWaitAnchorHint: '见下方 ↓',
    askWaitAnchor: '等待你回答',
    askWaitAnchorHint: '在下方输入区作答 ↓',

    // Tool-call card — labels for the default input/output panes and
    // the raw-data toggle that friendly-view tool cards show at the
    // bottom for power users.
    toolPaneInputLabel: 'Input',
    toolPaneOutputLabel: 'Output',
    toolRawDataSummary: '原始数据',
    toolWorkflowTasksLabel: '子任务',
    toolStatusRunning: '运行中',
    toolStatusDone: '完成',
    toolRunningHint: '正在执行',
    toolStatusPending: '等待中',
    toolStatusFailed: '失败',
    toolStatusStopped: '已停止',
    toolWorkflowResultLabel: '结果',
    toolWorkflowAgentsLabel: 'agents',

    // Workflow script panel (left pane) + the script entry chip on the
    // Workflow tool card that reopens it.
    workflowScriptPanelTitle: '编排脚本',
    workflowScriptWriting: '正在编写',
    workflowScriptPreparing: '正在准备脚本',
    workflowScriptLines: '{count} 行',
    workflowScriptClose: '关闭脚本面板',
    workflowScriptEntryOpen: '查看脚本',

    // Spreadsheet preview panel (right pane, opened from deliverable
    // file cards for xlsx / xls / csv).
    sheetPreviewOpenExternal: '用系统应用打开',
    sheetPreviewClose: '关闭表格预览',
    sheetPreviewLoading: '正在读取表格',
    sheetPreviewError: '无法预览此表格',
    sheetPreviewEmpty: '这个工作表是空的',
    sheetPreviewDims: '{rows} 行 × {cols} 列',
    sheetPreviewTruncated: '表格较大，仅显示前 {rows} 行（共 {total} 行）',
    sheetPreviewZoomIn: '放大',
    sheetPreviewZoomOut: '缩小',
    sheetPreviewZoomReset: '恢复 100%',
    sheetPreviewAskPlaceholder: '针对选区问点什么…',
    sheetPreviewCopy: '复制选区',
    sheetPreviewSend: '发送给 AI',
    sheetPreviewStale: '刷新以查看最新内容',
    sheetPreviewStaleDismiss: '忽略此次变更',
    sheetSelectionRange: '范围:',
    sheetSelectionPill: '1 条注释',

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
    chatHeaderAiBadge: 'AI-generated',
    chatHeaderUntitled: 'New chat',
    chatHeaderOutputs: 'Outputs',
    chatHeaderOutputsEmpty: 'No outputs yet in this chat',
    chatHeaderOutputsEmptyHint: 'Images, documents, and spreadsheets will show up here as they’re created',
    outputsGroupImages: 'Images',
    outputsGroupFiles: 'Files',
    sidebarStatusRunning: 'Running',
    sidebarStatusAwaitingPermission: 'Awaiting approval',
    sidebarStatusAwaitingAnswer: 'Awaiting answer',
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
    switchWorkspaceTooltip: 'Click to switch workspace',
    confirmSwitchWorkspace:
      'Switching workspace will abort the in-flight turn and discard unsent drafts. Continue?',
    confirmInterruptStreaming:
      'A chat turn is still in progress. Continuing will interrupt it. Are you sure?',

    renameChat: 'Rename',
    renameChatPrompt: 'Enter a new name for this chat',
    renameChatFailed: 'Rename failed',
    renameChatSave: 'Save name',
    chatHeaderMenu: 'Chat actions',

    // Replay (session demo playback)
    replayExportMenu: 'Export as demo',
    replayOpenFile: 'Open demo file…',
    replayBadge: 'Demo replay',
    replayPlay: 'Play',
    replayPause: 'Pause',
    replaySpeed: 'Speed',
    replayExit: 'Exit replay',
    replayDone: 'Demo finished',
    replayOpenFailed: 'Failed to open demo file',
    demoShowcaseTitle: 'See what it can do',
    demoShowcaseHint: 'Each under a minute — replays of real sessions',
    demoShowcasePlay: 'Play demo',
    demoShowcaseTag: 'Demo replay',
    demoShowcaseFallbackDesc: 'turns · real session replay',
    replaySlidesTitle: 'Slides',
    replaySlidesEmpty: 'Generating slides…',
    searchChats: 'Search chats',
    searchChatsPlaceholder: 'Search chat titles and messages…',
    searchRecent: 'Recent chats',
    searchNoResults: 'No matching chats found',
    searchWhoUser: 'You: ',
    searchWhoAi: 'AI: ',
    searchHitCountPrefix: '',
    searchHitCountSuffix: ' matching messages',
    searchKbdSelect: 'select',
    searchKbdOpen: 'open',
    searchKbdClose: 'close',
    searchResultSuffix: ' results',

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
    scenarioProposalTitle: 'Write a proposal',
    scenarioProposalDesc: 'Use the company knowledge base to co-author a construction proposal draft',
    scenarioProposalPrompt:
      'Which product the proposal is for, and which customer or scenario; how to split it into sections, and what each section should focus on.',

    catKnowledgeBase: 'Proposal Knowledge Base',

    // EmptyState scenario navigation (ScenarioRail): category tab labels.
    scenarioCatDaily: 'Everyday work',
    scenarioCatCode: 'Coding',
    scenarioCatDesign: 'Design & creative',

    // Settings — Configuration category — Image API credentials for the
    // in-editor image generate/edit feature.
    imageApiTitle: 'Image API',
    imageApiDesc:
      'Configure image generation/editing API credentials used by the in-editor image tools. Entry points stay disabled until this is set up.',
    imageApiKeyLabel: 'API Key',
    imageApiKeyPlaceholderConfigured: '••••',
    imageApiKeyPlaceholderEmpty: 'Not configured',
    imageApiKeyClear: 'Clear saved key',
    imageApiBaseUrlLabel: 'Base URL',
    imageApiBaseUrlPlaceholder: 'https://api.example.com/v1',
    imageApiModelLabel: 'Default model',
    imageApiSave: 'Save',
    imageApiSaving: 'Saving…',
    imageApiSaved: 'Saved',
    // Settings — Knowledge Base category — proposal-writing source (local folder / remote sync)
    kbSourceTitle: 'Knowledge base source',
    kbSourceDesc:
      'Where proposal writing retrieves source material from. Remote mode is built on the server and auto-synced.',
    kbSourceLocal: 'Local folder',
    kbSourceLocalDesc:
      'Pick a local source folder; the index must be built on this machine (requires markitdown / LibreOffice)',
    kbSourceRemote: 'Remote server',
    kbSourceRemoteDesc: 'Company KB server address, e.g. http://10.0.0.5:8080',
    kbPickFolder: 'Choose folder…',
    kbRemoteUrl: 'Server URL',
    kbRemoteApply: 'Save & sync',
    kbSyncNow: 'Sync now',
    kbSyncing: 'Syncing…',
    kbLastSync: 'Last synced',
    kbVersion: 'KB version',
    kbSyncFailed: 'Sync failed',
    kbNeverSynced: 'Never synced',

    // KB managed repository manager (P2)
    kbManageOpen: 'Open KB manager',
    kbManageTitle: 'Proposal Knowledge Base',
    kbManageEmpty: 'No documents yet — click Import to add.',
    kbManageLoading: 'Loading knowledge base…',
    kbManageReadOnly: 'Managed by the editor machine — browse only.',
    kbColTitle: 'Document',
    kbStatusIndexed: 'Indexed',
    kbStatusFailed: 'Convert failed',
    kbImport: 'Import',
    kbNewLine: 'New product line',
    kbNewProduct: 'New product',
    kbRename: 'Rename',
    kbDelete: 'Delete',
    kbMove: 'Move',
    kbOpenSource: 'Open original',
    kbPreview: 'Preview',
    kbRetry: 'Retry',
    kbToolingMissing: 'markitdown not found — cannot import Office docs. Install: pipx install markitdown',
    kbBuilding: 'Building index',
    kbConfirmDeleteDoc: 'Delete "{title}"? Original, mirror and index entry are all removed.',
    kbConfirmDeleteCat: 'Delete category "{name}" and all its documents?',
    kbPromptOk: 'OK',
    kbPromptCancel: 'Cancel',
    kbConflictPrompt: '{n} document(s) already exist — overwrite with new version?',
    kbMigrateCta: 'Bulk-import from legacy folder',
    kbMigrateDone: 'Imported {n} document(s)',
    kbSyncLocal: 'Sync from folder',
    kbSyncLocalHint: 'Align the KB with the current state of your local source folder (adds/deletes/renames sync; only changed files are re-processed)',
    kbSyncDone: 'Synced — added {a} · updated {u} · deleted {d}',
    kbSyncConfirm: 'This sync will add {a}, update {u}, and delete {d} file(s).\n\nThe following files will be removed from the knowledge base (your local originals are untouched):\n{list}\n\nNote: if you renamed a file and also changed its extension (e.g. .docx → .doc), it becomes unsupported and shows up here as a deletion. Continue syncing?',
    kbSyncMore: '\n…and {n} more',
    kbSyncCancelled: 'Sync cancelled — the knowledge base was not changed.',

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
    composerPlaceholderStreaming:
      'Replying — your message will queue and send when the reply finishes…',
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

    // Context usage chip (popover above the composer)
    contextUsageLabel: 'Context',
    contextUsageTitle: 'Context usage',
    contextUsageUsed: 'Used',
    contextUsageWindow: 'Context window',
    contextUsageInput: 'Input',
    contextUsageCacheRead: 'Cache read',
    contextUsageCacheWrite: 'Cache write',
    contextUsageOutput: 'Last output',

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

    permissionAriaLabel: '{toolName} permission',
    permissionNoParams: '(no parameters)',
    permissionYes: 'Yes',
    permissionFloatTitle: 'Allow {tool}?',
    permissionFloatQueued: '{count} more waiting',
    permissionFloatAllowSession: "Yes, don't ask again this session",
    permissionFloatDenyFeedback: 'No — tell it what to do instead',
    permissionFloatFeedbackPlaceholder:
      'e.g. Not the Desktop — put it in Downloads instead…',
    permissionFloatHint: 'Numbers select · ↑↓ move',
    permissionFloatSkip: 'Skip',
    permissionFloatSubmit: 'Submit',
    permissionWaitAnchor: 'Waiting for your approval to continue',
    permissionWaitAnchorHint: 'See below ↓',
    askWaitAnchor: 'Waiting for your answer',
    askWaitAnchorHint: 'Answer in the input area below ↓',

    toolPaneInputLabel: 'Input',
    toolPaneOutputLabel: 'Output',
    toolRawDataSummary: 'Raw data',
    toolWorkflowTasksLabel: 'Subtasks',
    toolStatusRunning: 'running',
    toolStatusDone: 'done',
    toolRunningHint: 'Working',
    toolStatusPending: 'pending',
    toolStatusFailed: 'failed',
    toolStatusStopped: 'stopped',
    toolWorkflowResultLabel: 'Result',
    toolWorkflowAgentsLabel: 'agents',

    workflowScriptPanelTitle: 'Workflow script',
    workflowScriptWriting: 'Writing',
    workflowScriptPreparing: 'Preparing script',
    workflowScriptLines: '{count} lines',
    workflowScriptClose: 'Close script panel',
    workflowScriptEntryOpen: 'View script',

    sheetPreviewOpenExternal: 'Open in default app',
    sheetPreviewClose: 'Close spreadsheet preview',
    sheetPreviewLoading: 'Loading spreadsheet',
    sheetPreviewError: 'Cannot preview this spreadsheet',
    sheetPreviewEmpty: 'This sheet is empty',
    sheetPreviewDims: '{rows} rows × {cols} cols',
    sheetPreviewTruncated: 'Large sheet — showing first {rows} of {total} rows',
    sheetPreviewZoomIn: 'Zoom in',
    sheetPreviewZoomOut: 'Zoom out',
    sheetPreviewZoomReset: 'Reset to 100%',
    sheetPreviewAskPlaceholder: 'Ask about the selection…',
    sheetPreviewCopy: 'Copy selection',
    sheetPreviewSend: 'Send to AI',
    sheetPreviewStale: 'Refresh to see latest changes',
    sheetPreviewStaleDismiss: 'Dismiss this change',
    sheetSelectionRange: 'Range: ',
    sheetSelectionPill: '1 note',

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
  Workflow: '多智能体编排',
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
