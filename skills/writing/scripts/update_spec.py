#!/usr/bin/env python3
"""改写作契约，并标出受影响、需要回改的已写章节。

用法：
    python3 scripts/update_spec.py <项目路径> --section 文风锁定 --key voice --value 市井烟火

为什么要有这个脚本而不是直接手改契约：契约是写手每节都要重读的执行
合同，改了它，**已经写完的章节并不会自动跟着变**。手改的人常常忘了
这一点，结果前三节是冷峻克制、后三节是市井烟火。这个脚本改完会明确
列出受影响的初稿文件，交给润色角色回改——把「改契约」和「回改正文」
绑成一件事，而不是两件容易漏做后半截的事。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import writing_utils as wu  # noqa: E402

# 段名 → 改这一段会影响什么。用于提示回改范围。
IMPACT_MAP: dict[str, str] = {
    "体裁": "体裁变更影响全篇结构，通常应重新走策划阶段而不是改契约",
    "目标": "读者/核心信息变更影响全篇取材与例子，所有已写章节需复核",
    "文风锁定": "文风/人称变更影响所有已写章节的语气与叙述视角",
    "结构": "结构或字数变更影响分节安排，需复核大纲",
    "人物档案": "人物设定变更影响所有该人物出场的章节",
    "伏笔表": "伏笔变更影响埋点与回收所在的章节",
    "禁用清单": "禁用词/句式变更需对所有已写章节重跑 AI 味检测",
    "平台格式": "平台变更影响段落长度与小标题密度，需重跑平台合规检查",
}


def set_field(spec_path: Path, section: str, key: str, value: str) -> None:
    """原地改契约的某个字段。

    逐行改而不是「解析成对象再整体重写」：契约里可能有用户自己加的
    注释行和空行，整体重写会把它们抹掉。
    """
    lines = spec_path.read_text(encoding="utf-8").splitlines()
    target_header = f"## {section}"

    if target_header not in lines:
        # 段不存在：在文件末尾补一段
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(target_header)
        lines.append(f"- {key}: {value}")
        spec_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return

    start = lines.index(target_header)
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].strip().startswith("## "):
            end = i
            break

    for i in range(start + 1, end):
        stripped = lines[i].strip()
        if not stripped.startswith("- "):
            continue
        # 用 writing_utils 的同一个切分器，别在这里自己 split(":")——
        # 人物档案/伏笔表是竖线记录，按冒号切会认错键（见 split_data_line 注释）
        parsed = wu.split_data_line(stripped[2:])
        if parsed and parsed[0] == key:
            indent = lines[i][: len(lines[i]) - len(lines[i].lstrip())]
            lines[i] = f"{indent}- {key}: {value}"
            spec_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            return

    # 键不存在：插在本段最后一条数据行之后（不是文件末尾）
    insert_at = start + 1
    for i in range(start + 1, end):
        if lines[i].strip().startswith("- "):
            insert_at = i + 1
    lines.insert(insert_at, f"- {key}: {value}")
    spec_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def affected_drafts(project_dir: Path, section: str) -> list[Path]:
    """受该段变更影响、需要回改的初稿文件。

    当前策略：只要契约变了，全部已写章节都要复核。刻意不做「智能」
    的按人物名筛选——漏掉一节的代价（读者读到不一致）远大于多看一节。
    """
    drafts_dir = project_dir / "drafts"
    if not drafts_dir.is_dir():
        return []
    return sorted(drafts_dir.glob("*.md"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="修改写作契约并标出受影响章节")
    parser.add_argument("project_path")
    parser.add_argument("--section", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--value", required=True)
    args = parser.parse_args(argv)

    project = Path(args.project_path)
    spec_path = project / "spec_lock.md"
    if not spec_path.exists():
        print(f"[writing] 错误：找不到写作契约 {spec_path}")
        return 1

    before = wu.parse_spec_lock(spec_path).get(args.section, {}).get(args.key, "（未设置）")
    set_field(spec_path, args.section, args.key, args.value)
    print(f"[writing] 契约已更新：[{args.section}] {args.key}：{before} → {args.value}")

    impact = IMPACT_MAP.get(args.section)
    if impact:
        print(f"[writing] 影响范围：{impact}")

    affected = affected_drafts(project, args.section)
    if affected:
        print(f"[writing] 以下 {len(affected)} 个已写章节需要润色角色回改：")
        for p in affected:
            print(f"  - {p.relative_to(project)}")
    else:
        print("[writing] 尚无已写章节，无需回改。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
