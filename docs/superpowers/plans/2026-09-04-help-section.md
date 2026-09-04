# 设置页「使用帮助」分区 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置页「关于」组新增「使用帮助」分区：5 组 17 条可展开问答，部分条目带「去看看」按钮跳到对应设置分区 / 侧栏面 / 反馈弹窗。

**Architecture:** 纯数据文件（`src/chat/lib/helpContent.ts`，进 bun test 范围）+ 一个无状态渲染组件（`src/canvas/components/settings/HelpSection.tsx`，用现有 SettingGroup/SettingCard 原语 + 原生 `<details>`）+ 4 处接线（section token、页头标题表、内容分支、V2 导航项）。搜索关键词从数据自动生成。

**Tech Stack:** React 19、TypeScript、Tailwind v4 utility、shadcn Button、lucide-react、zustand store（`stores/surfaceOverlay`、`chat/stores/dialogs`）、bun test。

**Spec:** `docs/superpowers/specs/2026-09-04-help-section-design.md`

## Global Constraints

- 包管理器是 **bun**，所有命令在 `apps/studio` 下跑：`bun test`、`bun run typecheck`（根目录跑 `bun run typecheck` 也可，覆盖全 workspace）。
- 设置页目录（`src/canvas/components/SettingsDialog/`、`src/canvas/components/settings/`）里的新 markup **一律 shadcn 原语 + Tailwind utility，禁止使用 `.settings-*` / `.sv2-*` / `.field*` 等 legacy 类**。
- 裸 `<details>` / `<summary>` / `<button>` 必须带 `data-slot="…"` 属性，逃逸 canvas 的裸元素 reset。
- 文案中文硬编码；导航与页头标题走 `tt(key, 中文兜底)`，**不改 19 本字典**。
- 文案必须是大白话，面向不懂技术的用户；界面事实以 spec 第 3 节核实过的内容为准，不许凭印象添加功能。
- `src/chat/lib/` 下的文件**不得 import `src/canvas/**`**（跨面 import 是坑源）。
- 提交信息末尾带：
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01B6qTBX2cfR6mAqjjVFpPiE
  ```
- 不要一并提交无关的未跟踪文件 `create_report.py` 与 `desktop/`。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/studio/src/chat/lib/helpContent.ts` | 新建 | 帮助内容数据（5 组 17 条）+ `buildHelpKeywords` 纯函数 |
| `apps/studio/src/chat/lib/helpContent.test.ts` | 新建 | 数据完整性测试 |
| `apps/studio/src/canvas/components/settings/HelpSection.tsx` | 新建 | 渲染组卡 + 折叠问答 + 「去看看」动作 |
| `apps/studio/src/canvas/components/SettingsDialog/settingsHelpers.ts` | 修改 | `SettingsSection` 加 `'help'`；`useSectionHeaders` 加一行 |
| `apps/studio/src/canvas/components/SettingsDialog/SettingsDialog.tsx` | 修改 | 内容区加 `help` 分支 |
| `apps/studio/src/canvas/components/settings/SettingsDialogV2.tsx` | 修改 | 「关于」组首位加导航项 |

---

### Task 1: 帮助内容数据 + 关键词生成（TDD）

**Files:**
- Create: `apps/studio/src/chat/lib/helpContent.ts`
- Test: `apps/studio/src/chat/lib/helpContent.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  ```ts
  export type HelpSectionTarget = 'skills' | 'knowledgeBase' | 'execution'
  export type HelpAction =
    | { kind: 'section'; section: HelpSectionTarget; label?: string }
    | { kind: 'surface'; surface: 'kb' | 'market'; label?: string }
    | { kind: 'feedback'; label?: string }
  export interface HelpItem { id: string; question: string; answer: string[]; keywords?: string; action?: HelpAction }
  export interface HelpGroup { id: string; title: string; items: HelpItem[] }
  export const HELP_GROUPS: HelpGroup[]
  export function buildHelpKeywords(groups: HelpGroup[]): string
  ```
  Task 2 用 `HELP_GROUPS` 与四个类型；Task 4 用 `buildHelpKeywords(HELP_GROUPS)`。

- [ ] **Step 1: 写失败的测试**

`apps/studio/src/chat/lib/helpContent.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'
import { HELP_GROUPS, buildHelpKeywords, type HelpGroup } from './helpContent'

describe('HELP_GROUPS 数据完整性', () => {
  it('组 id 与条目 id 全局唯一', () => {
    const groupIds = HELP_GROUPS.map((g) => g.id)
    expect(new Set(groupIds).size).toBe(groupIds.length)
    const itemIds = HELP_GROUPS.flatMap((g) => g.items.map((i) => i.id))
    expect(new Set(itemIds).size).toBe(itemIds.length)
  })

  it('每组有标题且至少一条；每条问题非空、回答至少一段且每段非空', () => {
    for (const g of HELP_GROUPS) {
      expect(g.title.trim().length).toBeGreaterThan(0)
      expect(g.items.length).toBeGreaterThan(0)
      for (const item of g.items) {
        expect(item.question.trim().length).toBeGreaterThan(0)
        expect(item.answer.length).toBeGreaterThan(0)
        for (const p of item.answer) expect(p.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('section 跳转目标只允许三个值（防止有人把类型放宽）', () => {
    const allowed = new Set(['skills', 'knowledgeBase', 'execution'])
    for (const item of HELP_GROUPS.flatMap((g) => g.items)) {
      if (item.action?.kind === 'section') expect(allowed.has(item.action.section)).toBe(true)
    }
  })

  it('共 5 组 17 条（与设计文档对齐；改内容时同步改这里）', () => {
    expect(HELP_GROUPS.length).toBe(5)
    expect(HELP_GROUPS.reduce((n, g) => n + g.items.length, 0)).toBe(17)
  })
})

describe('buildHelpKeywords', () => {
  const groups: HelpGroup[] = [
    {
      id: 'a',
      title: '组A',
      items: [
        { id: 'a1', question: '怎么开始？', answer: ['x'], keywords: 'start 开始' },
        { id: 'a2', question: '怎么附件？', answer: ['y'] },
      ],
    },
  ]

  it('包含每个组标题、每条问题和额外关键词，空格分隔、无换行', () => {
    const out = buildHelpKeywords(groups)
    expect(out).toContain('组A')
    expect(out).toContain('怎么开始？')
    expect(out).toContain('怎么附件？')
    expect(out).toContain('start 开始')
    expect(out.includes('\n')).toBe(false)
  })

  it('对真实数据输出非空且包含「权限」「重试」（走查用的两个搜索词）', () => {
    const out = buildHelpKeywords(HELP_GROUPS)
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain('权限')
    expect(out).toContain('重试')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test src/chat/lib/helpContent.test.ts`
Expected: FAIL，报 `Cannot find module './helpContent'`。

- [ ] **Step 3: 写数据文件**

`apps/studio/src/chat/lib/helpContent.ts`（完整内容，文案照抄，不要自己发挥；每条 `// 依据：` 注释指向核实过的组件）：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && bun test src/chat/lib/helpContent.test.ts`
Expected: 6 pass, 0 fail。

- [ ] **Step 5: 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/studio/src/chat/lib/helpContent.ts apps/studio/src/chat/lib/helpContent.test.ts
git commit -m "feat(studio): 使用帮助内容数据（5 组 17 条）+ 搜索关键词生成

纯数据放 src/chat/lib 进 bun test 范围；每条注明依据的组件，界面改了顺手改文案。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01B6qTBX2cfR6mAqjjVFpPiE"
```

---

### Task 2: HelpSection 渲染组件

**Files:**
- Create: `apps/studio/src/canvas/components/settings/HelpSection.tsx`

**Interfaces:**
- Consumes（Task 1）：`HELP_GROUPS`、`HelpAction`、`HelpItem` from `@/src/chat/lib/helpContent`；
  现有：`SettingGroup`、`SettingCard` from `./SettingPrimitives`；`Button` from `@/src/components/ui/button`；
  `openSurfaceOverlay` from `@/src/stores/surfaceOverlay`；`useDialogStore` from `@/src/chat/stores/dialogs`；
  `SettingsSection` type from `../SettingsDialog/settingsHelpers`。
- Produces：
  ```ts
  export function HelpSection(props: { onSelectSection: (s: SettingsSection) => void; onClose: () => void }): React.JSX.Element
  ```
  Task 3 在 SettingsDialog 里渲染它。

本组件没有纯逻辑可单测（全是 markup + 三个一行的动作转发），验证靠 Task 5 的 typecheck 与 Task 6 的真机走查。

- [ ] **Step 1: 写组件**

`apps/studio/src/canvas/components/settings/HelpSection.tsx`：

```tsx
/**
 * 设置页「使用帮助」分区（2026-09-04）。
 *
 * 内容全部来自 src/chat/lib/helpContent.ts，这里只管渲染：一组一张组卡
 * （SettingGroup + SettingCard），卡内每条是一个原生 <details> 折叠块，点问题
 * 展开回答，回答末尾按 action 渲染一颗「去看看」按钮。
 *
 * 为什么用原生 <details> 而不是引 accordion 组件：执行模式页已经在用同一套
 * <details> 写法（SettingsDialog.tsx 的 MemoryModelInline 折叠块），开合状态交给
 * 浏览器，零 state、零依赖；本仓库的 components/ui 里也没有 accordion 原语。
 *
 * 三种动作为什么这样实现：
 * - section：切设置分区，走父组件的 setActiveSection（embedded 模式下会经
 *   onSectionChange 回报给 V2 壳，与「记忆 → 连接器」的既有面内跳转同一条路）。
 * - surface：设置页是盖住 rail 的全屏 overlay，必须**先关设置再开面**，否则面
 *   开了也被设置页盖着看不见。openSurfaceOverlay 来自根层 store，canvas App.tsx
 *   已有同样的跨树 import 先例。
 * - feedback：与关于分区「问题反馈」行同一调用（useDialogStore.openDialog）。
 *
 * 样式纪律（CLAUDE.md）：只用 shadcn 原语 + Tailwind utility；裸 <details>/<summary>
 * 带 data-slot 逃逸 canvas 的裸元素 reset。
 */

import { ChevronRight } from 'lucide-react';

import { Button } from '@/src/components/ui/button';
import { HELP_GROUPS, type HelpAction, type HelpItem } from '@/src/chat/lib/helpContent';
import { useDialogStore } from '@/src/chat/stores/dialogs';
import { openSurfaceOverlay } from '@/src/stores/surfaceOverlay';

import type { SettingsSection } from '../SettingsDialog/settingsHelpers';
import { SettingCard, SettingGroup } from './SettingPrimitives';

interface HelpSectionProps {
  /** 切到设置页的另一个分区（设置页保持打开） */
  onSelectSection: (section: SettingsSection) => void;
  /** 关闭设置页；跳侧栏面之前必须先调它 */
  onClose: () => void;
}

const DEFAULT_ACTION_LABEL = '去看看';

export function HelpSection({ onSelectSection, onClose }: HelpSectionProps): React.JSX.Element {
  const runAction = (action: HelpAction): void => {
    if (action.kind === 'section') {
      onSelectSection(action.section);
      return;
    }
    if (action.kind === 'surface') {
      onClose();
      openSurfaceOverlay(action.surface);
      return;
    }
    useDialogStore.getState().openDialog('feedback');
  };

  return (
    <section>
      {HELP_GROUPS.map((group) => (
        <SettingGroup key={group.id} label={group.title}>
          <SettingCard>
            {group.items.map((item) => (
              <HelpItemRow key={item.id} item={item} onAction={runAction} />
            ))}
          </SettingCard>
        </SettingGroup>
      ))}
    </section>
  );
}

function HelpItemRow({
  item,
  onAction,
}: {
  item: HelpItem;
  onAction: (action: HelpAction) => void;
}): React.JSX.Element {
  return (
    <details data-slot="help-item" className="group">
      <summary
        data-slot="help-item-summary"
        className="flex cursor-pointer select-none list-none items-center gap-2 px-3.5 py-3 transition-colors hover:bg-secondary/50 [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="text-[13px] font-medium text-foreground">{item.question}</span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-border/50 px-3.5 pb-4 pt-3 pl-[2.375rem]">
        {item.answer.map((paragraph, index) => (
          <p key={index} className="text-[13px] leading-relaxed text-muted-foreground">
            {paragraph}
          </p>
        ))}
        {item.action ? (
          <div className="mt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onAction(item.action as HelpAction)}
            >
              {item.action.label ?? DEFAULT_ACTION_LABEL}
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
    </details>
  );
}
```

说明：`pl-[2.375rem]` = 左内边距 0.875rem（px-3.5）+ 图标 0.875rem + 间距 0.5rem +0.125rem 微调，让回答与问题文字左对齐而不是与箭头对齐。回答段落用 `text-muted-foreground`，与 SettingRow 的 hint 同色，问题用 foreground 色，层级和其他分区一致。

- [ ] **Step 2: 只做类型检查（此时还没接线，组件未被引用也应能过）**

Run: `cd apps/studio && bun run typecheck`
Expected: 通过（0 errors）。若报 `Cannot find module '@/src/stores/surfaceOverlay'`，检查路径拼写——文件确实在 `apps/studio/src/stores/surfaceOverlay.ts`。

- [ ] **Step 3: 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/studio/src/canvas/components/settings/HelpSection.tsx
git commit -m "feat(studio): HelpSection 组件——组卡 + 原生 details 折叠问答 + 去看看动作

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01B6qTBX2cfR6mAqjjVFpPiE"
```

---

### Task 3: 接线——section token、页头标题、内容分支

**Files:**
- Modify: `apps/studio/src/canvas/components/SettingsDialog/settingsHelpers.ts`（`SettingsSection` 联合约第 18–70 行；`useSectionHeaders` 约第 767–826 行）
- Modify: `apps/studio/src/canvas/components/SettingsDialog/SettingsDialog.tsx`（import 区约第 39–78 行；内容区 `activeSection === 'about'` 分支约第 2655 行）

**Interfaces:**
- Consumes（Task 2）：`HelpSection`。
- Produces：`SettingsSection` 含 `'help'`；Task 4 的导航项 `id: 'help'` 依赖它。

- [ ] **Step 1: `SettingsSection` 加 token**

在 `settingsHelpers.ts` 的 `SettingsSection` 联合里，`| 'about';` 这一行**之前**插入：

```ts
  // 使用帮助（2026-09-04）：5 组 17 条可展开问答 + 「去看看」跳转。内容在
  // src/chat/lib/helpContent.ts，组件 settings/HelpSection.tsx。设计文档
  // docs/superpowers/specs/2026-09-04-help-section-design.md。
  | 'help'
```

- [ ] **Step 2: 跑 typecheck，确认它替你指出所有需要补的 Record**

Run: `cd apps/studio && bun run typecheck`
Expected: FAIL，至少一处报 `Property 'help' is missing in type … Record<SettingsSection, …>`，位置在 `settingsHelpers.ts` 的 `useSectionHeaders`。（这就是穷举联合的价值：漏一处编译就红。）若还有别处报错，也一并按同样方式补一行。

- [ ] **Step 3: `useSectionHeaders` 加一行**

在 `settingsHelpers.ts` 的 `useSectionHeaders` 返回对象里，`about: {` 那一段**之前**插入：

```ts
    help: {
      title: tt('settingsV2.help', '使用帮助'),
      subtitle: tt('settingsV2.helpHint', '常见操作怎么做，点开就能看'),
    },
```

- [ ] **Step 4: SettingsDialog 引入组件并加内容分支**

在 `SettingsDialog.tsx` 的 import 区、`import { SkillsSection } from '../settings/SkillsSection';` 之后加一行：

```ts
import { HelpSection } from '../settings/HelpSection';
```

在内容区找到 `{activeSection === 'about' ? (` 这一行，在它**之前**插入：

```tsx
          {activeSection === 'help' ? (
            /* 使用帮助（2026-09-04）：内容与渲染都在别处（helpContent.ts / HelpSection.tsx），
               这里只做接线。setActiveSection 在 embedded 模式下经 onSectionChange 回报
               给 V2 壳；onClose 给「跳侧栏面」用（先关设置再开面）。 */
            <HelpSection onSelectSection={setActiveSection} onClose={onClose} />
          ) : null}
```

`setActiveSection` 与 `onClose` 在本组件里都已存在（前者约第 250 行的 `useCallback`，后者是 props 解构）。

- [ ] **Step 5: 跑 typecheck 确认通过**

Run: `cd apps/studio && bun run typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/studio/src/canvas/components/SettingsDialog/settingsHelpers.ts apps/studio/src/canvas/components/SettingsDialog/SettingsDialog.tsx
git commit -m "feat(studio): 设置页接入 help 分区——token、页头标题、内容分支

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01B6qTBX2cfR6mAqjjVFpPiE"
```

---

### Task 4: V2 导航项（含自动关键词）

**Files:**
- Modify: `apps/studio/src/canvas/components/settings/SettingsDialogV2.tsx`（lucide import 块约第 62–89 行；`NAV_GROUPS` 「关于」组约第 333–353 行）

**Interfaces:**
- Consumes（Task 1）：`HELP_GROUPS`、`buildHelpKeywords`；（Task 3）：`'help'` token。

- [ ] **Step 1: 加 import**

lucide import 列表里按字母序加 `CircleHelp`（放在 `Blocks,` 之后、`CircleUserRound,` 之前）：

```ts
  Blocks,
  CircleHelp,
  CircleUserRound,
```

在 `import { Button } from '@/src/components/ui/button';` 之前加：

```ts
import { HELP_GROUPS, buildHelpKeywords } from '@/src/chat/lib/helpContent';
```

- [ ] **Step 2: 「关于」组首位加导航项**

把 `NAV_GROUPS` 里「关于」组的 `items: [` 改成：

```ts
    items: [
      {
        // 使用帮助（2026-09-04）放在关于组首位：用户找「怎么用」时会先往
        // 「关于 / 帮助」这类词上看，比放进任何功能组都好找。关键词从内容
        // 自动生成（每条问题标题 + 别名），不手写第二份词表——内容改了搜索
        // 自动跟上。
        id: 'help',
        labelKey: 'settingsV2.help',
        fallback: '使用帮助',
        icon: CircleHelp,
        keywords: buildHelpKeywords(HELP_GROUPS),
      },
      {
        id: 'about',
```

（其余 `about`、`logAnalysis` 两项原样保留。）

- [ ] **Step 3: typecheck + 全量测试**

Run: `cd apps/studio && bun run typecheck && bun test`
Expected: typecheck 通过；bun test 全绿（此前基线全绿，见 memory `repo-bun-test-preexisting-failures`）。

- [ ] **Step 4: 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/studio/src/canvas/components/settings/SettingsDialogV2.tsx
git commit -m "feat(studio): 设置侧栏「关于」组首位加「使用帮助」，搜索词由内容自动生成

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01B6qTBX2cfR6mAqjjVFpPiE"
```

---

### Task 5: 真机走查（CDP）

**Files:**
- Create（scratchpad，不入库）: `<scratchpad>/cdp.ts`
- 截图输出到 `<scratchpad>/help-*.png`

`<scratchpad>` = `/private/tmp/claude-501/-Users-kika-Desktop-project-Electron-claude-desktop/8718c9f4-a0ca-4c0a-9f4e-34c73eb917b7/scratchpad`。该目录下已经有一份 `cdp.ts`（上一会话的模板，提供 `eval` / `shot` / `type` / `enter` 四个子命令）；本任务需要再加一个 `click x y` 子命令。

前置：应用以 `bun run dev` 跑着（dev 下 9222 端口开 CDP）。注意本机代理会拦本地请求，**所有 bun 命令前缀 `NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost`**（memory `drive-app-via-cdp`）。

- [ ] **Step 1: 给 cdp.ts 加 click 子命令**

在 `<scratchpad>/cdp.ts` 里 `else if (cmd === 'enter') {` 之前插入：

```ts
else if (cmd === 'click') {
  const [x, y] = rest.map(Number)
  const base = { x, y, button: 'left' as const, clickCount: 1 }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}
```

并把最后一行 `ws.close()` 保留在所有分支之后。

以下用 `CDP="NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost bun <scratchpad>/cdp.ts"` 代指驱动命令。

- [ ] **Step 2: 打开设置页**

设置在账户菜单里（AppRail 的 DropdownMenu，`aria-label="账户菜单"` 的按钮 → 菜单项文本「设置」）。Radix 菜单要真实指针事件，所以用坐标点击：

```bash
# 1) 账户菜单按钮中心坐标
$CDP eval "(() => { const r = document.querySelector('[aria-label=\"账户菜单\"]').getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2] })()"
$CDP click <x> <y>
# 2) 菜单项「设置」坐标（菜单已弹出）
$CDP eval "(() => { const el = [...document.querySelectorAll('[role=menuitem]')].find(e => e.textContent.trim() === '设置'); const r = el.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2] })()"
$CDP click <x> <y>
# 3) 确认设置页开了、侧栏有「使用帮助」
$CDP eval "!!document.querySelector('input[placeholder=\"搜索设置\"]')"
$CDP eval "[...document.querySelectorAll('button')].some(b => b.textContent.includes('使用帮助'))"
```

Expected: 最后两条都是 `true`。

- [ ] **Step 3: 进入帮助分区并截图**

```bash
$CDP eval "(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('使用帮助')); b.click(); return true })()"
$CDP eval "document.querySelectorAll('details[data-slot=help-item]').length"
$CDP shot <scratchpad>/help-01-overview.png
```

Expected: 数量为 `17`。用 Read 打开截图，确认：页头标题「使用帮助」+ 副标题；5 张组卡；每条一行问题带右箭头；导航里「使用帮助」在「关于与更新」上方且高亮。

- [ ] **Step 4: 搜索命中**

```bash
$CDP eval "(() => { const i = document.querySelector('input[placeholder=\"搜索设置\"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(i, '权限'); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()"
$CDP eval "[...document.querySelectorAll('button')].some(b => b.textContent.includes('使用帮助'))"
$CDP eval "(() => { const i = document.querySelector('input[placeholder=\"搜索设置\"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(i, '重试'); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()"
$CDP eval "[...document.querySelectorAll('button')].some(b => b.textContent.includes('使用帮助'))"
$CDP eval "(() => { const i = document.querySelector('input[placeholder=\"搜索设置\"]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()"
```

Expected: 两次查询都返回 `true`（「使用帮助」仍在侧栏结果里）。

- [ ] **Step 5: 展开一条 + 跳设置分区**

```bash
$CDP eval "(() => { const d = [...document.querySelectorAll('details[data-slot=help-item]')].find(d => d.textContent.includes('怎么关掉不想要的技能')); d.open = true; return d.open })()"
$CDP shot <scratchpad>/help-02-expanded.png
$CDP eval "(() => { const d = [...document.querySelectorAll('details[data-slot=help-item]')].find(d => d.textContent.includes('怎么关掉不想要的技能')); d.querySelector('button').click(); return true })()"
$CDP eval "document.querySelector('h1, [data-slot=settings-title]')?.textContent || document.body.innerText.slice(0, 200)"
$CDP shot <scratchpad>/help-03-jump-skills.png
```

Expected: 截图 02 里回答展开、左对齐、末尾有「去看技能列表 ›」按钮；截图 03 显示已切到「技能」分区（页头是技能页标题，侧栏「技能」高亮）。

- [ ] **Step 6: 跳侧栏面（知识库）**

先回到帮助分区（重复 Step 3 第一条），然后：

```bash
$CDP eval "(() => { const d = [...document.querySelectorAll('details[data-slot=help-item]')].find(d => d.textContent.includes('怎么把资料放进知识库')); d.open = true; d.querySelector('button').click(); return true })()"
$CDP eval "location.search"
$CDP eval "!document.querySelector('input[placeholder=\"搜索设置\"]')"
$CDP shot <scratchpad>/help-04-kb-surface.png
```

Expected: `location.search` 含 `kb=1`；设置页搜索框已不存在（设置关闭）；截图里知识库面打开、rail 上「知识库」高亮。

- [ ] **Step 7: 反馈弹窗**

再开设置（Step 2）→ 进帮助（Step 3 第一条）→

```bash
$CDP eval "(() => { const d = [...document.querySelectorAll('details[data-slot=help-item]')].find(d => d.textContent.includes('遇到问题怎么反馈')); d.open = true; d.querySelector('button').click(); return true })()"
$CDP eval "!!document.querySelector('[role=dialog]')"
$CDP shot <scratchpad>/help-05-feedback.png
```

Expected: `true`，截图里反馈弹窗盖在设置页之上。按 Esc 关掉弹窗：

```bash
$CDP eval "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) && true"
```

- [ ] **Step 8: 深色模式**

```bash
$CDP eval "(() => { document.documentElement.classList.add('dark'); document.documentElement.setAttribute('data-theme', 'dark'); return true })()"
$CDP shot <scratchpad>/help-06-dark.png
$CDP eval "(() => { document.documentElement.classList.remove('dark'); document.documentElement.removeAttribute('data-theme'); return true })()"
```

Expected: 深色下折叠块边框、问题文字、回答文字、按钮都可读，没有白底块。
（这只是临时切类做视觉检查；真正的主题切换走外观页，两标记会由 applier 同步。）

- [ ] **Step 9: 记录结果**

把 6 张截图的结论写进最终汇报；若有任一步不符合 Expected，回到对应 Task 修，修完重跑该步。不提交任何 scratchpad 文件。

---

### Task 6: 收尾——更新 SettingsDialogV2 头注释与 memory

**Files:**
- Modify: `apps/studio/src/canvas/components/settings/SettingsDialogV2.tsx`（文件头注释里「剩余待迁 section 清单」附近）
- Modify: `/Users/kika/.claude/projects/-Users-kika-Desktop-project-Electron-claude-desktop/memory/settings-redesign-progress.md`

- [ ] **Step 1: 头注释补一句**

在 `SettingsDialogV2.tsx` 文件头注释里，找到描述信息架构 / 分区清单的段落末尾，追加：

```
   2026-09-04 新增「使用帮助」分区（关于组首位，token 'help'）：内容在
   src/chat/lib/helpContent.ts，组件 settings/HelpSection.tsx，天生 chat 栈、
   不在待迁清单里。
```

- [ ] **Step 2: memory 追加进度**

在 `settings-redesign-progress.md` 末尾追加：

```
**2026-09-04 使用帮助分区**：设置「关于」组首位新增 `help` token（5 组 17 条问答 +
「去看看」跳转），内容 `src/chat/lib/helpContent.ts`（进 bun test），组件
`settings/HelpSection.tsx`。核实时的关键纠偏：权限出厂默认是「全自动」
（bypassPermissions），用户开箱看不到逐条权限卡。设计文档
`docs/superpowers/specs/2026-09-04-help-section-design.md`。
```

并把文件头 frontmatter 的 `description` 末尾补上「；09-04 加了使用帮助分区」。

- [ ] **Step 3: typecheck 最后一遍并提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/studio && bun run typecheck
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/studio/src/canvas/components/settings/SettingsDialogV2.tsx
git commit -m "docs(studio): SettingsDialogV2 头注释登记使用帮助分区

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01B6qTBX2cfR6mAqjjVFpPiE"
```

（memory 文件在仓库外，不入 git。）
