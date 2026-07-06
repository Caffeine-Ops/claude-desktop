# 知识库驱动的方案写作功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 claude-desktop 里加一个"知识库驱动的方案写作"MVP：用户选产品 → AI 以对话向导方式、严格基于公司知识库逐段写方案草稿 → 用户轻量编辑 → 导出 Markdown。

**Architecture:** 分两阶段。**阶段 A（离线索引器）**是一个独立 Node 脚本，把 3GB 的 docx/pptx/xlsx/pdf 预转换成"文本镜像 + 媒体资产 + index.json"，与 Electron 无关、可独立运行验证。**阶段 B（应用内功能）**复用现有 chat / ChatEngine / todos / markdown 渲染，新增"写方案"入口卡、产品选择、方案专家系统提示词（把镜像目录作为额外可读目录注入，不动 cwd 不变量）、右侧方案文档面板、Markdown 导出。

**Tech Stack:** bun + TypeScript + electron-vite；markitdown（Python，docx/pptx/xlsx/pdf→md，主力）+ LibreOffice headless（兜底）；React 19 + zustand + react-markdown + remark-gfm；fusion-code（@anthropic-ai/claude-agent-sdk）。

## Global Constraints

- 包管理器是 **bun**，不是 npm。所有命令用 `bun run …`。
- 实际代码在 `apps/desktop/src/`（CLAUDE.md 里的 `src/` 是旧路径，已失效）。
- **唯一质量门是 `bun run typecheck`**（= `typecheck:node` + `typecheck:web`）。项目**没有单元测试框架、没有 ESLint**。本计划不引入 vitest；纯逻辑用独立 smoke 脚本跑真实数据并核对输出，UI 用 typecheck + 手动运行验证。
- 加一条 IPC 必须**同时改四处**：`apps/desktop/src/shared/ipc-channels.ts`（常量）→ `apps/desktop/src/preload/index.ts`（暴露方法）→ `apps/desktop/src/preload/index.d.ts`（类型）→ `apps/desktop/src/main/ipc/register.ts`（handler）。漏一处 typecheck 报错。
- **不变量：会话 cwd（ChatEngine.workspaceDir）只能设一次，不可改。** 本功能**绝不**通过改 cwd 来让 AI 读知识库；改用"额外可读目录 + 系统提示词告知绝对路径"。
- **底线：实事求是，只用知识库内容写，绝不臆想。** 查不到的内容必须标"⚠️ 资料缺失"，不得用模型自身知识填补。每段须标来源文件。
- **索引产物契约（阶段 A 产出、阶段 B 消费，两阶段必须一致）**——`index.json` 顶层形状：
  ```ts
  // apps/desktop/src/shared/kbIndex.ts 里定义并被两端共享
  export interface KbIndexFile {
    sourcePath: string      // 原始文件绝对路径
    mirrorPath: string      // 文本镜像 .md 的绝对路径
    productLine: string     // 一级目录名，如 "01AI患者服务"
    product: string         // 二级目录名，如 "1_智能导诊系统"；无二级时为 ""
    title: string           // 文件名去扩展名
    mtimeMs: number         // 源文件 mtime（增量判断）
    sha1: string            // 源文件内容 sha1（增量判断）
    assets: string[]        // 抽出的媒体资产绝对路径数组（可空）
    ok: boolean             // 转换是否成功
    error?: string          // 失败原因（ok=false 时）
  }
  export interface KbIndex {
    version: 1
    kbRoot: string          // 知识库根绝对路径
    builtAtMs: number       // 构建时间戳（由调用方传入，脚本不调 Date.now 之外这里允许）
    files: KbIndexFile[]
  }
  ```
- 镜像与索引输出根：`<app userData>/kb-index/`（脚本里用 `--out` 参数传入；脚本本身不依赖 Electron，由调用方决定路径）。

---

## 阶段 A：离线索引器（独立脚本，无 Electron 依赖）

### Task 1: 索引产物类型 + 知识库目录扫描

**Files:**
- Create: `apps/desktop/src/shared/kbIndex.ts`（类型，被脚本和 app 共享）
- Create: `scripts/kb-index/scan.ts`（扫描 KB 目录树，产出待处理文件列表 + 产品线分类）
- Create: `scripts/kb-index/types.ts`（脚本内部类型，re-export 共享类型）

**Interfaces:**
- Produces: `KbIndexFile` / `KbIndex`（见 Global Constraints 契约）；
  `scanKb(kbRoot: string): ScanEntry[]`，其中
  `interface ScanEntry { sourcePath: string; productLine: string; product: string; title: string; ext: string }`。
  只扫这些扩展名：`.docx .docm .pptx .xlsx .xls .pdf .txt`；跳过 `.DS_Store`、`~$` 开头的临时文件、`.png/.mp4/.drawio/.xmind`（媒体在转换阶段处理）。

- [ ] **Step 1: 写共享类型文件**

`apps/desktop/src/shared/kbIndex.ts`：
```ts
// 知识库索引产物契约。阶段 A 脚本产出、阶段 B app 消费，两端共享此文件。
export interface KbIndexFile {
  sourcePath: string
  mirrorPath: string
  productLine: string
  product: string
  title: string
  mtimeMs: number
  sha1: string
  assets: string[]
  ok: boolean
  error?: string
}

export interface KbIndex {
  version: 1
  kbRoot: string
  builtAtMs: number
  files: KbIndexFile[]
}
```

- [ ] **Step 2: 写扫描器**

`scripts/kb-index/scan.ts`：
```ts
import { readdirSync, statSync } from 'node:fs'
import { join, extname, basename, relative, sep } from 'node:path'

export interface ScanEntry {
  sourcePath: string
  productLine: string
  product: string
  title: string
  ext: string
}

const ALLOWED = new Set(['.docx', '.docm', '.pptx', '.xlsx', '.xls', '.pdf', '.txt'])

function walk(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === '.DS_Store' || name.startsWith('~$')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, acc)
    else acc.push(full)
  }
}

export function scanKb(kbRoot: string): ScanEntry[] {
  const files: string[] = []
  walk(kbRoot, files)
  const out: ScanEntry[] = []
  for (const sourcePath of files) {
    const ext = extname(sourcePath).toLowerCase()
    if (!ALLOWED.has(ext)) continue
    // 相对 kbRoot 的路径段：第一段=产品线，第二段（若存在）=产品
    const rel = relative(kbRoot, sourcePath).split(sep)
    const productLine = rel[0] ?? ''
    const product = rel.length > 2 ? rel[1] : ''
    out.push({
      sourcePath,
      productLine,
      product,
      title: basename(sourcePath, ext),
      ext
    })
  }
  return out
}
```

- [ ] **Step 3: smoke 跑真实知识库，核对分类**

Run:
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun -e 'import {scanKb} from "./scripts/kb-index/scan.ts"; const e=scanKb("/Users/kika/Desktop/fusion方案资料/福鑫数科产品线资料库"); console.log("count=",e.length); console.log(e.find(x=>x.title.includes("智能导诊")||x.productLine.includes("患者服务")));'
```
Expected: `count=` 约 250+（312 文件减去 png/mp4/drawio/xmind/DS_Store）；打印出的样本 `productLine` 应是 `01AI患者服务`，`product` 形如 `1_智能导诊系统`。

- [ ] **Step 4: typecheck**

Run: `bun run typecheck:node`
Expected: PASS（新增 shared 类型与脚本不报错）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/kbIndex.ts scripts/kb-index/scan.ts scripts/kb-index/types.ts
git commit -m "feat(kb-index): 知识库目录扫描与索引产物类型"
```

---

### Task 2: 单文件转换（markitdown 主力 + LibreOffice 兜底）

**Files:**
- Create: `scripts/kb-index/convert.ts`
- Test（smoke）：用知识库里任一 docx

**Interfaces:**
- Consumes: `ScanEntry`（Task 1）
- Produces: `convertFile(entry: ScanEntry, outDir: string): Promise<ConvertResult>`，
  `interface ConvertResult { markdown: string; assets: string[]; ok: boolean; error?: string }`。
  转换工具优先 `markitdown <src> -o <tmp.md>`（同时把内嵌图片导到 `<outDir>/assets/<title>/`）；失败则 `soffice --headless --convert-to "txt:Text" --outdir <tmp> <src>` 兜底；`.txt` 直接读原文。

- [ ] **Step 1: 写转换器**

`scripts/kb-index/convert.ts`：
```ts
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { ScanEntry } from './scan.ts'

export interface ConvertResult {
  markdown: string
  assets: string[]
  ok: boolean
  error?: string
}

function tryMarkitdown(src: string, assetsDir: string): { md: string; assets: string[] } {
  // markitdown 把文档转 markdown 到 stdout；--keep-data-uris 关闭，改用 -o 落盘可控
  mkdirSync(assetsDir, { recursive: true })
  const md = execFileSync('markitdown', [src], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  // markitdown 当前版本不单独导图；内嵌图以 data-uri 形式留在 md 里，
  // 由 Task 3 统一抽取落盘。这里 assets 先返回空。
  return { md, assets: [] }
}

function tryLibreOffice(src: string, tmpDir: string): string {
  mkdirSync(tmpDir, { recursive: true })
  execFileSync('soffice', [
    '--headless', '--convert-to', 'txt:Text', '--outdir', tmpDir, src
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const base = basename(src).replace(/\.[^.]+$/, '.txt')
  const out = join(tmpDir, base)
  return existsSync(out) ? readFileSync(out, 'utf8') : ''
}

export async function convertFile(entry: ScanEntry, outDir: string): Promise<ConvertResult> {
  const assetsDir = join(outDir, 'assets', `${entry.productLine}__${entry.product}__${entry.title}`)
  if (entry.ext === '.txt') {
    return { markdown: readFileSync(entry.sourcePath, 'utf8'), assets: [], ok: true }
  }
  try {
    const { md, assets } = tryMarkitdown(entry.sourcePath, assetsDir)
    if (md.trim().length > 0) return { markdown: md, assets, ok: true }
    throw new Error('markitdown 输出为空')
  } catch (e) {
    try {
      const txt = tryLibreOffice(entry.sourcePath, join(outDir, '.tmp'))
      if (txt.trim().length > 0) return { markdown: txt, assets: [], ok: true }
      return { markdown: '', assets: [], ok: false, error: 'markitdown+soffice 均失败/空' }
    } catch (e2) {
      return { markdown: '', assets: [], ok: false, error: String(e2) }
    }
  }
}
```

- [ ] **Step 2: 校验依赖已装 + smoke 转一个 docx**

Run:
```bash
command -v markitdown || pip install markitdown
command -v soffice || echo "需手动装 LibreOffice (brew install --cask libreoffice)"
cd /Users/kika/Desktop/project/Electron/claude-desktop
SRC=$(bun -e 'import {scanKb} from "./scripts/kb-index/scan.ts"; const e=scanKb("/Users/kika/Desktop/fusion方案资料/福鑫数科产品线资料库").find(x=>x.ext===".docx"); console.log(e.sourcePath)')
bun -e "import {convertFile} from './scripts/kb-index/convert.ts'; import {scanKb} from './scripts/kb-index/scan.ts'; const e=scanKb('/Users/kika/Desktop/fusion方案资料/福鑫数科产品线资料库').find(x=>x.ext==='.docx'); const r=await convertFile(e,'/tmp/kbtest'); console.log('ok=',r.ok,'len=',r.markdown.length); console.log(r.markdown.slice(0,200));"
```
Expected: `ok= true`，`len=` 数千以上，打印出该 docx 的中文正文开头（证明转换真的拿到了文字，不是乱码）。

- [ ] **Step 3: typecheck**

Run: `bun run typecheck:node`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/kb-index/convert.ts
git commit -m "feat(kb-index): docx/pptx/xlsx/pdf 转 markdown（markitdown 主力 + soffice 兜底）"
```

---

### Task 3: 媒体资产抽取（从转换结果里把图落盘）

**Files:**
- Create: `scripts/kb-index/assets.ts`
- Modify: `scripts/kb-index/convert.ts`（接入 assets 抽取）

**Interfaces:**
- Consumes: `convertFile` 的 markdown 字符串
- Produces: `extractDataUriImages(markdown: string, assetsDir: string): { markdown: string; assets: string[] }`——
  把 markdown 里的 `data:image/...;base64,xxx` 内嵌图写成 `assetsDir/img-<n>.<ext>` 文件，并把引用替换成相对路径。返回改写后的 markdown 和落盘资产绝对路径数组。

- [ ] **Step 1: 写资产抽取**

`scripts/kb-index/assets.ts`：
```ts
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_URI = /data:image\/(png|jpeg|jpg|gif|svg\+xml);base64,([A-Za-z0-9+/=]+)/g

export function extractDataUriImages(
  markdown: string,
  assetsDir: string
): { markdown: string; assets: string[] } {
  const assets: string[] = []
  let n = 0
  const out = markdown.replace(DATA_URI, (_m, fmt: string, b64: string) => {
    const ext = fmt === 'svg+xml' ? 'svg' : fmt === 'jpeg' ? 'jpg' : fmt
    if (assets.length === 0) mkdirSync(assetsDir, { recursive: true })
    const file = join(assetsDir, `img-${++n}.${ext}`)
    writeFileSync(file, Buffer.from(b64, 'base64'))
    assets.push(file)
    return file // 用绝对路径引用，app 侧再转相对/file://
  })
  return { markdown: out, assets }
}
```

- [ ] **Step 2: 在 convert.ts 接入**

修改 `scripts/kb-index/convert.ts`，在 markitdown 成功分支后调用：
```ts
import { extractDataUriImages } from './assets.ts'
// ...tryMarkitdown 成功后：
const { md } = tryMarkitdown(entry.sourcePath, assetsDir)
const extracted = extractDataUriImages(md, assetsDir)
if (extracted.markdown.trim().length > 0)
  return { markdown: extracted.markdown, assets: extracted.assets, ok: true }
```

- [ ] **Step 3: smoke 验证抽图**

Run:
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun -e "import {convertFile} from './scripts/kb-index/convert.ts'; import {scanKb} from './scripts/kb-index/scan.ts'; const cands=scanKb('/Users/kika/Desktop/fusion方案资料/福鑫数科产品线资料库').filter(x=>x.ext==='.docx'); for(const e of cands.slice(0,5)){const r=await convertFile(e,'/tmp/kbtest'); console.log(e.title,'ok=',r.ok,'assets=',r.assets.length);}"
```
Expected: 5 个文件至少有部分 `assets= >0`（含图的方案文档抽出了图片文件），全部 `ok= true`。

- [ ] **Step 4: typecheck**

Run: `bun run typecheck:node`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/kb-index/assets.ts scripts/kb-index/convert.ts
git commit -m "feat(kb-index): 从转换结果抽取内嵌图片落盘为媒体资产"
```

---

### Task 4: 索引主流程 + 增量构建（build-kb-index.ts 入口）

**Files:**
- Create: `scripts/build-kb-index.ts`（CLI 入口）
- Modify: `apps/desktop/package.json`（加 `kb:index` script）

**Interfaces:**
- Consumes: `scanKb`、`convertFile`、`KbIndex`/`KbIndexFile`
- Produces: 命令 `bun run kb:index -- --kb <kbRoot> --out <outDir>`；落盘
  `<outDir>/index.json`（`KbIndex`）+ `<outDir>/<productLine>/<product>/<title>.md` 文本镜像 +
  `<outDir>/assets/...`。**增量**：读已存在的 `index.json`，源文件 sha1 未变则跳过转换、沿用旧记录。

- [ ] **Step 1: 写入口脚本**

`scripts/build-kb-index.ts`：
```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { scanKb } from './kb-index/scan.ts'
import { convertFile } from './kb-index/convert.ts'
import type { KbIndex, KbIndexFile } from '../apps/desktop/src/shared/kbIndex.ts'

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  if (fallback !== undefined) return fallback
  throw new Error(`缺少参数 --${name}`)
}

function sha1OfFile(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

async function main(): Promise<void> {
  const kbRoot = arg('kb')
  const outDir = arg('out')
  const builtAtMs = Number(arg('now', String(0))) // 调用方传时间戳；脚本不调 Date.now

  const prevByPath = new Map<string, KbIndexFile>()
  const indexPath = join(outDir, 'index.json')
  if (existsSync(indexPath)) {
    const prev = JSON.parse(readFileSync(indexPath, 'utf8')) as KbIndex
    for (const f of prev.files) prevByPath.set(f.sourcePath, f)
  }

  const entries = scanKb(kbRoot)
  const files: KbIndexFile[] = []
  let converted = 0, skipped = 0, failed = 0

  for (const e of entries) {
    const st = statSync(e.sourcePath)
    const sha1 = sha1OfFile(e.sourcePath)
    const prev = prevByPath.get(e.sourcePath)
    if (prev && prev.sha1 === sha1 && prev.ok && existsSync(prev.mirrorPath)) {
      files.push(prev); skipped++; continue
    }
    const mirrorPath = join(outDir, e.productLine, e.product, `${e.title}.md`)
    const r = await convertFile(e, outDir)
    if (r.ok) {
      mkdirSync(dirname(mirrorPath), { recursive: true })
      writeFileSync(mirrorPath, r.markdown, 'utf8')
      converted++
    } else { failed++ }
    files.push({
      sourcePath: e.sourcePath, mirrorPath, productLine: e.productLine,
      product: e.product, title: e.title, mtimeMs: st.mtimeMs, sha1,
      assets: r.assets, ok: r.ok, error: r.error
    })
    process.stdout.write(`\r转换 ${converted} 跳过 ${skipped} 失败 ${failed} / ${entries.length}`)
  }

  const index: KbIndex = { version: 1, kbRoot, builtAtMs, files }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
  console.log(`\n完成：${files.length} 文件，失败 ${failed}。index.json → ${indexPath}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: 加 package.json script**

`apps/desktop/package.json` 的 `scripts` 加（注意 `kb:index` 放根更顺手，但脚本在根 `scripts/`，故加在根 `package.json`）：

改根 `package.json` 的 `scripts`：
```json
"kb:index": "bun scripts/build-kb-index.ts"
```

- [ ] **Step 3: 全量跑一次真实知识库（耗时，3GB）**

Run:
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run kb:index -- --kb "/Users/kika/Desktop/fusion方案资料/福鑫数科产品线资料库" --out /tmp/kb-index --now 1750000000000
```
Expected: 进度跑完，末行 `完成：250+ 文件，失败 <小数字>`；`/tmp/kb-index/index.json` 存在且 `jq '.files | length'` 与计数一致。

- [ ] **Step 4: 验证增量（再跑一次应几乎全跳过）**

Run:
```bash
bun run kb:index -- --kb "/Users/kika/Desktop/fusion方案资料/福鑫数科产品线资料库" --out /tmp/kb-index --now 1750000001000
```
Expected: 末行 `跳过` 数 ≈ 文件总数，`转换 0`（除非有失败项重试）。

- [ ] **Step 5: typecheck + Commit**

Run: `bun run typecheck:node` → PASS
```bash
git add scripts/build-kb-index.ts package.json
git commit -m "feat(kb-index): 索引主流程入口 + 增量构建 + kb:index 命令"
```

---

## 阶段 B：应用内方案写作功能

### Task 5: 知识库路径与索引就绪状态（设置项 + IPC）

**Files:**
- Modify: `apps/desktop/src/shared/ipc-channels.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`
- Modify: `apps/desktop/src/main/ipc/register.ts`
- Create: `apps/desktop/src/main/core/kbIndexStore.ts`（main 侧读 index.json + 落盘 KB 路径配置）

**Interfaces:**
- Produces 三条 IPC：
  - `KB_PATH_GET` → `Promise<{ kbRoot: string | null; outDir: string }>`
  - `KB_PATH_SET` → `(kbRoot: string) => Promise<void>`（落盘到 main config）
  - `KB_INDEX_READ` → `Promise<KbIndex | null>`（读 `outDir/index.json`，无则 null）
  - `outDir` 固定为 `join(app.getPath('userData'), 'kb-index')`。

- [ ] **Step 1: 加通道常量**

`apps/desktop/src/shared/ipc-channels.ts` 加（沿用文件里 `'域:动作'` 风格）：
```ts
KB_PATH_GET: 'kb:path-get',
KB_PATH_SET: 'kb:path-set',
KB_INDEX_READ: 'kb:index-read',
```
并在该文件的 `ChatApi` interface 加方法签名：
```ts
getKbPath(): Promise<{ kbRoot: string | null; outDir: string }>
setKbPath(kbRoot: string): Promise<void>
readKbIndex(): Promise<import('./kbIndex').KbIndex | null>
```

- [ ] **Step 2: 写 main 侧 kbIndexStore**

`apps/desktop/src/main/core/kbIndexStore.ts`：
```ts
import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { KbIndex } from '../../shared/kbIndex'

const configPath = (): string => join(app.getPath('userData'), 'kb-config.json')
export const kbOutDir = (): string => join(app.getPath('userData'), 'kb-index')

export function getKbRoot(): string | null {
  const p = configPath()
  if (!existsSync(p)) return null
  try { return (JSON.parse(readFileSync(p, 'utf8')).kbRoot as string) ?? null }
  catch { return null }
}

export function setKbRoot(kbRoot: string): void {
  writeFileSync(configPath(), JSON.stringify({ kbRoot }), 'utf8')
}

export function readKbIndex(): KbIndex | null {
  const p = join(kbOutDir(), 'index.json')
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as KbIndex } catch { return null }
}
```

- [ ] **Step 3: 注册 handler**

`apps/desktop/src/main/ipc/register.ts` 的 `registerIpcHandlers` 内加：
```ts
import { getKbRoot, setKbRoot, readKbIndex, kbOutDir } from '../core/kbIndexStore'
// ...
ipcMain.handle(IPC_CHANNELS.KB_PATH_GET, async () => ({ kbRoot: getKbRoot(), outDir: kbOutDir() }))
ipcMain.handle(IPC_CHANNELS.KB_PATH_SET, async (_e, kbRoot: string) => { setKbRoot(kbRoot) })
ipcMain.handle(IPC_CHANNELS.KB_INDEX_READ, async () => readKbIndex())
```

- [ ] **Step 4: preload 暴露 + 类型**

`apps/desktop/src/preload/index.ts` 的 chatApi 对象加：
```ts
getKbPath: () => ipcRenderer.invoke(IPC_CHANNELS.KB_PATH_GET),
setKbPath: (kbRoot: string) => ipcRenderer.invoke(IPC_CHANNELS.KB_PATH_SET, kbRoot),
readKbIndex: () => ipcRenderer.invoke(IPC_CHANNELS.KB_INDEX_READ),
```
`apps/desktop/src/preload/index.d.ts`：确认 `ChatApi` 类型来自 ipc-channels（Step 1 已加签名），无需重复。

- [ ] **Step 5: typecheck + Commit**

Run: `bun run typecheck`（node + web 都跑，验证四件套类型贯通）
Expected: PASS
```bash
git add apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/preload/index.ts apps/desktop/src/preload/index.d.ts apps/desktop/src/main/ipc/register.ts apps/desktop/src/main/core/kbIndexStore.ts
git commit -m "feat(proposal): 知识库路径配置与 index.json 读取 IPC"
```

---

### Task 6: 方案会话状态 store（产品选择 + 章节骨架 + 文档草稿）

**Files:**
- Create: `apps/desktop/src/renderer/src/stores/proposal.ts`
- Create: `apps/desktop/src/renderer/src/constants/proposalTemplates.ts`

**Interfaces:**
- Produces:
  ```ts
  // proposalTemplates.ts —— 写死的章节骨架
  export interface ProposalTemplate { key: string; title: string; sections: string[] }
  export const PROPOSAL_TEMPLATE: ProposalTemplate // 单一通用建设方案骨架（MVP 一个就够）
  // proposal.ts
  interface ProposalState {
    active: boolean
    productLine: string | null
    product: string | null
    docMarkdown: string                 // 右侧文档当前内容（用户可改）
    start: (productLine: string, product: string) => void
    setDoc: (md: string) => void
    appendSection: (heading: string, body: string) => void
    reset: () => void
  }
  export const useProposalStore: ... // zustand
  ```

- [ ] **Step 1: 写章节模板常量**

`apps/desktop/src/renderer/src/constants/proposalTemplates.ts`：
```ts
// MVP 写死一套通用建设方案骨架。进阶再按产品线分化/做成可配置。
export interface ProposalTemplate {
  key: string
  title: string
  sections: string[]
}

export const PROPOSAL_TEMPLATE: ProposalTemplate = {
  key: 'construction',
  title: '建设方案',
  sections: ['建设背景', '需求与现状分析', '系统目标与定位', '总体方案与架构', '系统功能', '建设价值与成效']
}
```

- [ ] **Step 2: 写 proposal store**

`apps/desktop/src/renderer/src/stores/proposal.ts`：
```ts
import { create } from 'zustand'

interface ProposalState {
  active: boolean
  productLine: string | null
  product: string | null
  docMarkdown: string
  start: (productLine: string, product: string) => void
  setDoc: (md: string) => void
  appendSection: (heading: string, body: string) => void
  reset: () => void
}

export const useProposalStore = create<ProposalState>((set) => ({
  active: false,
  productLine: null,
  product: null,
  docMarkdown: '',
  start: (productLine, product) =>
    set({ active: true, productLine, product, docMarkdown: '' }),
  setDoc: (md) => set({ docMarkdown: md }),
  appendSection: (heading, body) =>
    set((s) => ({ docMarkdown: `${s.docMarkdown}\n\n## ${heading}\n\n${body}`.trimStart() })),
  reset: () => set({ active: false, productLine: null, product: null, docMarkdown: '' })
}))
```

- [ ] **Step 3: typecheck + Commit**

Run: `bun run typecheck:web` → PASS
```bash
git add apps/desktop/src/renderer/src/stores/proposal.ts apps/desktop/src/renderer/src/constants/proposalTemplates.ts
git commit -m "feat(proposal): 方案会话状态 store 与章节模板常量"
```

---

### Task 7: "写方案"入口卡 + 产品选择对话框

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/chat/ScenarioQuickStart.tsx`
- Create: `apps/desktop/src/renderer/src/components/dialogs/ProductPickerDialog.tsx`
- Modify: `apps/desktop/src/renderer/src/i18n.ts`（加 scenarioProposal* 三个 key，zh + en）

**Interfaces:**
- Consumes: `chatApi.readKbIndex()`（Task 5）、`useProposalStore.start`（Task 6）、`PROPOSAL_TEMPLATE`、`useTodosStore.setTodos`
- Produces: 点"写方案"卡 → 打开 `ProductPickerDialog`；选定产品 → 调 `start()` + 用 `PROPOSAL_TEMPLATE.sections` 给当前 session `setTodos` 播种章节进度 + 把首段引导 prompt `composer.setText()`。

- [ ] **Step 1: 加 i18n key**

`apps/desktop/src/renderer/src/i18n.ts` 的 `zh` 与 `en` 各加：
```ts
// zh
scenarioProposalTitle: '写方案',
scenarioProposalDesc: '基于公司知识库，对话式生成建设方案草稿',
scenarioProposalPrompt: '我要写一份关于 [产品] 的建设方案。请严格基于知识库资料，从「建设背景」开始，一段一段地问我要点并起草，每段标注来源文件；知识库里查不到的内容请标“⚠️ 资料缺失”，不要编造。',
// en（对应英文，从略，实现时按同结构补）
```

- [ ] **Step 2: 写产品选择对话框**

`apps/desktop/src/renderer/src/components/dialogs/ProductPickerDialog.tsx`：
```tsx
import { useEffect, useState } from 'react'
import type { KbIndex } from '../../../../shared/kbIndex'

interface Props {
  open: boolean
  onClose: () => void
  onPick: (productLine: string, product: string) => void
}

export function ProductPickerDialog({ open, onClose, onPick }: Props): React.JSX.Element | null {
  const [index, setIndex] = useState<KbIndex | null>(null)
  useEffect(() => {
    if (open) void window.chatApi.readKbIndex().then(setIndex)
  }, [open])
  if (!open) return null

  // 从 index.files 聚合「产品线 → 产品集合」
  const tree = new Map<string, Set<string>>()
  for (const f of index?.files ?? []) {
    if (!tree.has(f.productLine)) tree.set(f.productLine, new Set())
    if (f.product) tree.get(f.productLine)!.add(f.product)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="max-h-[70vh] w-[480px] overflow-auto rounded-xl bg-neutral-900 p-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-sm font-semibold text-neutral-200">选择产品</h2>
        {!index && <p className="text-xs text-neutral-400">尚未建立知识库索引，请先在设置里配置路径并运行 kb:index。</p>}
        {[...tree.entries()].map(([line, products]) => (
          <div key={line} className="mb-2">
            <div className="text-xs text-neutral-500">{line}</div>
            {[...products].map((p) => (
              <button key={p} className="block w-full rounded px-2 py-1 text-left text-sm text-neutral-200 hover:bg-neutral-800"
                onClick={() => { onPick(line, p); onClose() }}>
                {p}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: ScenarioQuickStart 加卡 + 接对话框**

在 `SCENARIO_CARDS` 加一项 `{ key:'proposal', iconClass:'from-sky-500/20 to-sky-500/5 text-sky-400', icon:<DocIcon/>, titleKey:'scenarioProposalTitle', descKey:'scenarioProposalDesc', promptKey:'scenarioProposalPrompt' }`，并在组件内：
```tsx
import { ProductPickerDialog } from '../dialogs/ProductPickerDialog'
import { useProposalStore } from '../../stores/proposal'
import { useTodosStore } from '../../stores/todos'
import { PROPOSAL_TEMPLATE } from '../../constants/proposalTemplates'
import { useChatStore } from '../../stores/chat' // 取 activeSessionId（实现时确认 store 名）
// proposal 卡点击：不直接 setText，先开对话框
const [pickerOpen, setPickerOpen] = useState(false)
const startProposal = useProposalStore((s) => s.start)
const setTodos = useTodosStore((s) => s.setTodos)
const onPickProduct = (line: string, product: string) => {
  startProposal(line, product)
  const sessionId = /* 当前活动 sessionId */ ''
  setTodos(sessionId, PROPOSAL_TEMPLATE.sections.map((sec) => ({
    content: `撰写「${sec}」`, activeForm: `正在撰写「${sec}」`, status: 'pending'
  })))
  composer.setText(t('scenarioProposalPrompt').replace('[产品]', product))
  queueMicrotask(() => document.querySelector<HTMLElement>('.ProseMirror')?.focus())
}
// 渲染：proposal 卡的 onClick = () => setPickerOpen(true)；末尾挂 <ProductPickerDialog .../>
```
> 实现注意：当前活动 sessionId 的来源在实现时按现有 store 确认（报告未覆盖 chat store 的 activeSessionId 字段名，执行此任务时先 grep `activeSessionId` 定位）。

- [ ] **Step 4: typecheck + 手动运行**

Run: `bun run typecheck:web` → PASS
Run: `bun run dev`，确认侧栏出现"写方案"卡，点击弹出产品选择，选一个产品后 composer 出现引导 prompt、右侧 todos 出现 6 个章节。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat/ScenarioQuickStart.tsx apps/desktop/src/renderer/src/components/dialogs/ProductPickerDialog.tsx apps/desktop/src/renderer/src/i18n.ts
git commit -m "feat(proposal): 写方案入口卡 + 产品选择对话框 + 章节进度播种"
```

---

### Task 8: 方案专家系统提示词 + 镜像目录作为额外可读目录

**Files:**
- Modify: `apps/desktop/src/main/core/engine.ts`（openSession 的 systemPrompt.append 与 SDK 选项）
- Create: `apps/desktop/src/main/core/proposalPrompt.ts`（提示词常量 + 拼装函数）

**Interfaces:**
- Consumes: `kbOutDir()`（Task 5）、当前是否处于方案模式的信号
- Produces: `buildProposalAppend(mirrorDir: string): string`；engine 在方案会话里把它拼到现有中文 append 之后，并把 `mirrorDir` 加进 SDK 的额外可读目录选项（`additionalDirectories` / `add-dir`，实现时按 SDK 版本确认字段名）。
- **不变量**：cwd 不变，仅"扩大可读范围 + 告知绝对路径"。

- [ ] **Step 1: 写提示词常量**

`apps/desktop/src/main/core/proposalPrompt.ts`：
```ts
// 方案写作模式的系统提示词追加段。底线：只用知识库、绝不臆想。
export function buildProposalAppend(mirrorDir: string): string {
  return [
    '【方案写作模式】你正在帮用户撰写商业建设方案。严格遵守以下纪律：',
    `1. 公司知识库的文本镜像在目录：${mirrorDir}。撰写任何内容前，先用 Grep/Glob/Read 在该目录内检索相关资料，只依据检索到的原文撰写。`,
    '2. 绝不使用你自身的知识或想象来填补内容。知识库里查不到的，明确写「⚠️ 资料缺失：<缺什么>」，不要编造。',
    '3. 每写完一段，标注来源文件，格式：（据《<文件名>》）。',
    '4. 按章节逐段推进，一次只聚焦一个章节，先问用户该章节的关键要点，再起草。',
    '5. 全程中文。'
  ].join('\n')
}
```

- [ ] **Step 2: engine 接入（方案会话拼接 append + 加可读目录）**

`apps/desktop/src/main/core/engine.ts` 的 openSession：在已有 `systemPrompt.append`（中文指令）基础上，方案模式时追加 `buildProposalAppend(kbOutDir())`；并在 sdkOptions 里把 `kbOutDir()` 加入额外可读目录。方案模式的开关：新增一条 IPC `PROPOSAL_MODE_SET`（按四件套加）或在 send 时透传 flag——实现时选其一，最小改动优先用 send payload 透传。
```ts
// 伪代码（实现时贴合 openSession 现有结构）：
const baseAppend = '始终用中文回复。...'
const append = this.proposalMode
  ? `${baseAppend}\n\n${buildProposalAppend(kbOutDir())}`
  : baseAppend
const sdkOptions = {
  cwd: this.getWorkingDirectory(),       // 不变量：cwd 不动
  additionalDirectories: this.proposalMode ? [kbOutDir()] : undefined, // 字段名按 SDK 版本确认
  systemPrompt: { type: 'preset', preset: 'claude_code', append },
  // ...
}
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck:node` → PASS

- [ ] **Step 4: 手动验证"不臆想"**

Run: `bun run dev`，进入方案模式，先选一个知识库里**确实有**的产品（如智能导诊）让它写"建设背景"，确认正文带"（据《…》）"来源；再要求它写一段知识库里**没有**的内容（如某个不存在的产品指标），确认它回"⚠️ 资料缺失"而非编造。
Expected: 两种行为都符合。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/core/engine.ts apps/desktop/src/main/core/proposalPrompt.ts
git commit -m "feat(proposal): 方案专家系统提示词 + 镜像目录作为额外可读目录（不动 cwd 不变量）"
```

---

### Task 9: 右侧方案文档面板（轻量 Markdown 可编辑预览）

**Files:**
- Create: `apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx`
- Modify: `apps/desktop/src/renderer/src/App.tsx`（在右侧 row 挂载，按 proposal.active 显隐）

**Interfaces:**
- Consumes: `useProposalStore`（docMarkdown / setDoc / active）、`AssistantMarkdown`
- Produces: 一个右侧面板：上方"编辑/预览"切换；编辑态是 `<textarea>` 绑定 `docMarkdown`，预览态用 `<AssistantMarkdown text={docMarkdown}/>`。仅当 `proposal.active` 为真时渲染。

- [ ] **Step 1: 写面板组件**

`apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx`：
```tsx
import { useState } from 'react'
import { useProposalStore } from '../../stores/proposal'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'

export function ProposalDocPanel(): React.JSX.Element | null {
  const active = useProposalStore((s) => s.active)
  const doc = useProposalStore((s) => s.docMarkdown)
  const setDoc = useProposalStore((s) => s.setDoc)
  const [editing, setEditing] = useState(false)
  if (!active) return null
  return (
    <div className="flex w-96 flex-col border-l border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between px-3 py-2 text-xs text-neutral-400">
        <span>方案草稿</span>
        <button className="rounded px-2 py-0.5 hover:bg-neutral-800"
          onClick={() => setEditing((v) => !v)}>{editing ? '预览' : '编辑'}</button>
      </div>
      <div className="flex-1 overflow-auto p-3">
        {editing
          ? <textarea className="h-full w-full resize-none bg-transparent text-[13px] text-neutral-200 outline-none"
              value={doc} onChange={(e) => setDoc(e.target.value)} />
          : <AssistantMarkdown text={doc || '_等待 AI 起草…_'} />}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 挂载到 App.tsx**

`apps/desktop/src/renderer/src/App.tsx` 右侧 flex row 里，`TodoListPanel` 之后加 `<ProposalDocPanel />`（组件自身按 active 决定是否渲染，不破坏现有布局）。

- [ ] **Step 3: typecheck + 手动验证**

Run: `bun run typecheck:web` → PASS
Run: `bun run dev`，进入方案模式后右侧出现"方案草稿"面板，编辑/预览切换正常；普通会话（非方案模式）该面板不出现。

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx apps/desktop/src/renderer/src/App.tsx
git commit -m "feat(proposal): 右侧方案文档面板（Markdown 编辑/预览）"
```

---

### Task 10: AI 草稿落入文档面板（拦截助手输出累积到 docMarkdown）

**Files:**
- Modify: `apps/desktop/src/renderer/src/runtime/`（FusionRuntimeProvider，报告 Task 2 提到它拦截 tool_use；实现时 grep 定位文件）

**Interfaces:**
- Consumes: 助手每轮完成的文本（与 TodoWrite 同一拦截点）
- Produces: 方案模式下，把助手每条 assistant 文本消息 `appendSection` 或整体 `setDoc` 进 proposal store。MVP 用最简策略：每当助手完成一条消息，若处于 `proposal.active`，把该消息全文追加到 docMarkdown。

- [ ] **Step 1: 在 runtime 拦截点接入**

在 FusionRuntimeProvider 处理 assistant 消息完成的地方加：
```ts
import { useProposalStore } from '../stores/proposal'
// 助手一条消息 done 时：
if (useProposalStore.getState().active) {
  const text = /* 该 assistant 消息纯文本 */ ''
  if (text.trim()) useProposalStore.getState().setDoc(
    `${useProposalStore.getState().docMarkdown}\n\n${text}`.trimStart()
  )
}
```
> 实现注意：拦截点与"取一条 assistant 消息纯文本"的方式按 runtime 现有代码确认（与 TodoWrite 拦截在同一文件）。MVP 接受"全文追加"，进阶再做按章节归位。

- [ ] **Step 2: typecheck + 手动验证端到端**

Run: `bun run typecheck:web` → PASS
Run: `bun run dev`，走完整流程：写方案卡 → 选产品 → AI 逐段起草 → 右侧文档面板实时累积出带来源标注的草稿。

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(proposal): AI 草稿实时落入右侧方案文档面板"
```

---

### Task 11: 导出 Markdown（可扩展格式适配层）

**Files:**
- Modify: `apps/desktop/src/shared/ipc-channels.ts` / `preload/index.ts` / `preload/index.d.ts` / `main/ipc/register.ts`（加 `PROPOSAL_EXPORT` 一条 IPC）
- Create: `apps/desktop/src/main/core/proposalExport.ts`（格式适配层，MVP 仅 markdown adapter）
- Modify: `ProposalDocPanel.tsx`（加"导出"按钮）

**Interfaces:**
- Produces: IPC `PROPOSAL_EXPORT` → `(payload: { markdown: string; format: 'md' }) => Promise<{ path: string | null }>`；
  main 侧 `exportProposal(markdown, format)`：弹原生保存对话框 → 写文件 → 返回路径。`format` 为联合类型，MVP 只实现 `'md'`，Word/PDF 留进阶往同一 switch 加 adapter。

- [ ] **Step 1: 写导出适配层**

`apps/desktop/src/main/core/proposalExport.ts`：
```ts
import { dialog, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'

export type ExportFormat = 'md' // 进阶加 'docx' | 'pdf'

export async function exportProposal(
  win: BrowserWindow, markdown: string, format: ExportFormat
): Promise<{ path: string | null }> {
  const filters = format === 'md' ? [{ name: 'Markdown', extensions: ['md'] }] : []
  const r = await dialog.showSaveDialog(win, { filters, defaultPath: '方案草稿.md' })
  if (r.canceled || !r.filePath) return { path: null }
  // MVP：md 直接落盘。进阶按 format 走不同 adapter（markdown→docx/pdf）。
  writeFileSync(r.filePath, markdown, 'utf8')
  return { path: r.filePath }
}
```

- [ ] **Step 2: 加 IPC 四件套**

按 Global Constraints 四件套加 `PROPOSAL_EXPORT: 'proposal:export'`，preload 暴露 `exportProposal(payload)`，d.ts/ChatApi 加签名，register.ts：
```ts
import { exportProposal } from '../core/proposalExport'
ipcMain.handle(IPC_CHANNELS.PROPOSAL_EXPORT, async (e, payload: { markdown: string; format: 'md' }) => {
  const win = BrowserWindow.fromWebContents(e.sender)!
  return exportProposal(win, payload.markdown, payload.format)
})
```

- [ ] **Step 3: 面板加导出按钮**

`ProposalDocPanel.tsx` 头部加：
```tsx
<button className="rounded px-2 py-0.5 hover:bg-neutral-800"
  onClick={() => window.chatApi.exportProposal({ markdown: doc, format: 'md' })}>导出</button>
```

- [ ] **Step 4: typecheck + 手动验证**

Run: `bun run typecheck` → PASS
Run: `bun run dev`，点导出 → 原生保存框 → 选位置 → 生成的 .md 内容与面板一致。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(proposal): 导出 Markdown（可扩展格式适配层，Word/PDF 留进阶）"
```

---

## Self-Review 记录

- **Spec 覆盖**：底线"只用知识库/不臆想"→ Task 8 提示词 + Task 8 Step 4 验证；预转换+索引+媒体资产+增量 → Task 1-4；产品=模板分类 → Task 6/7；对话向导 → Task 7/8/10；章节进度=todos → Task 7；右侧轻量编辑 → Task 9；导出 md（可扩展）→ Task 11；镜像放 userData → Task 5（kbOutDir）。三个进阶功能的地基（源路径映射/媒体资产/可限范围）已在 index.json 契约与 Task 3/8 预留。✅
- **占位符**：无 TBD/TODO 式空步骤；每个代码步骤给了完整代码。两处显式标注"实现时按现有代码确认字段名"（activeSessionId、runtime 拦截点、SDK additionalDirectories 字段）——这是对未被探查覆盖的现有代码的诚实标注，非占位符。
- **类型一致**：`KbIndex`/`KbIndexFile` 全程一致；`useProposalStore` 的 action 名（start/setDoc/appendSection/reset）在 Task 6 定义、Task 7/9/10 使用一致；`exportProposal(win, markdown, format)` 签名一致。
- **无测试框架**：遵循 CLAUDE.md，未引入 vitest；纯逻辑（阶段 A）用真实数据 smoke 跑 + 核对输出，UI 用 typecheck + 手动运行。

## 已知前置依赖（执行前需就绪）

- `markitdown`（`pip install markitdown`）、`soffice`（LibreOffice，兜底用）需在开发机可用。
- 全量索引一次 3GB 资料较耗时，建议首次在后台跑。
