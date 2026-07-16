# 打包体积守卫 + 按需下载组件框架（长期能力）

日期：2026-07-16
状态：设计草案，待用户复核 → writing-plans
根本目的：**长期控制安装包体积**。不追求眼前一次性瘦身（实测短期收益有限，见下），而是建一套**长期机制**：以后任何「能按需下载的地方」都自动提醒开发者、逼其当场决定「随包 vs 按需下载」，并在确需时用统一框架把组件搬出安装包。

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
- **大头 Electron 242MB 搬不走**，是硬地板。按需下载动不了它。
- **能搬的只有 node(115)+python(67)=182MB 落盘 / 压缩后约 74MB**，是理论上限。
- **只搬 python（唯一干净目标）省 ~24MB 压缩 / ~67MB 落盘**，相对整包（压缩估 ~250MB）约 **10%**——**短期性价比偏低**：为省 10% 搭整套下载框架不划算。
- 真正的肉在 node 的 50MB，但 node 近核心、要啃「启动早期阻塞式下载」，最难。
- ⚠️ 压缩后总大小仅估算（runtime 只在 CI 进包，本地打不出真包）；**最准分母 = 去 GitHub Release 看最近 `.dmg` 实际 MB**，待补。

**因此本 spec 的重心从「现在搬几个」转为「长期不失控」**：先建**守卫机制**（便宜、立刻见效、防未来失控），下载框架留到**真要搬某个候选时**再搭。

---

## 设计哲学（守卫为先，框架次之，搬迁最后）

1. **守卫（Phase A，主线，先做）**：一份「打包决策登记表」+ 一个 **CI 硬卡检查**——真实进包的每个大件都必须在登记表里有明确决定（随包/已按需/候选），**冒出未登记的新大件就挂 CI**。这直接实现用户诉求「以后能按需下载的地方都提醒开发者、让他决定」，且不依赖任何人记性。**便宜、独立、立即交付长期价值。**
2. **能力（Phase B，按需搭）**：当开发者对某个候选点头「要搬」时，才搭/复用通用「按需下载组件框架」（组件中心 + 状态/IPC + 三策略 + 触发降级），用 embed 迁移做零风险验证。
3. **搬迁（Phase C，逐个挑）**：框架就位后，从候选清单逐个搬（python 首选），每次 = 填档案卡 + 移出打包 + 真打一次包核实体积。

**为什么守卫先于框架**：守卫是「不失控」的保险，成本低、马上生效、且它正是持续暴露「该不该搬」决策的入口；框架是「真要搬时」的重活，短期 ROI 低，不必抢先。二者解耦，各自独立推进。

---

## Phase A — 打包体积守卫（本 spec 主交付物）

### A1. 打包决策登记表（单一事实源，签进库）

一份机器可读的登记（`apps/studio/scripts/bundle-decisions.json` 或 `.ts`），每个大件一条：

```jsonc
{
  "budgetWarnBytes": 10485760,           // 阈值：进包 >10MB 的组件必须登记
  "components": [
    { "id": "electron", "measuredBytes": 253755392, "decision": "bundle",
      "reason": "Chromium 框架地板，不可搬", "reviewed": "2026-07-16" },
    { "id": "node-runtime", "measuredBytes": 120586240, "decision": "candidate",
      "reason": "能搬但 daemon 近核心/启动早期需要，待评估", "reviewed": "2026-07-16" },
    { "id": "python-runtime", "measuredBytes": 70254592, "decision": "candidate",
      "reason": "只 ppt-master 用，纯可选，推荐首搬", "reviewed": "2026-07-16" },
    { "id": "onnxruntime-node", "measuredBytes": 36700160, "decision": "bundle",
      "reason": "已剔平台，近核心+原生模块，不值当", "reviewed": "2026-07-16" }
    // @img/sharp、daemon、fusion-cli … 同理
  ]
}
```

`decision` 三态：`bundle`（随包，带 reason）/ `on-demand`（已改按需下载）/ `candidate`（能搬、待开发者拍板）。

### A2. CI 硬卡检查（`check-bundle-inventory.mjs`）

在 CI 打包链里跑（runtime 已就位、electron-builder 前后皆可），扫真实进包内容与登记表对：

1. **枚举真实进包大件**：解析 `package.json` 的 `build.extraResources` + `asarUnpack` 目标 + `build.files`，逐个在盘上量真实体积（node-runtime/、python-runtime/、onnxruntime-node 当前平台、@img、prebundled、fusion-bin、Electron dist）。
2. **逐个比对登记表**：
   - **进包大件（>阈值）未登记** → **CI 失败（硬卡）**：`未登记的大件 X = YMB。请决定 bundle / on-demand 并记入 bundle-decisions.json`。**不记不放行。**
   - 登记为 `candidate` → **提示**（不挂）：`X 仍是待搬候选（YMB），可迁移或复核为 bundle`。
   - 登记为 `bundle`/`on-demand`、体积吻合 → 放行。
   - **体积较登记显著变化**（如 ±20%）→ **CI 失败**：`X 体积从 A→B MB，请复核决定并更新 measuredBytes/reviewed`。
3.（可选）**总预算**：记录进包大件总和，超设定总预算时 WARN，便于长期盯趋势。

> 硬卡即「装作没看见」不成立：任何新大件、或已有大件长胖，都必须开发者主动去登记表做一次显式决定，CI 才过。这就是用户要的「自动提醒 + 逼其决定 + 留记录」。

### A3. 开发者引导（降低摩擦）

- CLAUDE.md 加一句：**改 `extraResources`/`asarUnpack`/引入大依赖时，同步更新 `bundle-decisions.json`**（否则 CI 挂）。
- 检查失败信息里直接给出「怎么登记」的示例行，开发者照抄改一行即可。

**Phase A 完成后：安装包体积尚未变化，但「未来失控」被自动挡住，且每个可搬点都会持续浮出水面等你决定。这就是长期价值的兑现。**

---

## Phase B — 按需下载组件框架（真要搬时才搭）

> 以下为框架设计，Phase C 首次搬迁时落地；Phase A 不依赖它。

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
> ⚠️ **热路径无弹窗时机**：`engine.ts:1308` 写正文自动召回是后台热路径，缺组件时没有自然弹窗点。embed 已在包外无碍；将来 reranker 走此路时「何时提示下载」需专门设计（Phase C 处理，非本框架）。

### 五、优雅降级（增强层永不拖累基础层）

断网/所有镜像失败→清半截、标 error、功能降级（BM25 / 系统 python / soffice 兜底）；下一半→只留 `.part`；校验不符→删掉重试；取消→回未装态、不当错误；下成功但收尾翻车→**下载仍算成功**、收尾隔离 try。任何失败**不让功能比「没组件」更糟**。

### 六、embed 迁移（框架零风险验证）

`kbModelDownloader.ts` 抽成 `HostedFilesInstaller` 后，bge embed 作首个 `kind:'files'` 组件接上，`urls` 填现有 HF 地址（留镜像位）。**行为与迁移前逐字节一致**——embed 本就运行时下载，迁移纯重构、对用户零新增行为，是框架安全验证。

---

## Phase C — 候选搬迁清单（框架就位后逐个挑）

每次 = 填档案卡 + 移出 `extraResources` + 改消费方目录解析 + **真打一次包核实体积**。按推荐序：

### 候选 #1 — python-runtime（推荐首搬，~67MB 落盘 / ~24MB 压缩）
- **为何首选**：全仓已核实唯一消费方 = ppt-master（`resolveBundledPythonHome`/`PPT_MASTER_PYTHON_HOME` 之外无引用）；纯可选；公网现成（astral Release，CI 已用）；**缺失兜底已存在**（`engine.ts:1749-1750`/`:1780` 回落系统 python）。
- **做法**：档案卡 `kind:'archive'`、`format:'tar.gz'`、`stripComponents:1`、mac `chmodExec:['bin/python3']`、`readyCheck:'bin/python3'`（win `python.exe`）、`archive.urls` 指 astral 公网、整包 sha256 pin；落 `userData/python-runtime/<platform>/`；`resolveBundledPythonHome()`（`cliDetect.ts:189`）解析新增该路径；触发=发起做 PPT 时缺则弹窗，[暂不]/下载中走系统 python 兜底；`package.json:97-98/130-131` extraResources 移除 python 项 + CI「Bundle Python runtime」步退役 + `bundle-decisions.json` 改 `on-demand`。

### 候选 #2 — node-runtime（~115MB 落盘 / ~50MB 压缩，靠后）
最大可搬项但 daemon 近核心、**启动早期即需**，需专门设计「首次用画布/方案时阻塞式下载 + 等待体验」；ABI 须仍钉 137（Node 24，build.yml 断言）；源 nodejs.org 公网。收益大、体验设计复杂度大。

### 候选 #3 — onnxruntime-node（~35MB，最后/大概率不搬）
已剔平台、近核心、原生模块（固定路径 require），搬出风险最高、收益已被平台裁剪吃掉大半。登记为 `bundle`，除非未来评估翻案。

---

## 后续待补（框架能力 backlog，非当期，留插口）

- **国内镜像 / CDN**：`DownloadUnit.urls` 多镜像结构就位，后续填 `hf-mirror.com` 等，下载器零改动。**触发信号**：国内用户首下大面积失败。（实测慢网下 40MB 二进制下 6–7 分钟——搬 python/node 时慢网体验是硬约束。）
- **断点续传**：v1 断了从头下；搬 node（115MB）或慢网反馈多时再加 Range 续传。
- **后台自动下载偏好**：设置项「WiFi 下自动预下载已启用功能的组件」。
- **组件更新 / 版本漂移**：档案卡版本钉死；组件出新版时的「检测 pin 变更→提示重下」流（借现有 fingerprint/stale）。
- **磁盘占用管理**：组件中心显示各组件占用 + 一键删除释放。
- **登记表维护**：每完成一次搬迁把候选标 `on-demand`；新识别可搬项追加进登记表与体重地图。

---

## 验收标准

### A. 守卫验收（Phase A，先达 —— 本 spec 核心交付）
- `bundle-decisions.json` 落地，含步骤 0 实测的全部进包大件与显式决定。
- `check-bundle-inventory.mjs` 接入 CI 打包链：**未登记大件 / 体积显著变化 → CI 硬失败**；`candidate` → 提示不挂；吻合 → 放行。
- CLAUDE.md 记「改 extraResources/asarUnpack/加大依赖须更新登记表」；失败信息含照抄示例。
- 人为加一个未登记的 >阈值项 → CI 如期失败（负例验证）。

### B. 框架验收（Phase B，首次搬迁时）
- `kbModelDownloader.ts` 抽为 `HostedFilesInstaller`；embed 迁移后行为逐字节等价（零回归）。
- 支持 `kind:'files'` 与 `kind:'archive'`（解压/strip/chmod/整包校验），archive 有单测。
- `DownloadUnit.urls` 多镜像依次试；状态泛化为每组件一格、前台整块镜像；IPC 四处无类型漏。
- 组件中心（未搬迁项灰显「随包」）+ 渐进弹窗 + 成功反馈/toast，措辞对后台收尾诚实。
- markitdown/soffice 收编各走策略。`bun run typecheck` 绿；纯逻辑有 bun test；BM25 测试零回归。

### C. 单次搬迁验收模板（每挑一个候选）
- 从 extraResources 移除 → 真实产物对应目录消失，**真打一次包核实前后体积差≈其体积**。
- 全新安装→触发功能→弹窗引导→落 userData→功能用上；未下/失败/[暂不]→既有降级兜底不崩。
- sha256 校验通过、半截不当成功；消费方目录解析新增 userData 路径且 dev 分支保留；`bundle-decisions.json` 更新为 `on-demand`。

---

## 实施顺序建议

1. **Phase A 守卫**（先做，交付长期价值，安装包体积此时不变）：`bundle-decisions.json`（填步骤 0 实测）→ `check-bundle-inventory.mjs` → 接 CI 硬卡 → CLAUDE.md 引导 → 负例验证。
2.（待某候选获批）**Phase B 框架**：抽 `HostedFilesInstaller`（含 files+archive）→ 状态/IPC 泛化 → embed 迁移验证 → 组件中心 UI + 弹窗 → 收编 markitdown/soffice。
3. **Phase C 逐个搬**：从候选清单挑（推荐 python 首搬），套「单次搬迁验收模板」，每次真打包核实体积、更新登记表。

> 短期不追求瘦身（实测省 10% 不划算）；价值在长期——守卫防未来失控 + 持续暴露可搬点，框架在真要搬时才投入。

---

## 与其它工作的关系
- **取代 retrieval-quality spec 的 P1 打包段落**：reranker 将来在 `COMPONENT_REGISTRY` 加一张 `hosted-files` 卡即可（该 prebundle/extraResources 链已退役 dcb3e1f9）。
- **通用化 `2026-07-15-kb-model-first-run-download-design.md`**：embed 迁移即其延续。
- **LanceDB** 已暂缓，无关（memory `kb-lancedb-deferred`）。
