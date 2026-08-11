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
