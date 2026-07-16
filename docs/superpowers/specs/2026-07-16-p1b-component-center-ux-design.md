# 按需下载组件框架 P1b — 通用状态/IPC + 组件中心 + 渐进弹窗 + 收编 markitdown/soffice

日期：2026-07-16
状态：设计草案（用户已口头批准 4 项关键决策 + 六节设计）→ 待用户复核 spec → writing-plans
分支：feat/kb-markitdown-one-click-install（继续，不新开）

## 关系与前序

- **总设计（伞）**：`2026-07-16-on-demand-component-download-design.md` —— 本 spec 落地其 **Phase 1** 的「四、七节 + 收编」部分。根本目的仍是**长期控制安装包体积**，本期只搭框架能力，交付后安装包体积不变。
- **P1a（已完成 + 终审 Ready to merge + 实机验证通过）**：`2026-07-16-on-demand-download-engine-p1.md`。后端引擎已就绪，本 spec 直接复用、不重写这些既有件：
  - `electron/shared/componentDownload.ts` —— `ComponentDescriptor` / `DownloadUnit` / `HostedFilesInstall(kind:'files')` / `HostedArchiveInstall(kind:'archive')` + `descriptorTotalBytes()`。
  - `electron/main/services/componentInstaller/downloadUnit.ts` —— 多镜像 `downloadWithMirrors` + `downloadOneUrl` + `resolveRedirectLocation`。
  - `electron/main/core/componentRegistry.ts` —— `COMPONENT_REGISTRY`（目前只有 embed 一张卡）+ `getComponentDescriptor`。
  - `electron/main/services/componentInstaller/hostedFilesInstaller.ts` —— `isComponentInstalled` / `installComponent`。
  - `electron/main/services/kbModelDownloader.ts` —— 已退化为薄壳、委托上面的引擎。
- **P1a 留给 P1b 的技术备忘**（必须遵守）：
  - 镜像回退只覆盖「传输失败」、不覆盖「sha 校验失败」。P1a 单 url 无影响；本期若给某组件真填多镜像且要「坏镜像自动换好镜像」，须把 sha 校验挪进 `downloadWithMirrors` 单次尝试内。
  - `installComponent` 只下「当前组件」、非循环整份清单。加第二个组件时按 registry 逐组件调用，勿回退循环。
  - `installComponent` 的进度分母可复用 `descriptorTotalBytes()`。
  - `engine.ts:1308` 写正文自动召回是后台热路径、无自然弹窗时机——将来 reranker 走这条路时「何时提示下载」需专门设计，**本期不接 reranker、不碰此路**。

## 本期范围（P1b）

做五件事，全在前端 + 收编两个已有安装动作，后端引擎不重写：

1. **通用状态 + IPC 泛化**：单模型状态 → 每组件一格的状态表；`KB_MODEL_DOWNLOAD_*`（4 通道）与 `KB_TOOLING_*`（2 通道）→ 一套 id 键控的通用组件通道。
2. **组件中心 UI**：设置页**新增独立分类**「组件 / 扩展」，一行一组件、状态 → 按钮。
3. **渐进式弹窗**：可复用的非阻断提示，初始 `[现在下载][暂不]` → 就地下变进度条 → 冒出 `[查看下载详情]` → 成功话术 + 淡出。
4. **功能门触发**：本期只接一个示范触发点——导入文档缺 markitdown；embed 现有「缺模型」引导升级为打开弹窗/组件中心。
5. **收编 markitdown（pipx）+ soffice（detect-only）** 为另两种安装策略，进同一状态表 + 同一组件中心。

### 明确不做（YAGNI / 留后续）

- reranker 组件、python-runtime 等真实搬迁（属伞 spec 的 Phase 2）。
- `engine.ts:1308` 热路径自动召回的下载提示。
- 国内镜像/CDN 实填、断点续传、后台自动预下载、组件更新版本漂移、磁盘占用管理（伞 spec 待办②，留插口不实现）。
- 打包体积守卫 `bundle-decisions.json` + CI 硬卡（伞 spec 待办①，框架之后）。

---

## 已定的 4 项关键决策（用户拍板）

| 决策 | 选择 |
|---|---|
| 组件中心位置 | **新建独立设置分类「组件/扩展」**（不塞进「知识库」分类；python 等非 KB 组件长期归此，贴合伞 spec「组件/扩展板块」措辞） |
| 状态统一程度 | **三策略统一成同一款状态标签 + 一套通道**，退役 markitdown/soffice 旧专用通道 `KB_TOOLING_*` |
| 弹窗触发点 | **做好可复用弹窗，本期只接一个示范触发点**（导入文档缺 markitdown；embed 缺模型引导升级） |
| 成功 toast | **顺手建一个最小全局 toast**（角落浮条，复用 ProposalDocPanel 浮层视觉） |

---

## 一、后端：统一的「组件状态表」+ id 键控通道

### 统一状态标签（五态）

把现在只管单个模型的 `KbModelDownloadState`（phase: idle/downloading/ready/error + installed）泛化为「每组件一格」的通用状态。三种装法的组件都报同一款标签：

```ts
// electron/shared/componentDownload.ts（在 P1a 既有文件里追加，与档案卡类型同处）
export type ComponentStatus =
  | 'idle'          // 没装、但可装（hosted-files / pipx）
  | 'installing'    // 正在装；percent 有值=可测量进度（hosted-files），null=不定长（pipx 转圈）
  | 'ready'         // 装好了 / 本就存在（detect-only 探到也是此态）
  | 'error'         // 失败，errorMessage 有值
  | 'unavailable'   // 装不了、需用户手动（detect-only 没探到；或 pipx 连 python 都没有）

export interface ComponentState {
  id: string
  status: ComponentStatus
  percent: number | null      // 仅 installing 且可测量时有值，否则 null
  currentFile: string | null  // 下载型当前文件（供 UI 文本），否则 null
  errorMessage: string | null
}

export type ComponentTable = Record<string, ComponentState>  // 整表；main 单一事实源，前台整块镜像
```

**范式对齐 P1a 现有 `kbModelDownload.ts`**：main 持单例整表、invoke 拉快照 + 主动推全量、renderer 整体替换不拼装。`KbModelDownloadState` 与 `kbModelDownload.ts` 文件退役（被 `ComponentTable` 取代）。

**状态映射（旧 → 新）**：embed 的 `phase:'downloading'`+`percent` → `status:'installing'`+`percent`；`phase:'ready'`/`installed:true` → `status:'ready'`；`phase:'error'` → `status:'error'`；`phase:'idle'` 未装 → `status:'idle'`。

### id 键控的通用通道（退役旧 6 通道）

退役：`KB_MODEL_DOWNLOAD_STATUS_GET/START/CANCEL/STATUS`（4 条）与 `KB_TOOLING_CHECK/INSTALL_TOOLING`（2 条）。新增通用四通道（照 KB_MODEL_DOWNLOAD 范式，参数带组件 id）：

| 通道 | 语义 |
|---|---|
| `COMPONENT_STATUS_GET` | 拉整张 `ComponentTable` 快照 |
| `COMPONENT_INSTALL_START(id)` | 装某组件；触发即返回，进度走广播 |
| `COMPONENT_INSTALL_CANCEL(id)` | 取消（仅 hosted-files 真能取消；pipx 无取消、detect-only 无此动作） |
| `COMPONENT_STATUS`（广播） | 任一格变 → 整表推前台 |

**IPC 四处同改铁律**（漏一处 typecheck 报错）：`electron/shared/ipc-channels.ts`（通道常量 + ChatApi 接口签名）→ `electron/preload/index.ts`（暴露方法）→ `electron/preload/index.d.ts`（类型，若该文件承载）→ main handler（`electron/main/ipc/register.ts`）。广播在 `electron/main/tabRegistry.ts`（新增 `broadcastComponentStatus`，取代 `broadcastKbModelDownload`）；订阅接线在 `electron/main/index.ts`（取代 `onKbModelDownload`）。

### 安装调度器（一个 orchestrator，按策略分派）

新增一个「组件安装编排」模块（`electron/main/services/componentInstaller/` 内），持 `ComponentTable` 单例 + 广播回调 + 每组件的 AbortController，对外暴露与旧 `kbModelDownloader` 等价的 API 面（`getComponentTable` / `startComponentInstall(id)` / `cancelComponentInstall(id)` / `refreshComponentInstalled` / `onComponentStatus`）。`startComponentInstall(id)` 按档案卡 `strategy` 分派：

- **hosted-files**：调 P1a 既有 `installComponent(descriptor, root, signal, onProgress)`。进度回调 → `status:'installing'` + percent。成功后的 embed 专属收尾（`resetEmbedWorker`/`warmEmbedWorker`/`scheduleKbBuild`）**保留在独立内层 try**（承接 b5636bb3：收尾失败不把已成功下载翻成 error）。收尾副作用**不泄进通用编排器**——按组件 id 挂一张「成功收尾钩子」小表（仅 embed 有）。
- **pipx**：调现有 `installMarkitdown()`（`electron/main/core/kbTooling.ts`，pipx 优先、退 pip --user、连 python 都没有 → `unsupported`）。装前/装中 → `status:'installing'`（`percent:null`，UI 转圈，**无取消**——与现状一致）；`installMarkitdown` 返回 `{ok:true}` → `ready`；`{unsupported:true}` → `unavailable`；`{ok:false}` → `error`（带 log 摘要）。`installMarkitdown` 逻辑本身**一字不改**，只被编排器包一层。
- **detect-only**：无「装」动作。`refreshComponentInstalled` / `COMPONENT_STATUS_GET` 时用现有 `detectTooling()` 的 soffice 探测：探到 → `ready`，没探到 → `unavailable`（UI 出「如何安装」引导）。`COMPONENT_INSTALL_START('soffice')` 无意义（UI 不给该按钮）。

**结果**：不管从哪触发装 markitdown（组件中心 / 知识库管理页那张卡 / 导入弹窗），都汇进 `startComponentInstall('markitdown')` 同一条路。

---

## 二、组件档案卡：补两种新策略

P1a 已留口子（`ComponentDescriptor.strategy` 目前只 `'hosted-files'`；shared 文件注释已写明 pipx/detect-only 在 P1b 加）。本期往联合类型加：

```ts
// electron/shared/componentDownload.ts 追加
export interface PipxInstall {
  kind: 'pipx'
  pkg: string        // 'markitdown'
  probeCmd: string   // 探测「装没装好」的命令名，如 'markitdown'
}
export interface DetectOnlyInstall {
  kind: 'detect-only'
  probeCmd: string   // 'soffice'
  guideUrl?: string  // 「如何安装」引导链接（可选）
}
export type ComponentInstallSpec = HostedFilesInstall | HostedArchiveInstall | PipxInstall | DetectOnlyInstall
// ComponentDescriptor.strategy: 'hosted-files' | 'pipx' | 'detect-only'
// ComponentDescriptor.install: ComponentInstallSpec
```

`COMPONENT_REGISTRY` 从 1 张卡（embed）变 3 张：
- `kb-embed`（既有，`hosted-files`，不动）
- `markitdown`（`pipx`，`pkg:'markitdown'`，`probeCmd:'markitdown'`）
- `soffice`（`detect-only`，`probeCmd:'soffice'`，`guideUrl` 指向 LibreOffice 下载页）

`title`/`description` 用人话（如 markitdown：「文档转换工具，导入 Office/PDF 文档到知识库时用；缺失时降级纯文本」）。**加组件 = 加一张卡**，这就是框架的意义。

---

## 三、组件中心 UI（新设置分类「组件/扩展」）

`src/chat/components/settings/SettingsView.tsx` 的 `categories` 数组新增一个分类（id 如 `components`，label `catComponents`，排在 `knowledgeBase` 附近），内容组件 `ComponentsSection.tsx`（chat 侧，shadcn/Tailwind）。一行一组件（读 `ComponentTable` + 从 `COMPONENT_REGISTRY` 取标题/描述/体积），右侧按钮随状态：

| 状态 | 右侧 |
|---|---|
| `idle` | `[下载]`（hosted-files）/ `[安装]`（pipx） |
| `installing`（percent 有值） | 进度条 + % + `[取消]` |
| `installing`（percent=null） | 转圈 + 「正在安装…」（无取消） |
| `ready` | ✓ 已就绪 |
| `error` | 原因 + `[重试]` |
| `unavailable` | 说明 + `[如何安装]`（soffice；或 markitdown 缺 python 的引导） |
| 随包未搬迁 | 灰显标「随包」（本期无此项，给将来 python 留呈现位） |

**embed 行从「知识库」分类搬到这里**：`KnowledgeBaseSection.tsx` 里现有的 `kbModelTitle` 模型下载 Section（该文件 146-183 行那块）**移除**，改由 `ComponentsSection` 承载。「知识库」分类**留一句指路**（如「语义检索模型已移至『组件/扩展』」+ 可点跳转），避免老用户找不到。

i18n：新 label / 状态文案中英对齐（本仓有 i18n，`useT`）。

---

## 四、渐进式弹窗（可复用 + 只接一个示范触发点）

**弹窗本体**：可复用组件（chat 侧，挂 App 根，`createPortal` 到 body 的子树加 `data-slot` 逃逸 canvas reset），由新 store（`src/chat/stores/componentPrompt.ts`，zustand）驱动——`promptComponent(id, {feature})` 打开、订阅 `ComponentTable` 实时反映进度。渐进四阶段：

1. **初始**：一句话说明「用『导入文档』需要 X，要现在下载吗？」+ `[现在下载]` `[暂不]`。
2. **点「现在下载」** → 调 `startComponentInstall(id)`，弹窗**就地**变进度条（读组件表 percent，pipx 转圈），冒出 `[查看下载详情]`（点开跳组件中心分类）。
3. **成功** → 变一句「说清变了什么」的成功话，**措辞对后台收尾诚实**（如「模型已就绪，正在后台重建索引，稍后语义检索自动生效」）→ 淡出。
4. **`[暂不]` / 失败** → 关掉；功能照旧**静默降级**（现状：import 走 markitdown→丢图重试→soffice→纯失败三级降级；embed 缺失走 BM25），不拦路。

**本期唯一真实触发点（示范）**：用户在知识库管理页触发**导入/迁移/同步文档**（`kbMigrateFromFolder` / `kbSyncFromLocal` / `kbRetryDoc` 上游）、而 markitdown 未 `ready` 时 → `promptComponent('markitdown', {feature:'import'})`。理由：导入是用户一个明确动作，有天然弹窗时机。

**embed 触发升级**：知识库工具栏（`KbToolbar.tsx`）现有的「缺模型」引导，按钮从死链升级为 `promptComponent('kb-embed')` / 打开组件中心。

**现有 markitdown 卡片的处置**：知识库管理页 `KbToolbar.tsx:109` 的 `KbToolingCard`（`tooling.markitdown===false` 时常驻的「一键安装」卡片）改为读新 `ComponentTable`（其安装按钮走 `startComponentInstall('markitdown')`）；或在导入弹窗覆盖后退役——实施计划权衡，优先**改读新表**保证不丢现有能力、零回归。

**不接**：`engine.ts:1308` 热路径自动召回（spec 已注明无弹窗时机）。

---

## 五、最小全局 toast

全仓现无 toast（已核实：无 sonner/Toaster/toast 调用，多处注明「没有 toast 槽位」）。新建最小一套：

- `src/chat/stores/toast.ts`（zustand）：`toast(message, tone)`（tone: ok/err/info），入队 + 自动约 4s 出队。
- `<Toaster>` 挂 App 根，角落浮条，视觉复用 `ProposalDocPanel.tsx` 的浮层模式（`proposal-anim-pop`、tone 三色），shadcn 风格，`data-slot` 逃逸 canvas reset。

**服务场景**：下载中用户离开弹窗上下文 → 装好时角落 toast 报喜 + 组件中心该行翻 ✓ 做持久记录。以后导出/同步成功等别处可复用。

---

## 六、架构与单元边界

- **通用编排器**（main）：唯一状态写手 + 按策略分派 + 广播。对外 API 面稳定，UI/IPC 只认这层。
- **策略实现**：hosted-files（P1a `installComponent`）/ pipx（`installMarkitdown` 包一层）/ detect-only（`detectTooling` soffice）——各自独立、可单独理解替换。
- **收尾副作用隔离**：embed 的重热/重建挂「成功收尾钩子」小表，不泄进通用编排器（保持通用引擎干净）。
- **前端三件**：组件中心 Section（读表渲染）/ 渐进弹窗（store 驱动、订阅表）/ toast（独立小 store）——互不耦合，各有清晰 store 边界。
- **纯逻辑可测**：状态映射（旧 phase→新 status）、`installMarkitdown` 结果 → `ComponentStatus` 的翻译、按 id 更新整表的 reducer——这些纯函数写 bun:test。

---

## 验收标准

### 功能
- 设置页新增「组件/扩展」分类，列出 embed / markitdown / soffice 三行，状态→按钮映射如第三节表；embed 行从「知识库」搬来、知识库留指路。
- embed 下载行为**逐字节等价于 P1a 迁移后**（走通用表/通道后无回归）：进度、取消、断网降级、成功收尾一致。
- markitdown 从组件中心 / 导入弹窗 / 知识库卡片任一处触发，都走 `startComponentInstall('markitdown')` → `installMarkitdown()`，状态在表里正确流转（installing 转圈 → ready/unavailable/error）。
- soffice 探到 → ready、没探到 → unavailable + 「如何安装」引导；无「安装」按钮。
- 导入文档缺 markitdown → 渐进弹窗四阶段可走通；`[暂不]`/失败 → 既有静默降级不崩。
- 成功后用户离开 → toast 报喜 + 组件中心翻 ✓。

### 工程
- `KB_MODEL_DOWNLOAD_*` 与 `KB_TOOLING_*` 六通道退役，`COMPONENT_*` 四通道 IPC 四处无类型漏；`kbModelDownload.ts` 状态文件退役。
- `bun run typecheck`（双 tsc）绿；纯逻辑（状态映射/结果翻译/表 reducer）有 bun:test；embed/BM25 既有测试零回归。
- 子代理只 `git add` 任务列出的确切文件、绝不 `-A`；子代理不跑 dev（运行时验证留用户）。

### 运行时（留用户实机）
- embed 下载 happy-path + 取消 + 断网降级；markitdown 真装一次（pipx）；soffice 探测两态；导入弹窗流；toast 显示。

---

## 实施顺序建议（供 writing-plans 参考）

1. **后端泛化**：ComponentState/Table 类型 + 状态映射（纯核测）→ 通用编排器（分派 hosted-files/pipx/detect-only + 收尾钩子表）→ COMPONENT_* 四通道 IPC 四处 + 广播/订阅接线 → 退役旧 6 通道与 `kbModelDownload.ts`。embed 走新路、行为逐字节保持。
2. **档案卡扩策略**：联合类型加 pipx/detect-only + registry 加 markitdown/soffice 两卡（纯核测防漂移）。
3. **组件中心 UI**：新分类 + `ComponentsSection`（读表渲染）；embed 行搬迁、知识库留指路。
4. **渐进弹窗 + 触发**：弹窗组件 + store；接导入文档→markitdown 触发；embed 缺模型引导升级；markitdown 卡片改读新表。
5. **最小 toast**：store + Toaster + 接成功场景。

每步以 `bun run typecheck` 绿 + 纯核 bun:test 为门；运行时留用户。
