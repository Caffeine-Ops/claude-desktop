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
    ul: 'disc'
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
    ul: 'square'
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
    ul: 'circle'
  }
}

export const DEFAULT_PROPOSAL_STYLE_KEY: ProposalTemplateKey = 'classic'

/** 深拷贝一份模板配置（微调以它为起点，不污染原模板常量）。 */
export function cloneProposalStyle(key: ProposalTemplateKey): ProposalStyleConfig {
  return structuredClone(PROPOSAL_TEMPLATES[key])
}

/** 默认样式（首次进入 / 未选择时用）。 */
export function defaultProposalStyle(): ProposalStyleConfig {
  return cloneProposalStyle(DEFAULT_PROPOSAL_STYLE_KEY)
}
