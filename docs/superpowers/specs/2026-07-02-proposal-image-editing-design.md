# 写方案·编辑器内 P 图（图片编辑/生成）设计

- 日期：2026-07-02
- 状态：设计已定，待写实现计划
- 分支基线：`main`（图片功能 kbasset:// 已在 main）
- 相关：`2026-06-26-proposal-images-from-kb-design.md`（知识库插图，接地模型）、`2026-07-01-proposal-block-edit-and-selection-ai-design.md`（块编辑 + 选区即改 + 对话内审阅）

## 背景与动因

「写方案」编辑器现在只能插入**知识库里的图**（`kbasset://` 只读协议），且受「接地」硬约束：图能进某节 ⟺ 属于本节已 `（据《X》）` 引用文件的 `assets[]`，否则校验标红。

用户要在编辑功能里新增 **P 图** 能力，底层复用 `gpt-image-2` / `draw` skill 的出图逻辑，覆盖三种场景：

1. **改造已插入的图**：换背景、去水印、换元素、调风格（整图编辑）。
2. **从零文生图**：凭一句话生成新插图/示意图，直接插进方案。
3. **上传外部图再改**：拖/选本地图片进来，插入或继续 P。

**明确不做（YAGNI）**：遮罩局部编辑（`--mask`）；中文→英文提示词翻译（先透传，gpt-image 系列能吃中文）。

## 关键约束（不可动的不变量）

- **分发目标是终端用户**，不是只给开发机。因此不能 spawn 本机 `~/.claude/skills/draw/scripts/draw.js`（脚本 + `~/.codex` 凭据都不会被打进 Electron 安装包）。出图逻辑必须移植进主进程。
- `kbasset://` 协议**只读**、路径守卫锁死知识库根目录，无法承载新产出的图。
- 进程模型（CLAUDE.md）：renderer 禁止直接 import Node；一切主进程能力走 `window.chatApi`；加一条 IPC 必须同步改四处（`ipc-channels.ts` → `preload/index.ts` → `preload/index.d.ts` → main handler）。
- 不碰哨兵、层级编号（TOC_REF/HEADING_REF）、校验 trigram 逻辑。

## 设计

### A. 图片来源模型 —— 接地豁免

给图片新增来源标记 `origin`：

| origin | 含义 | 接地校验 |
|---|---|---|
| `kb`（现状） | 知识库原图 | 继续走接地，不达标标红 |
| `generated` | AI 文生图 | **豁免**，直接放行不标红 |
| `edited` | AI 改过的图 | **豁免**，直接放行不标红 |
| `uploaded` | 用户上传的图 | **豁免**，直接放行不标红 |

- 预览/编辑态给豁免来源一个小角标（「AI 生成」「已编辑」「用户上传」）；导出 docx 时角标**不带进去**。
- 理由：接地是防 AI 臆造知识库里没有的事实。用户主动 P 的图是用户自负其责的产出，不该拦。
- 实现：校验管线逻辑不改，只在图片接地判定处对非 `kb` 来源短路放行。

### B. 产出图的落盘与引用

- **落盘**：每草稿一个私有资产目录 `<userData>/proposal-drafts/<draftId>/assets/<slug>-<时间戳>.png`。
- **新协议 `proposalasset://`**：照 `apps/desktop/src/main/services/kbAssetProtocol.ts` 范式做**可写版**，同样带 `isPathInside` 路径逃逸守卫，根目录换成草稿资产目录。`registerSchemesAsPrivileged` 在 app ready 前、handler async await（与 kbasset 一致）。
- markdown 里存 `![](proposalasset://<draftId>/<file>.png)`。
- **渲染**：renderer 侧 `kbAssetUrl.ts` 已有 `toKbAssetUrl`；新增对应 `toProposalAssetUrl`，`AssistantMarkdown` 的 `img` override 按协议前缀分派（只渲染时转，不改存储 markdown）。
- **导出 docx**：`proposalDocx.ts` 的 `imageParagraphs` 现在只解析 kbasset，扩成也解析 proposalasset → 读盘 → `ImageRun`（等比缩放 + 图说，复用现有逻辑；坏图降级文字不中断导出）。
- **持久化 / 清理**：`proposalDraftStore.ts` 已管草稿；资产目录随草稿存活，删草稿时连带清理资产目录。

### C. 出图能力进主进程

新增主进程 service `imageGenService.ts`，移植 `draw.js` 逻辑，**不 spawn 外部脚本**：

- 直接调 OpenAI 兼容端点：
  - 文生图 → `POST /images/generations`
  - 改图 → `POST /images/edits`（multipart，传源图 PNG）
- 照搬 draw.js 的健壮性：**502 重试** + **模型降级**（`gpt-image-2 → gpt-image-1.5 → gpt-image-1`）。
- 成功后把返回图落盘到草稿资产目录，返回 proposalasset 路径。

**凭据**：

- `appSettings.ts` 新增字段 `imageApi: { apiKey: string; baseURL: string; model: string }`（走现有 `normalize` 容错，未配置留空）。
- `SettingsView.tsx` 加一个真实设置区（现有多为占位）让用户填 key / baseURL / 默认模型。
- 未配置时：三个入口按钮置灰 + 提示「去设置里填出图 API」。
- 不与听写（whisper）凭据耦合，独立字段。

**新增 IPC（改四处）**：

- `proposal:image:generate`（入参：draftId、prompt、size/quality 可选）
- `proposal:image:edit`（入参：draftId、源图路径或字节、prompt）
- 四处：`shared/ipc-channels.ts`（通道常量）→ `preload/index.ts`（暴露方法）→ `preload/index.d.ts`（类型）→ main handler（`ipc/register.ts` 或 engine，调 `imageGenService`）。
- 返回：落盘后的 proposalasset 路径（供 renderer 插入/替换 markdown）。

**提示词**：v1 中文指令直接透传，不做翻译。效果不好再加「中文→英文提示词」润色步（后续增量）。

### D. 三个入口的交互

复用编辑器现有模式（块渲染、选区气泡、对话内审阅）。

1. **点图 → 浮动工具栏**：鼠标点选方案里任一图，图旁弹 `[改图] [换图] [删除]`。
   - **改图**：弹输入框填指令 → 取这张图当源图（若是 `kb` 图，先拷进草稿资产目录当源，避免污染只读 KB）→ 调 `proposal:image:edit` → 生成新图。
   - **换图**：从知识库选 / 上传本地（复用插入）。
   - **删除**：删掉这段图 markdown。
2. **文字指令生图**：在左侧对话流或选区气泡打「在这里生成一张 XX 图」→ 调 `proposal:image:generate` → 插到当前块/光标位置。
3. **上传本地图再改**：拖/选本地图 → 拷进草稿资产目录（origin=`uploaded`）→ 插入，可接着走「改图」。

**改图/生图一律「先审后落地」**：新增 `ProposalImageReview` 卡片，复用「对话内审阅」模式（对照 `ProposalRevisionReview`）——展示 **原图 vs 改后图**（生图则展示 生成图 + 「插入到此处」）+ `[应用] [放弃] [重改]`。点「应用」才把 markdown 里的图替换/插入。与现有文字改写审阅体验一致。

### E. 加载 / 失败处理

- 出图是网络请求，慢（数秒~十几秒）且会失败。UI 必须：
  - 触发后立即进 loading 态（按钮 spinner / 审阅卡占位），**不阻塞编辑器其余操作**。
  - 失败给可见错误 + 「重试」；区分「配置问题（缺 key）」与「网关临时 5xx」两类提示（对齐 draw.js 的经验：对话端点能用不代表图像端点同时可用）。
  - 生成中禁用同一入口的重复触发。

## 影响面（文件清单）

- 新增：`apps/desktop/src/main/services/imageGenService.ts`、`apps/desktop/src/main/services/proposalAssetProtocol.ts`、`ProposalImageReview.tsx`、图片浮动工具栏组件。
- 改：`appSettings.ts`（imageApi 字段）、`SettingsView.tsx`（设置区）、`ipc-channels.ts` + `preload/index.ts` + `preload/index.d.ts` + main handler（两条 IPC）、`proposalDocx.ts`（imageParagraphs 认 proposalasset）、`kbAssetUrl.ts`/`AssistantMarkdown`（proposalasset 渲染分派）、`proposal.ts`（图片 origin 标记 + 接地豁免）、`proposalDraftStore.ts`（资产目录生命周期）、`ProposalPaper.tsx`（点图工具栏挂载）。
- 不碰：哨兵、层级编号、BM25/trigram 校验逻辑本体。

## 测试策略

- `imageGenService`：mock OpenAI 端点，测 502 重试 + 模型降级路径、edit multipart 组装。
- `proposalAssetProtocol`：路径逃逸守卫（越界路径拒绝），复用 kbasset 测试范式。
- docx 导出：含 proposalasset 图的 buffer 比去图版大 200+ 字节（沿用图片功能的「真嵌入」判据，非弱 `>1000`）。
- 接地豁免：非 `kb` 来源图不进 `imageVerdicts` 标红。
- 手动 GUI 走查：三个入口 + 先审后落地 + 缺 key 置灰 + 失败重试。

## 开放项 / 后续增量（不在 v1）

- 遮罩局部编辑（`--mask`）。
- 中文→英文提示词润色。
- 复用听写凭据（若后续统一 OpenAI 兼容网关）。
