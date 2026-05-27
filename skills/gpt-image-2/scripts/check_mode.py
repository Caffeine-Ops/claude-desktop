#!/usr/bin/env python3
"""Python port of check-mode.js — detect the runtime mode (A / A? / B-or-C).

Same logic and output keys as the JS version; `--json` prints the structured
result. See SKILL.md for what each mode means.
"""

import sys

from _shared import DEFAULT_MODEL, load_ambient_env
import os


def main():
    load_ambient_env()

    truthy = {"1", "true", "yes", "on", "y"}
    raw_flag = str(os.environ.get("ENABLE_GARDEN_IMAGEGEN") or "").strip().lower()
    garden_enabled = raw_flag in truthy

    api_key = os.environ.get("OPENAI_API_KEY") or ""
    base_url = os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1"
    model = os.environ.get("OPENAI_IMAGE_MODEL") or DEFAULT_MODEL

    if garden_enabled and api_key:
        mode = "A"
        recommendation = "garden"
        summary = (
            "MODE A · Garden 本地生图：用 scripts/generate.py / scripts/edit.py 直接出图并落盘。"
        )
    elif garden_enabled and not api_key:
        mode = "A?"
        recommendation = "garden-missing-key"
        summary = (
            "ENABLE_GARDEN_IMAGEGEN 已开，但缺 OPENAI_API_KEY。先向用户索要 key，或临时降级到 MODE B / C。"
        )
    else:
        mode = "B-or-C"
        recommendation = "host-or-advisor"
        summary = (
            "MODE B / C · 未启用 Garden。若宿主 Agent 自带图像工具（image_generation / dalle / "
            "mcp__*image* 等）→ MODE B：把 prompt 交给宿主出图。若宿主无图像工具 → MODE C：仅产出高质量 prompt 给用户。"
        )

    result = {
        "mode": mode,
        "recommendation": recommendation,
        "garden_mode_enabled": garden_enabled,
        "has_api_key": bool(api_key),
        "base_url": base_url,
        "model": model,
        "env_flag_value": raw_flag or "(unset)",
        "summary": summary,
    }

    if "--json" in sys.argv:
        import json

        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    def pad(s):
        return s.ljust(24)

    print("--- gpt-image-2 runtime mode ---")
    print(f"{pad('mode')}: {result['mode']}")
    print(f"{pad('recommendation')}: {result['recommendation']}")
    print(f"{pad('garden_mode_enabled')}: {result['garden_mode_enabled']}")
    print(f"{pad('has_api_key')}: {result['has_api_key']}")
    print(f"{pad('base_url')}: {result['base_url']}")
    print(f"{pad('model')}: {result['model']}")
    print(f"{pad('env_flag_value')}: {result['env_flag_value']}")
    print("")
    print(result["summary"])


if __name__ == "__main__":
    main()
