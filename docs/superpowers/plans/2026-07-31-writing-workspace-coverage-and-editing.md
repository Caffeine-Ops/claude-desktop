# 写作工作区：覆盖面补齐 + 纸面手动编辑 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「改写 / 优化已有作品 / 只润色」三条工作流的稿子在写作右栏看得见，并把纸面从只读改成双击就地编辑 Markdown 源码、可撤销。

**Architecture:** P0-1 全部是 `skills/writing/` 里的 Markdown 文档改动（改稿子落点 + 补最小体裁契约），`apps/studio` 零改动。P0-2 复用现有的「块替换 → `writingWriteSection` 带 mtime 乐观锁写盘」链路，不新增任何 IPC；新增一个纯函数模块 `src/chat/lib/writingEdit.ts` 承载块级操作，撤销栈住在 `stores/writing.ts`，由 AI 改写与手动编辑两条通道共用。

**Tech Stack:** Electron + React 19 + zustand + Tailwind v4/shadcn；测试用 `bun test`（`bun:test` 的 describe/it/expect）；包管理器是 **bun**，不是 npm。

**设计文档:** `docs/superpowers/specs/2026-07-31-writing-workspace-coverage-and-editing-design.md`

## Global Constraints

- 包管理器是 **bun**。所有命令用 `bun`，不要用 npm/yarn/pnpm。
- 类型检查是本仓库唯一的全局自动防线：任何任务收尾前必须 `bun run typecheck` 全绿。
- 测试命令是 `bun test`（在 `apps/studio` 目录下跑），扫描目录只有 `electron/`、`src/chat/lib`、`src/chat/composer` 三个 —— **新的纯函数必须放进 `src/chat/lib/` 才会被测到**。组件（`src/chat/components/`）与 store（`src/chat/stores/`）没有测试基建，靠手动走查验证。
- 注释风格：本仓库注释密度很高，且专门解释「**为什么这样而不是那样**」。新增不变量必须把理由写进注释，别只写做了什么。
- 中文正文用全角标点；代码 / 路径 / 命令内用半角。
- **样式铁律**：写作面板在 `.chat-app` 子树下，天然豁免 canvas 的裸元素 reset，本轮不 portal 到 body，因此 `<textarea>` / `<button>` 不需要额外加 `data-slot`。但顶栏整条落在根 `.window-drag-strip`（fixed 全宽 46px、`app-region:drag`）里，**顶栏新增的任何交互控件必须落在已有的 `[-webkit-app-region:no-drag]` 分组内**，否则点击会被原生窗口拖拽吞掉且控制台零报错。
- **顶栏本身禁止再标 `app-region:drag`**（全应用唯一拖拽面是根 strip，组件顶栏再标会复发「整窗拖不动 + 双击不缩放」）。
- 提交信息用中文，格式 `<type>(<scope>): <描述>`，参照现有 git log（如 `feat(writing): …` / `fix(chat): …`）。

---

## 任务总览

| # | 任务 | 类型 | 验证方式 |
|---|---|---|---|
| 1 | skill 文档改稿子落点 + 补最小体裁契约 | 文档 | grep + 手动走查 |
| 2 | `writingEdit.ts` 块级纯函数 | TDD | `bun test` |
| 3 | **纯重构**：抽出共用的写盘落地函数 | 重构（行为零变化） | `bun run typecheck` + 手动回归 |
| 4 | 撤销栈 + 接进 AI 改写「应用」 | 行为变化 | `bun test`（栈纯函数）+ 手动走查 |
| 5 | 顶栏「撤销上一步」按钮 | 行为变化 | 手动走查 |
| 6 | 纸面块编辑态 + 手动编辑落地 | 行为变化 | 手动走查 |
| 7 | 全量验收 | 验收 | typecheck + test + 8 条走查 |

**任务 3 是纯重构，必须单独提交、单独给用户过目，不允许和任务 4 的行为改动合并在一次提交里。**

---

### Task 1: skill 文档改稿子落点

**Files:**
- Modify: `skills/writing/workflows/rewrite.md`
- Modify: `skills/writing/workflows/optimize-existing.md`
- Modify: `skills/writing/workflows/polish-only.md`
- Modify: `skills/writing/SKILL.md`
- Modify: `docs/superpowers/specs/2026-07-29-writing-live-preview-design.md`

**Interfaces:**
- Consumes: 无（本任务不依赖其他任务）
- Produces: 无代码接口。产出的是「建项目的工作流把正文写进 `<项目>/drafts/`，轻量快道写进 `<cwd>/写作/<标题>.md`」这条约定，前端 `sectionDir()` 已经按它工作。

**背景（实施者必读）：** 写作右栏扫的是 `<projectDir>/drafts`（硬编码在 `apps/studio/electron/main/core/writingProject.ts` 的 `sectionDir()`）。这三条工作流把正文写去了 `output/` 或压根不落盘，所以右栏恒显「还没有正文」。本任务不动前端，只把工作流的落点掰回 `drafts/`。

- [ ] **Step 1: 先看清 rewrite.md 现在怎么写的**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
grep -n "output/" skills/writing/workflows/rewrite.md
```

预期看到 4 处左右：Step 4 标题「改写、进 output/、逐处标注」、正文「改完落 `<项目>/output/`」、Step 5 的复检命令路径 `<项目>/output/rewrite.md`、检查点「改写稿在 output/」。

- [ ] **Step 2: 把 rewrite.md 的正文落点改成 drafts/**

把上一步 grep 到的每一处 `<项目>/output/` 改成 `<项目>/drafts/`（Step 4 标题、正文、Step 5 命令、检查点）。**不要**改动 `reviews/`（质检报告仍落 reviews/）与 `sources/`（原稿留档不变）。

在 Step 4 落点那一句后面补一条说明，讲清为什么改（本仓库注释纪律：写理由，不只写做法）：

```markdown
> 落 `drafts/` 而不是 `output/`：`drafts/` 是「正在打磨的正文」，`output/` 是「定稿与导出物
> （.docx / .html）」——主管线本来就这么分。桌面端写作工作区只扫 `drafts/`，落错地方的
> 后果是用户跑完整条改写流程、右栏却一片空白（2026-07-31 修）。
```

- [ ] **Step 3: 改 optimize-existing.md**

把「原稿始终留档、绝不原地改（存 `sources/`，改动落 `output/`，随时可对账）」里的 `output/` 改成 `drafts/`。原稿仍存 `sources/` 不变。同样补一句上面那条理由（可精简为一行）。

- [ ] **Step 4: 给 polish-only.md 补落盘 Step 0**

`polish-only.md` 是**轻量快道，不建项目**，所以它不落 `drafts/`，而是照抄 `de-ai.md` 已跑通的单文件模式。先读那段现成写法：

```bash
grep -n "落单文件" -A 6 skills/writing/workflows/de-ai.md
```

在 `polish-only.md` 的「## 一条统摄铁律」之后、「## Step 1 · 审校诊断」之前，插入：

```markdown
---

## Step 0 · 落单文件（先做，别跳）

润色后的成稿写到 `<当前工作目录>/写作/<标题>-润色版.md`（目录不存在就先建），用 Write
工具直接写，**不要**为这一步去跑 `project_manager.py`——本工作流是轻量快道，建项目会让
它名存实亡。

> 为什么必须落盘：桌面端的写作工作区认这个落点，落了盘用户才能在右栏看到排好版的稿子、
> 选段继续改、一键导出 Word / PDF。只在对话里给全文，等于让这一整套工作区在只润色这条
> 路上完全失效。落点与 [去AI化](de-ai.md) 同款，两条快道保持一致。
```

- [ ] **Step 5: 给 rewrite.md 和 optimize-existing.md 补最小体裁契约**

**为什么要补：** 右栏的排版皮肤（公众号手机窄栏 / 小说分页 A4 / 文章 / 职场）来自 `spec_lock.md` 的 `- genre:` 行，解析不到时回退 `workplace`。改写 / 优化不走策划八项、通常没有 `spec_lock.md`，结果拿一篇公众号推文来优化，右栏用职场公文排版显示它。

`rewrite.md` 第 61 行附近已有一张「看原文像什么 → 定 `genre`」的判断表。在那张表之后补一段：

```markdown
**判完 genre 后，立刻写一份最小写作契约**（`<项目>/spec_lock.md`），只要两行：

```markdown
## 体裁
- genre: wechat
```

段名 `## 体裁` 与字段名 `genre` 必须逐字用这一套（`update_spec.py` 认死八个固定段名），
否则后续要改契约时脚本认不出。桌面端写作工作区也读这一行决定排版皮肤——不写的话，
一篇公众号推文会被按职场公文的版式显示给用户。

（小说改写另有更高要求：`continuity_check.py` 需要完整的人物档案与伏笔表，见下面 Step 2 的
逆向补契约那条，那种情况下这份最小契约会被完整契约取代。）
```

在 `optimize-existing.md` 里做同样的事——它同样要判体裁，同样在建完项目后写这份最小契约。

- [ ] **Step 6: 同步 SKILL.md 的工作流索引**

```bash
grep -n "optimize-existing\|polish-only\|rewrite" skills/writing/SKILL.md
```

检查「独立工作流索引」表里这三条的描述有没有提到落点。有提到 `output/` 的改成 `drafts/`；「只润色」那条的触发条件描述后补一句「产物落 `<cwd>/写作/<标题>-润色版.md`」。

- [ ] **Step 7: 更新前作设计文档，把 H-2 标记为已解决**

编辑 `docs/superpowers/specs/2026-07-29-writing-live-preview-design.md`：

1. 「覆盖范围」表里「优化 / 改写类」那行的「⚠️ 实为 `<项目>/output/`，**当前未接管**，见「已知问题 H-2」」改成「`<项目>/drafts/`（2026-07-31 修，见后续设计）」。
2. 「已知问题」里 H-2 那节的标题改为 `### H-2：优化 / 改写类工作流的产物落在 output/，右栏恒空 —— ✅ 已解决（2026-07-31）`，并在小节开头加一行：

```markdown
> **已由 [`2026-07-31-writing-workspace-coverage-and-editing-design.md`](2026-07-31-writing-workspace-coverage-and-editing-design.md)
> 解决**：采用下面三个方向里的第 2 个（让工作流改落 `drafts/`），另加「轻量快道走单文件」
> 的分界。**一稿多平台（`serialize.md`）仍不覆盖** —— 它产出的是多个平行的平台版本，
> 不是一篇文章的多个小节，需要的是平台切换器而非拼接纸面。下面的三方向记录保留作决策留痕。
```

- [ ] **Step 8: 验证没有漏网的 output/ 正文落点**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
grep -n "output/" skills/writing/workflows/rewrite.md skills/writing/workflows/optimize-existing.md skills/writing/workflows/polish-only.md
```

预期：**只剩下**指向导出物（`.html` / `.docx` / `export.py --out`）的行。任何指向 `.md` 正文的 `output/` 都是漏改。

- [ ] **Step 9: 跑资源库校验（改动 skill 后的仓库约定）**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/skills/writing
source bin/ensure-python.sh && $WRITING_PY scripts/validate_library.py
```

预期：PASS。（本任务没动 `references/` 资源库，跑它是为了确认没有意外破坏；首次运行会花几分钟建 venv。）

- [ ] **Step 10: 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add skills/writing docs/superpowers/specs/2026-07-29-writing-live-preview-design.md
git commit -m "fix(writing): 改写/优化/只润色的稿子落到右栏扫得到的位置

改写与优化已有作品的正文从 output/ 改落 drafts/（output/ 仍只放定稿与导出物），
只润色补 Step 0 落单文件 <cwd>/写作/<标题>-润色版.md（沿用去AI化的快道落点）。
两条建项目的工作流另补一份最小 spec_lock（只有 genre 一行），否则右栏排版皮肤
会回退成职场档，把公众号推文按公文版式显示。

修掉前作设计文档记的 H-2。"
```

---

### Task 2: `writingEdit.ts` 块级纯函数

**Files:**
- Create: `apps/studio/src/chat/lib/writingEdit.ts`
- Test: `apps/studio/src/chat/lib/writingEdit.test.ts`

**Interfaces:**
- Consumes: `splitBlocks` / `spliceBlocks`（`@desktop-shared/proposalBlocks`，已存在）
- Produces（后续任务按这些确切签名调用）:
  - `blockSourceAt(sectionMarkdown: string, blockIndex: number): string | null`
  - `replaceBlockAt(sectionMarkdown: string, blockIndex: number, nextBlockMarkdown: string): string | null`
  - `isBlockUnchanged(originalBlock: string, candidate: string): boolean`
  - `pushBounded<T>(stack: T[], item: T, max: number): T[]`

- [ ] **Step 1: 写失败的测试**

创建 `apps/studio/src/chat/lib/writingEdit.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { blockSourceAt, replaceBlockAt, isBlockUnchanged, pushBounded } from './writingEdit'

const SECTION = '# 小标题\n\n第一段正文。\n\n第二段正文。\n\n第三段正文。'

describe('blockSourceAt', () => {
  it('取出指定序号那一块的源码', () => {
    expect(blockSourceAt(SECTION, 0)).toBe('# 小标题')
    expect(blockSourceAt(SECTION, 2)).toBe('第二段正文。')
  })

  it('序号越界或非整数一律回 null —— 调用方据此不进入编辑态', () => {
    expect(blockSourceAt(SECTION, -1)).toBeNull()
    expect(blockSourceAt(SECTION, 99)).toBeNull()
    expect(blockSourceAt(SECTION, 1.5)).toBeNull()
    expect(blockSourceAt(SECTION, NaN)).toBeNull()
  })
})

describe('replaceBlockAt', () => {
  it('只换目标那一块，其余块逐字节不变', () => {
    const next = replaceBlockAt(SECTION, 2, '换过的第二段。')
    expect(next).toBe('# 小标题\n\n第一段正文。\n\n换过的第二段。\n\n第三段正文。')
  })

  it('新内容里有空行 —— 存盘后自然切成两块（Markdown 正常语义，不拦）', () => {
    const next = replaceBlockAt(SECTION, 2, '前半句。\n\n后半句。')
    expect(next).toBe('# 小标题\n\n第一段正文。\n\n前半句。\n\n后半句。\n\n第三段正文。')
  })

  it('新内容为空 = 删除这一块，后面的块顺次前移', () => {
    const next = replaceBlockAt(SECTION, 2, '')
    expect(next).toBe('# 小标题\n\n第一段正文。\n\n第三段正文。')
  })

  it('只剩一块时清空它，整节变成空字符串（可撤销，故允许）', () => {
    expect(replaceBlockAt('只有一段。', 0, '')).toBe('')
  })

  it('序号越界回 null —— 绝不夹紧到最后一块后硬写，那会改到用户没选的段落', () => {
    expect(replaceBlockAt(SECTION, 99, 'x')).toBeNull()
    expect(replaceBlockAt(SECTION, -1, 'x')).toBeNull()
    expect(replaceBlockAt(SECTION, NaN, 'x')).toBeNull()
  })
})

describe('isBlockUnchanged', () => {
  it('逐字节相同 → 真（调用方据此跳过写盘）', () => {
    expect(isBlockUnchanged('第一段。', '第一段。')).toBe(true)
  })

  it('只多了首尾空行 → 仍算没变（splitBlocks 会把它们吃掉，写盘等于空转）', () => {
    expect(isBlockUnchanged('第一段。', '\n第一段。\n\n')).toBe(true)
  })

  it('内容真的变了 → 假', () => {
    expect(isBlockUnchanged('第一段。', '第一段！')).toBe(false)
  })

  it('清空 → 假（那是「删除这一段」这个真实意图，必须写盘）', () => {
    expect(isBlockUnchanged('第一段。', '')).toBe(false)
    expect(isBlockUnchanged('第一段。', '   \n  ')).toBe(false)
  })
})

describe('pushBounded', () => {
  it('未到上限时直接追加，不改动入参数组', () => {
    const stack = [1, 2]
    expect(pushBounded(stack, 3, 5)).toEqual([1, 2, 3])
    expect(stack).toEqual([1, 2])
  })

  it('超出上限时丢最老的一条，长度恒定', () => {
    expect(pushBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/studio
bun test src/chat/lib/writingEdit.test.ts
```

预期：FAIL，报找不到模块 `./writingEdit`。

- [ ] **Step 3: 写实现**

创建 `apps/studio/src/chat/lib/writingEdit.ts`：

```ts
import { splitBlocks, spliceBlocks } from '@desktop-shared/proposalBlocks'

/**
 * 手动编辑用的块级操作。与 `writingRevision.ts`（AI 改写）分开成两个模块：那边的重头戏是
 * 「AI 回来的文本怎么在漂过的正文里重新定位」，这边不需要——手动编辑期间 AI 被锁住不写盘
 * （见 useWritingInProgress 那道闸），块序号在编辑窗口内是稳定的，直接按序号操作即可。
 * 两边共用底层的 splitBlocks / spliceBlocks，不共用定位逻辑。
 */

/** 取出第 `blockIndex` 块的 markdown 源码。序号非法回 null —— 调用方据此拒绝进入编辑态。 */
export function blockSourceAt(sectionMarkdown: string, blockIndex: number): string | null {
  if (!Number.isInteger(blockIndex) || blockIndex < 0) return null
  const blocks = splitBlocks(sectionMarkdown)
  if (blockIndex >= blocks.length) return null
  return blocks[blockIndex]
}

/**
 * 把第 `blockIndex` 块换成 `nextBlockMarkdown`，返回整节的新源码。
 *
 * `nextBlockMarkdown` 为空 = 删除这一块（spliceBlocks 里 splitBlocks('') 得空数组，
 * 前后两段直接接上）。这是「把输入框清空 = 删掉这一段」这条产品约定的实现点，
 * 有撤销栈兜底，故不在这里拦。
 *
 * 【为什么越界必须回 null 而不是交给 spliceBlocks 夹紧】spliceBlocks 会把越界端点
 * clamp 到最后一块（它是为「AI 改写的 stale range」设计的容错）。手动编辑里越界只可能
 * 来自「用户编辑期间这一节被换掉了」，此时夹紧等于把用户的字写进他没选的那一段——
 * 静默改错内容，比拒绝写入糟糕得多。
 */
export function replaceBlockAt(
  sectionMarkdown: string,
  blockIndex: number,
  nextBlockMarkdown: string
): string | null {
  if (!Number.isInteger(blockIndex) || blockIndex < 0) return null
  const blocks = splitBlocks(sectionMarkdown)
  if (blockIndex >= blocks.length) return null
  return spliceBlocks(sectionMarkdown, { start: blockIndex, end: blockIndex }, nextBlockMarkdown)
}

/**
 * 用户在输入框里改出来的内容，和进入编辑时那一块，落到磁盘上会不会是同一个东西。
 *
 * 比的是**规范形态**（都过一遍 splitBlocks 再 join）而不是裸字符串：用户在末尾多敲一个
 * 回车，splitBlocks 会把它吃掉、写进磁盘的字节完全相同——此时写盘是纯空转，还会白占一格
 * 撤销额度（用户点开看一眼再点走，就少一次真正的后悔机会）。
 *
 * 注意清空必须判为「变了」：那是「删除这一段」这个真实意图，不是空转。
 */
export function isBlockUnchanged(originalBlock: string, candidate: string): boolean {
  return splitBlocks(originalBlock).join('\n\n') === splitBlocks(candidate).join('\n\n')
}

/** 定长栈追加：超出 `max` 时丢最老的一条。不改动入参（zustand 要求 immutable 更新）。 */
export function pushBounded<T>(stack: T[], item: T, max: number): T[] {
  const next = [...stack, item]
  return next.length > max ? next.slice(next.length - max) : next
}
```

- [ ] **Step 4: 跑测试确认全过**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/studio
bun test src/chat/lib/writingEdit.test.ts
```

预期：PASS，全部 13 个用例通过。

如果「只剩一块时清空整节变空字符串」那条失败，去读 `electron/shared/proposalBlocks.ts` 的 `spliceBlocks` 第一行 `if (blocks.length === 0) return replacement.trim()` —— 它处理的是**原文为空**的情况，与本用例（原文一块、替换为空）不同路径，用例期望值以实际实现为准，但**必须先确认实现是对的，不要为了让测试变绿而改期望值**。

- [ ] **Step 5: typecheck**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run typecheck
```

预期：全绿。

- [ ] **Step 6: 提交**

```bash
git add apps/studio/src/chat/lib/writingEdit.ts apps/studio/src/chat/lib/writingEdit.test.ts
git commit -m "feat(writing): 加块级编辑纯函数（取块/换块/变没变/定长栈）

手动编辑不需要 AI 改写那套重定位——编辑期间 AI 被锁住不写盘，块序号稳定，
按序号直接操作即可。越界一律回 null 不夹紧：夹紧会把用户的字写进他没选的段落。"
```

---

### Task 3: 【纯重构】抽出共用的写盘落地函数

**这是一次纯重构：行为必须零变化。不要在本任务里夹带任何新功能。**

**Files:**
- Modify: `apps/studio/src/chat/components/workspace/WritingDocPanel.tsx`（`applyReview` 函数，约 265-338 行）

**Interfaces:**
- Consumes: 现有的 `window.chatApi.writingWriteSection`、`useWritingStore`
- Produces（Task 4 / Task 6 会调用）:
  - `commitSection(input: { sectionName: string; markdown: string; expectedMtimeMs: number }): Promise<'ok' | 'conflict' | 'error'>` —— 组件内的局部函数（不导出），负责写盘 + 冲突处理 + store 更新 + 提示文案

**背景：** 现在 `applyReview` 里从 `setApplying(true)` 到 `finally` 之间那一段（写盘 → 三种结果分支 → store 更新 → 提示文案）是 AI 改写专用的。Task 6 的手动编辑要走一模一样的逻辑，两处各写一份必然在冲突文案与 store 更新顺序上漂。先把它抽出来。

- [ ] **Step 1: 读懂现有实现**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
sed -n '260,340p' apps/studio/src/chat/components/workspace/WritingDocPanel.tsx
```

重点看三条不变量，重构后必须原样保留：
1. 冲突时**不覆盖**，把盘上最新内容灌回 store。
2. `res.current` 为 null（文件被删/改名）与非 null（被改过）**必须两条不同文案** —— 说错了会让用户按提示再操作一次、再撞同一堵墙。
3. `expectedMtimeMs` 由调用方传入，不在函数内部现读。

- [ ] **Step 2: 抽出 `commitSection`**

在 `WritingDocPanel` 组件内、`applyReview` 之前插入：

```tsx
  /**
   * 把一节的新内容写回磁盘，并按结果更新 store / 提示文案。
   *
   * **AI 改写「应用」与手动编辑共用这一条**（2026-07-31 抽出）：两条通道的差别只在
   * 「新内容从哪来」，写盘、乐观锁冲突处理、store 更新、提示文案完全一样。两处各写一份
   * 必然在文案与更新顺序上漂——而这里每一条文案都对应一种「你的改动没生效」的具体原因，
   * 漂了就等于给用户指错下一步。
   *
   * `expectedMtimeMs` 一律由**调用方**传入，绝不在函数内部现读最新值：基准必须与调用方
   * 当初看到的那一版同源同刻，否则乐观锁只覆盖「最后一次轮询到写盘」那 2 秒，
   * 「期间被 AI 改过」这个最该拦的场景恰好漏掉（完整推演见 stores/writing.ts 的
   * baseMtimeMs 字段注释）。
   */
  const commitSection = useCallback(
    async (input: {
      sectionName: string
      markdown: string
      expectedMtimeMs: number
    }): Promise<'ok' | 'conflict' | 'error'> => {
      const src = useWritingStore.getState().source
      if (!src) return 'error'
      const res = await window.chatApi.writingWriteSection({
        source: src,
        name: input.sectionName,
        markdown: input.markdown,
        expectedMtimeMs: input.expectedMtimeMs
      })
      const after = useWritingStore.getState()
      if (res.ok) {
        after.replaceSectionMarkdown(input.sectionName, input.markdown, res.mtimeMs)
        after.setConflictMsg('')
        return 'ok'
      }
      if (res.conflict) {
        // 乐观锁拦下：不覆盖，把盘上最新的灌回来。
        // res.current 为 null = 文件没了（被删/改名），不是「被改过」——两种情况必须两条
        // 文案：说成「已刷新到最新内容，请重新选中修改」会让用户再操作一次、再撞同样的墙。
        if (res.current) {
          after.replaceSectionMarkdown(
            input.sectionName,
            res.current.markdown,
            res.current.mtimeMs
          )
        }
        after.setConflictMsg(
          res.current
            ? '这一节刚被 AI 改过，你的改动未生效。已刷新到最新内容，请重新选中修改。'
            : '这一节的文件已不存在（可能被删除或改名），改动未生效。'
        )
        return 'conflict'
      }
      after.setConflictMsg(`写入失败：${res.error}`)
      return 'error'
    },
    []
  )
```

- [ ] **Step 3: 让 `applyReview` 改用它**

把 `applyReview` 里 `setApplying(true)` 之后那一整段（从 `const next = applyRevision(...)` 到 `after.setConflictMsg(\`写入失败：${res.error}\`)`）替换为：

```tsx
    setApplying(true)
    try {
      const next = applyRevision(sec.markdown, range, r.after)
      const outcome = await commitSection({
        sectionName: r.target.sectionName,
        markdown: next,
        expectedMtimeMs: r.baseMtimeMs
      })
      // 三种结果都要收掉对照卡：成功已落地；冲突/失败时卡上的 range 与 before 已对不上
      // 盘上的内容，留着它用户只会再点一次、再撞一次同样的墙。
      if (outcome !== 'error') useWritingStore.getState().setReview(null)
      else useWritingStore.getState().setReview(null)
    } finally {
      setApplying(false)
    }
```

**注意：** 上面那两行 if/else 分支体相同，是为了保留「原实现在三条路径上都调了 `setReview(null)`」这个事实并让它显式可见。实施时请**核对原实现**：若原代码在 `error` 路径上没有 `setReview(null)`，就必须照原样保留（纯重构不许改行为），并把这段简化成对应的形态。

- [ ] **Step 4: 把 `commitSection` 加进 `applyReview` 的依赖数组**

`applyReview` 现在的 `useCallback` 依赖数组是 `[]`。加上 `commitSection`：

```tsx
  }, [commitSection])
```

（`commitSection` 自身依赖数组为 `[]`，引用稳定，不会造成重复创建。）

- [ ] **Step 5: typecheck**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run typecheck
```

预期：全绿。

- [ ] **Step 6: 手动回归 —— 确认 AI 改写这条路行为没变**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run dev
```

在应用里：跑一次写作技能出至少一节正文 → 在右栏纸面选中一段 → 输入改写指令 → 等对照卡 → 点「应用」。

预期：与重构前完全一致——纸面更新、对照卡消失、没有冲突提示。

- [ ] **Step 7: 提交（纯重构单独一次提交）**

```bash
git add apps/studio/src/chat/components/workspace/WritingDocPanel.tsx
git commit -m "refactor(writing): 抽出共用的写盘落地函数 commitSection

行为零变化。把 applyReview 里的写盘 + 乐观锁冲突处理 + store 更新 + 提示文案
抽成组件内的 commitSection，为手动编辑复用同一条链做准备——两处各写一份必然
在冲突文案与更新顺序上漂，而每条文案都对应一种「你的改动没生效」的具体原因。"
```

- [ ] **Step 8: 停下来，请用户过目这次重构**

按用户既定偏好：纯重构与行为改动分两次做，重构要先给他看过再动行为。**不要自动继续 Task 4**，先汇报这次重构改了什么、验证过什么，等用户确认。

---

### Task 4: 撤销栈 + 接进 AI 改写「应用」

**Files:**
- Modify: `apps/studio/src/chat/stores/writing.ts`
- Modify: `apps/studio/src/chat/components/workspace/WritingDocPanel.tsx`

**Interfaces:**
- Consumes: `pushBounded`（Task 2）、`commitSection`（Task 3）
- Produces（Task 5 / Task 6 调用）:
  - store 字段 `undoStack: WritingUndoEntry[]`
  - store action `pushUndo(entry: WritingUndoEntry): void`
  - store action `popUndo(): WritingUndoEntry | null`
  - 导出常量 `MAX_WRITING_UNDO = 20`
  - 导出类型 `WritingUndoEntry = { sectionName: string; markdown: string }`

- [ ] **Step 1: 在 store 里加类型与常量**

编辑 `apps/studio/src/chat/stores/writing.ts`，在 `MAX_WRITING_REVISION_QUEUE` 那一行之后加：

```ts
/**
 * 撤销栈上限。20 步足够覆盖「刚才手滑那几下」，而这是个纯内存栈（关窗即失），
 * 不设上限的话长时间写一篇长文会把每一节的历史全副本堆在内存里。
 */
export const MAX_WRITING_UNDO = 20

/**
 * 一步可撤销的修改：**改之前**那一节长什么样。
 *
 * 刻意不存 mtime：撤销的语义是「把它现在变回旧样子」，写盘基准应取**撤销那一刻**盘上的
 * 最新 mtime，而不是当初改动前的。存了反而会诱使实现去用那个陈旧值——那样一来，用户改了
 * 三步再撤销，基准是三步之前的，乐观锁必然误报冲突。
 */
export interface WritingUndoEntry {
  sectionName: string
  markdown: string
}
```

- [ ] **Step 2: 在 store 接口与实现里加字段和 action**

在 `interface WritingState` 里，`conflictMsg: string` 之后加：

```ts
  /**
   * 撤销栈。**AI 改写「应用」与手动编辑共用**——用户心里只有一个「后悔」的概念，
   * 不该因为这次改动来自哪条通道而行为不同。只在内存，不持久化（关窗即失）。
   */
  undoStack: WritingUndoEntry[]
  pushUndo: (entry: WritingUndoEntry) => void
  /** 弹出栈顶；空栈回 null。弹出即消费，撤销失败也不回填——不做重做。 */
  popUndo: () => WritingUndoEntry | null
```

在 `create<WritingState>` 的初始值里，`conflictMsg: ''` 之后加 `undoStack: [],`，并在 `setConflictMsg` 之后加实现：

```ts
  pushUndo: (entry) => set((s) => ({ undoStack: pushBounded(s.undoStack, entry, MAX_WRITING_UNDO) })),
  popUndo: () => {
    const stack = get().undoStack
    if (stack.length === 0) return null
    const top = stack[stack.length - 1]
    set({ undoStack: stack.slice(0, -1) })
    return top
  },
```

文件顶部加 import：

```ts
import { pushBounded } from '../lib/writingEdit'
```

- [ ] **Step 3: 换源时清空撤销栈**

在 `setSource` 的 `set({...})` 里，`conflictMsg: ''` 之后加：

```ts
      // 换源 = 换了篇稿子，旧稿的 sectionName 对新稿没有意义。留着它撤销会把上一篇的
      // 内容写进这一篇的同名文件——这类跨文档串台是不可逆的正文损坏，与上面 pending/queue
      // 必须跟着清空是同一个理由。
      undoStack: [],
```

- [ ] **Step 4: 让 AI 改写「应用」成功时压栈**

编辑 `WritingDocPanel.tsx` 的 `applyReview`，在调用 `commitSection` **之前**取出旧内容，成功后压栈：

```tsx
    setApplying(true)
    try {
      const before = sec.markdown
      const next = applyRevision(sec.markdown, range, r.after)
      const outcome = await commitSection({
        sectionName: r.target.sectionName,
        markdown: next,
        expectedMtimeMs: r.baseMtimeMs
      })
      // 只在真的写进去了才压栈：冲突/失败时磁盘没变，压进去会让「撤销」把一个从未生效的
      // 状态写回磁盘——那不是撤销，是凭空改稿。
      if (outcome === 'ok') {
        useWritingStore.getState().pushUndo({ sectionName: r.target.sectionName, markdown: before })
      }
      useWritingStore.getState().setReview(null)
    } finally {
      setApplying(false)
    }
```

- [ ] **Step 5: typecheck**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run typecheck
```

预期：全绿。

- [ ] **Step 6: 跑全量测试确认没碰坏别的**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/studio
bun test
```

预期：全绿。

- [ ] **Step 7: 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/studio/src/chat/stores/writing.ts apps/studio/src/chat/components/workspace/WritingDocPanel.tsx
git commit -m "feat(writing): 加撤销栈，AI 改写应用后可回退

内存级、上限 20 步、换源清空。只在写盘真的成功时压栈——冲突/失败时磁盘没变，
压进去会让撤销把一个从未生效的状态写回磁盘。栈里刻意不存 mtime：撤销的基准该取
撤销那一刻的最新值，存了会诱使实现用陈旧值、连撤三步必然误报冲突。"
```

---

### Task 5: 顶栏「撤销上一步」按钮

**Files:**
- Modify: `apps/studio/src/chat/components/workspace/WritingDocPanel.tsx`

**Interfaces:**
- Consumes: `popUndo` / `pushUndo` / `undoStack`（Task 4）、`commitSection`（Task 3）
- Produces: 无（UI 终点）

- [ ] **Step 1: 加 undo 落地函数**

在 `WritingDocPanel` 组件内、`commitSection` 之后加：

```tsx
  // 撤销在飞：防连点。连点会让第二次拿着已经被第一次改掉的 mtime 去写，必撞假冲突。
  const [undoing, setUndoing] = useState(false)
  const undoDepth = useWritingStore((s) => s.undoStack.length)

  /**
   * 撤销上一步。把栈顶那一节的旧内容**再写一次盘**（而不是只改 store）——磁盘是这个技能
   * 事实上的真相源：质检脚本、续写工作流、导出全都直接读盘，只改 store 会让屏幕上和盘上
   * 分家，用户以为撤销了，AI 续写时接的还是没撤销的那版。
   *
   * 基准取**当前** store 里那一节的 mtime（不是栈里存的）：撤销的语义是「把它现在变回
   * 旧样子」。若这中间 AI 又改过这一节，乐观锁会拦下并提示，不静默覆盖。
   */
  const undoLast = useCallback(async (): Promise<void> => {
    if (undoing) return
    const st = useWritingStore.getState()
    const entry = st.popUndo()
    if (!entry) return
    const sec = st.sections.find((s) => s.name === entry.sectionName)
    if (!sec) {
      st.setConflictMsg('这一节的文件已不在了，撤销未生效。')
      return
    }
    setUndoing(true)
    try {
      const outcome = await commitSection({
        sectionName: entry.sectionName,
        markdown: entry.markdown,
        expectedMtimeMs: sec.mtimeMs
      })
      // 撤销失败不把 entry 塞回栈：塞回去用户会以为还能再撤一次，而失败原因（这一节被
      // 改过 / 文件没了）多半下一次还在，只是让他再撞一次。冲突提示已经说清了发生什么。
      if (outcome !== 'ok') return
    } finally {
      setUndoing(false)
    }
  }, [commitSection, undoing])
```

- [ ] **Step 2: 在顶栏右侧组里加按钮**

在顶栏 `<div className="flex min-w-0 items-center gap-2 [-webkit-app-region:no-drag]">` 里、`{exportMsg && (...)}` **之前**插入：

```tsx
          {/* 撤销上一步。落在这个 no-drag 分组内（新增控件自动继承挖洞，不必逐个挖）——
              顶栏整条在根 .window-drag-strip 里，漏挖的表现是「按钮点了没反应、按住会拖动
              窗口」且控制台零报错。 */}
          {undoDepth > 0 && (
            <Button
              size="xs"
              variant="ghost"
              disabled={undoing}
              onClick={() => void undoLast()}
              title={`撤销上一步修改（还可撤销 ${undoDepth} 步）`}
            >
              {undoing ? '撤销中…' : '撤销'}
            </Button>
          )}
```

- [ ] **Step 3: typecheck**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run typecheck
```

预期：全绿。

- [ ] **Step 4: 手动走查**

```bash
bun run dev
```

1. 跑写作技能出正文 → 选段改写 → 应用 → 顶栏出现「撤销」按钮。
2. 点「撤销」→ 纸面回到改写前 → 按钮消失（栈空了）。
3. `cat` 那个 md 文件确认**盘上真的回退了**，不只是屏幕上。
4. 按住「撤销」按钮拖动 → 窗口**不应该**跟着动（no-drag 挖洞生效）。

- [ ] **Step 5: 提交**

```bash
git add apps/studio/src/chat/components/workspace/WritingDocPanel.tsx
git commit -m "feat(writing): 顶栏加「撤销上一步」

撤销是把旧内容再写一次盘而不是只改 store——磁盘是这个技能的真相源，只改 store
会让 AI 续写时接的还是没撤销的那版。基准取撤销那一刻的最新 mtime；期间被 AI 改过
则乐观锁拦下并提示，不静默覆盖。"
```

---

### Task 6: 纸面块编辑态 + 手动编辑落地

**Files:**
- Modify: `apps/studio/src/chat/components/workspace/WritingPaper.tsx`
- Modify: `apps/studio/src/chat/components/workspace/WritingDocPanel.tsx`

**Interfaces:**
- Consumes: `blockSourceAt` / `replaceBlockAt` / `isBlockUnchanged`（Task 2）、`commitSection`（Task 3）、`pushUndo`（Task 4）
- Produces:
  - `WritingPaper` 新增可选 prop `onEditBlock?: (input: { sectionName: string; blockIndex: number; nextBlockMarkdown: string; baseMtimeMs: number }) => Promise<boolean>` —— 返回 `true` = 存盘成功（编辑框可以关掉），`false` = 失败（停在原块）

- [ ] **Step 1: 给 WritingPaper 加编辑态**

在 `WritingPaper.tsx` 顶部加 import：

```tsx
import { useCallback, useMemo, useRef, useState } from 'react'
import { blockSourceAt, isBlockUnchanged } from '../../lib/writingEdit'
```

在 props 类型里加：

```tsx
  /**
   * 提交一次手动编辑。**省略时纸面仍是纯只读的**（与 onRevise 同款约定：能力跟着 prop
   * 挂载，不无条件常驻）。返回 true = 已存盘、可以关掉编辑框；false = 存盘失败，停在原块
   * 让用户看到错误并重试——**不要在失败时也关掉编辑框**，那会让错误提示伴随焦点转移一起
   * 被忽略，用户以为存上了。
   */
  onEditBlock?: (input: {
    sectionName: string
    blockIndex: number
    nextBlockMarkdown: string
    baseMtimeMs: number
  }) => Promise<boolean>
```

在组件内、`scrollRef` 之后加状态：

```tsx
  const sectionsRaw = useWritingStore((s) => s.sections)
  /**
   * 当前正在编辑哪一块。同一时刻只有一个 —— 双击另一块会先存当前块再进新块（见 commitEdit）。
   * `draft` 是输入框里的实时内容，`base` 是进入编辑那一刻这一块的源码（用来判「变没变」），
   * `baseMtimeMs` 是**那一刻**这一节的 mtime，写盘时当乐观锁基准。
   *
   * 【为什么 baseMtimeMs 必须在进入编辑时快照，不能写盘时现读】轮询每 2s 把 sections 连同
   * mtime 刷一遍。现读的话，「你编辑期间这一节被 AI 或外部改过」——锁最该拦的场景——会因为
   * 基准已经悄悄跟到最新而比对相等、直接放行，把基于旧版编辑的内容拼进新版的错误位置。
   * 完整推演见 stores/writing.ts 的 baseMtimeMs 字段注释，那是同一颗地雷。
   */
  const [editing, setEditing] = useState<{
    sectionName: string
    blockIndex: number
    base: string
    draft: string
    baseMtimeMs: number
  } | null>(null)
  const [saving, setSaving] = useState(false)
```

- [ ] **Step 2: 加进入 / 取消 / 提交三个动作**

在 `blocks` 的 `useMemo` 之后加：

```tsx
  /** 双击进入编辑。AI 正在落字时不许进（见下面的 canEdit 判据）。 */
  const beginEdit = useCallback(
    (sectionName: string, blockIndex: number): void => {
      if (!onEditBlock || writing) return
      const sec = sectionsRaw.find((s) => s.name === sectionName)
      if (!sec) return
      const source = blockSourceAt(sec.markdown, blockIndex)
      if (source === null) return
      // 清掉浏览器选区：双击本身会选中一个词，不清的话选区改写气泡会同时冒出来，
      // 两条修改通道各有一套定位，同时开着必然打架。
      window.getSelection()?.removeAllRanges()
      setEditing({
        sectionName,
        blockIndex,
        base: source,
        draft: source,
        baseMtimeMs: sec.mtimeMs
      })
    },
    [onEditBlock, writing, sectionsRaw]
  )

  /**
   * 提交当前编辑。返回 true = 可以离开这一块（存成功、或内容压根没变）。
   *
   * 内容没变时直接返回 true 不写盘：省掉一次无意义 IPC，也省掉一格撤销额度——用户点开
   * 看一眼再点走，不该消耗掉一次真正的后悔机会。
   */
  const commitEdit = useCallback(async (): Promise<boolean> => {
    if (!editing || !onEditBlock) return true
    if (isBlockUnchanged(editing.base, editing.draft)) {
      setEditing(null)
      return true
    }
    setSaving(true)
    try {
      const ok = await onEditBlock({
        sectionName: editing.sectionName,
        blockIndex: editing.blockIndex,
        nextBlockMarkdown: editing.draft,
        baseMtimeMs: editing.baseMtimeMs
      })
      if (ok) setEditing(null)
      return ok
    } finally {
      setSaving(false)
    }
  }, [editing, onEditBlock])

  /** Esc 取消：丢弃修改，不写盘。 */
  const cancelEdit = useCallback((): void => setEditing(null), [])
```

- [ ] **Step 3: 渲染编辑态**

把现有的块渲染（`blocks.map(...)` 那一段）替换为：

```tsx
        {blocks.map((sec) =>
          sec.items.map((block, i) => {
            const isEditing =
              editing !== null && editing.sectionName === sec.name && editing.blockIndex === i
            return (
              <div
                key={`${sec.name}:${i}`}
                data-section-name={sec.name}
                data-block-index={i}
                className="writing-block"
                onDoubleClick={isEditing ? undefined : () => beginEdit(sec.name, i)}
              >
                {isEditing ? (
                  <div className="my-1">
                    <textarea
                      autoFocus
                      value={editing.draft}
                      disabled={saving}
                      onChange={(e) => setEditing({ ...editing, draft: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelEdit()
                          return
                        }
                        // Cmd/Ctrl+Enter 存盘。裸 Enter 不能当存盘键 —— 段落里换行是正常写作动作。
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          void commitEdit()
                        }
                      }}
                      onBlur={() => void commitEdit()}
                      // 高度随内容长：不这么做就是滚动条套滚动条（纸面本身已经是滚动容器）。
                      rows={Math.max(2, editing.draft.split('\n').length + 1)}
                      className="w-full resize-none rounded-md border border-accent bg-muted/40 px-2 py-1.5 font-mono text-[13px] leading-relaxed text-foreground outline-none"
                    />
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {saving ? '保存中…' : 'Esc 取消 · 点击别处保存'}
                    </div>
                  </div>
                ) : (
                  <AssistantMarkdown text={block} />
                )}
              </div>
            )
          })
        )}
```

- [ ] **Step 4: AI 忙时的提示条**

把现有的 `{status === 'error' && (<div className="sticky top-0 ...">...)}` 那一段改成二选一（**刷新失败优先**，两条不叠成两行占掉纸面顶部）：

```tsx
      {/* 顶部单条状态提示。两条可能同时成立时「刷新失败」优先——它关乎「你现在看的内容是不是
          最新的」，比「现在不能编辑」更要紧；叠成两行会把纸面顶部占掉两条。 */}
      {status === 'error' ? (
        <div className="sticky top-0 z-10 border-b border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 backdrop-blur-sm dark:text-amber-400">
          刷新文稿失败，下面显示的可能不是最新内容{errMsg ? `：${errMsg}` : ''}
        </div>
      ) : writing && onEditBlock ? (
        <div className="sticky top-0 z-10 border-b border-border bg-muted/60 px-3 py-1.5 text-[11px] text-muted-foreground backdrop-blur-sm">
          AI 正在写这篇稿子，暂时不能编辑
        </div>
      ) : null}
```

**同时**：在编辑框上方加一条黄条 —— 用户已经在编辑、AI 突然开写时**不踢他出去**（那会直接丢掉正敲的字）。在 Step 3 的 `<div className="my-1">` 内、`<textarea>` 之前插入：

```tsx
                    {writing && (
                      <div className="mb-1 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                        AI 正在改这篇稿子，保存时可能冲突
                      </div>
                    )}
```

- [ ] **Step 5: 编辑中隐藏选区改写气泡**

把底部的 `{onRevise && (<WritingSelectionBubble ... />)}` 改成：

```tsx
      {/* 编辑中隐藏气泡：同一时刻只走一条修改通道。两套定位（气泡按块区间、编辑按块序号）
          同时开着必然打架。 */}
      {onRevise && editing === null && (
        <WritingSelectionBubble containerRef={scrollRef} busy={busy} onSubmit={onRevise} />
      )}
```

- [ ] **Step 6: 更新组件头注释**

把 `WritingPaper` 头注释里那句「**只读**——第一版不做手动改字（见 spec「明确不做」），一切修改经 AI 改写通道」替换为：

```tsx
/**
 * 文稿态纸面。两条修改通道：选中一段交给 AI 改写（气泡），或**双击一块就地改它的
 * Markdown 源码**（2026-07-31 加，推翻了前作 spec 的「明确不做手动编辑」）。
 *
 * 手动编辑改的是**源码而不是排好版的字**：所见即所得要把富文本反向转回 Markdown，
 * 加粗 / 列表 / 链接在来回转换里很容易跑掉，工作量还大一个量级。
 *
 * 逐块渲染（块 = 一个标题/段落/列表/表格/围栏代码，切法见 proposalBlocks.ts）而不是把整节
 * 丢给一个 markdown 组件：块的 DOM 边界既是选区改写的定位锚点（`data-section-name` +
 * `data-block-index`），也是手动编辑的最小单元。整节渲染时这个映射无从建立。
 */
```

- [ ] **Step 7: 在 WritingDocPanel 里实现 onEditBlock**

在 `WritingDocPanel` 组件内、`undoLast` 之后加：

```tsx
  /**
   * 手动编辑落地。与 AI 改写「应用」共用 commitSection 与撤销栈——两条通道的差别只在
   * 「新内容从哪来」。
   *
   * 返回 false 时纸面会停在编辑态让用户重试，所以这里**不能吞掉失败**：
   * 越界（编辑期间这一节被换掉了）与写盘冲突都要如实回 false 并留下提示。
   */
  const editBlock = useCallback(
    async (input: {
      sectionName: string
      blockIndex: number
      nextBlockMarkdown: string
      baseMtimeMs: number
    }): Promise<boolean> => {
      const st = useWritingStore.getState()
      const sec = st.sections.find((s) => s.name === input.sectionName)
      if (!sec) {
        st.setConflictMsg('这一节的文件已不在了，改动未写入。')
        return false
      }
      const next = replaceBlockAt(sec.markdown, input.blockIndex, input.nextBlockMarkdown)
      if (next === null) {
        // replaceBlockAt 越界回 null（它刻意不夹紧）：这一节在编辑期间被换掉了，
        // 硬写会把用户的字落进他没选的那一段。
        st.setConflictMsg('这一节的内容已经变了，改动未写入，请重新编辑。')
        return false
      }
      const before = sec.markdown
      const outcome = await commitSection({
        sectionName: input.sectionName,
        markdown: next,
        expectedMtimeMs: input.baseMtimeMs
      })
      if (outcome !== 'ok') return false
      useWritingStore.getState().pushUndo({ sectionName: input.sectionName, markdown: before })
      return true
    },
    [commitSection]
  )
```

文件顶部 import 加 `replaceBlockAt`：

```tsx
import { replaceBlockAt } from '../../lib/writingEdit'
```

- [ ] **Step 8: 把 onEditBlock 传给纸面**

```tsx
        <WritingPaper
          writing={writing}
          busy={streaming || pendingRevision !== null}
          onRevise={(target, instruction) => void submitRevision(target, instruction)}
          onEditBlock={editBlock}
        />
```

- [ ] **Step 9: typecheck + 全量测试**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run typecheck
cd apps/studio && bun test
```

预期：两条都全绿。

- [ ] **Step 10: 手动走查**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run dev
```

1. 双击一个段落 → 变成显源码的输入框，其余段落仍是排好版。
2. 改几个字 → 点纸面别处 → 编辑框关掉、纸面更新；`cat` 那个 md 文件确认盘上变了。
3. 双击 → 改字 → 按 Esc → 内容不变，`ls -l` 确认文件 mtime 没变。
4. 双击 A 段改字 → **直接双击 B 段** → A 的改动应该已存盘（不是被丢弃），B 进入编辑。
5. 清空一段 → 点别处 → 该段消失 → 点顶栏「撤销」→ 回来了。
6. AI 正在写的时候双击 → 进不去，纸面顶部有「AI 正在写这篇稿子，暂时不能编辑」。
7. 编辑框打开着的时候选中文字 → 改写气泡**不应该**出现。

- [ ] **Step 11: 提交**

```bash
git add apps/studio/src/chat/components/workspace/WritingPaper.tsx apps/studio/src/chat/components/workspace/WritingDocPanel.tsx
git commit -m "feat(writing): 纸面支持双击就地编辑 Markdown 源码

推翻前作 spec 的「明确不做手动编辑」。改源码而非所见即所得：富文本反向转 Markdown
容易丢加粗/列表/链接，工作量还大一个量级。

正面回答前作担心的时序问题：AI 落字期间禁止进入编辑（已在编辑的不踢出，只加黄条
提醒）；乐观锁基准在进入编辑时快照，不是写盘时现读——现读会让「编辑期间被改过」
这个最该拦的场景恰好漏掉。越界不夹紧、直接拒写。

与 AI 改写共用 commitSection 与撤销栈。"
```

---

### Task 7: 全量验收

**Files:** 无改动（纯验证）

**Interfaces:**
- Consumes: 前六个任务的全部产出
- Produces: 一份如实的验收报告

- [ ] **Step 1: 自动化防线**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run typecheck
cd apps/studio && bun test
```

两条都必须全绿。**任何一条不绿就不算做完** —— 如实报告失败输出，不要绕过。

- [ ] **Step 2: P0-1 三条手动走查**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun run dev
```

1. 跑一次真实的「优化已有作品」（给它一篇现成 md）→ 右栏出现稿子，不再是「还没有正文」。
2. 跑一次「只润色」→ `<cwd>/写作/` 下有 `-润色版.md` 文件，右栏接管。
3. 拿一篇公众号推文跑「改写」→ 右栏用**公众号皮肤**（手机窄栏），不是职场公文版式。

- [ ] **Step 3: P0-2 五条手动走查**

4. 双击段落 → 显源码；改字 → 点别处 → 纸面更新且 `cat` 确认盘上真的变了。
5. Esc → 内容不变，文件 mtime 不变。
6. 清空一段 → 该段消失 → 点「撤销」→ 回来了。
7. AI 正在写的时候双击 → 进不去，有提示。
8. **冲突验证（本轮最该验的一条）**：双击进入编辑 → 不要关掉编辑框，切到外部编辑器改**同一个 md 文件**并保存 → 回到应用点别处存盘 → 应出现「这一节刚被 AI 改过，你的改动未生效。已刷新到最新内容，请重新选中修改。」，且 `cat` 确认**外部的改动没有被覆盖**。

第 8 条验的是乐观锁基准取对了没有。基准若取成「写盘那一刻」，前七条全绿它也会静默毁数据 —— 这一条不过，整个 Task 6 要回炉。

- [ ] **Step 4: 更新 CLAUDE.md 里过时的一句**

`CLAUDE.md` 的「命令」一节写着「**没有单元测试、没有 ESLint**，类型检查是唯一的自动化防线」。实际上 `apps/studio/package.json` 有 `test` 脚本（`bun test electron/ src/chat/lib src/chat/composer`）。改成：

```markdown
改完代码以 `bun run typecheck` 为准——**没有 ESLint**，类型检查是唯一的全局防线；
另有 `bun test`（在 apps/studio 下跑）覆盖 `electron/`、`src/chat/lib`、`src/chat/composer`
三个目录的纯函数，新写的纯逻辑放进这三处才会被测到。
```

- [ ] **Step 5: 按仓库约定写事故/经验记录**

CLAUDE.md 要求：修了 bug 或踩了坑，写进 Obsidian vault 的 `errors/` 和 `sessions/`，并互相加双链。本轮值得记的两条：

1. 「工作流产物落点与前端扫描目录脱节 → 右栏恒空、零报错」这一类**契约在文档里、消费方在代码里，两边没有任何机制保证同步**的坑。
2. 乐观锁基准取「写盘那一刻」还是「用户开始改那一刻」—— 取错会让锁形同虚设且完全静默。

- [ ] **Step 6: 提交收尾改动**

```bash
git add CLAUDE.md
git commit -m "docs: 更新 CLAUDE.md 里「没有单元测试」的过时表述

apps/studio 有 bun test，覆盖 electron/、src/chat/lib、src/chat/composer 三个目录。"
```

---

## Self-Review 记录

**Spec 覆盖检查**（逐节比对设计文档）：

| Spec 章节 | 对应任务 |
|---|---|
| P0-1 三条工作流改落点 | Task 1 Step 2-4 |
| P0-1 落点分界（建项目 vs 快道） | Task 1 Step 4 |
| P0-1 最小体裁契约补丁 | Task 1 Step 5 |
| P0-1 更新 SKILL.md 与前作 spec | Task 1 Step 6-7 |
| P0-2 编辑形态（双击改源码） | Task 6 Step 1-3 |
| P0-2 状态机（Esc / 失焦 / Cmd+Enter / 内容没变不写盘） | Task 6 Step 2-3 |
| P0-2 双击另一块 = 先存再进 | Task 6 Step 3（`onBlur` 先触发 `commitEdit`，再由新块的 `onDoubleClick` 进入）+ Step 10 走查第 4 条 |
| P0-2 AI 忙时锁 + 已编辑不踢出 | Task 6 Step 1、Step 4 |
| P0-2 乐观锁基准取进入编辑那一刻 | Task 6 Step 1（`baseMtimeMs` 快照）+ Task 7 Step 3 第 8 条验收 |
| P0-2 不新增 IPC，复用 writingWriteSection | Task 3 + Task 6 Step 7 |
| P0-2 抽公共函数 | Task 3（单独的纯重构任务） |
| P0-2 撤销栈（两通道共用、20 步、换源清空、撤销也带锁） | Task 4 + Task 5 |
| P0-2 边界：清空=删除 / 空行拆两段 / 标题表格代码块 / 隐藏气泡 / 清选区 | Task 2 测试 + Task 6 Step 2、Step 5 |
| P0-2 样式纪律（no-drag、不 portal） | Task 5 Step 2、Global Constraints |
| 错误处理五种失败 | Task 3 Step 2（commitSection 三分支）+ Task 6 Step 7（越界）+ Task 5 Step 1（撤销冲突） |
| 测试与验收 | Task 2（自动化）+ Task 7（8 条走查） |

无遗漏。

**类型一致性检查**：`blockSourceAt` / `replaceBlockAt` / `isBlockUnchanged` / `pushBounded` 四个签名在 Task 2 定义，Task 4（`pushBounded`）、Task 6（其余三个）的调用处参数与返回值一致；`commitSection` 在 Task 3 定义返回 `'ok' | 'conflict' | 'error'`，Task 4/5/6 三处调用都按这三个字面量判断；`WritingUndoEntry` 在 Task 4 定义为 `{ sectionName, markdown }`（无 mtime），Task 5 的 `undoLast` 确实没有读它的 mtime，而是取当前 `sec.mtimeMs`。一致。

**决策留痕**：`onEditBlock` 返回 `Promise<boolean>` 而不是复用 `commitSection` 的三态字符串 —— 纸面只关心「能不能关掉编辑框」这一个判断，把三态透传给它等于让展示组件去理解写盘语义。
