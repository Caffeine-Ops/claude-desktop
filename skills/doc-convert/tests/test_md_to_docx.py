"""md_to_docx 的行为契约。

只测「结构映射对不对」，不测排版细节——排版由 Word 默认样式决定，
断言它等于把 python-docx 的实现细节钉进测试里。
"""
import sys
from pathlib import Path

import pytest
from docx import Document

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import md_to_docx  # noqa: E402


def test_headings_paragraphs_and_bullets(tmp_path):
    src = tmp_path / "a.md"
    src.write_text(
        "# 标题一\n\n正文一段。\n\n- 项目甲\n- 项目乙\n\n## 标题二\n",
        encoding="utf-8",
    )
    dst = tmp_path / "a.docx"

    md_to_docx.convert(src, dst)

    doc = Document(str(dst))
    texts = [p.text for p in doc.paragraphs]
    styles = [p.style.name for p in doc.paragraphs]
    assert texts[:5] == ["标题一", "正文一段。", "项目甲", "项目乙", "标题二"]
    assert styles[0] == "Heading 1"
    assert styles[1] == "Normal"
    assert styles[2] == "List Bullet"
    assert styles[4] == "Heading 2"


def test_bold_and_italic_become_runs(tmp_path):
    src = tmp_path / "b.md"
    src.write_text("这是**重点**和*强调*。\n", encoding="utf-8")
    dst = tmp_path / "b.docx"

    md_to_docx.convert(src, dst)

    doc = Document(str(dst))
    runs = doc.paragraphs[0].runs
    assert "".join(r.text for r in runs) == "这是重点和强调。"
    assert any(r.bold and r.text == "重点" for r in runs)
    assert any(r.italic and r.text == "强调" for r in runs)


def test_fenced_code_block_kept_verbatim(tmp_path):
    src = tmp_path / "c.md"
    src.write_text("```\nline1\nline2\n```\n", encoding="utf-8")
    dst = tmp_path / "c.docx"

    md_to_docx.convert(src, dst)

    doc = Document(str(dst))
    # 代码块逐行成段，且不被行内标记解析（`*` 之类原样保留）
    assert [p.text for p in doc.paragraphs[:2]] == ["line1", "line2"]


def test_missing_input_exits_with_message(tmp_path, capsys):
    with pytest.raises(SystemExit) as e:
        md_to_docx.main([str(tmp_path / "nope.md"), "-o", str(tmp_path / "x.docx")])
    assert e.value.code != 0
    assert "找不到输入文件" in capsys.readouterr().err


def test_bom_prefixed_markdown_still_recognizes_heading(tmp_path):
    """复审实测：Windows 记事本 / VS Code 存 UTF-8 时会在文件开头塞三个不可见
    字节（BOM）。原来用 encoding="utf-8" 读，BOM 会留在首行变成 `\\ufeff# 标题`，
    匹配不上标题规则、被当普通正文默默写进 Word——exit 0，用户拿到的文档少了
    一级标题却毫无提示。
    """
    src = tmp_path / "bom.md"
    src.write_bytes("﻿# 标题一\n\n正文一段。\n".encode("utf-8"))
    dst = tmp_path / "bom.docx"

    md_to_docx.convert(src, dst)

    doc = Document(str(dst))
    assert doc.paragraphs[0].text == "标题一"
    assert doc.paragraphs[0].style.name == "Heading 1"


def test_gbk_markdown_is_readable(tmp_path):
    """中文 Windows 上另存的 .md 常是 GBK，原来直接抛 UnicodeDecodeError 英文堆栈。"""
    src = tmp_path / "gbk.md"
    src.write_bytes("# 中文标题\n\n中文正文。\n".encode("gbk"))
    dst = tmp_path / "gbk.docx"

    md_to_docx.convert(src, dst)

    doc = Document(str(dst))
    assert doc.paragraphs[0].text == "中文标题"
    assert doc.paragraphs[1].text == "中文正文。"


def test_undecodable_bytes_give_chinese_message(tmp_path, capsys):
    """UTF-8 与 GB18030 都解不了时要给中文提示，不是英文堆栈。"""
    src = tmp_path / "bad.md"
    src.write_bytes(b"\xff\xfe\x00# x\x00")  # UTF-16 开头，两种候选编码都解不通

    with pytest.raises(SystemExit) as e:
        md_to_docx.convert(src, tmp_path / "bad.docx")

    assert e.value.code != 0
    err = capsys.readouterr().err
    assert "编码" in err
    assert "Traceback" not in err


def test_main_wraps_unexpected_error_in_chinese(tmp_path, monkeypatch, capsys):
    """main() 的兜底层：doc.save() 遇到只读目录抛的裸 OSError 不能漏出去。"""
    src = tmp_path / "a.md"
    src.write_text("# 标题\n", encoding="utf-8")

    def _boom(*a, **k):
        raise OSError(30, "Read-only file system")

    monkeypatch.setattr(md_to_docx, "convert", _boom)

    with pytest.raises(SystemExit) as e:
        md_to_docx.main([str(src), "-o", str(tmp_path / "a.docx")])

    assert e.value.code != 0
    err = capsys.readouterr().err
    assert "处理过程中出错" in err
    assert "Traceback" not in err
