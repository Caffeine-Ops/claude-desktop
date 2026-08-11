"""rows_to_xlsx 的行为契约 —— 本 PR 全部质量门禁的落点。

四条最要紧的：
  1. 数字要写成真数值，不然用户 =SUM() 得 0（PR 1 的 csv→xlsx 已经踩过一次，
     那次只能靠文档提醒补救；这次是我们自己生成，没有借口）。
  2. 「看不清」和「本来就没有」必须区分：都标成无法识别会制造大量假警报，
     用户三天就学会无视所有黄格子，标记随之失效。
  3. 模型偷偷加列要当场拒绝——表头是跟用户确认过的契约。
  4. 识别率不到一半直接拒绝出文件：一份一半是问号的台账，用户核对的工夫
     比自己录还多。
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest
from openpyxl import load_workbook

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import rows_to_xlsx  # noqa: E402


def _write_json(path: Path, payload: dict) -> Path:
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def _run(src: Path, out: Path, *extra: str):
    return subprocess.run(
        [sys.executable, str(SCRIPTS / "rows_to_xlsx.py"), str(src), "-o", str(out), *extra],
        capture_output=True, text=True,
    )


def test_numbers_are_written_as_numbers(tmp_path):
    src = _write_json(tmp_path / "a.json", {
        "headers": ["项目", "金额"],
        "rows": [{"项目": "差旅", "金额": 128.5}],
    })
    out = tmp_path / "a.xlsx"
    assert _run(src, out).returncode == 0
    ws = load_workbook(out).active
    assert ws["B2"].value == 128.5
    assert ws["B2"].data_type == "n", "写成文本的话用户 =SUM() 会得 0"


def test_uncertain_cell_is_marked_and_filled_yellow(tmp_path):
    src = _write_json(tmp_path / "b.json", {
        "headers": ["项目", "金额"],
        "rows": [{"项目": "餐饮", "金额": None,
                  "_存疑": [{"字段": "金额", "原因": "折痕遮挡"}],
                  "_来源": "IMG_1.jpg"}],
    })
    out = tmp_path / "b.xlsx"
    assert _run(src, out).returncode == 0
    wb = load_workbook(out)
    ws = wb.active
    assert ws["B2"].value == rows_to_xlsx.UNREADABLE_TEXT
    assert rows_to_xlsx.YELLOW_HEX in str(ws["B2"].fill.start_color.rgb)
    review = wb["待核对"]
    assert [c.value for c in review[2]] == ["IMG_1.jpg", "金额", "折痕遮挡"]


def test_missing_but_not_uncertain_stays_empty(tmp_path):
    """票据上本来就没有税额 ≠ 看不清税额。混为一谈会制造假警报。"""
    src = _write_json(tmp_path / "c.json", {
        "headers": ["项目", "税额"],
        "rows": [{"项目": "打车", "税额": None}],
    })
    out = tmp_path / "c.xlsx"
    assert _run(src, out).returncode == 0
    wb = load_workbook(out)
    assert wb.active["B2"].value is None
    assert "待核对" not in wb.sheetnames, "一个存疑都没有时不该多出一张空表"


def test_unknown_field_is_refused_with_row_number(tmp_path):
    src = _write_json(tmp_path / "d.json", {
        "headers": ["项目"],
        "rows": [{"项目": "住宿"}, {"项目": "机票", "偷加的列": "x"}],
    })
    out = tmp_path / "d.xlsx"
    proc = _run(src, out)
    assert proc.returncode != 0
    assert "第 2 行" in proc.stderr and "偷加的列" in proc.stderr
    assert not out.exists()


def test_over_half_uncertain_is_refused(tmp_path):
    src = _write_json(tmp_path / "e.json", {
        "headers": ["日期", "金额"],
        "rows": [{"日期": None, "金额": None,
                  "_存疑": [{"字段": "日期", "原因": "模糊"},
                            {"字段": "金额", "原因": "模糊"}]}],
    })
    out = tmp_path / "e.xlsx"
    proc = _run(src, out)
    assert proc.returncode != 0
    assert "超过一半" in proc.stderr
    assert not out.exists()


def test_empty_rows_is_refused(tmp_path):
    src = _write_json(tmp_path / "f.json", {"headers": ["项目"], "rows": []})
    out = tmp_path / "f.xlsx"
    proc = _run(src, out)
    assert proc.returncode != 0
    assert not out.exists()


def test_jsonl_without_headers_is_refused(tmp_path):
    src = tmp_path / "g.jsonl"
    src.write_text('{"项目": "住宿"}\n', encoding="utf-8")
    out = tmp_path / "g.xlsx"
    proc = _run(src, out)
    assert proc.returncode != 0
    assert "--headers" in proc.stderr
    assert not out.exists()


def test_jsonl_with_headers_works(tmp_path):
    src = tmp_path / "h.jsonl"
    src.write_text('{"项目": "住宿", "金额": 300}\n{"项目": "机票", "金额": 1200}\n',
                   encoding="utf-8")
    out = tmp_path / "h.xlsx"
    assert _run(src, out, "--headers", "项目", "金额").returncode == 0
    ws = load_workbook(out).active
    assert ws["A3"].value == "机票"


def test_boolean_is_written_as_text_not_number(tmp_path):
    """Python 里 bool 是 int 的子类，不特判会把 True 写成 1。"""
    src = _write_json(tmp_path / "i.json", {
        "headers": ["项目", "已报销"],
        "rows": [{"项目": "打车", "已报销": True}],
    })
    out = tmp_path / "i.xlsx"
    assert _run(src, out).returncode == 0
    assert load_workbook(out).active["B2"].value == "True"


# --- 补充：main() 的兜底 except Exception —— Task 2 评审升级的全局约束。
# 只测 _die 路径测不到兜底本身，因为 _die 抛的是 SystemExit（继承
# BaseException 不是 Exception），到不了外层的 except Exception；必须让
# 内部函数抛一个普通异常才能验证兜底真的接住了。同 pdf_tables.py /
# pdf_render.py / doc_text.py 已落地的写法。

def test_main_wraps_unexpected_exception(tmp_path, monkeypatch, capsys):
    src = _write_json(tmp_path / "j.json", {
        "headers": ["项目"],
        "rows": [{"项目": "住宿"}],
    })
    out = tmp_path / "j.xlsx"

    def _boom(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(rows_to_xlsx, "build", _boom)
    with pytest.raises(SystemExit) as exc:
        rows_to_xlsx.main([str(src), "-o", str(out)])
    assert exc.value.code != 0
    err = capsys.readouterr().err
    assert "[doc-convert] 错误：" in err
    assert "Traceback" not in err
