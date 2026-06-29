# 写方案·阶段确认改为聊天内 AskUserQuestion

**日期**: 2026-06-29
**状态**: 已批准设计，待写实施计划

## 背景

「写方案」(proposal writer) 是三阶段流程：封面 → 目录 → 正文。当前每阶段之间靠右侧文档面板 (`ProposalDocPanel.tsx`) 上的确认按钮推进：

- `confirmCover()` —「确认封面，生成目录」→ `advancePhase('toc')` + `sendProposalStageMessage(...)`
- `confirmToc()` —「确认目录，开始正文」→ `advancePhase('content')` + 回灌目录 markdown 给 AI

阶段门 `gateDraftBlocksByPhase`（`shared/proposal.ts`）靠 `phase` 拦截越界正文：`isDraftBlockAheadOfPhase` 规定「content 块在非 content 阶段一律拦下」。因此 `toc→content` 这道门**必须**有人调 `advancePhase('content')` 才能放行正文 —— 现在是按钮在调。

## 目标

去掉这两个阶段确认按钮，改为由 AI 在左侧聊天里用 `AskUserQuestion` 工具发起确认提问，用户在聊天卡片里点选确认/修改。`AskUserQuestion` 在方案模式中已是硬性纪律，渲染卡片 (`AskUserQuestionView.tsx`) 现成。

## 非目标

- 不改阶段门 / 去重 / 排序等核心不变量（`gateDraftBlocksByPhase`、`sortSectionsByKind`、消息级/内容级去重）。
- 不动「重新生成目录」补救红条、定向修订、补料续写等其他交互。
- 不新增"右侧文档面板直接手改目录"路径。

## 设计

### 核心机制：phase 推进改由聊天答案触发

新流程下，`toc→content` 的 `advancePhase('content')` 不再由按钮调，而是**由用户点选 AskUserQuestion 的「确认目录」选项时，渲染层拦截该答案后调用**。

时序保证：用户点选是同步事件，`advancePhase('content')` 在该刻立即生效；AI 收到 tool_result 后才流式吐正文，正文在 `end` 事件里过阶段门时，phase 早已是 `content`，故放行。

`cover→toc` 无需特殊处理：AI 一吐出目录哨兵块，现有 `laterPhase` 即把 phase 推到 `toc`（阶段门只拦 content，不拦 toc）。因此**只需拦截「目录确认」这一个答案**来推进 phase；「封面确认」答案只需做 `clearStageSkip()` 之类的轻量清理（可选）。

### 改动一：提示词纪律（`apps/desktop/src/main/core/proposalPrompt.ts`）

在现有提问纪律基础上新增一条阶段确认纪律：

- AI 每完成一个阶段草稿（封面 / 目录）后，**必须**用 `AskUserQuestion` 发起确认，**绝不自行往下吐下一阶段内容**。
- 封面确认问题：`header` 固定为常量 `封面确认`；**首选项**文案为「确认封面，生成目录」（放行项）；后续项为修改类（如「我要调整封面」）。
- 目录确认问题：`header` 固定为常量 `目录确认`；**首选项**文案为「确认目录，开始撰写正文」（放行项）；后续项为修改类（如「我要调整目录」）。
- 约定写死：放行项永远是该问题的第一个选项（`options[0]`）。修改类选项排在其后。

### 改动二：共享常量（`apps/desktop/src/shared/proposal.ts`）

新增两个 header 常量，供提示词与渲染层共用，避免字面量散落：

```ts
export const PROPOSAL_COVER_CONFIRM_HEADER = '封面确认'
export const PROPOSAL_TOC_CONFIRM_HEADER = '目录确认'
```

### 改动三：渲染层拦截 AskUserQuestion 答案（仅方案模式生效）

在 `AskUserQuestion` 的提交路径（`AskUserQuestionView.tsx` 的 `onSubmit` 或其父级装配处）加入方案感知逻辑，用 `useProposalStore.active` 门控，仅方案模式生效：

- 当某问题 `header === PROPOSAL_TOC_CONFIRM_HEADER` 且用户选中的 label 等于该问题 `options[0].label`（放行项）→ 调 `advancePhase('content')` + `clearStageSkip()`。
- 选中的是修改类选项 → 不推进 phase，AI 收到答案后自然进入修订对话。
- `header === PROPOSAL_COVER_CONFIRM_HEADER` 时：可选地 `clearStageSkip()`，无需推进 phase。

匹配采用 **header 常量 + 首选项 label 双重判定**，避免误判 AI 在该阶段问的其他无关问题。

> 实施时需定位 `AskUserQuestionView` 的 `onSubmit` 装配点：该组件是所有 `AskUserQuestion` 调用共用的通用权限组件，方案逻辑必须用 `useProposalStore.active` 门控，不能污染非方案场景。

### 改动四：删除按钮（`apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx`）

- 删除 `phase === 'cover'` 和 `phase === 'toc'` 分支里的两个确认 `<button>`。
- 删除 `confirmCover()` / `confirmToc()` 两个 handler。
- 顶部阶段条改为**纯只读状态显示**：高亮当前阶段，无可点交互（保留 `phase === 'content'` 的「正文撰写中」文案风格）。
- 保留「重新生成目录」补救红条及 `regenerateToc()`。
- 相应清理对 `sendProposalStageMessage` 的两处调用（若无其他引用，该 lib 文件可一并删除 —— 实施时确认引用情况）。

## 取舍记录

旧 `confirmToc` 会把**最终目录 markdown 回灌**给 AI（「目录已确认，最终目录如下：…请进入阶段三」）再让其写正文。新流程里 AI 在自己刚生成的上下文基础上直接续写正文 —— 用户若在聊天里改过目录，AI 上下文本就有最新版，故该回灌**多数情况冗余，省去**，流程更干净。

代价：若将来支持"在右侧文档面板直接手改目录、不经聊天"，手改内容 AI 不会感知。当前无此纯右侧编辑路径，故可接受。

## 鲁棒性 / 边界

- **AI 未发起确认提问**：靠提示词纪律保证可靠触发；万一漏问，用户可在聊天直接输入「确认目录，开始正文」推进；「重新生成目录」补救红条仍覆盖目录生成卡住的场景。
- **时序**：phase 在点选时同步推进，先于正文 `end` 处理，阶段门正常放行。
- **不污染非方案场景**：渲染层拦截严格以 `useProposalStore.active` 门控。

## 验收

- 进入方案模式，AI 生成封面后在左侧聊天弹出「封面确认」AskUserQuestion 卡片（含确认 + 修改选项），右侧无确认按钮。
- 点「确认封面，生成目录」→ AI 生成目录 → 弹出「目录确认」卡片。
- 点「确认目录，开始撰写正文」→ phase 推进到 content，AI 正文正常落地、不被阶段门拦。
- 点「我要调整目录」→ phase 不推进，进入修订对话。
- 顶部进度条随阶段高亮，但不可点击。
- `bun run typecheck` 通过。
