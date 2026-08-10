#!/usr/bin/env python3
"""PDF 页级操作：合并 / 拆分 / 删页 / 加水印。

**页码一律 1 起、闭区间**，对内对外一致，只在调 pypdf 时减 1。理由：这是
唯一会被用户直接说出口的参数（"把第 3 页删掉"），内外不一致的话，中间任何
一层忘了换算就错一页，而且错得很安静——PDF 少一页没人会立刻发现。

拆分默认「一页一个文件」；给了 --ranges 就按区间切。两种模式共用一个子命令
而不是拆两个，是因为用户嘴里说的都是"拆开"，区别只是"怎么拆"。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.errors import FileNotDecryptedError


def _open_reader(path: Path) -> PdfReader:
    """打开 PDF 文件并检查加密状态。

    评审后加固：如果 PDF 被加密（例如有读密码），pypdf 在访问 pages 时会抛
    FileNotDecryptedError。统一检查和转为友好错误信息，而不是让上层 AI 看到
    裸异常堆栈。

    选择 catch FileNotDecryptedError（而非 is_encrypted 属性检查）的理由：
    pypdf 对"有无密码"和"是否解密"的区分比较细致，直接访问会更可靠地捕捉
    真实的操作障碍。
    """
    try:
        reader = PdfReader(str(path))
        # 主动访问 pages 以触发加密异常，如果有密码保护会在此抛出
        _ = len(reader.pages)
        return reader
    except FileNotDecryptedError:
        print(
            f"[doc-convert] 错误：PDF 「{path}」被密码保护，本工具无法处理。"
            "请先用阅读器去掉密码再试。",
            file=sys.stderr,
        )
        raise SystemExit(2)
    except Exception as e:
        print(
            f"[doc-convert] 错误：打开 PDF 「{path}」失败：{e}",
            file=sys.stderr,
        )
        raise SystemExit(2)


def _parse_pages(spec: str, total: int) -> list[int]:
    """把 "1,3-5" 解析成 1 起的页码列表，去重并排序。越界即报错退出。"""
    pages: set[int] = set()
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        if "-" in chunk:
            a, _, b = chunk.partition("-")
            try:
                start, end = int(a), int(b)
            except ValueError:
                print(f"[doc-convert] 错误：看不懂页码区间「{chunk}」", file=sys.stderr)
                raise SystemExit(2)
            if start > end:
                start, end = end, start
            pages.update(range(start, end + 1))
        else:
            try:
                pages.add(int(chunk))
            except ValueError:
                print(f"[doc-convert] 错误：看不懂页码「{chunk}」", file=sys.stderr)
                raise SystemExit(2)

    bad = [p for p in sorted(pages) if p < 1 or p > total]
    if bad:
        print(
            f"[doc-convert] 错误：页码 {bad} 超出范围，该文件共 {total} 页。",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return sorted(pages)


def _write(writer: PdfWriter, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    with dst.open("wb") as f:
        writer.write(f)


def merge(inputs: list[Path], dst: Path) -> None:
    # Important 3 加固：检查空列表，防止静默生成 0 页 PDF
    if not inputs:
        print("[doc-convert] 错误：合并列表为空，没有文件要合并。", file=sys.stderr)
        raise SystemExit(2)

    writer = PdfWriter()
    for path in inputs:
        if not path.is_file():
            print(f"[doc-convert] 错误：找不到 {path}", file=sys.stderr)
            raise SystemExit(2)
        reader = _open_reader(path)
        for page in reader.pages:
            writer.add_page(page)
    _write(writer, dst)


def split(src: Path, out_dir: Path, ranges: str | None = None) -> list[Path]:
    reader = _open_reader(src)
    total = len(reader.pages)
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []

    if ranges is None:
        # 一页一个文件。序号补零到两位，保证文件管理器里按名排序＝按页排序
        # （不补零时 s_10.pdf 会排在 s_2.pdf 前面）。
        width = max(2, len(str(total)))
        for i in range(total):
            writer = PdfWriter()
            writer.add_page(reader.pages[i])
            dst = out_dir / f"{src.stem}_{str(i + 1).zfill(width)}.pdf"
            _write(writer, dst)
            written.append(dst)
        return written

    for idx, chunk in enumerate(ranges.split(","), start=1):
        pages = _parse_pages(chunk, total)
        writer = PdfWriter()
        for p in pages:
            writer.add_page(reader.pages[p - 1])
        dst = out_dir / f"{src.stem}_part{idx}.pdf"
        _write(writer, dst)
        written.append(dst)
    return written


def delete(src: Path, dst: Path, pages_spec: str) -> None:
    reader = _open_reader(src)
    total = len(reader.pages)
    drop = set(_parse_pages(pages_spec, total))
    writer = PdfWriter()
    for i in range(total):
        if i + 1 not in drop:
            writer.add_page(reader.pages[i])
    if not writer.pages:
        print("[doc-convert] 错误：删完就一页不剩了，拒绝生成空 PDF。", file=sys.stderr)
        raise SystemExit(2)
    _write(writer, dst)


def watermark(src: Path, dst: Path, stamp_pdf: Path) -> None:
    """把 stamp_pdf 的第一页叠加到 src 每一页上。

    水印用「另一份 PDF 的第一页」而不是让脚本自己画文字：画文字要处理中文
    字体、字号、旋转、透明度，是一整套排版活；而用户/模型完全可以先用别的
    方式做出一张水印页再叠上来，职责更干净。
    """
    # Important 1 加固：检查水印源是否为 0 页，避免 IndexError
    stamp_reader = _open_reader(stamp_pdf)
    if len(stamp_reader.pages) == 0:
        print(
            f"[doc-convert] 错误：水印 PDF 「{stamp_pdf}」为空（0 页），无法提取水印。",
            file=sys.stderr,
        )
        raise SystemExit(2)

    stamp = stamp_reader.pages[0]
    reader = _open_reader(src)
    writer = PdfWriter()
    for page in reader.pages:
        page.merge_page(stamp)
        writer.add_page(page)
    _write(writer, dst)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="PDF 合并 / 拆分 / 删页 / 加水印")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("merge", help="按给定顺序合并多个 PDF")
    p.add_argument("inputs", nargs="+")
    p.add_argument("-o", "--output", required=True)

    p = sub.add_parser("split", help="拆分 PDF（默认一页一个文件）")
    p.add_argument("input")
    p.add_argument("-d", "--out-dir", required=True)
    p.add_argument("--ranges", default=None, help='如 "1-2,4-5"，每个区间一个文件')

    p = sub.add_parser("delete", help="删除指定页")
    p.add_argument("input")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--pages", required=True, help='如 "2,4-6"，页码 1 起')

    p = sub.add_parser("watermark", help="把一张水印页叠到每一页上")
    p.add_argument("input")
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--stamp", required=True, help="水印 PDF（取其第一页）")

    args = ap.parse_args(argv)

    if args.cmd == "merge":
        merge([Path(x) for x in args.inputs], Path(args.output))
        print(f"[doc-convert] 已生成 {args.output}")
    elif args.cmd == "split":
        written = split(Path(args.input), Path(args.out_dir), args.ranges)
        print(f"[doc-convert] 已生成 {len(written)} 个文件于 {args.out_dir}")
    elif args.cmd == "delete":
        delete(Path(args.input), Path(args.output), args.pages)
        print(f"[doc-convert] 已生成 {args.output}")
    elif args.cmd == "watermark":
        watermark(Path(args.input), Path(args.output), Path(args.stamp))
        print(f"[doc-convert] 已生成 {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
