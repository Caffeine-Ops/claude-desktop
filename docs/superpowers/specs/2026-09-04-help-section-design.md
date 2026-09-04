# 设置页「使用帮助」分区 — 设计文档

日期：2026-09-04　分支：feat/settings-redesign　状态：已拍板，待出实施计划

## 1. 背景与目标

应用目前没有任何面向用户的使用教程：首启的「欢迎向导」只是配置向导（填 API key、
选模型），README 是开发者文档，官网只有落地页，设置 → 关于 只有「问题反馈」。
写作纸面的代码注释里已经写明「悬停提示是替代还没做的新手引导」。

目标：让一个装好应用的普通用户（产品定位见 PRODUCT.md，非技术背景、要大白话）
能在设置页里找到「这个软件怎么用」，并且能从帮助条目一键跳到对应的界面位置。

非目标（明确不做）：
- 首次进入时的弹窗式引导、功能高亮气泡、示例对话回放。
- 截图或动图（设置页正在大改，截图会立刻过时）。
- 多语言译文（沿用 settingsV2 的「中文硬编码 + `tt(key, 中文)` 兜底」约定）。
- 改动侧栏账户菜单里已有的「帮助与反馈」（目前只开反馈弹窗，保持不变）。

## 2. 入口与形态

- 位置：`SettingsDialogV2` 的「关于」组新增导航项 **「使用帮助」**，排在
  「关于与更新」之前。新增 section token：`'help'`。
- 形态：按 5 个主题分成 5 张组卡（`SettingGroup` + `SettingCard`），每张卡里
  一行一个问题，点问题展开 3～5 句大白话回答；能跳的条目在回答末尾放一个
  「去看看」按钮。
- 折叠块用原生 `<details>/<summary>`，沿用执行模式页已有的写法
  （`SettingsDialog.tsx` 第 1965 行附近的 className 模式），不引入新的
  accordion 依赖；裸 `<summary>`/`<button>` 一律带 `data-slot` 逃逸 canvas 的
  裸元素 reset（CLAUDE.md 样式铁律）。
- 搜索：V2 侧栏搜索靠 `NavItem.keywords` 命中。帮助项的 keywords **从内容
  自动生成**（所有问题标题 + 每条自带的 `keywords` 拼成一串），不手写第二份词表。
  搜索命中后只是切到帮助分区，不做「定位到某一条」（YAGNI）。

## 3. 内容大纲（5 组 17 条）

所有说法都对着 2026-09-04 核实过的真实界面写；下面括号里是核实来源，
写文案时必须以它为准，不许凭印象补功能。**关键纠偏：权限模式出厂默认是
「全自动」**（`chat/stores/permissionMode.ts`），用户开箱不会看到逐条权限卡。

### 组 1　开始第一次对话
1. 怎么开始一个新对话？——侧栏顶部「新对话」；Enter 发送、Shift+Enter 换行；
   AI 回复中仍可继续打字，Enter 会排队（`Composer.tsx`、`i18n.ts` placeholder）。
2. 怎么把任务说清楚？——说目标、给材料、说想要的格式；附一句示例。
   （产品原则，非界面事实。）
3. 怎么附上文件或图片？——输入框「+」按钮、把文件拖进窗口、直接粘贴截图；
   输入 `@` 可引用本机文件（`Composer.tsx`、`attachFiles.ts`、`fileMentionAdapter.ts`）。
   → 无跳转。
4. 怎么用技能？——输入 `/` 弹出技能菜单，或点输入框的技能按钮；空白对话页
   也有场景入口（`slashAdapter.ts`、`ScenarioRail.tsx`）。→ 去看看：设置「技能」分区。

### 组 2　智能体动手前会问我吗？
5. 三种模式是什么意思？——默认（关键操作前先问你）/ 计划（只读、先出计划）/
   全自动（全权托付）；出厂是全自动；在输入框工具行的胶囊里切换
   （`PermissionModePicker.tsx`）。→ 无跳转（切换器在聊天页，不在设置里）。
6. 弹出「允许 … 吗？」时怎么回答？——「同意」/「同意，本次会话内不再问」；
   不同意就在下方输入框写理由发送；直接「跳过」等于拒绝；数字键直选、Esc 跳过
   （`PermissionComposerPanel.tsx`）。
7. 什么时候该用「计划」模式？——改动范围大、想先看方案再放手时。

### 组 3　知识库
8. 知识库是干什么的？——「写方案」等技能检索资料的地方（`KnowledgeBaseSection.tsx`）。
   隐私措辞只说「文件留在本机、检索到的片段随提问交给 AI」，不写「不会发到别处」。
9. 怎么把资料放进去？——侧栏「知识库」→ 右上角「扫描目录」图标按钮（仅图标，悬停显示名字）→ 添加文件夹；**是扫描本机
   文件夹，不是上传**（`AllFilesPanel.tsx`）。→ 去看看：打开知识库面。
10. 本地目录和远程服务器有什么区别？——设置 → 知识库 里二选一；远程要填地址后
    点「保存并同步」。→ 去看看：设置「知识库」分区。

### 组 4　插件与技能
11. 插件和技能有什么区别？——插件把 AI 接进你常用的工具，技能是某类任务的
    专家流程（`MarketView.tsx` 副标题）。
12. 怎么安装？——侧栏「插件」（只在智能助手面显示）→ 搜索 → 安装 → 新对话生效
    （`InstallButton.tsx`、`MarketDetailPage.tsx`）。→ 去看看：打开插件面。
13. 怎么关掉不想要的技能？——设置 → 技能 → 每行开关（`SkillsSection.tsx`；`disabledSkills`
    只在 canvas 侧消费，不影响 / 菜单，文案不得声称影响 / 菜单）。
    → 去看看：设置「技能」分区。

### 组 5　常见问题
14. 回复中断了怎么办？——输入框上方会出现「回复中断了 … 重试」，点重试原样重发
    上一条；自己按 Esc 停止的不算中断（`failedTurn.ts`、`TurnFailedBanner`）。
15. 第一次启动一直在下载 / 下载失败？——首启要下载一次 AI 引擎；失败点「重试下载」，
    本机装过 Claude 的可选「使用本机已安装的 Claude 继续」；反复失败检查网络后重启
    （`ComponentGate.tsx`）。
16. 怎么重命名或删除对话？——侧栏会话行右键 → 重命名 / 删除；删除不可撤销
    （`RailSessionList.tsx`）。
17. 遇到问题怎么反馈？——侧栏「问题反馈」或设置 → 关于；可附 4 张截图。
    → 去看看：打开反馈弹窗。


## 4. 代码结构

全部落在设置页已迁 chat 栈的目录，遵守 CLAUDE.md「shadcn 原语 + utility，
禁用 `.settings-*`/`.sv2-*` legacy 类」。

### 4.1 数据：`apps/studio/src/chat/lib/helpContent.ts`

纯数据 + 两个纯函数，放 `src/chat/lib/` 是为了进 `bun test` 范围
（`package.json` 的 test 脚本只扫 `electron/`、`src/chat/lib`、`src/chat/composer`）。

```ts
export type HelpAction =
  | { kind: 'section'; section: 'skills' | 'knowledgeBase'; label?: string }
  | { kind: 'surface'; surface: 'kb' | 'market'; label?: string }
  | { kind: 'feedback'; label?: string };

export interface HelpItem {
  id: string;            // 稳定 id，形如 'chat-new'
  question: string;      // 折叠块标题
  answer: string[];      // 每项一段，渲染成 <p>
  keywords?: string;     // 额外搜索词，空格分隔
  action?: HelpAction;   // 「去看看」
}

export interface HelpGroup { id: string; title: string; items: HelpItem[] }

export const HELP_GROUPS: HelpGroup[];
export function buildHelpKeywords(groups: HelpGroup[]): string;  // 供 NAV_GROUPS 用
```

`section` 的取值刻意收窄成两个字面量而不是整个 `SettingsSection`：
chat/lib 不该 import canvas 的类型（跨面 import 是坑源），且帮助只跳这两处。
`HelpSection.tsx` 里把它赋给 `SettingsSection` 时靠 TS 子类型自动兼容。

### 4.2 组件：`apps/studio/src/canvas/components/settings/HelpSection.tsx`

```ts
interface HelpSectionProps {
  onSelectSection: (section: SettingsSection) => void;  // 切分区
  onClose: () => void;                                  // 关设置（跳面前用）
}
```

- 遍历 `HELP_GROUPS` → `SettingGroup(label=title)` → `SettingCard` → 每条一个
  `<details data-slot="help-item">`，`<summary>` 是问题，内部 `<p>` 是回答，
  末尾按 `action` 渲染 shadcn `Button`（variant outline, size sm，默认文案「去看看」，
  `action.label` 可覆盖）。
- 动作实现：
  - `section` → `onSelectSection(section)`。
  - `surface` → `onClose()` 然后 `openSurfaceOverlay(surface)`
    （`src/stores/surfaceOverlay.ts`，canvas App.tsx 已有跨树 import 先例）。
    先关后开：设置页是盖住 rail 的全屏 overlay，不关的话面开了也看不见。
  - `feedback` → `useDialogStore.getState().openDialog('feedback')`
    （与关于页「问题反馈」行同一调用）。
- 不持有任何业务状态；`<details>` 的开合交给浏览器。

### 4.3 接线（4 处，typecheck 兜底）

1. `SettingsDialog/settingsHelpers.ts`：`SettingsSection` 联合加 `| 'help'`；
   `useSectionHeaders()` 的 Record 加一行（标题「使用帮助」，副标题
   「常见操作怎么做，点开就能看」）。
2. `SettingsDialog/SettingsDialog.tsx`：内容区加分支
   `{activeSection === 'help' ? <HelpSection onSelectSection={setActiveSection} onClose={onClose} /> : null}`
   （embedded 模式下 `setActiveSection` 会经 `onSectionChange` 回报给 V2）。
3. `settings/SettingsDialogV2.tsx`：`NAV_GROUPS` 「关于」组首位加
   `{ id: 'help', labelKey: 'settingsV2.help', fallback: '使用帮助', icon: CircleHelp,
   keywords: buildHelpKeywords(HELP_GROUPS) }`。
4. 无需改 `stores/surfaceOverlay.ts` 的 `SettingsOverlaySection` 子集或
   `EntryView/EntryShell` 的收窄联合——它们只是子集，加 token 不破坏。

## 5. 测试与验收

单元测试 `src/chat/lib/helpContent.test.ts`：
- 所有 `group.id` / `item.id` 全局唯一。
- 每条 `question` 非空、`answer` 至少一段且每段非空。
- `buildHelpKeywords` 输出包含每个 `question`，且不含换行。
- `action.kind === 'section'` 的 `section` 只出现在允许的三个值里（类型已保证，
  测试兜底防止有人把类型放宽）。

真机走查（CDP，见 memory `drive-app-via-cdp`）：
1. 打开设置 → 侧栏「关于」组第一项是「使用帮助」，点开渲染 5 张组卡。
2. 搜索框输「权限」→ 帮助项留在结果里；输「重试」同样命中。
3. 展开「怎么关掉不想要的技能」→ 点「去看看」→ 落到「技能」分区。
4. 展开「怎么把资料放进去」→ 点「去看看」→ 设置关闭、知识库面打开、rail 上
   「知识库」高亮。
5. 展开「遇到问题怎么反馈」→ 点「去看看」→ 反馈弹窗出现。
6. 深色模式下折叠块与按钮可读（`dark:` utility 保底）。
7. `bun run typecheck` 与 `bun test` 全绿。

## 6. 风险与取舍

- **文案会过时**：帮助写的是界面事实，界面一改就错。缓解：所有条目集中在一个
  数据文件、每条注明依据的组件，改功能时顺手改；不做截图正是为了降低过时成本。
- **跨面 import**：`HelpSection` import `src/stores/surfaceOverlay` 与
  `useDialogStore`，与关于页、canvas App 的既有做法一致，不新开先例。
- **多语言界面显示中文**：与 settingsV2 全部 key 的现状相同，项目已接受。
