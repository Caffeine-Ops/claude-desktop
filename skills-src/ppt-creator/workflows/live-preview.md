---
description: Signal live preview activation when the tab is empty, and apply submitted annotations after Step 7 export
---

# Live Preview Workflow

> **Purpose**: (1) (re-)signal live preview activation when the 「预览幻灯片」canvas tab isn't showing anything for this project, and (2) apply user-submitted annotations after Step 7 export completes.
>
> **Not in scope**: Executor's mandatory auto-startup — that lives in [`SKILL.md`](../SKILL.md) Step 6. Do not re-signal a preview that's already active this session.

## When to Run

- **Signal activation (Step 1) — mandatory before ANY edit to an existing project's SVGs.** If `svg_output/*.svg` already exists for this project and the user asks for ANY change to it — a full style pass, a single word, one color, one coordinate, no matter how small — signal activation first (if not already signaled this session) and only then touch the SVG. There is no "too small to bother" exception: the tab's only signal to the user that an edit landed is the live preview, so skipping the startup makes the edit invisible in the UI even though the file changed correctly on disk.
- Also signal whenever the user wants to look at the deck or click an element (post-export re-entry in a fresh chat, or a resumed session whose tab is empty).
- **Apply annotations (Step 2)** — Step 7 has produced at least one PPTX, and the user signals that submitted annotations should now be applied. Triggers include:
  - quoting the composer message the app sends on their behalf (`应用我的标注`)
  - saying `apply my annotations` / `apply my edits` / `应用注解` / `开始应用` / 等价表达

## When NOT to Run

- Live preview was already signaled this session → nothing to do; the 「预览幻灯片」tab already reflects `svg_output/` live.
- The user wants a full regeneration → use the main workflow.
- Step 7 has never run for this project → annotations cannot be applied yet; finish the main pipeline first.
- No `svg_output/*.svg` exists yet for this project → Step 6's mandatory auto-startup (`SKILL.md`) handles the first signal when Executor begins generating; nothing to preview before that.

---

## Step 1: Signal activation

**Precondition**: the 「预览幻灯片」tab is showing its empty state for this project (nothing signaled yet this session, or a resumed session).

```bash
python3 ${SKILL_DIR}/scripts/svg_editor/preview_open.py <project_path>
```

(Plain mode — no `--live`. The `--live` flag, which also creates `svg_output/` if missing, is reserved for Step 6's auto-startup where the directory may not exist yet.)

This is a one-shot signal, not a server launch: the script resolves the project's absolute path, prints `live preview ready: <path>` to stdout, and exits immediately. The Claude Desktop host detects the command and its printed path, and renders `svg_output/` NATIVELY in the 「预览幻灯片」canvas tab (LivePreviewEditor) — reading the files directly, no port, nothing to embed. After running it, tell the user in their language, in one short message:

- the deck is now visible in the 「预览幻灯片」tab
- **Annotate** (changes that need AI judgement / re-layout): select an element (click; Ctrl/Cmd-click or drag a marquee to select several) → write the instruction in the floating box → it stages locally → click **应用我的标注** to write annotation markers to `svg_output/` and send the apply message to chat
- to skip the tab, just describe the change in chat
- there is no direct attribute/text editing in this surface — only annotations that the AI acts on

Do not wait for confirmation before signaling — the user already asked for preview, so signaling is the response. Remote access: nothing special to forward anymore — reading local files over IPC works identically over Remote-SSH / a remote desktop session, since there is no port to tunnel.

---

## Step 2: Apply submitted annotations

🚧 **GATE**: `<project_path>/exports/` contains at least one `*.pptx` (Step 7 has completed). If not, do not apply annotations — tell the user to finish the main pipeline first.

Triggered by the user signals listed in "When to Run".

1. Discover annotations:
   ```bash
   python3 ${SKILL_DIR}/scripts/check_annotations.py <project_path>
   ```
   The output already lists each pending change as `file → element_id → annotation text → content preview`. Use it directly as the to-do list; no need to re-parse SVG attributes yourself.
2. If the output says no annotations: tell the user, stop.
3. For each listed annotation:
   - Edit the targeted element in `<project_path>/svg_output/<file>` per the annotation text.
   - Remove `data-edit-target` and `data-edit-annotation` from that element.
   - Append one `annotation_applied` JSONL record to `<project_path>/live_preview/annotations.jsonl` with `ts`, `file`, `element_id`, and the original annotation text.
4. Re-export:
   ```bash
   python3 ${SKILL_DIR}/scripts/finalize_svg.py <project_path>
   python3 ${SKILL_DIR}/scripts/svg_to_pptx.py <project_path>
   ```
5. Tell the user (in their language): annotations applied, new PPTX exported, the 「预览幻灯片」tab reflects the cleared markers automatically. No refresh step — it's a live read of the files.
6. Loop: more annotations submitted → repeat from step 1. User signals done → end.

---

## Notes (native editor — referenced from SKILL.md Step 6)

The interactive surface described here is LivePreviewEditor, rendered natively by the Claude Desktop app (no browser, no server). It reads `<project_path>/svg_output/` directly and writes back only through the app's own save flow — there is nothing on the skill side to configure beyond signaling activation (Step 1).

- **Selection**: click an element to select it; `Ctrl`/`Cmd`-click adds to the selection; drag on empty canvas draws a marquee (rubber-band) selecting everything it touches, with the same additive modifiers. Hovering pre-highlights the element under the pointer.
- **Slide navigation**: rail thumbnails, prev/next controls, and `←` / `→` (suppressed while typing in the annotation textarea).
- **Annotate**: with one or more elements selected, type an instruction in the floating box and submit — this stages the annotation locally (instant, no network/IPC round-trip to save). Clicking an existing annotation's number badge re-opens it for editing; the delete control on a staged annotation removes it. Nothing is written to `svg_output/` until **应用我的标注**.
- **应用我的标注** (the sole write action): replays every staged annotation across every touched slide onto a FRESH read of each file (so an Executor rewrite that landed while the user was working is never clobbered — see the "并发写" note below), writes the result back to `svg_output/`, appends history to `<project>/live_preview/{annotations,edits}.jsonl`, and sends the `应用我的标注` message to chat so the AI picks up the work. The button is disabled while a previous apply's chat turn is still in flight.
- **Concurrent writes**: if the Executor is rewriting a page at the exact moment the user applies, the write is refused (a compare-and-swap on the file's mtime) and retried once automatically after a fresh read; a toast asks the user to try again shortly if it still conflicts.
- **No direct attribute/text editing, no undo, no drag-to-move, no arrow-key nudge** — these existed only in the retired browser editor's UI and were never carried over to the native one. If they're ever added, they'll layer onto the same annotation surface, not replace it.
- **Icon rendering**: `<use data-icon="…">` placeholders are inlined into real paths for preview (same logic as the offline `pptx_to_svg`/`visual_review` renderers) — the on-disk SVG is unchanged by this; only the preview shows the expanded icon.
- **Transient ids**: each element gets a temporary `_edit_N` id while being previewed/annotated. On save, only annotated elements keep their id; unannotated `_edit_N` ids are stripped before write-back.
