# 按需下载组件框架（长期能力）+ 打包体积守卫（待办）

日期：2026-07-16
状态：设计草案，待用户复核 → writing-plans
根本目的：**长期控制安装包体积**。先搭一套通用「按需下载组件」能力（把功能专属大块头从随包改为用到才下），再逐个把候选搬出安装包；「提醒开发者哪里可按需下载」的守卫机制作为**框架之后的待办**推进。

前序 / 相关：
- `2026-07-15-kb-model-first-run-download-design.md`（嵌入模型首次下载——本 spec 的下载框架是它的通用化）
- `2026-07-15-kb-retrieval-quality-from-anythingllm-design.md`（P1 reranker ~100MB——取代其 P1 打包段落）
- 已落地基座：`kbModelDownloader.ts` / `kbModelManifest.ts` / `kbModelDownload.ts` / `kbModelDir()`（c8bc2e0d…b5636bb3）

---

## 步骤 0 实测：安装包「体重地图」（mac arm64，2026-07-16 实测）

动工前先量了真实体积（node/python 下 CI 同款版本解压实测，onnx/electron 本地实测）：

| 组件 | 落盘 | 压缩后≈装包 | 能搬 | 备注 |
|---|---|---|---|---|
| **Electron/Chromium 框架** | **242MB** | ~80–100MB | ❌ 地板 | 最大一块，所有 Electron 应用不可避免，按需下载碰不到 |
| **node-runtime**（Node 24 单二进制） | **115MB** | ~50MB | ⚠️ 能但难 | 最大**可搬**项；daemon（画布/方案）近核心、启动早期就要，时机难卡 |
| **python-runtime**（CPython 3.12） | **67MB** | ~24MB | ✅ 干净 | 只 ppt-master（做 PPT）用，纯可选，缺失兜底已存在 |
| onnxruntime-node | 35MB | ~15MB | ❌ 不值 | **打包已剔 win/linux 平台**（`mac.files` 排除规则），近核心 + 原生模块 |
| @img/sharp(libvips) | 16MB | ~6MB | ❌ 不值 | 原生、用得广、小 |
| daemon prebundled | ~9MB+ | 小 | ❌ 核心 | |
| fusion-code-cli | 几十 MB | | ❌ 核心 | AI 后端，搬不了 |

**实测结论（决定了本 spec 的定位）**：
- 大头 **Electron 242MB 搬不走**，是硬地板，按需下载动不了它。
- 能搬的只有 **node(115)+python(67)=182MB 落盘 / 压缩后约 74MB**，是理论上限。
- 只搬 python 省 ~24MB 压缩 / ~67MB 落盘，相对整包（压缩估 ~250MB）约 **10%**——**短期性价比偏低**；价值在长期沉淀能力，不在眼前瘦身。
- 真正的肉在 node 的 50MB，但 node 近核心、要啃「启动早期阻塞式下载」，最难。
- ⚠️ 压缩后总大小仅估算（runtime 只在 CI 进包，本地打不出真包）；**最准分母 = 去 GitHub Release 看最近 `.dmg` 实际 MB**，待补。

---

## 设计哲学（先能力，后搬迁，守卫待办）

1. **能力（Phase 1，主线，先做）**：搭通用「按需下载组件框架」（组件中心 + 状态/IPC + 三策略 + 触发降级），用 embed 迁移做零风险验证。这是「用到才下」的地基。
2. **搬迁（Phase 2，逐个挑）**：框架就位后，从候选清单逐个把大件搬出安装包（python 首选），每次 = 填档案卡 + 移出打包 + 真打一次包核实体积。
3. **守卫（待办，放在框架之后）**：一套「打包决策登记表 + CI 硬卡」，以后任何进包大件没做过「随包/按需/候选」决定就挂 CI，自动提醒开发者、逼其决定、留记录。**排在框架之后**——下载能力还不存在时，提醒「这里可按需下载」是空的（无从搬）；先有能力，再有「提醒你去用它」的守卫。详见「后续待办」节。

---

## Phase 1 — 按需下载组件框架（主交付物）

### 一、组件模型（档案卡 + 名册）

```ts
interface ComponentDescriptor {
  id: string; title: string; description: string
  sizeEstimateBytes: number
  strategy: 'hosted-files' | 'pipx' | 'detect-only'
  install: HostedFilesInstall | HostedArchiveInstall | PipxInstall | DetectOnlyInstall
}
interface DownloadUnit { urls: string[]; sha256: string; size: number }  // urls 多镜像依次试
interface HostedFilesInstall {                        // 散文件（模型）
  kind: 'files'; destSubdir: string
  files: Array<DownloadUnit & { relPath: string; chmodExec?: boolean }>
}
interface HostedArchiveInstall {                       // 压缩包（runtime）
  kind: 'archive'; destSubdir: string; archive: DownloadUnit; format: 'tar.gz'
  stripComponents?: number; chmodExec?: string[]; readyCheck: string
}
```

名册 `COMPONENT_REGISTRY`（泛化自 `kbModelManifest.ts`）。加组件 = 加一张卡。`hosted-files` 分 `files`（逐文件下 + 逐文件 sha256）与 `archive`（下整包→校验→解压 strip chmod→readyCheck 判据）两形态，同一专办员处理；**archive 形态是相对现有下载器的新增能力**，服务 runtime 类搬迁。

### 二、安装策略接口（三动作三实现）

```ts
interface ComponentInstaller {
  isInstalled(d): boolean          // 只看本地磁盘，不联网
  install(d, onProgress, signal): Promise<void>
  cancel(): void
}
```
- `HostedFilesInstaller`（泛化自 `kbModelDownloader.ts`，保留 `.part` rename/sha256/60s 超时/取消/进度/成功与收尾分账全部韧性）：多镜像依次试→sha256→(archive)解压 strip chmod→readyCheck。
- `PipxInstaller`（包住 `kbTooling.installMarkitdown()`）；`DetectOnlyInstaller`（soffice：探测 + 引导）。

### 三、状态与 IPC（单一事实源 + 整块推送）

main 持「每组件一格」的状态表（泛化自 `kbModelDownload.ts` 单模型态），任一格变→整表推前台→前台整块镜像。IPC 四处同改（照 KB_MODEL_DOWNLOAD 范式）：`ipc-channels.ts`→`preload/index.ts`→`preload/index.d.ts`→main handler。

### 四、触发与 UX（功能门→非阻断弹窗→就地下→明确成功）

功能门查 `isInstalled()`（本地）→ 未装弹**非阻断提示**。弹窗渐进：初始 **[现在下载][暂不]** → 点下载后**就地**下、自身变进度条、才冒出 **[查看下载详情]**（打开组件中心）。成功：弹窗变一句「说清变化了什么」的成功话再淡出；用户走开给 toast；组件中心行翻 ✓；措辞对「后台收尾」诚实（承接 b5636bb3）。[暂不]/失败 → 功能优雅降级。
> ⚠️ **热路径无弹窗时机**：`engine.ts:1308` 写正文自动召回是后台热路径，缺组件时没有自然弹窗点。embed 已在包外无碍；将来 reranker 走此路时「何时提示下载」需专门设计（搬迁时处理，非本框架）。

### 五、优雅降级（增强层永不拖累基础层）

断网/所有镜像失败→清半截、标 error、功能降级（BM25 / 系统 python / soffice 兜底）；下一半→只留 `.part`；校验不符→删掉重试；取消→回未装态、不当错误；下成功但收尾翻车→**下载仍算成功**、收尾隔离 try。任何失败**不让功能比「没组件」更糟**。

### 六、embed 迁移（框架零风险验证）

`kbModelDownloader.ts` 抽成 `HostedFilesInstaller` 后，bge embed 作首个 `kind:'files'` 组件接上，`urls` 填现有 HF 地址（留镜像位）。**行为与迁移前逐字节一致**——embed 本就运行时下载，迁移纯重构、对用户零新增行为，是框架安全验证。

### 七、组件中心

设置页「组件 / 扩展」板块（升级现有 embed 下载入口）。一行一组件，右侧按钮随状态变：未装→[下载/安装]、下载中→进度条+%+[取消]、失败→原因+[重试]、已就绪→✓、未搬迁（仍随包）→灰显标「随包」。markitdown/soffice 收编为其它策略的行。

---

## Phase 2 — 候选搬迁清单（框架就位后逐个挑）

每次 = 填档案卡 + 移出 `extraResources` + 改消费方目录解析 + **真打一次包核实体积**。按推荐序：

### 候选 #1 — python-runtime（推荐首搬，~67MB 落盘 / ~24MB 压缩）
- **为何首选**：全仓已核实唯一消费方 = ppt-master（`resolveBundledPythonHome`/`PPT_MASTER_PYTHON_HOME` 之外无引用）；纯可选；公网现成（astral Release，CI 已用）；**缺失兜底已存在**（`engine.ts:1749-1750`/`:1780` 回落系统 python）。
- **做法**：档案卡 `kind:'archive'`、`format:'tar.gz'`、`stripComponents:1`、mac `chmodExec:['bin/python3']`、`readyCheck:'bin/python3'`（win `python.exe`）、`archive.urls` 指 astral 公网、整包 sha256 pin；落 `userData/python-runtime/<platform>/`；`resolveBundledPythonHome()`（`cliDetect.ts:189`）解析新增该路径；触发=发起做 PPT 时缺则弹窗，[暂不]/下载中走系统 python 兜底；`package.json:97-98/130-131` extraResources 移除 python 项 + CI「Bundle Python runtime」步退役。

### 候选 #2 — node-runtime（~115MB 落盘 / ~50MB 压缩，靠后）
最大可搬项但 daemon 近核心、**启动早期即需**，需专门设计「首次用画布/方案时阻塞式下载 + 等待体验」；ABI 须仍钉 137（Node 24，build.yml 断言）；源 nodejs.org 公网。收益大、体验设计复杂度大。

### 候选 #3 — onnxruntime-node（~35MB，最后/大概率不搬）
已剔平台、近核心、原生模块（固定路径 require），搬出风险最高、收益已被平台裁剪吃掉大半。大概率维持随包，除非未来评估翻案。

---

## 后续待办（框架之后逐项推进；留插口）

### 待办 ①（首要）— 打包体积守卫（提醒开发者哪里可按需下载）

**放在框架之后做**。目标：以后任何进包大件都自动提醒开发者、逼其当场决定「随包 vs 按需下载」，不靠记性。**用户已定「硬卡」强度：未登记就挂 CI。**

- **打包决策登记表**（`apps/studio/scripts/bundle-decisions.json`，签进库）：每个进包大件一条 `{id, measuredBytes, decision, reason, reviewed}`；`decision` 三态 `bundle`/`on-demand`/`candidate`。初值填步骤 0 实测（Electron=bundle、node/python=candidate、onnx=bundle…）。
- **CI 硬卡检查**（`check-bundle-inventory.mjs`，接 CI 打包链）：扫真实进包大件（解析 `extraResources`+`asarUnpack`+`files`、逐个量盘上体积）与登记表对——**未登记的 >阈值大件 → CI 失败**（信息含照抄示例）；`candidate` → 提示不挂；体积较登记 ±20% → CI 失败要求复核；吻合 → 放行。
- **开发者引导**：CLAUDE.md 记「改 extraResources/asarUnpack/加大依赖须更新登记表」；负例（人为加未登记大件）验证 CI 如期挂。
- **为何排框架之后**：`decision:'on-demand'` 这个选项要真能落地，前提是按需下载框架已存在；否则守卫只能在 bundle/candidate 之间打转，价值打折。框架先行，守卫才完整。

### 待办 ②+ — 框架能力增强（留插口，触发信号见括号）

- **国内镜像 / CDN**：`DownloadUnit.urls` 多镜像结构就位，后续填 `hf-mirror.com` 等，下载器零改动（国内用户首下大面积失败时）。实测慢网下 40MB 二进制下 6–7 分钟——搬 python/node 时慢网体验是硬约束。
- **断点续传**：v1 断了从头下；搬 node（115MB）或慢网反馈多时再加 Range 续传。
- **后台自动下载偏好**：设置项「WiFi 下自动预下载已启用功能的组件」。
- **组件更新 / 版本漂移**：档案卡版本钉死；组件出新版时的「检测 pin 变更→提示重下」流（借现有 fingerprint/stale）。
- **磁盘占用管理**：组件中心显示各组件占用 + 一键删除释放。
- **登记表维护**（待办①落地后）：每完成一次搬迁把候选标 `on-demand`；新识别可搬项追加进登记表与体重地图。

---

## 验收标准

### A. 框架验收（Phase 1，主交付）
- `kbModelDownloader.ts` 抽为 `HostedFilesInstaller`；embed 迁移后行为逐字节等价（零回归）。
- 支持 `kind:'files'` 与 `kind:'archive'`（解压/strip/chmod/整包校验），archive 有单测（即便暂无生产消费方也实现，为搬迁铺路）。
- `DownloadUnit.urls` 多镜像依次试；状态泛化为每组件一格、前台整块镜像；IPC 四处无类型漏。
- 组件中心（未搬迁项灰显「随包」）+ 渐进弹窗 + 成功反馈/toast，措辞对后台收尾诚实。
- markitdown/soffice 收编各走策略。`bun run typecheck` 绿；纯逻辑有 bun test；BM25 测试零回归。

### B. 单次搬迁验收模板（Phase 2，每挑一个候选）
- 从 extraResources 移除 → 真实产物对应目录消失，**真打一次包核实前后体积差≈其体积**。
- 全新安装→触发功能→弹窗引导→落 userData→功能用上；未下/失败/[暂不]→既有降级兜底不崩。
- sha256 校验通过、半截不当成功；消费方目录解析新增 userData 路径且 dev 分支保留。

### C. 守卫验收（待办①，框架之后）
- `bundle-decisions.json` 落地含步骤 0 实测全部大件与决定；`check-bundle-inventory.mjs` 接 CI：未登记/体积显著变化→硬失败，`candidate`→提示，吻合→放行。
- CLAUDE.md 记登记纪律；人为加未登记大件→CI 如期失败（负例验证）。

---

## 实施顺序建议

1. **Phase 1 框架**（先做，主线）：抽 `HostedFilesInstaller`（含 files+archive）→ 状态/IPC 泛化 → embed 迁移验证 → 组件中心 UI + 渐进弹窗 → 收编 markitdown/soffice。**交付后安装包体积尚未变化。**
2. **Phase 2 逐个搬**：从候选清单挑（推荐 python 首搬），套「单次搬迁验收模板」，每次真打包核实体积。**真正瘦身从这里开始。**
3. **待办① 守卫**（框架之后）：`bundle-decisions.json` + `check-bundle-inventory.mjs` + CI 硬卡 + CLAUDE.md 引导 + 负例验证。之后长期自动提醒可搬点。
4. **待办②+ 增强**：按触发信号逐项补（镜像/续传/自动下载/更新/磁盘管理）。

> 短期不追求瘦身（实测省 10% 不划算）；价值在长期——先有按需下载能力，再逐个搬，最后用守卫防未来失控 + 持续暴露可搬点。

---

## 与其它工作的关系
- **取代 retrieval-quality spec 的 P1 打包段落**：reranker 将来在 `COMPONENT_REGISTRY` 加一张 `hosted-files` 卡即可（prebundle/extraResources 链已退役 dcb3e1f9）。
- **通用化 `2026-07-15-kb-model-first-run-download-design.md`**：embed 迁移即其延续。
- **LanceDB** 已暂缓，无关（memory `kb-lancedb-deferred`）。
