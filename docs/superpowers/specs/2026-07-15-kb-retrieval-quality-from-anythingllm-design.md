# 方案写作·知识库检索质量增强（借鉴 AnythingLLM）

日期：2026-07-15
状态：设计草案，待用户复核 → writing-plans
前序：检索现状见 spec `2026-06-30-kb-semantic-search-design.md`（混合检索 BM25+向量 RRF 已交付）、`2026-06-23-kb-driven-proposal-writer-design.md`。本 spec 不改检索架构，只在既有混合检索管线上做**质量增强**。

## 背景与目标

现有语义检索已经是 BM25 + 向量（bge-small-zh-v1.5）RRF 融合，跑在 utilityProcess（`embedWorker.ts`），main 侧薄包装带超时/降级（`kbSemanticSearch.ts`）。管线本身是好的。

调研了开源同类 AnythingLLM 的检索代码后，识别出**四个它有、我们没有、且不改架构就能加**的质量增强点。全部落在既有的 embed/search 子系统里，按「性价比（收益/改动成本）」排 P0→P3：

| 阶段 | 增强点 | 是否需重建索引 | 核心收益 |
|---|---|---|---|
| **P0** | bge 查询侧指令前缀（非对称嵌入） | 否（仅改 query 侧） | 召回精度，一行改动，可 A/B |
| **P1** | cross-encoder 二阶段重排 | 否（查询期） | 精排质量最大杠杆 |
| **P2** | chunk 前置来源元数据头 | 是（改嵌入内容） | 标题/产品词召回 + grounding |
| **P3** | 多轮引用回填（fillSourceWindow） | 否（会话态） | 长会话逐段打磨的引用连贯性 |

**明确非目标（本 spec 不做）**：
- 不换向量存储（vectors.bin → LanceDB 是独立的**扩展性**议题，另立 spec，见「未来」）。
- 不碰文档转换/OCR（markitdown 现状；扫描件 OCR 兜底另立 spec）。
- 不做 query 改写/扩展、不做向量增量更新精细化。
- 不改 RRF 融合本身、不改 BM25 核（`proposalRetrieve.core.ts` 保持零回归）。

## 关键背景事实（借鉴依据）

AnythingLLM 相关实现（已读源码，供设计参照，非照搬）：
- **查询/passage 非对称前缀**：`EmbeddingEngines/native` 对 e5/nomic 模型用 `query:`/`passage:` 双前缀，检索 query 加前缀、passage 存储加前缀。我们的 bge 官方建议是**只查询侧**加 `为这个句子生成表示以用于检索相关文章：`，passage 侧不加——对我们更省（passage 不动 = 不重建索引）。
- **cross-encoder 重排**：`EmbeddingRerankers/native` 用 `AutoModelForSequenceClassification` 把 query+passage 作为 text-pair 联合编码，`logits.sigmoid()` 当相关分。`lance/index.js` 里开 rerank 时先**过量召回** `max(10, min(50, ceil(total*0.1)))` 再重排到 topN。singleton + 并发去重初始化。
- **fillSourceWindow**：`helpers/chat/index.js` 当本轮命中不足时，从历史轮已存的 sources 按 chunk id 去重回填，补满引用窗口，且不必跑 reranker。
- **chunk 元数据头**：`TextSplitter.buildHeaderMeta/stringifyHeader` 把 title/published/source 拼成 `<document_metadata>…</document_metadata>` prepend 到每块正文再嵌入+存储。

> AnythingLLM 本身**不做** hybrid/BM25、中文特化、表格保形、offset 对齐——这些我们已领先，不在借鉴范围。它的向量库多后端抽象为 SaaS 多租户设计，单机场景是负担，不借鉴。

## 现状（已查证，行号基于 apps/studio/）

- **查询期嵌入**：`electron/main/workers/embedWorker.ts:90` `const out = await extractor(query, { pooling:'mean', normalize:true })` —— query **裸文本**、无前缀。同一 `query` 在 `:103` 又喂给 BM25 `rankChunks(query, bmInput, {topK:N})`。两路共用一个 `query` 变量。`:96` `N=40`（两路各取域内前 40）。`:106` `fuseRRF(bm, vTop).slice(0, k)` 是融合后截断——**重排的天然插入点**。
- **离线（passage）嵌入**：`electron/main/core/kbBuild/embed.ts:44` 建 pipeline、`:66` `extractor(texts[i], {pooling:'mean', normalize:true})` —— passage **裸文本**、无前缀。
- **模型 id 唯一事实源**：`electron/shared/kbIndex.ts:9` `KB_MODEL_ID='bge-small-zh-v1.5'`；`VectorStoreMeta{version:2, dim:512, fingerprint, rows:VectorMeta[]}`。`SemanticHit{title,sourcePath,mirrorPath,productLine,product,text,snippet,score}`（`:60`）。
- **main 薄包装**：`electron/main/core/kbSemanticSearch.ts:129` `kbSemanticSearch(query, scopes, k=5)`；`SEARCH_TIMEOUT_MS=1500`（`:22`）；worker 未就绪/stale/超时 → `bm25Fallback` 降级、绝不返空（`:137-142`）；`degraded` 旗标区分基础设施降级 vs 正常补齐。worker fork 时以 argv 传 `[modelDir, kbOutDir, expectedFp]`（`:86`），`modelDir()`（`:70`）打包取 `resourcesPath/kb-model`、dev 取 `apps/studio/kb-model`。
- **两个消费方**：`engine.ts:1308` `await kbSemanticSearch(text, scopes)`（写正文自动召回，**忽略 staleIndex**）；`engine.ts:1840` `kbSemanticSearch(q, scopes, 8)`（AI 的 kb_search 工具）；搜索面板 `KbSemanticSearchPanel.tsx` 经 `KB_SEMANTIC_SEARCH` IPC。
- **模型打包范式（已存在，可复用）**：`apps/studio/scripts/prebundle-kb-model.mjs` 从钉版 HF 仓库按 sha256 拉模型到 `apps/studio/kb-model/<MODEL_DIR>/`；`kb-model-manifest.mjs` 是目录名/HF 仓库/sha256 的唯一事实源（与 `verify-*.mjs` 共享）；electron-builder `mac/win.extraResources` 发布 `kb-model`；`asarUnpack` 已含 `**/onnxruntime-node/**`。
- **纯核**：`proposalSemantic.core.ts` 有 `cosineTopKRows/fuseRRF/passagesToHits/fillHitsToK`，均无 electron 依赖、可 bun test。

---

## 设计

### P0 — 查询侧指令前缀（非对称嵌入）

**改动文件**：`electron/main/workers/embedWorker.ts`、`electron/shared/kbIndex.ts`（放前缀常量）。**不重建索引。**

bge-small-zh-v1.5 官方建议：短查询→长文档（s2p）检索场景，查询侧加固定指令前缀提升表示质量，passage 侧不加。我们的方案召回正是「短需求 → 长产品文档」，passage 现状本就无前缀，因此**只在 query 侧加前缀，无需重建向量库**。

- 在 `kbIndex.ts` 新增常量（与 `KB_MODEL_ID` 同处，作模型契约的一部分）：
  ```ts
  /** bge s2p 检索：仅查询侧加指令前缀，passage 侧不加。前缀绑模型——换模型须同改。 */
  export const KB_QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：'
  ```
- `embedWorker.ts:90` 改为**只给嵌入调用**加前缀，**BM25 那路（`:103`）必须保持裸 query**：
  ```ts
  const out = await extractor(KB_QUERY_INSTRUCTION + query, { pooling:'mean', normalize:true })
  // :103 不变：rankChunks(query, …) —— BM25 是词面匹配，加前缀反而污染 tf
  ```
- **可回退开关**：前缀是常量，效果不确定（见下「风险」），实现时把「是否加前缀」做成一个模块级 `const` 布尔（或复用现有配置），便于 A/B 与一键回退，不埋进散落代码。

**为什么不动 passage 侧**：passage 加前缀需重建整库（fingerprint 变），且 bge 官方不建议 passage 加检索指令。保持非对称即可。

**风险/验证**：
- bge **v1.5** 相比 v1.0 弱化了对指令的依赖（官方称「无指令也有良好检索能力」），故本项是「近零成本值得一试」而非「必涨」。**必须 A/B**：用现有若干真实需求 query 对比加/不加前缀的 top-k 命中，人工判相关性。
- 前缀只进嵌入、不进 BM25、不进注入块，无副作用面。

---

### P1 — cross-encoder 二阶段重排

**改动文件**：`electron/main/workers/embedWorker.ts`（加 reranker pipeline + 重排步）、`electron/main/core/kbSemanticSearch.ts`（超时预算 + degraded 语义）、`apps/studio/scripts/kb-model-manifest.mjs` + `prebundle-kb-model.mjs`（新增 reranker 模型下载）、electron-builder 配置（extraResources 发布 reranker 模型）。**不重建向量索引。**

现有管线到 `fuseRRF(bm, vTop).slice(0, k)` 就结束，是**排名融合**，没有对 query+passage 联合判别的精排。加一个 cross-encoder 作第二阶段：RRF 出候选 → cross-encoder 重算相关分 → 取真正的 top-k。二者正交（RRF 融两路排名，reranker 重算相关性）。

**模型**：`bge-reranker-v2-m3`（中文/多语，有 ONNX 权重可跑 transformers.js）或更轻的 `bge-reranker-base`。**不用** AnythingLLM 的 `ms-marco-MiniLM`（英文语料）。选型在 P1 第一步用真实中文 query 实测决定（m3 更准更重、base 更快）。

**管线（在 embedWorker `search()` 内，`:106` 之后）**：
1. 把 `N=40` 的融合结果**不再直接 `slice(0, k)`**，而是取融合后**前 M**（M = `min(30, fused.length)`，参 AnythingLLM 的过量召回思路，但我们候选来自已收窄的产品域，M 可小于它的 50）。
2. 对这 M 条，用 reranker 把 `(query, passage.text)` 逐条（或批量）打分，`sigmoid(logits)` 当相关分。
3. 按 reranker 分降序，取前 k，水合成 `SemanticHit`。**保留原 RRF `score` 到一个副字段**（诊断用），命中的 `score` 用 reranker 分。
4. **降级**：reranker pipeline 未就绪/加载失败/单次推理抛错 → 跳过重排，回落到 `fused.slice(0, k)`（即现状行为）。reranker 是**增强层**，任何失败都不得让检索变差或变空。

**reranker pipeline 生命周期**：与 embed pipeline 同进程（embedWorker 已隔离），singleton，`init()` 里 embed 就绪后再 lazy 建 reranker（或并行），失败只置 `reranker=null` 不影响 embed 路。localModelPath 复用同一 `modelDir`（reranker 模型放 `kb-model/<reranker-dir>/`）。

**延迟预算（关键运维纪律）**：cross-encoder 在 CPU 上对数十条重排是**几百 ms ~ 数秒**级，超过现有 `SEARCH_TIMEOUT_MS=1500`。策略：
- **两个消费方差异化**：搜索面板（用户主动搜、可等）用较宽超时（如 4000ms）并显示 loading；engine 自动召回（写正文热路径、不能卡）保持 1500ms，超时就用未重排的 RRF 结果——即 reranker 只在「来得及」时增强，来不及不拖慢出字。实现为 `kbSemanticSearch(query, scopes, k, { rerank?: boolean, timeoutMs?: number })` 增可选项，默认对面板开、对 engine 自动召回按预算开/关。
- reranker 只跑 M 条（≤30），不是全 40，控成本。

**打包**：reranker 模型（量化 ONNX，base ~最小、m3 较大）走**同一套** `prebundle-kb-model` 范式——`kb-model-manifest.mjs` 加第二个模型条目（目录名/HF 仓库/sha256），`prebundle`/`verify` 天然覆盖，`extraResources` 已发布整个 `kb-model/` 目录（新子目录自动带上），`asarUnpack` 的 `**/onnxruntime-node/**` 已覆盖运行时。**新增体积**：base 量化约数十 MB，m3 更大——若在意安装包体积，与「模型首次运行时下载」的瘦身议题一并权衡（见「未来」）。

**风险**：
- 体积增长（见上），选 base 还是 m3 是「准确度 vs 体积/延迟」权衡，实测定。
- 延迟：靠差异化超时 + 只重排 M 条兜住，engine 热路径永不被拖慢。

---

### P2 — chunk 前置来源元数据头（需重建索引）

**改动文件**：`electron/main/core/kbBuild/embed.ts`（嵌入前拼头）、`electron/shared/kbIndex.ts`（`VectorMeta` 可能加字段 + version bump）、`proposalRetrieve.core.ts`（offset 不变量处理）。**需重建整库向量索引。**

给每个 chunk 前置结构化来源头（产品线/产品/文档标题）再嵌入+存储，让：① 向量/ BM25 都能命中标题词（搜「预问诊」时，标题含该词的 chunk 加分）；② 注入 prompt 时模型就地知道出处。

```
<source>产品线：智能预问诊系统 | 文档：需求规格说明书</source>
<正文 chunk>
```

**难点（也是排 P2 的原因）——offset 不变量冲突**：现有 `chunkTextWithOffsets` 保证 `src.slice(charStart,charEnd)` 能回切原文（RRF 行号对齐 + 引用校验依赖它）。前置头会破坏这个不变量。两个方案：
- **方案 A（推荐）**：头**只进嵌入与注入呈现**，不进 `VectorMeta.text` 的 offset 计算——即 `text`（用于 BM25 + 回切）保持纯正文，另存一个 `headerText`（或嵌入时临时拼、不落 `text`）。嵌入时喂 `header + text`，BM25 仍对纯 `text`（若要标题进 BM25，则 BM25 那路单独拼头、不碰 offset）。复杂度中等但不破坏现有不变量。
- **方案 B**：头进 `text`，同步调整 offset 语义（头不算原文偏移）。改动面大、回归风险高，不推荐。

**为什么需重建**：改了嵌入内容 → 所有向量作废 → fingerprint/version bump（`version:2→3`），走现有 stale 检测让旧库提示重建。

**建议**：P2 与「下一次因其它原因（换模型/加 reranker 定型）本就要重建索引」的时机**合并落地**，避免为单独一个增强让用户重跑全库。收益中等，不紧急。

---

### P3 — 多轮引用回填（fillSourceWindow）

**改动文件**：`electron/main/core/engine.ts`（每 tab 的 `SessionRuntime` 加 sources 历史）、可能 `proposalSemantic.core.ts`（回填合并纯函数）。**不重建索引、不改检索核。**

写方案是长会话逐段打磨（「基于上面第 3 条扩写」「把导诊那段改得更详细」）。这类追问对当前 query 的检索常命中不足，但**上一轮引用过的资料其实还相关**。借鉴 AnythingLLM 的 fillSourceWindow：当本轮命中不足目标条数时，从**本会话历史轮已注入过的 sources** 里按 chunk 唯一键去重回填，补满窗口，且**不必为此跑 reranker**。

- **状态**：在 `SessionRuntime`（每 tab 独立，`engine.ts`）加 `proposalRecentHits: SemanticHit[]`（或按 mirrorPath#charStart 去重的有限环形缓冲，上限如 20）。每次自动召回（`:1308`）拿到 hits 后并入。
- **回填**：`engine.ts:1308` 处，若本轮 `hits.length < 目标`，用纯函数 `backfillFromHistory(currentHits, recentHits, target)`（按唯一键去重、跳过本轮已有）补齐，再 `renderRetrievedBlock` 注入。
- **注入 vs 展示不对称**（借鉴 AnythingLLM 的产品取舍）：回填内容进**注入**（喂 AI），但若前端有引用卡展示，只显示**本轮真实检索**结果，避免用户看到「跟本问无关的旧引用」。engine 自动召回目前无引用卡 UI，此点主要对 P3 之后若加引用展示时生效。
- **边界**：回填只在**同一方案会话**内（`SessionRuntime` 天然隔离，跨会话不泄漏）；上限防止历史无限增长吃 token 预算。

**风险**：回填的旧资料可能与新问题弱相关 → 上限 + 去重 + 只在命中不足时触发，控制副作用。纯函数可单测。

---

## 数据流（增强后）

```
query（用户面板 / AI kb_search / engine 自动召回）
  → kbSemanticSearch(query, scopes, k, {rerank, timeoutMs})
      worker 未就绪/超时 → BM25 降级（现状，不变）
      worker 就绪 → [utilityProcess embedWorker]
          ├ 向量路：extractor(【P0 前缀】+query) → cosineTopKRows(域内) top-40
          └ 词面路：rankChunks(query 裸文本) top-40         ← P0 不碰这路
          → fuseRRF 行号对齐 → 前 M(≤30)
          → 【P1 cross-encoder 重排 (query,passage) → 取 top-k；失败则回落 RRF top-k】
          → 水合 SemanticHit[]
  → engine 自动召回(:1308)：【P3 命中不足 → 从会话历史回填】→ renderRetrievedBlock 注入
```

（P2 作用在离线 embed 侧，改的是「每个 chunk 嵌入/存储的内容带来源头」，不在查询期数据流上。）

## 验收标准

**P0**：
- query 侧嵌入拼上 `KB_QUERY_INSTRUCTION`，BM25 那路仍用裸 query（代码走查 + 单测确认两路输入不同）。
- A/B：一组真实需求 query，加前缀 vs 不加，人工判 top-k 相关性无回退（理想为改善）；前缀可经开关一键回退。
- 不触发索引重建，旧向量库照常可用。

**P1**：
- 开 rerank 时，检索结果顺序由 cross-encoder 分决定；关/降级时等价于现状 RRF 结果。
- engine 自动召回热路径**不被拖慢**：reranker 超预算即用未重排结果，写正文出字延迟无可感增长。
- reranker 模型缺失/加载失败/推理抛错 → 静默回落 RRF，检索**不变空、不报错**。
- reranker 模型经 `prebundle`/`verify`/`extraResources` 打包，运行时零网络；`bun run typecheck` 通过。

**P2**（若本期做）：
- 每 chunk 嵌入内容含来源头；`VectorMeta.text` 的 offset 回切不变量保持（方案 A）。
- version bump，旧库被识别 stale 并提示重建；重建后搜「标题词」召回提升。

**P3**（若本期做）：
- 长会话追问命中不足时，从历史轮 sources 回填补满，注入块含回填内容。
- 回填按唯一键去重、限上限、仅同会话；纯函数单测覆盖去重与截断。

**通用**：`bun run typecheck` 通过；新增纯核逻辑有 bun test；`proposalRetrieve.core.ts` 现有 BM25 测试零回归。

## 实施顺序建议

1. **P0 先行**（最小改动、可 A/B、随时回退）——验证前缀对本库 query 的实际效果，同时不冒任何风险。
2. **P1 次之**（提准确度最大杠杆）——先用 base/m3 各跑一组真实 query 定选型，再接打包。engine 热路径差异化超时是硬要求。
3. **P2 / P3 视需求**——P2 等「本就要重建索引」的时机搭车；P3 在多轮打磨体验成为痛点时做。

## 未来（不在本 spec，各自独立立项）

- **向量存储换 LanceDB（扩展性）**：vectors.bin 全量余弦扫描在数万 chunk 后成瓶颈。`@lancedb/lancedb` 可嵌入、列式磁盘存储、离线。⚠️ 注意 AnythingLLM **未调 `createIndex()`**，其检索仍是列式穷举——要拿真 ANN（IVF-PQ/HNSW）加速须自建索引。配套借「检索门面 + docId→vectorId 映射」做精确删除。这是**替换存储层**的大改动，与本 spec 的质量增强正交。
- **扫描件/图片 PDF 的 OCR 兜底**：markitdown 对纯扫描件吐空文本静默漏检；中文方案里合同扫描件/盖章页常见。借 AnythingLLM 的「仅数字文本为空时触发 tesseract.js」范式。属**文档转换**子系统，另立 spec。
- **安装包瘦身**：模型（embed 23MB + reranker）改「首次建库时下载」而非构建时打包，可显著减小安装包；与 P1 引入 reranker 模型的体积权衡一并考虑。
