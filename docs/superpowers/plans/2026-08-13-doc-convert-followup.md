# doc-convert 挂账收口 + 表格支持 + 数字推断 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收口 PR #31 评审挂账的小项（原子写、0 页 PDF 拒绝、meta 中文指引、两条测试欠账），并给 md_to_docx 补 Markdown 表格支持、给 excel_csv 的 csv→xlsx 方向补保守数字类型推断。

**Architecture:** 全部改动局限在 `skills/doc-convert/` 内的独立 Python 脚本 + pytest 测试 + SKILL.md 文档。脚本互不依赖（技能自包含纪律，工具函数按先例在各脚本内平行维护，不抽公共模块）。

**Tech Stack:** Python 3.12（技能专属 venv）、python-docx、openpyxl、pytest。

**Spec:** `docs/superpowers/specs/2026-08-13-doc-convert-followup-design.md`

## Global Constraints

- 分支 `feat/doc-convert-followup`（已存在，含设计文档提交），所有提交落在它上面。
- 只改 `skills/doc-convert/` 与本计划/spec 文档，不碰主进程/前端/其他技能。
- **不引入任何新 Python 依赖**（requirements.txt 不动）。
- 所有面向用户的报错必须是中文、以 `[doc-convert] 错误：` 开头、无 Python 堆栈外漏。既有 `_die()` 出口不动。
- 纪律：宁可拒绝不产出，也不产出「看起来正常实则有缺陷」的文件。
- 每个修复任务做**变异验证**：临时把实现改回坏行为（或 `git stash` 撤回实现），确认新测试变红，再恢复。只跑正向的断言等于没有断言。
- 测试运行方式（repo 根目录）：
  ```bash
  source skills/doc-convert/bin/ensure-python.sh
  "$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests -q
  ```
  基线：**115 passed**。每个任务结束时全套必须全绿。
- 测试文件的既有约定（照抄，别发明新的）：模块级 `sys.path.insert` 后直接 `import <script>` 做单元断言；走完整 CLI 时用 `subprocess.run([sys.executable, str(SCRIPTS / "xxx.py"), ...], capture_output=True, text=True)`；中文报错断言用关键短语子串，不锁全句。

---

### Task 1: pdf_tables.py / doc_text.py 结果文件改原子写

**Files:**
- Modify: `skills/doc-convert/scripts/pdf_tables.py`（写盘处约 132-135 行）
- Modify: `skills/doc-convert/scripts/doc_text.py`（写盘处约 198-201 行）
- Test: `skills/doc-convert/tests/test_pdf_tables.py`、`skills/doc-convert/tests/test_doc_text.py`

**Interfaces:**
- Produces: 两个脚本各自新增模块级函数 `_write_text_atomic(dst: Path, body: str) -> None`（成功无返回值；失败清掉临时文件后把异常原样抛出，由既有调用点的 try/`_die` 接住）。两份实现刻意平行维护（同 `parse_pages` 先例），不抽公共模块。

- [ ] **Step 1: 写失败测试（两个测试文件各两条）**

在 `test_pdf_tables.py` 末尾追加（`test_doc_text.py` 同构，把 `pdf_tables` 换成 `doc_text`）：

```python
def test_atomic_write_success_leaves_no_temp_file(tmp_path):
    """挂账收口：结果文件必须原子落盘——成功后目录里只有目标文件，无 .part 残留。"""
    dst = tmp_path / "r.json"
    pdf_tables._write_text_atomic(dst, '{"ok": 1}')
    assert dst.read_text(encoding="utf-8") == '{"ok": 1}'
    assert [p.name for p in tmp_path.iterdir()] == ["r.json"]


def test_atomic_write_failure_leaves_no_partial_file(tmp_path, monkeypatch):
    """挂账收口：替换（os.replace）失败时不能留下半截临时文件，目标文件也不能
    出现——半截 JSON 比没有更糟，下游会拿着残缺数据继续走。"""
    import os as os_mod

    def _boom(src, dst):
        raise OSError("simulated failure")

    monkeypatch.setattr(pdf_tables.os, "replace", _boom)
    dst = tmp_path / "r.json"
    with pytest.raises(OSError):
        pdf_tables._write_text_atomic(dst, "{}")
    assert not dst.exists()
    assert list(tmp_path.iterdir()) == []
```

注意：两个测试文件顶部如果还没有 `import pytest`，补上（`test_pdf_tables.py` 已有）。

- [ ] **Step 2: 跑测试确认失败**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_pdf_tables.py skills/doc-convert/tests/test_doc_text.py -q`
Expected: 4 条新测试 FAIL（`AttributeError: module has no attribute '_write_text_atomic'`）

- [ ] **Step 3: 实现**

两个脚本各自加（放在 `_die` 定义之后；脚本顶部补 `import os`）：

```python
def _write_text_atomic(dst: Path, body: str) -> None:
    """先写同目录临时文件、成功后原子改名，失败清掉临时文件再抛。

    挂账收口（PR #31 Task 5 deferred）：原来的 dst.write_text 直接往目标路径写，
    中途失败（磁盘满/进程被杀）会留下半截文件——下游拿着残缺 JSON 继续走，
    比报错更糟。临时文件必须与目标同目录：os.replace 跨文件系统不保证原子。
    """
    tmp = dst.with_name(dst.name + ".part")
    try:
        tmp.write_text(body, encoding="utf-8")
        os.replace(tmp, dst)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
```

调用点替换——`pdf_tables.py` main() 里：

```python
        try:
            _write_text_atomic(dst, json.dumps(result, ensure_ascii=False, indent=2))
        except Exception:
            _die(f"写入 JSON 文件 {dst} 失败，请检查目标目录权限或磁盘空间。")
```

`doc_text.py` main() 里：

```python
        try:
            _write_text_atomic(text_file, body)
        except Exception:
            _die(f"写入文本文件 {text_file} 失败，请检查目标目录权限或磁盘空间。")
```

- [ ] **Step 4: 跑测试确认通过 + 全套回归**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests -q`
Expected: 119 passed（115 + 4）

- [ ] **Step 5: 变异验证**

把 `pdf_tables._write_text_atomic` 里的 `except` 清理临时文件那两行临时注释掉 → `test_atomic_write_failure_leaves_no_partial_file` 应变红；恢复后再全绿。`doc_text` 侧同做一次。

- [ ] **Step 6: Commit**

```bash
git add skills/doc-convert/scripts/pdf_tables.py skills/doc-convert/scripts/doc_text.py \
        skills/doc-convert/tests/test_pdf_tables.py skills/doc-convert/tests/test_doc_text.py
git commit -m "fix(doc-convert): pdf_tables/doc_text 结果文件改原子写，失败不留半截 JSON"
```

---

### Task 2: doc_text.py 拒绝 0 页 PDF

**Files:**
- Modify: `skills/doc-convert/scripts/doc_text.py`（main() 里约 182-185 行的 `if not units:` 分支）
- Test: `skills/doc-convert/tests/test_doc_text.py`

**Interfaces:**
- Consumes: 无（独立于 Task 1，但同文件，按顺序做避免冲突）
- Produces: 行为变化——0 页合法 PDF 从「静默产出空取料文件 + exit 0」变为「中文报错 exit 2、不产出文件」。

- [ ] **Step 1: 写失败测试**

`test_doc_text.py` 末尾追加（该文件已有 `SCRIPTS` 常量与 subprocess 跑法，照抄其 `_run` 辅助；若无则直接写 subprocess.run）：

```python
def test_zero_page_pdf_is_refused(tmp_path):
    """挂账收口：0 页的合法 PDF 原来会静默产出空取料文件 + exit 0，与「只有
    空段落的 docx 走拒绝」不对称。两条路径的纪律要一致：给不了任何有用产物
    就拒绝，不产出一份空文件让下游误以为「读完了、只是没内容」。"""
    from pypdf import PdfWriter

    src = tmp_path / "empty.pdf"
    with src.open("wb") as f:
        PdfWriter().write(f)
    outdir = tmp_path / "取料"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "doc_text.py"), str(src), "--outdir", str(outdir)],
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert proc.stderr.startswith("[doc-convert] 错误：")
    assert "0 页" in proc.stderr
    assert not outdir.exists() or list(outdir.glob("*.text.txt")) == []
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_doc_text.py::test_zero_page_pdf_is_refused -q`
Expected: FAIL（现状 returncode == 0）

- [ ] **Step 3: 实现**

把 main() 里这段：

```python
        if not units:
            # 一个字都提不出来又不是扫描件判定能解释的，属于「给不了任何有用产物」
            if kind != "pdf":
                _die(f"「{src.name}」里提不出任何文字。请确认文件内容是否正确。")
```

改成：

```python
        if not units:
            # 一个字都提不出来又不是扫描件判定能解释的，属于「给不了任何有用产物」。
            # PDF 侧：units 一项一页，空列表 = 0 页文件（扫描件每页仍占一项，不会
            # 走到这里）。原来这个分支只拦非 PDF，0 页 PDF 会静默产出空取料文件
            # + exit 0——与「只有空段落的 docx 被拒绝」不对称（挂账收口）。
            if kind == "pdf":
                _die(f"「{src.name}」是一份 0 页的 PDF，没有内容可提取。请确认文件是否正确。")
            _die(f"「{src.name}」里提不出任何文字。请确认文件内容是否正确。")
```

- [ ] **Step 4: 跑测试确认通过 + 全套回归**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests -q`
Expected: 120 passed

- [ ] **Step 5: Commit**

```bash
git add skills/doc-convert/scripts/doc_text.py skills/doc-convert/tests/test_doc_text.py
git commit -m "fix(doc-convert): doc_text 拒绝 0 页 PDF，与空 docx 的拒绝分支对称"
```

---

### Task 3: rows_to_xlsx.py meta 非对象时给中文指引

**Files:**
- Modify: `skills/doc-convert/scripts/rows_to_xlsx.py`（load() 里约 94-95 行）
- Test: `skills/doc-convert/tests/test_rows_to_xlsx.py`

**Interfaces:**
- Produces: 行为变化——`.json` 输入的 `meta` 字段不是对象时，从「AttributeError 落进通用兜底（中文前缀 + 英文异常类名）」变为「load() 里当场用中文指引拒绝」。

- [ ] **Step 1: 写失败测试**

`test_rows_to_xlsx.py` 末尾追加（复用该文件已有的 `_write_json` / `_run`）：

```python
def test_non_object_meta_gets_chinese_guidance(tmp_path):
    """挂账收口：meta 手滑写成字符串（如 "meta": "台账"）原来会在 build() 里
    炸 AttributeError、落进通用兜底，报「中文前缀 + 英文异常类名」，用户不知道
    该改哪。要在 load() 里当场用中文钉住，并告诉用户下一步怎么办。"""
    src = _write_json(tmp_path / "m.json", {
        "headers": ["项目"],
        "rows": [{"项目": "住宿"}],
        "meta": "台账标题",
    })
    out = tmp_path / "m.xlsx"
    proc = _run(src, out)
    assert proc.returncode != 0
    assert proc.stderr.startswith("[doc-convert] 错误：")
    assert "meta" in proc.stderr and "对象" in proc.stderr
    assert "AttributeError" not in proc.stderr
    assert not out.exists()
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_rows_to_xlsx.py::test_non_object_meta_gets_chinese_guidance -q`
Expected: FAIL（现状 stderr 含 AttributeError）

- [ ] **Step 3: 实现**

load() 末尾这两行：

```python
    headers = headers_arg or payload.get("headers") or []
    return list(headers), payload.get("rows") or [], payload.get("meta") or {}
```

改成：

```python
    headers = headers_arg or payload.get("headers") or []
    meta = payload.get("meta") or {}
    if not isinstance(meta, dict):
        # 挂账收口：meta 写成字符串/数组是很自然的手滑，不拦的话要到 build()
        # 末尾 meta.get("标题") 才炸 AttributeError——通用兜底接得住，但报出来
        # 的是「中文前缀 + 英文异常类名」，用户不知道该改哪。同 payload 顶层
        # 形状校验一个道理：能在读入时钉死的，不留给下游。
        _die(f"「{path.name}」的 meta 必须是一个对象（比如 {{\"标题\": \"...\"}}），"
             f"但读到的是 {type(meta).__name__}。不需要附加信息的话，"
             "把 meta 字段整个删掉即可。")
    return list(headers), payload.get("rows") or [], meta
```

- [ ] **Step 4: 跑测试确认通过 + 全套回归**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests -q`
Expected: 121 passed

- [ ] **Step 5: Commit**

```bash
git add skills/doc-convert/scripts/rows_to_xlsx.py skills/doc-convert/tests/test_rows_to_xlsx.py
git commit -m "fix(doc-convert): rows_to_xlsx 的 meta 非对象时给中文自救指引"
```

---

### Task 4: 补两条测试欠账（无实现改动）

**Files:**
- Test: `skills/doc-convert/tests/test_pdf_render.py`、`skills/doc-convert/tests/test_rows_to_xlsx.py`

背景：挂账清单里的「清理计数少 1」与「错误文案缺 `跳过` 断言」已在合并前的收口提交 1ba82009 修掉（`pdf_render.py:136` 已是 `cleaned = len(written) + (1 if leftover else 0)`；`test_pdf_render.py:98` 已有 `assert "跳过"`）。本任务只补剩下两条纯测试欠账。

- [ ] **Step 1: 补「已清理 0 个」直接断言**

`test_pdf_render.py` 末尾追加（照抄同文件 `test_render_removes_failed_pages_own_partial_file` 的 monkeypatch 模式；`_pdf` 辅助函数该文件已有）：

```python
def test_render_reports_zero_cleaned_when_nothing_was_written(tmp_path, monkeypatch, capsys):
    """挂账收口（测试欠账）：失败发生在 save() 落任何字节之前时，written 为空、
    失败页自己也没留半成品，计数必须如实报 0——这是 `len(written) + leftover`
    公式的另一条分支，此前只有「1 个」的断言守着。"""
    from PIL import Image

    src = _pdf(tmp_path / "m.pdf", pages=1)
    outdir = tmp_path / "png"

    def _fail_before_write(self, fp, *a, **kw):
        raise OSError("no space left on device")

    monkeypatch.setattr(Image.Image, "save", _fail_before_write)
    with pytest.raises(SystemExit):
        pdf_render.render(src, [1], outdir, pdf_render.SCALE_DEFAULT)
    err = capsys.readouterr().err
    assert "已清理本次产生的 0 个部分文件" in err
```

- [ ] **Step 2: 补超长表名专属单测**

`test_rows_to_xlsx.py` 末尾追加：

```python
def test_sheet_name_over_31_chars_is_refused(tmp_path):
    """挂账收口（测试欠账）：超长表名分支此前与非法字符共用一道防线、没有专属
    断言。Excel 表名硬上限 31 字符，超了 openpyxl 会报英文异常或静默截断。"""
    src = _write_json(tmp_path / "s.json", {
        "headers": ["项目"],
        "rows": [{"项目": "住宿"}],
    })
    out = tmp_path / "s.xlsx"
    proc = _run(src, out, "--sheet", "长" * 32)
    assert proc.returncode != 0
    assert proc.stderr.startswith("[doc-convert] 错误：")
    assert "超过 Excel 限制" in proc.stderr
    assert not out.exists()
```

- [ ] **Step 3: 跑全套确认通过**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests -q`
Expected: 123 passed

- [ ] **Step 4: 变异验证**

把 `pdf_render.py:136` 的 `+ (1 if leftover else 0)` 临时删掉 → 0 个的新断言应仍绿、既有「1 个」断言变红（说明两条分支各有测试守）；把 `rows_to_xlsx.py` 的 `len(name) > MAX_SHEET_NAME_LEN` 分支临时注释 → 新超长表名测试变红。恢复后全绿。

- [ ] **Step 5: Commit**

```bash
git add skills/doc-convert/tests/test_pdf_render.py skills/doc-convert/tests/test_rows_to_xlsx.py
git commit -m "test(doc-convert): 补清理计数 0 分支与超长表名的两条挂账断言"
```

---

### Task 5: md_to_docx.py 支持 Markdown 管道表格

**Files:**
- Modify: `skills/doc-convert/scripts/md_to_docx.py`（docstring、convert() 主循环、新增两个辅助函数）
- Modify: `skills/doc-convert/SKILL.md`（三处表格警告：A1 约 108-112 行、A4 约 251-253 行、B1 约 263-265 行）
- Test: `skills/doc-convert/tests/test_md_to_docx.py`

**Interfaces:**
- Produces: `_is_table_sep(line: str) -> bool`、`_split_cells(line: str) -> list[str]`、`_add_md_table(doc, header_line: str, sep_line: str, data_lines: list[str], first_data_lineno: int) -> None`。convert() 的对外签名不变。数据行列数超过表头时经 `_die` 中文报错退出（SystemExit 不被 main 兜底重包）。

- [ ] **Step 1: 写失败测试（6 条）**

`test_md_to_docx.py` 末尾追加：

```python
from docx.enum.text import WD_ALIGN_PARAGRAPH


def test_pipe_table_becomes_word_table(tmp_path):
    """表格是 A 类主力场景（发票/报表）最常见的结构，此前会塌成竖线文本。"""
    src = tmp_path / "t.md"
    src.write_text(
        "| 品名 | 金额 |\n|:---|---:|\n| 差旅 | 128.5 |\n| 餐饮 | 56 |\n",
        encoding="utf-8",
    )
    dst = tmp_path / "t.docx"
    md_to_docx.convert(src, dst)
    doc = Document(str(dst))
    assert len(doc.tables) == 1
    t = doc.tables[0]
    assert t.rows[0].cells[0].text == "品名"
    assert t.rows[2].cells[1].text == "56"
    # 表头加粗；右对齐列（---:）落到单元格段落上
    assert t.rows[0].cells[0].paragraphs[0].runs[0].bold is True
    assert t.rows[1].cells[1].paragraphs[0].alignment == WD_ALIGN_PARAGRAPH.RIGHT
    # 竖线文本不应再出现在正文段落里
    assert all("|" not in p.text for p in doc.paragraphs)


def test_table_cell_inline_formatting_works(tmp_path):
    src = tmp_path / "u.md"
    src.write_text("| 项 |\n|---|\n| **重点** |\n", encoding="utf-8")
    dst = tmp_path / "u.docx"
    md_to_docx.convert(src, dst)
    cell_runs = Document(str(dst)).tables[0].rows[1].cells[0].paragraphs[0].runs
    assert cell_runs[0].text == "重点" and cell_runs[0].bold is True


def test_short_row_is_padded_with_empty_cells(tmp_path):
    """GFM 标准行为：短行补空，不丢信息、不拒绝。"""
    src = tmp_path / "v.md"
    src.write_text("| 甲 | 乙 |\n|---|---|\n| 只有一格 |\n", encoding="utf-8")
    dst = tmp_path / "v.docx"
    md_to_docx.convert(src, dst)
    t = Document(str(dst)).tables[0]
    assert t.rows[1].cells[0].text == "只有一格"
    assert t.rows[1].cells[1].text == ""


def test_long_row_is_refused_with_line_number(tmp_path, capsys):
    """纪律：比表头长的行如果截断就丢内容，宁可拒绝，并报出 md 行号。"""
    src = tmp_path / "w.md"
    src.write_text("| 甲 | 乙 |\n|---|---|\n| 1 | 2 | 3 |\n", encoding="utf-8")
    dst = tmp_path / "w.docx"
    with pytest.raises(SystemExit):
        md_to_docx.convert(src, dst)
    err = capsys.readouterr().err
    assert err.startswith("[doc-convert] 错误：")
    assert "第 3 行" in err and "列" in err
    assert not dst.exists()


def test_pipe_lines_without_separator_stay_plain_text(tmp_path):
    """没有分隔行就不是表格——维持旧行为当普通文本，不误伤正文里的竖线。"""
    src = tmp_path / "x.md"
    src.write_text("| 这行只是碰巧有竖线 |\n没有分隔行。\n", encoding="utf-8")
    dst = tmp_path / "x.docx"
    md_to_docx.convert(src, dst)
    doc = Document(str(dst))
    assert doc.tables == []
    assert "| 这行只是碰巧有竖线 |" in [p.text for p in doc.paragraphs]


def test_table_syntax_inside_code_fence_is_not_parsed(tmp_path):
    src = tmp_path / "y.md"
    src.write_text("```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n", encoding="utf-8")
    dst = tmp_path / "y.docx"
    md_to_docx.convert(src, dst)
    assert Document(str(dst)).tables == []
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_md_to_docx.py -q`
Expected: 前 4 条与第 6 条 FAIL（现状没有表格支持）；第 5 条（无分隔行保持文本）现状就该 PASS——它是防回归的护栏。

- [ ] **Step 3: 实现**

`md_to_docx.py` 改动四处：

(a) docstring 第 4-11 行改写（表格从「不支持」清单挪走，说明仍不引解析库）：

```python
"""Markdown → Word（.docx）。

**刻意只支持 Markdown 的常用子集**，不引 markdown/mistune 之类解析库：
用户在办公场景写的 md 就是标题 / 段落 / 列表 / 表格 / 粗斜体 / 代码块这几样，
解析全靠手写规则就够。真遇到复杂 md，正确做法是让模型先把它规整成这个子集，
而不是把解析器做厚。

支持：# ~ ###### 标题、空行分段、- / * 无序列表、1. 有序列表、
     **粗体**、*斜体*、`行内代码`、``` 围栏代码块、--- 分隔线、
     | 管道表格（表头加粗、:--- 对齐语法；2026-08-13 补，A 类场景刚需）。
不支持（会原样当普通文本输出，不报错）：引用块、图片、链接语法、
     表格里的合并单元格与 \\| 转义竖线。
"""
```

(b) 新增两个辅助（放在 `_add_inline` 之后）：

```python
_SEP_CELL = re.compile(r":?-{3,}:?")


def _is_table_sep(line: str) -> bool:
    """判定分隔行（`|---|:---:|`）。它是「这一片竖线行是表格」的唯一凭证——
    没有它就维持旧行为当普通文本，不误伤正文里碰巧带竖线的行。"""
    s = line.strip()
    if not s.startswith("|"):
        return False
    parts = [p.strip() for p in s.strip("|").split("|")]
    return bool(parts) and all(_SEP_CELL.fullmatch(p) for p in parts)


def _split_cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]
```

(c) 新增 `_add_md_table`（放在 `_split_cells` 之后）：

```python
def _add_md_table(doc, header_line: str, sep_line: str,
                  data_lines: list[str], first_data_lineno: int) -> None:
    """把一片管道表格行画成真正的 Word 表格。

    边界纪律：短行补空单元格（GFM 标准行为，不丢信息）；长行拒绝——截断会
    丢内容，宁可报错让用户改（同本技能「不产出有缺陷文件」的头号纪律）。
    """
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    headers = _split_cells(header_line)
    aligns = []
    for p in [c.strip() for c in sep_line.strip().strip("|").split("|")]:
        if p.startswith(":") and p.endswith(":"):
            aligns.append(WD_ALIGN_PARAGRAPH.CENTER)
        elif p.endswith(":"):
            aligns.append(WD_ALIGN_PARAGRAPH.RIGHT)
        else:
            aligns.append(None)  # 左对齐是 Word 默认，不用显式设
    # 分隔行列数与表头不齐时对齐信息按左对齐补齐——对齐是装饰，不值得拒绝
    aligns += [None] * (len(headers) - len(aligns))

    rows: list[list[str]] = []
    for offset, ln in enumerate(data_lines):
        cells = _split_cells(ln)
        if len(cells) > len(headers):
            _die(f"Markdown 表格第 {first_data_lineno + offset} 行有 "
                 f"{len(cells)} 列，多于表头的 {len(headers)} 列。多出来的列"
                 "如果截断就丢内容，请把这一行改成与表头一致的列数后重试。")
        cells += [""] * (len(headers) - len(cells))
        rows.append(cells)

    table = doc.add_table(rows=len(rows) + 1, cols=len(headers))
    table.style = "Table Grid"  # 带边框；无边框的表在 Word 里看不出是表
    for c, text in enumerate(headers):
        par = table.rows[0].cells[c].paragraphs[0]
        _add_inline(par, text)
        for run in par.runs:
            run.bold = True
        if aligns[c] is not None:
            par.alignment = aligns[c]
    for r, cells in enumerate(rows, start=1):
        for c, text in enumerate(cells):
            par = table.rows[r].cells[c].paragraphs[0]
            _add_inline(par, text)
            if aligns[c] is not None:
                par.alignment = aligns[c]
```

(d) convert() 主循环从 `for raw in ...splitlines()` 改成索引式，插入表格分支。整个函数改写为：

```python
def convert(src: Path, dst: Path) -> None:
    """把 src 这份 Markdown 转成 dst 这份 .docx。"""
    doc = Document()
    in_code = False
    lines = _read_md(src).splitlines()
    i = 0

    while i < len(lines):
        line = lines[i].rstrip()

        # 围栏代码块：进入后逐行原样成段，直到再遇到围栏。放在最前面判断——
        # 代码块里的 `# ` 是注释不是标题，任何结构规则（包括表格）都不该在
        # 这里生效。
        if line.strip().startswith("```"):
            in_code = not in_code
            i += 1
            continue
        if in_code:
            run = doc.add_paragraph().add_run(line)
            run.font.name = "Consolas"
            i += 1
            continue

        # 管道表格：当前行以 | 开头、下一行是分隔行，才认作表格——分隔行是
        # 唯一凭证，没有它就落到下面当普通文本（不误伤正文里的竖线）。
        if (line.strip().startswith("|") and i + 1 < len(lines)
                and _is_table_sep(lines[i + 1])):
            j = i + 2
            while j < len(lines) and lines[j].strip().startswith("|"):
                j += 1
            # 行号从 1 起：数据行从文件的第 i+3 行开始（表头 i+1、分隔行 i+2）
            _add_md_table(doc, line, lines[i + 1],
                          [ln.rstrip() for ln in lines[i + 2:j]],
                          first_data_lineno=i + 3)
            i = j
            continue

        if not line.strip():
            i += 1
            continue

        if _HRULE.match(line):
            doc.add_paragraph("―" * 20)
            i += 1
            continue

        m = _HEADING.match(line)
        if m:
            doc.add_heading(m.group(2).strip(), level=len(m.group(1)))
            i += 1
            continue

        m = _BULLET.match(line)
        if m:
            _add_inline(doc.add_paragraph(style="List Bullet"), m.group(1))
            i += 1
            continue

        m = _ORDERED.match(line)
        if m:
            _add_inline(doc.add_paragraph(style="List Number"), m.group(1))
            i += 1
            continue

        _add_inline(doc.add_paragraph(), line)
        i += 1

    dst.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(dst))
```

注意：`_HRULE` 会匹配 `---`，但表格分隔行如 `|---|---|` 以 `|` 开头不会撞上它；表格分支在 `_HRULE` 之前，顺序不能反。

- [ ] **Step 4: 跑测试确认通过 + 全套回归**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests -q`
Expected: 129 passed（123 + 6）

- [ ] **Step 5: 同步 SKILL.md 三处**

(a) A1 段（约 108-112 行）：删掉「`md_to_docx.py` 不支持表格…先说清这一点让用户选：① 就交付 Markdown；② 表格单独走 A2 出 Excel、正文部分走 Word」整段警告（以 `⚠ **\`md_to_docx.py\` 不支持表格**` 开头的那一段），替换为：

```markdown
表格会被转成真正的 Word 表格（表头加粗、带边框）。注意单元格里别用 `\|`
转义竖线、别指望合并单元格——这两样不支持，会原样进文字。
```

(b) A4 段（约 251-253 行）：把「**同样要注意 A1 那条表格警告**：长文档里如果有表格（财务附表、参数对照表），转 Word 会塌成竖线文本，先跟用户说清楚」删掉，改为「表格会一并转成 Word 表格」。

(c) B1 段（约 263-265 行）：支持清单改为「支持 Markdown 常用子集（标题 / 段落 / 有序无序列表 / 表格 / 粗斜体 / 行内代码 / 围栏代码块 / 分隔线）。**不支持引用块、图片、链接语法**——遇到这些，先把它们改写成受支持的形式再转」。同时在下方补一句表格边界：「表格数据行多于表头列数时会报错拒绝（截断会丢内容），列数少会自动补空格」。

改完通读 SKILL.md 全文搜「表格」，确认没有残留的「会塌成竖线文本」措辞。

- [ ] **Step 6: Commit**

```bash
git add skills/doc-convert/scripts/md_to_docx.py skills/doc-convert/tests/test_md_to_docx.py skills/doc-convert/SKILL.md
git commit -m "feat(doc-convert): md_to_docx 支持管道表格，A1/A4 不再需要绕开表格"
```

---

### Task 6: excel_csv.py csv→xlsx 保守数字类型推断

**Files:**
- Modify: `skills/doc-convert/scripts/excel_csv.py`（csv_to_xlsx() + 新增 `_coerce_cell`）
- Modify: `skills/doc-convert/SKILL.md`（B3 段约 321-330 行的「数字是文本」警告改写）
- Test: `skills/doc-convert/tests/test_excel_csv.py`

**Interfaces:**
- Produces: `_coerce_cell(text: str) -> tuple[int | float | str, str]`，第二个元素是标签：`"num"`（转成了数值）/ `"guarded"`（长得像数字但被护栏留成文本）/ `"text"`（普通文本）。csv_to_xlsx() 行为变化：数值单元格写成真数值，转换后 stdout 打印按列汇总的中文报告。

- [ ] **Step 1: 写失败测试**

`test_excel_csv.py` 末尾追加（该文件顶部已有 `import excel_csv` 与 `from openpyxl import load_workbook`，直接用）：

```python
def test_csv_to_xlsx_infers_numbers_conservatively(tmp_path, capsys):
    """csv→xlsx 数字推断：数值写成真数值（=SUM 能算），编号样的坚决保文本。
    护栏三条：前导零、纯整数位数 ≥10、含非数值字符。"""
    src = tmp_path / "n.csv"
    src.write_text(
        "项目,金额,发票号,电话,备注\n"
        "差旅,\"1,200.50\",24312000000123456789,13800138000,正常\n"
        "餐饮,-56,007,1.5E+3,0.5\n",
        encoding="utf-8-sig",
    )
    dst = tmp_path / "n.xlsx"
    assert excel_csv.main([str(src), "-o", str(dst)]) == 0
    ws = load_workbook(dst).active
    # 数值列：千分位被剥掉、负数、小数都成真数值
    assert ws["B2"].value == 1200.5 and ws["B2"].data_type == "n"
    assert ws["B3"].value == -56 and ws["B3"].data_type == "n"
    assert ws["E3"].value == 0.5
    # 编号护栏：20 位发票号、11 位手机号、前导零、科学计数法——全部保文本
    assert ws["C2"].value == "24312000000123456789"
    assert ws["D2"].value == "13800138000"
    assert ws["C3"].value == "007"
    assert ws["D3"].value == "1.5E+3"
    # 表头行是普通文本
    assert ws["B1"].value == "金额"
    # 透明度：转换报告点名列
    out = capsys.readouterr().out
    assert "写成真数值" in out
    assert "保留为文本" in out


def test_coerce_cell_edge_cases():
    assert excel_csv._coerce_cell("128.5") == (128.5, "num")
    assert excel_csv._coerce_cell("1,200.50") == (1200.5, "num")
    assert excel_csv._coerce_cell("-42") == (-42, "num")
    assert excel_csv._coerce_cell("999999999") == (999999999, "num")     # 9 位，转
    assert excel_csv._coerce_cell("1234567890")[1] == "guarded"          # 10 位，保
    assert excel_csv._coerce_cell("0") == (0, "num")
    assert excel_csv._coerce_cell("0.5") == (0.5, "num")
    assert excel_csv._coerce_cell("007")[1] == "guarded"
    assert excel_csv._coerce_cell("12345678901.5") == (12345678901.5, "num")  # 带小数不受位数限制
    assert excel_csv._coerce_cell("1,23")[1] == "text"   # 假千分位
    assert excel_csv._coerce_cell("abc")[1] == "text"
    assert excel_csv._coerce_cell("")[1] == "text"
    assert excel_csv._coerce_cell(" 42 ") == (42, "num")  # 首尾空白剥掉再判
```

- [ ] **Step 2: 跑测试确认失败**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests/test_excel_csv.py -q`
Expected: 两条新测试 FAIL（`_coerce_cell` 不存在）。**同时注意 `test_csv_to_xlsx_roundtrip` 可能因值从文本变数值而变红**——那是本功能的目的，属于期望要更新的既有测试，先记下，Step 3 后一起改。

- [ ] **Step 3: 实现**

`excel_csv.py` 顶部补 `import re` 与 `from openpyxl.utils import get_column_letter`。新增（放在 `_die` 之后）：

```python
# csv→xlsx 数字推断的三条护栏（顺序即优先级）。设计取舍见 SKILL.md B3：
# 编号（发票号/手机号/身份证号）长得像数字但不是数值——转成 number 会被
# Excel 的 15 位精度静默截断成科学计数法，正是本技能要拦的「看起来正常
# 实则数字有缺陷」。宁可把十亿级无小数点的大金额保守留成文本（用户在
# Excel 里一步能改回数值），也不冒截断编号的险。
_THOUSANDS_RE = re.compile(r"^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$")
_PLAIN_NUM_RE = re.compile(r"^[+-]?\d+(\.\d+)?$")
_MAX_INT_DIGITS = 9  # 纯整数位数 ≥10（手机号 11 位起）一律保文本


def _coerce_cell(text: str) -> tuple[int | float | str, str]:
    """CSV 单元格 → (写入值, 标签)。标签："num" 转成数值 / "guarded" 长得像
    数字但被护栏留成文本 / "text" 普通文本。"""
    s = text.strip()
    if not s:
        return text, "text"
    if _THOUSANDS_RE.match(s):
        s = s.replace(",", "")  # 千分位只是显示形式，剥掉不算改值（同 A2 规则）
    elif not _PLAIN_NUM_RE.match(s):
        return text, "text"
    int_part = s.lstrip("+-").split(".", 1)[0]
    if len(int_part) > 1 and int_part.startswith("0"):
        return text, "guarded"  # 前导零：区号/编号特征（"0"、"0.5" 不算）
    if "." not in s:
        if len(int_part) > _MAX_INT_DIGITS:
            return text, "guarded"
        return int(s), "num"
    return float(s), "num"
```

csv_to_xlsx() 里把：

```python
    wb = Workbook()
    ws = wb.active
    for row in rows:
        ws.append(row)
```

改成：

```python
    wb = Workbook()
    ws = wb.active
    num_cols: dict[int, int] = {}      # 列号 → 转成数值的格数
    guarded_cols: dict[int, int] = {}  # 列号 → 被护栏保成文本的格数
    for row in rows:
        out_row = []
        for col, cell in enumerate(row, start=1):
            value, tag = _coerce_cell(cell)
            if tag == "num":
                num_cols[col] = num_cols.get(col, 0) + 1
            elif tag == "guarded":
                guarded_cols[col] = guarded_cols.get(col, 0) + 1
            out_row.append(value)
        ws.append(out_row)
```

并在该函数末尾 `wb.save(str(dst))` 之后补报告（转完必须让用户和模型看见发生了什么——静默转换等于让人事后猜）：

```python
    if num_cols:
        cols = "、".join(get_column_letter(c) for c in sorted(num_cols))
        print(f"[doc-convert] 已把 {sum(num_cols.values())} 个数字单元格"
              f"写成真数值（第 {cols} 列），可以直接用 =SUM() 等公式计算。")
    if guarded_cols:
        cols = "、".join(get_column_letter(c) for c in sorted(guarded_cols))
        print(f"[doc-convert] 另有 {sum(guarded_cols.values())} 个疑似编号的"
              f"单元格（第 {cols} 列，前导零或位数过长）保留为文本，避免被 "
              "Excel 按 15 位精度截断。确实需要按数值计算的话，"
              "在 Excel 里选中该列改成数值格式即可。")
```

- [ ] **Step 4: 修既有 roundtrip 测试的期望**

`test_excel_csv.py` 的 `test_csv_to_xlsx_roundtrip`（约 39 行起）现在断言：

```python
    assert [[c.value for c in row] for row in ws.iter_rows()] == [
        ["姓名", "金额"],
        ["李四", "200"],
    ]
```

改成（`"200"` → `200`，并注明缘由）：

```python
    # 2026-08-13 起 csv→xlsx 做保守数字推断："200" 这类数值格写成真数值，
    # 这是功能预期，不是回归。
    assert [[c.value for c in row] for row in ws.iter_rows()] == [
        ["姓名", "金额"],
        ["李四", 200],
    ]
```

- [ ] **Step 5: 跑全套确认通过**

Run: `"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests -q`
Expected: 131 passed（129 + 2）

- [ ] **Step 6: 变异验证**

把 `_MAX_INT_DIGITS` 临时改成 99 → 发票号/手机号两条断言变红；把前导零分支临时注释 → `"007"` 断言变红。恢复后全绿。

- [ ] **Step 7: 改写 SKILL.md B3 段**

把 B3 里「⚠️ **csv → xlsx 方向有个用户容易误以为"转错了"的坑…**」到「…就能转回真正的数字。」整段（约 321-330 行）替换为：

```markdown
csv → xlsx 方向会做**保守的数字类型推断**：看起来是数值的格子（含千分位
写法）会写成真数值，转出来直接就能 `=SUM()`。三类格子会**刻意保留为文本**，
脚本转完会打印报告点名哪些列：前导零的（`007`）、纯整数 10 位以上的
（手机号/身份证号/发票号——转成数值会被 Excel 的 15 位精度静默截断成
科学计数法，宁可不转）、含任何非数字字符的。用户如果问"为什么这列不能
求和"，把报告里的解释转达给他：在 Excel 里选中该列改成数值格式即可，
但编号类的列本来就不该参与计算。
```

- [ ] **Step 8: Commit**

```bash
git add skills/doc-convert/scripts/excel_csv.py skills/doc-convert/tests/test_excel_csv.py skills/doc-convert/SKILL.md
git commit -m "feat(doc-convert): csv→xlsx 保守数字推断，编号护栏 + 按列转换报告"
```

---

### Task 7: 端到端验证与收尾

**Files:** 无新改动（验证任务；发现问题则回到对应任务修）

- [ ] **Step 1: 全套测试终跑**

```bash
source skills/doc-convert/bin/ensure-python.sh
"$DOC_CONVERT_PY" -m pytest skills/doc-convert/tests -q
```
Expected: 131 passed，0 failed。

- [ ] **Step 2: 表格支持端到端实测（真命令、真文件）**

```bash
cd "$(mktemp -d)"
cat > 样例.md <<'EOF'
# 报销汇总

| 项目 | 金额 | 备注 |
|:---|---:|:---:|
| 差旅 | 1,280.50 | 高铁 |
| 餐饮 | 56 | **含酒水** |

正文段落不受影响。
EOF
"$DOC_CONVERT_PY" <repo>/skills/doc-convert/scripts/md_to_docx.py 样例.md -o 样例.docx
```

然后用 python-docx 读回验证（表格 1 张、3 行 3 列、金额列右对齐、单元格粗体生效），并 `open 样例.docx` 用 Pages/Word 肉眼确认边框与表头加粗正常。

- [ ] **Step 3: 数字推断端到端实测**

```bash
printf '项目,金额,发票号\n差旅,"1,200.50",24312000000123456789\n' > 台账.csv
"$DOC_CONVERT_PY" <repo>/skills/doc-convert/scripts/excel_csv.py 台账.csv -o 台账.xlsx
```
确认 stdout 出现两行中文报告；`open 台账.xlsx` 确认金额是数值（右对齐、无绿三角）、发票号是完整文本（无科学计数法）。

- [ ] **Step 4: typecheck 与工作区检查**

```bash
bun run typecheck   # 理论上不涉及 TS，跑一次确认没碰坏别处
git status          # 确认无未跟踪的运行产物（.part / 临时目录）混进来
```

- [ ] **Step 5: 核对 SKILL.md 一致性**

全文搜「表格」与「文本形式」：不得残留「塌成竖线」「数字以文本形式存储」的旧措辞；「脚本会拒绝干活的几种情况」表格补一行：

```markdown
| Markdown 表格某行列数多于表头 | `md_to_docx.py` | 报错并指出第几行、多了几列 | 把那一行改成与表头一致的列数再转，别删内容硬凑 |
```

有改动则：

```bash
git add skills/doc-convert/SKILL.md
git commit -m "docs(doc-convert): SKILL.md 拒绝清单补管道表格列数超限一行"
```
