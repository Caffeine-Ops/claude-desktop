# 写方案·阶段确认改为聊天内 AskUserQuestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉「写方案」右侧面板的两个阶段确认按钮（确认封面/确认目录），改由 AI 在左侧聊天用 AskUserQuestion 发起确认，用户点选后渲染层推进阶段。

**Architecture:** `toc→content` 阶段门原本靠右侧按钮调 `advancePhase('content')` 放行正文。改为：用户点选 AskUserQuestion 的「确认目录」放行项时，渲染层在 `InlinePermissionPrompt.onSubmit` 里同步推进 phase（先于 AI 流式吐正文、先于 `end` 过门，时序成立）。`cover→toc` 无需干预（AI 吐目录哨兵块时现有 `laterPhase` 自动推进，阶段门只拦 content）。判定用「固定 header 常量 + 首选项 label」双重匹配，纯决策逻辑下沉到 `shared/proposal.ts` 便于单测。

**Tech Stack:** Electron + React 19 + zustand + assistant-ui；bun 包管理；`bun test` 单测 + `bun run typecheck` 类型门。

## Global Constraints

- 包管理器是 **bun**，不是 npm。
- 质量门：`bun run typecheck`（CI 唯一自动门）+ `bun test src/`（已有 bun:test 基建）。**无 ESLint**。tsconfig 开启了 unused-locals 检查倾向，删除按钮后必须同步删除变为未引用的局部变量，否则 typecheck 失败。
- 全程中文文案；提示词、按钮、选项文案保持中文。
- header 常量值必须前后端一字不差：封面 = `封面确认`，目录 = `目录确认`。提示词里用模板字符串插值这两个常量，避免漂移。
- 放行项约定：阶段确认问题的 `options[0]`（第一个选项）永远是「放行/继续」项，修改类选项排其后。渲染层据此判定。
- 不改阶段门 / 去重 / 排序核心不变量（`gateDraftBlocksByPhase`、`sortSectionsByKind`、消息级/内容级去重）。
- 保留「重新生成目录」补救红条与 `regenerateToc()`、定向修订、补料续写等其它交互。
- 设计取舍：不再把已确认目录 markdown 回灌给 AI（旧 `confirmToc` 行为）。AI 基于自己刚生成的上下文续写正文。

---

### Task 1: shared/proposal.ts — header 常量 + 纯决策函数

**Files:**
- Modify: `apps/desktop/src/shared/proposal.ts`（在 `PROPOSAL_DRAFT_END` 定义后，约第 34 行之后插入）
- Test: `apps/desktop/src/shared/proposal.test.ts`

**Interfaces:**
- Produces:
  - `export const PROPOSAL_COVER_CONFIRM_HEADER = '封面确认'`
  - `export const PROPOSAL_TOC_CONFIRM_HEADER = '目录确认'`
  - `export type ProposalStageConfirm = 'advance-content' | 'clear-only' | 'none'`
  - `export function decideProposalStageConfirm(input: unknown, answers: Record<string, string>): ProposalStageConfirm`

- [ ] **Step 1: 写失败测试**

在 `apps/desktop/src/shared/proposal.test.ts` 顶部 import 块追加（与现有 `from './proposal'` 合并）：

```typescript
import {
  decideProposalStageConfirm,
  PROPOSAL_COVER_CONFIRM_HEADER,
  PROPOSAL_TOC_CONFIRM_HEADER
} from './proposal'
```

在文件末尾追加：

```typescript
describe('decideProposalStageConfirm', () => {
  const tocInput = (firstLabel: string): unknown => ({
    questions: [
      {
        question: '目录确认？',
        header: PROPOSAL_TOC_CONFIRM_HEADER,
        options: [{ label: firstLabel }, { label: '我要调整目录' }]
      }
    ]
  })

  it('目录确认·选放行项（首选项）→ advance-content', () => {
    expect(
      decideProposalStageConfirm(tocInput('确认目录，开始撰写正文'), {
        '目录确认？': '确认目录，开始撰写正文'
      })
    ).toBe('advance-content')
  })

  it('目录确认·选修改项 → none（不推进）', () => {
    expect(
      decideProposalStageConfirm(tocInput('确认目录，开始撰写正文'), {
        '目录确认？': '我要调整目录'
      })
    ).toBe('none')
  })

  it('封面确认·选放行项 → clear-only', () => {
    const input = {
      questions: [
        {
          question: '封面确认？',
          header: PROPOSAL_COVER_CONFIRM_HEADER,
          options: [{ label: '确认封面，生成目录' }, { label: '我要调整封面' }]
        }
      ]
    }
    expect(decideProposalStageConfirm(input, { '封面确认？': '确认封面，生成目录' })).toBe(
      'clear-only'
    )
  })

  it('非方案确认 header → none', () => {
    const input = {
      questions: [{ question: '随便问？', header: '其它', options: [{ label: 'A' }] }]
    }
    expect(decideProposalStageConfirm(input, { '随便问？': 'A' })).toBe('none')
  })

  it('畸形输入 → none', () => {
    expect(decideProposalStageConfirm(null, {})).toBe('none')
    expect(decideProposalStageConfirm({}, {})).toBe('none')
    expect(decideProposalStageConfirm({ questions: 'x' }, {})).toBe('none')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/desktop && bun test src/shared/proposal.test.ts`
Expected: FAIL —「decideProposalStageConfirm is not a function」/ 导入解析失败。

- [ ] **Step 3: 实现常量与决策函数**

在 `apps/desktop/src/shared/proposal.ts` 的 `PROPOSAL_DRAFT_END` 定义块（第 30-34 行）之后插入：

```typescript
// ── 阶段确认（聊天内 AskUserQuestion 驱动）─────────────────────────────
// 旧设计靠右侧面板按钮调 advancePhase 推进阶段；现改为 AI 在聊天里用 AskUserQuestion
// 发起确认，用户点选放行项时由渲染层推进。两个 header 是「确认问题」的身份标记：
// 提示词用它们填 AskUserQuestion 的 header，渲染层用它们识别「这是阶段确认、且选了放行项」。
// 值必须前后端一字不差，故集中定义在 shared。
export const PROPOSAL_COVER_CONFIRM_HEADER = '封面确认'
export const PROPOSAL_TOC_CONFIRM_HEADER = '目录确认'

// 决策结果：advance-content=推进到正文阶段（toc 确认放行）；clear-only=仅清跳阶提示
// （cover 确认放行）；none=不是阶段确认放行项，什么都不做。
export type ProposalStageConfirm = 'advance-content' | 'clear-only' | 'none'

/**
 * 纯函数：给定 AskUserQuestion 的原始 input 与用户答案 map（questionText→selectedLabel），
 * 判断是否命中「阶段确认放行」。判定 = header 命中两个确认常量之一 且 用户选中的 label
 * 恰等于该问题 options[0].label（放行项约定排首位）。toc 确认优先（命中即返回 advance-content）。
 *
 * 故意不硬编码放行项文案：放行项 label 取自同一份 input 的 options[0]，无论 AI 措辞如何，
 * 只要用户点的是首选项即匹配——唯一硬编码的是 header 常量（提示词据此填值，可靠）。
 */
export function decideProposalStageConfirm(
  input: unknown,
  answers: Record<string, string>
): ProposalStageConfirm {
  if (!input || typeof input !== 'object') return 'none'
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return 'none'
  let result: ProposalStageConfirm = 'none'
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const rq = q as Record<string, unknown>
    const header = typeof rq.header === 'string' ? rq.header : null
    const question = typeof rq.question === 'string' ? rq.question : null
    if (!header || !question) continue
    if (header !== PROPOSAL_COVER_CONFIRM_HEADER && header !== PROPOSAL_TOC_CONFIRM_HEADER)
      continue
    const opts = rq.options
    if (!Array.isArray(opts) || opts.length === 0) continue
    const first = opts[0]
    const proceedLabel =
      first && typeof first === 'object' && typeof (first as Record<string, unknown>).label === 'string'
        ? ((first as Record<string, unknown>).label as string)
        : null
    if (!proceedLabel) continue
    if (answers[question] !== proceedLabel) continue
    // 选了该确认问题的首选项（放行项）
    if (header === PROPOSAL_TOC_CONFIRM_HEADER) return 'advance-content'
    result = 'clear-only'
  }
  return result
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/desktop && bun test src/shared/proposal.test.ts`
Expected: PASS（含新增 5 个用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/shared/proposal.ts apps/desktop/src/shared/proposal.test.ts
git commit -m "feat(proposal): 阶段确认 header 常量 + decideProposalStageConfirm 纯决策

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 渲染层推进 — proposalStageConfirm lib + 接入 InlinePermissionPrompt

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/proposalStageConfirm.ts`
- Modify: `apps/desktop/src/renderer/src/components/permissions/InlinePermissionPrompt.tsx:84-90`
- Modify: `apps/desktop/src/renderer/src/stores/proposal.ts`（更新 advancePhase 注释，约第 63 行）

**Interfaces:**
- Consumes: `decideProposalStageConfirm`（Task 1）；`useProposalStore` 的 `active` / `phase` / `advancePhase(to)` / `clearStageSkip()`。
- Produces: `export function applyProposalStageConfirm(input: unknown, answers: Record<string, string>): void`

> 说明：本任务无独立单测——核心判定已在 Task 1 纯函数测过，这层是「读 store + 应用决策」的薄封装（依赖 zustand store，不宜在 bun:test 里隔离）。验证靠 `bun run typecheck` + Task 4 后的 GUI 走查。

- [ ] **Step 1: 新建 lib 封装**

创建 `apps/desktop/src/renderer/src/lib/proposalStageConfirm.ts`：

```typescript
import { decideProposalStageConfirm } from '@shared/proposal'
import { useProposalStore } from '../stores/proposal'

/**
 * 在用户提交 AskUserQuestion 答案的同步路径里调用：若命中「阶段确认放行」，推进 phase。
 *
 * 为什么放在提交同步路径、而非等 AI 回包：toc→content 阶段门要在 AI 流式吐正文、'end'
 * 过门【之前】就放行（phase=content）。用户点选是同步事件，advancePhase 经 getState() 同步
 * 生效，早于后续 AI 回合的 end 处理，时序成立。
 *
 * 仅方案模式生效（ps.active 门控），不污染非方案场景的 AskUserQuestion。
 */
export function applyProposalStageConfirm(
  input: unknown,
  answers: Record<string, string>
): void {
  const ps = useProposalStore.getState()
  if (!ps.active) return
  const decision = decideProposalStageConfirm(input, answers)
  if (decision === 'advance-content') {
    ps.clearStageSkip()
    ps.advancePhase('content')
  } else if (decision === 'clear-only') {
    ps.clearStageSkip()
  }
}
```

- [ ] **Step 2: 接入 InlinePermissionPrompt 的 onSubmit**

在 `apps/desktop/src/renderer/src/components/permissions/InlinePermissionPrompt.tsx` 顶部 import 区（第 9 行 `import { AskUserQuestionView }` 之后）加：

```typescript
import { applyProposalStageConfirm } from '../../lib/proposalStageConfirm'
```

将第 84-90 行的 `<AskUserQuestionView .../>` 的 `onSubmit` 改为：

```tsx
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
```

- [ ] **Step 3: 更新 store 里 advancePhase 的过时注释**

在 `apps/desktop/src/renderer/src/stores/proposal.ts` 第 63 行附近，找到注释：

```
  // 单一真相源。start() 起为 'cover'。仅由 advancePhase 推进（草稿面板按钮调用，
```

改为：

```
  // 单一真相源。start() 起为 'cover'。cover→toc 由 AI 目录哨兵块经 laterPhase 自动推进；
  // toc→content 由用户在聊天里点选 AskUserQuestion 的「确认目录」放行项时，经
  // applyProposalStageConfirm 调 advancePhase('content') 推进（不再有右侧确认按钮）。
```

> 注：若该注释跨多行，仅替换到与原意对应的范围，保持其余行不动；目的是消除「草稿面板按钮调用」这一过时表述。

- [ ] **Step 4: 类型门**

Run: `cd apps/desktop && bun run typecheck`
Expected: PASS（无类型错误；`@shared/proposal` 别名能解析到新导出）。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/renderer/src/lib/proposalStageConfirm.ts apps/desktop/src/renderer/src/components/permissions/InlinePermissionPrompt.tsx apps/desktop/src/renderer/src/stores/proposal.ts
git commit -m "feat(proposal): 聊天内 AskUserQuestion 确认放行项推进阶段门

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: proposalPrompt.ts — AskUserQuestion 驱动阶段确认纪律

**Files:**
- Modify: `apps/desktop/src/main/core/proposalPrompt.ts:1`（import）、`:67`（阶段总览）、`:76`（封面）、`:77`（目录）、`:78`（正文）
- Test: `apps/desktop/src/main/core/proposalPrompt.test.ts`

**Interfaces:**
- Consumes: `PROPOSAL_COVER_CONFIRM_HEADER` / `PROPOSAL_TOC_CONFIRM_HEADER`（Task 1）。

- [ ] **Step 1: 写失败测试**

在 `apps/desktop/src/main/core/proposalPrompt.test.ts` 末尾追加：

```typescript
describe('buildProposalAppend 阶段确认走 AskUserQuestion', () => {
  const out = buildProposalAppend('/mirror', [])

  it('每阶段完成后用 AskUserQuestion 确认才推进', () => {
    expect(out).toContain('每完成一个阶段')
    expect(out).toContain('AskUserQuestion')
  })

  it('封面/目录确认问题用固定 header 与放行项首选项文案', () => {
    expect(out).toContain('封面确认')
    expect(out).toContain('确认封面，生成目录')
    expect(out).toContain('目录确认')
    expect(out).toContain('确认目录，开始撰写正文')
  })

  it('不再宣称界面按钮推进（无回归）', () => {
    expect(out).not.toContain('界面按钮发来')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/desktop && bun test src/main/core/proposalPrompt.test.ts`
Expected: FAIL —「每完成一个阶段」「确认目录，开始撰写正文」尚不存在；且旧串「界面按钮发来」仍在 → `.not.toContain` 失败。

- [ ] **Step 3: 改 import**

`apps/desktop/src/main/core/proposalPrompt.ts` 第 1 行：

```typescript
import { PROPOSAL_DRAFT_BEGIN, PROPOSAL_DRAFT_END, PROPOSAL_GAP_PREFIX } from '../../shared/proposal'
```

改为：

```typescript
import {
  PROPOSAL_DRAFT_BEGIN,
  PROPOSAL_DRAFT_END,
  PROPOSAL_GAP_PREFIX,
  PROPOSAL_COVER_CONFIRM_HEADER,
  PROPOSAL_TOC_CONFIRM_HEADER
} from '../../shared/proposal'
```

- [ ] **Step 4: 改阶段总览句（第 67 行）**

旧（整行，单引号字符串）：

```typescript
    '这份方案分三个阶段【有序】生成：① 封面 → ② 目录 → ③ 正文。用户会通过界面按钮发来「确认封面，生成目录」「确认目录，开始正文」之类的推进消息；只有收到推进消息才进入下一阶段。绝不自行跳阶段——封面阶段不要写目录或正文，目录阶段不要写正文。',
```

改为：

```typescript
    '这份方案分三个阶段【有序】生成：① 封面 → ② 目录 → ③ 正文。每完成一个阶段（封面 / 目录），你【必须】用 AskUserQuestion 工具向用户发起确认；用户在确认卡片里点了「确认」类放行项，你才进入下一阶段。绝不自行跳阶段、绝不在用户确认前抢先写下一阶段内容——封面阶段不要写目录或正文，目录阶段不要写正文。',
```

- [ ] **Step 5: 改封面阶段句（第 76 行）→ 转模板字符串并追加确认指令**

旧（整行，以单引号包裹，结尾为「…把封面正文用第 6 条的【封面哨兵】包裹输出。'」）：

```typescript
    '【阶段一·封面】先用 AskUserQuestion 工具向用户询问生成封面所需的关键信息：客户单位全称、方案主题/标题、落款单位与日期等（把这几项合并进一次调用的多个问题里）；信息齐了再生成封面。封面通常含：方案标题、客户单位、编制单位、日期。封面请按这个结构逐行写：先写【方案标题】（用一级标题 # 开头），其下写【客户单位】等抬头信息，每项一行；然后单独一行写一个 `---`（三个连字符）作分隔；`---` 之下写【编制单位】与【日期】等落款信息，每项一行。导出器据此把标题块排在页面上中部、把落款块贴在页面底部、整页独占。除这一行 `---` 外，【不要】自己加「封面」字样、不要加任何居中/分页标签或其它装饰线——其余排布（水平居中、竖向分布）由导出器统一处理。把封面正文用第 6 条的【封面哨兵】包裹输出。',
```

改为（整行换成反引号模板字符串，插值 header 常量；注意行内已有的 `---` 反引号需保留为字面，模板字符串里直接写即可）：

```typescript
    `【阶段一·封面】先用 AskUserQuestion 工具向用户询问生成封面所需的关键信息：客户单位全称、方案主题/标题、落款单位与日期等（把这几项合并进一次调用的多个问题里）；信息齐了再生成封面。封面通常含：方案标题、客户单位、编制单位、日期。封面请按这个结构逐行写：先写【方案标题】（用一级标题 # 开头），其下写【客户单位】等抬头信息，每项一行；然后单独一行写一个 --- （三个连字符）作分隔；--- 之下写【编制单位】与【日期】等落款信息，每项一行。导出器据此把标题块排在页面上中部、把落款块贴在页面底部、整页独占。除这一行 --- 外，【不要】自己加「封面」字样、不要加任何居中/分页标签或其它装饰线——其余排布（水平居中、竖向分布）由导出器统一处理。把封面正文用第 6 条的【封面哨兵】包裹输出。输出封面后，【必须】立即用 AskUserQuestion 工具发起封面确认：header 固定填「${PROPOSAL_COVER_CONFIRM_HEADER}」，第 1 个选项填「确认封面，生成目录」（这是放行项，务必排在【首位】），其后再给「我要调整封面」等修改类候选。用户点第 1 个选项你才进入阶段二；点修改类则按其意见改封面、用【封面哨兵】重出后再次确认。`,
```

> 注意：原句里 `\`---\`` 用了反引号包裹连字符；转成外层反引号模板后不能再嵌套反引号，已改写为不带反引号的「--- 」。语义不变（仍指导 AI 单独成行写三个连字符）。

- [ ] **Step 6: 改目录阶段句（第 77 行）→ 转模板字符串、改触发条件、追加确认指令**

旧：

```typescript
    '【阶段二·目录】收到「确认封面」推进消息后，参考该产品在知识库里的资料结构与售前建设方案的常见章节（如：项目背景、需求分析、建设目标、总体方案设计、功能详述、实施计划、售后服务等），提出一份【章节目录大纲】（用有序列表逐章列出），【只输出有序列表形式的章节大纲本身，不要自己写「目录」二字标题】——「目录」大标题由导出器统一注入，你再写会重复。用第 6 条的【目录哨兵】包裹。用户可能直接编辑目录，或用自然语言要你增删/调整章节——按用户修订重新输出目录，不自行发挥。',
```

改为：

```typescript
    `【阶段二·目录】用户确认封面后，参考该产品在知识库里的资料结构与售前建设方案的常见章节（如：项目背景、需求分析、建设目标、总体方案设计、功能详述、实施计划、售后服务等），提出一份【章节目录大纲】（用有序列表逐章列出），【只输出有序列表形式的章节大纲本身，不要自己写「目录」二字标题】——「目录」大标题由导出器统一注入，你再写会重复。用第 6 条的【目录哨兵】包裹。输出目录后，【必须】立即用 AskUserQuestion 工具发起目录确认：header 固定填「${PROPOSAL_TOC_CONFIRM_HEADER}」，第 1 个选项填「确认目录，开始撰写正文」（这是放行项，务必排在【首位】），其后再给「我要调整目录」等修改类候选。用户点第 1 个选项你才进入阶段三；点修改类则按其意见增删/调整章节、用【目录哨兵】重出目录后再次确认，不自行发挥。`,
```

- [ ] **Step 7: 改正文阶段句（第 78 行）→ 改触发条件、去掉「带上已确认目录」**

旧：

```typescript
    '【阶段三·正文】收到「确认目录，开始正文」推进消息后（消息里会带上已确认的目录），严格【按该目录逐章撰写正文】：章节标题与顺序以目录为准，不自行增删章节。一次聚焦一章，每章用第 6 条的【正文哨兵】包裹；原文清晰、足以直接组织时可直接起草，不必逐段确认；只有该章关键要点确实不明确时，才先用 AskUserQuestion 工具问用户再起草（遵守上面的提问纪律）。用户标注「一条条介绍」「逐条」的部分要逐条列举（每条：小标题 + 该条内容 + 来源），不要并成一段。',
```

改为：

```typescript
    '【阶段三·正文】用户确认目录后，严格【按你上面已确认的目录逐章撰写正文】：章节标题与顺序以目录为准，不自行增删章节。一次聚焦一章，每章用第 6 条的【正文哨兵】包裹；原文清晰、足以直接组织时可直接起草，不必逐段确认；只有该章关键要点确实不明确时，才先用 AskUserQuestion 工具问用户再起草（遵守上面的提问纪律）。用户标注「一条条介绍」「逐条」的部分要逐条列举（每条：小标题 + 该条内容 + 来源），不要并成一段。',
```

- [ ] **Step 8: 运行测试确认通过 + 类型门**

Run: `cd apps/desktop && bun test src/main/core/proposalPrompt.test.ts && bun run typecheck`
Expected: PASS（新增 3 用例通过；既有「表格纪律/图片/全程中文」用例无回归；类型无误）。

- [ ] **Step 9: 提交**

```bash
git add apps/desktop/src/main/core/proposalPrompt.ts apps/desktop/src/main/core/proposalPrompt.test.ts
git commit -m "feat(proposal): 提示词改为每阶段用 AskUserQuestion 确认推进

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: ProposalDocPanel.tsx — 删确认按钮、阶段条改只读、清未用局部变量

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx`

**Interfaces:**
- Consumes: 无新增（删除为主）。保留 `regenerateToc`、`sendProposalStageMessage`、`PROPOSAL_DRAFT_BEGIN/END`（regenerateToc 仍用）、`buildProposalMarkdown`（导出仍用）。

- [ ] **Step 1: 确认待删局部变量无其它引用**

Run: `cd apps/desktop && grep -n "confirmCover\|confirmToc\|hasCover\|hasToc\|advancePhase" src/renderer/src/components/workspace/ProposalDocPanel.tsx`
Expected: `confirmCover`/`confirmToc` 各仅出现在「定义 + 按钮 onClick」；`hasCover`/`hasToc` 仅出现在「定义 + 按钮 disabled」；`advancePhase` 仅出现在「getState 解构 + confirmCover/confirmToc 内」。若某个还在别处使用，则该处不删、仅删按钮相关引用（按实际结果调整下面步骤）。

- [ ] **Step 2: 删除 advancePhase 解构（第 46-49 行注释 + 解构）**

旧：

```typescript
  // 订阅当前阶段，驱动阶段条高亮与推进按钮渲染。advancePhase 是 zustand 稳定引用，
  // 从 getState() 取——不订阅（避免 phase 每次变化都多跑一遍 selector）。
  const phase = useProposalStore((s) => s.phase)
  const { advancePhase } = useProposalStore.getState()
```

改为（保留 phase 订阅，删除 advancePhase 解构；推进已移到 applyProposalStageConfirm）：

```typescript
  // 订阅当前阶段，驱动阶段条高亮（只读）。阶段推进已不在本面板：cover→toc 由 AI 目录
  // 哨兵自动推进，toc→content 由聊天内 AskUserQuestion「确认目录」放行项触发
  // （applyProposalStageConfirm），故本面板不再解构/调用 advancePhase。
  const phase = useProposalStore((s) => s.phase)
```

- [ ] **Step 3: 删除 hasCover / hasToc（第 63-66 行）**

旧：

```typescript
  // 各区是否已有非空内容，决定推进按钮是否可用（空区或仅空白 → 禁用，避免误推进）。
  // 注：用 .trim().length > 0 而非仅 .some(kind===X)——纯空白区段依然无法驱动 AI 生成。
  const hasCover = sections.some((s) => s.kind === 'cover' && s.markdown.trim().length > 0)
  const hasToc = sections.some((s) => s.kind === 'toc' && s.markdown.trim().length > 0)
```

整段删除（两个推进按钮被删后不再引用；保留其上 `generating` 等其它派生量）。

- [ ] **Step 4: 删除 confirmCover 与 confirmToc 函数（第 154-162、171-182 行），保留 regenerateToc**

删除 `confirmCover`（含其上方第 154-155 行注释）整函数：

```typescript
  // 阶段一→二：先把 phase 推到 toc（驱动阶段条/按钮 UI），再让 AI 生成目录大纲。
  // 归档不再靠 phase 而靠哨兵类型，故消息里点名【目录哨兵】，让 AI 用对那对标记。
  function confirmCover(): void {
    clearStageSkip()
    advancePhase('toc')
    void sendProposalStageMessage(
      `封面已确认。请进入【阶段二·目录】：参考知识库里该产品的资料结构与售前方案常见章节，给出一份章节目录大纲（有序列表逐章列出），用方案【目录】哨兵包裹（${PROPOSAL_DRAFT_BEGIN.toc} … ${PROPOSAL_DRAFT_END.toc}）。`
    )
  }
```

删除 `confirmToc`（含其上方第 171 行注释）整函数：

```typescript
  // 阶段二→三：把已确认的目录正文带给 AI（目录驱动正文），phase 推到 content。
  function confirmToc(): void {
    clearStageSkip()
    const tocMd = buildProposalMarkdown(
      sections.filter((s) => s.kind === 'toc'),
      { pageBreaks: false }
    )
    advancePhase('content')
    void sendProposalStageMessage(
      `目录已确认，最终目录如下：\n\n${tocMd}\n\n请进入【阶段三·正文】：严格按上面目录逐章撰写正文，章节标题与顺序以目录为准，一次聚焦一章，每章用方案【正文】哨兵包裹（${PROPOSAL_DRAFT_BEGIN.content} … ${PROPOSAL_DRAFT_END.content}）。`
    )
  }
```

**保留** 其间的 `regenerateToc`（第 163-170 行）不动 —— 它被跳阶补救 effect 调用，仍需要 `clearStageSkip` / `sendProposalStageMessage` / `PROPOSAL_DRAFT_BEGIN.toc` / `PROPOSAL_DRAFT_END.toc`，故这些 import 与解构保持。

- [ ] **Step 5: 阶段条改只读 —— 删两个确认按钮 JSX、更新注释（第 418-447 行）**

旧：

```tsx
      {/* 阶段条：封面 → 目录 → 正文，显式按钮门控推进，一次只推进一阶段。 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px]">
        <span className={phase === 'cover' ? 'font-medium text-foreground' : 'text-muted-foreground'}>① 封面</span>
        <span className="text-muted-foreground">→</span>
        <span className={phase === 'toc' ? 'font-medium text-foreground' : 'text-muted-foreground'}>② 目录</span>
        <span className="text-muted-foreground">→</span>
        <span className={phase === 'content' ? 'font-medium text-foreground' : 'text-muted-foreground'}>③ 正文</span>
        <span className="flex-1" />
        {phase === 'cover' && (
          <button
            className="rounded bg-accent px-2 py-0.5 text-white disabled:opacity-40"
            disabled={generating || !hasCover}
            onClick={confirmCover}
            title={generating ? 'AI 生成中，请稍候' : hasCover ? '' : '封面尚未生成'}
          >
            确认封面，生成目录
          </button>
        )}
        {phase === 'toc' && (
          <button
            className="rounded bg-accent px-2 py-0.5 text-white disabled:opacity-40"
            disabled={generating || !hasToc}
            onClick={confirmToc}
            title={generating ? 'AI 生成中，请稍候' : hasToc ? '' : '目录尚未生成'}
          >
            确认目录，开始正文
          </button>
        )}
        {phase === 'content' && <span className="text-muted-foreground">正文撰写中</span>}
      </div>
```

改为（删两个 `<button>` 分支，保留三段高亮、spacer 与 content 文案；阶段确认已移到左侧聊天内 AskUserQuestion）：

```tsx
      {/* 阶段条：封面 → 目录 → 正文，只读状态显示。阶段推进已移到左侧聊天——AI 每完成
          一阶段用 AskUserQuestion 发确认卡片，用户点「确认」放行项后推进（见
          applyProposalStageConfirm），本条不再承载可点按钮。 */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px]">
        <span className={phase === 'cover' ? 'font-medium text-foreground' : 'text-muted-foreground'}>① 封面</span>
        <span className="text-muted-foreground">→</span>
        <span className={phase === 'toc' ? 'font-medium text-foreground' : 'text-muted-foreground'}>② 目录</span>
        <span className="text-muted-foreground">→</span>
        <span className={phase === 'content' ? 'font-medium text-foreground' : 'text-muted-foreground'}>③ 正文</span>
        <span className="flex-1" />
        {phase === 'cover' && <span className="text-muted-foreground">封面撰写中</span>}
        {phase === 'toc' && <span className="text-muted-foreground">目录整理中</span>}
        {phase === 'content' && <span className="text-muted-foreground">正文撰写中</span>}
      </div>
```

- [ ] **Step 6: 类型门**

Run: `cd apps/desktop && bun run typecheck`
Expected: PASS。若报「'xxx' is declared but never read」，说明仍有未清理的局部变量/import —— 按报错逐一删除其定义（仅限本任务删除按钮所连带失引用的：advancePhase / hasCover / hasToc；勿误删 regenerateToc 链路用到的）。

- [ ] **Step 7: 全量测试无回归**

Run: `cd apps/desktop && bun test src/`
Expected: PASS（全部既有 + 新增用例）。

- [ ] **Step 8: GUI 走查（手动）**

Run: `cd apps/desktop && bun run dev`
逐项确认：
1. 进入「写方案」模式，AI 询问封面信息（AskUserQuestion 卡片）→ 生成封面 → 左侧聊天弹出 header 为「封面确认」的卡片，含「确认封面，生成目录」+「我要调整封面」选项；右侧阶段条**无确认按钮**，仅高亮①封面。
2. 点「确认封面，生成目录」→ AI 生成目录 → 弹出「目录确认」卡片。阶段条高亮随哨兵推进到②目录。
3. 点「确认目录，开始撰写正文」→ 阶段条高亮③正文，AI 正文正常落地、**未被阶段门拦**（无「正在整理目录」红条误报）。
4. 回到目录阶段重试：点「我要调整目录」→ phase **不**推进，进入修订对话。
5. 阶段条三段文字随阶段高亮，但**不可点击**。

- [ ] **Step 9: 提交**

```bash
git add apps/desktop/src/renderer/src/components/workspace/ProposalDocPanel.tsx
git commit -m "feat(proposal): 删除右侧阶段确认按钮，阶段条改只读

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage**
- 「核心机制：phase 推进改由聊天答案触发」→ Task 1（纯决策）+ Task 2（拦截推进）。✓
- 「改动一：提示词纪律」→ Task 3。✓
- 「改动二：共享常量」→ Task 1。✓
- 「改动三：渲染层拦截（仅方案模式）」→ Task 2（`ps.active` 门控）。✓
- 「改动四：删按钮 + 阶段条只读 + 保留补救红条」→ Task 4（删按钮、只读条；regenerateToc/红条保留）。✓
- 「取舍：不回灌目录」→ Task 3 Step 7（去掉「带上已确认目录」）+ 设计文档记录。✓
- 「鲁棒性：未发起确认可手敲、时序、不污染非方案」→ Task 2（`ps.active` + 同步推进）；手敲推进仍可经聊天自然语言（AI 提示词纪律），无需额外代码。✓
- 验收清单 → Task 4 Step 8 GUI 走查逐条覆盖。✓

**2. Placeholder scan**：无 TBD/TODO；每个代码步骤含完整代码或精确旧→新替换；命令含预期输出。✓

**3. Type consistency**：`decideProposalStageConfirm(input, answers)` 与 `applyProposalStageConfirm(input, answers)` 签名一致；返回值 `'advance-content' | 'clear-only' | 'none'` 在 Task 1 定义、Task 2 消费一致；header 常量名 `PROPOSAL_COVER_CONFIRM_HEADER` / `PROPOSAL_TOC_CONFIRM_HEADER` 三任务一致；store action `advancePhase('content')` / `clearStageSkip()` 与现有签名一致。✓
