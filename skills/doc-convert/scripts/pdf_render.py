#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pdf_render.py — 把 PDF 指定页渲染成 PNG，供模型看图核对。

渲染引擎用 pypdfium2：它是 pdfplumber>=0.11 的自带依赖，**不额外增加体积**
（2026-08-11 实测确认）。别为这件事去装 PyMuPDF——它体积更大，且是 AGPL。

scale 默认 2：A4 @2 倍约 1191×1684 px，与模型内部约 1568px 的长边上限对齐，
再高只多花 token 不多认字。某页认不清时可单独提高 scale 重渲那一页。
SCALE_MAX 卡 4 是防手滑：scale=20 会渲出几十 MB 的图，喂进模型既慢又贵。

parse_pages 刻意在本文件重写一份，没有去 import pdf_ops.py 里那个私有的
_parse_pages：两个脚本的报错措辞各自独立演进更安全，为省 12 行去耦合两个
脚本的错误信息不划算。但**页码语义必须和 pdf_ops 完全一致**（1 起、闭区间、
越界报总页数），否则同一个技能里两套规则，用户说「第 3 页」会得到两种结果。
"""
import argparse
import sys
from pathlib import Path

SCALE_DEFAULT = 2.0
SCALE_MAX = 4.0

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _die(msg: str) -> None:
    print(f"[doc-convert] 错误：{msg}", file=sys.stderr)
    raise SystemExit(2)


def parse_pages(spec: str, total: int) -> list[int]:
    """把 "1,3-5" 解析成 1 起的页码列表，去重排序。越界即报错退出。"""
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
                _die(f"看不懂页码区间「{chunk}」。写法示例：1,3-5")
            if start > end:
                start, end = end, start
            pages.update(range(start, end + 1))
        else:
            try:
                pages.add(int(chunk))
            except ValueError:
                _die(f"看不懂页码「{chunk}」。写法示例：1,3-5")
    bad = [p for p in sorted(pages) if p < 1 or p > total]
    if bad:
        _die(f"页码 {bad} 超出范围，该文件共 {total} 页。请改正页码后重试。")
    return sorted(pages)


def open_document(src: Path):
    """打开 PDF，加密/损坏都转成中文报错。措辞与 pdf_ops.py 对齐。

    评审后加固：优先用 pypdfium2.PdfiumError.err_code 判断是不是密码保护——
    这是官方文档化的类型化信号（FPDF_ERR_PASSWORD == 4），跟 pdf_ops.py 那边
    catch FileNotDecryptedError 是同一路数，都是「认类型不认措辞」。原来只靠
    str(e).lower() 里找 "password"/"encrypt"：库一升级改了英文文案，加密 PDF
    就会滑进「文件可能已损坏」的通用分支——不是崩溃，是诊断答非所问，还没有
    任何测试能发现这种劣化。字符串匹配保留做兜底（双保险），只防极旧版本
    pypdfium2 还没有 err_code 属性的场景，不再是主判据。
    """
    import pypdfium2
    try:
        return pypdfium2.PdfDocument(str(src))
    except Exception as e:
        err_code = getattr(e, "err_code", None)
        password_code = getattr(pypdfium2.raw, "FPDF_ERR_PASSWORD", 4)
        low = str(e).lower()
        if err_code == password_code or "password" in low or "encrypt" in low:
            _die(f"PDF「{src.name}」被密码保护，本工具无法处理。请先用阅读器去掉密码再试。")
        _die(f"打开 PDF「{src.name}」失败，文件可能已损坏。请确认后重试。")


def render(src: Path, pages: list[int], outdir: Path, scale: float) -> list[Path]:
    src, outdir = Path(src), Path(outdir)
    try:
        outdir.mkdir(parents=True, exist_ok=True)
    except Exception:
        # 写盘调用单独兜底，不能让磁盘满/权限拒绝这类系统层异常
        # 裸露成 Traceback——同 doc_text.py / img_prep.py 的纪律。
        _die(f"无法创建输出目录 {outdir}，请检查目录权限或磁盘空间。")
    doc = open_document(src)
    written: list[Path] = []
    for p in pages:
        dst = outdir / f"page-{p:04d}.png"
        try:
            bitmap = doc[p - 1].render(scale=scale)
            bitmap.to_pil().save(dst)
        except Exception:
            # 评审后加固：多页渲染中途失败（比如渲到第 3 页时磁盘写满）如果
            # 不清理，outdir 里会留下前几页「看起来完整」的 PNG，但整批其实
            # 是残缺的——用户/模型看到一半文件容易误判成「已经渲完了」。这
            # 撞在本技能头号纪律上：宁可不产出，也不产出一份看起来正常实则
            # 有缺陷的东西（同 pdf_ops.py split 的两阶段写盘加固同源）。所以
            # 失败时先把本次已写出的文件全部删掉，再报错，并在消息里说明。
            for done in written:
                done.unlink(missing_ok=True)
            _die(f"写入第 {p} 页图片失败，已清理本次产生的 {len(written)} 个部分文件。"
                 f"请检查目标目录权限或磁盘空间。")
        written.append(dst)
    return written


def main(argv: list[str] | None = None) -> int:
    try:
        ap = argparse.ArgumentParser(description="把 PDF 页面渲染成 PNG 供模型看图")
        ap.add_argument("input", help="输入 PDF")
        ap.add_argument("--pages", help='页码，如 "1,3-5"；不给则全部页')
        ap.add_argument("-d", "--outdir", required=True, help="产物目录")
        ap.add_argument("--scale", type=float, default=SCALE_DEFAULT,
                        help=f"渲染倍率，默认 {SCALE_DEFAULT}，上限 {SCALE_MAX}")
        args = ap.parse_args(argv)

        if not (0 < args.scale <= SCALE_MAX):
            _die(f"渲染倍率 {args.scale} 不合法，必须在 0 到 {SCALE_MAX} 之间。"
                 f"倍率过高会渲出几十 MB 的图，模型读起来又慢又贵。")

        src = Path(args.input)
        if not src.is_file():
            _die(f"找不到文件「{src}」。请确认路径。")

        doc = open_document(src)
        total = len(doc)
        pages = parse_pages(args.pages, total) if args.pages else list(range(1, total + 1))

        written = render(src, pages, Path(args.outdir), args.scale)
        for p in written:
            print(p)
        return 0
    except Exception as e:
        # 兜底：main() 必须有这一层，逐个函数自觉包 try 是不够的——任何未
        # 预期的异常（哪怕来自看起来无辜的一行代码）都要转成中文错误，
        # 不能让裸 Traceback 打到用户面前。这是本 PR 的全局约束，
        # 同 doc_text.py / img_prep.py 等脚本的纪律保持一致。
        _die(f"处理过程中出错：{type(e).__name__}: {e}")


if __name__ == "__main__":
    raise SystemExit(main())
