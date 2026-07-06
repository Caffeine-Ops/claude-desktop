# 写方案编辑体验重构：块渲染 + 选区即改 设计

日期：2026-07-01
分支：Install-Plan（延续）
状态：设计已确认，待写实现计划

## 背景与问题

「写方案」的编辑态 `ProposalPaper.tsx` 目前是「**整节一个纯 `<textarea>`**」：点某节铅笔 → 整章 markdown 源码塞进一个 `resize-none` 的框，用户直接改 markdown 源码。AI 修订（重写/展开/精简/据来源修正）挤在右侧悬停窄工具条里，且作用域是**整章**。

用户诊断的两个核心痛点（其余两项——「面对 markdown 源码」「缺格式工具栏」——**未被选中**，故本设计不追求全功能富文本 WYSIWYG）：

1. **改动粒度太粗**：改一个词也要把整章切成一个大源码框，失去排版视图。
2. **AI 改写入口不好用**：想要「选中一段文字 → 让 AI 就地改这段」（ChatGPT Canvas / Claude Artifacts 式），而非整章重写。

## 目标

- 手改降到**段落（块）级**：双击某一块就地改那一块，而非整章。
- AI 改写升级为**选区驱动、块级作用域**：选中一段文字 → 浮出气泡，快捷动作 + 自由指令，只改选区所在的那一/几块。
- **不动数据模型、不换编辑器内核**：每节仍是一条 `markdown` 字符串，导出/持久化/校验/哨兵管线一律不变。

## 非目标

- 不做真富文本 WYSIWYG（不引 TipTap/ProseMirror/Lexical 内核）。
- 不做块拖拽排序（沿用现有上移/下移按钮）。
- 不改导出（docx/pdf/md）、不改草稿盘存字段、不改哨兵抽取/层级编号（TOC_REF/HEADING_REF）/引用校验管线。
- 不动预览态 `ProposalPreview`（真 docx 渲染），它保持只读。

## 关键取舍（已与用户确认）

- **AI 替换单位 = 选区所在的那一/几个块**，不是整章、也不是精确到字符的选区。选中的文字作为**焦点提示**传给 AI（「重点改这句」），AI 产出替换的是**整块**。理由：避开「选区纯文本 ↔ markdown 子串」这个最脆的映射（来源标记/编号/内联格式会让纯文本与源码错位），块级替换鲁棒性最高。
- **保留「编辑整节源码」逃生舱**：改坏的表格、批量替换等场景仍可整节改源码，挂在节级工具条，默认不再是主路径。
- 分块**只活在编辑态内存**；`updateSection` 仍写回整节 `markdown`（`blocks.join`），零 schema 变更、零新持久化字段。

## 架构

改动集中在四处，互相边界清晰：

1. **新模块：markdown 分块器**（`shared/` 纯函数，可 bun test）
2. **`ProposalPaper.tsx`**：整节 textarea → 逐块渲染 + 块级手改 + 选区浮层
3. **store `pendingRevision`**：`{sectionId}` → `{sectionId, blockRange?}`
4. **块级 AI 修订分流**：`sendProposalSectionRevision.ts` + `FusionRuntimeProvider` 的 end 路由

### 1. markdown 分块器（新模块）

放在 shared（渲染态和潜在的测试都要用，且不依赖浏览器 API）。建议 `apps/desktop/src/shared/proposalBlocks.ts`。

```ts
// 把一节 markdown 切成有序块。块 = 顶层结构单元：标题行、段落、列表、表格、
// 围栏代码、图片行、mermaid 围栏。空行是段落边界，但在围栏代码/表格/松散列表
// 内部不是——分块器必须吃住这些结构，否则块索引会与渲染 DOM 错位。
export function splitBlocks(markdown: string): string[]
// 无损还原：join(split(md)) 规范化后等于 md。块之间用 '\n\n' 连接。
export function joinBlocks(blocks: string[]): string
```

**不变式（bun test 守）**：`joinBlocks(splitBlocks(md))` 经统一换行/去尾空白规范化后 `=== md`，对以下语料成立：纯段落、含 `#`~`######` 标题、有序/无序/松散列表、GFM 表格、` ``` ` 围栏代码（含内部空行）、图片 `![](kbasset://…)` 行、` ```mermaid ` 围栏、含来源标记「（据《X》）」与层级编号引用（`TOC_REF`/`HEADING_REF`）的正文。

**分块边界规则**（实现要点，写进注释）：
- 围栏代码/mermaid：从 ` ``` ` 起到配对 ` ``` ` 止，整体一块，内部空行不切。
- 表格：连续的 `|…|` 行（含分隔行 `|---|`）整体一块。
- 标题行（`^#{1,6}\s`）：单独一块。
- 其余：空行分隔的段落各自一块；连续列表项归一块（列表内的松散空行不切）。

### 2. `ProposalPaper.tsx`：逐块渲染 + 块级手改 + 选区浮层

**逐块渲染**：`renderSection` 内部由「一个 `<AssistantMarkdown text={sec.markdown}>`」改为「`splitBlocks(sec.markdown).map((blk, bi) => <BlockView …>)`」。每个 `BlockView` 容器带 `data-section-id` + `data-block-index={bi}`，各自 `<AssistantMarkdown text={blk} highlightCitations>`。逐块独立渲染是「DOM 块索引 ⇔ markdown 块索引对齐」的地基。

- 节级悬停工具条（AI 重写整章/上移/下移/删除/编辑整节源码）**保留**，语义不变。「编辑」铅笔改标签为「编辑整节源码」逃生舱。
- 生成中（`generating` 为真、或该节处于 `pendingRevision`）禁用块级手改与选区浮层，复用现有闸。

**块级手改**：
- 双击某 `BlockView`（或点块级小铅笔）→ 该块进入就地编辑：块容器替换为一个 `<textarea value={blk}>`，`autoFocus`。
- 提交（失焦 / ⌘↵ / Esc 取消）→ 用新块文本替换 `blocks[bi]` → `joinBlocks` → `updateSection(sec.id, joined)`。
- 同一时刻至多一个块在编辑（`editingBlock: {sectionId, blockIndex} | null`）。

**选区浮层（选区即改）**：
- 监听编辑纸面内的 `selectionchange`/`mouseup`。选区非空且落在某节文本内 → 计算选区覆盖的块区间 `[startBlock, endBlock]`（从 `Range` 端点向上找最近 `data-block-index`），在选区尾部锚一个浮层气泡。
- 气泡内容：快捷动作 `润色 / 精简 / 扩写 / 改写 / 据来源修正` + 一个「告诉 AI 怎么改这段…」输入框（回车或按钮提交自由指令）。
- 触发任一动作 → 调 `reviseProposalSectionBlocks(sectionId, blockRange, mode|instruction, selectedText)`（见下）。发起后气泡关闭、清选区。
- 封面/目录节：AI 动作退化为现有封面/目录整节修订语义（无块级重写），手改照常。

### 3. store：`pendingRevision` 扩展

`pendingRevision: { sectionId: string; blockRange?: { start: number; end: number }; selectedText?: string } | null`

- `blockRange` 缺省 = 整节替换（现有行为，向后兼容 rewrite/expand/shorten/resume/fixSource 整章路径）。
- `blockRange` 存在 = 块区间替换：轮末 end 把 AI 产出**拼接进 `[start, end]` 那几块**、其余块原样保留 → `joinBlocks` → `reviseSection`（重置该节 `verification` 触发重校验、更新 `baselineMarkdown`、清 `truncated`，沿用现有语义）。

### 4. 块级 AI 修订分流

- **`sendProposalSectionRevision.ts`**：新增 `reviseProposalSectionBlocks(sectionId, blockRange, action, selectedText)`。取该节 markdown，`splitBlocks` 后取 `[start,end]` 块拼成上下文，构造提示词：给 AI 「本段原文（这几块）」+「用户选中重点：<selectedText>」+「操作：润色/精简/扩写/改写/据来源修正 或 自由指令」，要求**只重写这几块、用正文哨兵包裹、不加章节序号（沿用现有提示词规则）**。置 `pendingRevision = {sectionId, blockRange, selectedText}` 后发消息。
- **`FusionRuntimeProvider` 的 end 路由**：现有分流点检测 `pendingRevision`。扩展为：`blockRange` 存在时走块拼接（把 AI 产出的哨兵块作为 `[start,end]` 的替换，其余块保留、`joinBlocks`）；否则走现有整节替换。二者都落 `reviseSection`。

## 数据流

**手改**：双击块 → 块 textarea → 提交 → `blocks[bi]=新` → `joinBlocks` → `updateSection` → store `sections` 更新 → 800ms 防抖写盘（不变）。

**选区 AI 改**：选中文字 → 浮层 → 选动作 → `reviseProposalSectionBlocks` 置 `pendingRevision{blockRange}` + 发消息 → AI 产出哨兵块 → end 路由检测 `blockRange` → 拼接进那几块 → `reviseSection`（重置 verification）→ 异步重校验回填。

**导出/预览/持久化**：全程消费整节 `sec.markdown`，无感知块模型，一律不变。

## 错误处理与边界

- **分块器与渲染错位**：靠逐块独立渲染从结构上消除（DOM 块与 markdown 块一一对应）；围栏代码/表格/松散列表边界靠分块器专门吃住 + 往返单测兜底。
- **跨块选区**：吸附成覆盖到的连续块区间整体替换；退化到单块时 `start===end`。
- **选区落在图片/mermaid 块**：这些块作原子块，AI 上下文含其源码，手改显示源码。
- **AI 产出块数与原块区间不等**：允许——替换 `[start,end]` 为 AI 的全部产出块（可多可少），其余块保留，`joinBlocks` 重拼。层级编号不在块内手写（由导出器生成），故块增减不破编号。
- **生成中并发**：该节 `generating` 或 `pendingRevision` 未清时，禁手改与选区浮层，避免与在飞那轮叠加。
- **逃生舱一致性**：整节源码编辑与块编辑互斥（进整节源码时关掉任何块编辑态）。

## 测试

- **bun test**：`splitBlocks`/`joinBlocks` 往返不变式（覆盖上列全部语料）；块区间 splice（给定 `[start,end]` + 替换块，`joinBlocks` 结果正确、其余块不动）。
- **GUI 走查**：与 Install-Plan 上待走查的图表增强一并过——双击手改、选区浮层五个动作 + 自由指令、跨块选区、封面/目录退化、生成中禁用、整节源码逃生舱、改后重校验红/绿条刷新。
- `bun run typecheck` 作为唯一自动化门（新增 IPC/类型时四处同步）。

## 影响文件（预估）

- 新增：`apps/desktop/src/shared/proposalBlocks.ts`（+ `proposalBlocks.test.ts`）
- 改：`apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx`（逐块渲染 + 块手改 + 选区浮层，可能拆出 `BlockView.tsx` / `SelectionAiBubble.tsx` 控体积）
- 改：`apps/desktop/src/renderer/src/stores/proposal.ts`（`pendingRevision` 扩展）
- 改：`apps/desktop/src/renderer/src/lib/sendProposalSectionRevision.ts`（块级修订函数 + 提示词）
- 改：`apps/desktop/src/renderer/src/components/providers/FusionRuntimeProvider.tsx`（end 路由块拼接分流）
- 可能改：`proposalIcons.tsx`（浮层图标）

## 开放项（实现时定，不阻塞）

- 选区浮层的定位/避让（贴近选区尾、纸面边缘翻转）。
- 块级小铅笔 vs 纯双击：先做双击，块 hover 时可加一个小铅笔提示可点。
- 自由指令与快捷动作的提示词模板措辞，复用现有 `reviseProposalSection` 的产品化语气（不外漏 trigram/索引等工程词）。
