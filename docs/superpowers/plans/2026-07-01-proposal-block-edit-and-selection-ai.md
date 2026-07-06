# 写方案编辑重构：块渲染 + 选区即改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「写方案」编辑态从「整节一个源码 textarea」改成「块渲染 + 双击块就地手改 + 选中文字让 AI 就地改这几块」，不动数据模型/导出/持久化/哨兵管线。

**Architecture:** 新增一个纯函数分块器（`splitBlocks`/`joinBlocks`/`spliceBlocks`），编辑态 `ProposalPaper` 逐块渲染（DOM 块索引 ⇔ markdown 块索引天然对齐），块级手改与选区 AI 修订都只改「块」这个单位，重拼回整节 `markdown` 后走**现有** `updateSection`（防抖写盘）与 `pendingRevision` 分流（AI 整节替换扩展成块区间替换）。

**Tech Stack:** TypeScript、React 19、zustand、react-markdown（`AssistantMarkdown`）、bun test（唯一单测基建，仅 `shared/`）。

## Global Constraints

- 包管理器是 **bun**，不是 npm。单测：`bun test src/`（在 `apps/desktop/` 下跑）。
- 质量门只有 `bun run typecheck`（`tsc -p node` + `tsc -p web`）；**没有 ESLint**，只有 `shared/` 有 bun test。UI 任务以 typecheck + 人工 GUI 走查为准。
- 三进程模型：`ProposalPaper` / store / lib 都在 **renderer**（浏览器环境，禁 import Node 模块）；分块器放 `shared/`（node+web 双工程共享，纯函数不依赖浏览器/Node API）。
- **本计划不新增任何 IPC**：块手改复用 store `updateSection` + 现有 800ms 防抖写盘；块级 AI 修订复用 `sendProposalStageMessage` + `pendingRevision` 分流。
- 注释密度高，且解释「为什么这样而不是那样」——尤其分块边界规则、块级替换而非精确选区替换的理由。
- 数据模型不变：每节仍是一条 `markdown` 字符串（`ProposalSection.markdown` 是唯一真相源），分块只活在编辑态内存，不落盘、不进 `ProposalDraftRecord`。

---

## 影响文件

- **新增** `apps/desktop/src/shared/proposalBlocks.ts` — 分块器纯函数
- **新增** `apps/desktop/src/shared/proposalBlocks.test.ts` — bun test
- **改** `apps/desktop/src/renderer/src/stores/proposal.ts` — `pendingRevision` 类型扩展带 `blockRange`
- **改** `apps/desktop/src/renderer/src/lib/sendProposalSectionRevision.ts` — 新增 `reviseProposalSectionBlocks`
- **改** `apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx` — end 分流：`blockRange` 存在时块区间 splice
- **改** `apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx` — 逐块渲染 + 块级双击手改 + 整节源码逃生舱
- **新增** `apps/desktop/src/renderer/src/components/workspace/SelectionAiBubble.tsx` — 选区浮层

---

## Task 1: markdown 分块器（`proposalBlocks.ts`）

纯函数、可 bun test，是「块索引对齐」与「块区间替换」的地基。先做，后续 UI/AI 任务都依赖它。

**Files:**
- Create: `apps/desktop/src/shared/proposalBlocks.ts`
- Test: `apps/desktop/src/shared/proposalBlocks.test.ts`

**Interfaces:**
- Produces:
  - `splitBlocks(markdown: string): string[]`
  - `joinBlocks(blocks: string[]): string`
  - `spliceBlocks(markdown: string, range: { start: number; end: number }, replacement: string): string`

- [ ] **Step 1: 写失败测试**

`apps/desktop/src/shared/proposalBlocks.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'
import { splitBlocks, joinBlocks, spliceBlocks } from './proposalBlocks'

describe('splitBlocks', () => {
  it('空行分隔的段落各自成块', () => {
    expect(splitBlocks('第一段。\n\n第二段。')).toEqual(['第一段。', '第二段。'])
  })
  it('标题单独成块', () => {
    expect(splitBlocks('## 章节标题\n\n正文。')).toEqual(['## 章节标题', '正文。'])
  })
  it('围栏代码整体一块（内部空行不切）', () => {
    const md = '```mermaid\ngraph TD\n\nA-->B\n```'
    expect(splitBlocks(md)).toEqual([md])
  })
  it('GFM 表格整体一块', () => {
    const table = '| 列1 | 列2 |\n|---|---|\n| a | b |'
    expect(splitBlocks(`前言。\n\n${table}`)).toEqual(['前言。', table])
  })
  it('紧凑列表整体一块', () => {
    const list = '- 一\n- 二\n- 三'
    expect(splitBlocks(list)).toEqual([list])
  })
  it('松散列表（项间空行）不被拆散', () => {
    const list = '- 一\n\n- 二'
    expect(splitBlocks(list)).toEqual([list])
  })
  it('保留段末来源标注与图片行', () => {
    const md = '这段有依据。（据《白皮书》）\n\n![图](<kbasset://x/y.png>)'
    expect(splitBlocks(md)).toEqual(['这段有依据。（据《白皮书》）', '![图](<kbasset://x/y.png>)'])
  })
})

describe('joinBlocks 往返 + 幂等', () => {
  it('join(split(md)) 规范化后可再次 split 回同样的块（幂等）', () => {
    const md = '## 标题\n\n第一段。\n\n\n\n第二段。\n'
    const once = joinBlocks(splitBlocks(md))
    expect(once).toBe('## 标题\n\n第一段。\n\n第二段。')
    expect(joinBlocks(splitBlocks(once))).toBe(once)
  })
})

describe('spliceBlocks', () => {
  const md = 'A 段。\n\nB 段。\n\nC 段。'
  it('替换单块（start===end）只动那一块', () => {
    expect(spliceBlocks(md, { start: 1, end: 1 }, 'B 改。')).toBe('A 段。\n\nB 改。\n\nC 段。')
  })
  it('替换块区间为多块产出', () => {
    expect(spliceBlocks(md, { start: 0, end: 1 }, 'X1。\n\nX2。')).toBe('X1。\n\nX2。\n\nC 段。')
  })
  it('越界端点被夹紧', () => {
    expect(spliceBlocks(md, { start: 2, end: 99 }, 'C 改。')).toBe('A 段。\n\nB 段。\n\nC 改。')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

在 `apps/desktop/` 下运行：`bun test src/shared/proposalBlocks.test.ts`
Expected: FAIL（`Cannot find module './proposalBlocks'`）

- [ ] **Step 3: 写实现**

`apps/desktop/src/shared/proposalBlocks.ts`：

```ts
// 编辑态「块」= 一节 markdown 的顶层结构单元（标题/段落/列表/表格/围栏代码/图片行）。
// 逐块渲染让 DOM 块索引与本数组下标天然对齐——这是「选中文字/双击能精确定位到哪一块」
// 的地基。块只活在编辑态内存：手改/AI 改后一律 joinBlocks 重拼回整节 markdown（唯一真相源），
// 不落盘。之所以按「块」而非「精确字符选区」替换：选区纯文本 ↔ markdown 源码子串的映射会被
// 内联格式/来源标注/编号打乱，最脆；按块替换鲁棒得多（见 spec 关键取舍）。

const FENCE = /^```/
const TABLE_ROW = /^\s*\|/
const HEADING = /^#{1,6}\s/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const INDENT_CONT = /^\s+\S/ // 列表项的缩进续行

const isBlank = (s: string): boolean => s.trim() === ''

// 去每行尾空白 + 去块首尾空行，保留块内部结构（含围栏代码里的空行）。
function trimBlock(lines: string[]): string {
  const cleaned = lines.map((l) => l.replace(/\s+$/, ''))
  let a = 0
  let b = cleaned.length
  while (a < b && cleaned[a].trim() === '') a++
  while (b > a && cleaned[b - 1].trim() === '') b--
  return cleaned.slice(a, b).join('\n')
}

export function splitBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: string[] = []
  const n = lines.length
  let i = 0

  while (i < n) {
    if (isBlank(lines[i])) {
      i++ // 跳过块间空行
      continue
    }
    const start = i
    const line = lines[i]

    if (FENCE.test(line)) {
      // 围栏代码/mermaid：消费到配对 ``` （含），内部空行不切。
      i++
      while (i < n && !FENCE.test(lines[i])) i++
      if (i < n) i++ // 吃掉收尾 ```
    } else if (HEADING.test(line)) {
      i++ // 标题单行一块
    } else if (TABLE_ROW.test(line)) {
      while (i < n && TABLE_ROW.test(lines[i])) i++ // 连续 |…| 行
    } else if (LIST_ITEM.test(line)) {
      // 列表段：连续列表项 + 缩进续行 + 项间【单】空行（loose list 不被拆散）。
      i++
      while (i < n) {
        if (isBlank(lines[i])) {
          const j = i + 1
          if (j < n && !isBlank(lines[j]) && (LIST_ITEM.test(lines[j]) || INDENT_CONT.test(lines[j]))) {
            i++ // 项间单空行，并入列表段
            continue
          }
          break
        }
        if (LIST_ITEM.test(lines[i]) || INDENT_CONT.test(lines[i])) {
          i++
          continue
        }
        break
      }
    } else {
      // 段落：消费到下一空行或下一结构起点。
      i++
      while (
        i < n &&
        !isBlank(lines[i]) &&
        !HEADING.test(lines[i]) &&
        !FENCE.test(lines[i]) &&
        !TABLE_ROW.test(lines[i]) &&
        !LIST_ITEM.test(lines[i])
      ) {
        i++
      }
    }
    const blk = trimBlock(lines.slice(start, i))
    if (blk.length > 0) blocks.push(blk)
  }
  return blocks
}

// 块间用一个空行连接。过滤空块，逐块再去每行尾空白，保证 join(split()) 幂等。
export function joinBlocks(blocks: string[]): string {
  return blocks
    .map((b) => b.replace(/[ \t]+$/gm, ''))
    .filter((b) => b.trim().length > 0)
    .join('\n\n')
}

// 把 [range.start, range.end]（含端点）替换为 replacement（AI 产出，可多块），其余块原样保留。
// 越界端点夹紧到合法范围（防 stale range 越界）。
export function spliceBlocks(
  markdown: string,
  range: { start: number; end: number },
  replacement: string
): string {
  const blocks = splitBlocks(markdown)
  if (blocks.length === 0) return replacement.trim()
  const start = Math.max(0, Math.min(range.start, blocks.length - 1))
  const end = Math.max(start, Math.min(range.end, blocks.length - 1))
  const repl = splitBlocks(replacement)
  return joinBlocks([...blocks.slice(0, start), ...repl, ...blocks.slice(end + 1)])
}
```

- [ ] **Step 4: 跑测试确认通过**

Run（在 `apps/desktop/`）：`bun test src/shared/proposalBlocks.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 5: typecheck + 提交**

```bash
cd apps/desktop && bun run typecheck
git add apps/desktop/src/shared/proposalBlocks.ts apps/desktop/src/shared/proposalBlocks.test.ts
git commit -m "feat(proposal): markdown 分块器 splitBlocks/joinBlocks/spliceBlocks

编辑态逐块渲染/块级替换的地基。块只活内存、重拼回整节 markdown。
按块而非精确选区替换——避开选区↔源码子串脆映射。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: store `pendingRevision` 扩展带 `blockRange`

把定向修订指针从「只带 sectionId（整节替换）」扩展成「可选带 blockRange（块区间替换）」，其余分流逻辑在 Task 3。

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/proposal.ts`
- Modify: `apps/desktop/src/renderer/src/lib/sendProposalSectionRevision.ts:43,72`（call site 适配）

**Interfaces:**
- Consumes: 无（纯类型 + 已有 setter）
- Produces:
  - `pendingRevision: { sectionId: string; blockRange?: { start: number; end: number } } | null`
  - `setPendingRevision(pending: { sectionId: string; blockRange?: { start: number; end: number } } | null): void`

- [ ] **Step 1: 改类型定义（`ProposalState` 接口内）**

`stores/proposal.ts` 找到（约 78 行）：

```ts
  pendingRevision: { sectionId: string } | null
```

改为：

```ts
  // 定向修订指针：非空时下一轮 end 的 content 产出替换目标节。blockRange 缺省=整节替换
  // （节重写/展开/精简/据来源修正/截断续写/补料，向后兼容）；blockRange 存在=只替换该节的
  // 第 [start,end] 块（选区即改），由 FusionRuntimeProvider end 分流 spliceBlocks 拼回。瞬时
  // UI 信号，不持久化。
  pendingRevision: { sectionId: string; blockRange?: { start: number; end: number } } | null
```

找到（约 108 行）接口里的 setter 声明：

```ts
  setPendingRevision: (sectionId: string | null) => void
```

改为：

```ts
  setPendingRevision: (
    pending: { sectionId: string; blockRange?: { start: number; end: number } } | null
  ) => void
```

- [ ] **Step 2: 改 setter 实现**

`stores/proposal.ts` 找到（约 237-238 行）：

```ts
  setPendingRevision: (sectionId) =>
    set({ pendingRevision: sectionId ? { sectionId } : null }),
```

改为：

```ts
  setPendingRevision: (pending) => set({ pendingRevision: pending }),
```

- [ ] **Step 3: 适配现有两处 call site（传字符串 → 传对象）**

`lib/sendProposalSectionRevision.ts` 找到（约 43 行）`reviseProposalSection` 内：

```ts
  ps.setPendingRevision(sectionId)
```

改为：

```ts
  ps.setPendingRevision({ sectionId })
```

同文件找到（约 72 行）`fillProposalGap` 内的同一行 `ps.setPendingRevision(sectionId)`，同样改为 `ps.setPendingRevision({ sectionId })`。

> 注：`FusionRuntimeProvider.tsx` 里的 `setPendingRevision(null)` 三处不受影响（`null` 分支不变）。

- [ ] **Step 4: typecheck 确认无红**

Run（在 `apps/desktop/`）：`bun run typecheck`
Expected: PASS（若 call site 漏改会在此报「string 不能赋给对象」）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/renderer/src/stores/proposal.ts apps/desktop/src/renderer/src/lib/sendProposalSectionRevision.ts
git commit -m "feat(proposal): pendingRevision 扩展 blockRange（块区间替换指针）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 块级 AI 修订链路（发起 + end 分流 splice）

新增「选区即改」发起函数，并让 end 分流在 `blockRange` 存在时把 AI 产出 splice 进那几块。

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/sendProposalSectionRevision.ts`
- Modify: `apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx:1237-1245`

**Interfaces:**
- Consumes: `splitBlocks`, `spliceBlocks`（Task 1）；`setPendingRevision({sectionId, blockRange})`（Task 2）
- Produces:
  - `type BlockReviseAction = 'polish' | 'shorten' | 'expand' | 'rewrite' | 'fixSource' | 'custom'`
  - `reviseProposalSectionBlocks(sectionId: string, blockRange: { start: number; end: number }, action: BlockReviseAction, selectedText: string, customInstruction?: string): Promise<void>`

- [ ] **Step 1: 在 `sendProposalSectionRevision.ts` 顶部补 import**

找到（第 2 行）：

```ts
import { USER_SUPPLIED_SOURCE } from '@shared/proposal'
```

其后补一行：

```ts
import { splitBlocks } from '@shared/proposalBlocks'
```

- [ ] **Step 2: 在 `sendProposalSectionRevision.ts` 末尾追加块级修订函数**

```ts
/**
 * 选区即改（Canvas/Artifacts 式）：用户在编辑态选中一段文字，对【选区覆盖的那一/几个块】
 * 发起定向修订。与 reviseProposalSection（整章）的区别只在作用域——这里置
 * pendingRevision.blockRange，end 分流用 spliceBlocks 只把 AI 产出拼回那几块、本章其余内容
 * 原样不动。selectedText 作为「用户特别想改的这句」焦点提示传给 AI，但替换单位仍是【块】
 * （见 proposalBlocks.ts 注释：按块替换避开选区↔源码子串脆映射）。
 *
 * 仅对 content 节生效；非方案前台 / 目标节不存在 / 指令为空时静默 no-op。
 */
export type BlockReviseAction = 'polish' | 'shorten' | 'expand' | 'rewrite' | 'fixSource' | 'custom'

const BLOCK_ACTION_INSTRUCTION: Record<Exclude<BlockReviseAction, 'custom'>, string> = {
  polish: '润色下面这一小段：改善措辞与流畅度，保持原意与信息量不变',
  shorten: '精简下面这一小段：删去冗余与重复，只留要点',
  expand: '把下面这一小段写得更详尽（补充细节、数据、案例），但严禁引入知识库之外的内容',
  rewrite: '重写下面这一小段，换一种更好的组织方式与措辞，质量更高',
  fixSource:
    '下面这一小段里有内容在所引《来源》原文中找不到依据（疑似编造或过度改写），请严格只依据所引文件原文重写，凡无来源支撑的表述一律删除或改写'
}

export async function reviseProposalSectionBlocks(
  sectionId: string,
  blockRange: { start: number; end: number },
  action: BlockReviseAction,
  selectedText: string,
  customInstruction?: string
): Promise<void> {
  const ps = useProposalStore.getState()
  const sec = ps.sections.find((s) => s.id === sectionId)
  if (!sec || sec.kind !== 'content') return

  const blocks = splitBlocks(sec.markdown)
  if (blocks.length === 0) return
  const start = Math.max(0, Math.min(blockRange.start, blocks.length - 1))
  const end = Math.max(start, Math.min(blockRange.end, blocks.length - 1))
  const context = blocks.slice(start, end + 1).join('\n\n')

  const instruction =
    action === 'custom' ? (customInstruction ?? '').trim() : BLOCK_ACTION_INSTRUCTION[action]
  if (!instruction) return
  const focus = selectedText.trim()

  // 置块区间指针：本轮 end 的 content 产出 spliceBlocks 进 [start,end]（其余块不动）。
  ps.setPendingRevision({ sectionId, blockRange: { start, end } })
  await sendProposalStageMessage(
    `【定向修订·只重写下面这一小段，不要改动本章其它内容、更不要动其它章节】${instruction}。\n\n` +
      (focus ? `用户特别想改的是这句：「${focus}」。\n\n` : '') +
      `这一小段的原文如下：\n\n${context}\n\n` +
      `只输出【重写后的这一小段本身】（不要重复章节标题、不要写章节序号），仍用方案【正文】哨兵包裹，` +
      `段末按既有规则标注《来源》，绝不臆造知识库之外的内容。`
  )
}
```

- [ ] **Step 3: 改 `FusionRuntimeProvider.tsx` end 分流——补 import**

找到（第 23 行）：

```ts
import { extractProposalDraftResult, detectContentSentinelAheadOfPhase } from '@shared/proposal'
```

其后补一行：

```ts
import { spliceBlocks } from '@shared/proposalBlocks'
```

- [ ] **Step 4: 改 end 分流——`blockRange` 存在时走 splice**

`FusionRuntimeProvider.tsx` 找到（约 1242-1245 行）：

```ts
              if (pending && target && revised) {
                useProposalStore.getState().setPendingRevision(null)
                useProposalStore.getState().reviseSection(pending.sectionId, revised.markdown)
                triggerProposalCitationVerification()
              } else if (pending && target) {
```

改为：

```ts
              if (pending && target && revised) {
                useProposalStore.getState().setPendingRevision(null)
                // blockRange 存在=选区即改：只把 AI 产出 spliceBlocks 进目标节的那几块，本章
                // 其余内容原样保留；缺省=整章替换（节重写/展开/精简/据来源修正/截断/补料）。
                // 两路都落 reviseSection（重置 verification 触发重校验、更新 baseline、清 truncated）。
                const nextMarkdown = pending.blockRange
                  ? spliceBlocks(target.markdown, pending.blockRange, revised.markdown)
                  : revised.markdown
                useProposalStore.getState().reviseSection(pending.sectionId, nextMarkdown)
                triggerProposalCitationVerification()
              } else if (pending && target) {
```

- [ ] **Step 5: typecheck 确认无红**

Run（在 `apps/desktop/`）：`bun run typecheck`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/renderer/src/lib/sendProposalSectionRevision.ts apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx
git commit -m "feat(proposal): 块级 AI 修订链路——选区即改只替换那几块

reviseProposalSectionBlocks 置 blockRange 指针，end 分流 spliceBlocks 拼回。
选中文字作焦点提示，替换单位仍是块。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `ProposalPaper` 逐块渲染 + 双击块就地手改

编辑态每节从「整节一个 AssistantMarkdown / 整节一个 textarea」改为「逐块渲染，双击某块就地改那一块」，并保留「编辑整节源码」逃生舱。UI 任务，无 bun test；以 typecheck + GUI 走查为准。

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx`

**Interfaces:**
- Consumes: `splitBlocks`, `joinBlocks`（Task 1）；store `updateSection`（现有）
- Produces: 渲染出的每个块容器带 `data-section-id={sec.id}` 与 `data-block-index={bi}`（Task 5 的选区映射靠它）

- [ ] **Step 1: 补 import**

`ProposalPaper.tsx` 顶部 import 区补：

```ts
import { splitBlocks, joinBlocks } from '@shared/proposalBlocks'
```

- [ ] **Step 2: 加块编辑态 state**

`ProposalPaper` 组件内，找到（约 135 行）：

```ts
  const [editingId, setEditingId] = useState<string | null>(null)
```

其后补：

```ts
  // 块级就地手改（命中「改动粒度太粗」）：双击某块 → 只有那一块变 textarea。editingId（整节
  // 源码逃生舱）与 editingBlock 互斥——进整节源码时清块编辑，反之亦然。blockDraft 是就地草稿，
  // 失焦/⌘↵ 提交、Esc 取消；提交时替换该块 → joinBlocks 重拼 → updateSection（走现有防抖写盘）。
  const [editingBlock, setEditingBlock] = useState<{ sectionId: string; blockIndex: number } | null>(null)
  const [blockDraft, setBlockDraft] = useState('')

  // 提交块草稿：把 sec 的第 blockIndex 块替换成 blockDraft，重拼回整节 markdown。
  function commitBlock(sec: ProposalSection, blockIndex: number): void {
    const blocks = splitBlocks(sec.markdown)
    if (blockIndex < 0 || blockIndex >= blocks.length) {
      setEditingBlock(null)
      return
    }
    blocks[blockIndex] = blockDraft
    updateSection(sec.id, joinBlocks(blocks))
    setEditingBlock(null)
  }
```

- [ ] **Step 3: 把「铅笔（编辑整节）」按钮改成「编辑整节源码」逃生舱语义**

找到（约 212-218 行）节级工具条里的编辑按钮：

```ts
        <button
          className={toolBtn}
          onClick={() => setEditingId(editingId === sec.id ? null : sec.id)}
          aria-label={editingId === sec.id ? '完成' : '编辑'}
        >
          {editingId === sec.id ? <CheckIcon /> : <PencilIcon />}
        </button>
```

改为（进整节源码时先清块编辑，保持互斥）：

```ts
        <button
          className={toolBtn}
          onClick={() => {
            setEditingBlock(null)
            setEditingId(editingId === sec.id ? null : sec.id)
          }}
          title={editingId === sec.id ? '完成整节源码编辑' : '编辑整节 Markdown 源码（逃生舱）'}
          aria-label={editingId === sec.id ? '完成' : '编辑整节源码'}
        >
          {editingId === sec.id ? <CheckIcon /> : <PencilIcon />}
        </button>
```

- [ ] **Step 4: 替换节正文渲染——整节 textarea / 逐块渲染二选一**

找到（约 283-292 行）：

```ts
      {editingId === sec.id ? (
        <textarea
          className="min-h-[120px] w-full resize-none rounded-sm bg-accent/5 font-serif text-[14px] leading-[1.95] text-[#1d1d1f] outline-none"
          value={sec.markdown}
          autoFocus
          onChange={(e) => updateSection(sec.id, e.target.value)}
        />
      ) : (
        <AssistantMarkdown text={sec.markdown} highlightCitations />
      )}
```

改为：

```ts
      {editingId === sec.id ? (
        // 整节源码逃生舱：改坏的表格、批量替换等场景。默认不再是主路径。
        <textarea
          className="min-h-[120px] w-full resize-y rounded-sm bg-accent/5 font-mono text-[13px] leading-[1.8] text-[#1d1d1f] outline-none"
          value={sec.markdown}
          autoFocus
          onChange={(e) => updateSection(sec.id, e.target.value)}
        />
      ) : (
        // 逐块渲染：DOM 块索引 = splitBlocks 下标（Task 5 选区映射靠 data-block-index）。
        // 双击某块 → 只有那一块进就地编辑；其余块照常渲染（含来源高亮）。
        splitBlocks(sec.markdown).map((blk, bi) =>
          editingBlock && editingBlock.sectionId === sec.id && editingBlock.blockIndex === bi ? (
            <textarea
              key={bi}
              className="my-1 min-h-[64px] w-full resize-y rounded-sm bg-accent/5 font-serif text-[14px] leading-[1.95] text-[#1d1d1f] outline-none"
              value={blockDraft}
              autoFocus
              onChange={(e) => setBlockDraft(e.target.value)}
              onBlur={() => commitBlock(sec, bi)}
              onKeyDown={(e) => {
                // ⌘↵/Ctrl↵ 提交；Esc 取消（不写回）。普通回车留给多行输入。
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  commitBlock(sec, bi)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditingBlock(null)
                }
              }}
            />
          ) : (
            <div
              key={bi}
              data-section-id={sec.id}
              data-block-index={bi}
              className="rounded-sm hover:bg-accent/[0.03]"
              // 双击进块级就地手改：读该块源码进草稿、清整节源码逃生舱（互斥）。生成中禁改。
              onDoubleClick={() => {
                if (generating) return
                setEditingId(null)
                setBlockDraft(blk)
                setEditingBlock({ sectionId: sec.id, blockIndex: bi })
              }}
            >
              <AssistantMarkdown text={blk} highlightCitations />
            </div>
          )
        )
      )}
```

- [ ] **Step 5: typecheck**

Run（在 `apps/desktop/`）：`bun run typecheck`
Expected: PASS

- [ ] **Step 6: GUI 走查（dev）**

Run：`bun run dev`，进入某会话「写方案」，生成含多段/列表/表格的正文后，在编辑态验证：
- 每段/列表/表格各自可 hover（浅底），**双击某段**只有那一段变 textarea，改字后失焦/⌘↵ 提交、内容更新且排版恢复，Esc 取消不写回。
- 节级工具条的「铅笔」进入**整节源码**（等宽字体），与块编辑互斥。
- 表格/图片/mermaid 块双击显示其源码、提交不破坏结构。
- 生成中（AI 在写）双击不进编辑。
Expected: 全部符合；无控制台报错。

- [ ] **Step 7: 提交**

```bash
git add apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx
git commit -m "feat(proposal): 编辑态逐块渲染 + 双击块就地手改 + 整节源码逃生舱

改动粒度从整章降到块；每块带 data-block-index 供选区映射。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 选区浮层 `SelectionAiBubble`（选区即改）

在编辑纸面上选中文字 → 贴选区浮出气泡：快捷动作 + 自由指令，作用于选区覆盖的块区间。UI 任务，无 bun test；typecheck + GUI 走查为准。

**Files:**
- Create: `apps/desktop/src/renderer/src/components/workspace/SelectionAiBubble.tsx`
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx`（挂载浮层 + 给滚动容器加 ref）

**Interfaces:**
- Consumes: `reviseProposalSectionBlocks`, `BlockReviseAction`（Task 3）；`data-section-id`/`data-block-index`（Task 4）
- Produces: `<SelectionAiBubble containerRef={RefObject<HTMLDivElement | null>} disabled={boolean} />`

- [ ] **Step 1: 建组件**

`apps/desktop/src/renderer/src/components/workspace/SelectionAiBubble.tsx`：

```ts
import { useEffect, useRef, useState } from 'react'
import { reviseProposalSectionBlocks, type BlockReviseAction } from '../../lib/sendProposalSectionRevision'

// 选区即改浮层：监听编辑纸面内的选区，选中一段正文文字后贴选区尾浮出气泡。作用域=选区覆盖的
// 块区间（从选区两端向上找最近 data-block-index），替换单位是块（见 proposalBlocks.ts 理由）。
// 只对同一节 content 内的选区生效；跨节 / 封面目录 / 空选区 / disabled（生成中）一律不显。

interface Anchor {
  sectionId: string
  start: number
  end: number
  selectedText: string
  // 相对滚动容器的定位（容器为 relative）。
  left: number
  top: number
}

// 从选区端点节点向上找最近带 data-block-index 的块容器，读出 sectionId + blockIndex。
function resolveBlock(node: Node | null): { sectionId: string; blockIndex: number } | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null
  const blk = el?.closest<HTMLElement>('[data-block-index]')
  if (!blk) return null
  const sectionId = blk.getAttribute('data-section-id')
  const idx = blk.getAttribute('data-block-index')
  if (sectionId == null || idx == null) return null
  return { sectionId, blockIndex: Number(idx) }
}

const QUICK: Array<{ action: Exclude<BlockReviseAction, 'custom'>; label: string }> = [
  { action: 'polish', label: '润色' },
  { action: 'shorten', label: '精简' },
  { action: 'expand', label: '扩写' },
  { action: 'rewrite', label: '改写' },
  { action: 'fixSource', label: '据来源修正' }
]

export function SelectionAiBubble({
  containerRef,
  disabled
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  disabled: boolean
}): React.JSX.Element | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [instruction, setInstruction] = useState('')
  const bubbleRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    function recompute(): void {
      if (disabled) {
        setAnchor(null)
        return
      }
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setAnchor(null)
        return
      }
      const text = sel.toString().trim()
      if (!text) {
        setAnchor(null)
        return
      }
      const range = sel.getRangeAt(0)
      // 选区必须落在本容器内（别被聊天区/其它面板的选区触发）。
      if (!container.contains(range.commonAncestorContainer)) {
        setAnchor(null)
        return
      }
      const a = resolveBlock(range.startContainer)
      const b = resolveBlock(range.endContainer)
      if (!a) {
        setAnchor(null)
        return
      }
      // 跨节选区：吸附到起点所在节，end 夹到该节内（b 若在别节则退化为单块起点）。
      const sameSection = b && b.sectionId === a.sectionId
      const start = Math.min(a.blockIndex, sameSection ? b.blockIndex : a.blockIndex)
      const end = Math.max(a.blockIndex, sameSection ? b.blockIndex : a.blockIndex)
      // 定位：选区包围盒尾部，换算成容器相对坐标（容器 relative + 自身滚动）。
      const rect = range.getBoundingClientRect()
      const cRect = container.getBoundingClientRect()
      setAnchor({
        sectionId: a.sectionId,
        start,
        end,
        selectedText: text,
        left: rect.left - cRect.left + container.scrollLeft,
        top: rect.bottom - cRect.top + container.scrollTop + 6
      })
    }

    // 滚动/选区变化都重算（滚动时选区不变但坐标要跟）。点进气泡自身不清（下方 mousedown 拦截）。
    document.addEventListener('selectionchange', recompute)
    container.addEventListener('scroll', recompute)
    return () => {
      document.removeEventListener('selectionchange', recompute)
      container.removeEventListener('scroll', recompute)
    }
  }, [containerRef, disabled])

  if (!anchor) return null

  async function fire(action: BlockReviseAction): Promise<void> {
    if (!anchor) return
    await reviseProposalSectionBlocks(
      anchor.sectionId,
      { start: anchor.start, end: anchor.end },
      action,
      anchor.selectedText,
      action === 'custom' ? instruction : undefined
    )
    // 发起后收起浮层、清指令与选区。
    setInstruction('')
    setAnchor(null)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div
      ref={bubbleRef}
      className="proposal-anim-pop absolute z-40 w-72 rounded-lg border border-border bg-background p-1.5 text-foreground shadow-lg"
      style={{ left: anchor.left, top: anchor.top }}
      // 阻止 mousedown 清掉选区（否则点按钮前选区先没了）。
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-1 text-accent">
        <span className="px-1 text-[12px]">✦</span>
        {QUICK.map((q) => (
          <button
            key={q.action}
            type="button"
            className="rounded px-1.5 py-0.5 text-[12px] text-foreground hover:bg-muted"
            onClick={() => void fire(q.action)}
            title={`让 AI ${q.label}选中的这段`}
          >
            {q.label}
          </button>
        ))}
      </div>
      <div className="mt-1 flex items-center gap-1">
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && instruction.trim()) {
              e.preventDefault()
              void fire('custom')
            }
          }}
          placeholder="告诉 AI 怎么改这段…"
          className="h-7 flex-1 rounded-md border border-border bg-card px-2 text-[12px] outline-none focus:border-accent"
        />
        <button
          type="button"
          className="rounded bg-accent px-2 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
          disabled={!instruction.trim()}
          onClick={() => void fire('custom')}
        >
          改
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 在 `ProposalPaper` 挂载浮层 + 给滚动容器加 ref**

`ProposalPaper.tsx` 补 import：

```ts
import { useEffect, useRef, useState } from 'react'
import { SelectionAiBubble } from './SelectionAiBubble'
```

（若已 `import { useEffect, useState } from 'react'`，把它并成含 `useRef` 的那行。）

找到（约 298 行）最外层滚动容器：

```ts
  return (
    <div className="proposal-canvas flex-1 overflow-auto py-7">
```

改为（加 ref + relative 作浮层定位锚）：

```ts
  const canvasRef = useRef<HTMLDivElement | null>(null)
  return (
    <div ref={canvasRef} className="proposal-canvas relative flex-1 overflow-auto py-7">
```

在该滚动容器的**闭合 `</div>` 之前**（即 `.proposal-paper` 之后、`.proposal-canvas` 收尾前）挂浮层：

```ts
        {/* 选区即改浮层：贴选区尾浮出，作用于选区覆盖的块区间。生成中禁用（与块手改一致）。 */}
        <SelectionAiBubble containerRef={canvasRef} disabled={generating} />
      </div>
    </div>
  )
```

> 注意闭合层级：`SelectionAiBubble` 要放在 `ref={canvasRef}` 那个 `div` 内部（定位锚是它），在内层 `.proposal-paper` `</div>` 之后。

- [ ] **Step 3: typecheck**

Run（在 `apps/desktop/`）：`bun run typecheck`
Expected: PASS

- [ ] **Step 4: GUI 走查（dev）**

Run：`bun run dev`，编辑态：
- 在某段正文里**选中一句话** → 气泡贴选区下方浮出；点「润色/精简/扩写/改写」→ AI 只改这一段（本章其余不动），改后来源红/绿条随之刷新。
- 「据来源修正」对有溯源问题的段生效。
- 自由输入「把语气改得更正式」回车 → 只改这段。
- 选中**跨两段**文字 → 作用于这两块整体替换。
- 选区落在**封面/目录**：`reviseProposalSectionBlocks` 对非 content 静默 no-op（气泡可显示但点击无效——可接受；实现如需可进一步在气泡侧隐藏，属开放项）。
- 滚动纸面时气泡跟随选区；点空白/取消选区气泡消失；点气泡内按钮时选区不丢。
- 生成中不浮气泡。
Expected: 全部符合；无控制台报错。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/renderer/src/components/workspace/SelectionAiBubble.tsx apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx
git commit -m "feat(proposal): 选区即改浮层——选中文字让 AI 就地改这几块（Canvas 式）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 收尾验证（全部任务后）

- [ ] `cd apps/desktop && bun test src/` — 分块器全绿。
- [ ] `cd apps/desktop && bun run typecheck` — node + web 两工程无红。
- [ ] 完整 GUI 走查一遍（Task 4 Step 6 + Task 5 Step 4 的清单合并），确认块手改、选区五动作 + 自由指令、跨块、整节源码逃生舱、生成中禁用、改后重校验红/绿条刷新、导出/预览仍正常。
- [ ] 按全局 CLAUDE.md 规范把本次要点写进 Obsidian vault 的 sessions/，与既有 [[proposal-*]] 记忆互加双链。

## 自查（对照 spec）

- **粒度太粗** → Task 4（双击块就地手改）+ Task 5（选区 AI 作用于块区间）覆盖。
- **AI 入口不好用** → Task 5 选区浮层（快捷动作 + 自由指令）覆盖。
- **不动数据模型/导出/持久化/哨兵** → 分块只在编辑态内存，手改走 `updateSection`、AI 走 `pendingRevision`+`reviseSection`，均消费/产出整节 `markdown`，无 schema/IPC 变更。
- **AI 替换单位=块（选区作焦点提示）** → Task 3 `reviseProposalSectionBlocks` + end 分流 `spliceBlocks`。
- **保留整节源码逃生舱** → Task 4 Step 3/4。
- **往返无损** → Task 1 bun test（幂等 + 结构用例 + splice）。
- **生成中禁用** → Task 4 双击 `if (generating) return`、Task 5 `disabled={generating}`。
- **开放项**（浮层定位避让、封面目录气泡隐藏、提示词措辞微调）留实现时定，不阻塞。
