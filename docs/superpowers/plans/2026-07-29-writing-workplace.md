# 职场实用写作·快道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 writing 技能补一条职场实用写作独立轻量工作流，覆盖对内汇报 / 沟通协作 / 对外正式三簇，含 6 张骨架卡 + 得体度自检表 + UI 预设。

**Architecture:** 独立快道工作流（与 `de-ai` / `optimize-existing` 同级），不走主管线九步、不建 spec_lock、不逐节重读。5 项一次性确认 → 锁 1 张骨架卡直接写 → 过「职场失礼自检表」+ 复用 `ai_slop_checker.py` 去 AI 味。6 张骨架卡放 `references/workplace/`（受 `validate_library.py` 校验），得体度自检表作为根级标准文件放 `references/workplace-standards.md`。

**Tech Stack:** Markdown 内容库 + Python（`validate_library.py`，pytest）+ 一处 TSX（ScenarioRail 预设）。包管理 bun，Python 走技能自带 venv。

## Global Constraints

- **Python 环境**：任何 `python3 scripts/*.py` 必须先 `source skills/writing/bin/ensure-python.sh` 拿到 `$WRITING_PY`，用 `$WRITING_PY` 代替裸 `python3`（裸 python3 依赖不在）。
- **资源库纪律**：每个库目录必须有 `_index.md`，且索引必须列全同级文件（漏登记 → 永不被选中，静默失效）。`references/workplace/` 只放**同质的 6 张骨架卡**，结构不同的自检表**不许**放进去。
- **骨架卡固定三章节**：`骨架` / `反套路要点` / `范例`（一字不差，`validate_library.py` 逐字校验章节标题）。
- **正文标点**：中文正文用全角标点，代码 / 路径 / 命令内用半角。
- **快道铁律**：不建 spec_lock、不走八项 BLOCKING、不逐节重读；短文直出、长稿可选落盘。
- **TSX 交互元素**：ScenarioRail 在 rail/根 layout 层，交互元素用 shadcn 原语（本任务只改数据数组，不新增裸元素）。
- **验收命令**：`$WRITING_PY skills/writing/scripts/validate_library.py`（内容库）；`$WRITING_PY -m pytest skills/writing/tests/test_validate_library.py -v`（脚本）；`bun run typecheck`（TSX）。

---

### Task 1: validate_library.py 支持 workplace 组

让校验脚本认识新的 `references/workplace/` 库，否则 6 张卡漏登记进 `_index.md` 也零报错——这条防线正是要防这种静默失效。脚本 `validate()` 只遍历 `REQUIRED_SECTIONS` 的键，所以「加一个键」= 「让脚本开始扫这个目录」。

**Files:**
- Modify: `skills/writing/scripts/validate_library.py:23-30`（`REQUIRED_SECTIONS` 字典）
- Test: `skills/writing/tests/test_validate_library.py`（追加 workplace 用例）

**Interfaces:**
- Consumes: `vl.REQUIRED_SECTIONS`（dict[str, list[str]]）、`vl.validate(skill_dir: Path) -> list[str]`（已存在，不改签名）
- Produces: `REQUIRED_SECTIONS["workplace"] == ["骨架", "反套路要点", "范例"]`，供 Task 2 的骨架卡对齐章节名

- [ ] **Step 1: 写失败测试**

在 `skills/writing/tests/test_validate_library.py` 末尾追加（`_make_workplace_lib` 仿照文件里已有的 `_make_lib`，但建在 `references/workplace/` 下、用 workplace 的章节）：

```python
def _make_workplace_lib(tmp_path, *, index_lists_all=True, with_required_sections=True):
    refs = tmp_path / "references" / "workplace"
    refs.mkdir(parents=True)
    body = ""
    if with_required_sections:
        body = "\n".join(f"## {s}" for s in vl.REQUIRED_SECTIONS["workplace"])
    (refs / "hui-bao.md").write_text(f"# 汇报骨架\n{body}\n", encoding="utf-8")
    (refs / "dao-qian.md").write_text(f"# 道歉骨架\n{body}\n", encoding="utf-8")
    listed = ["hui-bao.md"]
    if index_lists_all:
        listed.append("dao-qian.md")
    index = "# 职场骨架卡索引\n" + "\n".join(f"- [{n}](./{n})" for n in listed)
    (refs / "_index.md").write_text(index, encoding="utf-8")
    return tmp_path


def test_workplace_group_validated_when_complete(tmp_path):
    # workplace 组结构完整（索引列全 + 章节齐）应零问题
    assert vl.validate(_make_workplace_lib(tmp_path)) == []


def test_workplace_index_missing_sibling_reported(tmp_path):
    # 漏登记进 _index.md 的骨架卡必须被揪出（改动前脚本根本不扫 workplace，报不出来）
    problems = vl.validate(_make_workplace_lib(tmp_path, index_lists_all=False))
    assert any("dao-qian.md" in p and "索引" in p for p in problems)


def test_workplace_missing_required_section_reported(tmp_path):
    problems = vl.validate(_make_workplace_lib(tmp_path, with_required_sections=False))
    assert any("缺少章节" in p for p in problems)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `source skills/writing/bin/ensure-python.sh && $WRITING_PY -m pytest skills/writing/tests/test_validate_library.py::test_workplace_index_missing_sibling_reported -v`
Expected: FAIL（`KeyError: 'workplace'` 出现在 `_make_workplace_lib` 里 `vl.REQUIRED_SECTIONS["workplace"]`；即便绕过，validate 也不扫 workplace、报不出漏登记）

- [ ] **Step 3: 加 workplace 组**

在 `skills/writing/scripts/validate_library.py` 的 `REQUIRED_SECTIONS` 字典里，`genres` 那条之后新增一行：

```python
    # 职场骨架卡：结构比创作体裁简单，三章节固定。
    # 得体度自检表不是骨架卡、结构不同，刻意放 references/ 根目录（workplace-standards.md），
    # 不进本组——否则会被当骨架卡误判缺章节。
    "workplace": ["骨架", "反套路要点", "范例"],
```

- [ ] **Step 4: 跑测试确认通过**

Run: `$WRITING_PY -m pytest skills/writing/tests/test_validate_library.py -v`
Expected: PASS（新增 3 条 + 原有 5 条全绿）

- [ ] **Step 5: 提交**

```bash
git add skills/writing/scripts/validate_library.py skills/writing/tests/test_validate_library.py
git commit -m "feat(writing): validate_library 支持 workplace 骨架卡组"
```

---

### Task 2: 6 张骨架卡 + 索引

写 `references/workplace/` 下的 6 张骨架卡与索引。每张卡固定三章节 `## 骨架` / `## 反套路要点` / `## 范例`，内容参照现成 `references/structures/copy/pas.md` 的写法密度（分段表格 + 具体到场景的要点 + 一个极简范例），但更短（职场文短）。验收闸 = Task 1 的 `validate_library.py` 通过。

**Files:**
- Create: `skills/writing/references/workplace/_index.md`
- Create: `skills/writing/references/workplace/hui-bao.md`
- Create: `skills/writing/references/workplace/hui-gu.md`
- Create: `skills/writing/references/workplace/shi-wu-you-jian.md`
- Create: `skills/writing/references/workplace/dao-qian.md`
- Create: `skills/writing/references/workplace/dui-wai-zheng-shi.md`
- Create: `skills/writing/references/workplace/yan-jiang.md`

**Interfaces:**
- Consumes: `REQUIRED_SECTIONS["workplace"]`（Task 1）= 每张卡必含 `## 骨架` `## 反套路要点` `## 范例`
- Produces: 6 个文件名 + `_index.md`，被 `workflows/workplace-writing.md`（Task 4）按「读索引锁一张」引用

每张卡的内容脑（`骨架` = 分段职责表；`反套路要点` = 下表「核心要点」展开成该文体特有坏味道 + 怎么避；`范例` = 一个 30–80 字的极简示例段）：

| 文件 | 骨架卡 | 吃下文体 | 核心要点（写进「反套路要点」） |
|---|---|---|---|
| `hui-bao.md` | 汇报骨架 | 周报 / 月报 / 项目汇报 | 结论先行（结论→数据→过程→下一步）；价值密度优先——讲成果和影响，不堆工时和过程流水账；风险 / 求助要明说不遮掩 |
| `hui-gu.md` | 回顾骨架 | 述职 / 复盘 / 年终总结 | STAR（情境-任务-行动-结果）+ 量化成果；反思要诚实（不自我批斗也不甩锅）；展望落到具体可查的下一步 |
| `shi-wu-you-jian.md` | 事务邮件骨架 | 请假 / 申请 / 催办 / 一般对内外邮件 | 一句话诉求 → 必要背景 → 明确下一步 / deadline；核心诉求放第一屏别埋第三段；主题行要能一眼看懂 |
| `dao-qian.md` | 道歉骨架 | 致歉信 / 事故说明 | 先担责不甩锅 → 说清影响 → 补救措施 → 防复发；绝不「由于不可抗力 / 由于客观原因」开头；不空喊「深表歉意」而无具体行动 |
| `dui-wai-zheng-shi.md` | 对外正式骨架 | 公告 / 通知 / 致辞 | 庄重得体但不套话空转；信息要素齐（何事 / 何时 / 何影响 / 何行动）；避免「在……正确领导下」这类空转 |
| `yan-jiang.md` | 演讲发言稿骨架 | 演讲 / 发言 / 分享开场 | 口语化（区别于书面）；开场有钩子；照顾听觉节奏（短句、重复、留停顿点）；一次只讲一个核心信息 |

`_index.md` 仿 `references/structures/copy/_index.md`：开头一句说明「这是从零写职场文时锁的骨架卡组」，一张「6 张一句话对照」表（每行 `[标题](./文件名.md)` + 一句定位 + 触发信号如「周报 / 汇报 → hui-bao」），末尾一句「读锁定那一份、禁止 glob 整个目录」。**索引必须列全 6 个文件名**（漏一个静默失效）。

- [ ] **Step 1: 写 6 张骨架卡**

逐个创建上表 6 个文件。每个文件严格三个 `##` 章节：`## 骨架`（分段职责表，仿 pas.md 的段-占比-职责表，但职场文按「段-任务」即可，不必强套占比）、`## 反套路要点`（把上表「核心要点」逐条展开，每条给「坏味道长啥样 + 怎么避」）、`## 范例`（一段极简真实示例，全角标点）。控制在 60–120 行/张，别写成长篇。

- [ ] **Step 2: 写 `_index.md`**

按上述结构写索引，确认 6 个文件名一个不漏地出现在 `[..](./xxx.md)` 链接里。

- [ ] **Step 3: 跑库校验确认通过**

Run: `source skills/writing/bin/ensure-python.sh && $WRITING_PY skills/writing/scripts/validate_library.py`
Expected: `[writing] ✓ 资源库结构完整`（若报「缺少章节」→ 某张卡章节名打错；若报「索引里没有列出」→ `_index.md` 漏登记）

- [ ] **Step 4: 提交**

```bash
git add skills/writing/references/workplace/
git commit -m "feat(writing): 职场写作 6 张骨架卡 + 索引"
```

---

### Task 3: 职场失礼自检表

写 `references/workplace-standards.md`（根目录标准文件，与 `anti-ai-slop.md` / `shared-standards.md` 同级，**不放进 `workplace/`**）。这是本快道的核心质量关——职场版「去 AI 味」，专抓通用 AI 味检测抓不到的「失礼 / 没说到点」。验收 = 人工读，确认 6 类失礼齐全、每类给「怎么判 + 怎么修」。

**Files:**
- Create: `skills/writing/references/workplace-standards.md`

**Interfaces:**
- Produces: `references/workplace-standards.md`，被 `workflows/workplace-writing.md`（Task 4）在质检步 `read_file` 引用

- [ ] **Step 1: 写自检表**

文件含一张失礼自检表，6 类各一节，每节：`失礼长啥样`（症状 + 反面例句）+ `怎么修`。六类：

1. **道歉甩锅** —— 把责任推给客观原因 / 别人 / 系统（反例：「由于不可抗力……」）。修：先认自己那部分责任，再谈客观因素。
2. **汇报堆过程** —— 堆工时和过程流水账、不讲成果和价值。修：每件事后面追一句「所以带来了什么结果 / 影响」。
3. **对上肉麻** —— 过度谦卑（反例：「恳请领导百忙之中」「万分感谢领导栽培」）。修：平实、具体、就事论事。
4. **诉求埋太深** —— 核心诉求 / deadline 埋在结尾。修：提到第一屏 / 首段。
5. **对外套话** —— 空转套话（反例：「在……正确领导下」）。修：删掉空话，只留信息要素。
6. **分寸错位** —— 语气配不上确认的关系（对上过冲 / 对下端架子 / 对外过随便）。修：对照确认的「关系」重校语气。

开头一句说明它「不是骨架卡，是产出后逐条过的质检清单」；末尾提示「配合 `ai_slop_checker.py` 一起用（自检表管失礼、脚本管 AI 腔）」。

- [ ] **Step 2: 跑库校验确认没误伤**

Run: `$WRITING_PY skills/writing/scripts/validate_library.py`
Expected: 仍 `✓ 资源库结构完整`（本文件在 `references/` 根、不在任何被扫库目录下，不应引入新问题）

- [ ] **Step 3: 提交**

```bash
git add skills/writing/references/workplace-standards.md
git commit -m "feat(writing): 职场失礼自检表 workplace-standards"
```

---

### Task 4: workplace-writing 快道工作流

写 `workflows/workplace-writing.md`——快道主体。仿 `workflows/de-ai.md` 的形态（YAML frontmatter `description` + 铁律 + 分 Step + 完成检查点），但流程是「5 项确认 → 锁骨架卡 → 写 → 得体度检查 → 交付」。验收 = 人工读，确认五要素齐（分流 / 5 项确认 / 骨架卡路由 / 得体度+去AI味 / 落盘策略）。

**Files:**
- Create: `skills/writing/workflows/workplace-writing.md`

**Interfaces:**
- Consumes: `references/workplace/_index.md` + 6 卡（Task 2）、`references/workplace-standards.md`（Task 3）、`scripts/ai_slop_checker.py`（现成）、`scripts/project_manager.py`（现成，长稿落盘用）
- Produces: `workflows/workplace-writing.md`，被 SKILL.md（Task 5）登记为第 10 条工作流

- [ ] **Step 1: 写工作流文件**

结构：
- **YAML frontmatter** `description`：一句话说清「从零写职场文（周报/邮件/道歉/述职/公告/发言稿）的轻量快道，不走主管线八项确认与 spec_lock」+ 触发语。
- **和别的工作流分界**（仿 de-ai 的「别混」块）：已有稿要改 / 体检 → optimize-existing；换说法 / 换体裁 → rewrite；纯去 AI 味 → de-ai；**从零写职场文 → 本工作流**。
- **统摄铁律**：① 分寸靠确认不靠脑补（关系②、红线⑤缺了必须追问）；② 不建 spec_lock、不走八项 BLOCKING、不逐节重读（快道）；③ 不捏造用户没给的事实 / 数据 / 日期。
- **Step 0 · 接收 + 判长短**：判断短文（直出）还是长稿（可选落盘）。
- **Step 1 · 5 项一次性确认**：文体 / 写给谁+关系 / 要达成什么 / 关键事实 / 语气+红线。用户一次性给全就直接开写，缺关键项（尤其关系、红线）才追问。**这不是 ⛔ BLOCKING 硬门**，但信息不全不许脑补开写。
- **Step 2 · 锁骨架卡**：`read_file references/workplace/_index.md` → 按文体锁 1 张 → 只读那一份（禁止 glob）。
- **Step 3 · 写**：套骨架卡直接写，一次成稿（短文无需分节循环）。长稿可分段但仍不建 spec_lock。
- **Step 4 · 得体度检查**：`read_file references/workplace-standards.md` 逐条过 6 类失礼；再（可选，仅中文）`$WRITING_PY scripts/ai_slop_checker.py <稿.md>` 去 AI 味。
- **Step 5 · 交付**：对话内给全文 + 一句「改 / 注意了哪些得体点」；长稿落盘则报完整路径。
- **✅ 完成检查点**：勾选清单（5 项确认到位、锁对骨架卡、过了 6 类失礼自检、没捏造、没套主管线重机器）。

参照 `workflows/de-ai.md` 的口吻与 `$WRITING_PY` 用法。控制在 ~100 行。

- [ ] **Step 2: 自查引用路径真实**

Run: `ls skills/writing/references/workplace/_index.md skills/writing/references/workplace-standards.md skills/writing/scripts/ai_slop_checker.py`
Expected: 三个路径都存在（工作流里 `read_file` / 脚本调用引用的都是真文件）

- [ ] **Step 3: 提交**

```bash
git add skills/writing/workflows/workplace-writing.md
git commit -m "feat(writing): 职场写作快道工作流 workplace-writing"
```

---

### Task 5: SKILL.md 登记

把新工作流接进 SKILL.md：`description` 补触发语、独立工作流索引加第 10 条、资源库索引提及 workplace 组。不登记的话模型不知道有这条快道，等于白做。

**Files:**
- Modify: `skills/writing/SKILL.md:8`（description 触发语）
- Modify: `skills/writing/SKILL.md:100-112`（独立工作流索引表）
- Modify: `skills/writing/SKILL.md`（资源库索引段，约 68-79 行）

**Interfaces:**
- Consumes: `workflows/workplace-writing.md`（Task 4）、`references/workplace/`（Task 2）、`references/workplace-standards.md`（Task 3）

- [ ] **Step 1: description 补触发语**

`SKILL.md:8` 现为：
```
  写文案 / 写小说 / 写文章 / 写公众号 / 改写 / 润色 / 去 AI 味 / 去AI化 / humanize / 优化已有作品 / 作品体检, or mentions "writing".
```
在 `作品体检` 后、`, or mentions` 前插入职场触发语，改为：
```
  写文案 / 写小说 / 写文章 / 写公众号 / 改写 / 润色 / 去 AI 味 / 去AI化 / humanize / 优化已有作品 / 作品体检 / 写周报 / 写述职 / 写邮件 / 写道歉信 / 写发言稿 / 给领导汇报 / 职场写作, or mentions "writing".
```

- [ ] **Step 2: 独立工作流索引加第 10 条**

在 `SKILL.md` 独立工作流索引表（`批量起标题` 那行 `112` 之后）追加一行：
```
| 职场写作 | `workflows/workplace-writing.md` | 用户要从零写职场实用文（周报 / 述职 / 复盘 / 邮件 / 请假 / 道歉 / 通知 / 公告 / 发言稿 / 给领导汇报）；轻量快道，5 项确认→套骨架卡→得体度自检，不走主管线八项与 spec_lock |
```
同时把该段标题「独立工作流索引（前向引用 …）」里若有「九条」类计数，改成「十条」（检查 `SKILL.md` 是否有工作流条数字样，有则同步）。

- [ ] **Step 3: 资源库索引提及 workplace**

在 SKILL.md「资源库索引」表（约 72-76 行三行库表）下方，补一句说明：职场写作另有独立骨架卡组 `references/workplace/`（6 张，由 `workplace-writing.md` 工作流锁用）与根级标准 `references/workplace-standards.md`（职场失礼自检表），不走三体裁的文风/结构/体裁三把锁。

- [ ] **Step 4: 校验 + 自查**

Run: `$WRITING_PY skills/writing/scripts/validate_library.py && grep -c "workplace-writing" skills/writing/SKILL.md`
Expected: 库校验 `✓`；grep 计数 ≥1（工作流已登记）

- [ ] **Step 5: 提交**

```bash
git add skills/writing/SKILL.md
git commit -m "docs(writing): SKILL.md 登记职场写作快道 + 触发语"
```

---

### Task 6: ScenarioRail 加职场预设

在写作技能推荐区加 1 条职场预设 prompt，和现有 7 条并列。归到「从零写」创作类那批（放「干货 / 观点长文」之后、「改写 / 换个说法」之前，让从零创作的聚一起、inline 贴文的聚一起）。

**Files:**
- Modify: `apps/studio/src/chat/components/chat/ThreadView/ScenarioRail.tsx:226`（`PROMPTS_BY_SKILL.writing` 数组，`干货 / 观点长文` 项之后）

**Interfaces:**
- Consumes: 无（纯静态预设数据）；触发后由 SKILL.md（Task 5）的触发语路由到 workplace-writing 工作流

- [ ] **Step 1: 插入预设项**

在 `ScenarioRail.tsx` 的 `干货 / 观点长文` 对象（`225` 行结束的 `}` 与 `226` 行 `,` 之后、`改写 / 换个说法` 的注释块之前）插入：

```tsx
    {
      // 职场实用写作走 workflows/workplace-writing.md：轻量快道，从零写周报 /
      // 邮件 / 道歉 / 发言稿等。与三体裁创作同为「从零写」，故紧邻创作类之后、
      // inline 贴文类（改写 / 去 AI 味）之前。细分文体不露按钮，由工作流追问。
      label: '职场文档',
      text: '帮我写一份职场文档，类型是【周报/述职/邮件/道歉信/通知/发言稿】，写给【谁·什么关系】，要达成【一句话目的】，关键信息是【必须写进去的事实】。'
    },
```

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: PASS（无类型错误；本改动只是给字符串数组加一个同构对象）

- [ ] **Step 3: 提交**

```bash
git add apps/studio/src/chat/components/chat/ThreadView/ScenarioRail.tsx
git commit -m "feat(studio): 写作推荐区新增「职场文档」预设"
```

---

### Task 7（可选增强）: anti-ai-slop 补职场破绽词

给 `references/anti-ai-slop.md` 补一小节「职场专属破绽词」，让通用去 AI 味检测也能带到职场语料（黑话 + 谦卑肉麻词）。**此任务可选**，前 6 个任务已能让功能跑通；做与不做不阻塞交付。

**Files:**
- Modify: `skills/writing/references/anti-ai-slop.md`（末尾追加一节）

- [ ] **Step 1: 追加小节**

在 `anti-ai-slop.md` 末尾加一节「§X 职场专属破绽」，列两组：① 职场黑话（赋能 / 抓手 / 闭环 / 对齐 / 颗粒度 / 抓手 / 打法…，附「怎么说人话」替换）；② 谦卑肉麻套话（恳请领导百忙之中 / 万分感谢领导栽培 / 在……正确领导下…）。注明这节供 `workplace-writing.md` 质检时参考。

- [ ] **Step 2: 校验没破坏结构**

Run: `$WRITING_PY skills/writing/scripts/validate_library.py`
Expected: `✓`（anti-ai-slop.md 是根级文件，追加内容不应引入库问题）

- [ ] **Step 3: 提交**

```bash
git add skills/writing/references/anti-ai-slop.md
git commit -m "feat(writing): anti-ai-slop 补职场专属破绽词"
```

---

## Self-Review

**Spec coverage（对照设计文档九节）：**
- §一 触发与路由 → Task 4（工作流分界）+ Task 5（SKILL 触发语/索引）✓
- §二 5 项确认 → Task 4 Step 1 ✓
- §三 6 张骨架卡 → Task 2 ✓
- §四 得体度检查 + 自检表位置 → Task 3（自检表根级）+ Task 4 Step 4（质检步引用）✓
- §五 项目目录策略（短文直出/长稿落盘）→ Task 4 Step 0 ✓
- §六 UI 入口 → Task 6 ✓
- §七 交付物清单 → Task 1–7 逐项覆盖（validate_library + test → Task 1；workplace-standards → Task 3；SKILL → Task 5；ScenarioRail → Task 6；anti-ai-slop 可选 → Task 7）✓
- §八 范围边界（不做求职/新脚本/评分团）→ 计划未引入这些，一致 ✓
- §九 验证（先加 workplace 组再跑校验；三簇手测；typecheck）→ Task 1 先行、Task 6 typecheck ✓；三簇手测建议在全部任务后由执行者补一次冒烟（见下）

**收尾冒烟（全部任务后，非强制单列任务）：** 手测三簇各一例——让技能写①周报②道歉邮件③发言稿开场，确认 5 项确认问得对、骨架卡锁得准、故意喂一版甩锅道歉能被 workplace-standards 揪出。

**Placeholder 扫描：** 无 TODO/TBD；代码步给了实际 test 与 diff；内容步给了明确 content brief（章节 + 要点表 + 篇幅约束），非「implement later」。

**Type/命名一致性：** `REQUIRED_SECTIONS["workplace"] = ["骨架","反套路要点","范例"]` 在 Task 1 定义、Task 2 six 卡与 `_make_workplace_lib` 测试三处一致；6 个文件名（hui-bao/hui-gu/shi-wu-you-jian/dao-qian/dui-wai-zheng-shi/yan-jiang）在 Task 2 表、Task 4 路由、Task 5 索引一致；`workplace-standards.md` 路径在 Task 3/4/自检表位置一致。
