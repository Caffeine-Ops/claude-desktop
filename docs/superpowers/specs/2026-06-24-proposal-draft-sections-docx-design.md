# 方案草稿分节化 + 真 .docx 导出（设计）

日期：2026-06-24
分支：Install-Plan
状态：已通过设计评审，待落实施计划

## 背景与问题

「写方案」功能当前实现（`ProposalDocPanel.tsx` + `stores/proposal.ts` +
`proposalExport.ts`）存在三个问题：

1. **样式与项目不符**：草稿面板硬编码深色 `bg-neutral-950`，并用一段
   `[--foreground:…]` 的 HSL 变量 hack 强行让聊天用的 `AssistantMarkdown`
   在黑底上可见；不跟随 App 主题，浅色主题下观感割裂，且看起来像聊天气泡而
   非文档。
2. **编辑太草率**：编辑只有"全文 textarea / 预览"二选一切换，无法只选其中
   一段修改。
3. **导出名不副实**：`ProposalExportFormat` 只有 `'md'`，`proposalExport.ts`
   里 `docx`/`pdf` 都是 `// future` 占位，直接把 markdown 落盘——并没有真正
   的 Word 导出。用户要的是"草稿就长成最终导出 Word 的样子和内容"。

## 目标

- 草稿面板跟随 App 主题，做成干净的"文档区"观感。
- 草稿按"部分"分节，可**选中其中一节单独编辑**（改完只动那节），并支持
  删除 / 上移 / 下移。
- 导出生成**真正的 .docx**（方案 B：`docx` 库 + remark AST 逐节点构造），
  精确还原结构内容（标题层级 / 列表 / 表格 / 来源标注）。保留 .md 导出。

## 非目标（本版不做）

- 公司专属 Word 视觉模板（具体字体/字号/页眉/配色）。本版用一套合理的中文
  方案默认样式；待用户给出模板规范后，单独升级导出层即可，面板与 store
  不需再动。
- 整篇富文本所见即所得编辑器（TipTap 等）——已在选型阶段排除。
- PDF 导出。
- 草稿持久化（store 仍是内存态，`start` 即重置）。

## 设计决策记录

- **选型 = 方案 B**：分节卡片 + `docx` 库 AST 转换。相比方案 A 的
  `html-to-docx`，B 对 Word 样式有完全控制，最接近成品；代价是要写一层
  markdown-AST→docx 映射代码。用户优先要"像最终 Word"，故选 B。
- **节的来源 = 复用现有哨兵机制**：AI 提示词（`proposalPrompt.ts` 规则 6）
  已要求把"最终正文"包在 `===方案正文开始===`/`===方案正文结束===` 之间，
  每个部分一个哨兵块。一个哨兵块天然就是一节——**提示词与哨兵不需改动**。

## 架构与单元

### 1. 数据模型（`renderer/src/stores/proposal.ts`）

把单串 `docMarkdown: string` 升级为分节数组：

```ts
export interface ProposalSection {
  id: string        // crypto.randomUUID()，稳定 key + 支持增删/重排
  markdown: string  // 该节正文 markdown
}
```

store 变更：
- `docMarkdown: string` → `sections: ProposalSection[]`。
- 保留 `consumedDraftIds: Set<string>`（按 messageId 去重，防 `end` 事件
  二次触发把同一段重复入节）。
- `start` / `reset` 把 `sections` 初始化/清空为 `[]`。
- `products` / `seeded` / `seedProducts` / `setProducts` 不动。

新增 actions：
- `appendSections(messageId: string, blocks: string[])`：若 `messageId` 已在
  `consumedDraftIds` 则跳过；否则为每个 block 生成一节 push 到 `sections`
  尾部，并把 messageId 记入 `consumedDraftIds`。
- `updateSection(id: string, markdown: string)`：写回指定节正文。
- `removeSection(id: string)`：删除指定节。
- `moveSection(id: string, dir: 'up' | 'down')`：与相邻节交换位置；越界
  则 no-op。

派生（不入 store）：导出时由 renderer 现算
`sections.map((s) => s.markdown).join('\n\n')`，IPC payload 形状不变。

### 2. 哨兵 → 节映射（`shared/proposal.ts` + `FusionRuntimeProvider.tsx`）

- `shared/proposal.ts` 新增纯函数
  `extractProposalDraftBlocks(text: string): string[]`：返回所有闭合哨兵块
  的内容数组（与现有 `extractProposalDraft` 同样的扫描逻辑，但不 join）。
  现有 `extractProposalDraft` 改为 `extractProposalDraftBlocks(text).join('\n\n')`
  以保持向后兼容、零行为变化。
- `FusionRuntimeProvider.tsx` 的 `end` 处理（约 1051 行）改为：
  ```ts
  const blocks = extractProposalDraftBlocks(fullText)
  if (blocks.length) {
    useProposalStore.getState().appendSections(event.messageId, blocks)
  }
  ```
  原 `setDoc(`${cur}\n\n${draft}`)` 删除。`markDraftConsumed` 的记账职责
  移入 `appendSections` 内部（去重与入节原子完成）；但**无论是否抽到正文都
  要标记 messageId 已处理**——保留对"零正文消息"也调一次记账的语义（可在
  `end` 分支里：抽到 → `appendSections`；没抽到 → 仍 `markDraftConsumed`）。

### 3. 面板重做（`renderer/src/components/workspace/ProposalDocPanel.tsx`）

容器与主题：
- 换成主题语义色：`bg-background text-foreground border-border`。
- **删除**硬编码 `bg-neutral-950` 与 `[--foreground:0_0%_100%]
  [--muted-foreground:0_0%_72%]` 这段 HSL hack（底色已是主题色，
  `AssistantMarkdown` 的 `text-foreground` 等语义色自然可见）。
- 宽度仍 `w-96` 固定（App 布局约束，避免方案模式下挤垮 composer——见
  `App.tsx` 现有注释，不动该约束）。

顶栏：
- 标题「方案草稿」。
- 导出按钮提供两种格式：**Word(.docx)** | **Markdown(.md)**（下拉或分段
  按钮，二选一触发 `handleExport(format)`）。
- 导出反馈条（成功显路径 / 取消 / 失败显错误，4s 自动消失）逻辑保留。

产品 chip 行：保留现有功能，重新着色到主题语义色。

正文 = 分节文档卡片列表：
- `sections` 为空 → 空态「等待 AI 起草…」。
- 每节渲染一张卡片，垂直排列：
  - 预览态：`AssistantMarkdown` 渲染该节 markdown。
  - 卡片操作（hover 显示）：**编辑**（铅笔）/ **删除** / **上移** / **下移**。
  - 编辑态：用单个组件级 `editingId: string | null`（一次只编辑一节）。
    点「编辑」→ 该节翻成 textarea（值 = 该节 markdown）；改动经
    `updateSection(id, value)` 写回；点「完成」或失焦退出编辑态。

### 4. 真 .docx 导出（`main/core/`）

新模块 `main/core/proposalDocx.ts`：
- 依赖：`docx`（构造 Word）+ `unified` + `remark-parse` + `remark-gfm`
  （解析 markdown→mdast AST，含 GFM 表格）。均为纯 JS，打进 main 进程包。
- `markdownToDocxBuffer(markdown: string): Promise<Buffer>`：
  - 用 unified + remark-parse + remark-gfm 解析为 mdast。
  - 遍历 mdast 顶层节点 → docx 段落/元素：
    - `heading`（depth 1–6）→ 对应 `HeadingLevel` 标题段。
    - `paragraph` → `Paragraph`，内联子节点 `text`/`strong`/`emphasis`/
      `inlineCode`/`link` → 对应 `TextRun`（粗体/斜体/等宽/带 link）。
    - `list`（ordered/unordered）→ 项目符号 / 编号段落（嵌套按层级缩进）。
    - `blockquote` → 带缩进/样式的段落。
    - `table`（gfm）→ docx `Table`/`TableRow`/`TableCell`。
    - `code` → 等宽代码段。
    - 来源标注 `（据《…》）` 作为段尾普通文本保留（后续可升级脚注）。
    - 未知/未处理节点 → 兜底为纯文本段落，不抛错。
  - `Packer.toBuffer(doc)` 返回 Buffer。
- `proposalExport.ts`：
  - `'docx'` case → `await markdownToDocxBuffer(markdown)` 后 `writeFileSync`。
  - save dialog filters 按 format 切换（docx 用
    `[{ name: 'Word', extensions: ['docx'] }]`，默认文件名 `方案草稿.docx`）。

### 5. 共享类型（`shared/ipc-channels.ts`）

- `ProposalExportFormat = 'md' | 'docx'`。
- `exportProposal` 的 IPC payload/return 形状不变（仍传 `{ markdown, format }`），
  只是 format 联合多了 `'docx'`，主进程 `switch` 的 exhaustiveness guard 自动
  要求补 docx 分支。

## 数据流

```
AI assistant 消息（含哨兵块）
  → runtime 'end' 事件
  → extractProposalDraftBlocks(fullText) → string[]
  → appendSections(messageId, blocks)（去重 + 每块一节）
  → store.sections 更新 → 面板卡片列表重渲染

用户点某卡片「编辑」→ textarea 改动 → updateSection(id, md) → store → 重渲染
用户点「删除/上移/下移」→ removeSection/moveSection → store → 重渲染

用户点导出(format)
  → renderer 现算 markdown = sections.join('\n\n')
  → window.chatApi.exportProposal({ markdown, format })
  → main exportProposal：'md' 直接写；'docx' 走 markdownToDocxBuffer
  → save dialog → writeFileSync → 返回 path
  → 面板反馈条显示结果
```

## 错误处理

- 导出 try/catch 复用现有反馈条；docx 转换异常归 `tone: 'err'` 显错误信息。
- 空草稿（`sections` 为空或 join 后为空）→ 维持现有「草稿为空，无内容可导出」。
- markdown 容错由 remark 兜底；未知 mdast 节点降级为纯文本段，不中断导出。
- 分节编辑文本即存即渲染，不做校验（markdown 渲染器自身容错）。

## 验证

项目无单元测试、无 ESLint，质量门为 `bun run typecheck`（tsc node + web）。
- `bun run typecheck` 必须通过（IPC 四处类型同步：ipc-channels / preload index /
  preload .d.ts / main handler；以及 store/shared 类型）。
- `bun run dev` 手动验收：进方案模式 → AI 起草多节 → 卡片分节渲染正确 →
  单节编辑写回正确 → 删除/上移/下移正确 → 导出 .docx 打开确认标题/列表/
  表格/来源标注样式 → 导出 .md 仍正常 → 浅色 + 深色主题面板观感一致。

## 影响文件

- `renderer/src/stores/proposal.ts`（数据模型 + actions）
- `shared/proposal.ts`（`extractProposalDraftBlocks`）
- `renderer/src/runtime/FusionRuntimeProvider.tsx`（`end` 累积改分节）
- `renderer/src/components/workspace/ProposalDocPanel.tsx`（面板重做）
- `main/core/proposalDocx.ts`（新增，md→docx）
- `main/core/proposalExport.ts`（接 docx 分支）
- `shared/ipc-channels.ts`（`ProposalExportFormat` 加 `'docx'`）
- `package.json`（新增 `docx` / `unified` / `remark-parse` / `remark-gfm`）
- `App.tsx`：无需改（布局门控 `useProposalForeground` 不变）
