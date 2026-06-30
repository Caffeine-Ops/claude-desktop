# 方案写作·知识库语义检索（P1 文本）

日期：2026-06-30
状态：设计已认可 + 打包 spike 已通过，待用户复核 → writing-plans
前序：检索现状见 spec `2026-06-23-kb-driven-proposal-writer-design.md`、内容召回(BM25)与引用校验(trigram) 已交付（memory `proposal-quality-grounding-retrieval`）。

## 背景与目标

现有知识库检索是**纯词面**的：内容召回走 BM25（中文 bigram + ASCII 词，`proposalRetrieve.core.ts`），引用校验走字符 trigram（`proposalVerify.core.ts`）。它的硬伤是**同义不同词召回不到**——用户搜「智能导诊」，文档里写「预诊/分诊流程」，BM25 因无共享字符判 0 分，整段漏检。

用户的真实诉求（brainstorming 已澄清）：**用一句模糊的自然语言描述，在知识库里捞出任何相关的东西**（一段话、一张表、将来还有图），返回「命中内容 + 它在哪篇文档里」。这要的是**语义检索**，不是词面匹配。

本 spec 是该能力的**第一期（P1）：只做文本的语义检索**，落地两个出口——用户主动用的「搜索面板」+ AI 写正文时能调的「检索工具」。图片可搜（P2）、任意文件夹（P3）不在本期。

## 打包 spike 结论（已实测，作为本设计的前提证据）

2026-06-30 在隔离目录实测 `@xenova/transformers` + `Xenova/bge-small-zh-v1.5`（量化 onnx）：

- **语义有效**：`cos(智能导诊, 预诊分诊流程) = 0.533`（同义不同词，高） vs `cos(智能导诊, 财务报销制度) = 0.270`（无关，低）。区分度足以兜住「模糊/同义」诉求——这是 BM25 给 0 分的场景。
- **能在 Node 跑**：模型 5.8s 加载，输出 **512 维**归一化向量。
- **模型小**：量化 onnx + tokenizer 共 **23MB**，可随 app 发。
- **拖入原生依赖**：`onnxruntime-node`（95M，含 6 平台 prebuilt `.node`）+ `onnxruntime-web`（69M wasm）+ `sharp`（原生图像库），node_modules 共 269M。

结论：**GO，用本地 embedding，不退回 API 方案**。

## 已拍板的设计决策

1. **混合检索（核心）**：不做纯向量。查询时 BM25 和向量各出一路 top-k，用 **RRF（reciprocal rank fusion）** 融合排序。理由：纯语义在「精确词」（产品型号、专有简称）上不如词面准；现有 BM25 一行不废，正好当混合检索的一条腿。
2. **本地 embedding**：实现用维护中的 `@huggingface/transformers`（v3，spike 用的 v2 已进维护期，API 基本一致），模型 `bge-small-zh-v1.5`（中文优于 e5），512 维。
3. **模型零网络发布**：23MB 量化模型走现成 `extraResources` 机制（与 fusion-bin/node-runtime 同款），运行时 `env.allowLocalModels=true` + `env.localModelPath` 指向固定路径，**运行时不下载任何东西**。
4. **向量存储不上向量库**：`vectors.bin`（连续 Float32Array）+ `vectors-meta.json`（行号→来源），查询时整块入内存暴力算余弦。公司知识库量级（数千~数万 chunk）在 JS 里毫秒级，`hnswlib` 等列为 YAGNI。
5. **索引契约带版本号**：`kbIndex.ts` 加 `indexVersion`；app 检测到旧版本 → 提示「知识库需重建」，绝不拿旧 index 静默漏检。
6. **两个出口共用一套查询核心**：① 搜索面板（IPC）；② AI 的 `kb_search` SDK 工具。二者只是同一 `kbSemanticSearch()` 的两个调用方。
7. **P1 不引 sharp**：sharp 是图像处理拖进来的，P1 纯文本用不到；实现时尝试在依赖里排除/不触发它，留到 P2 再引（少一个原生依赖、少一处打包风险）。

边界（YAGNI）：
- P1 不碰图片向量、不碰 VLM caption、不碰 OCR（P2）。
- P1 不碰任意文件夹（P3）；检索范围 = 已建索引的 KB。
- 不做 re-ranker 模型、不做 query 改写/扩展。
- 不做向量增量更新的精细化：索引重建时整表重算（沿用现有 mtime+sha1 决定哪些文件需重转，重转的文件其 chunk 向量重算）。

## 现状（已查证）

- **离线索引管线**：`scripts/build-kb-index.ts` + `scripts/kb-index/{scan,convert,assets}.ts`。`convert.ts` 用 markitdown 把源文档转 md 镜像（`<outDir>/<相对源路径>.md`）；产物索引 `userData/kb-index/index.json`，契约 `apps/desktop/src/shared/kbIndex.ts`（每文件一条 `KbIndexFile`，含 `mirrorPath/sha1/mtimeMs/assets[]/ok` 等）。
- **BM25 核心可复用**：`apps/desktop/src/main/core/proposalRetrieve.core.ts` —— `tokenize()` / `chunkText()`（表格保形分块）/ `rankChunks()`（标准 BM25）。IO 包装 `proposalRetrieve.ts` —— `retrievePassages()`（扫盘读镜像 md → 分块 → 排序）、`renderRetrievedBlock()`（拼注入块）。
- **召回已接在 send 热路径**：`engine.ts`（约 1100-1113 行）用用户输入做 `retrievePassages()`，`renderRetrievedBlock()` 拼成「知识库召回」块注入当轮。这是 P1 升级为混合检索的接入点。
- **scope 构建**：`proposalScopes.ts` `buildProposalProductScopes()` 从 `readKbIndex()` 按 (productLine, product) 过滤，engine 与「召回预览」IPC 共用。
- **IPC 四处约定**（CLAUDE.md）：加一条 IPC 要同改 `src/shared/ipc-channels.ts` → `src/preload/index.ts` → `src/preload/index.d.ts` → main handler（`src/main/ipc/register.ts` 或 engine）。
- **图片协议已有**：`kbAssetProtocol.ts`（`kbasset://`）、渲染侧 `kbAssetUrl.ts`——P1 用不到，P2 复用。
- **打包**：main 用 `externalizeDepsPlugin`（依赖不进 bundle、运行时从 node_modules 走），electron-builder 默认 asar=true，`build.files = ["out/**/*","env.json","package.json"]`，已有 `extraResources`（fusion-bin/node-runtime/python-runtime）与 `postinstall: install-app-deps`。

## 设计

### 组件 1：索引侧向量化（离线）

文件：新建 `scripts/kb-index/embed.ts`；改 `scripts/build-kb-index.ts`、`apps/desktop/src/shared/kbIndex.ts`。

- 复用 `chunkText()` 的同款分块逻辑（抽到 shared/core 以便脚本与 app 共用，或脚本内复制其纯逻辑）对每个 ok 文件的镜像 md 分块。
- `embed.ts`：用 `@huggingface/transformers` feature-extraction（mean pooling + normalize）批量把所有 chunk 文本转 512 维向量。
- 产物：
  - `userData/kb-index/vectors.bin` —— 所有 chunk 向量按行连续存（Float32Array，row i 占 512×4 字节）。
  - `userData/kb-index/vectors-meta.json` —— `VectorMeta[]`，第 i 项 = `{ sourcePath, mirrorPath, productLine, product, title, charStart, charEnd, snippet }`，行号 i 与 vectors.bin 对齐。
- `kbIndex.ts` 加顶层 `indexVersion: number`（本期定为如 `2`）。

### 组件 2：查询核心（纯函数，可单测）

文件：新建 `apps/desktop/src/main/core/proposalSemantic.core.ts`（+ `.test.ts`）。

- `cosineTopK(queryVec: Float32Array, matrix: Float32Array, rows: number, dim: number, k: number): {row:number; score:number}[]` —— 暴力算余弦（向量已归一化则为点积），取 top-k。纯函数、无 IO。
- `fuseRRF(bm25: {id:string; rank:number}[], vector: {id:string; rank:number}[], k=60): {id:string; score:number}[]` —— 标准 RRF：`score(id) = Σ 1/(k+rank)`，合并去重后降序。`id` 用「mirrorPath#charStart」之类稳定键，使 BM25 chunk 与向量 chunk 能对齐融合。
- 照现有 `.core.ts` 纪律：纯逻辑、bun test 覆盖，IO 留给包装层。

### 组件 3：查询 IO 包装

文件：新建 `apps/desktop/src/main/core/kbSemanticSearch.ts`。

- 启动/首查时惰性加载：① 用 `@huggingface/transformers` 建一次 feature-extraction pipeline（模型路径指向 extraResources 的固定目录，`env.allowLocalModels=true`、`env.localModelPath=<resources>/kb-model`、`env.allowRemoteModels=false`）；② mmap/读 `vectors.bin` 入内存 + 读 `vectors-meta.json`。两者缓存在模块级，跨查询复用。
- `kbSemanticSearch(query, { scope?, k }) → SemanticHit[]`：
  1. embed query → 512 维向量；
  2. 向量路：`cosineTopK` 取 top-N；
  3. 词面路：复用 `rankChunks()` 对同一语料取 top-N；
  4. `fuseRRF` 融合 → 取前 k；
  5. 用 `vectors-meta.json` 水合成 `SemanticHit { title, sourcePath, mirrorPath, productLine, product, snippet, score }`。
- 索引版本检查：读 `indexVersion`，与期望不符 → 返回带 `staleIndex: true` 的空结果，让上层提示重建。

### 组件 4：出口 A — 搜索面板（IPC + renderer）

文件：`src/shared/ipc-channels.ts`、`src/preload/index.ts`、`src/preload/index.d.ts`、main handler（`src/main/ipc/register.ts`）、renderer 新组件。

- 新 IPC 通道 `KB_SEMANTIC_SEARCH`（request `{ query, scope? }` → `SemanticHit[]`），按「四处」约定补齐。
- main handler 调 `kbSemanticSearch()`。
- renderer：写方案界面加一个搜索框 + 结果卡列表（命中片段高亮 + 出处文档标题/产品线）。命中行动作：**插入引用**（把 `（据《文件名》）` 风格的引用 + 片段插进当前草稿）或 **打开原文档**。样式遵循 memory `proposal-ui-icons-typescale`（内联 SVG 图标、勿直接套 text-apple-* 预设）。

### 组件 5：出口 B — AI 的 kb_search 工具 + 升级热路径召回

文件：`apps/desktop/src/main/core/engine.ts`、可能 `proposalPrompt.ts`。

- **升级现有自动召回**：engine 约 1100-1113 行的 `retrievePassages()`（纯 BM25）改调 `kbSemanticSearch()`（混合），`renderRetrievedBlock()` 渲染同款注入块。这是零新增 UI 的即时收益——AI 每轮拿到的「最相关原文片段」从词面升级为语义。
- **新增 SDK 工具 `kb_search`**：AI 写某节缺料时主动调，入参一句自然语言，返回同一 `SemanticHit[]` 的文本化结果供其引用。挂在 engine 现有工具注册处，复用 `kbSemanticSearch()`。与自动召回并存（一个被动、一个主动）。

### 组件 6：打包配置

文件：`apps/desktop/package.json`（build 段 + 依赖）、`scripts/`（模型落位）。

- 依赖：加 `@huggingface/transformers`（生产依赖，main 走 externalize、运行时从 node_modules 加载）。
- `build.asarUnpack`：加 `**/onnxruntime-node/**`、（P2 起）`**/sharp/**`——原生 `.node` 必须解包到 asar 外。
- `build.files`：负向 glob 砍掉非 mac 平台的 onnx 二进制（只留 `darwin/arm64`），省约 70M；win/linux 各自保留其平台。
- 模型落位：把 23MB 量化模型 + tokenizer 放进 `extraResources`（新增一项 `{ from: "kb-model", to: "kb-model" }`），构建脚本负责把模型拉到 `kb-model/`（参照 `prebundle-daemon`/`verify-fusion` 的预置脚本范式）。
- `kbSemanticSearch.ts` 解析 resources 路径用 `process.resourcesPath`（打包后）/ dev 回退到仓库内模型目录。

### 组件 7：测试（bun test）

1. `cosineTopK`：归一化向量集，已知最近邻被取到、k 截断正确。
2. `fuseRRF`：两路排名融合，公共 id 得分叠加、单路 id 也在、降序正确。
3. `kbIndex` 版本：旧 `indexVersion` → `kbSemanticSearch` 返回 `staleIndex`。
4. 回归：BM25 纯核 `proposalRetrieve.core.ts` 现有测试保持绿；无 KB / 空索引时检索不抛错。
5. 提示词/注入块：`renderRetrievedBlock` 在混合结果下仍产出合法注入块。
（embedding 推理本身依赖原生模型、不进 bun test 单测，靠 spike + 手动走查保证；core 层全程可单测。）

## 数据流

```
用户在面板输入「智能导诊的描述图表」/ AI 调 kb_search("…")
  → kbSemanticSearch: embed query(512维)
      ├─ 向量路: cosineTopK over vectors.bin
      └─ 词面路: rankChunks(BM25) over 同语料
      → fuseRRF 融合 → 水合 vectors-meta → SemanticHit[]
  → 出口A 面板: 结果卡(片段+出处) → 插入引用 / 打开文档
  → 出口B 注入: renderRetrievedBlock → 注入当轮 / kb_search 工具回传给 AI
```

## 验收标准

- 搜「智能导诊」能召回只写「预诊/分诊流程」的文档片段（语义命中，BM25 单独做不到），且结果带正确出处文档。
- 搜索面板：输入模糊描述 → 出片段+出处列表 → 可插入引用或打开原文档。
- AI 的 `kb_search` 工具可被调用并返回语义命中；engine 自动召回已升级为混合检索。
- 模型随 app 发布、运行时零网络；原生 `.node` 经 asarUnpack 正常加载；`build:mac` 能产出可运行包。
- 旧索引被识别为 stale 并提示重建；无 KB/空索引不崩。
- `bun run typecheck` 通过，新增 bun test 全绿，BM25 等现有测试零回归。

## 未来（不在本 spec）

- **P2 图片可搜**：索引时给图片做「带上下文的 caption」（VLM 一句话 + 文档标题 + 图周正文）再 embedding；`KbIndexFile.assets` 从 `string[]` 扩成 `KbAsset[]{path,caption,ocrText?,vectorRow}`；图片进检索结果、带 `kbasset://` 缩略图；引图复用现有图接地纪律。离线脚本跑 VLM 需独立凭据 + 断点续跑。
- **P3 任意文件夹**：非 KB 文件夹现扫现搜（markitdown 转 → 分块 → 即时 embedding → 内存向量检索），按「文件夹+mtime 哈希」缓存临时索引，不污染主库。
- 向量增量更新精细化、re-ranker、query 扩写。
