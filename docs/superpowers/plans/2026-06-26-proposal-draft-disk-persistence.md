# 方案草稿落盘持久化 + 多草稿 LRU 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把方案草稿（含用户手改）持久化到磁盘、按会话隔离、退出 App 不丢，并以 LRU 只保留最近 10 份。

**Architecture:** 内存仍只持有前台会话那 1 份草稿；磁盘 `userData/proposal-drafts/<sessionId>.json` 承载「多草稿 + 退出不丢手改」。打开会话时按「内存已有 → 盘上有 → transcript 兜底」三级载入。renderer 用单订阅器防抖写盘 + 切换会话前 flush。main 在每次写盘后跑 mtime LRU 淘汰。

**Tech Stack:** Electron（main/preload/renderer 三进程）、TypeScript、zustand、Node `fs/promises`、bun。

## Global Constraints

- 包管理器是 **bun**，不是 npm。
- **无单元测试 / 无 ESLint**；唯一自动化质量门是 `bun run typecheck`（每个任务必须跑通）。手动验证靠 `bun run dev`。
- 加一条 IPC 改三处：`shared/ipc-channels.ts`（通道常量 + 载荷/返回类型 + `ChatApi` 方法签名）→ `preload/index.ts`（实现）→ `main/ipc/register.ts`（handler）。`preload/index.d.ts` 引用的是 `ChatApi`，无需改。
- 注释解释「为什么这样而不那样」，沿用仓库高注释密度风格。
- renderer 禁止 import Node 模块；一切主进程能力走 `window.chatApi`。
- 草稿目录路径必须经 `app.getPath('userData')` **惰性**求值（避免模块加载期触发 Electron "app not ready"），范式见 `main/core/kbIndexStore.ts`。

---

### Task 1: 共享 IPC 契约（类型 + 通道常量 + ChatApi 签名）

**Files:**
- Modify: `apps/desktop/src/shared/ipc-channels.ts`

**Interfaces:**
- Produces:
  - `ProposalDraftRecord`（持久化记录 v1）
  - `ProposalLoadDraftPayload` / `ProposalDeleteDraftPayload`
  - `ProposalSaveDraftResult` / `ProposalDeleteDraftResult`
  - 通道常量 `PROPOSAL_SAVE_DRAFT` / `PROPOSAL_LOAD_DRAFT` / `PROPOSAL_DELETE_DRAFT`
  - `ChatApi.saveProposalDraft / loadProposalDraft / deleteProposalDraft`

- [ ] **Step 1: 加 import（复用 shared 的 ProposalKind，避免 kind 联合重复定义）**

文件顶部已有 `import type { ProposalStyleConfig } from './proposalStyle'`（约第 10 行）。在其下追加：

```ts
import type { ProposalKind } from './proposal'
```

（`shared/proposal.ts` 不 import 本文件，无循环依赖。）

- [ ] **Step 2: 加通道常量**

在 `IPC_CHANNELS` 对象里，`PROPOSAL_RENDER: 'proposal:render'`（约第 458 行）之后补三条（注意给 `PROPOSAL_RENDER` 行补逗号）：

```ts
  PROPOSAL_RENDER: 'proposal:render',
  /** Renderer → main. 写入/读出/删除某会话的持久化草稿（userData/proposal-drafts/<id>.json）。 */
  PROPOSAL_SAVE_DRAFT: 'proposal:save-draft',
  PROPOSAL_LOAD_DRAFT: 'proposal:load-draft',
  PROPOSAL_DELETE_DRAFT: 'proposal:delete-draft'
```

- [ ] **Step 3: 加载荷/返回/记录类型**

在 `ProposalRenderResult` 接口（约第 850 行）之后追加：

```ts
/**
 * 一份持久化的方案草稿记录（v1）。写入 userData/proposal-drafts/<sessionId>.json。
 * sections/products 结构与 renderer 的 ProposalSection/ProposalProduct 同构——本文件是
 * shared、不能 import renderer 类型，故在此内联其结构（字段须与 renderer 保持一致）。
 * consumedDraftIds/viewMode/workspaceOpen 刻意不持久化（见设计 spec「数据模型」）。
 */
export interface ProposalDraftRecord {
  version: 1
  sessionId: string
  sections: Array<{
    id: string
    markdown: string
    kind: ProposalKind
    truncated?: boolean
  }>
  products: Array<{ productLine: string; product: string }>
  phase: ProposalKind
  updatedAt: number
}

export interface ProposalLoadDraftPayload {
  sessionId: string
}
export interface ProposalDeleteDraftPayload {
  sessionId: string
}
export interface ProposalSaveDraftResult {
  ok: boolean
}
export interface ProposalDeleteDraftResult {
  ok: boolean
}
```

- [ ] **Step 4: 加 ChatApi 方法签名**

在 `ChatApi` 接口里 `renderProposal(...)` 签名（约第 1226 行）之后追加：

```ts
  /**
   * 持久化草稿三件套。saveProposalDraft 写盘并跑 LRU；loadProposalDraft 不存在返回 null；
   * deleteProposalDraft 删除该会话草稿文件（「清空草稿」用）。失败一律返回 ok:false / null，
   * 绝不抛——持久化是「尽力而为」，不得阻塞会话切换。
   */
  saveProposalDraft(record: ProposalDraftRecord): Promise<ProposalSaveDraftResult>
  loadProposalDraft(payload: ProposalLoadDraftPayload): Promise<ProposalDraftRecord | null>
  deleteProposalDraft(payload: ProposalDeleteDraftPayload): Promise<ProposalDeleteDraftResult>
```

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: PASS（`@claude-desktop/desktop typecheck: Exited with code 0`）。此刻 preload/register 还没实现这三个方法，但 `ChatApi` 只是接口声明、preload 的实现对象未做穷尽性检查，故 typecheck 仍过。

- [ ] **Step 6: commit**

```bash
git add apps/desktop/src/shared/ipc-channels.ts
git commit -m "feat(proposal): 草稿持久化 IPC 契约（类型+通道+ChatApi 签名）"
```

---

### Task 2: 后端持久层（proposalDraftStore + handlers + preload）

**Files:**
- Create: `apps/desktop/src/main/core/proposalDraftStore.ts`
- Modify: `apps/desktop/src/main/ipc/register.ts`（import、removeHandler、三个 handler）
- Modify: `apps/desktop/src/preload/index.ts`（import、三个方法）

**Interfaces:**
- Consumes: Task 1 的 `ProposalDraftRecord` / payload / result 类型与三个通道常量。
- Produces:
  - `saveProposalDraft(record): Promise<void>` / `loadProposalDraft(sessionId): Promise<ProposalDraftRecord|null>` / `deleteProposalDraft(sessionId): Promise<void>`（main core）
  - `window.chatApi.saveProposalDraft / loadProposalDraft / deleteProposalDraft`（renderer 可调）

- [ ] **Step 1: 新建 `main/core/proposalDraftStore.ts`**

```ts
/**
 * 方案草稿持久层（main 侧）。每会话一个 JSON 文件存在 userData/proposal-drafts/，
 * 与会话 JSONL（transcript）解耦：transcript 兜底 AI 正文，本层额外保住用户手改
 * （逐节编辑/重排/删节/产品 chip）。LRU 只留 mtime 最新的 MAX_DRAFTS 份。
 *
 * 路径惰性求值（draftsDir 内才调 app.getPath），避免模块加载期触发 "app not ready"
 * （范式同 kbIndexStore.ts）。所有读写防御式 try/catch——持久化失败绝不冒泡阻塞调用方。
 */
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile, writeFile, unlink, readdir, stat } from 'node:fs/promises'
import type { ProposalDraftRecord } from '../../shared/ipc-channels'

const TAG = '[proposalDraftStore]'
/** 磁盘上最多保留的草稿份数（LRU 上限）。超出按 mtime 淘汰最旧。 */
const MAX_DRAFTS = 10

const draftsDir = (): string => join(app.getPath('userData'), 'proposal-drafts')
const draftPath = (sessionId: string): string => join(draftsDir(), `${sessionId}.json`)

function ensureDir(): void {
  const dir = draftsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** 写入一份草稿后跑 LRU 淘汰。调用方已校验 record 基本合法。 */
export async function saveProposalDraft(record: ProposalDraftRecord): Promise<void> {
  ensureDir()
  await writeFile(draftPath(record.sessionId), JSON.stringify(record), 'utf8')
  await evictOldDrafts()
}

/** 读出某会话草稿。文件不存在 / 解析失败 / 版本或 id 不匹配 → null。 */
export async function loadProposalDraft(
  sessionId: string
): Promise<ProposalDraftRecord | null> {
  const p = draftPath(sessionId)
  if (!existsSync(p)) return null
  try {
    const rec = JSON.parse(await readFile(p, 'utf8')) as ProposalDraftRecord
    if (rec?.version !== 1 || rec.sessionId !== sessionId) return null
    return rec
  } catch (err) {
    console.warn(`${TAG} loadProposalDraft ${sessionId} failed:`, err)
    return null
  }
}

/** 删除某会话草稿文件（「清空草稿」用）。不存在或删除失败均静默。 */
export async function deleteProposalDraft(sessionId: string): Promise<void> {
  const p = draftPath(sessionId)
  try {
    if (existsSync(p)) await unlink(p)
  } catch (err) {
    console.warn(`${TAG} deleteProposalDraft ${sessionId} failed:`, err)
  }
}

/** LRU：保留 mtime 最新的 MAX_DRAFTS 个 .json，其余删除。当前刚写那份 mtime 最新、永不自删。 */
async function evictOldDrafts(): Promise<void> {
  const dir = draftsDir()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const files = names.filter((n) => n.endsWith('.json'))
  if (files.length <= MAX_DRAFTS) return
  const withMtime = await Promise.all(
    files.map(async (n) => {
      try {
        const s = await stat(join(dir, n))
        return { name: n, mtime: s.mtimeMs }
      } catch {
        return { name: n, mtime: 0 }
      }
    })
  )
  withMtime.sort((a, b) => b.mtime - a.mtime) // 新 → 旧
  for (const f of withMtime.slice(MAX_DRAFTS)) {
    try {
      await unlink(join(dir, f.name))
    } catch (err) {
      console.warn(`${TAG} evict ${f.name} failed:`, err)
    }
  }
}
```

- [ ] **Step 2: register.ts — 加 import**

在 register.ts 现有 `import { markdownToDocxBuffer } from '../core/proposalDocx'`（约第 84 行）之后追加：

```ts
import {
  saveProposalDraft,
  loadProposalDraft,
  deleteProposalDraft
} from '../core/proposalDraftStore'
```

并把这些类型加进现有从 `'../../shared/ipc-channels'`（或 `@shared/ipc-channels`，按文件现有写法）import 的 `import type { ... }` 块：`ProposalDraftRecord`、`ProposalLoadDraftPayload`、`ProposalDeleteDraftPayload`、`ProposalSaveDraftResult`、`ProposalDeleteDraftResult`。

- [ ] **Step 3: register.ts — 加 removeHandler（热重载幂等）**

在 `ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_RENDER)`（约第 221 行）之后追加：

```ts
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_SAVE_DRAFT)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_LOAD_DRAFT)
  ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_DELETE_DRAFT)
```

- [ ] **Step 4: register.ts — 加三个 handler**

在 `PROPOSAL_RENDER` 的 `ipcMain.handle(...)` 块（约第 1043 行结束）之后追加：

```ts
  // 草稿持久化三件套。全部防御式：非法载荷直接 ok:false/null，I/O 异常 catch 后同样
  // 降级返回——持久化是尽力而为，绝不让 reject 阻塞渲染层的会话切换。
  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_SAVE_DRAFT,
    async (_event, record: ProposalDraftRecord): Promise<ProposalSaveDraftResult> => {
      if (
        !record ||
        record.version !== 1 ||
        typeof record.sessionId !== 'string' ||
        !record.sessionId ||
        !Array.isArray(record.sections)
      ) {
        return { ok: false }
      }
      try {
        await saveProposalDraft(record)
        return { ok: true }
      } catch (err) {
        console.warn('[ipc] saveProposalDraft failed:', err)
        return { ok: false }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_LOAD_DRAFT,
    async (_event, payload: ProposalLoadDraftPayload): Promise<ProposalDraftRecord | null> => {
      const sid = payload?.sessionId
      if (typeof sid !== 'string' || !sid) return null
      return loadProposalDraft(sid)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.PROPOSAL_DELETE_DRAFT,
    async (_event, payload: ProposalDeleteDraftPayload): Promise<ProposalDeleteDraftResult> => {
      const sid = payload?.sessionId
      if (typeof sid !== 'string' || !sid) return { ok: false }
      try {
        await deleteProposalDraft(sid)
        return { ok: true }
      } catch (err) {
        console.warn('[ipc] deleteProposalDraft failed:', err)
        return { ok: false }
      }
    }
  )
```

- [ ] **Step 5: preload/index.ts — 加 import 与三个方法**

在 preload/index.ts 现有 ipc-channels 类型 import 块（约第 57-60 行，含 `type ProposalRenderResult`）里追加：

```ts
  type ProposalDraftRecord,
  type ProposalLoadDraftPayload,
  type ProposalDeleteDraftPayload,
  type ProposalSaveDraftResult,
  type ProposalDeleteDraftResult,
```

在 `renderProposal(...)` 方法（约第 407-412 行）之后、对象闭合 `}` 之前追加（注意给 `renderProposal` 块补尾逗号）：

```ts
  ,
  saveProposalDraft(record: ProposalDraftRecord): Promise<ProposalSaveDraftResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_SAVE_DRAFT,
      record
    ) as Promise<ProposalSaveDraftResult>
  },
  loadProposalDraft(
    payload: ProposalLoadDraftPayload
  ): Promise<ProposalDraftRecord | null> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_LOAD_DRAFT,
      payload
    ) as Promise<ProposalDraftRecord | null>
  },
  deleteProposalDraft(
    payload: ProposalDeleteDraftPayload
  ): Promise<ProposalDeleteDraftResult> {
    return ipcRenderer.invoke(
      IPC_CHANNELS.PROPOSAL_DELETE_DRAFT,
      payload
    ) as Promise<ProposalDeleteDraftResult>
  }
```

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: PASS。若报错多半是 import 名拼写或 `renderProposal` 后漏补逗号——按报错定位修正。

- [ ] **Step 7: commit**

```bash
git add apps/desktop/src/main/core/proposalDraftStore.ts apps/desktop/src/main/ipc/register.ts apps/desktop/src/preload/index.ts
git commit -m "feat(proposal): 草稿持久层 proposalDraftStore + 三个 IPC handler + preload 方法"
```

---

### Task 3: store 新增 restoreFromDisk

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/proposal.ts`（import、interface、实现）

**Interfaces:**
- Consumes: Task 1 的 `ProposalDraftRecord`。
- Produces: `useProposalStore` 的 `restoreFromDisk(record: ProposalDraftRecord): void`。

- [ ] **Step 1: 加 import**

在 proposal.ts 顶部 `import type { ProposalDraftBlock, ProposalKind } from '@shared/proposal'` 之后追加：

```ts
import type { ProposalDraftRecord } from '@shared/ipc-channels'
```

- [ ] **Step 2: interface 加方法声明**

在 `ProposalState` 接口里、`restoreFromTranscript(...)` 声明之后追加：

```ts
  // 从磁盘持久草稿恢复（载入优先级第 2 级，盘上有记录时用）。整体替换草稿状态并接管
  // 工作台。products/phase/sections 全来自盘上（含用户手改）；consumedDraftIds 置空集
  // （单次运行内去重即可，resume 不重放历史 end）；seeded=true 不再中途重匹配产品。
  restoreFromDisk: (record: ProposalDraftRecord) => void
```

- [ ] **Step 3: 实现**

在实现对象里、`restoreFromTranscript: (...) => ...` 之后追加：

```ts
  restoreFromDisk: (record) =>
    set({
      active: true,
      sessionId: record.sessionId,
      products: record.products,
      seeded: true,
      consumedDraftIds: new Set(),
      sections: record.sections,
      phase: record.phase,
      workspaceOpen: true,
      viewMode: 'edit'
    }),
```

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 5: commit**

```bash
git add apps/desktop/src/renderer/src/stores/proposal.ts
git commit -m "feat(proposal): store 新增 restoreFromDisk（从持久草稿恢复）"
```

---

### Task 4: 载入优先级 — rebuild 改异步 + 盘优先 + 各切换点 await

**Files:**
- Modify: `apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx`（`rebuildProposalFromTranscript` 函数体 + `onSwitchToThread` 两处调用 + `onSwitchToNewThread` 新增清空）

**Interfaces:**
- Consumes: Task 3 的 `restoreFromDisk`；既有 `restoreFromTranscript` / `reset` / `setWorkspaceOpen`；`window.chatApi.loadProposalDraft`。
- Produces: `async function rebuildProposalFromTranscript(sessionId: string, messages: ThreadMessageLike[]): Promise<void>`。

- [ ] **Step 1: 整体替换 `rebuildProposalFromTranscript` 函数**

把现有 `function rebuildProposalFromTranscript(...) { ... }` 整个替换为下面的异步版（函数签名前加 `async`，新增「盘优先」第 2 级与「非方案会话清空前台」第 4 级）：

```ts
async function rebuildProposalFromTranscript(
  sessionId: string,
  messages: ThreadMessageLike[]
): Promise<void> {
  const ps = useProposalStore.getState()
  // 1. 内存里已有该会话草稿（含未保存手改，比盘上新）→ 保留，仅确保工作台可见。
  if (ps.active && ps.sessionId === sessionId && ps.sections.length > 0) {
    if (!ps.workspaceOpen) ps.setWorkspaceOpen(true)
    return
  }
  // 2. 盘上有持久草稿（含手改/产品/phase）→ 优先恢复。I/O 失败降级到 transcript，不抛。
  try {
    const rec = await window.chatApi.loadProposalDraft({ sessionId })
    if (rec && rec.sections.length > 0) {
      useProposalStore.getState().restoreFromDisk(rec)
      return
    }
  } catch (err) {
    console.warn('[runtime] loadProposalDraft failed:', err)
  }
  // 3. transcript 兜底：从 assistant 消息抽哨兵块重建（仅 AI 正文，不含手改）。
  const sections: ProposalSection[] = []
  const consumed = new Set<string>()
  for (const m of messages) {
    const mm = m as unknown as { id?: string; role?: string; content?: unknown }
    if (mm.role !== 'assistant') continue
    const text = Array.isArray(mm.content)
      ? (mm.content as Array<{ type?: string; text?: string }>)
          .filter((p) => p?.type === 'text' && p.text)
          .map((p) => p.text as string)
          .join('')
      : typeof mm.content === 'string'
        ? mm.content
        : ''
    if (!text) continue
    const { blocks, truncated } = extractProposalDraftResult(text)
    if (!blocks.length && !truncated) continue
    for (const b of blocks) {
      sections.push({ id: crypto.randomUUID(), markdown: b.markdown, kind: b.kind })
    }
    if (truncated) {
      sections.push({
        id: crypto.randomUUID(),
        markdown: truncated.markdown,
        kind: truncated.kind,
        truncated: true
      })
    }
    if (mm.id) consumed.add(mm.id)
  }
  if (sections.length === 0) {
    // 4. 非方案会话：清空前台 store（旧草稿已在盘上、无损），避免陈旧草稿被「写方案」误 reopen。
    if (useProposalStore.getState().active) useProposalStore.getState().reset()
    return
  }
  // transcript 重建出的草稿：写进 store；订阅器（Task 5）随后自动落盘建档。
  const phase = sections[sections.length - 1].kind
  useProposalStore
    .getState()
    .restoreFromTranscript({ sessionId, sections, consumedDraftIds: consumed, phase })
}
```

并同步更新函数上方的块注释（现有注释讲的是「内存→transcript」两级，补成「内存→盘→transcript→非方案清空」四级；其余说明保留）。

- [ ] **Step 2: `onSwitchToThread` 两处调用改 await**

把常规路径（约第 694-697 行）：

```ts
        setSession(id, messages as ThreadMessageLike[])
        // 历史会话载入即重建方案草稿……
        rebuildProposalFromTranscript(id, messages as ThreadMessageLike[])
```

改为：

```ts
        setSession(id, messages as ThreadMessageLike[])
        // 历史会话载入即重建方案草稿（盘优先、transcript 兜底）。await 确保草稿与历史一起就绪。
        await rebuildProposalFromTranscript(id, messages as ThreadMessageLike[])
```

把静默 fork 重绑路径（约第 703-708 行）里的：

```ts
          setSession(activeId, messages as ThreadMessageLike[])
          // 静默 fork 重绑：草稿也重绑到真实 id……
          rebuildProposalFromTranscript(activeId, messages as ThreadMessageLike[])
```

改为：

```ts
          setSession(activeId, messages as ThreadMessageLike[])
          // 静默 fork 重绑：草稿也重绑到真实 id。
          await rebuildProposalFromTranscript(activeId, messages as ThreadMessageLike[])
```

- [ ] **Step 3: `onSwitchToNewThread` 新建后清空前台草稿**

在 `onSwitchToNewThread` 里 `setSession(activeId, [])`（约第 649 行）之后追加：

```ts
      setSession(activeId, [])
      // 新建空会话：以空 messages 走同一重建（盘上无该 id 草稿 → 走第 4 级 reset），清掉
      // 前台可能残留的别会话草稿，避免「写方案」把旧草稿 reopen 到新会话（陈旧草稿劫持）。
      await rebuildProposalFromTranscript(activeId, [])
```

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: PASS。注意 `onSwitchToThread`/`onSwitchToNewThread` 已是 async，`await` 合法。

- [ ] **Step 5: 手动冒烟（依赖 Task 5 才完整，但盘读路径可先验）**

此时尚无写盘（Task 5 才加），故盘上无文件，载入走 transcript 兜底——行为应与改造前一致：`bun run dev` → 生成草稿 → 切到普通会话再切回 → 草稿仍在（transcript 重建）。打开普通会话不应残留上一个草稿。

- [ ] **Step 6: commit**

```bash
git add apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx
git commit -m "feat(proposal): 载入优先级改盘优先（rebuild 异步 + 各切换点 await + 非方案清空）"
```

---

### Task 5: 写盘订阅器 + 切换前 flush

**Files:**
- Modify: `apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx`（组件内加 ref + flush 回调 + 订阅 effect + 两个切换回调首行 flush）

**Interfaces:**
- Consumes: `window.chatApi.saveProposalDraft`；`useProposalStore`。
- Produces: 组件内 `flushProposalSave()`（供切换回调调用）。

> 注意：以下 `useRef` / `useCallback` / `useEffect` 必须加在 `FusionRuntimeProvider` 组件函数体内（与 `onSwitchToThread` 同作用域），不是模块级。`useRef`/`useCallback`/`useEffect` 已在文件顶部 import。

- [ ] **Step 1: 加 timer ref + flush 回调**

在组件内 `onSwitchToThread` 的 `useCallback` 定义**之前**插入：

```ts
  // 防抖写盘：草稿任一改动后 ~800ms 落盘一次（合并连续键入）。timer 放 ref 以便切换会话
  // 前同步 flush（防最后几笔手改还没落盘就被新会话覆盖）。
  const proposalSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushProposalSave = useCallback((): void => {
    if (proposalSaveTimer.current) {
      clearTimeout(proposalSaveTimer.current)
      proposalSaveTimer.current = null
    }
    const s = useProposalStore.getState()
    // 只存「有内容的活跃草稿」；空草稿不建档（避免起草前就生成空文件）。
    if (!s.active || !s.sessionId || s.sections.length === 0) return
    void window.chatApi.saveProposalDraft({
      version: 1,
      sessionId: s.sessionId,
      sections: s.sections,
      products: s.products,
      phase: s.phase,
      updatedAt: Date.now()
    })
  }, [])
```

- [ ] **Step 2: 加订阅 effect**

紧接 Step 1 之后插入：

```ts
  // 订阅草稿 store：任一改动重置 800ms 防抖计时，到点落盘。卸载时清计时 + 退订。
  useEffect(() => {
    const unsub = useProposalStore.subscribe(() => {
      const s = useProposalStore.getState()
      if (!s.active || !s.sessionId || s.sections.length === 0) return
      if (proposalSaveTimer.current) clearTimeout(proposalSaveTimer.current)
      proposalSaveTimer.current = setTimeout(() => {
        proposalSaveTimer.current = null
        flushProposalSave()
      }, 800)
    })
    return () => {
      if (proposalSaveTimer.current) clearTimeout(proposalSaveTimer.current)
      unsub()
    }
  }, [flushProposalSave])
```

- [ ] **Step 3: 两个切换回调首行 flush**

在 `onSwitchToThread` 的 `try {` 之后、`setSessionLoading(true)` 之前插入：

```ts
      // 切走前把当前会话草稿的最后改动落盘（防抖可能还没触发）。
      flushProposalSave()
```

在 `onSwitchToNewThread` 的 `try {` 之后、`setSessionLoading(true)` 之前插入同样一行。

- [ ] **Step 4: 两个 useCallback 依赖数组补 flushProposalSave**

`onSwitchToThread` 的依赖数组 `[setSession, setSessionLoading]` 改为 `[setSession, setSessionLoading, flushProposalSave]`。
`onSwitchToNewThread` 的依赖数组 `[setSession, setSessionLoading]` 改为 `[setSession, setSessionLoading, flushProposalSave]`。

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 6: 手动冒烟（核心回归）**

`bun run dev`：
1. 会话 A 生成草稿 → 手改某节文字 → 等 ~1s → 切到方案会话 B → 切回 A：**手改在**。
2. A 手改 → 退出 App → 重开 → 点 A：**手改在**（来自盘 `userData/proposal-drafts/<A>.json`）。
3. 可在终端 `ls ~/Library/Application\ Support/<appName>/proposal-drafts/` 确认有 `<sessionId>.json`。

- [ ] **Step 7: commit**

```bash
git add apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx
git commit -m "feat(proposal): 草稿防抖写盘订阅器 + 切换会话前 flush"
```

---

### Task 6: 「清空草稿」并发删盘

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx`（「确认清空」onClick）

**Interfaces:**
- Consumes: `window.chatApi.deleteProposalDraft`；`useProposalStore.getState().start`。

- [ ] **Step 1: 改「确认清空」onClick**

把现有（约第 144-149 行）：

```tsx
                onClick={() => {
                  // proposalSid 在 show=true 时恒非空（门控要求 sessionId===前台会话）；
                  // 仍守一手 null，绝不把 start('') 透出去污染 gating。
                  if (proposalSid) useProposalStore.getState().start(proposalSid)
                  setConfirmingNew(false)
                }}
```

改为：

```tsx
                onClick={() => {
                  // proposalSid 在 show=true 时恒非空（门控要求 sessionId===前台会话）；
                  // 仍守一手 null，绝不把 start('') 透出去污染 gating。
                  if (proposalSid) {
                    // 先删盘再清内存：否则清完一刷新/切回，草稿又从盘上 restoreFromDisk 回来。
                    // start() 把 sections 清空，订阅器因空草稿不再写盘，故不会复活该文件。
                    void window.chatApi.deleteProposalDraft({ sessionId: proposalSid })
                    useProposalStore.getState().start(proposalSid)
                  }
                  setConfirmingNew(false)
                }}
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 3: 手动冒烟**

`bun run dev`：会话有草稿 → 「清空草稿」→「确认清空」→ 草稿清空；切到别的会话再切回 / 重启 App → **草稿不再回来**（盘文件已删）。

- [ ] **Step 4: commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx
git commit -m "feat(proposal): 清空草稿并发删盘（deleteProposalDraft）"
```

---

### Task 7: 端到端手动验收（spec 六场景）

**Files:** 无改动，纯验收。

- [ ] **Step 1: 跑 `bun run dev`，逐条过 spec 测试清单**

1. A 生成草稿 → 手改 → 切到方案会话 B → 切回 A：手改在。
2. A 手改 → 退出 App → 重开 → 点 A：手改在。
3. 连开 12 个方案会话各生成草稿 → 最早 2 个盘文件被 LRU 淘汰（`ls proposal-drafts/` 应 ≤10 个）；重开最早那个：AI 正文在、手改没了。
4. 「清空草稿」确认 → 重开该会话：草稿不再回来。
5. 打开普通（非方案）会话：不生成草稿文件，前台不残留上一个草稿。
6. `bun run typecheck` 通过。

- [ ] **Step 2: 若全过，无需额外提交**

验收发现的问题回到对应 Task 修复并补提交。

---

## Self-Review

**Spec coverage：**
- 数据模型/文件格式 → Task 1（类型）+ Task 2（写读）。✓
- 三条 IPC → Task 1（契约）+ Task 2（handler/preload）。✓
- 载入优先级四级 → Task 4。✓
- 写盘 write-through + flush → Task 5。✓
- LRU mtime 10 → Task 2 `evictOldDrafts`。✓
- 「清空草稿」删盘 → Task 6。✓
- 自动展开工作台（workspaceOpen=true）→ Task 3 `restoreFromDisk` + Task 4 transcript 分支（`restoreFromTranscript` 已设 true）。✓
- 边界/降级（I/O 失败不阻塞、非方案不写、孤儿靠 LRU）→ Task 2 防御式 + Task 4 try/catch。✓

**Placeholder scan：** 无 TBD/TODO；每个改码步骤均含完整代码。✓

**Type consistency：**
- `ProposalDraftRecord` 字段（version/sessionId/sections/products/phase/updatedAt）在 Task 1 定义，Task 2 读写、Task 3 `restoreFromDisk`、Task 5 写盘载荷全部一致。✓
- 通道常量名 `PROPOSAL_SAVE_DRAFT/LOAD_DRAFT/DELETE_DRAFT` 在 Task 1/2 一致。✓
- `saveProposalDraft/loadProposalDraft/deleteProposalDraft` 三处（core 函数、preload 方法、ChatApi 签名）同名同义。✓
- `restoreFromDisk` 在 Task 3 定义、Task 4 调用，签名一致。✓
- `flushProposalSave` 在 Task 5 定义并被两个切换回调引用，依赖数组已补。✓
