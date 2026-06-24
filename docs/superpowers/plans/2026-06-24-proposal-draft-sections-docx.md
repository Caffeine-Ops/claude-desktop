# 方案草稿分节化 + 真 .docx 导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「写方案」草稿升级为跟随主题的分节文档区（可单节编辑/删除/重排），并把导出从假 .md 升级为真 .docx（remark AST 逐节点构造 Word）。

**Architecture:** 草稿数据模型从单串 `docMarkdown` 改为 `ProposalSection[]`，每个 AI 哨兵块映射为一节；面板按节渲染文档卡片、单节就地编辑；导出时 renderer 把各节 join 成 markdown，主进程用 `docx` + `unified`/`remark-parse`/`remark-gfm` 解析为 mdast 并逐节点构造 .docx。

**Tech Stack:** React 19 + zustand（renderer）、Electron 主进程（Node）、`docx` + `unified` + `remark-parse` + `remark-gfm`、bun、electron-vite、TypeScript composite。

## Global Constraints

- 包管理器是 **bun**，不是 npm。依赖装在 `apps/desktop/package.json`。
- 质量门只有 `bun run typecheck`（tsc node + web）。**项目无单元测试、无 ESLint、无测试运行器**（见 CLAUDE.md）。本计划据此覆盖 writing-plans 的 pytest 范式：**纯函数**用一次性 `bun <script.ts>` 脚本断言验证（脚本放 scratchpad，不提交）；**UI / 集成**用 `bun run typecheck` + `bun run dev` 手动验收。
- IPC 改动若涉及通道/方法/类型/handler 必须四处同步；本计划只改类型联合（`ProposalExportFormat`）与 main handler 守卫，payload 形状不变。
- renderer 禁止 import Node 模块；docx 转换只在主进程。
- 全程中文注释，且解释「为什么这样而不是那样」（沿用现有风格）。
- 不动方案提示词（`proposalPrompt.ts`）与哨兵常量——一个哨兵块仍是一个"部分"。
- 不动 `App.tsx` 布局门控（`useProposalForeground`）与面板 `w-96` 固定宽度约束。
- scratchpad 目录：`/private/tmp/claude-501/-Users-kika-Desktop-project-Electron-claude-desktop/506da77a-cb4b-4abe-b88f-f450c5f28f3d/scratchpad`

---

### Task 1: shared 抽取器拆出 `extractProposalDraftBlocks`

**Files:**
- Modify: `apps/desktop/src/shared/proposal.ts`
- Verify (临时脚本，不提交): `<scratchpad>/t1-blocks.ts`

**Interfaces:**
- Produces: `extractProposalDraftBlocks(text: string): string[]` — 返回所有闭合哨兵块内容（trim 后非空）的数组，顺序与出现顺序一致；无哨兵对 → `[]`。
- `extractProposalDraft(text: string): string` 保持现有签名与行为（改为内部调用新函数再 `join('\n\n')`）。

- [ ] **Step 1: 写临时验证脚本（先红）**

创建 `<scratchpad>/t1-blocks.ts`（用绝对 scratchpad 路径替换 `<scratchpad>`）：

```ts
import { extractProposalDraftBlocks, extractProposalDraft } from '/Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop/src/shared/proposal'

const B = '===方案正文开始==='
const E = '===方案正文结束==='
const text = `提问无关\n${B}\n第一节\n${E}\n中间确认\n${B}\n第二节\n${E}\n未闭合${B}残块`

const blocks = extractProposalDraftBlocks(text)
console.assert(blocks.length === 2, `期望 2 块，实际 ${blocks.length}`)
console.assert(blocks[0] === '第一节', `块0=${JSON.stringify(blocks[0])}`)
console.assert(blocks[1] === '第二节', `块1=${JSON.stringify(blocks[1])}`)
console.assert(extractProposalDraftBlocks('无哨兵').length === 0, '无哨兵应为空')
// 向后兼容：join 行为不变
console.assert(extractProposalDraft(text) === '第一节\n\n第二节', `join=${JSON.stringify(extractProposalDraft(text))}`)
console.log('T1 OK')
```

- [ ] **Step 2: 运行确认失败**

Run: `bun <scratchpad>/t1-blocks.ts`
Expected: 报错 `extractProposalDraftBlocks is not a function`（或 import 失败）。

- [ ] **Step 3: 实现拆分**

编辑 `apps/desktop/src/shared/proposal.ts`，把现有 `extractProposalDraft` 的循环抽到新函数，原函数改为 join 包装：

```ts
/**
 * 抽取所有「方案正文」段（哨兵之间内容）为数组，顺序与出现顺序一致。
 * 分节化的来源：每个闭合哨兵块 = 一节。无哨兵对 → []。未闭合残块忽略。
 * 纯函数，main 与 renderer 共享。
 */
export function extractProposalDraftBlocks(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  let from = 0
  for (;;) {
    const b = text.indexOf(PROPOSAL_DRAFT_BEGIN, from)
    if (b < 0) break
    const contentStart = b + PROPOSAL_DRAFT_BEGIN.length
    const e = text.indexOf(PROPOSAL_DRAFT_END, contentStart)
    if (e < 0) break // 未闭合：忽略，避免把后续提问吞进草稿
    const section = text.slice(contentStart, e).trim()
    if (section) out.push(section)
    from = e + PROPOSAL_DRAFT_END.length
  }
  return out
}

/**
 * 向后兼容：把各正文段以空行拼成单串。行为与重构前一致。
 */
export function extractProposalDraft(text: string): string {
  return extractProposalDraftBlocks(text).join('\n\n').trim()
}
```

删除原 `extractProposalDraft` 函数体里的循环实现（被上面替代）。保留文件顶部哨兵常量与说明注释不动。

- [ ] **Step 4: 运行确认通过**

Run: `bun <scratchpad>/t1-blocks.ts`
Expected: 输出 `T1 OK`，无 assert 报错。

- [ ] **Step 5: typecheck + 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run typecheck
git add apps/desktop/src/shared/proposal.ts
git commit -m "refactor(proposal): 抽出 extractProposalDraftBlocks 为分节化铺路

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: typecheck 通过。

---

### Task 2: proposal store 升级为分节模型

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/proposal.ts`
- Verify: typecheck（store 纯类型 + zustand，无独立运行入口）

**Interfaces:**
- Produces:
  - `interface ProposalSection { id: string; markdown: string }`
  - store 字段 `sections: ProposalSection[]`（取代 `docMarkdown: string`）
  - `appendSections(messageId: string, blocks: string[]): void` — messageId 已消费则跳过；否则每块生成 `{ id: crypto.randomUUID(), markdown }` push 到尾部，并把 messageId 记入 `consumedDraftIds`。
  - `updateSection(id: string, markdown: string): void`
  - `removeSection(id: string): void`
  - `moveSection(id: string, dir: 'up' | 'down'): void` — 与相邻节交换；越界 no-op。
- Consumes: `crypto.randomUUID()`（renderer 浏览器环境原生可用）。

- [ ] **Step 1: 改接口与字段**

编辑 `apps/desktop/src/renderer/src/stores/proposal.ts`。在 `ProposalProduct` 下新增：

```ts
export interface ProposalSection {
  // 稳定 id：React key + 增删/重排定位。renderer 浏览器环境可用 crypto.randomUUID()。
  id: string
  markdown: string
}
```

把 `ProposalState` 里的 `docMarkdown: string` 改为 `sections: ProposalSection[]`，并把
`setDoc` 这条 action 删除，替换为下面四条声明：

```ts
  sections: ProposalSection[]
  // ...（consumedDraftIds、start、setProducts、seedProducts 保持）
  // 哨兵块 → 节：messageId 去重后，每块成一节追加到尾部。取代原 setDoc 字符串拼接。
  appendSections: (messageId: string, blocks: string[]) => void
  updateSection: (id: string, markdown: string) => void
  removeSection: (id: string) => void
  moveSection: (id: string, dir: 'up' | 'down') => void
```

（`markDraftConsumed` 保留——零正文消息仍要记账，见 Task 3。）

- [ ] **Step 2: 改实现**

把 `create<ProposalState>` 里的 `docMarkdown: ''` 改为 `sections: []`；`start` 与
`reset` 的 `docMarkdown: ''` 都改为 `sections: []`。删除 `setDoc` 实现，新增：

```ts
  appendSections: (messageId, blocks) =>
    set((s) => {
      // 消息级去重：end 对同一 messageId 二次触发时不重复入节（沿用原 consumedDraftIds 语义）。
      if (s.consumedDraftIds.has(messageId)) return s
      const consumed = new Set(s.consumedDraftIds)
      consumed.add(messageId)
      const added = blocks.map((markdown) => ({ id: crypto.randomUUID(), markdown }))
      return { sections: [...s.sections, ...added], consumedDraftIds: consumed }
    }),
  updateSection: (id, markdown) =>
    set((s) => ({
      sections: s.sections.map((sec) => (sec.id === id ? { ...sec, markdown } : sec))
    })),
  removeSection: (id) =>
    set((s) => ({ sections: s.sections.filter((sec) => sec.id !== id) })),
  moveSection: (id, dir) =>
    set((s) => {
      const i = s.sections.findIndex((sec) => sec.id === id)
      if (i < 0) return s
      const j = dir === 'up' ? i - 1 : i + 1
      if (j < 0 || j >= s.sections.length) return s // 越界 no-op
      const next = s.sections.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      return { sections: next }
    }),
```

保留 `markDraftConsumed` 实现不变。

- [ ] **Step 3: typecheck（会暴露 Task 3/6 的引用断裂，预期）**

Run: `cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck`
Expected: 报错集中在 `FusionRuntimeProvider.tsx`（用 `setDoc`/`docMarkdown`）与 `ProposalDocPanel.tsx`（用 `docMarkdown`/`setDoc`）——这两处在 Task 3、Task 6 修。**store 文件本身不应有错。** 若 store 文件内有错则修正后重跑。

- [ ] **Step 4: 提交（与 Task 3 连续，但 store 改动自洽，可单独 commit）**

```bash
git add apps/desktop/src/renderer/src/stores/proposal.ts
git commit -m "feat(proposal): store 升级为 ProposalSection[] 分节模型

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: 提交成功（typecheck 暂不绿，待 Task 3/6 修复——故此 commit 与后续紧邻）。

---

### Task 3: 运行时 end 累积改为分节

**Files:**
- Modify: `apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx`（约 1042–1059 行，及第 22 行 import）

**Interfaces:**
- Consumes: `extractProposalDraftBlocks`（Task 1）、`appendSections`/`markDraftConsumed`（Task 2）。

- [ ] **Step 1: 改 import**

把第 22 行：

```ts
import { extractProposalDraft } from '@shared/proposal'
```

改为：

```ts
import { extractProposalDraftBlocks } from '@shared/proposal'
```

- [ ] **Step 2: 改 end 累积块**

把 `FusionRuntimeProvider.tsx` 约 1042–1056 行（`if (msg && msg.role === 'assistant') { ... }` 内部用 `extractProposalDraft`/`setDoc` 的那段）替换为：

```ts
          if (msg && msg.role === 'assistant') {
            // Collect all 'text' parts (skip 'reasoning' / tool-call parts).
            const fullText = msg.content
              .filter((p) => p.type === 'text' && p.text)
              .map((p) => p.text!)
              .join('')
            // 每个哨兵块映射为一节。提问 / 过程对话不带哨兵 → 空数组 → 不入节
            // （修复提问污染文档）。哨兵与抽取器在 shared/proposal.ts，与提示词规则 6 同源。
            // appendSections 内部按 messageId 去重并记账（替代原 setDoc 字符串拼接）。
            const blocks = extractProposalDraftBlocks(fullText)
            if (blocks.length) {
              useProposalStore.getState().appendSections(event.messageId, blocks)
            } else {
              // 零正文消息（纯提问）也要记账，使同一 messageId 的 end 不再二次处理。
              useProposalStore.getState().markDraftConsumed(event.messageId)
            }
          }
```

删除原第 1057–1058 行那条「无论是否抽到正文都标记」的 `markDraftConsumed` 调用
（记账已并入上面两分支；`appendSections` 自身会记账）。保留外层三道门控注释与
`actions.endAssistantMessage(sid)`。

- [ ] **Step 3: typecheck**

Run: `cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck`
Expected: `FusionRuntimeProvider.tsx` 不再报 proposal 相关错误；剩余错误应只在 `ProposalDocPanel.tsx`（Task 6 修）。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx
git commit -m "feat(proposal): end 累积改为按哨兵块分节入 store

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: markdown→docx 转换器 + 依赖

**Files:**
- Create: `apps/desktop/src/main/core/proposalDocx.ts`
- Modify: `apps/desktop/package.json`（依赖）
- Verify: `<scratchpad>/t4-docx.ts`（生成 .docx 并断言非空 + 人工打开看样式）

**Interfaces:**
- Produces: `markdownToDocxBuffer(markdown: string): Promise<Buffer>` — 把 markdown 解析为 mdast 并构造 .docx，返回可直接 `writeFileSync` 的 Buffer。

- [ ] **Step 1: 安装依赖**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop
bun add docx unified remark-parse
bun add -d @types/mdast
```
（`remark-gfm` 已存在，复用。）
Expected: `apps/desktop/package.json` 出现 `docx`、`unified`、`remark-parse` 与 devDep `@types/mdast`。

- [ ] **Step 2: 写转换器**

创建 `apps/desktop/src/main/core/proposalDocx.ts`：

```ts
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  LevelFormat,
  AlignmentType
} from 'docx'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type {
  Root,
  RootContent,
  PhrasingContent,
  ListItem,
  TableCell as MdTableCell
} from 'mdast'

/**
 * 把方案 markdown 转成真正的 .docx（方案 B：逐 mdast 节点构造，而非 html 中转）。
 *
 * 为什么走 mdast 而不是 html→docx：对标题层级、有序/无序列表、表格、加粗/斜体有
 * 完全控制，最接近最终 Word 成品。未知节点降级为纯文本段，绝不抛错中断导出。
 *
 * 主进程专用（依赖 Node）。renderer 永远只传 markdown 字符串过来。
 */
const HEADING_BY_DEPTH = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6
] as const

// 内联样式累积：递归下传 bold/italics/code 标志，叶子 text 据此产出 TextRun。
interface InlineStyle {
  bold?: boolean
  italics?: boolean
  code?: boolean
}

function inlineRuns(nodes: PhrasingContent[], style: InlineStyle = {}): TextRun[] {
  const runs: TextRun[] = []
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        runs.push(
          new TextRun({
            text: n.value,
            bold: style.bold,
            italics: style.italics,
            font: style.code ? 'Consolas' : undefined
          })
        )
        break
      case 'strong':
        runs.push(...inlineRuns(n.children, { ...style, bold: true }))
        break
      case 'emphasis':
        runs.push(...inlineRuns(n.children, { ...style, italics: true }))
        break
      case 'inlineCode':
        runs.push(new TextRun({ text: n.value, font: 'Consolas', bold: style.bold }))
        break
      case 'link':
        // 链接降级为其可见文本（方案文档极少需要可点击超链接；保内容不保交互）。
        runs.push(...inlineRuns(n.children, style))
        break
      case 'break':
        runs.push(new TextRun({ break: 1 }))
        break
      default:
        // 其它内联节点（image 等）：取其 children 文本兜底，无 children 则忽略。
        if ('children' in n && Array.isArray(n.children)) {
          runs.push(...inlineRuns(n.children as PhrasingContent[], style))
        }
    }
  }
  return runs.length ? runs : [new TextRun('')]
}

// 列表项 → 段落数组。ordered 用编号引用，unordered 用项目符号；嵌套靠 level。
function listItemParagraphs(
  item: ListItem,
  ordered: boolean,
  level: number
): Paragraph[] {
  const out: Paragraph[] = []
  for (const child of item.children) {
    if (child.type === 'paragraph') {
      out.push(
        new Paragraph({
          children: inlineRuns(child.children),
          ...(ordered
            ? { numbering: { reference: 'proposal-ordered', level } }
            : { bullet: { level } })
        })
      )
    } else if (child.type === 'list') {
      // 嵌套列表：递归，level+1。
      for (const sub of child.children) {
        out.push(...listItemParagraphs(sub, Boolean(child.ordered), level + 1))
      }
    }
  }
  return out
}

function tableCellContent(cell: MdTableCell): Paragraph[] {
  return [new Paragraph({ children: inlineRuns(cell.children) })]
}

// 顶层块节点 → docx 元素（Paragraph | Table）。
function blockToDocx(node: RootContent): Array<Paragraph | Table> {
  switch (node.type) {
    case 'heading':
      return [
        new Paragraph({
          heading: HEADING_BY_DEPTH[Math.min(node.depth, 6) - 1],
          children: inlineRuns(node.children)
        })
      ]
    case 'paragraph':
      return [new Paragraph({ children: inlineRuns(node.children) })]
    case 'list': {
      const out: Paragraph[] = []
      for (const item of node.children) {
        out.push(...listItemParagraphs(item, Boolean(node.ordered), 0))
      }
      return out
    }
    case 'blockquote': {
      // 引用：缩进 + 斜体，逐子段处理。
      const out: Array<Paragraph | Table> = []
      for (const child of node.children) {
        for (const el of blockToDocx(child)) {
          if (el instanceof Paragraph) {
            out.push(
              new Paragraph({
                children: inlineRuns(
                  'children' in child ? (child.children as PhrasingContent[]) : []
                ),
                indent: { left: 480 },
                style: undefined
              })
            )
          } else {
            out.push(el)
          }
        }
      }
      return out.length ? out : [new Paragraph({ children: [new TextRun('')] })]
    }
    case 'code':
      // 代码块：逐行等宽段落。
      return node.value
        .split('\n')
        .map(
          (line) =>
            new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas' })] })
        )
    case 'table': {
      const rows = node.children.map(
        (row) =>
          new TableRow({
            children: row.children.map(
              (cell) =>
                new TableCell({
                  children: tableCellContent(cell),
                  width: { size: 0, type: WidthType.AUTO }
                })
            )
          })
      )
      return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })]
    }
    case 'thematicBreak':
      return [new Paragraph({ children: [new TextRun('———')], alignment: AlignmentType.CENTER })]
    default:
      // 未知块：取文本兜底，绝不抛错。
      if ('children' in node && Array.isArray(node.children)) {
        return [new Paragraph({ children: inlineRuns(node.children as PhrasingContent[]) })]
      }
      if ('value' in node && typeof node.value === 'string') {
        return [new Paragraph({ children: [new TextRun(node.value)] })]
      }
      return []
  }
}

export async function markdownToDocxBuffer(markdown: string): Promise<Buffer> {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as Root
  const children: Array<Paragraph | Table> = []
  for (const node of tree.children) {
    children.push(...blockToDocx(node))
  }
  const doc = new Document({
    // 有序列表编号实例：1. 2. 3. …，多级递进。
    numbering: {
      config: [
        {
          reference: 'proposal-ordered',
          levels: [0, 1, 2, 3].map((lvl) => ({
            level: lvl,
            format: LevelFormat.DECIMAL,
            text: `%${lvl + 1}.`,
            alignment: AlignmentType.START
          }))
        }
      ]
    },
    sections: [{ children: children.length ? children : [new Paragraph({ children: [new TextRun('')] })] }]
  })
  return Packer.toBuffer(doc)
}
```

- [ ] **Step 3: 写临时验证脚本**

创建 `<scratchpad>/t4-docx.ts`：

```ts
import { writeFileSync } from 'node:fs'
import { markdownToDocxBuffer } from '/Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop/src/main/core/proposalDocx'

const md = `# 建设方案
## 一、项目概述
这是一段**加粗**与*斜体*正文。（据《某资料.md》）

## 二、产品清单（逐条）
1. 产品 A：说明文字
2. 产品 B：说明文字

- 要点一
- 要点二

| 名称 | 规格 |
| --- | --- |
| 甲 | 100 |
| 乙 | 200 |
`
const buf = await markdownToDocxBuffer(md)
console.assert(buf.length > 1000, `docx buffer 过小: ${buf.length}`)
const out = '<scratchpad>/t4-out.docx'
writeFileSync(out, buf)
console.log('T4 OK, 写入', out, buf.length, 'bytes')
```

- [ ] **Step 4: 运行 + 人工看样式**

Run: `bun <scratchpad>/t4-docx.ts && open <scratchpad>/t4-out.docx`
Expected: 输出 `T4 OK ...`；Word/Pages 打开后能看到 H1/H2 标题层级、加粗/斜体、有序列表 1./2.、无序项目符号、两行两列表格。若 docx API 形参报错（版本差异），按 `docx` 安装版本的类型修正后重跑。

- [ ] **Step 5: typecheck + 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
git add apps/desktop/src/main/core/proposalDocx.ts apps/desktop/package.json
# 若锁文件变化也一并提交：
git add apps/desktop/bun.lock bun.lock 2>/dev/null || true
git commit -m "feat(proposal): 新增 markdown→docx 转换器（remark mdast 逐节点构造）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
Expected: typecheck 通过。

---

### Task 5: 把 docx 接入导出路径

**Files:**
- Modify: `apps/desktop/src/shared/ipc-channels.ts:806`（`ProposalExportFormat`）
- Modify: `apps/desktop/src/main/ipc/register.ts`（约 1014 行守卫）
- Modify: `apps/desktop/src/main/core/proposalExport.ts`

**Interfaces:**
- Consumes: `markdownToDocxBuffer`（Task 4）。
- Produces: `ProposalExportFormat = 'md' | 'docx'`；`exportProposal` 支持 `'docx'`。

- [ ] **Step 1: 放开类型联合**

`apps/desktop/src/shared/ipc-channels.ts` 第 806 行改为：

```ts
export type ProposalExportFormat = 'md' | 'docx' // 进阶可再加 'pdf'
```

- [ ] **Step 2: 放开 main handler 运行时守卫**

`apps/desktop/src/main/ipc/register.ts` 约 1012–1015 行那段（`if (payload?.format !== 'md') return { path: null }`）改为：

```ts
      // 校验 format 落在已支持联合内，挡掉意外值流入写路径。
      if (payload?.format !== 'md' && payload?.format !== 'docx') {
        return { path: null }
      }
      const format = payload.format
```

- [ ] **Step 3: proposalExport 接 docx 分支**

编辑 `apps/desktop/src/main/core/proposalExport.ts`：顶部加 import，filters 与 defaultPath 按 format 切换，switch 补 docx 分支。

import 区加：

```ts
import { markdownToDocxBuffer } from './proposalDocx'
```

filters/defaultPath 段改为：

```ts
  const filters =
    format === 'docx'
      ? [{ name: 'Word', extensions: ['docx'] }]
      : [{ name: 'Markdown', extensions: ['md'] }]

  const r = await dialog.showSaveDialog(win, {
    filters,
    defaultPath: format === 'docx' ? '方案草稿.docx' : '方案草稿.md'
  })
```

switch 段把 `case 'md'` 之后补 `case 'docx'`：

```ts
  switch (format) {
    case 'md':
      writeFileSync(r.filePath, markdown, 'utf8')
      break
    case 'docx': {
      // markdown → 真 .docx（逐 mdast 节点构造，见 proposalDocx.ts）。
      const buf = await markdownToDocxBuffer(markdown)
      writeFileSync(r.filePath, buf)
      break
    }
    default: {
      const _exhaustive: never = format
      throw new Error(`Unsupported export format: ${String(_exhaustive)}`)
    }
  }
```

- [ ] **Step 4: typecheck**

Run: `cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck`
Expected: 通过（exhaustiveness guard 现接受 'md'|'docx'）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/main/ipc/register.ts apps/desktop/src/main/core/proposalExport.ts
git commit -m "feat(proposal): 导出支持真 .docx 格式

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: ProposalDocPanel 重做（主题文档区 + 分节编辑 + 双格式导出）

**Files:**
- Modify (整体重写): `apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx`

**Interfaces:**
- Consumes: store 的 `sections`/`updateSection`/`removeSection`/`moveSection`（Task 2）、`products`/`setProducts`、`useProposalForeground`；`window.chatApi.exportProposal`；`AssistantMarkdown`。

- [ ] **Step 1: 整体重写组件**

用以下内容替换 `ProposalDocPanel.tsx` 全文：

```tsx
import { useEffect, useState } from 'react'
import { useProposalStore, useProposalForeground } from '../../stores/proposal'
import type { ProposalExportFormat } from '@shared/ipc-channels'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'

export function ProposalDocPanel(): React.JSX.Element | null {
  // 与 App.tsx 隐藏右栏同一门控：只对【当前前台会话】是方案会话时显示（评审 #8）。
  const show = useProposalForeground()
  const sections = useProposalStore((s) => s.sections)
  const updateSection = useProposalStore((s) => s.updateSection)
  const removeSection = useProposalStore((s) => s.removeSection)
  const moveSection = useProposalStore((s) => s.moveSection)
  const products = useProposalStore((s) => s.products)
  const setProducts = useProposalStore((s) => s.setProducts)
  // 一次只编辑一节，符合「选中其中一节单独编辑」。null = 全预览态。
  const [editingId, setEditingId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportMsg, setExportMsg] = useState<{ tone: 'ok' | 'err' | 'muted'; text: string } | null>(null)

  useEffect(() => {
    if (!exportMsg) return
    const id = setTimeout(() => setExportMsg(null), 4000)
    return () => clearTimeout(id)
  }, [exportMsg])

  async function handleExport(format: ProposalExportFormat): Promise<void> {
    if (exporting) return
    // 各节现算成单串 markdown 再交给主进程（IPC payload 形状不变）。
    const markdown = sections.map((s) => s.markdown).join('\n\n').trim()
    if (!markdown) {
      setExportMsg({ tone: 'muted', text: '草稿为空，无内容可导出' })
      return
    }
    setExporting(true)
    try {
      const r = await window.chatApi.exportProposal({ markdown, format })
      setExportMsg(
        r.path ? { tone: 'ok', text: `已导出：${r.path}` } : { tone: 'muted', text: '已取消导出' }
      )
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      console.error('[export]', err)
      setExportMsg({ tone: 'err', text: `导出失败：${m}` })
    } finally {
      setExporting(false)
    }
  }

  if (!show) return null
  return (
    <div className="flex w-96 flex-col border-l border-border bg-background text-foreground">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span>方案草稿</span>
        <div className="flex items-center gap-1">
          <button
            className="rounded px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            disabled={exporting}
            onClick={() => { void handleExport('docx') }}
          >
            {exporting ? '导出中…' : '导出 Word'}
          </button>
          <button
            className="rounded px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            disabled={exporting}
            onClick={() => { void handleExport('md') }}
          >
            .md
          </button>
        </div>
      </div>

      {exportMsg && (
        <div
          className={
            'truncate border-b border-border px-3 pb-1.5 pt-1 text-[11px] ' +
            (exportMsg.tone === 'ok'
              ? 'text-emerald-500'
              : exportMsg.tone === 'err'
                ? 'text-rose-500'
                : 'text-muted-foreground')
          }
          title={exportMsg.text}
        >
          {exportMsg.text}
        </div>
      )}

      {/* 识别到的产品 chip：方案首发时由 matchProducts 写入，可删纠错。空集 → 提示整库兜底。 */}
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
        {products.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">未识别到产品，AI 将自行在知识库定位</span>
        ) : (
          products.map((p) => (
            <span
              key={`${p.productLine} ${p.product}`}
              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground"
            >
              {p.product}
              <button
                type="button"
                aria-label={`移除 ${p.product}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() =>
                  setProducts(
                    products.filter((x) => !(x.productLine === p.productLine && x.product === p.product))
                  )
                }
              >
                ✕
              </button>
            </span>
          ))
        )}
      </div>

      {/* 分节文档区：每节一张卡片，可单节编辑 / 删除 / 上下移。底色为主题色，
          AssistantMarkdown 的语义色（text-foreground 等）自然可见，无需 HSL hack。 */}
      <div className="flex-1 space-y-2 overflow-auto p-3">
        {sections.length === 0 ? (
          <div className="text-[13px] text-muted-foreground">等待 AI 起草…</div>
        ) : (
          sections.map((sec, i) => (
            <div
              key={sec.id}
              className="group rounded-md border border-border bg-card/40 p-2"
            >
              <div className="mb-1 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-30"
                  disabled={i === 0}
                  onClick={() => moveSection(sec.id, 'up')}
                  aria-label="上移"
                >↑</button>
                <button
                  className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-30"
                  disabled={i === sections.length - 1}
                  onClick={() => moveSection(sec.id, 'down')}
                  aria-label="下移"
                >↓</button>
                <button
                  className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                  onClick={() => setEditingId(editingId === sec.id ? null : sec.id)}
                >{editingId === sec.id ? '完成' : '编辑'}</button>
                <button
                  className="rounded px-1.5 py-0.5 text-[11px] text-rose-500 hover:bg-muted"
                  onClick={() => {
                    if (editingId === sec.id) setEditingId(null)
                    removeSection(sec.id)
                  }}
                >删除</button>
              </div>
              {editingId === sec.id ? (
                <textarea
                  className="h-48 w-full resize-y rounded bg-transparent text-[13px] text-foreground outline-none"
                  value={sec.markdown}
                  autoFocus
                  onChange={(e) => updateSection(sec.id, e.target.value)}
                />
              ) : (
                <AssistantMarkdown text={sec.markdown} />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: typecheck**

Run: `cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck`
Expected: 全绿（node + web 都通过）。若 `bg-card` 等类在本项目主题里不存在，改用已有的 `bg-muted`/`bg-background`（Step 3 验收时按实际主题确认）。

- [ ] **Step 3: 提交**

```bash
git add apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx
git commit -m "feat(proposal): 草稿面板重做为主题文档区 + 分节编辑 + 双格式导出

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 全链路手动验收

**Files:** 无（验证 only）

- [ ] **Step 1: typecheck 终检**

Run: `cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck`
Expected: node + web 均通过、零错误。

- [ ] **Step 2: 起开发态**

Run: `bun run dev`（后台）。等 Electron 窗口出现。

- [ ] **Step 3: 走查方案模式**

进入方案写作模式 → 让 AI 起草含多个哨兵块的方案，逐项确认：
1. 草稿区按节渲染成多张文档卡片（非单块）。
2. 面板底色跟随主题（切浅色/深色主题，文字均清晰可见，无黑底白字割裂）。
3. hover 某卡片出现 上移/下移/编辑/删除；点「编辑」只该节翻 textarea，改动即时反映，点「完成」回预览。
4. 上移/下移调整顺序正确；删除移除该节。
5. 顶栏「导出 Word」→ 保存 .docx → Word/Pages 打开，标题层级 / 列表 / 表格 / 来源标注样式正确。
6. 顶栏「.md」→ 保存 .md → 内容为各节 join。
7. 空草稿点导出 → 提示「草稿为空」。

- [ ] **Step 4: 清理临时脚本**

```bash
rm -f <scratchpad>/t1-blocks.ts <scratchpad>/t4-docx.ts <scratchpad>/t4-out.docx
```

验收全过 → 功能完成。如需把踩坑写入 Obsidian errors/ 与 sessions/（见 CLAUDE.md 约定），在此追加。

---

## Self-Review

**Spec coverage（逐条对照 spec）：**
- 数据模型 `ProposalSection[]` + actions → Task 2 ✅
- 哨兵→节映射（`extractProposalDraftBlocks` + end 累积）→ Task 1 + Task 3 ✅
- 面板跟随主题文档区（删 `bg-neutral-950`/HSL hack）→ Task 6 ✅
- 分节卡片 + 单节编辑 + 删除/上移/下移 → Task 6 ✅
- 双格式导出（Word/.md）→ Task 6（UI）+ Task 5（路径）+ Task 4（转换器）✅
- 真 .docx（docx + remark AST）→ Task 4 ✅
- `ProposalExportFormat = 'md' | 'docx'`、register 守卫、IPC payload 不变 → Task 5 ✅
- 错误处理（反馈条、空草稿、未知节点兜底）→ Task 6 + Task 4 ✅
- 验证（typecheck + dev 手动）→ Task 7 ✅
- 非目标（公司模板/TipTap/PDF/持久化）→ 计划未涉及 ✅

**Placeholder scan：** 无 TBD/TODO；每个 code step 均含完整代码与确切命令、预期输出。

**Type consistency：** `ProposalSection`、`appendSections`/`updateSection`/`removeSection`/`moveSection`、`extractProposalDraftBlocks`、`markdownToDocxBuffer`、`ProposalExportFormat` 在定义任务与消费任务间签名一致。`setDoc`/`docMarkdown` 的所有引用（FusionRuntimeProvider、ProposalDocPanel）均在 Task 3/6 同步迁移，无悬挂引用。

**已知风险（实施时验证）：** `docx` 版本的构造形参（numbering/bullet/Table）以安装版本类型为准，若与示例签名有出入按 typecheck 报错修正（Task 4 Step 4 已含此回退指引）；主题类名 `bg-card` 不存在时退回 `bg-muted`（Task 6 Step 2 已注明）。
