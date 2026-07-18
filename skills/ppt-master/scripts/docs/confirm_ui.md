# Confirm UI — Eight Confirmations Page

> The interactive, visual surface for SKILL.md Step 4 (the Eight Confirmations), rendered NATIVELY by the Claude Desktop host (CanvasConfirm, in the 「问题」canvas tab) — there is no server or browser page on this path anymore. Enumerable fields list **all** options from a catalog with the AI's recommendation badged; generative fields (color, typography, generated-image style) show **≥3** AI candidates (creative recommendations always offer real choice — same rule as the h.5 image strategy; fewer only on the honest-shortfall exception, with a stated reason). Fields whose universe is open (canvas, mode, visual style, icons, image usage) also get a **Custom** box; fully closed fields (AI source when applicable, formula policy, generation mode, refine spec) do not. The AI writes its recommendation to `recommendations.json`; the user's final choices are written back to `result.json` for the AI to read. The chat path is always a valid fallback — if the app cannot render the tab (remote / headless / non-desktop), the AI presents the same confirmations in chat.

## `confirm_ui/confirm_wait.py`

A pure-stdlib waiter, not a server: it doesn't render anything, doesn't listen on a port, and doesn't care who writes `result.json` — it just blocks the calling Bash tool call until the stage it's watching shows up in that file. The desktop app's CanvasConfirm writes `result.json` via its own IPC (CONFIRM_UI_WRITE_RESULT); a hand-edit of the file would satisfy this script equally well.

```bash
python3 scripts/confirm_ui/confirm_wait.py <project_path> --stage tier1 --fresh   # start a round, wait for Tier 1
python3 scripts/confirm_ui/confirm_wait.py <project_path> --stage final           # Tier 2: wait for the final result
python3 scripts/confirm_ui/confirm_wait.py <project_path> --stage final --fresh   # single-pass (e.g. beautify-pptx)
```

- `--fresh` **starts a new confirmation round**: clears any stale `result.json` left by a previous round (otherwise a leftover `stage: final` would make this run's stage guard return instantly with no real confirmation), and writes a fresh `<project_path>/confirm_ui/catalogs.json` snapshot (the merged option universe — see below) plus a `_meta.static_dir` pointer the desktop app reads its style/canvas preview images from. Pass it on the **first** wait of a round (Tier 1's leg, or the single leg of a single-pass flow) — never on Tier 2's leg, which would delete the Tier 1 result it depends on.
- **No lock, no pid check, no port** — liveness is inferred purely from whether `result.json` reaches the target stage before the timeout. The budget is a **fixed 590 s ceiling** (`--timeout` is clamped to it — there is deliberately no way to wait longer or forever, so a stuck round can never strand the whole conversation turn), kept under the typical 600 s tool ceiling — run the wait with a long tool timeout (≈600000 ms). On timeout the script returns 124; the app may still be open and the user may confirm moments later, so the caller must re-check `result.json` once, then drop to the chat fallback — **never re-run the wait a second time** for the same non-result, that only repeats the same full 590 s for nothing.
- Refuses to start unless `<project_path>/confirm_ui/recommendations.json` exists — the same "a confirm round is legitimately in progress" gate the app's write-side IPC also checks.
- Exit codes: `0` target stage reached, `1` bad arguments / missing recommendations.json, `124` timed out.
- No cleanup step — there is no server or port to release. Re-running the same stage without `--fresh` is safe (if `result.json` already has that stage, it returns immediately).

Dependency: none (standard library only).

`confirm_ui/server.py` — the Flask page this replaced — has been deleted along with its `static/` HTML/JS. The static **data** files it used to serve remain and are still read by the app: `static/catalogs.json` (the option universe) and `static/style-previews/` / `static/canvas-previews/` (preview images, read via the app's local-file IPC through the `_meta.static_dir` pointer above).

## Two kinds of field

- **Enumerable + custom** — canvas / mode / visual_style / icons / image usage. The page lists common options from `static/catalogs.json`, badges the AI's recommendation, and still offers a Custom box for edge cases (custom canvas size, bespoke narrative mode, mixed image plan, self-provided icon system, etc.). `visual_style` additionally honors an optional `visual_style_spectrum` that badges a 3-pick personality spectrum (safe / shifted / bold, each with a temperament tag + analogy) in place of the single recommendation — see the schema below.
- **Closed enumerable** — formula policy / generation mode / refine spec, plus AI source only when image usage may include `ai`. These have no Custom box; out-of-catalog values snap back to the recommended option. Use pipeline vocabulary: icon ids are actual library ids such as `tabler-outline`, or `emoji` for system emoji; image usage labels mirror Strategist terminology: `ai` = AI-generated, `web` = Web-sourced, `provided` = User-provided, `placeholder` = Placeholder, `none` = No images. Use custom prose only when several sources are mixed.
- **Generative (open)** — color, typography, generated-image style. No finite catalog; the AI authors **≥3 candidates** the page renders as cards (never a single option — creative fields must offer real choice; fewer than 3 only on the honest-shortfall exception). `page_count`, `audience`, and `content_divergence` are free inputs (`content_divergence` is a free-text intent shown under audience in §c, not a fixed-option field).

**Custom box** appears only on fields whose universe is genuinely open — `canvas`, `mode`, `visual_style`, `icons`, and `image_usage`. Fully closed sets — `image_ai_path`, `formula_policy`, `generation_mode`, `refine_spec` — have **no** Custom box; an out-of-catalog value there is snapped back to the recommended option.

`image_ai_path` is conditional: the page shows it and writes it to `result.json` only when `image_usage` is `ai` or a custom image plan that may include AI. Web-sourced / User-provided / Placeholder / No images paths do not carry an AI backend choice.

## Catalogs — `static/catalogs.json` (the finite option universe)

`confirm_wait.py --fresh` writes `<project_path>/confirm_ui/catalogs.json` at the start of each confirmation round — the static `static/catalogs.json` merged **with the `canvas` list synced live from `config.py CANVAS_FORMATS`** (the set of formats and their `dim` come from config, single source of truth, zero drift; bilingual labels / use text stay in `static/catalogs.json`, a plain fallback label synthesized for any new id config adds), plus a `_meta.static_dir` pointer to `static/` for the app's preview-image reads. CanvasConfirm reads this project-local snapshot via CONFIRM_UI_READ — there is no `/api/catalogs` endpoint anymore. Keys: `canvas`, `modes`, `visual_styles` (grouped), `icons`, `image_usage`, `image_ai_path`, `formula_policy`, `generation_mode`, `delivery_purpose`. Each entry is `{ "id", "label", "label_zh", "label_en", ... }`; descriptions use `desc_zh` / `desc_en`, and `visual_styles` groups use `group_zh` / `group_en`. The front-end falls back to legacy `label` / `desc` / `group`, so old catalogs still load, but new user-facing catalog text must be bilingual. English labels should mirror canonical reference names (`pyramid`, `swiss-minimal`, `Path A`, `mixed`, etc.); Chinese labels should be translated for users. Descriptions render inline after the option title, not as a separate selected-option line. `visual_styles` is `[{ "group", "group_zh", "group_en", "items": [...] }]`. For `canvas` you only need to maintain the bilingual labels in catalogs.json; the format set and dimensions are authoritative in `config.py CANVAS_FORMATS`.

## Round-trip data contract

Both files live under `<project_path>/confirm_ui/`.

### Two-tier flow

The page runs as a **two-tier wizard in one CanvasConfirm mount** (it stays mounted, just hidden, across tab switches — see the app's SlidesWorkspace KEEP-ALIVE comment). `recommendations.json` carries a top-level `"tier"`:

| `tier` | Page renders | Button | On submit |
|---|---|---|---|
| `1` | anchors — canvas, audience + `content_divergence` + `delivery_purpose` *(PPT only — omitted on non-PPT canvases, not written to the result)* (all in the §c key-info area), mode + visual_style | **Next** | writes `result.json` `{ stage: "tier1", status: "tier1-confirmed", <anchors> }`; the page does **not** close — it shows a "deriving…" state and polls `recommendations.json` via CONFIRM_UI_READ |
| `2` | realization — page count, color, typography, icons, formula, image usage + strategy, generation mode, refine spec | **Confirm** | writes `result.json` `{ stage: "final", status: "confirmed", <all fields> }`, then shuts the page down |
| *(absent)* | legacy single-pass — every section on one page | **Confirm** | single final write (`status: "confirmed"`) — backward-compatible |

The AI waits for Tier 1 (`confirm_wait.py --stage tier1 --fresh`), reads the tier-1 result, **re-derives** the realization candidates from the user's actual anchors, overwrites `recommendations.json` with `"tier": 2` (realization fields only — it need not echo the anchors), and waits again (`--stage final`, no `--fresh`). The page (CanvasConfirm) preserves the user's Tier 1 selections across the transition (it never remounts) and polls the CONFIRM_UI_READ IPC to notice the tier-2 overwrite; when `tier == 2` it **folds the confirmed anchors from `result.json` back into what it renders** (`recommend.canvas` / `mode` / `visual_style` / `delivery_purpose`, plus `audience` / `content_divergence` values) — so a **remount on Tier 2 re-initializes the anchors from the user's choices** instead of catalog defaults, even though those sections are not rendered on the Tier-2 page.

### Input — `recommendations.json` (written by Strategist before launch)

```json
{
  "lang": "zh",
  "recommend": {
    "canvas": "ppt169",
    "mode": "pyramid",
    "visual_style": "swiss-minimal",
    "icons": "tabler-outline",
    "image_usage": "web",
    "formula_policy": "mixed",
    "generation_mode": "continuous",
    "delivery_purpose": "balanced"
  },
  "page_count":         { "value": "12-15" },
  "audience":           { "value": "..." },
  "content_divergence": { "value": "" },
  "color": {
    "selected": 0,
    "candidates": [
      { "name": "...", "note": "...",
        "palette": {
          "background": "#FFFFFF",
          "secondary_bg": "#F4F6F8",
          "primary": "#1A3A6B",
          "accent": "#E8A317",
          "secondary_accent": "#4A7BB5",
          "body_text": "#1D2430"
        } }
    ]
  },
  "typography": {
    "selected": 0,
    "candidates": [
      { "name": "...", "note": "...",
        "heading": { "cjk": "思源黑体", "latin": "Inter", "css": "'Source Han Sans SC','Inter',sans-serif", "sample_cjk": "标题示例", "sample_latin": "Heading Sample" },
        "body":    { "cjk": "思源黑体", "latin": "Inter", "css": "...", "sample_cjk": "正文示例", "sample_latin": "Body sample" },
        "body_size": 20 }
    ]
  },
  "image_strategy": {
    "selected": 0,
    "candidates": [
      {
        "name": "方案 A",
        "rendering": "vector-illustration",
        "palette": "cool-corporate",
        "visual": "扁平矢量、实色块、少阴影",
        "color": "背景 60-70% + 主色 25-30% + 强调色少量点题",
        "mood": "稳定、可信、克制"
      }
    ]
  },
  "visual_style_spectrum": [
    { "id": "soft-rounded", "tag_zh": "稳妥专业", "tag_en": "Safe & professional", "note_zh": "像 Notion 官网", "note_en": "like the Notion site" },
    { "id": "editorial",    "tag_zh": "编辑质感", "tag_en": "Editorial depth",     "note_zh": "像经济学人专题", "note_en": "like an Economist feature" },
    { "id": "brutalist",    "tag_zh": "硬核宣言", "tag_en": "Bold manifesto",      "note_zh": "像研究机构年度宣言", "note_en": "like a research-house manifesto" }
  ],
  "refine_spec": { "value": false }
}
```

> Each `candidates` array above shows **one** entry for brevity — the creative fields (`color`, `typography`, `image_strategy`) must each carry **≥3** in a real file (see the rule above); `selected` indexes the recommended default.

- `recommend.*` names the recommended `id` for each enumerable field (must match a `catalogs.json` id, or be a free string for a recommended custom value). The page badges and pre-selects it. **Guarantee**: if a `recommend.*` is omitted, the page falls back to the first catalog option so every enumerable field always shows one badged recommendation — but the AI should still set them for a meaningful default. Legacy aliases are accepted for old files (`line` → `tabler-outline`, `filled` → `tabler-filled`, `monochrome` → `chunk-filled`, `search` → `web`, `default` → `auto`, `builtin` → `host-native`), but new files should write canonical ids. For `recommend.image_usage`, do not write bare `"custom"`; if several image sources are mixed, write the concrete prose plan directly, such as `"封面用 AI 生成，产品页用用户素材，行业页用网络来源"` / `"AI cover + user product assets + web industry images"`.
- When `recommend.image_usage` is `ai` or a custom plan that includes AI, also set `recommend.image_ai_path` to one of `auto` / `api` / `host-native` / `manual`; the page presents these as explicit choices.
- For a custom image plan, the page treats "may include AI" as true only when the recommendation includes `recommend.image_ai_path` or `image_strategy.candidates`; a custom plan without those signals is handled as non-AI and omits AI controls / fields.
- **Color candidates carry the user-facing core `palette`**: `background`, `secondary_bg`, `primary`, `accent`, `secondary_accent`, and `body_text`. The page renders labelled swatches and offers per-role override inputs for precise single-role edits, plus a **Custom color card with a free-text box** (parallel to the custom typography box) — the user can describe the palette in words or paste HEX values instead of filling each role; this writes `color: { "name": "custom", "custom": "<text>" }` to `result.json` for the AI to interpret. Legacy `text` is accepted as an alias for `body_text`, but new files should write `body_text`. Strategist derives secondary text, borders, state colors, and visual-style neutral tiers later when writing `design_spec.md` / `spec_lock.md`; those are not user-facing confirmation choices.
- **Candidate display text may be bilingual**: color / typography candidates can provide `name_zh` / `name_en` and `note_zh` / `note_en`; the page falls back to legacy `name` / `note`.
- **Typography candidates split CJK and Latin** for both `heading` and `body`; `css` is the fallback preview `font-family` stack. The page previews CJK sample text with `cjk + css` and Latin sample text with `latin + css`, so the two script choices are visible independently. Each candidate should also include `body_size` — the body baseline in **px** (the system's only unit, every canvas). The initial value comes from the candidate's `body_size`, sized for the recommended delivery purpose: `text` ~20 · `balanced` ~24 · `presentation` ~32. On submit the page writes `typography.body_size` as px directly — no pt conversion, no `body_size_pt` provenance. The page exposes `body_size` as an editable numeric field whose hint shows the recommended size — **one fixed px per delivery purpose on PPT (`text` 20 · `balanced` 24 · `presentation` 32), not a range** (non-PPT ≈2.5–3.3% of height in px). The user may still edit it; an out-of-range flag only warns if the value strays far (e.g. a unit mistake). **Inputs are independent — the hint updates with canvas / delivery purpose but never rewrites a value the user can see.** It also offers a custom typography text box so the user is not limited to the proposed candidates.
- **Per-role size override** (parallel to color's per-role HEX override): besides `body_size`, the page exposes **independent** editable inputs for `title` / `subtitle` / `annotation`. Each role is pre-filled **once** with a starting value — the candidate's `typography.sizes[role]` if provided, otherwise a one-time ramp suggestion (`body × ` mid-band ratio) — and then holds its own value. **There is no cross-field cascade**: changing `body_size`, `delivery_purpose`, or canvas updates only the recommended-value hint, never the role values; a re-render preserves exactly what the user sees. The final values are written to `result.json` as `typography.sizes: { "title", "subtitle", "annotation" }` in **px** — every canvas, no pt and no `sizes_pt` provenance. Seeding `sizes` in a candidate is optional — omit it and each role gets its one-time ramp suggestion.
- **`delivery_purpose`** (enumerable, PPT only) is the primary driver of the body baseline: `text` (read-close), `balanced` (business, the default), `presentation`. It is surfaced in the **§c key-information area** (beside audience, Tier 1) as a consumption-mode choice; the Tier-2 typography section then reads the confirmed value for the recommended body px — the pick itself does not rewrite the body field (inputs are independent). `recommend.delivery_purpose` pre-selects one (default `balanced`); the user's pick writes back to `result.json.delivery_purpose` as a plain id. Strategist uses it to set the px body baseline — **one fixed px per purpose (`text` 20 · `balanced` 24 · `presentation` 32), not a range** (see [strategist.md §g](../../references/strategist.md)). Non-PPT canvases omit it.
- **Combined style preview** — a compact live "overall impression" strip sits just above the color section and is **sticky**: it pins under the topbar so it stays visible while the user scrolls through the color / icon / typography sections, keeping the picking controls and their combined effect on screen together. It applies the currently selected color palette **and** typography (heading sample in `primary` over `background`, body sample in `body_text`, an `accent` bar, a `secondary_bg` chip) and repaints on every color / HEX-override / font / `body_size` change. It does not replace the per-candidate swatches or font samples (those stay for picking); it is deliberately an abstract style chip, **not** a slide-layout preview — page layout preview remains the live-preview server's job (Step 6). No schema field; it derives entirely from the existing color + typography selections.
- **Generated image style candidates** live in `image_strategy.candidates` and are shown only when `image_usage` is `ai` or a custom image plan may include generated images. Each candidate records `rendering`, `palette`, and short `visual` / `color` / `mood` lines from Strategist h.5. The chosen value is written to `result.json.image_strategy`; it is omitted when generated images are not part of the plan.
- **`visual_style_spectrum`** (optional) lets the AI surface the deck's aesthetic as a **personality spectrum** instead of one badged style. Each entry is `{ "id", "tag_zh"/"tag_en", "note_zh"/"note_en" }` where `id` is a real `visual_styles` catalog id; the page badges those chips with their temperament `tag` (replacing the single ★) and appends the `note` (a real-world analogy) inline. The full grouped style list and Custom box stay visible below, and `recommend.visual_style` is still the pre-selected default (it should equal the spectrum's safe pick). Author **≥3** spanning safe / shifted / bold (mirrors h.5; honest-shortfall exception applies — fewer only when the constraints genuinely cannot yield 3). The user's pick still writes back to `result.json.visual_style` as a plain id; the spectrum is presentation-only. Omit the field to fall back to the single-recommendation badge.
- `recommend.generation_mode` and `refine_spec` mirror the two mandatory notes in SKILL.md Step 4. Confirmed `generation_mode: "split"` / `refine_spec: true` are explicit user choices, equivalent to opting in through chat.
- `content_divergence` is a **free-text** field shown right under the audience box in §c — the user states in their own words how closely to follow the source vs how freely to reshape it (e.g. "stick closely to the document" / "freely restructure and expand within the source"). It is **not** a fixed-option field; blank means a balanced default. Whatever the level, facts stay sourced — reshaping develops what is in the source, never imports facts from outside it. The Strategist consumes the prose when authoring the §IX outline and records it in `design_spec.md §I`; it is **not** written to `spec_lock.md` (the Executor never reads it). It carries no page-count coupling and no source-signal recommendation — it is purely the user's stated intent. Beautify / template-fill keep content verbatim and do not surface this field.
- `lang` is a soft default; an explicit user language choice in the page (persisted to `localStorage`) wins.

### Output — `result.json` (written on submit, read by the AI)

```json
{
  "canvas": "ppt169",
  "page_count": "12-15",
  "audience": "...",
  "content_divergence": "freely restructure and expand within the source",
  "mode": "pyramid",
  "visual_style": "swiss-minimal",
  "color": { "name": "...", "palette": { "background": "#...", "secondary_bg": "#...", "primary": "#...", "accent": "#...", "secondary_accent": "#...", "body_text": "#..." } },
  "icons": "tabler-outline",
  "typography": { "name": "...", "heading": { "cjk": "...", "latin": "...", "css": "..." }, "body": { "cjk": "...", "latin": "...", "css": "..." }, "body_size": 24, "body_size_unit": "px", "sizes": { "title": 42, "subtitle": 32, "annotation": 18 } },
  "delivery_purpose": "balanced",
  "formula_policy": "mixed",
  "image_usage": "web",
  "image_strategy": { "name": "方案 A", "rendering": "vector-illustration", "palette": "cool-corporate", "visual": "...", "color": "...", "mood": "..." },
  "generation_mode": "continuous",
  "refine_spec": false,
  "stage": "final",
  "status": "confirmed",
  "confirmed_at": "2026-06-15T11:44:44"
}
```

The shape above is the **final** (Tier 2) result, carrying all Tier 1 + Tier 2 fields. The intermediate **Tier 1** write carries only the anchor fields plus `"stage": "tier1"`, `"status": "tier1-confirmed"`; the AI reads it to re-derive Tier 2 and never treats it as the final confirmation. A legacy single-pass write has no `stage` (or `stage: "final"`) and `status: "confirmed"`.

- Any option field may instead hold a **free-text custom string** (the user picked **Custom**); `color` / `typography` custom entries set `name: "custom"`. Image usage custom values must be concrete prose plans, not the literal string `"custom"`. The AI interprets custom text against the canonical references.
- `image_ai_path` and `image_strategy` are omitted from `result.json` unless `image_usage` is `ai` or a custom image plan that may include generated images. Both are honored downstream as confirmed choices — and the page is only a convenience surface over the **canonical chat channel**: the same choices made in chat are honored identically when no `result.json` exists. `image_ai_path` drives the Step 5 generation path (`image-generator.md` §7 — `host-native` forces the host tool even when `IMAGE_BACKEND` is set); the chosen `image_strategy` candidate is locked verbatim by Strategist h.5 (no re-pick).
- After the user clicks the **final Confirm** (Tier 2, or single-pass), the page writes `result.json` via CONFIRM_UI_WRITE_RESULT — there is no server to shut down, so nothing else happens on the app side. A Tier-1 **Next** instead keeps the page mounted (it polls for the re-derived Tier 2). In the default flow, `confirm_wait.py --stage tier1 --fresh` returns on the tier-1 result and `--stage final` returns on the final result; the AI reads each immediately — no extra chat confirmation is required. Chat confirmation remains the fallback when the page cannot be used.

## Scope

- Confirmation surface only — Strategist authors every recommendation; the page never generates deck content.
- No SVG / layout preview here — that is the live preview server's job (`workflows/live-preview.md`, Step 6).
