#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pdf_tables.py — 从 PDF 抽表格 → JSON，并判定这份 PDF 是不是扫描件。

这个脚本是「PDF 表格转 Excel」这条能力的立身之本：它抽出来的数字是按坐标
从文件里**直接读**的，不是认出来的，逐字准确（2026-08-11 实测）。
正因如此，SKILL.md 才敢立那条纪律——模型只准改结构（合并跨页表头、拆开挤在
一起的两张表、剔除混进来的页眉页脚行），**不准改数字**。这条纪律一旦松掉，
就等于把本来 100% 准确的财务数字交给一个会看错小数点的读者。

扫描件（没有文字层）**不算错误**，退出码 0 并把 scanned 标成 true——
这是给 agent 的信号：改走「模型看图读表」那条分支，并套上严格的无法识别标记。
真正的错误只有一种：不是扫描件却一张表都没找到，那时拒绝产出，不留空 JSON。
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pdf_render import parse_pages  # noqa: E402

SCANNED_CHARS_PER_PAGE = 50  # 与 doc_text.py 同值；两处都改才算改

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _die(msg: str) -> None:
    print(f"[doc-convert] 错误：{msg}", file=sys.stderr)
    raise SystemExit(2)


def _open(src: Path):
    """打开 PDF，加密/损坏都转成中文报错。措辞与 pdf_render.py 对齐。

    评审加固（同 pdf_render.py 的 open_document）：加密探测要靠类型判断，
    不能靠猜英文措辞。2026-08-11 用 pypdf 现造一份真正带密码的 PDF 实测
    确认：pdfplumber.open() 对它抛出的是
    pdfplumber.utils.exceptions.PdfminerException（见 pdfplumber/pdf.py 里
    `raise PdfminerException(e)` 这行），**str(e) 是空字符串**——也就是说
    原来那版 "password" in str(e).lower() 的字符串匹配对这个包装类从来没
    生效过，纯靠巧合没被任何测试戳穿。真正管用的信号在 e.args[0]：pdfplumber
    是把被捕获的原始异常整个塞进 PdfminerException(e) 的构造参数，所以
    e.args[0] 就是那个原始异常——pdfminer 里凡是加密相关的问题（缺密码的
    PDFPasswordIncorrect、有密码但不许提取的 PDFTextExtractionNotAllowed）
    都继承自 pdfminer.pdfdocument.PDFEncryptionError，isinstance 判断稳。
    字符串匹配保留做兜底，只防未来 pdfplumber 改了包装方式、args[0] 不再是
    原始异常的场景，不再是主判据。
    """
    import pdfplumber
    from pdfminer.pdfdocument import PDFEncryptionError
    try:
        return pdfplumber.open(str(src))
    except Exception as e:
        inner = e.args[0] if e.args else None
        low = str(e).lower()
        if isinstance(inner, PDFEncryptionError) or "password" in low or "encrypt" in low:
            _die(f"PDF「{src.name}」被密码保护，本工具无法处理。请先用阅读器去掉密码再试。")
        _die(f"打开 PDF「{src.name}」失败，文件可能已损坏。请确认后重试。")


def extract(src: Path, pages_spec: str | None) -> dict:
    with _open(src) as pdf:
        total = len(pdf.pages)
        wanted = parse_pages(pages_spec, total) if pages_spec else list(range(1, total + 1))

        chars_total = 0
        tables: list[dict] = []
        tid = 0
        for pno in wanted:
            page = pdf.pages[pno - 1]
            chars_total += len(page.extract_text() or "")
            for raw in page.extract_tables():
                # pdfplumber 对空单元格给 None，统一成空串：下游要写进 Excel，
                # None 和 "" 在 JSON 里是两种东西，留着会让装配脚本多一层判断。
                rows = [["" if c is None else str(c).strip() for c in row] for row in raw]
                if not rows:
                    continue
                tid += 1
                tables.append({
                    "table_id": tid,
                    "page": pno,
                    "n_rows": len(rows),
                    "n_cols": max(len(r) for r in rows),
                    "rows": rows,
                })

    scanned = bool(wanted) and (chars_total / len(wanted)) < SCANNED_CHARS_PER_PAGE
    return {"source": src.name, "total_pages": total, "scanned": scanned, "tables": tables}


def main(argv: list[str] | None = None) -> int:
    try:
        ap = argparse.ArgumentParser(description="从 PDF 抽表格 → JSON")
        ap.add_argument("input", help="输入 PDF")
        ap.add_argument("--pages", help='只看这些页，如 "1,3-5"；不给则全部')
        ap.add_argument("-o", "--output", required=True, help="输出 JSON 路径")
        args = ap.parse_args(argv)

        src = Path(args.input)
        if not src.is_file():
            _die(f"找不到文件「{src}」。请确认路径。")

        result = extract(src, args.pages)

        if not result["tables"] and not result["scanned"]:
            # 有文字层却一张表都没有 = 这份 PDF 里确实没有表格。不产出空 JSON，
            # 免得下游拿着一份「结构完整但内容为空」的文件继续往下走。
            _die(f"「{src.name}」里没找到表格。请确认这份 PDF 是不是真的含表格，"
                 "或者告诉我要抽第几页。")

        dst = Path(args.output)
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
        except Exception:
            # 写盘调用单独兜底，不能让磁盘满/权限拒绝这类系统层异常
            # 裸露成 Traceback——同 pdf_render.py / doc_text.py 的纪律。
            _die(f"无法创建输出目录 {dst.parent}，请检查目录权限或磁盘空间。")
        try:
            dst.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            _die(f"写入 JSON 文件 {dst} 失败，请检查目标目录权限或磁盘空间。")

        print(f"表格 {len(result['tables'])} 张 → {dst}")
        if not result["tables"]:
            # 评审实测：scanned=True 但 tables 非空是真实会发生的情况（整体
            # 文字层稀薄，但表格本身靠线框/单元格结构被正常抽出来了）。原来
            # 只看 scanned 会在这种情况下打印「抽不到表格数据」——这句话和
            # 刚刚生成的 JSON 内容直接矛盾，会把 agent 教去看图认一份其实已经
            # 逐字准确抽出来的表。改成只在 tables 真的是空的时候才提示；tables
            # 为空时 scanned 必为 True（否则上面已经 _die），所以这里不用再判
            # scanned。
            print("提示：这份 PDF 没有文字层（扫描件），抽不到表格数据，请改走看图识别路线。")
        return 0
    except Exception as e:
        # 兜底：main() 必须有这一层，逐个函数自觉包 try 是不够的——任何未
        # 预期的异常（哪怕来自看起来无辜的一行代码）都要转成中文错误，
        # 不能让裸 Traceback 打到用户面前。这是本 PR 的全局约束，
        # 同 pdf_render.py / doc_text.py 等脚本的纪律保持一致。
        _die(f"处理过程中出错：{type(e).__name__}: {e}")


if __name__ == "__main__":
    raise SystemExit(main())
