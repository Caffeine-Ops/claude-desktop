# 知识库语义检索 P1（文本）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给「写方案」加文本语义检索——模糊/同义描述也能召回知识库原文片段并带出处，落地搜索面板 + AI 的 `kb_search` 工具。

**Architecture:** 离线建一张**唯一权威分块表**（`vectors.bin` 向量 + `vectors-meta.json` 元信息，行号即 chunk id）；查询时 BM25 与向量都跑同一张表、用行号 RRF 融合。embedding 跑在 **utilityProcess**（不冻 main），热路径 `await` 带超时、模型缺失/stale 时降级 BM25-only。

**Tech Stack:** Electron 33 / electron-vite / bun / TypeScript（composite：node + web）；`@huggingface/transformers`(v3, ESM-only) + `bge-small-zh-v1.5`(量化 onnx, 512 维)；bun test。

来源 spec：`docs/superpowers/specs/2026-06-30-kb-semantic-search-design.md`（v2）。

## Global Constraints

- **包管理器是 bun**，不是 npm。质量门 = `bun run typecheck`（`tsc -p node` + `tsc -p web`）+ `bun test src/`。无 ESLint。
- **main 必须保持 ESM**（externalizeDepsPlugin 把 transformers 留作运行时 `import`；v3 是 ESM-only，改回 CJS 会 `ERR_REQUIRE_ESM`）。
- **embedding/余弦绝不在 main 主线程同步跑**（每 tab 一 engine 共享 main，冷加载 5.8s 会冻全部 tab）。一律 utilityProcess + 空闲 warmup + 热路径 await 带超时。
- **stale/向量缺失 → 降级 BM25-only，绝不返回空**（engine 自动召回靠它，返空=回归）。
- **索引版本**：复用 `KbIndex.version`，从 `1` bump 到 `2`，**不新增 `indexVersion` 字段**。
- **向量维度 512**；模型 id（本地目录名）= `bge-small-zh-v1.5`；feature-extraction 用 `pooling:'mean', normalize:true`。
- **纯逻辑进 `*.core.ts` 可单测，IO/electron 进包装层**（沿用现有 proposalRetrieve.core.ts / proposalVerify.core.ts 纪律）。
- **模型不入 git**：构建时从钉版 release 拉取到 `apps/desktop/kb-model/`。
- 加一条 IPC 要**同改四处**：`shared/ipc-channels.ts` → `preload/index.ts` → `preload/index.d.ts` → main handler。
- 注释解释「为什么这样而不是那样」，沿用仓库高注释密度风格。

## 文件结构（本计划新建/改动）

新建：
- `apps/desktop/src/main/core/proposalSemantic.core.ts`(+`.test.ts`) — 纯核：cosineTopK + fuseRRF。
- `apps/desktop/src/main/core/kbSemanticSearch.ts` — main 侧薄包装（warmup/超时/降级/stale）。
- `apps/desktop/src/main/workers/embedWorker.ts` — utilityProcess 入口（载模型+向量、search 协议）。
- `scripts/kb-index/embed.ts` — 离线向量化。
- `scripts/prebundle-kb-model.mjs` — 构建时拉模型。
- renderer 搜索面板组件（见 Task 8）。

改动：
- `apps/desktop/src/main/core/proposalRetrieve.core.ts` — chunkText 增产 offset。
- `apps/desktop/src/shared/kbIndex.ts` — version→2 + VectorMeta/VectorStoreMeta 类型。
- `scripts/build-kb-index.ts` — 写 version:2 + 调 embed。
- `apps/desktop/src/main/core/engine.ts` — 热路径召回升级 + kb_search 工具。
- IPC 四处 + `apps/desktop/package.json`(build 段+scripts+deps) + `.github/workflows/build.yml`。

---

### Task 0: v3 spike 复跑 + 钉死 transformers v3 用法

spike 当初用的是 `@xenova/transformers`(v2)；实现用 v3(`@huggingface/transformers`)。本任务在隔离脚本里复跑 v3，**产出后续任务逐字复用的「加载+embed」标准片段 + 本地模型目录布局**。这是去风险任务，先做。

**Files:**
- Create: `scratch/v3-spike/embed-v3.mjs`（throwaway，不提交）

**Interfaces:**
- Produces: 经验证的 `loadExtractor()` / `embed(text):Float32Array(512)` 片段 + `kb-model/` 目录布局，写进本任务完成记录，Task 4/5 复用。

- [ ] **Step 1: 装 v3 + 跑**

```bash
mkdir -p scratch/v3-spike && cd scratch/v3-spike
echo '{"name":"v3-spike","type":"module","private":true}' > package.json
bun add @huggingface/transformers
cat > embed-v3.mjs <<'EOF'
import { pipeline, env } from '@huggingface/transformers'
env.allowRemoteModels = true          // 本步允许下载以验证；线上将 false
env.cacheDir = './.cache'
const t0 = Date.now()
const ex = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { dtype: 'q8' })
console.log('load', ((Date.now()-t0)/1000).toFixed(1), 's')
const out = await ex('智能导诊的描述图表', { pooling: 'mean', normalize: true })
console.log('dims', out.dims, 'len', out.data.length, 'isF32', out.data instanceof Float32Array)
const a = (await ex('智能导诊', {pooling:'mean',normalize:true})).data
const b = (await ex('预诊分诊流程', {pooling:'mean',normalize:true})).data
const cos=(x,y)=>{let s=0;for(let i=0;i<x.length;i++)s+=x[i]*y[i];return s}
console.log('cos(同义)=', cos(a,b).toFixed(3), '应≈0.5+')
EOF
node embed-v3.mjs
```

- [ ] **Step 2: 验收 + 记录**

Expected: `len 512`、`isF32 true`、`cos(同义) ≈ 0.5+`。若 v3 的 `dtype`/`out.data` 形态与上不符，**就地调通**并把最终可用片段记进本任务完成笔记（Task 4/5 逐字用它）。把 `.cache/Xenova/bge-small-zh-v1.5/` 下的实际文件树（`onnx/model_quantized.onnx`、`tokenizer.json`、`config.json`、`tokenizer_config.json`）记下来——这就是 `kb-model/bge-small-zh-v1.5/` 要摆的布局。

- [ ] **Step 3: 清理**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && rm -rf scratch/v3-spike
```

不提交（scratch 不入库）。本任务无 git commit。

---

### Task 1: chunkText 增产字符 offset

RRF 行号对齐的前提：BM25 与向量必须跑同一套 chunk。先让 chunkText 能产出每块的 `charStart/charEnd`，离线 embed 与查询两端共用。保持现有 `chunkText(): string[]` 签名不破坏既有调用方。

**Files:**
- Modify: `apps/desktop/src/main/core/proposalRetrieve.core.ts`
- Test: `apps/desktop/src/main/core/proposalRetrieve.core.test.ts`

**Interfaces:**
- Produces: `export interface TextChunk { text: string; charStart: number; charEnd: number }` 和 `export function chunkTextWithOffsets(text: string): TextChunk[]`。`chunkText` 改为 `chunkTextWithOffsets(text).map(c => c.text)`（行为不变）。

- [ ] **Step 1: 写失败测试**

在 `proposalRetrieve.core.test.ts` 末尾追加：

```typescript
import { chunkTextWithOffsets } from './proposalRetrieve.core'

test('chunkTextWithOffsets: offset 切片可回原文且与 text 一致', () => {
  const src = '第一段内容这里写满八十个字以上凑够最小块长度的要求一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥。\n\n第二段也要够长一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥再加一句话。'
  const chunks = chunkTextWithOffsets(src)
  expect(chunks.length).toBeGreaterThan(0)
  for (const c of chunks) {
    expect(c.charEnd).toBeGreaterThan(c.charStart)
    // 回切：用 offset 从原文截出的子串，trim 后等于 chunk.text
    expect(src.slice(c.charStart, c.charEnd).trim()).toBe(c.text)
  }
})

test('chunkText 仍等价于 chunkTextWithOffsets 的 text 投影', () => {
  const src = 'abc 一二三四五六七八九十甲乙丙丁戊己庚辛壬癸。\n\nxyz 子丑寅卯辰巳午未申酉戌亥一二三四五六。'
  const { chunkText } = require('./proposalRetrieve.core')
  expect(chunkText(src)).toEqual(chunkTextWithOffsets(src).map((c: { text: string }) => c.text))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/main/core/proposalRetrieve.core.test.ts`
Expected: FAIL，`chunkTextWithOffsets is not a function`。

- [ ] **Step 3: 实现**

改 `proposalRetrieve.core.ts`：保留现有分块算法，但在 split 时追踪偏移。把现有 `chunkText` 重写为基于 offset 版本。最小改法——新增 offset 版、旧版投影：

```typescript
/** 一个检索块 + 它在原文中的字符区间（用于 RRF 行号对齐：离线 embed 与查询共用同一套块）。 */
export interface TextChunk {
  text: string
  charStart: number
  charEnd: number
}

/**
 * 与 {@link chunkText} 同算法，但额外返回每块在【原文】中的字符区间 [charStart,charEnd)。
 * 区间对齐到 trim 前的边界：slice(charStart,charEnd).trim() === text。offset 让离线向量化
 * 与查询期 BM25 落到同一套块、用行号对齐 RRF（见 proposalSemantic.core.ts）。
 */
export function chunkTextWithOffsets(text: string): TextChunk[] {
  if (!text) return []
  const out: TextChunk[] = []
  // 用带捕获的分隔正则切段，同时累计绝对偏移。\n\s*\n 作为段分隔（与 chunkText 同义）。
  const sep = /\n\s*\n/g
  const segs: { raw: string; start: number }[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = sep.exec(text)) !== null) {
    segs.push({ raw: text.slice(last, m.index), start: last })
    last = m.index + m[0].length
  }
  segs.push({ raw: text.slice(last), start: last })

  // 把 raw 段 trim 成块；短段合并、超长段按 CHUNK_MAX 窗口/表格保形——与 chunkText 一致，
  // 但携带绝对偏移。合并块的区间取 [首段trim起点, 末段trim终点)。
  type Pending = { text: string; start: number; end: number }
  let buf: Pending | null = null
  const push = (p: Pending): void => out.push({ text: p.text, charStart: p.start, charEnd: p.end })
  const flush = (): void => { if (buf) { push(buf); buf = null } }
  const trimRange = (raw: string, base: number): { t: string; s: number; e: number } => {
    const lead = raw.length - raw.trimStart().length
    const t = raw.trim()
    return { t, s: base + lead, e: base + lead + t.length }
  }
  for (const seg of segs) {
    const { t, s, e } = trimRange(seg.raw, seg.start)
    if (!t) continue
    if (t.length >= CHUNK_MAX) {
      flush()
      if (isTableBlockExported(t)) push({ text: t, start: s, end: e })
      else for (let i = 0; i < t.length; i += CHUNK_MAX)
        push({ text: t.slice(i, i + CHUNK_MAX), start: s + i, end: s + Math.min(i + CHUNK_MAX, t.length) })
      continue
    }
    if (!buf) { buf = { text: t, start: s, end: e } }
    else {
      const merged = `${buf.text}\n\n${t}`
      if (merged.length > CHUNK_MAX) { flush(); buf = { text: t, start: s, end: e } }
      else { buf.text = merged; buf.end = e }
    }
    if (buf && buf.text.length >= CHUNK_MIN) flush()
  }
  flush()
  return out
}

export function chunkText(text: string): string[] {
  return chunkTextWithOffsets(text).map((c) => c.text)
}
```

把现有 `isTableBlock` 导出为 `isTableBlockExported`（或直接复用，保持私有亦可——若保持私有，上面调用改回 `isTableBlock`，因同文件可见）。**同文件直接调 `isTableBlock` 即可，无需导出**——删掉 `Exported` 后缀。删除原 `chunkText` 老实现体。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `cd apps/desktop && bun test src/main/core/proposalRetrieve.core.test.ts src/main/core/proposalRetrieve.test.ts`
Expected: PASS（新增 2 测 + 既有 BM25/retrieve 测试全绿）。

- [ ] **Step 5: typecheck + commit**

```bash
cd apps/desktop && bun run typecheck:node
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/src/main/core/proposalRetrieve.core.ts apps/desktop/src/main/core/proposalRetrieve.core.test.ts
git commit -m "feat(proposal): chunkText 增产字符 offset(chunkTextWithOffsets)——为语义检索行号对齐铺路

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 语义检索纯核（cosineTopK + fuseRRF）

**Files:**
- Create: `apps/desktop/src/main/core/proposalSemantic.core.ts`
- Test: `apps/desktop/src/main/core/proposalSemantic.core.test.ts`

**Interfaces:**
- Produces:
  - `export function cosineTopK(query: Float32Array, matrix: Float32Array, rows: number, dim: number, k: number): { row: number; score: number }[]`（归一化向量即点积；降序 top-k）。
  - `export function fuseRRF(bm25: { row: number; rank: number }[], vector: { row: number; rank: number }[], k?: number): { row: number; score: number }[]`（RRF：`Σ 1/(k+rank)`，k 默认 60；按 row 合并、降序）。
- Consumes（Task 5 用）：两路都以 `vectors-meta` 行号为 row。

- [ ] **Step 1: 写失败测试**

```typescript
import { test, expect } from 'bun:test'
import { cosineTopK, fuseRRF } from './proposalSemantic.core'

test('cosineTopK: 取最近邻、k 截断、降序', () => {
  // 3 行 2 维，已归一化
  const m = new Float32Array([1, 0, /*row0*/ 0, 1, /*row1*/ 0.7071, 0.7071 /*row2*/])
  const q = new Float32Array([1, 0])
  const top = cosineTopK(q, m, 3, 2, 2)
  expect(top.length).toBe(2)
  expect(top[0].row).toBe(0)            // 与 q 同向 → 最高
  expect(top[0].score).toBeCloseTo(1, 5)
  expect(top[1].row).toBe(2)            // 45° 次之
  expect(top[0].score).toBeGreaterThan(top[1].score)
})

test('fuseRRF: 公共 row 得分叠加、单路 row 也在、降序', () => {
  const bm25 = [{ row: 5, rank: 0 }, { row: 9, rank: 1 }]
  const vec  = [{ row: 5, rank: 0 }, { row: 7, rank: 1 }]
  const fused = fuseRRF(bm25, vec, 60)
  expect(fused[0].row).toBe(5)          // 两路都第 1 → 最高
  const rows = fused.map((f) => f.row).sort((a, b) => a - b)
  expect(rows).toEqual([5, 7, 9])       // 并集
  for (let i = 1; i < fused.length; i++) expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && bun test src/main/core/proposalSemantic.core.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

```typescript
/**
 * 语义检索纯核：余弦 top-k + RRF 融合。无 fs/electron，可 bun test 直测。
 * 调用方（kbSemanticSearch/embedWorker）保证传入向量【已 L2 归一化】，故余弦=点积。
 */

/** 对归一化向量矩阵（行优先，rows×dim）算与 query 的点积，返回降序 top-k。 */
export function cosineTopK(
  query: Float32Array, matrix: Float32Array, rows: number, dim: number, k: number
): { row: number; score: number }[] {
  const scored: { row: number; score: number }[] = new Array(rows)
  for (let r = 0; r < rows; r++) {
    let s = 0
    const base = r * dim
    for (let d = 0; d < dim; d++) s += query[d] * matrix[base + d]
    scored[r] = { row: r, score: s }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

/**
 * Reciprocal Rank Fusion：两路命中按各自 rank（0-based）给分 1/(k+rank)，按 row 合并相加、
 * 降序。row = vectors-meta 行号，两路天然对齐（同一张分块表）。k 默认 60（RRF 惯例）。
 */
export function fuseRRF(
  bm25: { row: number; rank: number }[], vector: { row: number; rank: number }[], k = 60
): { row: number; score: number }[] {
  const acc = new Map<number, number>()
  for (const { row, rank } of bm25) acc.set(row, (acc.get(row) ?? 0) + 1 / (k + rank))
  for (const { row, rank } of vector) acc.set(row, (acc.get(row) ?? 0) + 1 / (k + rank))
  return [...acc.entries()].map(([row, score]) => ({ row, score })).sort((a, b) => b.score - a.score)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/desktop && bun test src/main/core/proposalSemantic.core.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck + commit**

```bash
cd apps/desktop && bun run typecheck:node
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/src/main/core/proposalSemantic.core.ts apps/desktop/src/main/core/proposalSemantic.core.test.ts
git commit -m "feat(proposal): 语义检索纯核 cosineTopK + fuseRRF(行号对齐)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 索引契约升级（version 2 + 向量元信息类型）

**Files:**
- Modify: `apps/desktop/src/shared/kbIndex.ts`

**Interfaces:**
- Produces:
  - `KbIndex.version` 类型从 `1` 改为 `2`。
  - `export interface VectorMeta { sourcePath; mirrorPath; productLine; product; title; charStart; charEnd; text; snippet }`（行号 i = 对齐 vectors.bin 第 i 行）。
  - `export interface VectorStoreMeta { version: 2; dim: 512; fingerprint: string; rows: VectorMeta[] }`（`fingerprint` 绑 KbIndex.builtAtMs，用于「同版本号但向量过期」检测）。

- [ ] **Step 1: 改类型**

把 `kbIndex.ts` 改为：

```typescript
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
  // v2：新增语义向量产物（vectors.bin + vectors-meta.json）。v1 索引被视为 stale → 提示重建。
  version: 2
  kbRoot: string
  builtAtMs: number
  files: KbIndexFile[]
}

/** vectors.bin 第 i 行向量对应的来源元信息（i = 全库唯一分块表行号 = chunk id）。 */
export interface VectorMeta {
  sourcePath: string
  mirrorPath: string
  productLine: string
  product: string
  title: string
  charStart: number
  charEnd: number
  /** chunk 全文——查询期 BM25 腿用它构 RetrievalChunk（不能只存 snippet，否则两路不同表）。 */
  text: string
  /** UI 展示用短预览（text 截断）。 */
  snippet: string
}

/** vectors-meta.json 顶层。fingerprint 绑 KbIndex.builtAtMs：不符 → 向量过期 → stale。 */
export interface VectorStoreMeta {
  version: 2
  dim: 512
  fingerprint: string
  rows: VectorMeta[]
}
```

- [ ] **Step 2: typecheck（预期 build-kb-index 处报错——下个任务修）**

Run: `cd apps/desktop && bun run typecheck:node`
Expected: 仅 `kbIndexStore.ts`/消费方对 `version:2` 的窄化无碍（readKbIndex 返回 KbIndex，字面量 1→2 不影响 parse）。若 typecheck 报 `version: 1` 字面量冲突，定位在 `scripts/build-kb-index.ts`（Task 4 修，本步可暂记）。

- [ ] **Step 3: commit**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/src/shared/kbIndex.ts
git commit -m "feat(proposal): KbIndex version→2 + VectorMeta/VectorStoreMeta 契约

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 离线向量化（embed.ts + build 集成）

**Files:**
- Create: `scripts/kb-index/embed.ts`
- Modify: `scripts/build-kb-index.ts`

**Interfaces:**
- Consumes: `chunkTextWithOffsets`(Task 1)、`VectorMeta/VectorStoreMeta`(Task 3)、Task 0 钉死的 v3 加载片段。
- Produces: `userData/kb-index/vectors.bin`(Float32Array 行优先) + `vectors-meta.json`(VectorStoreMeta)；`index.json` 的 `version:2`。
- 导出：`export async function buildVectors(files: KbIndexFile[], outDir: string, builtAtMs: number): Promise<void>`。

- [ ] **Step 1: 写 embed.ts**

```typescript
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline, env } from '@huggingface/transformers'
import { chunkTextWithOffsets } from '../apps/desktop/src/main/core/proposalRetrieve.core.ts'
import type { KbIndexFile, VectorMeta, VectorStoreMeta } from '../apps/desktop/src/shared/kbIndex.ts'

const DIM = 512
const MODEL_ID = 'bge-small-zh-v1.5'

/**
 * 对所有 ok 文件镜像 md 切【唯一权威分块表】并向量化，写 vectors.bin + vectors-meta.json。
 * 行号 i 三者对齐（向量第 i 行 ↔ meta.rows[i] ↔ chunk id i）。bun 跑，直接 import app 纯核。
 */
export async function buildVectors(files: KbIndexFile[], outDir: string, builtAtMs: number): Promise<void> {
  // 离线允许从本地缓存/远端取模型；线上 app 侧才 allowRemoteModels=false（见 embedWorker）。
  env.allowRemoteModels = true
  const extractor = await pipeline('feature-extraction', `Xenova/${MODEL_ID}`, { dtype: 'q8' })

  const rows: VectorMeta[] = []
  const texts: string[] = []
  for (const f of files) {
    if (!f.ok) continue
    let content: string
    try { content = readFileSync(f.mirrorPath, 'utf8') } catch { continue }
    for (const c of chunkTextWithOffsets(content)) {
      rows.push({
        sourcePath: f.sourcePath, mirrorPath: f.mirrorPath,
        productLine: f.productLine, product: f.product, title: f.title,
        charStart: c.charStart, charEnd: c.charEnd,
        text: c.text, snippet: c.text.slice(0, 160)
      })
      texts.push(c.text)
    }
  }

  const vectors = new Float32Array(rows.length * DIM)
  // 逐条 embed（v3 也支持批，但逐条最稳；几千~几万条一次性离线跑可接受）。
  for (let i = 0; i < texts.length; i++) {
    const out = await extractor(texts[i], { pooling: 'mean', normalize: true })
    vectors.set(out.data as Float32Array, i * DIM)
    if (i % 200 === 0) process.stdout.write(`\r向量化 ${i}/${texts.length}`)
  }

  writeFileSync(join(outDir, 'vectors.bin'), Buffer.from(vectors.buffer))
  const meta: VectorStoreMeta = { version: 2, dim: DIM, fingerprint: String(builtAtMs), rows }
  writeFileSync(join(outDir, 'vectors-meta.json'), JSON.stringify(meta), 'utf8')
  console.log(`\n向量化完成：${rows.length} chunk → vectors.bin + vectors-meta.json`)
}
```

> ⚠️ Task 0 若发现 v3 的 `dtype`/`out.data`/模型 id 与上不符，按 Task 0 笔记逐字替换 `pipeline(...)` 与 `out.data` 两行。

- [ ] **Step 2: 接进 build-kb-index.ts**

`scripts/build-kb-index.ts` 改两处：

```typescript
// 顶部 import 区加：
import { buildVectors } from './kb-index/embed.ts'
```

把 `:76` 的写 index + 结尾改为：

```typescript
  const index: KbIndex = { version: 2, kbRoot, builtAtMs, files }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8')
  console.log(`\n转换完成：${files.length} 文件，失败 ${failed}。index.json → ${indexPath}`)
  // 向量化（fingerprint 绑 builtAtMs，与 index 同源）。失败不吞——整库可重建。
  await buildVectors(files, outDir, builtAtMs)
```

- [ ] **Step 3: 手动冒烟（需已配置 KB）**

Run（用真实/临时 KB root）：
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun scripts/build-kb-index.ts --kb <某个含 .docx/.txt 的目录> --out /tmp/kbtest --now 1700000000000
ls -la /tmp/kbtest/vectors.bin /tmp/kbtest/vectors-meta.json
node -e "const m=require('/tmp/kbtest/vectors-meta.json');console.log('rows',m.rows.length,'dim',m.dim,'fp',m.fingerprint,'bin', require('fs').statSync('/tmp/kbtest/vectors.bin').size, '应=',m.rows.length*m.dim*4)"
```
Expected: `vectors.bin` 字节数 = `rows.length * 512 * 4`；`vectors-meta.json` rows 非空、含 text/charStart。

- [ ] **Step 4: commit**

```bash
git add scripts/kb-index/embed.ts scripts/build-kb-index.ts
git commit -m "feat(kb): 离线向量化 embed.ts——唯一分块表 vectors.bin + vectors-meta.json(version 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: embedWorker（utilityProcess）

载模型 + 向量、跑混合检索，全在子进程，不冻 main。

**Files:**
- Create: `apps/desktop/src/main/workers/embedWorker.ts`

**Interfaces:**
- 消息协议（main↔worker，`utilityProcess.postMessage`）：
  - main→worker：`{ type: 'search'; id: number; query: string; k: number }`
  - worker→main：`{ type: 'ready' }`（载完）｜`{ type: 'stale'; reason: string }`（version/fingerprint 不符或缺文件）｜`{ type: 'result'; id: number; hits: SemanticHit[] }`｜`{ type: 'error'; id: number; message: string }`
- `export interface SemanticHit { title; sourcePath; mirrorPath; productLine; product; snippet; score }`（放 `apps/desktop/src/shared/kbIndex.ts` 或新建 `proposalSemanticTypes.ts`，main 与 worker 共享）。

- [ ] **Step 1: 实现 worker**

```typescript
// utilityProcess 入口：Node 环境，可 import transformers/fs。所有重活在此，main 只转发。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline, env, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { rankChunks, type RetrievalChunk } from '../core/proposalRetrieve.core'
import { cosineTopK, fuseRRF } from '../core/proposalSemantic.core'
import type { VectorStoreMeta, VectorMeta } from '../../shared/kbIndex'

const DIM = 512
const MODEL_ID = 'bge-small-zh-v1.5'
// fork 时通过 argv 传入：[modelDir, kbOutDir, expectedFingerprint]
const [modelDir, kbOutDir, expectedFp] = process.argv.slice(2)

type RowChunk = RetrievalChunk & { row: number }
let extractor: FeatureExtractionPipeline | null = null
let matrix: Float32Array | null = null
let meta: VectorStoreMeta | null = null
let rowChunks: RowChunk[] = []

async function init(): Promise<void> {
  const metaPath = join(kbOutDir, 'vectors-meta.json')
  const binPath = join(kbOutDir, 'vectors.bin')
  if (!existsSync(metaPath) || !existsSync(binPath)) {
    process.parentPort.postMessage({ type: 'stale', reason: 'no-vectors' }); return
  }
  meta = JSON.parse(readFileSync(metaPath, 'utf8')) as VectorStoreMeta
  if (meta.version !== 2 || meta.dim !== DIM || meta.fingerprint !== expectedFp) {
    process.parentPort.postMessage({ type: 'stale', reason: 'fingerprint' }); return
  }
  const buf = readFileSync(binPath)
  matrix = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  rowChunks = meta.rows.map((m: VectorMeta, row) => ({ text: m.text, title: m.title, mirrorPath: m.mirrorPath, row }))
  // 本地模型、零网络：localModelPath 下须有 <MODEL_ID>/onnx/... + tokenizer.json（见 prebundle-kb-model）。
  env.allowRemoteModels = false
  env.localModelPath = modelDir
  extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
  process.parentPort.postMessage({ type: 'ready' })
}

async function search(query: string, k: number): Promise<SemanticHit[]> {
  if (!extractor || !matrix || !meta) return []
  const out = await extractor(query, { pooling: 'mean', normalize: true })
  const qvec = out.data as Float32Array
  const N = 40
  const vTop = cosineTopK(qvec, matrix, meta.rows.length, DIM, N).map((h, i) => ({ row: h.row, rank: i }))
  const bm = (rankChunks(query, rowChunks, { topK: N }) as Array<RowChunk & { score: number }>)
    .map((p, i) => ({ row: p.row, rank: i }))
  const fused = fuseRRF(bm, vTop).slice(0, k)
  return fused.map(({ row, score }) => {
    const m = meta!.rows[row]
    return { title: m.title, sourcePath: m.sourcePath, mirrorPath: m.mirrorPath,
      productLine: m.productLine, product: m.product, snippet: m.snippet, score }
  })
}

process.parentPort.on('message', async (e) => {
  const msg = e.data as { type: 'search'; id: number; query: string; k: number }
  if (msg.type !== 'search') return
  try { process.parentPort.postMessage({ type: 'result', id: msg.id, hits: await search(msg.query, msg.k) }) }
  catch (err) { process.parentPort.postMessage({ type: 'error', id: msg.id, message: String(err) }) }
})

init().catch((err) => process.parentPort.postMessage({ type: 'stale', reason: String(err) }))
```

> `SemanticHit` 定义加进 `shared/kbIndex.ts`（与 VectorMeta 同文件）。`rankChunks` 接受 `RetrievalChunk[]`，`RowChunk` 多带 `row`（结构子类型 OK），`{...c,score}` 把 row 透传到结果，故可读 `p.row`。

- [ ] **Step 2: 加 SemanticHit 类型 + electron-vite 把 worker 列为入口**

在 `shared/kbIndex.ts` 追加 `SemanticHit`。`electron.vite.config.ts` 的 main `rollupOptions.input` 由单入口改为多入口，让 worker 单独打包：

```typescript
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          embedWorker: resolve(__dirname, 'src/main/workers/embedWorker.ts')
        }
      },
      commonjsOptions: { transformMixedEsModules: true }
    }
```
产物落 `out/main/embedWorker.js`，Task 6 用 `utilityProcess.fork` 指向它。

- [ ] **Step 3: typecheck + commit**（worker 无独立单测——依赖原生模型；逻辑已被 Task 1/2 纯核覆盖）

```bash
cd apps/desktop && bun run typecheck:node
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/src/main/workers/embedWorker.ts apps/desktop/src/shared/kbIndex.ts apps/desktop/electron.vite.config.ts
git commit -m "feat(proposal): embedWorker(utilityProcess)——载模型+向量、混合检索不冻 main

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: kbSemanticSearch（main 薄包装：warmup/超时/降级/stale）

**Files:**
- Create: `apps/desktop/src/main/core/kbSemanticSearch.ts`

**Interfaces:**
- Consumes: embedWorker 协议(Task 5)、`retrievePassages`/`renderRetrievedBlock`(BM25 降级)、`readKbIndex`/`kbOutDir`、`resolveRepoRoot` 范式(`openDesignServices.ts`)。
- Produces:
  - `export function warmEmbedWorker(): void`（空闲调一次，fork worker、预载）。
  - `export async function kbSemanticSearch(query: string, scopes: readonly ProposalProductScope[], k?: number): Promise<{ hits: SemanticHit[]; staleIndex: boolean }>`。

- [ ] **Step 1: 实现**

```typescript
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProposalProductScope } from './proposalPrompt'
import type { SemanticHit } from '../../shared/kbIndex'
import { readKbIndex, kbOutDir } from './kbIndexStore'
import { retrievePassages } from './proposalRetrieve'

const SEARCH_TIMEOUT_MS = 1500
let worker: UtilityProcess | null = null
let ready = false
let stale = false
let seq = 0
const pending = new Map<number, (hits: SemanticHit[]) => void>()

/** 模型/向量目录解析：打包 = resourcesPath/kb-model；dev = 仓库内 apps/desktop/kb-model。 */
function modelDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'kb-model')
  return join(dirname(fileURLToPath(import.meta.url)), '../../../kb-model') // out/main → apps/desktop
}

/** 空闲 warmup：fork worker 子进程预载模型+向量。绝不在首次用户查询同步路径里跑。 */
export function warmEmbedWorker(): void {
  if (worker) return
  const idx = readKbIndex()
  const fp = idx ? String(idx.builtAtMs) : ''
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'embedWorker.js') // out/main/embedWorker.js
  worker = utilityProcess.fork(workerPath, [modelDir(), kbOutDir(), fp])
  worker.on('message', (msg: { type: string; id?: number; hits?: SemanticHit[] }) => {
    if (msg.type === 'ready') ready = true
    else if (msg.type === 'stale') { stale = true; ready = false }
    else if (msg.type === 'result' && msg.id != null) { pending.get(msg.id)?.(msg.hits ?? []); pending.delete(msg.id) }
    else if (msg.type === 'error' && msg.id != null) { pending.get(msg.id)?.([]); pending.delete(msg.id) }
  })
  worker.on('exit', () => { worker = null; ready = false })
}

/** BM25-only 降级：复用现有即时召回，转成 SemanticHit。 */
function bm25Fallback(query: string, scopes: readonly ProposalProductScope[], k: number): SemanticHit[] {
  return retrievePassages(query, scopes, { topK: k }).map((p) => ({
    title: p.title, sourcePath: '', mirrorPath: p.mirrorPath,
    productLine: '', product: '', snippet: p.text.slice(0, 160), score: p.score
  }))
}

/**
 * 混合语义检索。worker 未就绪/超时/stale → 降级 BM25-only（绝不返空、绝不阻塞等模型）。
 * staleIndex=true 仅供面板提示重建；engine 自动召回忽略它。
 */
export async function kbSemanticSearch(
  query: string, scopes: readonly ProposalProductScope[], k = 5
): Promise<{ hits: SemanticHit[]; staleIndex: boolean }> {
  if (!worker) warmEmbedWorker()
  if (!ready || stale || !worker) return { hits: bm25Fallback(query, scopes, k), staleIndex: stale }
  const id = ++seq
  const hits = await new Promise<SemanticHit[]>((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(bm25Fallback(query, scopes, k)) }, SEARCH_TIMEOUT_MS)
    pending.set(id, (h) => { clearTimeout(timer); resolve(h.length ? h : bm25Fallback(query, scopes, k)) })
    worker!.postMessage({ type: 'search', id, query, k })
  })
  return { hits, staleIndex: false }
}
```

> dev 的 `modelDir()`/`workerPath` 相对层级以 Task 0/构建产物实测为准（`out/main/` 下）；若 import.meta.url 在 dev 指向 src，按 `app.isPackaged` already 分支兜底。落地时用 `console.log(modelDir())` 验一次。

- [ ] **Step 2: typecheck + commit**

```bash
cd apps/desktop && bun run typecheck:node
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/src/main/core/kbSemanticSearch.ts
git commit -m "feat(proposal): kbSemanticSearch——warmup/超时/BM25降级/stale 旗标

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: 热路径召回升级 + kb_search 工具

**Files:**
- Modify: `apps/desktop/src/main/core/engine.ts`（召回点 `:1100`；工具注册处；warmup 触发处）

**Interfaces:**
- Consumes: `kbSemanticSearch`/`warmEmbedWorker`(Task 6)、`renderRetrievedBlock`(已存在)。

- [ ] **Step 1: 召回点改混合 + 忽略 stale**

`engine.ts:58` import 增 `kbSemanticSearch, warmEmbedWorker`。把 `:1100` 的同步块改为：

```typescript
    let retrievalBlock = ''
    if (wantsRetrieval) {
      // 混合语义检索（embedding 在 utilityProcess）。engine 自动召回【忽略 staleIndex】——
      // 拿到什么（混合或 BM25 降级）就注什么，绝不因 stale 变空（防回归）。带超时不冻 send。
      const { hits } = await kbSemanticSearch(text, scopes)
      const passages = hits.map((h) => ({ text: h.snippet, title: h.title, mirrorPath: h.mirrorPath, score: h.score }))
      retrievalBlock = renderRetrievedBlock(passages)
      console.log('[engine] proposal semantic retrieval', { query: text.slice(0, 40), hits: hits.length, titles: hits.map((h) => h.title) })
    }
```

> 注意：`renderRetrievedBlock` 吃 `RetrievedPassage`（含 text/title/mirrorPath/score），上面映射满足。snippet 较短可接受（注入块本就片段）；若要全文注入，让 worker 在 hit 里带 `text` 全文（VectorMeta.text 已有）——视注入预算决定，落地时若发现 snippet 太短影响质量，把 SemanticHit 加 `text` 字段返全文。

- [ ] **Step 2: 进入方案模式时 warmup**

找到 engine 里 `proposalMode` 首次置真/openSession 方案分支（grep `spawnedWithProposal`），在其附近调一次 `warmEmbedWorker()`（幂等）。确保模型在用户首查前后台预载。

- [ ] **Step 3: 注册 kb_search SDK 工具**

在 engine 现有工具注册处（grep `tool(` 或 SDK `tools:`/mcp 工具定义）加：

```typescript
// AI 写某节缺料时主动调：一句自然语言 → 语义命中片段（含出处）。复用 kbSemanticSearch。
// 与热路径自动召回并存（一个被动、一个主动）。
{
  name: 'kb_search',
  description: '在知识库里用自然语言模糊描述检索相关原文片段（语义+词面混合），返回片段与出处文件名。写方案缺资料时用。',
  // 入参 schema：{ query: string }；实现里 scopes 取当前 runtime.proposalProducts 的 scope
  // 返回：命中片段文本化（《文件名》\n片段）拼成字符串
}
```

具体挂载形态对齐 engine 现有工具的注册 API（SDK in-process tool 或 mcp）。实现体：
```typescript
const { hits } = await kbSemanticSearch(query, this.proposalProductScopes(runtime.proposalProducts), 8)
return hits.length
  ? hits.map((h) => `《${h.title}》\n${h.snippet}`).join('\n\n- - -\n\n')
  : '（知识库未命中相关内容）'
```

- [ ] **Step 4: typecheck + 手测召回日志**

Run: `cd apps/desktop && bun run typecheck:node`
Expected: 通过。dev 起 app 进方案模式发一轮，终端应见 `[engine] proposal semantic retrieval` 日志、hits 非空。

- [ ] **Step 5: commit**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/src/main/core/engine.ts
git commit -m "feat(proposal): engine 热路径召回升级混合检索(忽略stale不变空) + kb_search 工具 + warmup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: 搜索面板（IPC 四处 + renderer）

照 `PROPOSAL_PEEK_RETRIEVAL` 既有范式（召回预览方案三）扩一个语义搜索面板。

**Files:**
- Modify: `apps/desktop/src/shared/ipc-channels.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/preload/index.d.ts`、main handler（grep `PROPOSAL_PEEK_RETRIEVAL` 找到注册处，多在 `src/main/ipc/register.ts` 或 engine）。
- Create: renderer 面板组件（参照现有召回预览组件，grep `peekRetrieval`/`PEEK_RETRIEVAL` 定位）。

**Interfaces:**
- 新通道 `KB_SEMANTIC_SEARCH: 'kb:semantic-search'`；payload `{ query: string; products: ReadonlyArray<{productLine;product}> }`；result `{ hits: SemanticHit[]; staleIndex: boolean }`。

- [ ] **Step 1: ipc-channels.ts**

在 `IPC_CHANNELS` 加（带注释）：
```typescript
  /**
   * Renderer → main. 语义检索：模糊自然语言 → 混合(向量+BM25)命中片段+出处。供写方案
   * 搜索面板主动用。embedding 在 utilityProcess、不冻 main；模型缺失/stale 降级 BM25。
   */
  KB_SEMANTIC_SEARCH: 'kb:semantic-search',
```
并加类型：
```typescript
export interface KbSemanticSearchPayload {
  query: string
  products: ReadonlyArray<{ productLine: string; product: string }>
}
export interface KbSemanticSearchResult {
  hits: SemanticHit[]
  staleIndex: boolean
}
```
（`SemanticHit` 从 `./kbIndex` import 进 ipc-channels，或在此 re-export。）`ChatApi` 接口加：
```typescript
  kbSemanticSearch(payload: KbSemanticSearchPayload): Promise<KbSemanticSearchResult>
```

- [ ] **Step 2: preload 两处**

`preload/index.ts` 的 chatApi 对象加（仿现有 `peekRetrieval`/`verifyProposal` invoke 包装）：
```typescript
  kbSemanticSearch: (payload) => ipcRenderer.invoke(IPC_CHANNELS.KB_SEMANTIC_SEARCH, payload),
```
`preload/index.d.ts` 对应补方法签名（与 ChatApi 一致）。

- [ ] **Step 3: main handler**

在 PROPOSAL_PEEK_RETRIEVAL 注册旁加：
```typescript
ipcMain.handle(IPC_CHANNELS.KB_SEMANTIC_SEARCH, async (_e, p: KbSemanticSearchPayload) => {
  const scopes = buildProposalProductScopes(p.products)  // 复用 proposalScopes
  return kbSemanticSearch(p.query, scopes, 12)
})
```
（确认 handler 文件能 import `kbSemanticSearch` 与 `buildProposalProductScopes`；与 peek-retrieval 同位置即可。）

- [ ] **Step 4: renderer 面板**

复制召回预览组件为语义搜索面板：搜索框 + 结果卡（`《title》` + snippet + score）。命中行两个动作：① 「插入引用」把 `（据《title》）` + snippet 插入当前草稿（复用现有插入逻辑）；② 「打开文档」走现有 `openPath`(sourcePath)。`staleIndex:true` 顶部显「知识库需重建」条。图标走 `proposalIcons.tsx` 内联 SVG，勿直接套 `text-apple-*` 预设（见 memory proposal-ui-icons-typescale）。

- [ ] **Step 5: typecheck（node+web）+ 手测**

Run: `cd apps/desktop && bun run typecheck`
Expected: 通过（四处类型齐则过；漏一处 typecheck 当场抓）。dev 起 app，面板输入「智能导诊」应出片段+出处，stale 时显重建条。

- [ ] **Step 6: commit**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/preload/ apps/desktop/src/main/ apps/desktop/src/renderer/
git commit -m "feat(proposal): 语义搜索面板(IPC KB_SEMANTIC_SEARCH 四处 + renderer 结果卡)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: 打包（依赖 + asarUnpack + 平台裁剪 + 模型拉取 + 校验 + CI）

**Files:**
- Modify: `apps/desktop/package.json`（deps + build 段 + scripts）、`.github/workflows/build.yml`
- Create: `apps/desktop/scripts/prebundle-kb-model.mjs`、`apps/desktop/scripts/verify-kb-model.mjs`

**Interfaces:**
- Consumes: 运行时 `modelDir()`(Task 6) 指向 `resources/kb-model`。

- [ ] **Step 1: 加生产依赖**

```bash
cd apps/desktop && bun add @huggingface/transformers
```

- [ ] **Step 2: build 段**

`apps/desktop/package.json` `build` 内：
- 加 `"asarUnpack": ["**/onnxruntime-node/**"]`（原生 .node 解包到 asar 外；P2 起加 `**/sharp/**`）。
- onnx 跨平台二进制裁剪放**平台级 files**（非共享 build.files，避免误伤）：
```jsonc
"mac": {
  // ...现有...
  "files": ["!**/onnxruntime-node/bin/napi-v3/{win32,linux}/**"],
  "extraResources": [ /* ...现有4项... */, { "from": "kb-model", "to": "kb-model" } ]
},
"win": {
  "files": ["!**/onnxruntime-node/bin/napi-v3/{darwin,linux}/**"],
  "extraResources": [ /* ...现有4项... */, { "from": "kb-model", "to": "kb-model" } ]
}
```
（`from` 相对 `apps/desktop` 根 → `apps/desktop/kb-model`。）

- [ ] **Step 3: 模型拉取脚本**

`apps/desktop/scripts/prebundle-kb-model.mjs`：从钉定版本 release 下载 `bge-small-zh-v1.5` 量化模型到 `apps/desktop/kb-model/bge-small-zh-v1.5/`，布局按 Task 0 实测（`onnx/model_quantized.onnx`、`tokenizer.json`、`config.json`、`tokenizer_config.json`）。版本号常量钉死（仿 `FUSION_CODE_VERSION`）。已存在且校验过 → 跳过。

`apps/desktop/scripts/verify-kb-model.mjs`：断言上述文件齐全、`vectors` 维度文件大小/哈希合理；缺失即 `process.exit(1)`（仿 `verify-fusion-bin`）。

`package.json` scripts 加：
```jsonc
"prebundle:kb-model": "bun scripts/prebundle-kb-model.mjs",
"verify:kb-model": "bun scripts/verify-kb-model.mjs",
```
`build:mac`/`build:win` 链在 `electron-vite build` 前插 `bun run prebundle:kb-model && bun run verify:kb-model`：
```jsonc
"build:mac": "bun run verify:fusion && bun run build:icons && bun run prebundle:daemon && bun run prebundle:kb-model && bun run verify:kb-model && electron-vite build && electron-builder --mac --publish never",
```

- [ ] **Step 4: 打包后断言 unpacked .node 存在**

`verify:kb-model`（或新增 `verify:asar`）里加：打包产物 `dist/mac-arm64/Claude Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/onnxruntime-node/**/*.node` 存在（bun 的 hoist 布局与 npm 不同，必须实测一次）。

- [ ] **Step 5: CI**

`.github/workflows/build.yml` 在现有 fusion-code/python 下载步骤旁加「下载 kb-model」步骤（同 `gh release` 范式），并确保 `build:mac` 链已含 prebundle/verify。

- [ ] **Step 6: 真打包验收**

```bash
cd apps/desktop && bun run build:mac
```
Expected: 链路不报错；`dist/` 产出 .dmg/.zip；`app.asar.unpacked/node_modules/onnxruntime-node` 含 darwin-arm64 `.node`；`Resources/kb-model/bge-small-zh-v1.5/` 文件齐。装包跑一次，进方案模式搜「智能导诊」出语义命中（运行时零网络）。

- [ ] **Step 7: commit**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/package.json apps/desktop/scripts/prebundle-kb-model.mjs apps/desktop/scripts/verify-kb-model.mjs .github/workflows/build.yml apps/desktop/bun.lock
git commit -m "build(proposal): 语义检索打包——transformers依赖+asarUnpack+平台裁剪+kb-model拉取/校验+CI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec 覆盖核对：**
- 混合检索 RRF → Task 2 + Task 5。✅
- 本地 embedding v3/512 维 → Task 0(钉版) + Task 4/5。✅
- 模型构建时拉取、运行时零网络 → Task 9 + Task 6(allowRemoteModels=false)。✅
- utilityProcess 不冻 main + warmup + 超时降级 → Task 5 + Task 6 + Task 7。✅
- 向量存储 vectors.bin + meta、不上向量库 → Task 4。✅
- version 复用 bump 到 2、stale 检测 → Task 3 + Task 5(fingerprint) + Task 6。✅
- stale→BM25 降级不返空、engine 忽略旗标 → Task 6 + Task 7。✅
- 唯一分块表行号对齐（chunkText offset）→ Task 1 + Task 4 + Task 5。✅
- 两出口（面板 + kb_search）→ Task 8 + Task 7。✅
- 平台级裁剪/分平台 extraResources/去 install-app-deps 依赖/asar 断言 → Task 9。✅
- 测试：cosineTopK/fuseRRF/chunkText offset/stale 降级/BM25 回归 → Task 1/2 测，stale 降级在 Task 6 手测（worker 依赖原生模型不单测）。⚠️ 补：Task 6 可加一个不依赖模型的 `bm25Fallback` 纯函数单测（见下）。

**补一个遗漏单测（加进 Task 6 Step）：** `bm25Fallback` 不依赖 worker/模型，可单测「worker 未就绪时 kbSemanticSearch 返回非空 BM25 结果且 staleIndex 透传」——把 `bm25Fallback` 导出，写一个用假 scopes 的测试，断言 hits 来自 retrievePassages、不返空。

**Placeholder 扫描：** 无 TBD/TODO；集成任务（5-9）的 SDK 工具注册形态、renderer 组件、prebundle 脚本给了 file:line 锚点 + 范式参照 + 完整接口契约，执行者照既有同类代码落地。Task 0 钉死 v3 API 供 4/5 逐字用。

**类型一致性：** `SemanticHit`(shared/kbIndex) 贯穿 Task 5/6/7/8；`VectorMeta/VectorStoreMeta`(Task 3) → Task 4 写、Task 5 读；`row` 对齐键贯穿 Task 1/2/5；`chunkTextWithOffsets`(Task 1) → Task 4。一致。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-kb-semantic-search-p1.md`.
