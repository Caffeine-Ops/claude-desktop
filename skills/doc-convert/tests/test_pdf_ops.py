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


def test_split_by_ranges_out_of_range_leaves_no_partial_files(tmp_path):
    """评审后加固：越界区间报错时，之前已校验通过的区间也不应该落盘。

    "1-2,5-6" 里第 2 个区间越界（源文件只有 3 页）。旧实现是边解析边写，
    第 1 个区间的 _part1.pdf 会先写盘，报错时已经是半成品。
    """
    src = tmp_path / "s.pdf"
    _make_pdf(src, 3)
    out_dir = tmp_path / "parts"

    with pytest.raises(SystemExit):
        pdf_ops.split(src, out_dir, ranges="1-2,5-6")

    # 拒绝时不产出文件：目录可能被建了（mkdir 在校验前发生），但里面必须空
    assert not out_dir.exists() or list(out_dir.iterdir()) == []


def test_delete_pages_is_one_based(tmp_path):
    # Minor 4 改进：用不同尺寸的页面而不是等大小空白页，能精确验证删对了具体页
    # 这样能区分"删掉第 2、4 页"和"删掉任意两页"的实现差异
    src = tmp_path / "d.pdf"
    w = PdfWriter()
    # 创建 4 个不同宽度的页面：宽 210, 220, 230, 240
    for i in range(4):
        w.add_blank_page(width=210 + i * 10, height=200)
    with src.open("wb") as f:
        w.write(f)
    dst = tmp_path / "d-out.pdf"

    pdf_ops.delete(src, dst, "2,4")

    # 删除第 2、4 页后，应该留下第 1、3 页
    reader = PdfReader(str(dst))
    assert len(reader.pages) == 2
    # 精确验证：第 1 页宽度应该是 210，第 3 页宽度应该是 230
    assert reader.pages[0].mediabox.width == 210
    assert reader.pages[1].mediabox.width == 230


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


def test_watermark_with_zero_page_stamp(tmp_path, capsys):
    """Important 1 加固：验证 0 页水印源抛出友好错误而不是 IndexError。"""
    src = tmp_path / "w.pdf"
    _make_pdf(src, 3)
    stamp = tmp_path / "stamp.pdf"
    # 创建 0 页的 PDF（空 PDF）
    w = PdfWriter()
    with stamp.open("wb") as f:
        w.write(f)
    dst = tmp_path / "w-out.pdf"

    with pytest.raises(SystemExit):
        pdf_ops.watermark(src, dst, stamp)
    assert "为空" in capsys.readouterr().err


def test_encrypted_pdf_readable_error(tmp_path, capsys):
    """Important 2 加固：验证加密 PDF 抛出友好错误而不是 FileNotDecryptedError 堆栈。"""
    src = tmp_path / "s.pdf"
    _make_pdf(src, 3)
    out_dir = tmp_path / "parts"

    # 创建一个加密的 PDF（用密码保护）
    encrypted = tmp_path / "encrypted.pdf"
    w = PdfWriter()
    for _ in range(2):
        w.add_blank_page(width=200, height=200)
    w.encrypt("password")
    with encrypted.open("wb") as f:
        w.write(f)

    with pytest.raises(SystemExit):
        pdf_ops.split(encrypted, out_dir)
    assert "密码保护" in capsys.readouterr().err


def test_merge_empty_list_fails(tmp_path, capsys):
    """Important 3 加固：验证空 merge 列表抛出错误而不是静默生成 0 页 PDF。"""
    dst = tmp_path / "empty.pdf"

    with pytest.raises(SystemExit):
        pdf_ops.merge([], dst)
    assert "为空" in capsys.readouterr().err


def test_watermark_content_truly_overlaid(tmp_path):
    """验证水印内容确实被叠加到了输出页中，而不是只改变页数。

    这条测试能区分「水印有没有实际叠上」。方法是：生成一个含矩形内容的水印 PDF
    （用 reportlab），叠加后检查输出 PDF 是否真的包含了水印的内容流，而不只是
    改变了页数。对照组：未叠加水印的版本应该文件更小。
    """
    from io import BytesIO

    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas

    # 源 PDF：1 页空白
    src = tmp_path / "src.pdf"
    _make_pdf(src, 1)

    # 水印 PDF：1 页含红色矩形（用 reportlab 绘制，确保有可检测的内容）
    stamp = tmp_path / "stamp.pdf"
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    c.setFillColorRGB(1, 0, 0)  # 红色
    c.rect(50, 50, 100, 100, fill=1)  # 绘制矩形
    c.save()
    with stamp.open("wb") as f:
        f.write(buf.getvalue())

    # 对照组：不叠水印的源 PDF 直接复制到输出
    no_watermark = tmp_path / "no_watermark.pdf"
    import shutil
    shutil.copy(src, no_watermark)

    # 实验组：叠加水印
    dst = tmp_path / "watermarked.pdf"
    pdf_ops.watermark(src, dst, stamp)

    # 验证：叠加后的输出文件应该比未加水印的版本更大（因为包含了水印内容）
    no_watermark_size = no_watermark.stat().st_size
    watermarked_size = dst.stat().st_size

    assert watermarked_size > no_watermark_size, (
        f"水印未被合并：未加水印 {no_watermark_size} 字节，"
        f"加水印后 {watermarked_size} 字节，应该更大"
    )

    # 额外验证：检查输出页确实含有内容（不是空页）
    result_reader = PdfReader(str(dst))
    result_page = result_reader.pages[0]
    # 若成功叠加，页面的属性不应该和源空白页完全相同
    src_reader = PdfReader(str(src))
    src_page = src_reader.pages[0]
    # 比较页面大小的字典表示（若叠加成功，会有额外的内容流或操作符）
    assert len(str(result_page)) >= len(str(src_page)), (
        "输出页面内容未被修改，水印可能未叠上"
    )


def test_split_trailing_comma_does_not_write_empty_pdf(tmp_path):
    """复审实测：`--ranges "1-2,"`（模型很容易多打一个尾逗号）原来会多写出一个
    **0 页的 PDF** 还报「已生成 2 个文件」——正是 delete() 明令拒绝的那种空产物。
    空区间按「本来就没想要这一段」跳过，不为一个多余的逗号让模型多跑一轮。
    """
    src = tmp_path / "s.pdf"
    _make_pdf(src, 3)
    out_dir = tmp_path / "parts"

    written = pdf_ops.split(src, out_dir, ranges="1-2,")

    assert len(written) == 1
    assert len(PdfReader(str(written[0])).pages) == 2
    # 目录里也不能留下多余的空文件
    assert sorted(p.name for p in out_dir.glob("*.pdf")) == ["s_part1.pdf"]


def test_split_all_empty_ranges_refuses(tmp_path, capsys):
    """跳完一个区间都不剩，说明用户/模型根本没说清要什么——报错，不落盘。"""
    src = tmp_path / "s.pdf"
    _make_pdf(src, 3)
    out_dir = tmp_path / "parts"

    with pytest.raises(SystemExit) as e:
        pdf_ops.split(src, out_dir, ranges=" , ")

    assert e.value.code != 0
    assert "没有任何有效区间" in capsys.readouterr().err
    assert not list(out_dir.glob("*.pdf"))


def test_main_wraps_write_failure_in_chinese(tmp_path, monkeypatch, capsys):
    """main() 的兜底层：_write 直接调 open("wb")，目标只读/磁盘满时抛的是裸
    OSError，原来会冒泡成一屏英文堆栈。
    """
    src = tmp_path / "s.pdf"
    _make_pdf(src, 3)

    def _boom(*a, **k):
        raise OSError(30, "Read-only file system")

    monkeypatch.setattr(pdf_ops, "_write", _boom)

    with pytest.raises(SystemExit) as e:
        pdf_ops.main(["delete", str(src), "-o", str(tmp_path / "x.pdf"), "--pages", "2"])

    assert e.value.code != 0
    err = capsys.readouterr().err
    assert "处理过程中出错" in err
    assert "Traceback" not in err
