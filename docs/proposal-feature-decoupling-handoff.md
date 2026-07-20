# 写方案功能解耦重构 · 交接文档（Handoff Spec）

> **给接手 AI 的话**：这份文档是自包含的。你不需要之前的对话历史。读完它，你就能理解用户想做什么、当前进度、以及从哪一步继续。用户是**编程新手**，请用大白话跟他交流、帮他做技术决策、别把选择题都甩给他。**动代码前先读项目根目录的 `CLAUDE.md`**（有大量工程铁律和历史踩坑，违反会引入回归）。

---

## 0. 一句话概括

把桌面应用里的「写方案（proposal）」功能，从「聊天（chat）」里**解耦**出来，做成一个自成一体、可独立维护的**功能切片（vertical slice）**，让用户以后加/删/改功能时只需动对应的一块，互不牵连。

**当前进度**：方向与决策已敲定；已创建重构分支 `refactor/proposal-feature-slice`；**代码尚未改动一行**。从第 6 节的第①步开始执行即可。

---

## 1. 项目背景（建立地基）

- **是什么**：Electron 桌面应用，封装 `@anthropic-ai/claude-agent-sdk`（实际驱动打包进去的 fusion-code CLI）。React 19 + Vite + Tailwind v4 + zustand + assistant-ui。
- **包管理器**：`bun`（不是 npm）。
- **单包形态**：整个应用住在 `apps/studio` 一个包里。
- **进程模型（三个世界，改任何东西前先搞清在哪个进程）**：
  - **前端 UI**（`apps/studio/src/` + `apps/studio/app/`，浏览器环境，React）——用户看到的一切。被浏览器沙盒限制，不能碰文件/开进程。
  - **preload**（`apps/studio/electron/preload/`）——前后端唯一 IPC 边界，通过 `window.chatApi` 暴露能力。
  - **后端 main 主进程**（`apps/studio/electron/main/`，Node 环境）——拥有 `ChatEngine`（`core/engine.ts`，~3200 行），spawn fusion-code 子进程，管权限/会话/文件/知识库检索/导出。
  - **shared**（`apps/studio/electron/shared/`）——前后端共用的纯类型/纯逻辑，前端经 `@desktop-shared/*` 别名 type-only 消费。
- **唯一自动化防线**：`bun run typecheck`（全 workspace 双 tsc）。**没有单元测试、没有 ESLint**。→ 每一步改动都必须能被 typecheck 兜住，并辅以手动走查。
- **加一条 IPC 要同时改四处**：`electron/shared/ipc-channels.ts`（通道常量）→ `preload/index.ts`（暴露方法）→ `preload/index.d.ts`（类型）→ main 侧 handler。漏一处 typecheck 报错。

---

## 2. 用户想要什么（目标与理念）

### 目标
让项目**好维护**：改一个东西时，要动的地方少、连带影响小、要读懂的范围窄。

### 核心理念：内核 + 功能插件（竖切竹子）
软件有两个切法，好维护要求两个方向都清晰：
- **横切（技术分层）**：前端 / 后端 / 共享。
- **竖切（功能分块）**：聊天 / 写方案 / 幻灯片。

**理想：每个功能是一根从前端通到后端的完整「竹子」**——它自己的界面、逻辑、后端 handler、共享类型都装在自己那一竖条里，只通过明确接口跟「内核」对接，可以整根抽走。

### 好维护的五条判据（衡量任何决策都用它）
1. **高内聚**：相关零件放一个抽屉 → 找得到。
2. **低耦合**：改 A 不震到 B → 改得动、不怕坏。
3. **依赖单向流**：从「善变」流向「稳定」，绝不双向 → 改内核不怕功能崩。
4. **模块是黑盒**：外面只见几扇门（接口），看不见实现 → 里面随便重写、门不变外面无感。
5. **一个知识只有一个家**（DRY）。

**体温计**：*"把某个功能整个删掉，得动几个文件？"* 动得越少 = 越好维护。

---

## 3. 当前架构现状（诚实体检）

**总评：横切很干净、竖切很糊。** 楼层规整、水电管线好，但楼上房间之间没砌墙——写方案和聊天的家具堆在一起。

| 维度 | 现状 | 评价 |
|---|---|---|
| 横切·技术分层 | 前端/preload/后端三分清晰；shared 收口；依赖分层铁律；已抽 8 个 workspace 包 | ✅ 地基扎实 |
| 竖切·**知识库(KB)后端** | `main/core/kb*.ts` + `kbBuild/` + 独立 worker 进程，自成体系 | ✅ 准独立模块 |
| 竖切·**写方案后端** | 文件已用 `proposal*`/`kb*` 前缀聚在 `main/core/`，彼此内聚；真正耦合只在 `engine.ts` 的 ~300–400 行「编织逻辑」+ `register.ts` 的 handler 注册 | ⚠️ 散在大文件，但可控 |
| 竖切·**写方案前端** | 与聊天**双向焊死**（见下） | ❌ 主要痛点 |

### 前端的具体耦合点（第②步要打断的死结）
- `src/chat/runtime/FusionRuntimeProvider.tsx`（~1992 行，**131 处 proposal 引用**）——聊天流式运行时同时驱动「聊天回复」和「写方案草稿分块 append」，是头号障碍。
- 聊天核心**反向 import 写方案**：`ThreadView.tsx`（靠 `isProposalMode` 决定右栏分屏 + import `ProposalDocPanel`）、`AssistantMessage.tsx`（import `useProposalStore` + 多个 proposal lib）、`Composer.tsx`、`AssistantMarkdown.tsx`。
- **写方案反向读聊天**：`src/chat/stores/proposal.ts` `import { useChatStore }` 读前台 `sessionId` → 双向依赖。
- 样式散落：`src/chat/styles/main.css` 里 ~18 处 proposal 规则，未独立分层。

### 后端的具体耦合点（第②步的硬骨头）
`engine.ts`（~3200 行）中约 300–400 行写方案专属逻辑，**未独立成方法，散布在通用热路径里**：
- imports（约 L67–71）：`buildProposalAppend` / `renderRetrievedBlock` / `buildProposalProductScopes` / `kbSemanticSearch` / `warmEmbedWorker` / `kbOutDir`。
- `SessionRuntime` 字段（约 L289–327）：`spawnedWithProposal` / `proposalMode` / `proposalProducts` / `proposalGroundedKey`。
- `send()` 内（约 L1051–1210）：~160 行，grounding 注入判定 + KB 召回注入本轮消息。
- spawn 内（约 L1622–1932）：`warmEmbedWorker()`、`kb_search` in-process MCP server 构建、systemPrompt.append 注入方案纪律、镜像目录加入 additionalDirectories。
- `isKbMirrorRead()` + canUseTool 放行（约 L2265–2375）：方案模式对 KB 镜像目录的 Read/Grep/Glob 静默放行。
- **注意**：`SESSION_SEND` 的 payload 夹带 `proposalMode`/`proposalProducts`/`proposalRetrieve`（`ipc-channels.ts` 约 L836–867）——写方案挤进通用 send 通道，不是独立通道。

### 反向依赖排查结论
除 `engine.ts`、`ipc/register.ts`、`index.ts`（bootstrap）三个「编织层」外，**没有任何其他功能 import 写方案/KB 模块**（已全量 grep 验证）。canvas 侧对写方案零依赖。→ 解耦面收敛、可控。

---

## 4. 目标架构

### 顶层形状
```
  ┌──────────── features（功能插件，每个是一根竹子）────────────┐
  │   proposal（写方案）    slides（幻灯片）    …更多            │
  │   前端组件 + store + lib + 后端 handler + 自己的 shared 类型  │
  └───────────────────────────┬────────────────────────────────┘
                             │ 只依赖 core 的「插槽/接口」，单向向下
  ┌───────────────────────────┴────────────────────────────────┐
  │  core（内核）：聊天引擎 · 会话 · 权限 · IPC 底座 · 流式运行时  │
  │              —— 稳定、通用、【绝不 import 任何 feature】       │
  └───────────────────────────┬────────────────────────────────┘
                             │
  ┌───────────────────────────┴────────────────────────────────┐
  │  shared / platform：跨进程共享类型 · UI 原语 · design-tokens  │
  └─────────────────────────────────────────────────────────────┘
```
**铁律**：`core` 绝不 import `feature`；`feature` 只通过 `core` 开好的插槽接进来；两者都可依赖底层 `shared`。**任何时候看到 `core` 里 import 了某个 `feature`，就是着火了，立刻掉头。**

### 目录结构（示意方向，非逐文件定稿）
前端 `apps/studio/src/chat/`：
```
core/       ← 聊天内核（现在散在各处的通用件收拢；runtime 只管聊天、对功能开插槽）
features/
  proposal/ ← 写方案整根竹子：components/ stores/ lib/ styles/ index.ts(唯一对外出口)
  slides/   ← 幻灯片（本轮不动，未来同构）
shared/     ← 前端内部通用件（i18n、mermaidRender…）
```
后端 `apps/studio/electron/main/`：
```
core/       ← engine.ts（抽掉写方案触手，改插件式注入）、ipc/register.ts（只挂 core 通道 + 逐个调 feature 注册函数）
features/proposal/  ← ipc.ts(registerProposalIpc)、kb/、export/、index.ts
```

### 内核给功能开哪些「插槽」（第②步的核心设计，每个对应一个真实痛点）
| 插槽（core 提供） | 功能怎么用 | 替换掉的痛点 |
|---|---|---|
| 流式 chunk 钩子 | 功能注册「如何处理流式片段」（草稿 append） | `FusionRuntimeProvider` 131 处 |
| 右栏面板注册 | 功能注册一个分屏右侧面板 | `ThreadView` 的 `isProposalMode` 硬判断 + 直接 import |
| 输入模式注册 | 功能注册一个 `composerMode` | `composerMode.ts` 内建 `'proposal'` |
| 消息附加区注册 | 功能在消息下渲染自定义区块 | `AssistantMessage` 直接 import 审阅组件 |
| 后端 IPC 命名空间 | 功能自带 `registerXxxIpc(engine)` | handler 全挤在 `register.ts` |
| 会话能力注入（后端） | 功能向 engine 注入 system-prompt/检索/放行 | engine 的 300–400 行编织逻辑 |

**后端解耦的关键设计建议**：把 engine 里那 300–400 行编织逻辑抽成一个 **`ProposalRuntimeHook` 接口**，提供如 `augmentSystemPrompt()` / `buildMcpServers()` / `augmentSendMessage()` / `canReadPath()`，让 engine 通过 hook 回调而非直接 import proposal 模块。

### 依赖注入：打断双向死结
- 病：`proposal.ts` 反手 `useChatStore()` 抓 sessionId → 写方案「认识」聊天。
- 药：core 调用功能时把 sessionId **当参数递进来**；功能只收不问来源 → 双向变单向。

---

## 5. 已经拍定的决策（接手模型请直接采用，别再问用户）

| 决策 | 定了什么 | 理由 |
|---|---|---|
| 北极星档位 | 做到**第②步（真解耦）**；第③步（抽独立包）**按需**，不强求 | 自用桌面 App，完全可插拔略过度设计 |
| 本轮功能范围 | **只做 proposal，不碰 slides** | 一次只动一根竹子，风险最低 |
| 样式 | 本轮**先不拆 CSS** | 项目 CSS 无作用域、跨面泄漏是历史大坑，拆样式单独当一小步 |
| 后端归拢深度 | 只做 `register.ts` 拆出 `registerProposalIpc()`；**后端文件不做物理大搬迁** | 后端已高度模块化，物理搬迁收益小、diff 巨大、改一堆 import 路径 |
| 演进方式 | **演进式、小步、可回退**，绝不推倒重来 | 无单测，只有 typecheck 兜底 |
| 分支 | 已建 `refactor/proposal-feature-slice`，代码未动 | 隔离，可一秒还原 |

---

## 6. 迁移路径（三步，演进式）

| 步 | 做什么 | 产出 | 风险 | 怎么验证 |
|---|---|---|---|---|
| **① 归拢** | 前端 proposal 散件收进 `features/proposal/`；后端 `register.ts` 拆出 `registerProposalIpc()`。**只搬家、不改逻辑** | 找得到、边界清 | 极低 | `bun run typecheck` 全绿 + 手动走查功能没变 |
| **② 定接口** | 给 core 开第 4 节的插槽；把 `FusionRuntimeProvider` 131 处逻辑挪进 `proposal/index.ts` 注册；用 `ProposalRuntimeHook` 把 engine 300–400 行编织逻辑移出；依赖注入打断双向 sessionId | 聊天不再认识写方案 | 中 | typecheck + 重点回归写方案全流程（生成/选区改写/导出） |
| **③ 成模块** | （按需）KB 抽成 `@claude-desktop/kb` 包；写方案成为可独立编译/测试的 feature | 真·独立竹子 | 中 | 包内测试 + 全量 typecheck |

---

## 7. 关键技术资产清单（省你重新调研）

### 前端写方案文件（`apps/studio/src/chat/`）
- `components/workspace/`：`ProposalPaper.tsx`(1329) `ProposalDocPanel.tsx`(791) `SelectionAiBubble.tsx`(500) `ProposalStyleModal.tsx`(480) `ProposalImageReview.tsx` `proposalIcons.tsx` `ProposalImageToolbar.tsx` `KbSemanticSearchPanel.tsx` `ProposalPreview.tsx` `GenImageDirectiveCard.tsx` `ProposalTooltip.tsx`（注：`WorkspaceTreePanel.tsx` 是通用件、非写方案专属，勿搬）。
- `lib/proposal*`：`sendProposalSectionRevision.ts`(311) `renderProposalPdfHtml.ts`(201) `proposalStageGate.ts`(175) `proposalGenImageFire.ts` `sendProposalStageMessage.ts` `proposalRevisionMessages.ts` `proposalSlash.ts` `proposalRevisionGuards.ts` `proposalVerification.ts` `proposalStepper.ts` `proposalStageConfirm.ts` `startOrReopenProposal.ts` `proposalOnboarding.ts` `proposalAssetUrl.ts` `kbAssetUrl.ts` `localAssetPath.ts`。
- `stores/`：`proposal.ts`(658) `proposalStyle.ts`(55)；`composerMode.ts` 含 `'proposal'` 模式（通用文件、只改枚举）。
- `runtime/FusionRuntimeProvider.tsx`（共用引擎，第②步重点）。

### 后端写方案文件（`apps/studio/electron/main/`）—— 已较整洁
- 提示词/检索：`core/proposalPrompt.ts`(225) `proposalScopes.ts` `proposalRetrieve.ts` `proposalRetrieve.core.ts`(230) `proposalSemantic.core.ts`（`.core.ts` 被 main 和 worker 双向共用，抽包时必须一起走）。
- KB 检索/向量：`core/kbSemanticSearch.ts`(170) `workers/embedWorker.ts`(143，独立 utilityProcess) `core/kbIndexStore.ts`(121)。
- KB 构建：`core/kbBuild/{scan,convert,embed,build,assets}.ts` `kbBuildRunner.ts` `workers/kbBuildWorker.ts` `kbTooling.ts`。
- KB 存储/同步/管理：`core/kbStore.ts` `kbStore.core.ts` `kbAdminService.ts`(197) `kbSync.ts`(303) `kbSyncDiff.ts` `kbSyncScheduler.ts` `kbLocalSync.core.ts`。
- 导出：`core/proposalDocx.ts`(**1177**, `markdownToDocxBuffer`) `proposalExport.ts` `proposalPdf.ts` `proposalVerify.ts`/`.core.ts`。
- 草稿/指标/配图：`core/proposalDraftStore.ts` `proposalMetricsStore.ts` `services/imageGenService.ts`(178) `proposalImageWriter.ts` `proposalAssetProtocol.ts` `kbAssetProtocol.ts`。
- shared：`shared/proposal.ts`(990) `proposalStyle.ts`(332) `proposalGenImage.ts`(212) `proposalBlocks.ts`(179) `proposalImageOps.ts`(170) `proposalAsset.ts` `proposalBrand.ts` `kbIndex.ts` `kbAdmin.ts` `kbBuildStatus.ts` `kbConfig.ts` `kbSyncStatus.ts`。
- 外置模板（运行期文件读取，非 import）：`skills/proposal-writer/`（`SKILL.md` / `references/append-template.md`），被 `proposalPrompt.ts` 读取。

### IPC 通道（常量在 `shared/ipc-channels.ts`，handler 在 `main/ipc/register.ts` 的 `registerIpcHandlers()`，约 L289 起）
- `proposal:*`：export、export-pdf、render、render-pdf、save/load/delete-draft、verify、metric-log、peek-retrieval；`proposal-image:*`：settings-get/set、generate、edit、upload。
- `kb:*`：semantic-search、path-get/set、index-read、root-pick、remote-set、sync-now/status、sync-from-local、docs-list、tooling-check、import-pick/import、doc-delete/move/retry/open-source/preview、category-create/rename/delete、migrate-from-folder、build-status-get/status。
- **关键**：这些 handler **不依赖 engine 实例**（直接调 core 模块），故拆成 `registerProposalIpc()` 很干净。

---

## 8. 必守的纪律与项目特有的坑

### 重构纪律
- **演进式，不推倒重来**：边住边装修，每步小到能 typecheck 兜住、能一键回退。
- **YAGNI + 三次法则**：插槽只为已存在的功能设计，别为假想功能预留。
- **内核洁癖**：`core` 一旦 import `feature` 即报警。

### 项目特有坑（违反会静默引入回归，务必先读 `CLAUDE.md` 全文）
- **样式无作用域**：chat 与 canvas 共存同一 document，CSS 无隔离。shadcn 原语带 `data-slot`；canvas legacy token 用 `--od-*` 前缀；`createPortal` 到 body 的子树脱离 `.chat-app` 豁免、裸交互元素要加 `data-slot`。品牌绿用 `--brand`，用户可调色用 `--accent`。dark 双标记（`.dark` 与 `[data-theme]`）要同步。
- **依赖分层铁律**：`package.json` 的 `dependencies` 只放 Electron 运行时真正 require 的包；前端依赖一律 `devDependencies`。
- **加 IPC 改四处**（见第 1 节）。
- **contracts / registry-protocol 是预构建包**（types 指 dist）：改其源码必须包内 `bun run build`，否则下游 typecheck 读陈旧 .d.ts。
- **产物目录分家**：electron-vite → `out-electron/`，next export → `out/`，互不写对方目录。
- **大规模移动/重命名文件后**，codebase-memory 索引会陈旧，需重跑 `index_repository`。

---

## 9. 从哪继续（给接手模型的下一个动作）

1. 确认在分支 `refactor/proposal-feature-slice` 上（已建、代码未动）。
2. 先读 `CLAUDE.md` 全文。
3. **执行第①步「归拢」**，建议顺序（从最安全到较大改动，每步一个小 commit + typecheck）：
   - **先做后端**：读 `register.ts`，把 proposal/kb 的 handler 拎进新文件 `main/features/proposal/ipc.ts` 的 `registerProposalIpc(engine)`，在原处调用。改动局部、不依赖 engine、易验证。
   - **再做前端**：在 `src/chat/features/proposal/` 建目录，分批把 `components/workspace/Proposal*`、`lib/proposal*`、`stores/proposal*` 搬进去；每搬一批，更新所有 import 路径（含聊天核心里反向 import 的那些）并 `bun run typecheck`。
   - 全程**只搬家、不改逻辑**；本轮**不拆样式、不碰 slides、不动 engine 的编织逻辑**（那是第②步）。
4. 每完成一小批：`bun run typecheck` 全绿 → 请用户手动走查写方案功能没变 → 小 commit。
5. 第①步全部落地、用户确认稳定后，再进入第②步（定接口 / `ProposalRuntimeHook` / 打断双向依赖）——那一步动 `FusionRuntimeProvider` 和 `engine.ts`，风险升高，务必先与用户确认再动，并逐块 typecheck + 回归。

**与用户协作的方式**：他是新手，请用大白话解释你在做什么、为什么；帮他做技术决策而不是甩选择题；每一步告诉他「改了什么、有什么用、对他意味着什么」。
