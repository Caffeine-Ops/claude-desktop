import { type FileIconKey } from '../components/chat/FileTypeIcon'

/**
 * Per-skill chip appearance registry.
 *
 * Most slash chips render with the generic accent-tinted Lucide "box"
 * glyph (see `chipNodeView.ts`). A handful of *known* skills get a
 * bespoke look instead — a coloured Icons8 glyph plus a friendly label
 * (e.g. `/ppt-master` → orange PowerPoint icon + 「制作PPT」) — so the
 * composer reads as a product surface rather than a raw CLI prompt.
 *
 * This is the single place to register that. Adding a new skill means
 * appending ONE entry below; nothing in the NodeView changes. Keep the
 * registry purely declarative — no DOM, no React — so it stays a plain
 * data table that `chipNodeView.ts` reads.
 *
 *   - `match`: the chip's literal `value` (with leading `/`). The chip
 *     value is the verbatim text we serialize back to fusion-code, so
 *     matching on it keeps the wire format untouched — this is *only* a
 *     visual override.
 *   - `icon`: a key into the shared Icons8 colour table
 *     (`fileIconPathsByKey`). Self-coloured multi-fill glyph, drawn the
 *     same way file-mention chips draw their type icon, so a skill that
 *     produces a `.pptx` can reuse the PowerPoint icon for instant
 *     recognition.
 *   - `label`: the pill text. Defaults to the value minus its leading
 *     `/` (the raw skill name) when omitted.
 *   - `appearance`: which visual treatment the NodeView draws. Defaults
 *     to `'tinted'` (the flat accent-tint pill). `'gradient'` is the
 *     larger gradient-border card prototype the user picked for
 *     `/ppt-master` — see `chipNodeView.ts` for how each is rendered.
 */

/** Visual treatments a skill chip can opt into. See `chipNodeView.ts`. */
export type SkillChipAppearance = 'tinted' | 'gradient'

export interface SkillChipSpec {
  /** Literal chip value to match, e.g. `/ppt-master`. */
  match: string
  /** Key into the shared Icons8 colour icon table. */
  icon: FileIconKey
  /** Pill text. Defaults to the value without its leading `/`. */
  label?: string
  /** Visual treatment. Defaults to `'tinted'`. */
  appearance?: SkillChipAppearance
}

/**
 * The registry. Order doesn't matter — lookup is by exact `value`.
 * Add new skills here; the NodeView picks them up automatically.
 */
export const SKILL_CHIP_SPECS: readonly SkillChipSpec[] = [
  // ppt-master — both the plugin-namespaced value (bundled fusion-code
  // exposes it as `claude-desktop:ppt-master`, so the chip value is
  // `/claude-desktop:ppt-master`) and the bare name (other backends /
  // user-installed copies surface it without the namespace).
  {
    match: '/claude-desktop:ppt-master',
    icon: 'ppt',
    label: '制作PPT',
    appearance: 'gradient'
  },
  {
    match: '/ppt-master',
    icon: 'ppt',
    label: '制作PPT',
    appearance: 'gradient'
  },
  // gpt-image-2 — image generation. Same namespaced + bare pair.
  {
    match: '/claude-desktop:gpt-image-2',
    icon: 'image',
    label: '生成图片',
    appearance: 'gradient'
  },
  {
    match: '/gpt-image-2',
    icon: 'image',
    label: '生成图片',
    appearance: 'gradient'
  },
  // proposal-writer — 写方案。namespaced + 裸名双注册，理由同 ppt-master。
  // 注意：这个命令不会发给 fusion-code——FusionRuntimeProvider.onNew 会拦截它、
  // 激活方案模式（见 matchProposalSlash）。chip 只是让斜杠菜单里它长得像个产品功能。
  {
    match: '/claude-desktop:proposal-writer',
    icon: 'word',
    label: '写方案',
    appearance: 'gradient'
  },
  {
    match: '/proposal-writer',
    icon: 'word',
    label: '写方案',
    appearance: 'gradient'
  }
]

const BY_VALUE = new Map(SKILL_CHIP_SPECS.map((s) => [s.match, s]))

/** Look up a bespoke chip spec by its literal value, or `null`. */
export function findSkillChipSpec(value: string): SkillChipSpec | null {
  return BY_VALUE.get(value) ?? null
}
