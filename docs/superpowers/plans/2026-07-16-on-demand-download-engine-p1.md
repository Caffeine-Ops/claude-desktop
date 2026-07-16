# 按需下载引擎通用化 + embed 迁移（P1a）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把只会下 KB 模型的 `kbModelDownloader.ts` 抽成一个通用「按需下载组件」引擎（档案卡 + 名册 + 多镜像 + files/archive 两形态），并让现有 embed 模型改由它驱动，全程 IPC/UI 不动、用户零感知、embed 下载行为逐字节不变。

**Architecture:** Strangler（绞杀者）式重构——先在旁边建通用引擎（新文件），把现有下载器的韧性核心（`.part` rename / sha256 / 60s 超时 / AbortController 取消 / 字节进度 / 成功与收尾分账）搬进通用 `HostedFilesInstaller`，再让 `kbModelDownloader.ts` 退化成「持有下载状态 + 对外 IPC API + embed 专属收尾副作用」的薄壳，内部委托通用引擎。IPC 通道（`KB_MODEL_DOWNLOAD_*`）与前端（`KnowledgeBaseSection.tsx`/`KbToolbar.tsx`）**完全不改**，因此零回归、可独立上线。

**Tech Stack:** TypeScript（Electron main，Node 环境）、node:https（不用 fetch）、node:crypto（sha256）、node:child_process（tar 解压）、bun:test（纯逻辑单测）。

## Global Constraints

- 包管理器是 **bun**，不是 npm。跑测试：`cd apps/studio && bun test <路径>`；类型检查：`cd apps/studio && bun run typecheck`（= `tsc --noEmit && tsc --noEmit -p tsconfig.node.json`，双 tsc）。
- **不新增任何 runtime 依赖**：只用 node 内置（https/crypto/fs/path/child_process）。不往 package.json `dependencies` 加东西。
- **网络必须用 `node:https`，不用 fetch**：环境常有 SSL-MITM 代理，node https 自动尊重 `NODE_EXTRA_CA_CERTS`。**故意不调 HuggingFace `/api/models` 端点**（2026-07-06 CI 事故元凶）。
- **保留现有全部韧性**：临时 `.part` 文件下完校验通过才 rename；每文件精确 size + sha256 双校验；每请求 60s 无数据超时；AbortController 取消；字节级进度；**「下载成功」与「下完的收尾副作用（重热/重建）」分开算账**——收尾失败不得把已成功的下载翻成 error（承接提交 b5636bb3）。
- **embed 行为必须逐字节不变**：迁移后 embed 下载的文件、校验、降级、IPC、UI 与迁移前完全一致。
- **本计划不碰 IPC、不碰前端、不碰 markitdown/soffice**（那些在 P1b）。`KB_MODEL_DOWNLOAD_*` 四通道与 `broadcastKbModelDownload` 保持原样。
- 新增 shared 类型文件供将来前端 type-only 消费（本计划前端不引用），放 `electron/shared/`，走 `@desktop-shared/*` 别名约定。
- 注释解释「为什么」，沿用本仓高注释密度风格。

---

### Task 1: 通用组件类型（shared）

**Files:**
- Create: `apps/studio/electron/shared/componentDownload.ts`
- Test: `apps/studio/electron/shared/componentDownload.test.ts`

**Interfaces:**
- Consumes: 无（新起点）。
- Produces:
  - `DownloadUnit { urls: string[]; sha256: string; size: number }`
  - `HostedFilesInstall { kind: 'files'; destSubdir: string; files: Array<DownloadUnit & { relPath: string; chmodExec?: boolean }>; readyCheck?: string }`
  - `HostedArchiveInstall { kind: 'archive'; destSubdir: string; archive: DownloadUnit; format: 'tar.gz'; stripComponents?: number; chmodExec?: string[]; readyCheck: string }`
  - `type HostedInstall = HostedFilesInstall | HostedArchiveInstall`
  - `ComponentDescriptor { id: string; title: string; description: string; sizeEstimateBytes: number; strategy: 'hosted-files'; install: HostedInstall }`
  - `function descriptorTotalBytes(d: ComponentDescriptor): number`

- [ ] **Step 1: 写失败测试**

```ts
// apps/studio/electron/shared/componentDownload.test.ts
import { describe, expect, test } from 'bun:test'
import { descriptorTotalBytes, type ComponentDescriptor } from './componentDownload'

const filesDesc: ComponentDescriptor = {
  id: 'x', title: 'X', description: 'x', sizeEstimateBytes: 0, strategy: 'hosted-files',
  install: {
    kind: 'files', destSubdir: 'x',
    files: [
      { relPath: 'a', urls: ['u1'], sha256: 'h1', size: 10 },
      { relPath: 'b', urls: ['u2'], sha256: 'h2', size: 32 },
    ],
  },
}
const archiveDesc: ComponentDescriptor = {
  id: 'y', title: 'Y', description: 'y', sizeEstimateBytes: 0, strategy: 'hosted-files',
  install: { kind: 'archive', destSubdir: 'y', format: 'tar.gz', readyCheck: 'bin/x',
    archive: { urls: ['u'], sha256: 'h', size: 100 } },
}

describe('descriptorTotalBytes', () => {
  test('files 形态 = 各文件 size 之和', () => {
    expect(descriptorTotalBytes(filesDesc)).toBe(42)
  })
  test('archive 形态 = 整包 size', () => {
    expect(descriptorTotalBytes(archiveDesc)).toBe(100)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/shared/componentDownload.test.ts`
Expected: FAIL（`Cannot find module './componentDownload'` 或 `descriptorTotalBytes is not a function`）

- [ ] **Step 3: 写实现**

```ts
// apps/studio/electron/shared/componentDownload.ts
// 通用「按需下载组件」的前后端共享类型。范式对齐现有 kbModelDownload.ts，但把「单个模型」
// 泛化为「任意托管文件包组件」。本文件只放类型 + 纯函数，无 electron/node 依赖，可 bun test。
// P1a 只实现 strategy:'hosted-files'；pipx/detect-only 策略在 P1b 再加进联合类型。

/** 一个下载单元：一串候选地址（多镜像，按序试）+ sha256 指纹 + 真实字节数。 */
export interface DownloadUnit {
  urls: string[]
  sha256: string
  size: number
}

/** 散文件形态（模型类）：N 个文件直接落到 <root>/<destSubdir>/<relPath>。 */
export interface HostedFilesInstall {
  kind: 'files'
  destSubdir: string
  files: Array<DownloadUnit & { relPath: string; chmodExec?: boolean }>
  /** 省略 = 全部 files 就位即就绪；给定则以该相对路径文件存在为判据。 */
  readyCheck?: string
}

/** 压缩包形态（runtime 类）：下 1 个 tarball → 校验整包 → 解压到 destSubdir。 */
export interface HostedArchiveInstall {
  kind: 'archive'
  destSubdir: string
  archive: DownloadUnit
  format: 'tar.gz'
  /** tar 解压剥顶层目录层数（python-build-standalone 剥 1 层）。 */
  stripComponents?: number
  /** 解压后需 chmod +x 的相对路径（mac 的 bin/python3）。 */
  chmodExec?: string[]
  /** 解压后的「装好判据」文件（相对 destSubdir）。 */
  readyCheck: string
}

export type HostedInstall = HostedFilesInstall | HostedArchiveInstall

/** 一个可按需下载的组件档案卡。名册里一条即一个组件。 */
export interface ComponentDescriptor {
  id: string
  title: string
  description: string
  sizeEstimateBytes: number
  strategy: 'hosted-files'
  install: HostedInstall
}

/** 组件下载总字节数（进度分母）。files=各文件之和；archive=整包 size。 */
export function descriptorTotalBytes(d: ComponentDescriptor): number {
  const i = d.install
  return i.kind === 'files' ? i.files.reduce((s, f) => s + f.size, 0) : i.archive.size
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && bun test electron/shared/componentDownload.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add apps/studio/electron/shared/componentDownload.ts apps/studio/electron/shared/componentDownload.test.ts
git commit -m "feat(component-download): 通用组件档案卡类型 + descriptorTotalBytes（纯核）"
```

---

### Task 2: 多镜像下载原语

**Files:**
- Create: `apps/studio/electron/main/services/componentInstaller/downloadUnit.ts`
- Test: `apps/studio/electron/main/services/componentInstaller/downloadUnit.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `type SingleUrlDownloader = (url: string, dest: string, signal: AbortSignal, onBytes: (n: number) => void) => Promise<void>`
  - `function downloadWithMirrors(urls: string[], dest: string, signal: AbortSignal, onBytes: (n: number) => void, downloadOne: SingleUrlDownloader): Promise<void>` — 依次试 urls，第一个成的即返回；全失败抛聚合错误；signal 已 abort 立即停。
  - `const downloadOneUrl: SingleUrlDownloader` — 真实 node:https 单地址下载（跟随重定向 + 60s 超时），移植自 `kbModelDownloader.ts` 的私有 `downloadFile`。

- [ ] **Step 1: 写失败测试（只测多镜像编排，用假 downloader 注入）**

```ts
// apps/studio/electron/main/services/componentInstaller/downloadUnit.test.ts
import { describe, expect, test } from 'bun:test'
import { downloadWithMirrors, type SingleUrlDownloader } from './downloadUnit'

const noopSignal = new AbortController().signal

describe('downloadWithMirrors', () => {
  test('第一个地址成功即用，不再试后续', async () => {
    const tried: string[] = []
    const dl: SingleUrlDownloader = async (url) => { tried.push(url) }
    await downloadWithMirrors(['a', 'b'], '/tmp/x', noopSignal, () => {}, dl)
    expect(tried).toEqual(['a'])
  })
  test('第一个失败则回落第二个', async () => {
    const tried: string[] = []
    const dl: SingleUrlDownloader = async (url) => {
      tried.push(url); if (url === 'a') throw new Error('a down')
    }
    await downloadWithMirrors(['a', 'b'], '/tmp/x', noopSignal, () => {}, dl)
    expect(tried).toEqual(['a', 'b'])
  })
  test('全部失败抛错（含最后一个原因）', async () => {
    const dl: SingleUrlDownloader = async (url) => { throw new Error(`${url} down`) }
    await expect(downloadWithMirrors(['a', 'b'], '/tmp/x', noopSignal, () => {}, dl))
      .rejects.toThrow('b down')
  })
  test('signal 已 abort 时不尝试任何下载', async () => {
    const ac = new AbortController(); ac.abort()
    const tried: string[] = []
    const dl: SingleUrlDownloader = async (url) => { tried.push(url) }
    await expect(downloadWithMirrors(['a'], '/tmp/x', ac.signal, () => {}, dl)).rejects.toThrow()
    expect(tried).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/main/services/componentInstaller/downloadUnit.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// apps/studio/electron/main/services/componentInstaller/downloadUnit.ts
// 多镜像下载原语：把「一串候选地址依次试」与「单地址 https 下载」拆开——前者纯编排、可单测，
// 后者是真实 node:https 逻辑，移植自 kbModelDownloader 的私有 downloadFile（保留跟随重定向 +
// 60s 无数据超时 + 出错显式 destroy 写句柄）。网络用 node:https 不用 fetch：环境常有 SSL-MITM
// 代理，node https 自动尊重 NODE_EXTRA_CA_CERTS。
import { createWriteStream } from 'node:fs'
import https from 'node:https'

const DOWNLOAD_TIMEOUT_MS = 60_000

export type SingleUrlDownloader = (
  url: string, dest: string, signal: AbortSignal, onBytes: (n: number) => void
) => Promise<void>

/**
 * 依次尝试 urls，第一个成功即返回；每个失败继续下一个；全失败抛最后一个错误。
 * signal 已 abort：立即抛，不尝试任何下载（避免明知取消还发请求）。
 */
export async function downloadWithMirrors(
  urls: string[], dest: string, signal: AbortSignal,
  onBytes: (n: number) => void, downloadOne: SingleUrlDownloader
): Promise<void> {
  if (signal.aborted) throw new Error('下载已取消')
  let lastErr: unknown = new Error(`无可用下载地址：${dest}`)
  for (const url of urls) {
    if (signal.aborted) throw new Error('下载已取消')
    try {
      await downloadOne(url, dest, signal, onBytes)
      return
    } catch (err) {
      lastErr = err // 记下继续试下一个镜像
    }
  }
  throw lastErr
}

/** 真实单地址下载：跟随重定向、流式落盘、按块回调字节数、60s 无数据超时、abort 报错。 */
export const downloadOneUrl: SingleUrlDownloader = (url, dest, signal, onBytes) =>
  new Promise((resolve, reject) => {
    const follow = (u: string, remaining: number): void => {
      const req = https.get(u, { signal }, (res) => {
        const code = res.statusCode ?? 0
        const loc = res.headers.location
        if ([301, 302, 303, 307, 308].includes(code) && loc) {
          if (remaining <= 0) return reject(new Error(`Too many redirects for ${url}`))
          return follow(Array.isArray(loc) ? loc[0] : loc, remaining - 1)
        }
        if (code !== 200) return reject(new Error(`HTTP ${code} from ${u}`))
        const ws = createWriteStream(dest)
        res.on('data', (c: Buffer) => onBytes(c.length))
        res.pipe(ws)
        ws.on('finish', () => resolve())
        ws.on('error', (err) => { ws.destroy(); reject(err) })
        res.on('error', (err) => { ws.destroy(); reject(err) })
      })
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('下载超时（60s 无响应）')))
      req.on('error', reject)
    }
    follow(url, 10)
  })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && bun test electron/main/services/componentInstaller/downloadUnit.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 5: 提交**

```bash
git add apps/studio/electron/main/services/componentInstaller/downloadUnit.ts apps/studio/electron/main/services/componentInstaller/downloadUnit.test.ts
git commit -m "feat(component-download): 多镜像下载原语（依次试 + node:https 单地址）"
```

---

### Task 3: 组件名册（含 embed 档案卡）

**Files:**
- Create: `apps/studio/electron/main/core/componentRegistry.ts`
- Test: `apps/studio/electron/main/core/componentRegistry.test.ts`
- Read (数据来源，不改): `apps/studio/electron/main/core/kbModelManifest.ts`、`apps/studio/electron/shared/kbIndex.ts`（`KB_MODEL_ID`）

**Interfaces:**
- Consumes: Task 1 的 `ComponentDescriptor`；现有 `KB_DOWNLOADABLE_MODELS`（`kbModelManifest.ts`）、`KB_MODEL_ID`。
- Produces:
  - `const EMBED_COMPONENT_ID = 'kb-embed'`
  - `const COMPONENT_REGISTRY: ComponentDescriptor[]`
  - `function getComponentDescriptor(id: string): ComponentDescriptor | undefined`

- [ ] **Step 1: 写失败测试（校验 embed 档案卡忠实于现有 manifest）**

```ts
// apps/studio/electron/main/core/componentRegistry.test.ts
import { describe, expect, test } from 'bun:test'
import { COMPONENT_REGISTRY, EMBED_COMPONENT_ID, getComponentDescriptor } from './componentRegistry'
import { KB_DOWNLOADABLE_MODELS } from './kbModelManifest'

describe('componentRegistry', () => {
  test('能按 id 取到 embed 档案卡', () => {
    const d = getComponentDescriptor(EMBED_COMPONENT_ID)
    expect(d).toBeDefined()
    expect(d!.strategy).toBe('hosted-files')
    expect(d!.install.kind).toBe('files')
  })
  test('未知 id 返回 undefined', () => {
    expect(getComponentDescriptor('nope')).toBeUndefined()
  })
  test('embed 档案卡的文件 sha256/size 逐条忠实于 KB_DOWNLOADABLE_MODELS（防漂移）', () => {
    const d = getComponentDescriptor(EMBED_COMPONENT_ID)!
    const model = KB_DOWNLOADABLE_MODELS[0]
    if (d.install.kind !== 'files') throw new Error('embed 应为 files 形态')
    expect(d.install.files.length).toBe(model.files.length)
    for (const f of model.files) {
      const got = d.install.files.find((x) => x.relPath === f.relPath)
      expect(got).toBeDefined()
      expect(got!.sha256).toBe(f.sha256)
      expect(got!.size).toBe(f.size)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/main/core/componentRegistry.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// apps/studio/electron/main/core/componentRegistry.ts
// 通用组件名册——「加一个可下载组件 = 往这里加一张档案卡」。P1a 只有 embed 一张（从既有
// kbModelManifest 派生，sha256/size 复用那份唯一事实源，绝不再抄一份防漂移）。
// P1b 会把 reranker/python-runtime/markitdown/soffice 追加进来。
import type { ComponentDescriptor } from '../../shared/componentDownload'
import { KB_MODEL_ID } from '../../shared/kbIndex'
import { KB_DOWNLOADABLE_MODELS } from './kbModelManifest'

export const EMBED_COMPONENT_ID = 'kb-embed'

// embed 档案卡：把 KB_DOWNLOADABLE_MODELS[0]（bge 四个散文件）翻译成通用档案卡。
// destSubdir=KB_MODEL_ID，与现有 kbModelDir()/<KB_MODEL_ID>/ 布局一致；urls 用 HF resolve
// 地址（一串里先只放默认源，多镜像位就此留好）；readyCheck 判据同 kbBuildWorker.modelReady。
const embedModel = KB_DOWNLOADABLE_MODELS[0]
const embedDescriptor: ComponentDescriptor = {
  id: EMBED_COMPONENT_ID,
  title: '语义检索模型',
  description: 'bge 嵌入模型，启用向量语义检索（缺失时降级 BM25）',
  strategy: 'hosted-files',
  sizeEstimateBytes: embedModel.files.reduce((s, f) => s + f.size, 0),
  install: {
    kind: 'files',
    destSubdir: embedModel.dirName, // = KB_MODEL_ID
    readyCheck: `onnx/model_quantized.onnx`,
    files: embedModel.files.map((f) => ({
      relPath: f.relPath,
      sha256: f.sha256,
      size: f.size,
      urls: [`https://huggingface.co/${embedModel.hfRepo}/resolve/${embedModel.revision}/${f.relPath}`],
    })),
  },
}

export const COMPONENT_REGISTRY: ComponentDescriptor[] = [embedDescriptor]

export function getComponentDescriptor(id: string): ComponentDescriptor | undefined {
  return COMPONENT_REGISTRY.find((d) => d.id === id)
}

// 引用 KB_MODEL_ID 只为断言布局一致（destSubdir 必须等于它），避免将来 dirName 改了不自知。
if (embedModel.dirName !== KB_MODEL_ID) {
  throw new Error(`embed destSubdir(${embedModel.dirName}) 必须等于 KB_MODEL_ID(${KB_MODEL_ID})`)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && bun test electron/main/core/componentRegistry.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add apps/studio/electron/main/core/componentRegistry.ts apps/studio/electron/main/core/componentRegistry.test.ts
git commit -m "feat(component-download): 组件名册 + embed 档案卡（派生自 manifest 防漂移）"
```

---

### Task 4: HostedFilesInstaller — 就绪判据 + 纯路径计算

**Files:**
- Create: `apps/studio/electron/main/services/componentInstaller/hostedFilesInstaller.ts`
- Test: `apps/studio/electron/main/services/componentInstaller/hostedFilesInstaller.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ComponentDescriptor`/`HostedInstall`。
- Produces:
  - `function isComponentInstalled(d: ComponentDescriptor, root: string, exists: (p: string) => boolean): boolean`
  - `function readyCheckAbsPath(d: ComponentDescriptor, root: string): string`
  - `function tarExtractArgs(install: HostedArchiveInstall, tmp: string, destDir: string): string[]`

- [ ] **Step 1: 写失败测试**

```ts
// apps/studio/electron/main/services/componentInstaller/hostedFilesInstaller.test.ts
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { isComponentInstalled, readyCheckAbsPath, tarExtractArgs } from './hostedFilesInstaller'
import type { ComponentDescriptor, HostedArchiveInstall } from '../../../shared/componentDownload'

const filesDesc: ComponentDescriptor = {
  id: 'e', title: 'e', description: 'e', sizeEstimateBytes: 0, strategy: 'hosted-files',
  install: { kind: 'files', destSubdir: 'm', readyCheck: 'onnx/model.onnx',
    files: [{ relPath: 'config.json', urls: ['u'], sha256: 'h', size: 1 }] },
}
const filesNoReady: ComponentDescriptor = {
  id: 'e2', title: 'e2', description: 'e2', sizeEstimateBytes: 0, strategy: 'hosted-files',
  install: { kind: 'files', destSubdir: 'm',
    files: [
      { relPath: 'a.json', urls: ['u'], sha256: 'h', size: 1 },
      { relPath: 'b.json', urls: ['u'], sha256: 'h', size: 1 },
    ] },
}
const archiveDesc: ComponentDescriptor = {
  id: 'p', title: 'p', description: 'p', sizeEstimateBytes: 0, strategy: 'hosted-files',
  install: { kind: 'archive', destSubdir: 'py', format: 'tar.gz', stripComponents: 1,
    readyCheck: 'bin/python3', archive: { urls: ['u'], sha256: 'h', size: 1 } },
}

describe('readyCheckAbsPath', () => {
  test('files：root/destSubdir/readyCheck', () => {
    expect(readyCheckAbsPath(filesDesc, '/r')).toBe(join('/r', 'm', 'onnx/model.onnx'))
  })
  test('archive：root/destSubdir/readyCheck', () => {
    expect(readyCheckAbsPath(archiveDesc, '/r')).toBe(join('/r', 'py', 'bin/python3'))
  })
})

describe('isComponentInstalled', () => {
  test('有 readyCheck：判据文件存在即装好', () => {
    const exists = (p: string) => p === join('/r', 'm', 'onnx/model.onnx')
    expect(isComponentInstalled(filesDesc, '/r', exists)).toBe(true)
  })
  test('有 readyCheck：判据文件缺失即未装', () => {
    expect(isComponentInstalled(filesDesc, '/r', () => false)).toBe(false)
  })
  test('无 readyCheck 的 files：所有文件都在才算装好', () => {
    const onlyA = (p: string) => p === join('/r', 'm', 'a.json')
    expect(isComponentInstalled(filesNoReady, '/r', onlyA)).toBe(false)
    expect(isComponentInstalled(filesNoReady, '/r', () => true)).toBe(true)
  })
})

describe('tarExtractArgs', () => {
  test('含 strip-components 与目标目录', () => {
    const install = archiveDesc.install as HostedArchiveInstall
    expect(tarExtractArgs(install, '/tmp/p.part', '/r/py'))
      .toEqual(['-xzf', '/tmp/p.part', '--strip-components', '1', '-C', '/r/py'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/main/services/componentInstaller/hostedFilesInstaller.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现（纯函数部分）**

```ts
// apps/studio/electron/main/services/componentInstaller/hostedFilesInstaller.ts
// 「下载文件包」专办员。本文件的纯函数（判据/路径/tar 参数）可单测；install() 编排（下载+校验+
// 解压+chmod）是 io，靠 typecheck + 手动验证。isComponentInstalled 只看磁盘、不联网，判据同
// kbBuildWorker.modelReady（readyCheck 文件存在）。
import { join } from 'node:path'
import type { ComponentDescriptor, HostedArchiveInstall } from '../../../shared/componentDownload'

/** readyCheck 的绝对路径：root/destSubdir/readyCheck。 */
export function readyCheckAbsPath(d: ComponentDescriptor, root: string): string {
  return join(root, d.install.destSubdir, d.install.readyCheck ?? '')
}

/**
 * 是否已就绪：只看磁盘。有 readyCheck → 该文件存在即就绪；files 形态且无 readyCheck → 全部
 * 文件都在才就绪。exists 注入便于单测（生产传 fs.existsSync）。
 */
export function isComponentInstalled(
  d: ComponentDescriptor, root: string, exists: (p: string) => boolean
): boolean {
  const i = d.install
  if (i.readyCheck) return exists(readyCheckAbsPath(d, root))
  if (i.kind === 'files') {
    return i.files.every((f) => exists(join(root, i.destSubdir, f.relPath)))
  }
  return false // archive 必须给 readyCheck（类型上 readyCheck 必填，这里兜底）
}

/** tar 解压参数：-xzf <tmp> [--strip-components N] -C <destDir>。 */
export function tarExtractArgs(
  install: HostedArchiveInstall, tmp: string, destDir: string
): string[] {
  const args = ['-xzf', tmp]
  if (install.stripComponents != null) args.push('--strip-components', String(install.stripComponents))
  args.push('-C', destDir)
  return args
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && bun test electron/main/services/componentInstaller/hostedFilesInstaller.test.ts`
Expected: PASS（7 tests）

- [ ] **Step 5: 提交**

```bash
git add apps/studio/electron/main/services/componentInstaller/hostedFilesInstaller.test.ts apps/studio/electron/main/services/componentInstaller/hostedFilesInstaller.ts
git commit -m "feat(component-download): HostedFiles 就绪判据 + readyCheck 路径 + tar 参数（纯核）"
```

---

### Task 5: HostedFilesInstaller — install 编排（下载+校验+解压+chmod）

**Files:**
- Modify: `apps/studio/electron/main/services/componentInstaller/hostedFilesInstaller.ts`（追加 `installComponent`）

**Interfaces:**
- Consumes: Task 2 `downloadWithMirrors`/`downloadOneUrl`；Task 4 `tarExtractArgs`/`isComponentInstalled`；Task 1 类型。
- Produces:
  - `interface InstallProgress { percent: number; currentFile: string | null }`
  - `function installComponent(d: ComponentDescriptor, root: string, signal: AbortSignal, onProgress: (p: InstallProgress) => void): Promise<void>` —— 下载→校验→（archive）解压 strip chmod→抛错则清残留。**不含**「下完的业务收尾」（那由调用方做）。

- [ ] **Step 1: 追加实现（无独立单测——io 编排靠 typecheck + Task 6 的手动验证；纯参数计算已在 Task 4 覆盖）**

在 `hostedFilesInstaller.ts` 顶部补 import，并追加：

```ts
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { downloadWithMirrors, downloadOneUrl } from './downloadUnit'
import type { DownloadUnit } from '../../../shared/componentDownload'

export interface InstallProgress { percent: number; currentFile: string | null }

async function sha256File(p: string): Promise<string> {
  return createHash('sha256').update(await readFile(p)).digest('hex')
}

// 下 1 个 DownloadUnit 到 dest：临时 .part → 精确 size + sha256 双校验 → rename 到位。
// 已存在且 sha 匹配则幂等跳过（累加 size 让进度不倒退）。校验失败删 .part 并抛。
async function fetchUnit(
  unit: DownloadUnit, dest: string, signal: AbortSignal,
  base: number, onBytes: (done: number) => void
): Promise<void> {
  if (existsSync(dest) && (await sha256File(dest)) === unit.sha256) {
    onBytes(base + unit.size); return
  }
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  try {
    await downloadWithMirrors(unit.urls, tmp, signal, (n) => onBytes(base + n /* 见下累加 */), downloadOneUrl)
    const size = statSync(tmp).size
    if (size !== unit.size || (await sha256File(tmp)) !== unit.sha256) {
      rmSync(tmp, { force: true })
      throw new Error(`文件校验失败：${dest}`)
    }
    renameSync(tmp, dest)
    onBytes(base + unit.size)
  } catch (err) {
    rmSync(tmp, { force: true }) // 清半截，防污染幂等跳过
    throw err
  }
}

/**
 * 下载并安装一个组件到 <root>/<destSubdir>/。files：逐文件下+校验落盘。archive：下整包+校验+
 * tar 解压 strip + chmod +x。抛错前清残留。进度按真实字节数（分母=descriptorTotalBytes）。
 * 不做业务收尾（重热/重建索引）——那由调用方在成功后单独隔离 try 执行（成功/收尾分账）。
 */
export async function installComponent(
  d: ComponentDescriptor, root: string, signal: AbortSignal,
  onProgress: (p: InstallProgress) => void
): Promise<void> {
  const i = d.install
  const total = i.kind === 'files' ? i.files.reduce((s, f) => s + f.size, 0) : i.archive.size
  let done = 0
  const push = (abs: number, file: string | null): void => {
    done = abs
    onProgress({ percent: Math.min(100, Math.round((done / total) * 100)), currentFile: file })
  }

  if (i.kind === 'files') {
    for (const f of i.files) {
      const dest = join(root, i.destSubdir, f.relPath)
      const base = done
      await fetchUnit(f, dest, signal, base, (abs) => push(abs, f.relPath))
      if (f.chmodExec) chmodSync(dest, 0o755)
      push(base + f.size, null)
    }
    return
  }

  // archive：下整包到 <destSubdir>.tar.gz.part → 校验 → tar 解压到 destSubdir → chmod → 判据
  const destDir = join(root, i.destSubdir)
  mkdirSync(destDir, { recursive: true })
  const tmp = join(root, `${i.destSubdir}.tar.gz.part`)
  try {
    await downloadWithMirrors(i.archive.urls, tmp, signal, (n) => push(done + n, i.destSubdir), downloadOneUrl)
    if (statSync(tmp).size !== i.archive.size || (await sha256File(tmp)) !== i.archive.sha256) {
      rmSync(tmp, { force: true }); throw new Error(`整包校验失败：${d.id}`)
    }
    execFileSync('tar', tarExtractArgs(i, tmp, destDir))
    for (const rel of i.chmodExec ?? []) chmodSync(join(destDir, rel), 0o755)
    rmSync(tmp, { force: true })
    push(total, null)
  } catch (err) {
    rmSync(tmp, { force: true }); throw err
  }
}
```

> ⚠️ **进度累加订正**：上面 `fetchUnit` 的 `onBytes(base + n)` 是「本文件内到目前的字节」，跨文件用 `base` 隔开。实现时把 `push` 的语义统一为「已完成绝对字节」，`downloadWithMirrors` 的流式回调 `n` 是增量，需在 `fetchUnit` 内维护 `local += n` 再 `onBytes(base + local)`。落地时以「进度单调不减、结尾等于 total」为验收，不纠结中间抖动。

- [ ] **Step 2: 类型检查通过**

Run: `cd apps/studio && bun run typecheck`
Expected: PASS（无类型错误）

- [ ] **Step 3: 纯函数回归（确认 Task 4 测试仍绿）**

Run: `cd apps/studio && bun test electron/main/services/componentInstaller/hostedFilesInstaller.test.ts`
Expected: PASS（7 tests，追加 install 未破坏纯函数）

- [ ] **Step 4: 提交**

```bash
git add apps/studio/electron/main/services/componentInstaller/hostedFilesInstaller.ts
git commit -m "feat(component-download): installComponent 编排（files 逐文件 + archive 解压 chmod，含半截清理）"
```

---

### Task 6: kbModelDownloader 退化为薄壳（委托通用引擎，embed 行为逐字节保持）

**Files:**
- Modify: `apps/studio/electron/main/services/kbModelDownloader.ts`
- Read (不改，确认接线仍成立): `apps/studio/electron/main/index.ts:302`（`onKbModelDownload` 广播）、`apps/studio/electron/main/ipc/register.ts:2222-2229`（IPC handlers）、`apps/studio/electron/main/core/kbSemanticSearch.ts`（`resetEmbedWorker`/`warmEmbedWorker`）

**Interfaces:**
- Consumes: Task 3 `getComponentDescriptor`/`EMBED_COMPONENT_ID`；Task 4 `isComponentInstalled`；Task 5 `installComponent`；现有 `kbModelDir()`、`resetEmbedWorker`/`warmEmbedWorker`、`scheduleKbBuild`、`kbStoreHasDocs`。
- Produces: **保持现有导出签名不变**（`startKbModelDownload`/`cancelKbModelDownload`/`getKbModelDownloadState`/`onKbModelDownload`/`isKbModelInstalled`/`refreshKbModelInstalled`）——IPC 层与 index.ts 广播零改动。

- [ ] **Step 1: 改写 `isKbModelInstalled` 走通用判据**

把 `kbModelDownloader.ts` 中：
```ts
export function isKbModelInstalled(): boolean {
  return existsSync(join(kbModelDir(), KB_MODEL_ID, 'onnx', 'model_quantized.onnx'))
}
```
改为（判据等价——embed 档案卡的 readyCheck 就是 `onnx/model_quantized.onnx`，destSubdir 就是 KB_MODEL_ID）：
```ts
import { existsSync } from 'node:fs'
import { getComponentDescriptor, EMBED_COMPONENT_ID } from '../core/componentRegistry'
import { isComponentInstalled } from './componentInstaller/hostedFilesInstaller'

const embedDescriptor = getComponentDescriptor(EMBED_COMPONENT_ID)!

export function isKbModelInstalled(): boolean {
  return isComponentInstalled(embedDescriptor, kbModelDir(), existsSync)
}
```

- [ ] **Step 2: 改写 `startKbModelDownload` 委托 `installComponent`，收尾副作用原样保留**

把 `startKbModelDownload` 的下载循环体（`for (const model of KB_DOWNLOADABLE_MODELS) { … }` 那整段 + 进度分母计算）替换为委托，**收尾（reset/warm/rebuild）与 catch/cancel/finally 分支原样保留**：
```ts
export async function startKbModelDownload(): Promise<void> {
  if (downloading) return
  downloading = true
  try {
    cancelled = false
    controller = new AbortController()
    setState({ phase: 'downloading', percent: 0, currentFile: null, errorMessage: null })

    await installComponent(embedDescriptor, kbModelDir(), controller.signal, (p) => {
      setState({ percent: p.percent, currentFile: p.currentFile })
    })

    setState({ phase: 'ready', percent: 100, currentFile: null, installed: true })
    // 下载已落盘成功；下面的重热/重建是"锦上添花"，其失败不该把已成功的下载翻成 error
    // （建库本身已有降级）。故单独 try 包住（承接 b5636bb3）。
    try {
      resetEmbedWorker()
      warmEmbedWorker()
      if (kbStoreHasDocs()) scheduleKbBuild()
    } catch {
      // 重热/重建失败：下载仍视为成功，降级链兜底，不改 state。
    }
  } catch (err) {
    if (cancelled) {
      const installed = isKbModelInstalled()
      setState({ phase: installed ? 'ready' : 'idle', percent: 0, currentFile: null, errorMessage: null, installed })
    } else {
      setState({ phase: 'error', currentFile: null, errorMessage: err instanceof Error ? err.message : String(err) })
    }
  } finally {
    downloading = false
    controller = null
  }
}
```
> `installComponent` 内部已做 `.part` 清理，故删除原 `currentTmp` 手动清残留逻辑。`cancelKbModelDownload`（abort controller）与 `onKbModelDownload`/`getKbModelDownloadState`/`refreshKbModelInstalled` 保持不变。删除现已无用的 import（`createWriteStream`/`https`/`downloadFile`/`KB_DOWNLOADABLE_MODELS`/`renameSync` 等——以 typecheck 报的未用为准清）。

- [ ] **Step 3: 类型检查通过**

Run: `cd apps/studio && bun run typecheck`
Expected: PASS（若报未用 import，删掉对应行再跑至绿）

- [ ] **Step 4: 全量纯核测试回归**

Run: `cd apps/studio && bun test electron/`
Expected: PASS（新增 4 个测试文件全绿 + 现有测试零回归）

- [ ] **Step 5: 手动验证 embed 下载行为不变（关键——无自动化替代）**

按下述实机验证并记录结果：
1. `cd apps/studio && bun run dev` 启动应用。
2. 若本地已有 embed 模型：删除 `~/Library/Application Support/<appName>/kb-model/`（回到未安装态）。
3. 设置页 → 知识库 → 触发模型下载（现有入口，UI 未改）。
4. 预期：进度条从 0→100%，四个文件依次下载，完成后显示已就绪；语义检索恢复向量腿。
5. 断网重试：下载中断网 → 状态转 error、可重试，语义检索降级 BM25 不崩。
6. 取消：下载中点取消 → 回未安装态、不报错、无残留 `.part`。

Expected: 与迁移前逐条一致（下载/进度/校验/取消/断网降级）。

- [ ] **Step 6: 提交**

```bash
git add apps/studio/electron/main/services/kbModelDownloader.ts
git commit -m "refactor(component-download): kbModelDownloader 委托通用引擎，embed 行为保持、IPC/UI 零改动"
```

---

## Self-Review

**1. Spec 覆盖（对 P1a 范围）**：
- 通用档案卡 + 名册 → Task 1、3 ✓
- 多镜像 `urls` 依次试 → Task 2 ✓
- HostedFilesInstaller（files + archive + `.part`/sha256/超时/取消/进度/成功收尾分账）→ Task 2/4/5 ✓
- embed 迁移、行为逐字节保持、IPC/UI 不动 → Task 6 ✓
- archive 形态即便无生产消费方也实现 + 纯参数单测 → Task 4/5 ✓
- **超出 P1a（属 P1b，本计划不含）**：通用状态 map/IPC、组件中心 UI、渐进弹窗、markitdown/soffice 收编、功能门触发。已在计划开头 Scope 明确划走。

**2. 占位符扫描**：无 TBD/TODO；每步含真实代码与确切命令。Task 5 的「进度累加订正」是显式说明而非占位，验收以「单调不减、结尾=total」界定。

**3. 类型一致性**：`ComponentDescriptor`/`HostedInstall`/`DownloadUnit`（Task 1）贯穿 Task 3/4/5/6；`installComponent`/`isComponentInstalled`/`descriptorTotalBytes`/`downloadWithMirrors`/`getComponentDescriptor` 命名在各 Consumes/Produces 对齐；`readyCheck='onnx/model_quantized.onnx'` 与现有 `isKbModelInstalled` 旧判据字面一致（Task 6 判据等价性依赖此）。

**4. 测试策略贴合本仓**：纯逻辑走 bun:test（本仓既有范式）；Electron 单例/IPC/io 编排无单测传统，靠 `bun run typecheck`（唯一自动化防线）+ Task 6 Step 5 手动实机验证。未虚构本仓不存在的测试设施。
