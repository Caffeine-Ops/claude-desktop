# 写方案 skill 重塑 · 实施计划（Part A）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `skills/proposal-writer` 从「app 专用的薄方法论文本」重塑为一个多模式、自给自足、支持「从素材生成 + 改写已有方案」两类任务的写方案 skill，并保持 app 满血模式不回归。

**Architecture:** SKILL.md 变成独立大脑（判模式/判任务/判类型/采集偏好/按需加载索引 + 独立流程）；写作纪律与章节写法拆成 `references/` 下约 50 张细颗粒卡（对标 gpt-image-2）；`append-template.md` 保留为 app 的写死契约文件，仅优化散文、不碰占位符。本计划只做 Part A（低风险，不改 app 逻辑）；Part B（app 内三阶段可选）另立计划。

**Tech Stack:** Markdown（skill 内容）、bun test（app 侧快照/契约测试）、Python 3 标准库（docx 抽取，勘察/验收用）。

## Global Constraints

- 包管理器是 **bun**，不是 npm。类型检查 `bun run typecheck`（repo 根，全 workspace）是主要自动化防线（无 ESLint）。
- **proposal bun test 必须从 `apps/studio` 目录跑**（cwd 决定 skills 插件目录解析；在仓库根跑会报「找不到 skills 插件目录」而全红）。基线：`cd apps/studio && bun test electron/main/core/proposalPrompt` = 26 pass（Task 0 已验证）。
- **G10 结论（Task 0 已勘察）**：app 斜杠拦截认**目录名** `proposal-writer`（`proposalSlash.ts` 的 `PROPOSAL_WRITER_SLASH_NAMES` 硬编码）+ `proposalPrompt.ts` 按目录名读模板，**不读 SKILL.md 的 frontmatter**。→ `description` 可自由重写、`name` 保持 `proposal-writer`；**目录 `skills/proposal-writer/` 不可改名**。
- **不可碰占位符/常量清单（Task 0 已列全）**：`{{COVER_BEGIN}}` `{{COVER_END}}` `{{TOC_BEGIN}}` `{{TOC_END}}` `{{CONTENT_BEGIN}}` `{{CONTENT_END}}` `{{COVER_CONFIRM_HEADER}}` `{{TOC_CONFIRM_HEADER}}` `{{GAP_PREFIX}}` `{{KB_SCOPE}}`。
- **契约铁律**：`apps/studio/electron/main/core/proposalPrompt.ts` 写死读
  `skills/proposal-writer/references/append-template.md`。此文件**不可挪、不可删、不可改文件名**；
  其中的哨兵（`===方案封面开始===` 等）、GAP 前缀（`⚠️ 资料缺失：`）、确认 header
  是解析器**逐字节匹配的硬协议**——改文时**只动散文、绝不碰 `{{占位符}}` 及其贴邻常量**。
  协议事实源：`apps/studio/electron/shared/proposal.ts`。
- **接地底线**：skill 全程「忠实搬运 + 标注出处 + 缺料标注」，**绝不编造**。独立模式**严禁编造图片路径**。
- 全程中文输出（方案正文与 skill 卡片均中文）。
- 真实范例源文件（勘察/验收用，只读不改）：
  `/Users/kika/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_6e468xv80pgz22_107d/msg/file/2026-06/20260621智能导诊和预问诊建设方案(1).docx`

---

## 共享约定：section 卡的统一结构（DRY，所有 sections/*.md 照此写）

每张 section 卡固定这几节，避免各卡各写：

```markdown
# <章节名>

## 何时用 / 不用
- 用：<触发场景>
- 不用：<该转投哪张卡>

## 缺失信息优先提问顺序
1. <最关键，缺了写不了的>
2. <次要，可默认的>

## 结构骨架（逐行）
<这节正文该长什么样，逐行小标题/字段，标出层级>

## 写作要点
- <接地：每段末尾（据《X》）>
- <本节该详还是略、常见篇幅>

## 本节常见呈现变体
- <逐条 / 段落 / 表格 / 图文，本节默认走哪种>

## 配图 / 结构图建议
- <本节适合 mermaid 哪种图 / 该配什么截图（app 满血）或占位（独立模式）>

## 正例 / 反例
- 正例：<一句话＋极短片段>
- 反例：<常见写坏的样子＋为什么错>
```

---

## Task 0: 勘察 —— 锁定契约与 G10，确认动手边界

**Files:**
- 只读：`apps/studio/electron/main/core/proposalPrompt.ts`、`apps/studio/electron/shared/proposal.ts`、
  `skills/proposal-writer/SKILL.md`、`skills/proposal-writer/references/append-template.md`、`skills/proposal-writer/NOTES.md`
- 只读勘察：app 斜杠拦截处（`FusionRuntimeProvider` 及 onNew）

**Interfaces:**
- Produces: 一条结论「app 斜杠拦截是否依赖 skill 的 `name`/`description`」——决定 Task 1 能否改 `name`。

- [ ] **Step 1: 定位斜杠拦截，判断是否认 skill 的 name/description**

Run:
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop
grep -rniE "proposal-writer|onNew|/proposal|斜杠|intercept|slash" apps/studio/src apps/studio/electron 2>/dev/null | grep -iE "proposal|slash|onNew" | head -40
```
Expected: 找到拦截 `/proposal-writer` 的位置。**判定**：拦截若匹配字符串 `proposal-writer`（命令名/skill 目录名），则 `name: proposal-writer` **不可改**；`description` 正文可自由改（app 不读它）。

- [ ] **Step 2: 确认 append-template 的读取路径与占位符清单**

Run:
```bash
grep -nE "append-template|COVER_BEGIN|TOC_BEGIN|CONTENT_BEGIN|GAP_PREFIX|CONFIRM_HEADER|\\{\\{" skills/proposal-writer/references/append-template.md apps/studio/electron/shared/proposal.ts | head -40
```
Expected: 列全 `{{占位符}}` 与哨兵/前缀常量。记下这张「不可碰清单」，供 Task 9 参照。

- [ ] **Step 3: 跑一遍现有 proposal 测试建基线**

Run:
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/studio && bun test electron/main/core/proposalPrompt 2>&1 | tail -20
```
Expected: 现有测试全绿（这是 Task 9 之后的对照基线）。若本地跑不动，记录命令供后续在能跑的环境执行。

- [ ] **Step 4: 提交勘察结论（写进 NOTES 草记）**

```bash
# 无代码改动；把结论追加到一个临时勘察记录，供后续任务引用
git add -A && git commit -m "chore(proposal-writer): 勘察契约与斜杠拦截边界（Task 0）" --allow-empty
```

---

## Task 1: SKILL.md —— 独立大脑（触发器 + 判模式/任务/类型 + 偏好 + 按需加载 + 独立流程）

**Files:**
- Modify（整体重写）：`skills/proposal-writer/SKILL.md`

**Interfaces:**
- Produces: SKILL.md 顶部的「读取指引」章节（Task 2–8 的卡按它被加载）；`description` 触发词集合。
- Consumes: Task 0 的 G10 结论（`name` 能否改）。

- [ ] **Step 1: 写 frontmatter（G1 触发器）**

`name` 依 Task 0 结论（默认保持 `proposal-writer` 不改）。`description` 重写为多宿主可触发，例如：

```yaml
---
name: proposal-writer
description: >
  售前/商业方案写作与改写（写方案）。支持从素材生成、或改写已有方案；覆盖售前建设/技术/产品/
  投标/POC 五类。在 Claude Desktop 内输入 /proposal-writer 或点侧栏「写方案」卡走满血模式
  （知识库检索、三阶段、Word/PDF 导出、配图）；在 CLI/claude.ai/其他宿主里直接展开走独立模式
  （读素材、纯 markdown 产出、缺料标注、绝不编造）。Use when the user asks to 写方案 / 售前方案 /
  建设方案 / 技术方案 / 产品方案 / 投标方案 / POC 方案 / 改方案 / proposal.
---
```

- [ ] **Step 2: 写「运行模式（必读）」——判模式（含独立模式 B/C 细分）**

正文写明：读到本 SKILL.md 即「不在 app 里 → 独立模式」（app 走注入 append-template、不读 SKILL.md）。
独立再分：有素材档（用户给了资料/文件路径）/ 无素材·顾问档（没料→只给骨架＋标待填，绝不编造）。
给一张「app 满血 vs 独立」对照表（照设计文档「运行模式」节）。写明两默认相反的原因（G9）。

- [ ] **Step 3: 写「第 0 步 判任务」「第 0.1 步 判类型」「第 0.5 步 采集偏好」**

- 判任务（G8）：generate（从素材生成）/ edit（改写已有方案），并各指向对应流程。
- 判类型：从用户话推断售前建设/技术/产品/投标/POC，拿不准才用一次 AskUserQuestion。
- 采集偏好（展示方式/详略侧重/篇幅/受众），能推断先推断、拿不准一次问清，尊重随时指令。

- [ ] **Step 4: 写「按需加载索引」（G5）——只放卡名 + 一句何时用**

列出 `references/` 全部卡的**索引**（卡名 + 一句），并写死加载纪律：先 SKILL.md → 读类型 `_skeleton` →
写某节只读该节 section 卡 + 命中的 methodology 卡 → 绝不预加载全部。

- [ ] **Step 5: 写「独立流程」——generate（默认一口气/可选逐段）+ edit（最小改动）**

generate：挑模板→定骨架→填素材→连续产出封面+目录+正文→一次性征求修改；可选逐段确认。
edit：摄入已有方案→解析现有结构→弄清诉求→最小改动、其余原样保留→守接地→输出。
并把「长文档一致性」（逐章产出 + 维护目录/术语表）与「独立模式产出降级」（只 mermaid、截图占位、
genimage 仅描述、序号手动补、手写目录）在此点名并链到对应 methodology 卡。

- [ ] **Step 6: 验证 —— 结构自查**

Run:
```bash
grep -nE "^---|description:|运行模式|第 0 步|按需加载|独立流程|editing-existing|降级" skills/proposal-writer/SKILL.md | head
```
Expected: 上述锚点全部出现；frontmatter 合法（首尾 `---`）。

- [ ] **Step 7: Commit**

```bash
git add skills/proposal-writer/SKILL.md
git commit -m "feat(proposal-writer): SKILL.md 重写为独立大脑（触发器/判模式任务类型/按需加载/独立流程）"
```

---

## Task 2: methodology/ —— 9 张写作纪律卡

**Files（全部 Create）:**
- `skills/proposal-writer/references/methodology/grounding-and-citation.md` — 不编造 + 每段末尾（据《X》）；多来源都列。
- `.../gap-marking.md` — 「⚠️ 资料缺失：<具体缺什么>」就地标注，描述具体到缺哪项数据/参数/案例。
- `.../images-and-figures.md` — 三类图分工：知识库截图（app 满血）/ mermaid 结构图 / genimage 门面图；**独立模式降级铁律**（只 mermaid、截图写占位「〔建议插入：XX 界面截图〕」、genimage 仅描述、严禁编造图路径）；mermaid 防语法错（含中文标点的节点标签用英文双引号包裹）。
- `.../tables.md` — 结构化数据（参数/对比/清单/计划/报价）用 GFM 表格；表值只填查到的真值、缺写「—」、不编造；表后仍标来源。
- `.../presentation-modes.md` — 逐条 / 段落 / 表格 / 图文，各自何时用、怎么写好。
- `.../emphasis-and-depth.md` — 详略与侧重：重点章节如何展开、次要如何压缩、篇幅档位。
- `.../asking-vs-proactive.md` — 何时自主（挑模板/定结构/表格vs段落）何时问（关键事实缺失且卡住）；问就用 AskUserQuestion 合并一次。
- `.../flow-oneshot-vs-staged.md` — 独立流程默认一口气；「我们一步步来」切逐段确认；两默认相反的说明（G9）。
- `.../editing-existing.md` — 改写已有方案（G8）：摄入→解析现有结构→弄清诉求→**最小改动、其余原样保留**→新增须有据否则标缺料→输出改后全文或仅变更节。

**Interfaces:**
- Produces: 被 SKILL.md 索引与各 section 卡引用的纪律卡。

- [ ] **Step 1: 建目录并逐卡撰写（内容照上列职责，接地/降级/mermaid 防错等硬纪律逐字落实）**

- [ ] **Step 2: 验证 —— 关键纪律在位**

Run:
```bash
grep -rl "严禁编造图片路径\|⚠️ 资料缺失\|最小改动\|逐段确认" skills/proposal-writer/references/methodology/ | sort
```
Expected: `images-and-figures.md`、`gap-marking.md`、`editing-existing.md`、`flow-oneshot-vs-staged.md` 分别命中。

- [ ] **Step 3: Commit**

```bash
git add skills/proposal-writer/references/methodology
git commit -m "feat(proposal-writer): methodology/ 9 张写作纪律卡（含独立模式降级/改写/缺料/接地）"
```

---

## Task 3: proposal-types/ —— 5 类骨架（售前扎实 + 4 通用）

**Files（全部 Create）:**
- `skills/proposal-writer/references/proposal-types/presales-construction/_skeleton.md` — 售前建设通用骨架：章节顺序 + 每章调用哪些 section 卡。
- `.../presales-construction/healthcare.md` — 医疗变体·扎实款，照真实范例骨架：封面 / 1 系统功能概述（建设背景·系统定位·产品总体概述·总体目标〔患者/医生/机构〕·业务范围·应用入口·建设价值·总体成效）/ 2 系统功能架构（总体架构说明·总体架构图·业务闭环·功能架构·AI 能力架构·关键技术·技术路线·总体特点）/ 3 系统功能（智能导诊〔导诊·交互集成·统计分析〕、智能预问诊〔接入·输入·对话·报告·配置·反馈〕…）。标「扎实款」。
- `.../technical-solution.md`、`.../product-solution.md`、`.../bidding-commercial.md`、`.../poc-pilot.md` — 每张单骨架卡，头部显眼标「通用款·待真实样本升级」，正文给该类型的通用章节骨架 + 一段「行业适配提示」（内联，不铺空文件）。

**Interfaces:**
- Consumes: Task 4–7 的 section 卡名（skeleton 里按名索引）。
- Produces: SKILL.md「判类型」后加载的入口。

- [ ] **Step 1: 撰写 presales `_skeleton.md` + `healthcare.md`（章节顺序与真实范例对齐）**

- [ ] **Step 2: 撰写 4 张通用类型卡，头部标注「通用款·待升级」**

- [ ] **Step 3: 验证 —— 售前骨架章节齐、通用款有标注**

Run:
```bash
grep -c "系统功能概述\|系统功能架构\|系统功能" skills/proposal-writer/references/proposal-types/presales-construction/healthcare.md
grep -rl "通用款·待真实样本升级\|通用款·待升级" skills/proposal-writer/references/proposal-types/*.md
```
Expected: healthcare 三大块命中；4 张通用卡全部带标注。

- [ ] **Step 4: Commit**

```bash
git add skills/proposal-writer/references/proposal-types
git commit -m "feat(proposal-writer): proposal-types/ 五类骨架（售前医疗扎实款 + 4 通用款）"
```

---

## Task 4: sections/ 封面 + 概述区（cover + overview 8 张）

**Files（全部 Create，均照「共享约定 section 卡结构」）:**
- `skills/proposal-writer/references/sections/cover.md` — 封面：标题（# 一级）→抬头（客户单位等）→单行 `---`→落款（编制单位/日期）。独立模式排布规则见 images/降级。**封面不插图、不标来源**。
- `sections/overview/background.md`、`positioning.md`、`product-summary.md`、`goals-by-audience.md`（患者/医生/机构三视角各一段）、`business-scope.md`、`entry-points.md`、`value.md`（常逐条）、`outcomes.md`。

- [ ] **Step 1: 撰写 cover.md + 8 张 overview 卡（每张含全部固定节；goals-by-audience 给三视角模板）**

- [ ] **Step 2: 验证 —— 卡数与结构完整**

Run:
```bash
ls skills/proposal-writer/references/sections/overview/ | wc -l   # 期望 8
grep -L "本节常见呈现变体" skills/proposal-writer/references/sections/overview/*.md   # 期望无输出（每张都有）
```
Expected: 8 张；无缺「呈现变体」节的卡。

- [ ] **Step 3: Commit**

```bash
git add skills/proposal-writer/references/sections/cover.md skills/proposal-writer/references/sections/overview
git commit -m "feat(proposal-writer): sections 封面 + 概述区 8 张写法卡"
```

---

## Task 5: sections/architecture 架构区（7 张）

**Files（全部 Create，照共享结构）:**
- `sections/architecture/overall-architecture.md`（总体架构说明 + 门面架构图：app 满血用 genimage、独立模式仅描述/退 mermaid）、`business-loop.md`、`functional-architecture.md`、`ai-capability.md`、`key-tech.md`（常表格化）、`tech-roadmap.md`（常表格+图）、`system-traits.md`。

- [ ] **Step 1: 撰写 7 张架构卡（overall 明确 genimage/降级分模式；含 mermaid 图型建议）**

- [ ] **Step 2: 验证**

Run:
```bash
ls skills/proposal-writer/references/sections/architecture/ | wc -l   # 期望 7
grep -l "genimage" skills/proposal-writer/references/sections/architecture/overall-architecture.md
```
Expected: 7 张；overall 提到 genimage 与独立降级。

- [ ] **Step 3: Commit**

```bash
git add skills/proposal-writer/references/sections/architecture
git commit -m "feat(proposal-writer): sections 架构区 7 张写法卡"
```

---

## Task 6: sections/features 功能详述区（_pattern-guide + 7 形态卡）

**Files（全部 Create）:**
- `sections/features/_pattern-guide.md` — 功能卡通用总则：叶子功能 =「小标题 → 一句定义 → 功能说明 → 截图（满血）/占位（独立）→（据《X》）」。
- `input-methods.md`、`dialogue.md`、`recommendation.md`、`integration.md`、`report-generation.md`、`stats-analysis.md`、`admin-backend.md` — 各形态给 2–3 个叶子功能的写法范例（照真实范例的功能名）。

- [ ] **Step 1: 撰写 pattern-guide + 7 张形态卡（叶子功能范例贴合真实范例功能名）**

- [ ] **Step 2: 验证**

Run:
```bash
ls skills/proposal-writer/references/sections/features/ | wc -l   # 期望 8（含 _pattern-guide）
grep -l "小标题" skills/proposal-writer/references/sections/features/_pattern-guide.md
```
Expected: 8 个文件；总则含「小标题→…」骨架。

- [ ] **Step 3: Commit**

```bash
git add skills/proposal-writer/references/sections/features
git commit -m "feat(proposal-writer): sections 功能详述区（总则 + 7 形态卡）"
```

---

## Task 7: sections/delivery 交付区（3 张）

**Files（全部 Create，照共享结构）:**
- `sections/delivery/implementation-plan.md`（实施计划，常甘特图 mermaid）、`after-sales.md`（售后服务）、`pricing-config.md`（报价/配置，投标类，强表格化、缺值写「—」不编造）。

- [ ] **Step 1: 撰写 3 张交付卡**

- [ ] **Step 2: 验证**

Run:
```bash
ls skills/proposal-writer/references/sections/delivery/ | wc -l   # 期望 3
```
Expected: 3 张。

- [ ] **Step 3: Commit**

```bash
git add skills/proposal-writer/references/sections/delivery
git commit -m "feat(proposal-writer): sections 交付区 3 张写法卡"
```

---

## Task 8: quality/ + examples/

**Files（全部 Create）:**
- `references/quality/rubric.md` — 交付前打分清单：逐句可溯源？图文/结构图密度达标？无编造？缺料已标注？章节层级合规？封面/目录规范？呈现是否贴合偏好？
- `references/quality/antipatterns.md` — 常见反模式：编造内容/图路径、塞装饰图、把深层小节压平、封面加 HTML、目录自写序号、缺料静默跳过。
- `references/examples/good-feature-section.md`、`good-architecture-section.md`、`bad-fabricated-section.md` — 从真实范例脱敏提炼的正/反例。

- [ ] **Step 1: 撰写 rubric + antipatterns + 3 例**

- [ ] **Step 2: 验证**

Run:
```bash
ls skills/proposal-writer/references/quality/ skills/proposal-writer/references/examples/
```
Expected: quality 2 个、examples 3 个文件在位。

- [ ] **Step 3: Commit**

```bash
git add skills/proposal-writer/references/quality skills/proposal-writer/references/examples
git commit -m "feat(proposal-writer): quality 自检清单/反模式 + 好坏范例"
```

---

## Task 9: append-template.md 优化（惠及 app 满血）+ 更新测试基线 —— 高危、单独一任务

**Files:**
- Modify：`skills/proposal-writer/references/append-template.md`（**只动散文，绝不碰 `{{占位符}}`/哨兵/GAP 前缀/确认 header**）
- Modify（更新基线）：`apps/studio/electron/main/core/proposalPrompt.snapshot.test.ts` 的 `.snap`；核对 `proposalPromptTemplate.test.ts` 契约不破。
- 参照：`skills/proposal-writer/NOTES.md`（改前必读那两段警告）

**Interfaces:**
- Consumes: Task 0 的「不可碰清单」。

- [ ] **Step 1: 加三条散文纪律（不碰占位符）**

在方法论散文里补：①「更主动、少问」（AI 自主挑结构、只在关键事实缺失且卡住时合并一次问）；
②「缺料优雅标注」已有则加强；③「尊重用户呈现/侧重偏好」（逐条 vs 段落、重点章节详写、篇幅、受众语气）。
**改动只落在散文句子里**，占位符行与其贴邻常量一字不动。

- [ ] **Step 2: 先跑契约测试确认没撞硬协议**

Run:
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/studio && bun test electron/main/core/proposalPromptTemplate 2>&1 | tail -20
```
Expected: 契约测试仍 PASS（若 FAIL＝碰到了硬协议，回退 Step 1 的措辞，别改占位符）。

- [ ] **Step 3: 更新快照基线**

Run:
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/studio && bun test electron/main/core/proposalPrompt.snapshot --update-snapshots 2>&1 | tail -20
```
Expected: 快照更新成功，diff 只反映本次散文改动（人工核对 diff 合理）。

- [ ] **Step 4: 全量 proposal 测试 + typecheck**

Run:
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/studio && bun test electron/main/core/proposalPrompt 2>&1 | tail -20 && bun run typecheck 2>&1 | tail -15
```
Expected: 全绿。

- [ ] **Step 5: Commit（含 .snap）**

```bash
git add skills/proposal-writer/references/append-template.md apps/studio/electron/main/core/*.snap
git commit -m "feat(proposal-writer): append-template 补主动性/缺料/偏好纪律 + 刷新快照（不碰硬协议）"
```

---

## Task 10: NOTES.md 修订 + 质量验收（G7）+ 独立模式冒烟

**Files:**
- Modify：`skills/proposal-writer/NOTES.md`（修陈旧路径 `apps/desktop`→`apps/studio`；补「append-template 与 SKILL.md 的不编造/溯源底线必须同步改」的漂移警告；**把原先住在 SKILL.md「维护须知」里、Task 1 重写时移走的开发者维护指引搬进这里**：app 如何消费 skill——`proposalPrompt.ts` 按目录名读 `references/append-template.md`、斜杠拦截在 `FusionRuntimeProvider.tsx` + `proposalSlash.ts`（`PROPOSAL_WRITER_SLASH_NAMES`）、协议字样事实源 `shared/proposal.ts`；改 append-template 的测试须从 `apps/studio` 跑、契约 vs 快照两类后果；目录 `proposal-writer/` 不可改名）

**Interfaces:**
- Consumes: 全部前置任务产出的 skill。

- [ ] **Step 1: 修订 NOTES.md（路径 + 漂移警告 + 双份方法论同步须知 + 搬回 SKILL.md 移走的开发者维护指引，见上 Files）**

- [ ] **Step 2: 独立模式冒烟 —— 用真实范例源料重生成一节（G7 质量验收）**

抽真实范例某功能小节的源文字（用 Python 抽 docx，见 Global Constraints 路径），喂给独立模式让其重写这一节，人工核对：
- 结构＝「小标题→定义→说明→截图占位→（据《X》）」；
- **没有编造图片路径**（只有 `〔建议插入…〕` 占位或 mermaid）；
- 查不到处有「⚠️ 资料缺失：…」；
- 呈现贴合所选偏好。

Run（抽源料示例）：
```bash
PY="$(command -v python3)"; "$PY" - <<'EOF'
# 抽取真实范例某节文字，人工投喂给独立模式做对照重写
import zipfile
from xml.etree import ElementTree as ET
W="{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
p="/Users/kika/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_6e468xv80pgz22_107d/msg/file/2026-06/20260621智能导诊和预问诊建设方案(1).docx"
z=zipfile.ZipFile(p); root=ET.fromstring(z.read("word/document.xml"))
paras=["".join(t.text or "" for t in el.iter(f"{W}t")).strip() for el in root.iter(f"{W}p")]
print("\n".join([x for x in paras if x][:60]))
EOF
```
Expected: 拿到源料；重写产物通过上述四条人工核对。

- [ ] **Step 3: app 满血模式无回归确认**

Run:
```bash
cd /Users/kika/Desktop/project/Electron/claude-desktop/apps/studio && bun test electron/main/core/proposal 2>&1 | tail -25 && bun run typecheck 2>&1 | tail -10
```
Expected: 全绿（Task 9 已保证；此处二次确认整套 proposal 子系统未回归）。

- [ ] **Step 4: Commit**

```bash
git add skills/proposal-writer/NOTES.md
git commit -m "docs(proposal-writer): NOTES 修陈旧路径 + 双份方法论漂移警告；独立模式质量验收通过"
```

---

## Part B（次期计划，另立文档）

Part B「app 内三阶段可选」需先做代码勘察（精确定位『没确认就丢弃早到正文』的硬门在
`proposal.ts` / `engine.ts` / `proposalDraftStore.ts` / renderer 的哪一处）才能写出无占位的精确任务。
待 Part A 落地后，另立 `docs/superpowers/plans/<日期>-proposal-writer-staging-toggle.md`，覆盖：
`AppSettings.proposalStageMode`（默认 `staged`）→ `proposalPrompt.ts` 双方法论变体注入 →
硬门放松（oneshot 不丢弃）→ 设置页 UI 开关（shadcn）→ 快照/契约测试更新。

---

## Self-Review（对照设计文档）

- **Spec 覆盖**：多模式(Task1)/两类任务 generate+edit(Task1,2 editing-existing)/五类型(Task3)/~50 卡(Task2–8)/
  偏好层(Task1,2 presentation+emphasis)/素材摄入与降级(Task1,2 images)/长文档一致性(Task1)/按需加载(Task1)/
  append 优化+测试(Task9)/契约与漂移风险(Task0,9,10)/质量验收 G7(Task10)/G10(Task0)/NOTES 修订(Task10) — 均有任务。
  Part B 明确另立计划。
- **占位符扫描**：内容类任务给了统一卡结构与逐卡职责，非「TODO」；代码/命令步骤均给了可执行命令与期望。
- **一致性**：卡命名与 SKILL.md 索引、skeleton 引用同名；append-template 契约在 Global Constraints 与 Task0/9 一致口径。
