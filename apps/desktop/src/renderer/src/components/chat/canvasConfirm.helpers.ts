/**
 * canvasConfirm.helpers
 * ---------------------
 * Pure logic ported VERBATIM from the ppt-master confirm_ui front-end
 * (skills/ppt-master/scripts/confirm_ui/static/app.js). The CanvasConfirm
 * React component renders the Eight-Confirmations UI natively inside the
 * 「问题」canvas tab instead of iframing that page; to stay byte-compatible
 * with the Flask server's data contract (recommendations.json in,
 * result.json out — the server's `--wait-only` loop only watches that file),
 * every normalization / recommendation-resolution / submit-shaping rule must
 * match app.js exactly. Keep this file a 1:1 mirror of app.js's pure helpers;
 * if app.js changes upstream, re-port here. The DOM-building parts of app.js
 * (el(), section(), the enumField/renderX closures) become React components in
 * CanvasConfirm.tsx — only the pure logic lives here.
 */

// ---- types -----------------------------------------------------------------
// Loose by design: catalogs.json / recommendations.json are AI-authored JSON
// whose exact shape varies (bilingual keys, legacy nesting, optional fields).
// app.js reads them defensively; we mirror that with index-signature records
// and read through the same normalizers rather than over-tightening types.

export type Lang = 'zh' | 'en'

/** A finite catalog option (canvas / mode / icons / …). Flat or, for
 *  visual_styles, grouped under {group, items}. */
export interface CatalogOption {
  id: string
  label?: string
  label_zh?: string
  label_en?: string
  desc_zh?: string
  desc_en?: string
  dim?: string
  // grouped form (visual_styles only)
  group?: string
  group_zh?: string
  group_en?: string
  items?: CatalogOption[]
  [k: string]: unknown
}

export interface Catalogs {
  canvas?: CatalogOption[]
  modes?: CatalogOption[]
  visual_styles?: CatalogOption[]
  icons?: CatalogOption[]
  image_usage?: CatalogOption[]
  image_ai_path?: CatalogOption[]
  formula_policy?: CatalogOption[]
  generation_mode?: CatalogOption[]
  delivery_purpose?: CatalogOption[]
  [k: string]: CatalogOption[] | undefined
}

/** recommendations.json — the AI's picks + generative candidate arrays. Read
 *  defensively; almost everything is optional. */
export type Recommendations = Record<string, any>

/** The mutable selection object — mirror of app.js's `STATE`. */
export interface ConfirmState {
  canvas?: string
  audience?: string
  content_divergence?: string
  mode?: string
  visual_style?: string
  delivery_purpose?: string
  page_count?: string
  color?: { name?: string; custom?: string; palette?: Palette }
  icons?: string
  typography?: Typography
  formula_policy?: string
  image_usage?: string
  image_ai_path?: string
  image_strategy?: Record<string, string>
  generation_mode?: string
  refine_spec?: boolean
}

export interface Palette {
  background?: string
  secondary_bg?: string
  primary?: string
  accent?: string
  secondary_accent?: string
  body_text?: string
}

export interface FontSlot {
  cjk?: string
  latin?: string
  css?: string
  sample_cjk?: string
  sample_latin?: string
}

export interface Typography {
  name?: string
  note?: string
  custom?: string
  body_size?: string | number
  heading?: FontSlot
  body?: FontSlot
  sizes?: Record<string, string | number>
}

// ---- i18n ------------------------------------------------------------------
// Ported verbatim from app.js MESSAGES.

export const MESSAGES: Record<Lang, Record<string, string>> = {
  en: {
    page_title: 'PPT Master - Confirm Design',
    topbar_hint:
      'Pick or type your choices, then click Confirm — the page closes and you return to the chat.',
    loading: 'Loading…',
    load_error: 'Could not load recommendations.json. The AI must write it before launch.',
    btn_confirm: 'Confirm',
    btn_next: 'Next →',
    deriving: 'Generating the downstream options from your choices…',
    already_confirmed: 'Already confirmed once. Re-submitting overwrites the previous choices.',
    confirmed_title: '✓ Confirmed',
    confirmed_hint: 'Your choices are saved. You can close this page and return to the chat.',
    lang_toggle_title: 'Switch language',
    sec_canvas: 'Canvas format',
    sec_pages: 'Page count',
    sec_audience: 'Target audience',
    sec_style: 'Style objective',
    sec_color: 'Color scheme',
    sec_icons: 'Icon usage',
    sec_type: 'Typography',
    sec_images: 'Image usage',
    sec_mode: 'Generation mode',
    sec_refine: 'Refine spec first',
    sub_mode: 'Narrative mode',
    sub_visual: 'Visual style',
    sub_divergence: 'Material divergence (how freely to reshape vs. stay close to the source)',
    placeholder_divergence:
      'In your words — e.g. "stick closely to the document" / "freely restructure and expand within the source". Leave blank for a balanced default.',
    custom: 'Custom',
    custom_placeholder: 'Type your own…',
    recommended: 'Recommended',
    placeholder_audience: 'Who is this deck for?',
    placeholder_pages: 'e.g. 12-15',
    hex_override: 'Custom HEX override:',
    formula_policy: 'Formula rendering policy',
    image_ai_path: 'AI image source',
    image_strategy: 'Generated image style',
    image_strategy_empty: 'No generated-image style candidates were provided.',
    image_strategy_rendering: 'Rendering',
    image_strategy_palette: 'Palette',
    image_strategy_visual: 'Visual',
    image_strategy_color: 'Color',
    image_strategy_mood: 'Mood',
    image_usage_custom_required: 'Describe the custom image plan before confirming.',
    font_heading: 'Heading',
    font_body: 'Body',
    font_body_size: 'Body baseline size',
    font_body_size_hint: 'All type sizes derive from this body baseline.',
    body_size_hint_canvas: 'This canvas suggests ~{lo}–{hi}px (scales with canvas height).',
    body_size_hint_purpose:
      'This delivery purpose recommends {def}px — one fixed size, not a range.',
    body_size_hint_oor:
      '(Current value is outside the usual range for this canvas — check the unit is right and that it fits.)',
    delivery_purpose: 'Delivery purpose',
    delivery_purpose_hint: 'Read-close decks can run smaller; projected decks need larger type.',
    size_override: 'Per-role size override:',
    size_role_title: 'title',
    size_role_subtitle: 'subtitle',
    size_role_annotation: 'annotation',
    custom_typography: 'Custom typography',
    custom_typography_placeholder:
      'Type your font plan, e.g. Heading: Georgia + KaiTi; Body: Microsoft YaHei + Arial…',
    custom_color: 'Custom color',
    custom_color_placeholder:
      'Describe your colors in words, e.g. deep navy primary, warm orange accent, white background — or paste HEX values…',
    role_background: 'bg',
    role_secondary_bg: '2nd bg',
    role_primary: 'primary',
    role_accent: 'accent',
    role_secondary_accent: '2nd accent',
    role_body_text: 'body text',
    cjk: 'CJK',
    latin: 'Latin',
    sample_cjk: '数字化转型战略',
    sample_latin: 'Digital Transformation',
    style_preview_label: 'Overall impression (color + typography)',
    style_preview_body: '· rough feel only, not the actual slide layout',
    mode_continuous_desc: 'Generate the whole deck in one pass.',
    mode_split_desc: 'Stop after the spec; resume SVG generation in a fresh window.',
    refine_off_desc: 'Spec is written in one go; the pipeline auto-proceeds.',
    refine_on_desc: 'Stop after the spec for review/revision before any generation.',
    off_default: 'Off',
    on: 'On',
    option_prefix: 'Option',
    error_retry: 'Error - retry'
  },
  zh: {
    page_title: '确认设计方案',
    topbar_hint: '选择或自定义各项后点「确认」；页面会关闭，请回到聊天窗口。',
    loading: '加载中…',
    load_error: '无法加载推荐文件，需在启动前写入。',
    btn_confirm: '确认',
    btn_next: '下一步 →',
    deriving: '正在据你的选择生成下游选项…',
    already_confirmed: '已确认过一次，重新提交会覆盖之前的选择。',
    confirmed_title: '✓ 已确认',
    confirmed_hint: '选择已保存，可关闭此页并回到聊天窗口。',
    lang_toggle_title: '切换语言',
    sec_canvas: '画布格式',
    sec_pages: '页数',
    sec_audience: '目标受众',
    sec_style: '风格目标',
    sec_color: '色彩方案',
    sec_icons: '图标使用',
    sec_type: '字体方案',
    sec_images: '图片使用',
    sec_mode: '生成模式',
    sec_refine: '先精修设计规范',
    sub_mode: '叙事模式',
    sub_visual: '视觉风格',
    sub_divergence: '材料发散度（多大程度重塑，还是贴近源材料）',
    placeholder_divergence:
      '用你自己的话写，例如「严格贴着文档来」/「在源材料范围内自由重组并展开」。留空则按平衡处理。',
    custom: '自定义',
    custom_placeholder: '输入自定义内容…',
    recommended: '推荐',
    placeholder_audience: '这份演示文稿面向谁？',
    placeholder_pages: '如：12-15',
    hex_override: '自定义色值覆盖：',
    formula_policy: '公式渲染策略',
    image_ai_path: '生成配图来源',
    image_strategy: '生成图风格',
    image_strategy_empty: '还没有提供生成图风格候选。',
    image_strategy_rendering: '渲染风格',
    image_strategy_palette: '图像调色',
    image_strategy_visual: '视觉',
    image_strategy_color: '色彩',
    image_strategy_mood: '情绪',
    image_usage_custom_required: '请先写清楚自定义图片方案。',
    font_heading: '标题',
    font_body: '正文',
    font_body_size: '正文基准字号',
    font_body_size_hint: '所有字号按这个正文基准推导。',
    body_size_hint_canvas: '当前画布建议 ~{lo}–{hi}px（随画布高度缩放）。',
    body_size_hint_purpose: '该交付目的推荐 {def}px（单一固定值，非区间）。',
    body_size_hint_oor: '（当前数值超出该画布的常用范围——请确认单位无误、是否合适。）',
    delivery_purpose: '交付目的',
    delivery_purpose_hint: '近读型可以小一点；投影型需要更大的字。',
    size_override: '逐角色字号覆盖：',
    size_role_title: '标题',
    size_role_subtitle: '副标题',
    size_role_annotation: '注释',
    custom_typography: '自定义字体方案',
    custom_typography_placeholder: '输入字体方案，如：标题用楷体；正文用微软雅黑…',
    custom_color: '自定义配色',
    custom_color_placeholder: '用文字描述配色，如：深蓝主色、暖橙强调、白色背景——或直接粘贴 HEX 值…',
    role_background: '背景',
    role_secondary_bg: '次级背景',
    role_primary: '主色',
    role_accent: '强调',
    role_secondary_accent: '次强调',
    role_body_text: '正文文字',
    cjk: '中文',
    latin: '西文',
    sample_cjk: '数字化转型战略',
    sample_latin: 'Digital Transformation',
    style_preview_label: '整体形象（配色 + 字体）',
    style_preview_body: '· 仅大致形象，非实际版式',
    mode_continuous_desc: '一次性连续生成整份演示文稿。',
    mode_split_desc: '写完设计规范后停止，另开窗口继续生成页面。',
    refine_off_desc: '设计规范一次写完，流程自动继续。',
    refine_on_desc: '写完设计规范后停下供你审阅或修改，再开始生成。',
    off_default: '关',
    on: '开',
    option_prefix: '方案',
    error_retry: '出错，请重试'
  }
}

export function detectLang(): Lang {
  try {
    const stored = window.localStorage.getItem('ppt_lang')
    if (stored === 'zh' || stored === 'en') return stored
  } catch {
    /* ignore */
  }
  const nav = (navigator.language || 'en').toLowerCase()
  return nav.indexOf('zh') === 0 ? 'zh' : 'en'
}

export function makeT(lang: Lang) {
  return (key: string): string => {
    const dict = MESSAGES[lang] || MESSAGES.en
    return dict[key] != null ? dict[key] : key
  }
}

/** Resolve a bilingual field: `base_<lang>` → `base` (string or {zh,en}) →
 *  cross-lang fallback. Mirror of app.js `localized`. */
export function localized(obj: Record<string, any> | null | undefined, base: string, lang: Lang): string {
  if (!obj) return ''
  const langKey = base + '_' + lang
  const fallbackKey = base + '_' + (lang === 'zh' ? 'en' : 'zh')
  if (obj[langKey] != null) return obj[langKey]
  if (obj[base] != null) {
    if (typeof obj[base] === 'object') {
      return obj[base][lang] || obj[base].en || obj[base].zh || ''
    }
    return obj[base]
  }
  return obj[fallbackKey] || ''
}

export function optionLabel(option: CatalogOption, lang: Lang): string {
  return localized(option, 'label', lang) || String(option && option.id)
}

export function optionDesc(option: CatalogOption, lang: Lang): string {
  return localized(option, 'desc', lang)
}

export function groupLabel(group: CatalogOption, lang: Lang): string {
  return localized(group, 'group', lang)
}

// ---- recommendation resolution (recId chain) -------------------------------

export const REC_ALIASES: Record<string, Record<string, string>> = {
  icons: {
    line: 'tabler-outline',
    filled: 'tabler-filled',
    monochrome: 'chunk-filled'
  },
  image_usage: {
    search: 'web'
  },
  image_ai_path: {
    default: 'auto',
    builtin: 'host-native'
  }
}

function normalizeRecId(field: string, value: string | null | undefined): string | null | undefined {
  if (value == null || value === '') return value
  const aliases = REC_ALIASES[field] || {}
  return aliases[value] || value
}

function legacyRecId(rec: Recommendations | null, field: string): string | null | undefined {
  if (!rec) return null
  if (field === 'canvas') return rec.canvas && rec.canvas.value
  if (field === 'visual_style') return rec.visual_style || (rec.style && rec.style.value)
  if (field === 'icons') return rec.icons && rec.icons.value
  if (field === 'image_usage') return rec.images && rec.images.value
  if (field === 'image_ai_path') return rec.image_ai_path || (rec.images && rec.images.ai_path)
  if (field === 'formula_policy')
    return rec.typography && rec.typography.formula_policy && rec.typography.formula_policy.value
  if (field === 'generation_mode') return rec.generation_mode && rec.generation_mode.value
  return rec[field] && rec[field].value
}

export function recId(rec: Recommendations | null, field: string): string | null | undefined {
  const value = (rec && rec.recommend && rec.recommend[field]) || legacyRecId(rec, field)
  return normalizeRecId(field, (value as string) || null)
}

export function firstId(list: CatalogOption[] | undefined): string | undefined {
  if (!list || !list.length) return undefined
  if (list[0].items) return (list[0].items[0] || ({} as CatalogOption)).id
  return list[0].id
}

/** The AI's pick, or the first catalog option — so an enumerable field ALWAYS
 *  shows a badged recommendation. Mirror of app.js `recOrFirst`. */
export function recOrFirst(
  rec: Recommendations | null,
  field: string,
  list: CatalogOption[] | undefined
): string | undefined {
  const r = recId(rec, field)
  if (r != null && r !== '') return r
  return firstId(list)
}

/** Flatten a flat-or-grouped catalog list to its option array. */
export function flattenCatalog(list: CatalogOption[] | undefined): CatalogOption[] {
  if (!list || !list.length) return []
  if (list[0] && list[0].items) {
    return list.reduce<CatalogOption[]>((a, g) => a.concat(g.items || []), [])
  }
  return list
}

export function isGrouped(list: CatalogOption[] | undefined): boolean {
  return !!(list && list.length && list[0] && list[0].items)
}

// ---- palette / typography normalizers --------------------------------------

export function normPalette(c: Record<string, any> | null | undefined): Palette {
  function read(src: Record<string, any> | undefined, keys: string[]): string | undefined {
    if (!src) return undefined
    for (let i = 0; i < keys.length; i += 1) {
      if (src[keys[i]] != null) return src[keys[i]]
    }
    return undefined
  }
  function collect(src: Record<string, any> | undefined): Palette {
    return {
      background: read(src, ['background', 'bg']),
      secondary_bg: read(src, ['secondary_bg', 'secondary_background', 'card_bg', 'card_background']),
      primary: read(src, ['primary']),
      accent: read(src, ['accent']),
      secondary_accent: read(src, ['secondary_accent', 'secondary']),
      body_text: read(src, ['body_text', 'text'])
    }
  }
  if (c && c.palette) return collect(c.palette)
  if (!c) return {}
  return collect(c)
}

export function typographyBodySize(c: Record<string, any> | null | undefined): string {
  c = c || {}
  const value =
    c.body_size ||
    c.body_baseline ||
    c.body_px ||
    (c.sizes && c.sizes.body) ||
    (c.size && c.size.body) ||
    (c.body && typeof c.body === 'object' && (c.body.size || c.body.font_size))
  return value == null ? '' : String(value).replace(/px$/i, '')
}

export function normTypography(c: Record<string, any> | null | undefined): Typography {
  c = c || {}
  if (c.heading && typeof c.heading === 'object' && c.body && typeof c.body === 'object') {
    return Object.assign({}, c, { body_size: typographyBodySize(c) }) as Typography
  }
  return {
    name: c.name || '',
    note: c.note || '',
    custom: c.custom || '',
    body_size: typographyBodySize(c),
    heading: {
      cjk: c.heading || '',
      latin: c.heading_latin || '',
      css: c.heading_css || '',
      sample_cjk: c.sample_heading || '',
      sample_latin: c.sample_heading_latin || ''
    },
    body: {
      cjk: c.body || '',
      latin: c.body_latin || '',
      css: c.body_css || '',
      sample_cjk: c.sample_body || '',
      sample_latin: c.sample_body_latin || ''
    }
  }
}

// ---- HEX -------------------------------------------------------------------

export function normHex(val: string | undefined | null): string | null {
  const v = (val || '').trim()
  if (!/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(v)) return null
  return v.charAt(0) === '#' ? v : '#' + v
}

export function hexOr(val: string | undefined | null, fallback: string): string {
  return normHex(val) || fallback
}

// ---- canvas / size math ----------------------------------------------------

export const PALETTE_ROLES: (keyof Palette)[] = [
  'background',
  'secondary_bg',
  'primary',
  'accent',
  'secondary_accent',
  'body_text'
]

export const SIZE_ROLES = ['title', 'subtitle', 'annotation'] as const
const SIZE_RATIO: Record<string, number> = { title: 1.75, subtitle: 1.35, annotation: 0.78 }

export function canvasHeight(cat: Catalogs, canvasVal: string | undefined): number | null {
  let dim: string | null = null
  ;(cat.canvas || []).forEach((o) => {
    if (o.id === canvasVal) dim = o.dim || null
  })
  const m = String(dim || canvasVal || '').match(/(\d{2,5})\s*[×xX*]\s*(\d{2,5})/)
  return m ? parseInt(m[2], 10) : null
}

export function isPptCanvas(cat: Catalogs, canvasVal: string | undefined): boolean {
  let dim: string | null = null
  ;(cat.canvas || []).forEach((o) => {
    if (o.id === canvasVal) dim = o.dim || null
  })
  const raw = String(dim || canvasVal || '')
  const id = String(canvasVal || '').toLowerCase()
  return (
    id === 'ppt169' ||
    id === 'ppt43' ||
    /1280\s*[×xX*]\s*720/.test(raw) ||
    /1024\s*[×xX*]\s*768/.test(raw)
  )
}

export function bodySizeRatioBand(
  cat: Catalogs,
  canvasVal: string | undefined
): { lo: number; hi: number } {
  let dim: string | null = null
  ;(cat.canvas || []).forEach((o) => {
    if (o.id === canvasVal) dim = o.dim || null
  })
  const raw = String(dim || canvasVal || '')
  const id = String(canvasVal || '').toLowerCase()
  const isPpt =
    id === 'ppt169' ||
    id === 'ppt43' ||
    /1280\s*[×xX*]\s*720/.test(raw) ||
    /1024\s*[×xX*]\s*768/.test(raw)
  return isPpt ? { lo: 0.031, hi: 0.047 } : { lo: 0.025, hi: 0.033 }
}

export function deliveryBodyPx(purposeId: string | undefined): { lo: number; hi: number; def: number } {
  if (purposeId === 'text') return { lo: 18, hi: 21, def: 20 }
  if (purposeId === 'presentation') return { lo: 28, hi: 32, def: 32 }
  return { lo: 22, hi: 25, def: 24 } // balanced — the default
}

export function defaultBodySizeForCanvas(
  cat: Catalogs,
  canvasVal: string | undefined,
  purposeId: string | undefined
): number {
  if (isPptCanvas(cat, canvasVal)) return deliveryBodyPx(purposeId).def
  const h = canvasHeight(cat, canvasVal)
  if (!h) return 40
  const band = bodySizeRatioBand(cat, canvasVal)
  return Math.round((h * (band.lo + band.hi)) / 2)
}

export function deriveSize(cat: Catalogs, canvasVal: string | undefined, role: string, bodyVal: number): number {
  const raw = (bodyVal || 0) * (SIZE_RATIO[role] || 1)
  if (isPptCanvas(cat, canvasVal)) return Math.round(raw / 2) * 2
  return Math.round(raw)
}

function roundSize(value: number): number {
  return Math.round(value * 100) / 100
}

/** Coerce typography sizes to rounded px and drop delivery_purpose on non-PPT.
 *  Mutates `payload` in place, mirror of app.js `normalizeTypographyForSubmit`. */
export function normalizeTypographyForSubmit(cat: Catalogs, payload: Record<string, any>): void {
  if (!payload.typography || typeof payload.typography !== 'object') return
  const typ = payload.typography
  let body = parseFloat(typ.body_size)
  if (!isFinite(body)) {
    body = defaultBodySizeForCanvas(cat, payload.canvas, payload.delivery_purpose)
  }
  typ.body_size = roundSize(body)
  typ.body_size_unit = 'px'
  if (typ.sizes && typeof typ.sizes === 'object') {
    Object.keys(typ.sizes).forEach((role) => {
      const raw = parseFloat(typ.sizes[role])
      if (isFinite(raw)) typ.sizes[role] = roundSize(raw)
    })
  }
  if (!isPptCanvas(cat, payload.canvas)) delete payload.delivery_purpose
}

// ---- image strategy --------------------------------------------------------

export function imageStrategySpec(rec: Recommendations | null): Record<string, any> {
  return (
    (rec && rec.image_strategy) ||
    (rec && rec.images && rec.images.strategy) ||
    (rec && rec.images && rec.images.ai_strategy) ||
    {}
  )
}

export function imageStrategyCandidates(rec: Recommendations | null): Record<string, any>[] {
  const spec = imageStrategySpec(rec)
  return spec.candidates || spec.options || []
}

export function imageStrategySelectedIndex(rec: Recommendations | null): number {
  const spec = imageStrategySpec(rec)
  const idx = spec.selected || 0
  return Math.min(idx, Math.max(imageStrategyCandidates(rec).length - 1, 0))
}

export function usesCustomImagePlanValue(cat: Catalogs, value: string | undefined): boolean {
  const ids = (cat.image_usage || []).map((item) => item.id)
  return !!value && ids.indexOf(value) === -1
}

function customImagePlanHasAiSignal(rec: Recommendations | null): boolean {
  return imageStrategyCandidates(rec).length > 0 || !!recId(rec, 'image_ai_path')
}

export function needsGeneratedImagesForUsage(
  cat: Catalogs,
  rec: Recommendations | null,
  value: string | undefined
): boolean {
  return value === 'ai' || (usesCustomImagePlanValue(cat, value) && customImagePlanHasAiSignal(rec))
}

// ---- font preview ----------------------------------------------------------

export function previewFontStack(primary: string | undefined, fallback: string | undefined): string {
  if (!primary) return fallback || ''
  if (!fallback) return primary
  return primary + ', ' + fallback
}
