#!/usr/bin/env python3
"""小说连贯性检查 —— 拿写作契约当标准答案，扫正文找矛盾。

用法：
    python3 scripts/continuity_check.py <正文路径> --spec-lock <契约路径>

查三件事：
  1. 伏笔埋了没回收（契约的伏笔表状态 vs 正文）
  2. 档案里的人物压根没登场（策划定了却没用上，通常是大纲漂了）
  3. 档案外人名（与某个档案人名同姓、同长、只差一个字的词）

第 3 项**刻意不做分词也不做模糊相似度**。中文分词要么引入重依赖、要么在
人名上本来就不准；而在没有词边界的情况下按 n-gram 滑窗算相似度会把
「张明打开」这种跨词窗口判成「张明」的笔误——满屏假警报的报告审校根本
不会看，比漏报更糟。这里用两道窄条件：①（同姓 + 同长 + 差一字）只抓
「张明→张鸣」这类最常见的手滑；②**边界闸**——候选词至少一侧要挨着非汉字
（行首行尾 / 标点 / 空格 / 引号）。加②是实测教训：光靠①，滑窗仍会把
「养老院」抠成「老院」（撞「老陈」）、把「小林小林地叫」抠成「林小/林地」
（撞「林晚」）这类夹在汉字中间的词碎片报成手滑。真人名手滑几乎总落在句首、
对话引号旁、标点边，靠②整类滤掉词碎片。代价是「张明→张明明」这种变长的、
以及埋在句子正中央的手滑都抓不到。宁可漏报。

副作用是有意保留的：正文里出现档案外的其他人名（如「张三」）也会被报
出来——策划本就该把所有有名字的人物登记进档案，报出来是对的。
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import writing_utils as wu  # noqa: E402

# 候选词必须整体是汉字：跨标点/数字的窗口不可能是人名。
_CJK_ONLY = re.compile(r"[一-龥]+")
_HANZI = re.compile(r"[一-龥]")


def _is_hanzi(ch: str) -> bool:
    return bool(_HANZI.match(ch))


@dataclass
class Character:
    name: str
    want: str = ""
    need: str = ""
    wound: str = ""
    lie: str = ""
    voice: str = ""


@dataclass
class Foreshadow:
    fid: str
    plant: str = ""
    payoff: str = ""
    status: str = ""


@dataclass
class ContinuityResult:
    ok: bool
    problems: list[wu.Hit] = field(default_factory=list)
    stats: dict[str, float] = field(default_factory=dict)


def _split_fields(body: str) -> dict[str, str]:
    """把 `want:x | need:y` 这种竖线分隔的字段串解析成字典。"""
    out: dict[str, str] = {}
    for part in body.split("|"):
        part = part.strip()
        if ":" not in part:
            continue
        key, _, value = part.partition(":")
        out[key.strip()] = value.strip()
    return out


def parse_characters(spec: dict) -> list[Character]:
    section = spec.get("人物档案", {})
    chars: list[Character] = []
    for name, body in section.items():
        fields = _split_fields(body)
        chars.append(
            Character(
                name=name.strip(),
                want=fields.get("want", ""),
                need=fields.get("need", ""),
                wound=fields.get("wound", ""),
                lie=fields.get("lie", ""),
                voice=fields.get("语料", ""),
            )
        )
    return chars


def parse_foreshadows(spec: dict) -> list[Foreshadow]:
    section = spec.get("伏笔表", {})
    items: list[Foreshadow] = []
    for fid, body in section.items():
        fields = _split_fields(body)
        items.append(
            Foreshadow(
                fid=fid.strip(),
                plant=fields.get("埋点", ""),
                payoff=fields.get("回收", ""),
                status=fields.get("状态", ""),
            )
        )
    return items


def check(text: str, spec: dict) -> ContinuityResult:
    problems: list[wu.Hit] = []
    characters = parse_characters(spec)
    foreshadows = parse_foreshadows(spec)

    # 1. 伏笔未回收
    for f in foreshadows:
        if f.status and f.status != "已回收":
            problems.append(
                wu.Hit(
                    line=1,
                    col=1,
                    text=f"伏笔 {f.fid}（{f.plant}）状态为「{f.status}」，计划回收点：{f.payoff}",
                    rule="伏笔未回收",
                )
            )

    # 2. 人物未登场
    known_names = {c.name for c in characters}
    for c in characters:
        if c.name and c.name not in text:
            problems.append(
                wu.Hit(line=1, col=1, text=f"人物「{c.name}」在正文中一次也没出现", rule="人物未登场")
            )

    # 3. 档案外人名：与某个档案人名同姓、同长、只差一个字
    seen: set[str] = set()
    for idx, line in enumerate(text.splitlines(), start=1):
        for name in sorted(known_names):
            length = len(name)
            if length < 2:
                continue
            for i in range(len(line) - length + 1):
                token = line[i : i + length]
                if token == name or token in seen or token in known_names:
                    continue
                if not _CJK_ONLY.fullmatch(token):
                    continue
                # 边界闸：候选词至少一侧要挨着「非汉字」（行首行尾 / 标点 / 空格 /
                # 引号）才算数。理由是实测教训——只按「同姓同长差一字」滑窗，会把
                # 「养老院」抠成「老院」（撞「老陈」）、「小林小林地叫」抠成「林小/
                # 林地」（撞「林晚」），全是普通词的碎片，满屏假警报把真问题淹了。
                # 真人名手滑几乎总落在句首、对话引号旁、标点边（至少一侧是边界），
                # 靠这一条把「夹在汉字中间的词碎片」整类滤掉。代价：埋在句子正中
                # 央的手滑会漏——与本脚本「宁可漏报不假报」的既定取舍一致。
                left_boundary = i == 0 or not _is_hanzi(line[i - 1])
                right_boundary = (i + length >= len(line)) or not _is_hanzi(line[i + length])
                if not (left_boundary or right_boundary):
                    continue
                if token[0] != name[0]:
                    continue
                if sum(1 for a, b in zip(token, name) if a != b) != 1:
                    continue
                problems.append(
                    wu.Hit(
                        line=idx,
                        col=i + 1,
                        text=f"「{token}」不在人物档案里，与「{name}」只差一个字——写错了还是漏登记？",
                        rule="档案外人名",
                    )
                )
                seen.add(token)

    return ContinuityResult(
        ok=not problems,
        problems=problems,
        stats={
            "人物数": float(len(characters)),
            "伏笔数": float(len(foreshadows)),
            "未回收伏笔": float(sum(1 for f in foreshadows if f.status and f.status != "已回收")),
        },
    )


def format_result(result: ContinuityResult, source: str) -> str:
    lines = [f"# 连贯性检查 — {source}", ""]
    lines.append("**✅ 全部通过**" if result.ok else f"**❌ {len(result.problems)} 项待处理**")
    lines.append("")
    lines.append("## 统计")
    for name, value in result.stats.items():
        lines.append(f"- {name}: {value:g}")
    if result.problems:
        lines.append("")
        lines.append("## 问题清单")
        lines.append("")
        lines.append("| 行 | 类型 | 详情 |")
        lines.append("|---|---|---|")
        for p in result.problems:
            lines.append(f"| {p.line} | {p.rule} | {p.text} |")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="小说连贯性检查")
    parser.add_argument("path")
    parser.add_argument("--spec-lock", required=True)
    args = parser.parse_args(argv)

    text = Path(args.path).read_text(encoding="utf-8")
    spec = wu.parse_spec_lock(Path(args.spec_lock))
    result = check(text, spec)
    print(format_result(result, Path(args.path).name))
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
