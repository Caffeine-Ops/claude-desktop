# 选区即改·只改选中范围 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「选区即改」的初次改写只改用户选中的文字、段落其余部分逐字保留，消掉「多改了附近一整块」。

**Architecture:** 不动「按块替换」的底层机制（`splitBlocks`→`spliceBlocks`），只改发给 AI 的指令措辞：从「把这一小段改写了」改成「只改选中部分、其余一字不动、整段返回」。把拼指令的逻辑抽成纯函数 `buildSelectionRevisionMessage` 放进新纯文件，便于单测。

**Tech Stack:** TypeScript、bun test、zustand（本次不碰）。测试从 `apps/studio` 目录跑。

## Global Constraints

- 包管理器是 **bun**，不是 npm。测试脚本：`apps/studio` 内 `bun test electron/ src/chat/lib`。
- 新纯文件**只准 import 类型**（`type ProposalKind`），绝不 import store / 有副作用的模块——否则 `bun test`（Node 环境）加载即炸，破坏可测性初衷。
- 硬边界段（严禁写文件/评估/收尾/另起章节、仅 Read）与 `groundingSuffix(kind)` 溯源措辞**原样保留语义**，不因本次改动松口。
- `ProposalKind = 'cover' | 'toc' | 'content'`（`electron/shared/proposal.ts`）。
- 中文注释解释「为什么这样而不是那样」，沿用项目高注释密度风格。
- 类型检查是唯一自动化防线之一：收尾必须 `bun run typecheck` 通过。

---

### Task 1: 新建纯函数模块 `proposalRevisionMessages.ts` + 单测

把「拼选区改写指令」的纯逻辑与「溯源措辞」`groundingSuffix` 抽进新纯文件，先写测试再实现。

**Files:**
- Create: `apps/studio/src/chat/lib/proposalRevisionMessages.ts`
- Test: `apps/studio/src/chat/lib/proposalRevisionMessages.test.ts`

**Interfaces:**
- Consumes: `type ProposalKind` from `@desktop-shared/proposal`（`'cover' | 'toc' | 'content'`）。
- Produces（Task 2 依赖这两个导出）：
  - `groundingSuffix(kind: ProposalKind): string`
  - `buildSelectionRevisionMessage(params: { instruction: string; focus: string; context: string; kind: ProposalKind }): string`
    - `instruction`＝已 trim 的用户指令；`focus`＝已 trim 的选中原文（可能为空）；`context`＝选区覆盖的块拼成的完整原文；`kind`＝节类型。

- [ ] **Step 1: 写失败测试**

创建 `apps/studio/src/chat/lib/proposalRevisionMessages.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'
import { buildSelectionRevisionMessage, groundingSuffix } from './proposalRevisionMessages'

describe('buildSelectionRevisionMessage', () => {
  const context = '第一句是背景。第二句要改的正是这里。第三句收尾。'

  it('选中子串（content 节）：钉死「只改选中、其余原样」，且带上选中原文/完整上下文/指令/《来源》约束', () => {
    const msg = buildSelectionRevisionMessage({
      instruction: '把它写得更专业',
      focus: '第二句要改的正是这里。',
      context,
      kind: 'content'
    })
    expect(msg).toContain('一字不动、原样保留')       // 核心约束
    expect(msg).toContain('第二句要改的正是这里。')     // 选中原文入 prompt
    expect(msg).toContain(context)                     // 完整上下文入 prompt
    expect(msg).toContain('把它写得更专业')             // 用户指令入 prompt
    expect(msg).toContain('段末按既有规则标注《来源》') // content 溯源不松口
  })

  it('focus 为空（防御兜底）：退回「整段改写」措辞、不含「原样保留」约束', () => {
    const msg = buildSelectionRevisionMessage({
      instruction: '精简这段',
      focus: '',
      context,
      kind: 'content'
    })
    expect(msg).toContain('把下面这一小段按要求改写')
    expect(msg).not.toContain('一字不动、原样保留')
  })

  it('封面/目录节（cover）：走免标《来源》的溯源措辞', () => {
    const msg = buildSelectionRevisionMessage({
      instruction: '换个说法',
      focus: '武汉协和医院',
      context: '武汉协和医院',
      kind: 'cover'
    })
    expect(msg).toContain('不要标注《来源》')
    expect(msg).not.toContain('段末按既有规则标注《来源》')
  })
})

describe('groundingSuffix', () => {
  it('content 标《来源》，cover/toc 免标', () => {
    expect(groundingSuffix('content')).toContain('《来源》')
    expect(groundingSuffix('cover')).toContain('不要标注《来源》')
    expect(groundingSuffix('toc')).toContain('不要标注《来源》')
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run（从 `apps/studio` 目录）：`bun test src/chat/lib/proposalRevisionMessages.test.ts`
Expected: FAIL —— 模块 `./proposalRevisionMessages` 不存在 / 导出未定义（`Cannot find module` 或 `undefined is not a function`）。

- [ ] **Step 3: 写实现**

创建 `apps/studio/src/chat/lib/proposalRevisionMessages.ts`：

```ts
import type { ProposalKind } from '@desktop-shared/proposal'

// 纯函数模块：只拼「选区即改」发给引擎的指令字符串，不碰任何 store / 副作用——故可被 bun test
// 单独加载单测（sendProposalSectionRevision.ts 因 import zustand store 等无法在 Node 里直接测）。

// 溯源后缀按节类型分叉：正文节要标《来源》、守 trigram 引用落地校验；封面/目录不引用知识库、无
// 溯源语义，故只要求「按指令改这一小段、保持简短、别臆造」——否则会逼 AI 给封面字段硬凑《来源》成噪声。
export function groundingSuffix(kind: ProposalKind): string {
  return kind === 'content'
    ? '段末按既有规则标注《来源》，绝不臆造知识库之外的内容。'
    : '这是封面/目录里的字段，只按指令改这一小段、保持简短，不要标注《来源》，也不要臆造任何事实信息。'
}

/**
 * 拼「选区即改·初次改写」发给引擎的一条消息。核心不变量：focus 非空时钉死「只改选中、其余一字不动、
 * 整段返回」——底层仍整块 spliceBlocks，靠这段措辞让 AI 只动选中句、段内其余逐字保留，从而消掉
 * 「多改了附近一整块」。focus 为空（防御性，选区气泡不会以空选区发起）退回「整段改写」旧措辞。
 * 同一句「其余原样」对「选了一句」与「选了整段」都通用：选了整段时「选中范围以外」为空，自然整段改。
 */
export function buildSelectionRevisionMessage(params: {
  instruction: string
  focus: string
  context: string
  kind: ProposalKind
}): string {
  const { instruction, focus, context, kind } = params

  // 硬边界（实测踩坑）：fusion-code 是带 Write/Bash 的 agent，连做几轮小改后会「自作主张」觉得
  // 方案该收尾了，转去评估整份方案 / 往桌面写报告，无视改写指令。方案系统提示词没禁这些，故在此
  // 把边界钉死：只改这一小段、只用哨兵返回、严禁写文件/评估/交付/另起任务。两个分支共用。
  const boundary =
    `【就地小改·硬性边界】这是针对方案正文里【某一小段】的一次就地改写，不是新任务、更不是收尾。` +
    `你【唯一要做的事】：按要求就地改写下面这一小段，并用方案【正文】哨兵原样返回。` +
    `【严禁】写入或创建任何文件（别碰桌面、别生成任何 .md/报告）、评估或点评整份方案、总结或交付、` +
    `另起新章节、输出这一小段以外的任何内容；如需核对来源仅用 Read，绝不调用任何写类工具。\n\n`

  const scope = focus
    ? `用户只选中了这段里的一部分文字要改：「${focus}」。请【只改写这部分选中的文字】，` +
      `本段里选中范围以外的其它文字【必须一字不动、原样保留】——不要顺手润色、调整或重写它们。\n\n` +
      `改写要求：${instruction}\n\n` +
      `这一小段的完整原文如下：\n\n${context}\n\n` +
      `请输出【整段完整内容】：选中部分按要求改写、其余部分逐字保持不变` +
      `（不要重复章节标题、不要写章节序号），`
    : `请把下面这一小段按要求改写。\n\n` +
      `改写要求：${instruction}\n\n` +
      `这一小段的原文如下：\n\n${context}\n\n` +
      `只输出【重写后的这一小段本身】（不要重复章节标题、不要写章节序号），`

  return boundary + scope + `仍用方案【正文】哨兵包裹，` + groundingSuffix(kind)
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run（从 `apps/studio` 目录）：`bun test src/chat/lib/proposalRevisionMessages.test.ts`
Expected: PASS —— 4 个 it 全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/studio/src/chat/lib/proposalRevisionMessages.ts apps/studio/src/chat/lib/proposalRevisionMessages.test.ts
git commit -m "feat(proposal): 抽 buildSelectionRevisionMessage 纯函数——选区即改只改选中、其余原样（路A）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: 接线——`reviseProposalSectionBlocks` 改用新函数，删本地 `groundingSuffix`

把 `sendProposalSectionRevision.ts` 里内联的消息拼装换成调用 Task 1 的 `buildSelectionRevisionMessage`；本地 `groundingSuffix` 删除、改从新模块 import（`continueProposalSectionBlocks` 仍在用它）。

**Files:**
- Modify: `apps/studio/src/chat/lib/sendProposalSectionRevision.ts`

**Interfaces:**
- Consumes: `buildSelectionRevisionMessage`、`groundingSuffix`（from `./proposalRevisionMessages`，Task 1 产出）。

- [ ] **Step 1: 删本地 `groundingSuffix`，加 import**

删除 `sendProposalSectionRevision.ts` 顶部本地定义的 `groundingSuffix`（连同其上方注释，现约第 8–15 行整块）：

```ts
// 溯源后缀按节类型分叉：正文节要标《来源》、守 trigram 引用落地校验；封面/目录不引用知识库、无
// 溯源语义（renderVerification 对非 content 直接不渲染），故只要求「按指令改这一小段、保持简短、
// 别臆造事实」——否则会逼 AI 给「武汉协和医院」这类封面字段硬凑一个《来源》，反成噪声。
function groundingSuffix(kind: ProposalKind): string {
  return kind === 'content'
    ? '段末按既有规则标注《来源》，绝不臆造知识库之外的内容。'
    : '这是封面/目录里的字段，只按指令改这一小段、保持简短，不要标注《来源》，也不要臆造任何事实信息。'
}
```

在已有的 import 区（`import { sendProposalStageMessage } from './sendProposalStageMessage'` 附近）新增一行：

```ts
import { buildSelectionRevisionMessage, groundingSuffix } from './proposalRevisionMessages'
```

**同时改 import 行**：`ProposalKind` 在本文件里**只**被刚删掉的 `groundingSuffix` 用（已核实），删除后它变成未用 import、严格 tsc 会报错。故把第 3 行

```ts
import { USER_SUPPLIED_SOURCE, type ProposalKind } from '@desktop-shared/proposal'
```

改为（去掉 `type ProposalKind`，`USER_SUPPLIED_SOURCE` 仍被 `buildGapFillRewriteMessage` 用，保留）：

```ts
import { USER_SUPPLIED_SOURCE } from '@desktop-shared/proposal'
```

- [ ] **Step 2: `reviseProposalSectionBlocks` 的 message 改成调用新函数**

在 `reviseProposalSectionBlocks` 的 `dispatchSectionRevision` build 回调里，把返回对象的 `message`（现约第 190–203 行那一大段字符串拼接，含硬边界/改写要求/`focus ? …`/原文/`groundingSuffix(sec.kind)`）整体替换为：

```ts
      message: buildSelectionRevisionMessage({
        instruction: trimmed,
        focus,
        context,
        kind: sec.kind
      })
```

替换后该 `return` 应为：

```ts
    return {
      blockRange: { start, end },
      displayText: trimmed,
      message: buildSelectionRevisionMessage({
        instruction: trimmed,
        focus,
        context,
        kind: sec.kind
      })
    }
```

（`trimmed`、`focus`、`context`、`start`、`end` 均为该函数内已算好的既有局部变量，不新增。）

- [ ] **Step 3: typecheck**

Run（repo 根目录）：`bun run typecheck`
Expected: PASS（无 `groundingSuffix`/`buildSelectionRevisionMessage` 未定义、无未用 import 报错）。若报 `groundingSuffix` 在别处仍被本地引用，确认 `continueProposalSectionBlocks` 现在读的是 import 版（同名，无需改调用点）。

- [ ] **Step 4: 跑全量相关测试，确认不回归**

Run（从 `apps/studio` 目录）：`bun test electron/ src/chat/lib`
Expected: PASS —— 新增 `proposalRevisionMessages.test.ts` 与既有 `proposalRevisionGuards.test.ts` 等全绿。

- [ ] **Step 5: 提交**

```bash
git add apps/studio/src/chat/lib/sendProposalSectionRevision.ts
git commit -m "feat(proposal): 选区即改接线到 buildSelectionRevisionMessage，删重复 groundingSuffix

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 手动 GUI 走查（验收）

自动化只能锁住「指令措辞对不对」，锁不住「AI 是否真只改选中句」——这条靠人肉走查。

**Files:** 无（仅运行验证）。

- [ ] **Step 1: 起 dev**

Run（repo 根目录）：`bun run dev`
Expected: Electron 起来，进「写方案」，随便生成/打开一份有正文的草稿。

- [ ] **Step 2: 选一句话触发选区即改**

在正文某个**长段落**里，只高亮其中一句话 → 浮出「AI 改写」气泡 → 填个指令（如「润色」）→ 点「开始改写」。

- [ ] **Step 3: 核对改动范围**

Expected:
- 审阅卡落在选中所在段；**该句以外的同段文字逐字未变**（对照改写前后）。
- 相邻段落 / 上面的标题 / 下面的列表**均未动**。
- 封面/目录节里选字段改，同样只改选中、且不冒出《来源》标注。

- [ ] **Step 4: 记录结果**

若通过：在收尾汇报里注明「GUI 走查通过」。若 AI 仍频繁改动选区以外文字：记录复现步骤，回到设计讨论是否需上路 B（真子串替换）——不要自行加码扩大改动。

---

## 备注（不在本计划范围，勿动）

- 审阅卡「继续改」`continueProposalSectionBlocks` 不带 `selectedText` 焦点，本次不改（其消息构造仍在 `sendProposalSectionRevision.ts` 内联，继续用 import 版 `groundingSuffix`）。
- 审阅卡红绿 diff 显示层不改。
- 路 B（真子串替换）/ 路 C（句级切块）不做。
