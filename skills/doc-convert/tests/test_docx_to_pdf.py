"""docx_to_pdf 的行为契约。

重点全在「没装 LibreOffice 时会发生什么」——那是绝大多数用户的处境。
"""
import sys
from pathlib import Path

import pytest
from docx import Document
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import docx_to_pdf  # noqa: E402


def _make_docx(path: Path) -> None:
    doc = Document()
    doc.add_heading("季度汇报", level=1)
    doc.add_paragraph("这是一段中文正文，用来验证字体没有变成方块。")
    doc.save(str(path))


def test_refuses_textonly_without_explicit_flag(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(docx_to_pdf, "find_soffice", lambda: None)
    src = tmp_path / "a.docx"
    _make_docx(src)

    with pytest.raises(SystemExit) as e:
        docx_to_pdf.convert(src, tmp_path / "a.pdf", allow_textonly=False)

    assert e.value.code != 0
    err = capsys.readouterr().err
    # 报错必须同时说清：为什么不能转、装什么能解决、怎么强行继续
    assert "LibreOffice" in err
    assert "--allow-textonly" in err
    assert "排版" in err


def test_textonly_path_produces_pdf_when_allowed(tmp_path, monkeypatch):
    monkeypatch.setattr(docx_to_pdf, "find_soffice", lambda: None)
    src = tmp_path / "b.docx"
    _make_docx(src)
    dst = tmp_path / "b.pdf"

    mode = docx_to_pdf.convert(src, dst, allow_textonly=True)

    assert mode == "textonly"
    assert dst.is_file()
    assert len(PdfReader(str(dst)).pages) >= 1


def test_textonly_refuses_when_no_cjk_font(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(docx_to_pdf, "find_soffice", lambda: None)
    monkeypatch.setattr(docx_to_pdf, "find_cjk_font", lambda: None)
    src = tmp_path / "c.docx"
    _make_docx(src)

    with pytest.raises(SystemExit):
        docx_to_pdf.convert(src, tmp_path / "c.pdf", allow_textonly=True)

    # 没有中文字体时输出的是满纸方块，不如不给
    assert "中文字体" in capsys.readouterr().err


def test_find_cjk_font_returns_existing_file_or_none():
    font = docx_to_pdf.find_cjk_font()
    assert font is None or font.is_file()
