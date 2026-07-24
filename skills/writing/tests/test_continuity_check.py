"""小说连贯性检查测试。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import continuity_check as cc

SPEC_TEXT = """## 体裁
- genre: short-story
- sub: 悬疑推理

## 人物档案
- 张明 | want:找到妹妹 | need:原谅自己 | wound:车祸中独自生还 | lie:活下来的人不配幸福 | 语料:……我知道。
- 李芸 | want:掩盖真相 | need:被理解 | wound:年少被抛弃 | lie:没人会留下来 | 语料:随你怎么想。

## 伏笔表
- 001 | 埋点:第2节 抽屉里的钥匙 | 回收:第5节 | 状态:已埋未收
- 002 | 埋点:第1节 窗台的烟头 | 回收:第4节 | 状态:已回收
"""


def _spec(tmp_path):
    p = tmp_path / "spec_lock.md"
    p.write_text(SPEC_TEXT, encoding="utf-8")
    import writing_utils as wu

    return wu.parse_spec_lock(p)


def test_parse_characters(tmp_path):
    chars = cc.parse_characters(_spec(tmp_path))
    assert [c.name for c in chars] == ["张明", "李芸"]
    assert chars[0].wound == "车祸中独自生还"
    assert chars[0].lie == "活下来的人不配幸福"


def test_parse_foreshadows(tmp_path):
    items = cc.parse_foreshadows(_spec(tmp_path))
    assert [f.fid for f in items] == ["001", "002"]
    assert items[0].status == "已埋未收"
    assert items[1].status == "已回收"


def test_unpaid_foreshadow_reported(tmp_path):
    text = "第一节。张明走进房间。\n第二节。他打开抽屉，里面有一把钥匙。"
    result = cc.check(text, _spec(tmp_path))
    assert not result.ok
    assert any(p.rule == "伏笔未回收" and "001" in p.text for p in result.problems)


def test_paid_foreshadow_not_reported(tmp_path):
    text = "第一节。窗台上有个烟头。"
    result = cc.check(text, _spec(tmp_path))
    assert not any(p.rule == "伏笔未回收" and "002" in p.text for p in result.problems)


def test_character_never_appears_reported(tmp_path):
    text = "张明一个人走了很久。"
    result = cc.check(text, _spec(tmp_path))
    assert any(p.rule == "人物未登场" and "李芸" in p.text for p in result.problems)


def test_suspected_typo_name_reported(tmp_path):
    # 「张鸣」与档案里的「张明」同姓、同长、只差一个字 —— 疑似写错名字
    text = "张明走进来。张鸣坐下了。李芸没说话。"
    result = cc.check(text, _spec(tmp_path))
    problems = [p for p in result.problems if p.rule == "档案外人名"]
    assert any("张鸣" in p.text for p in problems)
    assert problems[0].line == 1


def test_ordinary_words_do_not_trigger_name_check(tmp_path):
    # 「张明打开」这类跨词窗口不能被当成人名 —— 满屏假警报比漏报更糟
    text = "张明打开抽屉，钥匙还在。李芸站在窗台边。"
    result = cc.check(text, _spec(tmp_path))
    assert not any(p.rule == "档案外人名" for p in result.problems)


def test_clean_text_passes(tmp_path):
    text = "张明打开抽屉，钥匙还在。李芸站在窗台边，烟头掉在地上。"
    spec = _spec(tmp_path)
    # 把 001 也标成已回收，模拟完稿状态
    spec["伏笔表"]["001"] = "埋点:第2节 抽屉里的钥匙 | 回收:第5节 | 状态:已回收"
    result = cc.check(text, spec)
    assert result.ok


def test_missing_sections_do_not_crash():
    result = cc.check("随便一段文字。", {})
    assert result.ok
