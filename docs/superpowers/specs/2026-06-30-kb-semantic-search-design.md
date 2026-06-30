# 方案写作·知识库语义检索（P1 文本）

日期：2026-06-30（v2，已过两轮独立工程评审并修订）
状态：设计已认可 + 打包 spike 已通过，待用户复核 → writing-plans
前序：检索现状见 spec `2026-06-23-kb-driven-proposal-writer-design.md`、内容召回(BM25)与引用校验(trigram) 已交付（memory `proposal-quality-grounding-retrieval`）。

## 背景与目标

现有知识库检索是**纯词面**的：内容召回走 BM25（中文 bigram + ASCII 词，`proposalRetrieve.core.ts`），引用校验走字符 trigram（`proposalVerify.core.ts`）。硬伤是**同义不同词召回不到**——搜「智能导诊」，文档里写「预诊/分诊流程」，BM25 因无共享字符判 0 分，整段漏检。

用户诉求（brainstorming 已澄清）：**用一句模糊的自然语言描述，在知识库里捞出任何相关的东西**，返回「命中内容 + 它在哪篇文档里」。这要语义检索，不是词面匹配。

本 spec 是该能力的**第一期（P1）：只做文本的语义检索**，落地两个出口——搜索面板 + AI 写正文时能调的 `kb_search` 工具。图片可搜（P2）、任意文件夹（P3）不在本期。

## 打包 spike 结论（已实测，作为设计前提）

2026-06-30 在隔离目录实测 `@xenova/transformers`(v2) + `Xenova/bge-small-zh-v1.5`（量化 onnx）：

- **语义有效**：`cos(智能导诊, 预诊分诊流程) = 0.533`（同义不同词，高） vs `cos(智能导诊, 财务报销制度) = 0.270`（无关，低）。区分度足以兜住「模糊/同义」诉求——BM25 在此给 0 分。
- **能在 Node 跑**：模型 5.8s 加载，输出 **512 维**归一化向量。
- **模型小**：量化 onnx + tokenizer 共 **23MB**，可随 app 发。
- **拖入原生依赖**：`onnxruntime-node`（95M，6 平台 prebuilt `.node`）+ `onnxruntime-web`（69M wasm）+ `sharp`（原生图像库），node_modules 共 269M。

结论：**GO，用本地 embedding**。⚠️ 注意 spike 用的是 v2；实现改用 v3（`@huggingface/transformers`，见决策 2），**P1 第一项任务是在 v3 上复跑这三项指标**（加载时长 / 维度 / 模型目录布局），通过后才把「spike 已过」当 v3 前提。

## 已拍板的设计决策

1. **混合检索（核心）**：不做纯向量。查询时 BM25 和向量各出一路 top-k，用 **RRF（reciprocal rank fusion）** 融合。理由：纯语义在「精确词」（产品型号、专有简称）上不如词面准；现有 BM25 一行不废，正好当词面腿。
2. **本地 embedding**：实现用维护中的 `@huggingface/transformers`（v3，ESM-only；spike 用的 v2 已进维护期），模型 `bge-small-zh-v1.5`（中文优于 e5），512 维。
3. **模型构建时拉取、运行时零网络**：23MB 量化模型不入 git；新增 `prebundle:kb-model` 脚本从**钉定版本的 release** 拉到 `apps/desktop/kb-model/`（仿 `FUSION_CODE_VERSION` 钉版 + `gh release` 下载范式），接进 `build:*` 链 + CI；`verify:kb-model` 校验完整性。运行时经 `extraResources` 发布、`env.allowRemoteModels=false` + `env.localModelPath` 指向固定目录，**运行时不下载任何东西**。
4. **embedding 跑在 utilityProcess、不占 main 线程（核心运维纪律）**：模型加载 + query embedding + 暴力余弦放进 `utilityProcess`（与现有 fusion-bin 子进程模型一致），main 侧只做 IPC 转发。模型在**空闲时 warmup**（仿 engine lazy-spawn/后台 warmup），绝不落在首次用户查询的同步路径上。热路径 `await` 子进程结果**带超时**，超时/未就绪即降级 BM25-only。
5. **向量存储不上向量库**：`vectors.bin`（连续 Float32Array）+ `vectors-meta.json`，查询时整块入 utilityProcess 内存暴力算余弦。量级数千~数万 chunk，CPU 毫秒级；常驻内存预算见组件 3。
6. **复用现有 `version` 字段做 stale 判定，不新增字段**：`kbIndex.ts` 已有顶层 `version:1`（当前无任何消费方校验）。本期把它 bump 到 `2`（同步改 `build-kb-index.ts` 写 2），并**新建** stale 检测。
7. **stale/向量缺失 → 降级 BM25-only，不返回空**：避免回归（见组件 5）。面板消费 `staleIndex` 旗标弹「需重建」CTA；engine 自动召回**忽略旗标**、静默用 BM25 结果（它本不依赖向量）。
8. **唯一权威分块表**：BM25 与向量必须跑**同一套** chunk（见组件 1/2），用行号当 id 对齐，根治 RRF 对齐问题。

边界（YAGNI）：
- P1 不碰图片向量、VLM caption、OCR（P2）；不碰任意文件夹（P3）；检索范围 = 已建索引的 KB。
- 不做 re-ranker、query 改写/扩展。
- 不做向量增量更新精细化：重建时整表重算（沿用 mtime+sha1 决定哪些文件需重转）。
- `sharp` 是 transformers 的依赖、装是装上的；P1 只保证**运行时不触发它的代码路径**，不把「无 sharp 原生依赖」当打包收益（asarUnpack 是否带 sharp 留到 P2）。
- linux 当前无 electron-builder build 块，P1 不支持 linux 打包。

## 现状（已查证）

- **BM25 核心**：`proposalRetrieve.core.ts` —— `chunkText(text):string[]`（`:91`，**只返回字符串、无 offset/id**）、`RetrievalChunk={text,title,mirrorPath}`（`:11`，**无 charStart/charEnd**）、`rankChunks(query,chunks,opts):RetrievedPassage[]`（`:134`，命中仅含 `text/title/mirrorPath/score`）。IO 包装 `proposalRetrieve.ts`：`retrievePassages()`（`:27`，**同步**，语料受 `MAX_FILES=40`/`MAX_TOTAL_BYTES=2_000_000` 截断，`:16-17,36-51`）、`renderRetrievedBlock()`（`:64`）。
- **召回接入点**：`engine.ts:1100` `const passages = retrievePassages(text, scopes)` —— **同步、内联在 `send()` 里**，`:1101` `renderRetrievedBlock`。这是组件 5 的接入点（spec 旧版说 1100-1113 准确）。
- **索引契约**：`kbIndex.ts` `KbIndex` 已有 `version:1`（`:16`）；`build-kb-index.ts:76` 写 `{version:1,kbRoot,builtAtMs,files}`。`readKbIndex()`（`kbIndexStore.ts:64`）只 `JSON.parse`、**不校验版本**——stale 检测目前不存在，需新建。
- **离线脚本可直接 import app 模块**：`kb:index` 用 **bun** 跑（root `package.json:31`），`build-kb-index.ts:6` 已 `import type {KbIndex} from '../apps/desktop/src/shared/kbIndex.ts'`、`:4-5` import `./kb-index/*.ts`。bun 按相对路径解析、不读 tsconfig，scripts/ 不在任何 tsconfig include。`proposalRetrieve.core.ts` 是纯模块零 import（无 fs/electron）。→ embed.ts 可**直接 `import {chunkText}`**，不抽不复制。
- **打包**：main 用 `externalizeDepsPlugin`（依赖运行时从 node_modules 走、留作 `import`；main bundle 是 **ESM**——v3 ESM-only 正因此可用，**main 必须保持 ESM**）。electron-builder 默认 asar=true；`build.files=["out/**/*","env.json","package.json"]` 是**三平台共享**；`extraResources` 是**分平台**（`mac.extraResources:62-79`、`win.extraResources:88-105`、**无 linux 块**）；生产依赖即使不在 files 里也会被打进 asar（现有 docx/mermaid/image-size 即如此）。
- **资源路径范式可照搬**：`openDesignServices.ts:110-124 resolveRepoRoot()`（`app.isPackaged` 分支、`out/main`→repo 上溯、cwd 兜底）、`cliDetect.ts:34-43`（resourcesPath-or-walk-up）。`extraResources` 的 `from` 相对 `apps/desktop` 根。
- **install-app-deps 不可依赖**：`apps/desktop/package.json:27` 有 `postinstall: electron-builder install-app-deps`，但 CI 只在 root 跑 `bun install --frozen-lockfile`（`build.yml:72`），不触发 workspace 包的 postinstall。且 onnxruntime-node 是 napi-v3 prebuilt、无 binding.gyp，N-API ABI 跨 Electron 33 稳定、**本就无需 rebuild**。
- **图片协议已有**：`kbAssetProtocol.ts`/`kbAssetUrl.ts`——P1 用不到，P2 复用。
- **IPC 四处约定**（CLAUDE.md）：`ipc-channels.ts`→`preload/index.ts`→`preload/index.d.ts`→main handler。

## 设计

### 组件 1：索引侧向量化 + 唯一分块表（离线）

文件：新建 `scripts/kb-index/embed.ts`；改 `scripts/build-kb-index.ts`、`apps/desktop/src/shared/kbIndex.ts`、`apps/desktop/src/main/core/proposalRetrieve.core.ts`。

- **给 `chunkText` 增产 offset**：改成同时返回每块的 `charStart/charEnd`（保持纯函数、不引 fs）。现有 `string[]` 调用方相应适配（`retrievePassages` 等）。
- `embed.ts` **直接 `import {chunkText}`**（bun 跨 workspace，已验证可行）对每个 ok 文件镜像 md 切块，得到**全库唯一的 chunk 序列**。用 `@huggingface/transformers` feature-extraction（mean pooling + normalize）批量转 512 维向量。
- 产物（行号 i 三者对齐、i 即 chunk id）：
  - `userData/kb-index/vectors.bin` —— 所有 chunk 向量按行连续（Float32Array，row i = 512×4 字节）。
  - `userData/kb-index/vectors-meta.json` —— `VectorMeta[]`，第 i 项 = `{ sourcePath, mirrorPath, productLine, product, title, charStart, charEnd, text, snippet }`。**必须存 chunk 全文 `text`**（不能只存 snippet）——查询时 BM25 腿要用它构造 `RetrievalChunk[]`，两路才同表。
  - 顶层 `fingerprint` —— 绑定到 index 的指纹（取 `KbIndex.builtAtMs` 或全文件 sha1 汇总），用于「同版本号但向量过期」的 stale 检测（见组件 3）。
- `kbIndex.ts`：`KbIndex.version` 从 `1` bump 到 `2`；`build-kb-index.ts:76` 同步写 `version:2`。

### 组件 2：查询核心（纯函数，可单测）

文件：新建 `apps/desktop/src/main/core/proposalSemantic.core.ts`（+ `.test.ts`）。

- `cosineTopK(queryVec, matrix, rows, dim, k): {row:number; score:number}[]` —— 暴力余弦（归一化向量即点积），取 top-k。纯函数无 IO。
- `fuseRRF(bm25: {row:number; rank:number}[], vector: {row:number; rank:number}[], k=60): {row:number; score:number}[]` —— 标准 RRF：`score(row)=Σ 1/(k+rank)`，合并去重降序。**id 是 `vectors-meta` 的行号 `number`**（不是 `mirrorPath#charStart`），因 BM25 与向量同跑一张表，天然对齐。
- 词面腿在核内由 `rankChunks` 提供命中，调用方把命中映射回行号（meta 全文 → row）。

### 组件 3：查询 IO 包装 + utilityProcess

文件：新建 `apps/desktop/src/main/core/kbSemanticSearch.ts`（main 侧、薄）+ 新建 `apps/desktop/src/main/workers/embedWorker.ts`（utilityProcess 入口）。

- **utilityProcess（`embedWorker`）**：进程内一次性建 `@huggingface/transformers` pipeline（`env.allowRemoteModels=false`、`env.localModelPath=<模型目录>`）、读 `vectors.bin` 入内存 + 读 `vectors-meta.json`。常驻内存预算：数万 chunk×512×4B ≈ 数十 MB，隔离在该子进程、不压 main。提供「embed(query)→512 向量」「search(query,k)→hits」消息接口。
- **main 侧 `kbSemanticSearch(query,{scope?,k}) → {hits:SemanticHit[], staleIndex:boolean}`**：
  1. 若 worker 未 warmup/未就绪 → 直接走 BM25-only（`rankChunks` over 现有语料）+ `staleIndex` 据情况，**绝不阻塞等模型**；
  2. 就绪时把 query 发给 worker：worker 内 ① 向量路 `cosineTopK` top-N，② 词面路用 meta.text 构 `RetrievalChunk[]` 跑 `rankChunks` top-N，③ `fuseRRF` → 前 k → 水合 `SemanticHit{title,sourcePath,mirrorPath,productLine,product,snippet,score}`；
  3. main 对 worker 调用**带超时**，超时回退 BM25-only。
- **warmup**：app 空闲/进入写方案模式时触发 worker 建 pipeline + 载向量，仿 engine 后台 warmup 纪律。
- **stale 检测**：worker 启动比对 `readKbIndex().version===2` 且 `vectors-meta.fingerprint===index 指纹`；任一不符 → 标记不可用，`kbSemanticSearch` 返回 `staleIndex:true` 且 `hits` 走 BM25-only（不是空）。
- **模型/向量路径解析**：复用 `resolveRepoRoot()` 范式——`app.isPackaged` 时 `process.resourcesPath/kb-model`，dev 时仓库内 `apps/desktop/kb-model`。模型目录布局须满足 v3 loader 期望（`<localModelPath>/<modelId>/onnx/model_quantized.onnx`、`tokenizer.json` 等），由 `prebundle:kb-model` 摆好。

### 组件 4：出口 A — 搜索面板（IPC + renderer）

文件：`src/shared/ipc-channels.ts`、`src/preload/index.ts`、`src/preload/index.d.ts`、main handler（`src/main/ipc/register.ts`）、renderer 新组件。

- 新 IPC 通道 `KB_SEMANTIC_SEARCH`（request `{query,scope?}` → `{hits,staleIndex}`），按「四处」约定补齐。
- main handler 调 `kbSemanticSearch()`。
- renderer：写方案界面加搜索框 + 结果卡列表（片段高亮 + 出处文档标题/产品线）。命中行动作：**插入引用**（`（据《文件名》）` 风格 + 片段插进草稿）或 **打开原文档**。`staleIndex:true` 时顶部显「知识库需重建」CTA。样式遵循 memory `proposal-ui-icons-typescale`（内联 SVG、勿直接套 text-apple-* 预设）。

### 组件 5：出口 B — AI 的 kb_search 工具 + 升级热路径召回

文件：`apps/desktop/src/main/core/engine.ts`、可能 `proposalPrompt.ts`。

- **升级现有自动召回**：`engine.ts:1100` 的同步 `retrievePassages()` 改为 `await kbSemanticSearch()`（带超时）。`renderRetrievedBlock()` 渲染同款注入块。**engine 这路忽略 `staleIndex`**——拿到什么（混合或 BM25 降级）就注什么，绝不因 stale 变空（这是组件 7 决策的落点，防回归）。
- **新增 SDK 工具 `kb_search`**：AI 写某节缺料时主动调，入参一句自然语言，返回 `SemanticHit[]` 文本化结果。挂在 engine 现有工具注册处，复用 `kbSemanticSearch()`，与自动召回并存。

### 组件 6：打包配置

文件：`apps/desktop/package.json`（build 段 + scripts + 依赖）、新建 `scripts/prebundle-kb-model.mjs`、`.github/workflows/build.yml`。

- 依赖：加 `@huggingface/transformers`（生产依赖，main externalize、运行时 import）。
- **原生 .node 解包**：`build.asarUnpack` 加 `**/onnxruntime-node/**`（P2 起再加 `**/sharp/**`）。bun 把依赖 hoist 到 root node_modules（`.bun` store 软链），electron-builder 打包时解引用、glob 仍命中——但**首次真打包后加断言**：`app.asar.unpacked/node_modules/onnxruntime-node/**/*.node` 存在（仿 `verify-fusion-bin` 失败即停）。
- **平台级裁剪（关键，别误伤）**：onnx 二进制裁剪放进**平台级 `mac.files`/`win.files`**（各只留自己 arch），**不要**放进三平台共享的 `build.files`，否则 win/linux 的 prebuilt 被一起砍掉。
- **模型发布（分平台）**：`mac.extraResources` 与 `win.extraResources` **各加** `{from:"kb-model",to:"kb-model"}`（只加 mac 块则 win 拿不到）。
- **模型来源**：新增 `prebundle:kb-model`（`bun scripts/prebundle-kb-model.mjs`）从钉定版本 release 下载模型到 `apps/desktop/kb-model/`，接进 `build:mac`/`build:win` 链（在 electron-vite build 前）；CI `build.yml` 加对应下载步骤；新增 `verify:kb-model` 校验文件齐全/哈希。
- **去掉 rebuild 依赖**：不再宣称靠 `install-app-deps` 兜底（CI 不跑、且 napi-v3 无需 rebuild）。如要安全网，给 `verify:*` 加一个 onnxruntime-node 的 dlopen 冒烟（仿 `scripts/postinstall.mjs` better-sqlite3「以加载验证、不看 exit code」纪律）。
- 运行时路径解析见组件 3（`app.isPackaged`）。

### 组件 7：测试（bun test）

1. `cosineTopK`：归一化向量集，最近邻取到、k 截断正确。
2. `fuseRRF`：两路按**行号**融合，公共 row 得分叠加、单路 row 也在、降序正确。
3. `chunkText` offset：charStart/charEnd 与切片一致、可回切原文。
4. stale：version≠2 或 fingerprint 不符 → `kbSemanticSearch` 返回 `staleIndex:true` 且 hits 非空（BM25 降级），**不返回空**。
5. 回归：`proposalRetrieve.core.ts` 现有 BM25 测试保持绿；无 KB/空索引不抛错。
6. 注入块：`renderRetrievedBlock` 在混合结果与 BM25 降级结果下都产出合法块。
（embedding 推理依赖原生模型、不进单测，靠 v3 复跑 spike + 手动走查；core 层全可单测。worker 消息协议可加一个轻量 mock 测。）

## 数据流

```
用户面板输入 / AI 调 kb_search("…")
  → main kbSemanticSearch:
      worker 未就绪/超时 → BM25-only(rankChunks) + staleIndex 据情况
      worker 就绪 → [utilityProcess] embed query(512) →
          ├ 向量路 cosineTopK over vectors.bin
          └ 词面路 rankChunks over meta.text(同一张表)
          → fuseRRF(行号对齐) → 水合 → SemanticHit[]
  → 出口A 面板: 结果卡(片段+出处) → 插入引用/打开文档; stale→重建CTA
  → 出口B engine(:1100): await(超时) → renderRetrievedBlock 注入; 忽略 stale 不变空
```

## 验收标准

- 搜「智能导诊」能召回只写「预诊/分诊流程」的文档片段（语义命中，BM25 单独做不到），结果带正确出处。
- 搜索面板：模糊描述 → 片段+出处列表 → 可插入引用/打开文档；索引 stale 时显重建 CTA 且仍能给 BM25 结果。
- AI `kb_search` 可被调用并返回语义命中；engine 自动召回升级为混合检索，且 **stale/冷模型时退化为 BM25、绝不变空、不冻 UI**（embedding 在 utilityProcess、热路径带超时）。
- 模型经构建拉取 + extraResources 发布，运行时零网络；原生 `.node` 经 asarUnpack 加载，打包后断言 unpacked 存在；`build:mac`/`build:win` 各自拿到模型与对应 arch 二进制。
- 旧索引（version 1 或 fingerprint 不符）被识别为 stale；无 KB/空索引不崩。
- v3 复跑 spike 通过（加载时长/512 维/模型目录布局）。
- `bun run typecheck` 通过，新增 bun test 全绿，BM25 等现有测试零回归。

## 未来（不在本 spec）

- **P2 图片可搜**：索引时给图片做「带上下文的 caption」（VLM 一句话 + 文档标题 + 图周正文）再 embedding；`KbIndexFile.assets` 从 `string[]` 扩成 `KbAsset[]{path,caption,ocrText?,vectorRow}`；图进结果带 `kbasset://` 缩略图；引图复用图接地纪律。离线 VLM 需独立凭据 + 断点续跑。届时 asarUnpack 补 `**/sharp/**`。
- **P3 任意文件夹**：非 KB 文件夹现扫现搜（markitdown 转 → chunkText → 即时 embedding → 内存向量检索），按「文件夹+mtime 哈希」缓存临时索引，不污染主库。
- 向量增量更新精细化、re-ranker、query 扩写、linux 打包。
