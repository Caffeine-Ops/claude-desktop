# 对话驱动的写方案入口（方案 D）设计

> 状态：已 brainstorm 定稿，待 review → 写实现计划
> 分支：Install-Plan
> 关联：`2026-06-23-kb-driven-proposal-writer-design.md`（本功能是它「选产品」第一步的重构）

## 背景与现状

「知识库驱动方案写作」已上线（11 任务全完成）。它的第一步是**选产品**：

1. 点左栏「写方案」卡 → 弹 `ProductPickerDialog`。
2. dialog 把索引 `index.json` 摊成「产品线 → 产品」树，用户**单选一个产品**。
3. `onPickProduct` 做三件事：`startProposal(productLine, product, sessionId)`、按写死的 `PROPOSAL_TEMPLATE.sections` 初始化右侧 Todos、用 `[产品]` 填 composer 提示词。
4. 用户发送 → `proposalMode=true` 透传到 main → `openSession` spawn 时把方案纪律 append 进系统提示词、把**整个镜像根目录** `kbOutDir()` 加进 `additionalDirectories`。

现状的两个硬约束，正是本次要解开的：

- **只能选一个产品**：实际方案常涉及多个产品（如「导诊 + 预问诊」）。
- **结构写死**：所有产品一律走 `PROPOSAL_TEMPLATE` 的固定章节，无法表达「这次第 3 部分要一条条介绍」这类临时结构。
- 补充事实：选中的 `product` 当前其实只是个**语义标签**（填提示词占位符 + store 记录 + 初始化 Todos）。真正给 AI 的检索范围是整个镜像根目录，并未按产品收窄。

## 用户的真实诉求

用户（福鑫数科售前）希望第一步**不要任何结构化选择 UI**，而是直接用一句话把需求说清，AI 照着写。范本（用户原话）：

```
导诊、预问诊两个产品
内容分三部分写：
1 系统功能概述
2 系统功能架构（或者特点、关键技术什么的）
3 系统功能（一条条介绍）
```

这一段同时表达了三件事——**哪些产品**、**分哪几部分**、**哪部分要逐条**。所有原本想用 UI 结构化的输入，自然语言一次说完。

## 目标 / 非目标

**目标**

- 点「写方案」卡 → 直接进对话，**不弹任何选择器**；输入框预填可编辑的引导模板。
- 用户用自然语言描述「产品 + 章节结构 + 逐条标记」，AI 严格照办，逐条部分逐条出。
- 发送时**系统轻量匹配**用户文本里的产品名（基于 `index.json` 的 `product` 字段），识别出产品集，以可删的内联 chip 回显，并据此**收窄检索范围**。
- 守住原纪律：只用知识库、标来源、查不到标「⚠️ 资料缺失」。

**非目标（YAGNI，本期不做）**

- 不做拖拽大纲编排器（曾考虑的方案 C，过重）。
- 不做产品「补选」UI（漏配靠对话补 + 整库兜底）。
- 不做输入实时匹配（只在发送时匹配一次）。
- 不保留按写死模板初始化的右侧章节 Todos（见默认①）。

## 设计

### 用户流程

```
1. 点「写方案」卡
   → startProposal()（不带具体产品，仅激活方案模式 + 绑定 sessionId）
   → composer 预填【可编辑引导模板】：
       要写的产品：
       内容分几部分写：
       1.
       2.
       3.（哪部分要一条条介绍，就在该部分标注「一条条介绍」）
   → 聚焦 ProseMirror
2. 用户改成真实需求（即上面的范本），按发送
3. 发送瞬间：对文本跑产品名轻量匹配
   → 命中 {导诊系统, 预问诊系统} → 内联 chip 回显，可删误配
   → 命中结果写进 store.products，随 send 一起传给 main
4. 收窄检索范围：
   → 命中 ≥1：additionalDirectories = 各命中产品的镜像子目录
   → 命中 0：fallback 整个镜像根目录（AI 自己 Grep 定位）
5. AI 收到：升级后的方案纪律 + 收窄目录列表 + 用户的自然语言结构
   → 按用户给的部分逐段写，标「一条条介绍」的部分逐条列举，全程守纪律
```

### 产品名匹配（新增 `kbProductMatch.ts`）

- 输入：用户消息文本 + `KbIndex`。
- 从 `index.files` 抽出所有 distinct `{productLine, product}`（`product` 非空）。
- 匹配策略（best-effort，**召回优先**，因为误配代价低、漏配有整库兜底）：
  - 对每个 index 产品名 `P`：若用户文本**包含** `P`（如文本「导诊系统」含目录名）；或把用户文本按 `、，,；; 空格 数字 换行` 切成 token，存在长度 ≥2 的 token 被 `P` **包含**（如 token「导诊」⊂「导诊系统」）→ 命中。
  - 命中返回 `{productLine, product}`。同一 `product` 名跨多个产品线重名时**全部命中**（保守多给可读目录，不阻塞）。
- 输出：去重后的 `Array<{productLine, product}>`。
- 放在 renderer 侧（发送前调用），读 `window.chatApi.readKbIndex()` 已有的索引。
- **为何误配代价低**：命中只影响①给 AI 的可读目录、②提示词点名。AI 始终按用户文本写，多一个可读目录不会让它乱写；chip 可删进一步兜底。

### 检索范围收窄（main / `engine.openSession`）

- 镜像目录结构：`kbOutDir()/产品线/产品/*.md`（阶段 A 已固定）。
- fresh spawn 路径：`additionalDirectories` = 命中产品集映射为 `join(kbOutDir(), productLine, product)` 的数组；为空则 `[kbOutDir()]`（整库）。
- warm spawn 路径：`additionalDirectories` 在 warmup spawn 时已烘焙（那时还不知道产品），无法再收窄——沿用现有 warm-spawn 处理（见关联 spec 的 commit 429c9f7e），靠注入升级版 `buildProposalAppend`（带产品目录列表）给 AI 点名。app 当前 `bypassPermissions`，读镜像不弹权限，可接受。

### 系统提示词升级（`proposalPrompt.ts` 的 `buildProposalAppend`）

签名从 `buildProposalAppend(mirrorDir)` 扩为 `buildProposalAppend(mirrorDir, productDirs?)`，内容增补：

1. 保留原 5 条纪律的精神（只用知识库 / 不臆想 / 标来源 / 查不到标缺失 / 全程中文）。
2. 新增：「用户会用自然语言告诉你**要写哪些产品**、**内容分哪几部分**、**哪部分要一条条介绍**。严格按用户给的部分与顺序组织，不自行增删章节。」
3. 新增：「标注『一条条介绍』『逐条』的部分，要逐条列举（每条：小标题 + 该条内容 + 来源），不要并成一段。」
4. 收窄目录：命中产品时列出 `productDirs` 的绝对路径并说明「优先在这些目录内检索」；为空时说明「先用 Grep 在镜像根目录定位用户提到的产品」。
5. 保持纯函数 / 无副作用（同输入同输出，不破坏 prompt cache 断点）——与现有注释约束一致。

### 数据结构与 IPC 改动

**`stores/proposal.ts`**

```ts
// 单值 → 数组；start 不再强制要产品
products: Array<{ productLine: string; product: string }>   // 替换 productLine/product 单值
start: (sessionId: string) => void                          // 仅激活 + 绑定 session
setProducts: (p: Array<{ productLine; product }>) => void   // 匹配结果回写 + chip 删除时更新
```

**IPC 扩展（四处同改，CLAUDE.md 铁律）**：`ChatSendPayload` 增 `proposalProducts?: Array<{productLine; product}>` → `ipc-channels.ts` / `preload/index.ts` / `preload/index.d.ts` / `ipc/register.ts` handler → `engine.send(sessionId, text, images, proposalMode, proposalProducts)`。main 用 `kbOutDir()` + pair 拼镜像子目录路径。

**`FusionRuntimeProvider.tsx`**：发送前跑匹配 → 写 `store.setProducts` → 随 `send` 透传 `proposalProducts`（门控同 `proposalMode`：仅 `ps.active && ps.sessionId === targetSid` 时带）。

### UI 改动

- **`ScenarioQuickStart.tsx`**：「写方案」卡 onClick 从 `setPickerOpen(true)` 改为 `onStartProposal()`——`startProposal(activeSessionId)` + `composer.setText(引导模板)` + 聚焦。移除 `ProductPickerDialog`、`setTodos`、`PROPOSAL_TEMPLATE` 的 import 与使用。
- **chip 回显**：在 composer 上方（或消息卡片）渲染识别到的产品 chip，每个带删除按钮；删除调用 `setProducts`。匹配为空时显示一句浅色提示「未识别到产品，AI 将自行在知识库定位」。组件新增，轻量。
- **删除 `ProductPickerDialog.tsx`**：纯对话方向下不再需要。实现时 grep 确认无其它引用。
- **i18n**：`scenarioProposalPrompt` 从 `[产品]` 占位模板改为新的引导模板（EN/CN 各一份）。

### 默认决策（已与用户确认）

- **默认①｜砍掉写死的章节 Todos**：写死的 `PROPOSAL_TEMPLATE` 与「结构由对话临时定」矛盾，本期去掉自动初始化。grep `PROPOSAL_TEMPLATE` 确认无其它消费后，可一并删常量。（未来若要进度条，让 AI 用 todo 工具按用户结构自管。）
- **默认②｜匹配纠错只做「删」**：chip 可删误配；不做补选 UI，漏配靠对话补 + 整库兜底。
- **默认③｜发送时匹配一次**：不做输入实时匹配。

## 验收标准

1. 点「写方案」卡：**不弹 dialog**，直接进对话且 composer 已预填引导模板、焦点在编辑器。
2. 发送范本那段话：内联 chip 显示「导诊系统、预问诊系统」（或库内实际匹配到的名）；`additionalDirectories` 收窄到这两个产品目录；AI 按三部分结构写、第 3 部分逐条、每段标来源、查不到标「⚠️ 资料缺失」。
3. 删除某个 chip：该产品从 store 移除，本次发送不再把它列入可读目录。
4. 发一段不含任何库内产品名的文本：不阻塞发送；fallback 整库；AI 仍能 Grep 定位。
5. `bun run typecheck` 全绿；仓库内无对 `ProductPickerDialog` 的残留引用。

## 风险与注意

- **匹配召回**：依赖目录命名能被口语名匹配到（「导诊」⊂「导诊系统」成立）。若库内产品名与口语差异大，会漏——有整库 fallback 兜底，且 chip 暴露了识别结果让用户即时发现。
- **warm-spawn 收窄失效**：warm 路径 `additionalDirectories` 收窄不了，靠注入提示词点名 + 当前 `bypassPermissions` 兜底。与关联 spec 的 warm-spawn 修复保持一致，不回退那套机制。
- **多产品检索噪音**：收窄到多个产品目录是好事（精准），真正的整库 fallback 只在零命中时发生。
- **IPC 四处同改**：漏一处 typecheck 当场报错，按 CLAUDE.md 流程逐处改。
