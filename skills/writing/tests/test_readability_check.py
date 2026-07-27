"""平台合规检查测试。

这些是硬指标（段落上限、小标题密度、字数区间），不是启发式，
所以可以钉死具体数值。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import readability_check as rc


def test_platform_rules_cover_wechat():
    rules = rc.PLATFORM_RULES["公众号"]
    assert rules["paragraph_max"] == 150
    assert rules["subhead_every"] == 500


def test_longest_paragraph_stat_matches_checked_paragraphs():
    # 超长列表行被「段落过长」检查故意跳过；「最长段落」统计也不该把它算进去，
    # 否则报告自相矛盾：统计说 400 字，却不报超长
    text = "正常一段话。\n- " + ("字" * 400) + "\n又一段话。"
    result = rc.check(text, platform="公众号")
    assert not any(p.rule == "段落过长" for p in result.problems)
    assert result.stats["最长段落"] < 150


def test_long_paragraph_flagged_with_line_number():
    text = "短段落。\n" + ("很长的一段" * 40) + "\n又一个短段落。"
    result = rc.check(text, platform="公众号")
    assert not result.ok
    over = [p for p in result.problems if p.rule == "段落过长"]
    assert len(over) == 1
    assert over[0].line == 2


def test_short_paragraphs_pass_paragraph_rule():
    text = "## 小标题\n" + "\n".join(["这是一段正常长度的话。"] * 3)
    result = rc.check(text, platform="公众号")
    assert not any(p.rule == "段落过长" for p in result.problems)


def test_missing_subheads_flagged():
    # 1200 字正文、零个小标题 → 公众号要求每 500 字一个，缺 2 个
    text = "\n".join(["这是一段大约六十个字的正文内容用来凑够检测所需要的总字数长度。" * 2] * 10)
    result = rc.check(text, platform="公众号")
    assert any(p.rule == "小标题不足" for p in result.problems)


def test_subheads_counted_from_markdown_headings():
    body = "\n".join(["这是一段大约六十个字的正文内容用来凑够检测所需要的总字数长度。" * 2] * 10)
    text = "## 一\n" + body + "\n## 二\n" + body + "\n## 三\n" + body
    result = rc.check(text, platform="公众号")
    assert result.stats["小标题数"] == 3


def test_word_count_below_minimum_flagged():
    result = rc.check("太短了。", platform="公众号")
    assert any(p.rule == "字数不足" for p in result.problems)


def test_overrides_take_precedence():
    text = "短段落。\n" + ("很长的一段" * 40)
    loose = rc.check(text, platform="公众号", overrides={"paragraph_max": 10000})
    assert not any(p.rule == "段落过长" for p in loose.problems)


def test_unknown_platform_falls_back_to_generic():
    result = rc.check("随便写点东西。", platform="不存在的平台")
    assert isinstance(result.stats["正文字数"], float)


def test_code_block_interior_not_flagged_as_long_paragraph():
    # 代码块内部的行（比如注释很长的一行代码）不该被当成正文段落核对
    # paragraph_max——旧实现只跳过了 ``` 分隔符本身那一行，围栏内部的行
    # 只要不是以 ```/>/|/-/* 开头就会被误判成「段落过长」。
    # 重复 25 次是为了让 char_count（剥空白后）确实超过公众号的 150 上限
    # ——重复次数太少时空格会被 char_count 剥掉，字数不够，测不出这条 bug。
    text = "正常段落。\n```python\n" + ("x = 1  # 长注释" * 25) + "\n```\n结尾段落。"
    result = rc.check(text, platform="公众号")
    assert not any(p.rule == "段落过长" for p in result.problems)
