#!/usr/bin/env python3
"""Python port of edit.js — image edit via POST /images/edits (multipart)."""

import argparse
import os
import sys
from pathlib import Path

from _shared import (
    DEFAULT_IMAGE_DIR,
    DEFAULT_MODEL,
    build_base_url,
    build_default_image_path,
    ensure_files_exist,
    extract_generated_bytes,
    load_ambient_env,
    mime_for,
    post_multipart,
    print_json,
    read_prompt_input,
    resolve_output,
    save_image,
    save_prompt,
    slugify,
)


def parse_cli(argv):
    parser = argparse.ArgumentParser(
        prog="edit.py",
        add_help=True,
        description="Image edit via POST /images/edits",
    )
    parser.add_argument("--image", help="Source image path (required)")
    parser.add_argument("--mask", help="Optional mask image path")
    parser.add_argument("--prompt", help="Edit prompt")
    parser.add_argument("--promptfile", help="Load prompt from a file")
    parser.add_argument("--prompt-output", dest="prompt_output", help="Save the final prompt to a specific file")
    parser.add_argument("--output", help=f"Output image path (default: {DEFAULT_IMAGE_DIR}/<slug>-<timestamp>.png)")
    parser.add_argument("--model", help=f"Model override (default: {DEFAULT_MODEL})")
    parser.add_argument("--size", help="Output size (WxH | auto)")
    parser.add_argument("--n", help="Number of images")
    parser.add_argument("--quality", help="auto | high | medium | low")
    parser.add_argument("--background", help="transparent | opaque | auto")
    parser.add_argument("--input-fidelity", dest="input_fidelity", help="low | high")
    parser.add_argument("--output-format", dest="output_format", help="png | jpeg | webp")
    parser.add_argument("--output-compression", dest="output_compression", help="Compression for jpeg/webp (0-100)")
    parser.add_argument("--moderation", help="low | auto")
    parser.add_argument("--no-proxy", dest="no_proxy", action="store_true", help="Ignore *_proxy env vars for the API call (matches the old Node fetch behavior)")
    parser.add_argument("--json", action="store_true", help="Print structured output")
    return parser.parse_args(argv)


def build_form(cfg, prompt):
    """Return (fields, files) for post_multipart, mirroring buildForm in edit.js."""
    fields = []
    files = []

    image_path = cfg.image
    image_bytes = Path(image_path).read_bytes()
    files.append(("image", Path(image_path).name, mime_for(image_path), image_bytes))

    if cfg.mask:
        mask_bytes = Path(cfg.mask).read_bytes()
        files.append(("mask", Path(cfg.mask).name, mime_for(cfg.mask), mask_bytes))

    fields.append(("prompt", prompt))
    fields.append(("model", cfg.model or os.environ.get("OPENAI_IMAGE_MODEL") or DEFAULT_MODEL))

    def append_if_present(key, value):
        if value is not None and value != "":
            fields.append((key, str(value)))

    append_if_present("size", cfg.size)
    append_if_present("n", cfg.n)
    append_if_present("quality", cfg.quality)
    append_if_present("background", cfg.background)
    append_if_present("input_fidelity", cfg.input_fidelity)
    append_if_present("output_format", cfg.output_format)
    append_if_present("output_compression", cfg.output_compression)
    append_if_present("moderation", cfg.moderation)
    return fields, files


def run(argv):
    cfg = parse_cli(argv)
    if cfg.no_proxy:
        os.environ["GPT_IMAGE_2_NO_PROXY"] = "1"

    if not cfg.image:
        raise ValueError("--image is required")

    load_ambient_env()
    ensure_files_exist([cfg.image, *( [cfg.mask] if cfg.mask else [] )], "Image file")
    prompt = read_prompt_input(cfg.prompt, cfg.promptfile)
    name_hint = slugify(" ".join(prompt.split()[:8]), "edited-image")
    # Prompt archiving is opt-in (claude-desktop change): only write the prompt
    # .md when the caller explicitly asks via --prompt-output. Mirrors generate.py.
    prompt_path = (
        save_prompt(prompt, cfg.prompt_output, name_hint) if cfg.prompt_output else None
    )
    output_path = resolve_output(cfg.output, build_default_image_path("edit", name_hint))
    fields, files = build_form(cfg, prompt)
    url = f"{build_base_url()}/images/edits"
    response = post_multipart(url, fields, files)
    content = extract_generated_bytes(response)
    save_image(output_path, content)

    if cfg.json:
        out = {
            "savedImage": output_path,
            "model": cfg.model or os.environ.get("OPENAI_IMAGE_MODEL") or DEFAULT_MODEL,
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
