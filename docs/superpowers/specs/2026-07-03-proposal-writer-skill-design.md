# 「写方案」skill 化设计：`skills/proposal-writer` + 斜杠入口

日期：2026-07-03
状态：待用户评审
分支：Install-Plan

## 1. 背景与目标

「写方案」的方法论提示词目前是 `apps/desktop/src/main/core/proposalPrompt.ts` 里
`buildProposalAppend()` 中的编译期中文字符串大数组（十几段 200~600 字长段落），
维护体验差：无高亮、需转义、diff 糊成一行。

目标（用户确认的方向）：

1. 像 `skills/ppt-master` 一样，在仓库根 `skills/proposal-writer/` 落一个标准
   skill 目录，方法论文本以 markdown 形态维护。
2. 在对话输入框以 `/` 方式调用（出现在斜杠菜单「技能」分组、有专属 chip 图标），
   调用后进入完整的方案写作体验（右侧文档面板、阶段硬门、检索、导图、导出全部在位）。
3. 行为零回归：注入到模型的提示词内容与现版**逐字节一致**（首版硬目标）。

## 2. 非目标

- 不做「真 skill 化」（即靠模型自愿触发 skill 加载方法论）。阶段硬门的纪律依赖
  systemPrompt 无条件烘焙——历史上每道硬门都是被模型跳过后才补的，改成概率行为
  等于把修好的坑重新挖开。
- 不把哨兵解析、阶段门、BM25 检索、docx/pdf 导出等应用侧能力搬进 skill 目录。
  这些是代码与 UI 交互，skill 只能承载「给模型看的文本」。
- 不动 `shared/proposal.ts` 的任何协议常量与解析逻辑。
- renderer 侧散落的提示词（`sendProposalSectionRevision`、`buildGenImagePrompt` 等）
  留待二期用同一套模板机制迁移，本期不动。

## 3. 现状要点（设计依据）

- `skills/` 目录已作为 local plugin 挂进每个 fusion-code 会话
  （`engine.ts` `plugins: [{type:'local', path: skillsPluginDir}]`），skill 名会经
  `system init` 回传到 `sessionMeta.slashCommands`，斜杠菜单自动列出——ppt-master
  的整条链路现成。
- 斜杠提交拦截：`FusionRuntimeProvider.onNew` 里已有
  `matchSlashCommand(baseText)` 客户端拦截机制（现处理 `/skill`、`/mcp`，命中即
  开本地对话框、不发给模型）。
- chip 外观：`composer/skillChipRegistry.ts` 纯声明表，ppt-master / gpt-image-2
  各注册了 namespaced + 裸名两条。
- 方案模式现有入口：侧栏场景卡 `ScenarioQuickStart.onStartProposal` —— 有草稿则
  `reopen(activeSessionId)`（绝不丢稿），否则 `start(activeSessionId)` + 预填引导
  模板 `t('scenarioProposalPrompt')` + 聚焦编辑器。产品不弹选择器，由用户在对话里
  说、发送时 `matchProducts` 识别。
- 提示词注入：`openSession` 在 `proposalActive` 时把
  `中文基础指令 + buildProposalAppend(mirrorDir, products)` 作为
  `systemPrompt: {type:'preset', preset:'claude_code', append}` 烘焙进子进程；
  非方案 spawn 的会话中途进入方案模式时，engine 在 `send()` 里做轮内 grounding
  注入补偿。本设计不改这两条路径，只改 append 字符串的**生产方式**。
- 提示词文本二分：约 2/3 是纯写作方法论（改了不动代码）；约 1/3 是协议契约镜像
  （哨兵字样、确认卡 header、`⚠️ 资料缺失：`前缀、genimage 块格式），与
  `shared/proposal.ts` / stage-gate 解析代码必须逐字节一致。

## 4. 总体架构

三件套，各司其职：

```
skills/proposal-writer/            ① skill 目录 = 斜杠入口 + 方法论唯一事实源
├── SKILL.md                       #   入口说明（frontmatter name/description +
│                                  #   「本 skill 由桌面应用接管」+ 纯 CLI 降级指引）
└── references/
    └── append-template.md         #   方法论正文模板（含 {{占位符}}），
                                   #   与现版 buildProposalAppend 输出逐字节对应

apps/desktop/src/main/core/
└── proposalPrompt.ts              ② 改为「模板渲染器」：?raw 内联模板，
                                   #   从 shared/proposal.ts 常量渲染占位符，
                                   #   动态拼 KB 文件清单。函数签名不变。

apps/desktop/src/renderer/src/
├── composer/skillChipRegistry.ts  ③a chip 注册 +2 条（namespaced + 裸名）
└── runtime/FusionRuntimeProvider  ③b onNew 斜杠拦截 +1 分支 → 激活方案模式
```

关键取舍：**斜杠提交被 renderer 拦截、不发给 CLI**。CLI 因此永远不会展开这个
skill——方法论只经 systemPrompt.append 一条通道注入，避免双份注入的 token 浪费
与口径漂移。skill 目录的 SKILL.md 承担三个次要职责：斜杠菜单的可见面、纯 CLI
终端里被直接展开时的降级文档、以及给维护者的导读。

## 5. 组件设计

### 5.1 `skills/proposal-writer/`

**SKILL.md**（短，~30 行）：

- frontmatter：`name: proposal-writer`，`description` 明确写「请通过 Claude Desktop
  的『写方案』入口或 `/proposal-writer` 使用；直接展开本 skill 只能获得写作方法论，
  没有文档面板 / 阶段门 / 知识库检索联动」。
- 正文：功能一句话定位 + 指引读 `references/append-template.md` + 维护须知
  （改方法论只改 markdown；协议字样是占位符、事实源在 `shared/proposal.ts`）。

**references/append-template.md**：现版 `buildProposalAppend` 返回数组的全部静态
块，按原顺序原文迁入，仅做两类替换：

1. 协议常量 → 占位符（表见 5.2）；
2. 动态 scope 块（知识库路径 + 产品文件清单）→ 单一占位符 `{{KB_SCOPE}}`。

**硬约束：不添加任何额外标题、注释或装饰**——渲染结果必须与现版输出逐字节一致
（快照测试把关，见 §8）。原 TS 里解释「为什么这样写」的行内注释迁为模板同目录
的 `NOTES.md`（不参与渲染），注释资产不丢。

### 5.2 占位符协议

模板里出现的每个协议字样都用 `{{NAME}}` 占位，渲染值一律取自
`shared/proposal.ts` 现有导出（单一事实源，杜绝 markdown 与解析器漂移）：

| 占位符 | 渲染源 |
|---|---|
| `{{COVER_BEGIN}}` / `{{COVER_END}}` | `PROPOSAL_DRAFT_BEGIN.cover` / `PROPOSAL_DRAFT_END.cover` |
| `{{TOC_BEGIN}}` / `{{TOC_END}}` | 同上 `.toc` |
| `{{CONTENT_BEGIN}}` / `{{CONTENT_END}}` | 同上 `.content` |
| `{{GAP_PREFIX}}` | `PROPOSAL_GAP_PREFIX` |
| `{{COVER_CONFIRM_HEADER}}` | `PROPOSAL_COVER_CONFIRM_HEADER` |
| `{{TOC_CONFIRM_HEADER}}` | `PROPOSAL_TOC_CONFIRM_HEADER` |
| `{{KB_SCOPE}}` | 运行期：`renderScopeBlock(mirrorDir, products)`（现 `scope` 变量 + `renderProductBlock` 逻辑，原样保留在 TS） |

渲染器 `renderPromptTemplate(template, values)`（~40 行，放
`proposalPrompt.ts` 内部）：纯字符串替换；遇到 values 里没有的 `{{...}}` 抛错
（fail fast，防拼错字的占位符静默漏进 prompt）。

### 5.3 `proposalPrompt.ts` 改造

- 模板载入方式（**2026-07-03 计划期修订**，原设计为 Vite `?raw` 编译期内联）：
  **运行期从 skills 目录读文件**。修订原因：`?raw` 是 Vite 专属语法，`bun test`
  解析不了 `.md?raw` 导入，会弄挂现有 `proposalPrompt.test.ts` 与本设计新增的
  快照/契约测试——而 typecheck 之外 bun test 是仅有的自动化防线，不可牺牲。
  运行期读取的可行性已核实：`skills/` 整树经 `tools/pack/src/resources.ts` 的
  `BUNDLED_RESOURCE_TREES` 打进包内 `resources/prebundled/skills`，dev / bun test
  下经 cwd 候选回落仓库根 `skills/`，解析器 `resolveBundledSkillsPluginDir()` 现成
  （engine 挂 plugin 用的就是它）。额外收益：dev 下改模板对下一个 spawn 的会话
  即时生效，无需重启。代价：`resolveBundledSkillsPluginDir` 现居 `cliDetect.ts`
  （import electron，bun test 加载不了），需先抽到 electron 无关的
  `src/main/core/skillsDir.ts`。
- `buildProposalAppend(mirrorDir, products)` **签名与调用方不变**（engine 零改动），
  内部改为：渲染 `{{KB_SCOPE}}` → 全模板占位符替换 → 返回。
- `ProposalProductScope`、`MAX_FILES_PER_PRODUCT`、`MAX_IMAGES_PER_FILE`、
  `renderProductBlock` 原样保留。

### 5.4 renderer 斜杠入口

**chip 注册**（`skillChipRegistry.ts`）：照 ppt-master 模式加两条——
`/claude-desktop:proposal-writer` 与 `/proposal-writer`，`label: '写方案'`，
`appearance: 'gradient'`，icon 复用现有 Icons8 文档类图标键（实现时从
`fileIconPathsByKey` 挑最贴近 Word/文档的键）。

**提交拦截**（`FusionRuntimeProvider.onNew`）：在现有
`matchSlashCommand` 分支旁加一条方案专用匹配（不塞进 DialogKind——它开的不是
对话框）。命中 `proposal-writer` / `claude-desktop:proposal-writer` 时：

- **无尾随文字**（`/proposal-writer` 直接回车）：行为与侧栏场景卡完全一致——
  有草稿（`active` 或 `sections` 非空）则 `reopen(activeSessionId)`；否则
  `start(activeSessionId)` 并把引导模板 `t('scenarioProposalPrompt')` 预填回
  composer、聚焦编辑器。`return`，不发送。
- **带尾随文字**（`/proposal-writer 给XX客户写YY平台方案`）：先按上面逻辑激活
  模式（reopen/start，不预填模板），然后把**尾随文字作为本轮用户消息继续走
  正常发送路径**——此时 `proposalMode` 已激活，产品识别（`matchProducts`）、
  检索注入等与现有首条方案消息完全同路。
- 与现有拦截同样的守卫：带图片/文件附件时不拦截（视为普通消息）。

激活逻辑与 `ScenarioQuickStart.onStartProposal` 是同一份语义，实现时抽成
`stores/proposal.ts` 上的一个共享 action（或 lib helper），场景卡与斜杠两个
入口共用，避免「再入永不丢草稿」的分支逻辑复制两份后漂移。

## 6. 数据流（斜杠调用一次的完整链路）

1. 用户敲 `/` → 斜杠菜单列出 `写方案`（chip 来自 skillChipRegistry；命令名来自
   `sessionMeta.slashCommands`，由 skills/ plugin 挂载自动产生）。
2. 选中插入 chip，回车提交 → `onNew` 拦截命中 → 激活方案模式（reopen/start）→
   （带尾随文字则）尾随文字作为首条消息发送。
3. `send()` 带 `proposalMode/proposalProducts/proposalRetrieve` → engine 按现有
   逻辑走：spawn 时烘焙 `buildProposalAppend`（现在从模板渲染）或轮内 grounding
   补偿——**这一层完全不变**。
4. 模型输出哨兵块 → renderer 归档到文档面板，阶段硬门照常设防——**完全不变**。

## 7. 错误处理与降级

- **占位符渲染失败**（模板里出现未知 `{{...}}`）：`renderPromptTemplate` 抛错。
  由于模板是编译期内联的常量，这类错误必然在开发期被快照/契约测试拦下，不可能
  只在运行期暴露。
- **纯 CLI 终端里用户手动 `/claude-desktop:proposal-writer`**：CLI 会真的展开
  SKILL.md——文案明确说明桌面联动缺席、指引读 references 里的方法论后按降级
  方式写（无面板/硬门/检索）。可用但降级，符合预期。
- **模型在非方案会话里自己调用该 skill**：同上，只得到文本。description 已写明
  使用方式，暴露面与 ppt-master 相同，可接受。
- **`skills/` 目录在打包产物里缺失或被用户改坏**（随 §5.3 修订同步更新）：
  模板读不到时 `buildProposalAppend` 抛带完整路径的错误、当轮发送失败——宁可
  失败也不让方案会话在没有纪律注入的情况下静默跑（编造风险 > 可用性）。这一
  依赖面与 skills plugin 挂载、ppt-master 的 Python 脚本相同：skills 目录缺失
  时它们同样已经坏了，不是本功能新引入的脆弱点。

## 8. 测试（bun test，沿用现有基建）

1. **快照回归（本期最重要的门）**：固定一组 `(mirrorDir, products)` 输入
   （含 files 为空、超 `MAX_FILES_PER_PRODUCT`、超 `MAX_IMAGES_PER_FILE` 三种
   形态），断言新 `buildProposalAppend` 输出与改造前实现的输出**逐字节相等**。
   实现方式：改造前先把现版输出固化成快照文件。
2. **契约测试**：渲染结果必须包含全部 6 个哨兵字样、两个确认 header、
   `PROPOSAL_GAP_PREFIX`；且不含任何残留 `{{`。
3. **渲染器单测**：未知占位符抛错、重复占位符全部替换。
4. **slash 匹配单测**：`/proposal-writer`、`/claude-desktop:proposal-writer`、
   带尾随文字、大小写、非命中（`/proposal-writerx`）各用例。
5. `bun run typecheck` 通过（含 `?raw` 模块声明）。

手动走查（GUI）：斜杠菜单出现「写方案」chip → 空调用预填模板 → 带文字调用直发
且面板打开 → 草稿存在时斜杠再入不丢稿。

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 模板迁移时手滑改动文本导致 prompt 行为变化 | 逐字节快照测试（§8.1），改造前固化基线 |
| markdown 与协议代码漂移 | 占位符 + 单一事实源在 `shared/proposal.ts`，模板里不存在协议字样明文 |
| 双入口（场景卡/斜杠）激活逻辑分叉 | 抽共享 action，两入口调同一份 |
| `?raw` 在 tsconfig composite 工程下的类型报错 | 补模块声明；typecheck 是 CI 唯一质量门，当场暴露 |
| 尾随文字直发时机早于模式状态就绪 | 激活是同步 store 写入，发送在其后同一 tick；实现时加注释固化顺序 |

## 10. 分期

- **一期（本设计）**：skill 目录 + 模板渲染 + 斜杠入口 + chip + 测试。
  不碰 engine、不碰协议代码、不碰导出/检索/硬门。
- **二期（可选）**：renderer 侧散落提示词（选区即改、genimage 重改）迁入同一
  模板机制；若届时想把方法论按主题拆成多个 references 文件，放开「逐字节一致」
  改为「契约测试 + 人工评审」。
