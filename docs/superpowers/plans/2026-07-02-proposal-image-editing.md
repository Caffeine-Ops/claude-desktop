# 写方案·编辑器内 P 图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在「写方案」编辑器里新增图片编辑能力——改造已插入的图、从零文生图、上传本地图再改——底层复用 gpt-image-2 的出图逻辑（移植进主进程，因为要分发给终端用户）。

**Architecture:** 产出图落盘到每会话的 `<userData>/proposal-drafts/<sessionId>/assets/`，markdown 里存**绝对路径**（与现有 KB 图一致，故 docx 导出零改动）；渲染侧新增 `proposalasset://` 协议加载这些图（照 kbasset 范式，路径守卫锁死 proposal-drafts 目录）。出图走主进程 service `imageGenService`（直调 OpenAI 兼容 `/images/generations` 与 `/images/edits`，含 502 重试 + 模型降级），凭据存在 `appSettings` 新字段并由设置面板填。接地校验对 proposal-drafts 下的图（用户主动 P 的）豁免，不标红。改图/生图一律先审后落地，复用现有「对话内审阅」组件模式。

**Tech Stack:** Electron（main/preload/renderer 三进程）、React 19、zustand、TypeScript composite、bun test（唯一自动化测试）、`docx` 库、`image-size`。

## Global Constraints

- 包管理器是 **bun**，不是 npm。测试：`bun test src/`（在 `apps/desktop/` 下跑）。
- 质量门只有 `bun run typecheck`（`apps/desktop/` 下）+ `bun test`；**无 ESLint**。renderer 无单元测试传统，renderer 任务以 typecheck + 手动 GUI 走查为验收。
- 进程边界：renderer **禁止**直接 import Node 模块；主进程能力一律走 `window.chatApi`（preload 暴露）。
- 加一条 IPC **必须同步改四处**：`apps/desktop/src/shared/ipc-channels.ts`（通道常量）→ `apps/desktop/src/preload/index.ts`（暴露方法）→ `apps/desktop/src/preload/index.d.ts`（类型）→ main handler（`apps/desktop/src/main/ipc/register.ts`）。漏一处 typecheck 当场报错。
- `registerSchemesAsPrivileged` 必须在 `app.whenReady()` **之前**登记；协议 handler 在 whenReady 回调里 `await` 注册（见 `apps/desktop/src/main/index.ts` 现有 kbasset 登记处）。
- 不碰哨兵、层级编号（TOC_REF/HEADING_REF）、BM25/trigram 校验逻辑本体。
- 图片 markdown 存**绝对路径**（不存 `proposalasset://`）——这是与 spec 的有意偏离：docx `imageParagraphs` 已 `readFileSync(绝对路径)` 直读，存绝对路径则导出零改动。
- 产出图文件名前缀编码来源：`gen-*`（文生图）/ `edit-*`（改图）/ `upload-*`（上传）。来源从路径 basename 前缀推导，不引入 markdown schema 变更。

---

### Task 1: 草稿资产纯函数（shared）

产出图的「路径判定 + 来源推导 + 文件名生成」纯函数。main 与 renderer 共享，可单测。

**Files:**
- Create: `apps/desktop/src/shared/proposalAsset.ts`
- Test: `apps/desktop/src/shared/proposalAsset.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `PROPOSAL_ASSET_MARKER = '/proposal-drafts/'`（路径判定特征段）
  - `type ProposalImageOrigin = 'generated' | 'edited' | 'uploaded'`
  - `isProposalAssetPath(absPath: string): boolean` —— 路径是否落在草稿资产区（含 `/proposal-drafts/` 且含 `/assets/`）
  - `deriveImageOrigin(absPath: string): ProposalImageOrigin | null` —— 按 basename 前缀 `gen-`/`edit-`/`upload-` 推导，非草稿资产返回 null
  - `proposalAssetFileName(origin: ProposalImageOrigin, ext: string, ts: number): string` —— 生成 `<prefix>-<ts>.<ext>`（prefix: gen/edit/upload）

- [ ] **Step 1: 写失败测试**

```ts
// apps/desktop/src/shared/proposalAsset.test.ts
import { describe, it, expect } from 'bun:test'
import {
  isProposalAssetPath,
  deriveImageOrigin,
  proposalAssetFileName
} from './proposalAsset'

describe('isProposalAssetPath', () => {
  it('proposal-drafts 下的 assets 路径 → true', () => {
    expect(
      isProposalAssetPath('/U/x/Application Support/app/proposal-drafts/sess-1/assets/gen-123.png')
    ).toBe(true)
  })
  it('KB assets 路径 → false（不是草稿资产）', () => {
    expect(isProposalAssetPath('/U/x/app/kb-index/assets/线/img-1.png')).toBe(false)
  })
  it('空串 → false', () => {
    expect(isProposalAssetPath('')).toBe(false)
  })
})

describe('deriveImageOrigin', () => {
  it('gen- 前缀 → generated', () => {
    expect(deriveImageOrigin('/p/proposal-drafts/s/assets/gen-1.png')).toBe('generated')
  })
  it('edit- 前缀 → edited', () => {
    expect(deriveImageOrigin('/p/proposal-drafts/s/assets/edit-1.png')).toBe('edited')
  })
  it('upload- 前缀 → uploaded', () => {
    expect(deriveImageOrigin('/p/proposal-drafts/s/assets/upload-1.png')).toBe('uploaded')
  })
  it('非草稿资产路径 → null', () => {
    expect(deriveImageOrigin('/p/kb-index/assets/img-1.png')).toBeNull()
  })
})

describe('proposalAssetFileName', () => {
  it('generated → gen-<ts>.png', () => {
    expect(proposalAssetFileName('generated', 'png', 1751000000000)).toBe('gen-1751000000000.png')
  })
  it('edited → edit-<ts>.png', () => {
    expect(proposalAssetFileName('edited', 'png', 42)).toBe('edit-42.png')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/shared/proposalAsset.test.ts`
Expected: FAIL —— `Cannot find module './proposalAsset'`

- [ ] **Step 3: 写实现**

```ts
// apps/desktop/src/shared/proposalAsset.ts
/**
 * 草稿产出图（改图/文生图/上传）的路径判定与来源推导纯函数。
 *
 * 为什么靠路径而非 markdown schema：产出图与 KB 图一样在 markdown 里只存绝对路径
 * （`![alt](/abs/path.png)`），没有额外字段承载来源。约定「草稿资产目录 + 文件名前缀」
 * 双特征就能无歧义地推出来源，零 schema 变更。见 [[proposal-image-editing 设计 spec]]。
 */

/** 草稿资产落盘根特征：`<userData>/proposal-drafts/<sessionId>/assets/`。 */
export const PROPOSAL_ASSET_MARKER = '/proposal-drafts/'
const ASSETS_SEG = '/assets/'

export type ProposalImageOrigin = 'generated' | 'edited' | 'uploaded'

const PREFIX: Record<ProposalImageOrigin, string> = {
  generated: 'gen',
  edited: 'edit',
  uploaded: 'upload'
}

export function isProposalAssetPath(absPath: string): boolean {
  if (!absPath) return false
  return absPath.includes(PROPOSAL_ASSET_MARKER) && absPath.includes(ASSETS_SEG)
}

export function deriveImageOrigin(absPath: string): ProposalImageOrigin | null {
  if (!isProposalAssetPath(absPath)) return null
  const base = absPath.slice(absPath.lastIndexOf('/') + 1)
  if (base.startsWith('gen-')) return 'generated'
  if (base.startsWith('edit-')) return 'edited'
  if (base.startsWith('upload-')) return 'uploaded'
  return null
}

export function proposalAssetFileName(origin: ProposalImageOrigin, ext: string, ts: number): string {
  return `${PREFIX[origin]}-${ts}.${ext}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test src/shared/proposalAsset.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/proposalAsset.ts apps/desktop/src/shared/proposalAsset.test.ts
git commit -m "feat(proposal): 草稿产出图路径判定/来源推导纯函数"
```

---

### Task 2: `proposalasset://` 协议（main service）

让渲染进程能加载草稿资产目录里的产出图。照 `kbAssetProtocol.ts` 范式，路径守卫锁死 `<userData>/proposal-drafts/`。

**Files:**
- Create: `apps/desktop/src/main/services/proposalAssetProtocol.ts`
- Test: `apps/desktop/src/main/services/proposalAssetProtocol.test.ts`
- Modify: `apps/desktop/src/main/index.ts`（registerSchemesAsPrivileged 追加 scheme + whenReady 里 await 注册）

**Interfaces:**
- Consumes: `isPathInsideProposalRoot` 复用 kbAssetProtocol 里 `isPathInsideKbRoot` 的同款纯前缀守卫（本任务自带一份，签名 `(absPath, root) => boolean`）。
- Produces:
  - `PROPOSAL_ASSET_SCHEME = 'proposalasset'`
  - `isPathInsideProposalRoot(absPath: string, root: string): boolean`
  - `registerProposalAssetProtocol(): Promise<void>`
  - `proposalDraftsRoot(): string`（`<userData>/proposal-drafts`）

- [ ] **Step 1: 写失败测试（路径守卫）**

```ts
// apps/desktop/src/main/services/proposalAssetProtocol.test.ts
import { describe, it, expect } from 'bun:test'
import { isPathInsideProposalRoot } from './proposalAssetProtocol'

const ROOT = '/U/x/app/proposal-drafts'

describe('isPathInsideProposalRoot', () => {
  it('根目录内的文件 → true', () => {
    expect(isPathInsideProposalRoot(`${ROOT}/sess-1/assets/gen-1.png`, ROOT)).toBe(true)
  })
  it('根目录本身 → true', () => {
    expect(isPathInsideProposalRoot(ROOT, ROOT)).toBe(true)
  })
  it('兄弟目录 proposal-drafts-evil → false（防前缀误判）', () => {
    expect(isPathInsideProposalRoot('/U/x/app/proposal-drafts-evil/x.png', ROOT)).toBe(false)
  })
  it('逃逸到根外 → false', () => {
    expect(isPathInsideProposalRoot(`${ROOT}/../../etc/passwd`, ROOT)).toBe(false)
  })
  it('空串 → false', () => {
    expect(isPathInsideProposalRoot('', ROOT)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/main/services/proposalAssetProtocol.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写实现（协议 + 守卫）**

```ts
// apps/desktop/src/main/services/proposalAssetProtocol.ts
/**
 * `proposalasset://` 自定义协议 —— 让渲染进程显示草稿资产目录里的产出图
 * （改图/文生图/上传）。与 kbAssetProtocol.ts 同构，区别只在守卫根目录换成
 * `<userData>/proposal-drafts`（可写区），而非只读的 KB 镜像。
 *
 * URL 形：`proposalasset://p/<encodeURIComponent(图的绝对路径)>`，渲染侧由
 * toProposalAssetUrl 构造（见 renderer/lib/proposalAssetUrl.ts）。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { normalize, sep } from 'node:path'
import { Readable } from 'node:stream'

export const PROPOSAL_ASSET_SCHEME = 'proposalasset'

/** 纯前缀守卫（无 fs）：规整后的 absPath 必须落在 root 之内。root 末尾补 sep 防兄弟目录误判。 */
export function isPathInsideProposalRoot(absPath: string, root: string): boolean {
  if (!absPath || !root) return false
  const abs = normalize(absPath)
  const r = normalize(root)
  return abs === r || abs.startsWith(r + sep)
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

function mimeFor(filePath: string): string {
  const idx = filePath.lastIndexOf('.')
  if (idx === -1) return 'application/octet-stream'
  return MIME[filePath.slice(idx).toLowerCase()] ?? 'application/octet-stream'
}

/** `<userData>/proposal-drafts`（惰性取，避免模块加载期 "app not ready"）。 */
export function proposalDraftsRoot(): string {
  // 动态 import 避免顶层依赖 electron（影响测试）。
  const { app } = require('electron') as typeof import('electron')
  const { join } = require('node:path') as typeof import('node:path')
  return join(app.getPath('userData'), 'proposal-drafts')
}

export async function registerProposalAssetProtocol(): Promise<void> {
  const { protocol } = await import('electron')
  protocol.handle(PROPOSAL_ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const absPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const root = proposalDraftsRoot()
      if (!isPathInsideProposalRoot(absPath, root)) return new Response('Forbidden', { status: 403 })
      const abs = normalize(absPath)
      if (!existsSync(abs) || !statSync(abs).isFile()) return new Response('Not Found', { status: 404 })
      const body = Readable.toWeb(createReadStream(abs)) as ReadableStream
      return new Response(body, { headers: { 'content-type': mimeFor(abs) } })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test src/main/services/proposalAssetProtocol.test.ts`
Expected: PASS

- [ ] **Step 5: 在 index.ts 登记 scheme + 注册 handler**

在 `apps/desktop/src/main/index.ts` 找到现有 `protocol.registerSchemesAsPrivileged([...])` 调用（kbasset 所在数组），追加一项；找到 `app.whenReady()` 回调里 `await registerKbAssetProtocol()` 处，追加 `await registerProposalAssetProtocol()`。

```ts
// index.ts 顶部 import 区，紧邻 kbAssetProtocol import
import { registerProposalAssetProtocol } from './services/proposalAssetProtocol'

// registerSchemesAsPrivileged 数组里追加（与 kbasset 同款开关）：
{ scheme: 'proposalasset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },

// app.whenReady() 回调里，await registerKbAssetProtocol() 之后追加：
await registerProposalAssetProtocol()
```

- [ ] **Step 6: typecheck + 提交**

Run: `cd apps/desktop && bun run typecheck`
Expected: 无错误

```bash
git add apps/desktop/src/main/services/proposalAssetProtocol.ts apps/desktop/src/main/services/proposalAssetProtocol.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(proposal): proposalasset:// 协议——加载草稿产出图（路径守卫锁 proposal-drafts）"
```

---

### Task 3: 渲染侧 URL 转换 + img override 分派（renderer）

markdown 里的产出图是绝对路径，渲染时转成 `proposalasset://`。KB 图走 kbasset、产出图走 proposalasset，其余原样。

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/proposalAssetUrl.ts`
- Test: `apps/desktop/src/renderer/src/lib/proposalAssetUrl.test.ts`
- Modify: `apps/desktop/src/renderer/src/components/chat/AssistantMarkdown.tsx`（img override 里对 src 先试 kbasset、再试 proposalasset）

**Interfaces:**
- Consumes: `PROPOSAL_ASSET_MARKER`（Task 1）
- Produces: `toProposalAssetUrl(src: string): string`

- [ ] **Step 1: 写失败测试**

```ts
// apps/desktop/src/renderer/src/lib/proposalAssetUrl.test.ts
import { describe, it, expect } from 'bun:test'
import { toProposalAssetUrl } from './proposalAssetUrl'

describe('toProposalAssetUrl', () => {
  it('草稿资产绝对路径 → proposalasset:// 编码 URL', () => {
    const p = '/U/x/app/proposal-drafts/sess-1/assets/gen-123.png'
    expect(toProposalAssetUrl(p)).toBe(`proposalasset://p/${encodeURIComponent(p)}`)
  })
  it('KB 图路径原样返回（交给 kbasset 处理）', () => {
    const p = '/U/x/app/kb-index/assets/img-1.png'
    expect(toProposalAssetUrl(p)).toBe(p)
  })
  it('http 图原样返回', () => {
    expect(toProposalAssetUrl('https://e.com/a.png')).toBe('https://e.com/a.png')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/renderer/src/lib/proposalAssetUrl.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写实现**

```ts
// apps/desktop/src/renderer/src/lib/proposalAssetUrl.ts
/**
 * 把 markdown 里的「草稿产出图绝对路径」转成 `proposalasset://` URL 供 <img> 加载。
 * 与 toKbAssetUrl 并列：KB 图含 /kb-index/assets/ 特征、走 kbasset；产出图含
 * /proposal-drafts/ + /assets/ 特征、走本函数。只在渲染时转，不改存储 markdown。
 */
import { PROPOSAL_ASSET_MARKER } from '../../../shared/proposalAsset'

export function toProposalAssetUrl(src: string): string {
  if (!src) return src
  if (src.includes(PROPOSAL_ASSET_MARKER) && src.includes('/assets/')) {
    return `proposalasset://p/${encodeURIComponent(src)}`
  }
  return src
}
```

> 注意 import 路径的 `../` 层级要对齐现有 `kbAssetUrl.ts` 引用 shared 的写法；若 shared 用了路径别名（如 `@shared/`），改用别名。跑 typecheck 校准。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test src/renderer/src/lib/proposalAssetUrl.test.ts`
Expected: PASS

- [ ] **Step 5: 接进 AssistantMarkdown 的 img override**

在 `AssistantMarkdown.tsx` 找到现有 `img` override（调 `toKbAssetUrl(src)` 处），改成链式：先 kbasset、若未命中再 proposalasset。

```tsx
// 现有大意：src = toKbAssetUrl(rawSrc)
// 改为：
import { toProposalAssetUrl } from '../../lib/proposalAssetUrl'
// ...
const kb = toKbAssetUrl(rawSrc)
const resolved = kb === rawSrc ? toProposalAssetUrl(rawSrc) : kb
// 用 resolved 作 <img src>
```

- [ ] **Step 6: 产出图来源角标**

在 img override 里，若 `deriveImageOrigin(rawSrc)` 非 null，把 `<img>` 包一层相对定位 `<span>`，右上角叠一个小角标：`generated`→「AI 生成」、`edited`→「已编辑」、`uploaded`→「用户上传」。角标只在编辑/预览态显示，**不进 markdown、不进 docx**（导出侧读的是绝对路径原文，天然不含角标）。样式用现有 Tailwind 工具类，勿套 `text-apple-*` 预设（见 [[proposal-ui-icons-typescale]]）。

```tsx
import { deriveImageOrigin } from '../../../shared/proposalAsset'
const originLabel = { generated: 'AI 生成', edited: '已编辑', uploaded: '用户上传' } as const
const origin = deriveImageOrigin(rawSrc)
// origin ? <span className="relative inline-block"><img .../><span className="absolute right-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{originLabel[origin]}</span></span> : <img .../>
```

- [ ] **Step 7: typecheck + 提交**

Run: `cd apps/desktop && bun run typecheck`
Expected: 无错误

```bash
git add apps/desktop/src/renderer/src/lib/proposalAssetUrl.ts apps/desktop/src/renderer/src/lib/proposalAssetUrl.test.ts apps/desktop/src/renderer/src/components/chat/AssistantMarkdown.tsx
git commit -m "feat(proposal): 渲染侧 proposalasset URL 转换 + img override 分派 + 来源角标"
```

---

### Task 4: 接地校验豁免产出图（verify core）

用户主动 P 的图（proposal-drafts 下）不参与知识库接地，不标红。

**Files:**
- Modify: `apps/desktop/src/main/core/proposalVerify.core.ts`（图接地判定处）
- Test: `apps/desktop/src/main/core/proposalVerify.core.test.ts`（新增用例）

**Interfaces:**
- Consumes: `isProposalAssetPath`（Task 1）
- Produces: 无新导出；改变 `verifyCitationsCore` 对产出图的判定（不产生 `ungrounded` 的 ImageVerdict）。

- [ ] **Step 1: 先看现有图接地判定**

Run: `cd apps/desktop && grep -n "imageVerdicts\|resolveAssets\|grounded\|parseImages" src/main/core/proposalVerify.core.ts`
读懂现在怎么给每张图判 grounded/ungrounded（图∈本节所引文件 assets 并集），定位那段循环。

- [ ] **Step 2: 写失败测试**

在 `proposalVerify.core.test.ts` 追加（沿用文件里既有的 `verifyCitationsCore` 调用范式与入参构造；下面是断言意图，入参按现有测试的 helper 补全）：

```ts
it('proposal-drafts 下的产出图豁免接地——不产生 ungrounded verdict', () => {
  const markdown = '正文（据《报告A》）\n\n![示意](/U/x/app/proposal-drafts/s1/assets/gen-1.png)'
  const result = verifyCitationsCore(/* section=markdown, 所引文件 assets 不含该图 */)
  const bad = (result.imageVerdicts ?? []).filter((v) => v.status === 'ungrounded')
  expect(bad.find((v) => v.path.includes('/proposal-drafts/'))).toBeUndefined()
})
```

> 用文件内已有测试的 helper（如构造 section / assets 的工厂）补全 `verifyCitationsCore` 的真实入参；`ImageVerdict.status` 字段名以 `proposal.ts` 的 `ImageVerdict` 定义为准（Step 1 已读到）。

- [ ] **Step 3: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/main/core/proposalVerify.core.test.ts`
Expected: FAIL —— 产出图当前被判 ungrounded

- [ ] **Step 4: 写实现（豁免）**

在图接地循环里，判定前短路：

```ts
import { isProposalAssetPath } from '../../shared/proposalAsset'
// ...每张图 img 判定处，最前面加：
if (isProposalAssetPath(img.path)) {
  continue // 用户主动 P 的图（改图/文生图/上传），不参与 KB 接地、不标红
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/desktop && bun test src/main/core/proposalVerify.core.test.ts`
Expected: PASS（新用例绿，既有用例不回归）

- [ ] **Step 6: 提交**

```bash
git add apps/desktop/src/main/core/proposalVerify.core.ts apps/desktop/src/main/core/proposalVerify.core.test.ts
git commit -m "feat(proposal): 接地校验豁免草稿产出图（用户主动 P 的图不标红）"
```

---

### Task 5: 出图 service（main）

移植 gpt-image-2 的出图逻辑：文生图 + 改图，含 502 重试 + 模型降级。纯 fetch，不 spawn 外部脚本。

**Files:**
- Create: `apps/desktop/src/main/services/imageGenService.ts`
- Test: `apps/desktop/src/main/services/imageGenService.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `interface ImageApiConfig { apiKey: string; baseURL: string; model: string }`
  - `normalizeBaseUrl(url: string): string` —— 去尾斜杠；末段非 /vN 则补 /v1
  - `buildModelList(startModel: string): string[]` —— `[startModel, ...默认降级序列去重]`
  - `generateImage(cfg, opts: { prompt: string; size?: string; quality?: string }): Promise<Buffer>`
  - `editImage(cfg, opts: { prompt: string; sourceBytes: Buffer; sourceMime: string; size?: string; quality?: string }): Promise<Buffer>`

- [ ] **Step 1: 写失败测试（normalizeBaseUrl + buildModelList + 降级）**

```ts
// apps/desktop/src/main/services/imageGenService.test.ts
import { describe, it, expect, mock, afterEach } from 'bun:test'
import {
  normalizeBaseUrl,
  buildModelList,
  generateImage,
  editImage
} from './imageGenService'

const CFG = { apiKey: 'k', baseURL: 'https://gw.example.com', model: 'gpt-image-2' }

describe('normalizeBaseUrl', () => {
  it('域名补 /v1', () => {
    expect(normalizeBaseUrl('https://gw.example.com')).toBe('https://gw.example.com/v1')
  })
  it('已有 /v1 原样', () => {
    expect(normalizeBaseUrl('https://gw.example.com/v1/')).toBe('https://gw.example.com/v1')
  })
})

describe('buildModelList', () => {
  it('起始模型置顶 + 默认降级序列去重', () => {
    expect(buildModelList('gpt-image-2')).toEqual(['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1'])
  })
})

const okJson = (b64: string) =>
  new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 })
const err502 = () => new Response('upstream', { status: 502 })

afterEach(() => {
  ;(globalThis.fetch as unknown) = undefined
})

describe('generateImage', () => {
  it('200 直接返回 b64 解码后的 Buffer', async () => {
    const b64 = Buffer.from('PNGDATA').toString('base64')
    globalThis.fetch = mock(async () => okJson(b64)) as unknown as typeof fetch
    const buf = await generateImage(CFG, { prompt: '一只鸭子' })
    expect(buf.toString()).toBe('PNGDATA')
  })

  it('首模型 502 → 降级到下一模型成功', async () => {
    const b64 = Buffer.from('OK').toString('base64')
    let n = 0
    globalThis.fetch = mock(async () => {
      n += 1
      // 第一模型 3 次都 502（MAX_ATTEMPTS_PER_MODEL），第二模型成功
      return n <= 3 ? err502() : okJson(b64)
    }) as unknown as typeof fetch
    const buf = await generateImage(CFG, { prompt: 'x' })
    expect(buf.toString()).toBe('OK')
  })

  it('所有模型都 5xx → 抛错', async () => {
    globalThis.fetch = mock(async () => err502()) as unknown as typeof fetch
    await expect(generateImage(CFG, { prompt: 'x' })).rejects.toThrow(/都失败|5\d\d|failed/i)
  })
})

describe('editImage', () => {
  it('走 multipart，200 返回 Buffer', async () => {
    const b64 = Buffer.from('EDITED').toString('base64')
    let sawMultipart = false
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      sawMultipart = init.body instanceof FormData
      return okJson(b64)
    }) as unknown as typeof fetch
    const buf = await editImage(CFG, {
      prompt: '换白底',
      sourceBytes: Buffer.from('SRC'),
      sourceMime: 'image/png'
    })
    expect(sawMultipart).toBe(true)
    expect(buf.toString()).toBe('EDITED')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/main/services/imageGenService.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写实现**

```ts
// apps/desktop/src/main/services/imageGenService.ts
/**
 * 主进程出图 service。移植 ~/.claude/skills/gpt-image-2（generate.js/edit.js/shared.js）
 * 的出图逻辑到 app 内——因为要分发给终端用户，不能 spawn 本机脚本 + ~/.codex 凭据。
 *
 * 端点（OpenAI 兼容）：
 *   文生图  POST {baseURL}/images/generations   JSON  { model, prompt, size?, quality? }
 *   改图    POST {baseURL}/images/edits          multipart  image + prompt + model + size? + quality?
 * 响应：data[0].b64_json（优先）或 data[0].url（回落下载）。
 * 健壮性：每模型最多 MAX_ATTEMPTS_PER_MODEL 次；5xx/网络错重试；模型间降级
 *   gpt-image-2 → gpt-image-1.5 → gpt-image-1。对话端点能用 ≠ 图像端点同时可用。
 */

export interface ImageApiConfig {
  apiKey: string
  baseURL: string
  model: string
}

const DEFAULT_DOWNGRADE = ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1']
const MAX_ATTEMPTS_PER_MODEL = 3

/** 图像端点需要 /vN 前缀，而中转网关 base_url 常只到域名。去尾斜杠；末段已是 /vN 则保留，否则补 /v1。 */
export function normalizeBaseUrl(url: string): string {
  const stripped = url.trim().replace(/\/+$/, '')
  if (/\/v\d+$/.test(stripped)) return stripped
  return `${stripped}/v1`
}

export function buildModelList(startModel: string): string[] {
  const seq = [startModel, ...DEFAULT_DOWNGRADE]
  return [...new Set(seq.filter(Boolean))]
}

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /Image API error \(5\d\d\)|upstream|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|EAI_AGAIN/i.test(
    msg
  )
}

async function postJson(url: string, apiKey: string, payload: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!res.ok) throw new Error(`Image API error (${res.status}): ${await res.text()}`)
  return res.json()
}

async function postMultipart(url: string, apiKey: string, form: FormData): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form
  })
  if (!res.ok) throw new Error(`Image API error (${res.status}): ${await res.text()}`)
  return res.json()
}

async function extractBytes(json: unknown): Promise<Buffer> {
  const first = (json as { data?: Array<{ b64_json?: string; url?: string }> })?.data?.[0]
  if (!first) throw new Error('API 响应缺 data[0]')
  if (first.b64_json) return Buffer.from(first.b64_json, 'base64')
  if (first.url) {
    const res = await fetch(first.url)
    if (!res.ok) throw new Error(`下载生成图失败 (${res.status})`)
    return Buffer.from(await res.arrayBuffer())
  }
  throw new Error('API 响应既无 b64_json 也无 url')
}

/** 对每个候选模型重试若干次，失败则降级到下一模型；全败则抛错。 */
async function withModelDowngrade(
  cfg: ImageApiConfig,
  call: (model: string) => Promise<unknown>
): Promise<Buffer> {
  const models = buildModelList(cfg.model)
  const failures: string[] = []
  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        return await extractBytes(await call(model))
      } catch (err) {
        failures.push(`${model}#${attempt}: ${(err as Error).message.slice(0, 120)}`)
        if (!isRetryable(err)) break // 非 5xx（如 400 提示词违规）不重试、直接换下一模型
      }
    }
  }
  throw new Error(
    `所有模型都失败了（${models.join(', ')}）。多半是中转网关图像后端临时 5xx。\n${failures.join('\n')}`
  )
}

export async function generateImage(
  cfg: ImageApiConfig,
  opts: { prompt: string; size?: string; quality?: string }
): Promise<Buffer> {
  const url = `${normalizeBaseUrl(cfg.baseURL)}/images/generations`
  return withModelDowngrade(cfg, (model) => {
    const payload: Record<string, unknown> = { model, prompt: opts.prompt }
    if (opts.size) payload.size = opts.size
    if (opts.quality) payload.quality = opts.quality
    return postJson(url, cfg.apiKey, payload)
  })
}

export async function editImage(
  cfg: ImageApiConfig,
  opts: { prompt: string; sourceBytes: Buffer; sourceMime: string; size?: string; quality?: string }
): Promise<Buffer> {
  const url = `${normalizeBaseUrl(cfg.baseURL)}/images/edits`
  return withModelDowngrade(cfg, (model) => {
    const form = new FormData()
    form.append('image', new Blob([opts.sourceBytes], { type: opts.sourceMime }), 'source.png')
    form.append('prompt', opts.prompt)
    form.append('model', model)
    if (opts.size) form.append('size', opts.size)
    if (opts.quality) form.append('quality', opts.quality)
    return postMultipart(url, cfg.apiKey, form)
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test src/main/services/imageGenService.test.ts`
Expected: PASS（含降级、multipart、全败抛错）

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/main/services/imageGenService.ts apps/desktop/src/main/services/imageGenService.test.ts
git commit -m "feat(proposal): 主进程出图 service——文生图/改图 + 502 重试 + 模型降级"
```

---

### Task 6: appSettings 新增 imageApi 字段

凭据存主进程设置文件。normalize 抽成可测纯函数。

**Files:**
- Modify: `apps/desktop/src/main/core/appSettings.ts`
- Test: `apps/desktop/src/main/core/appSettings.test.ts`（新建，只测导出的 `normalizeImageApi`）

**Interfaces:**
- Consumes: `ImageApiConfig`（Task 5）
- Produces: `AppSettings.imageApi?: ImageApiConfig`；`normalizeImageApi(raw: unknown): ImageApiConfig | undefined`（导出供测试）

- [ ] **Step 1: 写失败测试**

```ts
// apps/desktop/src/main/core/appSettings.test.ts
import { describe, it, expect } from 'bun:test'
import { normalizeImageApi } from './appSettings'

describe('normalizeImageApi', () => {
  it('三字段齐全 → 原样', () => {
    expect(normalizeImageApi({ apiKey: 'k', baseURL: 'https://x', model: 'gpt-image-2' })).toEqual({
      apiKey: 'k',
      baseURL: 'https://x',
      model: 'gpt-image-2'
    })
  })
  it('model 缺省 → 填默认 gpt-image-2', () => {
    expect(normalizeImageApi({ apiKey: 'k', baseURL: 'https://x' })?.model).toBe('gpt-image-2')
  })
  it('非对象 → undefined', () => {
    expect(normalizeImageApi(null)).toBeUndefined()
    expect(normalizeImageApi('x')).toBeUndefined()
  })
  it('apiKey 非字符串 → undefined（视为未配置）', () => {
    expect(normalizeImageApi({ apiKey: 42, baseURL: 'https://x' })).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/main/core/appSettings.test.ts`
Expected: FAIL —— `normalizeImageApi` 未导出

- [ ] **Step 3: 写实现**

在 `appSettings.ts`：

```ts
import type { ImageApiConfig } from '../services/imageGenService'

// AppSettings 接口加字段：
export interface AppSettings {
  cliBackend: CliBackend
  imageApi?: ImageApiConfig
}

// 新增导出纯函数：
export function normalizeImageApi(raw: unknown): ImageApiConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.apiKey !== 'string' || typeof r.baseURL !== 'string') return undefined
  return {
    apiKey: r.apiKey,
    baseURL: r.baseURL,
    model: typeof r.model === 'string' && r.model ? r.model : 'gpt-image-2'
  }
}

// 在现有 normalize(raw) 里追加：
if (raw.imageApi !== undefined) {
  const img = normalizeImageApi(raw.imageApi)
  if (img) out.imageApi = img
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test src/main/core/appSettings.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + 提交**

Run: `cd apps/desktop && bun run typecheck`

```bash
git add apps/desktop/src/main/core/appSettings.ts apps/desktop/src/main/core/appSettings.test.ts
git commit -m "feat(proposal): appSettings 新增 imageApi 字段（出图凭据）"
```

---

### Task 7: IPC 全链路——生图/改图/设置读写

把出图 service 与设置暴露给渲染进程。**改四处** + 落盘到草稿资产目录。

**Files:**
- Modify: `apps/desktop/src/shared/ipc-channels.ts`（4 个通道常量）
- Modify: `apps/desktop/src/preload/index.ts`（暴露方法）
- Modify: `apps/desktop/src/preload/index.d.ts`（类型）
- Modify: `apps/desktop/src/main/ipc/register.ts`（handler）
- Create: `apps/desktop/src/main/services/proposalImageWriter.ts`（落盘 helper）
- Test: `apps/desktop/src/main/services/proposalImageWriter.test.ts`

**Interfaces:**
- Consumes: `generateImage`/`editImage`（Task 5）、`getAppSettings`（Task 6）、`proposalDraftsRoot`（Task 2）、`proposalAssetFileName`（Task 1）
- Produces（IPC 契约，renderer 侧类型）：
  - `PROPOSAL_IMAGE_SETTINGS_GET: 'proposal-image:settings-get'` → `Promise<ImageApiConfig | null>`（返回时 apiKey 可脱敏为是否已配置，见 Step）
  - `PROPOSAL_IMAGE_SETTINGS_SET: 'proposal-image:settings-set'` → `(cfg: ImageApiConfig) => Promise<void>`
  - `PROPOSAL_IMAGE_GENERATE: 'proposal-image:generate'` → `(args: { sessionId: string; prompt: string }) => Promise<{ path: string }>`
  - `PROPOSAL_IMAGE_EDIT: 'proposal-image:edit'` → `(args: { sessionId: string; sourcePath: string; prompt: string }) => Promise<{ path: string }>`
  - `writeProposalImage(sessionId, origin, bytes, ext?): Promise<string>` —— 落盘到 `<root>/<sessionId>/assets/<gen|edit|upload>-<ts>.<ext>`，返回绝对路径

- [ ] **Step 1: 写 writer 落盘 helper 的失败测试**

```ts
// apps/desktop/src/main/services/proposalImageWriter.test.ts
import { describe, it, expect } from 'bun:test'
import { assetPathFor } from './proposalImageWriter'

describe('assetPathFor', () => {
  it('拼出 <root>/<sessionId>/assets/<gen|edit|upload>-<ts>.<ext>', () => {
    const p = assetPathFor('/root', 'sess-1', 'generated', 'png', 123)
    expect(p).toBe('/root/sess-1/assets/gen-123.png')
  })
  it('edited → edit- 前缀', () => {
    expect(assetPathFor('/root', 's', 'edited', 'png', 9)).toBe('/root/s/assets/edit-9.png')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/main/services/proposalImageWriter.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 写 writer 实现**

```ts
// apps/desktop/src/main/services/proposalImageWriter.ts
/**
 * 出图落盘 helper：把 service 产出的 Buffer 存进草稿资产目录，返回绝对路径。
 * 文件名前缀编码来源（Task 1 约定），路径可被 proposalasset:// 协议加载。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { proposalAssetFileName, type ProposalImageOrigin } from '../../shared/proposalAsset'

/** 纯拼路径（可测，不碰 fs）。 */
export function assetPathFor(
  root: string,
  sessionId: string,
  origin: ProposalImageOrigin,
  ext: string,
  ts: number
): string {
  return join(root, sessionId, 'assets', proposalAssetFileName(origin, ext, ts))
}

export async function writeProposalImage(
  sessionId: string,
  origin: ProposalImageOrigin,
  bytes: Buffer,
  ext = 'png'
): Promise<string> {
  const { proposalDraftsRoot } = await import('./proposalAssetProtocol')
  const ts = Date.now()
  const abs = assetPathFor(proposalDraftsRoot(), sessionId, origin, ext, ts)
  await mkdir(join(proposalDraftsRoot(), sessionId, 'assets'), { recursive: true })
  await writeFile(abs, bytes)
  return abs
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test src/main/services/proposalImageWriter.test.ts`
Expected: PASS

- [ ] **Step 5: 加 4 个通道常量**

在 `ipc-channels.ts` 的通道对象里追加：

```ts
  PROPOSAL_IMAGE_SETTINGS_GET: 'proposal-image:settings-get',
  PROPOSAL_IMAGE_SETTINGS_SET: 'proposal-image:settings-set',
  PROPOSAL_IMAGE_GENERATE: 'proposal-image:generate',
  PROPOSAL_IMAGE_EDIT: 'proposal-image:edit',
```

- [ ] **Step 6: 写 main handler**

在 `main/ipc/register.ts` 里，仿现有 proposal handler 的 `ipcMain.handle(...)` 范式追加：

```ts
import { getAppSettings, updateAppSettings } from '../core/appSettings'
import { generateImage, editImage } from '../services/imageGenService'
import { writeProposalImage } from '../services/proposalImageWriter'
import { readFile } from 'node:fs/promises'

ipcMain.handle(IpcChannels.PROPOSAL_IMAGE_SETTINGS_GET, () => {
  const cfg = getAppSettings().imageApi
  if (!cfg) return null
  // 不把明文 key 回渲染进程：只回 baseURL/model + 一个 hasKey 标记，UI 据此显示「已配置」。
  return { apiKey: cfg.apiKey ? '••••' : '', baseURL: cfg.baseURL, model: cfg.model }
})

ipcMain.handle(IpcChannels.PROPOSAL_IMAGE_SETTINGS_SET, (_e, cfg) => {
  updateAppSettings({ imageApi: cfg })
})

ipcMain.handle(IpcChannels.PROPOSAL_IMAGE_GENERATE, async (_e, args) => {
  const cfg = getAppSettings().imageApi
  if (!cfg?.apiKey) throw new Error('未配置出图 API，请到设置里填写 key 与地址')
  const bytes = await generateImage(cfg, { prompt: args.prompt })
  const path = await writeProposalImage(args.sessionId, 'generated', bytes)
  return { path }
})

ipcMain.handle(IpcChannels.PROPOSAL_IMAGE_EDIT, async (_e, args) => {
  const cfg = getAppSettings().imageApi
  if (!cfg?.apiKey) throw new Error('未配置出图 API，请到设置里填写 key 与地址')
  const sourceBytes = await readFile(args.sourcePath)
  const bytes = await editImage(cfg, {
    prompt: args.prompt,
    sourceBytes,
    sourceMime: 'image/png'
  })
  const path = await writeProposalImage(args.sessionId, 'edited', bytes)
  return { path }
})
```

> `PROPOSAL_IMAGE_SETTINGS_SET` 若前端只改 baseURL/model 不重填 key，需先合并现有 key（避免脱敏占位 `••••` 覆盖真 key）。在 handler 里：`const cur = getAppSettings().imageApi; const merged = { ...cur, ...cfg }; if (cfg.apiKey === '••••') merged.apiKey = cur?.apiKey ?? '';` 再 `updateAppSettings({ imageApi: merged })`。

- [ ] **Step 7: preload 暴露 + 类型**

`preload/index.ts` 的 `chatApi`（或对应 proposal 命名空间）里加四个方法，用 `ipcRenderer.invoke(IpcChannels.XXX, args)`；`preload/index.d.ts` 补对应签名（见 Interfaces 的返回类型）。

```ts
// preload/index.ts（并入现有暴露对象）
proposalImageSettingsGet: () => ipcRenderer.invoke(IpcChannels.PROPOSAL_IMAGE_SETTINGS_GET),
proposalImageSettingsSet: (cfg) => ipcRenderer.invoke(IpcChannels.PROPOSAL_IMAGE_SETTINGS_SET, cfg),
proposalImageGenerate: (args) => ipcRenderer.invoke(IpcChannels.PROPOSAL_IMAGE_GENERATE, args),
proposalImageEdit: (args) => ipcRenderer.invoke(IpcChannels.PROPOSAL_IMAGE_EDIT, args),
```

```ts
// preload/index.d.ts（并入 chatApi 接口）
proposalImageSettingsGet(): Promise<{ apiKey: string; baseURL: string; model: string } | null>
proposalImageSettingsSet(cfg: { apiKey: string; baseURL: string; model: string }): Promise<void>
proposalImageGenerate(args: { sessionId: string; prompt: string }): Promise<{ path: string }>
proposalImageEdit(args: { sessionId: string; sourcePath: string; prompt: string }): Promise<{ path: string }>
```

- [ ] **Step 8: typecheck（四处一致性由此把关）+ 提交**

Run: `cd apps/desktop && bun run typecheck`
Expected: 无错误（漏改任一处这里会红）

```bash
git add apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/preload/index.ts apps/desktop/src/preload/index.d.ts apps/desktop/src/main/ipc/register.ts apps/desktop/src/main/services/proposalImageWriter.ts apps/desktop/src/main/services/proposalImageWriter.test.ts
git commit -m "feat(proposal): 出图/改图/设置读写 IPC 全链路 + 落盘 helper"
```

---

### Task 8: 设置面板——出图 API 配置区（renderer）

让用户填 key/baseURL/model；未配置时后续入口据此置灰。

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/settings/SettingsView.tsx`

**Interfaces:**
- Consumes: `window.chatApi.proposalImageSettingsGet/Set`（Task 7）
- Produces: 无（纯 UI）。

- [ ] **Step 1: 加设置区**

在 `SettingsView.tsx` 找到分类列表（现有多为 `PlaceholderSection`），新增一个「出图 API」区块，含三个输入：API Key（password）、Base URL、默认模型（默认值 `gpt-image-2`）。挂载时 `proposalImageSettingsGet()` 回填，保存按钮调 `proposalImageSettingsSet({ apiKey, baseURL, model })`。key 回显为脱敏占位 `••••`，用户不改就沿用（handler 已处理合并）。

（照本文件现有输入组件与保存范式写，无需引入新库。）

- [ ] **Step 2: typecheck**

Run: `cd apps/desktop && bun run typecheck`
Expected: 无错误

- [ ] **Step 3: 手动走查 + 提交**

`bun run dev` → 打开设置 → 填 key/baseURL/model → 保存 → 重开设置确认 baseURL/model 回填、key 显脱敏。

```bash
git add apps/desktop/src/renderer/src/components/settings/SettingsView.tsx
git commit -m "feat(proposal): 设置面板新增出图 API 配置区"
```

---

### Task 9: 点图浮动工具栏 + 改图/换图/删除（renderer）

编辑态点选一张图，图旁弹 `[改图] [换图] [删除]`。改图弹指令输入框 → 调 edit IPC。

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx`
- Create: `apps/desktop/src/renderer/src/components/workspace/ProposalImageToolbar.tsx`
- Modify: `apps/desktop/src/renderer/src/stores/proposal.ts`（新增 imageReviews 态，见 Task 11 契约）

**Interfaces:**
- Consumes: `window.chatApi.proposalImageEdit`（Task 7）、当前 sessionId（从现有 session store 读，对齐 ProposalPaper 已有取 sessionId 的方式）、`toProposalAssetUrl`/`toKbAssetUrl`（解析源图 URL）
- Produces: 触发 `proposalImageEdit` 后把结果交给 Task 11 的审阅态（`addImageReview`）。

- [ ] **Step 1: 工具栏组件**

新建 `ProposalImageToolbar.tsx`：props `{ imageSrc, blockRef, onEdit, onReplace, onDelete }`，绝对定位在图右上角，三个按钮。样式沿用 `proposalIcons.tsx` 的内联 SVG + 现有卡片按钮类（**不要**直接套 `text-apple-*` 预设，见 [[proposal-ui-icons-typescale]]）。

- [ ] **Step 2: ProposalPaper 挂载点图交互**

编辑态给逐块渲染的 `<img>` 加点击命中：点中某图 → 记录该图 markdown 里的**绝对路径**（源图 path）+ 所在块索引 → 显示工具栏。
- **改图**：弹小输入框（复用 SelectionAiBubble 的输入框范式）填指令 → `const { path } = await window.chatApi.proposalImageEdit({ sessionId, sourcePath, prompt })` → 交 Task 11 审阅（原图 sourcePath vs 新图 path）。
- **换图**：触发 Task 10 的「上传/从知识库选」。
- **删除**：从该块 markdown 删掉这段 `![...](...)` → `updateSection`。

> 源图路径：markdown 存的就是绝对路径，直接拿来当 `sourcePath` 传给 IPC（main 侧 `readFile` 读盘）。KB 图（只读）也能读，产出图在草稿区也能读，无需额外拷贝——edit 的产物一律以 `edit-` 前缀落到草稿区，不写回 KB。

- [ ] **Step 3: typecheck**

Run: `cd apps/desktop && bun run typecheck`
Expected: 无错误

- [ ] **Step 4: 手动走查 + 提交**

`bun run dev` → 进方案编辑态 → 点一张图 → 出工具栏 → 点删除生效；点改图弹输入框（落地在 Task 11 后整体验）。

```bash
git add apps/desktop/src/renderer/src/components/workspace/ProposalImageToolbar.tsx apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx apps/desktop/src/renderer/src/stores/proposal.ts
git commit -m "feat(proposal): 点图浮动工具栏（改图/换图/删除）"
```

---

### Task 10: 文字指令生图 + 上传本地图（renderer）

两个新增入口：对话/选区里「在这里生成一张 X 图」；拖或选本地图插入。

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx`（上传入口 + 生图插入）
- Modify: `apps/desktop/src/renderer/src/components/workspace/SelectionAiBubble.tsx`（选区气泡加「生成图片」动作，可选）
- Create: `apps/desktop/src/main/services/proposalImageWriter.ts` 已有 `writeProposalImage`；上传走它（origin='uploaded'）——需新增一条上传 IPC 或复用文件读取。

**Interfaces:**
- Consumes: `window.chatApi.proposalImageGenerate`（Task 7）、`writeProposalImage(sessionId,'uploaded',bytes)`
- Produces: 插入 `![alt](绝对路径)` 到目标块。

- [ ] **Step 1: 上传 IPC（改四处）**

加通道 `PROPOSAL_IMAGE_UPLOAD: 'proposal-image:upload'` → handler：用 `dialog.showOpenDialog` 选 png/jpg → `readFile` → `writeProposalImage(sessionId,'uploaded',bytes,ext)` → 返回 `{ path }`。preload + d.ts 同步（签名 `(args:{sessionId:string}) => Promise<{path:string}|null>`，取消返回 null）。

- [ ] **Step 2: 生图入口**

在 ProposalPaper 编辑态提供「生成图片」触发（按钮或选区气泡动作）：弹输入框填描述 → `const { path } = await window.chatApi.proposalImageGenerate({ sessionId, prompt })` → 交 Task 11 审阅（无原图，仅新图 + 「插入到此处」）。

- [ ] **Step 3: 上传入口**

「换图/插图」里提供上传：调 `proposalImageUpload({ sessionId })` → 拿 path → 直接插入 `![上传图](path)` 到当前块（上传图不需审阅，用户已选定；如需改再走改图）。

- [ ] **Step 4: typecheck + 手动走查 + 提交**

Run: `cd apps/desktop && bun run typecheck`
`bun run dev` → 上传本地图能插入并显示（proposalasset 协议加载）；生图弹输入框（落地在 Task 11 验）。

```bash
git add apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/preload/index.ts apps/desktop/src/preload/index.d.ts apps/desktop/src/main/ipc/register.ts apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx apps/desktop/src/renderer/src/components/workspace/SelectionAiBubble.tsx
git commit -m "feat(proposal): 文字指令生图 + 上传本地图入口"
```

---

### Task 11: ProposalImageReview 先审后落地（renderer）

改图/生图产物先给「原图 vs 新图」对照卡，点应用才写进 markdown。复用现有「对话内审阅」模式（对照 `ProposalRevisionReview` 在 ThreadView.tsx 的挂法）。

**Files:**
- Modify: `apps/desktop/src/renderer/src/stores/proposal.ts`（imageReviews 态 + 增删）
- Create: `apps/desktop/src/renderer/src/components/workspace/ProposalImageReview.tsx`
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx`（渲染审阅卡 + 应用逻辑）

**Interfaces:**
- Consumes: Task 9/10 产出的 `{ sourcePath?: string; resultPath: string; sectionId: string; blockIndex: number; mode: 'edit' | 'generate' }`
- Produces（proposal store 新增）：
  - `interface ImageReview { id: string; sectionId: string; blockIndex: number; sourcePath?: string; resultPath: string; mode: 'edit' | 'generate' }`
  - `imageReviews: ImageReview[]`
  - `addImageReview(r: Omit<ImageReview,'id'>): string`（返回 id）
  - `removeImageReview(id: string): void`
  - 各重置点（新建/清空草稿）清空 `imageReviews`

- [ ] **Step 1: proposal store 加审阅态（先于 Task 9/10 落地）**

在 `stores/proposal.ts` 仿现有 `blockReviews`/`addBlockReview`/`removeBlockReview` 加 `imageReviews` 三件套 + 各 reset 点清空（见 [[proposal-block-edit-selection-ai]] 的 blockReviews 范式）。**这一步须在 Task 9/10 调用 `addImageReview` 之前完成**——若按 9→10→11 顺序执行，把本步的 store 改动提前到 Task 9 首次用到时写入。

- [ ] **Step 2: 审阅卡组件**

`ProposalImageReview.tsx`：props `{ review, onApply, onDiscard, onRetry }`。
- `mode==='edit'`：左右并排 `<img src={原图}>` vs `<img src={新图}>`（src 经 `toProposalAssetUrl`/`toKbAssetUrl` 解析）。
- `mode==='generate'`：只显新图 + 「插入到此处」。
- 底栏 `[应用] [放弃] [重改]`（重改=展开输入框重发同 IPC）。样式对齐 SelectionAiBubble 卡片式。

- [ ] **Step 3: ProposalPaper 渲染卡 + 应用**

在编辑区渲染当前 `imageReviews`。
- **应用（edit）**：把该块 markdown 里源图路径替换成新图路径 → `spliceBlocks`/`updateSection` → `removeImageReview`。
- **应用（generate）**：在目标块插入 `![生成图](新图路径)` → `updateSection` → `removeImageReview`。
- **放弃**：`removeImageReview`（新图文件可留在草稿区，随草稿删除时清理；不做即时删盘，避免误删已被复用的图）。

- [ ] **Step 4: 加载/失败态**

改图/生图 IPC 期间：触发按钮进 loading（spinner + 禁用），失败弹可见错误 + 「重试」，区分「未配置 key」（提示去设置）与「网关 5xx」（提示稍后重试）。不阻塞编辑器其余操作。

- [ ] **Step 5: typecheck + 端到端手动走查 + 提交**

Run: `cd apps/desktop && bun run typecheck`

端到端走查（需在设置里填好可用的 key/baseURL）：
1. 点已插入的图 → 改图 → 填「换成白色背景」→ loading → 出对照卡 → 应用 → 图替换、预览/导出都显新图。
2. 生图 → 填描述 → 出新图卡 → 插入到此处。
3. 上传本地图 → 插入显示 → 对它改图。
4. 断网/填错 key → 出可区分的错误 + 重试。
5. 导出 docx → 产出图真嵌入（打开 Word 看得到）。

```bash
git add apps/desktop/src/renderer/src/stores/proposal.ts apps/desktop/src/renderer/src/components/workspace/ProposalImageReview.tsx apps/desktop/src/renderer/src/components/workspace/ProposalPaper.tsx
git commit -m "feat(proposal): ProposalImageReview 改图/生图先审后落地"
```

---

### Task 12: docx 导出产出图冒烟测试（守回归）

验证「产出图绝对路径 → docx 真嵌入」（架构上零改动，但补测防未来回归）。

**Files:**
- Modify: `apps/desktop/src/main/core/proposalDocx.test.ts`（新增用例）

**Interfaces:**
- Consumes: 现有 `markdownToDocxBuffer`（或该文件测试已用的导出入口）

- [ ] **Step 1: 写用例**

沿用文件里既有的「嵌图 buffer 比去图版大 200+ 字节」判据（见 [[proposal-tables-images-enhancement]]），用一张放在临时 proposal-drafts 路径下的真 PNG（bun test 里写一个最小 PNG 到 tmp），断言含图导出 buffer 明显大于同文去图版。

```ts
it('产出图（proposal-drafts 绝对路径）真嵌入 docx', async () => {
  // 写一张最小 PNG 到 tmp（构造 8x8 纯色 png bytes，或复用文件内已有的 fixture helper）
  // md1 = 含 ![](<tmpPngAbs>)；md0 = 同文去掉图片行
  const withImg = await markdownToDocxBuffer(md1 /* + 现有测试所需其余入参 */)
  const without = await markdownToDocxBuffer(md0 /* 同上 */)
  expect(withImg.byteLength - without.byteLength).toBeGreaterThan(200)
})
```

> 入参与 fixture 构造照 `proposalDocx.test.ts` 现有嵌图用例复制（它已有一份 KB 图嵌入测试可仿）。

- [ ] **Step 2: 跑测试 + 提交**

Run: `cd apps/desktop && bun test src/main/core/proposalDocx.test.ts`
Expected: PASS

```bash
git add apps/desktop/src/main/core/proposalDocx.test.ts
git commit -m "test(proposal): docx 导出产出图真嵌入冒烟（守零改动回归）"
```

---

## 最终验收

- [ ] `cd apps/desktop && bun test src/` 全绿
- [ ] `cd apps/desktop && bun run typecheck` 无错误
- [ ] Task 11 Step 5 的 5 项端到端手动走查全过（需填好可用出图凭据）
- [ ] 未配置 key 时三入口给明确提示、不崩

## 与 spec 的偏离记录

- spec 说 markdown 存 `proposalasset://<draftId>/file.png` 且 docx 需改：**改为存绝对路径**（与 KB 图一致），docx `imageParagraphs` 已直读绝对路径，故**零改动**，Task 12 仅补冒烟测试守回归。
- spec 的图片 `origin` 字段：**改为从路径 + 文件名前缀推导**（Task 1），不引入 markdown/schema 变更。
- 遮罩局部编辑、中文→英文提示词翻译：按 spec 明确不做。
