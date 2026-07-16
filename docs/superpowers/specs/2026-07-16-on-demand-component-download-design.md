# 按需下载组件框架 + python-runtime 首搬（安装包瘦身）

日期：2026-07-16
状态：设计草案，待用户复核 → writing-plans
根本目的：**缩小安装包体积**。把「功能专属、非人人都用」的大块头从随包发布改为「用到才从网上下」。

前序 / 相关：
- `2026-07-15-kb-model-first-run-download-design.md`（嵌入模型首次下载——本 spec 是它的**通用化**，把那套 KB 专用下载器抽成可复用引擎）
- `2026-07-15-kb-retrieval-quality-from-anythingllm-design.md`（P1 reranker 模型 ~100MB——本 spec 的通用引擎正是 P1 打包段落的**取代方案**，见下「与其它工作的关系」）
- 已落地基座：运行时下载器 `kbModelDownloader.ts`、TS 单一事实源清单 `kbModelManifest.ts`、共享状态 `kbModelDownload.ts`、`kbModelDir()` 收敛（提交 c8bc2e0d / 55442c4a / 142cf665 / b4f87696 / 3d1f22d1 / dcb3e1f9 / b5636bb3）

---

## 背景与目标

### 根本目的：缩小安装包

当前正式安装包里塞进了若干「功能专属」的大块头（`extraResources` + `asarUnpack` 的原生模块）。其中**真正可选、且能搬出去缩体积**的，已查证的「体重分布地图」（单平台估值，精确值需真打一次包核实）：

| 装了啥 | 单平台约 | 是否可选 | 能否按需下载 | 下载源 |
|---|---|---|---|---|
| onnxruntime-node（跑模型的原生引擎） | 大（多平台目录 216MB，单平台 ~50–120MB） | 只语义检索用 | **难**：原生模块、固定路径 require，风险高 | npm |
| **node-runtime**（内置 Node 24 单文件） | ~60–110MB | daemon（画布/方案）用，**近核心** | 能搬，但启动早期就要，时机难卡 | nodejs.org（公网，CI 已用） |
| **python-runtime**（内置 CPython 3.12） | **~60–80MB** | **只 ppt-master（做 PPT）用，纯可选** | **相对容易**（可重定位压缩包） | astral GitHub Release（公网，CI 已用） |
| prebundled（daemon 打包） | ~20–60MB | 画布/方案核心 | 不可选，搬不了 | — |
| fusion-code-cli（AI 后端） | 几十 MB | 核心 | 搬不了 | — |
| @img / sharp | ~16MB | 用得广、小 | 不值当 | npm |

**结论**：v1 选 **python-runtime** 作第一个真实搬运目标——它是唯一同时满足「功能纯可选 + 体积实打实（60–80MB）+ 公网现成不用自建托管 + 缺失兜底代码已存在」的目标，风险最小、收益直接。node-runtime / onnxruntime-node 留后（各有近核心/原生模块的额外复杂度）。

### 功能目标

把现有 KB 专用下载器（`kbModelDownloader.ts`，只会下 bge 模型）抽成一个**通用「组件按需下载」框架**：

- **界面统一、引擎分派**：一个设置页「组件中心」列出所有可选组件（统一的状态/进度/取消/重试/降级 UX）；底层按组件类型分派给不同「安装策略」。
- **触发即引导**：用户用到某个缺失组件的功能时，功能门弹非阻断提示，引导下载，缺失时功能优雅降级。
- **首个搬运证明价值**：embed 模型迁到新引擎（零行为变化，验证抽象）；python-runtime 改按需下载（真实缩体积）。

### 非目标（本 spec 不做）

- 不搬 node-runtime、onnxruntime-node（各自独立评估，见「未来」）。
- 不做完整国内 CDN / 断点续传（多镜像结构就位即可，v1 只填默认源）。
- 不改 reranker 检索逻辑（reranker 模型将来复用本引擎，但不在本 spec 交付）。
- 不动 fusion-code-cli / prebundled daemon（核心，搬不了）。

---

## 关键背景事实（已查证，行号基于 apps/studio/）

- **现有下载器（待抽象）**：`electron/main/services/kbModelDownloader.ts` —— 已含临时文件 `.part` rename、sha256 校验、60s 超时、AbortController 取消、字节进度、下载成功与「下完收尾（重热/重建）」分开算账（提交 b5636bb3）。**这些韧性全部保留**，只把「写死 KB 模型」换成「读组件档案卡」。
- **现有清单（待泛化）**：`electron/main/core/kbModelManifest.ts` `KB_DOWNLOADABLE_MODELS`（`dirName/hfRepo/revision/files[{relPath,sha256,size}]`）。每文件目前只有一个 HF 地址——要扩成「一串候选地址依次试」。
- **现有共享状态（待泛化）**：`electron/shared/kbModelDownload.ts` `KbModelDownloadState{phase,percent,currentFile,errorMessage,installed}` —— 单模型。要扩成「每组件一格」的状态表。
- **现有目录解析**：`electron/main/core/kbModelDir.ts` `kbModelDir()` → `userData/kb-model`（打包后 Resources 只读，下载目标必须用户可写）。通用化为按组件解析可写目录。
- **现有 IPC**（提交 142cf665，KB_MODEL_DOWNLOAD 四处）：`shared/ipc-channels.ts` → `preload/index.ts` → `preload/index.d.ts` → main handler（`ipc/register.ts`）。加通用组件通道照此四处同改。
- **现有 UI**：设置页下载入口（b4f87696）、`KbToolbar` 缺模型引导（3d1f22d1）。升级为通用组件中心 + 通用弹窗。
- **python-runtime 消费方（已核实唯一）**：`electron/main/core/cliDetect.ts:189` `resolveBundledPythonHome()`，经 `engine.ts:1751` 注入为 `PPT_MASTER_PYTHON_HOME`，只服务 **ppt-master** skill。**全仓无第二消费方**（markitdown 的 `python3`/`py` 是用户系统 Python，非内置 runtime，别混淆）。
- **python-runtime 缺失兜底已存在**：`engine.ts:1749-1750`、`:1780` 注释——`resolveBundledPythonHome()` 返回 null 时 ppt-master 的 `bin/ensure-python.sh` 回落系统 python3。即「未下载」已有定义行为，不崩。
- **python-runtime 打包来源**：`package.json:97-98`（mac）/`:130-131`（win）`extraResources`；CI `.github/workflows/build.yml` python bundle 步从 `https://github.com/astral-sh/python-build-standalone/releases/download/${TAG}/cpython-${VER}+${TAG}-${dist}-install_only.tar.gz` 下载（`PYTHON_STANDALONE_TAG=20260510`、`PYTHON_STANDALONE_VERSION=3.12.13`），`tar --strip-components=1` 落到 `python-runtime/<platform>/`，mac 解释器在 `bin/python3`、win 在 `python.exe`。**运行时下载可指向同一公网 URL，无需自建托管。**
- **markitdown / soffice（收编为其它策略）**：`electron/main/core/kbTooling.ts` `installMarkitdown()`（pipx/pip，委托系统包管理器）、`probeTooling/detectTooling`（探测）。soffice 无自动安装、只探测 + 引导。

---

## 设计

### 一、组件模型（档案卡 + 名册）

所有可选组件用同一张「档案卡」描述（`ComponentDescriptor`），集中放在一个「名册」（`COMPONENT_REGISTRY`，由 `kbModelManifest.ts` 泛化而来）。**加一个新组件 = 往名册加一张卡。**

```ts
interface ComponentDescriptor {
  id: string                    // 唯一代号，如 'kb-embed' / 'python-runtime' / 'markitdown'
  title: string                 // 给用户看的名字
  description: string           // 一句话说明「装了有啥用」
  sizeEstimateBytes: number     // 预估体积（提示文案 + 进度分母参考）
  strategy: 'hosted-files' | 'pipx' | 'detect-only'
  // 安装参数：按 strategy 各异（联合类型），交给对应「专办员」
  // hosted-files 的参数再分 files/archive 两形态（见下 HostedFilesInstall | HostedArchiveInstall）
  install: HostedFilesInstall | HostedArchiveInstall | PipxInstall | DetectOnlyInstall
}

interface DownloadUnit {
  urls: string[]                // 多镜像：按序试，第一个成的用（v1 只填默认）
  sha256: string
  size: number
}

// 散文件模式（模型）：直接把 N 个文件落到 destSubdir 下的 relPath
interface HostedFilesInstall {
  kind: 'files'
  destSubdir: string
  files: Array<DownloadUnit & { relPath: string; chmodExec?: boolean }>
  // readyCheck 省略 = 全部 files 就位即就绪
}

// 压缩包模式（python-runtime）：下 1 个 tarball → 校验整包 → 解压到 destSubdir
interface HostedArchiveInstall {
  kind: 'archive'
  destSubdir: string
  archive: DownloadUnit         // 指向 tarball 本身（urls/sha256/size = 整包）
  format: 'tar.gz'
  stripComponents?: number      // python-standalone 剥顶层 python/ 目录（1 层）
  chmodExec?: string[]          // 解压后需 +x 的相对路径（mac: ['bin/python3']）
  readyCheck: string            // 解压后的「装好判据」文件（mac: 'bin/python3'）
}
```

> 说明：`hosted-files` 策略分两形态——**散文件**（模型：逐文件下载 + 逐文件 sha256，全部就位即就绪）与**压缩包**（python-runtime：下整个 tarball → 校验整包 sha256 → 解压 + strip + chmod → 校验 readyCheck 文件）。压缩包形态是相对现有下载器的**主要新增能力**。两形态由 `kind` 区分，同属 `HostedFilesInstaller` 一个专办员处理。

### 二、安装策略接口（三动作，三实现）

所有专办员对外只暴露相同三动作，上层（组件中心/弹窗/功能门）不感知内部：

```ts
interface ComponentInstaller {
  isInstalled(d: ComponentDescriptor): boolean            // 只看本地磁盘，不联网
  install(d, onProgress, signal): Promise<void>           // 带进度、可取消
  cancel(): void
}
```

- **`HostedFilesInstaller`**（核心，泛化自 `kbModelDownloader.ts`）：按档案卡 `files[].urls` 多镜像依次试下载 → sha256 校验 → （tarball）解压 strip chmod → readyCheck。**保留现有全部韧性**（`.part` rename、超时、取消、进度、成功/收尾分账）。embed、python-runtime 都用它。
- **`PipxInstaller`**（包住 `kbTooling.installMarkitdown()`）：pipx 优先、pip --user 退路、探测走补全 PATH。`isInstalled` = `detectTooling().markitdown`。
- **`DetectOnlyInstaller`**（soffice）：`isInstalled` = `detectTooling().soffice`；`install` = 打开安装引导（无自动安装）。

### 三、状态与 IPC（单一事实源 + 整块推送）

main 持有**一张状态表**（键=组件 id），泛化自 `kbModelDownload.ts` 的单模型状态：

```ts
type ComponentDownloadState = {
  phase: 'idle' | 'downloading' | 'ready' | 'error'
  percent: number
  currentFile: string | null
  errorMessage: string | null
  installed: boolean
}
type ComponentStateMap = Record<string /*componentId*/, ComponentDownloadState>
```

- 任一组件状态变 → 整张表推前台 → 前台整块替换、重渲染列表（延续现有「后台单一事实源、前台照镜子、不自拼」范式）。
- IPC 四处同改（照 KB_MODEL_DOWNLOAD 范式）：`ipc-channels.ts`（通道常量：拉快照 / 广播 / start(id) / cancel(id) / 打开引导）→ `preload/index.ts` → `preload/index.d.ts` → main handler（`ipc/register.ts`）。

### 四、触发与 UX（功能门 → 非阻断弹窗 → 就地下 → 明确成功）

**流程**：用户触发需某组件的功能 → 查该组件 `isInstalled()`（本地、快）→ 未装则弹**非阻断提示**（横幅/角落卡片，不强弹遮挡）。

**弹窗按钮渐进式**：
1. 初始只有 **[现在下载]** 和 **[暂不]**。
2. 点 **[现在下载]** → 弹窗**就地**开始下（不跳走），自身变进度条（percent + 取消），**此时才**冒出 **[查看下载详情]**（打开组件中心；同一目的地，此入口下文案叫「查看下载详情」贴合当下心思）。
3. **[暂不]** → 关闭，功能优雅降级继续用（见下）。

**成功反馈（明确、说清变化、诚实）**：
- 下完后弹窗**不立刻消失**，先变成一句说清「变化了什么」的成功话（如「✓ 精排模型已就绪，之后搜索会更准」；python 则「✓ Python 运行时已就绪，PPT 功能已可用」），再自动淡出/手动关。
- 用户已关弹窗/走开 → 给一条不打扰的轻提示（toast）：「XX 下载完成 ✓」。
- 组件中心那行翻 **已就绪 ✓**。
- **诚实分寸**：文件下完即报「已下载完成 ✓」（板上钉钉）；若触发后台收尾（重热/重建索引），只轻带「正在后台更新，稍后自动生效」，不夸口「立刻全好」——成功话只为「确实做成的事」背书（承接现有「下载成功 vs 收尾分开算账」纪律 b5636bb3）。

**组件中心**：设置页「组件 / 扩展」板块（升级现有 embed 下载入口）。一行一组件，右侧按钮随状态变：未装→[下载/安装]、下载中→进度条+%+[取消]、失败→原因+[重试]、已就绪→✓、随包不可搬→灰显。python-runtime/node-runtime v1 标「随包」灰显（node phase 2、python v1 搬完后不再随包）。

### 五、优雅降级（增强层永不拖累基础层）

下载失败/未装**永不让功能比「没这组件」更糟**：

| 情况 | 下载器处理 | 用户侧 |
|---|---|---|
| 断网 / 所有镜像失败 | 清半截、标 error + 原因 | 提示可重试；功能降级：语义检索走 BM25、PPT 回落系统 python、markitdown 缺则 soffice 兜底 |
| 下到一半断 | 只留 `.part`，不算成功 | 显示失败，重试从头下（v1 不做续传） |
| 校验不符 | 删掉、报「校验失败」 | 重试；绝不用可疑文件 |
| 用户取消 | 停、清半截、**不当错误** | 回未安装态，随时可再下 |
| 下成功但收尾翻车 | **下载仍算成功**，收尾单独 try 隔离 | 组件显示就绪，收尾走自身降级链 |

### 六、python-runtime 专项（v1 的缩体积一刀）

- **下载**：`HostedFilesInstaller` + `archive:'tar.gz'` + `stripComponents:1` + mac `bin/python3` `chmodExec`；`urls` 指向 CI 同款 astral 公网 Release；整包 sha256 校验（pin 到 manifest）；readyCheck = `bin/python3`（mac）/`python.exe`（win）。
- **落点**：用户可写目录（如 `userData/python-runtime/<platform>/`）；`resolveBundledPythonHome()`（`cliDetect.ts:189`）解析顺序**新增该 userData 路径**，排在现有 `resourcesPath/python-runtime` 之前或取代之。
- **触发**：ppt-master 被调用 / 用户发起做 PPT 时，若 `isInstalled('python-runtime')` 为假 → 弹窗引导；用户 [暂不] 或下载中 → 现有「null → 回落系统 python」兜底继续（不崩）。
- **打包收尾**：`package.json` mac/win `extraResources` **移除 python-runtime 项**；CI build.yml「Bundle Python runtime」步可退役或改为「可选离线预置」；`resolveBundledPythonHome()` 的 dev 分支保留。**这一步才是安装包真正瘦 60–80MB 的地方。**
- **平台**：mac / win 各自 tarball、各自 dist 串；linux 现无 extraResources，维持。

### 七、embed 迁移（零行为变化，验证抽象）

把 `kbModelDownloader.ts` 抽成 `HostedFilesInstaller` 后，bge embed 作为**第一个 hosted-files 组件**接上：档案卡 `strategy:'hosted-files'`、`archive:'none'`、四个散文件、`urls` 填现有 HF 地址（顺带留镜像位）。**下载/校验/降级行为与迁移前逐字节一致**——这是「通用引擎是否立住」的试金石，验证方式即「embed 还能跟以前一样下下来」。

---

## 数据流

```
用户触发功能（做 PPT / 语义检索 / 文档导入）
  → 功能门 isInstalled(componentId)   本地磁盘、不联网
      已装 → 直接用
      未装 → 非阻断弹窗[现在下载][暂不]
              [暂不] → 功能优雅降级（BM25 / 系统 python / soffice 兜底）
              [现在下载] → installer.install(descriptor, onProgress, signal)
                  ├ HostedFilesInstaller：多镜像依次试 → sha256 →（tarball）解压 strip chmod → readyCheck
                  ├ PipxInstaller：pipx→pip --user 退路
                  └ DetectOnlyInstaller：打开引导
                  进度 → main 状态表某格更新 → 整表推前台 → 弹窗进度条 + 组件中心行同步
                  成功 → 明确成功反馈（说清变化）+ 收尾（隔离 try）；走开则 toast；行翻 ✓
                  失败/取消 → 清半截、状态 error/idle、功能降级兜底
```

## 验收标准

**通用引擎**
- `kbModelDownloader.ts` 抽为 `HostedFilesInstaller`；embed 迁移后下载/校验/降级**逐字节等价**（纯重构零回归）。
- `HostedFilesInstaller` 支持散文件与 tar.gz（解压/strip/chmod/整包校验）两种。
- 每文件 `urls` 多镜像依次试；v1 只填默认源但结构就位。
- 状态从单模型泛化为「每组件一格」的表；前台整块镜像。

**python-runtime 搬运（缩体积核心）**
- `extraResources` 移除 python-runtime → 真实产物 `Resources/` 下无 `python-runtime/`，安装包实测减小 ~60–80MB（**需真打一次包核实前后体积**）。
- 全新安装（无内置 python）→ 触发做 PPT → 弹窗引导下载 → 落用户可写目录 → ppt-master 用上钉死 3.12。
- 未下载 / 下载失败 / [暂不] → ppt-master 回落系统 python（现有兜底），**不崩**。
- 整包 sha256 校验通过；半截不被当成功。

**触发与 UX**
- 弹窗初始 [现在下载][暂不]；点下载 → 变进度条 + 冒出 [查看下载详情]（就地下、不跳走）。
- 下载成功有明确反馈（说清变化）；走开有 toast；组件中心行翻 ✓；措辞对「后台收尾」保持诚实。

**收编与前瞻**
- markitdown（pipx）/soffice（detect-only）进入组件中心，底层各走策略。
- node-runtime / onnxruntime-node 留「未来」；reranker 将来复用 `HostedFilesInstaller`（加一张档案卡）。

**通用纪律**
- `bun run typecheck` 绿；IPC 四处同改无类型漏；新增纯逻辑（多镜像选址、tar 解压判据、状态表 reducer）有 bun test；现有 BM25 测试零回归。

## 实施顺序建议

1. **抽骨架 + embed 迁移**（零新增行为，验证通用引擎）——`ComponentDescriptor`/`COMPONENT_REGISTRY`/`ComponentInstaller`/状态表/IPC 泛化；embed 接上；确认「embed 照旧能下」。
2. **HostedFilesInstaller 增 tarball 能力**（解压/strip/chmod/整包校验）——为 python-runtime 铺路。
3. **python-runtime 改按需下载**（缩体积一刀）——档案卡 + `resolveBundledPythonHome()` 新增 userData 路径 + 功能门触发 + 移除 extraResources + CI 步退役。**真打一次包核实体积。**
4. **组件中心 UI + 渐进式弹窗 + 成功反馈/toast**——升级现有设置页入口；接功能门触发。
5. **收编 markitdown / soffice**（低成本，UI 完整性；不缩体积）。

## 与其它工作的关系

- **取代 retrieval-quality spec 的 P1 打包段落**：那份 spec 的 P1 说 reranker 走 `prebundle`/`extraResources` 打包——该链已退役（dcb3e1f9）。reranker 模型将来只需在本框架 `COMPONENT_REGISTRY` 加一张 `hosted-files` 档案卡即可下载，无需打包。本 spec 落地后应回改 retrieval-quality spec 的 P1「打包」小节指向此处。
- **通用化 `2026-07-15-kb-model-first-run-download-design.md`**：那份是 KB 模型专用首下；本 spec 把它抽成可复用框架，embed 迁移即其延续。
- **LanceDB**（向量存储升级）已评估暂缓，与本 spec 无关（memory `kb-lancedb-deferred`）。

## 未来（不在本 spec，各自独立立项）

- **node-runtime 按需下载**（~60–110MB）：daemon 近核心、启动早期即需，需设计「首次用画布/方案时阻塞式下载」的时机与体验；下载源 nodejs.org 公网现成、不用自托管。收益大、复杂度也大。
- **onnxruntime-node 瘦身**（最大但最难）：原生模块、按固定路径 require、语义检索近核心，搬出风险最高；先评估 electron-builder 是否已裁到单平台，再论。
- **国内镜像 / CDN**：`urls` 多镜像结构已就位，后续填 `hf-mirror.com` 等即用，下载器代码零改动。
