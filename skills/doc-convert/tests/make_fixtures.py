#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_fixtures.py — 现造人工验收用的样本，答案写在 ACCEPTANCE.md 里。

刻意「现造」而不是往仓库里塞几个 PDF/JPG：二进制样本会让仓库越滚越大，
而且真实发票涉及隐私。用法：

    "$DOC_CONVERT_PY" skills/doc-convert/tests/make_fixtures.py -d /tmp/dc-fixtures
"""
import argparse
from pathlib import Path


def make_table_pdf(dst: Path) -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle
    data = [
        ["项目", "第一季度", "第二季度", "合计"],
        ["营业收入", "1200.50", "1310.25", "2510.75"],
        ["营业成本", "800.00", "910.10", "1710.10"],
        ["毛利", "400.50", "400.15", "800.65"],
    ]
    t = Table(data)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)]))
    SimpleDocTemplate(str(dst), pagesize=A4).build([t])


def _cjk_font(size: int):
    """找一个支持中文的字体。PIL 的默认位图字体不含 CJK 字形，中文会被静默
    画成方块/空白——这条假发票靠「测试发票（非真实票据）」这行中文字样
    声明自己不是真票据，字体选错等于这行免责声明形同虚设（2026-08-11 实测
    发现：默认字体下这行中文整段变成一排 tofu 方块，肉眼完全看不出是字）。
    按平台各试几个常见路径，都找不到就退回默认字体并打印警告——不让脚本
    在没装中文字体的机器上直接崩，但会显式提醒人去核实图片。
    """
    from PIL import ImageFont
    candidates = [
        "/System/Library/Fonts/STHeiti Light.ttc",  # macOS
        "/System/Library/Fonts/PingFang.ttc",
        "C:\\Windows\\Fonts\\msyh.ttc",  # Windows（微软雅黑）
        "C:\\Windows\\Fonts\\simsun.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",  # Linux
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    print("[make_fixtures] 警告：本机没找到中文字体，假发票里的中文可能显示为方块，"
          "请生成后肉眼核实「测试发票（非真实票据）」这行是否可读。")
    return ImageFont.load_default()


def make_receipt_image(dst: Path) -> None:
    """一张字段已知的假票据。刻意把「税额」印得很淡，用来验证存疑标记。"""
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (900, 600), (255, 255, 255))
    d = ImageDraw.Draw(img)
    font = _cjk_font(24)
    d.text((40, 40), "DEMO INVOICE / 测试发票（非真实票据）", fill=(0, 0, 0), font=font)
    d.text((40, 120), "Date 2026-03-01", fill=(0, 0, 0), font=font)
    d.text((40, 170), "Seller: DEMO TECH CO LTD", fill=(0, 0, 0), font=font)
    d.text((40, 220), "No. 12345678", fill=(0, 0, 0), font=font)
    d.text((40, 270), "Amount 1280.00", fill=(0, 0, 0), font=font)
    d.text((40, 320), "Tax 76.80", fill=(232, 232, 232), font=font)  # 极淡 → 应被标存疑
    img.save(dst)


def make_long_pdf(dst: Path, pages: int = 12) -> None:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(str(dst), pagesize=A4)
    for i in range(1, pages + 1):
        c.drawString(72, 760, f"Chapter {i}")
        for line in range(20):
            c.drawString(72, 730 - line * 24,
                         f"Section {i}.{line}: demo body text for acceptance run.")
        c.showPage()
    c.save()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-d", "--outdir", required=True)
    args = ap.parse_args()
    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)
    make_table_pdf(out / "财务表.pdf")
    make_receipt_image(out / "假发票.png")
    make_long_pdf(out / "长文档.pdf")
    print(f"样本已生成到 {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
