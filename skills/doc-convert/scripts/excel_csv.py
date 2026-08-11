#!/usr/bin/env python3
"""Excel ↔ CSV 双向转换。

**刻意不用 pandas**：这件事用内置 csv + openpyxl 就够了，而 pandas 连同
numpy 约 84 MB，比本技能其余依赖加起来还大。为一次读写背这个包不划算。

两个非显然的决定，都是「不这么做用户就会踩坑」：

1. **写 CSV 一律带 UTF-8 BOM**（encoding="utf-8-sig"）。中文用户双击打开
   无 BOM 的 UTF-8 CSV 时，Excel 按本地代码页解码 → 满屏乱码，然后用户
   会认为是我们转错了。BOM 让 Excel 认出编码。读 CSV 同样用 utf-8-sig，
   它对没有 BOM 的文件也能正常工作（只在有 BOM 时吃掉它）。
2. **多工作表时拒绝猜**。静默只导第一张表 = 用户丢了数据还不知道。宁可
   报错要求他指定 --sheet。
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from openpyxl import Workbook, load_workbook

_XLSX_SUFFIXES = {".xlsx", ".xlsm"}
_CSV_SUFFIXES = {".csv"}


def xlsx_to_csv(src: Path, dst: Path, sheet: str | None = None) -> None:
    wb = load_workbook(str(src), data_only=True)
    names = wb.sheetnames
    if sheet is None:
        if len(names) > 1:
            print(
                f"[doc-convert] 错误：{src.name} 有 {len(names)} 张工作表"
                f"（{'、'.join(names)}），请用 --sheet 指定要导出哪一张。",
                file=sys.stderr,
            )
            raise SystemExit(2)
        ws = wb[names[0]]
    else:
        if sheet not in names:
            print(
                f"[doc-convert] 错误：没有名为「{sheet}」的工作表。"
                f"可选：{'、'.join(names)}",
                file=sys.stderr,
            )
            raise SystemExit(2)
        ws = wb[sheet]

    # 评审后加固：先把行读进内存判断有没有数据，再决定要不要落盘。原实现是边读
    # 边写，源表一行数据都没有时会在磁盘上留下一个 0 字节的 CSV、还打印"已生成"——
    # 这是四个脚本里唯一一处"静默产出空文件却报成功"，跟本分支「宁可不产出，也
    # 不产出一份看起来正常实则有缺陷的文件」的纪律不符。0 字节文件用户双击打开
    # 会一脸问号，还以为源表本来就有数据、是转换弄丢的。
    rows = [
        ["" if v is None else v for v in row] for row in ws.iter_rows(values_only=True)
    ]
    if not rows:
        print(
            f"[doc-convert] 错误：{src.name}"
            + (f" 的工作表「{ws.title}」" if sheet else "")
            + " 里一行数据都没有，没有内容可导出。",
            file=sys.stderr,
        )
        raise SystemExit(2)

    dst.parent.mkdir(parents=True, exist_ok=True)
    # newline="" 是 csv 模块的硬要求，不写会在 Windows 上多出空行
    with dst.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(rows)


def csv_to_xlsx(src: Path, dst: Path) -> None:
    wb = Workbook()
    ws = wb.active
    with src.open("r", encoding="utf-8-sig", newline="") as f:
        for row in csv.reader(f):
            ws.append(row)
    dst.parent.mkdir(parents=True, exist_ok=True)
    wb.save(str(dst))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Excel 与 CSV 互转（方向按输入扩展名自动判定）")
    ap.add_argument("input", help="输入 .xlsx / .xlsm / .csv 文件")
    ap.add_argument("-o", "--output", required=True, help="输出文件")
    ap.add_argument("--sheet", default=None, help="仅 xlsx→csv：指定工作表名")
    args = ap.parse_args(argv)

    src = Path(args.input)
    if not src.is_file():
        print(f"[doc-convert] 错误：找不到输入文件 {src}", file=sys.stderr)
        raise SystemExit(2)

    suffix = src.suffix.lower()
    dst = Path(args.output)
    if suffix in _XLSX_SUFFIXES:
        xlsx_to_csv(src, dst, args.sheet)
    elif suffix in _CSV_SUFFIXES:
        csv_to_xlsx(src, dst)
    elif suffix == ".xls":
        # 评审后加固：前端【Excel 文件】槽放行 .xls，但 openpyxl 只认 .xlsx/.xlsm
        # 这种 zip 容器格式，读不了 .xls 的老二进制格式。单独分支给出"下一步该
        # 干嘛"，而不是让它落进下面那条"只支持..."的通用提示——通用提示不会
        # 主动告诉用户 .xls 为什么不行、该怎么办。
        print(
            "[doc-convert] 错误：.xls 是旧版 Excel 格式，本工具读不了"
            "（.xls 是旧格式，请先在 Excel 里另存为 .xlsx 再试）。",
            file=sys.stderr,
        )
        raise SystemExit(2)
    else:
        print(
            f"[doc-convert] 错误：只支持 .xlsx / .xlsm / .csv，收到的是 {suffix or '（无扩展名）'}",
            file=sys.stderr,
        )
        raise SystemExit(2)

    print(f"[doc-convert] 已生成 {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
