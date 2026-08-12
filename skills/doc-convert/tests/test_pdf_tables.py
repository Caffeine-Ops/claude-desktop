"""pdf_tables 的行为契约。

最要紧的一条：脚本抽出来的数字必须与源文件逐字一致。这是整条「PDF 表格转
Excel」路线的立身之本——模型只准改结构不准改数字，前提就是脚本读的数字是
从文件坐标里直接读出来的、不是认出来的。这条断言一旦松掉，整条纪律就空了。
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import pdf_tables  # noqa: E402


def _table_pdf(path: Path) -> Path:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle
    data = [["Item", "Q1", "Q2"],
            ["Revenue", "1200.50", "1310.25"],
            ["Cost", "800.00", "910.10"]]
    t = Table(data)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)]))
    SimpleDocTemplate(str(path), pagesize=A4).build([t])
    return path


def _no_table_pdf(path: Path) -> Path:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawString(72, 720, "Just a paragraph of prose, no tables here at all. " * 3)
    c.showPage()
    c.save()
    return path


def _scanned_pdf(path: Path, tmp_path: Path) -> Path:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    img = tmp_path / "page.png"
    Image.new("RGB", (800, 1100), (245, 245, 245)).save(img)
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawImage(str(img), 0, 0, width=A4[0], height=A4[1])
    c.showPage()
    c.save()
    return path


def _sparse_table_pdf(path: Path) -> Path:
    """页面整体文字层稀薄（远低于 SCANNED_CHARS_PER_PAGE 阈值），但确实画了
    一张带线框的表格——评审实测能真实发生的组合：scanned 判定只看整页字符数，
    跟"这页有没有表格"是两件独立的事。用来验证 scanned=True 且 tables 非空时，
    stdout 不能再打印"抽不到表格数据"这句自相矛盾的提示（这正是脚本判断条件
    从 `if result["scanned"]` 改成 `if not result["tables"]` 要守住的分支）。
    """
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    from reportlab.platypus import Table, TableStyle
    c = canvas.Canvas(str(path), pagesize=A4)
    w, h = A4
    t = Table([["Total", "72.50"]], colWidths=[100, 100])
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 1, colors.black)]))
    t.wrapOn(c, w, h)
    t.drawOn(c, 72, h - 150)
    c.showPage()
    c.save()
    return path


def test_numbers_are_extracted_verbatim(tmp_path):
    out = tmp_path / "t.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_tables.py"), str(_table_pdf(tmp_path / "a.pdf")),
         "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    rows = data["tables"][0]["rows"]
    assert rows[1] == ["Revenue", "1200.50", "1310.25"]
    assert data["scanned"] is False


def test_no_table_in_text_pdf_is_refused(tmp_path):
    out = tmp_path / "t.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_tables.py"),
         str(_no_table_pdf(tmp_path / "b.pdf")), "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert "没找到表格" in proc.stderr
    assert not out.exists(), "拒绝时不能留下半成品 JSON"
    assert "Traceback" not in proc.stderr


def test_scanned_pdf_exits_zero_and_flags_scanned(tmp_path):
    """扫描件没有文字层不是错误，是需要 agent 改走看图路线的信号。"""
    out = tmp_path / "t.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_tables.py"),
         str(_scanned_pdf(tmp_path / "c.pdf", tmp_path)), "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["scanned"] is True
    assert data["tables"] == []


# --- 补充：stdout 提示文案的分支覆盖。评审第二轮实测发现原来的判断条件
# `if result["scanned"]:` 会在"scanned=True 但 tables 非空"这个真实会发生的
# 组合下打印一句和刚生成的 JSON 内容自相矛盾的话——数字明明是坐标直读的，
# 提示却说"抽不到表格数据"。改成 `if not result["tables"]:` 后修复，但之前
# 没有任何测试断言过这行 stdout 文案，这个分支是零覆盖的：下次有人手滑把
# 条件改回 `if result["scanned"]:`，不会被任何测试抓到。这两条测试专门堵住
# 这个坑，各自对应 tables 非空/为空两种情况。

def test_scanned_but_tables_found_does_not_print_misleading_hint(tmp_path):
    """scanned=True 且 tables 非空：数字仍是坐标直读、逐字准确，
    stdout 不能再说"抽不到表格数据"——那是自相矛盾的。"""
    out = tmp_path / "t.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_tables.py"),
         str(_sparse_table_pdf(tmp_path / "h.pdf")), "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["scanned"] is True
    assert data["tables"] != []
    assert "抽不到表格数据" not in proc.stdout


def test_scanned_with_no_tables_still_prints_hint(tmp_path):
    """真扫描件（纯图片页，没有文字层也没有表格）：这句提示还是必须打印，
    它是 agent 改走看图识别路线的信号，不能因为这次改动被连带删掉。"""
    out = tmp_path / "t.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_tables.py"),
         str(_scanned_pdf(tmp_path / "j.pdf", tmp_path)), "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["scanned"] is True
    assert data["tables"] == []
    assert "抽不到表格数据" in proc.stdout


def test_scanned_scope_reflects_pages_filter(tmp_path):
    """[Minor 9] scanned 只按 --pages 选中的那几页算，却和 total_pages（整份
    文档页数）并排放在同一个 JSON 里，容易被误读成整份文件的属性——
    `--pages "3-4"` 恰好点到两页插图，整份 PDF 就会被报成 scanned: true。
    加一个 scanned_scope 字段显式标出这次判定的作用域，不给读的人留猜的空间。
    """
    out = tmp_path / "t.json"
    # 不给 --pages：作用域应该是全文
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_tables.py"), str(_table_pdf(tmp_path / "k.pdf")),
         "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(out.read_text(encoding="utf-8"))["scanned_scope"] == "all_pages"

    # 给了 --pages：作用域应该是选中页，不是整份文档
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_tables.py"), str(_table_pdf(tmp_path / "k.pdf")),
         "--pages", "1", "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(out.read_text(encoding="utf-8"))["scanned_scope"] == "selected_pages"


def test_page_filter_is_honoured(tmp_path):
    out = tmp_path / "t.json"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_tables.py"), str(_table_pdf(tmp_path / "d.pdf")),
         "--pages", "1", "-o", str(out)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert json.loads(out.read_text(encoding="utf-8"))["tables"][0]["page"] == 1


# --- 补充：加密探测必须是类型判断，不是猜英文措辞。评审判定字符串匹配是
# Important 级缺陷——库升级改一句措辞，加密 PDF 就会滑进「文件可能已损坏」
# 的通用分支，用户看到答非所问的诊断。用 pypdf 现造一份真正带密码的 PDF，
# 不能凭记忆假设异常类型。

def test_open_reports_password_protection_in_chinese(tmp_path, capsys):
    """用 pypdf 现造加密 PDF 实测：pdfplumber.open() 对它抛出的是
    pdfplumber.utils.exceptions.PdfminerException，str(e) 是空的——原来的
    字符串匹配对这个包装类从来没生效过。真正管用的信号在 e.args[0]，那是
    被包了一层的原始异常，是 pdfminer.pdfdocument.PDFPasswordIncorrect，
    继承自 PDFEncryptionError。"""
    from pypdf import PdfReader, PdfWriter

    src = _no_table_pdf(tmp_path / "i.pdf")
    reader = PdfReader(str(src))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.encrypt(user_password="secret")
    enc = tmp_path / "enc.pdf"
    with enc.open("wb") as f:
        writer.write(f)

    with pytest.raises(SystemExit):
        pdf_tables._open(enc)
    err = capsys.readouterr().err
    assert "密码保护" in err


# --- 补充：main() 的兜底 except Exception 之前零覆盖。extract() 内部的
# _die() 抛 SystemExit，根本到不了外层的 except Exception；只测 _die 路径
# 测不到兜底本身，得让内部函数抛一个普通异常。

def test_main_wraps_unexpected_exception(tmp_path, monkeypatch, capsys):
    src = _table_pdf(tmp_path / "e.pdf")

    def _boom(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(pdf_tables, "extract", _boom)
    with pytest.raises(SystemExit) as exc:
        pdf_tables.main([str(src), "-o", str(tmp_path / "t.json")])
    assert exc.value.code != 0
    err = capsys.readouterr().err
    assert "[doc-convert] 错误：" in err
    assert "Traceback" not in err


# --- 补充：写盘点（mkdir / write_text）失败必须转中文错误，不能裸
# Traceback——同 pdf_render.py / doc_text.py 的纪律。用 monkeypatch 强制这
# 两个调用抛异常，而不是真的填满磁盘或改权限。

def test_mkdir_failure_gives_chinese_message_not_traceback(tmp_path, monkeypatch, capsys):
    src = _table_pdf(tmp_path / "f.pdf")

    def _boom(self, parents=True, exist_ok=True):
        raise OSError("模拟的目录创建失败")

    monkeypatch.setattr(Path, "mkdir", _boom)
    with pytest.raises(SystemExit) as exc:
        pdf_tables.main([str(src), "-o", str(tmp_path / "out" / "t.json")])
    assert exc.value.code != 0
    err = capsys.readouterr().err
    assert "[doc-convert] 错误：" in err
    assert "Traceback" not in err


def test_write_text_failure_gives_chinese_message_not_traceback(tmp_path, monkeypatch, capsys):
    src = _table_pdf(tmp_path / "g.pdf")

    def _boom(self, *a, **kw):
        raise OSError("模拟的磁盘写入失败")

    monkeypatch.setattr(Path, "write_text", _boom)
    with pytest.raises(SystemExit) as exc:
        pdf_tables.main([str(src), "-o", str(tmp_path / "t.json")])
    assert exc.value.code != 0
    err = capsys.readouterr().err
    assert "[doc-convert] 错误：" in err
    assert "Traceback" not in err
