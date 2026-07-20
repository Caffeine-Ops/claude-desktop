# 写方案·选区改写排队 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"选区即改"（选中一段让 AI 润色）在 AI 忙时不再被拒绝，而是把后续指令排进一个 FIFO 队列，一轮结束自动串行发起下一个。

**Architecture:** 新增一个 per-session 的"改写队列"（存在 proposal store 里）。用户在 AI 生成中选中新段落并点"排队改写"时，把 `{sectionId, selectedText, instruction}` 入队——**故意不存块序号 `blockRange`**，因为草稿在排队期间可能变化、序号会漂。等当前这一轮 `end` 走完、`streaming` 落回 false，一个"排空"函数取出队头，用 `selectedText` 在**最新** section markdown 里重新定位出 `blockRange`，再复用现有的 `reviseProposalSectionBlocks` 发起。这样执行永远串行（单个 fusion-code 子进程一次只能跑一轮），且每个任务在真正执行前才锚定位置，对块漂移免疫。

**Tech Stack:** TypeScript / React 19 / zustand / bun:test。零新增 IPC、零新增 SDK schema——全部复用现有聊天发送链路（`window.chatApi.send`）与选区改写链路。

## Global Constraints

- **包管理器是 bun，不是 npm。** 所有命令用 `bun`。
- **单测框架是 `bun:test`**，import 用同目录相对路径（见 `apps/studio/electron/shared/proposalBlocks.test.ts`）。测试命令：在 `apps/studio` 目录下跑 `bun test electron/ src/chat/lib`（见 `apps/studio/package.json:30`）。
- **纯函数进 `electron/shared/`**（三端共用、可单测）；**store 状态进 `apps/studio/src/chat/stores/proposal.ts`**；**React 交互进 `apps/studio/src/chat/components/`**。禁止在 shared/store 里 import React。
- **类型检查是唯一自动化防线**：改完跑 `bun run typecheck`（根目录），必须零错。
- **只做"选区块改写"的排队**（`SelectionAiBubble` → `reviseProposalSectionBlocks` 这条路）。整章修订（`reviseProposalSection`）、补料（`startProposalGapFill`）、图片生成/上传**本次不排队**，维持"忙时禁用"现状——它们的锚点语义不同，混进来会放大风险。方案末尾"未来扩展"记了如何延伸。
- **队列是瞬时 UI 信号，不持久化**（同 `blockReviews`/`pendingRevision`）——不进 `ProposalDraftRecord`，重开会话不复现。理由：未发出的改写意图跨会话留存反直觉。
- **串行不变量**：任一时刻最多一个改写在飞。排空函数发起一个后必须等它的 `end` 才发下一个；发起前再查一次 `streaming` 保险，绝不并发 `send`。

## 关键背景（实现者必读，零上下文假设）

现状数据流（改造前）：
1. 用户在纸面选中文字 → `SelectionAiBubble`（`apps/studio/src/chat/components/workspace/SelectionAiBubble.tsx`）冒出气泡，算出 `anchor = {sectionId, start, end, selectedText}`。
2. 点"开始改写" → `fire()` 调 `reviseProposalSectionBlocks(sectionId, {start,end}, instruction, selectedText)`（`apps/studio/src/chat/lib/sendProposalSectionRevision.ts:168`）。
3. 该函数 → `dispatchSectionRevision`：**若 `streaming` 为真直接 `console.warn` 后 return（当场拒绝，不排队）**（`sendProposalSectionRevision.ts:40-43`）→ 否则 `setPendingRevision({sectionId, blockRange})` + `sendProposalStageMessage(...)` 发消息。
4. `streaming` 存在 `apps/studio/src/chat/stores/chat.ts` 的 per-session 态；`'start'` 事件置 true、`endAssistantMessage` 置 false。
5. AI 回完 → `FusionRuntimeProvider`（`apps/studio/src/chat/runtime/FusionRuntimeProvider.tsx`）的 `'end'` 分支（~1780 行）读 `pendingRevision.blockRange`，把"原文 vs 改写后"登记成一条 `blockReview`（**不即时落地**），`finally` 里 `endAssistantMessage(sid)` 置 `streaming=false`（~1869 行）。
6. `blockReviews` 是 `Record<messageId, BlockRevisionReview>`（`stores/proposal.ts:156`），**可同时挂多条**。审阅卡 `ProposalRevisionReview`（`components/chat/ThreadView/AssistantMessage.tsx:506`）渲染对照 + [应用/放弃/继续改]，点"应用"才 `spliceBlocks` 落地。

"锁住不能再选新段落"的直接成因：`SelectionAiBubble` 的 effect 在 `disabled`（=generating=streaming）为真时 `setAnchor(null)` 并**不订阅选区**（`SelectionAiBubble.tsx:88-95`）。

现有可复用零件：
- `splitBlocks(markdown): string[]`（`electron/shared/proposalBlocks.ts:27`）：把一节 markdown 切成顶层块数组。
- `spliceBlocks` / `joinBlocks`：同文件。
- `useSessionQueue` / `optimisticEnqueue` 模式（`stores/messageQueue.ts`）：普通聊天排队的样板，本方案的队列 store 照它的选择器稳定空数组写法。

---

### Task 1: 选区文本重定位纯函数 `locateBlockRangeByText`

排空队头时，要用当初选中的文字在**最新** markdown 里重新找出它落在第几到第几块。块序号会因前面的改写落地而漂移，文字内容不会——所以用文字重定位。

**Files:**
- Modify: `apps/studio/electron/shared/proposalBlocks.ts`（在 `spliceBlocks` 之后追加导出函数）
- Test: `apps/studio/electron/shared/proposalBlocks.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: `splitBlocks(markdown: string): string[]`（本文件已有）
- Produces: `locateBlockRangeByText(markdown: string, selectedText: string): { start: number; end: number } | null` — 返回覆盖 `selectedText` 的最小连续块区间（含端点）；文字找不到返回 `null`。规范化：比较前把两侧的所有空白字符（含换行）去掉，因为选区取到的文本换行/空格被浏览器折叠过，与源码 markdown 的空白不一致。多处命中取第一处。

- [ ] **Step 1: 写失败测试**

在 `apps/studio/electron/shared/proposalBlocks.test.ts` 末尾追加：

```typescript
import { splitBlocks, joinBlocks, spliceBlocks, locateBlockRangeByText } from './proposalBlocks'
// ^ 若文件顶部已有 import，改成把 locateBlockRangeByText 加进同一行，别重复 import

describe('locateBlockRangeByText', () => {
  const md = ['# 标题', '第一段讲的是产品背景。', '第二段讲的是技术方案。', '第三段讲的是落地计划。'].join('\n\n')

  it('单块命中：定位到该块', () => {
    expect(locateBlockRangeByText(md, '第二段讲的是技术方案。')).toEqual({ start: 2, end: 2 })
  })

  it('选区文本的空白被折叠也能命中（换行 vs 源码空行）', () => {
    // 浏览器选区常把块间空行变成一个空格或直接相连
    expect(locateBlockRangeByText(md, '第一段讲的是产品背景。 第二段讲的是技术方案。')).toEqual({ start: 1, end: 2 })
  })

  it('跨块选区：返回覆盖它的最小连续区间', () => {
    expect(locateBlockRangeByText(md, '技术方案。第三段')).toEqual({ start: 2, end: 3 })
  })

  it('文字已不存在（被上一轮改写覆盖）：返回 null', () => {
    expect(locateBlockRangeByText(md, '这段文字草稿里根本没有')).toBeNull()
  })

  it('空 markdown / 空选区：返回 null', () => {
    expect(locateBlockRangeByText('', '任意')).toBeNull()
    expect(locateBlockRangeByText(md, '   ')).toBeNull()
  })

  it('多处命中取第一处', () => {
    const dup = ['复用段。', '中间段。', '复用段。'].join('\n\n')
    expect(locateBlockRangeByText(dup, '复用段。')).toEqual({ start: 0, end: 0 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

在 `apps/studio` 目录：
```bash
cd apps/studio && bun test electron/shared/proposalBlocks.test.ts
```
Expected: FAIL，报 `locateBlockRangeByText is not a function` / 导出不存在。

- [ ] **Step 3: 写最小实现**

在 `apps/studio/electron/shared/proposalBlocks.ts` 的 `spliceBlocks` 函数之后追加：

```typescript
// 用"当初选中的文字"在最新 markdown 里重新定位块区间（排队改写排空时用）。
// 为什么按文字重定位而非直接存块序号：排队期间前面的改写可能落地、块数变化，序号会漂到别处、
// 改错段落；文字内容不漂。规范化去掉两侧所有空白后比较——浏览器选区把块间空行折叠成空格/直接
// 相连，与源码 markdown 的空白不一致，不去空白会永远匹配不上。
//
// 算法：切块后把每块规范化文本顺次拼成一条长串，同时记住每块在长串里的字符区间；在长串里
// indexOf(规范化选区文本)，命中区间的首尾字符各落在哪个块，就是 [start,end]。找不到 → null。
// 多处命中取第一处（indexOf 语义），第一版够用。
export function locateBlockRangeByText(
  markdown: string,
  selectedText: string
): { start: number; end: number } | null {
  const norm = (s: string): string => s.replace(/\s+/g, '')
  const needle = norm(selectedText)
  if (!needle) return null
  const blocks = splitBlocks(markdown)
  if (blocks.length === 0) return null

  // 每块规范化文本 + 它在拼接长串里的 [起, 止) 字符区间。
  let hay = ''
  const spans: Array<{ start: number; end: number }> = []
  for (const blk of blocks) {
    const nb = norm(blk)
    const begin = hay.length
    hay += nb
    spans.push({ start: begin, end: hay.length }) // [begin, hay.length)
  }

  const at = hay.indexOf(needle)
  if (at < 0) return null
  const hitStart = at
  const hitEnd = at + needle.length - 1 // 命中末字符下标（含）

  // 找命中首/末字符各自落在哪个块。空块（nb 为空、span.start===span.end）跳过。
  let start = -1
  let end = -1
  for (let k = 0; k < spans.length; k++) {
    const sp = spans[k]
    if (sp.start === sp.end) continue // 规范化后为空的块不参与
    if (start < 0 && hitStart < sp.end) start = k
    if (hitEnd < sp.end) {
      end = k
      break
    }
  }
  if (start < 0) return null
  if (end < 0) end = blocks.length - 1 // 命中延伸到末尾（理论兜底）
  return { start, end }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/studio && bun test electron/shared/proposalBlocks.test.ts
```
Expected: PASS，全部 `locateBlockRangeByText` 用例绿。

- [ ] **Step 5: 提交**

```bash
git add apps/studio/electron/shared/proposalBlocks.ts apps/studio/electron/shared/proposalBlocks.test.ts
git commit -m "feat(proposal): locateBlockRangeByText 按选中文字重定位块区间（排队改写地基）"
```

---

## CEO 评审硬化护栏 → 落点映射（HOLD SCOPE 模式产出）

本方案经 `/plan-ceo-review` 守范围评审，7 条护栏已并入下列 Task。此表供实现者核对覆盖：

| # | 护栏 | 落点 |
|---|------|------|
| 1 | 并发排空闸（防 end 双触发导致两个改写同时在飞，破坏"一次一个"铁律） | Task 3（模块级 `draining` 闸 + pendingRevision 兜底） |
| 2 | 丢弃可见提示（重定位失败不能只 console.warn 静默丢） | Task 2 加 `revisionQueueNotice` 字段 + Task 3 置文案 + Task 5 渲染 |
| 3 | 多处命中消歧（selectedText 出现多次时按 hint 选最近处，别定位到错的一处） | Task 6（给 `locateBlockRangeByText` 加可选 `hint` 参数 + Task 2 队列项存 `hintRange`） |
| 4 | 审阅卡冲突拦截（同几块已有待审阅卡时拦下新排队，防应用顺序错乱） | Task 7 |
| 5 | 队列软上限（每项都是一轮真金白银 AI，防手抖排 50 个） | Task 5（enqueue 前查 `MAX_QUEUE`，满则提示不入队） |
| 6 | 失败重排（send 抛错时也 endAssistantMessage + 重新调度排空，防队列停摆） | Task 3（drain 内 `try/catch` + 兜底重排） |
| 7 | 实机 QA 走查（生成中选区是否真可选、气泡贴位不乱跳） | Task 8（合并前 `/qa`，非代码 Task） |

---

### Task 2: proposal store 里的改写队列（字段 + actions + 丢弃提示）

队列存在 proposal store（它本就绑单个方案会话）。存 `{id, sectionId, selectedText, instruction, hintRange}`——`hintRange` 是入队那一刻的块区间**仅作重定位歧义时的裁判**（护栏 #3），真正定位仍靠 `selectedText`。另加一个 `revisionQueueNotice` 字段承载"某项被跳过"的可见提示（护栏 #2）。

**Files:**
- Modify: `apps/studio/src/chat/stores/proposal.ts`
- Test: `apps/studio/src/chat/stores/proposal.queue.test.ts`（新建）

**Interfaces:**
- Produces:
  - `interface QueuedRevision { id: string; sectionId: string; selectedText: string; instruction: string; hintRange: { start: number; end: number } }`
  - state `revisionQueue: QueuedRevision[]`、`revisionQueueNotice: string | null`
  - `enqueueRevision(item: Omit<QueuedRevision, 'id'>): string`
  - `dequeueRevision(): QueuedRevision | null`
  - `removeRevision(id: string): void`
  - `clearRevisionQueue(): void`
  - `setRevisionQueueNotice(notice: string | null): void`

- [ ] **Step 1: 写失败测试**

新建 `apps/studio/src/chat/stores/proposal.queue.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'bun:test'
import { useProposalStore } from './proposal'

const item = (selectedText: string, instruction = '润色') => ({
  sectionId: 's1',
  selectedText,
  instruction,
  hintRange: { start: 0, end: 0 }
})

describe('proposal revisionQueue', () => {
  beforeEach(() => {
    useProposalStore.getState().reset()
  })

  it('enqueue 追加并返回稳定 id，FIFO 顺序', () => {
    const a = useProposalStore.getState().enqueueRevision(item('甲'))
    const b = useProposalStore.getState().enqueueRevision(item('乙', '精简'))
    const q = useProposalStore.getState().revisionQueue
    expect(q.map((x) => x.id)).toEqual([a, b])
    expect(q[0].selectedText).toBe('甲')
    expect(a).not.toBe(b)
  })

  it('dequeue 弹出队头、缩短队列；空时返回 null', () => {
    useProposalStore.getState().enqueueRevision(item('甲'))
    const head = useProposalStore.getState().dequeueRevision()
    expect(head?.selectedText).toBe('甲')
    expect(useProposalStore.getState().revisionQueue).toHaveLength(0)
    expect(useProposalStore.getState().dequeueRevision()).toBeNull()
  })

  it('removeRevision 按 id 删除（取消某项）', () => {
    const a = useProposalStore.getState().enqueueRevision(item('甲'))
    const b = useProposalStore.getState().enqueueRevision(item('乙'))
    useProposalStore.getState().removeRevision(a)
    expect(useProposalStore.getState().revisionQueue.map((x) => x.id)).toEqual([b])
  })

  it('setRevisionQueueNotice 置/清丢弃提示', () => {
    useProposalStore.getState().setRevisionQueueNotice('1 个排队改写被跳过')
    expect(useProposalStore.getState().revisionQueueNotice).toBe('1 个排队改写被跳过')
    useProposalStore.getState().setRevisionQueueNotice(null)
    expect(useProposalStore.getState().revisionQueueNotice).toBeNull()
  })

  it('reset / start 清空队列与提示', () => {
    useProposalStore.getState().enqueueRevision(item('甲'))
    useProposalStore.getState().setRevisionQueueNotice('x')
    useProposalStore.getState().start('sess-1')
    expect(useProposalStore.getState().revisionQueue).toHaveLength(0)
    expect(useProposalStore.getState().revisionQueueNotice).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/studio && bun test src/chat/stores/proposal.queue.test.ts
```
Expected: FAIL，`enqueueRevision is not a function`。

- [ ] **Step 3: 写实现**

3a. 在 `BlockRevisionReview` 接口定义之后（约 `:47` 后）加类型：

```typescript
// 选区改写排队项：AI 忙时用户又发起的改写意图。故意【不存最终 blockRange】——排队期间前面的
// 改写可能落地、块序号会漂；排空时才用 selectedText 在最新 markdown 里重定位（locateBlockRangeByText）。
// hintRange = 入队那刻的块区间，【仅】在 selectedText 多处命中时当裁判选最近的一处（CEO 护栏#3），
// 不作主定位。瞬时 UI 信号，不持久化（同 blockReviews/pendingRevision）。
export interface QueuedRevision {
  id: string
  sectionId: string
  selectedText: string
  instruction: string
  hintRange: { start: number; end: number }
}
```

3b. 在 `ProposalState` 接口里 `blockReviews` 声明之后加两个字段：

```typescript
  // 选区改写排队（FIFO）：AI 生成中用户又发起的改写按顺序排这里，一轮 end 后排空函数取队头串行发。
  // 见 QueuedRevision 顶注。瞬时 UI 信号，不持久化，与 blockReviews 同重置点清空。
  revisionQueue: QueuedRevision[]
  // 排队项被跳过的可见提示（CEO 护栏#2·零静默失败）：重定位失败/目标节已删时，排空函数置一句文案，
  // 面板据此显示一行黄字（用户看得见"我排的某个改写没执行"），而非只往 console 里 warn 后静默丢。
  // 纯瞬时 UI 信号，用户手动关或下次成功排空时清。
  revisionQueueNotice: string | null
```

3c. 在 actions 区（`addBlockReview`/`removeBlockReview` 附近）加签名：

```typescript
  // 选区改写排队增删。enqueue 返回稳定 id 供 UI 取消；dequeue 弹队头供排空函数；clear 用于各重置点。
  enqueueRevision: (item: Omit<QueuedRevision, 'id'>) => string
  dequeueRevision: () => QueuedRevision | null
  removeRevision: (id: string) => void
  clearRevisionQueue: () => void
  setRevisionQueueNotice: (notice: string | null) => void
```

3d. 在 `create()` 初始 state 里（`blockReviews: {},` 附近，`:283`）加：

```typescript
    revisionQueue: [],
    revisionQueueNotice: null,
```

3e. 在 actions 实现区（`addBlockReview` 实现附近，`:352`）加：

```typescript
  enqueueRevision: (item) => {
    const id = crypto.randomUUID()
    set((s) => ({ revisionQueue: [...s.revisionQueue, { ...item, id }] }))
    return id
  },
  dequeueRevision: () => {
    let head: QueuedRevision | null = null
    set((s) => {
      if (s.revisionQueue.length === 0) return s
      head = s.revisionQueue[0]
      return { revisionQueue: s.revisionQueue.slice(1) }
    })
    return head
  },
  removeRevision: (id) =>
    set((s) => {
      const next = s.revisionQueue.filter((r) => r.id !== id)
      if (next.length === s.revisionQueue.length) return s
      return { revisionQueue: next }
    }),
  clearRevisionQueue: () => set({ revisionQueue: [] }),
  setRevisionQueueNotice: (notice) => set({ revisionQueueNotice: notice }),
```

3f. **每个重置点加 `revisionQueue: []` 与 `revisionQueueNotice: null`**（跟着 `blockReviews: {},` 一起）：`start`(`:287`)、`reopen`(`:467`)、`leaveMode`(`:479`)、`restoreFromTranscript`(`:498`)、`restoreFromDisk`(`:527`)、`reset`(`:547`)。语义同 `blockReviews`：未决改写意图不跨离开/再入/重开留存。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```bash
cd apps/studio && bun test src/chat/stores/proposal.queue.test.ts
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
```
Expected: 测试 PASS；typecheck 零错。

- [ ] **Step 5: 提交**

```bash
git add apps/studio/src/chat/stores/proposal.ts apps/studio/src/chat/stores/proposal.queue.test.ts
git commit -m "feat(proposal): 改写队列 store（队列+丢弃提示字段与增删 actions）"
```

---

### Task 3: 排空函数 `drainRevisionQueue`（重定位 + 并发闸 + 失败重排 + 丢弃提示）

一轮 `end` 后调用。**含三条 CEO 护栏**：并发闸（#1）、失败重排（#6）、丢弃可见提示（#2）。

**Files:**
- Modify: `apps/studio/src/chat/lib/sendProposalSectionRevision.ts`
- Modify: `apps/studio/src/chat/runtime/FusionRuntimeProvider.tsx`（`end` 分支 `endAssistantMessage(sid)` 之后调用）
- Test: `apps/studio/src/chat/lib/sendProposalSectionRevision.drain.test.ts`（新建）

**Interfaces:**
- Consumes: `useProposalStore`、`useChatStore`、`locateBlockRangeByTextWithHint`（Task 6 加的带 hint 版；本 Task 先用 Task 1 的无 hint 版占位，Task 6 再替）、`reviseProposalSectionBlocks`
- Produces: `drainRevisionQueue(): Promise<void>`

- [ ] **Step 1: 写失败测试**

新建 `apps/studio/src/chat/lib/sendProposalSectionRevision.drain.test.ts`：

```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test'

// 把真正发消息的底层挡掉：只关心 drain 的"重定位/丢弃/前进/丢弃提示"逻辑，不真的发送。
mock.module('./sendProposalStageMessage', () => ({
  sendProposalStageMessage: async () => {}
}))

import { useProposalStore } from '../stores/proposal'
import { useChatStore } from '../stores/chat'
import { drainRevisionQueue } from './sendProposalSectionRevision'

const enqueue = (selectedText: string) =>
  useProposalStore.getState().enqueueRevision({
    sectionId: 'sec-1',
    selectedText,
    instruction: '精简',
    hintRange: { start: 0, end: 0 }
  })

describe('drainRevisionQueue', () => {
  beforeEach(() => {
    useProposalStore.getState().reset()
  })

  it('队列空：什么都不做', async () => {
    await drainRevisionQueue()
    expect(useProposalStore.getState().pendingRevision).toBeNull()
  })

  it('队头文字找不到：丢弃+置可见提示+继续到下一个', async () => {
    useProposalStore.setState({
      active: true,
      sessionId: 'sess-1',
      sections: [{ id: 'sec-1', markdown: '真实存在的一段。', kind: 'content' }]
    })
    enqueue('幽灵文字不存在')
    enqueue('真实存在的一段。')

    await drainRevisionQueue()

    expect(useProposalStore.getState().revisionQueue).toHaveLength(0)
    expect(useProposalStore.getState().pendingRevision?.sectionId).toBe('sec-1')
    // 护栏#2：被跳过的那项要有可见提示
    expect(useProposalStore.getState().revisionQueueNotice).toContain('跳过')
  })

  it('streaming 为真：不排空（护栏#1 并发闸的外层）', async () => {
    useProposalStore.setState({
      active: true,
      sessionId: 'sess-1',
      sections: [{ id: 'sec-1', markdown: '真实存在的一段。', kind: 'content' }]
    })
    useChatStore.setState((s) => ({
      perSession: { ...s.perSession, ['sess-1']: { ...(s.perSession['sess-1'] ?? {}), streaming: true } }
    }) as never)
    enqueue('真实存在的一段。')

    await drainRevisionQueue()
    expect(useProposalStore.getState().revisionQueue).toHaveLength(1)
  })

  it('并发闸：两次并发 drain 只发起一个（护栏#1）', async () => {
    useProposalStore.setState({
      active: true,
      sessionId: 'sess-1',
      sections: [{ id: 'sec-1', markdown: '真实存在的一段。', kind: 'content' }]
    })
    enqueue('真实存在的一段。')
    enqueue('真实存在的一段。')

    // 同一 tick 并发触发两次，模拟 end 双触发
    await Promise.all([drainRevisionQueue(), drainRevisionQueue()])

    // 只应消费一个（另一个被 draining 闸挡回），队列还剩 1
    expect(useProposalStore.getState().revisionQueue).toHaveLength(1)
  })
})
```

> 注：`useChatStore.perSession[sid].streaming` 结构以 `stores/chat.ts` 实际为准，测试里对齐。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/studio && bun test src/chat/lib/sendProposalSectionRevision.drain.test.ts
```
Expected: FAIL，`drainRevisionQueue is not a function`。

- [ ] **Step 3: 写实现**

顶部 import 补上重定位函数（Task 6 会把它换成带 hint 版；本 Task 先引 Task 1 的版本）：

```typescript
import { splitBlocks, locateBlockRangeByText } from '@desktop-shared/proposalBlocks'
```

文件末尾追加（**含并发闸 + 失败重排 + 丢弃提示三护栏**）：

```typescript
// 并发闸（CEO 护栏#1）：end 事件可能对同一 messageId 双触发，两个 queueMicrotask 里的 drain 会各自
// dequeue 到不同队头、各自 send，破坏"一次只一个改写在飞"铁律。用模块级闸串行化：抢到闸才进，
// 发起后到下一轮 end 由新的 drain 再抢。闸是模块单例——proposal 同一时刻只有一个前台会话在排空，
// 不会跨会话争用（sessionId 已在 store 里自持）。
let draining = false

/**
 * 排空改写队列（选区改写排队·消费端）。一轮 end 后由 FusionRuntimeProvider 调用。
 * 三条 CEO 护栏就地落实：
 *  #1 并发闸 draining——防 end 双触发导致并发 send；
 *  #6 失败重排——发起抛错也不让队列停摆（catch 后靠下一轮 end 兜底，见下）；
 *  #2 丢弃提示——重定位失败/目标节已删时置 revisionQueueNotice，让用户看得见被跳过的项。
 *
 * 串行不变量：一次只发一个。reviseProposalSectionBlocks 发起后 streaming 转真（下一轮 start），
 * 下一轮 end 再次调本函数取下一个。
 */
export async function drainRevisionQueue(): Promise<void> {
  if (draining) return // 护栏#1：已有 drain 在跑，直接退（另一个 end 触发的重入）
  draining = true
  try {
    const ps = useProposalStore.getState()
    if (!ps.active || !ps.sessionId) return
    // streaming 闸：与 dispatchSectionRevision 同源，忙时按兵不动（下一轮 end 会再来）。
    const streaming = useChatStore.getState().perSession[ps.sessionId]?.streaming ?? false
    if (streaming) return

    let dropped = 0
    // 循环丢弃"文字已不存在/节已删"的死项，直到发起一个或排空。
    for (;;) {
      const head = useProposalStore.getState().dequeueRevision()
      if (!head) break // 队列空
      const sec = useProposalStore.getState().sections.find((s) => s.id === head.sectionId)
      if (!sec) {
        dropped++
        console.warn('[proposal-queue] 丢弃排队项：目标节已不存在', { sectionId: head.sectionId })
        continue
      }
      // Task 6 会把这里换成带 hint 的 locateBlockRangeByTextWithHint(sec.markdown, head.selectedText, head.hintRange)
      const range = locateBlockRangeByText(sec.markdown, head.selectedText)
      if (!range) {
        dropped++
        console.warn('[proposal-queue] 丢弃排队项：选中文字在最新草稿里已找不到', { sectionId: head.sectionId })
        continue
      }
      // 护栏#6：发起可能抛错（send 失败）。catch 后不重抛——现有 dispatchChatTurn 的 send 早退错误
      // 也走 endAssistantMessage 兜底，会再触发一轮 drain 收拾剩余项，故此处只需保证 draining 闸被
      // finally 释放、且把已置的 notice 落下。若未来兜底不可靠，可在 catch 里 queueMicrotask 再排一次。
      try {
        await reviseProposalSectionBlocks(head.sectionId, range, head.instruction, head.selectedText)
      } catch (err) {
        console.error('[proposal-queue] 发起排队改写抛错，交由 end 兜底重排', err)
      }
      if (dropped > 0) {
        useProposalStore.getState().setRevisionQueueNotice(`${dropped} 个排队改写因原文已变化被跳过`)
      }
      return // 发起了一个（或尝试过），等它的 end 再排下一个
    }
    // 走到这里=队列排空。若本轮有丢弃项，置提示；否则清掉旧提示。
    useProposalStore.getState().setRevisionQueueNotice(dropped > 0 ? `${dropped} 个排队改写因原文已变化被跳过` : null)
  } finally {
    draining = false // 护栏#1：务必释放，否则一次异常永久锁死排空
  }
}
```

- [ ] **Step 4: 在 FusionRuntimeProvider 接线**

顶部 import 加 `drainRevisionQueue`（从 `../lib/sendProposalSectionRevision`）。在 `'end'` 分支 `finally` 里 `actions.endAssistantMessage(sid)` 之后（`:1869`）追加：

```typescript
        } finally {
          actions.endAssistantMessage(sid)
          // 选区改写排队·排空（CEO 护栏#1/#6 在 drainRevisionQueue 内部）：queueMicrotask 让
          // endAssistantMessage 的 set 先落定（streaming=false 对 drain 内的闸可见），再排空。
          queueMicrotask(() => {
            void drainRevisionQueue()
          })
        }
```

- [ ] **Step 5: 跑测试 + typecheck + 提交**

```bash
cd apps/studio && bun test src/chat/lib/sendProposalSectionRevision.drain.test.ts
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
```
Expected: 测试 PASS（含并发闸用例）；typecheck 零错。

```bash
git add apps/studio/src/chat/lib/sendProposalSectionRevision.ts apps/studio/src/chat/lib/sendProposalSectionRevision.drain.test.ts apps/studio/src/chat/runtime/FusionRuntimeProvider.tsx
git commit -m "feat(proposal): drainRevisionQueue 排空——并发闸+失败重排+丢弃提示，接入 end 收尾"
```

---

### Task 4: SelectionAiBubble 解锁——生成中仍可选区、按钮变"排队改写"

现状：`disabled`（=generating）时清 anchor、不订阅选区（`SelectionAiBubble.tsx:88-95`），这是"锁住"的成因。改为：生成中**仍显示气泡、仍订阅选区**，但"开始改写"按钮变"排队改写"，`fire()` 分流到 `enqueueRevision`。图片入口维持生成中禁用（本次不排队图片）。

**Files:**
- Modify: `apps/studio/src/chat/components/workspace/SelectionAiBubble.tsx`

**Interfaces:**
- Consumes: `enqueueRevision`（Task 2）、`reviseProposalSectionBlocks`（已有）
- `disabled` prop 语义**不变**（仍是 generating），但内部对它的响应改变：不再清 anchor，而是切换按钮行为。

- [ ] **Step 1: 改订阅逻辑——生成中不再清 anchor**

把 `SelectionAiBubble.tsx:88-95` 的 disabled 分支删掉/改写。当前：

```typescript
    if (disabled) {
      setAnchor(null)
      return
    }
```

改为（删除这段早退，让 effect 在 generating 时也订阅选区）：

```typescript
    // 生成中【不再】清 anchor / 停订阅：排队改写需要用户在 AI 忙时仍能选新段落。fire() 会按 disabled
    // 分流——忙时入队、闲时直发（见下）。原先这里清 anchor 是"忙时锁死"的成因，排队方案下移除。
```

同时 `recompute` 内部（`:101-104`）的 `if (disabled) { setAnchor(null); return }` 也一并删除（同理由）。effect deps 里的 `disabled` 保留（按钮文案随它变要重渲染）。

- [ ] **Step 2: fire() 分流——忙时入队、闲时直发**

把 `fire()`（`:210-226`）改为：

```typescript
  async function fire(): Promise<void> {
    if (!anchor) return
    const text = instruction.trim()
    if (!text) return
    if (disabled) {
      // 生成中：入队，等当前轮结束由 drainRevisionQueue 串行发起（护栏#3 需要 hintRange 当消歧裁判）。
      useProposalStore.getState().enqueueRevision({
        sectionId: anchor.sectionId,
        selectedText: anchor.selectedText,
        instruction: text,
        hintRange: { start: anchor.start, end: anchor.end }
      })
    } else {
      await reviseProposalSectionBlocks(
        anchor.sectionId,
        { start: anchor.start, end: anchor.end },
        text,
        anchor.selectedText
      )
    }
    setInstruction('')
    setAnchor(null)
    window.getSelection()?.removeAllRanges()
  }
```

顶部加 import：`import { useProposalStore } from '../../stores/proposal'`（路径按文件实际层级对齐）。

- [ ] **Step 3: 按钮文案随 disabled 变**

把"开始改写"按钮（`:312-322`）的文案与标题改为条件式：

```typescript
              {disabled ? '排队改写' : '开始改写'}
```

并把按钮 `title`、`onKeyDown` 的 `⌘↵` 提示同步（`title={disabled ? 'AI 忙，⌘/Ctrl+回车 排队' : '⌘/Ctrl + 回车'}`）。标题栏"AI 改写"（`:246`）在 disabled 时可加后缀"· 排队中"提示当前是排队态。

- [ ] **Step 4: 图片入口生成中禁用**

`isContent` 分支里的"生成图片/上传图片"按钮（`:355-375`）本次不排队。在 disabled 时禁用它们（加 `disabled={disabled}` 到两个按钮，或整个"插入图片"区在 disabled 时不渲染），避免用户以为图片也排队。

- [ ] **Step 5: typecheck + 手动冒烟 + 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
```
Expected: 零错。（本 Task 是纯 UI 交互，单测覆盖弱；真正验证在 Task 8 的 /qa。）

```bash
git add apps/studio/src/chat/components/workspace/SelectionAiBubble.tsx
git commit -m "feat(proposal): 选区气泡生成中不再锁死——按钮切'排队改写'、fire 分流入队"
```

---

### Task 5: 队列可视化 + 取消 + 丢弃提示渲染 + 软上限（护栏 #5）

用户要能看到"排了几个、排了啥"，能取消某个，能看到"某项被跳过"，且排太多时被拦。

**Files:**
- Modify: `apps/studio/src/chat/components/workspace/ProposalPaper.tsx`（挂一个队列小面板 + 提示条）
- Modify: `apps/studio/src/chat/components/workspace/SelectionAiBubble.tsx`（enqueue 前查软上限）
- 可选 Create: `apps/studio/src/chat/components/workspace/RevisionQueuePanel.tsx`（若 ProposalPaper 超 ~1500 行则拆分，见 CLAUDE.md 约定）

**Interfaces:**
- Consumes: `revisionQueue`、`removeRevision`、`revisionQueueNotice`、`setRevisionQueueNotice`（Task 2）
- Produces: 常量 `MAX_REVISION_QUEUE = 10`（护栏#5）从 SelectionAiBubble 或 store 导出

- [ ] **Step 1: 队列面板**

在 `ProposalPaper.tsx` 纸面区合适位置（建议贴近工作台顶部或选区气泡上方）渲染：队列非空时列出每项（显示 `instruction` 截断 + `selectedText` 首 20 字），每项一个"取消"按钮调 `removeRevision(id)`。用 shadcn 原语 + Tailwind utility（本目录在 chat 链，禁用 canvas legacy 类；裸交互元素加 `data-slot` 逃逸 canvas reset——见 CLAUDE.md 样式铁律）。

```tsx
// ProposalPaper 内，读队列
const revisionQueue = useProposalStore((s) => s.revisionQueue)
const removeRevision = useProposalStore((s) => s.removeRevision)
// …渲染（示意，用现有 shadcn 卡片/按钮原语，非裸元素）：
{revisionQueue.length > 0 && (
  <div className="mb-2 rounded-lg border border-border bg-muted/30 p-2 text-[12px]">
    <div className="mb-1 font-medium text-muted-foreground">改写排队中（{revisionQueue.length}）</div>
    {revisionQueue.map((r, i) => (
      <div key={r.id} className="flex items-center gap-2 py-0.5">
        <span className="text-muted-foreground">{i + 1}.</span>
        <span className="truncate">{r.instruction}</span>
        <button
          type="button"
          data-slot="queue-cancel"
          className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => removeRevision(r.id)}
        >
          取消
        </button>
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 2: 丢弃提示条（护栏 #2 渲染端）**

`revisionQueueNotice` 非空时在同区域上方渲染一行黄字 + 关闭按钮（`onClick={() => setRevisionQueueNotice(null)}`）：

```tsx
{revisionQueueNotice && (
  <div className="mb-2 flex items-start gap-1 rounded bg-amber-500/10 px-2 py-1 text-[12px] text-amber-700 dark:text-amber-400">
    <span>{revisionQueueNotice}</span>
    <button type="button" data-slot="queue-notice-close" className="ml-auto shrink-0 hover:underline"
      onClick={() => useProposalStore.getState().setRevisionQueueNotice(null)}>
      知道了
    </button>
  </div>
)}
```

- [ ] **Step 3: 软上限（护栏 #5）**

在 `SelectionAiBubble.tsx` 的 `fire()` 入队分支前加：

```typescript
    if (disabled) {
      const MAX_REVISION_QUEUE = 10
      if (useProposalStore.getState().revisionQueue.length >= MAX_REVISION_QUEUE) {
        useProposalStore.getState().setRevisionQueueNotice('排队已满（上限 10 个），请等几个跑完再排')
        return // 不入队、不清 anchor，让用户看到提示后自行处理
      }
      useProposalStore.getState().enqueueRevision({ /* …如 Task 4 */ })
    }
```

- [ ] **Step 4: typecheck + 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
```
Expected: 零错。

```bash
git add apps/studio/src/chat/components/workspace/ProposalPaper.tsx apps/studio/src/chat/components/workspace/SelectionAiBubble.tsx
git commit -m "feat(proposal): 队列面板+取消+丢弃提示条+软上限（护栏#2/#5）"
```

---

### Task 6: 重定位消歧——给 `locateBlockRangeByText` 加 hint（护栏 #3）

Task 1 的 `indexOf` 取第一处，selectedText 出现多次时会定位到错的一处。加一个带 `hint` 的版本：多处命中时选**起点块离 hint.start 最近**的那处。

**Files:**
- Modify: `apps/studio/electron/shared/proposalBlocks.ts`（加 `locateBlockRangeByTextWithHint`）
- Modify: `apps/studio/electron/shared/proposalBlocks.test.ts`（追加用例）
- Modify: `apps/studio/src/chat/lib/sendProposalSectionRevision.ts`（drain 改调带 hint 版）

**Interfaces:**
- Produces: `locateBlockRangeByTextWithHint(markdown: string, selectedText: string, hint: { start: number; end: number }): { start: number; end: number } | null`

- [ ] **Step 1: 写失败测试**

在 `proposalBlocks.test.ts` 追加：

```typescript
describe('locateBlockRangeByTextWithHint', () => {
  const dup = ['复用段。', '中间段甲。', '复用段。', '中间段乙。', '复用段。'].join('\n\n')

  it('多处命中：选起点块离 hint 最近的一处', () => {
    // hint 指向第 2 处（块 2），应命中块 2 而非块 0
    expect(locateBlockRangeByTextWithHint(dup, '复用段。', { start: 2, end: 2 })).toEqual({ start: 2, end: 2 })
    // hint 指向末处（块 4）
    expect(locateBlockRangeByTextWithHint(dup, '复用段。', { start: 4, end: 4 })).toEqual({ start: 4, end: 4 })
  })

  it('单处命中：hint 无影响', () => {
    const md = ['甲。', '乙。', '丙。'].join('\n\n')
    expect(locateBlockRangeByTextWithHint(md, '乙。', { start: 0, end: 0 })).toEqual({ start: 1, end: 1 })
  })

  it('找不到：返回 null（同无 hint 版）', () => {
    expect(locateBlockRangeByTextWithHint('甲。', '幽灵', { start: 0, end: 0 })).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/studio && bun test electron/shared/proposalBlocks.test.ts
```
Expected: FAIL，`locateBlockRangeByTextWithHint is not a function`。

- [ ] **Step 3: 写实现**

在 `proposalBlocks.ts` 里，把 Task 1 的核心抽成"找所有命中"，再由无 hint / 带 hint 两个导出各取所需。重写为：

```typescript
// 内部：返回 selectedText 在 markdown 里【所有】命中的块区间（规范化去空白后匹配）。空则空数组。
function locateAllBlockRanges(markdown: string, selectedText: string): Array<{ start: number; end: number }> {
  const norm = (s: string): string => s.replace(/\s+/g, '')
  const needle = norm(selectedText)
  if (!needle) return []
  const blocks = splitBlocks(markdown)
  if (blocks.length === 0) return []

  let hay = ''
  const spans: Array<{ start: number; end: number }> = []
  for (const blk of blocks) {
    const nb = norm(blk)
    const begin = hay.length
    hay += nb
    spans.push({ start: begin, end: hay.length })
  }

  const blockOf = (charIdx: number, forEnd: boolean): number => {
    let found = -1
    for (let k = 0; k < spans.length; k++) {
      const sp = spans[k]
      if (sp.start === sp.end) continue // 规范化后空块跳过
      if (charIdx < sp.end) return k
      found = k
    }
    return forEnd ? found : -1
  }

  const out: Array<{ start: number; end: number }> = []
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at < 0) break
    const start = blockOf(at, false)
    const end = blockOf(at + needle.length - 1, true)
    if (start >= 0 && end >= start) out.push({ start, end })
    from = at + 1 // 允许重叠命中的下一处
  }
  return out
}

// 无 hint 版（Task 1 契约不变）：取第一处命中。
export function locateBlockRangeByText(
  markdown: string,
  selectedText: string
): { start: number; end: number } | null {
  const all = locateAllBlockRanges(markdown, selectedText)
  return all[0] ?? null
}

// 带 hint 版（CEO 护栏#3）：多处命中时选 start 离 hint.start 最近的一处（并列取更靠前）。
export function locateBlockRangeByTextWithHint(
  markdown: string,
  selectedText: string,
  hint: { start: number; end: number }
): { start: number; end: number } | null {
  const all = locateAllBlockRanges(markdown, selectedText)
  if (all.length === 0) return null
  if (all.length === 1) return all[0]
  return all.reduce((best, cur) =>
    Math.abs(cur.start - hint.start) < Math.abs(best.start - hint.start) ? cur : best
  )
}
```

> Task 1 已写的 `locateBlockRangeByText` 函数体被本 Task 替换成"调 `locateAllBlockRanges` 取首个"——行为对既有单测不变（首处命中），全绿即证明未回归。

- [ ] **Step 4: drain 改调带 hint 版**

`sendProposalSectionRevision.ts` 顶部 import 加 `locateBlockRangeByTextWithHint`；把 `drainRevisionQueue` 里的定位改为：

```typescript
      const range = locateBlockRangeByTextWithHint(sec.markdown, head.selectedText, head.hintRange)
```

- [ ] **Step 5: 跑全量相关测试 + typecheck + 提交**

```bash
cd apps/studio && bun test electron/shared/proposalBlocks.test.ts src/chat/lib/sendProposalSectionRevision.drain.test.ts
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
```
Expected: 全绿（含 Task 1 原用例未回归）。

```bash
git add apps/studio/electron/shared/proposalBlocks.ts apps/studio/electron/shared/proposalBlocks.test.ts apps/studio/src/chat/lib/sendProposalSectionRevision.ts
git commit -m "feat(proposal): 重定位多处命中按 hint 消歧（护栏#3）"
```

---

### Task 7: 审阅卡冲突拦截（护栏 #4）

同几块已挂着待审阅卡时，拦下针对这几块的新排队/新发起，防"两张卡先后应用致 blockRange 错乱"。

**Files:**
- Modify: `apps/studio/src/chat/components/workspace/SelectionAiBubble.tsx`（fire 前查冲突）
- Test: `apps/studio/src/chat/stores/proposal.blockreview-overlap.test.ts`（新建，测纯判定函数）

**Interfaces:**
- Produces: 纯函数 `blockRangeOverlapsPendingReview(reviews: Record<string, BlockRevisionReview>, sectionId: string, range: { start: number; end: number }): boolean`，放 `apps/studio/src/chat/lib/proposalRevisionGuards.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `apps/studio/src/chat/lib/proposalRevisionGuards.test.ts`：

```typescript
import { describe, it, expect } from 'bun:test'
import { blockRangeOverlapsPendingReview } from './proposalRevisionGuards'
import type { BlockRevisionReview } from '../stores/proposal'

const mk = (sectionId: string, start: number, end: number): BlockRevisionReview => ({
  sectionId, blockRange: { start, end }, before: 'x', after: 'y'
})

describe('blockRangeOverlapsPendingReview', () => {
  const reviews = { m1: mk('sec-1', 2, 4) }

  it('同节区间相交：true', () => {
    expect(blockRangeOverlapsPendingReview(reviews, 'sec-1', { start: 3, end: 5 })).toBe(true)
    expect(blockRangeOverlapsPendingReview(reviews, 'sec-1', { start: 4, end: 4 })).toBe(true)
  })
  it('同节区间不相交：false', () => {
    expect(blockRangeOverlapsPendingReview(reviews, 'sec-1', { start: 5, end: 6 })).toBe(false)
  })
  it('异节：false', () => {
    expect(blockRangeOverlapsPendingReview(reviews, 'sec-2', { start: 2, end: 4 })).toBe(false)
  })
  it('无待审阅：false', () => {
    expect(blockRangeOverlapsPendingReview({}, 'sec-1', { start: 2, end: 4 })).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/studio && bun test src/chat/lib/proposalRevisionGuards.test.ts
```
Expected: FAIL，模块不存在。

- [ ] **Step 3: 写实现**

新建 `apps/studio/src/chat/lib/proposalRevisionGuards.ts`：

```typescript
import type { BlockRevisionReview } from '../stores/proposal'

// 目标区间是否与某条【同节】待审阅卡的块区间相交（CEO 护栏#4）。相交=两张卡改重叠块，先后应用
// 会因块数变化令后一张 blockRange 错位。发起前命中即拦下，请用户先处理已有审阅卡。
export function blockRangeOverlapsPendingReview(
  reviews: Record<string, BlockRevisionReview>,
  sectionId: string,
  range: { start: number; end: number }
): boolean {
  for (const r of Object.values(reviews)) {
    if (r.sectionId !== sectionId) continue
    // 闭区间相交：start <= r.end && r.start <= end
    if (range.start <= r.blockRange.end && r.blockRange.start <= range.end) return true
  }
  return false
}
```

- [ ] **Step 4: 在 fire() 直发路径接线**

在 `SelectionAiBubble.tsx` 的 `fire()` 里，**直发分支**（`!disabled`）发起前查冲突（排队分支因执行时才定位，冲突在 drain 时已被自然错开+审阅卡并存语义，主要防即时发起）：

```typescript
    } else {
      const { blockReviews } = useProposalStore.getState()
      if (blockRangeOverlapsPendingReview(blockReviews, anchor.sectionId, { start: anchor.start, end: anchor.end })) {
        useProposalStore.getState().setRevisionQueueNotice('这段还有待确认的改写，请先「应用」或「放弃」它，再改这几段')
        return // 不发起、不清 anchor
      }
      await reviseProposalSectionBlocks(/* …如 Task 4 */)
    }
```

顶部 import `blockRangeOverlapsPendingReview`。

- [ ] **Step 5: 跑测试 + typecheck + 提交**

```bash
cd apps/studio && bun test src/chat/lib/proposalRevisionGuards.test.ts
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
```
Expected: 全绿。

```bash
git add apps/studio/src/chat/lib/proposalRevisionGuards.ts apps/studio/src/chat/lib/proposalRevisionGuards.test.ts apps/studio/src/chat/components/workspace/SelectionAiBubble.tsx
git commit -m "feat(proposal): 审阅卡区间冲突拦截，防先后应用错位（护栏#4）"
```

---

### Task 8: 实机 QA 走查（护栏 #7·非代码 Task）

生成中选区能否真选、气泡贴位、排队→自动串行执行→审阅卡逐个出现，这些代码测不了，必须开应用走一遍。

**Files:** 无（人工/工具走查）

- [ ] **Step 1: 起应用**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run dev
```

- [ ] **Step 2: 走查清单（逐条确认）**

- [ ] 进"写方案"、生成出一份带正文的草稿。
- [ ] 选中一段点"开始改写"，AI 开始跑（左侧 streaming）。
- [ ] **生成中再选另一段**——气泡应正常冒出、按钮显示"排队改写"、贴位不乱跳。
- [ ] 点"排队改写"，纸面出现"改写排队中（1）"面板。
- [ ] 再排 1~2 个，队列计数递增；点某项"取消"能移除。
- [ ] 第一轮 end 后，队列自动弹出队头、串行发起下一个，逐个出审阅卡。
- [ ] 故意排一个"选中文字会被前一个改写覆盖"的项，验证它被跳过且出黄字提示。
- [ ] 排满 10 个后再排，出"排队已满"提示、不入队。
- [ ] 队列执行中"返回"退出工作台再进，队列已清空（符合 leaveMode 语义）。

- [ ] **Step 3: 若发现问题**

按 `superpowers:systematic-debugging` 定位，回到对应 Task 修复。全绿后本方案完成。

可选：用 `/qa` 让工具辅助走查上面清单。

---

## Self-Review（对照 spec 检查）

**1. 覆盖：** 用户诉求"AI 工作时后续指令排队等待"→ Task 4（解锁+入队）+ Task 3（串行排空）覆盖主线；Task 5 给可见性与取消。7 条 CEO 护栏经映射表逐条落到 Task 3/5/6/7/8。✅

**2. 占位符扫描：** 无 TBD/TODO；每个改代码的 Step 都给了完整代码与预期输出。SelectionAiBubble 的 import 路径标了"按文件实际层级对齐"——实现时需核对相对层级（`../../stores` vs `../stores`），非占位符而是一处需现场确认的细节。

**3. 类型一致：** `QueuedRevision` 字段（含 `hintRange`）在 Task 2 定义，Task 3/4/6 消费签名一致；`locateBlockRangeByText`(Task1) 与 `locateBlockRangeByTextWithHint`(Task6) 命名区分清楚，drain 在 Task 3 用前者、Task 6 换后者，已注明替换点。`blockRangeOverlapsPendingReview` 在 Task 7 定义与消费一致。✅

**已知边界（未纳入本次·守范围）：**
- 整章修订/补料/图片**不排队**，维持忙时禁用（Global Constraints 已声明）。
- 会话切走后队列在后台继续排空——与现有单条改写"绑 sessionId 后台也发"一致，属预期。
- selectedText 被前轮改写部分覆盖致"半匹配"→ 归入"找不到"分支被跳过（保守，不猜）。

---

## Execution Handoff

方案已补完整并硬化，保存在 `docs/superpowers/plans/2026-07-09-proposal-revision-queue.md`。两种执行方式：

1. **Subagent-Driven（推荐）** — 每个 Task 派一个新 subagent 实现、Task 间人工过一眼，迭代快。
2. **Inline Execution** — 本会话内按 Task 顺序批量执行，带检查点。

想开始实现时告诉我用哪种，我再进 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`。
