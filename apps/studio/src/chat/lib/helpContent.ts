/**
 * 设置页「使用帮助」的全部内容（2026-09-04）。
 *
 * 为什么是纯数据文件而不是写在组件里：帮助讲的是界面事实，界面一改文案就错，
 * 集中在一个文件里、每条注明依据的组件，改功能时顺手就能改到。放在
 * src/chat/lib/ 是为了进 `bun test` 的扫描范围（package.json 的 test 脚本只扫
 * electron/、src/chat/lib、src/chat/composer）。
 *
 * 纪律：
 * - 本文件不得 import src/canvas/**（跨面 import 是坑源），所以 section 跳转
 *   目标收窄成三个字面量而不是引用 SettingsSection。
 * - 文案是大白话，面向不懂技术的用户；每一句界面事实都要能在「依据」指向的
 *   组件里找到，不许凭印象添加功能。
 * - 设计文档：docs/superpowers/specs/2026-09-04-help-section-design.md
 */

/** 帮助条目可以跳去的设置分区。刻意只列帮助用到的三个，见文件头。 */
export type HelpSectionTarget = 'skills' | 'knowledgeBase' | 'execution'

export type HelpAction =
  /** 切到设置页的另一个分区（设置页不关） */
  | { kind: 'section'; section: HelpSectionTarget; label?: string }
  /** 关掉设置页，打开侧栏的知识库 / 插件面 */
  | { kind: 'surface'; surface: 'kb' | 'market'; label?: string }
  /** 打开「问题反馈」弹窗 */
  | { kind: 'feedback'; label?: string }

export interface HelpItem {
  /** 稳定 id，形如 'chat-new'；只用于 React key 与测试去重 */
  id: string
  /** 折叠块标题 */
  question: string
  /** 每项一段，渲染成一个 <p> */
  answer: string[]
  /** 额外搜索词，空格分隔。问题标题本身已自动进搜索，这里放用户可能用的别名。 */
  keywords?: string
  /** 「去看看」按钮；没有就不渲染按钮 */
  action?: HelpAction
}

export interface HelpGroup {
  id: string
  title: string
  items: HelpItem[]
}

export const HELP_GROUPS: HelpGroup[] = [
  {
    id: 'start',
    title: '开始第一次对话',
    items: [
      {
        // 依据：AppRail.tsx「新对话」按钮；ProseMirrorComposerInput.tsx Enter/Shift+Enter；
        // chat/i18n.ts 的 placeholder「↵ 发送 · ⇧↵ 换行」与「回复中 Enter 加入队列」。
        id: 'start-new-chat',
        question: '怎么开始一个新对话？',
        answer: [
          '点左侧栏最上面的「新对话」，就会得到一个空白对话。',
          '在下方输入框里打字，按 Enter 发送；想换行就按 Shift + Enter。',
          'AI 正在回复时你也可以继续打字，按 Enter 会先排队，等它说完再接着处理。',
        ],
        keywords: '新建 发送 换行 回车 排队 enter',
      },
      {
        // 依据：产品原则（PRODUCT.md「把想法交给智能体」），非界面事实。
        id: 'start-describe-task',
        question: '怎么把任务说清楚？',
        answer: [
          '把它当成交代给一位新同事：说清你要什么结果、给它需要的材料、说明想要的格式。',
          '例如：「根据附件里的会议纪要，写一份 500 字的项目周报，用要点列出进度、风险和下一步。」',
          '说得越具体，第一次得到的结果就越接近你想要的；不满意可以直接接着说「再短一点」「换个语气」。',
        ],
        keywords: '提示词 怎么问 描述 需求 prompt',
      },
      {
        // 依据：Composer.tsx「+」按钮（aria「附加文件或图片」）；ThreadView.tsx 拖拽；
        // ProseMirrorComposerInput.tsx 粘贴；attachFiles.ts；fileMentionAdapter.ts 的 @ 引用。
        id: 'start-attach',
        question: '怎么附上文件或图片？',
        answer: [
          '三种方式都行：点输入框左下角的「+」选文件；把文件直接拖进窗口；或者复制一张截图后在输入框里粘贴。',
          '文件类型没有限制，文档、表格、图片都可以。',
          '想让 AI 读电脑里的某个文件，也可以在输入框里输入 @，然后选文件名。',
        ],
        keywords: '上传 附件 图片 截图 拖拽 粘贴 文件 @',
      },
      {
        // 依据：slashAdapter.ts「/」菜单分技能/命令；Composer.tsx 技能按钮（SkillPickerPopover）；
        // ScenarioRail.tsx 空白页场景入口。
        id: 'start-skills',
        question: '怎么用技能？',
        answer: [
          '技能是为某类任务准备好的专家流程，比如做 PPT、写方案、处理表格。',
          '在输入框里输入 /，会弹出技能列表；也可以点输入框旁边的技能按钮来挑选。',
          '空白对话页上方也有常用场景的入口，点一下就会把对应技能填进输入框。',
          '想看全部技能、或关掉某个技能，去设置里的「技能」分区。',
        ],
        keywords: '斜杠 / 场景 ppt 方案 表格 skill',
        action: { kind: 'section', section: 'skills', label: '去看技能列表' },
      },
    ],
  },
  {
    id: 'permission',
    title: '智能体动手前会问我吗？',
    items: [
      {
        // 依据：PermissionModePicker.tsx 三档文案；chat/stores/permissionMode.ts 默认值为
        // bypassPermissions（全自动）。
        id: 'permission-modes',
        question: '「默认」「计划」「全自动」三种模式是什么意思？',
        answer: [
          '输入框工具行里有一个模式开关，决定 AI 要改文件、跑命令之前要不要先问你。',
          '「全自动」：全权交给它，不逐步确认。这是安装后的初始设置，所以平时你不会看到确认卡片。',
          '「默认」：关键操作前先向你确认，你点同意它才做。',
          '「计划」：只看不改，先给你一份计划，你点头后再执行。',
        ],
        keywords: '权限 模式 确认 自动 bypass plan 计划',
      },
      {
        // 依据：PermissionComposerPanel.tsx——「同意」「同意，本次会话内不再问」、理由输入框、
        // 「跳过」= 拒绝、数字键直选、Esc 跳过。
        id: 'permission-answer',
        question: '弹出「允许 … 吗？」时怎么回答？',
        answer: [
          '这是 AI 在问你能不能做某件事，输入框会暂时变成一张确认卡片。',
          '点「同意」它就做这一次；点「同意，本次会话内不再问」这个对话里同类操作都不再问你。',
          '不同意的话，在卡片下方的输入框里写一句你希望它改成怎么做，发送后它会照办；什么都不写直接点「跳过」就是拒绝。',
          '也可以按数字键快速选，按 Esc 等于跳过。',
        ],
        keywords: '允许 同意 拒绝 跳过 确认卡片 权限请求',
      },
      {
        // 依据：产品建议，基于 PermissionModePicker.tsx 的「计划」档说明。
        id: 'permission-when-plan',
        question: '什么时候该用「计划」模式？',
        answer: [
          '改动范围大、或者你还不确定该怎么做的时候，先切到「计划」。',
          'AI 会先把打算怎么做列出来，你看过、改过意见之后，再切回「默认」或「全自动」让它动手。',
          '这样能避免它在你没看清楚之前就改了一堆东西。',
        ],
        keywords: '计划 先看 方案 大改 plan',
      },
    ],
  },
  {
    id: 'kb',
    title: '知识库',
    items: [
      {
        // 依据：KnowledgeBaseSection.tsx 说明「『写方案』检索资料的地方」。
        id: 'kb-what',
        question: '知识库是干什么的？',
        answer: [
          '知识库是 AI 写东西时可以翻阅的资料柜。像「写方案」这类技能，会先到知识库里找相关资料再动笔。',
          '你放进去的是自己电脑上的文档，AI 只在需要时读取，不会把它们发到别处。',
        ],
        keywords: '资料 检索 文档 rag knowledge',
      },
      {
        // 依据：AllFilesPanel.tsx 目录管理弹层——预设「下载/桌面」开关 + 「添加文件夹…」，
        // 是扫描本机目录，没有上传功能。
        id: 'kb-add',
        question: '怎么把资料放进知识库？',
        answer: [
          '点左侧栏的「知识库」，再点上方的「目录管理」，把装资料的文件夹加进去。',
          '它不是上传，而是让应用去读你指定的文件夹；之后往那个文件夹里放新文件，点「重新扫描」就能被收进来。',
          '「下载」和「桌面」两个常用文件夹可以直接打开开关。',
        ],
        keywords: '添加 文件夹 目录 扫描 导入 上传',
        action: { kind: 'surface', surface: 'kb', label: '打开知识库' },
      },
      {
        // 依据：KnowledgeBaseSection.tsx——「本地目录」选择文件夹 / 「远程服务器」填地址后
        // 「保存并同步」。
        id: 'kb-source',
        question: '「本地目录」和「远程服务器」有什么区别？',
        answer: [
          '在设置的「知识库」分区里可以二选一。',
          '「本地目录」：资料就在你自己电脑上，选一个文件夹即可，适合个人使用。',
          '「远程服务器」：资料放在公司统一的服务器上，填地址后点「保存并同步」，适合团队共用一套资料。',
        ],
        keywords: '来源 本地 远程 服务器 同步',
        action: { kind: 'section', section: 'knowledgeBase', label: '去设置资料来源' },
      },
    ],
  },
  {
    id: 'plugins',
    title: '插件与技能',
    items: [
      {
        // 依据：MarketView.tsx 两个 tab 的副标题——插件「在你常用的工具中与 AI 协作」、
        // 技能「通过任务专用技能扩展 AI 的能力」。
        id: 'plugins-vs-skills',
        question: '插件和技能有什么区别？',
        answer: [
          '插件：把 AI 接进你常用的工具，比如让它能读写你的某个在线文档或聊天软件。',
          '技能：教 AI 一套做某类任务的专家流程，比如做 PPT、审标书、写公众号文案。',
          '简单记：插件管「能碰到什么」，技能管「会做什么」。',
        ],
        keywords: '区别 插件 技能 plugin skill',
      },
      {
        // 依据：AppRail.tsx「插件」入口只在聊天面显示；MarketView.tsx 搜索；InstallButton.tsx
        // 安装 → 安装中 → 已安装；MarketDetailPage.tsx「新会话生效」。
        id: 'plugins-install',
        question: '怎么安装插件或技能？',
        answer: [
          '在「智能助手」面点左侧栏的「插件」，上方可以切换「插件」「技能」两个列表，用搜索框找到想要的，点「安装」。',
          '装好后要新开一个对话才会生效，正在进行的对话不会自动用上。',
          '不想要了，回到同一个地方，把鼠标放到「已安装」上会变成「移除」。',
        ],
        keywords: '安装 市场 商店 卸载 移除 market',
        action: { kind: 'surface', surface: 'market', label: '打开插件市场' },
      },
      {
        // 依据：SkillsSection.tsx 每行技能有启用开关。
        id: 'plugins-disable-skill',
        question: '怎么关掉不想要的技能？',
        answer: [
          '打开设置的「技能」分区，每个技能前面都有一个开关，关掉它就不会再出现在 / 列表里。',
          '关掉不会删除，随时可以再打开。',
        ],
        keywords: '禁用 关闭 开关 启用',
        action: { kind: 'section', section: 'skills', label: '去看技能列表' },
      },
    ],
  },
  {
    id: 'faq',
    title: '常见问题',
    items: [
      {
        // 依据：Composer.tsx TurnFailedBanner + chat/i18n.ts「回复中断了 … 重试」；
        // failedTurn.ts 原样重发；用户按 Esc 停止不触发。
        id: 'faq-retry',
        question: '回复中断了怎么办？',
        answer: [
          '网络波动或服务异常时，输入框上方会出现一条「回复中断了」提示，点旁边的「重试」，会把你上一条消息原样再发一次，附件也会带上。',
          '如果是你自己按 Esc 停下来的，不算中断，不会出现这条提示。',
        ],
        keywords: '中断 失败 重试 断网 报错 卡住',
      },
      {
        // 依据：ComponentGate.tsx——首启下载 AI 引擎；失败时「重试下载」；探测到本机 claude
        // 则给「使用本机已安装的 Claude 继续」；否则提示检查网络后重启。
        id: 'faq-first-launch',
        question: '第一次启动一直在下载，或者下载失败？',
        answer: [
          '第一次打开时需要下载一次 AI 引擎，之后就不用了。这一步不能跳过，请耐心等它完成。',
          '失败了先点「重试下载」；如果反复失败，检查一下网络，然后重启应用再试。',
          '如果你电脑上本来就装了 Claude，会多出一个「使用本机已安装的 Claude 继续」的按钮，点它可以直接用。',
        ],
        keywords: '启动 下载 安装 引擎 组件 失败 卡住',
      },
      {
        // 依据：RailSessionList.tsx 会话行菜单「重命名」「删除」，删除有不可撤销确认框。
        id: 'faq-rename-delete',
        question: '怎么重命名或删除对话？',
        answer: [
          '在左侧栏的对话列表里，右键点某个对话，选「重命名」或「删除」。',
          '删除之前会再问你一次，确认后这个对话和里面的消息就没了，不能恢复。',
        ],
        keywords: '重命名 删除 会话 对话 历史',
      },
      {
        // 依据：AppRail.tsx「问题反馈」常驻入口；SettingsDialog.tsx 关于分区反馈行
        // 「最多可以附 4 张截图」。
        id: 'faq-feedback',
        question: '遇到问题怎么反馈？',
        answer: [
          '点左侧栏的「问题反馈」，或者在设置的「关于与更新」里点「问题反馈」。',
          '写清楚你做了什么、看到了什么，最多可以附 4 张截图，我们会更容易帮你解决。',
        ],
        keywords: '反馈 bug 建议 联系 客服',
        action: { kind: 'feedback', label: '去反馈' },
      },
    ],
  },
]

/**
 * 把全部组标题、问题标题和额外关键词拼成一串，给设置页侧栏搜索用
 * （SettingsDialogV2 的 NavItem.keywords）。空格分隔、无换行——搜索那边是
 * 小写化后做子串包含，所以中文原样拼上就能命中。
 */
export function buildHelpKeywords(groups: HelpGroup[]): string {
  return groups
    .flatMap((g) => [g.title, ...g.items.flatMap((i) => [i.question, i.keywords ?? ''])])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}
