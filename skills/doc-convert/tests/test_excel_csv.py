"""excel_csv 的行为契约。

最重要的一条是 BOM：中文用户双击打开无 BOM 的 UTF-8 CSV，Excel 会按
本地代码页解码 → 满屏乱码。这不是锦上添花，是这条功能能不能用的分界线。
"""
import csv
import sys
from pathlib import Path

import pytest
from openpyxl import Workbook, load_workbook

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import excel_csv  # noqa: E402


def _make_xlsx(path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "数据"
    ws.append(["姓名", "金额"])
    ws.append(["张三", 100])
    wb.save(str(path))


def test_xlsx_to_csv_writes_utf8_bom(tmp_path):
    src = tmp_path / "a.xlsx"
    _make_xlsx(src)
    dst = tmp_path / "a.csv"

    excel_csv.xlsx_to_csv(src, dst)

    raw = dst.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf"), "缺 BOM 会让 Excel 打开中文 CSV 乱码"
    rows = list(csv.reader(dst.read_text(encoding="utf-8-sig").splitlines()))
    assert rows == [["姓名", "金额"], ["张三", "100"]]


def test_csv_to_xlsx_roundtrip(tmp_path):
    src = tmp_path / "b.csv"
    src.write_text("姓名,金额\n李四,200\n", encoding="utf-8-sig")
    dst = tmp_path / "b.xlsx"

    excel_csv.csv_to_xlsx(src, dst)

    ws = load_workbook(str(dst)).active
    assert [[c.value for c in row] for row in ws.iter_rows()] == [
        ["姓名", "金额"],
        ["李四", "200"],
    ]


def test_multi_sheet_requires_explicit_choice(tmp_path):
    src = tmp_path / "c.xlsx"
    wb = Workbook()
    wb.active.title = "一月"
    wb.create_sheet("二月")
    wb.save(str(src))

    # 多表时静默只导第一张 = 用户丢数据还不知道。必须报错要求指定。
    with pytest.raises(SystemExit):
        excel_csv.xlsx_to_csv(src, tmp_path / "c.csv")

    excel_csv.xlsx_to_csv(src, tmp_path / "c.csv", sheet="二月")
    assert (tmp_path / "c.csv").is_file()


def test_unknown_extension_exits_with_message(tmp_path, capsys):
    bad = tmp_path / "d.txt"
    bad.write_text("x", encoding="utf-8")
    with pytest.raises(SystemExit):
        excel_csv.main([str(bad), "-o", str(tmp_path / "d.csv")])
    assert "只支持" in capsys.readouterr().err
