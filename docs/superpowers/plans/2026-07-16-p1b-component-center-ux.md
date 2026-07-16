# 按需下载组件 P1b — 通用状态/IPC + 组件中心 + 渐进弹窗 + 收编 markitdown/soffice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「只会下 embed 模型」的下载能力泛化成「每组件一格」的通用状态表 + id 键控 IPC，做出设置页「组件/扩展」中心、可复用渐进弹窗、最小全局 toast，并把 markitdown（pipx）与 soffice（detect-only）收编为另两种安装策略，全部汇进同一套后端与同一个组件中心。

**Architecture:** 后端新建一个「组件安装编排器」（唯一状态写手，持整张 `ComponentTable`、按档案卡 `strategy` 分派到 hosted-files/pipx/detect-only 三种实现、成功收尾副作用挂 per-id 钩子表不泄进通用层）。采「**先加新通道、后退旧通道**」顺序：先加 `COMPONENT_*` 四通道并让编排器接管 embed，前端逐件迁移，最后一个任务统一退役 `KB_MODEL_DOWNLOAD_*`（4）+ `KB_TOOLING_*`（2）六通道与 `kbModelDownloader.ts`/`kbModelDownload.ts`。每个任务结束都 typecheck 绿。

**Tech Stack:** TypeScript（Electron main Node 环境 + chat 侧浏览器环境）、zustand（前端 store）、React 19 + Tailwind v4 + shadcn 原语、bun:test（纯逻辑单测）。网络/文件/子进程沿用 P1a 既有 node 内置栈（不新增 runtime 依赖）。

## Global Constraints

- 包管理器是 **bun**：测试 `cd apps/studio && bun test <路径>`；类型检查 `cd apps/studio && bun run typecheck`（= 双 tsc：`tsc --noEmit && tsc --noEmit -p tsconfig.node.json`）。**唯一自动化门 = typecheck 绿 + 纯核 bun:test**，无 ESLint / E2E。
- **不新增任何 runtime 依赖**，不往 package.json `dependencies` 加东西。
- **子代理只 `git add` 本任务列出的确切文件，绝不 `git add -A`**——工作区有 ~100 个不相关脏文件（ppt PNG / bun.lock）。
- **子代理不跑 `bun run dev`**（会撞用户真实 app / 端口）；运行时实机验证留用户。
- **样式铁律**：chat 侧一律 shadcn 原语 + Tailwind utility；`createPortal(…, document.body)` 的子树里的裸交互元素必须加 `data-slot` 逃逸 canvas reset；不写裸 `<button>`/`<input>`。
- **IPC 四处同改**：`electron/shared/ipc-channels.ts`（通道常量 + `ChatApi` 接口签名）→ `electron/preload/index.ts`（暴露方法）→ `electron/preload/index.d.ts`（若该文件承载镜像声明，本仓 KB_MODEL_DOWNLOAD 类型真相在 ipc-channels.ts 的 `ChatApi` 接口、index.d.ts 无声明——照此模式）→ main handler（`electron/main/ipc/register.ts`）。
- **P1a 技术备忘（必须遵守）**：① 镜像回退只覆盖「传输失败」不覆盖「sha 校验失败」（本期若给某组件真填多镜像且要坏镜像自动换，须把 sha 校验挪进 `downloadWithMirrors` 单次尝试内——本期不填真镜像，不触发）；② `installComponent` 只下当前组件、非循环整清单，加组件按 registry 逐组件调用；③ 进度分母复用 `descriptorTotalBytes()`；④ `engine.ts:1308` 写正文自动召回是热路径无弹窗时机，本期不接 reranker、不碰此路。
- **收尾分账**（承接 b5636bb3）：下载/安装「成功」与「成功后的业务收尾（重热 embed worker / 重建索引）」分开算账——收尾失败**不得**把已成功的安装翻成 error。
- 注释解释「为什么这样而不那样」，沿用本仓高注释密度风格。中英 i18n 双写（`src/chat/i18n.ts`，zh 块约 160-264 行、en 块约 554-660 行，键值对）。

---

### Task 1: 共享类型——通用组件状态 + 两种新安装策略

**Files:**
- Modify: `apps/studio/electron/shared/componentDownload.ts`（P1a 既有档案卡类型文件，追加）
- Test: `apps/studio/electron/shared/componentDownload.test.ts`（P1a 既有测试文件，追加）

**Interfaces:**
- Consumes: P1a 既有 `HostedFilesInstall` / `HostedArchiveInstall` / `ComponentDescriptor` / `descriptorTotalBytes`。
- Produces（后续所有任务都依赖这些确切名字/形状）：
  - `type ComponentStatus = 'idle' | 'installing' | 'ready' | 'error' | 'unavailable'`
  - `interface ComponentState { id: string; status: ComponentStatus; percent: number | null; currentFile: string | null; errorMessage: string | null }`
  - `type ComponentTable = Record<string, ComponentState>`
  - `interface PipxInstall { kind: 'pipx'; pkg: string; probeCmd: string }`
  - `interface DetectOnlyInstall { kind: 'detect-only'; probeCmd: string; guideUrl?: string }`
  - `type ComponentInstallSpec = HostedFilesInstall | HostedArchiveInstall | PipxInstall | DetectOnlyInstall`
  - `ComponentDescriptor.strategy: 'hosted-files' | 'pipx' | 'detect-only'`、`ComponentDescriptor.install: ComponentInstallSpec`
  - `function initialComponentState(id: string): ComponentState`

- [ ] **Step 1: 写失败测试**

在 `componentDownload.test.ts` 末尾追加：

```ts
import { initialComponentState } from './componentDownload'

describe('initialComponentState', () => {
  test('新组件初态 = idle、无进度、无错误', () => {
    expect(initialComponentState('foo')).toEqual({
      id: 'foo', status: 'idle', percent: null, currentFile: null, errorMessage: null,
    })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/shared/componentDownload.test.ts`
Expected: FAIL（`initialComponentState is not a function`）

- [ ] **Step 3: 写实现**

在 `componentDownload.ts` 中：把 `ComponentDescriptor` 的 `strategy` 与 `install` 字段改成新联合，并追加新类型与纯函数。具体改动：

将现有

```ts
export interface ComponentDescriptor {
  id: string
  title: string
  description: string
  sizeEstimateBytes: number
  strategy: 'hosted-files'
  install: HostedInstall
}
```

改为

```ts
/** pipx 策略（markitdown 类）：跑 pipx/pip 装一个 python 包；无字节进度、不可取消。 */
export interface PipxInstall {
  kind: 'pipx'
  pkg: string        // pip 包名，如 'markitdown'
  probeCmd: string   // 「装没装好」的探测命令名，如 'markitdown'
}

/** detect-only 策略（soffice 类）：我们装不了，只探测本机有没有，没有就引导手动装。 */
export interface DetectOnlyInstall {
  kind: 'detect-only'
  probeCmd: string   // 探测命令名，如 'soffice'
  guideUrl?: string  // 「如何安装」引导链接
}

export type ComponentInstallSpec = HostedFilesInstall | HostedArchiveInstall | PipxInstall | DetectOnlyInstall

export interface ComponentDescriptor {
  id: string
  title: string
  description: string
  sizeEstimateBytes: number
  strategy: 'hosted-files' | 'pipx' | 'detect-only'
  install: ComponentInstallSpec
}

// ── 运行时状态（每组件一格，main 单一事实源、前台整块镜像；范式对齐 kbBuildStatus/updaterState）──

/** 一个组件当前所处状态。三种安装策略都归一到这五态。 */
export type ComponentStatus =
  | 'idle'          // 没装、但可装（hosted-files / pipx）
  | 'installing'    // 正在装；percent 有值=可测量进度（hosted-files），null=不定长（pipx 转圈）
  | 'ready'         // 装好了 / 本就存在（detect-only 探到也是此态）
  | 'error'         // 失败，errorMessage 有值
  | 'unavailable'   // 装不了、需用户手动（detect-only 没探到；或 pipx 连 python 都没有）

export interface ComponentState {
  id: string
  status: ComponentStatus
  percent: number | null      // 仅 installing 且可测量时有值，否则 null
  currentFile: string | null  // 下载型当前文件（供 UI 文本），否则 null
  errorMessage: string | null // error 态原因，否则 null
}

/** 整张组件状态表：组件 id → 状态。 */
export type ComponentTable = Record<string, ComponentState>

/** 一个组件的初始状态（未探测前的保守态）。 */
export function initialComponentState(id: string): ComponentState {
  return { id, status: 'idle', percent: null, currentFile: null, errorMessage: null }
}
```

> `descriptorTotalBytes` 内部 `i.kind === 'files' ? … : i.archive.size` 现在 `install` 联合多了 pipx/detect-only 两支（无 `files`/`archive`）——TS 会报 `archive` 不在联合上。改 `descriptorTotalBytes` 为只对 hosted 两形态计数、其余返回 `sizeEstimateBytes`：

```ts
export function descriptorTotalBytes(d: ComponentDescriptor): number {
  const i = d.install
  if (i.kind === 'files') return i.files.reduce((s, f) => s + f.size, 0)
  if (i.kind === 'archive') return i.archive.size
  return d.sizeEstimateBytes // pipx/detect-only 无字节分母，回落体积估算
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd apps/studio && bun test electron/shared/componentDownload.test.ts && bun run typecheck`
Expected: PASS（新增测试绿；typecheck 无错——`descriptorTotalBytes` 已收窄联合）

- [ ] **Step 5: 提交**

```bash
git add apps/studio/electron/shared/componentDownload.ts apps/studio/electron/shared/componentDownload.test.ts
git commit -m "feat(component-download): 通用组件状态类型 + pipx/detect-only 策略（纯核）"
```

---

### Task 2: 组件名册加 markitdown + soffice 两张卡

**Files:**
- Modify: `apps/studio/electron/main/core/componentRegistry.ts`
- Test: `apps/studio/electron/main/core/componentRegistry.test.ts`（P1a 既有，追加）

**Interfaces:**
- Consumes: Task 1 的 `ComponentDescriptor`（新 strategy 联合）。
- Produces:
  - `const MARKITDOWN_COMPONENT_ID = 'markitdown'`
  - `const SOFFICE_COMPONENT_ID = 'soffice'`
  - `COMPONENT_REGISTRY` 追加两张卡；`getComponentDescriptor` 能按这两个 id 取到。

- [ ] **Step 1: 写失败测试**

在 `componentRegistry.test.ts` 追加：

```ts
import { MARKITDOWN_COMPONENT_ID, SOFFICE_COMPONENT_ID } from './componentRegistry'

describe('markitdown / soffice 档案卡', () => {
  test('markitdown 是 pipx 策略', () => {
    const d = getComponentDescriptor(MARKITDOWN_COMPONENT_ID)!
    expect(d.strategy).toBe('pipx')
    if (d.install.kind !== 'pipx') throw new Error('应为 pipx')
    expect(d.install.pkg).toBe('markitdown')
    expect(d.install.probeCmd).toBe('markitdown')
  })
  test('soffice 是 detect-only 策略', () => {
    const d = getComponentDescriptor(SOFFICE_COMPONENT_ID)!
    expect(d.strategy).toBe('detect-only')
    if (d.install.kind !== 'detect-only') throw new Error('应为 detect-only')
    expect(d.install.probeCmd).toBe('soffice')
  })
})
```

（`getComponentDescriptor` 已在文件顶部 P1a 测试里 import，无需重复。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/main/core/componentRegistry.test.ts`
Expected: FAIL（`MARKITDOWN_COMPONENT_ID` 未导出）

- [ ] **Step 3: 写实现**

在 `componentRegistry.ts` 中，`COMPONENT_REGISTRY` 定义前加两张卡、并把它们加进数组：

```ts
export const MARKITDOWN_COMPONENT_ID = 'markitdown'
export const SOFFICE_COMPONENT_ID = 'soffice'

// markitdown：pipx 装的 python 文档转换工具，导入 Office/PDF 文档进知识库时用；缺失时转换降级
// （丢内嵌图重试 → soffice 纯文本兜底）。安装编排走既有 kbTooling.installMarkitdown（pipx 优先）。
const markitdownDescriptor: ComponentDescriptor = {
  id: MARKITDOWN_COMPONENT_ID,
  title: '文档转换工具 markitdown',
  description: '把 Office / PDF 文档转成 Markdown 存进知识库；缺失时降级纯文本转换',
  strategy: 'pipx',
  sizeEstimateBytes: 0, // pipx 装、体积不定，UI 不显字节
  install: { kind: 'pipx', pkg: 'markitdown', probeCmd: 'markitdown' },
}

// soffice（LibreOffice）：我们装不了这种大办公套件，只探测本机有没有；没有就引导手动装。
// 它只作为 markitdown 之后的最后兜底纯文本转换用（见 kbBuild/convert.ts）。
const sofficeDescriptor: ComponentDescriptor = {
  id: SOFFICE_COMPONENT_ID,
  title: 'LibreOffice（soffice）',
  description: '文档转换的最后兜底；本机未安装时导入部分格式会失败，可选装',
  strategy: 'detect-only',
  sizeEstimateBytes: 0,
  install: { kind: 'detect-only', probeCmd: 'soffice', guideUrl: 'https://www.libreoffice.org/download/download/' },
}
```

把

```ts
export const COMPONENT_REGISTRY: ComponentDescriptor[] = [embedDescriptor]
```

改为

```ts
export const COMPONENT_REGISTRY: ComponentDescriptor[] = [embedDescriptor, markitdownDescriptor, sofficeDescriptor]
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && bun test electron/main/core/componentRegistry.test.ts`
Expected: PASS（embed 原有 3 test + 新 2 test 全绿）

- [ ] **Step 5: 提交**

```bash
git add apps/studio/electron/main/core/componentRegistry.ts apps/studio/electron/main/core/componentRegistry.test.ts
git commit -m "feat(component-download): 名册加 markitdown(pipx) + soffice(detect-only) 两卡"
```

---

### Task 3: 通用安装编排器（唯一状态写手 + 按策略分派）

**Files:**
- Create: `apps/studio/electron/main/services/componentInstaller/componentOrchestrator.ts`
- Test: `apps/studio/electron/main/services/componentInstaller/componentOrchestrator.test.ts`

**Interfaces:**
- Consumes: Task 1 类型；Task 2 名册（`COMPONENT_REGISTRY`/`getComponentDescriptor`/`EMBED_COMPONENT_ID`/`MARKITDOWN_COMPONENT_ID`/`SOFFICE_COMPONENT_ID`）；P1a `installComponent`/`isComponentInstalled`；既有 `kbTooling`（`installMarkitdown`/`detectTooling`）、`kbModelDir`、`kbSemanticSearch`（`resetEmbedWorker`/`warmEmbedWorker`）、`kbBuildRunner`（`scheduleKbBuild`）、`kbIndexStore`（`kbStoreHasDocs`）；`kbTooling` 的 `KbToolingInstallResult` 类型（`@desktop-shared/kbAdmin`）。
- Produces（后续 IPC/前端依赖这些确切名字）：
  - `function applyComponentPatch(table: ComponentTable, id: string, patch: Partial<ComponentState>): ComponentTable` — 纯函数，不可变更新一格。
  - `function mapPipxResult(r: KbToolingInstallResult): { status: ComponentStatus; errorMessage: string | null }` — 纯函数，pipx 结果 → 状态。
  - `function getComponentTable(): ComponentTable`
  - `function onComponentStatus(cb: (t: ComponentTable) => void): () => void`
  - `function refreshComponentInstalled(): void` — 探测磁盘/工具链，重设整表就绪态。
  - `function startComponentInstall(id: string): void` — 触发即返回；进度经 onComponentStatus 推。
  - `function cancelComponentInstall(id: string): void`

- [ ] **Step 1: 写失败测试（只测两个纯函数）**

```ts
// apps/studio/electron/main/services/componentInstaller/componentOrchestrator.test.ts
import { describe, expect, test } from 'bun:test'
import { applyComponentPatch, mapPipxResult } from './componentOrchestrator'
import { initialComponentState, type ComponentTable } from '../../../shared/componentDownload'

describe('applyComponentPatch', () => {
  test('只改目标格、返回新对象、不动其他格', () => {
    const base: ComponentTable = { a: initialComponentState('a'), b: initialComponentState('b') }
    const next = applyComponentPatch(base, 'a', { status: 'installing', percent: 40 })
    expect(next.a.status).toBe('installing')
    expect(next.a.percent).toBe(40)
    expect(next.b).toBe(base.b)        // 未动的格同引用
    expect(next).not.toBe(base)        // 顶层新对象
    expect(base.a.status).toBe('idle') // 原表不被就地改
  })
  test('未知 id 补一格再打补丁', () => {
    const next = applyComponentPatch({}, 'x', { status: 'ready' })
    expect(next.x.status).toBe('ready')
    expect(next.x.id).toBe('x')
  })
})

describe('mapPipxResult', () => {
  test('ok → ready', () => {
    expect(mapPipxResult({ ok: true, unsupported: false, tooling: { markitdown: true, soffice: false }, log: '' }))
      .toEqual({ status: 'ready', errorMessage: null })
  })
  test('unsupported → unavailable', () => {
    expect(mapPipxResult({ ok: false, unsupported: true, tooling: { markitdown: false, soffice: false }, log: 'x' }).status)
      .toBe('unavailable')
  })
  test('普通失败 → error（带 log 摘要）', () => {
    const r = mapPipxResult({ ok: false, unsupported: false, tooling: { markitdown: false, soffice: false }, log: 'boom' })
    expect(r.status).toBe('error')
    expect(r.errorMessage).toContain('boom')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/main/services/componentInstaller/componentOrchestrator.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// apps/studio/electron/main/services/componentInstaller/componentOrchestrator.ts
// 通用组件安装编排器：整张 ComponentTable 的唯一写手 + 按档案卡 strategy 分派到三种实现。
// 泛化自 kbModelDownloader（单模型）——那份薄壳在收尾任务里退役。
//
// 分账铁律（承接 b5636bb3）：安装「成功」与「成功后的业务收尾（重热 embed / 重建索引）」分开——
// 收尾挂 per-id SUCCESS_HOOKS 钩子表、单独 try 包住，失败不把已成功安装翻成 error；且收尾副作用
// 不泄进通用编排逻辑（只 embed 有）。
import { existsSync } from 'node:fs'
import {
  initialComponentState, type ComponentState, type ComponentStatus, type ComponentTable,
} from '../../../shared/componentDownload'
import {
  COMPONENT_REGISTRY, getComponentDescriptor,
  EMBED_COMPONENT_ID, MARKITDOWN_COMPONENT_ID, SOFFICE_COMPONENT_ID,
} from '../../core/componentRegistry'
import { installComponent, isComponentInstalled } from './hostedFilesInstaller'
import { installMarkitdown, detectTooling } from '../../core/kbTooling'
import { kbModelDir } from '../../core/kbModelDir'
import { resetEmbedWorker, warmEmbedWorker } from '../../core/kbSemanticSearch'
import { scheduleKbBuild } from '../../core/kbBuildRunner'
import { kbStoreHasDocs } from '../../core/kbIndexStore'
import type { KbToolingInstallResult } from '../../../shared/kbAdmin'

// ── 纯函数（可单测）────────────────────────────────────────────────

/** 不可变地更新一格；未知 id 先补初态。 */
export function applyComponentPatch(
  table: ComponentTable, id: string, patch: Partial<ComponentState>,
): ComponentTable {
  const cur = table[id] ?? initialComponentState(id)
  return { ...table, [id]: { ...cur, ...patch } }
}

/** pipx 安装结果 → 状态标签。unsupported=缺 python 前置（装不了）；普通失败带 log 摘要供排查。 */
export function mapPipxResult(r: KbToolingInstallResult): { status: ComponentStatus; errorMessage: string | null } {
  if (r.ok) return { status: 'ready', errorMessage: null }
  if (r.unsupported) return { status: 'unavailable', errorMessage: null }
  const tail = (r.log || '').trim().slice(-400) // 只留尾部摘要，别把整段日志塞状态
  return { status: 'error', errorMessage: tail || '安装失败' }
}

// ── 状态单例 + 广播 ────────────────────────────────────────────────

let table: ComponentTable = Object.fromEntries(
  COMPONENT_REGISTRY.map((d) => [d.id, initialComponentState(d.id)]),
)
type Listener = (t: ComponentTable) => void
const listeners = new Set<Listener>()

export function onComponentStatus(cb: Listener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
export function getComponentTable(): ComponentTable {
  return table
}
function patch(id: string, p: Partial<ComponentState>): void {
  table = applyComponentPatch(table, id, p)
  for (const cb of listeners) cb(table)
}

// 成功收尾钩子（只 embed 有）：下载成功后重热 worker + 有文档则重建索引。不泄进通用逻辑。
const SUCCESS_HOOKS: Record<string, () => void> = {
  [EMBED_COMPONENT_ID]: () => {
    resetEmbedWorker()
    warmEmbedWorker()
    if (kbStoreHasDocs()) scheduleKbBuild()
  },
}

/** 探测磁盘/工具链，重设整表就绪态（启动时 + 每次 status-get 前调）。 */
export function refreshComponentInstalled(): void {
  const t = detectTooling() // { markitdown, soffice }
  for (const d of COMPONENT_REGISTRY) {
    const i = d.install
    let status: ComponentStatus
    if (i.kind === 'files' || i.kind === 'archive') {
      status = isComponentInstalled(d, kbModelDir(), existsSync) ? 'ready' : 'idle'
    } else if (i.kind === 'pipx') {
      status = t.markitdown ? 'ready' : 'idle'
    } else {
      status = t.soffice ? 'ready' : 'unavailable' // detect-only：没探到 = 需手动
    }
    // 正在装的格别被探测覆盖（探测在装的中途可能仍为 false）。
    if (table[d.id]?.status !== 'installing') patch(d.id, { status, percent: null, currentFile: null, errorMessage: null })
  }
}

// ── 安装编排（io，靠 typecheck + 手动验证）────────────────────────

const inFlight = new Set<string>()
const controllers = new Map<string, AbortController>()

/** 触发某组件安装；触发即返回，进度经广播推。detect-only 无此动作（UI 不给按钮）。 */
export function startComponentInstall(id: string): void {
  if (inFlight.has(id)) return
  const d = getComponentDescriptor(id)
  if (!d) return
  if (d.install.kind === 'detect-only') return // 装不了，UI 不该触发
  inFlight.add(id)
  void run(id).finally(() => { inFlight.delete(id); controllers.delete(id) })
}

async function run(id: string): Promise<void> {
  const d = getComponentDescriptor(id)!
  const i = d.install
  patch(id, { status: 'installing', percent: i.kind === 'files' || i.kind === 'archive' ? 0 : null, currentFile: null, errorMessage: null })

  try {
    if (i.kind === 'files' || i.kind === 'archive') {
      const controller = new AbortController()
      controllers.set(id, controller)
      await installComponent(d, kbModelDir(), controller.signal, (p) => {
        patch(id, { percent: p.percent, currentFile: p.currentFile })
      })
      patch(id, { status: 'ready', percent: 100, currentFile: null })
    } else {
      // pipx：无字节进度（percent 恒 null），不可取消。
      const r = await installMarkitdown()
      const { status, errorMessage } = mapPipxResult(r)
      patch(id, { status, percent: null, currentFile: null, errorMessage })
      if (status !== 'ready') return // 失败/装不了：不跑收尾
    }
    // 成功收尾（锦上添花，隔离 try）：失败不把已成功安装翻成 error。
    try { SUCCESS_HOOKS[id]?.() } catch { /* 收尾失败：安装仍算成功，降级链兜底 */ }
  } catch (err) {
    // hosted-files 取消：controller.abort() 落这。回未装/已装态，不当错误。
    if (controllers.get(id)?.signal.aborted) {
      const installed = isComponentInstalled(d, kbModelDir(), existsSync)
      patch(id, { status: installed ? 'ready' : 'idle', percent: null, currentFile: null, errorMessage: null })
    } else {
      patch(id, { status: 'error', currentFile: null, errorMessage: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** 取消进行中的安装（仅 hosted-files 真能取消；其余 no-op）。 */
export function cancelComponentInstall(id: string): void {
  controllers.get(id)?.abort()
}
```

> `installComponent` 的 `root` 参数：本期唯一 hosted-files 组件是 embed，落 `kbModelDir()`（与 P1a 一致）。将来非 embed 的 hosted-files 组件若落别处，再把 root 做成 per-strategy 解析——本期 YAGNI，统一 `kbModelDir()`。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd apps/studio && bun test electron/main/services/componentInstaller/componentOrchestrator.test.ts && bun run typecheck`
Expected: PASS（5 test 绿；typecheck 无错）

- [ ] **Step 5: 提交**

```bash
git add apps/studio/electron/main/services/componentInstaller/componentOrchestrator.ts apps/studio/electron/main/services/componentInstaller/componentOrchestrator.test.ts
git commit -m "feat(component-download): 通用安装编排器（三策略分派 + 收尾钩子表 + 纯核测试）"
```

---

### Task 4: COMPONENT_* 四通道 IPC + 广播 + 订阅（加新，不动旧）

**Files:**
- Modify: `apps/studio/electron/shared/ipc-channels.ts`（通道常量段 + `ChatApi` 接口段）
- Modify: `apps/studio/electron/preload/index.ts`
- Modify: `apps/studio/electron/main/ipc/register.ts`（加 handler + removeHandler）
- Modify: `apps/studio/electron/main/tabRegistry.ts`（加 `broadcastComponentStatus`）
- Modify: `apps/studio/electron/main/index.ts`（只订阅 `onComponentStatus`，**不**在启动时 refresh——见 Step 6 注释）
- Modify: `apps/studio/electron/main/services/componentInstaller/componentOrchestrator.ts`（补一行 `installing` 守卫，见 Step 0）
- Read（确认 index.d.ts 无需改）: `apps/studio/electron/preload/index.d.ts`

**Interfaces:**
- Consumes: Task 3 编排器全部导出；Task 1 `ComponentTable`。
- Produces:
  - 通道常量 `COMPONENT_STATUS_GET='component:status-get'` / `COMPONENT_INSTALL_START='component:install-start'` / `COMPONENT_INSTALL_CANCEL='component:install-cancel'` / `COMPONENT_STATUS='component:status'`
  - preload 方法 `componentStatusGet(): Promise<ComponentTable>` / `startComponentInstall(id: string): Promise<void>` / `cancelComponentInstall(id: string): Promise<void>` / `onComponentStatus(cb: (t: ComponentTable) => void): () => void`
  - main `broadcastComponentStatus(t: ComponentTable): void`

- [ ] **Step 0: 补 `installing` 守卫（componentOrchestrator.ts，Task 3 复审遗留的 Minor）**

Task 3 的 `applyDetectedStatus` 在 ready 分支无条件转正，丢了原先双向的 `installing` 守卫。本任务把 `refreshComponentInstalled()` 接到每次 status-get 前，正是激活它的时机：装到一半时探测若说「已就绪」，会把格子提前拍成 ready、清空 percent，UI 在装完前一直显示「已就绪」（最终自愈，但过程视觉错乱）。

在 `applyDetectedStatus` 函数最前面加 early-return，恢复双向语义（in-flight 的格子由 `run()` 独占写，探测不该插手任一方向）：

```ts
  // 正在装的格由 run() 独占写：探测既不该把它降级、也不该提前转正（提前转正会清空 percent，
  // UI 在装完前一直显示「已就绪」）。双向守卫，勿只挡一边。
  if (table[id]?.status === 'installing') return
```

> 具体变量名/签名以该函数实际实现为准（Task 3 的 `applyDetectedStatus` 收的是组件 id 与探测结论）；语义以「installing 格在两个方向上都不被探测覆盖」为准。

- [ ] **Step 1: 加通道常量 + ChatApi 接口签名（ipc-channels.ts）**

在 `KB_MODEL_DOWNLOAD_STATUS: 'kb:model-download-status',` 那行之后（`} as const` 之前）加：

```ts
  // ── 通用按需下载组件（P1b）：一套 id 键控通道服务所有组件（embed/markitdown/soffice…）──
  COMPONENT_STATUS_GET: 'component:status-get',
  COMPONENT_INSTALL_START: 'component:install-start',
  COMPONENT_INSTALL_CANCEL: 'component:install-cancel',
  COMPONENT_STATUS: 'component:status',
```

在 `ChatApi` 接口里，`onKbModelDownload(...)` 那行之后加：

```ts
  /** 拉整张组件状态表快照（组件中心/弹窗初始渲染）。 */
  componentStatusGet(): Promise<import('./componentDownload').ComponentTable>
  /** 触发某组件安装（组件中心/渐进弹窗）。触发即返回，进度经 onComponentStatus 推。 */
  startComponentInstall(id: string): Promise<void>
  /** 取消某组件安装（仅下载型真能取消）。 */
  cancelComponentInstall(id: string): Promise<void>
  /** 订阅组件状态表整块推送。返回取消订阅函数。 */
  onComponentStatus(handler: (t: import('./componentDownload').ComponentTable) => void): () => void
```

- [ ] **Step 2: 暴露 preload 方法（preload/index.ts）**

在 `onKbModelDownload(...)` 方法块之后加：

```ts
  componentStatusGet(): Promise<ComponentTable> {
    return ipcRenderer.invoke(IPC_CHANNELS.COMPONENT_STATUS_GET) as Promise<ComponentTable>
  },
  startComponentInstall(id: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.COMPONENT_INSTALL_START, id) as Promise<void>
  },
  cancelComponentInstall(id: string): Promise<void> {
    return ipcRenderer.invoke(IPC_CHANNELS.COMPONENT_INSTALL_CANCEL, id) as Promise<void>
  },
  onComponentStatus(cb: (t: ComponentTable) => void): () => void {
    const listener = (_e: unknown, t: ComponentTable): void => cb(t)
    ipcRenderer.on(IPC_CHANNELS.COMPONENT_STATUS, listener)
    return () => {
      ipcRenderer.off(IPC_CHANNELS.COMPONENT_STATUS, listener)
    }
  },
```

在文件顶部 import 区，给 `ComponentTable` 补 type-only import（与既有 `KbModelDownloadState` 等同处，从 `@desktop-shared/componentDownload` 或既有 shared 别名路径引——照该文件现有 shared import 风格）：

```ts
import type { ComponentTable } from '@desktop-shared/componentDownload'
```

> 若该文件的 shared 类型走相对路径而非 `@desktop-shared/*`，照其邻近 import 的写法来（以 typecheck 绿为准）。

- [ ] **Step 3: 确认 index.d.ts 是否需要镜像声明**

Run: `grep -n "onKbModelDownload\|kbModelDownloadStatusGet" apps/studio/electron/preload/index.d.ts`
Expected: 无输出（KB_MODEL_DOWNLOAD 方法未在 index.d.ts 声明，类型真相在 ipc-channels.ts 的 ChatApi）。→ **index.d.ts 不改**。若有输出，则在同处照 KB_MODEL_DOWNLOAD 模式补 4 个 component 方法声明。

- [ ] **Step 4: 加 main handler（register.ts）**

在 `KB_MODEL_DOWNLOAD_CANCEL` handler 块（约 2228-2230 行）之后加：

```ts
  ipcMain.handle(IPC_CHANNELS.COMPONENT_STATUS_GET, async (): Promise<import('../../shared/componentDownload').ComponentTable> => {
    refreshComponentInstalled() // 拉快照前先探一遍磁盘/工具链，反映用户手动装/删
    return getComponentTable()
  })
  ipcMain.handle(IPC_CHANNELS.COMPONENT_INSTALL_START, async (_e, id: string): Promise<void> => {
    startComponentInstall(id)
  })
  ipcMain.handle(IPC_CHANNELS.COMPONENT_INSTALL_CANCEL, async (_e, id: string): Promise<void> => {
    cancelComponentInstall(id)
  })
```

在 register.ts 顶部（`../services/kbModelDownloader` import 附近）加：

```ts
import { getComponentTable, startComponentInstall, cancelComponentInstall, refreshComponentInstalled } from '../services/componentInstaller/componentOrchestrator'
```

在 removeHandler 段（约 356-358，`KB_MODEL_DOWNLOAD_CANCEL` 那条之后）加：

```ts
  ipcMain.removeHandler(IPC_CHANNELS.COMPONENT_STATUS_GET)
  ipcMain.removeHandler(IPC_CHANNELS.COMPONENT_INSTALL_START)
  ipcMain.removeHandler(IPC_CHANNELS.COMPONENT_INSTALL_CANCEL)
```

- [ ] **Step 5: 加广播（tabRegistry.ts）**

在 `broadcastKbModelDownload` 函数之后加（复用其「shell + 非 web tab 逐个 send」模式）：

```ts
/** 把组件状态表整块推给每个能收 IPC 的 renderer。来源在 MAIN（编排器单飞行），每窗同等「other」。 */
export function broadcastComponentStatus(payload: import('../shared/componentDownload').ComponentTable): void {
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send(IPC_CHANNELS.COMPONENT_STATUS, payload)
  }
  for (const ctx of tabs.values()) {
    if (ctx.kind === 'web') continue
    const wc = ctx.view.webContents
    if (!wc.isDestroyed()) wc.send(IPC_CHANNELS.COMPONENT_STATUS, payload)
  }
}
```

> `import('../shared/…')` 内联类型或在顶部加 type-only import，照 tabRegistry.ts 现有风格（`KbModelDownloadState` 怎么引就怎么引）。

- [ ] **Step 6: 订阅接线（index.ts）**

在 `onKbModelDownload(...)` + `refreshKbModelInstalled()`（约 302-303）之后加：

```ts
  // 通用组件下载：同层订阅整表推送。
  // 刻意「只订阅、不在启动时 refresh」：refreshComponentInstalled() 内部的 detectTooling() 是
  // execFileSync × 2 探针 × 4s 超时 = 最坏约 8s 同步阻塞主进程（所有窗口 + IPC），挂启动路径
  // 会卡住 splash 交接。就绪态由 COMPONENT_STATUS_GET 这条用户触发的懒路径负责探（前端 store
  // 的 init() 必调 componentStatusGet()，每个消费方首帧前都会拿到探测过的整表），故启动探测冗余。
  onComponentStatus((t) => broadcastComponentStatus(t))
```

在 index.ts 顶部 import 区加：

```ts
import { onComponentStatus } from './services/componentInstaller/componentOrchestrator'
import { broadcastComponentStatus } from './tabRegistry'
```

（`broadcastComponentStatus` 若与既有 `broadcastKbModelDownload` 同一 import 行，合并即可。）

- [ ] **Step 7: typecheck**

Run: `cd apps/studio && bun run typecheck`
Expected: PASS（新旧通道并存、无类型漏）

- [ ] **Step 8: 提交**

```bash
git add apps/studio/electron/shared/ipc-channels.ts apps/studio/electron/preload/index.ts apps/studio/electron/main/ipc/register.ts apps/studio/electron/main/tabRegistry.ts apps/studio/electron/main/index.ts
git commit -m "feat(component-download): COMPONENT_* 四通道 IPC + 广播 + 订阅（加新，旧通道暂留）"
```

---

### Task 5: 前端组件状态 store（订阅整表）

**Files:**
- Create: `apps/studio/src/chat/stores/components.ts`

**Interfaces:**
- Consumes: Task 4 preload 方法（`componentStatusGet`/`onComponentStatus`/`startComponentInstall`/`cancelComponentInstall`）；Task 1 `ComponentTable`。
- Produces:
  - `useComponentStore` — zustand store，字段 `table: ComponentTable`；方法 `init(): () => void`（拉快照 + 订阅，返回 unsubscribe）；`stateOf(id): ComponentState`（取一格，缺则 idle 初态）。

- [ ] **Step 1: 写实现（无独立单测——薄订阅层，靠 typecheck + 消费方运行时）**

```ts
// apps/studio/src/chat/stores/components.ts
// 组件状态表的前端背板：拉一次快照 + 订阅整表推送，全整块替换不拼装（范式对齐后端单一事实源）。
// 组件中心 / 渐进弹窗 / KbToolbar 都消费这份 store，避免各自订阅打架。
import { create } from 'zustand'
import { initialComponentState, type ComponentState, type ComponentTable } from '@desktop-shared/componentDownload'

interface ComponentsState {
  table: ComponentTable
  init: () => () => void
  stateOf: (id: string) => ComponentState
}

export const useComponentStore = create<ComponentsState>((set, get) => ({
  table: {},
  init: () => {
    void window.chatApi.componentStatusGet().then((t) => set({ table: t }))
    const off = window.chatApi.onComponentStatus((t) => set({ table: t }))
    return off
  },
  stateOf: (id) => get().table[id] ?? initialComponentState(id),
}))
```

> `@desktop-shared/componentDownload` 别名若前端未配，改用前端消费 shared 类型的既有别名（同 `KbModelDownloadState` 在 KnowledgeBaseSection 里怎么引就怎么引，以 typecheck 绿为准）。

- [ ] **Step 2: typecheck**

Run: `cd apps/studio && bun run typecheck`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add apps/studio/src/chat/stores/components.ts
git commit -m "feat(component-download): 前端组件状态 store（拉快照 + 订阅整表）"
```

---

### Task 6: 组件中心 UI（新设置分类「组件/扩展」）

**Files:**
- Create: `apps/studio/src/chat/components/settings/ComponentsSection.tsx`
- Modify: `apps/studio/src/chat/components/settings/SettingsView.tsx`（categories + CategoryId + 渲染分支）
- Modify: `apps/studio/src/chat/i18n.ts`（新 i18n 键）

**Interfaces:**
- Consumes: Task 5 `useComponentStore`；Task 1/2 名册与类型（前端读 `COMPONENT_REGISTRY` 的 title/description——但 registry 在 main 侧，前端不能 import main 模块。**改由后端把 title/description 随表下发**？不——保持前端只读 `ComponentTable`（纯状态），标题/描述用 i18n 键按组件 id 硬映射在前端）。
- Produces: 设置页新增 `components` 分类，列出 3 行组件。

- [ ] **Step 1: 加 i18n 键（i18n.ts）**

在 zh 块（`catKnowledgeBase` 附近）加：

```ts
    catComponents: '组件 / 扩展',
    componentsTitle: '组件 / 扩展',
    componentsDesc: '按需下载的可选组件，用到才装、不撑大安装包',
    compEmbedTitle: '语义检索模型',
    compEmbedDesc: 'bge 嵌入模型，启用向量语义检索（缺失时降级关键词检索）',
    compMarkitdownTitle: '文档转换工具 markitdown',
    compMarkitdownDesc: '把 Office / PDF 文档转成 Markdown 存进知识库（缺失时降级纯文本）',
    compSofficeTitle: 'LibreOffice（soffice）',
    compSofficeDesc: '文档转换的最后兜底；本机未安装时部分格式导入会失败，可选装',
    compDownload: '下载',
    compInstall: '安装',
    compInstalling: '正在安装…',
    compCancel: '取消',
    compRetry: '重试',
    compReady: '已就绪',
    compHowToInstall: '如何安装',
    compBundled: '随包',
    kbModelMovedHint: '语义检索模型已移至「组件 / 扩展」设置',
```

在 en 块（对应位置）加：

```ts
    catComponents: 'Components',
    componentsTitle: 'Components',
    componentsDesc: 'Optional components downloaded on demand — installed only when needed, keeping the app small',
    compEmbedTitle: 'Semantic search model',
    compEmbedDesc: 'bge embedding model for vector search (falls back to keyword search when missing)',
    compMarkitdownTitle: 'Document converter (markitdown)',
    compMarkitdownDesc: 'Converts Office / PDF documents to Markdown for the knowledge base (falls back to plain text)',
    compSofficeTitle: 'LibreOffice (soffice)',
    compSofficeDesc: 'Last-resort document conversion; some formats fail to import if not installed. Optional.',
    compDownload: 'Download',
    compInstall: 'Install',
    compInstalling: 'Installing…',
    compCancel: 'Cancel',
    compRetry: 'Retry',
    compReady: 'Ready',
    compHowToInstall: 'How to install',
    compBundled: 'Bundled',
    kbModelMovedHint: 'The semantic search model moved to Settings → Components',
```

- [ ] **Step 2: 写 ComponentsSection.tsx**

```tsx
// apps/studio/src/chat/components/settings/ComponentsSection.tsx
import React, { useEffect } from 'react'
import { useT } from '../../i18n'
import { useComponentStore } from '../../stores/components'
import { Section } from './SettingsView'

// 组件 id → i18n 键映射（前端不 import main 侧 registry，标题/描述走 i18n）。
// guideUrl（soffice）也在此硬映射，避免前端依赖 main 档案卡。
const ROWS: { id: string; titleKey: string; descKey: string; guideUrl?: string }[] = [
  { id: 'kb-embed', titleKey: 'compEmbedTitle', descKey: 'compEmbedDesc' },
  { id: 'markitdown', titleKey: 'compMarkitdownTitle', descKey: 'compMarkitdownDesc' },
  { id: 'soffice', titleKey: 'compSofficeTitle', descKey: 'compSofficeDesc', guideUrl: 'https://www.libreoffice.org/download/download/' },
]

export function ComponentsSection(): React.JSX.Element {
  const t = useT()
  const init = useComponentStore((s) => s.init)
  const stateOf = useComponentStore((s) => s.stateOf)
  // 订阅整表（组件卸载时退订）。
  useEffect(() => init(), [init])

  return (
    <section className="space-y-8">
      <h1 className="text-[20px] font-semibold text-foreground">{t('componentsTitle')}</h1>
      <Section title={t('componentsTitle')} description={t('componentsDesc')}>
        <div className="space-y-2">
          {ROWS.map((row) => (
            <ComponentRow key={row.id} row={row} state={stateOf(row.id)} />
          ))}
        </div>
      </Section>
    </section>
  )
}

function ComponentRow({ row, state }: {
  row: { id: string; titleKey: string; descKey: string; guideUrl?: string }
  state: import('@desktop-shared/componentDownload').ComponentState
}): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-card/40 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">{t(row.titleKey)}</p>
        <p className="text-[11.5px] text-muted-foreground/80">{t(row.descKey)}</p>
        {state.status === 'error' && state.errorMessage && (
          <p className="mt-1 text-[11px] text-destructive">{state.errorMessage}</p>
        )}
      </div>
      <div className="shrink-0">
        <RowAction id={row.id} guideUrl={row.guideUrl} state={state} />
      </div>
    </div>
  )
}

function RowAction({ id, guideUrl, state }: {
  id: string
  guideUrl?: string
  state: import('@desktop-shared/componentDownload').ComponentState
}): React.JSX.Element {
  const t = useT()
  const start = (): void => { void window.chatApi.startComponentInstall(id) }
  const cancel = (): void => { void window.chatApi.cancelComponentInstall(id) }

  if (state.status === 'ready') {
    return <span className="text-[12px] font-medium text-emerald-600 dark:text-emerald-400">✓ {t('compReady')}</span>
  }
  if (state.status === 'installing') {
    return (
      <div className="flex items-center gap-2">
        {state.percent != null ? (
          <>
            <div className="relative h-1.5 w-28 rounded-full bg-muted">
              <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width]" style={{ width: `${state.percent}%` }} />
            </div>
            <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">{state.percent}%</span>
            <button type="button" onClick={cancel}
              className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12px] font-medium text-foreground hover:bg-muted/60">
              {t('compCancel')}
            </button>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent" />
            {t('compInstalling')}
          </span>
        )}
      </div>
    )
  }
  if (state.status === 'unavailable') {
    // 装不了（soffice / 缺 python 前置）：给「如何安装」引导。
    return guideUrl ? (
      <button type="button" onClick={() => { void window.chatApi.openExternal?.(guideUrl) }}
        className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12px] font-medium text-foreground hover:bg-muted/60">
        {t('compHowToInstall')}
      </button>
    ) : (
      <span className="text-[12px] text-muted-foreground">{t('compHowToInstall')}</span>
    )
  }
  // idle / error → 下载/安装 或 重试
  return (
    <button type="button" onClick={start}
      className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-[12px] font-medium text-accent-foreground hover:bg-accent/90">
      {state.status === 'error' ? t('compRetry') : (id === 'kb-embed' ? t('compDownload') : t('compInstall'))}
    </button>
  )
}
```

> `window.chatApi.openExternal?.(url)` 用可选链兜底：若该 preload 方法名不同（如 `openExternalUrl`），改成实际存在的方法（Step 4 typecheck 会暴露）。若无任何打开外链方法，退化为纯文本提示 + 可复制的 `guideUrl`。**Step 4 前先 grep 确认**：`grep -n "openExternal" apps/studio/electron/preload/index.ts`。

- [ ] **Step 3: 接进 SettingsView（SettingsView.tsx）**

`categories` 数组里，在 `knowledgeBase` 那条之后加一条（icon 复用现有已 import 的图标，如 `<SlidersIcon />`；若想要专属图标用现有任一 lucide 图标）：

```tsx
      { id: 'components', label: t('catComponents'), icon: <SlidersIcon /> },
```

`CategoryId` 联合类型加 `| 'components'`。

渲染分支里，`knowledgeBase` 分支之后加：

```tsx
          ) : activeCategory === 'components' ? (
            <ComponentsSection />
```

文件顶部 import 加：

```tsx
import { ComponentsSection } from './ComponentsSection'
```

- [ ] **Step 4: typecheck**

Run: `cd apps/studio && bun run typecheck`
Expected: PASS（若 `openExternal` 报未定义，按 Step 2 注释换成实际方法名或退化）

- [ ] **Step 5: 提交**

```bash
git add apps/studio/src/chat/components/settings/ComponentsSection.tsx apps/studio/src/chat/components/settings/SettingsView.tsx apps/studio/src/chat/i18n.ts
git commit -m "feat(component-download): 组件中心 UI（新设置分类『组件/扩展』，三行组件读状态表）"
```

---

### Task 7: embed 下载入口从「知识库」搬到组件中心

**Files:**
- Modify: `apps/studio/src/chat/components/settings/KnowledgeBaseSection.tsx`（移除模型下载 Section + 加指路）

**Interfaces:**
- Consumes: Task 6 的 `kbModelMovedHint` i18n 键。
- Produces: 「知识库」分类不再有模型下载 UI，只留一句指路。

- [ ] **Step 1: 移除模型下载 Section、加指路**

删除 `KnowledgeBaseSection.tsx` 中整个 `<Section title={t('kbModelTitle')} …>…</Section>` 块（约 146-183 行，即消费 `model?.phase` 的那整块）。同时删除该组件里已无用的模型状态：`const [model, setModel] = useState<KbModelDownloadState | null>(null)` 及其 `useEffect`（订阅 `onKbModelDownload` 那段，约 61-65 行）、`modelDownloading` 变量（约 135 行）、`KbModelDownloadState` import（约第 5 行）。

在原 Section 位置替换为一句指路（放在 `catKnowledgeBase` 标题下、`kbSourceTitle` Section 前）：

```tsx
      <p className="text-[12px] text-muted-foreground/80">{t('kbModelMovedHint')}</p>
```

- [ ] **Step 2: typecheck**

Run: `cd apps/studio && bun run typecheck`
Expected: PASS（若报 `KbModelDownloadState` 未用 import / `model` 未用，按报错删净）

- [ ] **Step 3: 提交**

```bash
git add apps/studio/src/chat/components/settings/KnowledgeBaseSection.tsx
git commit -m "feat(component-download): embed 下载入口移至组件中心，知识库分区留指路"
```

---

### Task 8: 最小全局 toast

**Files:**
- Create: `apps/studio/src/chat/stores/toast.ts`
- Create: `apps/studio/src/chat/components/Toaster.tsx`
- Modify: `apps/studio/src/chat/App.tsx`（App 根挂 `<Toaster />`）

**Interfaces:**
- Produces:
  - `useToastStore` — `{ toasts: ToastItem[]; push(msg, tone): void; dismiss(id): void }`；`interface ToastItem { id: number; message: string; tone: 'ok' | 'err' | 'info' }`
  - `<Toaster />` — 角落浮条渲染器。

- [ ] **Step 1: 写 toast store（含纯计数器测试）**

```ts
// apps/studio/src/chat/stores/toast.ts
// 最小全局 toast：角落浮条，约 4s 自动消。全仓原无 toast 基建，这是第一套——
// 组件下载「用户走开后装好了」等场景报喜用，别处（导出/同步成功）也可复用。
import { create } from 'zustand'

export interface ToastItem { id: number; message: string; tone: 'ok' | 'err' | 'info' }

let seq = 0
const DURATION_MS = 4000

interface ToastState {
  toasts: ToastItem[]
  push: (message: string, tone?: ToastItem['tone']) => void
  dismiss: (id: number) => void
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (message, tone = 'info') => {
    const id = ++seq
    set({ toasts: [...get().toasts, { id, message, tone }] })
    window.setTimeout(() => get().dismiss(id), DURATION_MS)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((x) => x.id !== id) }),
}))

/** 便捷调用：toast('已就绪', 'ok')。 */
export function toast(message: string, tone: ToastItem['tone'] = 'info'): void {
  useToastStore.getState().push(message, tone)
}
```

- [ ] **Step 2: 写 Toaster.tsx**

```tsx
// apps/studio/src/chat/components/Toaster.tsx
import React from 'react'
import { useToastStore } from '../stores/toast'

/**
 * 角落浮条渲染器。挂 App 根、常驻（无 toast 时渲染空容器）。视觉参照 ProposalDocPanel 的浮层：
 * 右下固定、pointer-events 放行到按钮、tone 三色。裸元素不涉及 canvas reset（不在 portal、
 * 用 data-slot 稳妥标记逃逸）。
 */
export function Toaster(): React.JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2" data-slot="toaster">
      {toasts.map((tst) => (
        <button
          key={tst.id}
          type="button"
          data-slot="toast"
          onClick={() => dismiss(tst.id)}
          className={
            'pointer-events-auto max-w-[320px] rounded-lg border px-3.5 py-2.5 text-left text-[12.5px] shadow-lg transition-all ' +
            (tst.tone === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : tst.tone === 'err'
                ? 'border-destructive/30 bg-destructive/10 text-destructive'
                : 'border-border bg-card text-foreground')
          }
        >
          {tst.message}
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: 挂 App 根（App.tsx）**

在 `<SessionSearchDialog />` 之后（约 306 行）加：

```tsx
      <Toaster />
```

文件顶部 import 加：

```tsx
import { Toaster } from './components/Toaster'
```

- [ ] **Step 4: typecheck**

Run: `cd apps/studio && bun run typecheck`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/studio/src/chat/stores/toast.ts apps/studio/src/chat/components/Toaster.tsx apps/studio/src/chat/App.tsx
git commit -m "feat(component-download): 最小全局 toast（store + Toaster + App 根挂载）"
```

---

### Task 9: 渐进式弹窗（可复用组件 + store）

**Files:**
- Create: `apps/studio/src/chat/stores/componentPrompt.ts`
- Create: `apps/studio/src/chat/components/ComponentPrompt.tsx`
- Modify: `apps/studio/src/chat/App.tsx`（App 根挂 `<ComponentPrompt />`）
- Modify: `apps/studio/src/chat/i18n.ts`（弹窗文案键）

**Interfaces:**
- Consumes: Task 5 `useComponentStore`；Task 8 `toast`；Task 6 的组件标题 i18n 键。
- Produces:
  - `useComponentPromptStore` — `{ openFor: string | null; promptComponent(id): void; close(): void }`
  - `<ComponentPrompt />` — 渐进四阶段弹窗。
  - `promptComponent(id: string): void`（便捷导出）

- [ ] **Step 1: 加弹窗文案键（i18n.ts，zh + en 各一组）**

zh：

```ts
    compPromptTitle: '需要一个可选组件',
    compPromptBody: '这个功能需要「{title}」。要现在下载吗？下载在后台进行，不打断你。',
    compPromptNow: '现在下载',
    compPromptLater: '暂不',
    compPromptDetails: '查看下载详情',
    compPromptDone: '「{title}」已就绪，正在后台更新，稍后自动生效。',
    compPromptToast: '「{title}」已就绪',
```

en：

```ts
    compPromptTitle: 'An optional component is needed',
    compPromptBody: 'This feature needs “{title}”. Download it now? It runs in the background and won’t interrupt you.',
    compPromptNow: 'Download now',
    compPromptLater: 'Not now',
    compPromptDetails: 'View download details',
    compPromptDone: '“{title}” is ready and updating in the background; it will take effect shortly.',
    compPromptToast: '“{title}” is ready',
```

- [ ] **Step 2: 写 prompt store**

```ts
// apps/studio/src/chat/stores/componentPrompt.ts
// 渐进式组件下载弹窗的开关背板。promptComponent(id) 打开、指向某个缺失组件；弹窗自身订阅
// 组件状态表反映进度。一次只弹一个（openFor 单值），避免多弹窗叠。
import { create } from 'zustand'

interface PromptState {
  openFor: string | null
  promptComponent: (id: string) => void
  close: () => void
}

export const useComponentPromptStore = create<PromptState>((set) => ({
  openFor: null,
  promptComponent: (id) => set({ openFor: id }),
  close: () => set({ openFor: null }),
}))

export function promptComponent(id: string): void {
  useComponentPromptStore.getState().promptComponent(id)
}
```

- [ ] **Step 3: 写 ComponentPrompt.tsx**

```tsx
// apps/studio/src/chat/components/ComponentPrompt.tsx
import React, { useEffect, useRef } from 'react'
import { useT, useTFormat } from '../i18n'
import { useComponentPromptStore } from '../stores/componentPrompt'
import { useComponentStore } from '../stores/components'
import { useSettingsStore } from '../stores/settings'
import { toast } from '../stores/toast'

// 组件 id → 标题 i18n 键（与 ComponentsSection 的映射一致，供弹窗文案插值）。
const TITLE_KEY: Record<string, string> = {
  'kb-embed': 'compEmbedTitle',
  'markitdown': 'compMarkitdownTitle',
  'soffice': 'compSofficeTitle',
}

/**
 * 渐进式非阻断弹窗，右下角浮出。四阶段：
 *  1. 初始   [现在下载][暂不]
 *  2. 下载中 进度条/转圈 + [查看下载详情]（跳组件中心）
 *  3. 成功   一句「说清变了什么」+ 自动淡出；若用户已关掉弹窗 → toast 报喜
 *  4. 失败/暂不 → 关掉，功能照旧静默降级
 * 常驻挂载：openFor==null 时渲染 null。
 */
export function ComponentPrompt(): React.JSX.Element | null {
  const t = useT()
  const tFormat = useTFormat()
  const openFor = useComponentPromptStore((s) => s.openFor)
  const close = useComponentPromptStore((s) => s.close)
  const stateOf = useComponentStore((s) => s.stateOf)
  const init = useComponentStore((s) => s.init)
  const openSettings = useSettingsStore((s) => s.open) // 打开设置页（跳组件中心分类）

  // 订阅整表（弹窗独立订阅一次，保证即便组件中心没开也能拿进度）。
  useEffect(() => init(), [init])

  const state = openFor ? stateOf(openFor) : null
  const title = openFor ? t(TITLE_KEY[openFor] ?? '') : ''

  // 成功后：短暂展示成功话再自动关；若此刻弹窗已被用户关掉（openFor 变 null 由 close 触发），
  // 则在 KbToolbar/触发点侧用 toast 兜底（此处只管弹窗还开着的情形）。
  const doneShownRef = useRef(false)
  useEffect(() => {
    if (state?.status === 'ready' && openFor && !doneShownRef.current) {
      doneShownRef.current = true
      const id = window.setTimeout(() => { close(); doneShownRef.current = false }, 3000)
      return () => window.clearTimeout(id)
    }
    if (!openFor) doneShownRef.current = false
  }, [state?.status, openFor, close])

  if (!openFor || !state) return null

  const start = (): void => { void window.chatApi.startComponentInstall(openFor) }
  const goDetails = (): void => { openSettings('components'); /* 保留弹窗，用户可在两处看进度 */ }

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[55] w-[340px]" data-slot="component-prompt">
      <div className="pointer-events-auto space-y-3 rounded-xl border border-border bg-card p-4 shadow-xl">
        {state.status === 'ready' ? (
          <p className="text-[12.5px] text-emerald-700 dark:text-emerald-300">{tFormat('compPromptDone', { title })}</p>
        ) : state.status === 'installing' ? (
          <>
            <p className="text-[12.5px] font-medium text-foreground">{title}</p>
            {state.percent != null ? (
              <div className="relative h-1.5 w-full rounded-full bg-muted">
                <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width]" style={{ width: `${state.percent}%` }} />
              </div>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                <span className="size-3.5 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-transparent" />
                {t('compInstalling')}
              </span>
            )}
            <button type="button" onClick={goDetails}
              className="text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
              {t('compPromptDetails')}
            </button>
          </>
        ) : (
          <>
            <p className="text-[12.5px] font-medium text-foreground">{t('compPromptTitle')}</p>
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">{tFormat('compPromptBody', { title })}</p>
            {state.status === 'error' && state.errorMessage && (
              <p className="text-[11px] text-destructive">{state.errorMessage}</p>
            )}
            <div className="flex items-center gap-2">
              <button type="button" onClick={start}
                className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-[12px] font-medium text-accent-foreground hover:bg-accent/90">
                {t('compPromptNow')}
              </button>
              <button type="button" onClick={close}
                className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12px] font-medium text-foreground hover:bg-muted/60">
                {t('compPromptLater')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
```

> **`useSettingsStore` 的开法**：本文件假设有 `stores/settings.ts` 且其 `open(categoryId?)` 能打开设置页并可选定位分类。**Step 5 前先核实**：`grep -n "export const useSettingsStore\|open:" apps/studio/src/chat/stores/settings.ts`。若 `open` 不接分类参数，改为先 `open()` 再无定位（跳详情降级为打开设置页首屏），并在注释里记；若 store 名/方法名不同，按实际改。以 typecheck 绿为准。

- [ ] **Step 4: 挂 App 根（App.tsx）**

在 `<Toaster />` 之前或之后加：

```tsx
      <ComponentPrompt />
```

import：

```tsx
import { ComponentPrompt } from './components/ComponentPrompt'
```

- [ ] **Step 5: typecheck**

Run: `cd apps/studio && bun run typecheck`
Expected: PASS（settings store 开法按实际校准后）

- [ ] **Step 6: 提交**

```bash
git add apps/studio/src/chat/stores/componentPrompt.ts apps/studio/src/chat/components/ComponentPrompt.tsx apps/studio/src/chat/App.tsx apps/studio/src/chat/i18n.ts
git commit -m "feat(component-download): 渐进式非阻断弹窗（四阶段 + 跳组件中心 + 成功淡出）"
```

---

### Task 10: 功能门接线（导入缺 markitdown 弹窗 + embed 引导升级 + 卡片改读新表）

**Files:**
- Modify: `apps/studio/src/chat/components/kb/KbToolbar.tsx`
- Modify: `apps/studio/src/chat/components/kb/KbToolingCard.tsx`

**Interfaces:**
- Consumes: Task 5 `useComponentStore`；Task 9 `promptComponent`。
- Produces: 导入/同步缺 markitdown → 弹渐进弹窗；embed 缺模型引导 → 打开组件中心/弹窗；markitdown 卡片改读组件表、安装走编排器。

- [ ] **Step 1: KbToolbar 改用组件表 + 接触发点**

在 `KbToolbar.tsx`：
- 删除本地 `const [model, setModel] = useState<KbModelDownloadState | null>(null)` 及其订阅 `useEffect`（约 23-28 行）、`KbModelDownloadState` import（第 2 行）。
- 从 `useKbStore` 移除 `tooling`（第 18 行）的使用改为组件表。顶部加：

```tsx
import { useComponentStore } from '../../stores/components'
import { promptComponent } from '../../stores/componentPrompt'
```

- 组件体内取两格状态与订阅：

```tsx
  const init = useComponentStore((s) => s.init)
  const embed = useComponentStore((s) => s.stateOf('kb-embed'))
  const markitdown = useComponentStore((s) => s.stateOf('markitdown'))
  useEffect(() => init(), [init])
```

- `migrate` 与 `sync` 两个函数体最前面（`if (busy) return` 之后）加「缺 markitdown 先弹窗」的非阻断守卫：

```tsx
    if (markitdown.status !== 'ready') { promptComponent('markitdown'); return }
```

> 语义：导入/同步是用到 markitdown 的功能门，缺就弹渐进弹窗、本次动作先不跑（用户装好后再点一次）。这是非阻断——弹窗不挡别的操作。

- 右侧状态区（约 86-104 行）把 `model?.phase === 'downloading'` / `model && !model.installed` 改成读 `embed`：

```tsx
        ) : embed.status === 'installing' ? (
          <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground/80">
            <kbIcons.refresh className="size-3.5 animate-spin" />
            {t('kbModelDownloading')} {embed.percent ?? 0}%
          </span>
        ) : embed.status !== 'ready' && (
          <button
            type="button"
            onClick={() => promptComponent('kb-embed')}
            className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-muted-foreground/80 transition-colors hover:text-foreground"
          >
            {t('kbModelMissingHint')} · {t('kbModelDownload')}
          </button>
        )}
```

- 底部 markitdown 缺失卡片 gate（约 109 行）改读组件表：

```tsx
      {!readOnly && markitdown.status !== 'ready' && <KbToolingCard />}
```

- [ ] **Step 2: KbToolingCard 改走编排器**

在 `KbToolingCard.tsx`：把 `install()` 里的 `await window.chatApi.kbInstallTooling()` + 三态 `result` 处理，改为触发编排器安装并由组件表反映（卡片自身不再持 `result`，改看组件表状态）。最小改法——保留卡片结构，安装按钮改触发编排器、文案随组件表：

```tsx
import { useComponentStore } from '../../stores/kb' // 占位：见下改为 components store
```

实际改动：
- 顶部 import 换成 `import { useComponentStore } from '../../stores/components'`。
- 组件体：`const md = useComponentStore((s) => s.stateOf('markitdown'))`；`const init = useComponentStore((s) => s.init)`；`useEffect(() => init(), [init])`。
- 安装按钮 `onClick` 改为 `() => { void window.chatApi.startComponentInstall('markitdown') }`；`busy` 改为 `md.status === 'installing'`。
- 失败反馈 `feedbackText`：`md.status === 'unavailable'` → `t('kbToolingUnsupported')`；`md.status === 'error'` → `t('kbToolingFailed')`（`md.errorMessage` 展开为日志区）。
- 删除本地 `result`/`showLog` 里依赖旧 `KbToolingInstallResult` 的分支，`manualCmd` 的 `result?.unsupported` 改 `md.status === 'unavailable'`。`refresh`（`useKbStore`）不再需要（组件表自动推），删其 import 与使用。

> 该卡片改动较碎，实施时以「按钮触发 `startComponentInstall('markitdown')` + 文案/日志读 `md` 组件表 + 删净旧 `kbInstallTooling`/`KbToolingInstallResult` 依赖」为准，typecheck 绿即可。

- [ ] **Step 3: typecheck**

Run: `cd apps/studio && bun run typecheck`
Expected: PASS（`tooling`/`model`/`KbModelDownloadState`/`KbToolingInstallResult` 旧依赖删净）

- [ ] **Step 4: 提交**

```bash
git add apps/studio/src/chat/components/kb/KbToolbar.tsx apps/studio/src/chat/components/kb/KbToolingCard.tsx
git commit -m "feat(component-download): 功能门接线——导入缺 markitdown 弹窗 + embed 引导升级 + 卡片读新表"
```

---

### Task 11: 退役旧 6 通道 + kbModelDownloader / kbModelDownload + kb store tooling

**Files:**
- Delete: `apps/studio/electron/main/services/kbModelDownloader.ts`
- Delete: `apps/studio/electron/shared/kbModelDownload.ts`
- Modify: `apps/studio/electron/shared/ipc-channels.ts`（删 6 通道常量 + 4 个 ChatApi 方法签名 + `KbToolingStatus`/`KbToolingInstallResult` 的 kbToolingCheck/kbInstallTooling 签名）
- Modify: `apps/studio/electron/preload/index.ts`（删 6 方法）
- Modify: `apps/studio/electron/main/ipc/register.ts`（删 6 handler + 6 removeHandler + import）
- Modify: `apps/studio/electron/main/tabRegistry.ts`（删 `broadcastKbModelDownload`）
- Modify: `apps/studio/electron/main/index.ts`（删 `onKbModelDownload`/`refreshKbModelInstalled` 接线与 import）
- Modify: `apps/studio/src/chat/stores/kb.ts`（删 `tooling` 字段 + `kbToolingCheck()` 调用）

**Interfaces:**
- Consumes: 前面所有任务已把消费方迁到 `COMPONENT_*`。
- Produces: 旧下载/工具通道与单模型状态彻底移除，单一事实源收敛到编排器。

- [ ] **Step 1: 先扫残余消费方，确认可安全删**

Run: `cd apps/studio && grep -rn "kbModelDownloader\|KbModelDownloadState\|kbModelDownload\b\|KB_MODEL_DOWNLOAD\|kbToolingCheck\|kbInstallTooling\|KB_TOOLING_CHECK\|KB_INSTALL_TOOLING\|broadcastKbModelDownload\|onKbModelDownload\|refreshKbModelInstalled\|startKbModelDownload\|cancelKbModelDownload\|kbModelDownloadStatusGet" electron src | grep -v ".test.ts"`
Expected: 命中只应落在本任务待删的那几处（ipc-channels/preload/register/tabRegistry/index/stores/kb + 两个待删文件自身）。若命中别处，先把那处迁到 `COMPONENT_*`（照 Task 6/10 模式）再继续。

- [ ] **Step 2: 删两个文件**

```bash
git rm apps/studio/electron/main/services/kbModelDownloader.ts apps/studio/electron/shared/kbModelDownload.ts
```

- [ ] **Step 3: 删各处旧接线**

- `ipc-channels.ts`：删 `KB_MODEL_DOWNLOAD_STATUS_GET/START/CANCEL/STATUS`、`KB_TOOLING_CHECK`、`KB_INSTALL_TOOLING` 六个常量；删 `ChatApi` 里 `kbToolingCheck`/`kbInstallTooling`/`kbModelDownloadStatusGet`/`startKbModelDownload`/`cancelKbModelDownload`/`onKbModelDownload` 六个签名。
- `preload/index.ts`：删对应 6 个方法块（`kbToolingCheck`/`kbInstallTooling`/`kbModelDownloadStatusGet`/`startKbModelDownload`/`cancelKbModelDownload`/`onKbModelDownload`）及不再用的类型 import（`KbModelDownloadState` 等，以 typecheck 报未用为准）。
- `register.ts`：删 `KB_TOOLING_CHECK`/`KB_INSTALL_TOOLING`/`KB_MODEL_DOWNLOAD_STATUS_GET/START/CANCEL` 五个 `ipcMain.handle` 块 + removeHandler 段对应三条 `KB_MODEL_DOWNLOAD_*`；删 `../services/kbModelDownloader` import；`detectTooling`/`installMarkitdown` 若在 register.ts 已无其他引用则删其 import（grep 确认——它们现被编排器引用、register 不再直接用）。
- `tabRegistry.ts`：删 `broadcastKbModelDownload` 函数 + 其 `KbModelDownloadState` type import。
- `index.ts`：删 `onKbModelDownload((s) => broadcastKbModelDownload(s))` 与 `refreshKbModelInstalled()` 两行 + 其 import（第 60 行那条 + broadcast import）。
- `stores/kb.ts`：`KbState` 删 `tooling: KbToolingStatus | null` 字段；`refresh()` 的 `Promise.all` 去掉 `window.chatApi.kbToolingCheck()`（三元组变二元 `[list, build]`），`set(...)` 去掉 `tooling`；删 `KbToolingStatus` import。

- [ ] **Step 4: typecheck + 全量纯核回归**

Run: `cd apps/studio && bun run typecheck && bun test electron/`
Expected: PASS（typecheck 无未用/未定义；electron 纯核测试全绿，旧测试若引用已删符号需同删——以报错为准）

> 若 `electron/` 下有 `kbModelDownloader`/`kbModelDownload` 的旧测试文件，一并 `git rm`（其被测对象已删）。

- [ ] **Step 5: 提交**

```bash
git add apps/studio/electron/shared/ipc-channels.ts apps/studio/electron/preload/index.ts apps/studio/electron/main/ipc/register.ts apps/studio/electron/main/tabRegistry.ts apps/studio/electron/main/index.ts apps/studio/src/chat/stores/kb.ts
git commit -m "refactor(component-download): 退役 KB_MODEL_DOWNLOAD/KB_TOOLING 六通道 + kbModelDownloader 薄壳，收敛单一事实源"
```

---

## Self-Review

**1. Spec 覆盖（对本 spec 六节 + 验收）**：
- 一、统一状态表 + id 键控通道退役旧 6 通道 → Task 1（状态类型）/ Task 3（编排器单一写手）/ Task 4（加新通道）/ Task 11（退旧）✓
- 二、档案卡补 pipx/detect-only + 名册加两卡 → Task 1（类型）/ Task 2（名册）✓
- 三、组件中心新分类 + embed 搬迁 + 知识库指路 → Task 6 / Task 7 ✓
- 四、渐进弹窗 + 只接导入-markitdown 触发 + embed 引导升级 + engine.ts:1308 不接 → Task 9 / Task 10 ✓
- 五、最小全局 toast → Task 8（+ Task 9 成功场景消费）✓
- 六、架构/单元边界/纯逻辑可测 → 纯函数测试落在 Task 1/2/3；前端薄层靠 typecheck ✓
- 验收「embed 逐字节等价」：Task 3 编排器 hosted-files 分派复用 P1a `installComponent` + 收尾钩子保留 resetEmbedWorker/warmEmbedWorker/scheduleKbBuild + 取消回未装态——行为对齐旧 `startKbModelDownload`；Task 11 退旧后 embed 只经编排器一条路 ✓
- 「收尾分账」：Task 3 `SUCCESS_HOOKS` 单独 try 包住 ✓

**2. 占位符扫描**：无 TBD/TODO。三处「以 typecheck 绿为准」的校准点（preload shared import 别名、`openExternal` 方法名、`useSettingsStore.open` 分类参数）均给了 grep 核实步骤 + 降级方案，非空占位。

**3. 类型一致性**：`ComponentStatus`/`ComponentState`/`ComponentTable`（Task 1）贯穿 3/4/5/6/9；`applyComponentPatch`/`mapPipxResult`/`getComponentTable`/`onComponentStatus`/`startComponentInstall`/`cancelComponentInstall`/`refreshComponentInstalled`（Task 3）在 Task 4 handler 与 Task 11 一致引用；通道常量 `COMPONENT_STATUS_GET/INSTALL_START/INSTALL_CANCEL/STATUS`（Task 4）与 preload 方法 `componentStatusGet/startComponentInstall/cancelComponentInstall/onComponentStatus` 命名对齐；组件 id 常量 `kb-embed`/`markitdown`/`soffice` 在 registry（Task 2）、前端 ROWS/TITLE_KEY（Task 6/9）、触发点（Task 10）逐字一致。

**4. 顺序/绿灯保证**：先加后退（Task 4 加新通道、Task 11 退旧），中间 Task 5-10 每个只加前端、typecheck 绿；Task 11 前置 grep 步确保无残余消费方才删。
