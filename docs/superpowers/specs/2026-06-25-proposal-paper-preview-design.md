# 方案草稿：连续长纸编辑 + docx-preview 真预览 + 工作台接管布局

日期：2026-06-25
状态：设计已确认，待评审
关联：
- [[2026-06-24-proposal-draft-sections-docx-design]]（分节模型 + mdast→docx 导出，本设计在其之上换皮 + 加预览）
- [[2026-06-24-dialog-driven-proposal-input-design]]（对话驱动产品播种）

## 1. 背景与目标

当前方案草稿面板（`ProposalDocPanel.tsx`）是**分节卡片堆叠式**：每个 AI 哨兵块 = 一张 `bg-card/40` 卡片，带独立的「编辑/上移/下移/删除」按钮，单节 `textarea` 编辑，固定宽 `w-96` 嵌在右栏。导出走 main 进程 `proposalDocx.ts`（`docx` 库做 markdown→mdast→docx）。

问题：编辑态看不出最终 Word 的版式/分页；窄面板也撑不开像「一张纸」。

目标（方案 ①「连续长纸 + 真预览」）：
1. **编辑态**改成一张连续 A4 宽长纸，向下滚动**不分页**，分节无缝拼接（保留现有哨兵→分节机制，仅换皮）。
2. 新增**预览态**：把当前草稿用**导出同一引擎**生成真 `.docx`，再用 `docx-preview` 渲染成一页页 A4（真分页），保证与用户最终拿到的 Word **逐像素一致**。
3. **布局接管**：方案模式下右半区变「方案工作台」——撤掉左侧对话历史栏、左上角加「← 返回」、对话变成可折叠列、撤出的宽度喂给纸张，对话/纸张之间加可拖拽分隔条。

非目标（本期不做）：
- 不改 AI 哨兵→分节抽取链路（`shared/proposal.ts`、`appendSections`）。
- 不做 PDF 导出。
- 不把编辑器换成富文本/所见即所得引擎——编辑仍是「分节 + 单节 markdown textarea」，只是视觉换皮。
- 编辑态不做真分页（这是方案①的既定取舍：要看分页切预览）。

## 2. 总体形态

```
方案工作台（proposalForeground && workspaceOpen 为真时接管右半区）
┌──────────────────────────────────────────────────────────────┐
│ shell tab 条（不变）                                            │
├───────────────┬──┬───────────────────────────────────────────┤
│ 对话列(可折叠) │分│ 方案纸张区（flex-1，吃掉撤出的 256px）       │
│ ┌───────────┐ │隔│ ┌───────────────────────────────────────┐ │
│ │← 返回  «折叠│ │条│ │ 方案草稿   [✎ 编辑 | ▤ 预览]  导出Word .md│ │
│ ├───────────┤ │（│ ├───────────────────────────────────────┤ │
│ │ 对话消息…  │ │拖│ │ 识别产品 chip…                          │ │
│ │           │ │动│ ├───────────────────────────────────────┤ │
│ │ composer  │ │）│ │ 编辑态：连续白纸长卷 / 预览态：A4 分页    │ │
│ └───────────┘ │  │ └───────────────────────────────────────┘ │
└───────────────┴──┴───────────────────────────────────────────┘
对话列折叠后 → 纸张铺满；左上角浮出小竖条（← 返回 / ▤ 展开对话）
```

原型（已与用户确认形态）：`scratchpad/proposal-paper-prototype-v2.html`。

## 3. 布局改造（`App.tsx` + proposal store）

### 3.1 三态门控

现有 `useProposalForeground()` = `active && sessionId === 前台 sessionId`，同时驱动「隐藏 Todos/工作区右栏」与「显示方案面板」。新增一个**布局可见**维度，互不破坏草稿数据：

在 `proposal.ts` 增加：
- `workspaceOpen: boolean` — 方案工作台是否接管布局。`start()` 时置 `true`。
- action `setWorkspaceOpen(open: boolean)`。
- **`reset()` 之外，「返回」不清数据**——只 `setWorkspaceOpen(false)`，`sections`/`products` 保留，可再进。

派生 hook：
- `useProposalForeground()`：保持现含义（active + 前台），ProposalDocPanel 与"隐藏原右栏"仍用它。
- 新增 `useProposalWorkspace()` = `useProposalForeground() && workspaceOpen`：驱动「工作台接管布局」。

三态：

| 状态 | 条件 | 布局 |
| --- | --- | --- |
| 非方案 | `!active` 或非前台 | 现状三栏（对话历史栏 + ThreadView + Todos/工作区右栏） |
| 方案·已返回 | foreground && `!workspaceOpen` | 现状三栏，但右栏顶替为一颗「方案草稿 · N 节 ▸」**再入按钮**（点它 `setWorkspaceOpen(true)`），不丢草稿。对话历史栏正常显示 |
| 方案·工作台 | foreground && `workspaceOpen` | **接管**：隐藏对话历史栏；ThreadView 进可折叠对话列；分隔条；ProposalDocPanel 占 `flex-1` 纸张区 |

> 「再入按钮」的落点（ThreadView 顶部 / 原右栏位置 / 浮动 pill）留给实现计划定，原则是**离开工作台不等于销毁草稿**、随时可回。

### 3.2 不重挂 ThreadView（关键约束）

ThreadView 由 `FusionRuntimeProvider` 的 assistant-ui runtime 驱动。**进/出工作台不能重挂 ThreadView**，否则丢滚动位置 + 触发历史 rehydrate 闪烁。

做法：维持 `App.tsx` 里**同一个 flex 行**，用条件类名/宽度切换，而不是渲染两套不同子树：
- `ThreadListSidebar`：`useProposalWorkspace()` 为真时隐藏（与今天隐藏右栏同一手法）。
- `ThreadView`：始终挂载在同一节点。外层包一个 `<div>`，其宽度/flex 按模式切：非工作台 `flex-1`；工作台 = 受控宽度的可折叠列（默认 420px，折叠到 0）。
- 分隔条 `PaneSplitter`：仅工作台模式渲染，插在对话列与纸张区之间。
- `ProposalDocPanel`：非工作台 `w-96`（或再入按钮态隐藏）；工作台 `flex-1`。

### 3.3 对话列折叠 + 返回 + 分隔条

- **折叠**：对话列头部右侧「«」按钮 → 宽度 0（CSS transition）。折叠后左上角浮出 `floatCluster`（半透明小竖条：`←` 返回 + `▤` 展开对话），悬纸张左上角、不挡正文（用户已接受常驻形态）。
- **返回**：对话列头部左上「← 返回」→ `setWorkspaceOpen(false)`。
- **分隔条**：拖动改对话列宽度（纸张区 `flex-1` 自动吃掉余量）。约束：对话列 `min 320px`；纸张区至少留 A4 + 留白（窗口太窄时纸张容器内部横向滚动，不挤垮对话）。
- **布局偏好持久化**：`chatColWidth`、`chatCollapsed` 存 `localStorage`（每 tab 一个 renderer，天然按 tab 隔离）；`mode`（编辑/预览）为组件本地态，每次默认 `edit`。

### 3.4 新增组件 `PaneSplitter.tsx`

小而独立：`onDrag(deltaX)` 回调 + 视觉（hover/drag 变 accent 色、抓握竖纹）。`mousedown` 起拖、`window` 上 `mousemove/mouseup`，拖动时 `userSelect:none`。

## 4. 编辑态：连续长纸（`ProposalPaper.tsx`，从 `ProposalDocPanel` 拆出）

把现有分节渲染从「卡片堆叠」换皮为「一张连续白纸」：

- 外层滚动容器：浅灰画布（`editScroll`），居中放一张 `paper`：白底、`width: min(794px, 100% - 边距)`、上下大内边距模拟页边距、轻微纸张阴影、衬线字（中文 `Songti/SimSun`，回退 Georgia）。向下滚动**不分页**。
- **分节无缝拼接**：去掉每节卡片的 `border`/`bg-card/40`/间隙。每节是 `paper` 内的一个 `.sec`，正文用现有 `AssistantMarkdown` 渲染（衬线样式在 `paper` 作用域覆盖）。
- **悬停工具条**：鼠标悬停某节 → 该节右侧外边距浮出细竖条（✎ 编辑 / ↑ 上移 / ↓ 下移 / × 删除），不占正文宽度、不破坏纸面。首/末节的上/下移禁用（沿用 `i===0` / `i===len-1`）。
- **就地编辑**：单节编辑仍是 `editingId` 单选 + `textarea`，但 textarea 重新配色——白底、与正文同字号/行高的衬线字、无灰框，让「就地在纸上改字」连贯，而非跳出灰框。下方「完成/取消」小条。`updateSection` / `removeSection` / `moveSection` 调用不变。
- **截断徽标**：`sec.truncated` 的黄色「疑似截断」提示保留（常驻、不随 hover 隐藏）。
- **空态**：无 section 时显示「等待 AI 起草…」/「方案正在生成…」（沿用 `generating` 判定）。

数据与 action 全部复用 `proposal.ts`，本节零改动。

## 5. 预览态：docx-preview 真分页（`ProposalPreview.tsx`，新）

### 5.1 触发与渲染流程

`ProposalDocPanel` 头部加「✎ 编辑 ｜ ▤ 预览」segmented 切换（本地 `mode` 态）。切到预览：
1. 把当前 `sections` 拼成单串 markdown（`sections.map(s=>s.markdown).join('\n\n').trim()`，与导出同一拼法）。
2. 空 → 显示空态，不渲染。
3. 调新 IPC `renderProposal({ markdown })` → 拿到 `.docx` 字节（`Uint8Array`）。
4. 包成 `Blob`，用 `docx-preview` 的 `renderAsync(blob, container, undefined, options)` 渲染进专用容器。
5. 渲染期间显示 loading（spinner）；失败显示错误态（可重试）。

`docx-preview` options：`{ inWrapper: true, breakPages: true, ignoreWidth: false, ignoreHeight: false, className: 'docx' }` —— 得到带页间留白、阴影、真分页的 A4 页面。

**一致性保证**：预览的 `.docx` 字节与「导出 Word」走的**完全是同一个** `markdownToDocxBuffer()`，所以预览分页 = 导出成品分页，逐像素一致。

### 5.2 缓存与重渲染

- 进入预览时按当前 markdown 的简单 hash 缓存：markdown 未变则跳过重新生成/渲染（沿用原型「rendered 快路径」直觉）。
- AI 仍在流式生成（`generating`）时，预览是**当前快照**；用户可切回编辑、待生成完再切预览刷新。不在生成中途自动重渲（避免抖动）。

### 5.3 样式隔离

`docx-preview` 会注入 CSS。用 `inWrapper:true` + 专用挂载容器，其样式作用域基本落在 `.docx-wrapper`/`.docx` 下。风险：全局样式注入污染。缓解：渲染进独立容器、容器卸载时清空 `innerHTML`；评审时实测确认不影响应用其它部分（写入 errors/ 若踩坑）。

### 5.4 页码（子决策）

`docx-preview` 默认不自动加页码——页码来自 docx 自身的页脚域。两个选项：
- **A（推荐）**：在 `proposalDocx.ts` 给 `Document` 加一个含 `PageNumber` 域的页脚。好处：**导出的真 Word 也带页码**，预览自然显示，彻底一致。代价：改动导出引擎一处（低风险，加 footer）。
- B：MVP 先不加页码，仅靠 docx-preview 的分页留白/阴影体现「分页」。

建议取 A（顺带让导出的 Word 更完整）。最终以评审确认为准。

## 6. 新增 IPC：`proposal:render`（拿字节不落盘）

现有 `proposal:export` 是「弹保存框 + 写盘」，预览不能落盘。新增**只生成不落盘**的通道。按本项目约定改三处（`preload/index.d.ts` 仅 `import { ChatApi }`，给 `ChatApi` 接口加方法即自动跟随，无需单独改）：

1. `shared/ipc-channels.ts`：
   - 通道常量 `PROPOSAL_RENDER: 'proposal:render'`。
   - 类型 `ProposalRenderPayload { markdown: string }`、`ProposalRenderResult { bytes: Uint8Array }`。
   - `ChatApi` 加 `renderProposal(payload: ProposalRenderPayload): Promise<ProposalRenderResult>`。
2. `preload/index.ts`：实现 `renderProposal` → `ipcRenderer.invoke(IPC_CHANNELS.PROPOSAL_RENDER, payload)`。
3. `main/ipc/register.ts`：
   - `ipcMain.handle(PROPOSAL_RENDER, …)`：校验 `markdown` 为 string，调 `markdownToDocxBuffer(markdown)`（从 `proposalDocx` 直接 import），返回 `{ bytes: buf }`（`Buffer` 是 `Uint8Array` 子类，IPC 结构化克隆原样传）。生成异常则抛出 → 渲染层 try/catch 显示错误态。
   - 在 teardown 段补 `ipcMain.removeHandler(IPC_CHANNELS.PROPOSAL_RENDER)`（与现有 `PROPOSAL_EXPORT` 的 removeHandler 并列）。

导出引擎（`proposalDocx.ts` 的 `markdownToDocxBuffer`）被 `export`（落盘）与 `render`（预览）两条 IPC 共用，**一行业务逻辑不重复**。

## 7. 依赖

- 渲染进程新增 `docx-preview`（含 `jszip` 传递依赖，纯前端库）。`bun add docx-preview`。
- `docx` / `unified` / `remark-*` 仍只在 main 进程，不进 renderer 包。

## 8. 涉及文件清单

| 文件 | 改动 |
| --- | --- |
| `src/shared/ipc-channels.ts` | 加 `PROPOSAL_RENDER` 常量 + 类型 + `ChatApi.renderProposal` |
| `src/preload/index.ts` | 实现 `renderProposal` |
| `src/main/ipc/register.ts` | `PROPOSAL_RENDER` handler + teardown removeHandler；import `markdownToDocxBuffer` |
| `src/main/core/proposalDocx.ts` | （页码选项 A 时）加含 `PageNumber` 的页脚 |
| `src/renderer/src/stores/proposal.ts` | 加 `workspaceOpen` + `setWorkspaceOpen`；新 hook `useProposalWorkspace` |
| `src/renderer/src/App.tsx` | 工作台接管布局：隐藏对话历史栏、对话列可折叠、分隔条、ProposalDocPanel `flex-1`、返回/再入 |
| `src/renderer/src/components/workspace/ProposalDocPanel.tsx` | 拆成 shell：头部 title + 编辑/预览 toggle + 导出 + chips，按 mode 渲染 Paper/Preview |
| `src/renderer/src/components/workspace/ProposalPaper.tsx`（新） | 连续长纸编辑态（含悬停工具条 + 就地 textarea） |
| `src/renderer/src/components/workspace/ProposalPreview.tsx`（新） | docx-preview 渲染 + loading/error |
| `src/renderer/src/components/workspace/PaneSplitter.tsx`（新） | 可拖拽分隔条 |
| `package.json` | 加 `docx-preview` |

## 9. 边界与错误处理

- **空草稿预览**：不调 IPC，显示空态。
- **渲染失败**：IPC 抛错 → 错误态 + 重试按钮；不崩面板。
- **生成中预览**：快照当前 sections；不自动重渲。
- **折叠态返回**：`floatCluster` 的「← 返回」与对话列头部「← 返回」语义一致（都 `setWorkspaceOpen(false)`）。
- **窗口过窄**：纸张容器内部横向滚动，保对话列 `min 320px`，composer 不被挤垮。
- **样式污染**：docx-preview 渲染容器隔离 + 卸载清空。
- **切到非方案会话**：`useProposalWorkspace()` 立即为假，布局回正常三栏（不依赖手动返回）。

## 10. 风险与取舍

- 编辑态无真分页——方案①既定取舍，已与用户确认。
- `docx-preview` 全局 CSS 注入需实测隔离（评审验证项）。
- 布局接管动到 `App.tsx` 的 flex 行结构，须保证 **ThreadView 不重挂**（§3.2）。这是本设计最大工程风险点。
- 预览是「生成 docx + 渲染」异步链，首次有 loading 延迟（可接受，给 spinner）。

## 11. 验证

- `bun run typecheck`（CI 唯一质量门，无单测无 ESLint）必须过。
- 手动验收：
  1. 进入方案 → 工作台接管、对话历史栏消失、纸张占宽。
  2. 拖分隔条调宽；折叠对话 → 纸张铺满 + 浮动返回/展开；展开复原。
  3. 编辑长纸：悬停出工具条、就地改字、上下移、删除、截断徽标。
  4. 切预览 → loading → A4 分页（含页码若选 A）；与「导出 Word」打开的文件逐页比对一致。
  5. 「← 返回」→ 回正常三栏且草稿不丢；再入按钮 → 回工作台、草稿仍在。
  6. 空草稿预览空态；渲染失败错误态可重试。
