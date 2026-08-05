#!/usr/bin/env python3
"""writing skill 项目管理。

用法：
    python3 scripts/project_manager.py init <项目名> [--dir <路径>]
    python3 scripts/project_manager.py validate <项目路径>
    python3 scripts/project_manager.py info <项目路径>

项目目录即真相：不维护任何中央索引文件，删目录就等于删项目。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_PROJECTS_DIR = SKILL_DIR / "projects"

# 项目内的固定子目录。每个都有明确归属，不允许写串：
#   sources/  用户给的原始素材 + 转好的 Markdown
#   analysis/ 机器提取的事实（素材摘要、文风分析、AI 味基线分）
#   drafts/   初稿分节，一节一个文件
#   images/   配图（AI 生成 / 用户提供）。与 drafts/ 平级，
#             所以正文里的相对路径恒为 ../images/<文件名>
#   reviews/  质检报告
#   output/   定稿与各平台导出
SUBDIRS = ("sources", "analysis", "drafts", "images", "reviews", "output")

# validate 的必需集刻意**不含 images**：它是 2026-08-03 才加的目录，
# 此前建的项目都没有。把新目录列进必需项，会让所有老项目一夜之间被判
# 「结构不完整」——纯粹的向后兼容伤害，零收益。新项目照常会建出来。
REQUIRED_SUBDIRS = ("sources", "analysis", "drafts", "reviews", "output")

_SLUG_RE = re.compile(r"[^a-z0-9一-鿿]+")


def slugify(name: str) -> str:
    """项目名 → 目录安全的 slug。保留中文，其余非字母数字压成下划线。"""
    s = _SLUG_RE.sub("_", name.strip().lower()).strip("_")
    return s or "untitled"


def init_project(name: str, base_dir: Path, today: str) -> Path:
    project_dir = base_dir / f"{slugify(name)}_{today}"
    project_dir.mkdir(parents=True, exist_ok=True)
    for sub in SUBDIRS:
        (project_dir / sub).mkdir(exist_ok=True)
    readme = project_dir / "README.md"
    if not readme.exists():
        readme.write_text(
            f"# {name}\n\n"
            f"创建于 {today}。\n\n"
            "- `sources/` 原始素材与转好的 Markdown\n"
            "- `analysis/` 机器提取的事实\n"
            "- `drafts/` 初稿分节\n"
            "- `images/` 配图（正文里以 ../images/ 相对路径引用）\n"
            "- `reviews/` 质检报告\n"
            "- `output/` 定稿与导出\n\n"
            "`design_spec.md` 是写作方案，`spec_lock.md` 是写作契约"
            "（写手每写一节前必须重读）。\n",
            encoding="utf-8",
        )
    return project_dir


def validate_project(project_dir: Path) -> list[str]:
    """返回问题列表，空列表代表结构完整。"""
    problems: list[str] = []
    if not project_dir.is_dir():
        return [f"项目目录不存在：{project_dir}"]
    for sub in REQUIRED_SUBDIRS:
        if not (project_dir / sub).is_dir():
            problems.append(f"缺少子目录：{sub}/")
    if not (project_dir / "spec_lock.md").exists():
        problems.append("缺少 spec_lock.md（写作契约尚未生成，策划阶段未完成）")
    return problems


def project_info(project_dir: Path) -> dict:
    drafts = sorted((project_dir / "drafts").glob("*.md")) if (project_dir / "drafts").is_dir() else []
    return {
        "path": str(project_dir),
        "has_design_spec": (project_dir / "design_spec.md").exists(),
        "has_spec_lock": (project_dir / "spec_lock.md").exists(),
        "draft_sections": [p.name for p in drafts],
        "problems": validate_project(project_dir),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="writing skill 项目管理")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="新建项目目录")
    p_init.add_argument("name")
    p_init.add_argument("--dir", default=str(DEFAULT_PROJECTS_DIR))
    p_init.add_argument("--date", default=None, help="日期戳，默认今天（YYYYMMDD）")

    p_val = sub.add_parser("validate", help="校验项目结构")
    p_val.add_argument("project_path")

    p_info = sub.add_parser("info", help="打印项目状态 JSON")
    p_info.add_argument("project_path")

    args = parser.parse_args(argv)

    if args.cmd == "init":
        today = args.date or datetime.now().strftime("%Y%m%d")
        path = init_project(args.name, Path(args.dir), today)
        print(f"[writing] 项目已创建：{path}")
        # 桌面端接管标记：Cowork 的写作工作区从这一行抓项目绝对路径。
        # 同款手法见 bin/ensure-python.cmd 的 `WRITING_PY=<path>`——脚本自己报数，
        # 免得调用方复刻 slugify 规则（中文保留、其余压下划线），两边一漂就找不到目录。
        # 必须是最后一行且独占一行，前端按行首 `WRITING_PROJECT=` 匹配。
        print(f"WRITING_PROJECT={path.resolve()}")
        return 0

    if args.cmd == "validate":
        problems = validate_project(Path(args.project_path))
        if problems:
            for p in problems:
                print(f"[writing] ✗ {p}")
            return 1
        print("[writing] ✓ 项目结构完整")
        return 0

    print(json.dumps(project_info(Path(args.project_path)), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
