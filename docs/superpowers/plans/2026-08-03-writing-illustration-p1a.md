# 写作插图能力 P1a（技能侧）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `skills/writing/` 在策划阶段规划配图、写作阶段留出图指令、导出阶段带上图，且不依赖桌面应用——纯命令行跑也能独立交付。

**Architecture:** 改动全部落在 `skills/writing/` 内，分三类：**脚本层**（`writing_utils.py` 剥图片语法、`project_manager.py` 加 `images/`、`update_spec.py` 登记新段、`export.py` 认图 + 图片就位闸）、**契约层**（`spec_lock_reference.md` 加 `## 配图` 段）、**文档层**（新增 `references/illustrator.md` 配图手册、`SKILL.md` 八项确认扩为九项）。脚本层全部 TDD，文档层靠人工核对。

**Tech Stack:** Python 3（标准库 + `python-docx`）、pytest、Markdown。

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-08-03-writing-illustration-design.md`。有冲突以 spec 为准。
- **Python 必须跑在技能自己的 venv 里**：每个会话先 `source skills/writing/bin/ensure-python.sh`，随后用 `$WRITING_PY` 代替 `python3`。不许回退到裸 `python3`（依赖不在那儿）。
- 测试跑法：`cd skills/writing && $WRITING_PY -m pytest tests/ -v`。
- **中文正文用全角标点，代码 / 路径 / 命令内用半角。**
- 注释写「为什么这样而不是那样」，不只写做了什么——这是本仓库既有风格，见 `writing_utils.split_data_line` 等函数的注释。
- 图片在正文里一律是**相对路径** `../images/<文件名>`（`drafts/` 与 `images/` 是兄弟目录）。
- 两类图：氛围图 = AI 生图，信息图 = mermaid 围栏块。本期不产图，只铺路。
- 已知既存事实，不要"顺手修"：`writing_utils.strip_markdown` **已经**剥围栏代码块，故 mermaid 本来就不进质检统计；`update_spec.set_field` 对未登记的段**已经**能写入，登记 `IMPACT_MAP` 只是为了补「影响范围」提示。

---

### Task 1: 质检统计剥掉图片语法

**Files:**
- Modify: `skills/writing/scripts/writing_utils.py:70-94`（`strip_markdown`）
- Test: `skills/writing/tests/test_writing_utils.py`

**Interfaces:**
- Consumes: 无（本任务是起点）
- Produces: `strip_markdown(text: str) -> str` 行为扩展——输出中不再含 `![...](...)`。`ai_slop_checker.py:92` 与 `readability_check.py:53` 已调用它，自动受益，**两个 checker 一行都不用改**。

- [ ] **Step 1: 写失败的测试**

追加到 `skills/writing/tests/test_writing_utils.py` 末尾：

```python
def test_strip_markdown_removes_image_syntax():
    """图片行必须整行剥掉：图说是极短行，留着会被当成一个超短段落，
    污染 readability 的段落长度分布与 ai_slop 的结构均匀度。"""
    text = "正文第一段。\n\n![深夜便利店的窗](../images/gen-1.png)\n\n正文第二段。"
    body = wu.strip_markdown(text)
    assert "gen-1.png" not in body
    assert "深夜便利店的窗" not in body
    assert wu.split_paragraphs(body) == ["正文第一段。", "正文第二段。"]


def test_strip_markdown_keeps_normal_links():
    """普通链接 [文字](url) 不是图片，正文里的字要留下——
    图片语法有前导 !，两者只差一个字符，正则写松了会连链接文字一起吃掉。"""
    body = wu.strip_markdown("详见[这篇报告](https://example.com/a)的第三节。")
    assert "这篇报告" in body


def test_strip_markdown_removes_inline_image_keeps_sentence():
    """图夹在句子中间（罕见）：只剥图，句子其余部分照常统计。"""
    body = wu.strip_markdown("如下图![流程](../images/a.png)所示的三步。")
    assert "a.png" not in body
    assert "如下图所示的三步。" in body
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/test_writing_utils.py -k image -v`
Expected: 3 个用例 FAIL（`gen-1.png` 仍在输出里）。

- [ ] **Step 3: 实现**

在 `skills/writing/scripts/writing_utils.py` 的 `_FENCE` 定义下方（第 21 行附近）加常量：

```python
# 图片语法。前导 ! 是与普通链接 [文字](url) 的唯一区别，不能省——
# 省了会把正文里的链接文字也一起吃掉。alt 允许为空（![](x.png)）。
# 路径部分用 [^)]* 而非 \S+：markdown 允许 `![图](路径 "标题")` 带标题后缀。
_IMAGE_SYNTAX = re.compile(r"!\[[^\]]*\]\([^)]*\)")
```

在 `strip_markdown` 里，把第 91-93 行那段改成：

```python
        if stripped.startswith(">"):
            stripped = stripped.lstrip("> ").strip()
        # 剥图片语法：图说（alt）不是正文，是配图说明；路径更不是。
        # 剥完若整行变空，交给下游 split_paragraphs 丢掉即可（它本来就跳空行），
        # 这里不显式 continue —— 少一条分支，也保住 char_count 的现有行为。
        stripped = _IMAGE_SYNTAX.sub("", stripped).strip()
        out.append(stripped)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/ -v`
Expected: 全部 PASS（含既有用例——本改动不能让 `test_ai_slop_checker.py` / `test_readability_check.py` 变红）。

- [ ] **Step 5: 提交**

```bash
git add skills/writing/scripts/writing_utils.py skills/writing/tests/test_writing_utils.py
git commit -m "fix(writing): 质检统计剥掉图片语法，图说不再被当超短段落"
```

---

### Task 2: 项目目录新增 images/

**Files:**
- Modify: `skills/writing/scripts/project_manager.py:24-30`（`SUBDIRS`）、`:46-59`（README 模板）、`:63-73`（`validate_project`）
- Test: `skills/writing/tests/test_project_manager.py`

**Interfaces:**
- Consumes: 无
- Produces: `SUBDIRS`（init 时创建的目录元组，新增 `"images"`）与新常量 `REQUIRED_SUBDIRS`（validate 时必需的目录元组，**不含** `images`）。后续任务里 `<项目>/images/` 是配图的落点。

- [ ] **Step 1: 写失败的测试**

追加到 `skills/writing/tests/test_project_manager.py` 末尾：

```python
def test_init_creates_images_dir(tmp_path):
    """配图要有地方放。images/ 与 drafts/ 是兄弟目录，
    正文里因此写相对路径 ../images/xxx.png。"""
    proj = pm.init_project("配图测试", tmp_path, "20260803")
    assert (proj / "images").is_dir()


def test_validate_tolerates_missing_images_dir(tmp_path):
    """images/ 是 2026-08-03 才加的。此前建的项目没有这个目录，
    若把它列进必需项，所有老项目会突然被判「结构不完整」——
    这是纯粹的向后兼容伤害，没有任何收益。"""
    proj = pm.init_project("老项目", tmp_path, "20260803")
    (proj / "spec_lock.md").write_text("## 体裁\n- genre: article\n", encoding="utf-8")
    (proj / "images").rmdir()
    assert pm.validate_project(proj) == []
```

> 该测试文件顶部已有 `import project_manager as pm` 与 `sys.path` 注入，沿用即可。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/test_project_manager.py -k images -v`
Expected: `test_init_creates_images_dir` FAIL（目录不存在）。

- [ ] **Step 3: 实现**

`skills/writing/scripts/project_manager.py` 第 24-30 行整段替换为：

```python
# 项目内的固定子目录。每个都有明确归属，不允许写串：
#   sources/  用户给的原始素材 + 转好的 Markdown
#   analysis/ 机器提取的事实（素材摘要、文风分析、AI 味基线分）
#   drafts/   初稿分节，一节一个文件
#   images/   配图（AI 生成 / 用户提供）。与 drafts/ 平级，
#             所以正文里的相对路径恒为 ../images/<文件名>
#   reviews/  质检报告
#   output/   定稿与各平台导出
SUBDIRS = ("sources", "analysis", "drafts", "images", "reviews", "output")

# validate 的必需集刻意**不含 images**：它是 2026-08-03 才加的目录，
# 此前建的项目都没有。把新目录列进必需项，会让所有老项目一夜之间被判
# 「结构不完整」——纯粹的向后兼容伤害，零收益。新项目照常会建出来。
REQUIRED_SUBDIRS = ("sources", "analysis", "drafts", "reviews", "output")
```

README 模板（第 51-55 行）在 `drafts/` 那行之后插入一行：

```python
            "- `images/` 配图（正文里以 ../images/ 相对路径引用）\n"
```

`validate_project` 第 68 行的循环改成遍历 `REQUIRED_SUBDIRS`：

```python
    for sub in REQUIRED_SUBDIRS:
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/test_project_manager.py -v`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add skills/writing/scripts/project_manager.py skills/writing/tests/test_project_manager.py
git commit -m "feat(writing): 项目新增 images/ 子目录，validate 对老项目保持兼容"
```

---

### Task 3: 契约新增「配图」段（骨架 + 影响提示）

**Files:**
- Modify: `skills/writing/scripts/update_spec.py:24-34`（`IMPACT_MAP`）
- Modify: `skills/writing/templates/spec_lock_reference.md:7`（段名清单从 8 改 9）、文件末尾（新增 `## 配图` 段）
- Test: `skills/writing/tests/test_update_spec.py`

**Interfaces:**
- Consumes: 无
- Produces: 契约新段 `## 配图`，三个字段 `image_plan` / `image_count` / `image_style`。后续任务（Task 6 手册、Task 7 SKILL.md）按这三个字段名书写，**一个字都不能改**——`wu.parse_spec_lock` 按 `- key: value` 读它们。

- [ ] **Step 1: 写失败的测试**

追加到 `skills/writing/tests/test_update_spec.py` 末尾：

```python
def test_impact_map_covers_illustration_section():
    """未登记的段改完不会打印「影响范围」，用户拿不到「哪些已写章节要回改」
    的提醒。配图方案改了，已写章节里的出图指令块就得复核，必须有这条提示。"""
    assert "配图" in us.IMPACT_MAP
    assert "配图" in us.IMPACT_MAP["配图"]


def test_set_field_writes_illustration_fields(tmp_path):
    """三个字段名是后续手册与 SKILL.md 共同依赖的契约，
    这条用例把它们钉死，改名会当场变红。"""
    spec = tmp_path / "spec_lock.md"
    spec.write_text("## 体裁\n- genre: article\n", encoding="utf-8")
    us.set_field(spec, "配图", "image_plan", "inline")
    us.set_field(spec, "配图", "image_count", "3")
    us.set_field(spec, "配图", "image_style", "极简线条插画")
    parsed = wu.parse_spec_lock(spec)
    assert parsed["配图"] == {
        "image_plan": "inline",
        "image_count": "3",
        "image_style": "极简线条插画",
    }
```

> 该文件顶部已有 `import update_spec as us`；若尚未 import `writing_utils as wu`，在同处补上 `import writing_utils as wu`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/test_update_spec.py -k illustration -v`
Expected: `test_impact_map_covers_illustration_section` FAIL（KeyError / assert 失败）。

- [ ] **Step 3: 实现**

`skills/writing/scripts/update_spec.py` 的 `IMPACT_MAP` 末尾（第 33 行 `平台格式` 那条之后）加一条：

```python
    "配图": "配图方案变更影响已写章节里的出图指令块，需复核受影响章节的配图位",
```

`skills/writing/templates/spec_lock_reference.md` 第 7 行改为（**8 → 9，并把新段名加进清单**）：

```markdown
> **段名固定**（`scripts/update_spec.py` 的 `IMPACT_MAP` 认这 9 个段头，逐字对齐）：`体裁` / `目标` / `文风锁定` / `结构` / `人物档案` / `伏笔表` / `禁用清单` / `平台格式` / `配图`。段名写错，改契约脚本会当成新段追加、连贯性检查读不到该段。
```

文件末尾（第 81 行之后）追加整段：

```markdown

## 配图
- image_plan: inline
- image_count: 3
- image_style: 极简线条插画，低饱和暖色，无文字

> `image_plan` 三选一：`none`（不配图）| `cover-only`（只配封面）| `inline`（封面 + 正文内配图）。**`none` 时本段其余两行可省**，写手不会留任何出图指令。
> `image_count` 整数，本篇配图张数**上限**。生图是要花钱的，这是第一道闸（第二道在桌面端的自动触发上限）。含封面图在内一起算。
> `image_style` 生图风格，自由文本，写到「出图模型照着能画」的程度（画法、色调、有无文字）。它是**创作性字段**，策划必须给 ≥3 个候选、每个带一句「选它是什么效果」，由用户拍板——同 `voice` / `structure` 的硬规则。`image_plan: none` 时留空。
> **只管氛围图，不管信息图**：流程/对比/结构类的信息图走 ```mermaid 围栏块，是正文的一部分，不消耗 `image_count`、也不受 `image_style` 约束（它没有画风可言）。判据见 `references/illustrator.md`。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/ -v`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add skills/writing/scripts/update_spec.py skills/writing/templates/spec_lock_reference.md skills/writing/tests/test_update_spec.py
git commit -m "feat(writing): 写作契约新增「配图」段与影响提示"
```

---

### Task 4: 导出前的图片就位闸

**Files:**
- Modify: `skills/writing/scripts/export.py`（新增图片解析与检查，`main` 里加闸）
- Test: `skills/writing/tests/test_export.py`

**Interfaces:**
- Consumes: Task 2 的 `<项目>/images/` 约定
- Produces:
  - `ImageRef` dataclass —— 字段 `caption: str`、`src: str`、`line: int`
  - `parse_images(markdown: str) -> list[ImageRef]`
  - `resolve_image_path(src: str, md_path: Path) -> Path`
  - `missing_images(markdown: str, md_path: Path) -> list[ImageRef]`
  - Task 5、Task 6 都复用 `parse_images` / `resolve_image_path`，**不要各写一份正则**。

- [ ] **Step 1: 写失败的测试**

追加到 `skills/writing/tests/test_export.py` 末尾：

```python
def test_parse_images_extracts_caption_src_and_line():
    md = "开头。\n\n![深夜的便利店](../images/gen-1.png)\n\n结尾。"
    refs = export.parse_images(md)
    assert len(refs) == 1
    assert refs[0].caption == "深夜的便利店"
    assert refs[0].src == "../images/gen-1.png"
    assert refs[0].line == 3


def test_parse_images_ignores_normal_links():
    assert export.parse_images("详见[报告](https://example.com/a)。") == []


def test_parse_images_skips_fenced_blocks():
    """mermaid / 代码块里出现的图片语法是示例文本，不是真配图。
    当成真配图会导致导出闸报「缺图」，卡住一次本该成功的导出。"""
    md = "正文。\n\n```markdown\n![示例](../images/nope.png)\n```\n"
    assert export.parse_images(md) == []


def test_resolve_image_path_is_relative_to_markdown_file(tmp_path):
    """正文在 drafts/、图在 images/，相对路径必须按 md 文件所在目录解析，
    不是按当前工作目录——否则从别处跑导出脚本就全找不到图。"""
    md_path = tmp_path / "drafts" / "01.md"
    resolved = export.resolve_image_path("../images/a.png", md_path)
    assert resolved == tmp_path / "images" / "a.png"


def test_resolve_image_path_passes_absolute_through(tmp_path):
    abs_src = str(tmp_path / "images" / "a.png")
    assert export.resolve_image_path(abs_src, tmp_path / "drafts" / "01.md") == Path(abs_src)


def test_missing_images_reports_only_absent_files(tmp_path):
    (tmp_path / "images").mkdir()
    (tmp_path / "images" / "there.png").write_bytes(b"x")
    (tmp_path / "drafts").mkdir()
    md_path = tmp_path / "drafts" / "01.md"
    md = "![在的](../images/there.png)\n\n![不在的](../images/gone.png)"
    md_path.write_text(md, encoding="utf-8")
    missing = export.missing_images(md, md_path)
    assert [r.src for r in missing] == ["../images/gone.png"]


def test_main_blocks_export_when_image_missing(tmp_path, capsys):
    """缺图必须停下报清单，而不是导出一份引用损坏的稿。
    下游（公众号编辑器 / Word）不会在这一层报错，带着缺口跑完
    只会产出一份看着成功、打开全是碎图的成品。"""
    (tmp_path / "drafts").mkdir()
    md_path = tmp_path / "drafts" / "01.md"
    md_path.write_text("正文。\n\n![缺的](../images/gone.png)\n", encoding="utf-8")
    code = export.main([str(md_path), "--format", "plain", "--out", str(tmp_path / "o.txt")])
    assert code == 1
    assert "gone.png" in capsys.readouterr().out
    assert not (tmp_path / "o.txt").exists()
```

> 该文件顶部已有 `import export` 与 `sys.path` 注入——**沿用 `export.` 前缀，不要新加 `import export as ex` 别名**（同一模块两个调用约定并存，评审判为 Important）。若没有 `from pathlib import Path`，补上。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/test_export.py -k "image" -v`
Expected: FAIL，`AttributeError: module 'export' has no attribute 'parse_images'`。

- [ ] **Step 3: 实现**

`skills/writing/scripts/export.py` 顶部 import 区补 `from dataclasses import dataclass`。在正则常量区（第 37 行 `_ITALIC` 之后）加：

```python
# 图片语法。前导 ! 是与普通链接的唯一区别；路径部分排除空白与右括号，
# 后面可选一个 markdown 标题后缀 `"..."`（`![图](路径 "标题")`）。
# 与 writing_utils._IMAGE_SYNTAX 是两份正则、口径刻意不同：那边只需要
# 「整体删掉」，这边要**分组取出** caption 与 src，合并成一份反而两头别扭。
_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")


@dataclass
class ImageRef:
    """正文里的一处配图引用。line 是 1-based 行号——缺图报告要能让人直接跳过去。"""

    caption: str
    src: str
    line: int


def parse_images(markdown: str) -> list[ImageRef]:
    """抽出正文里的全部配图引用。

    **围栏代码块内的图片语法一律跳过**：那是示例文本（mermaid 块、
    教程里贴的 markdown 片段），不是真配图。当成真配图会让导出闸误报
    「缺图」，卡住一次本该成功的导出。
    """
    refs: list[ImageRef] = []
    in_fence = False
    for idx, raw in enumerate(markdown.splitlines(), start=1):
        if raw.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for m in _IMAGE.finditer(raw):
            refs.append(ImageRef(caption=m.group(1).strip(), src=m.group(2), line=idx))
    return refs


def resolve_image_path(src: str, md_path: Path) -> Path:
    """相对路径按**正文文件所在目录**解析，不是按 cwd。

    正文在 `<项目>/drafts/`、图在 `<项目>/images/`，相对路径恒为
    `../images/x.png`。若按 cwd 解析，从项目外任何地方跑导出都会找不到图，
    而且报的错是「文件不存在」而非「路径基准错了」，极难排查。
    """
    p = Path(src)
    return p if p.is_absolute() else (md_path.parent / p).resolve()


def missing_images(markdown: str, md_path: Path) -> list[ImageRef]:
    """返回磁盘上找不到的配图引用，保持正文中的出现顺序。"""
    return [r for r in parse_images(markdown) if not resolve_image_path(r.src, md_path).is_file()]
```

在 `main` 里，读完 markdown、算出 `out_path` **之前**加闸（放在第 165 行 `markdown = src.read_text(...)` 之后）：

```python
    # 图片就位闸：缺图停下报清单，绝不导出一份引用损坏的稿。
    # 下游导出器（公众号编辑器 / python-docx）不在这一层检测缺失，
    # 带着缺口跑完只会产出一份「看着成功、打开全是碎图」的成品。
    # 同源做法见 ppt-master 的 Image readiness GATE。
    missing = missing_images(markdown, src)
    if missing:
        print(f"[writing] ✗ 有 {len(missing)} 张配图找不到文件，导出已中止：")
        for ref in missing:
            print(f"  - 第 {ref.line} 行「{ref.caption or '无图说'}」→ {ref.src}")
        print("[writing] 请先把缺的图放到上述路径，或从正文里删掉这些引用，再重跑导出。")
        return 1
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/test_export.py -v`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add skills/writing/scripts/export.py skills/writing/tests/test_export.py
git commit -m "feat(writing): 导出前加图片就位闸，缺图报清单并中止"
```

---

### Task 5: 三种导出格式认图片

**Files:**
- Modify: `skills/writing/scripts/export.py`（`md_to_wechat_html` / `md_to_plain` / `md_to_docx`）
- Modify: `skills/writing/templates/export_styles/wechat-default.json`、`wechat-serif.json`
- Test: `skills/writing/tests/test_export.py`

**Interfaces:**
- Consumes: Task 4 的 `_IMAGE`、`ImageRef`、`parse_images`、`resolve_image_path`
- Produces: 三个导出函数对图片的渲染行为。`md_to_docx(markdown, out_path)` 签名新增第三个参数 `md_path: Path`（要按正文位置解析相对路径才能嵌图），`main` 里同步改调用。

- [ ] **Step 1: 写失败的测试**

追加到 `skills/writing/tests/test_export.py` 末尾：

```python
def test_wechat_html_renders_image_with_caption():
    """公众号里图和图说是一体的：<img> 后跟一行居中小字图说。
    图说为空时不产出空的说明行（留着是一条视觉上莫名其妙的空隙）。"""
    style = export.load_style("wechat-default")
    html_out = export.md_to_wechat_html("![深夜的便利店](../images/gen-1.png)", style)
    assert 'src="../images/gen-1.png"' in html_out
    assert "深夜的便利店" in html_out
    assert "<p" not in html_out.split("<img")[0]  # 图不该被包成普通段落


def test_wechat_html_image_without_caption_has_no_caption_line():
    style = export.load_style("wechat-default")
    html_out = export.md_to_wechat_html("![](../images/gen-1.png)", style)
    assert "<img" in html_out
    assert "figcaption" not in html_out


def test_wechat_html_escapes_caption():
    """图说来自 AI 生成的文本，可能含 < >，不转义就把 HTML 结构打坏了。"""
    style = export.load_style("wechat-default")
    html_out = export.md_to_wechat_html('![a<b>c](../images/x.png)', style)
    assert "<b>" not in html_out
    assert "&lt;b&gt;" in html_out


def test_plain_export_renders_image_as_caption_marker():
    """纯文本没法放图，退化成一个人能看懂的占位标记，
    而不是把 markdown 语法原样漏给读者。"""
    out = export.md_to_plain("![深夜的便利店](../images/gen-1.png)")
    assert out == "［图：深夜的便利店］"


def test_docx_embeds_existing_image(tmp_path):
    import base64

    from docx import Document

    (tmp_path / "images").mkdir()
    (tmp_path / "drafts").mkdir()
    # 1x1 透明 PNG。用 base64 而不是手打 hex：hex 串抄错一个字符，
    # python-docx 报的是「无法识别的图片格式」，会被误当成实现有 bug。
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    )
    (tmp_path / "images" / "a.png").write_bytes(png)
    md_path = tmp_path / "drafts" / "01.md"
    out = tmp_path / "o.docx"
    export.md_to_docx("正文。\n\n![图说](../images/a.png)\n", out, md_path)
    doc = Document(str(out))
    assert len(doc.inline_shapes) == 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/test_export.py -k "image or docx or plain" -v`
Expected: FAIL（HTML 里图被当普通段落转义成了字面文本；`md_to_docx` 只接受两个参数）。

- [ ] **Step 3: 实现**

**3a. 样式表加两个键。** `skills/writing/templates/export_styles/wechat-default.json` 与 `wechat-serif.json` 各加：

```json
  "img": "display:block;max-width:100%;height:auto;margin:1.4em auto 0.4em auto;border-radius:4px;",
  "figcaption": "display:block;text-align:center;font-size:13px;color:#999999;margin:0 0 1.4em 0;line-height:1.6;"
```

**3b. `md_to_wechat_html` 认图。** 在 `_HR` 分支之前（第 70 行 `if _HR.match(line):` 之上）插入独占一行的图片分支：

```python
        # 图独占一行 → 图 + 图说，不包进 <p>（公众号里 <p> 的 margin 会把
        # 图和图说撑开成两块不相干的东西）。样式键用 .get 兜底：用户可能自带
        # 一份没有 img/figcaption 键的样式 JSON，KeyError 会让整次导出崩掉。
        m = _IMAGE.fullmatch(line.strip())
        if m:
            close_list()
            caption, src = m.group(1).strip(), m.group(2)
            img_style = style.get("img", "display:block;max-width:100%;height:auto;margin:1.4em auto 0.4em auto;")
            out.append(f'<img src="{html.escape(src, quote=True)}" alt="{html.escape(caption, quote=True)}" style="{img_style}" />')
            if caption:
                cap_style = style.get("figcaption", "display:block;text-align:center;font-size:13px;color:#999999;")
                out.append(f'<figcaption style="{cap_style}">{html.escape(caption, quote=False)}</figcaption>')
            continue
```

**3c. `md_to_plain` 认图。** 在 `_HEADING.sub` 那行（第 113 行）**之前**插入：

```python
        # 纯文本没法放图，退化成人能看懂的占位标记——把 markdown 语法
        # 原样漏给读者（朋友圈/私域话术会被直接复制粘贴）是最糟的结果。
        line = _IMAGE.sub(lambda m: f"［图：{m.group(1).strip() or '配图'}］", line)
```

**3d. `md_to_docx` 嵌图。** 函数签名与循环体改为：

```python
def md_to_docx(markdown: str, out_path: Path, md_path: Path) -> None:
    """导出 Word。依赖 python-docx（requirements.txt 已列）。

    多收一个 md_path：图片在正文里是相对路径（../images/x.png），
    要按**正文文件所在目录**解析才找得到——见 resolve_image_path 的注释。
    """
    try:
        from docx import Document
        from docx.shared import Inches
    except ImportError:
        raise SystemExit("[writing] 错误：导出 docx 需要 python-docx，请先跑 bin/ensure-python.sh 装依赖")

    doc = Document()
    for raw in markdown.splitlines():
        line = raw.strip()
        if not line or _HR.match(line):
            continue
        # 图独占一行 → 嵌图 + 图说段。宽度钉 5.5 英寸（A4 正文宽度），
        # 不钉会按图片像素尺寸铺开，大图直接溢出页面。
        m = _IMAGE.fullmatch(line)
        if m:
            caption, src = m.group(1).strip(), m.group(2)
            doc.add_picture(str(resolve_image_path(src, md_path)), width=Inches(5.5))
            if caption:
                doc.add_paragraph(caption, style="Caption")
            continue
        m = _HEADING.match(line)
```

（其余分支不变。）`main` 里第 175 行的调用同步改成：

```python
        md_to_docx(markdown, out_path, src)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/test_export.py -v`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add skills/writing/scripts/export.py skills/writing/templates/export_styles/ skills/writing/tests/test_export.py
git commit -m "feat(writing): 公众号/纯文本/docx 三种导出认图片语法"
```

---

### Task 6: 公众号导出的插图交付包

**Files:**
- Modify: `skills/writing/scripts/export.py`（新增 `copy_images` / `build_image_manifest`，`main` 里接上）
- Test: `skills/writing/tests/test_export.py`

**Interfaces:**
- Consumes: Task 4 的 `parse_images` / `resolve_image_path` / `ImageRef`
- Produces:
  - `copy_images(refs: list[ImageRef], md_path: Path, out_dir: Path) -> list[tuple[ImageRef, str]]` —— 把图复制进 `<out_dir>/images/`，返回 (引用, 新文件名) 列表，文件名带序号前缀
  - `build_image_manifest(pairs: list[tuple[ImageRef, str]], cover_first: bool) -> str` —— 生成贴在 HTML 顶部的插图说明块（内联样式）

- [ ] **Step 1: 写失败的测试**

追加到 `skills/writing/tests/test_export.py` 末尾：

```python
def test_copy_images_numbers_files_in_document_order(tmp_path):
    """文件名带序号，是为了让人在公众号编辑器里能按顺序对着插——
    原始文件名（gen-1754…png）对人没有任何顺序信息。"""
    (tmp_path / "images").mkdir()
    (tmp_path / "drafts").mkdir()
    for name in ("b.png", "a.png"):
        (tmp_path / "images" / name).write_bytes(b"x")
    md_path = tmp_path / "drafts" / "01.md"
    refs = export.parse_images("![二](../images/b.png)\n\n![一](../images/a.png)")
    out_dir = tmp_path / "output"
    pairs = export.copy_images(refs, md_path, out_dir)
    assert [name for _, name in pairs] == ["01-b.png", "02-a.png"]
    assert (out_dir / "images" / "01-b.png").is_file()
    assert (out_dir / "images" / "02-a.png").is_file()


def test_build_image_manifest_marks_cover_separately():
    """公众号封面在编辑器里是独立上传项、不进正文。
    不单独标出来，用户会把封面当成正文第一张图插进去。"""
    refs = export.parse_images("![封面](../images/a.png)\n\n![流程](../images/b.png)")
    pairs = [(refs[0], "01-a.png"), (refs[1], "02-b.png")]
    text = export.build_image_manifest(pairs, cover_first=True)
    assert "封面" in text
    assert "01-a.png" in text and "02-b.png" in text
    assert "output/images/" in text


def test_build_image_manifest_without_cover_lists_all_inline():
    refs = export.parse_images("![流程](../images/b.png)")
    text = export.build_image_manifest([(refs[0], "01-b.png")], cover_first=False)
    assert "封面" not in text


def test_build_image_manifest_is_empty_without_images():
    assert export.build_image_manifest([], cover_first=False) == ""
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/test_export.py -k "copy_images or manifest" -v`
Expected: FAIL，`module 'export' has no attribute 'copy_images'`。

- [ ] **Step 3: 实现**

`skills/writing/scripts/export.py` 顶部 import 区补 `import shutil`。在 `md_to_wechat_html` 之前加两个函数：

```python
def copy_images(refs: list[ImageRef], md_path: Path, out_dir: Path) -> list[tuple[ImageRef, str]]:
    """把正文用到的图复制进 `<out_dir>/images/`，按正文出现顺序编号。

    为什么要复制而不是让 HTML 指回项目里的原图：导出产物是**要交出去的一包**
    （发给自己手机、发给同事代发），指回项目路径的 HTML 换台机器就全断。
    为什么要重编号：原始文件名（gen-1754…png）对人零顺序信息，而公众号
    必须由人按顺序手工插图——序号就是那份操作顺序。
    """
    dest_dir = out_dir / "images"
    dest_dir.mkdir(parents=True, exist_ok=True)
    pairs: list[tuple[ImageRef, str]] = []
    for i, ref in enumerate(refs, start=1):
        source = resolve_image_path(ref.src, md_path)
        name = f"{i:02d}-{source.name}"
        shutil.copyfile(source, dest_dir / name)
        pairs.append((ref, name))
    return pairs


def build_image_manifest(pairs: list[tuple[ImageRef, str]], cover_first: bool) -> str:
    """贴在导出 HTML 顶部的插图说明块。

    为什么必须有这块东西：**微信编辑器会丢弃所有指向本地文件的图**
    （它只认已上传到微信服务器的图），也不支持 data URI。也就是说
    「粘一次全带图」在这个平台上做不到——这是平台限制，不是实现偷懒。
    能做的只有把手工步骤压到最低：图按序号命名、逐张列出该插在哪。
    样式内联，理由同全篇（公众号会剥掉 <style> 与 class）。
    """
    if not pairs:
        return ""
    rows: list[str] = []
    for idx, (ref, name) in enumerate(pairs):
        role = "封面（在编辑器的封面位单独上传，不要插进正文）" if (cover_first and idx == 0) else f"正文第 {ref.line} 行"
        cap = html.escape(ref.caption or "无图说", quote=False)
        rows.append(f"<li style=\"margin:0.3em 0;\">「{cap}」 → <code>output/images/{html.escape(name, quote=False)}</code>　·　{role}</li>")
    return (
        '<div style="border:1px dashed #cccccc;background:#fafafa;padding:1em 1.2em;margin:0 0 1.6em 0;'
        'font-size:14px;color:#666666;line-height:1.7;">'
        f'<strong style="color:#333333;">本文共 {len(pairs)} 张配图，需在公众号编辑器里手工插入</strong>'
        '<br />（微信会丢弃指向本地文件的图，这一步无法自动化）'
        f'<ol style="margin:0.6em 0 0 0;padding-left:1.4em;">{"".join(rows)}</ol>'
        '</div>'
    )
```

在 `main` 的 wechat 分支（第 170-171 行）改成：

```python
    if args.format == "wechat":
        style = load_style(args.style)
        body = md_to_wechat_html(markdown, style)
        refs = parse_images(markdown)
        # cover_first：有图就把第一张当封面。**刻意不去读契约的 image_plan**——
        # export.py 收的是一个 md 文件路径，不是项目路径，正文可能来自
        # `<cwd>/写作/` 这类没有契约的单文件场景，为此反推项目根既脆弱又多余。
        # 代价可控：判错时只是多提示一句「第一张是封面」，而漏提示会让用户
        # 把封面当正文图插错位——两种错的代价不对称，取宁可多提示的那边。
        cover_first = bool(refs)
        pairs = copy_images(refs, src, out_path.parent) if refs else []
        out_path.write_text(build_image_manifest(pairs, cover_first) + body, encoding="utf-8")
        if pairs:
            print(f"[writing] 已复制 {len(pairs)} 张配图到：{out_path.parent / 'images'}")
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/ -v`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add skills/writing/scripts/export.py skills/writing/tests/test_export.py
git commit -m "feat(writing): 公众号导出附插图交付包（复制图 + 手工插图清单 + 封面单列）"
```

---

### Task 7: 配图手册 references/illustrator.md

**Files:**
- Create: `skills/writing/references/illustrator.md`

**Interfaces:**
- Consumes: Task 3 的契约字段名 `image_plan` / `image_count` / `image_style`
- Produces: 写手在 Step 6 会 `Read` 的配图参考资料。Task 8 的 `SKILL.md` 会引用本文件路径。

> **不新增第五个角色。** 四角色流水线（策划 → 写手 → 审校 → 润色）的边界是整个技能的骨架。配图仍由**写手**在写到那一节时顺手留指令，本文件是写手的参考资料，不是岗位说明书——**不要**写成 `references/editor.md` 那种「## 你的职责 / ## 你的边界」的岗位格式。
>
> `scripts/validate_library.py` 只校验 `voices` / `structures` / `genres` / `workplace` 四个子目录，根级 `references/*.md` 不在其校验范围，**无需登记进任何 `_index.md`**。

- [ ] **Step 1: 写手册**

创建 `skills/writing/references/illustrator.md`，必须包含以下六节，每节的内容要求已写死：

1. **`## 什么该配图、什么不该`** —— 给出一条可执行判据：「这张图能否比同等篇幅的文字更快说清一件事？不能就不配」。明确写出配图是替读者省认知、不是装饰。列 3 个该配的场景与 3 个不该配的场景（例如：不该配——纯为了断开长文而塞的风景图、与段落内容无关的情绪图、把已经说清的一句话再画一遍）。

2. **`## 两条腿：氛围图 vs 信息图`** —— 一张判据表：能一句话说清的关系 / 流程 / 对比 → mermaid；讲氛围、场景、情绪、封面 → AI 生图。**必须写明为什么信息图不用生图**：生图模型画不好字，中文标注必糊必错，发公众号是硬伤；mermaid 里的字是真文字，清晰、可改、可复制。

3. **`## 氛围图：出图指令怎么写`** —— 说明格式并给 2 个完整示例。写清四条硬要求：构图描述要具体到「画面里有什么、什么光线、什么视角」；风格取自契约的 `image_style`，不在指令里另起一套；**不要求模型在图里写字**；不要水印与无关装饰。示例照抄下面这两段：

   ````markdown
   ```genimage
   图说: 凌晨三点的便利店，是很多人一天里唯一的松弛
   夜晚的便利店内景，暖黄色顶灯，落地玻璃窗外在下雨。
   一个人背对镜头坐在窗边高脚凳上低头写字，只见背影与肩线。
   平视视角，画面安静，色调偏暖。不要出现任何文字。
   ```
   ````

   ````markdown
   ```genimage
   图说: 把「等灵感」换成「排班表」
   俯视视角的木质书桌一角，摊开的纸质周历上密密标着记号，
   旁边一支笔和一杯凉掉的咖啡。自然光从左侧斜射进来。
   低饱和暖色，不要出现可辨认的文字或数字。
   ```
   ````

4. **`## 信息图：mermaid 怎么写`** —— 写清三条公众号限制：手机屏窄，横向图会被压成蚂蚁，所以方向优先 `graph TD`；节点数封顶（建议 ≤7）；单节点文字尽量短（建议 ≤10 字）。给下面这两个可直接抄的示例：

   ````markdown
   ```mermaid
   graph TD
     A[收到需求] --> B{一句话说得清吗}
     B -->|说得清| C[直接开工]
     B -->|说不清| D[先拆成三问]
     D --> C
     C --> E[交付并复盘]
   ```
   ````

   ````markdown
   ```mermaid
   graph TD
     subgraph 旧做法
       A1[等灵感] --> A2[灵感不来] --> A3[拖]
     end
     subgraph 新做法
       B1[排班表] --> B2[到点就写] --> B3[改]
     end
   ```
   ````

5. **`## 图说怎么写`** —— 图说要有信息增量，**禁止**「如图所示」「下图展示了」这类零信息说明。给 3 组「差 → 好」对照。写明图说同时是 `![图说](路径)` 的 alt 文字、公众号插图清单里的条目名、Word 导出的题注。

6. **`## 张数与预算`** —— 说明 `image_count` 是本篇上限、含封面一起算、生图是花钱的；写明超出上限时的做法（优先保留信息图——mermaid 不花钱且不占额度，砍氛围图）。

- [ ] **Step 2: 人工核对**

对照上面六节逐条检查：每节都在、判据都是可执行的（不是「要好看」这种没法照做的话）、示例都是完整可抄的。

- [ ] **Step 3: 跑资源库校验确认没打坏别的**

Run: `cd skills/writing && $WRITING_PY scripts/validate_library.py`
Expected: `[writing] ✓ 资源库结构完整`（根级新文件不在校验范围，本步只是确认没有误伤）。

- [ ] **Step 4: 提交**

```bash
git add skills/writing/references/illustrator.md
git commit -m "docs(writing): 新增配图手册，钉死氛围图/信息图两条腿的判据"
```

---

### Task 8: SKILL.md 八项确认扩为九项

**Files:**
- Modify: `skills/writing/SKILL.md`（Step 4 表格与检查点、Step 6 写手动作、Step 9 导出、主管线脚本索引）

**Interfaces:**
- Consumes: Task 3 的契约字段、Task 4 的导出闸、Task 6 的插图清单、Task 7 的手册路径
- Produces: 无（本任务是终点）

- [ ] **Step 1: 改 Step 4 的八项确认表**

在实现层最后一行（⑧ 平台格式 + 禁用清单）之后追加一行：

```markdown
| | ⑨ 配图方案 | 配不配图 / 几张 / 什么画风 | `image_plan` 三选一；`image_style` 是**创作性字段**，给 ≥3 候选让用户拍板（同文风、结构）。判据见 `references/illustrator.md` |
```

同时把该节开头那句「八项确认分两层」改为「九项确认分两层」，并在「**创作性字段 ≥3 候选（硬规则）**」那段的开头，把「⑥ 文风、⑦ 结构」改为「⑥ 文风、⑦ 结构、⑨ 配图风格（`image_plan != none` 时）」。

- [ ] **Step 2: 改 Step 4 的检查点**

在检查点清单里插入一条：

```markdown
- [x] ⑨ 配图方案已定：image_plan / image_count 有值；inline 或 cover-only 时 image_style 给过 ≥3 候选由用户拍板
```

并把「## ✅ Step 4 · 策划完成」段里提到「八项确认全部有明确值」的那条改为「九项确认全部有明确值」。

- [ ] **Step 3: 改 Step 6 的写手固定动作**

在「每写一节，动笔前把这套固定动作走一遍」的清单末尾追加一条：

```markdown
- [ ] （`image_plan != none` 时）`read_file references/illustrator.md` —— 取配图判据与出图指令格式。**只在本节大纲标了配图位时才需要**，没标就跳过。
```

在「每写完一节的收尾动作」里追加一条：

```markdown
- **核对配图张数**：本节留的出图指令 + 已写章节的累计张数不得超过契约 `image_count`。超了就砍氛围图（mermaid 信息图不占额度、也不花钱）。
```

- [ ] **Step 4: 改 Step 9 导出**

在 Step 9 的 GATE 行之后加一段：

```markdown
> 🚧 **图片就位闸**：`export.py` 会先扫正文里的全部 `![]()`，有任何一张在磁盘上找不到就**报清单并中止**（退出码 1），不会导出一份引用损坏的稿。被拦下时按清单把缺的图放到指定路径，或从正文里删掉这些引用，再重跑。
>
> 📎 **公众号配图要手工插**：微信编辑器会丢弃指向本地文件的图，「粘一次全带图」在这个平台上做不到。导出会把用到的图按顺序复制到 `<项目>/output/images/`，并在 HTML 顶部生成一份逐张对照的插图清单（封面单列，因为公众号封面是编辑器里的独立上传项、不进正文）。把这份清单一并交给用户。
```

- [ ] **Step 5: 改主管线脚本索引**

把 `export.py` 那行的说明改为：

```markdown
| `${SKILL_DIR}/scripts/export.py` | 导出定稿到平台格式（公众号内联样式 HTML / 纯文本 / docx），三种格式均支持配图；导出前跑图片就位闸，缺图中止。`<md路径> --format wechat\|plain\|docx [--style wechat-default\|wechat-serif] [--out <路径>]` |
```

- [ ] **Step 6: 人工核对全文一致性**

通读 SKILL.md，确认全文再无「八项确认」的残留说法（Step 4 标题、全局纪律第 2 条、Step 4 检查点、Step 2/3 的「进入 Step 4 策划」附近都可能提到）。用 `grep -n "八项" skills/writing/SKILL.md` 兜一遍，命中处逐一改成「九项」。

- [ ] **Step 7: 跑全套测试确认没打坏脚本**

Run: `cd skills/writing && $WRITING_PY -m pytest tests/ -v && $WRITING_PY scripts/validate_library.py`
Expected: 测试全部 PASS，资源库校验通过。

- [ ] **Step 8: 提交**

```bash
git add skills/writing/SKILL.md
git commit -m "feat(writing): 八项确认扩为九项，写作与导出接入配图"
```

---

## 完成后的验收

- [ ] `cd skills/writing && $WRITING_PY -m pytest tests/ -v` 全绿
- [ ] `cd skills/writing && $WRITING_PY scripts/validate_library.py` 通过
- [ ] `grep -n "八项" skills/writing/SKILL.md` 无输出
- [ ] 手动端到端：建一个项目 → 契约里填 `image_plan: inline` → 在某节正文里写一个 `![测试图](../images/t.png)` 且**不放图** → 跑 `export.py --format wechat` → 确认被闸拦下并报出第几行缺哪张 → 放上图重跑 → 确认 `output/images/01-t.png` 存在、HTML 顶部有插图清单、正文里图和图说都在

## 不在本计划内（P1b，另出计划）

`writingasset://` 协议、桌面端出图触发与审阅卡、图片落位写回 `drafts/*.md`、app 侧三条导出链补图。P1b 的任务边界依赖 P1a 落地后的契约实际形态，且其中的组件抽共用需要先单独重构、验证提案侧行为不变，故单独成篇。
