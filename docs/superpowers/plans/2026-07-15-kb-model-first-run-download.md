# 嵌入模型「首次运行时下载」 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 bge 嵌入模型从「本该随安装包发布（实际从未打进包）」改为**首次使用时从 HuggingFace 下载到用户可写目录 `userData/kb-model/`**，让正式版第一次真正拿到模型、语义检索不再永久降级 BM25，且安装包不撑大。

**Architecture:** 新建 main 进程下载器 `kbModelDownloader.ts`（node:https 流式下载 + sha256/精确尺寸校验 + 临时文件 rename + 每请求 60s 超时 + AbortController 取消 + 按 manifest 模型列表循环 + 状态广播），把散在两处的 `modelDir()` 收敛成一个共享 `kbModelDir()`（统一指向 userData），下载成功后复用现成的 `resetEmbedWorker()+warmEmbedWorker()+scheduleKbBuild()` 触发重热与向量重建。设置页 KB 分区加「下载模型」入口 + 进度条 + 取消，KbToolbar 建库处加缺模型引导，经一套新 IPC 通道（invoke 拉快照 + 主动推送全量状态）驱动。版本号钉在 manifest（不再调那个害死 CI 的 HF API 端点），sha256 硬校验保证字节正确。缺模型时现有降级链（stale→BM25、建库跳向量化）继续兜底。

**Tech Stack:** Electron main（Node 环境，`node:https`/`node:crypto`）、TypeScript、`@huggingface/transformers`（运行期消费本地模型，不改）、React 19 + Tailwind v4 + shadcn 色 token（设置页 chat 栈）、per-tab IPC（contextBridge）。

## Global Constraints

- **包管理器是 `bun`，不是 npm。** 所有命令用 `bun run …`。
- **唯一自动化门是 `bun run typecheck`**（全 workspace = Next 侧 + electron 侧双 tsc）。本仓库**没有单元测试、没有 ESLint**（CLAUDE.md 明载）；`electron/` 下无测试运行器。故本计划**不写 pytest/bun-test 式单测**（那会引入本仓库没有的测试基建，违反「follow established patterns」），每个任务的验证 = `bun run typecheck` 绿 + 具体的手动跑 app 观察行为。这是对 writing-plans TDD 模板的**有意适配**，理由如前。
- **加一条 IPC 必须同改四处**：`electron/shared/ipc-channels.ts`（通道常量）→ `electron/preload/index.ts`（暴露方法）→ `electron/preload/index.d.ts`（类型）→ main handler（`electron/main/ipc/register.ts`）。漏一处 typecheck 当场报错。
- **模型 id 唯一事实源** = `electron/shared/kbIndex.ts` 的 `KB_MODEL_ID = 'bge-small-zh-v1.5'`。新增的 manifest 复用它，不得再写第五份字面量。
- **下载目标必须是可写的 userData**，绝不能是 `resourcesPath`（打包后只读）。
- **网络用 `node:https` 不用 `fetch`**：环境常有 SSL-MITM 代理，node https 自动尊重 `NODE_EXTRA_CA_CERTS`，bun/undici fetch 会 ECONNRESET。下载核心移植自 `apps/studio/scripts/prebundle-kb-model.mjs`。
- **本地模型目录布局（裸 id，无 `Xenova/` 前缀）**：`<kbModelDir>/bge-small-zh-v1.5/{config.json, tokenizer.json, tokenizer_config.json, onnx/model_quantized.onnx}`。
- 工作目录默认 `apps/studio`（下文相对路径均以此为根，除非写明 repo 根）。

---

## File Structure

**新建：**
- `electron/main/core/kbModelDir.ts` —— 唯一的模型根目录解析器 `kbModelDir()`（返回 `userData/kb-model`）。取代 `kbSemanticSearch.ts` 与 `kbBuildRunner.ts` 各自的私有 `modelDir()`。
- `electron/main/core/kbModelManifest.ts` —— 下载清单（模型列表 + 每文件 sha256/size pins + 钉死的 revision），运行时下载器的唯一事实源。取代已退役的 `scripts/kb-model-manifest.mjs`。
- `electron/main/services/kbModelDownloader.ts` —— 下载器服务：状态机 + 广播 + node:https 下载 + sha256/尺寸校验 + 临时文件 rename + 按模型列表循环 + 成功后重热/重建。
- `electron/shared/kbModelDownload.ts` —— 前后端共享的下载状态类型 `KbModelDownloadState` + 初值。

**修改：**
- `electron/main/core/kbSemanticSearch.ts:70-74` —— 删私有 `modelDir()`，改 import `kbModelDir`。
- `electron/main/core/kbBuildRunner.ts:23-27` —— 同上。
- `electron/shared/ipc-channels.ts` —— 加 4 个通道常量（get/start/cancel/status 广播）+ preload 接口声明。
- `electron/preload/index.ts` —— 暴露 4 个方法（含 cancel）。
- `electron/preload/index.d.ts` —— 4 个方法的类型。
- `electron/main/ipc/register.ts` —— 3 个 handler（get/start/cancel）。
- `electron/main/tabRegistry.ts` —— 加 `broadcastKbModelDownload`（照抄 `broadcastKbBuildStatus`）。
- `electron/main/index.ts` —— 接线：`onKbModelDownload → broadcastKbModelDownload`，启动时 `refreshKbModelInstalled()`。
- `src/chat/components/settings/KnowledgeBaseSection.tsx` —— 加「模型」分区（状态 + 下载/取消按钮 + 进度条）。
- `src/chat/components/kb/KbToolbar.tsx` —— 缺模型时加一行引导（下载入口 + 下载中百分比）。
- `src/chat/i18n.ts` —— 新 i18n key（中英各一份）。
- `package.json`（apps/studio）—— 删 `prebundle:kb-model` / `verify:kb-model` 两个孤儿脚本。
- **删除**：`scripts/kb-model-manifest.mjs`、`scripts/prebundle-kb-model.mjs`、`scripts/verify-kb-model.mjs`（下载改运行时后彻底无用；userData 是每用户目录，打包时无从预置）。

---

## Task 1: 收敛 `modelDir()` → 共享 `kbModelDir()`（指向 userData）

**Files:**
- Create: `electron/main/core/kbModelDir.ts`
- Modify: `electron/main/core/kbSemanticSearch.ts:70-74`
- Modify: `electron/main/core/kbBuildRunner.ts:23-27`

**Interfaces:**
- Produces: `export function kbModelDir(): string` —— 返回 `userData/kb-model`（其下含 `<KB_MODEL_ID>/…` 布局）。供 `kbSemanticSearch`、`kbBuildRunner`、后续下载器三方共用。

- [ ] **Step 1: 新建共享解析器**

Create `electron/main/core/kbModelDir.ts`：

```ts
// kb 模型根目录的唯一解析器。原本 kbSemanticSearch.ts 与 kbBuildRunner.ts 各存一份私有
// modelDir()：打包分支返回 process.resourcesPath/kb-model——但正式安装包从不含 kb-model
// （extraResources / build.files 均无，prebundle-kb-model.mjs 是孤儿脚本，CI 自 2026-07-06
// 起亦跳过），导致生产语义检索永久降级 BM25。故统一改为可写的 userData，并由首次下载器填充。
import { app } from 'electron'
import { join } from 'node:path'

/**
 * 模型根目录。dev 与打包**统一**走 userData（可写、每用户独立）——
 * 打包后 resourcesPath 只读且从不含模型；dev 也走 userData 以与生产同路径，便于测首次下载。
 * 目录布局：<kbModelDir>/<KB_MODEL_ID>/{config.json,tokenizer.json,tokenizer_config.json,onnx/model_quantized.onnx}
 */
export function kbModelDir(): string {
  return join(app.getPath('userData'), 'kb-model')
}
```

- [ ] **Step 2: kbSemanticSearch 改用共享解析器**

在 `electron/main/core/kbSemanticSearch.ts` 顶部 import 区加：

```ts
import { kbModelDir } from './kbModelDir'
```

删除现有私有函数（连同其上方推导注释块，行 55-74）：

```ts
function modelDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'kb-model')
  // out-electron/main → out-electron → apps/studio（两层 ..）
  return join(dirname(fileURLToPath(import.meta.url)), '../../kb-model')
}
```

把 `warmEmbedWorker()` 内唯一调用点（约行 86）`modelDir()` 改成 `kbModelDir()`：

```ts
    worker = utilityProcess.fork(workerPath, [kbModelDir(), kbOutDir(), fp])
```

若删除后 `app` / `process.resourcesPath` / `dirname` / `fileURLToPath` 在本文件再无其它用处，一并清理其 import（typecheck 的 `noUnusedLocals` 会报未用；`dirname`/`fileURLToPath` 仍被 `workerPath` 与 embedWorker 路径用到，**勿误删**——只删确实不再引用的）。

- [ ] **Step 3: kbBuildRunner 改用共享解析器**

在 `electron/main/core/kbBuildRunner.ts` 顶部 import 区加：

```ts
import { kbModelDir } from './kbModelDir'
```

删除私有函数（连注释，行 23-27）：

```ts
/** 模型目录解析与 kbSemanticSearch.modelDir 同式（打包=resourcesPath，dev=apps/desktop/kb-model）。 */
function modelDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'kb-model')
  return join(dirname(fileURLToPath(import.meta.url)), '../../kb-model')
}
```

把 `start()` 内 fork 调用（约行 32）的 `modelDir()` 改 `kbModelDir()`：

```ts
  const child = utilityProcess.fork(workerPath, [kbStoreDir(), kbOutDir(), String(Date.now()), kbModelDir()])
```

同样清理本文件因此不再使用的 import（只删确实无引用的）。

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: 绿。若报 `app`/`resourcesPath` 相关未用 import，按 Step 2/3 清理。

- [ ] **Step 5: 手动验证路径切换生效**

Run: `bun run dev`，打开一个会话 → 设置 → 知识库，随便触发一次建库（或看主进程日志）。
Expected: 主进程日志里 embedWorker / kbBuildWorker 的 modelDir 现在指向 `~/Library/Application Support/<appName>/kb-model`（macOS 的 userData），**不再**是 `apps/studio/kb-model`。此时该 userData 目录还没有模型 → 建库日志出现「kb-model 缺失，本轮跳过向量化」、语义检索走 BM25——**这是预期的**，正是本功能要填的坑。
（可选：想让 dev 立刻恢复语义检索，把现有 `apps/studio/kb-model/bge-small-zh-v1.5` 拷到该 userData 的 `kb-model/` 下即可；但保持为空更能测后面的真实首次下载。）

- [ ] **Step 6: Commit**

```bash
git add apps/studio/electron/main/core/kbModelDir.ts apps/studio/electron/main/core/kbSemanticSearch.ts apps/studio/electron/main/core/kbBuildRunner.ts
git commit -m "refactor(kb): 收敛 modelDir 为共享 kbModelDir()，统一指向 userData

正式包从不含 kb-model，resourcesPath 分支实际永远落空。两处私有 modelDir()
合并成一个解析器并改到可写的 userData，为首次运行时下载铺路。"
```

---

## Task 2: 下载清单单一事实源（TS manifest）

**Files:**
- Create: `electron/main/core/kbModelManifest.ts`

**Interfaces:**
- Consumes: `KB_MODEL_ID` from `electron/shared/kbIndex.ts`。
- Produces:
  - `interface KbModelFile { relPath: string; sha256: string; size: number }`（`size` = 真实字节数：进度分母 + 精确尺寸校验）
  - `interface KbDownloadableModel { dirName: string; hfRepo: string; revision: string; files: KbModelFile[] }`
  - `const KB_DOWNLOADABLE_MODELS: KbDownloadableModel[]` —— 下载器按此循环。

- [ ] **Step 1: 新建 manifest**

Create `electron/main/core/kbModelManifest.ts`（sha256 逐字来自原 `scripts/kb-model-manifest.mjs`，`size` 为本机实测真实字节数）：

```ts
// 嵌入模型下载清单——运行时首次下载器的唯一事实源，取代已退役的 scripts/kb-model-manifest.mjs。
// 模型 id 复用 shared/kbIndex.ts 的 KB_MODEL_ID，避免又一份漂移。P1 的 reranker 只需在
// KB_DOWNLOADABLE_MODELS 追加一项，下载器按列表循环即零改动复用。
import { KB_MODEL_ID } from '../../shared/kbIndex'

/** 单个待下载文件：相对模型目录根的路径 + sha256 pin + 真实字节数（进度分母 + 下载后精确尺寸校验）。 */
export interface KbModelFile {
  relPath: string
  sha256: string
  size: number
}

/**
 * 一个可下载模型。落盘到 <kbModelDir>/<dirName>/…；hfRepo 是 HuggingFace resolve 仓库（含 org 前缀）。
 * revision：钉死的版本。用 'main' + sha256 硬校验已能保证下到的字节正确（上游若变，sha256 会 loud
 * 报错而非静默给错数据）；**故意不再调 HF 的 /api/models 端点取最新 sha**——那个 API 调用正是
 * 2026-07-06 害死 CI kb-model 下载的元凶（resolve-cache 返回非法 URL）。有 HF 访问时可把 'main'
 * 换成具体 commit sha，彻底免疫上游变更。
 */
export interface KbDownloadableModel {
  dirName: string
  hfRepo: string
  revision: string
  files: KbModelFile[]
}

/** bge 嵌入模型的四个文件（sha256 来自原 manifest；size 为实测：本机 kb-model 下的真实字节数）。 */
const BGE_EMBED_FILES: KbModelFile[] = [
  { relPath: 'config.json', sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f', size: 716 },
  { relPath: 'tokenizer.json', sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26', size: 439125 },
  { relPath: 'tokenizer_config.json', sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a', size: 367 },
  { relPath: 'onnx/model_quantized.onnx', sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc', size: 24010842 },
]

/** 全部可下载模型。P1 reranker（bge-reranker-base ~100MB）追加为第二项即零改动复用下载器。 */
export const KB_DOWNLOADABLE_MODELS: KbDownloadableModel[] = [
  { dirName: KB_MODEL_ID, hfRepo: `Xenova/${KB_MODEL_ID}`, revision: 'main', files: BGE_EMBED_FILES },
]
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 绿（此文件无消费方时也应通过；若报未用导出可忽略，Task 3 会消费）。

- [ ] **Step 3: Commit**

```bash
git add apps/studio/electron/main/core/kbModelManifest.ts
git commit -m "feat(kb): 运行时下载清单 TS 单一事实源（含 sha256/size pins + revision）"
```

---

## Task 3: 下载器服务（下载 + 校验 + 临时文件 rename + 状态机）

**Files:**
- Create: `electron/shared/kbModelDownload.ts`
- Create: `electron/main/services/kbModelDownloader.ts`

**Interfaces:**
- Consumes: `KB_DOWNLOADABLE_MODELS`（Task 2）、`kbModelDir`（Task 1）、`KB_MODEL_ID`、`resetEmbedWorker`/`warmEmbedWorker`（`kbSemanticSearch.ts` 已导出）、`scheduleKbBuild`（`kbBuildRunner.ts:60`，签名 `(): void`）、`kbStoreHasDocs`（`kbIndexStore.ts:87`，签名 `(): boolean`——用作重建前置守卫，照现有 `index.ts:302` 模式）。
- Produces（供 Task 4/5/6 消费）：
  - `interface KbModelDownloadState { phase: 'idle'|'downloading'|'ready'|'error'; percent: number; currentFile: string | null; errorMessage: string | null; installed: boolean }`
  - `const INITIAL_KB_MODEL_DOWNLOAD_STATE: KbModelDownloadState`
  - `function getKbModelDownloadState(): KbModelDownloadState`
  - `function startKbModelDownload(): Promise<void>`（幂等：已在下载则 no-op；进度经广播，返回不代表完成）
  - `function cancelKbModelDownload(): void`（下载中才有效；abort 当前请求，回未安装态、不当错误）
  - `function onKbModelDownload(cb: (s: KbModelDownloadState) => void): () => void`
  - `function isKbModelInstalled(): boolean`
  - `function refreshKbModelInstalled(): void`

- [ ] **Step 1: 共享状态类型**

Create `electron/shared/kbModelDownload.ts`：

```ts
// 前后端共享的嵌入模型下载状态。范式同 UpdaterState/KbBuildStatus：main 持单例、
// invoke 拉快照 + 主动推全量，renderer 整体替换不拼装。
export interface KbModelDownloadState {
  /** idle=未开始/未安装；downloading=下载中；ready=已就绪（安装完或本就存在）；error=失败。 */
  phase: 'idle' | 'downloading' | 'ready' | 'error'
  /** 0-100，跨所有文件的整体字节进度（分母＝各文件真实字节数之和，onnx 占绝对多数）。 */
  percent: number
  /** 当前正在下载的文件相对路径（供 UI 文本），非下载态为 null。 */
  currentFile: string | null
  /** 失败原因，成功/进行中为 null。 */
  errorMessage: string | null
  /** 模型是否已在磁盘就绪（判据同 kbBuildWorker.modelReady）。 */
  installed: boolean
}

export const INITIAL_KB_MODEL_DOWNLOAD_STATE: KbModelDownloadState = {
  phase: 'idle',
  percent: 0,
  currentFile: null,
  errorMessage: null,
  installed: false,
}
```

- [ ] **Step 2: 下载器主体**

Create `electron/main/services/kbModelDownloader.ts`：

```ts
// kb 嵌入模型「首次运行时下载」——把 bge 模型从 HuggingFace 下到 userData/kb-model/。
// 为何在此而非打包时：正式安装包从不含模型（见 kbModelDir.ts 头注释），生产语义检索因此
// 永久降级 BM25。改为运行时下载后模型落可写的 userData，安装包不撑大、CI 不需联网。
//
// 网络用 node:https 不用 fetch：环境常有 SSL-MITM 代理，node https 自动尊重 NODE_EXTRA_CA_CERTS；
// 下载核心（跟随重定向 + sha256 校验 + 幂等跳过）移植自 scripts/prebundle-kb-model.mjs，但跑在运行时
// main 进程，并加了：字节进度回调、临时文件 rename（防半截被当成功）、每请求 60s 超时（防卡死）、
// AbortController 取消。**故意不调 HF /api/models 端点**——版本号钉在 manifest（那个 API 正是
// 2026-07-06 害死 CI 下载的元凶），少一个失败点。
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import https from 'node:https'
import { dirname, join } from 'node:path'
import { KB_MODEL_ID } from '../../shared/kbIndex'
import { INITIAL_KB_MODEL_DOWNLOAD_STATE, type KbModelDownloadState } from '../../shared/kbModelDownload'
import { KB_DOWNLOADABLE_MODELS } from '../core/kbModelManifest'
import { kbModelDir } from '../core/kbModelDir'
import { resetEmbedWorker, warmEmbedWorker } from '../core/kbSemanticSearch'
import { scheduleKbBuild } from '../core/kbBuildRunner'
import { kbStoreHasDocs } from '../core/kbIndexStore'

/** 单请求无数据超时（毫秒）：连上但不传数据也不会永久卡死。 */
const DOWNLOAD_TIMEOUT_MS = 60_000

let state: KbModelDownloadState = { ...INITIAL_KB_MODEL_DOWNLOAD_STATE }

type Listener = (s: KbModelDownloadState) => void
const listeners = new Set<Listener>()

/** 订阅状态推送。返回 unsubscribe。 */
export function onKbModelDownload(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function setState(patch: Partial<KbModelDownloadState>): void {
  state = { ...state, ...patch }
  for (const cb of listeners) cb(state)
}

export function getKbModelDownloadState(): KbModelDownloadState {
  return state
}

/** 模型是否已就绪：判据与 kbBuildWorker 的 modelReady 完全一致（onnx 权重存在）。 */
export function isKbModelInstalled(): boolean {
  return existsSync(join(kbModelDir(), KB_MODEL_ID, 'onnx', 'model_quantized.onnx'))
}

/** 启动时刷新 installed 旗标，让设置页首帧就知道要不要显示「下载」。 */
export function refreshKbModelInstalled(): void {
  const installed = isKbModelInstalled()
  setState({ installed, phase: installed ? 'ready' : state.phase })
}

async function sha256File(filePath: string): Promise<string> {
  const buf = await readFile(filePath)
  return createHash('sha256').update(buf).digest('hex')
}

// 下载 url → filePath，跟随重定向、流式落盘，每收到数据块回调字节数（进度）。
// signal：AbortController.signal，abort 时请求报错 → 上层落进取消分支。
// setTimeout：DOWNLOAD_TIMEOUT_MS 内无数据即 destroy 请求（防连上却不传数据的永久卡死）。
function downloadFile(
  url: string,
  filePath: string,
  signal: AbortSignal,
  onBytes: (n: number) => void,
  maxRedirects = 10
): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (u: string, remaining: number): void => {
      const req = https.get(u, { signal }, (res) => {
        const code = res.statusCode ?? 0
        const loc = res.headers.location
        if ([301, 302, 303, 307, 308].includes(code) && loc) {
          if (remaining <= 0) return reject(new Error(`Too many redirects for ${url}`))
          // location 极少是数组；收窄成 string 传下一跳。
          return follow(Array.isArray(loc) ? loc[0] : loc, remaining - 1)
        }
        if (code !== 200) return reject(new Error(`HTTP ${code} from ${u}`))
        const ws = createWriteStream(filePath)
        res.on('data', (c: Buffer) => onBytes(c.length))
        res.pipe(ws)
        ws.on('finish', () => resolve())
        ws.on('error', reject)
        res.on('error', reject)
      })
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('下载超时（60s 无响应）')))
      req.on('error', reject)
    }
    follow(url, maxRedirects)
  })
}

let downloading = false
let cancelled = false
let controller: AbortController | null = null

/**
 * 触发首次下载。按 KB_DOWNLOADABLE_MODELS 循环（P1 reranker 零改动复用）。
 * 每文件：临时 .part 下载 → 精确尺寸 + sha256 校验 → rename 到位（防半截被当成功）；已存在且 sha
 * 匹配则幂等跳过。全部成功后 resetEmbedWorker + warmEmbedWorker +（有文档才）scheduleKbBuild 重建向量。
 * 失败：phase='error'；取消：回未安装态、不当错误。两者都清残留 .part。现有降级链继续兜底，不崩不空。
 */
export async function startKbModelDownload(): Promise<void> {
  if (downloading) return
  downloading = true
  cancelled = false
  controller = new AbortController()
  setState({ phase: 'downloading', percent: 0, currentFile: null, errorMessage: null })

  // 进度分母 = 所有文件真实字节数之和（onnx 24MB 占绝对多数，进度条精确跟大文件走，不会早跳 100%）。
  const totalBytes = KB_DOWNLOADABLE_MODELS.flatMap((m) => m.files).reduce((sum, f) => sum + f.size, 0)
  let doneBytes = 0
  let currentTmp: string | null = null
  const pushPercent = (): void => setState({ percent: Math.min(100, Math.round((doneBytes / totalBytes) * 100)) })

  try {
    for (const model of KB_DOWNLOADABLE_MODELS) {
      const destRoot = join(kbModelDir(), model.dirName)
      for (const file of model.files) {
        const dest = join(destRoot, file.relPath)
        // 幂等：已存在且 sha 匹配则跳过（累加真实 size 让进度不倒退）。
        if (existsSync(dest) && (await sha256File(dest)) === file.sha256) {
          doneBytes += file.size
          pushPercent()
          continue
        }
        setState({ currentFile: file.relPath })
        mkdirSync(dirname(dest), { recursive: true })
        const tmp = `${dest}.part`
        currentTmp = tmp
        const base = doneBytes
        await downloadFile(
          `https://huggingface.co/${model.hfRepo}/resolve/${model.revision}/${file.relPath}`,
          tmp,
          controller.signal,
          (n) => {
            doneBytes += n
            pushPercent()
          }
        )
        // 校验：精确尺寸 + sha256，任一不符删临时文件并抛（不留半截污染幂等跳过）。
        const size = statSync(tmp).size
        const sha = await sha256File(tmp)
        if (size !== file.size || sha !== file.sha256) {
          rmSync(tmp, { force: true })
          throw new Error(`模型文件校验失败：${file.relPath}`)
        }
        renameSync(tmp, dest)
        currentTmp = null
        // 用真实 size 对齐进度（下载回调是流式累加，rename 后归位到 base+size）。
        doneBytes = base + file.size
        pushPercent()
      }
    }
    setState({ phase: 'ready', percent: 100, currentFile: null, installed: true })
    // 模型就绪：回收旧 worker 重热；有知识库文档才触发重建（守卫照 index.ts:302 现有模式）。
    resetEmbedWorker()
    warmEmbedWorker()
    if (kbStoreHasDocs()) scheduleKbBuild()
  } catch (err) {
    if (currentTmp) rmSync(currentTmp, { force: true }) // 清掉中断留下的半截 .part
    if (cancelled) {
      // 用户主动取消：回到未安装/已安装态，不当错误。
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

/** 取消进行中的下载（无下载时 no-op）。abort 当前请求，落进 startKbModelDownload 的取消分支。 */
export function cancelKbModelDownload(): void {
  if (!downloading) return
  cancelled = true
  controller?.abort()
}
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 绿。`res.headers.location` 的 `string | string[]` 收窄已在 `downloadFile` 内用 `Array.isArray(loc) ? loc[0] : loc` 处理。若报 `https.get` 第二参 `{ signal }` 类型不符（旧 @types/node），确认 `@types/node` 版本支持 options+callback 重载——本仓库 Electron 版对应的 node 类型支持 `AbortSignal`。

- [ ] **Step 4: 手动冒烟（下载器可跑通）**

临时在 `electron/main/index.ts` 启动收尾处加一行 `void startKbModelDownload()`（**验证完删掉**，正式触发在 Task 4/5）。Run: `bun run dev`。
Expected: 主进程日志无异常；`~/Library/Application Support/<appName>/kb-model/bge-small-zh-v1.5/` 下逐个出现 4 个文件、无遗留 `.part`；下载完成后触发一次建库（日志不再有「kb-model 缺失」）。断网重试应进入 `phase='error'` 且不崩。**验证后移除临时那行。**

- [ ] **Step 5: Commit**

```bash
git add apps/studio/electron/shared/kbModelDownload.ts apps/studio/electron/main/services/kbModelDownloader.ts
git commit -m "feat(kb): 运行时嵌入模型下载器（node https + sha256 + 临时文件 rename + 60s 超时 + 取消 + 进度状态机）"
```

---

## Task 4: IPC 接线（四处 + 广播）

**Files:**
- Modify: `electron/shared/ipc-channels.ts`
- Modify: `electron/preload/index.ts`
- Modify: `electron/preload/index.d.ts`
- Modify: `electron/main/ipc/register.ts`
- Modify: `electron/main/tabRegistry.ts`
- Modify: `electron/main/index.ts`

**Interfaces:**
- Consumes: `getKbModelDownloadState`/`startKbModelDownload`/`cancelKbModelDownload`/`onKbModelDownload`/`refreshKbModelInstalled`（Task 3）、`KbModelDownloadState`（Task 3）。
- Produces（renderer 侧 `window.chatApi` 四方法，供 Task 5/6）：
  - `kbModelDownloadStatusGet(): Promise<KbModelDownloadState>`
  - `startKbModelDownload(): Promise<void>`
  - `cancelKbModelDownload(): Promise<void>`
  - `onKbModelDownload(cb: (s: KbModelDownloadState) => void): () => void`

- [ ] **Step 1: 通道常量**

在 `electron/shared/ipc-channels.ts` 的 KB 段（`KB_BUILD_STATUS` 附近，约行 892）加三条常量：

```ts
  KB_MODEL_DOWNLOAD_STATUS_GET: 'kb:model-download-status-get',
  KB_MODEL_DOWNLOAD_START: 'kb:model-download-start',
  KB_MODEL_DOWNLOAD_CANCEL: 'kb:model-download-cancel',
  KB_MODEL_DOWNLOAD_STATUS: 'kb:model-download-status',
```

（注意上一条 `KB_BUILD_STATUS: 'kb:build-status'` 无尾逗号是对象最后一项——若在其后追加，先给它补逗号。）

- [ ] **Step 2: preload 接口声明**

在同文件的 preload 接口声明段（KB 方法处，约行 2463-2465，`kbBuildStatusGet`/`onKbBuildStatus` 旁）加：

```ts
  kbModelDownloadStatusGet(): Promise<import('./kbModelDownload').KbModelDownloadState>
  startKbModelDownload(): Promise<void>
  cancelKbModelDownload(): Promise<void>
  onKbModelDownload(handler: (s: import('./kbModelDownload').KbModelDownloadState) => void): () => void
```

- [ ] **Step 3: preload 暴露方法**

在 `electron/preload/index.ts` 的 KB 方法区（`kbBuildStatusGet`/`onKbBuildStatus` 约行 847-856）后加，照抄其订阅返回 unsubscribe 的写法：

```ts
    kbModelDownloadStatusGet(): Promise<KbModelDownloadState> {
      return ipcRenderer.invoke(IPC_CHANNELS.KB_MODEL_DOWNLOAD_STATUS_GET) as Promise<KbModelDownloadState>
    },
    startKbModelDownload(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.KB_MODEL_DOWNLOAD_START) as Promise<void>
    },
    cancelKbModelDownload(): Promise<void> {
      return ipcRenderer.invoke(IPC_CHANNELS.KB_MODEL_DOWNLOAD_CANCEL) as Promise<void>
    },
    onKbModelDownload(cb: (s: KbModelDownloadState) => void): () => void {
      const listener = (_e: unknown, s: KbModelDownloadState): void => cb(s)
      ipcRenderer.on(IPC_CHANNELS.KB_MODEL_DOWNLOAD_STATUS, listener)
      return () => {
        ipcRenderer.off(IPC_CHANNELS.KB_MODEL_DOWNLOAD_STATUS, listener)
      }
    },
```

在 `electron/preload/index.ts` 顶部 type import 区加（若尚无）：

```ts
import type { KbModelDownloadState } from '../shared/kbModelDownload'
```

- [ ] **Step 4: preload 类型声明（.d.ts）**

在 `electron/preload/index.d.ts` 的 chatApi 接口里，KB 方法处加：

```ts
  kbModelDownloadStatusGet(): Promise<import('../shared/kbModelDownload').KbModelDownloadState>
  startKbModelDownload(): Promise<void>
  cancelKbModelDownload(): Promise<void>
  onKbModelDownload(cb: (s: import('../shared/kbModelDownload').KbModelDownloadState) => void): () => void
```

（路径前缀以本文件里其它 shared 类型的既有写法为准，照抄相邻行的相对深度。）

- [ ] **Step 5: main handler**

在 `electron/main/ipc/register.ts` 顶部 import 下载器：

```ts
import { getKbModelDownloadState, startKbModelDownload, cancelKbModelDownload } from '../services/kbModelDownloader'
```

在 KB handler 区（`KB_BUILD_STATUS_GET` handler 约行 2215 附近）加三个：

```ts
  ipcMain.handle(IPC_CHANNELS.KB_MODEL_DOWNLOAD_STATUS_GET, async (): Promise<import('../../shared/kbModelDownload').KbModelDownloadState> =>
    getKbModelDownloadState())
  // 触发即返回：下载在后台跑，进度经 KB_MODEL_DOWNLOAD_STATUS 广播推送（不阻塞 invoke）。
  ipcMain.handle(IPC_CHANNELS.KB_MODEL_DOWNLOAD_START, async (): Promise<void> => {
    void startKbModelDownload()
  })
  ipcMain.handle(IPC_CHANNELS.KB_MODEL_DOWNLOAD_CANCEL, async (): Promise<void> => {
    cancelKbModelDownload()
  })
```

- [ ] **Step 6: 广播函数**

在 `electron/main/tabRegistry.ts` 照抄 `broadcastKbBuildStatus`（约行 999-1008）加一个：

```ts
export function broadcastKbModelDownload(payload: KbModelDownloadState): void {
  if (shellWindow && !shellWindow.isDestroyed()) {
    shellWindow.webContents.send(IPC_CHANNELS.KB_MODEL_DOWNLOAD_STATUS, payload)
  }
  for (const ctx of tabs.values()) {
    if (ctx.kind === 'web') continue
    const wc = ctx.view.webContents
    if (!wc.isDestroyed()) wc.send(IPC_CHANNELS.KB_MODEL_DOWNLOAD_STATUS, payload)
  }
}
```

在 `tabRegistry.ts` 顶部 type import 加：

```ts
import type { KbModelDownloadState } from './shared/kbModelDownload'
```

（相对路径以 tabRegistry.ts 引用其它 `shared/*` 类型的既有写法为准，照抄。）

- [ ] **Step 7: 接线（推送 + 启动刷新）**

在 `electron/main/index.ts`：
- import 区加：

```ts
import { onKbModelDownload, refreshKbModelInstalled } from './services/kbModelDownloader'
import { broadcastKbModelDownload } from './tabRegistry'
```

（`broadcastKbModelDownload` 若 tabRegistry 已在行 42 附近成组导入，加进那个 import 块即可。）

- 在建库广播接线旁（约行 297 `onKbBuildStatus((s) => broadcastKbBuildStatus(s))`）加：

```ts
  onKbModelDownload((s) => broadcastKbModelDownload(s))
  refreshKbModelInstalled()
```

- [ ] **Step 8: typecheck**

Run: `bun run typecheck`
Expected: 绿。四处任漏一处都会在此报错（IPC 铁律）。

- [ ] **Step 9: 手动验证 IPC 通**

Run: `bun run dev`。打开 DevTools 控制台（chat 面），执行：

```js
await window.chatApi.kbModelDownloadStatusGet()
```

Expected: 返回形如 `{ phase: 'idle'|'ready', percent, currentFile: null, errorMessage: null, installed: <bool> }`（installed 反映 userData 里有没有模型）。再执行 `window.chatApi.startKbModelDownload()`，配合 `window.chatApi.onKbModelDownload(console.log)` 应看到 percent 递增的推送。

- [ ] **Step 10: Commit**

```bash
git add apps/studio/electron/shared/ipc-channels.ts apps/studio/electron/preload/index.ts apps/studio/electron/preload/index.d.ts apps/studio/electron/main/ipc/register.ts apps/studio/electron/main/tabRegistry.ts apps/studio/electron/main/index.ts
git commit -m "feat(kb): 模型下载 IPC 通道 + 状态广播接线（四处 + broadcast）"
```

---

## Task 5: 设置页「模型」分区（状态 + 下载/取消按钮 + 进度条）

**Files:**
- Modify: `src/chat/components/settings/KnowledgeBaseSection.tsx`
- Modify: `src/chat/i18n.ts`

**Interfaces:**
- Consumes: `window.chatApi.kbModelDownloadStatusGet()` / `startKbModelDownload()` / `cancelKbModelDownload()` / `onKbModelDownload(cb)`（Task 4）、`KbModelDownloadState`（Task 3 shared 类型）。

- [ ] **Step 1: i18n key（中英各一份）**

在 `src/chat/i18n.ts` 中文 KB 段（约行 174-189）加：

```ts
    kbModelTitle: '嵌入模型',
    kbModelDesc: '语义检索需要一个本地嵌入模型（约 23MB）。未下载时检索退回关键词匹配（BM25）。',
    kbModelInstalled: '模型已就绪，语义检索已启用。',
    kbModelDownload: '下载模型',
    kbModelDownloading: '正在下载',
    kbModelCancel: '取消',
    kbModelRetry: '重试',
    kbModelError: '下载失败，可重试；期间检索继续走关键词匹配。',
    kbModelMissingHint: '语义检索未启用（未下载嵌入模型）',
```

在英文对应段（约行 562 起）加同名 key：

```ts
    kbModelTitle: 'Embedding model',
    kbModelDesc: 'Semantic search needs a local embedding model (~23MB). Until it is downloaded, search falls back to keyword matching (BM25).',
    kbModelInstalled: 'Model ready — semantic search enabled.',
    kbModelDownload: 'Download model',
    kbModelDownloading: 'Downloading',
    kbModelCancel: 'Cancel',
    kbModelRetry: 'Retry',
    kbModelError: 'Download failed — you can retry; search keeps using keyword matching meanwhile.',
    kbModelMissingHint: 'Semantic search off (embedding model not downloaded)',
```

- [ ] **Step 2: 组件里订阅下载状态**

在 `src/chat/components/settings/KnowledgeBaseSection.tsx` 顶部 type import 加：

```ts
import type { KbModelDownloadState } from '../../../../electron/shared/kbModelDownload'
```

（相对深度以本文件引用其它 `electron/shared/*` 类型的既有写法为准；若本文件尚未引用 shared 类型，用 `@desktop-shared/kbModelDownload` 别名——查文件内既有 import 风格照抄。）

在组件函数体内（现有 `useState`/`useEffect` 区，约行 30-57）加状态与订阅：

```tsx
  const [model, setModel] = useState<KbModelDownloadState | null>(null)
  useEffect(() => {
    void window.chatApi.kbModelDownloadStatusGet().then(setModel)
    const off = window.chatApi.onKbModelDownload(setModel)
    return off
  }, [])
```

- [ ] **Step 3: 渲染「模型」分区**

在 `return (` 的 `<section>` 内、`<h1>`（约行 129）之后、`kbSourceTitle` 的 `<Section>`（约行 134）之前，插入新分区。按钮/进度条 markup 照抄本文件既有 utility 风格（accent 实心按钮 `:185-192`、进度轨照 `SettingsView.tsx:826-831` 的两层 div）：

```tsx
      <Section title={t('kbModelTitle')} description={t('kbModelDesc')}>
        <div className="rounded-xl border border-border/60 bg-card/40 px-4 py-3">
          {model?.phase === 'ready' || model?.installed ? (
            <p className="text-[12px] text-emerald-600 dark:text-emerald-400">{t('kbModelInstalled')}</p>
          ) : model?.phase === 'downloading' ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[12px] text-muted-foreground">
                <span>{t('kbModelDownloading')}{model.currentFile ? ` · ${model.currentFile}` : ''}</span>
                <span>{model.percent}%</span>
              </div>
              <div className="relative h-1.5 w-full rounded-full bg-muted">
                <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width]" style={{ width: `${model.percent}%` }} />
              </div>
              <button
                type="button"
                onClick={() => void window.chatApi.cancelKbModelDownload()}
                className="inline-flex h-8 shrink-0 items-center rounded-md border border-border bg-card px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                {t('kbModelCancel')}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {model?.phase === 'error' && (
                <p className="text-[12px] text-destructive">{model.errorMessage || t('kbModelError')}</p>
              )}
              <button
                type="button"
                onClick={() => void window.chatApi.startKbModelDownload()}
                className="inline-flex h-8 shrink-0 items-center rounded-md bg-accent px-3 text-[12px] font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {model?.phase === 'error' ? t('kbModelRetry') : t('kbModelDownload')}
              </button>
            </div>
          )}
        </div>
      </Section>
```

（`Section` 已在本文件 import，见 `:5`；`useState`/`useEffect` 应已 import，若无则补 `import { useEffect, useState } from 'react'`。`text-destructive` 若本仓库无此 token，用 `text-red-600 dark:text-red-400`——查现有错误文本类名照抄。）

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: 绿。

- [ ] **Step 5: 手动验证完整闭环**

Run: `bun run dev`（先确保 userData 的 kb-model 为空以测真实首次下载；已存在则先删该目录）。
打开 设置 → 知识库 → 「嵌入模型」分区：
1. 初始显示「下载模型」按钮 + 说明文案。
2. 点「下载模型」→ 进度条从 0% 递增、显示当前文件名、到 100%。
3. 完成后变绿字「模型已就绪，语义检索已启用」；`userData/kb-model/bge-small-zh-v1.5/` 下 4 文件齐、无 `.part`。
4. 下载中途点「取消」→ 进度停下、回到「下载模型」按钮态，app 不崩；再点可重新下载。
5. 下载完成自动触发一次建库（KbToolbar 出现构建中指示），建库日志不再有「kb-model 缺失」。
6. 建库后做一次知识库检索，确认走向量腿（主进程 embedWorker 日志 `ready`、无 `stale`）。
7. 断网点重试 → 进入错误态、显示错误文案 + 「重试」按钮，app 不崩；恢复网络重试成功。
8. （超时）用网络工具把 huggingface.co 限速到近乎不通，确认 ~60s 后自动进入错误态而非永久卡在下载中。

- [ ] **Step 6: Commit**

```bash
git add apps/studio/src/chat/components/settings/KnowledgeBaseSection.tsx apps/studio/src/chat/i18n.ts
git commit -m "feat(kb): 设置页嵌入模型下载入口（状态/进度条/下载·取消·重试 + i18n）"
```

---

## Task 6: KbToolbar 缺模型引导

**Files:**
- Modify: `src/chat/components/kb/KbToolbar.tsx`

**Interfaces:**
- Consumes: `window.chatApi.kbModelDownloadStatusGet()` / `startKbModelDownload()` / `onKbModelDownload(cb)`（Task 4）、`KbModelDownloadState`（Task 3 shared 类型）。

**背景**：用户选定的方案是「设置页显式入口 **+ 建库/搜索时若缺模型给引导**」。Task 5 做了设置页入口；本任务补「建库工具条处的引导」——用户从 KbToolbar 触发建库时，若没模型，就地给一个「语义检索未启用 · 下载模型」的一行入口（下载走同一套 IPC，仍是显式点击、不偷偷后台跑）。

- [ ] **Step 1: 订阅下载状态**

在 `src/chat/components/kb/KbToolbar.tsx` 顶部 type import 加（相对深度以本文件既有 `electron/shared/*` 引用为准，或用 `@desktop-shared/kbModelDownload` 别名——照文件内既有风格）：

```ts
import type { KbModelDownloadState } from '../../../../electron/shared/kbModelDownload'
```

在组件函数体加状态与订阅（照 KnowledgeBaseSection 同款「拉快照 + 订阅推送」范式）：

```tsx
  const [model, setModel] = useState<KbModelDownloadState | null>(null)
  useEffect(() => {
    void window.chatApi.kbModelDownloadStatusGet().then(setModel)
    const off = window.chatApi.onKbModelDownload(setModel)
    return off
  }, [])
```

（`useState`/`useEffect` 若未 import 则补 `import { useEffect, useState } from 'react'`。）

- [ ] **Step 2: 渲染引导**

先 Read `KbToolbar.tsx` 找到构建中指示那段（`{build?.running && (` … `text-[11.5px] text-muted-foreground/80` …，约行 77-82）。在同一工具条行内、作为该指示的**兄弟节点**加下面两段（缺模型时给下载入口；下载中显示百分比）。样式沿用相邻状态 span 的 `text-[11.5px] text-muted-foreground/80`：

```tsx
      {model && !model.installed && model.phase !== 'downloading' && (
        <button
          type="button"
          onClick={() => void window.chatApi.startKbModelDownload()}
          className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-muted-foreground/80 transition-colors hover:text-foreground"
        >
          {t('kbModelMissingHint')} · {t('kbModelDownload')}
        </button>
      )}
      {model?.phase === 'downloading' && (
        <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-muted-foreground/80">
          <kbIcons.refresh className="size-3.5 animate-spin" />
          {t('kbModelDownloading')} {model.percent}%
        </span>
      )}
```

**布局注意**：`ml-auto` 是「推到最右」。若与既有构建指示的 `ml-auto` 同时出现会打架——把这两段与构建指示放进同一个「右侧状态区」，同一时刻实际只会命中其一（下载中 / 缺模型 / 建库中互斥或叠加时以最相关者为准）。Read 现有结构后按最贴合的方式放置，勿破坏工具条既有布局。`kbIcons.refresh` 沿用本文件既有图标引用（构建指示已用它）。

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: 绿。

- [ ] **Step 4: 手动验证**

Run: `bun run dev`（userData 无模型）。打开挂了知识库的会话看 KbToolbar：
1. 缺模型时工具条出现「语义检索未启用 · 下载模型」一行入口。
2. 点它 → 开始下载、工具条显示「正在下载 NN%」；设置页同步进度（同一状态广播）。
3. 下载完引导消失、自动建库。

- [ ] **Step 5: Commit**

```bash
git add apps/studio/src/chat/components/kb/KbToolbar.tsx
git commit -m "feat(kb): KbToolbar 缺模型引导（就地下载入口 + 下载中百分比）"
```

---

## Task 7: 退役孤儿打包脚本

**Files:**
- Delete: `scripts/kb-model-manifest.mjs`, `scripts/prebundle-kb-model.mjs`, `scripts/verify-kb-model.mjs`
- Modify: `package.json`（apps/studio，删 `prebundle:kb-model` / `verify:kb-model` 两个 script）

**Interfaces:** 无（纯清理；这三个 `.mjs` 与两个 script 全仓已无调用方——见设计文档「孤儿脚本」核实与 CI 注释）。

- [ ] **Step 1: 确认确无引用**

Run:
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
grep -rn "prebundle:kb-model\|verify:kb-model\|prebundle-kb-model\|verify-kb-model\|kb-model-manifest" --include="*.json" --include="*.mjs" --include="*.ts" --include="*.tsx" --include="*.yml" --include="*.yaml" . | grep -v node_modules | grep -v "docs/superpowers"
```
Expected: 仅剩这三个脚本彼此 import + `package.json` 两个 script 定义 + `.github/workflows/build.yml` 的**注释**（已停用）。若出现别的实代码引用，停下核对——不应有。

- [ ] **Step 2: 删脚本 + package.json script**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/studio
git rm scripts/kb-model-manifest.mjs scripts/prebundle-kb-model.mjs scripts/verify-kb-model.mjs
```
用编辑器删 `apps/studio/package.json` 里这两行：
```json
    "prebundle:kb-model": "node scripts/prebundle-kb-model.mjs",
    "verify:kb-model": "node scripts/verify-kb-model.mjs",
```
（注意 JSON 逗号：删后确保上一行不留悬空逗号语法错。）

- [ ] **Step 3: typecheck + 确认打包链不引用**

Run: `bun run typecheck`
Expected: 绿。
Run: `node -e "const p=require('./package.json');const s=p.scripts;console.log(Object.keys(s).filter(k=>/kb-model/.test(k)))"`（在 apps/studio 下）
Expected: `[]`（空数组）。`build:mac`/`build:win`/`dist:*`/`prebuild:resources` 本就不含它们，无需改。

- [ ] **Step 4: Commit**

```bash
git add apps/studio/package.json apps/studio/scripts
git commit -m "chore(kb): 退役孤儿打包脚本（模型改运行时下载，userData 目录无从打包预置）"
```

---

## Self-Review

对照设计文档 `docs/superpowers/specs/2026-07-15-kb-model-first-run-download-design.md` 核查：

**1. Spec coverage**
- 核心约束「下载进 userData / modelDir 两处同步改」→ Task 1 ✓
- 「node https 不用 fetch，移植 prebundle 下载逻辑」→ Task 3 ✓
- 「复用 manifest pins，单一事实源」→ Task 2（pins 进 TS，孤儿 .mjs 退役）✓
- 待定决策 1「何时触发」= 用户已拍板「设置页显式入口 + 建库时引导」→ Task 5（设置页入口）+ Task 6（KbToolbar 建库处引导）✓
- 待定决策 2「进度与失败/优雅降级」→ Task 3（精确进度 + error/取消态 + 60s 超时 + 现有降级链）+ Task 5（进度条/取消/重试）✓
- 待定决策 3「多模型前瞻，按列表循环」→ Task 2/3（`KB_DOWNLOADABLE_MODELS` 循环）✓
- 待定决策 4「完整性/断点，临时文件 + rename」→ Task 3 ✓
- 验收「下载完 sha256 校验、半截不算成功」→ Task 3（精确尺寸 + sha256 + rename，取消/失败清 .part）✓
- 验收「modelDir 两处同步、embedWorker 与 kbBuildWorker 都能从新位置加载」→ Task 1（两 worker 经 argv 拿到同一 `kbModelDir()`）✓
- 验收「typecheck 绿」→ 每个 Task 的 typecheck 步 ✓
- 打包收尾「prebundle/verify 退役」→ Task 7 ✓

**评审并入的修正（brainstorming 复审后加）**
- A 进度数学：分母改真实 `size`（onnx 24010842），不再「早跳 100% 卡住」→ Task 2/3 ✓
- B 卡死：每请求 60s 超时 + AbortController 取消（设置页+工具条可取消）→ Task 3/4/5 ✓
- C 版本漂移：版本钉在 manifest、删掉害死 CI 的 HF `/api/models` 调用，sha256 硬校验兜底 → Task 2/3 ✓
- D 建库引导：KbToolbar 缺模型入口 → Task 6 ✓
- E 空跑重建：`scheduleKbBuild()` 前加 `kbStoreHasDocs()` 守卫（照 index.ts:302）→ Task 3 ✓
- F .part 残留：取消/失败均 `rmSync` 清临时文件 → Task 3 ✓
- G（留待 P1）：sha256 用整文件 `readFile`，100MB reranker 有内存尖峰——见文末备注，本期不改。

**2. Placeholder scan** — 每个代码步均含完整可编译代码；手动验证步给了确切操作与预期。UI 里 `text-destructive`、`kbIcons.refresh`、shared 类型 import 深度、KbToolbar 引导的具体放置均标注「Read 后以既有写法为准照抄」，属对既有约定的引用而非占位。

**3. Type consistency** — `KbModelDownloadState` 字段（phase/percent/currentFile/errorMessage/installed）在 shared 定义、downloader、IPC、preload、设置页 UI、KbToolbar 六处一致；`KbModelFile.size`（非旧 `minSize`）在 manifest 定义与 downloader 校验/进度处一致；`startKbModelDownload`/`cancelKbModelDownload`/`getKbModelDownloadState`/`onKbModelDownload`/`kbModelDir`/`KB_DOWNLOADABLE_MODELS` 命名跨任务一致；`scheduleKbBuild()`/`resetEmbedWorker()`/`warmEmbedWorker()`/`kbStoreHasDocs()` 均已核实为导出函数（前三无参、末者返 boolean）。

---

## 备注：本仓库测试现实

writing-plans 默认 TDD（先写失败测试）。本仓库 `electron/` 无测试运行器、CLAUDE.md 明载「没有单元测试」，唯一自动化门是 `bun run typecheck`。故本计划以 **typecheck + 手动跑 app 观察行为**作每任务验证，未引入本仓库不存在的测试基建（遵循 writing-plans 的「follow established patterns」）。若日后引入 electron 侧测试运行器，`kbModelManifest`（pins 形状）、`kbModelDir`（路径）、下载器的 sha256/rename 幂等是最值得补单测的纯逻辑点。

**留待 P1 的已知项（G）**：`sha256File` 用整文件 `readFile` 进内存算哈希。当前 bge onnx 24MB 无碍；P1 的 reranker（~100MB）会有 100MB 级内存尖峰。P1 接入 reranker 时把 `sha256File` 换成流式（`createReadStream` + `hash.update`）即可，本期不改（YAGNI）。
