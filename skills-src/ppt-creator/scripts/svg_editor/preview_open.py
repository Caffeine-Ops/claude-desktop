#!/usr/bin/env python3
"""
PPT Master - Live Preview activation signal (Step 6, desktop-native)

Claude Desktop renders svg_output/ natively (LivePreviewEditor.tsx in the
「预览幻灯片」canvas tab) by reading SVG files directly over IPC — there is no
browser page and no HTTP server on this path. This script's only job is to be
a detectable activation signal: the desktop host watches the transcript for
this command and reads the project path from its own stdout, then starts
polling svg_output/ over IPC. It does not itself serve anything, holds no
lock, and exits immediately — there is nothing to shut down at the end of a
session.

Usage:
    python3 preview_open.py <project_dir> [--live]

--live creates an empty svg_output/ if missing (Executor writes into it as it
goes) — mirrors the old --live flag's directory-creation behavior, the only
part of it that still matters without a server process to keep alive.

Dependencies:
    None (standard library only)
"""

import argparse
import sys
from pathlib import Path
from typing import Optional


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Signal that live preview should activate for a project',
    )
    parser.add_argument('project_dir', help='Path to project directory')
    parser.add_argument(
        '--live', action='store_true',
        help='Executor mode: create svg_output/ if it does not exist yet',
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    project_path = Path(args.project_dir).resolve()
    if not project_path.is_dir():
        print(f'{project_path} is not a directory', file=sys.stderr)
        return 1

    svg_output = project_path / 'svg_output'
    if args.live:
        svg_output.mkdir(parents=True, exist_ok=True)
    elif not svg_output.is_dir():
        print(f'{svg_output} does not exist', file=sys.stderr)
        return 1

    # The desktop host's usePreviewServer scans Bash tool-call stdout for this
    # exact phrase and takes everything after the colon as the absolute
    # project path — resolved here, not left to the host to guess via shell
    # variable expansion. Keep this line's shape stable; it's a parsed
    # contract (see apps/studio/src/chat/stores/chat.ts).
    print(f'live preview ready: {project_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
