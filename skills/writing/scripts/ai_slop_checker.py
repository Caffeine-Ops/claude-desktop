#!/usr/bin/env python3
"""AI 味检测 —— 五维打分，满分 50，低于 35 打回重写。

用法：
    python3 scripts/ai_slop_checker.py <文件路径> [--spec-lock <路径>] [--json]

为什么要脚本而不是让模型自查：五个维度里最关键的「结构均匀度」是纯
统计量（句长/段长的变异系数），模型对自己写的东西估不准这个数——
它读起来觉得「挺有变化的」，算出来 CV 只有 0.28。调研里那条
「结构均匀度是 AI 味首要信号，光换词无效」正是靠算才立得住。

标定常量（下面的 *_FLOOR / *_CEIL）是种子值，用真实样本调。调它们
不该动测试：测试钉的是相对行为（AI 腔 < 人话），不是具体分数。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import writing_utils as wu  # noqa: E402

# ── 标定常量 ─────────────────────────────────────────────────────────
# 句长变异系数：中文人写正文通常 0.55–0.80，AI 生成常落在 0.28–0.45。
SENT_CV_FLOOR, SENT_CV_CEIL = 0.25, 0.65
# 段长变异系数：AI 爱写「每段三句话」，人写作段落长短差得多。
PARA_CV_FLOOR, PARA_CV_CEIL = 0.20, 0.70
# 每千字命中数 → 扣分斜率。套话比书面腔更刺眼，斜率更陡。
BANNED_SLOPE = 1.5
PATTERN_SLOPE = 3.0
BOOKISH_SLOPE = 2.0
# 「的」字密度（每百字）：人写 3–5，书面腔堆到 7 以上。
DE_FLOOR, DE_CEIL = 7.0, 3.5
# 具体度：具体标记 ÷（具体标记 + 形容词）的比值区间。
CONCRETE_FLOOR, CONCRETE_CEIL = 0.15, 0.55

PASS_THRESHOLD = 35.0

_NUMBER = re.compile(r"\d+(?:\.\d+)?%?")
_DE = re.compile("的")

# 命中分级：按规则名精确查表（不是前缀匹配）。套话＝🔴、书面腔＝🟡；
# 表外的规则名（AI 句式各名，如「反转对举句」）回落 🔴——都是硬伤。
_GRADE_BY_RULE = {"套话": "🔴", "书面腔": "🟡"}


@dataclass
class Report:
    total: float
    dimensions: dict[str, float]
    hits: list[wu.Hit] = field(default_factory=list)
    stats: dict[str, float] = field(default_factory=dict)


def _clamp(value: float, low: float = 0.0, high: float = 10.0) -> float:
    return max(low, min(high, value))


def _scale(value: float, floor: float, ceil: float) -> float:
    """把 value 从 [floor, ceil] 线性映射到 [0, 10]。

    floor > ceil 时自动反向（用于「越小越好」的指标，如「的」字密度）。
    """
    if floor == ceil:
        return 10.0
    return _clamp((value - floor) / (ceil - floor) * 10.0)


def _load_patterns() -> list[tuple[re.Pattern, str]]:
    """ai_patterns.txt 每行 `<正则>|<规则名>`。"""
    out: list[tuple[re.Pattern, str]] = []
    for line in wu.load_wordlist("ai_patterns"):
        raw, _, name = line.rpartition("|")
        if not raw:
            continue
        out.append((re.compile(raw), name.strip() or "AI句式"))
    return out


def grade(hit: wu.Hit) -> str:
    """命中分级：🔴 必须改 / 🟡 建议改 / 🟢 可选。表外规则（AI 句式）回落 🔴。"""
    return _GRADE_BY_RULE.get(hit.rule, "🔴")


def score_text(text: str, extra_banned: list[str] | None = None) -> Report:
    body = wu.strip_markdown(text)
    total_chars = wu.char_count(body)
    per_k = (total_chars / 1000.0) or 1.0
    per_hundred = (total_chars / 100.0) or 1.0

    sentences = wu.split_sentences(body)
    paragraphs = wu.split_paragraphs(body)
    sent_lengths = [wu.char_count(s) for s in sentences]
    para_lengths = [wu.char_count(p) for p in paragraphs]

    # 1. 结构均匀度 —— 句长权重 0.6、段长 0.4（句子是更细的信号）
    sent_cv = wu.coefficient_of_variation(sent_lengths)
    para_cv = wu.coefficient_of_variation(para_lengths)
    structure = round(
        0.6 * _scale(sent_cv, SENT_CV_FLOOR, SENT_CV_CEIL)
        + 0.4 * _scale(para_cv, PARA_CV_FLOOR, PARA_CV_CEIL),
        1,
    )

    hits: list[wu.Hit] = []

    # 2. 套话密度
    banned = wu.load_wordlist("banned_words") + list(extra_banned or [])
    if banned:
        pattern = re.compile("|".join(re.escape(w) for w in banned))
        hits.extend(wu.find_hits(body, pattern, rule="套话"))
    banned_count = sum(1 for h in hits if h.rule == "套话")
    banned_score = round(_clamp(10.0 - (banned_count / per_k) * BANNED_SLOPE), 1)

    # 3. AI 句式密度
    pattern_count = 0
    for regex, name in _load_patterns():
        found = wu.find_hits(body, regex, rule=name)
        hits.extend(found)
        pattern_count += len(found)
    pattern_score = round(_clamp(10.0 - (pattern_count / per_k) * PATTERN_SLOPE), 1)

    # 4. 书面腔浓度 —— 动词名词化命中 + 「的」字密度，各占一半
    bookish_words = wu.load_wordlist("bookish_words")
    bookish_count = 0
    if bookish_words:
        pattern = re.compile("|".join(re.escape(w) for w in bookish_words))
        found = wu.find_hits(body, pattern, rule="书面腔")
        hits.extend(found)
        bookish_count = len(found)
    de_density = len(_DE.findall(body)) / per_hundred
    bookish_score = round(
        0.5 * _clamp(10.0 - (bookish_count / per_k) * BOOKISH_SLOPE)
        + 0.5 * _scale(de_density, DE_FLOOR, DE_CEIL),
        1,
    )

    # 5. 具体度 —— 具体标记（数字 + 单位量词）对形容词的比值
    concrete_markers = wu.load_wordlist("concrete_markers")
    concrete_count = len(_NUMBER.findall(body))
    if concrete_markers:
        pattern = re.compile("|".join(re.escape(w) for w in concrete_markers))
        concrete_count += len(pattern.findall(body))
    adjectives = wu.load_wordlist("adjectives")
    adj_count = 0
    if adjectives:
        pattern = re.compile("|".join(re.escape(w) for w in adjectives))
        adj_count = len(pattern.findall(body))
    denominator = concrete_count + adj_count
    ratio = (concrete_count / denominator) if denominator else 0.0
    concrete_score = round(_scale(ratio, CONCRETE_FLOOR, CONCRETE_CEIL), 1)

    dimensions = {
        "结构均匀度": structure,
        "套话密度": banned_score,
        "AI句式密度": pattern_score,
        "书面腔浓度": bookish_score,
        "具体度": concrete_score,
    }
    return Report(
        total=round(sum(dimensions.values()), 1),
        dimensions=dimensions,
        hits=sorted(hits, key=lambda h: (h.line, h.col)),
        stats={
            "字数": float(total_chars),
            "句数": float(len(sentences)),
            "段数": float(len(paragraphs)),
            "句长变异系数": round(sent_cv, 3),
            "段长变异系数": round(para_cv, 3),
            "的字密度_每百字": round(de_density, 2),
            "具体度比值": round(ratio, 3),
        },
    )


def format_report(report: Report, source: str) -> str:
    lines = [f"# AI 味检测报告 — {source}", ""]
    verdict = "✅ 通过" if report.total >= PASS_THRESHOLD else "❌ 打回重写"
    lines.append(f"**总分 {report.total} / 50 — {verdict}**（阈值 {PASS_THRESHOLD}）")
    lines.append("")
    lines.append("| 维度 | 得分 |")
    lines.append("|---|---|")
    for name, value in report.dimensions.items():
        lines.append(f"| {name} | {value} / 10 |")
    lines.append("")
    lines.append("## 统计")
    for name, value in report.stats.items():
        lines.append(f"- {name}: {value}")
    if report.hits:
        lines.append("")
        lines.append("## 命中清单")
        lines.append("")
        lines.append("| 级别 | 行:列 | 命中 | 规则 |")
        lines.append("|---|---|---|---|")
        for hit in report.hits:
            lines.append(f"| {grade(hit)} | {hit.line}:{hit.col} | {hit.text} | {hit.rule} |")
    else:
        lines.append("")
        lines.append("## 命中清单")
        lines.append("")
        lines.append("无命中。")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AI 味检测")
    parser.add_argument("path", help="待检测的文本文件（.md / .txt）")
    parser.add_argument("--spec-lock", default=None, help="写作契约路径，取其中的禁用词")
    parser.add_argument("--json", action="store_true", help="输出 JSON 而非报告")
    args = parser.parse_args(argv)

    text = Path(args.path).read_text(encoding="utf-8")

    extra: list[str] = []
    if args.spec_lock:
        spec = wu.parse_spec_lock(Path(args.spec_lock))
        raw = spec.get("禁用清单", {}).get("禁用词", "")
        extra = [w.strip() for w in re.split(r"[,，、]", raw) if w.strip()]

    report = score_text(text, extra_banned=extra)

    if args.json:
        print(
            json.dumps(
                {
                    "total": report.total,
                    "pass": report.total >= PASS_THRESHOLD,
                    "dimensions": report.dimensions,
                    "stats": report.stats,
                    "hits": [
                        {"line": h.line, "col": h.col, "text": h.text, "rule": h.rule, "grade": grade(h)}
                        for h in report.hits
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(format_report(report, Path(args.path).name))

    return 0 if report.total >= PASS_THRESHOLD else 1


if __name__ == "__main__":
    sys.exit(main())
