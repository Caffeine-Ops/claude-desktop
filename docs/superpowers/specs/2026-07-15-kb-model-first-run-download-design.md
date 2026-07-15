# 方案知识库·嵌入模型「首次运行时下载」（新功能设计 / 交接）

日期：2026-07-15
状态：设计草案（含一条**待打包验证的重大现状发现**）→ 待复核后 writing-plans
相关：检索质量增强 spec `2026-07-15-kb-retrieval-quality-from-anythingllm-design.md`（P0 已提交 444e359a、P1 纯核 21914d48）；语义检索原始 spec `2026-06-30-kb-semantic-search-design.md`。

---

## 一句话目标

把 bge 嵌入模型（以及将来 P1 的 reranker 模型）从「本该随安装包发布」改为**首次使用时从远程下载到用户可写目录**，让正式版真正拿到模型、同时不撑大安装包。

## ⚠️ 触发本功能的重大发现（**新窗口第一步先验证**）

调研打包配置（三平台 `extraResources`、`build.files`、afterPack 钩子、`electron.vite.config.ts`、`dist:*`/`build:*`/`prebuild:resources` 全链、git 跟踪状态）后发现：

**当前没有任何一处把 bge 模型拷进正式安装包。**

证据（均已用 `node -e` 读 package.json 干净核实，非 grep）：
- `apps/studio/scripts/prebundle-kb-model.mjs` + `verify-kb-model.mjs` 两脚本**存在但从未被调用**——`build:mac`（studio）= `verify:fusion && build:icons && prebundle:daemon && electron-vite build && electron-builder`，`dist:mac`（root）= `prebuild:resources && build:mac`，`prebuild:resources` = 建 contracts/registry-protocol/daemon + studio `build:next`。**三条链都不含 `prebundle:kb-model`**。是「孤儿脚本」。
- `mac.extraResources` = [fusion-code-cli, prebundled, node-runtime/mac, python-runtime/mac] —— **无 kb-model**；`win.extraResources` 同样无；`linux.extraResources` 不存在。
- `build.files` = [out-electron, resources, env.json, package.json, 若干否定 glob] —— **无 kb-model**。
- `apps/studio/kb-model/` 未被 git 跟踪（`git ls-files` 0 文件）、也未 gitignore——**只存在于开发机本地**（dev 路径正好是 `apps/studio/kb-model`）。

**推论（待坐实）**：正式包内 `process.resourcesPath/kb-model` 不存在 → embedWorker 加载模型失败 → **语义检索在生产环境很可能一直静默降级为 BM25**（纯词面），只有开发机（本地有模型）才真正跑向量腿。即「BM25+向量 RRF」的向量腿在发行版里可能未生效。

**新窗口的第 0 步**：实际打一个包（或检查一次真实产物），确认 `Resources/` 下无 `kb-model/` → 坐实上述推论，再动手。也可能是「功能开发中、打包接线故意没做完」——两种情况本功能都是正解，只是叙事不同（修复 vs 补完）。

## 设计（首次下载机制）

### 核心约束
- **不能下载进 `resourcesPath`**：打包后 Resources 只读。下载目标必须是**用户可写目录**，用 `app.getPath('userData')` → 建议 `userData/kb-model/<KB_MODEL_ID>/`。
- **模型目录解析要随之改**：现在 `modelDir()`（两处：`kbSemanticSearch.ts` 与 `kbBuildRunner.ts`）打包分支返回 `resourcesPath/kb-model`；改为返回 `userData/kb-model`（dev 分支 `apps/studio/kb-model` 可保留，或统一走 userData 便于测）。**两处必须同步改**（它们各有一份 `modelDir()`，注释互相指路）。
- **网络用 node https，不用 bun fetch**：`prebundle-kb-model.mjs` 头部注释详述——环境常有 SSL-MITM 代理，bun fetch 握手 ECONNRESET，node https 尊重 `NODE_EXTRA_CA_CERTS`。下载逻辑（跟随重定向 + sha256 校验）可**从 `prebundle-kb-model.mjs` 移植**，但要在**运行时的 main/utility 进程**跑，不是构建时。
- **复用 manifest 作事实源**：`apps/studio/scripts/kb-model-manifest.mjs` 已有 `MODEL_DIR_NAME`/`HF_REPO`/`SHA256`/`MIN_SIZE`/`sha256File`。但它是 `.mjs`（构建脚本用），运行时 TS 侧要能拿到同样的 pins——**决策点**：要么把 pins 搬进 TS 侧共享（`shared/kbIndex.ts` 旁）并让 .mjs 反向 import，要么运行时下载器自带一份（回到「两处漂移」的老问题）。倾向前者：pins 进 TS、构建脚本从 TS 派生。

### 待定决策（新窗口需拍板）
1. **何时触发下载**：
   - (a) 首次建知识库时（`kbBuildWorker` 向量化前需要模型——现在它 `existsSync(model)` 为假就跳过向量化）；
   - (b) 首次语义搜索时（懒下载）；
   - (c) 设置页显式「启用语义检索 / 下载模型」按钮 + 进度条。
   - **建议**：设置页显式入口（可见进度、可控）+ 建库/搜索时若缺模型给引导。避免用户毫无预期地在后台跑 23MB 下载。
2. **进度与失败**：23MB（bge）要显示下载进度；无网/失败**优雅降级**——语义搜索继续走 BM25（现有 `stale→BM25` 降级链已具备，不返空、不崩），建库继续跳过向量化（`kbBuildWorker` 已有此分支）。下载成功后 `resetEmbedWorker()` 触发重热 + 重建向量（fingerprint 机制已能识别）。
3. **多模型前瞻**：P1 会加 reranker 模型（bge-reranker-base ~100MB）。下载器应设计成**按 manifest 的模型列表循环**，一次做对，P1 直接复用。
4. **完整性/断点**：下载后 sha256 校验（manifest 已有 pins）；大文件建议临时文件 + 校验通过再 rename（防半截文件被当成功）。

### 现状锚点（改这些）
- **模型消费方（都要能容忍模型缺失→已具备）**：
  - `apps/studio/electron/main/workers/embedWorker.ts` —— `modelDir` 经 argv 传入；`env.localModelPath=modelDir` + `pipeline('feature-extraction', KB_MODEL_ID, {dtype:'q8'})`，缺失则 init 抛→post `stale`→BM25 降级。
  - `apps/studio/electron/main/core/kbSemanticSearch.ts:70` `modelDir()`（打包 `resourcesPath/kb-model`｜dev `apps/studio/kb-model`），fork embedWorker 时以 argv 传。
  - `apps/studio/electron/main/core/kbBuildRunner.ts` —— 自带一份 `modelDir()`（同式），fork `kbBuildWorker`。
  - `apps/studio/electron/main/workers/kbBuildWorker.ts` —— `existsSync(join(modelDir, KB_MODEL_ID,'onnx','model_quantized.onnx'))` = modelReady，为假则 `vectors:false` 跳过向量化。
  - `apps/studio/electron/main/core/kbBuild/embed.ts` —— 离线向量化，用 localModelPath（裸 KB_MODEL_ID 布局）。
- **模型 id / 布局事实源**：`apps/studio/electron/shared/kbIndex.ts` `KB_MODEL_ID='bge-small-zh-v1.5'`；本地布局 `<modelDir>/<KB_MODEL_ID>/onnx/model_quantized.onnx` + `config.json`/`tokenizer.json`/`tokenizer_config.json`。
- **下载逻辑可移植来源**：`apps/studio/scripts/prebundle-kb-model.mjs`（node https + 跟随重定向 + sha256 校验 + 幂等跳过）。
- **打包侧收尾**：模型既不入包，`prebundle:kb-model`/`verify:kb-model` 可退役或改成「可选的离线预置」；`asarUnpack` 的 `**/onnxruntime-node/**` 保留（引擎仍随包，只是模型改下载）。
- **IPC 四处约定**（若加设置页下载入口）：`ipc-channels.ts`→`preload/index.ts`→`preload/index.d.ts`→main handler。

## 验收标准（草案）
- 全新安装（无 dev 模型）→ 首次触发下载 → 模型落 `userData/kb-model/` → 语义检索真正走向量腿（不再永久 BM25）。
- 无网/下载失败 → 语义搜索降级 BM25、建库跳过向量化，**不崩不空**；恢复网络后可重试成功。
- 下载完 sha256 校验通过；半截文件不被当成功（临时文件+rename）。
- `modelDir()` 两处同步改为 userData；embedWorker 与 kbBuildWorker 都能从新位置加载。
- `bun run typecheck` 绿。
- （前瞻）下载器按 manifest 模型列表循环，P1 reranker 可零改动接入。

## 与其它工作的关系
- **本功能是 P1 的前置**：P1 reranker 模型 ~100MB，走首次下载才不撑爆安装包（用户原始诉求就是「别让包变大」）。顺序：先本功能 → 再 P1 的 Task 3+。
- P0（查询前缀）已独立提交，与本功能无耦合。
- LanceDB（向量存储升级）已评估暂缓，与本功能无关（见 memory `kb-lancedb-deferred`）。

## 交接备注（给新窗口）
- 本次会话未写任何首次下载代码——纯设计 + 现状核实。工作区当前干净（P0/纯核已提交）。
- memory 有两条相关：`kb-lancedb-deferred`（LanceDB 决策）、`kb-model-first-run-download`（本功能指针，含「模型未进包」发现）。
- 第一步务必先**坐实「正式包无模型」**再动手。
