import { type FileIconKey } from '../components/chat/FileTypeIcon'
import { PROPOSAL_WRITER_SLASH_NAMES } from '../lib/proposalSlash'

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
  // imagegen — 生成图片。namespaced + 裸名双注册，理由同 ppt-master。
  // 2026-07-09：「生成图片」按钮从 gpt-image-2 换绑到 imagegen（imagegen 已
  // 改造为纯标准库走同一 OpenAI 兼容网关，见 skills/imagegen/scripts/image_gen.py）。
  // gpt-image-2 skill 仍在仓库、仍可手动 /gpt-image-2 调用，只是不再是这个
  // 彩色按钮背后的那个 skill。
  {
    match: '/claude-desktop:imagegen',
    icon: 'image',
    label: '生成图片',
    appearance: 'gradient'
  },
  {
    match: '/imagegen',
    icon: 'image',
    label: '生成图片',
    appearance: 'gradient'
  },
  // spreadsheets — 处理表格。namespaced + 裸名双注册，理由同 ppt-master。
  {
    match: '/claude-desktop:spreadsheets',
    icon: 'excel',
    label: '处理表格',
    appearance: 'gradient'
  },
  {
    match: '/spreadsheets',
    icon: 'excel',
    label: '处理表格',
    appearance: 'gradient'
  },
  // remotion — 制作视频。namespaced + 裸名双注册，理由同 ppt-master。
  // FileIconKey 尚无 video/film 图标，暂借 'image'（remotion 产出即渲染画面，
  // 不违和）；要专属视频图标须先在 FileTypeIcon 加 key + 多色 path。
  {
    match: '/claude-desktop:remotion',
    icon: 'image',
    label: '制作视频',
    appearance: 'gradient'
  },
  {
    match: '/remotion',
    icon: 'image',
    label: '制作视频',
    appearance: 'gradient'
  },
  // proposal-writer — 写方案。namespaced + 裸名双注册，理由同 ppt-master。
  // 注意：这个命令不会发给 fusion-code——FusionRuntimeProvider.onNew 会拦截它、
  // 激活方案模式（见 matchProposalSlash）。chip 只是让斜杠菜单里它长得像个产品功能。
  // 命令名从 PROPOSAL_WRITER_SLASH_NAMES 派生而非在此重写字面量：拦截识别集与
  // chip 注册必须永远同一份名单，否则改名漏同步会出现「chip 显示正常、点了却不
  // 拦截、静默直发 CLI」。
  ...PROPOSAL_WRITER_SLASH_NAMES.map(
    (name): SkillChipSpec => ({
      match: `/${name}`,
      icon: 'word',
      label: '写方案',
      appearance: 'gradient'
    })
  )
]

const BY_VALUE = new Map(SKILL_CHIP_SPECS.map((s) => [s.match, s]))

/** Look up a bespoke chip spec by its literal value, or `null`. */
export function findSkillChipSpec(value: string): SkillChipSpec | null {
  return BY_VALUE.get(value) ?? null
}
