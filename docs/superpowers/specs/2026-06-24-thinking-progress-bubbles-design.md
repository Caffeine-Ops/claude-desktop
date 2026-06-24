# 思考过程：百分比进度条 + 分步对话气泡

> 状态：设计已确认，待 review → 进入实现计划
> 日期：2026-06-24
> 范围：普通聊天的"思考过程"展现（extended thinking），不含方案生成

## 1. 目标

把普通聊天里 AI 的扩展思考（extended thinking）从现在的"单块可折叠卡片"改为：

1. **顶部一条带百分比的进度条**——反映思考的真实推进度。
2. **思考流切成多条小气泡逐条冒出**——按段落切分，像 AI 在逐句口述思路，而不是塞进一张折叠卡。

## 2. 现状（改之前的基线）

思考相关有两块，互相独立：

- **思考前的空档**：`ThinkingSpinner.tsx`（挂在 assistant-ui `MessagePrimitive.Parts` 的 `Empty` slot），显示 `✻ Cogitating… (12s · esc to interrupt)`——动词 + 已用秒数，**无百分比**。本设计**不动它**。
- **思考内容**：扩展思考是真实流式的。Anthropic API 通过 `content_block_delta.thinking_delta` 流出文本 → `engine.ts` 转成 `ChatEvent.thinking_delta` → `FusionRuntimeProvider` 调 `chat` store 的 `appendReasoning` → 累积进 assistant 消息的一个 `reasoning` part → `ThreadView.tsx` 的 `ReasoningCard`（约 1093 行起）渲染成单块可折叠卡（流式自动展开"正在思考…"，结束折叠成"思考过程 · N 字"）。

**关键技术现实**：LLM 思考没有天然的"完成百分比"，API 不吐进度。要做*真*进度，唯一来源是 token 预算——`已生成 thinking token / 预算上限`。

## 3. 设计

### 3.1 数据流：复用现有链路，不新增 IPC

整个特性在两处落地，**不新增任何 IPC 通道或 ChatEvent 类型**：

- **分母（budget）**在 main 侧通过 env 设给 CLI；
- **分子（实时进度）+ 切气泡 + 进度条**全在 renderer 的 `ReasoningCard` 内计算与渲染。

数据源唯一：reasoning part 的累积全文。

### 3.2 分母 / 思考预算

`src/shared/` 新增常量：

```ts
// shared 单一真相源——main 注入 env 与 renderer 算百分比都引用它，杜绝两处漂移。
export const THINKING_TOKEN_BUDGET = 8000
// 流式过程拿不到官方实时 thinking token 数，用字符数估算：中文/英文混合下
// 经验系数约 3.5 字符 ≈ 1 token。偏大估计（分子保守）→ 进度条不会虚高冲顶。
export const CHARS_PER_THINKING_TOKEN = 3.5
```

`engine.ts` 的 `openSession` 在构造子进程 `env` 时加一行（沿用现有"尊重父进程覆盖"约定）：

```ts
// 给思考钉一个 token 预算上限，作为进度条的分母。这是做"真进度"的代价：
// 思考超过该预算会被 CLI 截断。尊重父进程显式覆盖。
MAX_THINKING_TOKENS: process.env.MAX_THINKING_TOKENS ?? String(THINKING_TOKEN_BUDGET),
```

`MAX_THINKING_TOKENS` 是 Claude Code / fusion-code CLI 既有的环境变量；实现阶段需先验证 bundled backend 确实读取它（见 §6 风险）。

### 3.3 分子 / 实时百分比（renderer）

`ReasoningCard` 内，基于已累积的 reasoning 文本：

```ts
const estTokens = trimmedText.length / CHARS_PER_THINKING_TOKEN
// 流式中封顶 99%——避免估算误差把条冲到 100% 后还在写；thinking_end 落地
// （isStreaming 变 false）后才允许跳 100%。
const pct = isStreaming
  ? Math.min(99, Math.round((estTokens / THINKING_TOKEN_BUDGET) * 100))
  : 100
```

百分比与进度条只在思考流式期间（`isStreaming`）展示；结束后进度条消失，回到摘要行。

### 3.4 切气泡（renderer）

`ReasoningCard` 从"单块卡"重构为"进度条 + 气泡列表"：

- 把 `trimmedText` 按 `\n\n`（段落）切成数组，逐段渲染为独立小气泡，顺序排列。
- **为什么按段落切**：思考流是增量到达的连续文本，段落（双换行）是其中最自然、最稳健的"一步"边界——能边流边增量封条（前 N-1 段已定，最后一段随 delta 增长），不需要等流结束、也不依赖脆弱的句子/标题解析。
- 最后一段（流式未完成那段）带"正在写"光标指示。
- 顶部一行：`○ 思考中 {pct}%` + 进度条（沿用 TodoRow / 现有进度条的视觉语言）。

### 3.5 结束后的收起行为

思考结束（`isStreaming` 变 false）后：

- 进度条 + 气泡列表折叠成一行摘要"思考过程 · N 字"（沿用现有 `ReasoningCard` 的折叠交互与 `userToggled` 逻辑）。
- 点击重新展开为多气泡列表。
- 理由：避免历史消息被一长串思考气泡永久占满版面。

## 4. 改动范围

| 文件 | 改动 |
| --- | --- |
| `src/shared/`（proposal.ts 同级，新增或并入一个常量文件） | 新增 `THINKING_TOKEN_BUDGET`、`CHARS_PER_THINKING_TOKEN` |
| `src/main/core/engine.ts` `openSession` | 子进程 env 加 `MAX_THINKING_TOKENS`（一行，尊重父覆盖） |
| `src/renderer/src/components/chat/ThreadView.tsx` `ReasoningCard` | 单块卡 → 进度条 + 多气泡列表；新增百分比/段落切分逻辑 |

实现路径：**纯 renderer 计算**（路径 1）。budget 经 shared 常量在 main/renderer 间保持单一真相源，分子与渲染全在 renderer。相比"main 计算后经事件下发"省去新增 IPC/事件类型的复杂度。

## 5. 不做（YAGNI）

- 不动 `ThinkingSpinner`（思考前空档那行保持原样）。
- 不新增 IPC 通道 / ChatEvent 类型。
- budget 暂不做成 UI 可配，先用 shared 常量（`MAX_THINKING_TOKENS` env 仍可被父进程覆盖，留了手动调的口子）。
- 不做方案生成（proposal）场景——本特性只覆盖普通聊天思考。

## 6. 风险 / 待实现阶段验证

- **`MAX_THINKING_TOKENS` 是否被 bundled fusion-code 读取并生效**：实现首步先验证；若 CLI 不认这个 env，分母失去意义，需退回到"估算固定 budget"或改用伪进度——这是整个真进度方案的硬前提。
- **字符→token 系数**：3.5 是经验值，中英文混合会有偏差；因封顶 99%，偏差只影响进度条走速，不会冲顶失真。
- **预算截断**：8000 token 上限可能截断超长思考。8000 对绝大多数对话足够；偏大更安全但进度条走得慢。值集中在 shared 常量，调整成本低。

## 7. 验收

- 普通聊天触发思考时：思考内容按段落分成多条气泡逐条冒出，顶部进度条随思考推进平滑前进（流式封顶 99%）。
- 思考结束：进度条到 100% 后折叠成"思考过程 · N 字"一行，可点开重新展开为多气泡。
- `ThinkingSpinner`（思考前空档）行为不变。
- `bun run typecheck` 通过。
