# 「写方案」skill 化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「写方案」的方法论提示词外置为 `skills/proposal-writer/` 标准 skill 目录（占位符模板），并让聊天框 `/proposal-writer` 斜杠调用直达完整方案写作体验——注入路径、协议、硬门全部不变，提示词输出逐字节零回归。

**Architecture:** 三件套——① `skills/proposal-writer/`（SKILL.md 入口 + `references/append-template.md` 方法论模板，协议字样全为 `{{占位符}}`）；② `proposalPrompt.ts` 改为模板渲染器（运行期经 `resolveBundledSkillsPluginDir()` 读模板，渲染值取自 `shared/proposal.ts` 单一事实源）；③ renderer 斜杠入口（chip 注册 + `FusionRuntimeProvider.onNew` 拦截，复用场景卡 start/reopen 语义，不把命令发给 CLI）。

**Tech Stack:** Electron（main=Node / renderer=浏览器，双 tsconfig composite），bun（包管理 + `bun test`），zustand，assistant-ui。

**设计文档:** `docs/superpowers/specs/2026-07-03-proposal-writer-skill-design.md`（已含 §5.3 载入方式修订：Vite `?raw` → 运行期读 skills 目录，原因与可行性核实见 spec）。

## Global Constraints

- 包管理器是 **bun**，不是 npm；测试命令 `cd apps/desktop && bun test src/`，质量门 `bun run typecheck`（在仓库根跑，tsc node+web 双工程；**没有 ESLint、没有其它 CI 检查**）。
- 提示词渲染输出必须与改造前 `buildProposalAppend` 的输出**逐字节一致**（Task 1 固化的快照是仲裁者，绝不手动改快照文件来「让测试过」）。
- 模板 markdown 里**绝不出现协议字样明文**（哨兵 `===方案封面开始===` 等六个、`⚠️ 资料缺失：`、`封面确认`、`目录确认`）——只能是 `{{占位符}}`，事实源在 `apps/desktop/src/shared/proposal.ts`。
- `proposalPrompt.ts` 及其依赖链**不得 import `'electron'`**（`bun test` 加载不了 electron 模块——这正是 Task 2 存在的原因）。
- renderer 不得 import Node 模块；零新增 IPC 通道。
- 注释按项目惯例解释「为什么这样而不是那样」；本计划各代码块里的中文注释是交付物的一部分，照抄进代码。
- `tsconfig.node.json` 已排除 `src/**/*.test.ts`（bun:test 类型不进 tsc），新测试文件与被测文件同目录、以 `.test.ts` 结尾即可，无需动 tsconfig。
- 不碰：`engine.ts` 的 proposal 注入/补偿逻辑、`shared/proposal.ts` 全部、阶段硬门（`proposalStageGate.ts`）、导出器、检索。

---

### Task 1: 固化现版提示词输出快照（改造前基线）

改任何代码**之前**，先把现版 `buildProposalAppend` 的输出用 bun 快照测试固化。它是后续所有任务的逐字节回归仲裁者。

**Files:**
- Test: `apps/desktop/src/main/core/proposalPrompt.snapshot.test.ts`（新建）
- 生成: `apps/desktop/src/main/core/__snapshots__/proposalPrompt.snapshot.test.ts.snap`（bun 自动生成，要提交）

**Interfaces:**
- Consumes: 现有 `buildProposalAppend(mirrorDir: string, products?: ProposalProductScope[]): string`、`ProposalProductScope`（`./proposalPrompt`）
- Produces: 快照基线文件。Task 4 改造后此测试必须原样通过。

- [ ] **Step 1: 写快照测试**

创建 `apps/desktop/src/main/core/proposalPrompt.snapshot.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'

import { buildProposalAppend, type ProposalProductScope } from './proposalPrompt'

// skill 化改造（2026-07-03 设计）的逐字节回归基线：三种输入形态覆盖 scope 块与
// renderProductBlock 的全部分支——空清单回退、常规清单（含图/空 assets/空文件产品）、
// 文件数与图数双溢出截断。改造后（模板渲染）输出必须与这里固化的快照逐字节相等；
// 只有【有意】修改方法论文案时才允许 `bun test --update-snapshots` 刷新基线。
const EMPTY: ProposalProductScope[] = []

const NORMAL: ProposalProductScope[] = [
  {
    dir: '/kb/医疗线/预问诊',
    productLine: '医疗线',
    product: '预问诊',
    files: [
      {
        title: '产品白皮书',
        mirrorPath: '/kb/医疗线/预问诊/白皮书.md',
        // 路径故意带空格：验证清单渲染不动原始路径（尖括号包裹是 AI 侧纪律）
        assets: ['/kb/医疗线/预问诊/assets/首页 界面.png']
      },
      { title: '技术方案', mirrorPath: '/kb/医疗线/预问诊/技术方案.md', assets: [] }
    ]
  },
  { dir: '/kb/医疗线/空品', productLine: '医疗线', product: '空品', files: [] }
]

const OVERFLOW: ProposalProductScope[] = [
  {
    dir: '/kb/线/品',
    productLine: '线',
    product: '品',
    files: Array.from({ length: 55 }, (_, i) => ({
      title: `文件${i}`,
      mirrorPath: `/kb/线/品/f${i}.md`,
      assets: i === 0 ? Array.from({ length: 15 }, (_, j) => `/kb/线/品/assets/img-${j}.png`) : []
    }))
  }
]

describe('buildProposalAppend 输出快照（skill 化改造的逐字节回归基线）', () => {
  it('空产品清单（scope 回退到 Grep/Glob 自查文案）', () => {
    expect(buildProposalAppend('/mirror/kb-index', EMPTY)).toMatchSnapshot()
  })

  it('常规产品清单（含图 / 空 assets / 空文件产品三种文件形态）', () => {
    expect(buildProposalAppend('/mirror/kb-index', NORMAL)).toMatchSnapshot()
  })

  it('文件数超 50 且首文件图数超 12 的双溢出截断', () => {
    expect(buildProposalAppend('/mirror/kb-index', OVERFLOW)).toMatchSnapshot()
  })
})
```

- [ ] **Step 2: 运行生成快照**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop
bun test src/main/core/proposalPrompt.snapshot.test.ts
```

预期：3 pass，0 fail，输出提到 `snapshots: +3 added`；生成 `src/main/core/__snapshots__/proposalPrompt.snapshot.test.ts.snap`。

- [ ] **Step 3: 复跑确认稳定（纯函数、无时间/随机因素）**

同上命令再跑一次。预期：3 pass，`+0 added`（全部命中已有快照）。

- [ ] **Step 4: 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/src/main/core/proposalPrompt.snapshot.test.ts apps/desktop/src/main/core/__snapshots__/
git commit -m "test(proposal): 固化 buildProposalAppend 输出快照——skill 化改造的逐字节回归基线"
```

---

### Task 2: 把 `resolveBundledSkillsPluginDir` 抽到 electron 无关模块

`proposalPrompt.ts`（Task 4）要在运行期定位 skills 目录，但该解析函数现居 `cliDetect.ts`，而 `cliDetect.ts` 顶部 `import { app } from 'electron'`——bun test 加载不了 electron，一旦 proposalPrompt 引它，全部 proposal 测试当场挂。先把函数原样搬到独立模块。

**Files:**
- Create: `apps/desktop/src/main/core/skillsDir.ts`
- Modify: `apps/desktop/src/main/core/cliDetect.ts`（删除该函数及其独占注释；`existsSync`/`join` 等 import 若仍被其余函数使用则保留）
- Modify: `apps/desktop/src/main/core/engine.ts:44`（import 来源改为 `./skillsDir`）
- Modify: `apps/desktop/src/main/core/seedSkills.ts:4`（同上）

**Interfaces:**
- Produces: `resolveBundledSkillsPluginDir(): string | null`（`./skillsDir`）——签名、行为、候选路径列表与现版完全一致，Task 4 依赖它。

- [ ] **Step 1: 创建 `skillsDir.ts`，函数体从 `cliDetect.ts:180-201` 原样搬入**

```ts
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 从 cliDetect.ts 原样搬出（2026-07-03 skill 化改造）。为什么单独成模块：
// cliDetect 顶部 import electron 的 app，而本函数是纯 env + 路径探测、不碰 electron——
// proposalPrompt.ts 运行期读 skills/proposal-writer 模板要用它，且 proposalPrompt 的
// bun test（快照/契约）在无 electron 的进程里跑，依赖链上不允许出现 electron。
export function resolveBundledSkillsPluginDir(): string | null {
  const envOverride = process.env.FUSION_CODE_SKILLS_DIR
  if (envOverride) return existsSync(envOverride) ? envOverride : null

  const selfDir = dirname(fileURLToPath(import.meta.url))
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath
  const candidates = [
    ...(resourcesPath ? [resolve(resourcesPath, 'prebundled', 'skills')] : []),
    resolve(process.cwd(), '../../skills'),
    resolve(process.cwd(), '../../../skills'),
    resolve(selfDir, '../../../skills'),
    resolve(selfDir, '../../../../skills')
  ]
  for (const p of candidates) {
    // Require the plugin manifest, not just the dir — a bare skills/ without
    // `.claude-plugin/plugin.json` would make fusion-code's `--plugin` reject
    // it, so only return a path that will actually load.
    if (existsSync(join(p, '.claude-plugin', 'plugin.json'))) return p
  }
  return null
}
```

注意：搬运时把 `cliDetect.ts` 里该函数**原有的 doc 注释**（函数上方那段，若有）一并带过来放在新增注释之后，保持注释资产不丢。

- [ ] **Step 2: 从 `cliDetect.ts` 删除该函数，更新两处 import**

`engine.ts` 第 44 行附近，把 `resolveBundledSkillsPluginDir` 从 `./cliDetect` 的 import 列表里移出，新增：

```ts
import { resolveBundledSkillsPluginDir } from './skillsDir'
```

`seedSkills.ts` 第 4 行同理：

```ts
import { resolveBundledSkillsPluginDir } from './skillsDir'
```

然后确认无遗漏引用：

```bash
grep -rn "resolveBundledSkillsPluginDir" /Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop/src --include="*.ts"
```

预期：只出现在 `skillsDir.ts`（定义）、`engine.ts`、`seedSkills.ts`（import + 调用），`cliDetect.ts` 里一处都没有。

- [ ] **Step 3: 验证（纯搬运，无行为变化）**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
cd apps/desktop && bun test src/
```

预期：typecheck exit 0；bun test 全绿（含 Task 1 快照）。

- [ ] **Step 4: 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/src/main/core/skillsDir.ts apps/desktop/src/main/core/cliDetect.ts apps/desktop/src/main/core/engine.ts apps/desktop/src/main/core/seedSkills.ts
git commit -m "refactor(main): resolveBundledSkillsPluginDir 抽到 electron 无关的 skillsDir.ts——为 proposalPrompt 运行期读模板铺路"
```

---

### Task 3: 生成 `skills/proposal-writer/` 目录（模板 + SKILL.md + NOTES.md）

模板**必须由脚本从现版实现生成**，不许手抄——手抄必错（十几段 600 字中文、全角标点、行内 `\n`）。脚本思路：拿旧实现对空产品清单的输出，把 scope 行替换为 `{{KB_SCOPE}}`，再把每个协议常量值 replaceAll 成对应占位符（协议字样在方法论叙述里也会出现，如「封面确认」只能在…——全部占位符化是**有意的**：渲染回来逐字节相同，且模板从此不含明文）。

**Files:**
- Create: `skills/proposal-writer/SKILL.md`
- Create: `skills/proposal-writer/references/append-template.md`（脚本生成）
- Create: `skills/proposal-writer/NOTES.md`
- 临时脚本: `/private/tmp/claude-501/-Users-kika-Desktop-project-Electron-claude-desktop/0b10d040-e455-4122-a54a-ba22257d4221/scratchpad/gen-proposal-template.ts`（不提交）

**Interfaces:**
- Consumes: 旧版 `buildProposalAppend`（此刻尚未改造——本任务必须在 Task 4 之前）；`shared/proposal.ts` 的协议常量。
- Produces: `append-template.md`，含且仅含这些占位符：`{{KB_SCOPE}}`、`{{COVER_BEGIN}}`、`{{COVER_END}}`、`{{TOC_BEGIN}}`、`{{TOC_END}}`、`{{CONTENT_BEGIN}}`、`{{CONTENT_END}}`、`{{GAP_PREFIX}}`、`{{COVER_CONFIRM_HEADER}}`、`{{TOC_CONFIRM_HEADER}}`。Task 4 的渲染器按这些名字供值。

- [ ] **Step 1: 写生成脚本**

创建 `/private/tmp/claude-501/-Users-kika-Desktop-project-Electron-claude-desktop/0b10d040-e455-4122-a54a-ba22257d4221/scratchpad/gen-proposal-template.ts`：

```ts
// 一次性脚本：从【旧版】buildProposalAppend 生成 skills/proposal-writer 的占位符模板。
// 必须在 proposalPrompt.ts 改造（Task 4）之前运行。
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { buildProposalAppend } from '/Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop/src/main/core/proposalPrompt'
import {
  PROPOSAL_DRAFT_BEGIN,
  PROPOSAL_DRAFT_END,
  PROPOSAL_GAP_PREFIX,
  PROPOSAL_COVER_CONFIRM_HEADER,
  PROPOSAL_TOC_CONFIRM_HEADER
} from '/Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop/src/shared/proposal'

const REPO = '/Users/kika/Desktop/project/Electron/claude-desktop'
const MIRROR_SENTINEL = '__MIRROR_DIR_SENTINEL__'

const out = buildProposalAppend(MIRROR_SENTINEL, [])
const lines = out.split('\n')

// 空产品清单时 scope 块是单独一行（'1. 公司知识库的文本镜像在目录：…'），整行换成占位符。
const scopeIdx = lines.findIndex((l) => l.startsWith('1. 公司知识库的文本镜像在目录：'))
if (scopeIdx < 0) throw new Error('未找到 scope 行——proposalPrompt 结构变了？')
lines[scopeIdx] = '{{KB_SCOPE}}'
let tpl = lines.join('\n')

// 协议常量 → 占位符。replaceAll：常量值在方法论叙述里也会出现（如「封面确认」只能在…），
// 全部占位符化，渲染回来逐字节相同，且模板从此不含协议明文（契约测试据此把关）。
const SUBS: Array<[string, string]> = [
  [PROPOSAL_DRAFT_BEGIN.cover, '{{COVER_BEGIN}}'],
  [PROPOSAL_DRAFT_END.cover, '{{COVER_END}}'],
  [PROPOSAL_DRAFT_BEGIN.toc, '{{TOC_BEGIN}}'],
  [PROPOSAL_DRAFT_END.toc, '{{TOC_END}}'],
  [PROPOSAL_DRAFT_BEGIN.content, '{{CONTENT_BEGIN}}'],
  [PROPOSAL_DRAFT_END.content, '{{CONTENT_END}}'],
  [PROPOSAL_GAP_PREFIX, '{{GAP_PREFIX}}'],
  [PROPOSAL_COVER_CONFIRM_HEADER, '{{COVER_CONFIRM_HEADER}}'],
  [PROPOSAL_TOC_CONFIRM_HEADER, '{{TOC_CONFIRM_HEADER}}']
]
for (const [value, ph] of SUBS) tpl = tpl.replaceAll(value, ph)

if (tpl.includes(MIRROR_SENTINEL)) throw new Error('mirrorDir 残留在 scope 块之外——假设被打破')
for (const [value] of SUBS) {
  if (tpl.includes(value)) throw new Error(`协议明文残留：${value}`)
}

const dir = join(REPO, 'skills', 'proposal-writer', 'references')
mkdirSync(dir, { recursive: true })
// 文件末尾补一个 POSIX 换行；Task 4 的 loadAppendTemplate 会剥掉这一个字节。
writeFileSync(join(dir, 'append-template.md'), tpl + '\n')
console.log('written:', join(dir, 'append-template.md'), `(${tpl.length} chars)`)
```

- [ ] **Step 2: 运行并验证产物**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
bun /private/tmp/claude-501/-Users-kika-Desktop-project-Electron-claude-desktop/0b10d040-e455-4122-a54a-ba22257d4221/scratchpad/gen-proposal-template.ts
grep -c '{{KB_SCOPE}}' skills/proposal-writer/references/append-template.md
grep -c '===方案封面开始===\|⚠️ 资料缺失：' skills/proposal-writer/references/append-template.md || echo 'no protocol literals ✓'
```

预期：脚本打印 written 行；第一个 grep 输出 `1`；第二个 grep 无匹配（exit 1，回显 `no protocol literals ✓`）。

- [ ] **Step 3: 写 SKILL.md**

创建 `skills/proposal-writer/SKILL.md`：

```markdown
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
```

- [ ] **Step 4: 写 NOTES.md（迁移 TS 里的行间注释资产）**

创建 `skills/proposal-writer/NOTES.md`。内容 = 现版 `proposalPrompt.ts` `buildProposalAppend` 函数体内**全部 `//` 行间注释**，逐段原文迁入，每段前加一个二级标题点明它注解的是哪段纪律。骨架如下（`>` 引用处照抄 TS 里对应注释原文，一字不改）：

```markdown
# 方法论纪律的来龙去脉（自 proposalPrompt.ts 迁移，2026-07-03）

模板正文见 `references/append-template.md`。下面每段解释「为什么这样写而不是那样写」，
原为 buildProposalAppend 数组元素间的行间注释，模板化后无处安放、迁到这里。

## 提问纪律（AskUserQuestion 硬约束）
> （照抄原 TS 中「提问纪律：硬性约束——…」整段注释）

## 资料缺失标记（P3-2）
> （照抄原 TS 中「资料缺失标记（P3-2）：…」整段注释）

## 表格化呈现
> （照抄原 TS 中「表格化呈现：…」整段注释）

## 积极嵌图（配图密度增强 ①）
> （照抄原 TS 中「嵌图（配图密度增强 ①）：…」整段注释）

## Mermaid 结构图（配图密度增强 ②）
> （照抄原 TS 中「Mermaid 结构图（配图密度增强 ②）：…」整段注释）

## genimage 彩图指令（配图密度增强 ③）
> （照抄原 TS 中「AI 彩图指令（配图密度增强 ③）：…」整段注释）

## 哨兵规则
> （照抄原 TS 中「哨兵规则：…」整段注释）

## HTML 禁令
> （照抄原 TS 中「HTML 禁令：…」整段注释）
```

- [ ] **Step 5: 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add skills/proposal-writer/
git commit -m "feat(skills): 新增 proposal-writer skill 目录——写方案方法论模板（占位符化）+ 入口文档 + 注释资产"
```

（`skills/` 整树已在 `tools/pack/src/resources.ts` 的 `BUNDLED_RESOURCE_TREES` 与 plugin 挂载范围内，新目录自动随包、自动进斜杠命令列表，无需任何打包/engine 改动。）

---

### Task 4: `proposalPrompt.ts` 改为模板渲染（快照守门）

**Files:**
- Modify: `apps/desktop/src/main/core/proposalPrompt.ts`（整文件重写，见 Step 3）
- Test: `apps/desktop/src/main/core/proposalPromptTemplate.test.ts`（新建）
- 现有测试不动：`proposalPrompt.test.ts`、`proposalPrompt.snapshot.test.ts` 必须原样通过。

**Interfaces:**
- Consumes: `resolveBundledSkillsPluginDir()`（Task 2 的 `./skillsDir`）；Task 3 的模板文件与占位符名。
- Produces: `buildProposalAppend(mirrorDir, products?)` 签名不变（engine 零改动）；新导出 `loadAppendTemplate(): string`、`renderPromptTemplate(template: string, values: Record<string, string>): string`（供测试与后续复用）。

- [ ] **Step 1: 先写失败测试**

创建 `apps/desktop/src/main/core/proposalPromptTemplate.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'

import {
  PROPOSAL_DRAFT_BEGIN,
  PROPOSAL_DRAFT_END,
  PROPOSAL_GAP_PREFIX,
  PROPOSAL_COVER_CONFIRM_HEADER,
  PROPOSAL_TOC_CONFIRM_HEADER
} from '../../shared/proposal'
import { buildProposalAppend, loadAppendTemplate, renderPromptTemplate } from './proposalPrompt'

const PROTOCOL_STRINGS = [
  ...Object.values(PROPOSAL_DRAFT_BEGIN),
  ...Object.values(PROPOSAL_DRAFT_END),
  PROPOSAL_GAP_PREFIX,
  PROPOSAL_COVER_CONFIRM_HEADER,
  PROPOSAL_TOC_CONFIRM_HEADER
]

describe('renderPromptTemplate', () => {
  it('替换全部出现（含同名重复占位符）', () => {
    expect(renderPromptTemplate('a{{X}}b{{X}}c{{Y}}', { X: '1', Y: '2' })).toBe('a1b1c2')
  })

  it('未知占位符抛错——fail fast，防模板拼错字静默漏进 prompt', () => {
    expect(() => renderPromptTemplate('{{NOPE}}', {})).toThrow('NOPE')
  })

  it('替换值含 $& 等 replace 特殊序列时原样落地（函数替换器语义）', () => {
    expect(renderPromptTemplate('{{X}}', { X: 'a$&b' })).toBe('a$&b')
  })
})

describe('append 模板契约', () => {
  it('模板文件不含任何协议字样明文——事实源只在 shared/proposal.ts', () => {
    const tpl = loadAppendTemplate()
    for (const s of PROTOCOL_STRINGS) expect(tpl).not.toContain(s)
  })

  it('渲染结果含全部协议字样、且无 {{ 残留', () => {
    const out = buildProposalAppend('/mirror', [])
    for (const s of PROTOCOL_STRINGS) expect(out).toContain(s)
    expect(out).not.toContain('{{')
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop
bun test src/main/core/proposalPromptTemplate.test.ts
```

预期：FAIL——`loadAppendTemplate`/`renderPromptTemplate` 不存在（export not found）。

- [ ] **Step 3: 重写 `proposalPrompt.ts`**

整文件替换为（`ProposalProductScope` 接口、两个 MAX 常量、`renderProductBlock` 及它们的注释**原文保留**，下面省略号处照抄现版）：

```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PROPOSAL_DRAFT_BEGIN,
  PROPOSAL_DRAFT_END,
  PROPOSAL_GAP_PREFIX,
  PROPOSAL_COVER_CONFIRM_HEADER,
  PROPOSAL_TOC_CONFIRM_HEADER
} from '../../shared/proposal'
import { resolveBundledSkillsPluginDir } from './skillsDir'

/** （原 ProposalProductScope 的整段 doc 注释，照抄） */
export interface ProposalProductScope {
  dir: string
  productLine: string
  product: string
  files: { title: string; mirrorPath: string; assets: string[] }[]
}

/** （原 MAX_FILES_PER_PRODUCT 注释，照抄） */
const MAX_FILES_PER_PRODUCT = 50

/** （原 MAX_IMAGES_PER_FILE 注释，照抄） */
const MAX_IMAGES_PER_FILE = 12

/**
 * 读取方案写作方法论模板（skills/proposal-writer/references/append-template.md）。
 *
 * 为什么运行期读文件而不是 Vite `?raw` 编译期内联（设计 §5.3 修订）：`?raw` 是
 * Vite 专属语法，bun test 解析不了，会弄挂本目录全部 proposal 测试；而 skills/
 * 整树本就随包发布（tools/pack resources.ts）且 dev/bun test 下可经 cwd 候选回落
 * 仓库根，resolveBundledSkillsPluginDir 是现成解析器（engine 挂 plugin 用的同一个）。
 * 附带收益：dev 改模板对下一个 spawn 的会话即时生效，无需重启。
 *
 * 读不到就抛错（而不是回退空串）：方案会话没有纪律注入就等于放任编造——客户会
 * 据方案做采购决策，宁可当轮发送失败也不静默降级。这一依赖面与 skills plugin
 * 挂载、ppt-master 相同：skills 目录缺失时它们同样已经坏了。
 *
 * 每次调用都重读、不做模块级缓存：调用频率是「每次 spawn / 每次 grounding 补偿」
 * 量级，几 KB 的同步读开销可忽略；换来 dev 改模板即时生效。
 */
export function loadAppendTemplate(): string {
  const skillsDir = resolveBundledSkillsPluginDir()
  if (!skillsDir) {
    throw new Error(
      '写方案提示词模板不可用：找不到 skills 插件目录（.claude-plugin/plugin.json 缺失）'
    )
  }
  const path = join(skillsDir, 'proposal-writer', 'references', 'append-template.md')
  if (!existsSync(path)) {
    throw new Error(`写方案提示词模板不可用：${path} 不存在`)
  }
  const raw = readFileSync(path, 'utf8')
  // 模板文件末尾按 POSIX 惯例带一个换行，而旧实现 join('\n') 无尾换行——剥掉这
  // 一个字节以维持「渲染输出与旧实现逐字节一致」的快照不变量。只剥一个、不用
  // trimEnd：trimEnd 会连模板刻意保留的尾部空白一起吃掉。
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw
}

/**
 * 极简占位符渲染：`{{NAME}}` → values[NAME]。用函数替换器有两层含义：
 * ① 值里出现 `$&` 等 String.replace 特殊序列时不被二次解释；
 * ② 值本身不会被再次扫描占位符（replace 语义如此）——KB 文件名里就算出现
 *   `{{...}}` 也只会原样落地，不存在注入放大。
 * 未知占位符抛错而不是留空：模板拼错字必须在测试期炸出来，不能静默漏进 prompt。
 */
export function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, name: string) => {
    const v = values[name]
    if (v === undefined) {
      throw new Error(`提示词模板占位符缺渲染值：{{${name}}}（检查模板与 buildProposalAppend 的 values 是否同步）`)
    }
    return v
  })
}

/**
 * （原 buildProposalAppend 的整段 doc 注释照抄，并在末尾追加一段：）
 *
 * 2026-07-03 skill 化：方法论文本外置到 skills/proposal-writer/references/
 * append-template.md（改文案只改 markdown），协议字样在模板里是 {{占位符}}、
 * 渲染值取自 shared/proposal.ts（改协议只改常量，模板自动跟随）。输出与外置前
 * 逐字节一致，由 proposalPrompt.snapshot.test.ts 把关。
 */
export function buildProposalAppend(mirrorDir: string, products: ProposalProductScope[] = []): string {
  return renderPromptTemplate(loadAppendTemplate(), {
    KB_SCOPE: renderScopeBlock(mirrorDir, products),
    COVER_BEGIN: PROPOSAL_DRAFT_BEGIN.cover,
    COVER_END: PROPOSAL_DRAFT_END.cover,
    TOC_BEGIN: PROPOSAL_DRAFT_BEGIN.toc,
    TOC_END: PROPOSAL_DRAFT_END.toc,
    CONTENT_BEGIN: PROPOSAL_DRAFT_BEGIN.content,
    CONTENT_END: PROPOSAL_DRAFT_END.content,
    GAP_PREFIX: PROPOSAL_GAP_PREFIX,
    COVER_CONFIRM_HEADER: PROPOSAL_COVER_CONFIRM_HEADER,
    TOC_CONFIRM_HEADER: PROPOSAL_TOC_CONFIRM_HEADER
  })
}

/**
 * 渲染 {{KB_SCOPE}}：知识库镜像路径 + 产品文件清单（运行期数据，留在 TS 侧）。
 * 两个分支的文案是旧实现 `scope` 变量的原文，一字未动。
 */
function renderScopeBlock(mirrorDir: string, products: ProposalProductScope[]): string {
  return products.length > 0
    ? `1. 公司知识库的文本镜像在目录：${mirrorDir}。本次用户要写的产品及其可用资料文件【已为你列好】如下——**优先直接 Read 下面列出的文件取原文，不要再用 Glob 探目录、也不必逐个 Grep 试探**：\n${products
        .map((p) => renderProductBlock(p))
        .join('\n')}\n撰写任何内容前，先在上面清单里按文件标题判断该读哪些，直接 Read 取原文；只有清单里找不到的内容，才用 Grep/Glob 在对应产品目录内补查。只依据检索到的原文撰写。`
    : `1. 公司知识库的文本镜像在目录：${mirrorDir}。用户会在对话里说明要写哪些产品；撰写任何内容前，先用 Grep/Glob 在该镜像目录内定位对应产品，再 Read 检索原文，只依据检索到的原文撰写。`
}

/** （原 renderProductBlock 及其注释，整个函数原样照抄，一字不动） */
function renderProductBlock(p: ProposalProductScope): string {
  // …（照抄现版 proposalPrompt.ts:127-150）
}
```

- [ ] **Step 4: 跑全部 proposal prompt 测试（快照是硬门）**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop
bun test src/main/core/proposalPrompt src/main/core/proposalPromptTemplate.test.ts
```

预期：全绿，快照 `+0 added`、0 失配。**若快照失配：是模板生成或 renderScopeBlock 抄写有出入，回 Task 3/本 Task 修，绝不 `--update-snapshots`。**

- [ ] **Step 5: 全量验证**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
cd apps/desktop && bun test src/
```

预期：都是 exit 0。

- [ ] **Step 6: 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/src/main/core/proposalPrompt.ts apps/desktop/src/main/core/proposalPromptTemplate.test.ts
git commit -m "feat(proposal): buildProposalAppend 改模板渲染——方法论外置 skills/proposal-writer，输出逐字节零回归（快照守门）"
```

---

### Task 5: renderer 纯函数 helper——`matchProposalSlash` + `startOrReopenProposal`（含场景卡复用）

两个 helper 都是纯逻辑、可 bun test，先于 UI 接线（Task 6）落地。`startOrReopenProposal` 把场景卡 `onStartProposal` 里「再入永不丢草稿」的分支抽成唯一实现——斜杠与场景卡两个入口共用，防止日后漂移。

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/proposalSlash.ts`
- Create: `apps/desktop/src/renderer/src/lib/proposalSlash.test.ts`
- Create: `apps/desktop/src/renderer/src/lib/startOrReopenProposal.ts`
- Create: `apps/desktop/src/renderer/src/lib/startOrReopenProposal.test.ts`
- Modify: `apps/desktop/src/renderer/src/components/chat/ScenarioQuickStart.tsx`（`onStartProposal` 改调 helper）

**Interfaces:**
- Consumes: `useProposalStore`（`../stores/proposal`：`start(sessionId)`、`reopen(sessionId)`、`reset()`、字段 `active`/`sections`/`sessionId`）。
- Produces（Task 6 依赖，签名以此为准）:
  - `matchProposalSlash(text: string): { rest: string } | null`
  - `startOrReopenProposal(sessionId: string): 'started' | 'reopened'`

- [ ] **Step 1: 写 `matchProposalSlash` 失败测试**

创建 `apps/desktop/src/renderer/src/lib/proposalSlash.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'

import { matchProposalSlash } from './proposalSlash'

describe('matchProposalSlash', () => {
  it('裸名命中，无尾随文字时 rest 为空串', () => {
    expect(matchProposalSlash('/proposal-writer')).toEqual({ rest: '' })
  })

  it('plugin 命名空间形态命中（chip 序列化的实际值）', () => {
    expect(matchProposalSlash('/claude-desktop:proposal-writer')).toEqual({ rest: '' })
  })

  it('尾随文字进 rest（含多行），首尾空白剥掉', () => {
    expect(matchProposalSlash('/proposal-writer 给XX医院写预问诊方案\n分三部分')).toEqual({
      rest: '给XX医院写预问诊方案\n分三部分'
    })
    expect(matchProposalSlash('  /claude-desktop:proposal-writer   写个方案  ')).toEqual({
      rest: '写个方案'
    })
  })

  it('大小写不敏感（与 matchSlashCommand 的 head 处理一致）', () => {
    expect(matchProposalSlash('/Proposal-Writer')).toEqual({ rest: '' })
  })

  it('不命中：其它命令 / 前缀相似 / 非斜杠开头 / 空串', () => {
    expect(matchProposalSlash('/skill')).toBeNull()
    expect(matchProposalSlash('/proposal-writerx')).toBeNull()
    expect(matchProposalSlash('proposal-writer')).toBeNull()
    expect(matchProposalSlash('')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/desktop
bun test src/renderer/src/lib/proposalSlash.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 `proposalSlash.ts`**

```ts
/**
 * 「写方案」斜杠入口的命令识别。与 FusionRuntimeProvider 的 matchSlashCommand
 * 平行存在而不塞进它：那个函数的返回值是 DialogKind（开本地对话框），而本命令
 * 的动作是激活方案模式 + 可选直发尾随文字，语义不同、别硬挤一个 switch。
 *
 * 两个命令名都认：chip 从斜杠菜单插入的是 plugin 命名空间形态
 * `/claude-desktop:proposal-writer`（bundled fusion-code 回传的命令名），用户手敲
 * 或其它后端下则是裸名 `/proposal-writer`——与 skillChipRegistry 的双注册同一理由。
 */
const PROPOSAL_SLASH_NAMES = new Set(['proposal-writer', 'claude-desktop:proposal-writer'])

export function matchProposalSlash(text: string): { rest: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  // head = 第一个空白前的命令名；rest = 其后全部文字（保留内部换行，作首条消息直发）。
  const m = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/)
  if (!m) return null
  if (!PROPOSAL_SLASH_NAMES.has(m[1].toLowerCase())) return null
  return { rest: (m[2] ?? '').trim() }
}
```

- [ ] **Step 4: 跑测试确认通过**

同 Step 2 命令。预期：PASS（5 项全绿）。

- [ ] **Step 5: 写 `startOrReopenProposal` 失败测试**

创建 `apps/desktop/src/renderer/src/lib/startOrReopenProposal.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'bun:test'

import { useProposalStore } from '../stores/proposal'
import { startOrReopenProposal } from './startOrReopenProposal'

// zustand vanilla store 在 bun 下可直接驱动；每例前 reset 回初始态，互不串扰。
beforeEach(() => {
  useProposalStore.getState().reset()
})

describe('startOrReopenProposal（场景卡与斜杠入口共用的再入语义）', () => {
  it('无草稿 → started：激活并绑定会话', () => {
    expect(startOrReopenProposal('s1')).toBe('started')
    const ps = useProposalStore.getState()
    expect(ps.active).toBe(true)
    expect(ps.sessionId).toBe('s1')
  })

  it('active 中再入 → reopened：重绑到新前台会话、不清草稿状态', () => {
    useProposalStore.getState().start('s1')
    expect(startOrReopenProposal('s2')).toBe('reopened')
    const ps = useProposalStore.getState()
    expect(ps.active).toBe(true)
    expect(ps.sessionId).toBe('s2')
  })

  it('leaveMode 收起但 sections 非空 → reopened：草稿在就绝不 start 清空', () => {
    const st = useProposalStore.getState()
    st.start('s1')
    useProposalStore.setState({
      sections: [{ id: 'x', markdown: '# 封面', kind: 'cover' }]
    })
    useProposalStore.getState().leaveMode()
    expect(startOrReopenProposal('s2')).toBe('reopened')
    const ps = useProposalStore.getState()
    expect(ps.sections.length).toBe(1)
    expect(ps.sessionId).toBe('s2')
  })

  it('leaveMode 收起且无草稿 → started（与场景卡语义一致）', () => {
    useProposalStore.getState().start('s1')
    useProposalStore.getState().leaveMode()
    expect(startOrReopenProposal('s2')).toBe('started')
  })
})
```

- [ ] **Step 6: 运行确认失败**

```bash
bun test src/renderer/src/lib/startOrReopenProposal.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 7: 实现 `startOrReopenProposal.ts`**

```ts
import { useProposalStore } from '../stores/proposal'

/**
 * 「写方案」的激活/再入语义，场景卡（ScenarioQuickStart）与斜杠入口
 * （FusionRuntimeProvider 拦截 /proposal-writer）共用的唯一实现。
 *
 * 只要还存在一份未被显式丢弃的草稿（active 为真，或 sections 非空），一律 reopen
 * 回工作台、【绝不】start()——start 会清空 sections/products 把用户已写的草稿冲掉，
 * 这是「再入永不丢草稿」的落点（丢草稿根因的修复，见 stores/proposal.ts reopen 注释）。
 * 返回值告诉调用方走了哪条路：'started' 时调用方可选择预填引导模板（首发体验），
 * 'reopened' 时绝不能覆盖 composer——用户可能写到一半。
 */
export function startOrReopenProposal(sessionId: string): 'started' | 'reopened' {
  const ps = useProposalStore.getState()
  if (ps.active || ps.sections.length > 0) {
    ps.reopen(sessionId)
    return 'reopened'
  }
  ps.start(sessionId)
  return 'started'
}
```

- [ ] **Step 8: 跑测试确认通过**

同 Step 6 命令。预期：PASS（4 项全绿）。

- [ ] **Step 9: 场景卡改用 helper**

`ScenarioQuickStart.tsx` 的 `onStartProposal`（当前 ~137-155 行）改为：

```tsx
  // 点「写方案」卡：激活/再入语义抽到 startOrReopenProposal（斜杠入口
  // /proposal-writer 与本卡共用同一实现，防两处分支漂移——见该 helper 注释）。
  // 'started'（首发）才预填引导模板并聚焦；'reopened' 不动 composer——用户可能写到一半。
  const onStartProposal = useCallback(() => {
    if (startOrReopenProposal(activeSessionId) === 'reopened') return
    composer.setText(t('scenarioProposalPrompt'))
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>('.ProseMirror')
      el?.focus()
    })
  }, [activeSessionId, composer, t])
```

同时：顶部加 `import { startOrReopenProposal } from '../../lib/startOrReopenProposal'`；原 `const startProposal = useProposalStore((s) => s.start)` 一行删除（helper 内部取 store，组件不再直接用 `start`）。**保留** `leaveProposalMode` 与 `onPickScenario`（其它场景卡仍用）。

- [ ] **Step 10: 全量验证 + 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
cd apps/desktop && bun test src/
```

预期：exit 0、全绿。

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/src/renderer/src/lib/proposalSlash.ts apps/desktop/src/renderer/src/lib/proposalSlash.test.ts apps/desktop/src/renderer/src/lib/startOrReopenProposal.ts apps/desktop/src/renderer/src/lib/startOrReopenProposal.test.ts apps/desktop/src/renderer/src/components/chat/ScenarioQuickStart.tsx
git commit -m "feat(proposal): 斜杠命令识别 + start/reopen 再入语义抽共享 helper——场景卡改用同一实现"
```

---

### Task 6: `onNew` 拦截 `/proposal-writer` + chip 注册

**Files:**
- Modify: `apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx`（onNew 拦截 + runtimeRef + useT）
- Modify: `apps/desktop/src/renderer/src/composer/skillChipRegistry.ts`（+2 条）

**Interfaces:**
- Consumes: Task 5 的 `matchProposalSlash`、`startOrReopenProposal`；`useT`（`../i18n`）；i18n 既有 key `scenarioProposalPrompt`。
- Produces: 无新导出——纯接线。

- [ ] **Step 1: chip 注册**

`skillChipRegistry.ts` 的 `SKILL_CHIP_SPECS` 数组尾部追加（照 ppt-master 的 namespaced+裸名双注册惯例；icon 用 `'word'`——方案最终导出 Word，蓝色文档图标最贴合）：

```ts
  // proposal-writer — 写方案。namespaced + 裸名双注册，理由同 ppt-master。
  // 注意：这个命令不会发给 fusion-code——FusionRuntimeProvider.onNew 会拦截它、
  // 激活方案模式（见 matchProposalSlash）。chip 只是让斜杠菜单里它长得像个产品功能。
  {
    match: '/claude-desktop:proposal-writer',
    icon: 'word',
    label: '写方案',
    appearance: 'gradient'
  },
  {
    match: '/proposal-writer',
    icon: 'word',
    label: '写方案',
    appearance: 'gradient'
  }
```

- [ ] **Step 2: `FusionRuntimeProvider.tsx` 接线**

四处修改：

**(a) imports**（顶部）——在既有 import 区加：

```ts
import { matchProposalSlash } from '../lib/proposalSlash'
import { startOrReopenProposal } from '../lib/startOrReopenProposal'
```

并把 `useT` 加进既有的 `../i18n` import（当前只 import 了 `useI18n`）。

**(b) 组件内取 `t` 与 runtimeRef**（`const sessionId = useChatStore((s) => s.sessionId)` 之后，~154 行附近）：

```ts
  const t = useT()
  // onNew 拦截 /proposal-writer 空调用时要把引导模板写回 composer，但 onNew 是
  // useExternalStoreRuntime 参数对象里的闭包、定义时 runtime 还不存在——经 ref 间接
  // 引用（与下面 useThreadListAdapter 的 sessionIdRef 同一手法），调用期必已就绪。
  const runtimeRef = useRef<ReturnType<typeof useExternalStoreRuntime> | null>(null)
```

（`useRef` 已在文件 import 里。）

**(c) runtime 创建后回填 ref**（`const runtime = useExternalStoreRuntime({ ... })` 整个调用之后紧跟一行）：

```ts
  runtimeRef.current = runtime
```

**(d) onNew 拦截分支**——现有 slash 拦截块（`if (images.length === 0 && filePaths.length === 0) { const dialogKind = ... }`，~471-477 行）**内部**、`dialogKind` 分支之后追加；同时把 429 行 `const baseText` 与 441 行 `const text` 改成 `let`：

```ts
        // ─── /proposal-writer：写方案斜杠入口（拦截，不发给 CLI）────────
        // 方法论必须经 systemPrompt.append 无条件注入（硬门纪律不能靠模型自愿展开
        // skill），所以这个命令在 renderer 侧消化：激活方案模式后，空调用=场景卡
        // 语义（预填引导模板），带尾随文字=剥掉命令、尾随文字当本轮用户消息继续走
        // 下面的正常发送路径（storeContent/payload 都读重写后的 baseText/text，
        // matchProducts 播种、召回注入与场景卡首发完全同路）。设计见
        // docs/superpowers/specs/2026-07-03-proposal-writer-skill-design.md §5.4。
        const proposalSlash = matchProposalSlash(baseText)
        if (proposalSlash) {
          if (sessionId === null) {
            console.error('[runtime] /proposal-writer：无前台会话，忽略')
            return
          }
          const outcome = startOrReopenProposal(sessionId)
          if (!proposalSlash.rest) {
            // 空调用：'started'（首发）才预填模板；'reopened' 绝不覆盖 composer。
            // queueMicrotask：assistant-ui send() 在 onNew 之后才清空 composer，
            // 同步 setText 会被那次清空吃掉，推迟一拍写入。
            if (outcome === 'started') {
              queueMicrotask(() => {
                runtimeRef.current?.thread.composer.setText(t('scenarioProposalPrompt'))
                document.querySelector<HTMLElement>('.ProseMirror')?.focus()
              })
            }
            return
          }
          baseText = proposalSlash.rest
          text = proposalSlash.rest
        }
```

- [ ] **Step 3: 验证**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
cd apps/desktop && bun test src/
```

预期：exit 0、全绿。若 typecheck 在 `runtimeRef.current?.thread.composer.setText` 报属性不存在（assistant-ui 版本差异），改用 `runtimeRef.current?.threads.main.composer.setText`——两者是同一 ComposerRuntime 的两条访问路径，以能过编译的为准，并把实际用的那条写进注释。

- [ ] **Step 4: 提交**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
git add apps/desktop/src/renderer/src/runtime/FusionRuntimeProvider.tsx apps/desktop/src/renderer/src/composer/skillChipRegistry.ts
git commit -m "feat(proposal): /proposal-writer 斜杠入口——onNew 拦截激活方案模式（空调用预填模板/带文字直发），chip 进技能分组"
```

---

### Task 7: 收尾——全量回归 + GUI 走查清单

- [ ] **Step 1: 全量回归**

```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop && bun run typecheck
cd apps/desktop && bun test src/
```

预期：exit 0；全部测试通过（含 Task 1 快照 3 项、Task 4 契约 5 项、Task 5 单测 9 项与全部既有测试）。

- [ ] **Step 2: dev 冒烟（`bun run dev`，主进程改动需重启 dev 而非等 HMR）**

按下列清单人工走查（AI 可用 CDP 9222 自查前四项，最终以用户走查为准）：

1. 输入框敲 `/` → 菜单「技能」分组出现「写方案」chip（蓝色 Word 图标、gradient 卡样式）。
2. 选中回车（空调用）→ 不发消息、无用户气泡；方案工作台打开；composer 被预填引导模板并聚焦。
3. `/proposal-writer 给XX医院写预问诊平台方案` → 用户气泡只显示尾随文字（不含命令）；方案模式激活；AI 按封面阶段纪律走（AskUserQuestion 问封面信息）——证明模板渲染的 append 注入成功。
4. 写出草稿后点「返回」再 `/proposal-writer` → 回到工作台、草稿原样（reopen 不丢稿）；composer 未被覆盖。
5. 侧栏「写方案」场景卡行为与改造前一致（复用 helper 后无回归）。
6. 改 `skills/proposal-writer/references/append-template.md` 里任一句文案 → 新开会话发送 → 生效（运行期读模板）；`bun test` 快照失配报警 → `git checkout` 还原文案。

- [ ] **Step 3: 按 CLAUDE.md 惯例把踩坑写进 Obsidian vault（若走查发现问题）**

- [ ] **Step 4: 汇报走查结果，等用户确认后按 finishing-a-development-branch 流程收尾**

---

## Self-Review 记录

- **Spec 覆盖**：§5.1 目录（Task 3）；§5.2 占位符协议（Task 3 生成 + Task 4 渲染，占位符名一致）；§5.3 渲染改造含修订后的运行期读取（Task 2+4）；§5.4 chip+拦截+共享 action（Task 5+6，空调用/尾随文字两分支都有）；§8 测试 1-5 → Task 1/4/5 + typecheck；§7 降级路径 → SKILL.md 文案 + loadAppendTemplate 抛错。
- **占位符扫描**：Task 3 NOTES.md 与 Task 4 的「照抄」处均指向现存文件的明确行段（proposalPrompt.ts 现版注释、:127-150），非 TBD。
- **类型一致性**：`matchProposalSlash`/`startOrReopenProposal` 签名在 Task 5 Interfaces 定义、Task 6 按同名同签名消费；占位符名 Task 3 ↔ Task 4 逐一核对过。
