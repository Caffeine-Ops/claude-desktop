#!/usr/bin/env python3
"""
PPT Master - Eight Confirmations wait (Step 4, desktop-native)

Claude Desktop renders the Eight-Confirmations page natively (CanvasConfirm.tsx
in the 「问题」canvas tab) by reading and writing this project's confirm_ui
files directly over IPC — there is no browser page and no HTTP server on this
path. This script's only job is to be the synchronization point between the
skill flow and that native UI: it blocks until the stage it was told to watch
for shows up in result.json, so the calling Bash tool call doesn't return
until the user has actually answered.

The data contract is unchanged from the old Flask server (see
scripts/docs/confirm_ui.md): the Strategist writes
``<project>/confirm_ui/recommendations.json``; the user's choices land in
``<project>/confirm_ui/result.json``. This script does not care who writes
result.json — the desktop app's IPC write handler does today, but any process
that lands the right JSON shape satisfies the wait. That's what makes it a
pure stdlib waiter: no server, no port, no lock file, nothing to shut down.

Two-tier flow (unchanged): a Tier-1 submit records the anchor choices
(canvas / audience / content_divergence / mode / visual_style /
delivery_purpose) without closing the page; the AI reads them, re-derives
Tier-2 recommendations, and overwrites recommendations.json with ``tier: 2``.
Only the Tier-2 (``final``) submit is a full confirmation.

Usage:
    python3 confirm_wait.py <project_dir> --stage tier1 --fresh
    python3 confirm_wait.py <project_dir> --stage final
    python3 confirm_wait.py <project_dir> --stage final --fresh   # single-pass (e.g. beautify-pptx)

Exit codes:
    0   the target stage's result was received
    1   bad arguments / project_dir is not a directory / recommendations.json missing
    124 timed out — re-check result.json before falling back to chat

Dependencies:
    None (standard library only)
"""

import argparse
import json
import logging
import sys
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger('confirm_ui')

CONFIRM_DIR_NAME = 'confirm_ui'
RECOMMENDATIONS_NAME = 'recommendations.json'
RESULT_NAME = 'result.json'
CATALOGS_SNAPSHOT_NAME = 'catalogs.json'

# Local — sys.path injection for sibling module (code-style.md §3), same
# technique the old server.py used to reach scripts/config.py.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_STATIC_DIR = Path(__file__).resolve().parent / 'static'
_STATIC_CATALOGS_PATH = _STATIC_DIR / 'catalogs.json'

# Default wait budget, kept just under the 600s Bash-tool ceiling so the
# calling command returns before the harness kills it, instead of the harness
# doing an uncontrolled kill mid-wait. There is no detached child to keep
# living past this — a timeout here just means "re-check result.json, the
# user may still answer after this call returns" (see the module docstring).
WAIT_TIMEOUT_DEFAULT = 590

# Marker for the one-line JSON dump logged when the target stage is detected.
# This is NOT read by the skill flow (which only re-reads result.json from
# disk) — its sole consumer is claude-desktop's replay compiler
# (electron/main/replay/compileReplay.ts + replayPackage.ts), which has no
# other way to learn what the Eight-Confirmations page actually showed and
# what the user picked: recommendations.json/result.json are plain files the
# CLI never echoes, and by replay time recommendations.json may already be
# overwritten (tier 2 overwrites tier 1 in place) or the project directory
# gone. Logging all three together, at the exact moment this stage is
# confirmed, is the only point where a consistent snapshot of "what options
# existed" + "what was recommended" + "what the user chose" all still exist.
# Kept human-scannable (prefix + compact JSON on its own line) rather than
# folded into the existing `logger.info` sentence so a regex can lift it
# without also matching the surrounding prose.
RESULT_LOG_MARKER = '[[confirm-result]]'


def _result_stage(result_file: Path) -> Optional[str]:
    """Return the ``stage`` field of result.json (``tier1`` / ``final``), or None."""
    try:
        data = json.loads(result_file.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None
    return data.get('stage') if isinstance(data, dict) else None


def _build_catalogs() -> dict:
    """Return the static catalog set with the canvas list synced live from
    ``config.CANVAS_FORMATS`` — the single source of truth for canvas formats —
    so the confirm page can never drift from the pipeline's real formats. The
    set of formats and their dimensions come from config; bilingual labels and
    use text are kept from catalogs.json (with a plain fallback for any new id).
    """
    data = json.loads(_STATIC_CATALOGS_PATH.read_text(encoding='utf-8'))
    try:
        import config  # scripts/ is on sys.path (injected above)
        formats = config.CANVAS_FORMATS
    except (ImportError, AttributeError):  # missing module/attr → static canvas
        return data
    existing = {
        c.get('id'): c
        for c in data.get('canvas', [])
        if isinstance(c, dict) and c.get('id')
    }
    canvas = []
    for cid, fmt in formats.items():
        entry = dict(existing.get(cid, {}))
        entry['id'] = cid
        entry['dim'] = fmt.get('dimensions', entry.get('dim', ''))
        if not entry.get('label'):
            name = fmt.get('name', cid)
            entry['label'] = name
            entry.setdefault('label_zh', name)
            entry.setdefault('label_en', name)
        if not entry.get('use_en') and fmt.get('use_case'):
            entry['use_en'] = fmt['use_case']
        canvas.append(entry)
    data['canvas'] = canvas
    return data


def _prepare_fresh(confirm_dir: Path) -> None:
    """Reset this confirmation round: clear any stale result.json from a
    previous run of this project (otherwise the stage guard below would see a
    leftover ``stage: final`` and return instantly without a real
    confirmation), and write a fresh catalogs snapshot into the project so the
    native UI's boot read gets an exact, self-contained option set instead of
    reaching back into the skill install directory.

    ``_meta.static_dir`` points at the skill's own static/ folder (which still
    ships style-previews/ and canvas-previews/ image sets even though the
    Flask page and its bundled HTML/JS are gone) — that's the one place the
    native UI's preview images can be read from via the desktop app's existing
    absolute-path image IPC.
    """
    result_file = confirm_dir / RESULT_NAME
    try:
        result_file.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        logger.warning('could not clear stale result.json: %s', exc)

    catalogs = _build_catalogs()
    catalogs['_meta'] = {'static_dir': str(_STATIC_DIR)}
    (confirm_dir / CATALOGS_SNAPSHOT_NAME).write_text(
        json.dumps(catalogs, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )


def _log_result_snapshot(result_file: Path, stage: str, catalogs_snapshot_file: Path) -> None:
    """Best-effort: log the just-written result.json, the recommendations.json
    it was answering, and the catalogs snapshot this round showed, all
    together, behind the marker above. Never raises — a malformed/unreadable
    file only costs the replay-only marker line, not the wait contract.
    """
    try:
        result = json.loads(result_file.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(result, dict):
        return
    recommendations: object = None
    try:
        recommendations = json.loads(
            (result_file.parent / RECOMMENDATIONS_NAME).read_text(encoding='utf-8')
        )
    except (OSError, json.JSONDecodeError):
        pass  # recommendations snapshot is best-effort — result alone still logs
    catalogs: object = None
    try:
        catalogs = json.loads(catalogs_snapshot_file.read_text(encoding='utf-8'))
        if isinstance(catalogs, dict):
            catalogs.pop('_meta', None)  # desktop-only path hint, not replay data
    except (OSError, json.JSONDecodeError):
        pass  # catalogs snapshot is best-effort too, same reasoning
    snapshot = {
        'stage': stage,
        'result': result,
        'recommendations': recommendations,
        'catalogs': catalogs,
    }
    logger.info('%s%s', RESULT_LOG_MARKER, json.dumps(snapshot, ensure_ascii=False))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Wait for the native Eight Confirmations UI to write a result',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('project_dir', help='Path to project directory')
    parser.add_argument(
        '--stage', choices=('tier1', 'final'), required=True,
        help='Which confirmation stage to wait for: tier1 = anchors, '
             'final = tier-2 realization (or the whole thing, single-pass).',
    )
    parser.add_argument(
        '--fresh', action='store_true',
        help='Start a new confirmation round: clear any stale result.json '
             'and write a fresh catalogs snapshot. Pass on the first wait of '
             'a round (the Tier-1 leg of the two-tier flow, or the only leg '
             'of a single-pass flow like beautify-pptx). Do NOT pass on the '
             'Tier-2 leg — that would delete the Tier-1 result it depends on.',
    )
    parser.add_argument(
        '--timeout', type=int, default=WAIT_TIMEOUT_DEFAULT,
        help=f'Seconds to wait before returning 124 (default and hard ceiling: '
             f'{WAIT_TIMEOUT_DEFAULT}s; values <=0 or above the ceiling are '
             'clamped to it). There is intentionally no way to disable the '
             'wait: this script must always return control to the caller '
             'before the Bash-tool ceiling would kill it uncontrolled — see '
             'WAIT_TIMEOUT_DEFAULT above.',
    )
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format='[%(asctime)s] [%(levelname)s] confirm_ui: %(message)s',
        datefmt='%H:%M:%S',
    )

    project_path = Path(args.project_dir).resolve()
    if not project_path.is_dir():
        logger.error('%s is not a directory', project_path)
        return 1

    confirm_dir = project_path / CONFIRM_DIR_NAME
    rec_file = confirm_dir / RECOMMENDATIONS_NAME
    if not rec_file.exists():
        logger.error(
            '%s not found — Strategist must write recommendations.json before waiting',
            rec_file,
        )
        return 1

    if args.fresh:
        _prepare_fresh(confirm_dir)

    result_file = confirm_dir / RESULT_NAME
    catalogs_snapshot_file = confirm_dir / CATALOGS_SNAPSHOT_NAME

    logger.info('waiting for %s confirmation...', args.stage)
    # No infinite-wait escape hatch, on purpose: a caller passing --timeout 0
    # (or anything above the ceiling) used to mean "wait forever," which lets
    # a confused caller retry-with-no-limit and strand the whole conversation
    # turn with nothing that can ever unblock it. Clamping instead of
    # honoring an out-of-range value keeps the one guarantee this script
    # exists for — always hand control back before the outer Bash-tool
    # ceiling would kill it uncontrolled (see WAIT_TIMEOUT_DEFAULT above).
    effective_timeout = (
        args.timeout if 0 < args.timeout <= WAIT_TIMEOUT_DEFAULT else WAIT_TIMEOUT_DEFAULT
    )
    deadline = time.time() + effective_timeout
    while True:
        # The stage guard alone is the signal (no mtime gate): for tier1,
        # result.json was just cleared by --fresh, so any 'tier1' is this
        # round's anchor submit. For final, this round's tier-1 confirm
        # already left result.json at stage 'tier1', so any 'final' is the
        # tier-2 submit. A mtime gate would race-miss a user who answers
        # before this wait is even issued.
        if _result_stage(result_file) == args.stage:
            logger.info('%s confirmation received: %s', args.stage, result_file)
            _log_result_snapshot(result_file, args.stage, catalogs_snapshot_file)
            return 0

        if time.time() >= deadline:
            logger.error(
                'timed out waiting for %s confirmation — the app may still be '
                'open; re-check %s before falling back to chat', args.stage, result_file,
            )
            return 124

        time.sleep(0.5)


if __name__ == '__main__':
    raise SystemExit(main())
