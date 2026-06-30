// 方案 Word 文档「样式模板」配置。main（proposalDocx 生成 .docx）与 renderer（导出
// 弹窗的模板选择 / 微调 / 实时预览）共享此文件，保证两端用同一份配置——「预览=导出
// 逐像素一致」这条既有不变量，正是靠 markdownToDocxBuffer(markdown, style) 单一入口
// 同时喂给预览与导出来维持的。本文件只放【纯数据 + 纯换算】，不 import docx（那是
// main 专属重依赖，renderer 不能碰）；docx 结构的拼装在 proposalDocx.ts 里完成。

/** 可选字体（UI 下拉项 = 此联合的 key 顺序）。 */
export type ProposalFontName = '宋体' | '黑体' | '楷体' | '仿宋' | '微软雅黑' | 'Times'

/** 可选中文字号（UI 下拉项）。值 = Word 实际磅值，见 CN_SIZE_PT。 */
export type ProposalSizeName =
  | '初号' | '小初' | '一号' | '小一' | '二号' | '小二'
  | '三号' | '小三' | '四号' | '小四' | '五号' | '小五'

export type ProposalAlign = 'left' | 'center' | 'justify'

/** 三个内置模板键。第一个（classic）是默认——「默认就是第一个模板」。 */
export type ProposalTemplateKey = 'classic' | 'business' | 'academic'

/** 单个层级（封面标题 / 一级 / 二级 / 三级 / 正文）的可调样式。 */
export interface ProposalLevelStyle {
  font: ProposalFontName
  size: ProposalSizeName
  bold: boolean
  align: ProposalAlign
  /** 首行缩进字符数（0 / 1 / 2）。docx 端换算为 indentChars × sizePt × 20 twips。 */
  indentChars: number
  /** 可选标题点缀色（6 位 hex，无 #）。仅商务模板的一二级标题用。 */
  color?: string
}

/** 一份完整的文档样式配置。导出/预览/微调都围绕它。 */
export interface ProposalStyleConfig {
  templateKey: ProposalTemplateKey
  /** 给用户改的风格名（仅显示，导出无副作用）。 */
  name: string
  title: ProposalLevelStyle
  h1: ProposalLevelStyle
  h2: ProposalLevelStyle
  h3: ProposalLevelStyle
  body: ProposalLevelStyle
  /** 行距倍数（1.0 = 单倍）。docx 端 line = round(×240)，lineRule=auto。 */
  lineMultiple: number
  /** 段后距（磅）。docx 端 after = ×20 twips。 */
  spaceAfterPt: number
  /** 页边距档位。 */
  margin: 'narrow' | 'normal' | 'wide'
  /** 有序列表编号格式。 */
  ol: 'decimal' | 'lowerLetter' | 'lowerRoman'
  /** 无序列表项目符号。 */
  ul: 'disc' | 'circle' | 'square'
  /**
   * 品牌化导出（P2-1）：是否加 Fusion Ai 品牌——正文/目录每页页眉横幅 logo + 封面顶部 logo。
   * 独立于排版模板（品牌与字体字号正交），故放顶层而非 ProposalLevelStyle。默认开。关掉则回退
   * 当前裸样式，不破坏现有方案。资产见 proposalBrand.ts。
   */
  brand: boolean
}

/** 中文字号 → Word 磅值（pt）。docx 用 half-points，故生成时再 ×2。 */
export const CN_SIZE_PT: Record<ProposalSizeName, number> = {
  初号: 42, 小初: 36, 一号: 26, 小一: 24, 二号: 22, 小二: 18,
  三号: 16, 小三: 15, 四号: 14, 小四: 12, 五号: 10.5, 小五: 9
}

/** UI 下拉的字号顺序（从大到小）。 */
export const SIZE_ORDER: ProposalSizeName[] = [
  '初号', '小初', '一号', '小一', '二号', '小二',
  '三号', '小三', '四号', '小四', '五号', '小五'
]

/** UI 下拉的字体顺序。 */
export const FONT_ORDER: ProposalFontName[] = ['宋体', '黑体', '楷体', '仿宋', '微软雅黑', 'Times']

/**
 * 字体 → docx 字体名（eastAsia 给中文字形，ascii/hAnsi 给西文/数字）。
 *
 * 西文统一配 Times New Roman（衬线模板）或 Arial（无衬线模板），与中文字形观感协调。
 * 不用「苹方」——它在 Windows Word 缺失会回退默认，跨平台不稳；商务模板统一走「微软
 * 雅黑」（Win 自带、Mac 回退到系统无衬线），保证导出成品两端都有字形。
 */
export const FONT_DOCX: Record<ProposalFontName, { eastAsia: string; ascii: string }> = {
  宋体: { eastAsia: '宋体', ascii: 'Times New Roman' },
  黑体: { eastAsia: '黑体', ascii: 'Arial' },
  楷体: { eastAsia: '楷体', ascii: 'Times New Roman' },
  仿宋: { eastAsia: '仿宋', ascii: 'Times New Roman' },
  微软雅黑: { eastAsia: '微软雅黑', ascii: 'Arial' },
  Times: { eastAsia: '宋体', ascii: 'Times New Roman' }
}

/**
 * 字体 → CSS font-family 栈（renderer 端 docx-preview 的近似预览用）。
 * docx-preview 按 docx 里的字体名渲染，Mac 上「宋体/黑体」等 Windows 字体名常缺失，
 * 这里补一层 Mac 友好回退，让预览的衬线/无衬线区分仍然可见（字形可能回退，但字号/
 * 加粗/对齐/缩进/行距/颜色都精确——足以呈现模板差异；真 Word 成品才是最终基准）。
 */
export const FONT_CSS: Record<ProposalFontName, string> = {
  宋体: '"Songti SC","SimSun","宋体",serif',
  黑体: '"Heiti SC","SimHei","黑体","PingFang SC",sans-serif',
  楷体: '"Kaiti SC","KaiTi","楷体",serif',
  仿宋: '"STFangsong","FangSong","仿宋",serif',
  微软雅黑: '"Microsoft YaHei","微软雅黑","PingFang SC","Heiti SC",sans-serif',
  Times: '"Times New Roman",Georgia,serif'
}

/** 页边距档位 → 四边 twips（1cm ≈ 567 twips）。 */
export const MARGIN_TWIPS: Record<ProposalStyleConfig['margin'], number> = {
  narrow: 1134, // 2cm
  normal: 1440, // 2.54cm（Word 默认 1 英寸）
  wide: 1803 // 3.18cm
}

export const MARGIN_LABEL: Record<ProposalStyleConfig['margin'], string> = {
  narrow: '窄', normal: '中', wide: '宽'
}

function lv(
  font: ProposalFontName,
  size: ProposalSizeName,
  bold: boolean,
  align: ProposalAlign,
  indentChars: number,
  color?: string
): ProposalLevelStyle {
  return { font, size, bold, align, indentChars, color }
}

const ACCENT = '2b46b8' // 商务模板标题靛蓝（与原型一致，克制不刺眼）

/**
 * 三个内置模板。第一个 classic 为默认。
 *
 * 真实方案 markdown 的标题层级直接来自 `#` / `##` / `###`（AI 已在文本里写好「第一章
 * /第一节」等编号），故这里【不做自动编号】——只定义各层级的字体/字号/对齐/缩进/色，
 * 避免与 AI 写好的编号文本重复。封面大标题映射到「文档里第一个一级标题」（见 proposalDocx
 * 的 firstH1AsTitle）。
 */
export const PROPOSAL_TEMPLATES: Record<ProposalTemplateKey, ProposalStyleConfig> = {
  classic: {
    templateKey: 'classic',
    name: '经典正式',
    title: lv('黑体', '二号', true, 'center', 0),
    h1: lv('黑体', '三号', true, 'left', 0),
    h2: lv('黑体', '四号', true, 'left', 0),
    h3: lv('楷体', '小四', true, 'left', 0),
    body: lv('宋体', '小四', false, 'justify', 2),
    lineMultiple: 1.65,
    spaceAfterPt: 6,
    margin: 'normal',
    ol: 'decimal',
    ul: 'disc',
    brand: true
  },
  business: {
    templateKey: 'business',
    name: '简洁商务',
    title: lv('微软雅黑', '小二', true, 'left', 0, ACCENT),
    h1: lv('微软雅黑', '三号', true, 'left', 0, ACCENT),
    h2: lv('微软雅黑', '四号', true, 'left', 0, ACCENT),
    h3: lv('微软雅黑', '小四', true, 'left', 0),
    body: lv('微软雅黑', '小四', false, 'left', 0),
    lineMultiple: 1.8,
    spaceAfterPt: 8,
    margin: 'normal',
    ol: 'decimal',
    ul: 'square',
    brand: true
  },
  academic: {
    templateKey: 'academic',
    name: '专业学术',
    title: lv('宋体', '二号', true, 'center', 0),
    h1: lv('黑体', '四号', true, 'left', 0),
    h2: lv('黑体', '小四', true, 'left', 0),
    h3: lv('宋体', '小四', true, 'left', 0),
    body: lv('宋体', '小四', false, 'justify', 2),
    lineMultiple: 1.5,
    spaceAfterPt: 4,
    margin: 'wide',
    ol: 'decimal',
    ul: 'circle',
    brand: true
  }
}

export const DEFAULT_PROPOSAL_STYLE_KEY: ProposalTemplateKey = 'classic'

/** 深拷贝一份模板配置（微调以它为起点，不污染原模板常量）。 */
export function cloneProposalStyle(key: ProposalTemplateKey): ProposalStyleConfig {
  return structuredClone(PROPOSAL_TEMPLATES[key])
}

/**
 * 切换样式模板时的【智能合并】：以「当前模板默认值」（draft.templateKey 指示）为基准，逐叶子
 * 字段判断用户是否动过——动过的（draft 值 ≠ 当前模板默认）保留，没动过的采用新模板对应值。
 * templateKey 切到新模板。这样切模板只换走用户「没微调过」的字段，显式改过的字体/字号/行距/
 * 页边距等跟着走，不再被整份覆盖（修复前 selectTemplate 整份 clone，切模板即丢全部微调）。
 *
 * 想彻底回到某模板的纯默认，走「还原模板默认」（= cloneProposalStyle(key)），不经本函数。
 * 点【当前已选中】的模板卡：oldBase===next，每个字段 keep(cur,old,neu) 中 old===neu，未动的
 * 取 neu(=old 不变)、动过的取 cur(保留)——故点当前卡是 no-op，绝不再清空微调。纯函数、可单测。
 */
export function mergeTemplateSwitch(
  draft: ProposalStyleConfig,
  newKey: ProposalTemplateKey
): ProposalStyleConfig {
  const oldBase = PROPOSAL_TEMPLATES[draft.templateKey] ?? PROPOSAL_TEMPLATES[DEFAULT_PROPOSAL_STYLE_KEY]
  const next = PROPOSAL_TEMPLATES[newKey]
  // 用户动过（cur≠old）→ 保留 cur；否则采用新模板 neu。用 Object.is 以正确处理 undefined（color）。
  const keep = <T>(cur: T, old: T, neu: T): T => (Object.is(cur, old) ? neu : cur)
  const mergeLevel = (
    cur: ProposalLevelStyle,
    old: ProposalLevelStyle,
    neu: ProposalLevelStyle
  ): ProposalLevelStyle => {
    const merged: ProposalLevelStyle = {
      font: keep(cur.font, old.font, neu.font),
      size: keep(cur.size, old.size, neu.size),
      bold: keep(cur.bold, old.bold, neu.bold),
      align: keep(cur.align, old.align, neu.align),
      indentChars: keep(cur.indentChars, old.indentChars, neu.indentChars)
    }
    // color 可选：合并结果可能为 undefined（如切到无标题色的模板且用户没设色）→ 不写该键。
    const color = keep(cur.color, old.color, neu.color)
    if (color) merged.color = color
    return merged
  }
  return {
    templateKey: newKey,
    name: keep(draft.name, oldBase.name, next.name),
    title: mergeLevel(draft.title, oldBase.title, next.title),
    h1: mergeLevel(draft.h1, oldBase.h1, next.h1),
    h2: mergeLevel(draft.h2, oldBase.h2, next.h2),
    h3: mergeLevel(draft.h3, oldBase.h3, next.h3),
    body: mergeLevel(draft.body, oldBase.body, next.body),
    lineMultiple: keep(draft.lineMultiple, oldBase.lineMultiple, next.lineMultiple),
    spaceAfterPt: keep(draft.spaceAfterPt, oldBase.spaceAfterPt, next.spaceAfterPt),
    margin: keep(draft.margin, oldBase.margin, next.margin),
    ol: keep(draft.ol, oldBase.ol, next.ol),
    ul: keep(draft.ul, oldBase.ul, next.ul),
    brand: keep(draft.brand, oldBase.brand, next.brand)
  }
}

/** 默认样式（首次进入 / 未选择时用）。 */
export function defaultProposalStyle(): ProposalStyleConfig {
  return cloneProposalStyle(DEFAULT_PROPOSAL_STYLE_KEY)
}

// 反序列化校验用的合法值集合（与各联合类型同源）。持久化数据可能是旧 schema / 任意损坏，
// 故逐字段校验值合法性，非法即回退默认——而非信任 `as ProposalStyleConfig`。
const ALIGN_VALUES: readonly ProposalAlign[] = ['left', 'center', 'justify']
const MARGIN_VALUES: readonly ProposalStyleConfig['margin'][] = ['narrow', 'normal', 'wide']
const OL_VALUES: readonly ProposalStyleConfig['ol'][] = ['decimal', 'lowerLetter', 'lowerRoman']
const UL_VALUES: readonly ProposalStyleConfig['ul'][] = ['disc', 'circle', 'square']
const TEMPLATE_KEYS: readonly ProposalTemplateKey[] = ['classic', 'business', 'academic']

/** 取 v（若是 allowed 里的合法值）否则 base。用于把任意持久化值收敛回联合类型。 */
function pick<T extends string>(v: unknown, allowed: readonly T[], base: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : base
}

/**
 * 取 v（若是 [min,max] 内的有限数）否则 base。挡住负值 / 0 / NaN / Infinity / 荒谬巨值——
 * 这些进 docx 会出大问题：lineMultiple≤0 让 `round(×240)` 产 0 或负，docx 抛
 * 「Invalid value '-720'. Must be a positive integer」整篇导出/预览直接失败；indentChars 负
 * 让首行缩进 twips 为负同样炸；spaceAfterPt 巨值则排版退化。range 取得宽松（覆盖 UI 滑块全程
 * 与合法微调），只拦真正越界的脏持久化值，回退默认而非裁剪（与 pick 的「非法即回退」一致、
 * 行为可预测）。这正是 coerce 立身的契约：绝不让半残配置喂进 docx 生成。 */
function num(v: unknown, min: number, max: number, base: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : base
}

/** docx 颜色要 6 位 hex（RRGGBB、无 #）。校验防止脏色值原样拼进 docx XML（坏色值 / 注入串）。 */
const HEX6_RE = /^[0-9a-fA-F]{6}$/

/**
 * 把任意来源的（可能旧 schema / 部分损坏 / 缺字段的）样式数据强制补全成完整 ProposalStyleConfig。
 * 持久化反序列化（store 的 loadPersisted）必经此函数：缺哪个字段就用默认模板对应字段兜底、
 * 枚举值非法也回退——绝不让半残配置喂进 docx 生成。否则 main 侧 levelStyle 解引用 undefined.size
 * 抛 TypeError、MARGIN_TWIPS[undefined]/OL_FORMAT[undefined] 产 NaN/undefined，导出 Word 直接失败
 * （评审发现：旧浅校验只看 templateKey/title/body 在不在，缺 h1/h2/h3/margin/ol/ul 照样直用）。
 *
 * 合并到【字段级】（每个层级的 font/size/… 缺一个补一个），不是整块替换：用户只改过 body.size
 * 的旧配置仍保留其改动、同时补回新增字段。纯函数、可单测、无副作用。main 与 renderer 共享。
 */
export function coerceProposalStyle(raw: unknown): ProposalStyleConfig {
  const d = defaultProposalStyle()
  if (!raw || typeof raw !== 'object') return d
  const p = raw as Record<string, unknown>
  const lvl = (
    key: 'title' | 'h1' | 'h2' | 'h3' | 'body',
    base: ProposalLevelStyle
  ): ProposalLevelStyle => {
    const v = p[key]
    if (!v || typeof v !== 'object') return base
    const o = v as Record<string, unknown>
    const merged: ProposalLevelStyle = {
      font: pick(o.font, FONT_ORDER, base.font),
      size: pick(o.size, SIZE_ORDER, base.size),
      bold: typeof o.bold === 'boolean' ? o.bold : base.bold,
      align: pick(o.align, ALIGN_VALUES, base.align),
      // 首行缩进字符数：0~8 的有限数（UI 是 0/1/2 下拉，放宽到 8 容未来微调）。负值会让
      // docx 首行缩进 twips 为负而炸，故越界回退 base。
      indentChars: num(o.indentChars, 0, 8, base.indentChars)
    }
    // color 可选：必须是 6 位 hex（docx 要 RRGGBB）才采用，否则沿用 base 的（可能本就无）——
    // 挡住坏色值 / 注入串原样拼进 docx XML。
    const color = typeof o.color === 'string' && HEX6_RE.test(o.color) ? o.color : base.color
    if (color) merged.color = color
    return merged
  }
  return {
    templateKey: pick(p.templateKey, TEMPLATE_KEYS, d.templateKey),
    name: typeof p.name === 'string' ? p.name : d.name,
    title: lvl('title', d.title),
    h1: lvl('h1', d.h1),
    h2: lvl('h2', d.h2),
    h3: lvl('h3', d.h3),
    body: lvl('body', d.body),
    // 行距倍数：1.0~3.0（UI 滑块 1.2~2.4，放宽容微调）。≤0 会让 docx line=round(×240) 产 0/负、
    // 抛「Must be a positive integer」整篇导出失败，故越界回退默认。
    lineMultiple: num(p.lineMultiple, 1.0, 3.0, d.lineMultiple),
    // 段后距：0~100pt（UI 滑块 0~24，放宽容微调）。负值 docx 炸、巨值排版退化，越界回退默认。
    spaceAfterPt: num(p.spaceAfterPt, 0, 100, d.spaceAfterPt),
    margin: pick(p.margin, MARGIN_VALUES, d.margin),
    ol: pick(p.ol, OL_VALUES, d.ol),
    ul: pick(p.ul, UL_VALUES, d.ul),
    // 旧持久化配置无 brand 字段 → 默认开（品牌化是本次新增、用户要的默认行为）。
    brand: typeof p.brand === 'boolean' ? p.brand : d.brand
  }
}
