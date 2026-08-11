"""docx_to_pdf 的行为契约。

重点全在「没装 LibreOffice 时会发生什么」——那是绝大多数用户的处境。
"""
import subprocess
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
    dst = tmp_path / "a.pdf"

    with pytest.raises(SystemExit) as e:
        docx_to_pdf.convert(src, dst, allow_textonly=False)

    assert e.value.code != 0
    err = capsys.readouterr().err
    # 报错必须同时说清：为什么不能转、装什么能解决、怎么强行继续
    assert "LibreOffice" in err
    assert "--allow-textonly" in err
    assert "排版" in err
    # 门禁的承诺：拒绝时不产出任何文件
    assert not dst.exists()


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


def test_soffice_failure_gives_chinese_message_not_traceback(tmp_path, monkeypatch, capsys):
    """评审后加固：soffice 崩溃/超时不能让 CalledProcessError 堆栈冒泡出去。

    最容易触发这条的场景是用户桌面正开着 LibreOffice，无头模式抢不到配置锁——
    这恰好是本技能默认主路径（装了 LibreOffice 就走这条），所以必须给中文提示。
    """
    monkeypatch.setattr(docx_to_pdf, "find_soffice", lambda: "/usr/bin/fake-soffice")

    def _boom(*args, **kwargs):
        raise subprocess.CalledProcessError(
            1, ["fake-soffice"], output=b"", stderr=b"some LibreOffice internal error\nsecond line"
        )

    monkeypatch.setattr(docx_to_pdf.subprocess, "run", _boom)
    src = tmp_path / "a.docx"
    _make_docx(src)
    dst = tmp_path / "a.pdf"

    with pytest.raises(SystemExit) as e:
        docx_to_pdf.convert(src, dst, allow_textonly=False)

    assert e.value.code != 0
    err = capsys.readouterr().err
    assert "LibreOffice" in err
    assert "关掉" in err  # 提醒"如果正开着，先关掉再试"
    assert not dst.exists()


def test_soffice_timeout_gives_chinese_message(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(docx_to_pdf, "find_soffice", lambda: "/usr/bin/fake-soffice")

    def _boom(*args, **kwargs):
        raise subprocess.TimeoutExpired(["fake-soffice"], 300)

    monkeypatch.setattr(docx_to_pdf.subprocess, "run", _boom)
    src = tmp_path / "a.docx"
    _make_docx(src)
    dst = tmp_path / "a.pdf"

    with pytest.raises(SystemExit):
        docx_to_pdf.convert(src, dst, allow_textonly=False)

    err = capsys.readouterr().err
    assert "超时" in err or "卡住" in err


def test_doc_legacy_format_gives_chinese_message_on_textonly_path(tmp_path, monkeypatch, capsys):
    """评审后加固：.doc（旧二进制格式）走纯文字兜底时，python-docx 打不开会抛
    PackageNotFoundError，不能让它冒泡成英文堆栈——必须提示用户另存为 .docx。
    """
    monkeypatch.setattr(docx_to_pdf, "find_soffice", lambda: None)
    src = tmp_path / "legacy.doc"
    # 假装是一份旧版二进制 .doc：随便写点非 zip 内容，python-docx 打不开
    src.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1not a real doc file")
    dst = tmp_path / "legacy.pdf"

    with pytest.raises(SystemExit):
        docx_to_pdf.convert(src, dst, allow_textonly=True)

    err = capsys.readouterr().err
    assert "另存为" in err
    assert not dst.exists()


def test_empty_paragraph_document_refuses_textonly(tmp_path, monkeypatch, capsys):
    # 空段落文档（只有换行没有文字）应该被拒绝，不能静默产出空白 PDF
    monkeypatch.setattr(docx_to_pdf, "find_soffice", lambda: None)
    src = tmp_path / "d.docx"
    doc = Document()
    doc.add_paragraph("")  # 纯空段落
    doc.add_paragraph("")
    doc.add_paragraph("")
    doc.save(str(src))
    dst = tmp_path / "d.pdf"

    with pytest.raises(SystemExit):
        docx_to_pdf.convert(src, dst, allow_textonly=True)

    # 拒绝时不产出文件
    assert not dst.exists()
    assert "没有可提取的文字" in capsys.readouterr().err
