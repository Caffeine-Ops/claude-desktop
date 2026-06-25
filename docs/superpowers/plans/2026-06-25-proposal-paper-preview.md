# 方案草稿：连续长纸 + docx-preview 真预览 + 工作台布局 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把方案草稿改成「连续 A4 长纸编辑 + docx-preview 真分页预览」，并在方案模式下让右半区接管为工作台（撤对话历史栏、返回键、可折叠对话列、可拖拽分隔条）。

**Architecture:** 复用现有 `markdownToDocxBuffer`（mdast→docx）经新 IPC `proposal:render` 回字节给渲染层，用 `docx-preview` 渲染成与导出 Word 逐像素一致的 A4 分页；编辑态保留「哨兵→分节」数据模型，仅把卡片堆叠换皮成连续白纸；布局接管走 `App.tsx` 同一 flex 行内的条件宽度/类名切换，保证 `ThreadView` 不重挂。

**Tech Stack:** Electron（main/preload/renderer 三进程）、React 19、zustand、Tailwind v4（`hsl(var(--token))` 主题映射）、`docx`（main）、`docx-preview`（renderer，新增）、bun。

## Global Constraints

- 包管理器是 **bun**，不是 npm（`bun add` / `bun run`）。
- **唯一自动化质量门是 `bun run typecheck`**（tsc 双工程：node + web）。**无单元测试、无 ESLint**——故本计划每个任务的「验证」= `bun run typecheck` 通过 + 在 `bun run dev` 跑起来的真应用里手测，不引入任何测试框架。
- 加一条 IPC 改三处即可：`shared/ipc-channels.ts`（通道常量 + 类型 + `ChatApi` 方法）→ `preload/index.ts`（实现）→ `main/ipc/register.ts`（handler + teardown removeHandler）。`preload/index.d.ts` 仅 `import { ChatApi }`，自动跟随，无需手改。
- renderer 禁止直接 import Node 模块；一切主进程能力走 `window.chatApi`。
- 不动 AI 哨兵→分节抽取链路（`shared/proposal.ts`、`appendSections`、`consumedDraftIds`）。
- 注释解释「为什么这样而不是那样」，沿用仓库高注释密度风格。
- 主题色：纸张恒为白底黑字；accent token 在暗色 `#2997ff`、浅色 `#3395ff`，沿用 `hsl(var(--accent))`。
- 提交信息结尾加 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

## 文件结构

| 文件 | 职责 | 增/改 |
| --- | --- | --- |
| `apps/desktop/src/shared/ipc-channels.ts` | `PROPOSAL_RENDER` 常量 + 类型 + `ChatApi.renderProposal` | 改 |
| `apps/desktop/src/preload/index.ts` | `renderProposal` 实现 | 改 |
| `apps/desktop/src/main/ipc/register.ts` | `PROPOSAL_RENDER` handler + teardown | 改 |
| `apps/desktop/src/main/core/proposalDocx.ts` | 给 docx 加带页码的页脚（导出 Word 与预览同时受益） | 改 |
| `apps/desktop/src/renderer/src/stores/proposal.ts` | `workspaceOpen` + `setWorkspaceOpen` + `useProposalWorkspace` | 改 |
| `apps/desktop/src/renderer/src/index.css` | `.proposal-paper` 纸张 token 作用域覆盖 | 改 |
| `apps/desktop/src/renderer/src/components/workspace/PaneSplitter.tsx` | 竖向可拖拽分隔条（受控） | 新 |
| `apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx` | 编辑态：连续长纸 + 悬停工具条 + 就地 textarea | 新 |
| `apps/desktop/src/renderer/src/components/workspace/ProposalPreview.tsx` | 预览态：docx-preview 渲染 + loading/empty/error | 新 |
| `apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx` | shell：头部 title + 编辑/预览 toggle + 工作台再入 + 导出 + chips；按 mode 渲染 Paper/Preview；自适应宽度 | 改 |
| `apps/desktop/src/renderer/src/App.tsx` | 工作台接管布局：隐藏对话历史栏、可折叠对话列、分隔条、浮动返回簇 | 改 |
| `apps/desktop/package.json` | 加 `docx-preview` 依赖 | 改 |

依赖顺序：T1 IPC → T2 页脚 → T3 store → T4 splitter → T5 paper（并接进 panel，立即可测）→ T6 preview → T7 panel toggle 接 preview → T8 App 布局接管。每个任务结束应用都可跑、可测。

---

### Task 1: 新增 IPC `proposal:render`（生成 .docx 字节不落盘）

**Files:**
- Modify: `apps/desktop/src/shared/ipc-channels.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/ipc/register.ts`

**Interfaces:**
- Consumes: `markdownToDocxBuffer(markdown: string): Promise<Buffer>`（`main/core/proposalDocx.ts` 既有导出）。
- Produces:
  - 通道常量 `IPC_CHANNELS.PROPOSAL_RENDER = 'proposal:render'`
  - `interface ProposalRenderPayload { markdown: string }`
  - `interface ProposalRenderResult { bytes: Uint8Array }`
  - `ChatApi.renderProposal(payload: ProposalRenderPayload): Promise<ProposalRenderResult>` → `window.chatApi.renderProposal`

- [ ] **Step 1: 在 ipc-channels.ts 加通道常量**

把 `IPC_CHANNELS` 对象末尾的 `PROPOSAL_EXPORT` 行（约 line 450，注意它当前是最后一项、无尾逗号）改为补逗号 + 新增项：

```ts
  PROPOSAL_EXPORT: 'proposal:export',
  /**
   * Renderer → main. Renders the proposal markdown to a .docx binary
   * IN MEMORY (no save dialog, no disk write), so the renderer can paint a
   * docx-preview pagination view that matches the exported Word file
   * byte-for-byte — same `markdownToDocxBuffer` engine as PROPOSAL_EXPORT.
   */
  PROPOSAL_RENDER: 'proposal:render'
```

- [ ] **Step 2: 在 ipc-channels.ts 加 payload/result 类型**

紧接 `ProposalExportResult`（约 line 817）之后追加：

```ts
/** Payload for PROPOSAL_RENDER. */
export interface ProposalRenderPayload {
  markdown: string
}

/**
 * Result of PROPOSAL_RENDER. `bytes` is the .docx binary — a Node `Buffer`
 * on the main side, which structured-clones across IPC as a `Uint8Array`.
 * The renderer wraps it in a `Blob` for docx-preview.
 */
export interface ProposalRenderResult {
  bytes: Uint8Array
}
```

- [ ] **Step 3: 在 ipc-channels.ts 的 ChatApi 接口加方法**

在 `ChatApi` 接口里 `exportProposal(...)` 方法（约 line 1186）之后追加：

```ts
  /**
   * Render the proposal markdown to a .docx binary in-memory (no save
   * dialog, no disk write). The preview tab feeds the bytes to docx-preview
   * to paint paginated A4 that matches the exported Word exactly. Rejects
   * on render failure — the renderer shows an error state.
   */
  renderProposal(payload: ProposalRenderPayload): Promise<ProposalRenderResult>
```

- [ ] **Step 4: 在 preload/index.ts 导入新类型并实现方法**

在顶部类型 import 块（约 line 57-58，`type ProposalExportPayload,` / `type ProposalExportResult` 处）补两行：

```ts
  type ProposalExportPayload,
  type ProposalExportResult,
  type ProposalRenderPayload,
  type ProposalRenderResult
```

把 `chatApi` 对象里 `exportProposal` 方法（约 line 398-403，当前是对象最后一个方法、其后是 `}`）改为补尾逗号 + 新增方法：

```ts
  exportProposal(payload: ProposalExportPayload): Promise<ProposalExportResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_EXPORT,
      payload
    ) as Promise<ProposalExportResult>
  },

  renderProposal(payload: ProposalRenderPayload): Promise<ProposalRenderResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_RENDER,
      payload
    ) as Promise<ProposalRenderResult>
  }
```

- [ ] **Step 5: 在 register.ts 导入引擎与类型**

在既有 `import { exportProposal, isProposalExportFormat } from '../core/proposalExport'`（line 83）下方加：

```ts
import { markdownToDocxBuffer } from '../core/proposalDocx'
```

确认 `register.ts` 顶部从 `../../shared/ipc-channels` 的类型 import 里含 `ProposalRenderPayload, ProposalRenderResult`（与 `ProposalExportPayload` 同一处 import；若该 import 是具名列表，补上这两个名字）。

- [ ] **Step 6: 在 register.ts 注册 handler**

在 `PROPOSAL_EXPORT` 的 `ipcMain.handle(...)` 块（约 line 1009-1026）之后追加：

```ts
  // 预览专用：复用与「导出 Word」完全相同的引擎（markdownToDocxBuffer），
  // 保证 docx-preview 渲染出的分页 = 导出成品逐像素一致。不弹保存框、不落盘——
  // 只把 .docx 字节回给渲染层喂给 docx-preview。生成异常直接抛出（reject），
  // 渲染层 try/catch 后显示错误态，而不是静默吞掉。
  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_RENDER,
    async (_event, payload: ProposalRenderPayload): Promise<ProposalRenderResult> => {
      const markdown = typeof payload?.markdown === 'string' ? payload.markdown : ''
      const bytes = await markdownToDocxBuffer(markdown)
      return { bytes }
    }
  )
```

- [ ] **Step 7: 在 register.ts teardown 补 removeHandler**

在既有 `ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_EXPORT)`（line 219）下方加一行：

```ts
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_EXPORT)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_RENDER)
```

- [ ] **Step 8: typecheck**

Run: `bun run typecheck`
Expected: PASS（无类型错误）。

- [ ] **Step 9: 手测 IPC**

Run: `bun run dev`，在某个 tab 的 DevTools Console 执行：

```js
await window.chatApi.renderProposal({ markdown: '# 标题\n\n一个段落。\n\n- 项一\n- 项二' })
```

Expected: 返回 `{ bytes: Uint8Array(N) }`，`N > 0`（典型几千字节）。

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/ipc/register.ts
git commit -m "$(printf 'feat(proposal): 新增 proposal:render IPC——复用导出引擎生成 .docx 字节不落盘\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 2: 给导出 docx 加带页码的页脚

页码来自 docx 自身页脚域——加了之后**导出的真 Word 与预览都显示页码**，彻底一致。

**Files:**
- Modify: `apps/desktop/src/main/core/proposalDocx.ts`

**Interfaces:**
- Consumes: `docx` 的 `Footer` / `PageNumber`（新 import）、既有 `AlignmentType` / `TextRun` / `Paragraph`。
- Produces: `markdownToDocxBuffer` 产出的 docx 每页底部居中显示 `— <页码> —`。

- [ ] **Step 1: 扩充 docx import**

把 `proposalDocx.ts` 顶部从 `'docx'` 的 import（line 1-13）里补两个名字 `Footer`、`PageNumber`：

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
  AlignmentType,
  Footer,
  PageNumber
} from 'docx'
```

- [ ] **Step 2: 给 section 加 footers**

把 `markdownToDocxBuffer` 里 `new Document({ ... })` 的 `sections` 数组项（约 line 241）改为带 `footers`：

```ts
    sections: [
      {
        // 页脚：每页底部居中「— 当前页码 —」。size 18 = 9pt（half-points），
        // 灰色 9a9a9e 与正文区分。页码字段由 Word/LibreOffice/ docx-preview 在
        // 渲染/翻页时各自计算，故导出成品与预览的页码完全一致。
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: ['— ', PageNumber.CURRENT, ' —'],
                    size: 18,
                    color: '9a9a9e'
                  })
                ]
              })
            ]
          })
        },
        children: children.length
          ? children
          : [new Paragraph({ children: [new TextRun('')] })]
      }
    ]
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 4: 手测导出页码**

`bun run dev`，进入一个方案会话、让草稿有多于一页的内容，点「导出 Word」存盘，用 Word/Pages/LibreOffice 打开 → 每页底部居中有 `— 1 —`、`— 2 —` …

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/core/proposalDocx.ts
git commit -m "$(printf 'feat(proposal): 导出 docx 加带页码的页脚（导出 Word 与预览同时受益）\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 3: proposal store 加 `workspaceOpen` 与 `useProposalWorkspace`

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/proposal.ts`

**Interfaces:**
- Produces:
  - 状态字段 `workspaceOpen: boolean`
  - action `setWorkspaceOpen(open: boolean): void`
  - hook `useProposalWorkspace(): boolean` = `useProposalForeground() && workspaceOpen`

- [ ] **Step 1: 在 ProposalState 接口加字段与 action**

在 `interface ProposalState`（line 19-51）里，`sections: ProposalSection[]` 行之后、`start` 之前加：

```ts
  // 方案工作台是否接管布局（撤对话历史栏 + 可折叠对话列 + 宽纸张区）。
  // 与 active 分离：「返回」只关工作台、不销毁草稿，可再入。start() 时置 true。
  workspaceOpen: boolean
```

在 `moveSection` action 声明之后、`reset` 之前加：

```ts
  setWorkspaceOpen: (open: boolean) => void
```

- [ ] **Step 2: 初值 / start / reset / action 实现**

在 `create<ProposalState>` 的初始对象里，`sections: [],`（line 59）之后加：

```ts
  workspaceOpen: false,
```

`start` 的 `set({ ... })`（line 61-68）里补一行（进入方案即接管工作台）：

```ts
  start: (sessionId) =>
    set({
      active: true,
      sessionId,
      products: [],
      seeded: false,
      consumedDraftIds: new Set(),
      sections: [],
      workspaceOpen: true
    }),
```

在 `moveSection` action 实现之后、`reset` 之前加 action：

```ts
  setWorkspaceOpen: (open) => set({ workspaceOpen: open }),
```

`reset` 的 `set({ ... })`（line 110-117）里补一行：

```ts
  reset: () =>
    set({
      active: false,
      sessionId: null,
      products: [],
      seeded: false,
      consumedDraftIds: new Set(),
      sections: [],
      workspaceOpen: false
    })
```

- [ ] **Step 3: 加 useProposalWorkspace hook**

在文件末尾 `useProposalForeground` 函数之后追加：

```ts
/**
 * 方案工作台是否应接管布局。在「前台是方案会话」(useProposalForeground) 之上再叠加
 * workspaceOpen——「返回」把 workspaceOpen 置 false 即退出接管、回到正常三栏，但
 * sections/products 仍在，可由再入按钮重新打开。与 useProposalForeground 分离，确保
 * 「返回」不等于销毁草稿。
 */
export function useProposalWorkspace(): boolean {
  const foreground = useProposalForeground()
  const open = useProposalStore((s) => s.workspaceOpen)
  return foreground && open
}
```

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/stores/proposal.ts
git commit -m "$(printf 'feat(proposal): store 加 workspaceOpen + useProposalWorkspace（返回不销毁草稿）\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 4: 可拖拽分隔条 `PaneSplitter`

**Files:**
- Create: `apps/desktop/src/renderer/src/components/workspace/PaneSplitter.tsx`

**Interfaces:**
- Produces: `PaneSplitter({ onDrag }: { onDrag: (clientX: number) => void }): React.JSX.Element`——拖动时把鼠标 `clientX` 上报，由父组件换算成某一侧宽度。组件自身不持宽度状态（纯受控）。

- [ ] **Step 1: 写组件**

```tsx
import { useCallback, useRef } from 'react'

/**
 * 竖向可拖拽分隔条（纯受控）。拖动时把鼠标 clientX 通过 onDrag 上报，由父组件决定
 * 落到哪一侧的宽度——组件不持有宽度状态，便于复用与父组件统一钳制范围。
 *
 * mousemove/mouseup 挂在 window 上（而非自身），保证鼠标拖出条宽后仍持续收到事件；
 * 拖拽期间禁用 body 的 userSelect，避免拖动时选中正文。监听在 mouseup/卸载时摘除。
 */
export function PaneSplitter({
  onDrag
}: {
  onDrag: (clientX: number) => void
}): React.JSX.Element {
  const dragging = useRef(false)

  const onMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging.current) return
      onDrag(e.clientX)
    },
    [onDrag]
  )

  const stop = useCallback(() => {
    dragging.current = false
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', stop)
  }, [onMove])

  const start = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      document.body.style.userSelect = 'none'
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', stop)
    },
    [onMove, stop]
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={start}
      className="group relative w-[7px] shrink-0 cursor-col-resize"
    >
      {/* 1px 视觉线，hover/拖动时变 accent 色 */}
      <div className="absolute inset-y-0 left-[3px] w-px bg-border transition-colors group-hover:bg-accent" />
    </div>
  )
}
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: PASS（导出但暂未被引用，typecheck 仍通过）。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/PaneSplitter.tsx
git commit -m "$(printf 'feat(proposal): 新增受控可拖拽分隔条 PaneSplitter\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 5: 编辑态连续长纸 `ProposalPaper` + 纸张 token + 接进面板

本任务建立 `ProposalPaper` 并**立即替换** `ProposalDocPanel` 里旧的分节卡片区，使编辑态马上变成连续长纸、可在当前（仍为 w-96 的）面板里手测。

**Files:**
- Create: `apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx`
- Modify: `apps/desktop/src/renderer/src/index.css`
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx`

**Interfaces:**
- Consumes: `useProposalStore`（`sections` / `updateSection` / `removeSection` / `moveSection` / `sessionId`）、`useChatStore`（`perSession[sid].streaming`）、`AssistantMarkdown`。
- Produces: `ProposalPaper(): React.JSX.Element`——自含 `editingId` 单选编辑状态，渲染连续白纸。

- [ ] **Step 1: 写 ProposalPaper 组件**

```tsx
import { useState } from 'react'
import { useProposalStore } from '../../stores/proposal'
import { useChatStore } from '../../stores/chat'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'

/**
 * 编辑态：一张连续的 A4 宽长纸，分节无缝拼接、向下滚动不分页。
 * 保留现有「哨兵→分节」数据模型，仅把卡片堆叠换皮成纸面：
 *  - 去卡片边框/底色，节正文用 AssistantMarkdown 渲染；白纸黑字靠 .proposal-paper
 *    作用域覆盖前景 token（见 index.css），无需逐元素 !important。
 *  - 悬停某节 → 右侧外边距浮出工具条（编辑/上移/下移/删除），不占正文宽度、不破坏纸面。
 *  - 单节编辑仍是 editingId 单选 + textarea，但 textarea 白底衬线、无框，就地改字。
 *
 * 工具条按钮用显式中性色（非主题 token）——因为 .proposal-paper 把 token 覆盖成纸墨色，
 * 若按钮也用 text-foreground 会变成白纸上的浅色控件、对比过低。
 */
export function ProposalPaper(): React.JSX.Element {
  const sections = useProposalStore((s) => s.sections)
  const { updateSection, removeSection, moveSection } = useProposalStore.getState()
  const proposalSid = useProposalStore((s) => s.sessionId)
  const generating = useChatStore((s) =>
    proposalSid ? (s.perSession[proposalSid]?.streaming ?? false) : false
  )
  const [editingId, setEditingId] = useState<string | null>(null)

  const toolBtn =
    'grid size-6 place-items-center rounded-md border border-neutral-300 bg-white text-[12px] text-neutral-600 hover:border-accent hover:text-accent disabled:opacity-30'

  return (
    <div className="flex-1 overflow-auto bg-black/10 py-7 dark:bg-black/25">
      <div className="proposal-paper mx-auto w-[min(794px,calc(100%-48px))] rounded-sm bg-white px-[clamp(28px,6%,76px)] py-16 text-[#1d1d1f] shadow-[0_1px_0_rgba(0,0,0,0.04),0_12px_34px_rgba(0,0,0,0.30)]">
        {sections.length === 0 ? (
          <div className="text-center text-[13px] text-neutral-400">
            {generating ? '方案正在生成，完成的部分会陆续出现在这里…' : '等待 AI 起草…'}
          </div>
        ) : (
          sections.map((sec, i) => (
            <section key={sec.id} className="group relative py-0.5">
              <div className="absolute -right-[58px] top-1.5 hidden flex-col gap-1 group-hover:flex">
                <button
                  className={toolBtn}
                  onClick={() => setEditingId(editingId === sec.id ? null : sec.id)}
                  aria-label={editingId === sec.id ? '完成' : '编辑'}
                >
                  {editingId === sec.id ? '✓' : '✎'}
                </button>
                <button
                  className={toolBtn}
                  disabled={i === 0}
                  onClick={() => moveSection(sec.id, 'up')}
                  aria-label="上移"
                >
                  ↑
                </button>
                <button
                  className={toolBtn}
                  disabled={i === sections.length - 1}
                  onClick={() => moveSection(sec.id, 'down')}
                  aria-label="下移"
                >
                  ↓
                </button>
                <button
                  className="grid size-6 place-items-center rounded-md border border-neutral-300 bg-white text-[12px] text-rose-500 hover:border-rose-400"
                  onClick={() => {
                    if (editingId === sec.id) setEditingId(null)
                    removeSection(sec.id)
                  }}
                  aria-label="删除"
                >
                  ×
                </button>
              </div>

              {sec.truncated && (
                <div className="mb-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600">
                  ⚠ 本段疑似截断（AI 未写结束标记），内容可能不完整，请复核或重新生成
                </div>
              )}

              {editingId === sec.id ? (
                <textarea
                  className="min-h-[120px] w-full resize-none rounded-sm bg-accent/5 font-serif text-[14.5px] leading-[1.95] text-[#1d1d1f] outline-none"
                  value={sec.markdown}
                  autoFocus
                  onChange={(e) => updateSection(sec.id, e.target.value)}
                />
              ) : (
                <AssistantMarkdown text={sec.markdown} />
              )}
            </section>
          ))
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 加纸张 token 作用域到 index.css**

在 `apps/desktop/src/renderer/src/index.css` 末尾追加：

```css
/* 方案纸张：白纸黑字。AssistantMarkdown 用 hsl(var(--foreground)) 等主题 token 上色，
   暗色主题下前景是暖白、落到白纸上几乎不可见。这里在纸张作用域内把前景/次级/边框
   token 覆盖为纸墨色，子树所有 text-foreground/border-border 自动变深，无需逐元素
   !important。仅覆盖正文相关 token；accent 不覆盖，保留主题强调色。 */
.proposal-paper {
  --foreground: 0 0% 11%;
  --muted-foreground: 0 0% 40%;
  --border: 0 0% 85%;
  --card: 0 0% 96%;
  --muted: 0 0% 96%;
  font-family: 'Songti SC', 'SimSun', Georgia, 'Times New Roman', serif;
}
```

- [ ] **Step 3: 把面板分节区替换为 ProposalPaper**

在 `ProposalDocPanel.tsx`：

(a) 顶部 import 加：

```ts
import { ProposalPaper } from './ProposalPaper'
```

(b) 删掉不再由面板直接使用的状态/订阅：移除 `const [editingId, setEditingId] = useState<string | null>(null)`（line 20）、`const { updateSection, removeSection, moveSection, setProducts } = useProposalStore.getState()` 改为只取 `const { setProducts } = useProposalStore.getState()`（line 15）、移除 `proposalSid` / `generating` 两行（line 17-18）。`sections` / `products` 仍保留（导出与 chip 用）。

(c) 把分节渲染块——即 `{/* 分节文档区… */}` 注释起到对应 `</div>` 止的整段（line 120-178，`<div className="flex-1 space-y-2 overflow-auto p-3">...</div>`）整体替换为：

```tsx
      <ProposalPaper />
```

(d) 若 `useState` 因此变为未使用，删掉其 import 中的 `useState`（保留 `useEffect`）。`AssistantMarkdown` 的 import 也不再被面板直接使用，一并删除。

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: PASS（如报「未使用」类错误，按 Step 3(d) 清理 import）。

- [ ] **Step 5: 手测连续长纸**

`bun run dev` → 进入方案会话、让草稿有几节。预期：右侧面板内是一张白纸长卷、各节无缝拼接、向下滚动不分页；悬停某节右侧浮出工具条；点 ✎ 就地变 textarea 改字、✓ 收起；上/下移、删除有效；截断节有黄色徽标。（面板此时仍是窄的 w-96，纸张按 `min(794, 100%-48)` 收窄、可横向滚动——属预期，T8 拓宽后舒展。）

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx apps/desktop/src/renderer/src/index.css apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx
git commit -m "$(printf 'feat(proposal): 编辑态换皮为连续长纸 ProposalPaper（悬停工具条 + 就地编辑）\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 6: 预览态 `ProposalPreview`（docx-preview 真分页）

**Files:**
- Modify: `apps/desktop/package.json`（加依赖）
- Create: `apps/desktop/src/renderer/src/components/workspace/ProposalPreview.tsx`

**Interfaces:**
- Consumes: `window.chatApi.renderProposal`（Task 1）、`docx-preview` 的 `renderAsync`、`useProposalStore`（`sections`）。
- Produces: `ProposalPreview(): React.JSX.Element`——自含渲染状态，把当前草稿渲染成 A4 分页。

- [ ] **Step 1: 安装 docx-preview**

```bash
cd apps/desktop && bun add docx-preview
```

Expected: `package.json` 的 `dependencies` 出现 `docx-preview`；`bun.lock` 更新。

- [ ] **Step 2: 写 ProposalPreview 组件**

```tsx
import { useEffect, useRef, useState } from 'react'
import { renderAsync } from 'docx-preview'
import { useProposalStore } from '../../stores/proposal'

/**
 * 预览态：把当前草稿拼成 markdown → 走与「导出 Word」完全相同的引擎
 * (renderProposal IPC → markdownToDocxBuffer) 生成真 .docx → docx-preview
 * 渲染成一页页 A4（真分页）。故预览分页 = 导出成品逐像素一致。
 *
 * 渲染异步：生成 + 渲染期间显示 spinner；失败显示错误态可重试；空草稿显示空态。
 * lastRendered 缓存上次成功渲染的 markdown，未变则跳过重渲（来回切 tab 不重复生成）。
 * effect 只依赖 [sections, nonce]——nonce 仅由「重试」自增，避免把 status 放进依赖
 * 造成的重渲循环。
 */
type Status = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

export function ProposalPreview(): React.JSX.Element {
  const sections = useProposalStore((s) => s.sections)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const lastRendered = useRef<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [errMsg, setErrMsg] = useState('')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const markdown = sections.map((s) => s.markdown).join('\n\n').trim()
    if (!markdown) {
      lastRendered.current = null
      if (hostRef.current) hostRef.current.innerHTML = ''
      setStatus('empty')
      return
    }
    if (markdown === lastRendered.current) return // 该内容已渲染，跳过

    let cancelled = false
    setStatus('loading')
    void (async () => {
      try {
        const { bytes } = await window.chatApi.renderProposal({ markdown })
        if (cancelled) return
        const host = hostRef.current
        if (!host) return
        host.innerHTML = ''
        const blob = new Blob([bytes], {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        })
        // inWrapper + breakPages：得到带页间留白、阴影、真分页的 A4 页面。
        // 样式注入限定在 host 容器内（renderAsync 第 2 参即挂载容器），卸载/重渲前
        // 清空 innerHTML，避免污染应用其它部分。
        await renderAsync(blob, host, undefined, {
          inWrapper: true,
          breakPages: true,
          ignoreWidth: false,
          ignoreHeight: false,
          className: 'docx'
        })
        if (cancelled) return
        lastRendered.current = markdown
        setStatus('ready')
      } catch (err) {
        if (cancelled) return
        setErrMsg(err instanceof Error ? err.message : String(err))
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sections, nonce])

  return (
    <div className="relative flex-1 overflow-hidden">
      <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-black/55 px-3 py-1 text-[11px] text-white backdrop-blur">
        ▤ 真预览 · 与最终导出的 Word 逐像素一致
      </div>
      <div className="h-full overflow-auto bg-neutral-200 py-8 dark:bg-neutral-900">
        <div ref={hostRef} className="proposal-docx-host" />
      </div>

      {status === 'loading' && (
        <div className="absolute inset-0 grid place-items-center bg-neutral-200/80 dark:bg-neutral-900/80">
          <div className="flex flex-col items-center gap-3">
            <div className="size-6 animate-spin rounded-full border-[2.5px] border-border border-t-accent" />
            <div className="text-[12px] text-muted-foreground">正在生成 .docx 并渲染分页…</div>
          </div>
        </div>
      )}
      {status === 'empty' && (
        <div className="absolute inset-0 grid place-items-center text-[13px] text-muted-foreground">
          草稿为空，无可预览内容
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex max-w-[80%] flex-col items-center gap-3 text-center">
            <div className="text-[13px] text-rose-500">预览生成失败</div>
            <div className="text-[11px] text-muted-foreground">{errMsg}</div>
            <button
              className="rounded border border-border px-3 py-1 text-[12px] hover:border-accent"
              onClick={() => {
                lastRendered.current = null
                setNonce((n) => n + 1)
              }}
            >
              重试
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: PASS。若报找不到 `docx-preview` 类型，确认 Step 1 安装成功（该包自带 d.ts）。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/package.json apps/desktop/bun.lock apps/desktop/src/renderer/src/components/workspace/ProposalPreview.tsx
git commit -m "$(printf 'feat(proposal): 新增 docx-preview 预览组件 ProposalPreview（真分页 A4）\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 7: 面板头部加「编辑 ｜ 预览」切换 + 自适应宽度 + 工作台再入

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx`

**Interfaces:**
- Consumes: `ProposalPaper`（Task 5）、`ProposalPreview`（Task 6）、`useProposalWorkspace` / `useProposalStore`（Task 3）。
- Produces: 面板按本地 `mode` 渲染 Paper/Preview；根宽度随 `useProposalWorkspace()` 在 `flex-1`（工作台）/ `w-96`（返回态）间切换；返回态头部显示「⤢ 工作台」再入按钮。

- [ ] **Step 1: import 与状态**

`ProposalDocPanel.tsx` 顶部加：

```ts
import { useProposalWorkspace } from '../../stores/proposal'
import { ProposalPreview } from './ProposalPreview'
```

（`ProposalPaper` 已在 Task 5 import。`useState` 仍需要——确保其在 `react` import 中。）

在组件内 `const show = useProposalForeground()` 之后加：

```ts
  const isWorkspace = useProposalWorkspace()
  const setWorkspaceOpen = useProposalStore((s) => s.setWorkspaceOpen)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
```

- [ ] **Step 2: 根容器宽度自适应**

把根 `return` 的 `<div className="flex w-96 flex-col border-l border-border bg-background text-foreground">`（line 55）改为：

```tsx
    <div
      className={
        'flex flex-col border-l border-border bg-background text-foreground ' +
        (isWorkspace ? 'flex-1 min-w-0' : 'w-96')
      }
    >
```

- [ ] **Step 3: 头部加 编辑/预览 segmented + 再入按钮**

把头部 `<div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">...</div>`（line 56-74）整体替换为：

```tsx
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">方案草稿</span>

        {/* 编辑 ｜ 预览 segmented */}
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          <button
            className={
              'rounded-md px-3 py-1 ' +
              (mode === 'edit' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')
            }
            onClick={() => setMode('edit')}
          >
            ✎ 编辑
          </button>
          <button
            className={
              'rounded-md px-3 py-1 ' +
              (mode === 'preview' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground')
            }
            onClick={() => setMode('preview')}
          >
            ▤ 预览
          </button>
        </div>

        <div className="flex items-center gap-1">
          {/* 返回态（非工作台）显示再入按钮：把工作台重新打开，不丢草稿 */}
          {!isWorkspace && (
            <button
              className="rounded px-2 py-0.5 hover:bg-muted"
              onClick={() => setWorkspaceOpen(true)}
              title="展开为方案工作台"
            >
              ⤢ 工作台
            </button>
          )}
          <button
            className="rounded px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            disabled={exporting}
            onClick={() => {
              void handleExport('docx')
            }}
          >
            {exporting ? '导出中…' : '导出 Word'}
          </button>
          <button
            className="rounded px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            disabled={exporting}
            onClick={() => {
              void handleExport('md')
            }}
          >
            .md
          </button>
        </div>
      </div>
```

- [ ] **Step 4: body 按 mode 渲染**

把 Task 5 留下的 `<ProposalPaper />`（面板 body）替换为：

```tsx
      {mode === 'edit' ? <ProposalPaper /> : <ProposalPreview />}
```

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 6: 手测 编辑/预览 切换**

`bun run dev` → 方案会话有内容时：点「▤ 预览」→ 短暂 loading → 出 A4 分页页面（底部页码、页间留白）；与「导出 Word」存盘后打开的文件逐页比对一致。点「✎ 编辑」→ 回连续长纸。空草稿点预览 → 空态。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx
git commit -m "$(printf 'feat(proposal): 面板加 编辑/预览 切换 + 自适应宽度 + 工作台再入按钮\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

### Task 8: App.tsx 工作台接管布局（撤历史栏 + 可折叠对话列 + 分隔条 + 返回）

**Files:**
- Modify: `apps/desktop/src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `useProposalWorkspace`（Task 3）、`PaneSplitter`（Task 4）、`useProposalStore.setWorkspaceOpen`。
- Produces: 方案工作台模式下隐藏 `ThreadListSidebar`、把 `ThreadView` 收进可折叠对话列、插入分隔条、左上角返回 + 折叠态浮动簇。`ThreadView` 始终挂在同一位置（带稳定 `key`），不重挂。

- [ ] **Step 1: import 与布局状态**

`App.tsx` 顶部 import 区加：

```ts
import { useProposalForeground, useProposalWorkspace, useProposalStore } from './stores/proposal'
import { PaneSplitter } from './components/workspace/PaneSplitter'
import { useRef } from 'react'
```

（注意：`useProposalForeground` 原本已 import（line 14），把它并入这一行、避免重复 import；`useRef` 并入既有 `react` import。）

在 `App()` 内、`const proposalForeground = useProposalForeground()`（line 209）之后加：

```ts
  const proposalWorkspace = useProposalWorkspace()
  const setWorkspaceOpen = useProposalStore((s) => s.setWorkspaceOpen)
  const rowRef = useRef<HTMLDivElement | null>(null)

  // 对话列宽度/折叠：持久化到 localStorage（每 tab 一个 renderer，天然按 tab 隔离）。
  // 初值用惰性 initializer 读 localStorage，避免每次渲染重读。
  const [chatColWidth, setChatColWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('proposal:chatColWidth'))
    return Number.isFinite(v) && v >= 320 ? v : 420
  })
  const [chatCollapsed, setChatCollapsed] = useState<boolean>(
    () => localStorage.getItem('proposal:chatCollapsed') === '1'
  )
  useEffect(() => {
    localStorage.setItem('proposal:chatColWidth', String(chatColWidth))
  }, [chatColWidth])
  useEffect(() => {
    localStorage.setItem('proposal:chatCollapsed', chatCollapsed ? '1' : '0')
  }, [chatCollapsed])

  // 分隔条拖动：clientX → 对话列宽度（钳制在 [320, 行宽-A4(794)-留白(64)-条(7)]）。
  function onSplitDrag(clientX: number): void {
    const row = rowRef.current
    if (!row) return
    const r = row.getBoundingClientRect()
    const max = Math.max(320, r.width - 794 - 64 - 7)
    const w = Math.max(320, Math.min(clientX - r.left, max))
    setChatColWidth(w)
  }
```

- [ ] **Step 2: 给 row 挂 ref**

把 `<div className="flex min-h-0 flex-1">`（line 250）改为：

```tsx
          <div ref={rowRef} className="flex min-h-0 flex-1">
```

- [ ] **Step 3: 隐藏对话历史栏（工作台模式）**

把对话历史栏块（line 254-256）：

```tsx
            <div className="h-full w-64 shrink-0">
              <ThreadListSidebar />
            </div>
```

改为（工作台模式不渲染）：

```tsx
            {!proposalWorkspace && (
              <div className="h-full w-64 shrink-0">
                <ThreadListSidebar />
              </div>
            )}
```

- [ ] **Step 4: 把 ThreadView 包进恒定的可折叠对话列**

把裸 `<ThreadView />`（line 257）替换为下面整段。**关键**：包裹 `<div>` 与 `<ThreadView key="main-thread" />` 在两种模式下都渲染于同一位置，仅切 className/宽度——`key` 保证工作台头部出现/消失时 ThreadView 不被重挂：

```tsx
            <div
              className={
                proposalWorkspace
                  ? 'relative flex h-full min-h-0 flex-col overflow-hidden border-r border-border'
                  : 'flex min-h-0 flex-1 flex-col'
              }
              style={
                proposalWorkspace
                  ? {
                      width: chatCollapsed ? 0 : chatColWidth,
                      transition: 'width .26s cubic-bezier(.4,0,.2,1)'
                    }
                  : undefined
              }
            >
              {proposalWorkspace && (
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <button
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium hover:bg-muted"
                    onClick={() => setWorkspaceOpen(false)}
                  >
                    ← 返回
                  </button>
                  <button
                    className="grid size-7 place-items-center rounded-md border border-border text-muted-foreground hover:border-accent hover:text-accent"
                    title="折叠对话"
                    onClick={() => setChatCollapsed(true)}
                  >
                    «
                  </button>
                </div>
              )}
              <ThreadView key="main-thread" />
            </div>

            {/* 折叠态浮动簇：返回 + 展开对话，悬纸张左上角、不挡正文 */}
            {proposalWorkspace && chatCollapsed && (
              <div className="absolute left-0 top-12 z-30 flex flex-col gap-2 p-2">
                <button
                  className="grid size-9 place-items-center rounded-lg border border-border bg-card text-foreground shadow-lg hover:border-accent hover:text-accent"
                  title="返回"
                  onClick={() => setWorkspaceOpen(false)}
                >
                  ←
                </button>
                <button
                  className="grid size-9 place-items-center rounded-lg border border-border bg-card text-foreground shadow-lg hover:border-accent hover:text-accent"
                  title="展开对话"
                  onClick={() => setChatCollapsed(false)}
                >
                  ▤
                </button>
              </div>
            )}

            {/* 分隔条：仅工作台且未折叠 */}
            {proposalWorkspace && !chatCollapsed && <PaneSplitter onDrag={onSplitDrag} />}
```

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: PASS。若报 `useProposalForeground` 重复 import，按 Step 1 合并到一行解决。

- [ ] **Step 6: 手测工作台全链路**

`bun run dev`：
1. 进入方案会话 → 对话历史栏消失、左上角「← 返回」、对话变成 420px 列、方案面板拓宽到 `flex-1`、纸张舒展到 ~A4 宽。
2. 拖中间分隔条 → 对话/纸张比例随动；对话列不小于 320px。
3. 点「«」折叠 → 对话列收到 0、纸张铺满、左上角浮出「← / ▤」；点「▤」展开复原。
4. 点「← 返回」→ 回正常三栏（对话历史栏回来），草稿不丢；方案面板变窄 w-96，其头部出现「⤢ 工作台」；点它 → 回工作台、草稿仍在。
5. 在 tab 内切到别的非方案会话 → 立即回正常三栏（`useProposalWorkspace` 为假，无需手动返回）。
6. 重启 dev → 折叠态/对话列宽度被 localStorage 记住。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/App.tsx
git commit -m "$(printf 'feat(proposal): 方案工作台接管布局——撤历史栏 + 可折叠对话列 + 分隔条 + 返回/再入\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Self-Review（计划 vs spec 覆盖核对）

- **连续长纸编辑**（spec §4）→ Task 5（ProposalPaper + 纸张 token + 接进面板）。✓
- **悬停工具条 + 就地 textarea + 截断徽标**（§4）→ Task 5 组件。✓
- **预览态 docx-preview 真分页**（§5.1）→ Task 6 + Task 7（toggle 接入）。✓
- **一致性：预览与导出同引擎**（§5.1）→ Task 1 handler 直接调 `markdownToDocxBuffer`，与 export 同。✓
- **缓存/重渲不循环、生成中快照**（§5.2）→ Task 6 `lastRendered` + `nonce` 依赖设计。✓
- **样式隔离**（§5.3）→ Task 6 渲染进独立 host + 重渲前清空 innerHTML（注释说明）。✓
- **页码方案 A**（§5.4）→ Task 2 页脚 PageNumber（导出与预览同时受益）。✓
- **新 IPC proposal:render 改三处**（§6）→ Task 1 Step 1-7。✓
- **docx-preview 依赖**（§7）→ Task 6 Step 1。✓
- **store workspaceOpen + useProposalWorkspace**（§3.1）→ Task 3。✓
- **布局三态 / 返回不销毁草稿 / 再入按钮**（§3.1）→ Task 3（标志）+ Task 7（再入按钮）+ Task 8（接管布局 + 返回）。✓
- **ThreadView 不重挂**（§3.2）→ Task 8 Step 4（恒定包裹 + 稳定 key，仅切 className/宽度）。✓
- **可折叠对话列 + 浮动返回簇 + 分隔条 + min 320**（§3.3）→ Task 8 + Task 4。✓
- **布局偏好持久化 localStorage**（§3.3）→ Task 8 Step 1。✓
- **空草稿/渲染失败/窄窗**（§9）→ Task 6 空/错态；窄窗靠纸张 `min(794,100%-48)` 横向滚动 + 对话列 min 320。✓

类型一致性核对：`renderProposal` / `ProposalRenderPayload` / `ProposalRenderResult`（T1 定义，T6 消费）一致；`setWorkspaceOpen` / `workspaceOpen` / `useProposalWorkspace`（T3 定义，T7/T8 消费）一致；`PaneSplitter` 的 `onDrag(clientX:number)`（T4 定义，T8 `onSplitDrag` 消费）一致。

无占位符、每个代码步均给出完整代码与确切路径/行号锚点。

## 风险提示（执行时留意）

- **`docx-preview` 全局样式**：Task 6 已限定挂载容器并重渲前清空；手测时确认预览页样式未渗到聊天/面板其它处。若发现渗漏，按全局 CLAUDE.md 规范记入 Obsidian vault 的 errors/。
- **Task 8 是最大改动面**：动 `App.tsx` flex 行。务必先确认 Step 4 的 ThreadView 稳定 `key` 生效——切工作台/返回时聊天滚动位置与历史不应闪断重载。
- **行号会漂移**：本计划标注的行号基于当前 HEAD；前序任务提交后下游任务的行号可能位移，以「锚点代码片段」为准定位，不要死认行号。
