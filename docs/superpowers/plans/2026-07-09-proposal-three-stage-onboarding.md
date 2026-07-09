# 写方案·三阶段上手引导 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给写方案功能加一套轻量上手引导——新用户第一次进来看到「封面→目录→正文，每步要确认」的开场说明卡，过程中每张确认卡上有一行「为什么停在这」的固定说明。

**Architecture:** 纯渲染层，零新 IPC / 零 schema。两个组件：①开场空状态说明卡（一次性，localStorage 门控）；②过程常驻提示（2a 确认卡说明行 + 2b stepper 文案）。过程说明由前端**确定性渲染**，复用 shared 里抽出的 `identifyProposalStageConfirm` 识别阶段，不依赖 AI 措辞。

**Tech Stack:** React 19 + Tailwind v4（shadcn 原语）+ zustand；`bun test` 测纯函数；`bun run typecheck` 是唯一自动化门。

## Global Constraints

- 包管理器是 **bun**，不是 npm。测试命令 `bun test electron/ src/chat/lib`（只扫这两处，测试文件必须落在其中）。
- 样式在 `.chat-app` 下（chat 链，shadcn/Tailwind v4）：用 shadcn 原语 + utility class，**不写裸 `<button>`/`<input>`**（会被 canvas reset 填成描边卡片），不碰 canvas 的 `--od-*` token。品牌绿身份色用 `--brand`（不随用户主题），非该场景用 `--accent`。
- 渲染层运行时消费 shared 函数走 `@desktop-shared/proposal` 别名（已有先例：`src/chat/lib/proposalStageConfirm.ts:1`）。
- localStorage 读写一律 try/catch 降级，失败不致命（先例：`src/chat/stores/proposalStyle.ts:21-41`）。
- 每个 commit message 结尾附：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 当前分支 `feat/kb-port-to-studio`，非默认分支，无需再开分支。工作目录 `apps/studio`。

---

### Task 1: `identifyProposalStageConfirm` 阶段识别纯函数（shared）

抽一个「认卡」纯函数：给 AskUserQuestion 的 input，判断它是不是封面/目录确认卡（**不要求用户已作答**，比 `decideProposalStageConfirm` 更早一步）。放 shared 供确认卡渲染消费。

**Files:**
- Modify: `apps/studio/electron/shared/proposal.ts`（在 `decideProposalStageConfirm`（`:56`）之后追加新函数；复用同文件已有常量 `PROPOSAL_COVER_CONFIRM_HEADER`/`PROPOSAL_TOC_CONFIRM_HEADER`（`:41-42`））
- Test: `apps/studio/electron/shared/proposal.test.ts`（已存在，追加一个 describe 块）

**Interfaces:**
- Produces: `identifyProposalStageConfirm(input: unknown): 'cover' | 'toc' | null` —— Task 4 消费。

- [ ] **Step 1: 写失败测试**

在 `apps/studio/electron/shared/proposal.test.ts` 末尾追加（文件顶部若尚未 import 这两个符号，把 `identifyProposalStageConfirm` 加进现有从 `'./proposal'` 的 import；`PROPOSAL_*_CONFIRM_HEADER` 常量测试里用字面量即可，不必 import）：

```ts
import { identifyProposalStageConfirm } from './proposal'

describe('identifyProposalStageConfirm', () => {
  const coverInput = { questions: [{ header: '封面确认', question: '封面 OK 吗？', options: [{ label: '确认封面，继续' }] }] }
  const tocInput = { questions: [{ header: '目录确认', question: '目录 OK 吗？', options: [{ label: '确认目录，开始撰写正文' }] }] }

  it('封面确认卡 → cover', () => {
    expect(identifyProposalStageConfirm(coverInput)).toBe('cover')
  })
  it('目录确认卡 → toc', () => {
    expect(identifyProposalStageConfirm(tocInput)).toBe('toc')
  })
  it('普通 AskUserQuestion（非阶段卡）→ null', () => {
    const other = { questions: [{ header: '选个方向', question: '哪个？', options: [{ label: 'A' }] }] }
    expect(identifyProposalStageConfirm(other)).toBeNull()
  })
  it('畸形 input → null（不抛）', () => {
    expect(identifyProposalStageConfirm(null)).toBeNull()
    expect(identifyProposalStageConfirm({})).toBeNull()
    expect(identifyProposalStageConfirm({ questions: 'nope' })).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test electron/shared/proposal.test.ts`
Expected: FAIL —— `identifyProposalStageConfirm is not a function` / import 报错。

- [ ] **Step 3: 写最小实现**

在 `apps/studio/electron/shared/proposal.ts` 的 `decideProposalStageConfirm` 函数结束（`:86` 的 `}` 之后）追加：

```ts
/**
 * 纯函数：判断一张 AskUserQuestion 卡是不是【方案阶段确认卡】，是则返回是哪一阶段。
 * 与 decideProposalStageConfirm 的区别：那个判「用户点完放行项后该往哪走」（需要 answers），
 * 本函数只认「这是封面/目录确认卡」——用户还没作答就能识别，供确认卡渲染时钉说明行用。
 * 只硬编码 header 常量（提示词据此填值，可靠）；放行项文案一概不管。toc 优先于 cover。
 */
export function identifyProposalStageConfirm(input: unknown): 'cover' | 'toc' | null {
  if (!input || typeof input !== 'object') return null
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return null
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const header = (q as Record<string, unknown>).header
    if (header === PROPOSAL_TOC_CONFIRM_HEADER) return 'toc'
    if (header === PROPOSAL_COVER_CONFIRM_HEADER) return 'cover'
  }
  return null
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && bun test electron/shared/proposal.test.ts`
Expected: PASS（含新增 4 个 it）。

- [ ] **Step 5: typecheck + commit**

Run: `cd apps/studio && bun run typecheck`
Expected: exit 0。

```bash
git add apps/studio/electron/shared/proposal.ts apps/studio/electron/shared/proposal.test.ts
git commit -m "$(cat <<'EOF'
feat(proposal): identifyProposalStageConfirm 认卡纯函数——识别封面/目录确认卡供上手引导用

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 开场引导的状态与判定（renderer lib）

一个 renderer-only 小模块：localStorage 存「看过没」标记 + 一个判定纯函数。

**Files:**
- Create: `apps/studio/src/chat/lib/proposalOnboarding.ts`
- Test: `apps/studio/src/chat/lib/proposalOnboarding.test.ts`

**Interfaces:**
- Produces（Task 3 消费）：
  - `hasSeenProposalOnboarding(): boolean`
  - `markProposalOnboardingSeen(): void`
  - `shouldShowProposalOnboarding(seen: boolean, sectionsEmpty: boolean): boolean`

- [ ] **Step 1: 写失败测试**

Create `apps/studio/src/chat/lib/proposalOnboarding.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'
import { shouldShowProposalOnboarding } from './proposalOnboarding'

describe('shouldShowProposalOnboarding', () => {
  it('没看过 + 草稿为空 → 显示', () => {
    expect(shouldShowProposalOnboarding(false, true)).toBe(true)
  })
  it('没看过 + 草稿有内容 → 不显示（被内容替换）', () => {
    expect(shouldShowProposalOnboarding(false, false)).toBe(false)
  })
  it('看过 + 草稿为空 → 不显示（老用户不打扰）', () => {
    expect(shouldShowProposalOnboarding(true, true)).toBe(false)
  })
  it('看过 + 草稿有内容 → 不显示', () => {
    expect(shouldShowProposalOnboarding(true, false)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && bun test src/chat/lib/proposalOnboarding.test.ts`
Expected: FAIL —— 模块不存在 / 导入报错。

- [ ] **Step 3: 写最小实现**

Create `apps/studio/src/chat/lib/proposalOnboarding.ts`：

```ts
/**
 * 写方案「三阶段上手引导」的状态与判定。
 *
 * 开场空状态说明卡是【一次性】的：新用户第一次进来看一次，学会（草稿长出内容）或手动
 * 「知道了」后置位，此后再开空草稿也不再出现。标记跨会话持久到 localStorage——沿用
 * proposalStyle.ts / workspace.ts 的既有模式，不惊动主进程、不新增 IPC。
 */
const STORAGE_KEY = 'proposal-onboarding-seen-v1'

/** 读「是否已看过开场引导」。localStorage 不可用 → 当作没看过（fail-open 到「帮到人」）。 */
export function hasSeenProposalOnboarding(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** 置位「已看过」。持久化失败（隐私模式/配额）不致命：本次会话内引导已消失，下次再显示一次。 */
export function markProposalOnboardingSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // no-op
  }
}

/** 纯判定：没看过【且】草稿为空时才显示开场卡。逻辑与视图分离，供渲染层消费。 */
export function shouldShowProposalOnboarding(seen: boolean, sectionsEmpty: boolean): boolean {
  return !seen && sectionsEmpty
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && bun test src/chat/lib/proposalOnboarding.test.ts`
Expected: PASS（4 个 it）。

- [ ] **Step 5: typecheck + commit**

Run: `cd apps/studio && bun run typecheck`
Expected: exit 0。

```bash
git add apps/studio/src/chat/lib/proposalOnboarding.ts apps/studio/src/chat/lib/proposalOnboarding.test.ts
git commit -m "$(cat <<'EOF'
feat(proposal): 开场引导状态模块——localStorage 一次性标记 + shouldShow 纯判定

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 开场空状态说明卡（组件一）

草稿为空且未看过时，在文档面板正文区渲染「写方案分三步走」说明卡；草稿长出内容或点「知道了」即置位、消失。

**Files:**
- Modify: `apps/studio/src/chat/components/workspace/ProposalDocPanel.tsx`
  - import 区（顶部，`:1-20` 附近）
  - 组件体加 state/effect（`badge` 计算之后，`:106` 附近）
  - 正文区渲染（`:870-875` 两个 mode div 处）

**Interfaces:**
- Consumes: `hasSeenProposalOnboarding` / `markProposalOnboardingSeen` / `shouldShowProposalOnboarding`（Task 2）。

- [ ] **Step 1: 加 import**

在 `ProposalDocPanel.tsx` import 区（挨着其它 `../../lib/*` import，如 `:19-20` 的 ProposalPaper/Preview 之上或之下）加：

```ts
import {
  hasSeenProposalOnboarding,
  markProposalOnboardingSeen,
  shouldShowProposalOnboarding
} from '../../lib/proposalOnboarding'
```

顶部若无 `useEffect`/`useState` 请确认已从 react 引入（文件已用 `useState`，见 `:110`；`useEffect` 已在用，见 `:182`）。

- [ ] **Step 2: 加 state + 派生 + 置位 effect**

在 `badge` 计算块之后（`:106` 那行 `null` 结束之后）插入：

```ts
  // 开场上手引导（一次性）：草稿为空且没看过时显示「三步走」说明卡。用户发出首条需求、
  // 草稿长出内容（sections 非空）即视为「走过一次」，自动置位；也可点卡上「知道了」手动关。
  // 置位后再开空草稿也不再出现（老用户不打扰）。onboardingSeen 初值读 localStorage。
  const [onboardingSeen, setOnboardingSeen] = useState(hasSeenProposalOnboarding)
  const showOnboarding = shouldShowProposalOnboarding(onboardingSeen, sections.length === 0)
  useEffect(() => {
    if (sections.length > 0 && !onboardingSeen) {
      markProposalOnboardingSeen()
      setOnboardingSeen(true)
    }
  }, [sections.length, onboardingSeen])
  const dismissOnboarding = (): void => {
    markProposalOnboardingSeen()
    setOnboardingSeen(true)
  }
```

- [ ] **Step 3: 改正文区渲染**

把 `:870-875` 现有的两个 mode div：

```tsx
      <div className={'flex min-h-0 flex-1 flex-col ' + (mode === 'edit' ? '' : 'hidden')}>
        <ProposalPaper />
      </div>
      <div className={'flex min-h-0 flex-1 flex-col ' + (mode === 'preview' ? '' : 'hidden')}>
        <ProposalPreview active={mode === 'preview'} />
      </div>
```

替换为（草稿为空+未看过时用说明卡顶替；有内容时才挂 Paper/Preview——空草稿本无缓存可留，故此处 unmount 不违反「预览常驻挂载」的初衷，那条不变量是为「有内容时来回切不重渲染」）：

```tsx
      {showOnboarding ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8">
          <div className="w-full max-w-xs rounded-2xl border border-border bg-card/60 p-6 text-[13px]">
            <div className="mb-4 flex items-center gap-2 text-[15px] font-semibold text-foreground">
              <span aria-hidden>📄</span> 写方案分三步走
            </div>
            <ol className="mb-4 space-y-1.5 text-muted-foreground">
              <li>① 封面 <span className="text-foreground/50">→ 你确认</span></li>
              <li>② 目录 <span className="text-foreground/50">→ 你确认</span></li>
              <li>③ 正文 <span className="text-foreground/50">→ 逐章生成</span></li>
            </ol>
            <p className="mb-3 text-muted-foreground">每步 AI 会停下来等你，点“确认”才继续。</p>
            <p className="mb-4 text-xs text-muted-foreground/70">↓ 在下方输入框描述你的方案需求</p>
            <button
              type="button"
              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={dismissOnboarding}
            >
              知道了
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className={'flex min-h-0 flex-1 flex-col ' + (mode === 'edit' ? '' : 'hidden')}>
            <ProposalPaper />
          </div>
          <div className={'flex min-h-0 flex-1 flex-col ' + (mode === 'preview' ? '' : 'hidden')}>
            <ProposalPreview active={mode === 'preview'} />
          </div>
        </>
      )}
```

- [ ] **Step 4: typecheck**

Run: `cd apps/studio && bun run typecheck`
Expected: exit 0（无未用变量 / 类型错误）。

- [ ] **Step 5: commit**

```bash
git add apps/studio/src/chat/components/workspace/ProposalDocPanel.tsx
git commit -m "$(cat <<'EOF'
feat(proposal): 开场空状态说明卡——草稿为空+未看过时显示三步走引导，一次性

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 确认卡「为什么停在这」说明行（组件 2a）

阶段确认卡（AskUserQuestion）上方钉一行前端写死的说明，讲清「这是哪一阶段确认、点了会怎样」。

**Files:**
- Modify: `apps/studio/src/chat/components/permissions/InlinePermissionPrompt.tsx`（import 区 `:1-10`；AskUserQuestion 分支 `:78-97`）

**Interfaces:**
- Consumes: `identifyProposalStageConfirm`（Task 1）。

- [ ] **Step 1: 加 import**

在 `InlinePermissionPrompt.tsx` import 区加（与 `:8` 的 `applyProposalStageConfirm` 并列）：

```ts
import { identifyProposalStageConfirm } from '@desktop-shared/proposal'
```

- [ ] **Step 2: 在 AskUserQuestion 分支渲染说明行**

把 `:78-97` 的 `if (isAskUserQuestion) { return (...) }` 整块替换为（新增 `stage` 识别 + 条件说明行，其余不动）：

```tsx
  if (isAskUserQuestion) {
    // 方案阶段确认卡：前端确定性识别（不靠 AI 措辞），钉一行说明讲清「为什么停、点了会怎样」。
    // 非阶段卡（普通 AskUserQuestion）→ stage=null → 不渲染说明行。
    const stage = identifyProposalStageConfirm(request.input)
    return (
      <div
        ref={containerRef}
        className="overflow-hidden rounded-2xl bg-muted/40 ring-1 ring-black/[0.06] dark:ring-white/[0.06]"
        aria-label={tf('permissionAriaLabel', { toolName: request.toolName })}
      >
        {stage && (
          <div className="border-b border-black/[0.06] bg-brand/5 px-3 py-2 text-[12px] leading-snug text-muted-foreground dark:border-white/[0.06]">
            <span aria-hidden>📄</span> 这是【{stage === 'cover' ? '封面确认' : '目录确认'}】。点“确认”后 AI 才会
            {stage === 'cover' ? '继续下一步：生成目录' : '开始逐章撰写正文'}。
          </div>
        )}
        <AskUserQuestionView
          input={request.input}
          onSubmit={(updatedInput) => {
            // 方案模式：用户点了「确认目录/封面」放行项时，先同步推进 phase（先于 AI
            // 回包的 end 过阶段门），再把答案回传给 AI。非方案场景下是 no-op。
            applyProposalStageConfirm(request.input, updatedInput.answers)
            void respond(request.requestId, 'allow-once', updatedInput)
          }}
          onCancel={() => void respond(request.requestId, 'deny')}
        />
      </div>
    )
  }
```

- [ ] **Step 3: typecheck**

Run: `cd apps/studio && bun run typecheck`
Expected: exit 0。

- [ ] **Step 4: commit**

```bash
git add apps/studio/src/chat/components/permissions/InlinePermissionPrompt.tsx
git commit -m "$(cat <<'EOF'
feat(proposal): 确认卡钉「为什么停在这」说明行——前端确定性识别封面/目录卡

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: stepper 状态文案更贴心（组件 2b）

现有「呼吸灯 badge」的 idle/wait 文案偏纯状态（'等待开始'/'目录待确认'），改成更有引导性的说法。**这是对现有 badge 文案的精化，不新增第二条状态文字**（比 spec §5.2 原写的「补一句」更 DRY——避免和 badge 重复；live 态保留现有 phase 专属文案，比通用说法更准，故不动）。

**Files:**
- Modify: `apps/studio/src/chat/components/workspace/ProposalDocPanel.tsx:97-106`（badge 计算）

- [ ] **Step 1: 改 idle/wait 文案**

把 `:97-106` 的 badge 计算：

```ts
  const badge: { text: string; tone: 'live' | 'wait' | 'idle' } | null = generating
    ? {
        text: phase === 'cover' ? '封面撰写中' : phase === 'toc' ? '目录整理中' : '正文撰写中',
        tone: 'live'
      }
    : sections.length === 0
      ? { text: '等待开始', tone: 'idle' }
      : phase === 'toc'
        ? { text: '目录待确认', tone: 'wait' }
        : null
```

改为（仅两处文案，逻辑不动）：

```ts
  const badge: { text: string; tone: 'live' | 'wait' | 'idle' } | null = generating
    ? {
        text: phase === 'cover' ? '封面撰写中' : phase === 'toc' ? '目录整理中' : '正文撰写中',
        tone: 'live'
      }
    : sections.length === 0
      ? { text: '描述需求即可开始', tone: 'idle' }
      : phase === 'toc'
        ? { text: '等你在聊天里确认', tone: 'wait' }
        : null
```

- [ ] **Step 2: typecheck**

Run: `cd apps/studio && bun run typecheck`
Expected: exit 0。

- [ ] **Step 3: commit**

```bash
git add apps/studio/src/chat/components/workspace/ProposalDocPanel.tsx
git commit -m "$(cat <<'EOF'
feat(proposal): stepper 状态文案更有引导性——'描述需求即可开始'/'等你在聊天里确认'

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 收尾：全量校验 + GUI 走查清单

- [ ] **全量 typecheck + 全量测试**

Run: `cd apps/studio && bun run typecheck && bun test electron/ src/chat/lib`
Expected: typecheck exit 0；测试全绿（含 Task 1/2 新增）。

- [ ] **GUI 走查（合并前唯一 gate，沙箱跑不了 Electron，须真机 `bun run dev`）**

  1. 清掉标记复现「新用户」：dev 里开 DevTools console 跑 `localStorage.removeItem('proposal-onboarding-seen-v1')`，或换全新 userData。
  2. 进写方案（底栏模式选「写方案」）→ 空草稿区应显示「写方案分三步走」说明卡。
  3. 发一条需求 → AI 生成封面 → 说明卡消失（内容替换）；确认卡上方出现「📄 这是【封面确认】。点"确认"后 AI 才会继续下一步：生成目录。」。
  4. 确认封面 → 进目录 → 目录确认卡上方出现「…【目录确认】…开始逐章撰写正文。」。
  5. 顶栏呼吸灯：空草稿灰点「描述需求即可开始」；目录待确认时琥珀「等你在聊天里确认」；生成中绿点「正文撰写中」。
  6. 重开一份空草稿 → 说明卡**不再出现**（标记已置位）。
  7. 重开一份有内容的旧草稿 → 直接显示草稿，无说明卡。

---

## Self-Review

**Spec coverage：**
- §4 开场空状态卡 → Task 2（状态/判定）+ Task 3（渲染/消失/置位）✓
- §4.3 localStorage 持久 + 降级 → Task 2 `hasSeen/markSeen` try/catch ✓
- §4.4 `shouldShowProposalOnboarding` 纯函数 + bun test → Task 2 ✓
- §5.1 确认卡说明行 + `identifyProposalStageConfirm` 抽函数 → Task 1（抽函数+test）+ Task 4（渲染）✓
- §5.2 stepper 文案 → Task 5（精化现有 badge，已在计划里注明对 spec「补一句」的 DRY 化偏离）✓
- §6 边界情形（旧草稿/老用户/localStorage 坏/非方案卡/正文阶段）→ Task 3 逻辑 + Task 4 `stage=null` 分支 + GUI 走查覆盖 ✓
- §7 测试 → 两个纯函数 bun test + typecheck + GUI 清单 ✓
- §8 涉及文件 → 与各 Task Files 一致（proposalOnboarding.ts 新增、ProposalDocPanel/InlinePermissionPrompt 改、proposal.ts 抽函数）✓

**Placeholder scan：** 无 TBD/TODO；每个改码步骤都给了完整代码块。✓

**Type consistency：** `identifyProposalStageConfirm(input: unknown): 'cover'|'toc'|null` 在 Task 1 定义、Task 4 按此签名消费；`shouldShowProposalOnboarding(seen, sectionsEmpty)`、`hasSeenProposalOnboarding()`、`markProposalOnboardingSeen()` 在 Task 2 定义、Task 3 按名消费；`badge` tone 联合类型 `'live'|'wait'|'idle'` 保持不变。✓
