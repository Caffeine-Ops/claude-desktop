# Writing 已有作品优化（一期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Writing 技能补一条「上传完整作品 → 先体检 → 确认修改强度 → 路由到润色/改写」的主入口，让用户不必复制粘贴长文，且在改动前先看诊断、明确改到什么程度。

**Architecture:** 前端两处小改（推荐区加一条主入口 prompt、文件槽加一类「文稿」组合格式过滤），skill 侧加一个只做「诊断 + 分档 + 路由」的新工作流 `optimize-existing.md`，执行仍交回既有的 `polish-only.md` / `rewrite.md`（不复制执行规则，避免口径漂移）。文件转换复用现成的 `source_to_md.py`（已支持 txt/md/docx/pdf）。

**Tech Stack:** TypeScript + React 19 + ProseMirror（前端）；`bun:test`（前端单测，跑法 `bun test`）；Markdown（skill 工作流）；Python venv（skill 脚本，经 `bin/ensure-python.sh` 自举出 `$WRITING_PY`）。

## Global Constraints

以下为设计文档（`docs/superpowers/specs/2026-07-28-writing-existing-work-optimization-design.md`）钉死的项目级约束，每个 task 都隐含遵守：

- **一期只上主入口**：推荐区一期只加 `优化已有作品` 一条 prompt；`润色已有作品` / `深度改写作品` 两个快捷入口推迟二期（§14 决策 1）。但 `optimize-existing.md` **内部三档分流照建不误**。
- **个人表达默认保留**（§14 决策 2）：轻度润色 / 标准优化 / 深度改写三档都把「用户自己的语气 / 口头禅 / 用词习惯」列为默认不动项；去 AI 味只报证据、不以统一腔调覆盖用户原声。
- **标准优化允许拆合段落、但禁止改整体结构**（§14 决策 3）：三档的唯一硬边界统一为「整体结构（章节顺序、论证骨架）能否改」。
- **文件槽必须用 `【文稿文件】`**（以「文件」结尾才被 `filePlaceholderPlugin` 识别为可点击 pill，且「文稿」关键词触发文稿组合格式过滤）。
- **一期支持格式**：`.txt` / `.md` / `.markdown` / `.docx` / `.pdf`（`source_to_md.py` 已能处理的四种来源）。**不宣称支持旧版 `.doc`**——picker 里靠 accept 过滤自动置灰，而不是选完再报错。
- **原稿不可覆盖**：上传文件转 Markdown 后存 `sources/`（原稿留档），诊断报告存 `reviews/`，成品存 `output/`；绝不原地改用户上传的文件。
- **确认前不生成正文**：主入口体检后必须 ⛔ BLOCKING 停下，等用户明确选档；未确认不写优化后的正文、不编假定的改写方案、不把示例句伪装成定稿。
- **新工作流只做诊断 + 路由**，执行纪律继续由 `polish-only.md` / `rewrite.md` 单独负责，不把两份工作流的执行规则复制过来。
- **前端唯一自动化防线是 `bun run typecheck` + `bun test`**（项目无 ESLint）；改完前端必过这两条。skill 侧无 workflow 的自动化内容校验（`validate_library.py` 只校验 references 库），workflow 正文靠内容存在性 grep + §12 手动走查把关。

---

## 文件结构（改动落点）

| 文件 | 动作 | 职责 |
|---|---|---|
| `apps/studio/src/chat/composer/filePlaceholderPlugin.ts` | 改 | `ACCEPT_BY_KEYWORD` 首位加「文稿/作品/稿件」组合映射 |
| `apps/studio/src/chat/composer/filePlaceholderPlugin.test.ts` | 建 | `acceptForPlaceholder` 的 bun 单测（映射正确 + 无回归） |
| `apps/studio/package.json` | 改 | `test` 脚本 glob 扩上 `src/chat/composer` |
| `apps/studio/src/chat/components/chat/ThreadView/ScenarioRail.tsx` | 改 | `PROMPTS_BY_SKILL.writing` 加一条主入口 prompt |
| `apps/studio/src/chat/composer/optimizeExistingScenario.test.ts` | 建 | 主入口 prompt 内容存在性守卫（读 ScenarioRail 源文断言） |
| `skills/writing/workflows/optimize-existing.md` | 建 | 新工作流：接文件 → 五维体检 → 三档 → ⛔ 确认 → 路由 |
| `skills/writing/SKILL.md` | 改 | frontmatter 触发语 + 独立工作流索引加一行 |
| `skills/writing/workflows/polish-only.md` | 改 | 标注为轻度润色唯一执行源、可从 optimize-existing 路由进入 |
| `skills/writing/workflows/rewrite.md` | 改 | 标注接收 optimize-existing 已确认档位；标准档/深改档约束注入说明 |

---

### Task 1: 文稿组合格式映射 + 单测 + 扩 test glob

**Files:**
- Modify: `apps/studio/src/chat/composer/filePlaceholderPlugin.ts:38-47`（`ACCEPT_BY_KEYWORD` 数组）
- Create: `apps/studio/src/chat/composer/filePlaceholderPlugin.test.ts`
- Modify: `apps/studio/package.json`（`scripts.test`）

**Interfaces:**
- Consumes: 无（本 task 是最底层）。
- Produces: `acceptForPlaceholder(placeholderText: string): string | undefined` 的行为——对含「文稿 / 作品 / 稿件」的占位描述返回 `'.txt,.md,.markdown,.docx,.pdf'`；既有单格式映射不变。Task 2 的 `【文稿文件】` 槽依赖此映射把 picker 过滤到文稿格式。

- [ ] **Step 1: 先扩 test glob，让新测试文件能被 `bun test` 收进套件**

改 `apps/studio/package.json` 的 `test` 脚本（当前 `"test": "bun test electron/ src/chat/lib"`），把 `src/chat/composer` 加进去：

```json
    "test": "bun test electron/ src/chat/lib src/chat/composer",
```

（`filePlaceholderPlugin.ts` 在 `src/chat/composer/`，原 glob 扫不到；实测 `bun test` 能正常加载这个含 prosemirror import 的模块，`acceptForPlaceholder` 是纯函数、无需 DOM。）

- [ ] **Step 2: 写失败测试**

创建 `apps/studio/src/chat/composer/filePlaceholderPlugin.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'

import { acceptForPlaceholder } from './filePlaceholderPlugin'

describe('acceptForPlaceholder · 文稿组合映射（设计 §5.2）', () => {
  const DOC_FORMATS = '.txt,.md,.markdown,.docx,.pdf'

  it('文稿 / 作品 / 稿件 都映射到全部文稿格式', () => {
    expect(acceptForPlaceholder('文稿文件')).toBe(DOC_FORMATS)
    expect(acceptForPlaceholder('作品文件')).toBe(DOC_FORMATS)
    expect(acceptForPlaceholder('稿件文件')).toBe(DOC_FORMATS)
  })

  it('文稿组合不含独立的旧版 .doc（picker 自动置灰，不是选完再报错）', () => {
    // .docx 里的 .doc 前缀不算——按逗号切成 token 后不应出现独立 '.doc'
    expect(acceptForPlaceholder('文稿文件')!.split(',')).not.toContain('.doc')
  })

  it('既有单格式映射不回归', () => {
    expect(acceptForPlaceholder('PPT 文件')).toBe('.ppt,.pptx')
    expect(acceptForPlaceholder('Excel 文件')).toBe('.xls,.xlsx,.csv')
    expect(acceptForPlaceholder('Word 文档')).toBe('.doc,.docx')
    expect(acceptForPlaceholder('PDF 文件')).toBe('.pdf')
    expect(acceptForPlaceholder('图片文件')).toBe('image/*')
  })

  it('未命中任何关键词仍返回 undefined（不限制，只做引导）', () => {
    expect(acceptForPlaceholder('资料文件')).toBeUndefined()
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd apps/studio && bun test src/chat/composer/filePlaceholderPlugin.test.ts`
Expected: 第一、二个用例 FAIL——当前 `acceptForPlaceholder('文稿文件')` 返回 `undefined`（「文稿」不命中任何现有关键词），`toBe(DOC_FORMATS)` 不满足。既有映射用例应已 PASS。

- [ ] **Step 4: 实现——`ACCEPT_BY_KEYWORD` 首位加文稿组合映射**

在 `filePlaceholderPlugin.ts` 的 `ACCEPT_BY_KEYWORD` 数组**最前面**插入一行（放最前是设计要求：避免「文稿文件」落入无过滤，且优先于单格式关键词命中）：

```ts
const ACCEPT_BY_KEYWORD: readonly [RegExp, string][] = [
  // 文稿组合映射（优化已有作品的「【文稿文件】」槽，设计 §5.2）：覆盖
  // source_to_md.py 能处理的全部文稿格式。放在单格式关键词之前，优先命中；
  // 刻意不含旧版 .doc（转换脚本不支持，picker 里靠 accept 自动置灰，而不是
  // 让用户选完再报错）。
  [/文稿|作品|稿件/i, '.txt,.md,.markdown,.docx,.pdf'],
  [/ppt|幻灯片|演示/i, '.ppt,.pptx'],
  [/excel|xlsx?|csv|表格|明细|台账/i, '.xls,.xlsx,.csv'],
  [/word|docx?(?![a-z])|文档/i, '.doc,.docx'],
  [/pdf/i, '.pdf'],
  [/markdown|(?<![a-z])md(?![a-z])/i, '.md,.markdown'],
  [/图片|image|截图|照片/i, 'image/*'],
  [/视频|video/i, 'video/*'],
  [/音频|audio|录音/i, 'audio/*']
]
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/studio && bun test src/chat/composer/filePlaceholderPlugin.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: 跑全套 test + typecheck 确认无回归**

Run: `cd apps/studio && bun test && bun run typecheck`
Expected: 两条都 PASS（新测试文件已被 glob 收入；typecheck 无新增错误）。

- [ ] **Step 7: Commit**

```bash
git add apps/studio/src/chat/composer/filePlaceholderPlugin.ts \
        apps/studio/src/chat/composer/filePlaceholderPlugin.test.ts \
        apps/studio/package.json
git commit -m "$(cat <<'EOF'
feat(composer): 文件槽新增「文稿」组合格式映射 + 单测

【文稿文件】槽的 accept 过滤到 .txt/.md/.markdown/.docx/.pdf（source_to_md.py
能处理的全部文稿格式），映射放 ACCEPT_BY_KEYWORD 首位优先命中；不含旧版
.doc，picker 里自动置灰。同时把 src/chat/composer 加进 bun test glob。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 推荐区主入口 prompt「优化已有作品」

**Files:**
- Modify: `apps/studio/src/chat/components/chat/ThreadView/ScenarioRail.tsx:206-229`（`PROMPTS_BY_SKILL.writing` 数组）
- Create: `apps/studio/src/chat/composer/optimizeExistingScenario.test.ts`

**Interfaces:**
- Consumes: Task 1 的文稿组合映射（`【文稿文件】` 槽靠它把 picker 过滤到文稿格式）。
- Produces: 用户在空态推荐区点「优化已有作品」→ composer 正文填入含 `【文稿文件】` 的 prompt。无导出符号，纯静态配置。

- [ ] **Step 1: 写失败测试（内容存在性守卫）**

创建 `apps/studio/src/chat/composer/optimizeExistingScenario.test.ts`：

```ts
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

// 主入口 prompt 是 ScenarioRail.tsx 里的静态配置，没有可导入的纯函数，改用读
// 源文件断言关键片段在场（设计 §12 自动化测试 #3）。路径相对 `bun test` 的
// cwd（apps/studio）；ScenarioRail 若搬家，此断言会大声失败——正是我们要的。
const RAIL = readFileSync(
  'src/chat/components/chat/ThreadView/ScenarioRail.tsx',
  'utf8'
)

describe('ScenarioRail · 优化已有作品主入口', () => {
  it('writing 场景含「优化已有作品」标签', () => {
    expect(RAIL).toContain("label: '优化已有作品'")
  })

  it('主入口 prompt 用【文稿文件】文件槽', () => {
    expect(RAIL).toContain('帮我优化【文稿文件】')
  })

  it('主入口 prompt 明确「确认修改强度前不改正文」硬约束', () => {
    expect(RAIL).toContain('在我确认修改强度前，不要改正文')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/studio && bun test src/chat/composer/optimizeExistingScenario.test.ts`
Expected: 三个用例全 FAIL——ScenarioRail 还没有这条 prompt。

- [ ] **Step 3: 实现——writing 数组加主入口 prompt**

在 `ScenarioRail.tsx` 的 `writing:` 数组里，`改写这段文字` 那条**之后**插入（两者概念相邻：一个是短文本粘贴、一个是完整文件）：

```ts
    {
      // 优化已有作品主入口（设计 2026-07-28）：【文稿文件】是 filePlaceholderPlugin
      // 的文件槽，「文稿」关键词 → picker 限定 txt/md/markdown/docx/pdf（见
      // acceptForPlaceholder 的文稿组合映射）。走 workflows/optimize-existing.md：
      // 先五维体检、再让用户确认修改强度，确认前不改正文。末句「在我确认修改强度
      // 前，不要改正文」是工作流 ⛔ BLOCKING 硬门在 UI 侧的对齐提醒。一期只上这一
      // 条主入口；润色/深改两个快捷入口按设计 §14 决策 1 推迟二期。
      label: '优化已有作品',
      text: '帮我优化【文稿文件】。请先检查内容、结构、表达、文风和 AI 痕迹，告诉我主要问题，并推荐轻度润色、标准优化或深度改写。在我确认修改强度前，不要改正文。'
    },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/studio && bun test src/chat/composer/optimizeExistingScenario.test.ts`
Expected: 三个用例全 PASS。

- [ ] **Step 5: typecheck + 全套 test 确认无回归**

Run: `cd apps/studio && bun run typecheck && bun test`
Expected: 两条都 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/studio/src/chat/components/chat/ThreadView/ScenarioRail.tsx \
        apps/studio/src/chat/composer/optimizeExistingScenario.test.ts
git commit -m "$(cat <<'EOF'
feat(scenario-rail): writing 推荐区新增「优化已有作品」主入口

用【文稿文件】文件槽让用户直接上传完整作品，走 optimize-existing 工作流先
体检再确认修改强度。一期只上主入口，润色/深改快捷入口推迟二期（设计 §14）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 新工作流 `optimize-existing.md`

**Files:**
- Create: `skills/writing/workflows/optimize-existing.md`

**Interfaces:**
- Consumes: 既有脚本 `source_to_md.py`（转 md）、`ai_slop_checker.py`、`readability_check.py`、`continuity_check.py`、`project_manager.py`；既有工作流 `polish-only.md` / `rewrite.md`（路由目标）；SKILL.md 的「体裁 → 目录映射表」。
- Produces: 一条「诊断 + 分档 + 路由」工作流，被 SKILL.md 索引引用（Task 4）、被 polish-only/rewrite 的路由说明引用（Task 5）。不含可执行代码，产物是 skill 运行时模型遵循的流程。

- [ ] **Step 1: 写入完整工作流内容**

创建 `skills/writing/workflows/optimize-existing.md`，**完整内容如下**（照抄，别留占位）：

````markdown
---
description: 优化已有作品统一入口 —— 用户上传一篇完整作品（文章 / 小说 / 文案，支持 txt/md/docx/pdf）要「优化 / 体检」，但没说清小修还是大改。本工作流只做三件事：保存原稿 → 五维体检（只诊断不改）→ 推荐三档修改强度 → ⛔ 硬门等确认 → 路由到 polish-only（轻度润色）或 rewrite（标准优化 / 深度改写）。不复制执行规则，改由那两条工作流负责。
---

# 优化已有作品工作流（Optimize Existing）

> 独立工作流。触发：用户**上传/给出一篇完整作品**要「优化一下 / 帮我体检 / 看看怎么改更好」，但**没明说改到什么程度**。它是「改写 / 只润色」上游的**分诊台**：先替用户查清哪不好、再让用户拍板改多重，最后把活派给对应工作流。
>
> **本工作流只做「诊断 + 分档 + 路由」，绝不自己动正文。** 执行（真正改字）交回 [只润色](polish-only.md) 或 [改写](rewrite.md)——它们的执行纪律是唯一真源，这里不复制，避免两处规则漂移。
>
> **和「改写这段文字」的区别**：那条要求用户粘贴短文本；本工作流面向**完整文件**（长文章 / 整篇小说 / Word/PDF 文稿），先转 Markdown 存档再诊断。

**前置**：先跑一次 Python 自举（见 SKILL.md 顶部「🐍 Python 环境」），把本文里所有 `$WRITING_PY` 备好。没自举，脚本全跑不起来。

---

## 一条统摄纪律：优化 ≠ 全部重写

「优化」天生有歧义——可能只想纠错润色，也可能允许大改结构。**最严重的失败不是文字质量差，而是擅自覆盖了用户的个人表达、结构选择或原意。** 所以：

- **确认修改强度前，绝不动正文**（这是 ⛔ BLOCKING 硬门，见 Step 4）。
- **「个人表达」是所有档位的默认保留项**——用户自己的语气、口头禅、用词习惯默认不动；去 AI 味只报证据、给建议，不以统一腔调覆盖用户原声。
- **原稿始终留档、绝不原地改**（存 `sources/`，改动落 `output/`，随时可对账）。

---

## Step 1 · 落项目、接文件、把原稿收进 sources/

先看 cwd 定 `--dir`（规则同 SKILL.md），建项目目录，产物才不散落：

```bash
pwd
$WRITING_PY ${SKILL_DIR}/scripts/project_manager.py init <作品名>-优化 --dir <解析好的目录>
```

**把上传的文件转 Markdown 存进 `sources/`**（原稿是这次优化的唯一地基，必须留档）：

```bash
# 支持 .txt / .md / .markdown / .docx / .pdf；旧版 .doc 不支持
$WRITING_PY ${SKILL_DIR}/scripts/source_to_md.py <上传的文件> --out-dir <项目>/sources
```

**开工前的守卫（都在诊断之前）**：

- **没上传文件就发送** → 提醒用户补上文稿，**不要**凭空做泛泛体检。
- **格式不支持**（如 `.doc`、`.rtf`、`.pages`）→ 明确列出支持格式（txt/md/markdown/docx/pdf），原文件不做任何改动，让用户另存后重传。
- **文件提取不出文字**（转换报错、或转出来几乎为空）→ 如实报告失败原因，建议改传 `.docx` / `.pdf` / `.md` / `.txt`。
- **扫描版 PDF（图片型、无可复制文本）** → 明确告诉用户「这是扫描件、提取不到文字，需要先 OCR 或提供可复制文本版」，**不要**伪装成已读完。

---

## Step 2 · 识别体裁、平台、完整度（识别不出只问一个关键问题）

不同体裁诊断法完全不同（文案查转化、小说查伏笔、文章查论证），**先认准体裁才能选对诊断标准**。照 SKILL.md 的「体裁 → 目录映射表」认：

| 看原文像什么 | 体裁（`genre`） |
|---|---|
| 推广、带货、私域、直播预告 | `wechat` |
| 有人物、有情节、要读者「感」 | `short-story` |
| 讲清一件事 / 立一个观点 | `article` |

**识别不出来时，只问一个会改变诊断标准的关键问题**（如「这篇你当公众号推文、短篇故事、还是观察文章来优化？改法差很多」），**不要**启动主管线策划阶段的完整八项确认——那是从零创作的流程，这里稿子已经有了。目标平台同理：只在它**会影响诊断标准**时才问（比如要发小红书对字数/段落有硬要求）。

---

## Step 3 · 五维作品体检（审校角色，只诊断不动手）

先切审校角色（体检 = 审校那一棒的活）：

```markdown
## [角色切换：审校]
📖 正在加载岗位说明书：references/editor.md
📋 当前任务：给这篇完整作品做五维体检，产出分级诊断
🚧 边界：只诊断、不动手；不在体检阶段夹带「顺手改好」的正文
```

**第一步 · 跑脚本拿客观指标**（产物落 `reviews/`）：

```bash
# 所有体裁都跑 —— AI 味五维，总分 50、低于 35 是重灾
$WRITING_PY ${SKILL_DIR}/scripts/ai_slop_checker.py <项目>/sources/<原稿>.md

# 所有体裁都跑 —— 平台合规（--platform 取目标平台）
$WRITING_PY ${SKILL_DIR}/scripts/readability_check.py <项目>/sources/<原稿>.md --platform <平台>

# 仅小说加跑 —— 伏笔/人物/人名连贯性（--spec-lock 必填）
$WRITING_PY ${SKILL_DIR}/scripts/continuity_check.py <项目>/sources/<原稿>.md --spec-lock <项目>/spec_lock.md
```

> 小说体检要跑 `continuity_check.py` 得先有 `spec_lock.md`。优化场景没走过策划，就据原文**逆向补一份**契约（人物档案 Core Four + 伏笔表三态）当诊断标准答案。

**第二步 · 固定五维诊断**（脚本查不出的判断靠人；每维只报最高价值的问题，别把脚本原始日志倾倒给用户）：

| 维度 | 要回答的问题 |
|---|---|
| 内容 | 核心信息是否清楚，有无重复、缺口或事实风险 |
| 结构 | 顺序是否合理，段落或场景是否承担明确任务 |
| 表达 | 是否啰嗦、含混、书面腔过重或节奏单一 |
| 文风 | 语气、人称和个人表达是否一致 |
| AI 痕迹 | 套话、AI 句式、均匀结构和抽象表达是否集中 |

**第三步 · 分级 + 推荐档位**：把发现按 `必须处理 / 建议处理 / 可选处理` 分级，**每条说清「为什么」，但不提前给完整改写句**（改法留到执行阶段）。**完整报告落 `reviews/`，聊天里只给精简、可决策的版本**（诊断太长、用户还没开始改就流失）。最后**必须给出一个推荐档位及理由**（见 Step 4 三档）。

---

## Step 4 · 三档修改强度（推荐一档，等用户拍板）

把三档端给用户，**基于体检结果推荐一档、不机械默认中间档**：原稿已经成熟就只推荐轻度润色；结构性问题决定成败就推荐深度改写。

| 档位 | 允许改动 | 不允许改动 | 路由 |
|---|---|---|---|
| **轻度润色** | 错字、标点、语病、用词、句子节奏、AI 痕迹 | 观点、事实、段落顺序、整体结构、**个人表达** | `polish-only.md` |
| **标准优化** | 轻度润色全部能力；删减重复；局部改写；**必要时拆分/合并段落** | 核心观点、关键事实、**整体结构**、人物与情节走向、**个人表达** | `rewrite.md` 定向路径 |
| **深度改写** | 重排结构、重写段落、调整叙事顺序和文风；按目标平台重构 | 用户明确列入「必须保留」的内容、**个人表达（除非用户明确要求换风格）** | `rewrite.md` 全量路径 |

> **三档的唯一硬边界**：「整体结构（章节顺序、论证骨架）能不能改」。轻度/标准都不动整体结构（标准可拆合单个段落，但不搬家、不增删章节）；只有深度改写允许重排结构。
>
> **「个人表达」默认三档都保留**：用户的语气、口头禅、用词习惯是他的声音，不是 AI 味。文风异常只报证据、给建议，不擅自用统一腔调覆盖——除非用户在深度改写里明确要求「换成 XX 风格」。

---

## Step 5 · ⛔ BLOCKING 确认硬门

**体检 + 推荐档位给完，必须完全停下，等用户明确回复再走。** 确认信息至少覆盖：

- **选哪一档**修改强度（或用户自己调整范围）；
- **必须保留的内容**（用户点名不能动的观点/段落/风格）；
- **目标用途或平台**（仅在它会改变修改标准时才问）；
- **是否处理「可选处理」那一档**问题。

**用户未确认前**：不生成优化后的正文、不创建假定的改写方案、不把示例句伪装成定稿。理由：动的是用户自己的作品，改哪些、改多重是他的意图不是你的判断——替他默认「全改」就是越界。

---

## Step 6 · 按确认档位路由（不复制执行规则，交回对应工作流）

用户确认后，按档位路由。**把本次的约束作为「已确认前提」带过去**，进入对应工作流后**从它的第一步开始执行**（那些工作流的诊断步骤可据此走轻量版，不必再从头判别意图）：

| 用户选了 | 路由到 | 带过去的已确认约束 |
|---|---|---|
| 轻度润色 | `polish-only.md` | 「只动文字，不动结构/观点/个人表达」——它的三个「不动」铁律正是这一档 |
| 标准优化 | `rewrite.md` **定向路径**（路径 B） | 「整体结构不可改、允许拆合段落、个人表达保留」写入本次修改约束 |
| 深度改写 | `rewrite.md` **全量路径** | 「用户点名的必须保留项 + 个人表达」写入约束；`rewrite.md` 自身的硬确认仍保留 |

> `rewrite.md` 的 Step 0「两条路径分流」是给**绕过本入口、直接在对话里提改写要求**的用户用的；从本工作流路由进去时，意图已明确、档位已确认，无需再跑一遍它的意图判别。

---

## Step 7 · 输出与对账（执行工作流产出，此处列交付标准）

无论走哪一档，最终交付**至少包含**：

1. 优化后的完整作品文件（在 `output/`）；
2. 修改摘要；
3. 精简改动对照（**粒度随档位**：轻度润色列代表性句级改动、不穷举标点；标准优化逐项对应体检的「必须处理/建议处理」；深度改写按章节/结构块说明「原稿 → 新稿」变化及保留项落实情况）；
4. 未处理但值得注意的问题；
5. 原稿与成稿的**完整文件路径**（`/Users/…` 或 `~/` 开头）。

**中途改主意**：用户在体检后改了目标 → 以最新确认值为准，重新计算受影响的修改范围。**用户催「直接改」**：若已给出可验收的明确方向，可进对应快捷路径；若仍是笼统「优化」，**不得跳过 Step 5 的强度确认**。
````

- [ ] **Step 2: 内容存在性校验（三档 + 路由 + 硬门 + 保留项都在场）**

Run:

```bash
F=skills/writing/workflows/optimize-existing.md
for kw in "轻度润色" "标准优化" "深度改写" "polish-only.md" "rewrite.md" "BLOCKING" "个人表达" "sources/" "source_to_md.py" "扫描版 PDF"; do
  grep -q "$kw" "$F" && echo "OK  $kw" || echo "MISSING  $kw"
done
```

Expected: 十项全部打印 `OK`（无 `MISSING`）——覆盖三档、两个路由目标、确认硬门、个人表达保留项、原稿留档、转换脚本、扫描件错误处理。

- [ ] **Step 3: Commit**

```bash
git add skills/writing/workflows/optimize-existing.md
git commit -m "$(cat <<'EOF'
feat(writing): 新增「优化已有作品」工作流 — 体检+分档+路由

面向用户上传的完整作品：保存原稿 → 五维体检（只诊断不改）→ 三档修改强度
→ ⛔ 硬门等确认 → 路由到 polish-only / rewrite。只做诊断和路由，执行规则
仍由那两条工作流负责，不复制。三档默认保留个人表达，硬边界统一为「整体
结构能否改」。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: SKILL.md 登记新工作流 + 补触发语

**Files:**
- Modify: `skills/writing/SKILL.md:3-9`（frontmatter `description`）
- Modify: `skills/writing/SKILL.md:102-110`（独立工作流索引表）

**Interfaces:**
- Consumes: Task 3 产出的 `workflows/optimize-existing.md`（必须已存在，索引才不是断链）。
- Produces: SKILL.md 主索引能定位 optimize-existing.md（设计 §12 自动化测试 #4）；frontmatter 触发语覆盖「优化已有作品 / 作品体检」。

- [ ] **Step 1: frontmatter 触发语加「优化已有作品 / 作品体检」**

把 `SKILL.md` frontmatter 里这句：

```
  写文案 / 写小说 / 写文章 / 写公众号 / 改写 / 润色 / 去 AI 味, or mentions "writing".
```

改成（在「去 AI 味」后补两个触发语）：

```
  写文案 / 写小说 / 写文章 / 写公众号 / 改写 / 润色 / 去 AI 味 / 优化已有作品 / 作品体检, or mentions "writing".
```

- [ ] **Step 2: 独立工作流索引表加一行**

在 SKILL.md 「独立工作流索引」的表格里，`改写` 那一行**之前**插入一行（它是改写/润色的上游分诊台，放在前面更合逻辑）：

```
| 优化已有作品 | `workflows/optimize-existing.md` | 用户上传完整文稿（文章/小说/文案）要「优化 / 体检」，先五维诊断、分三档强度，再路由到润色 / 改写 |
```

- [ ] **Step 3: 校验——索引不断链 + references 库无回归**

Run:

```bash
# 索引链到的文件真实存在（不断链）
test -f skills/writing/workflows/optimize-existing.md && echo "FILE OK"
# SKILL.md 索引确实登记了它
grep -q "workflows/optimize-existing.md" skills/writing/SKILL.md && echo "INDEX OK"
# frontmatter 触发语已补
grep -q "优化已有作品" skills/writing/SKILL.md && echo "TRIGGER OK"
# references 资源库校验无回归（validate_library 只管 references，此处证明没误伤）
source skills/writing/bin/ensure-python.sh
$WRITING_PY skills/writing/scripts/validate_library.py && echo "LIBRARY OK"
```

Expected: 依次打印 `FILE OK` / `INDEX OK` / `TRIGGER OK` / `LIBRARY OK`（`validate_library.py` 退出码 0、无问题清单）。

- [ ] **Step 4: Commit**

```bash
git add skills/writing/SKILL.md
git commit -m "$(cat <<'EOF'
docs(writing): SKILL.md 登记 optimize-existing 工作流 + 补触发语

独立工作流索引加「优化已有作品」行（放改写/润色之前，它是上游分诊台）；
frontmatter description 补「优化已有作品 / 作品体检」触发语。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: polish-only / rewrite 补路由说明

**Files:**
- Modify: `skills/writing/workflows/polish-only.md`（顶部触发/区别说明段）
- Modify: `skills/writing/workflows/rewrite.md`（Step 0 段 + Step 4 改写纪律段）

**Interfaces:**
- Consumes: Task 3 的 `optimize-existing.md`（被这两处引用）。
- Produces: 两条执行工作流明确「可从 optimize-existing 路由进入、带着已确认档位」，口径与新工作流对齐。不改动它们既有的执行规则本身。

- [ ] **Step 1: polish-only.md 标注为轻度润色唯一执行源**

在 `polish-only.md` 顶部「和改写的区别（别混）」那段**之后**，补一句独立说明（引用锚点，不复制规则）：

```markdown
> **也是「优化已有作品」轻度润色档的唯一执行源**：用户从 [优化已有作品](optimize-existing.md) 主入口进来、在确认硬门里选了「轻度润色」时，会带着「只动文字、不动结构/观点/个人表达」的已确认前提路由到这里——直接从下面 Step 1 开始执行即可，那一档的边界与本工作流三个「不动」铁律完全一致。
```

- [ ] **Step 2: rewrite.md 标注接收已确认档位（Step 0 段）**

在 `rewrite.md` 的 `## Step 0 · 两条路径分流` 标题**下方、表格之前**，补一段前置说明：

```markdown
> **两种来法**：① 用户**绕过入口、直接在对话里**提改写要求 —— 走下面的意图判别（路径 A/B）；② 从 [优化已有作品](optimize-existing.md) 主入口的确认硬门**路由进来** —— 意图与档位**已经确认**，无需再判别，按带过来的档位直接执行：
> - **标准优化** → 走**路径 B（定向改写）**，并把「**整体结构不可改、允许拆分/合并段落、个人表达保留**」写入本次修改约束；
> - **深度改写** → 走**路径 A/全量**，把用户点名的「**必须保留项** + 个人表达」写入约束，本工作流自身的硬确认仍然保留。
>
> 下面的 Step 0 判别只适用于来法 ①。
```

- [ ] **Step 3: rewrite.md 改写纪律段补一句结构边界**

在 `rewrite.md` 的 Step 4「**改写纪律**（同润色那一棒）」那句**之后**，补一句把档位边界与既有纪律接上：

```markdown
> 从「优化已有作品」路由进来时，这条纪律按档位收紧：**标准优化**只允许拆合段落、绝不搬家/增删章节（整体结构不可改）；**深度改写**才可重排结构，但用户点名的「必须保留项」与「个人表达」是不可逾越的红线。
```

- [ ] **Step 4: 内容存在性校验（引用与约束都在场）**

Run:

```bash
grep -q "optimize-existing.md" skills/writing/workflows/polish-only.md && echo "POLISH LINK OK"
grep -q "optimize-existing.md" skills/writing/workflows/rewrite.md && echo "REWRITE LINK OK"
grep -q "整体结构不可改" skills/writing/workflows/rewrite.md && echo "STD CONSTRAINT OK"
grep -q "必须保留项" skills/writing/workflows/rewrite.md && echo "DEEP CONSTRAINT OK"
```

Expected: 四项全部打印 `... OK`。

- [ ] **Step 5: Commit**

```bash
git add skills/writing/workflows/polish-only.md skills/writing/workflows/rewrite.md
git commit -m "$(cat <<'EOF'
docs(writing): polish-only/rewrite 补 optimize-existing 路由说明

polish-only 标注为轻度润色唯一执行源；rewrite 说明可从优化入口带着已确认
档位路由进入（标准=结构不可改+允许拆合段落，深改=必须保留项+个人表达红
线），Step 0 意图判别只对「直接提改写」的来法生效。执行规则本身不动。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 手动走查（全部 task 完成后，对照设计 §12 手动走查）

自动化只能守住「配置/内容在场」，真正的流程正确性靠真机走查。**打开应用、用真实样稿逐条过**（每条对应设计 §12 一项）：

- [ ] 上传一篇 `.docx` 文章，从「优化已有作品」进入 → **先看到五维体检、确认前没有改写正文**。
- [ ] 选「轻度润色」→ 结构、观点、事实保持不变，输出有代表性对照。
- [ ] 选「标准优化」→ 只发生局部段落调整（含必要的拆/合段），整体结构（章节顺序、论证骨架）保持不变。
- [ ] 选「深度改写」→ AI **先确认目标与必须保留项**，再重构正文。
- [ ] 上传 `.txt` / `.md` / `.pdf` 各一份，确认文件槽 picker 只放这几类、`.doc` 置灰。
- [ ] 上传一篇扫描版 PDF（图片型）→ 得到「需要 OCR / 可复制文本」的诚实提示，不伪装成已读完。
- [ ] 上传不支持格式（如 `.doc`）→ 明确列出支持格式，原文件不动。
- [ ] 「个人表达」核对：用一篇口语化很强的原稿走轻度润色 → 用户的口头禅/语气没被去 AI 味规则抹成书面腔。

---

## Self-Review（已核对）

- **Spec coverage**：设计 §4.1 主入口→Task 2；§5.1/§5.2 文件槽→Task 1；§6 主入口流程/五维体检/三档/确认硬门→Task 3；§7 skill 改造（新工作流+SKILL.md+两条边界）→Task 3/4/5；§8 输出对账→Task 3 Step 7；§9 错误处理→Task 3 Step 1；§11 一期清单 6 项全覆盖；§12 自动化测试 #1#2→Task 1、#3→Task 2、#4→Task 4、#5（路由）→Task 3 内容守卫 + 手动走查；§14 三决策→Global Constraints + Task 3 三档表。§4.2/§4.3 两个快捷入口按 §14 决策 1 明确推迟二期（不在一期 task 内，已在 Global Constraints 说明）。§10 埋点为「建议记录」，一期不落代码（设计用词「一期建议」，非硬需求），不单列 task。
- **Placeholder 扫描**：无 TBD/TODO；所有代码步给了完整代码、所有 skill 内容给了完整正文、所有校验步给了可跑命令与预期输出。
- **Type/命名一致性**：全程只依赖既有导出 `acceptForPlaceholder`（Task 1 只改其数据表、不改签名）；`PROMPTS_BY_SKILL.writing`、`ACCEPT_BY_KEYWORD`、脚本名、工作流文件名在各 task 间一致。
