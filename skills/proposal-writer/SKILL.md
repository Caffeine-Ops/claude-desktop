---
name: proposal-writer
description: >
  知识库驱动的售前/商业建设方案写作（写方案）。请通过 Claude Desktop 聊天框输入
  /proposal-writer 或点侧栏「写方案」场景卡使用——桌面应用会拦截该命令并联动右侧
  文档面板、三阶段确认硬门、知识库检索与 Word/PDF 导出。在纯 CLI 或普通会话里直接
  展开本 skill 只能获得写作方法论文本、没有上述联动，属降级使用。Use when the user
  asks to 写方案 / 售前方案 / 建设方案 / proposal-writer.
---

# 写方案（proposal-writer）

本 skill 是 Claude Desktop「写方案」功能的**方法论唯一事实源** + 斜杠入口占位。

- **在桌面应用里**：聊天框输入 `/proposal-writer`（可带需求，如
  `/proposal-writer 给XX医院写预问诊平台建设方案`），或点侧栏「写方案」场景卡。
  应用会拦截命令、激活方案模式；方法论由应用渲染
  `references/append-template.md` 后注入会话系统提示词——本 skill 不会被 CLI
  真正展开，这是有意设计（阶段硬门的纪律必须无条件常驻系统提示词，不能依赖
  模型自愿加载）。
- **纯 CLI / 普通会话里被直接展开时（降级）**：读
  `references/append-template.md` 获取完整写作纪律。模板中的 `{{占位符}}` 是
  应用运行期注入的协议标记与知识库文件清单，此时不可用——按其中的方法论写作
  即可，但没有文档面板、阶段硬门与检索联动。

## 维护须知

- **改写作方法论**：只改 `references/append-template.md` 的文字，然后跑
  `cd apps/desktop && bun test src/main/core`。快照测试会 diff 出变化——确认是
  有意修改后用 `bun test --update-snapshots` 刷新基线，把 `.snap` 一起提交。
- **改协议字样**（哨兵、确认 header、资料缺失前缀）：事实源在
  `apps/desktop/src/shared/proposal.ts`，模板里只有 `{{占位符}}`、会自动跟随。
  **不要**在模板里手写协议字样明文——契约测试会当场拦下。
- 渲染逻辑：`apps/desktop/src/main/core/proposalPrompt.ts`（`buildProposalAppend`）。
- 斜杠拦截：`apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx`（onNew）。
- 各段纪律的历史来龙去脉：见本目录 `NOTES.md`。
