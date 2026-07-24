#!/usr/bin/env python3
"""平台合规 / 可读性检查。

用法：
    python3 scripts/readability_check.py <文件路径> [--platform 公众号] [--spec-lock <路径>]

与 ai_slop_checker 的分工：那个查「像不像人写的」（启发式、有得分），
这个查「能不能发出去」（硬指标、只有过不过）。两者刻意分开——硬指标
不该被平均进一个总分里稀释掉，段落超 300 字就是超了，不能靠别的维度
拉高分数蒙混过关。
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import writing_utils as wu  # noqa: E402

# 各平台的硬指标。数字来源见设计文档「研究结论摘要」：
# 公众号每段 ≤150 字＝手机屏 3–5 行，超了读者会滑走。
PLATFORM_RULES: dict[str, dict[str, int]] = {
    "公众号": {"paragraph_max": 150, "subhead_every": 500, "total_min": 800, "total_max": 5000},
    "朋友圈": {"paragraph_max": 80, "subhead_every": 0, "total_min": 20, "total_max": 500},
    "小红书": {"paragraph_max": 100, "subhead_every": 0, "total_min": 100, "total_max": 1000},
    "知乎": {"paragraph_max": 300, "subhead_every": 800, "total_min": 800, "total_max": 20000},
    "通用": {"paragraph_max": 300, "subhead_every": 0, "total_min": 0, "total_max": 100000},
}

_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+\S")


@dataclass
class CheckResult:
    ok: bool
    problems: list[wu.Hit] = field(default_factory=list)
    stats: dict[str, float] = field(default_factory=dict)


def _count_headings(text: str) -> int:
    return sum(1 for line in text.splitlines() if _HEADING.match(line))


def check(text: str, platform: str, overrides: dict[str, int] | None = None) -> CheckResult:
    rules = dict(PLATFORM_RULES.get(platform, PLATFORM_RULES["通用"]))
    rules.update(overrides or {})

    body = wu.strip_markdown(text)
    paragraphs = wu.split_paragraphs(body)
    total_chars = wu.char_count(body)
    heading_count = _count_headings(text)

    problems: list[wu.Hit] = []

    # 段落上限：行号按原文（未剥 Markdown）算，用户要能直接跳过去改
    para_max = rules["paragraph_max"]
    for idx, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped or _HEADING.match(line) or stripped.startswith(("```", ">", "|", "-", "*")):
            continue
        length = wu.char_count(stripped)
        if length > para_max:
            problems.append(
                wu.Hit(line=idx, col=1, text=f"{length} 字（上限 {para_max}）", rule="段落过长")
            )

    # 小标题密度：subhead_every 为 0 表示该平台不要求
    every = rules["subhead_every"]
    if every > 0 and total_chars > 0:
        expected = total_chars // every
        if heading_count < expected:
            problems.append(
                wu.Hit(
                    line=1,
                    col=1,
                    text=f"{total_chars} 字只有 {heading_count} 个小标题，建议至少 {expected} 个",
                    rule="小标题不足",
                )
            )

    # 字数区间
    if total_chars < rules["total_min"]:
        problems.append(
            wu.Hit(line=1, col=1, text=f"{total_chars} 字，低于下限 {rules['total_min']}", rule="字数不足")
        )
    if total_chars > rules["total_max"]:
        problems.append(
            wu.Hit(line=1, col=1, text=f"{total_chars} 字，超过上限 {rules['total_max']}", rule="字数超限")
        )

    return CheckResult(
        ok=not problems,
        problems=problems,
        stats={
            "正文字数": float(total_chars),
            "段落数": float(len(paragraphs)),
            "小标题数": float(heading_count),
            "最长段落": float(max((wu.char_count(p) for p in paragraphs), default=0)),
        },
    )


def format_result(result: CheckResult, source: str, platform: str) -> str:
    lines = [f"# 平台合规检查 — {source}（{platform}）", ""]
    lines.append("**✅ 全部通过**" if result.ok else f"**❌ {len(result.problems)} 项不合规**")
    lines.append("")
    lines.append("## 统计")
    for name, value in result.stats.items():
        lines.append(f"- {name}: {value:g}")
    if result.problems:
        lines.append("")
        lines.append("## 问题清单")
        lines.append("")
        lines.append("| 行 | 问题 | 详情 |")
        lines.append("|---|---|---|")
        for p in result.problems:
            lines.append(f"| {p.line} | {p.rule} | {p.text} |")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="平台合规检查")
    parser.add_argument("path")
    parser.add_argument("--platform", default="通用")
    parser.add_argument("--spec-lock", default=None, help="从契约读 platform 与段落/小标题覆盖值")
    args = parser.parse_args(argv)

    text = Path(args.path).read_text(encoding="utf-8")
    platform = args.platform
    overrides: dict[str, int] = {}

    if args.spec_lock:
        spec = wu.parse_spec_lock(Path(args.spec_lock))
        fmt = spec.get("平台格式", {})
        platform = fmt.get("platform", platform)
        for key, field_name in (("paragraph_max", "paragraph_max"), ("subhead_every", "subhead_every")):
            if key in fmt and fmt[key].isdigit():
                overrides[field_name] = int(fmt[key])

    result = check(text, platform=platform, overrides=overrides)
    print(format_result(result, Path(args.path).name, platform))
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
