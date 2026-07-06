# 方案封面/目录整页版式设计

日期：2026-06-26
状态：设计已通过，待 spec 复审

## 背景与问题

「写方案」功能里，封面、目录、正文是 AI 按哨兵分段生成的 markdown
（见 `shared/proposal.ts` 的 `ProposalKind` / `PROPOSAL_DRAFT_BEGIN`）。
导出/预览时 `buildProposalMarkdown(sections, {pageBreaks:true})` 把它们拼成
**一整串** markdown，仅在 kind 边界插一个 `PROPOSAL_PAGEBREAK` 注释标记，
再交给 `proposalDocx.ts` 的 `markdownToDocxBuffer` 生成 Word。

痛点：`markdownToDocxBuffer` 收到的是扁平字符串，**已丢失 kind 信息**，只能靠
「整篇第一个 `#` 当封面大标题（Title 样式居中放大），其余全按正文左上角顺排」
这一条启发式（见 `proposalDocx.ts` 的 `WalkEnv.walk.titleConsumed`）。结果：

- 封面 = 标题居中 + 几行左对齐小字挤在页顶，页面其余大片空白但无版式；
- 目录 = 一个普通有序列表，没有「目录」标题、没有层级排版、没有留白；
- 分页其实已有（封面→目录→正文各起新页），**结构上已「独占一页」，缺的是整页版式**。

用户诉求：封面独占且做成像样的整页封面；目录至少独占一整页、做得好看。

## 目标

- **封面**：居中庄重式——标题与落款（客户单位/编制单位/日期）整体**竖向居中**、
  全部**水平居中**、独占一页、**无页脚页码**。内容（标题/单位/日期文本）仍由 AI 生成，
  本设计只决定它们在整页上的排布。
- **目录**：节首居中「**目录**」大标题（+ 一条分隔线），下方把 AI 的章节大纲按
  list 层级缩进、行距拉开渲染；**无页码**；至少独占一整页；预览与导出逐像素一致。
- **落点**：只改 `proposalDocx.ts` + `shared/proposal.ts` + 轻调 `proposalPrompt.ts`。
  生效于 **Word 导出**（`exportProposal`）和**样式模板弹窗里的 docx-preview 真预览**
  （`renderProposal` IPC）——两者同走 `markdownToDocxBuffer`，故「预览=导出一致」
  这条不变量天然保持。

## 非目标 / 不动的部分

- **左侧「连续长纸」编辑视图 `ProposalPaper.tsx` 不变**：它是 react-markdown 连续滚动、
  天然无「页」概念，无法体现整页几何。整页效果只在分页的 docx 路径（导出 + docx-preview）呈现。
- **IPC 契约不变**：`exportProposal` / `renderProposal` 仍传 `markdown` 字符串
  （改动靠 markdown 内的注释标记承载 kind，不改 payload 形状，不触发「加 IPC 改四处」）。
- **样式模板配置结构不变**：不给 `ProposalStyleConfig` 加新字段；cover/toc 复用现有
  `title` / `body` 等层级样式。
- **`.md` 导出不变**：`buildProposalMarkdown(..., {pageBreaks:false})` 仍纯空行拼接、
  不含任何标记（注释外漏到纯文本成品是历史明令禁止的）。

## 设计

### 1. 用区段标记把 kind 带回 docx 生成器（`shared/proposal.ts`）

沿用既有「HTML 注释哨兵」思路（与 `PROPOSAL_PAGEBREAK` 同款，单独成行 → remark 解析为
块级 html 节点，在聊天/`.md` 里不可见）。新增**区段起始标记**：

```ts
// 形如 <!--proposal-section:cover-->，begin-only：下一个 section 标记或文末为界。
export const PROPOSAL_SECTION_MARK = (kind: ProposalKind): string =>
  `<!--proposal-section:${kind}-->`
// 反解析用的正则（proposalDocx 侧识别）
export const PROPOSAL_SECTION_RE = /^<!--proposal-section:(cover|toc|content)-->$/
```

`buildProposalMarkdown` 改动（仅 `pageBreaks:true` 即 docx 模式）：
- 在每个 kind **区段的第一节前**插入 `PROPOSAL_SECTION_MARK(kind)`；
- **移除**原来在 kind 边界插 `PROPOSAL_PAGEBREAK` 的逻辑（分页改由 Word 分节天然完成）。
- 同 kind 连续多节仍合在同一区段内（不重复插标记）。
- 截断残文（`truncated`）的处理维持原状：照常输出内容、不触发区段切换、不更新 prevKind。
- `pageBreaks:false`（`.md`）分支**完全不变**：纯空行拼接、零标记。

> 注：`PROPOSAL_PAGEBREAK` 常量与「单独成行的 html 注释 → PageBreak」识别逻辑**保留**
> （proposalDocx 仍处理它），仅 `buildProposalMarkdown` 不再主动产生它。这样任何遗留/
> 手写 pagebreak 仍工作，向后兼容。

### 2. 多 Section 构造（`proposalDocx.ts`）

`markdownToDocxBuffer` 从「单 section」改为「按区段分组 → 每组一个 Word Section」：

1. **解析后分组**：`mdProcessor.parse(markdown)` 得到顶层节点数组后，扫描其中的
   `proposal-section` 标记 html 节点，把节点切成有序分组 `Array<{kind, nodes}>`。
   - 无任何标记（旧调用 / 直接传裸 markdown）→ 单组 `{kind:'content', nodes:all}`，向后兼容。
   - 标记节点本身从内容中剔除（不渲染）。

2. **每组构造一个 `ISectionOptions`**，共享同一份 `buildDocStyles` / `buildNumbering`：

   - **cover 节**：
     - `properties.verticalAlign = VerticalAlignSection.CENTER`（节内竖向居中）。
     - 该节所有段落**强制水平居中**（覆盖 `levelStyle` 的 align）：首个 h1 仍走 `style:'Title'`
       放大样式；其余落款行用居中正文（沿用 `body` run 样式，alignment 改 CENTER，
       不施加首行缩进）。
     - **`footers` 留空**（无页码）。
     - 分节 type 用默认 `NEXT_PAGE` → 天然独占整页。
   - **toc 节**：
     - 节首注入一个居中「**目录**」大标题段落（用 `title`/`h1` 量级样式）+ 可选一条
       居中分隔线段落。
     - 若 AI 输出的 toc markdown 里**已自带**「目录」标题（首个 heading 文本 trim 后等于
       「目录」/「目 录」等）→ 先剥掉，避免重复。
     - 列表条目按 list level 缩进（复用现有 list→numbering 渲染即可得到层级缩进），
       行距适当拉开（沿用模板 `lineMultiple`，必要时该节 `spaceAfter` 略增以铺满）。
     - **无页码**页脚。
   - **content 节**：
     - 维持现有正文渲染逻辑（`blockToDocx` 全量）。
     - 维持现有「— 当前页码 —」居中灰色页脚（`Footer` + `PageNumber.CURRENT`）。

3. **页码约定**（已定 + 一处可选增强）：
   - 封面无页码、目录无页码（确定）。
   - 正文：**维持现有连续页码**（正文首页因此可能显示第 3 页）。
   - 可选增强（**本期不做，列为待定**）：正文页码从 1 重新起算（封面/目录不计数），
     需 `pageNumbers.start`/`PageNumberType`，且依赖 docx-preview 是否如实渲染
     `pageNumberStart`，有破坏「预览=导出一致」风险。spec 复审时若决定要，再纳入。

### 3. prompt 轻调（`proposalPrompt.ts`）

- **封面阶段（规则 5 阶段一）**：补一句「封面只需逐行写 方案标题 / 客户单位 / 编制单位 /
  日期，不要加任何额外标题、装饰或居中标签——整页排布交给导出器」。
- **目录阶段（规则 5 阶段二）**：补一句「只输出有序列表形式的章节大纲，**不要自己写
  『目录』二字标题**——标题由导出器统一注入」。

> prompt 调整是「降低 AI 与导出器版式打架」的兜底，不是功能正确性的前提：即便 AI 仍写了
> 「目录」标题或加了装饰，第 2 节的剥离逻辑 + `stripDraftHtml` 也能兜住。

## 关键风险与兜底

**封面竖向居中依赖 section `verticalAlign:CENTER`。** Word 必定支持；**docx-preview
（真预览所用库）是否如实渲染竖向居中需在实现时实测**。若不认，会出现「预览顶对齐 /
Word 居中」的 parity 破裂，违反核心不变量。

兜底（实现时若实测不达标即切换，二选一）：
- **整页高度单元格表格**：cover 内容放进一个占满版心高度的单行单列 `Table`，单元格
  `verticalAlign:CENTER`（`TableVerticalAlign`，表格单元格竖向居中两端渲染器支持更稳）。
- **按页高计算的 spacer 段落**：用页高 - 上下边距估算，在内容上方插一个固定高度空段把
  内容压到中部。确定性、两端一致，但对内容行数变化较脆。

实现顺序：先试 `verticalAlign:CENTER`，docx-preview 实测通过则用之；否则切换到「整页高
单元格表格」兜底。

## 影响面与验证

改动文件：
- `apps/desktop/src/shared/proposal.ts`：新增区段标记常量/正则；改 `buildProposalMarkdown`。
- `apps/desktop/src/main/core/proposalDocx.ts`：多 section 分组与构造；cover/toc 专属版式。
- `apps/desktop/src/main/core/proposalPrompt.ts`：两句 prompt 补充。

验证：
- `bun run typecheck`（CI 唯一质量门）。
- 手动：在样式弹窗 docx-preview 看封面竖向居中、目录标题+缩进、各自独占页；导出 Word 比对
  预览（重点核对封面竖向居中的 parity）。
- 回归：`.md` 导出不含任何标记；无标记的裸 markdown 调用仍正常（单 content section）；
  截断残文不破坏分节。
