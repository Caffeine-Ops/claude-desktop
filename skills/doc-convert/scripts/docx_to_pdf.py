#!/usr/bin/env python3
"""Word（.docx）→ PDF。

**这条路没有"又快又准"的纯 Python 方案**，所以是两条路 + 一道门禁：

  路 1（首选）：本机装了 LibreOffice → 调它无头转换，保真度等同本机另存为。
  路 2（兜底）：没装 → 用 reportlab 重排成**纯文字 PDF**，表格 / 图片 /
                样式 / 分栏 全部丢失。

门禁：路 2 必须由调用方显式传 --allow-textonly 才走，否则直接报错退出。
为什么做成开关而不是"转完加一行提示"——提示会被模型和用户一起略过，
用户拿着丢了表格的标书去投标，发现时已经晚了。降级本身可以接受，
**不知情的降级不行**。

中文字体：reportlab 默认字体没有 CJK 字形，不注册字体的话中文全是方块。
所以兜底路会去系统字体目录找一个可用的中文字体；一个都找不到就同样拒绝
输出——满纸方块的 PDF 比没有 PDF 更糟。
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

from docx import Document
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

# 候选中文字体，按「几乎一定存在」排在前面。.ttc 是字体集合，reportlab 需要
# subfontIndex 指定取其中第几个；.ttf 直接用。
_CJK_FONT_CANDIDATES: list[tuple[str, int]] = [
    # macOS
    ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", 0),
    ("/System/Library/Fonts/PingFang.ttc", 0),
    ("/System/Library/Fonts/Hiragino Sans GB.ttc", 0),
    # Windows
    ("C:/Windows/Fonts/msyh.ttc", 0),
    ("C:/Windows/Fonts/simsun.ttc", 0),
    # Linux
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
]

_FONT_NAME = "DocConvertCJK"


def find_soffice() -> str | None:
    """找 LibreOffice 的无头可执行文件；没有返回 None。"""
    found = shutil.which("soffice") or shutil.which("libreoffice")
    if found:
        return found
    # macOS 装了 LibreOffice.app 但没把 soffice 加进 PATH 是常态
    mac_default = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
    if Path(mac_default).is_file():
        return mac_default
    return None


def find_cjk_font() -> Path | None:
    """找一个能显示中文的字体文件；没有返回 None。"""
    for path, _idx in _CJK_FONT_CANDIDATES:
        p = Path(path)
        if p.is_file():
            return p
    return None


def _convert_with_soffice(soffice: str, src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    # soffice 只认「输出目录」，文件名由它按输入名决定，转完再改名到 dst
    subprocess.run(
        [soffice, "--headless", "--convert-to", "pdf", "--outdir", str(dst.parent), str(src)],
        check=True,
        capture_output=True,
        timeout=300,
    )
    produced = dst.parent / (src.stem + ".pdf")
    if produced != dst:
        produced.replace(dst)


def _convert_textonly(src: Path, dst: Path) -> None:
    font_path = find_cjk_font()
    if font_path is None:
        print(
            "[doc-convert] 错误：本机找不到任何中文字体，纯文字兜底会输出满纸方块，"
            "已拒绝生成。请安装 LibreOffice（免费）后重试。",
            file=sys.stderr,
        )
        raise SystemExit(3)

    idx = next(i for p, i in _CJK_FONT_CANDIDATES if Path(p) == font_path)
    if font_path.suffix.lower() == ".ttc":
        pdfmetrics.registerFont(TTFont(_FONT_NAME, str(font_path), subfontIndex=idx))
    else:
        pdfmetrics.registerFont(TTFont(_FONT_NAME, str(font_path)))

    base = getSampleStyleSheet()
    body = ParagraphStyle(
        "Body", parent=base["Normal"], fontName=_FONT_NAME, fontSize=11, leading=18
    )
    head = ParagraphStyle(
        "Head", parent=base["Heading1"], fontName=_FONT_NAME, fontSize=16, leading=22
    )

    flow = []
    for para in Document(str(src)).paragraphs:
        text = para.text.strip()
        if not text:
            flow.append(Spacer(1, 6))
            continue
        style = head if para.style.name.startswith("Heading") else body
        # reportlab 的 Paragraph 会解析类 HTML 标记，正文里的 & < > 必须转义
        safe = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        flow.append(Paragraph(safe, style))
        flow.append(Spacer(1, 4))

    if not flow:
        print("[doc-convert] 错误：文档里没有可提取的文字。", file=sys.stderr)
        raise SystemExit(3)

    dst.parent.mkdir(parents=True, exist_ok=True)
    SimpleDocTemplate(
        str(dst), pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm,
        topMargin=20 * mm, bottomMargin=20 * mm,
    ).build(flow)


def convert(src: Path, dst: Path, allow_textonly: bool = False) -> str:
    """转换并返回走的是哪条路：`"soffice"` 或 `"textonly"`。"""
    soffice = find_soffice()
    if soffice:
        _convert_with_soffice(soffice, src, dst)
        return "soffice"

    if not allow_textonly:
        print(
            "[doc-convert] 错误：本机没有 LibreOffice，无法保留原排版转换。\n"
            "  · 想保留排版：安装 LibreOffice（免费，https://www.libreoffice.org/），装完重试。\n"
            "  · 只要文字也行：重跑时加 --allow-textonly，将输出纯文字版 PDF，"
            "表格、图片和全部排版都会丢失。",
            file=sys.stderr,
        )
        raise SystemExit(4)

    _convert_textonly(src, dst)
    return "textonly"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Word 转 PDF")
    ap.add_argument("input", help="输入 .docx 文件")
    ap.add_argument("-o", "--output", required=True, help="输出 .pdf 文件")
    ap.add_argument(
        "--allow-textonly",
        action="store_true",
        help="没有 LibreOffice 时允许输出纯文字版 PDF（会丢失表格/图片/排版）",
    )
    args = ap.parse_args(argv)

    src = Path(args.input)
    if not src.is_file():
        print(f"[doc-convert] 错误：找不到输入文件 {src}", file=sys.stderr)
        raise SystemExit(2)

    mode = convert(src, Path(args.output), args.allow_textonly)
    if mode == "textonly":
        print(
            f"[doc-convert] 已生成 {args.output}（纯文字版：表格、图片与排版已丢失）"
        )
    else:
        print(f"[doc-convert] 已生成 {args.output}（保留原排版）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
