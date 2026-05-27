#!/usr/bin/env python3
"""Python port of generate.js — text-to-image via POST /images/generations."""

import argparse
import os
import sys

from _shared import (
    DEFAULT_IMAGE_DIR,
    DEFAULT_MODEL,
    build_base_url,
    build_default_image_path,
    ensure_files_exist,
    extract_generated_bytes,
    load_ambient_env,
    post_json,
    print_json,
    read_prompt_input,
    resolve_output,
    save_image,
    save_prompt,
    slugify,
)


def parse_cli(argv):
    parser = argparse.ArgumentParser(
        prog="generate.py",
        add_help=True,
        description="Text-to-image via POST /images/generations",
    )
    parser.add_argument("--prompt", help="Prompt text")
    parser.add_argument("--promptfile", help="Load prompt from a file")
    parser.add_argument("--prompt-output", dest="prompt_output", help="Save the final prompt to a specific file")
    parser.add_argument("--image", dest="image_path", help=f"Output image path (default: {DEFAULT_IMAGE_DIR}/<slug>-<timestamp>.png)")
    parser.add_argument("--model", help=f"Model override (default: {DEFAULT_MODEL})")
    parser.add_argument("--size", help="Output size, e.g. 1024x1024")
    parser.add_argument("--n", help="Number of images")
    parser.add_argument("--quality", help="auto | high | medium | low")
    parser.add_argument("--background", help="transparent | opaque | auto")
    parser.add_argument("--moderation", help="low | auto")
    parser.add_argument("--output-format", dest="output_format", help="png | jpeg | webp")
    parser.add_argument("--output-compression", dest="output_compression", help="Compression for jpeg/webp (0-100)")
    parser.add_argument("--no-proxy", dest="no_proxy", action="store_true", help="Ignore *_proxy env vars for the API call (matches the old Node fetch behavior)")
    parser.add_argument("--json", action="store_true", help="Print structured output")
    return parser.parse_args(argv)


def build_payload(cfg, prompt):
    payload = {
        "prompt": prompt,
        "model": cfg.model or os.environ.get("OPENAI_IMAGE_MODEL") or DEFAULT_MODEL,
    }
    if cfg.size:
        payload["size"] = cfg.size
    if cfg.n:
        payload["n"] = int(cfg.n)
    if cfg.quality:
        payload["quality"] = cfg.quality
    if cfg.background:
        payload["background"] = cfg.background
    if cfg.moderation:
        payload["moderation"] = cfg.moderation
    if cfg.output_format:
        payload["output_format"] = cfg.output_format
    if cfg.output_compression:
        payload["output_compression"] = int(cfg.output_compression)
    return payload


def run(argv):
    cfg = parse_cli(argv)
    if cfg.no_proxy:
        os.environ["GPT_IMAGE_2_NO_PROXY"] = "1"

    load_ambient_env()
    prompt = read_prompt_input(cfg.prompt, cfg.promptfile)
    name_hint = slugify(" ".join(prompt.split()[:8]), "generated-image")
    # Prompt archiving is opt-in (claude-desktop change): only write the prompt
    # .md when the caller explicitly asks via --prompt-output. The default no
    # longer litters a garden-gpt-image-2/prompt/ dir into the cwd.
    prompt_path = (
        save_prompt(prompt, cfg.prompt_output, name_hint) if cfg.prompt_output else None
    )
    output_path = resolve_output(cfg.image_path, build_default_image_path("generate", name_hint))
    ensure_files_exist([], "input")

    payload = build_payload(cfg, prompt)
    url = f"{build_base_url()}/images/generations"
    response = post_json(url, payload)
    content = extract_generated_bytes(response)
    save_image(output_path, content)

    if cfg.json:
        out = {
            "savedImage": output_path,
            "model": payload["model"],
            "requestUrl": url,
            "apiResponse": response,
        }
        if prompt_path:
            out["savedPrompt"] = prompt_path
        print_json(out)
        return

    print(output_path)


def main():
    try:
        run(sys.argv[1:])
    except Exception as error:  # noqa: BLE001 — match JS top-level catch
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
