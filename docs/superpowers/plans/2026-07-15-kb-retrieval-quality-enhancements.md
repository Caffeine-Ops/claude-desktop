# 知识库检索质量增强（借鉴 AnythingLLM）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有混合检索管线（BM25 + bge 向量 RRF）上做四项**不改架构**的质量增强——查询侧前缀(P0，已落地)、cross-encoder 二阶段重排(P1，本计划核心)、chunk 来源头(P2，需重建索引)、多轮引用回填(P3)。全部落在现有 embed/search 子系统内。

**Architecture:** 增量增强，不动检索架构：P0 只改查询期嵌入输入；P1 在 `embedWorker` 的 `search()` 融合结果后插入一个 cross-encoder 重排步（同进程、singleton、失败即回落 RRF），reranker 模型经现有 `prebundle-kb-model` 范式随包发布；P2 改离线 embed 的嵌入内容（前置来源头，需 version bump 重建）；P3 在 engine 的 `SessionRuntime` 加会话级 sources 历史，命中不足时回填注入。

**Tech Stack:** Electron utilityProcess、@huggingface/transformers（已有依赖，AutoModelForSequenceClassification 跑 cross-encoder）、bun test、现有 kb-model 打包链（manifest + prebundle + verify + extraResources）。

**Spec:** `docs/superpowers/specs/2026-07-15-kb-retrieval-quality-from-anythingllm-design.md`

**后续/独立立项（不在本计划内）：** 向量存储换 LanceDB（扩展性，独立 spec）；扫描件 OCR 兜底（文档转换子系统，独立 spec）；模型改首次运行时下载（安装包瘦身）。

## Global Constraints

- 包管理器是 **bun**，不是 npm；studio 包测试跑 `cd apps/studio && bun test electron/`。
- `bun run typecheck`（root，双 tsc：Next 侧 + electron 侧 tsconfig.node.json）是唯一质量门，每个 task 结束必须绿。**没有 ESLint、类型检查是唯一自动化防线。**
- 注释风格：解释「为什么这样而不是那样」，不写「做了什么」。
- **绝不允许模型加载 / 推理落在 main 进程**——embed 与 rerank 只能在 utilityProcess（`embedWorker`）里。
- `kbSemanticSearch.ts` 的顺序不变量（ready/stale 检查先于 postMessage）、exit 三态复位、mtime 自愈不可破坏。
- 向量产物对齐不变量：`vectors.bin` 行 i ↔ `vectors-meta.rows[i]`，fingerprint 绑 `KbIndex.builtAtMs`。
- **reranker 是纯增强层**：任何失败/缺失/超时都必须静默回落到未重排的 RRF 结果，绝不让检索变空、变差、报错、或拖慢 engine 写正文热路径。
- **P0 的非对称纪律**：前缀只加向量腿的 query，BM25 那路（`rankChunks(query,…)`）永远用裸 query。
- 改模型 id / 前缀 = 改契约：`shared/kbIndex.ts` 与 `scripts/kb-model-manifest.mjs` 两处同步（互有指路注释）。

---

### Task 1: P0 查询侧指令前缀（✅ 已落地，待并入提交）

**状态：实现已完成于工作区**（当前分支 `feat/kb-markitdown-one-click-install`），typecheck 已绿。本 task 记录其内容 + 收尾（A/B 与提交）。

**Files:**
- Modified: `apps/studio/electron/shared/kbIndex.ts`（新增 `KB_QUERY_INSTRUCTION` + `KB_QUERY_INSTRUCTION_ENABLED`）
- Modified: `apps/studio/electron/main/workers/embedWorker.ts`（import 常量；仅向量腿 query 拼前缀，BM25 路不动）

**Interfaces:**
- Produces: `KB_QUERY_INSTRUCTION: string`、`KB_QUERY_INSTRUCTION_ENABLED: boolean`（一键回退开关）。

- [x] **Step 1: 常量落 `kbIndex.ts`**（`KB_MODEL_ID` 后，带非对称/可回退注释）
- [x] **Step 2: `embedWorker.ts:90` 仅嵌入调用拼前缀**（`embedInput = ENABLED ? PREFIX + query : query`），`:103` BM25 保持裸 `query`
- [x] **Step 3: typecheck 绿**（全 workspace，含 studio 双 tsc）
- [ ] **Step 4: A/B 走查（人工，非阻塞）**

  起 `bun run dev`，进写方案、选产品，用一组「模糊/同义」需求 query（库里写「分诊流程」、搜「智能导诊」）对比 `KB_QUERY_INSTRUCTION_ENABLED` true/false 的 top-k 命中相关性。
  Expected: 加前缀不劣于裸 query（理想为改善）。若明显无益/有害 → 置 `false` 保留代码但关闭（bge v1.5 对指令依赖弱，属预期内）。

- [ ] **Step 5: Commit（可与本计划文档一起提交）**

```bash
git add apps/studio/electron/shared/kbIndex.ts apps/studio/electron/main/workers/embedWorker.ts \
        docs/superpowers/specs/2026-07-15-kb-retrieval-quality-from-anythingllm-design.md \
        docs/superpowers/plans/2026-07-15-kb-retrieval-quality-enhancements.md
git commit -m "feat(kb): bge 查询侧指令前缀(P0，非对称)+检索质量增强 spec/plan"
```

---

### Task 2: P1 重排选择纯核（`proposalSemantic.core.ts`）

先把「过量召回 → 按 reranker 分重排 → 取 top-k」里**不依赖模型的部分**抽成纯函数，可 bun test 直测。模型推理本身在 Task 4 接。

**Files:**
- Modify: `apps/studio/electron/main/core/proposalSemantic.core.ts`
- Test: `apps/studio/electron/main/core/proposalSemantic.core.test.ts`（已存在，追加 describe 块）

**Interfaces:**
- Consumes: 现有 `fuseRRF` 的输出 `{ row: number; score: number }[]`。
- Produces（Task 4 消费，签名冻结）：

```ts
/** 过量召回窗口：融合结果里取前 M 行送重排。M 参 AnythingLLM 的 max(10,min(50,…))，
 *  但我们候选已在产品域内收窄，上限更小。fused 少于 M 则全取。返回待重排的行号序列（保序）。 */
export function rerankWindow(fused: readonly { row: number; score: number }[], m: number): number[]
/** 用 reranker 分对候选行重排取 top-k。scores[i] 对应 candidateRows[i]。稳定降序（同分保留 RRF 序）。 */
export function applyRerank(candidateRows: readonly number[], scores: readonly number[], k: number): { row: number; score: number }[]
```

- [ ] **Step 1: 写失败测试**（追加到 `proposalSemantic.core.test.ts`）

```ts
import { rerankWindow, applyRerank } from './proposalSemantic.core'

describe('rerankWindow', () => {
  test('取前 M 行、保序、不足 M 全取', () => {
    const fused = [{ row: 7, score: 3 }, { row: 2, score: 2 }, { row: 5, score: 1 }]
    expect(rerankWindow(fused, 2)).toEqual([7, 2])
    expect(rerankWindow(fused, 10)).toEqual([7, 2, 5])
    expect(rerankWindow([], 5)).toEqual([])
  })
})

describe('applyRerank', () => {
  test('按 reranker 分降序取 top-k，score 用 reranker 分', () => {
    const rows = [7, 2, 5]
    const scores = [0.1, 0.9, 0.5] // 2 最相关、5 次、7 最低
    expect(applyRerank(rows, scores, 2)).toEqual([{ row: 2, score: 0.9 }, { row: 5, score: 0.5 }])
  })
  test('同分保留输入(RRF)序——稳定排序', () => {
    expect(applyRerank([7, 2], [0.5, 0.5], 2)).toEqual([{ row: 7, score: 0.5 }, { row: 2, score: 0.5 }])
  })
  test('长度不匹配/空 → 空数组（防御，触发调用方回落 RRF）', () => {
    expect(applyRerank([7, 2], [0.5], 2)).toEqual([])
    expect(applyRerank([], [], 5)).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/main/core/proposalSemantic.core.test.ts`
Expected: FAIL（`rerankWindow`/`applyRerank` 未导出）

- [ ] **Step 3: 实现**（追加到 `proposalSemantic.core.ts`）

```ts
export function rerankWindow(fused: readonly { row: number; score: number }[], m: number): number[] {
  return fused.slice(0, Math.max(0, m)).map((f) => f.row)
}

export function applyRerank(
  candidateRows: readonly number[], scores: readonly number[], k: number
): { row: number; score: number }[] {
  // 长度不匹配 = reranker 输出与候选错位（推理异常/截断）→ 返回空，调用方据此回落 RRF。
  if (candidateRows.length === 0 || candidateRows.length !== scores.length) return []
  // 稳定降序：map 带原下标，同分按原下标（即 RRF 序）升序，保留融合排名的 tie-break。
  return candidateRows
    .map((row, i) => ({ row, score: scores[i]!, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, k)
    .map(({ row, score }) => ({ row, score }))
}
```

- [ ] **Step 4: 跑测试 + typecheck**

Run: `cd apps/studio && bun test electron/main/core/proposalSemantic.core.test.ts && cd ../.. && bun run typecheck`
Expected: 新增测试 PASS；typecheck 绿；现有 semantic core 测试零回归。

- [ ] **Step 5: Commit**

```bash
git add apps/studio/electron/main/core/proposalSemantic.core.ts apps/studio/electron/main/core/proposalSemantic.core.test.ts
git commit -m "feat(kb): 重排选择纯核 rerankWindow/applyRerank——P1 cross-encoder 的可测底座"
```

---

### Task 3: P1 reranker 模型进打包链（manifest 多模型化 + prebundle + verify + extraResources）

reranker 模型要像 bge embed 模型一样随包发布、运行时零网络。现有 `kb-model-manifest.mjs` 是**单模型**结构（`MODEL_DIR_NAME`/`HF_REPO`/`SHA256`/`MIN_SIZE` 皆单数），本 task 泛化为**模型数组**，prebundle/verify 循环处理，reranker 作为第二个条目加入。

**选型前置**：Task 开始先用真实中文 query 实测 `Xenova/bge-reranker-base`（更快更小）vs `bge-reranker-v2-m3`（更准更大）——量化 ONNX 体积与 CPU 单批延迟是主要权衡，结果写进 manifest 注释。默认先用 `bge-reranker-base`（体积/延迟保守）。

**Files:**
- Modify: `apps/studio/scripts/kb-model-manifest.mjs`（单模型 → `MODELS` 数组）
- Modify: `apps/studio/scripts/prebundle-kb-model.mjs`（遍历 MODELS 下载）
- Modify: `apps/studio/scripts/verify-kb-model.mjs`（遍历 MODELS 校验）
- Modify: electron-builder 配置的 `mac/win.extraResources`（确认 `kb-model` 整目录发布已覆盖新子目录——通常已是 `{from:"kb-model",to:"kb-model"}`，只需验证不需改）
- Modify: `apps/studio/electron/shared/kbIndex.ts`（加 `KB_RERANKER_MODEL_ID` 常量，作 TS 侧事实源，与 manifest 互指）

**Interfaces:**
- Produces: `KB_RERANKER_MODEL_ID`（TS 侧，Task 4 加载用）；manifest `MODELS: {dirName, hfRepo, sha256, minSize}[]`。

- [ ] **Step 1: manifest 多模型化**（保持向后兼容：旧的单数导出可保留为 `MODELS[0]` 的投影，或一次性改所有消费方）

```js
// kb-model-manifest.mjs —— MODELS 数组，每个模型自带目录名/仓库/pin/体积下限
export const MODELS = [
  {
    dirName: 'bge-small-zh-v1.5',           // = shared/kbIndex.ts KB_MODEL_ID（嵌入）
    hfRepo: 'Xenova/bge-small-zh-v1.5',
    sha256: { 'config.json': 'd419…', 'tokenizer.json': '48ce…', 'tokenizer_config.json': 'e6f3…', 'onnx/model_quantized.onnx': '15b7…' },
    minSize: { 'config.json': 100, 'tokenizer.json': 100_000, 'tokenizer_config.json': 100, 'onnx/model_quantized.onnx': 20_000_000 }
  },
  {
    dirName: 'bge-reranker-base',            // = shared/kbIndex.ts KB_RERANKER_MODEL_ID（重排）
    hfRepo: 'Xenova/bge-reranker-base',      // ⚠️ 选型定后回填真实文件清单/pin（Step 0 实测）
    sha256: { /* Task 期间下载后算 */ },
    minSize: { /* config/tokenizer/onnx 下限 */ }
  }
]
```

- [ ] **Step 2: prebundle/verify 改遍历 MODELS**

两脚本原本对单模型的下载/校验逻辑抽成 `forEachModel(m => …)`，路径从 `kb-model/<m.dirName>/...` 派生。**verify 必须对每个模型每个文件校 sha——漏一个模型就是坏产物直通打包**（沿用 manifest 头注释的教训）。

- [ ] **Step 3: 拉取真实文件与 pin**

Run: `cd apps/studio && bun scripts/prebundle-kb-model.mjs`
Expected: `kb-model/bge-small-zh-v1.5/` 与 `kb-model/bge-reranker-base/` 都就位；把 reranker 各文件的 sha256/minSize 回填进 manifest（Step 1 占位符）。

- [ ] **Step 4: verify 绿 + extraResources 确认**

Run: `cd apps/studio && bun scripts/verify-kb-model.mjs`
Expected: 两模型全部文件 sha/size 通过。检查 electron-builder 配置 `mac/win.extraResources` 是否 `{from:"kb-model",to:"kb-model"}`（整目录）——是则新子目录自动带上，无需改；若是逐模型枚举则补 reranker 目录。

- [ ] **Step 5: TS 常量 + typecheck**

`kbIndex.ts` 加（紧邻 `KB_MODEL_ID`，带互指注释）：

```ts
/** cross-encoder 重排模型 id（P1）。= kb-model-manifest.mjs MODELS[1].dirName。本地布局
 *  kb-model/<KB_RERANKER_MODEL_ID>/，无 Xenova 前缀（同 KB_MODEL_ID）。换模型两处同步。 */
export const KB_RERANKER_MODEL_ID = 'bge-reranker-base'
```

Run: `bun run typecheck`
Expected: 绿。

- [ ] **Step 6: Commit**

```bash
git add apps/studio/scripts/kb-model-manifest.mjs apps/studio/scripts/prebundle-kb-model.mjs \
        apps/studio/scripts/verify-kb-model.mjs apps/studio/electron/shared/kbIndex.ts
git commit -m "feat(kb): kb-model 打包链多模型化 + 引入 bge-reranker-base——P1 重排模型随包发布"
```

---

### Task 4: P1 把 cross-encoder 重排接进 `embedWorker.search()`

在 `search()` 的 `fuseRRF(...).slice(0, k)` 处改为「融合 → rerankWindow 取前 M → reranker 打分 → applyRerank 取 k」，reranker 缺失/失败即回落原 `slice(0,k)`。reranker pipeline 与 embed 同进程 singleton，lazy 建、失败不影响 embed 路。

**Files:**
- Modify: `apps/studio/electron/main/workers/embedWorker.ts`

**Interfaces:**
- Consumes: Task 2 的 `rerankWindow`/`applyRerank`；Task 3 的 `KB_RERANKER_MODEL_ID`。
- search 消息新增可选 `rerank?: boolean`（Task 5 传入，默认按调用方决定）。

- [ ] **Step 1: reranker 加载（singleton，失败置 null）**

在 `init()` 末尾（embed ready 后）追加，**独立 try/catch**——reranker 建失败绝不能拖垮 embed：

```ts
import {
  AutoModelForSequenceClassification, AutoTokenizer,
  type PreTrainedModel, type PreTrainedTokenizer
} from '@huggingface/transformers'
import { KB_RERANKER_MODEL_ID } from '../../shared/kbIndex'

let reranker: { model: PreTrainedModel; tokenizer: PreTrainedTokenizer } | null = null

async function initReranker(): Promise<void> {
  try {
    const [model, tokenizer] = await Promise.all([
      AutoModelForSequenceClassification.from_pretrained(KB_RERANKER_MODEL_ID, { dtype: 'q8' }),
      AutoTokenizer.from_pretrained(KB_RERANKER_MODEL_ID)
    ])
    reranker = { model, tokenizer }
  } catch (err) {
    reranker = null // 缺模型/加载失败：静默降级，检索继续用 RRF
    parentPort.postMessage({ type: 'log', line: `reranker 不可用，回落 RRF：${String(err)}` })
  }
}
```

在 `init()` 里 embed `pipeline` 就绪、`postMessage({type:'ready'})` **之后**调用 `void initReranker()`（不 await——reranker 慢加载不该拖延 ready；未就绪时 search 自然回落 RRF）。

- [ ] **Step 2: search() 融合后插入重排**

`const fused = fuseRRF(bm, vTop).slice(0, k)` 改为：

```ts
const fusedAll = fuseRRF(bm, vTop)
const rows = await rerankOrFallback(query, fusedAll, k, wantRerank)
return rows.map(({ row, score }) => { /* 现有水合逻辑不变 */ })
```

新增 `rerankOrFallback`：

```ts
const RERANK_WINDOW = 30 // 过量召回窗口，候选已在产品域内，30 足够；越大越慢

async function rerankOrFallback(
  query: string, fused: readonly { row: number; score: number }[], k: number, want: boolean
): Promise<{ row: number; score: number }[]> {
  const rrfTopK = fused.slice(0, k)
  if (!want || !reranker || fused.length === 0) return rrfTopK
  try {
    const candidateRows = rerankWindow(fused, RERANK_WINDOW)
    const passages = candidateRows.map((r) => meta!.rows[r]!.text)
    const queries = passages.map(() => query) // text-pair：每条 (query, passage)
    const inputs = reranker.tokenizer(queries, { text_pair: passages, padding: true, truncation: true })
    const { logits } = await reranker.model(inputs)
    const scores = logits.sigmoid().tolist().map((r: number[]) => r[0]) // 单 logit → 相关分
    const reranked = applyRerank(candidateRows, scores, k)
    return reranked.length > 0 ? reranked : rrfTopK // applyRerank 防御返空 → 回落
  } catch (err) {
    parentPort.postMessage({ type: 'log', line: `rerank 推理失败，回落 RRF：${String(err)}` })
    return rrfTopK
  }
}
```

search 签名加 `wantRerank`，从消息透传（缺省 `false`，向后兼容旧 main）。`message` 处理器把 `msg.rerank ?? false` 传入。

- [ ] **Step 3: typecheck + 手动冒烟**

Run: `cd apps/studio && cd ../.. && bun run typecheck`
Expected: 绿（transformers 的 `AutoModelForSequenceClassification`/`text_pair` 类型可用；若 tolist 类型窄，按现有 `out.data as Float32Array` 的 cast 风格处理）。

手动冒烟（Task 5 接好开关后做完整走查）：`bun run dev`，选产品搜一句需求，dev 终端应见 embed 命中；reranker 就绪后结果顺序由重排分决定，未就绪/超时回落 RRF——两种都不报错、不空。

- [ ] **Step 4: Commit**

```bash
git add apps/studio/electron/main/workers/embedWorker.ts
git commit -m "feat(kb): embedWorker 融合后接 cross-encoder 重排——singleton/懒加载/失败回落 RRF"
```

---

### Task 5: P1 差异化重排开关与超时（`kbSemanticSearch.ts` + 两个消费方）

reranker 慢（几百 ms~数秒），engine 写正文热路径不能被拖。给 `kbSemanticSearch` 加可选项：面板开重排 + 宽超时；engine 自动召回按预算开/关 + 保持 1500ms（超时用未重排 RRF）。

**Files:**
- Modify: `apps/studio/electron/main/core/kbSemanticSearch.ts`（签名加 opts，透传 rerank、可覆盖 timeout）
- Modify: `apps/studio/electron/main/core/engine.ts`（`:1308` 自动召回、`:1840` kb_search 工具的调用点）
- Modify: 面板 IPC 链（`KB_SEMANTIC_SEARCH` handler 传 rerank=true）

**Interfaces:**
- `kbSemanticSearch(query, scopes, k=5, opts?: { rerank?: boolean; timeoutMs?: number })`。默认 `rerank:false, timeoutMs:1500`（向后兼容现状）。

- [ ] **Step 1: 写失败测试**（若 `kbSemanticSearch` 有可测面则加；否则以纯核 Task 2 覆盖，本 task 靠 typecheck + 手动走查）

`kbSemanticSearch` 依赖 utilityProcess，难纯测。**测超时透传的纯逻辑**：把「据 opts 选 timeout」抽一个 `const timeout = opts?.timeoutMs ?? SEARCH_TIMEOUT_MS`，无需单测；主要验收靠 Step 4 手动走查 + typecheck。若要单测，可抽 `resolveSearchOpts(opts)` 纯函数测默认值合并。

- [ ] **Step 2: 实现 opts 透传**

`kbSemanticSearch` 签名加 opts；`postMessage({type:'search', …, rerank: opts?.rerank ?? false})`；`setTimeout(…, opts?.timeoutMs ?? SEARCH_TIMEOUT_MS)`。**顺序不变量不动**（ready/stale 检查仍在 postMessage 前）。BM25 降级路不受 rerank 影响（降级本就无向量）。

- [ ] **Step 3: 两个消费方按场景开关**

- 面板 handler：`kbSemanticSearch(q, scopes, k, { rerank: true, timeoutMs: 4000 })` + 前端加 loading 态（用户主动搜、可等）。
- engine 自动召回（`:1308`）：`kbSemanticSearch(text, scopes, 5, { rerank: true, timeoutMs: 1500 })`——**开重排但不放宽超时**，来得及则增强、来不及用 RRF 结果，绝不拖慢出字。
- engine kb_search 工具（`:1840`）：`{ rerank: true, timeoutMs: 3000 }`（AI 工具调用，容忍中等延迟）。

- [ ] **Step 4: typecheck + 完整走查**

Run: `bun run typecheck`
Expected: 绿。

`bun run dev` 完整走查：① 面板搜「模糊/同义」query，观察结果与 loading；② 写正文触发自动召回，dev 终端确认热路径未因重排明显变慢（超时回落即用 RRF）；③ 删除/改坏 reranker 目录再跑，确认全链回落 RRF、不报错不空。

- [ ] **Step 5: Commit**

```bash
git add apps/studio/electron/main/core/kbSemanticSearch.ts apps/studio/electron/main/core/engine.ts \
        apps/studio/electron/main/ipc/register.ts apps/studio/src/chat/components/workspace/KbSemanticSearchPanel.tsx
git commit -m "feat(kb): 差异化重排开关/超时——面板宽松、engine 热路径保 1500ms 超时即回落"
```

**至此 P1 完成。** 下面 P2/P3 视需求择机，非本轮必做。

---

### Task 6:（P2，需重建索引，择机）chunk 前置来源元数据头

给每个 chunk 前置 `<source>产品线：… | 文档：…</source>` 再嵌入，提升标题/产品词召回与 grounding。**采用 spec 方案 A**：头只进嵌入输入与注入呈现，**不进 `VectorMeta.text`**（保 BM25 语料纯净 + charStart/charEnd 回切不变量）。改嵌入内容 → version bump 3、重建整库。

**Files:**
- Modify: `apps/studio/electron/main/core/kbBuild/embed.ts`（嵌入前拼头）
- Modify: `apps/studio/electron/shared/kbIndex.ts`（`version: 2|3`，`KbIndex` 已是 2|3 则复用；VectorStoreMeta 或加 headerless 说明）
- New: `apps/studio/electron/main/core/kbBuild/chunkHeader.ts` + `.test.ts`（纯函数）

**Interfaces:**
```ts
export function buildChunkHeader(productLine: string, product: string, title: string): string
```

- [ ] **Step 1: 写失败测试**（`chunkHeader.test.ts`）

```ts
import { buildChunkHeader } from './chunkHeader'
describe('buildChunkHeader', () => {
  test('两级/一级/缺失都产出稳定单行头', () => {
    expect(buildChunkHeader('智能预问诊系统', '需求规格', '方案')).toBe('<source>产品线：智能预问诊系统 | 产品：需求规格 | 文档：方案</source>\n')
    expect(buildChunkHeader('线A', '', '白皮书')).toBe('<source>产品线：线A | 文档：白皮书</source>\n')
  })
})
```

- [ ] **Step 2-4:** 确认失败 → 实现 `buildChunkHeader`（拼串纯函数）→ `embed.ts:66` 把 `texts[i]` 改为 `buildChunkHeader(...) + texts[i]` 喂 `extractor`，**`VectorMeta.text` 仍存纯 chunk**（不含头）→ version bump + 重建 → typecheck + 现有 embed 相关测试绿。

- [ ] **Step 5: 全库重建 + 冒烟**

Run: 触发一次 KB 重建（管理页或脚本），旧库经 fingerprint 不符走 stale 提示。重建后搜「标题词」应命中含该词标题的 chunk。

- [ ] **Step 6: Commit** `feat(kb): chunk 前置来源头(方案A，仅进嵌入)——标题词召回+grounding，需重建索引`

---

### Task 7:（P3，会话态，择机）多轮引用回填

engine 每 tab 的 `SessionRuntime` 加会话级 sources 历史；自动召回命中不足时，从历史轮已注入的 hits 按唯一键去重回填，补满注入窗口（不必跑 reranker）。

**Files:**
- Modify: `apps/studio/electron/main/core/engine.ts`（`SessionRuntime` 加 `proposalRecentHits`；`:1308` 召回后并入 + 命中不足时回填）
- Modify: `apps/studio/electron/main/core/proposalSemantic.core.ts`（回填纯函数）+ 测试

**Interfaces:**
```ts
/** 命中不足 target 时，用 history 补齐。按 mirrorPath+text 去重、跳过 current 已有、保序、截到 target。 */
export function backfillHits(current: readonly SemanticHit[], history: readonly SemanticHit[], target: number): SemanticHit[]
```

- [ ] **Step 1: 写失败测试**（`proposalSemantic.core.test.ts` 追加）

```ts
import { backfillHits } from './proposalSemantic.core'
const h = (mirrorPath: string, text: string): any => ({ mirrorPath, text, title: '', sourcePath: '', productLine: '', product: '', snippet: '', score: 0 })
describe('backfillHits', () => {
  test('不足则回填、去重、保序、截断', () => {
    const cur = [h('a', 'x')]
    const hist = [h('a', 'x'), h('b', 'y'), h('c', 'z')] // a 与 cur 重复
    expect(backfillHits(cur, hist, 3).map((r) => r.mirrorPath)).toEqual(['a', 'b', 'c'])
  })
  test('已满则原样返回', () => {
    const cur = [h('a', 'x'), h('b', 'y')]
    expect(backfillHits(cur, [h('c', 'z')], 2)).toBe(cur)
  })
})
```

- [ ] **Step 2-4:** 确认失败 → 实现 `backfillHits`（Set 去重 `mirrorPath\0text`）→ engine 接线（`SessionRuntime.proposalRecentHits` 有限环形上限 20；`:1308` 拿 hits 后并入历史、命中 < 目标时 `backfillHits` 再 `renderRetrievedBlock`）→ typecheck + 测试绿。

- [ ] **Step 5: 走查** 长会话追问（「基于上面第 3 条扩写」）时 dev 终端确认回填注入生效、同会话隔离、上限不撑爆。

- [ ] **Step 6: Commit** `feat(kb): 多轮引用回填(P3)——命中不足从会话历史补齐，长会话打磨引用连贯`

---

## 验收标准（全计划）

- **P0**：query 侧嵌入拼前缀、BM25 裸 query；A/B 无回退；开关可一键关；不重建索引。
- **P1**：开重排时结果由 cross-encoder 分决定，关/缺失/超时等价现状 RRF；engine 热路径无可感变慢；reranker 模型经 prebundle/verify/extraResources 打包、运行时零网络；全链任何 reranker 失败都回落 RRF、不空不报错。
- **P2**（若做）：头只进嵌入、`text` 保持纯 chunk（offset 回切不变量绿）；version bump、旧库提示重建；重建后标题词召回提升。
- **P3**（若做）：命中不足从会话历史回填、去重限量、仅同会话；纯函数覆盖。
- **通用**：`bun run typecheck` 全绿；新增纯核有 bun test；`proposalRetrieve.core.ts` / `proposalSemantic.core.ts` 现有测试零回归。
