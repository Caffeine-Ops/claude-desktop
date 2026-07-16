# 按需下载组件框架（安装包瘦身能力）

日期：2026-07-16
状态：设计草案，待用户复核 → writing-plans
根本目的：**缩小安装包体积**。先把「用到才从网上下」这套**通用能力**搭扎实，再按情况把「功能专属、非人人都用」的大块头逐个移出安装包。

前序 / 相关：
- `2026-07-15-kb-model-first-run-download-design.md`（嵌入模型首次下载——本 spec 是它的**通用化**，把那套 KB 专用下载器抽成可复用框架）
- `2026-07-15-kb-retrieval-quality-from-anythingllm-design.md`（P1 reranker 模型 ~100MB——本框架取代其 P1 打包段落，见「与其它工作的关系」）
- 已落地基座：运行时下载器 `kbModelDownloader.ts`、TS 单一事实源清单 `kbModelManifest.ts`、共享状态 `kbModelDownload.ts`、`kbModelDir()` 收敛（提交 c8bc2e0d / 55442c4a / 142cf665 / b4f87696 / 3d1f22d1 / dcb3e1f9 / b5636bb3）

---

## 设计哲学（先能力，后搬迁）

本 spec 的交付物**是「按需下载」这套通用能力本身，不是任何一次具体搬迁**。

- **v1 = 框架**：把现有 KB 专用下载器抽成通用「组件按需下载」框架（组件中心 UI + 状态/IPC + 三种安装策略 + 触发/降级），并用 embed 模型迁移做**零风险验证**（embed 本就在运行时下载，迁移是纯重构、零新增行为）。
- **搬迁 = 菜单**：框架就位后，「哪些东西移出安装包」变成一张**候选搬迁清单**（下「候选搬迁清单」节），用户**按情况逐个挑、逐个搬**。每次搬迁 = 「填一张组件档案卡 + 从 `extraResources` 移出」，独立决策、可随时喊停。
- **待补 = 活 backlog**：框架已知要补的能力（国内镜像、断点续传、后台自动下载偏好等）集中记在「后续待补」节，不在 v1 一次做完，但结构上留好插口。

**为什么这样分**：把「能按需下载」（能力）和「具体搬哪个」（应用）解耦——框架一次做对、做稳；以后每搬一个只是低风险的增量，且是用户自己按体积/风险/时机权衡后的选择，不被 spec 钉死。

---

## 背景：安装包「体重分布」地图 = 候选搬迁清单的依据

当前正式安装包塞进若干「功能专属」大块头（`extraResources` + `asarUnpack` 原生模块）。已查证的体重分布（单平台估值，**精确值需真打一次包核实**）——这张表就是「哪些地方能移出」的依据：

| 装了啥 | 单平台约 | 是否可选 | 能否按需下载 | 下载源 | 归入 |
|---|---|---|---|---|---|
| onnxruntime-node（跑模型的原生引擎） | 大（多平台目录 216MB，单平台 ~50–120MB） | 只语义检索用 | **难**：原生模块、固定路径 require | npm | 候选 #3 |
| **node-runtime**（内置 Node 24 单文件） | ~60–110MB | daemon（画布/方案）用，**近核心** | 能搬，但启动早期就要，时机难卡 | nodejs.org（公网，CI 已用） | 候选 #2 |
| **python-runtime**（内置 CPython 3.12） | **~60–80MB** | **只 ppt-master（做 PPT）用，纯可选** | **相对容易**（可重定位压缩包） | astral GitHub Release（公网，CI 已用） | **候选 #1（推荐首选）** |
| prebundled（daemon 打包） | ~20–60MB | 画布/方案核心 | 不可选 | — | 搬不了 |
| fusion-code-cli（AI 后端） | 几十 MB | 核心 | 搬不了 | — | 搬不了 |
| @img / sharp | ~16MB | 用得广、小 | 不值当 | npm | 暂不 |

排序依据：可选性（越纯粹越该搬）、体积（越大越值）、风险（原生模块/近核心越高）、托管成本（公网现成 vs 自建）。python-runtime 四项全优，是推荐首选；node/onnx 各有额外复杂度，靠后。

---

## 关键背景事实（已查证，行号基于 apps/studio/）

- **现有下载器（待抽象）**：`electron/main/services/kbModelDownloader.ts` —— 已含临时文件 `.part` rename、sha256 校验、60s 超时、AbortController 取消、字节进度、下载成功与「下完收尾（重热/重建）」分开算账（b5636bb3）。**这些韧性全部保留**，只把「写死 KB 模型」换成「读组件档案卡」。
- **现有清单（待泛化）**：`electron/main/core/kbModelManifest.ts` `KB_DOWNLOADABLE_MODELS`（`dirName/hfRepo/revision/files[{relPath,sha256,size}]`）。每文件目前只有一个 HF 地址——扩成「一串候选地址依次试」。
- **现有共享状态（待泛化）**：`electron/shared/kbModelDownload.ts` `KbModelDownloadState{phase,percent,currentFile,errorMessage,installed}`（单模型）——扩成「每组件一格」的状态表。
- **现有目录解析**：`electron/main/core/kbModelDir.ts` `kbModelDir()` → `userData/kb-model`（打包后 Resources 只读，下载目标必须用户可写）。通用化为按组件解析可写目录。
- **现有 IPC**（142cf665，KB_MODEL_DOWNLOAD 四处）：`shared/ipc-channels.ts` → `preload/index.ts` → `preload/index.d.ts` → main handler（`ipc/register.ts`）。加通用组件通道照此四处同改。
- **现有 UI**：设置页下载入口（b4f87696）、`KbToolbar` 缺模型引导（3d1f22d1）。升级为通用组件中心 + 通用弹窗。
- **markitdown / soffice（收编为其它策略）**：`electron/main/core/kbTooling.ts` `installMarkitdown()`（pipx/pip）、`probeTooling/detectTooling`（探测）。soffice 无自动安装、只探测 + 引导。
- **候选 #1 python-runtime 的查证**（见「候选搬迁清单」节展开）：全仓唯一消费方 `cliDetect.ts:189` `resolveBundledPythonHome()` → `engine.ts:1751` 注入 `PPT_MASTER_PYTHON_HOME`，只服务 ppt-master；缺失兜底已存在（`engine.ts:1749-1750`、`:1780` 回落系统 python）；`package.json:97-98`/`:130-131` extraResources；CI build.yml 从 astral 公网 Release 下 `PYTHON_STANDALONE_TAG=20260510`/`VERSION=3.12.13`，`tar --strip-components=1`，mac 解释器 `bin/python3`、win `python.exe`。

---

## 框架设计（v1 交付物）

### 一、组件模型（档案卡 + 名册）

所有可选组件用同一张「档案卡」描述，集中放在一个「名册」（`COMPONENT_REGISTRY`，由 `kbModelManifest.ts` 泛化）。**加一个组件 = 加一张卡。**

```ts
interface ComponentDescriptor {
  id: string                    // 'kb-embed' / 'python-runtime' / 'markitdown' …
  title: string                 // 给用户看的名字
  description: string           // 一句话「装了有啥用」
  sizeEstimateBytes: number     // 预估体积（文案 + 进度参考）
  strategy: 'hosted-files' | 'pipx' | 'detect-only'
  // hosted-files 再分 files/archive 两形态；install 按 strategy 各异（联合类型）
  install: HostedFilesInstall | HostedArchiveInstall | PipxInstall | DetectOnlyInstall
}

interface DownloadUnit {
  urls: string[]                // 多镜像：按序试，第一个成的用（v1 只填默认）
  sha256: string
  size: number
}

// 散文件模式（模型）：N 个文件直接落到 destSubdir 下
interface HostedFilesInstall {
  kind: 'files'
  destSubdir: string
  files: Array<DownloadUnit & { relPath: string; chmodExec?: boolean }>
  // 省略 readyCheck = 全部 files 就位即就绪
}

// 压缩包模式（python-runtime 等 runtime）：下 1 个 tarball → 校验整包 → 解压
interface HostedArchiveInstall {
  kind: 'archive'
  destSubdir: string
  archive: DownloadUnit         // urls/sha256/size = 整个 tarball
  format: 'tar.gz'
  stripComponents?: number      // python-standalone 剥顶层 python/（1 层）
  chmodExec?: string[]          // 解压后需 +x 的相对路径（mac: ['bin/python3']）
  readyCheck: string            // 解压后「装好判据」文件（mac: 'bin/python3'）
}
```

`hosted-files` 策略分两形态由 `kind` 区分、同一专办员处理：**散文件**（模型：逐文件下载 + 逐文件 sha256）与**压缩包**（runtime：下整包 → 校验整包 → 解压 strip chmod → 校验 readyCheck）。**压缩包形态是相对现有下载器的主要新增能力**，服务将来所有 runtime 类搬迁。

### 二、安装策略接口（三动作，三实现）

所有专办员对外只露相同三动作，上层（组件中心/弹窗/功能门）不感知内部：

```ts
interface ComponentInstaller {
  isInstalled(d: ComponentDescriptor): boolean   // 只看本地磁盘，不联网
  install(d, onProgress, signal): Promise<void>  // 带进度、可取消
  cancel(): void
}
```

- **`HostedFilesInstaller`**（核心，泛化自 `kbModelDownloader.ts`）：多镜像依次试 → sha256 →（archive）解压 strip chmod → readyCheck。**保留现有全部韧性**（`.part` rename、超时、取消、进度、成功/收尾分账）。embed、及将来 runtime 类都用它。
- **`PipxInstaller`**（包住 `kbTooling.installMarkitdown()`）：pipx 优先、pip --user 退路。`isInstalled` = `detectTooling().markitdown`。
- **`DetectOnlyInstaller`**（soffice）：`isInstalled` = `detectTooling().soffice`；`install` = 打开安装引导。

### 三、状态与 IPC（单一事实源 + 整块推送）

main 持有**一张状态表**（键=组件 id），泛化自 `kbModelDownload.ts`：

```ts
type ComponentDownloadState = {
  phase: 'idle' | 'downloading' | 'ready' | 'error'
  percent: number; currentFile: string | null
  errorMessage: string | null; installed: boolean
}
type ComponentStateMap = Record<string /*componentId*/, ComponentDownloadState>
```

任一格变 → 整表推前台 → 前台整块替换、重渲染列表（延续「后台单一事实源、前台照镜子、不自拼」范式）。IPC 四处同改（照 KB_MODEL_DOWNLOAD 范式）：`ipc-channels.ts`（拉快照/广播/start(id)/cancel(id)/打开引导）→ `preload/index.ts` → `preload/index.d.ts` → main handler。

### 四、触发与 UX（功能门 → 非阻断弹窗 → 就地下 → 明确成功）

用户触发需某组件的功能 → 查 `isInstalled()`（本地、快）→ 未装则弹**非阻断提示**（横幅/角落卡片，不强弹遮挡）。

**弹窗按钮渐进式**：
1. 初始只有 **[现在下载]** 和 **[暂不]**。
2. 点 **[现在下载]** → **就地**开始下（不跳走），弹窗自身变进度条（percent + 取消），**此时才**冒出 **[查看下载详情]**（打开组件中心；此入口下文案叫「查看下载详情」贴合当下心思）。
3. **[暂不]** → 关闭，功能优雅降级继续用。

**成功反馈（明确、说清变化、诚实）**：
- 下完弹窗不立刻消失，先变一句说清「变化了什么」的成功话，再自动淡出/手动关。
- 用户已关弹窗/走开 → 不打扰的轻提示 toast：「XX 下载完成 ✓」。
- 组件中心那行翻 **已就绪 ✓**。
- **诚实分寸**：文件下完即报「已下载完成 ✓」；若触发后台收尾（重热/重建），只轻带「正在后台更新，稍后自动生效」，不夸口——成功话只为「确实做成的事」背书（承接 b5636bb3 的「下载成功 vs 收尾分账」纪律）。

**组件中心**：设置页「组件 / 扩展」板块（升级现有 embed 下载入口）。一行一组件，右侧按钮随状态变：未装→[下载/安装]、下载中→进度条+%+[取消]、失败→原因+[重试]、已就绪→✓、**未搬迁（仍随包）→灰显标「随包」**。候选搬迁清单里还没搬的组件（node/onnx）在中心里可见但灰显，搬迁后才变可下载。

### 五、优雅降级（增强层永不拖累基础层）

下载失败/未装**永不让功能比「没这组件」更糟**：

| 情况 | 下载器处理 | 用户侧 |
|---|---|---|
| 断网 / 所有镜像失败 | 清半截、标 error + 原因 | 提示可重试；功能降级（语义检索走 BM25、PPT 回落系统 python、markitdown 缺则 soffice 兜底） |
| 下到一半断 | 只留 `.part`，不算成功 | 显示失败，重试从头下（v1 不做续传） |
| 校验不符 | 删掉、报「校验失败」 | 重试；绝不用可疑文件 |
| 用户取消 | 停、清半截、**不当错误** | 回未安装态，随时可再下 |
| 下成功但收尾翻车 | **下载仍算成功**，收尾单独 try 隔离 | 组件显示就绪，收尾走自身降级链 |

### 六、embed 迁移（框架的零风险验证）

把 `kbModelDownloader.ts` 抽成 `HostedFilesInstaller` 后，bge embed 作为**第一个 hosted-files 组件**接上：档案卡 `kind:'files'`、四个散文件、`urls` 填现有 HF 地址（留镜像位）。**下载/校验/降级行为与迁移前逐字节一致**——这是「通用引擎立没立住」的试金石。embed 本就在运行时下载，迁移是纯重构、**对用户零新增行为**，因此是框架 v1 的安全验证，不引入新风险。

---

## 候选搬迁清单（框架就位后，按情况逐个挑）

每次搬迁 = 「填一张组件档案卡 → 从 `extraResources` 移出 → 改消费方的目录解析 → 真打一次包核实体积」。以下按推荐顺序，含每个候选的关键信息，供用户逐个决策。

### 候选 #1 — python-runtime（推荐首选，~60–80MB）

**为什么首选**：功能纯可选（**全仓已核实唯一消费方 = ppt-master 做 PPT**，`resolveBundledPythonHome`/`PPT_MASTER_PYTHON_HOME` 之外无引用）、体积实打实、公网现成不用自托管、且**缺失兜底已存在**（`engine.ts:1749-1750`/`:1780`：内置 python 为 null 时 ppt-master 回落系统 python，不崩）。

**做法**：
- 档案卡：`strategy:'hosted-files'`、`kind:'archive'`、`format:'tar.gz'`、`stripComponents:1`、mac `chmodExec:['bin/python3']`、`readyCheck:'bin/python3'`（win 为 `python.exe`）；`archive.urls` 指向 CI 同款 astral 公网 Release，`sha256` pin 整包。
- 落点：用户可写目录（如 `userData/python-runtime/<platform>/`）。
- 消费方改：`resolveBundledPythonHome()`（`cliDetect.ts:189`）解析顺序**新增该 userData 路径**（排在 `resourcesPath/python-runtime` 之前或取代）；dev 分支保留。
- 触发：ppt-master 被调用 / 发起做 PPT 时，`isInstalled('python-runtime')` 为假 → 弹窗引导；[暂不]/下载中 → 现有「null → 回落系统 python」兜底继续。
- 打包收尾：`package.json` mac/win `extraResources` **移除 python-runtime 项**；CI build.yml「Bundle Python runtime」步退役或改「可选离线预置」。**这一步才让安装包真瘦 60–80MB。**
- 平台：mac/win 各自 tarball 与 dist 串；linux 现无该 extraResources，维持。

### 候选 #2 — node-runtime（~60–110MB，靠后）

**难点**：daemon（画布/方案）**近核心、启动早期就要**，「用到才下」的时机不好卡——不像 python 那样能等到「用户点做 PPT」。需**额外设计**「首次用画布/方案时的阻塞式下载 + 等待体验」，否则会出现「启动后画布不可用、静默等下载」。下载源 nodejs.org 公网现成、不用自托管；ABI 必须仍钉 137（Node 24，daemon 的 better-sqlite3 依赖，见 build.yml 断言）。收益大、体验设计复杂度也大。

### 候选 #3 — onnxruntime-node（最大但最难，最后）

**难点**：原生模块、被 `@huggingface/transformers` 按固定路径 require，且语义检索近核心。搬出去要解决「原生 .node 二进制不在 asar 固定位置时如何 require」——比下文件包难一个量级，风险最高。**先评估** electron-builder 是否已把 216MB 多平台目录裁到单平台（可能没那么大），再论值不值得动。

---

## 后续待补（框架能力 backlog，非 v1，结构上留插口）

- **国内镜像 / CDN**：`DownloadUnit.urls` 多镜像结构 v1 已就位但只填默认源；后续填 `hf-mirror.com`、runtime 的国内镜像等，下载器代码零改动。**触发信号**：出现国内用户首次下载大面积失败。
- **断点续传**：v1 断了从头下（~100MB 可接受）；若将来搬 node/onnx 这类更大件、或用户网络差反馈多，再加 Range 续传。
- **后台自动下载偏好**：v1 一律「用到才弹、用户点了才下」；后续可加设置项「WiFi 下自动预下载已启用功能的组件」，避免用户等待。
- **组件更新 / 版本漂移**：v1 组件版本钉死在档案卡；若某组件（如模型）出新版，需设计「检测到 pin 变更 → 提示重新下载」的更新流（现有 fingerprint/stale 机制可借鉴）。
- **磁盘占用管理**：多个大组件下载后，userData 可能涨到数百 MB；后续可加「组件中心显示各组件占用 + 一键删除释放」。
- **候选清单本身的维护**：每完成一次搬迁，把对应候选从「候选」标为「已搬迁」；新识别的可搬项追加进「体重地图」表。

---

## 数据流

```
用户触发功能（做 PPT / 语义检索 / 文档导入）
  → 功能门 isInstalled(componentId)   本地磁盘、不联网
      已装 → 直接用
      未装 → 非阻断弹窗[现在下载][暂不]
              [暂不] → 功能优雅降级（BM25 / 系统 python / soffice 兜底）
              [现在下载] → installer.install(descriptor, onProgress, signal)
                  ├ HostedFilesInstaller：多镜像依次试 → sha256 →(archive)解压 strip chmod → readyCheck
                  ├ PipxInstaller：pipx→pip --user
                  └ DetectOnlyInstaller：打开引导
                  进度 → main 状态表某格更新 → 整表推前台 → 弹窗进度条 + 组件中心行同步
                  成功 → 明确成功反馈（说清变化）+ 收尾（隔离 try）；走开则 toast；行翻 ✓
                  失败/取消 → 清半截、状态 error/idle、功能降级兜底
```

---

## 验收标准

### A. 框架验收（v1 必达）

- `kbModelDownloader.ts` 抽为 `HostedFilesInstaller`；embed 迁移后下载/校验/降级**逐字节等价**（纯重构零回归）。
- `HostedFilesInstaller` 支持 `kind:'files'` 与 `kind:'archive'`（解压/strip/chmod/整包校验）两形态——**archive 形态即便 v1 无生产消费方也要实现并单测**，为候选搬迁铺路。
- 每 `DownloadUnit.urls` 多镜像依次试；v1 只填默认源但结构就位。
- 状态从单模型泛化为「每组件一格」的表；前台整块镜像；IPC 四处同改无类型漏。
- 组件中心列出组件（含未搬迁的灰显「随包」项）；渐进式弹窗（[现在下载]→进度条→[查看下载详情]，就地下）；成功有明确反馈 + 走开 toast + 行翻 ✓，措辞对后台收尾诚实。
- markitdown（pipx）/soffice（detect-only）收编进中心，各走策略。
- `bun run typecheck` 绿；新增纯逻辑（多镜像选址、archive 解压判据、状态表 reducer）有 bun test；现有 BM25 测试零回归。

### B. 单次搬迁验收模板（每挑一个候选搬出时套用）

- 该组件从 `extraResources`（或原打包位）移除 → 真实产物对应目录消失，安装包实测减小≈其体积（**必须真打一次包核实前后**）。
- 全新安装（无内置件）→ 触发对应功能 → 弹窗引导下载 → 落用户可写目录 → 功能用上下载件。
- 未下载 / 下载失败 / [暂不] → 走该功能既有降级兜底，**不崩不空**。
- 整包/逐文件 sha256 校验通过；半截不被当成功。
- 消费方目录解析新增 userData 路径且 dev 分支保留。

---

## 实施顺序建议

1. **抽骨架 + embed 迁移**（框架核心，零新增行为验证）——`ComponentDescriptor`/`COMPONENT_REGISTRY`/`ComponentInstaller`/状态表/IPC 泛化；`HostedFilesInstaller` 含 files+archive 两形态（archive 先实现 + 单测，即便暂无消费方）；embed 接上，确认「照旧能下」。
2. **组件中心 UI + 渐进式弹窗 + 成功反馈/toast**——升级现有设置页入口；接功能门触发；未搬迁项灰显「随包」。
3. **收编 markitdown / soffice**（pipx / detect-only 策略）——大多是包一层现有逻辑。
4. **（框架完成，进入搬迁菜单）** 用户从「候选搬迁清单」挑第一个（推荐 python-runtime）：填档案卡 + 改消费方解析 + 移出 extraResources + CI 步退役 + **真打一次包核实体积**。后续候选按同一模板逐个搬。

> 注：1–3 是框架本体，交付后安装包体积**尚未变化**（框架不缩体积）；真正的瘦身从步骤 4 起、由用户按候选清单逐个触发。这正是「先能力、后搬迁」的落地形态。

---

## 与其它工作的关系

- **取代 retrieval-quality spec 的 P1 打包段落**：那份 P1 说 reranker 走 `prebundle`/`extraResources` 打包——该链已退役（dcb3e1f9）。reranker 将来只需在 `COMPONENT_REGISTRY` 加一张 `hosted-files`/`kind:'files'` 档案卡即可下载（相当于「候选搬迁清单」里的一个新增组件，而非从包里搬出）。本 spec 落地后回改 retrieval-quality spec P1「打包」小节指向此处。
- **通用化 `2026-07-15-kb-model-first-run-download-design.md`**：那份是 KB 模型专用首下；本 spec 抽成可复用框架，embed 迁移即其延续。
- **LanceDB**（向量存储升级）已暂缓，与本 spec 无关（memory `kb-lancedb-deferred`）。
