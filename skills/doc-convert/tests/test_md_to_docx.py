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
