"""pdf_ops 的行为契约。

页码全部按「人类习惯」：1 起、闭区间。这是唯一会被用户直接说出口的参数
（"删第 3 页"），如果内部 0 起而对外 1 起，转换层迟早错一页——所以对外
对内统一 1 起，只在调 pypdf 时减 1。
"""
import sys
from pathlib import Path

import pytest
from pypdf import PdfReader, PdfWriter

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import pdf_ops  # noqa: E402


def _make_pdf(path: Path, pages: int) -> None:
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=200, height=200)
    with path.open("wb") as f:
        w.write(f)


def test_merge_concatenates_in_order(tmp_path):
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    _make_pdf(a, 2)
    _make_pdf(b, 3)
    dst = tmp_path / "out.pdf"

    pdf_ops.merge([a, b], dst)

    assert len(PdfReader(str(dst)).pages) == 5


def test_split_one_file_per_page(tmp_path):
    src = tmp_path / "s.pdf"
    _make_pdf(src, 3)
    out_dir = tmp_path / "parts"

    written = pdf_ops.split(src, out_dir)

    assert len(written) == 3
    assert sorted(p.name for p in written) == ["s_01.pdf", "s_02.pdf", "s_03.pdf"]
    assert all(len(PdfReader(str(p)).pages) == 1 for p in written)


def test_split_by_ranges(tmp_path):
    src = tmp_path / "s.pdf"
    _make_pdf(src, 5)
    out_dir = tmp_path / "parts"

    written = pdf_ops.split(src, out_dir, ranges="1-2,4-5")

    assert len(written) == 2
    assert len(PdfReader(str(written[0])).pages) == 2
    assert len(PdfReader(str(written[1])).pages) == 2


def test_delete_pages_is_one_based(tmp_path):
    src = tmp_path / "d.pdf"
    _make_pdf(src, 4)
    dst = tmp_path / "d-out.pdf"

    pdf_ops.delete(src, dst, "2,4")

    assert len(PdfReader(str(dst)).pages) == 2


def test_out_of_range_page_exits_with_message(tmp_path, capsys):
    src = tmp_path / "e.pdf"
    _make_pdf(src, 2)
    with pytest.raises(SystemExit):
        pdf_ops.delete(src, tmp_path / "e-out.pdf", "5")
    assert "超出范围" in capsys.readouterr().err


def test_watermark_keeps_page_count(tmp_path):
    src = tmp_path / "w.pdf"
    _make_pdf(src, 3)
    stamp = tmp_path / "stamp.pdf"
    _make_pdf(stamp, 1)
    dst = tmp_path / "w-out.pdf"

    pdf_ops.watermark(src, dst, stamp)

    assert len(PdfReader(str(dst)).pages) == 3
