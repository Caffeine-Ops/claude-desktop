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
    # 「二月」必须写点数据——评审后加固的空表护栏（见下方
    # test_empty_worksheet_refuses_to_export）会拒绝导出空工作表，这条测试要测
    # 的是"多表必须指定 --sheet"这另一条护栏，两者不能用同一张空表互相踩脚
    wb.create_sheet("二月").append(["二月数据"])
    wb.save(str(src))

    # 多表时静默只导第一张 = 用户丢数据还不知道。必须报错要求指定。
    with pytest.raises(SystemExit):
        excel_csv.xlsx_to_csv(src, tmp_path / "c.csv")

    excel_csv.xlsx_to_csv(src, tmp_path / "c.csv", sheet="二月")
    assert (tmp_path / "c.csv").is_file()


def test_empty_worksheet_refuses_to_export(tmp_path, capsys):
    """评审后加固：空工作表不应该静默产出 0 字节 CSV 还报"已生成"。

    这是四个脚本里唯一一处「静默产出空文件却报成功」，与本分支「拒绝时不产出
    文件」的纪律不一致——改成报错退出、不落盘。
    """
    src = tmp_path / "empty.xlsx"
    wb = Workbook()
    wb.save(str(src))  # 全新工作簿，工作表里没写过任何单元格
    dst = tmp_path / "empty.csv"

    with pytest.raises(SystemExit):
        excel_csv.xlsx_to_csv(src, dst)

    assert "一行数据都没有" in capsys.readouterr().err
    assert not dst.exists()


def test_xls_extension_gives_actionable_message(tmp_path, capsys):
    """.xls 是前端【Excel 文件】槽放行的旧格式，openpyxl 读不了；错误要指路。"""
    bad = tmp_path / "old.xls"
    bad.write_bytes(b"\xd0\xcf\x11\xe0")  # 假装是旧版二进制 xls 的文件头，内容不重要
    with pytest.raises(SystemExit):
        excel_csv.main([str(bad), "-o", str(tmp_path / "old.csv")])
    err = capsys.readouterr().err
    assert "旧格式" in err or "另存为" in err


def test_unknown_extension_exits_with_message(tmp_path, capsys):
    bad = tmp_path / "d.txt"
    bad.write_text("x", encoding="utf-8")
    with pytest.raises(SystemExit):
        excel_csv.main([str(bad), "-o", str(tmp_path / "d.csv")])
    assert "只支持" in capsys.readouterr().err
