"""doc_text 的行为契约。

最要紧的是体检报告，尤其 scanned 判定：长文档提炼最大的风险不是总结得不好，
是模型只读了前面一小截就开始总结、而且它不会告诉你。取料时就把「多少页、
多少字、哪几页是扫描的」摊在台面上，agent 才有依据决定分不分块、走不走 OCR。
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import doc_text  # noqa: E402


def _text_pdf(path: Path, pages: int = 2) -> Path:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    c = canvas.Canvas(str(path), pagesize=A4)
    for i in range(pages):
        c.drawString(72, 720, f"This is page {i + 1} with enough text to look real. " * 4)
        c.showPage()
    c.save()
    return path


def _image_only_pdf(path: Path, tmp_path: Path) -> Path:
    """造一份「扫描件」：整页只有一张图，没有任何文字层。"""
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    img = tmp_path / "blank.png"
    Image.new("RGB", (800, 1100), (240, 240, 240)).save(img)
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawImage(str(img), 0, 0, width=A4[0], height=A4[1])
    c.showPage()
    c.save()
    return path


def _docx(path: Path) -> Path:
    from docx import Document
    d = Document()
    d.add_paragraph("第一段内容")
    d.add_paragraph("第二段内容")
    d.save(str(path))
    return path


def test_text_pdf_is_not_scanned(tmp_path):
    units, kind = doc_text.extract(_text_pdf(tmp_path / "a.pdf"))
    report = doc_text.checkup(units, kind)
    assert kind == "pdf"
    assert report["units"] == 2
    assert report["scanned"] is False
    assert report["scanned_units"] == []


def test_image_only_pdf_is_flagged_scanned(tmp_path):
    units, kind = doc_text.extract(_image_only_pdf(tmp_path / "s.pdf", tmp_path))
    report = doc_text.checkup(units, kind)
    assert report["scanned"] is True
    assert report["scanned_units"] == [1]


def test_docx_units_are_paragraphs(tmp_path):
    units, kind = doc_text.extract(_docx(tmp_path / "a.docx"))
    assert kind == "docx"
    assert units == ["第一段内容", "第二段内容"]


def test_legacy_doc_is_refused_in_chinese(tmp_path):
    old = tmp_path / "old.doc"
    old.write_bytes(b"\xd0\xcf\x11\xe0")
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "doc_text.py"), str(old), "--outdir", str(tmp_path)],
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert "另存为" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_cli_writes_text_file_with_page_anchors(tmp_path):
    src = _text_pdf(tmp_path / "b.pdf", pages=3)
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "doc_text.py"), str(src), "--outdir", str(tmp_path)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    body = Path(report["text_file"]).read_text(encoding="utf-8")
    assert "[P1]" in body and "[P3]" in body


def test_cli_docx_uses_paragraph_anchors(tmp_path):
    src = _docx(tmp_path / "c.docx")
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "doc_text.py"), str(src), "--outdir", str(tmp_path)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    body = Path(json.loads(proc.stdout)["text_file"]).read_text(encoding="utf-8")
    assert "[§1] 第一段内容" in body


# --- 以下两条是本 PR 的补充要求：main() 的兜底防线不能只靠零散 try/except，
# 写盘调用（mkdir / write_text）失败必须转成中文错误，不能把裸 Traceback
# 甩给用户。用 monkeypatch 强制这两个调用抛异常，而不是真的填满磁盘或
# 改权限——那样在 CI 环境里既不稳定也不方便清理。

def test_mkdir_failure_gives_chinese_message_not_traceback(tmp_path, monkeypatch, capsys):
    src = _text_pdf(tmp_path / "a.pdf")

    def _boom(self, parents=True, exist_ok=True):
        raise OSError("模拟的目录创建失败")

    monkeypatch.setattr(Path, "mkdir", _boom)
    with pytest.raises(SystemExit) as exc:
        doc_text.main([str(src), "--outdir", str(tmp_path / "out")])
    assert exc.value.code != 0
    captured = capsys.readouterr()
    assert "[doc-convert] 错误：" in captured.err
    assert "Traceback" not in captured.err


def test_write_text_failure_gives_chinese_message_not_traceback(tmp_path, monkeypatch, capsys):
    src = _text_pdf(tmp_path / "a.pdf")

    def _boom(self, *args, **kwargs):
        raise OSError("模拟的磁盘写入失败")

    monkeypatch.setattr(Path, "write_text", _boom)
    with pytest.raises(SystemExit) as exc:
        doc_text.main([str(src), "--outdir", str(tmp_path)])
    assert exc.value.code != 0
    captured = capsys.readouterr()
    assert "[doc-convert] 错误：" in captured.err
    assert "Traceback" not in captured.err
