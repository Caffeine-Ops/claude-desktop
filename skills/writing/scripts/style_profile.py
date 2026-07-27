#!/usr/bin/env python3
"""从用户往期文章提取个人文风档案。

用法：
    python3 scripts/style_profile.py <文件或目录> --out <档案路径>

产出的档案给两个人看：用户（「原来我爱这么写」）和策划角色（把
建议行直接抄进 spec_lock.md）。所以档案末尾必须有一段可直接复制的
契约字段，而不是只给一堆统计数字——数字本身不构成可执行的约束。

方法上刻意只用频次统计，不做语义分析：文风的可操作特征（句子多长、
爱用什么口头禅、标点习惯）恰好都是可数的，而「语气偏温暖」这类判断
模型自己读几段就能得出，不需要脚本。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import writing_utils as wu  # noqa: E402

# 候选短语长度：2–4 字。中文口头禅（「说白了」「我觉得」「其实吧」）
# 基本都落在这个区间，再长就是句子而非习惯用语了。
PHRASE_MIN, PHRASE_MAX = 2, 4
# 进高频表的门槛：至少出现 2 次。只出现一次的不是习惯，是巧合。
PHRASE_MIN_COUNT = 2
PHRASE_TOP_N = 20

_CJK = re.compile(r"[一-龥]+")
_PUNCT_OF_INTEREST = "？！…，；：、"


def _extract_phrases(text: str) -> Counter:
    """从连续汉字片段里切出 2–4 字候选短语并计数。"""
    counter: Counter = Counter()
    for chunk in _CJK.findall(text):
        for size in range(PHRASE_MIN, PHRASE_MAX + 1):
            for i in range(len(chunk) - size + 1):
                counter[chunk[i : i + size]] += 1
    return counter


def build(texts: list[str]) -> dict:
    bodies = [wu.strip_markdown(t) for t in texts]
    joined = "\n".join(bodies)

    sentences = wu.split_sentences(joined)
    paragraphs = wu.split_paragraphs(joined)
    sent_lengths = [wu.char_count(s) for s in sentences]
    para_lengths = [wu.char_count(p) for p in paragraphs]
    total_chars = wu.char_count(joined)

    phrase_counter = _extract_phrases(joined)
    # 过滤：出现次数达标，且不是更长高频短语的子串（避免「说白」「白了」
    # 与「说白了」同时上榜刷屏）
    candidates = [
        (phrase, count)
        for phrase, count in phrase_counter.items()
        if count >= PHRASE_MIN_COUNT
    ]
    candidates.sort(key=lambda kv: (-kv[1], -len(kv[0])))
    kept: list[tuple[str, int]] = []
    for phrase, count in candidates:
        if any(phrase in longer and phrase != longer and c >= count for longer, c in kept):
            continue
        kept.append((phrase, count))
        if len(kept) >= PHRASE_TOP_N:
            break

    punct = {ch: joined.count(ch) for ch in _PUNCT_OF_INTEREST if joined.count(ch) > 0}

    return {
        "样本数": len(texts),
        "总字数": total_chars,
        "句数": len(sentences),
        "段数": len(paragraphs),
        "平均句长": round(sum(sent_lengths) / len(sent_lengths), 1) if sent_lengths else 0.0,
        "句长变异系数": round(wu.coefficient_of_variation(sent_lengths), 3),
        "平均段长": round(sum(para_lengths) / len(para_lengths), 1) if para_lengths else 0.0,
        "段长变异系数": round(wu.coefficient_of_variation(para_lengths), 3),
        "高频短语": [{"短语": p, "次数": c} for p, c in kept],
        "标点偏好": punct,
    }


def _suggest_colloquial_level(profile: dict) -> int:
    """口语化程度 1–5。句子越短、问号叹号越多，越口语。

    这是个粗判断，给策划一个起点，用户可在八项确认里改。
    """
    avg = profile.get("平均句长", 0) or 0
    punct = profile.get("标点偏好", {})
    lively = punct.get("？", 0) + punct.get("！", 0)
    total = max(profile.get("句数", 1), 1)
    score = 3
    if avg < 18:
        score += 1
    if avg > 32:
        score -= 1
    if lively / total > 0.15:
        score += 1
    return max(1, min(5, score))


def render_markdown(profile: dict) -> str:
    lines = ["# 个人文风档案", ""]
    lines.append("> 由 `style_profile.py` 从往期文章统计得出。策划角色可把末尾")
    lines.append("> 「写作契约建议」整段抄进 `spec_lock.md`。")
    lines.append("")
    lines.append("## 统计特征")
    lines.append("")
    lines.append("| 指标 | 值 |")
    lines.append("|---|---|")
    for key in ("样本数", "总字数", "句数", "段数", "平均句长", "句长变异系数", "平均段长", "段长变异系数"):
        lines.append(f"| {key} | {profile.get(key, 0)} |")
    lines.append("")

    lines.append("## 高频短语")
    lines.append("")
    if profile.get("高频短语"):
        lines.append("| 短语 | 次数 |")
        lines.append("|---|---|")
        for item in profile["高频短语"]:
            lines.append(f"| {item['短语']} | {item['次数']} |")
        lines.append("")
        lines.append("> 这些是你的口头禅。写手应当**适度**复用（每千字 1–2 处），")
        lines.append("> 而不是每段都塞——高频词堆密了反而假。")
    else:
        lines.append("样本太少，未识别出稳定的高频短语。")
    lines.append("")

    lines.append("## 标点偏好")
    lines.append("")
    punct = profile.get("标点偏好", {})
    lines.append("、".join(f"{k}×{v}" for k, v in punct.items()) if punct else "无显著偏好。")
    lines.append("")

    level = _suggest_colloquial_level(profile)
    lines.append("## 写作契约建议")
    lines.append("")
    lines.append("```")
    lines.append("## 文风锁定")
    lines.append(f"- colloquial_level: {level}/5")
    lines.append(f"- 目标平均句长: {profile.get('平均句长', 0)} 字")
    lines.append(f"- 目标句长变异系数: ≥ {profile.get('句长变异系数', 0)}")
    phrases = "、".join(item["短语"] for item in profile.get("高频短语", [])[:6])
    lines.append(f"- 个人口头禅: {phrases or '（无）'}")
    lines.append("```")
    return "\n".join(lines)


def _collect_texts(target: Path) -> list[str]:
    if target.is_file():
        return [target.read_text(encoding="utf-8")]
    texts: list[str] = []
    for path in sorted(target.rglob("*")):
        if path.suffix.lower() in (".md", ".txt") and path.is_file():
            texts.append(path.read_text(encoding="utf-8"))
    return texts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="提取个人文风档案")
    parser.add_argument("target", help="单个文件或包含往期文章的目录")
    parser.add_argument("--out", default=None, help="档案输出路径（.md）")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    texts = _collect_texts(Path(args.target))
    if not texts:
        print(f"[writing] 错误：{args.target} 下没有找到 .md / .txt 文件")
        return 1

    profile = build(texts)

    if args.json:
        print(json.dumps(profile, ensure_ascii=False, indent=2))
        return 0

    markdown = render_markdown(profile)
    if args.out:
        Path(args.out).write_text(markdown, encoding="utf-8")
        print(f"[writing] 文风档案已生成：{args.out}（样本 {len(texts)} 篇）")
    else:
        print(markdown)
    return 0


if __name__ == "__main__":
    sys.exit(main())
