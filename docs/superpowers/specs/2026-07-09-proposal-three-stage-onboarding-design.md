# 写方案·三阶段上手引导设计（Proposal Three-Stage Onboarding Guide）

日期：2026-07-09
状态：已评审（与用户逐项确认关键决策）
规模：S 偏 M（纯渲染层，零新 IPC / 零 schema 改动）
关联：
- `docs/superpowers/specs/2026-06-25-proposal-three-part-cover-toc-content-design.md`（三阶段生成总设计）
- `docs/superpowers/specs/2026-06-29-proposal-stage-confirm-via-askuserquestion-design.md`（阶段确认卡）
- `docs/superpowers/plans/2026-06-26-proposal-optimization-backlog.md`（backlog，本项编号 **P3-1**）

---

## 1. 背景与问题

写方案功能采用**三阶段生成**：封面 → 目录 → 正文，每完成一阶段 AI 会停下来弹一张 AskUserQuestion 确认卡，等用户点「确认」才推进下一步（阶段门用四层硬门保证不跳阶）。

问题：**这套节奏对新用户不可发现**。两个具体的困惑时刻：

- **开始前**：用户一进写方案就直接提需求，不知道会分封面 / 目录 / 正文三步走、每步都要自己确认。
- **过程中**：AI 生成完封面就停住、弹确认卡，用户不明白「为什么停了」「这张卡要我干嘛」「点了会怎样」。

现状里没有任何一处专门解释这套流程：草稿为空时面板是空白，确认卡的措辞由 AI 临场决定（不可靠），文档面板顶部虽有「呼吸灯 stepper」但没有文字说明。

目标：加一套**轻量、不打扰**的上手引导，把三阶段节奏在这两个时刻讲清楚。

## 2. 已确认的关键决策（与用户逐项对齐）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 覆盖哪个困惑时刻 | **两个都管**：开始前讲整体节奏 + 过程中就地解释每一步。 |
| 2 | 持久性 | **混合**：开场引导一次性（学会就消失，不打扰老用户）；过程中的说明常驻（很短、不啰嗦）。 |
| 3 | 开场引导形态 | **空状态说明卡**（非遮罩式 coach-marks / 多屏 tour）。草稿为空时在文档面板直接显示，不遮挡、不弹窗。 |

明确否决（YAGNI）：
- 不做遮罩式 coach-marks / 多屏 tour（重、打断，用户已否）。
- 不加后端配置、不加引导埋点（真要看效果以后再说）。
- 不碰阶段门 / 哨兵 / 生成逻辑——本设计纯加「装饰与说明」，不改任何行为。

## 3. 总体架构

两个新增能力，互不依赖，全部落在**渲染进程（renderer）**内，零新 IPC、零 schema 改动：

- **组件一：开场空状态说明卡**（一次性，localStorage 标记门控）。
- **组件二：过程常驻提示**（永远都在，前端确定性渲染，不依赖 AI 措辞）。
  - 2a：阶段确认卡上的「为什么停在这」一行（核心）。
  - 2b：stepper 状态一句话（轻量补强）。

关键设计原则（沿用本功能反复踩坑得出的教训）：**能写死就写死，不靠 AI 措辞**。审查中反复出现「软约束不可靠」——过程中的说明文案全部由前端确定性生成，AI 改不了、也漏不掉。

## 4. 组件一：开场空状态说明卡（一次性）

### 4.1 位置与触发
- 渲染在 `src/chat/components/workspace/ProposalDocPanel.tsx`（草稿主区域）。
- 触发条件：`sections` 为空 **且** localStorage 里 `proposal-onboarding-seen` 未置位。
- 内容（就是评审确认的那张卡）：

```
📄 写方案分三步走
  ① 封面  → 你确认
  ② 目录  → 你确认
  ③ 正文  → 逐章生成
每步 AI 会停下来等你，点"确认"才继续。
↓ 在下方输入框描述需求
```

### 4.2 消失时机（两种自然退场）
- （a）用户发出第一条需求、草稿开始长出内容（`sections` 非空）→ 卡被内容自然替换。
- （b）卡角一个「知道了」按钮，手动关闭。

任一发生即写 `proposal-onboarding-seen=true`。**此后再开空草稿也不再出现**（老用户不打扰）——这是「一次性」语义的落点。

> 为什么用「首次内容到达 / 手动关」双出口置位，而不是「发出第一条消息就置位」：用户可能发了消息但生成失败、草稿仍空，此时不该判定「已学会」，卡应继续在。以「草稿真的长出内容」为准更贴合「已经完整走过一次」的心智。

### 4.3 持久化
- 用 `localStorage`，key `proposal-onboarding-seen`（布尔）。
- 沿用项目现成模式：`stores/proposalStyle.ts`、`stores/workspace.ts`、`stores/composerMode.ts` 均用 localStorage 存这类跨会话小状态。**不惊动主进程、不新增 IPC。**
- 健壮性：localStorage 不可用 / JSON 损坏时，**默认「当作没看过、显示一次」**（向「帮到人」这边容错，与 `proposalStyle.ts` 读失败回默认同理）。

### 4.4 可测性
抽一个纯函数：

```ts
function shouldShowProposalOnboarding(seen: boolean, sectionsEmpty: boolean): boolean
```

用 bun test 覆盖四种组合（seen×sectionsEmpty）。渲染层只消费这个布尔，逻辑与视图分离。

## 5. 组件二：过程常驻提示（常驻，前端确定性渲染）

两处，都永远显示、都由前端写死文案（不靠 AI）：

### 5.1 组件 2a：确认卡上的「为什么停在这」一行（核心）
- 位置：`src/chat/components/permissions/InlinePermissionPrompt.tsx`（阶段确认卡就是内联渲染的权限提示卡）。
- 识别机制：用现成纯函数 `decideProposalStageConfirm(request.input, ...)`（`electron/shared/proposal.ts:56`）判断当前卡是不是方案阶段确认卡，并区分封面 / 目录。
  - 该函数只硬编码 header 常量（`封面确认` / `目录确认`，`proposal.ts:41-42`），放行项文案不硬编码——所以无论 AI 措辞如何都能确定性识别。**本设计正是复用它的这个能力。**
  - 注意：`decideProposalStageConfirm` 的返回是「用户已点放行项后该走哪」（advance-content / clear-only / none），用于**判定放行**；本处只需要「这是哪一阶段的确认卡」这个**更早的信号**。落地时可复用其 header 判定逻辑（识别封面 vs 目录），不要求用户已作答。实现计划需明确：或直接读 `input.questions[].header` 比对两个常量，或从 `decideProposalStageConfirm` 抽出一个 `identifyProposalStageConfirm(input): 'cover' | 'toc' | null` 纯函数供两处共用（推荐后者，避免在渲染层重复解析 input 结构）。
- 文案（前端写死，随封面 / 目录两态切换）：
  - 封面：`📄 这是【封面确认】。点"确认"后 AI 才会继续下一步：生成目录。`
  - 目录：`📄 这是【目录确认】。点"确认"后 AI 才会开始逐章撰写正文。`
- 渲染位置：卡片上方钉一行说明条，不改卡片本身的按钮 / 选项。

### 5.2 组件 2b：stepper 状态一句话（轻量补强）
- 位置：`ProposalDocPanel.tsx` 顶部已有的「呼吸灯 stepper」（live 绿 / wait 琥珀 / idle 灰，见 `ProposalDocPanel.tsx:285` 注释）。
- 给它补一句随态切换的说明文字：
  - idle（灰）：`描述需求即可开始`
  - wait（琥珀）：`等你在聊天里确认`
  - live（绿）：`AI 正在逐章写正文`
- 这三态已经在现有代码里算出来了，本项只是把状态映射到一句中文说明，纯展示。

## 6. 边界情形

| 场景 | 行为 |
|------|------|
| 重开一份已有内容的旧草稿 | `sections` 非空 → 开场卡不显示（正确）。 |
| 老用户新建空草稿 | 标记已置位 → 开场卡不显示（正确）。 |
| 用户不读卡、直接打字 | 卡非阻塞，内容到达后被自然替换。 |
| localStorage 不可用 / 损坏 | 开场卡默认显示一次（fail-open 到「帮到人」）。 |
| 确认卡不是方案阶段卡（普通权限请求） | `identify` 返回 null → 不加说明条（组件 2a 静默不介入）。 |
| 正文阶段（content）| 无更多确认卡（阶段门设计如此）→ 组件 2a 自然不再出现；stepper 显示 live 说明。 |

## 7. 测试

- `shouldShowProposalOnboarding` 纯函数：bun test 覆盖 seen×sectionsEmpty 四组合。
- `identifyProposalStageConfirm`（若抽出）：bun test 覆盖 封面 / 目录 / 非方案卡 / 畸形 input 四类。
- `bun run typecheck` 是唯一的自动化门（项目无 ESLint / 无单测框架之外的 gate），必须绿。
- GUI 走查（合并前 gate，沙箱跑不了 Electron）：新用户路径看开场卡出现→发需求→卡消失→标记置位→重开不再出现；确认卡出现时看到对应说明行；stepper 三态文字正确切换。

## 8. 涉及文件（预估）

- 新增：`src/chat/lib/proposalOnboarding.ts`（`shouldShowProposalOnboarding` + 可选 `identifyProposalStageConfirm`）+ 同名 `.test.ts`。
- 改：`src/chat/components/workspace/ProposalDocPanel.tsx`（空状态卡 + stepper 说明）。
- 改：`src/chat/components/permissions/InlinePermissionPrompt.tsx`（确认卡说明行）。
- 可能改：`electron/shared/proposal.ts`（若把 header 识别抽成 `identifyProposalStageConfirm` 纯函数供两处共用）。

样式遵循 CLAUDE.md 分层铁律：这几处都在 `.chat-app` 下（shadcn / Tailwind v4），用 shadcn 原语 + utility，不写裸元素、不碰 canvas 的 `--od-*` token。

## 9. 非目标（Out of Scope）

- 遮罩式引导 / 多屏 tour。
- 引导效果埋点、A/B。
- 对阶段门、哨兵、生成 / 校验 / 检索任何逻辑的改动。
- 其它模式（通用 / 设计 / 幻灯片 / 写作）的上手引导——本设计只服务写方案。
