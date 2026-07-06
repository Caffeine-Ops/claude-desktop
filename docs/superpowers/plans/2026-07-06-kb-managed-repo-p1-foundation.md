# 知识库托管仓库 P1（底座）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 KB 构建管线从仓库脚本搬进桌面应用，并落地托管仓库（`userData/kb-store/`）的文档 CRUD 核心与后台构建 worker——为 P2 管理页提供全部 main 侧能力。

**Architecture:** 三步走：① `scripts/kb-index/` 的 scan/convert/assets/embed 提升为 `apps/desktop/src/main/core/kbBuild/` 共享模块（脚本改薄包装，服务器流水线不变）；② 新增 electron-free 的 `kbStore` 执行层（目录注入、bun 可测）做导入/删除/移动/分类管理；③ 新增 `kbBuildWorker`（utilityProcess）+ `kbBuildRunner`（单飞行+尾随）让任何写操作后自动增量构建，构建成功后重置 embedWorker 消除 stale。

**Tech Stack:** Electron utilityProcess、@huggingface/transformers（已有依赖）、bun test、electron-vite 多入口。

**Spec:** `docs/superpowers/specs/2026-07-06-kb-managed-repository-design.md`

**后续计划（不在本计划内）：** P2 = IPC 面 + 管理页 UI + 只读模式 + 旧 kbRoot 迁移引导；P3 = 发布 diff/上传 + 服务器上传服务 + 部署手册增补。

## Global Constraints

- 包管理器是 **bun**，不是 npm；测试跑 `cd apps/desktop && bun test src/`。
- `bun run typecheck`（在 `apps/desktop/` 下）是唯一质量门，每个 task 结束必须绿。
- 注释风格：解释「为什么这样而不是那样」，不写「做了什么」。
- **绝不允许 `execFileSync` / 模型加载落在 main 进程**——转换与向量化只能跑在 utilityProcess 或命令行脚本里。
- `kbSemanticSearch.ts` 的顺序不变量（ready/stale 检查先于 postMessage）与 exit 三态复位不可破坏。
- 向量产物对齐不变量：vectors.bin 行 i ↔ vectors-meta.rows[i]，fingerprint 绑 `KbIndex.builtAtMs`。
- 服务器命令行流水线（`bun scripts/build-kb-index.ts --kb … --out … --now …`）的 CLI 参数与行为必须保持不变。

---

### Task 1: shared 类型升级——KbIndex v3 字段 + KbConfig.mode

**Files:**
- Modify: `apps/desktop/src/shared/kbIndex.ts`
- Modify: `apps/desktop/src/shared/kbConfig.ts`
- Test: `apps/desktop/src/shared/kbConfig.test.ts`（新建）

**Interfaces:**
- Produces: `KbIndexFile.importedAtMs?: number`、`KbIndexFile.sizeBytes?: number`、`KbIndex.version: 2 | 3`；`KbConfig.mode: 'managed' | 'remote' | null`、`parseKbConfig` 对 mode 的防御解析。后续所有 task 依赖这些类型。

- [ ] **Step 1: 写失败测试**（`apps/desktop/src/shared/kbConfig.test.ts`）

```ts
import { describe, expect, test } from 'bun:test'
import { parseKbConfig } from './kbConfig'

describe('parseKbConfig mode 字段', () => {
  test('合法 mode 透传', () => {
    expect(parseKbConfig('{"mode":"managed"}').mode).toBe('managed')
    expect(parseKbConfig('{"mode":"remote"}').mode).toBe('remote')
  })
  test('非法/缺失 mode 退 null，不连坐其他字段', () => {
    expect(parseKbConfig('{"mode":"banana","kbRoot":"/a"}')).toEqual({
      mode: null, kbRoot: '/a', remote: null
    })
    expect(parseKbConfig('{"kbRoot":"/a"}').mode).toBeNull()
    expect(parseKbConfig(null).mode).toBeNull()
    expect(parseKbConfig('not json').mode).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/shared/kbConfig.test.ts`
Expected: FAIL（`mode` 属性不存在 / toEqual 不匹配）

- [ ] **Step 3: 实现**

`kbConfig.ts` 改动（接口加字段 + 解析加三行）：

```ts
export type KbMode = 'managed' | 'remote'

export interface KbConfig {
  /** null = 未配置/旧版配置（P2 迁移引导消费）。managed=主编机可写，remote=只读同步。 */
  mode: KbMode | null
  /** 旧「本地文件夹」模式的根目录。已废弃，仅保留读取供 P2 一次性迁移引导。 */
  kbRoot: string | null
  remote: KbRemoteConfig | null
}
```

`parseKbConfig` 中 `empty` 改为 `{ mode: null, kbRoot: null, remote: null }`，并在 kbRoot 解析行旁加：

```ts
  const mode = o.mode === 'managed' || o.mode === 'remote' ? o.mode : null
```

返回 `{ mode, kbRoot, remote }`。

`kbIndex.ts` 改动：

```ts
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
  /** v3：首次入库时间。重转不刷新；同路径覆盖导入时由 build 以 now 重置。缺失（v2 索引）UI 显示「—」。 */
  importedAtMs?: number
  /** v3：原件字节数。缺失（v2 索引）UI 显示「—」。 */
  sizeBytes?: number
}

export interface KbIndex {
  // v3：新增 importedAtMs/sizeBytes（可选字段）。读取端对 v2 完全兼容——
  // 消费方不判 version 只读字段，缺失字段按「无数据」渲染，因此不做 stale 处理。
  version: 2 | 3
  kbRoot: string
  builtAtMs: number
  files: KbIndexFile[]
}
```

- [ ] **Step 4: 跑测试 + typecheck**

Run: `cd apps/desktop && bun test src/shared/kbConfig.test.ts && bun run typecheck`
Expected: 测试 PASS；typecheck 绿（`build-kb-index.ts` 写 `version: 2` 仍满足 `2 | 3`）。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shared/kbIndex.ts apps/desktop/src/shared/kbConfig.ts apps/desktop/src/shared/kbConfig.test.ts
git commit -m "feat(kb): KbIndex v3 可选字段 + KbConfig.mode——托管仓库类型底座"
```

---

### Task 2: 管线搬家（scan/assets/convert → kbBuild/）

**Files:**
- Move: `scripts/kb-index/scan.ts` → `apps/desktop/src/main/core/kbBuild/scan.ts`
- Move: `scripts/kb-index/assets.ts` → `apps/desktop/src/main/core/kbBuild/assets.ts`
- Move: `scripts/kb-index/convert.ts` → `apps/desktop/src/main/core/kbBuild/convert.ts`
- Modify: `scripts/build-kb-index.ts`（import 路径）、`scripts/kb-index/types.ts`（re-export 路径）、`scripts/kb-index/embed.ts`（不动，Task 3 处理）

**Interfaces:**
- Produces: `kbBuild/scan.ts` 导出 `scanKb(kbRoot: string): ScanEntry[]` 与 `interface ScanEntry`；`kbBuild/convert.ts` 导出 `convertFile(entry: ScanEntry, outDir: string): Promise<ConvertResult>`；`kbBuild/assets.ts` 导出 `extractDataUriImages(markdown, assetsDir)`。逻辑零改动，只动 import。

- [ ] **Step 1: git mv 三个文件**

```bash
mkdir -p apps/desktop/src/main/core/kbBuild
git mv scripts/kb-index/scan.ts apps/desktop/src/main/core/kbBuild/scan.ts
git mv scripts/kb-index/assets.ts apps/desktop/src/main/core/kbBuild/assets.ts
git mv scripts/kb-index/convert.ts apps/desktop/src/main/core/kbBuild/convert.ts
```

- [ ] **Step 2: 修 import（tsconfig.node.json 作用域内不允许 .ts 扩展名）**

`kbBuild/convert.ts` 顶部两行改为：

```ts
import type { ScanEntry } from './scan'
import { extractDataUriImages } from './assets'
```

`scripts/build-kb-index.ts` 的两行改为（bun 跑脚本支持无扩展名解析）：

```ts
import { scanKb } from '../apps/desktop/src/main/core/kbBuild/scan'
import { convertFile } from '../apps/desktop/src/main/core/kbBuild/convert'
```

`scripts/kb-index/types.ts` 的 ScanEntry re-export 改为：

```ts
export type { ScanEntry } from '../../apps/desktop/src/main/core/kbBuild/scan'
```

- [ ] **Step 3: 全量验证**

Run: `cd apps/desktop && bun run typecheck && bun test src/ && cd ../.. && bun test scripts/`
Expected: 全绿（manifest.test.ts 不受影响；移动文件无逻辑改动）。

- [ ] **Step 4: 冒烟——脚本还能跑**

Run: `mkdir -p /tmp/kb-smoke/线A && printf 'hello kb' > /tmp/kb-smoke/线A/a.txt && bun scripts/build-kb-index.ts --kb /tmp/kb-smoke --out /tmp/kb-smoke-out --now $(date +%s)000`
Expected: 输出「转换完成：1 文件，失败 0」后进入向量化（可 Ctrl-C 中断——向量化联网拉模型不属于本 task 验证面）。`/tmp/kb-smoke-out/线A/a.txt.md` 存在。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(kb): scan/assets/convert 搬进 kbBuild/——桌面端与脚本共用一套管线"
```

---

### Task 3: embed 搬家 + buildKbIndex 函数化（脚本变薄包装）

**Files:**
- Move: `scripts/kb-index/embed.ts` → `apps/desktop/src/main/core/kbBuild/embed.ts`
- Create: `apps/desktop/src/main/core/kbBuild/build.ts`
- Modify: `scripts/build-kb-index.ts`（改薄包装）
- Test: `apps/desktop/src/main/core/kbBuild/build.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `scanKb`/`convertFile`；Task 1 的 v3 字段。
- Produces:

```ts
// build.ts
export interface BuildProgress { phase: 'convert' | 'vectors'; done: number; total: number }
export interface BuildVectorsOpt { localModelPath?: string; modelName?: string }
export interface BuildOptions {
  kbRoot: string
  outDir: string
  now: number
  /** false = 跳过向量化（模型不可用/测试）。跳过后旧 vectors fingerprint 与新 builtAtMs 不符 → embedWorker 自然 stale → BM25 降级，自洽。 */
  vectors: BuildVectorsOpt | false
  onProgress?: (p: BuildProgress) => void
  log?: (line: string) => void
}
export async function buildKbIndex(opts: BuildOptions): Promise<KbIndex>
// embed.ts（搬家后签名，新增 modelName）
export async function buildVectors(files: KbIndexFile[], outDir: string, builtAtMs: number, localModelPath?: string, modelName?: string): Promise<void>
```

- [ ] **Step 1: 写失败测试**（`build.test.ts`）

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildKbIndex } from './build'
import type { KbIndex } from '../../../shared/kbIndex'

function fixture(): { root: string; out: string } {
  const base = mkdtempSync(join(tmpdir(), 'kbbuild-'))
  const root = join(base, 'store')
  mkdirSync(join(root, '智慧水务', '平台A'), { recursive: true })
  writeFileSync(join(root, '智慧水务', '平台A', '方案.txt'), '这是方案正文', 'utf8')
  return { root, out: join(base, 'out') }
}

describe('buildKbIndex', () => {
  test('全量构建：v3 索引 + 镜像 + importedAtMs/sizeBytes', async () => {
    const { root, out } = fixture()
    const idx = await buildKbIndex({ kbRoot: root, outDir: out, now: 1000, vectors: false })
    expect(idx.version).toBe(3)
    expect(idx.files).toHaveLength(1)
    const f = idx.files[0]!
    expect(f.ok).toBe(true)
    expect(f.importedAtMs).toBe(1000)
    expect(f.sizeBytes).toBeGreaterThan(0)
    expect(f.productLine).toBe('智慧水务')
    expect(f.product).toBe('平台A')
    expect(existsSync(f.mirrorPath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')) as KbIndex
    expect(onDisk.files).toHaveLength(1)
  })

  test('增量：未变文件跳过且 importedAtMs 保留；删除的文件从索引消失', async () => {
    const { root, out } = fixture()
    await buildKbIndex({ kbRoot: root, outDir: out, now: 1000, vectors: false })
    writeFileSync(join(root, '智慧水务', '平台A', '新增.txt'), '第二篇', 'utf8')
    const idx2 = await buildKbIndex({ kbRoot: root, outDir: out, now: 2000, vectors: false })
    const old = idx2.files.find((f) => f.title === '方案')!
    expect(old.importedAtMs).toBe(1000) // 未变文件保留首次入库时间
    expect(idx2.files.find((f) => f.title === '新增')!.importedAtMs).toBe(2000)
    rmSync(join(root, '智慧水务', '平台A', '新增.txt'))
    const idx3 = await buildKbIndex({ kbRoot: root, outDir: out, now: 3000, vectors: false })
    expect(idx3.files.map((f) => f.title)).toEqual(['方案'])
  })

  test('内容不变仅 touch：走 sha1 快路径仍跳过', async () => {
    const { root, out } = fixture()
    const p = join(root, '智慧水务', '平台A', '方案.txt')
    const idx1 = await buildKbIndex({ kbRoot: root, outDir: out, now: 1000, vectors: false })
    utimesSync(p, new Date(9999999), new Date(9999999))
    const idx2 = await buildKbIndex({ kbRoot: root, outDir: out, now: 2000, vectors: false })
    expect(idx2.files[0]!.importedAtMs).toBe(1000)
    expect(idx2.files[0]!.sha1).toBe(idx1.files[0]!.sha1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/main/core/kbBuild/build.test.ts`
Expected: FAIL（`./build` 模块不存在）

- [ ] **Step 3: 搬 embed + 写 build.ts**

```bash
git mv scripts/kb-index/embed.ts apps/desktop/src/main/core/kbBuild/embed.ts
```

`kbBuild/embed.ts` 顶部 import 改为：

```ts
import { chunkTextWithOffsets } from '../proposalRetrieve.core'
import type { KbIndexFile, VectorMeta, VectorStoreMeta } from '../../../shared/kbIndex'
```

`buildVectors` 追加第五参 `modelName?: string`，并把 `pipeline` 行改为（打包进 app 的模型目录是 `kb-model/bge-small-zh-v1.5/`——**没有 Xenova 前缀**，与脚本用的 HF 缓存布局不同，所以模型名必须可注入）：

```ts
export async function buildVectors(
  files: KbIndexFile[],
  outDir: string,
  builtAtMs: number,
  localModelPath?: string,
  modelName?: string
): Promise<void> {
  // …env 设置段与原来一致…
  const extractor = await pipeline('feature-extraction', modelName ?? `Xenova/${MODEL_ID}`, { dtype: 'q8' })
```

新建 `kbBuild/build.ts`——把 `scripts/build-kb-index.ts` 的 `main()` 主体函数化，逐字保留增量注释，差异只有四处：CLI 参数改 opts、stdout 改 onProgress/log 回调、v3 字段、vectors 可跳过：

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { scanKb } from './scan'
import { convertFile } from './convert'
import { buildVectors } from './embed'
import type { KbIndex, KbIndexFile } from '../../../shared/kbIndex'

export interface BuildProgress { phase: 'convert' | 'vectors'; done: number; total: number }
export interface BuildVectorsOpt { localModelPath?: string; modelName?: string }
export interface BuildOptions {
  kbRoot: string
  outDir: string
  now: number
  vectors: BuildVectorsOpt | false
  onProgress?: (p: BuildProgress) => void
  log?: (line: string) => void
}

function sha1OfFile(path: string): string {
  return createHash('sha1').update(readFileSync(path)).digest('hex')
}

/**
 * 全库增量构建（原 scripts/build-kb-index.ts 主体）。增量三前提与镜像唯一键
 * 的注释原样保留在对应代码行。vectors:false 时跳过向量化——旧 vectors 的
 * fingerprint 与新 builtAtMs 不符，embedWorker 会报 stale 降级 BM25，不会读到
 * 幽灵行；模型就绪后下一轮构建自动补齐。
 */
export async function buildKbIndex(opts: BuildOptions): Promise<KbIndex> {
  const { kbRoot, outDir, now } = opts
  const prevByPath = new Map<string, KbIndexFile>()
  const indexPath = join(outDir, 'index.json')
  if (existsSync(indexPath)) {
    try {
      const prev = JSON.parse(readFileSync(indexPath, 'utf8')) as KbIndex
      for (const f of prev.files) prevByPath.set(f.sourcePath, f)
    } catch {
      // 半截 index.json（上次构建中断）→ 当全量构建，不抛
    }
  }

  const entries = scanKb(kbRoot)
  const files: KbIndexFile[] = []
  let converted = 0, skipped = 0, failed = 0

  for (const e of entries) {
    const st = statSync(e.sourcePath)
    const prev = prevByPath.get(e.sourcePath)
    const mirrorPath = `${join(outDir, e.relPath)}.md`
    // 快路径：mtime 未变且上次成功且路径一致且镜像还在 → 信任旧 sha1，跳过读文件
    if (prev && prev.ok && prev.mtimeMs === st.mtimeMs && prev.mirrorPath === mirrorPath && existsSync(prev.mirrorPath)) {
      files.push(prev); skipped++; continue
    }
    const sha1 = sha1OfFile(e.sourcePath)
    if (prev && prev.sha1 === sha1 && prev.ok && prev.mirrorPath === mirrorPath && existsSync(prev.mirrorPath)) {
      files.push(prev); skipped++; continue
    }
    const r = await convertFile(e, outDir)
    if (r.ok) {
      mkdirSync(dirname(mirrorPath), { recursive: true })
      writeFileSync(mirrorPath, r.markdown, 'utf8')
      converted++
    } else { failed++ }
    files.push({
      sourcePath: e.sourcePath, mirrorPath, productLine: e.productLine,
      product: e.product, title: e.title, mtimeMs: st.mtimeMs, sha1,
      assets: r.assets, ok: r.ok, error: r.error,
      // v3：重转不改「首次入库时间」；只有全新路径（或同路径覆盖后 prev 被内容判失效
      // 仍存在——此时保留 prev 值即「同路径覆盖刷新时间」交给 kbStore 删旧条目实现）取 now
      importedAtMs: prev?.importedAtMs ?? now,
      sizeBytes: st.size
    })
    opts.onProgress?.({ phase: 'convert', done: converted + skipped + failed, total: entries.length })
  }

  const index: KbIndex = { version: 3, kbRoot, builtAtMs: now, files }
  mkdirSync(outDir, { recursive: true })
  // tmp+rename：构建中途被杀不能留半截 index.json（读取端虽防御，但坏文件会
  // 让下一轮增量退化全量）。点开头 tmp 名同时保证 manifest walk 永远收不进它。
  const tmp = join(outDir, '.index.json.tmp')
  writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8')
  renameSync(tmp, indexPath)
  opts.log?.(`转换完成：${files.length} 文件，失败 ${failed}`)

  if (opts.vectors !== false) {
    opts.onProgress?.({ phase: 'vectors', done: 0, total: 1 })
    await buildVectors(files, outDir, now, opts.vectors.localModelPath, opts.vectors.modelName)
    opts.onProgress?.({ phase: 'vectors', done: 1, total: 1 })
  }
  return index
}
```

注意：原 `build-kb-index.ts` 写的是 `version: 2` 直写文件——`importedAtMs` 沿袭语义见代码注释；`renameSync` 是新增的原子化（spec §8 写序不变量），旧脚本直写属于既有瑕疵，趁函数化一并修。

- [ ] **Step 4: scripts/build-kb-index.ts 改薄包装（CLI 完全不变）**

整文件替换为：

```ts
import { buildKbIndex } from '../apps/desktop/src/main/core/kbBuild/build'

// CLI 契约冻结：--kb --out --now 三参与既有 cron/部署手册一字不差（Global Constraints）。
function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!
  throw new Error(`缺少参数 --${name}`)
}

const now = Number(arg('now')) // 必填：脚本不调 Date.now，缺失直接抛而非静默写 0（1970）
if (!Number.isFinite(now)) throw new Error('--now 必须是毫秒时间戳')

buildKbIndex({
  kbRoot: arg('kb'),
  outDir: arg('out'),
  now,
  vectors: {}, // 服务器/本机脚本：allowRemoteModels=true，允许拉取并缓存模型（embed.ts 缺省行为）
  onProgress: (p) =>
    process.stdout.write(p.phase === 'convert' ? `\r转换 ${p.done}/${p.total}` : `\r向量化…`),
  log: (line) => console.log(`\n${line}`)
}).catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 5: 跑测试 + typecheck**

Run: `cd apps/desktop && bun test src/main/core/kbBuild/build.test.ts && bun run typecheck`
Expected: 3 个测试 PASS；typecheck 绿。

- [ ] **Step 6: 冒烟脚本（同 Task 2 Step 4 的命令重跑一次）**

Run: `bun scripts/build-kb-index.ts --kb /tmp/kb-smoke --out /tmp/kb-smoke-out2 --now $(date +%s)000`
Expected: 转换段行为与原脚本一致；index.json 里 `"version": 3` 且条目带 `importedAtMs`/`sizeBytes`。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(kb): buildKbIndex 函数化+embed 搬家——app 内可调、脚本薄包装、index 原子落盘"
```

---

### Task 4: kbStore.core 纯核（路径规划/冲突/校验/移动改写）

**Files:**
- Create: `apps/desktop/src/main/core/kbStore.core.ts`
- Test: `apps/desktop/src/main/core/kbStore.core.test.ts`

**Interfaces:**
- Produces（Task 5/P2 依赖，签名冻结）：

```ts
export function validateSegmentName(name: string): string | null // null=合法，否则中文错误消息
export function docRelPath(productLine: string, product: string, fileName: string): string
export interface ImportPlanItem { fileName: string; relPath: string; conflict: boolean }
export function planImport(fileNames: string[], productLine: string, product: string, existing: ReadonlySet<string>): ImportPlanItem[]
export function moveRelPath(relPath: string, toProductLine: string, toProduct: string, newFileName?: string): string
export interface KbDocPaths { sourcePath: string; mirrorPath: string; assetsDir: string; productLine: string; product: string; title: string }
export function docPaths(relPath: string, storeDir: string, outDir: string): KbDocPaths
export function rewriteMovedIndexFile(f: KbIndexFile, oldRelPath: string, newRelPath: string, storeDir: string, outDir: string): KbIndexFile
```

- [ ] **Step 1: 写失败测试**（`kbStore.core.test.ts`）

```ts
import { describe, expect, test } from 'bun:test'
import { join, sep } from 'node:path'
import {
  validateSegmentName, docRelPath, planImport, moveRelPath, docPaths, rewriteMovedIndexFile
} from './kbStore.core'
import type { KbIndexFile } from '../../shared/kbIndex'

describe('validateSegmentName', () => {
  test('合法名通过', () => {
    expect(validateSegmentName('智慧水务')).toBeNull()
    expect(validateSegmentName('平台 A-2.0')).toBeNull()
  })
  test('非法名给中文错误', () => {
    expect(validateSegmentName('')).toContain('不能为空')
    expect(validateSegmentName('  ')).toContain('不能为空')
    expect(validateSegmentName('a/b')).toContain('分隔符')
    expect(validateSegmentName('a\\b')).toContain('分隔符')
    expect(validateSegmentName('.隐藏')).toContain('点')      // dotfile 会被 scan/manifest 静默跳过
    expect(validateSegmentName('..')).toContain('点')          // 路径穿越
    expect(validateSegmentName('~$草稿')).toContain('~$')      // scan 跳过 Office 锁文件前缀
  })
})

describe('docRelPath / planImport', () => {
  test('两级与一级归属', () => {
    expect(docRelPath('线', '品', 'a.docx')).toBe(join('线', '品', 'a.docx'))
    expect(docRelPath('线', '', 'a.docx')).toBe(join('线', 'a.docx'))
  })
  test('冲突按 existing 集合标记', () => {
    const existing = new Set([join('线', '品', '旧.docx')])
    const plan = planImport(['旧.docx', '新.docx'], '线', '品', existing)
    expect(plan).toEqual([
      { fileName: '旧.docx', relPath: join('线', '品', '旧.docx'), conflict: true },
      { fileName: '新.docx', relPath: join('线', '品', '新.docx'), conflict: false }
    ])
  })
})

describe('moveRelPath / docPaths / rewriteMovedIndexFile', () => {
  test('移动改分类保留文件名，可改名', () => {
    const from = join('线A', '品1', '方案.docx')
    expect(moveRelPath(from, '线B', '')).toBe(join('线B', '方案.docx'))
    expect(moveRelPath(from, '线B', '品2', '新名.docx')).toBe(join('线B', '品2', '新名.docx'))
  })
  test('docPaths 与构建管线的路径派生完全同源', () => {
    const p = docPaths(join('线', '品', '方案.docx'), '/store', '/out')
    expect(p.sourcePath).toBe(join('/store', '线', '品', '方案.docx'))
    expect(p.mirrorPath).toBe(`${join('/out', '线', '品', '方案.docx')}.md`)
    expect(p.assetsDir).toBe(join('/out', 'assets', '线', '品', '方案.docx'))
    expect(p.productLine).toBe('线')
    expect(p.product).toBe('品')
    expect(p.title).toBe('方案')
  })
  test('rewriteMovedIndexFile 全字段改写且 assets 前缀替换', () => {
    const oldRel = join('线A', '方案.docx')
    const newRel = join('线B', '品', '方案.docx')
    const f: KbIndexFile = {
      sourcePath: join('/s', oldRel), mirrorPath: `${join('/o', oldRel)}.md`,
      productLine: '线A', product: '', title: '方案', mtimeMs: 1, sha1: 'x',
      assets: [join('/o', 'assets', oldRel, 'img-1.png')], ok: true,
      importedAtMs: 5, sizeBytes: 9
    }
    const r = rewriteMovedIndexFile(f, oldRel, newRel, '/s', '/o')
    expect(r.sourcePath).toBe(join('/s', newRel))
    expect(r.mirrorPath).toBe(`${join('/o', newRel)}.md`)
    expect(r.productLine).toBe('线B')
    expect(r.product).toBe('品')
    expect(r.assets).toEqual([join('/o', 'assets', newRel, 'img-1.png')])
    expect(r.sha1).toBe('x')          // 内容没变
    expect(r.importedAtMs).toBe(5)    // 移动不是重新入库
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/main/core/kbStore.core.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**（`kbStore.core.ts`）

```ts
/**
 * 托管仓库纯核：路径规划 / 冲突检测 / 名称校验 / 移动时的索引条目改写。
 * electron-free、零 IO——执行层（kbStore.ts）与 P2 的 IPC 面都只消费这里的结论。
 *
 * relPath 是全库唯一键（与 scan.ts 同一约定：OS 分隔符、含扩展名），
 * 镜像/资产路径的派生公式必须与 kbBuild/build.ts 逐字一致——两处失同步
 * 的代价是移动后的文档被下一轮构建当新文件全量重转。
 */
import { join, sep, basename, extname } from 'node:path'
import type { KbIndexFile } from '../../shared/kbIndex'

/** null=合法。校验规则对齐 scan/manifest 的静默跳过项：dotfile、~$ 前缀进不了索引，必须挡在入口。 */
export function validateSegmentName(name: string): string | null {
  if (!name.trim()) return '名称不能为空'
  if (name.includes('/') || name.includes('\\')) return '名称不能包含路径分隔符'
  if (name.startsWith('.')) return '名称不能以点开头（会被扫描与同步静默跳过）'
  if (name.startsWith('~$')) return '名称不能以 ~$ 开头（会被当作 Office 锁文件跳过）'
  return null
}

export function docRelPath(productLine: string, product: string, fileName: string): string {
  return product ? join(productLine, product, fileName) : join(productLine, fileName)
}

export interface ImportPlanItem { fileName: string; relPath: string; conflict: boolean }

export function planImport(
  fileNames: string[], productLine: string, product: string, existing: ReadonlySet<string>
): ImportPlanItem[] {
  return fileNames.map((fileName) => {
    const relPath = docRelPath(productLine, product, fileName)
    return { fileName, relPath, conflict: existing.has(relPath) }
  })
}

export function moveRelPath(
  relPath: string, toProductLine: string, toProduct: string, newFileName?: string
): string {
  return docRelPath(toProductLine, toProduct, newFileName ?? basename(relPath))
}

export interface KbDocPaths {
  sourcePath: string
  mirrorPath: string
  assetsDir: string
  productLine: string
  product: string
  title: string
}

/** 派生公式与 kbBuild 逐字同源：mirror=<out>/<relPath>.md，assets=<out>/assets/<relPath>。 */
export function docPaths(relPath: string, storeDir: string, outDir: string): KbDocPaths {
  const segs = relPath.split(sep)
  return {
    sourcePath: join(storeDir, relPath),
    mirrorPath: `${join(outDir, relPath)}.md`,
    assetsDir: join(outDir, 'assets', relPath),
    productLine: segs[0] ?? '',
    product: segs.length > 2 ? (segs[1] ?? '') : '',
    title: basename(relPath, extname(relPath))
  }
}

/** 移动=改键不改内容：sha1/mtime/importedAtMs 原样保留，路径派生字段全部按新键重算。 */
export function rewriteMovedIndexFile(
  f: KbIndexFile, oldRelPath: string, newRelPath: string, storeDir: string, outDir: string
): KbIndexFile {
  const np = docPaths(newRelPath, storeDir, outDir)
  const op = docPaths(oldRelPath, storeDir, outDir)
  return {
    ...f,
    sourcePath: np.sourcePath,
    mirrorPath: np.mirrorPath,
    productLine: np.productLine,
    product: np.product,
    title: np.title,
    assets: f.assets.map((a) => (a.startsWith(op.assetsDir) ? np.assetsDir + a.slice(op.assetsDir.length) : a))
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/desktop && bun test src/main/core/kbStore.core.test.ts && bun run typecheck`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/core/kbStore.core.ts apps/desktop/src/main/core/kbStore.core.test.ts
git commit -m "feat(kb): kbStore 纯核——导入规划/冲突/名称校验/移动改写，与构建管线路径同源"
```

---

### Task 5: kbStore 执行层（目录注入的文件操作 + index 改写）

**Files:**
- Create: `apps/desktop/src/main/core/kbStore.ts`
- Test: `apps/desktop/src/main/core/kbStore.test.ts`

**Interfaces:**
- Consumes: Task 4 全部纯核函数；Task 3 的镜像布局约定。
- Produces（P2 的 IPC handler 直接调用）：

```ts
export interface KbStoreDirs { storeDir: string; outDir: string }
export interface ImportRequest { srcPath: string; fileName: string }
export interface ImportResult { imported: string[]; conflicted: string[] } // 均为 relPath
export function importDocs(dirs: KbStoreDirs, reqs: ImportRequest[], productLine: string, product: string, overwrite: boolean): ImportResult
export function deleteDoc(dirs: KbStoreDirs, relPath: string): void
export function moveDoc(dirs: KbStoreDirs, relPath: string, toProductLine: string, toProduct: string, newFileName?: string): string // 返回新 relPath；目标已存在时 throw
export function createCategory(dirs: KbStoreDirs, productLine: string, product?: string): void
export function renameCategory(dirs: KbStoreDirs, prefix: string, newName: string): { moved: number } // prefix='线' 或 '线/品'（OS sep）
export function deleteCategory(dirs: KbStoreDirs, prefix: string): { deletedDocs: number }
export function listStoreRelPaths(dirs: KbStoreDirs): Set<string> // planImport 的 existing 来源
```

行为要点（实现与测试都要覆盖）：
- 删除/移动**同步改写 index.json**（tmp+rename），镜像与 assets 一并搬/删——不等下一轮构建，管理页立即一致；向量收敛靠调用方随后 scheduleKbBuild()（Task 6）。
- `importDocs` 只拷原件不动 index（新条目由构建产生）；同路径覆盖时**先 deleteDoc 旧条目再拷**——保证 build 侧 `prev` 消失、`importedAtMs` 取新 now（Task 3 注释里预留的语义）。
- index.json 缺失/损坏时删除/移动仍要完成文件操作（index 视为空表），不抛。

- [ ] **Step 1: 写失败测试**（`kbStore.test.ts`，用 mkdtemp 三目录夹具）

```ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildKbIndex } from './kbBuild/build'
import {
  importDocs, deleteDoc, moveDoc, createCategory, renameCategory, deleteCategory, listStoreRelPaths,
  type KbStoreDirs
} from './kbStore'
import type { KbIndex } from '../../shared/kbIndex'

async function fixture(): Promise<{ dirs: KbStoreDirs; src: string }> {
  const base = mkdtempSync(join(tmpdir(), 'kbstore-'))
  const dirs = { storeDir: join(base, 'store'), outDir: join(base, 'out') }
  const src = join(base, 'inbox')
  mkdirSync(src, { recursive: true })
  mkdirSync(join(dirs.storeDir, '线A', '品1'), { recursive: true })
  writeFileSync(join(dirs.storeDir, '线A', '品1', '方案.txt'), '正文', 'utf8')
  await buildKbIndex({ kbRoot: dirs.storeDir, outDir: dirs.outDir, now: 1000, vectors: false })
  return { dirs, src }
}

const readIndex = (dirs: KbStoreDirs): KbIndex =>
  JSON.parse(readFileSync(join(dirs.outDir, 'index.json'), 'utf8')) as KbIndex

describe('kbStore 执行层', () => {
  test('importDocs：新文件拷入、冲突跳过、overwrite 覆盖并清旧条目', async () => {
    const { dirs, src } = await fixture()
    writeFileSync(join(src, '方案.txt'), '新版本', 'utf8')
    writeFileSync(join(src, '白皮书.txt'), '白皮书', 'utf8')
    const r1 = importDocs(dirs, [
      { srcPath: join(src, '方案.txt'), fileName: '方案.txt' },
      { srcPath: join(src, '白皮书.txt'), fileName: '白皮书.txt' }
    ], '线A', '品1', false)
    expect(r1.conflicted).toEqual([join('线A', '品1', '方案.txt')])
    expect(r1.imported).toEqual([join('线A', '品1', '白皮书.txt')])
    expect(readFileSync(join(dirs.storeDir, '线A', '品1', '方案.txt'), 'utf8')).toBe('正文') // 未覆盖

    const r2 = importDocs(dirs, [{ srcPath: join(src, '方案.txt'), fileName: '方案.txt' }], '线A', '品1', true)
    expect(r2.imported).toHaveLength(1)
    expect(readFileSync(join(dirs.storeDir, '线A', '品1', '方案.txt'), 'utf8')).toBe('新版本')
    // 覆盖导入 = 先删旧 index 条目：下一轮构建把它当新文件、importedAtMs 取新 now
    expect(readIndex(dirs).files).toHaveLength(0)
  })

  test('deleteDoc：原件+镜像+index 条目一起消失', async () => {
    const { dirs } = await fixture()
    const rel = join('线A', '品1', '方案.txt')
    deleteDoc(dirs, rel)
    expect(existsSync(join(dirs.storeDir, rel))).toBe(false)
    expect(existsSync(`${join(dirs.outDir, rel)}.md`)).toBe(false)
    expect(readIndex(dirs).files).toHaveLength(0)
  })

  test('moveDoc：三处路径搬家 + index 条目改写，目标已存在则 throw', async () => {
    const { dirs } = await fixture()
    const rel = join('线A', '品1', '方案.txt')
    const newRel = moveDoc(dirs, rel, '线B', '')
    expect(newRel).toBe(join('线B', '方案.txt'))
    expect(existsSync(join(dirs.storeDir, newRel))).toBe(true)
    expect(existsSync(`${join(dirs.outDir, newRel)}.md`)).toBe(true)
    const f = readIndex(dirs).files[0]!
    expect(f.productLine).toBe('线B')
    expect(f.importedAtMs).toBe(1000) // 移动不是重新入库
    expect(() => moveDoc(dirs, newRel, '线B', '', '方案.txt')).toThrow() // 原地移动=目标已存在
  })

  test('分类：create/rename/delete 贯通且 index 跟随', async () => {
    const { dirs } = await fixture()
    createCategory(dirs, '线C', '品X')
    expect(existsSync(join(dirs.storeDir, '线C', '品X'))).toBe(true)
    const { moved } = renameCategory(dirs, '线A', '线甲')
    expect(moved).toBe(1)
    expect(readIndex(dirs).files[0]!.productLine).toBe('线甲')
    expect(listStoreRelPaths(dirs).has(join('线甲', '品1', '方案.txt'))).toBe(true)
    const { deletedDocs } = deleteCategory(dirs, '线甲')
    expect(deletedDocs).toBe(1)
    expect(existsSync(join(dirs.storeDir, '线甲'))).toBe(false)
    expect(readIndex(dirs).files).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/main/core/kbStore.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**（`kbStore.ts`）

```ts
/**
 * 托管仓库执行层：真实文件操作 + index.json 同步改写。
 * electron-free（目录经 KbStoreDirs 注入，kbIndexStore 在 main 侧提供真实值）——
 * 与 kbSync 同一可测性哲学：bun test 用 mkdtemp 直测，不 mock fs。
 *
 * 一致性分工：本层负责「原件/镜像/assets/index 条目」四者的即时一致；
 * vectors.bin 的收敛不归本层管——调用方在写操作后 scheduleKbBuild()（kbBuildRunner），
 * 构建以 store 现状为准重算全库分块表。在那之前 embedWorker 因 fingerprint
 * 不符自动 stale→BM25 降级，不会读到已删文档的幽灵行。
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { KbIndex, KbIndexFile } from '../../shared/kbIndex'
import { docPaths, docRelPath, moveRelPath, planImport, rewriteMovedIndexFile } from './kbStore.core'

export interface KbStoreDirs { storeDir: string; outDir: string }
export interface ImportRequest { srcPath: string; fileName: string }
export interface ImportResult { imported: string[]; conflicted: string[] }

/** index.json 读-改-写。缺失/损坏当空表：文件操作的成败不能被索引状态绑架。 */
function readIndexOrNull(dirs: KbStoreDirs): KbIndex | null {
  const p = join(dirs.outDir, 'index.json')
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as KbIndex } catch { return null }
}

function writeIndex(dirs: KbStoreDirs, index: KbIndex): void {
  // tmp+rename 与 kbBuild/build.ts 同款：任何时刻崩溃不留半截 index.json
  const tmp = join(dirs.outDir, '.index.json.tmp')
  mkdirSync(dirs.outDir, { recursive: true })
  writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8')
  renameSync(tmp, join(dirs.outDir, 'index.json'))
}

function updateIndex(dirs: KbStoreDirs, fn: (files: KbIndexFile[]) => KbIndexFile[]): void {
  const idx = readIndexOrNull(dirs)
  if (!idx) return // 索引还没建过：无条目可改，构建时会全量生成
  writeIndex(dirs, { ...idx, files: fn(idx.files) })
}

export function listStoreRelPaths(dirs: KbStoreDirs): Set<string> {
  const out = new Set<string>()
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name.startsWith('~$')) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.add(relative(dirs.storeDir, full))
    }
  }
  walk(dirs.storeDir)
  return out
}

export function importDocs(
  dirs: KbStoreDirs, reqs: ImportRequest[], productLine: string, product: string, overwrite: boolean
): ImportResult {
  const existing = listStoreRelPaths(dirs)
  const plan = planImport(reqs.map((r) => r.fileName), productLine, product, existing)
  const imported: string[] = []
  const conflicted: string[] = []
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i]!
    if (item.conflict && !overwrite) { conflicted.push(item.relPath); continue }
    // 覆盖导入 = 先删旧条目与旧产物再拷：build 侧 prev 消失 → 该文件按「全新入库」
    // 处理，importedAtMs 取本轮 now（「覆盖刷新入库时间」的语义在这里落地）
    if (item.conflict) deleteDoc(dirs, item.relPath)
    const dest = join(dirs.storeDir, item.relPath)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(reqs[i]!.srcPath, dest)
    imported.push(item.relPath)
  }
  return { imported, conflicted }
}

export function deleteDoc(dirs: KbStoreDirs, relPath: string): void {
  const p = docPaths(relPath, dirs.storeDir, dirs.outDir)
  rmSync(p.sourcePath, { force: true })
  rmSync(p.mirrorPath, { force: true })
  rmSync(p.assetsDir, { recursive: true, force: true })
  updateIndex(dirs, (files) => files.filter((f) => f.sourcePath !== p.sourcePath))
}

export function moveDoc(
  dirs: KbStoreDirs, relPath: string, toProductLine: string, toProduct: string, newFileName?: string
): string {
  const newRel = moveRelPath(relPath, toProductLine, toProduct, newFileName)
  const op = docPaths(relPath, dirs.storeDir, dirs.outDir)
  const np = docPaths(newRel, dirs.storeDir, dirs.outDir)
  if (existsSync(np.sourcePath)) throw new Error(`目标已存在：${newRel}`)
  mkdirSync(dirname(np.sourcePath), { recursive: true })
  renameSync(op.sourcePath, np.sourcePath)
  if (existsSync(op.mirrorPath)) {
    mkdirSync(dirname(np.mirrorPath), { recursive: true })
    renameSync(op.mirrorPath, np.mirrorPath)
  }
  if (existsSync(op.assetsDir)) {
    mkdirSync(dirname(np.assetsDir), { recursive: true })
    renameSync(op.assetsDir, np.assetsDir)
  }
  updateIndex(dirs, (files) =>
    files.map((f) => (f.sourcePath === op.sourcePath ? rewriteMovedIndexFile(f, relPath, newRel, dirs.storeDir, dirs.outDir) : f))
  )
  return newRel
}

export function createCategory(dirs: KbStoreDirs, productLine: string, product?: string): void {
  mkdirSync(product ? join(dirs.storeDir, productLine, product) : join(dirs.storeDir, productLine), { recursive: true })
}

/** prefix：'线' 或 join('线','品')。重命名末段为 newName，三处目录 + index 条目跟随。 */
export function renameCategory(dirs: KbStoreDirs, prefix: string, newName: string): { moved: number } {
  const parent = dirname(prefix)
  const newPrefix = parent === '.' ? newName : join(parent, newName)
  if (existsSync(join(dirs.storeDir, newPrefix))) throw new Error(`分类已存在：${newPrefix}`)
  // 目录级 rename 三处；assets 树与镜像树同构（assets/<relPath>），所以同一前缀搬法适用
  renameSync(join(dirs.storeDir, prefix), join(dirs.storeDir, newPrefix))
  if (existsSync(join(dirs.outDir, prefix))) renameSync(join(dirs.outDir, prefix), join(dirs.outDir, newPrefix))
  if (existsSync(join(dirs.outDir, 'assets', prefix))) {
    mkdirSync(dirname(join(dirs.outDir, 'assets', newPrefix)), { recursive: true })
    renameSync(join(dirs.outDir, 'assets', prefix), join(dirs.outDir, 'assets', newPrefix))
  }
  let moved = 0
  // sep 后缀防前缀误伤：'线A' 不能匹配到 '线A2' 下的文档
  const oldSrcPrefix = join(dirs.storeDir, prefix) + sep
  updateIndex(dirs, (files) =>
    files.map((f) => {
      if (!f.sourcePath.startsWith(oldSrcPrefix)) return f
      const oldRel = relative(dirs.storeDir, f.sourcePath)
      const newRel = join(newPrefix, relative(prefix, oldRel))
      moved++
      return rewriteMovedIndexFile(f, oldRel, newRel, dirs.storeDir, dirs.outDir)
    })
  )
  return { moved }
}

export function deleteCategory(dirs: KbStoreDirs, prefix: string): { deletedDocs: number } {
  const srcPrefix = join(dirs.storeDir, prefix) + sep
  let deletedDocs = 0
  updateIndex(dirs, (files) =>
    files.filter((f) => {
      const hit = f.sourcePath.startsWith(srcPrefix)
      if (hit) deletedDocs++
      return !hit
    })
  )
  rmSync(join(dirs.storeDir, prefix), { recursive: true, force: true })
  rmSync(join(dirs.outDir, prefix), { recursive: true, force: true })
  rmSync(join(dirs.outDir, 'assets', prefix), { recursive: true, force: true })
  return { deletedDocs }
}
```

- [ ] **Step 4: 跑测试**

Run: `cd apps/desktop && bun test src/main/core/kbStore.test.ts && bun run typecheck`
Expected: 4 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/core/kbStore.ts apps/desktop/src/main/core/kbStore.test.ts
git commit -m "feat(kb): kbStore 执行层——导入/删除/移动/分类的四方即时一致(原件/镜像/assets/index)"
```

---

### Task 6: kbBuildWorker（utilityProcess）+ kbBuildRunner（单飞行+尾随）

**Files:**
- Create: `apps/desktop/src/main/workers/kbBuildWorker.ts`
- Create: `apps/desktop/src/main/core/kbBuildRunner.ts`
- Modify: `apps/desktop/electron.vite.config.ts`（加 worker 入口）
- Modify: `apps/desktop/src/main/core/kbSemanticSearch.ts`（导出 `resetEmbedWorker`）
- Modify: `apps/desktop/src/main/core/kbIndexStore.ts`（加 `kbStoreDir()` 与 `setKbMode()`）
- Test: `apps/desktop/src/shared/kbBuildStatus.test.ts` + Create `apps/desktop/src/shared/kbBuildStatus.ts`（状态 reducer 纯核）

**Interfaces:**
- Consumes: Task 3 `buildKbIndex`；kbSemanticSearch 的 worker 生命周期。
- Produces:

```ts
// shared/kbBuildStatus.ts（P2 renderer 也要显示进度，所以放 shared）
export interface KbBuildStatus {
  running: boolean
  queued: boolean
  phase: { phase: 'convert' | 'vectors'; done: number; total: number } | null
  lastError: string | null
  lastFinishedAtMs: number | null
}
export type KbBuildEvent =
  | { type: 'start' } | { type: 'queue' }
  | { type: 'progress'; phase: 'convert' | 'vectors'; done: number; total: number }
  | { type: 'exit'; ok: boolean; error: string | null; atMs: number }
export function reduceKbBuildStatus(s: KbBuildStatus, e: KbBuildEvent): KbBuildStatus
export const initialKbBuildStatus: KbBuildStatus
// core/kbBuildRunner.ts
export function scheduleKbBuild(): void
export function getKbBuildStatus(): KbBuildStatus
export function onKbBuildStatus(cb: (s: KbBuildStatus) => void): () => void
// core/kbSemanticSearch.ts 追加
export function resetEmbedWorker(): void
// core/kbIndexStore.ts 追加
export const kbStoreDir: () => string   // userData/kb-store
export function setKbMode(mode: KbMode): void
```

Worker 协议（argv 与消息，两端都按此实现）：
- fork argv：`[storeDir, outDir, nowMs, modelDir]`
- worker→main：`{type:'progress', phase, done, total}` | `{type:'log', line}` | `{type:'done', ok: true}` | `{type:'done', ok: false, error}`

- [ ] **Step 1: 写失败测试**（reducer 纯核，`apps/desktop/src/shared/kbBuildStatus.test.ts`）

```ts
import { describe, expect, test } from 'bun:test'
import { initialKbBuildStatus, reduceKbBuildStatus } from './kbBuildStatus'

describe('reduceKbBuildStatus', () => {
  test('start→progress→exit(ok) 生命周期', () => {
    let s = reduceKbBuildStatus(initialKbBuildStatus, { type: 'start' })
    expect(s.running).toBe(true)
    s = reduceKbBuildStatus(s, { type: 'progress', phase: 'convert', done: 3, total: 10 })
    expect(s.phase).toEqual({ phase: 'convert', done: 3, total: 10 })
    s = reduceKbBuildStatus(s, { type: 'exit', ok: true, error: null, atMs: 42 })
    expect(s).toEqual({ running: false, queued: false, phase: null, lastError: null, lastFinishedAtMs: 42 })
  })
  test('运行中 queue 置位；exit 保留 queued 供 runner 决定尾随再跑', () => {
    let s = reduceKbBuildStatus(initialKbBuildStatus, { type: 'start' })
    s = reduceKbBuildStatus(s, { type: 'queue' })
    expect(s.queued).toBe(true)
    s = reduceKbBuildStatus(s, { type: 'exit', ok: false, error: 'boom', atMs: 1 })
    expect(s.queued).toBe(true)   // 尾随意图不能被失败吞掉——排队的改动仍需一轮构建
    expect(s.lastError).toBe('boom')
    s = reduceKbBuildStatus(s, { type: 'start' })
    expect(s.queued).toBe(false)  // 尾随轮启动即消费掉排队标记
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/shared/kbBuildStatus.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 reducer**（`shared/kbBuildStatus.ts`）

```ts
/** 构建状态纯核：runner（main）与 P2 的进度 UI 共用。reducer 化是为了 bun 直测单飞行+尾随的状态转移。 */
export interface KbBuildStatus {
  running: boolean
  queued: boolean
  phase: { phase: 'convert' | 'vectors'; done: number; total: number } | null
  lastError: string | null
  lastFinishedAtMs: number | null
}

export type KbBuildEvent =
  | { type: 'start' }
  | { type: 'queue' }
  | { type: 'progress'; phase: 'convert' | 'vectors'; done: number; total: number }
  | { type: 'exit'; ok: boolean; error: string | null; atMs: number }

export const initialKbBuildStatus: KbBuildStatus = {
  running: false, queued: false, phase: null, lastError: null, lastFinishedAtMs: null
}

export function reduceKbBuildStatus(s: KbBuildStatus, e: KbBuildEvent): KbBuildStatus {
  switch (e.type) {
    case 'start':
      // 启动即消费尾随标记：这一轮会看到排队时刻之后的所有改动（构建按 store 现状扫盘）
      return { ...s, running: true, queued: false, phase: null }
    case 'queue':
      return s.running ? { ...s, queued: true } : s
    case 'progress':
      return { ...s, phase: { phase: e.phase, done: e.done, total: e.total } }
    case 'exit':
      // queued 保留：失败也不吞尾随意图，runner 看到 queued 立即再排一轮
      return { ...s, running: false, phase: null, lastError: e.ok ? null : e.error, lastFinishedAtMs: e.atMs }
  }
}
```

- [ ] **Step 4: 跑 reducer 测试通过**

Run: `cd apps/desktop && bun test src/shared/kbBuildStatus.test.ts`
Expected: PASS

- [ ] **Step 5: worker 入口**（`workers/kbBuildWorker.ts`）

```ts
// utilityProcess 入口：全库增量构建（转换 execFileSync + 向量化模型加载都是重活，
// 绝不进 main——同 embedWorker 的隔离理由）。argv: [storeDir, outDir, nowMs, modelDir]
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildKbIndex } from '../core/kbBuild/build'

// parentPort 类型注记同 embedWorker.ts（Electron 全局 ambient 声明，不能具名 import）
const parentPort = (process as typeof process & { parentPort: Electron.ParentPort }).parentPort

const [storeDir, outDir, nowArg, modelDir] = process.argv.slice(2) as [string, string, string, string]

async function run(): Promise<void> {
  // 模型缺失（打包裁剪/首启未就绪）→ 跳过向量化而非失败：BM25 与镜像先行，
  // embedWorker 对 stale 向量自动降级，模型就绪后下一轮构建补齐（spec §4 降级路径）。
  const modelReady = existsSync(join(modelDir, 'bge-small-zh-v1.5', 'onnx', 'model_quantized.onnx'))
  if (!modelReady) parentPort.postMessage({ type: 'log', line: 'kb-model 缺失，本轮跳过向量化' })
  await buildKbIndex({
    kbRoot: storeDir,
    outDir,
    now: Number(nowArg),
    // 打包模型目录无 Xenova 前缀（kb-model/bge-small-zh-v1.5/），所以显式给 modelName
    vectors: modelReady ? { localModelPath: modelDir, modelName: 'bge-small-zh-v1.5' } : false,
    onProgress: (p) => parentPort.postMessage({ type: 'progress', ...p }),
    log: (line) => parentPort.postMessage({ type: 'log', line })
  })
  parentPort.postMessage({ type: 'done', ok: true })
}

run().catch((err) => parentPort.postMessage({ type: 'done', ok: false, error: String(err) }))
```

- [ ] **Step 6: vite 入口 + kbSemanticSearch.resetEmbedWorker + kbIndexStore 扩展**

`electron.vite.config.ts` 的 main.build.rollupOptions.input 加一行：

```ts
          embedWorker: resolve(__dirname, 'src/main/workers/embedWorker.ts'),
          // kbBuildWorker 同理独立入口：转换/向量化重活全在子进程（P1 底座 Task 6）
          kbBuildWorker: resolve(__dirname, 'src/main/workers/kbBuildWorker.ts')
```

`kbSemanticSearch.ts` 末尾追加：

```ts
/**
 * 构建成功后由 kbBuildRunner 调用：杀掉旧 worker 让 exit 处理器复位三态（含 stale latch），
 * 下一次 warm/search 用新 fingerprint 重新 fork——否则重建后语义检索永久停在 BM25 降级。
 */
export function resetEmbedWorker(): void {
  worker?.kill()
}
```

`kbIndexStore.ts` 追加：

```ts
/** 托管仓库根目录（原件树，目录即分类）。P1 起 kb-store 取代旧「用户自选 kbRoot 文件夹」。 */
export const kbStoreDir = (): string => join(app.getPath('userData'), 'kb-store')

/** 持久化模式（managed=主编可写 / remote=只读同步）。读-合并-写，理由见 setKbRoot。 */
export function setKbMode(mode: KbMode): void {
  const cur = getKbConfig()
  writeFileSync(configPath(), JSON.stringify({ ...cur, mode }), 'utf8')
}
```

（`KbMode` 从 `../../shared/kbConfig` import type。）

- [ ] **Step 7: runner**（`core/kbBuildRunner.ts`）

```ts
/**
 * 构建编排（main 侧薄壳）：单飞行 + 尾随。所有状态转移在 shared/kbBuildStatus 纯核，
 * 这里只做 fork/转发/回调。为什么不复用 kbSyncScheduler：sync 是定时拉取（周期驱动），
 * build 是写操作驱动（事件驱动），两者唯一的共同点「单飞行」已经薄到不值得抽象。
 */
import { app, utilityProcess } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  initialKbBuildStatus, reduceKbBuildStatus, type KbBuildEvent, type KbBuildStatus
} from '../../shared/kbBuildStatus'
import { kbOutDir, kbStoreDir } from './kbIndexStore'
import { resetEmbedWorker, warmEmbedWorker } from './kbSemanticSearch'

let status: KbBuildStatus = initialKbBuildStatus
const listeners = new Set<(s: KbBuildStatus) => void>()

function dispatch(e: KbBuildEvent): void {
  status = reduceKbBuildStatus(status, e)
  for (const cb of listeners) cb(status)
}

/** 模型目录解析与 kbSemanticSearch.modelDir 同式（打包=resourcesPath，dev=apps/desktop/kb-model）。 */
function modelDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'kb-model')
  return join(dirname(fileURLToPath(import.meta.url)), '../../kb-model')
}

function start(): void {
  dispatch({ type: 'start' })
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'kbBuildWorker.js')
  const child = utilityProcess.fork(workerPath, [kbStoreDir(), kbOutDir(), String(Date.now()), modelDir()])
  let done = false
  child.on('message', (msg: { type: string; phase?: 'convert' | 'vectors'; done?: number; total?: number; ok?: boolean; error?: string; line?: string }) => {
    if (msg.type === 'progress' && msg.phase) {
      dispatch({ type: 'progress', phase: msg.phase, done: msg.done ?? 0, total: msg.total ?? 0 })
    } else if (msg.type === 'log' && msg.line) {
      console.log(`[kb-build] ${msg.line}`)
    } else if (msg.type === 'done') {
      done = true
      finish(msg.ok === true, msg.error ?? null)
    }
  })
  // worker 崩溃（OOM/被杀）不会发 done——exit 兜底把状态收敛，否则 running 永远卡 true
  child.on('exit', () => { if (!done) finish(false, 'kbBuildWorker 异常退出') })

  function finish(ok: boolean, error: string | null): void {
    dispatch({ type: 'exit', ok, error, atMs: Date.now() })
    if (ok) {
      // 新 builtAtMs → 旧 embedWorker 的向量 fingerprint 必 stale：杀掉重温，
      // 让语义检索在重建后自动恢复（而不是降级到重启 app 为止）
      resetEmbedWorker()
      warmEmbedWorker()
    }
    if (status.queued) start() // 尾随：构建期间的写操作合并成一轮
  }
}

/** 写操作后调用。运行中则置尾随标记（一轮扫盘会看到所有排队改动，天然合并）。 */
export function scheduleKbBuild(): void {
  if (status.running) dispatch({ type: 'queue' })
  else start()
}

export function getKbBuildStatus(): KbBuildStatus {
  return status
}

export function onKbBuildStatus(cb: (s: KbBuildStatus) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
```

- [ ] **Step 8: typecheck + 全量测试**

Run: `cd apps/desktop && bun run typecheck && bun test src/`
Expected: 全绿。runner/worker 的端到端行为（真 fork）依赖 IPC 触发入口，属 P2 的 GUI 走查范围；本 task 的自动化保障是 reducer 全覆盖 + typecheck，这是项目现有基建下的诚实边界（与 kbSyncScheduler 同待遇）。

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(kb): kbBuildWorker(utilityProcess)+kbBuildRunner 单飞行尾随——构建后重置 embedWorker 消 stale"
```

---

### Task 7: dev 冒烟入口 + 计划收尾核对

**Files:**
- Modify: `apps/desktop/src/main/index.ts`（临时 dev 冒烟，见下——P2 接 IPC 后移除）

**Interfaces:**
- Consumes: Task 5/6 全部导出。
- Produces: 无新接口；本 task 是 P1 的端到端验证闸门。

- [ ] **Step 1: dev 冒烟钩子**

在 `src/main/index.ts` 的 `app.whenReady()` 回调里（`startKbSyncScheduler` 调用附近）追加：

```ts
  // 【P1 临时冒烟，P2 接上 IPC 面后删除】KB_BUILD_SMOKE=1 时启动即跑一轮托管仓库构建，
  // 验证 worker fork/进度/退出链路。平时零开销（env 不设即完全不触发）。
  if (process.env.KB_BUILD_SMOKE === '1') {
    const { scheduleKbBuild, onKbBuildStatus } = await import('./core/kbBuildRunner')
    onKbBuildStatus((s) => console.log('[kb-build-smoke]', JSON.stringify(s)))
    scheduleKbBuild()
  }
```

（若该处不是 async 上下文，用顶部静态 import 替代动态 import——以现场代码结构为准，保持「env 不设零开销」即可。）

- [ ] **Step 2: 端到端冒烟**

```bash
mkdir -p ~/Library/Application\ Support/claude-desktop/kb-store/冒烟线/冒烟品
printf '托管仓库端到端冒烟' > ~/Library/Application\ Support/claude-desktop/kb-store/冒烟线/冒烟品/冒烟.txt
cd apps/desktop && KB_BUILD_SMOKE=1 bun run dev
```

（userData 目录名以 dev 实际值为准——不确定就先跑一次 dev，在主进程日志里打印 `app.getPath('userData')` 确认。）

Expected: 主进程日志出现 `[kb-build-smoke]` 状态序列：`running:true` → `phase:convert` →（模型在位则 `phase:vectors`，缺失则 `kb-model 缺失，本轮跳过向量化`）→ `running:false, lastError:null`。`userData/kb-index/` 下生成 `冒烟线/冒烟品/冒烟.txt.md` 与 v3 的 `index.json`。

- [ ] **Step 3: 回归全绿**

Run: `cd apps/desktop && bun run typecheck && bun test src/ && cd ../.. && bun test scripts/`
Expected: 全绿。

- [ ] **Step 4: 对照 spec 核对 P1 交付面**

逐项确认（都应已满足，异常则回补）：
- spec §3：kb-store 目录模型 ✓（Task 5/6）；index v3 ✓（Task 1/3）；kbConfig.mode ✓（Task 1/6）；操作语义表 ✓（Task 5，「任何写操作后触发增量构建」的调用点在 P2 IPC handler 里接 `scheduleKbBuild()`）
- spec §4：管线搬家 ✓（Task 2/3）；worker 化 ✓（Task 6）；向量化降级 ✓（Task 6 worker）；单飞行+尾随 ✓（Task 6）
- spec §8：index tmp+rename ✓（Task 3/5）；构建/发布互斥 → P3（发布侧持锁）
- spec §9：纯核测试 ✓（Task 1/3/4/5/6）

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(kb): P1 底座收尾——dev 冒烟入口(KB_BUILD_SMOKE)与端到端验证"
```

---

## Self-Review 记录

- **Spec coverage**：P1 覆盖 spec §3/§4/§8/§9 的 main 侧全部；§5（管理页）/§7（IPC）→ P2；§6（发布）→ P3；§3.4 迁移引导 → P2。无遗漏。
- **类型一致性**：`KbStoreDirs`/`BuildOptions`/`KbBuildStatus`/`ImportPlanItem` 的字段名与签名在 Interfaces 块与代码块间逐字核对过；`buildVectors` 第五参 `modelName` 在 Task 3 定义、Task 6 worker 消费。
- **已知取舍**：runner 的真 fork 链路没有自动化测试（项目无 e2e 基建），以 reducer 纯核全覆盖 + Task 7 冒烟兜底——与 kbSyncScheduler 同等待遇，诚实标注。
