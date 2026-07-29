# 写作技能【去AI化】Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在写作技能下新增唯一对外入口「去AI化」——轻量快道，贴文字吐人味版+改动摘要，中英双语，只擦 AI 痕迹不提质不改结构。

**Architecture:** 三处改动：(1) 把 `references/anti-ai-slop.md` 从中文单语升级为中英双语破绽库（加语言路由说明 + 节标注 + 新增英文破绽节）；(2) 新增 `workflows/de-ai.md` 轻量工作流，按语言读上面那份参考、走 self-critique 三步改写；(3) 在 `SKILL.md` 登记新工作流、补触发词、把「去 AI 味」对外招牌从 polish-only 挪给 de-ai。脚本 `ai_slop_checker.py` 及其词表**不动**（方案 A：英文不打分）。

**Tech Stack:** 纯 Markdown（工作流 / 参考文档）。无代码、无 pytest。复用现有 Python 脚本 `style_profile.py`、`ai_slop_checker.py`（不修改它们）。

## Global Constraints

- 中文正文用全角标点，代码 / 路径 / 命令内用半角。
- 所有 `python3 ...` 命令在文档里一律写成 `$WRITING_PY ${SKILL_DIR}/scripts/...`（本技能 venv 自举后的变量），绝不写裸 `python3`。
- 不修改 `scripts/ai_slop_checker.py` 及 `scripts/data/*.txt` 词表（方案 A，英文不打分）。
- 不修改 `polish-only.md` 的干活逻辑，只在 SKILL.md 里改它的对外触发描述。
- 去AI化铁律（贯穿 de-ai.md）：只擦 AI 痕迹、绝不捏造、个人表达保留、不承诺骗过检测器。
- SKILL.md line 34「下面八条」是**全局执行纪律**条数，**禁止改动**；只改 line 100「八条独立工作流」→「九条」。

---

## Task 1: 把 `anti-ai-slop.md` 升级为中英双语破绽库

**Files:**
- Modify: `skills/writing/references/anti-ai-slop.md`（现 258 行，中文单语）

**Interfaces:**
- Produces: 一份带「语言路由」说明、各节带语言标注、末尾含 `## 7. 英文稿去 AI 味（English de-AI）` 的参考文档。Task 2 的 de-ai.md 会按节名（§0 / §1–§5 / §7）引用它，节名与本任务落定的一致。

- [ ] **Step 1: 加「语言路由」说明块**

在文件顶部 intro 区（第 10 行 `> 脚本负责…怎么改。` 之后、第 12 行 `---` 之后）与 `## 0.` 之间，插入以下新节：

```markdown
## 语言路由（中文稿 / 英文稿各读哪些节）

本文件中英双语。**先看稿子是什么语言，再决定读哪些节**：

- **中文稿** → §0 + §1–§5（§6 是人机分工，脚本仅覆盖中文）。
- **英文稿** → §0 + §7（英文稿去 AI 味）+ §4–§5。**英文不跑打分脚本**，靠 §7 人工改写 + §5 的纪律兜底。
- **中英混排** → 两套都读。

**§0 结构均匀度是跨语言通用的第一杠杆**——中英文 AI 稿都栽在「节奏太齐」。§1–§3（套话 / AI 句式 / 书面词）是中文专属；§4（三维度揉进）、§5（改味纪律）跨语言通用。

---
```

- [ ] **Step 2: 给各节标题补语言标注**

逐条精确替换标题行（只改标题，正文不动）：

- `## 0. 第一原则：结构均匀度` → `## 0. 第一原则：结构均匀度（通用 · 中英适用）`
- `## 1. 套话库` → `## 1. 套话库（中文）`
- `## 2. AI 句式库` → `## 2. AI 句式库（中文）`
- `## 3. 书面词替换库` → `## 3. 书面词替换库（中文）`
- `## 4. 三维度揉进（叙事类专用）` → `## 4. 三维度揉进（叙事类专用 · 通用）`
- `## 5. 改味纪律` → `## 5. 改味纪律（通用）`
- `## 6. 与脚本的分工` → `## 6. 与脚本的分工（通用 · 脚本仅覆盖中文）`

- [ ] **Step 3: 在文件末尾追加 §7 英文破绽节**

在文件最末（§6 结束后）追加：

````markdown

---

## 7. 英文稿去 AI 味（English de-AI）

> **英文稿走本节 + §0（结构均匀是跨语言通用的第一杠杆）+ §4–§5。** 词表脚本（`ai_slop_checker.py`）只覆盖中文，英文稿不跑脚本，靠本节人工改写 + §5 的 self-critique 兜底。
> 本节吸收自 [blader/humanizer](https://github.com/blader/humanizer)（维基「Signs of AI writing」33 条），只收能落地的，分「通用」与「英文专属」两类。

### 7.1 通用破绽（跨语言，中英都适用；中文对应见 §1–§3）

| 破绽 | 为什么露馅 | ❌ | ✅ |
|---|---|---|---|
| 意义拔高（significance inflation） | AI 爱把普通事说成划时代 | This tool represents a groundbreaking milestone in productivity. | It's a to-do app that syncs across devices. |
| 营销腔（promotional language） | 形容词堆砌、无证据的最高级 | Our seamless, cutting-edge platform delivers unparalleled value. | It loads fast and rarely crashes — here's the benchmark. |
| 模糊出处（vague attribution） | 「有研究表明」却不给来源 | Studies show that users prefer dark mode. | A 2023 Nielsen survey (n=2,000) found 62% preferred dark mode. |
| 虚假并列 / 排比（false parallelism） | 三点式对仗撑结构 | It's fast, it's simple, and it's powerful. | It's fast. Setup takes about a minute — that's the main thing. |
| 谄媚语气（sycophancy） | 对话残留、讨好读者 | Great question! I'd be happy to help you explore this. | （删掉，直接进正文） |
| 空洞收尾金句（manufactured punchline） | 强行升华的结尾 | In the end, it's not about the tool — it's about the journey. | （删掉，或用一句具体的下一步收尾） |

### 7.2 英文专属破绽

| 破绽 | 为什么露馅 | ❌ | ✅ |
|---|---|---|---|
| em dash 泛滥 | AI 每段都甩 — 插入语 | The result — surprisingly — was clear. | The result was clear, which surprised us. |
| 标题 Title Case | 每个词首字母大写 | How To Improve Your Writing Today | How to improve your writing today |
| emoji 装点 | 小标题 / 要点前挂 emoji | 🚀 Boost Your Productivity | Boost your productivity |
| 系动词回避（copula avoidance） | 用 serves as / stands as 替 is | This serves as a testament to good design. | This is good design. |
| AI 高频词 | testament / landscape / tapestry / realm / delve | We must delve into the evolving landscape of... | Let's look at how X is changing. |
| hyphenated pairs 套话 | ever-evolving / fast-paced 连字符词组 | In today's fast-paced, ever-evolving world... | These days... |
| false ranges（from X to Y） | 假穷举显得全面 | Everything from strategy to execution to iteration. | Strategy and execution, mostly. |
| 过度加粗 | 满屏 **bold** 抢重点 | **Every** other phrase is **bold**. | 只给真正的关键词加粗，一段最多一处。 |

> 改法逻辑与中文同源（见 §5）：**优先删，其次换，最后才小范围重写**；打破对称、去掉装点、把拔高的话落回具体。§0 的节奏均匀对英文一样致命——改完务必回看句长 / 段长是否还像用尺子量过。
````

- [ ] **Step 4: 校验没误伤资源库结构**

Run:
```bash
cd skills/writing && source bin/ensure-python.sh && $WRITING_PY scripts/validate_library.py
```
Expected: 通过（无报错）。`anti-ai-slop.md` 不在库校验范围，此步是确认改动没波及 `voices|structures|genres`。若自举失败（找不到解释器/pip），如实报告并停，不回退裸 `python3`。

- [ ] **Step 5: 读检**

Run:
```bash
grep -n "^## " skills/writing/references/anti-ai-slop.md
```
Expected: 依次出现「语言路由」「0. …（通用 · 中英适用）」「1. …（中文）」「2. …（中文）」「3. …（中文）」「4. …（叙事类专用 · 通用）」「5. …（通用）」「6. …（通用 · 脚本仅覆盖中文）」「7. 英文稿去 AI 味（English de-AI）」。

- [ ] **Step 6: Commit**

```bash
git add skills/writing/references/anti-ai-slop.md
git commit -m "feat(writing): anti-ai-slop 升级为中英双语破绽库

加语言路由说明 + 各节语言标注 + 新增 §7 英文稿去 AI 味（吸收 humanizer 33 条可落地项）。脚本词表不动，英文破绽纯作人工改写指南。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 新增 `workflows/de-ai.md` 轻量工作流

**Files:**
- Create: `skills/writing/workflows/de-ai.md`

**Interfaces:**
- Consumes: Task 1 落定的 `anti-ai-slop.md` 节名（§0 / §1–§5 / §7）；现有脚本 `scripts/style_profile.py`、`scripts/ai_slop_checker.py`（不修改）。
- Produces: 一个独立工作流文件，供 Task 3 在 SKILL.md 索引里登记引用（路径 `workflows/de-ai.md`）。

- [ ] **Step 1: 写入 de-ai.md 完整内容**

创建 `skills/writing/workflows/de-ai.md`，内容为：

````markdown
---
description: 去AI化（唯一对外入口）—— 用户给一段成稿要「去AI化 / 去 AI 味 / humanize / 让这段不像 AI 写的 / 擦掉 AI 痕迹」。轻量快道：不建项目、不走八项确认、不用契约，贴文字→吐人味版+改动摘要。中英双语。铁律：只擦 AI 痕迹，保留原意/事实/观点/结构，绝不捏造。
---

# 去AI化工作流（De-AI / Humanize）

> 独立工作流，唯一的「去AI化」对外入口。触发：用户给一段**已经成型的文字**，要「去AI化 / 去 AI 味 / humanize / 让这段读起来不像 AI 写的 / 把 AI 痕迹擦掉」。它是**轻量快道**——默认纯对话内完成，**不建项目、不走策划八项确认、不用 spec_lock 契约**。

**和别的工作流别混（分界）**：
- 要「优化 / 体检完整作品、可能大改提质」→ [优化已有作品](optimize-existing.md)。
- 要「换个说法 / 换体裁 / 大改结构」→ [改写](rewrite.md)。
- 要「纯文学润色顺一遍文字」（管线语境 / 轻度润色档）→ [只润色](polish-only.md)。
- 只要「把 AI 味擦掉、别的不动」→ 就是本工作流。

**中英双语**：中文稿、英文稿、中英混排都能干活，读 `anti-ai-slop.md` 时按语言取对应节（见 Step 2）。

---

## 统摄铁律（改之前先钉死）

1. **只擦 AI 痕迹** —— 保留原意、事实、观点、篇章结构，只把「一看就是 AI 写的」味道换掉。不提质、不改结构、不动论证逻辑（那是 optimize-existing / rewrite 的活）。
2. **绝不捏造（no-fabrication）** —— 不新增原文没有的事实、人名、日期、引用、数据。去味只能删 / 换 / 重组表达，编不得。
3. **个人表达默认保留** —— 用户 / 客户自己的语气、口头禅、用词习惯不是 AI 味，不用统一腔调覆盖。
4. **⚠️ 伦理红线：不承诺骗过检测器** —— 目标是「让文字自然、像人写」，**不宣称、不保证能骗过任何具体 AI 检测器**（检测是军备竞赛、不可靠，且沾学术诚信灰区）。用户若坚持要「过某检测」，如实说明：我们只做「更像人」，不保证过检。

---

## Step 0 · 接收输入 + 识别语言

- **接收输入**：三种来源都行——对话里贴的文字 / 一个文件路径 / 指向某项目 `drafts`、`output` 里的稿。稿子已在上下文里就直接用；给的是文件路径就先读进来。
- **识别语言**：判定中文 / 英文 / 中英混排，决定 Step 2 读 `anti-ai-slop.md` 的哪些节。
- **轻量守则**：默认**不建项目、不落盘**，纯对话内改完吐回。只有要用「文风对齐」（Step 1）或「打分证据」（Step 4）时，才需要先跑 Python 自举（见 SKILL.md 顶部「🐍 Python 环境」）并把稿子存成 `.md`。

## Step 1 ·（可选）文风对齐

🚧 仅当用户**主动提供了往期文章 / 文风样本**、希望人味版更像本人时才做；没给就跳过，转「自然中性人声」。

```bash
$WRITING_PY ${SKILL_DIR}/scripts/style_profile.py <样本文件或目录> --out <独立路径，如 scratch 目录里的 .md>
```

> ⚠️ `--out` **绝不能落在被扫描的样本目录里**，否则重跑会把上次档案当语料再统计、越滚越偏。产出的档案末尾有可直接取用的文风特征，改写时当目标声音。

## Step 2 · 读破绽库（按语言取节）

`read_file references/anti-ai-slop.md`，按 Step 0 判定的语言取节：

- **中文稿** → §0（结构均匀度）+ §1–§5。
- **英文稿** → §0（结构均匀度，跨语言通用）+ §7（英文稿去 AI 味）+ §4–§5。
- **中英混排** → 两套都读。

> 记住 `anti-ai-slop.md` 的第一原则：**去 AI 味第一杠杆是改结构（节奏均匀），不是换词**——这条中英都成立。

## Step 3 · 改写（self-critique 三步，别一遍过）

**一、逐段改一遍**：按破绽库把套话 / AI 句式 / 英文破绽 / 均匀节奏就地改掉。删最少字、换最大效果（优先删，其次换，最后才小范围重写一句）。**只动表达，不碰事实与结构。**

**二、自审「这还像 AI 吗」**：改完切换成审查者视角，通读一遍，专挑残留的 AI 痕迹列出来（尤其 §0 的节奏均匀——最容易漏）。这一步是本快道最划算的质量杠杆，别省。

**三、补第二遍**：按自审清单再改一轮，清掉残留。

> 全程守铁律：发现内容有硬伤（事实错、逻辑漏）**不在这里顺手改**，单独标一句提给用户——那超出「去味」范围。

## Step 4 ·（可选，仅中文）打分证据

想给用户看量化证据时（仅中文稿，脚本不支持英文）：把改写前、后各存一份 `.md`，各跑一次五维打分，对比前后分。

```bash
$WRITING_PY ${SKILL_DIR}/scripts/ai_slop_checker.py <改写前.md>
$WRITING_PY ${SKILL_DIR}/scripts/ai_slop_checker.py <改写后.md>
```

> 英文稿跳过本步（`ai_slop_checker.py` 只覆盖中文）；不需要证据时整步略过，保持快道轻量。

## Step 5 · 输出

交付两样：

1. **人味版全文**（对话内直接给；若输入来自某项目文件，可另存到该项目 `output/` 并报完整路径）。
2. **「改了哪些味」摘要** —— 分类列：擦了哪些套话 / AI 句式 / 英文破绽 / 均匀节奏，让用户一眼看清动了什么、**没动事实与结构**。（可选）附 Step 4 的前后分对比。

---

## ✅ 去AI化完成检查点

```markdown
## ✅ 去AI化完成
- [x] 只擦了 AI 痕迹：原意 / 事实 / 观点 / 篇章结构原封未动
- [x] 没捏造任何原文没有的事实 / 人名 / 日期 / 引用
- [x] 走完了 self-critique 三步（改一遍 → 自审 → 补第二遍）
- [x] 按语言读对了 anti-ai-slop.md 的节（中文 §0+§1–§5 / 英文 §0+§7+§4–§5）
- [x] （可选）给了文风对齐 / 中文前后分对比
- [x] 给了「改了哪些味」摘要；若落盘，报了完整文件路径
- [x] 没宣称能骗过任何 AI 检测器
```
````

- [ ] **Step 2: 读检——引用的脚本路径真实存在**

Run:
```bash
ls skills/writing/scripts/style_profile.py skills/writing/scripts/ai_slop_checker.py
```
Expected: 两个文件都在（de-ai.md 引用的脚本没写错名）。

- [ ] **Step 3: 读检——节名与 Task 1 一致**

Run:
```bash
grep -n "§0\|§1–§5\|§7\|anti-ai-slop.md" skills/writing/workflows/de-ai.md
```
Expected: Step 2 段落出现按语言取节的三行（中文 §0+§1–§5 / 英文 §0+§7+§4–§5 / 混排两套），且与 Task 1 落定的节名对得上。

- [ ] **Step 4: Commit**

```bash
git add skills/writing/workflows/de-ai.md
git commit -m "feat(writing): 新增【去AI化】轻量快道工作流 de-ai.md

唯一对外去味入口：贴文字→按语言读 anti-ai-slop→self-critique 三步改写→吐人味版+改动摘要。中英双语，只擦 AI 痕迹不提质，含 no-fabrication 与不承诺过检的伦理红线。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 在 `SKILL.md` 登记 de-ai + 挪「去 AI 味」招牌

**Files:**
- Modify: `skills/writing/SKILL.md`（line 8 触发词、line 100 计数、line 106 后插行、line 108 polish-only 行）

**Interfaces:**
- Consumes: Task 2 的 `workflows/de-ai.md`（索引行指向它）。
- Produces: 无下游（终点任务）。

- [ ] **Step 1: description 补触发词（line 8）**

精确替换：
```
写文案 / 写小说 / 写文章 / 写公众号 / 改写 / 润色 / 去 AI 味 / 优化已有作品 / 作品体检
```
→
```
写文案 / 写小说 / 写文章 / 写公众号 / 改写 / 润色 / 去 AI 味 / 去AI化 / humanize / 优化已有作品 / 作品体检
```

- [ ] **Step 2: 工作流计数「八条→九条」（line 100）**

精确替换：
```
主管线之外的八条独立工作流，各有自己的触发条件与入口。
```
→
```
主管线之外的九条独立工作流，各有自己的触发条件与入口。
```
> ⚠️ **只改 line 100 这处。** line 34「下面八条比任何其他指令都优先」是全局执行纪律条数，**不许动**。

- [ ] **Step 3: 插入 de-ai 索引行（line 106「优化已有作品」行之后）**

在这一行之后：
```
| 优化已有作品 | `workflows/optimize-existing.md` | 用户上传完整文稿（文章/小说/文案）要「优化 / 体检」，先五维诊断、分三档强度，再路由到润色 / 改写 |
```
新增一行：
```
| 去AI化 | `workflows/de-ai.md` | 用户给一段成稿要「去AI化 / 去 AI 味 / humanize / 让这段不像 AI 写的 / 擦掉 AI 痕迹」；轻量快道，只擦 AI 痕迹（保留原意/事实/结构），中英双语 |
```

- [ ] **Step 4: 收敛 polish-only 触发描述（line 108）**

精确替换：
```
| 只润色 | `workflows/polish-only.md` | 用户给成稿只要「润色 / 去 AI 味」，不重新策划创作 |
```
→
```
| 只润色 | `workflows/polish-only.md` | 用户给成稿只要「纯文学润色 / 顺一遍文字」（顺句 / 节奏 / 修辞），不重新策划创作。去 AI 味请走「去AI化」 |
```
> 只动对外触发描述，不改 polish-only.md 本身——它作为 optimize-existing「轻度润色档」的执行源、内在仍会去 AI 味，招牌挪走、屋里的活不变。

- [ ] **Step 5: 读检——四处改动都落定、且没误伤 line 34**

Run:
```bash
cd skills/writing && grep -n "去AI化\|九条独立工作流\|下面八条\|de-ai.md\|纯文学润色" SKILL.md
```
Expected:
- line 8 触发词含「去AI化 / humanize」；
- line 100 为「九条独立工作流」；
- line 34 仍为「下面八条…」（未被动）；
- 出现 `| 去AI化 | ` workflows/de-ai.md ` | …` 索引行；
- polish-only 行含「纯文学润色」且「去 AI 味请走「去AI化」」。

- [ ] **Step 6: 全链引用自检——de-ai.md 被登记、无断链**

Run:
```bash
cd skills/writing && ls workflows/de-ai.md && grep -c "de-ai.md" SKILL.md
```
Expected: 文件存在；SKILL.md 里 `de-ai.md` 出现次数 ≥1。

- [ ] **Step 7: Commit**

```bash
git add skills/writing/SKILL.md
git commit -m "docs(writing): SKILL.md 登记【去AI化】+ 挪去味招牌

description 补 去AI化/humanize 触发词；工作流索引加 de-ai 行、计数八→九；polish-only 对外触发收敛为纯文学润色，去 AI 味统一走 de-ai（不动其干活逻辑）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage（逐条对 spec）：**
- §5 交付物三项 → Task 1（anti-ai-slop 增强）、Task 2（de-ai.md）、Task 3（SKILL.md）✅
- §6 工作流 5 步（接收/识别语言、可选文风、读库、self-critique 改写、可选打分、输出摘要）→ Task 2 Step 1 全文含 Step 0–5 ✅
- §7 决策 A（脚本不动）→ Global Constraints + 全程未触碰 `ai_slop_checker.py` ✅
- §7 决策 B（挪招牌、不动 polish-only 逻辑）→ Task 3 Step 4 ✅
- §7 决策 C（双语化：路由说明 + 节标注 + 英文节）→ Task 1 Step 1–3 ✅
- §4 铁律（只去味/no-fabrication/个人表达/伦理红线）→ Task 2 统摄铁律四条 + 完成检查点 ✅
- §8 边界表 → Task 2 分界段 + Task 3 索引行区分 ✅
- §9 测试（无 pytest，跑 validate_library + 读检）→ Task 1 Step 4–5、Task 2 Step 2–3、Task 3 Step 5–6 ✅

**2. Placeholder scan：** 无 TBD/TODO；每个文件的最终完整内容已写入对应 Step。✅

**3. Type/名称一致性：** de-ai.md 引用的节名「§0 / §1–§5 / §7」与 Task 1 落定的节标题一致；引用脚本 `style_profile.py`、`ai_slop_checker.py` 与仓库现有文件名一致；SKILL.md 索引路径 `workflows/de-ai.md` 与 Task 2 创建路径一致。✅
