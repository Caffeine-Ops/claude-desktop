#!/usr/bin/env python3
"""writing skill 的共享文本工具。

所有质检脚本都从这里取切分、统计与定位能力——切句规则只有一份，
避免各脚本各切各的、同一段正文在不同报告里句数不一致。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"

# 句末标点。中文正文一句话以这些收尾，后面可能紧跟收尾引号/括号——
# 那些符号属于上一句，不能切到下一句去（“他说：“我不去。”” 是一句）。
_SENT_END_CHARS = "。！？!?…"
_CLOSING_CHARS = "」』”’）)】》"

_FENCE = re.compile(r"^\s*```")

# 图片语法。前导 ! 是与普通链接 [文字](url) 的唯一区别，不能省——
# 省了会把正文里的链接文字也一起吃掉。alt 允许为空（![](x.png)）。
# 路径部分用 [^)]* 而非 \S+：markdown 允许 `![图](路径 "标题")` 带标题后缀。
_IMAGE_SYNTAX = re.compile(r"!\[[^\]]*\]\([^)]*\)")


@dataclass
class Hit:
    """一次规则命中，带行列定位——报告要能让人直接跳到那一行。"""

    line: int
    col: int
    text: str
    rule: str


def split_sentences(text: str) -> list[str]:
    """按中文句末标点切句。

    不用正则 split：收尾引号与连续省略号的归属需要向前吞字，
    正则的 lookaround 写法在这两种情况下都会切错。
    """
    sentences: list[str] = []
    buf: list[str] = []
    i = 0
    while i < len(text):
        ch = text[i]
        buf.append(ch)
        if ch in _SENT_END_CHARS:
            j = i + 1
            # 吞掉紧跟的句末标点（省略号、！？连用）与收尾引号
            while j < len(text) and (text[j] in _SENT_END_CHARS or text[j] in _CLOSING_CHARS):
                buf.append(text[j])
                j += 1
            chunk = "".join(buf).strip()
            if chunk:
                sentences.append(chunk)
            buf = []
            i = j
            continue
        i += 1
    tail = "".join(buf).strip()
    if tail:
        sentences.append(tail)
    return sentences


def split_paragraphs(text: str) -> list[str]:
    """非空行即一段——中文写作在 Markdown 里的通行习惯。"""
    return [line.strip() for line in text.splitlines() if line.strip()]


def strip_markdown(text: str) -> str:
    """剥掉不该进正文统计的部分：小标题、代码块、引用标记。

    小标题必须剥掉：它们天然极短，留着会把段落长度方差算虚高，
    正好掩盖掉「正文段落长得一样齐」这个 AI 味信号。
    """
    out: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if _FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        stripped = line.strip()
        # 只剥「真标题」——标准 Markdown 要求 # 后带空格（`# 标题`）。
        # 不能用 startswith("#")：小红书/朋友圈的话题标签 `#职场 #成长`（# 后无空格）
        # 是正文，剥掉会把这些字漏出 char_count，让 readability 误报「字数不足」。
        # 与 readability_check._HEADING 的口径（#{1,6}\s）保持一致。
        if re.match(r"#{1,6}\s", stripped):
            continue
        if stripped.startswith(">"):
            stripped = stripped.lstrip("> ").strip()
        # 剥图片语法：图说（alt）不是正文，是配图说明；路径更不是。
        # 剥完若整行变空，交给下游 split_paragraphs 丢掉即可（它本来就跳空行），
        # 这里不显式 continue —— 少一条分支，也保住 char_count 的现有行为。
        stripped = _IMAGE_SYNTAX.sub("", stripped).strip()
        out.append(stripped)
    return "\n".join(out)


def coefficient_of_variation(values: list[float]) -> float:
    """变异系数（标准差 ÷ 均值）。

    用它而不是裸标准差：长文与短文的绝对句长差很多，只有归一化后
    才能跨文本比较「参差程度」。
    """
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    if mean == 0:
        return 0.0
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    return (variance**0.5) / mean


def find_hits(text: str, pattern: re.Pattern, rule: str) -> list[Hit]:
    """逐行匹配，返回带行列号的命中列表。"""
    hits: list[Hit] = []
    for idx, line in enumerate(text.splitlines(), start=1):
        for m in pattern.finditer(line):
            hits.append(Hit(line=idx, col=m.start() + 1, text=m.group(0), rule=rule))
    return hits


def load_wordlist(name: str) -> list[str]:
    """读 scripts/data/<name>.txt。空行与 # 开头的注释行跳过。"""
    path = DATA_DIR / f"{name}.txt"
    if not path.exists():
        return []
    words: list[str] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        words.append(s)
    return words


def char_count(text: str) -> int:
    """正文字数：不含空白字符。中文写作的「字数」按字算，不按词。"""
    return len(re.sub(r"\s", "", text))


def split_data_line(body: str) -> tuple[str, str] | None:
    """把一条 `- ` 数据行的正文切成 (key, value)。返回 None 表示不是数据行。

    契约里有两种行：
      简单键值   `voice: 冷峻克制`                       → 按第一个冒号切
      竖线记录   `张明 | want:找到妹妹 | need:原谅自己`   → 按第一个竖线切

    必须先判断竖线：竖线记录里的冒号出现在竖线之后，按冒号切会得到
    `张明 | want` 这种废键，人物档案与伏笔表整段静默解析失败（而且不报错，
    只是查不出问题 —— 最难发现的那种坏法）。
    """
    pipe = body.find("|")
    colon = body.find(":")
    if pipe >= 0 and (colon < 0 or pipe < colon):
        key, _, value = body.partition("|")
    elif colon >= 0:
        key, _, value = body.partition(":")
    else:
        return None
    return key.strip(), value.strip()


def parse_spec_lock(path: Path) -> dict[str, dict[str, str]]:
    """解析写作契约。

    格式固定为 `## 段名` + 若干 `- ` 数据行——刻意保持成人类可读的
    Markdown 而不是 JSON/YAML：用户会直接打开它看、偶尔手改，
    Markdown 是唯一两边都舒服的格式。
    """
    result: dict[str, dict[str, str]] = {}
    section = ""
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s.startswith("## "):
            section = s[3:].strip()
            result.setdefault(section, {})
            continue
        if s.startswith("- ") and section:
            parsed = split_data_line(s[2:])
            if parsed is None:
                continue
            result[section][parsed[0]] = parsed[1]
    return result
