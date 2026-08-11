"""pdf_render 的行为契约。

页码语义必须和 PR 1 的 pdf_ops.py 完全一致（1 起、闭区间、越界报总页数），
否则同一个技能里两套页码规则，用户说「第 3 页」会得到两种结果。
"""
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import pdf_render  # noqa: E402


def _pdf(path: Path, pages: int = 3) -> Path:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
    c = canvas.Canvas(str(path), pagesize=A4)
    for i in range(pages):
        c.drawString(72, 720, f"page {i + 1}")
        c.showPage()
    c.save()
    return path


def test_parse_pages_is_one_based_and_inclusive():
    assert pdf_render.parse_pages("1,3-5", 10) == [1, 3, 4, 5]


def test_parse_pages_rejects_out_of_range_with_total(capsys):
    with pytest.raises(SystemExit):
        pdf_render.parse_pages("1-5", 3)
    err = capsys.readouterr().err
    assert "共 3 页" in err


def test_render_writes_one_png_per_page(tmp_path):
    src = _pdf(tmp_path / "a.pdf")
    outs = pdf_render.render(src, [1, 3], tmp_path / "png", pdf_render.SCALE_DEFAULT)
    assert [p.name for p in outs] == ["page-0001.png", "page-0003.png"]
    assert all(p.stat().st_size > 0 for p in outs)


def test_scale_above_max_is_refused_in_chinese(tmp_path):
    src = _pdf(tmp_path / "b.pdf", pages=1)
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_render.py"), str(src),
         "--pages", "1", "-d", str(tmp_path / "out"), "--scale", "9"],
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert "[doc-convert] 错误：" in proc.stderr
    assert "Traceback" not in proc.stderr


def test_cli_default_renders_all_pages(tmp_path):
    src = _pdf(tmp_path / "c.pdf", pages=2)
    outdir = tmp_path / "out"
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_render.py"), str(src), "-d", str(outdir)],
        capture_output=True, text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert sorted(p.name for p in outdir.glob("*.png")) == ["page-0001.png", "page-0002.png"]


def test_mkdir_failure_is_reported_in_chinese(tmp_path, monkeypatch):
    """outdir.mkdir() 失败（如磁盘满/权限拒绝）必须转中文错误，不能裸 Traceback。"""
    src = _pdf(tmp_path / "d.pdf", pages=1)

    def _boom(self, *a, **kw):
        raise OSError("no space left on device")

    monkeypatch.setattr(Path, "mkdir", _boom)
    with pytest.raises(SystemExit):
        pdf_render.render(src, [1], tmp_path / "png", pdf_render.SCALE_DEFAULT)


def test_save_failure_is_reported_in_chinese_via_cli(tmp_path):
    """PNG 保存失败（如目标路径被同名目录占用）必须转中文错误、非零退出、无 Traceback。"""
    src = _pdf(tmp_path / "e.pdf", pages=1)
    outdir = tmp_path / "out"
    outdir.mkdir(parents=True)
    # 让目标文件名被一个同名目录占据，PIL 的 save() 会因此失败
    (outdir / "page-0001.png").mkdir()
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS / "pdf_render.py"), str(src),
         "--pages", "1", "-d", str(outdir)],
        capture_output=True, text=True,
    )
    assert proc.returncode != 0
    assert "[doc-convert] 错误：" in proc.stderr
    assert "Traceback" not in proc.stderr
    # 顺手项：这条错误消息此前没有任何测试守着——只锁子串，不锁全句
    # （同 test_img_prep.py 的 "最兼容" / test_docx_to_pdf.py 的 "关掉"）。
    assert "跳过" in proc.stderr


def test_open_document_reports_password_protection_in_chinese(tmp_path, capsys):
    """评审 Important 1：加密探测要靠 pypdfium2 的 err_code 类型化信号，
    不是靠猜英文措辞——用 pypdf 现造一份真正带密码的 PDF 来验证。"""
    from pypdf import PdfReader, PdfWriter

    src = _pdf(tmp_path / "i.pdf", pages=1)
    reader = PdfReader(str(src))
    writer = PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    writer.encrypt(user_password="secret")
    enc = tmp_path / "enc.pdf"
    with enc.open("wb") as f:
        writer.write(f)

    with pytest.raises(SystemExit):
        pdf_render.open_document(enc)
    err = capsys.readouterr().err
    assert "密码保护" in err


def test_main_wraps_unexpected_exception_from_render(tmp_path, monkeypatch, capsys):
    """评审 Important 2：main() 的兜底 except Exception 之前零覆盖——
    render() 内部的 _die() 抛 SystemExit，根本到不了外层的 except Exception。
    这里让 render 抛一个普通异常，专门测外层兜底本身。"""
    src = _pdf(tmp_path / "j.pdf", pages=1)

    def _boom(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(pdf_render, "render", _boom)
    with pytest.raises(SystemExit):
        pdf_render.main([str(src), "-d", str(tmp_path / "out")])
    err = capsys.readouterr().err
    assert "[doc-convert] 错误：" in err
    assert "Traceback" not in err


def test_render_cleans_up_partial_files_on_mid_batch_failure(tmp_path, monkeypatch):
    """评审顺手项：多页渲染中途失败必须清理已写出的部分文件，不能留半成品
    目录——用户/模型看到一半的 PNG 容易误判成「已经渲完了」。"""
    from PIL import Image

    src = _pdf(tmp_path / "k.pdf", pages=3)
    outdir = tmp_path / "png"
    orig_save = Image.Image.save
    calls = {"n": 0}

    def _flaky_save(self, fp, *a, **kw):
        calls["n"] += 1
        if calls["n"] == 3:
            raise OSError("disk full")
        return orig_save(self, fp, *a, **kw)

    monkeypatch.setattr(Image.Image, "save", _flaky_save)
    with pytest.raises(SystemExit):
        pdf_render.render(src, [1, 2, 3], outdir, pdf_render.SCALE_DEFAULT)
    # 前两页已经落盘，第三页失败——清理逻辑要把前两页也删掉，不留半成品。
    assert list(outdir.glob("*.png")) == []


def test_render_removes_failed_pages_own_partial_file(tmp_path, monkeypatch, capsys):
    """二次评审加固：清理不能只删 written 列表里「已成功保存」的页，还要删
    「当前正在失败的这一页自己」写出的半成品。PIL 的 save() 是直接打开目标
    路径写、不是先写临时文件再 rename，真实磁盘写满时会先落几个字节再抛
    异常，遗留一个几十字节的假 PNG——这个文件从没被 append 进 written，
    旧的清理逻辑漏掉了它。同时验证：清理不会误删目录里预置的无关旧文件。"""
    from PIL import Image

    src = _pdf(tmp_path / "l.pdf", pages=1)
    outdir = tmp_path / "png"
    outdir.mkdir(parents=True)
    stale = outdir / "page-0009.png"
    stale.write_bytes(b"pretend-old-png")

    def _flaky_save(self, fp, *a, **kw):
        # 模拟磁盘写满：save() 先把目标文件打开并写入了几个字节，再抛异常。
        Path(fp).write_bytes(b"\x89PNG\r\n\x1a\nPARTIAL")
        raise OSError("no space left on device")

    monkeypatch.setattr(Image.Image, "save", _flaky_save)
    with pytest.raises(SystemExit):
        pdf_render.render(src, [1], outdir, pdf_render.SCALE_DEFAULT)

    assert not (outdir / "page-0001.png").exists()
    assert stale.exists()
    assert stale.read_bytes() == b"pretend-old-png"
    # 顺手项：written 在这里是空的（失败页自己没被 append），之前的计数
    # 只报 len(written)=0——但实际清理了 1 个文件（失败页自己的半成品）。
    err = capsys.readouterr().err
    assert "已清理本次产生的 1 个部分文件" in err
