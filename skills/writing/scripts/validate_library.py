#!/usr/bin/env python3
"""资源库结构校验 —— 内容任务的自动化防线。

用法：
    python3 scripts/validate_library.py [--skill-dir <路径>]

资源库（文风 / 结构 / 体裁手册）是几十份 Markdown，人写容易漏：
新增一份文风却忘了登记进 _index.md，SKILL.md 让模型「只读索引里
列出的那一份」，这份新文风就永远不会被选中——静默失效、零报错。
这个脚本把「索引必须列全同级文件」和「每份手册必须有约定章节」
变成可执行的检查。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# 各资源库要求的章节标题。改这里等于改内容规范，两边不会漂移。
REQUIRED_SECTIONS: dict[str, list[str]] = {
    "voices": ["识别特征", "句式偏好", "词汇取向", "适配体裁", "反例"],
    "structures": ["骨架", "各段职责", "适用场景", "常见失败", "骨架示例"],
    # 「目标定义」刻意用中性词：小说填情绪落点、文案填转化目标、文章填核心论点，
    # 三体裁共用一套章节骨架，校验脚本才不用按体裁分叉。
    "genres": ["目标定义", "结构要点", "写作手法", "自检清单", "改写诊断要点"],
}

_LINK = re.compile(r"\(\./([^)]+\.md)\)")


def _check_dir(lib_dir: Path, kind: str, problems: list[str]) -> None:
    rel = lib_dir.name
    index = lib_dir / "_index.md"
    siblings = sorted(p.name for p in lib_dir.glob("*.md") if p.name != "_index.md")

    if not siblings:
        return

    if not index.exists():
        problems.append(f"{rel}/ 缺少 _index.md（索引缺失，模型无从选择）")
    else:
        listed = set(_LINK.findall(index.read_text(encoding="utf-8")))
        for name in siblings:
            if name not in listed:
                problems.append(f"{rel}/_index.md 索引里没有列出 {name}（该文件将永远不会被选中）")

    required = REQUIRED_SECTIONS.get(kind, [])
    for name in siblings:
        content = (lib_dir / name).read_text(encoding="utf-8")
        headings = {
            line.strip().lstrip("#").strip()
            for line in content.splitlines()
            if line.strip().startswith("#")
        }
        for section in required:
            if section not in headings:
                problems.append(f"{rel}/{name} 缺少章节「{section}」")


def validate(skill_dir: Path) -> list[str]:
    problems: list[str] = []
    references = skill_dir / "references"
    if not references.is_dir():
        return [f"找不到 references/ 目录：{references}"]

    for kind in REQUIRED_SECTIONS:
        base = references / kind
        if not base.is_dir():
            continue
        # voices/ 是平铺的；structures/ 与 genres/ 下还有一层子目录
        if any(p.is_dir() for p in base.iterdir()):
            for sub in sorted(p for p in base.iterdir() if p.is_dir()):
                _check_dir(sub, kind, problems)
        else:
            _check_dir(base, kind, problems)

    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="资源库结构校验")
    parser.add_argument("--skill-dir", default=str(Path(__file__).resolve().parent.parent))
    args = parser.parse_args(argv)

    problems = validate(Path(args.skill_dir))
    if problems:
        for p in problems:
            print(f"[writing] ✗ {p}")
        print(f"[writing] 共 {len(problems)} 处问题")
        return 1
    print("[writing] ✓ 资源库结构完整")
    return 0


if __name__ == "__main__":
    sys.exit(main())
