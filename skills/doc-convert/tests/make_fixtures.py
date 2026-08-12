#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_fixtures.py — 现造人工验收用的样本，答案写在 ACCEPTANCE.md 里。

刻意「现造」而不是往仓库里塞几个 PDF/JPG：二进制样本会让仓库越滚越大，
而且真实发票涉及隐私。用法：

    "$DOC_CONVERT_PY" skills/doc-convert/tests/make_fixtures.py -d /tmp/dc-fixtures

中文字体：PIL 的 `ImageDraw.text` 默认字体、reportlab 的默认字体都不含
CJK 字形，不挂字体的话中文会被静默画成方块或抽取出乱码（2026-08-11 评审
实测过两种失效方式：假发票上的中文变成一排 tofu 方块；财务表的中文表头
被 pdfplumber 抽成 "nn"/"nnnn" 这种看着像正常英文缩写、实则完全不对的
乱码——比方块更隐蔽，会让人误以为是抽取脚本本身出了 bug）。找不到中文
字体就直接拒绝生成，不退化成「打印警告后继续」：本 PR 反复强调的纪律是
「宁可不产出，也不产出一份看起来正常实则有缺陷的东西」——这条纪律对
验收脚本自己同样适用，样本脚本自己搞悄悄降级是最大的讽刺。
"""
import argparse
import sys
from pathlib import Path

# 复用 docx_to_pdf.py 的中文字体查找逻辑，不再摸索第二套候选路径——两处都是
# 「给 reportlab/PIL 挂一个能显示中文的字体」这同一件事。
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from docx_to_pdf import find_cjk_font  # noqa: E402

_FONT_NAME = "DocConvertCJK"


def _require_cjk_font() -> Path:
    """找不到中文字体就拒绝生成，不静默退化。"""
    font_path = find_cjk_font()
    if font_path is None:
        print(
            "[make_fixtures] 错误：本机找不到任何中文字体，样本里的中文安全声明/表头"
            "会变成方块或乱码，已拒绝生成。请安装一款中文字体"
            "（如 Noto Sans CJK）后重试，或换一台装了中文字体的机器。",
            file=sys.stderr,
        )
        raise SystemExit(1)
    return font_path


def make_table_pdf(dst: Path, font_path: Path) -> None:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle

    # .ttc 是字体集合，注册要指定取第几个；我们要的都是集合里的第一个。
    # 与 docx_to_pdf.py 的注册写法保持一致。
    if _FONT_NAME not in pdfmetrics.getRegisteredFontNames():
        if font_path.suffix.lower() == ".ttc":
            pdfmetrics.registerFont(TTFont(_FONT_NAME, str(font_path), subfontIndex=0))
        else:
            pdfmetrics.registerFont(TTFont(_FONT_NAME, str(font_path)))

    data = [
        ["项目", "第一季度", "第二季度", "合计"],
        ["营业收入", "1200.50", "1310.25", "2510.75"],
        ["营业成本", "800.00", "910.10", "1710.10"],
        ["毛利", "400.50", "400.15", "800.65"],
    ]
    t = Table(data)
    t.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
        ("FONTNAME", (0, 0), (-1, -1), _FONT_NAME),  # 不挂字体中文表头会被抽成乱码
    ]))
    SimpleDocTemplate(str(dst), pagesize=A4).build([t])


def make_receipt_image(dst: Path, font_path: Path) -> None:
    """一张字段已知的假票据。刻意把「税额」印得很淡，用来验证存疑标记。

    76.80 用浅灰 (245,245,245) 印在白底上：比正文黑色浅得多、肉眼要费点劲
    才能读出数字，但没有淡到完全看不见——完全看不见的话模型会正确地说
    「看不清」，反而测不出「拿不准就不猜」这条纪律有没有生效（评审意见：
    (232,232,232) 偏容易一侧，不假思索直接 OCR 的模型大概率照样能读出来，
    区分力打了折扣）。
    """
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new("RGB", (900, 600), (255, 255, 255))
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(str(font_path), 24)
    d.text((40, 40), "DEMO INVOICE / 测试发票（非真实票据）", fill=(0, 0, 0), font=font)
    d.text((40, 120), "Date 2026-03-01", fill=(0, 0, 0), font=font)
    d.text((40, 170), "Seller: DEMO TECH CO LTD", fill=(0, 0, 0), font=font)
    d.text((40, 220), "No. 12345678", fill=(0, 0, 0), font=font)
    d.text((40, 270), "Amount 1280.00", fill=(0, 0, 0), font=font)
    d.text((40, 320), "Tax 76.80", fill=(245, 245, 245), font=font)  # 淡 → 应被标存疑
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
    # 先查字体、再建目录：找不到字体时要干净地拒绝，不留一个空产物目录。
    font_path = _require_cjk_font()

    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)
    make_table_pdf(out / "财务表.pdf", font_path)
    make_receipt_image(out / "假发票.png", font_path)
    make_long_pdf(out / "长文档.pdf")
    print(f"样本已生成到 {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
