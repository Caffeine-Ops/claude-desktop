# 思考过程：百分比进度条 + 分步气泡 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把普通聊天的扩展思考从"单块折叠卡"改为"顶部百分比进度条 + 思考流按段落切成多条小气泡逐条冒出"。

**Architecture:** 复用现有 `thinking_delta → reasoning part → ReasoningCard` 链路，不新增 IPC/事件。分母（思考 token 预算）由 main 经 `MAX_THINKING_TOKENS` env 设给 CLI，分子由 renderer 用累积思考字符数估算，百分比与气泡渲染全在 `ReasoningCard` 内。budget 集中在 `shared/` 常量做单一真相源。

**Tech Stack:** Electron + electron-vite；React 19 + Tailwind + motion/react；assistant-ui primitives；bun；TypeScript composite。

## Global Constraints

- 包管理器是 **bun**，不是 npm。
- 唯一自动化质量门是 `bun run typecheck`（跑 `tsc -p node` + `tsc -p web`）。**项目无单元测试、无 ESLint**——故本计划不引入测试框架，每个任务以 typecheck 通过 + `bun run dev` 手动观察验收（用户项目约定优先于默认 TDD）。
- renderer 禁止直接 import Node 模块；shared 常量是纯 TS，main 与 renderer 均可 import。
- `shared/` 模块在 main 用相对路径 `../../shared/<name>`，在 renderer（`components/chat/`）用 `../../../../shared/<name>`。
- env 注入一律**尊重父进程覆盖**（`process.env.X ?? 默认值`），沿用 `engine.ts` openSession 既有约定。
- 不动 `ThinkingSpinner`（思考前空档那行）；不新增 IPC 通道 / ChatEvent 类型。

---

## File Structure

- **Create** `apps/desktop/src/shared/thinking.ts` — 思考进度的两个常量（budget + 字符→token 系数），单一真相源。
- **Modify** `apps/desktop/src/main/core/engine.ts` — openSession 的子进程 `env` 块注入 `MAX_THINKING_TOKENS`。
- **Modify** `apps/desktop/src/renderer/src/components/chat/ThreadView.tsx` — `ReasoningCard`（~1093–1211）从单块折叠卡重构为"进度条 + 多气泡列表"。

---

## Task 1: 思考预算管线（分母）

**Files:**
- Create: `apps/desktop/src/shared/thinking.ts`
- Modify: `apps/desktop/src/main/core/engine.ts`（顶部 import 区 + openSession 的 `env:` 块，~1418–1448）

**Interfaces:**
- Produces: `THINKING_TOKEN_BUDGET: number`、`CHARS_PER_THINKING_TOKEN: number`（Task 2 消费）。
- Produces（运行时）：bundled / system 两种 backend 的子进程都带上 `MAX_THINKING_TOKENS` env。

- [ ] **Step 1: 新建 shared 常量文件**

创建 `apps/desktop/src/shared/thinking.ts`：

```ts
/**
 * 思考进度条的单一真相源。
 * main（engine.ts openSession）用 THINKING_TOKEN_BUDGET 注入 MAX_THINKING_TOKENS
 * env 作为分母上限；renderer（ReasoningCard）用同一常量算百分比。两处引用同一
 * 来源，杜绝分母漂移。
 */
export const THINKING_TOKEN_BUDGET = 8000

/**
 * 流式过程拿不到官方实时 thinking token 数，只能用已累积的思考字符数估算：
 * 中英文混合的经验值约 3.5 字符 ≈ 1 token。取偏大系数 → 估出的 token（分子）
 * 偏保守 → 进度条不会虚高冲顶。
 */
export const CHARS_PER_THINKING_TOKEN = 3.5
```

- [ ] **Step 2: engine.ts 顶部 import 常量**

在 `engine.ts` 的 shared import 区（`../../shared/types` 那一组附近）加：

```ts
import { THINKING_TOKEN_BUDGET } from '../../shared/thinking'
```

- [ ] **Step 3: 两个 backend 分支的 env 块各注入 MAX_THINKING_TOKENS**

在 openSession 的 `env: (backend === 'bundled' ? {...} : {...})` 块里。

bundled 分支（紧跟 `ENABLE_TOOL_SEARCH: ...` 之后）加：

```ts
            // 给扩展思考钉一个 token 预算上限，作为思考进度条的分母。
            // 这是做"真进度"的代价：思考超过该预算会被 CLI 截断。尊重用户
            // 在自己 shell 里导出的覆盖。值与 renderer 算百分比共用 shared 常量。
            MAX_THINKING_TOKENS:
              process.env.MAX_THINKING_TOKENS ?? String(THINKING_TOKEN_BUDGET),
```

system 分支（`...systemBackendEnv(),` 之后、PPT_MASTER 段之前）加同样一行：

```ts
            MAX_THINKING_TOKENS:
              process.env.MAX_THINKING_TOKENS ?? String(THINKING_TOKEN_BUDGET),
```

- [ ] **Step 4: typecheck**

Run: `bun run typecheck`
Expected: PASS（无类型错误；新 import 与常量被正确解析）。

- [ ] **Step 5: 验证 MAX_THINKING_TOKENS 真的被 CLI 读取（spec §6 硬前提）**

这是整个真进度方案能否成立的前提，必须实测，不能假设。

临时把 `THINKING_TOKEN_BUDGET` 改成一个很小的值（如 `512`），然后：

Run: `bun run dev`
操作：开一个对话，问一个会触发明显思考的问题（如"分几步推理：一个三位数各位数字之和为 12 且是 7 的倍数，最大是多少？"）。
Expected: 思考内容明显比平时短（被 512 token 截断）。再把常量改回 `8000`，思考恢复正常长度。

- 若思考长度对该 env **毫无变化** → CLI 不读 `MAX_THINKING_TOKENS`，分母失效。**停下，回报**：需改用伪进度（基于时间）或换 SDK option，方案要调整。不要带着失效的分母继续 Task 2。
- 改回 `8000` 后再继续。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/thinking.ts apps/desktop/src/main/core/engine.ts
git commit -m "feat(thinking): 注入 MAX_THINKING_TOKENS 预算作为思考进度条分母"
```

---

## Task 2: ReasoningCard 重构为进度条 + 多气泡

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/chat/ThreadView.tsx`（`ReasoningCard` 函数体，~1093–1211；顶部 import 区）

**Interfaces:**
- Consumes: `THINKING_TOKEN_BUDGET`、`CHARS_PER_THINKING_TOKEN`（Task 1）；现有 `ShimmerText`（同文件 ~1259）、`REASONING_PLACEHOLDER`（已 import）、`useState`、`AnimatePresence`/`motion`（已 import）。
- 不改 `ReasoningCard` 的 props 签名 `{ text, status }`，故 `MessagePrimitive.Parts` 的 `Reasoning: ReasoningCard` 接线（~774）无需动。

- [ ] **Step 1: import 常量**

在 ThreadView.tsx 顶部、`import { REASONING_PLACEHOLDER, useChatStore } from '../../stores/chat'` 附近加：

```ts
import { THINKING_TOKEN_BUDGET, CHARS_PER_THINKING_TOKEN } from '../../../../shared/thinking'
```

- [ ] **Step 2: 替换 ReasoningCard 函数体**

把现有 `ReasoningCard`（`function ReasoningCard({ text, status }... )` 到其结尾 `}`，约 1093–1211 行）整体替换为下面版本。改动点：①新增 `paragraphs`（按 `\n{2,}` 切段）、`estTokens`、`pct`；②按钮行流式态改为"思考中 + 百分比 + 进度条"；③body 由单个 `<pre>` 改为多气泡列表，末段流式时带光标。其余（dot 指示、open/userToggled 折叠逻辑、结束折叠成"思考过程 · N 字"、外层布局）保持不变。

```tsx
function ReasoningCard({
  text,
  status
}: {
  text: string
  status?: { type: string }
}): React.JSX.Element {
  const isStreaming = status?.type === 'running'
  const displayText = text.replace(REASONING_PLACEHOLDER, '')
  const trimmedText = displayText.trim()
  const hasText = trimmedText.length > 0
  const [userToggled, setUserToggled] = useState<boolean | null>(null)
  const open = hasText && (userToggled ?? isStreaming)
  const charCount = trimmedText.length

  // 思考流按段落（双换行）切成"一步一气泡"。段落是流式增量文本里最自然、
  // 最稳健的步边界——前 N-1 段已定，最后一段随 delta 增长。空段过滤掉。
  // 注：engine 把多个 thinking block 之间也用空行拼接，故此切法对单/多块一致。
  const paragraphs = trimmedText
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  // 真分母（MAX_THINKING_TOKENS 预算，shared 常量）+ 估分子（已累积字符 ÷ 系数）。
  // 流式中封顶 99%，避免估算误差把条冲到 100% 后还在写；thinking_end 落地
  // （isStreaming 变 false）后才允许 100%。
  const estTokens = trimmedText.length / CHARS_PER_THINKING_TOKEN
  const pct = isStreaming
    ? Math.min(99, Math.round((estTokens / THINKING_TOKEN_BUDGET) * 100))
    : 100

  return (
    <div className="flex w-full gap-3">
      <span
        aria-hidden
        className="mt-[7px] flex size-[6px] shrink-0 items-center justify-center"
      >
        <span
          className={
            'block size-[6px] rounded-full ' +
            (isStreaming ? 'bg-accent' : 'bg-emerald-500')
          }
        />
      </span>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => hasText && setUserToggled(!open)}
          aria-expanded={open}
          disabled={!hasText}
          className={
            'group/reason flex w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[12px] text-muted-foreground transition-colors ' +
            (hasText ? 'hover:text-foreground' : 'cursor-default')
          }
        >
          {hasText && (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={
                'shrink-0 transition-transform ' + (open ? 'rotate-90' : '')
              }
              aria-hidden
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          )}
          {isStreaming ? (
            <>
              <ShimmerText>思考中</ShimmerText>
              <span className="ml-1 tabular-nums text-[11px] text-muted-foreground/70">
                {pct}%
              </span>
              {/* 进度条：细长胶囊，沿用 accent 作为"进行中"色，与思考点一致。 */}
              <span
                className="ml-1.5 inline-block h-1 w-16 overflow-hidden rounded-full bg-muted-foreground/20"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span
                  className="block h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </span>
            </>
          ) : (
            <>
              <span className="font-medium tracking-tight">思考过程</span>
              {hasText && (
                <span className="text-[11px] text-muted-foreground/60">
                  · {charCount} 字
                </span>
              )}
            </>
          )}
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="reasoning-body"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              {/* 多气泡列表：每段思考一条独立气泡，顺序排列，像 AI 逐句口述
                  思路。末段在流式中带一个脉冲光标，表示"正在写这一条"。 */}
              <div className="mt-1.5 flex flex-col gap-1.5">
                {paragraphs.map((para, i) => {
                  const writing = isStreaming && i === paragraphs.length - 1
                  return (
                    <div
                      key={i}
                      className="rounded-apple-lg bg-muted px-4 py-2.5 text-[13px] leading-[1.47] tracking-apple-micro text-muted-foreground"
                    >
                      <pre className="whitespace-pre-wrap break-words font-sans">
                        {para}
                        {writing && (
                          <span
                            aria-hidden
                            className="ml-0.5 inline-block animate-pulse text-accent"
                          >
                            ●
                          </span>
                        )}
                      </pre>
                    </div>
                  )
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: typecheck**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 4: 手动验收（bun run dev）**

Run: `bun run dev`
操作：开对话，问一个会触发较长思考的问题。
Expected：
1. 思考时按钮行显示 `思考中 NN%` + 进度条，进度条随思考推进平滑前进，流式期间封顶 99%。
2. 思考区是多条小气泡逐条出现（不是一整块），末条带脉冲光标。
3. 思考结束：进度条/百分比消失，折叠成一行 `思考过程 · N 字`；点击该行可重新展开为多气泡，再点收起。
4. `ThinkingSpinner`（首个 part 到达前的 `✻ … (Ns · esc to interrupt)`）行为与改动前一致。

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/chat/ThreadView.tsx
git commit -m "feat(thinking): 思考卡重做为百分比进度条 + 分步对话气泡"
```

---

## Self-Review

**Spec coverage:**
- §3.2 分母/budget → Task 1 Step 1/3（shared 常量 + 两分支 env 注入）。✓
- §3.3 分子/百分比（封顶 99%、结束 100%）→ Task 2 Step 2（`estTokens`/`pct`）。✓
- §3.4 按段落切气泡、末段光标、顶部进度条 → Task 2 Step 2（`paragraphs` + 气泡列表 + 进度条）。✓
- §3.5 结束折叠成一行、可点开 → Task 2 Step 2（保留 `open`/`userToggled` + 非流式态 label）。✓
- §4 改动范围三处文件 → 与 File Structure 一致。✓
- §5 不动 ThinkingSpinner / 不新增 IPC → 计划未触碰它们；ReasoningCard props 签名不变。✓
- §6 硬前提（MAX_THINKING_TOKENS 是否生效）→ Task 1 Step 5 专门实测并给出失败回退指引。✓
- §7 验收 → Task 2 Step 4 逐条对应。✓

**Placeholder scan:** 无 TBD/TODO；每个代码步骤含完整可粘贴代码。✓

**Type consistency:** `THINKING_TOKEN_BUDGET`/`CHARS_PER_THINKING_TOKEN` 在 Task 1 定义、Task 2 消费，名称一致；`ReasoningCard({ text, status })` 签名跨任务不变。✓
