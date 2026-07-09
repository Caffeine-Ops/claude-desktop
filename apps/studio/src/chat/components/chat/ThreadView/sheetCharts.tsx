import { memo } from 'react'

/* ─────────────── xlsx OOXML 解析工具箱 + 图表 SVG 简绘 ─────────────── */

/**
 * 表格预览的 OOXML 侧解析集合,配套 SpreadsheetPreviewPanel 使用。
 * SheetJS/exceljs 都不吐的部件全在这里手解(输入都是 xlsx 原始 zip 字
 * 节,输出按 sheet 名分组;任何一步失败调用方 try/catch 降级):
 *
 *   parseThemePalette   —— xl/theme/theme1.xml 的 clrScheme 色板。文件
 *     大量样式走 theme 索引 + tint 而非直接 RGB,不解析真色板就只能猜
 *     Office 默认主题(颜色对不上的最大来源,2026-07-08 用户实拍)。
 *   parseSheetDrawings  —— drawing 锚点走 OPC 关系链,同时收:
 *     图表(chart XML → 类型/标题/系列/引用,数据按引用回表取,取数
 *     函数由调用方注入)与嵌入图片(blip → xl/media/* → base64)。
 *   parseSheetFreezes   —— sheetView pane 的冻结窗格。
 *   parseSheetTables    —— Excel Table(套用表格格式)的内置样式映射。
 *   parseSheetCondFmts  —— 条件格式 dataBar / cellIs / colorScale
 *     (+dxfs 样式解引用)。expression / iconSet 不支持,静默跳过
 *     (iconSet 的图标 id 映射成本高、AI 报表罕见,刻意放弃)。
 *
 *   SheetMiniChart —— 轻量 SVG 自绘(line / col / bar / pie 四类,
 *     doughnut 归 pie、area 归 line)。刻意不引图表库:ECharts 级依赖
 *     ~800KB 且观感与 Excel 原生图不符;Univer 的原生图表插件是
 *     @univerjs-pro 商业包(无证书带水印),预览走「开源 float DOM +
 *     自绘 SVG」零许可费。布局是 Excel 默认图表的简化仿写。
 *
 * 解析在渲染进程跑(DOMParser),图表/图片是增强不是底线。
 */

export type ChartSeries = {
  name: string
  /** 系列【填充】色(#rrggbb;srgbClr 直读、schemeClr 经主题色板)。
   *  ⚠️ 只认 spPr 直接子级的 solidFill——a:ln 里的 srgbClr 是描边色,
   *  混拿会把「只写了描边」的系列(hospital 月度柱状图)错染成描边
   *  色。null = 文件没写,渲染时按 Excel 规则用主题 accent 循环补
   *  (spec.accents)。 */
  color: string | null
  /** 系列描边色(a:ln > solidFill)。Excel 柱/饼常见「自动填充 + 显式
   *  描边」组合,描边不画观感差一截。 */
  lineColor: string | null
  /** dPt 逐点色(饼图扇区几乎都靠它;柱图逐点也可能有)。稀疏数组,
   *  idx 对齐分类;整组缺失为 null。 */
  ptColors: (string | null)[] | null
  vals: (number | null)[]
}

/** twoCellAnchor 的右下锚(Excel 手工插入的图片/图表用 from+to 而非
 *  ext;像素尺寸依赖列宽行高,由 buildSnapshot 换算后回填 wPx/hPx)。 */
export type AnchorTo = {
  r: number
  c: number
  offX: number
  offY: number
}

export type ChartSpec = {
  /** 锚点格(0-based,锚点的 from)。 */
  fromR: number
  fromC: number
  /** 锚点格内偏移(px,EMU/9525)。 */
  offX: number
  offY: number
  /** 图表框尺寸(px,EMU/9525)。ext 缺失(twoCellAnchor)时为 0,
   *  由 buildSnapshot 按 to 锚点与列宽行高回填。 */
  wPx: number
  hPx: number
  /** twoCellAnchor 的右下锚(有 ext 时缺省)。 */
  to?: AnchorTo
  title: string | null
  kind: 'line' | 'col' | 'bar' | 'pie'
  cats: string[]
  series: ChartSeries[]
  /** 单系列柱图逐点变色(c:varyColors;缺省 true——Excel 对无显式
   *  系列色的单系列柱图默认逐点循环主题色,实测员工示例)。仅当系列
   *  自身没写颜色时生效,写了颜色以文件为准(hospital 的单色条形图)。 */
  vary: boolean
  /** 数值轴反向(valAx scaling orientation="maxMin";hospital 条形图
   *  的「¥7,000 → ¥0」正是它)。 */
  valAxisReversed: boolean
  /** 类目轴反向(catAx orientation="maxMin")。⚠️ 条形图(bar)的
   *  OOXML 默认 minMax = 第一类目在【底部】(类目轴竖直向上),渲染
   *  层按此排;maxMin 才是第一项在顶。竖柱/折线的 minMax 是常规的
   *  「第一项在左」。 */
  catAxisReversed: boolean
  /** 文件主题的 accent1-6(theme1.xml)。系列/扇区无显式色时按
   *  「idx % 6 循环」补——这是 Excel 对"自动"颜色的实际行为;拿
   *  硬编码的新版 Office 色板猜会跟旧主题文件全对不上(2026-07-08
   *  hospital 实拍:openpyxl 默认主题是 2007 经典蓝红绿)。 */
  accents: string[]
}

/** 嵌入图片(drawing 锚点 + xl/media 字节,已转 data URL)。 */
export type SheetImageSpec = {
  fromR: number
  fromC: number
  offX: number
  offY: number
  /** ext 缺失(twoCellAnchor)时为 0,由 buildSnapshot 按 to 回填。 */
  wPx: number
  hPx: number
  to?: AnchorTo
  dataUrl: string
}

const EMU_PER_PX = 9525

export const CHART_FALLBACK_COLORS = [
  '#4472C4',
  '#ED7D31',
  '#A5A5A5',
  '#FFC000',
  '#5B9BD5',
  '#70AD47'
]

/* ──────────────── XML / OPC 基础工具 ──────────────── */

const RELNS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** ns 无关取子孙元素(OOXML 混用默认 ns 与 a:/c:/xdr: 前缀)。 */
function byName(root: Element | Document, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', name))
}

/** 直接子元素。不用 `.children`:bun 冒烟脚本垫的 @xmldom 没实现它,
 *  浏览器与冒烟共用这条,图表分支才能进冒烟覆盖。 */
function childElems(el: Element): Element[] {
  return Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1)
}

/** OPC 相对 target 归一:base='xl/worksheets' + '../drawings/d1.xml' →
 *  'xl/drawings/d1.xml'。 */
function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = baseDir.split('/').filter(Boolean)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

/** rels XML → Map<rId, 归一化 target 路径>。 */
function parseRels(xml: string, baseDir: string, dom: DOMParser): Map<string, { type: string; target: string }> {
  const out = new Map<string, { type: string; target: string }>()
  const doc = dom.parseFromString(xml, 'application/xml')
  for (const rel of byName(doc, 'Relationship')) {
    const id = rel.getAttribute('Id')
    const type = rel.getAttribute('Type') ?? ''
    const target = rel.getAttribute('Target')
    if (id && target) out.set(id, { type, target: resolvePath(baseDir, target) })
  }
  return out
}

/** workbook.xml(+rels)→ [{sheet 名, sheet XML 路径}](按声明顺序)。
 *  各解析器共用的 sheet 遍历入口。 */
async function sheetEntries(
  text: (p: string) => Promise<string | null>,
  dom: DOMParser
): Promise<Array<{ name: string; path: string }>> {
  const wbXml = await text('xl/workbook.xml')
  const wbRelsXml = await text('xl/_rels/workbook.xml.rels')
  if (!wbXml || !wbRelsXml) return []
  const wbRels = parseRels(wbRelsXml, 'xl', dom)
  const wbDoc = dom.parseFromString(wbXml, 'application/xml')
  const out: Array<{ name: string; path: string }> = []
  for (const sheetEl of byName(wbDoc, 'sheet')) {
    const name = sheetEl.getAttribute('name')
    // r:id 属性带 ns 前缀,DOMParser 下按字面名与 NS 各试一次。
    const rid =
      sheetEl.getAttribute('r:id') ?? sheetEl.getAttributeNS(RELNS, 'id')
    if (!name || !rid) continue
    const path = wbRels.get(rid)?.target
    if (path) out.push({ name, path })
  }
  return out
}

/** `'Sheet name'!$B$13:$B$16` / `Sheet!C12` → { sheet, range }。 */
function splitRef(f: string): { sheet: string | null; range: string } {
  const m = /^(?:'([^']+)'|([^'!]+))!(.+)$/.exec(f.trim())
  if (!m) return { sheet: null, range: f.trim().replace(/\$/g, '') }
  return { sheet: m[1] ?? m[2] ?? null, range: m[3]!.replace(/\$/g, '') }
}

/** 元素下首个引用公式(strRef/numRef 里的 <f>)。 */
function refOf(el: Element | undefined): string | null {
  if (!el) return null
  const f = byName(el, 'f')[0]
  return f?.textContent?.trim() || null
}

/** 元素下 rich 文本(a:t 连接)——chart 标题、字面系列名用。 */
function richText(el: Element | undefined): string | null {
  if (!el) return null
  const parts = byName(el, 't')
    .map((t) => t.textContent ?? '')
    .join('')
    .trim()
  return parts || null
}

/* ──────────────── 主题色板(theme1.xml) ──────────────── */

/** Office 默认主题色板,theme1.xml 缺失/解析失败时的兜底。索引按
 *  xlsx 单元格样式的 theme 序:lt1 dk1 lt2 dk2 accent1-6(注意与
 *  clrScheme 子元素的 dk1,lt1,dk2,lt2 声明序前两对互换——Excel 的
 *  历史怪癖,exceljs 同此约定)。 */
export const DEFAULT_THEME = [
  '#FFFFFF',
  '#000000',
  '#E7E6E6',
  '#44546A',
  '#4472C4',
  '#ED7D31',
  '#A5A5A5',
  '#FFC000',
  '#5B9BD5',
  '#70AD47'
]

/** Excel tint:正值向白插值、负值向黑压暗(OOXML 规范算法的简化版)。 */
export function applyTint(hex: string, tint: number): string {
  if (!tint) return hex
  const ch = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16))
    .map((v) =>
      Math.max(
        0,
        Math.min(
          255,
          Math.round(tint > 0 ? v + (255 - v) * tint : v * (1 + tint))
        )
      )
    )
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** 条件格式/dxf 里的 `<color rgb=… / theme=… tint=…/>` → CSS 色。 */
function xmlColor(el: Element | undefined, palette: string[]): string | null {
  if (!el) return null
  const rgb = rgbAttr(el.getAttribute('rgb'))
  if (rgb) return rgb
  const th = el.getAttribute('theme')
  if (th !== null) {
    const base = palette[Number(th)]
    if (base) {
      const tint = Number(el.getAttribute('tint') ?? '0')
      return applyTint(base, Number.isFinite(tint) ? tint : 0)
    }
  }
  return null
}

/**
 * xl/theme/theme1.xml 的 clrScheme → 索引色板(lt1 dk1 lt2 dk2
 * accent1-6)。sysClr(windowText/window)读 lastClr。缺失返回 null,
 * 调用方回落 DEFAULT_THEME。
 */
export async function parseThemePalette(bytes: Uint8Array): Promise<string[] | null> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const path = Object.keys(zip.files).find((p) => /^xl\/theme\/theme\d+\.xml$/.test(p))
  if (!path) return null
  const xml = await zip.file(path)!.async('string')
  const scheme = byName(new DOMParser().parseFromString(xml, 'application/xml'), 'clrScheme')[0]
  if (!scheme) return null
  const colorOf = (tag: string): string | null => {
    const el = byName(scheme, tag)[0]
    if (!el) return null
    const srgb = byName(el, 'srgbClr')[0]?.getAttribute('val')
    if (srgb) return '#' + srgb
    const sys = byName(el, 'sysClr')[0]?.getAttribute('lastClr')
    return sys ? '#' + sys : null
  }
  const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
  const out = order.map(colorOf)
  return out.every((c): c is string => c !== null) ? out : null
}

/** DrawingML schemeClr 名 → 色板索引(bg1/tx1 是 lt1/dk1 的别名)。 */
const SCHEME_TO_IDX: Record<string, number> = {
  lt1: 0,
  bg1: 0,
  dk1: 1,
  tx1: 1,
  lt2: 2,
  bg2: 2,
  dk2: 3,
  tx2: 3,
  accent1: 4,
  accent2: 5,
  accent3: 6,
  accent4: 7,
  accent5: 8,
  accent6: 9
}

/* ──────────────── 图表 + 嵌入图片(drawings) ──────────────── */

/** solidFill 元素 → CSS 色(srgbClr 直读、schemeClr 经主题色板;
 *  lumMod/lumOff 等修饰符忽略,预览不追)。 */
function solidFillColor(fill: Element | undefined, palette: string[]): string | null {
  if (!fill) return null
  const val = byName(fill, 'srgbClr')[0]?.getAttribute('val')
  if (val) return '#' + val
  const scheme = byName(fill, 'schemeClr')[0]?.getAttribute('val')
  if (scheme !== null && scheme !== undefined) {
    const idx = SCHEME_TO_IDX[scheme]
    if (idx !== undefined && palette[idx]) return palette[idx]!
  }
  return null
}

/** spPr → { 填充色, 描边色 }。填充只认 spPr 的【直接子级】solidFill
 *  ——a:ln 里的 solidFill 是描边;AI 生成的图表常见「只写描边不写
 *  填充」(填充留给 Excel 自动上主题色),把描边色当填充色会整图
 *  跑色(hospital 月度柱状图实拍)。线图(kind=line)的"线色"惯例
 *  写在 a:ln 里,由调用方按图型取 lineColor ?? color。 */
function spPrColors(
  el: Element,
  palette: string[]
): { color: string | null; lineColor: string | null } {
  const spPr = childElems(el).find((c) => c.localName === 'spPr')
  if (!spPr) return { color: null, lineColor: null }
  const direct = (name: string): Element | undefined =>
    childElems(spPr).find((c) => c.localName === name)
  const ln = direct('ln')
  return {
    color: solidFillColor(direct('solidFill'), palette),
    lineColor: ln ? solidFillColor(byName(ln, 'solidFill')[0], palette) : null
  }
}

/**
 * 解析一个 chart XML → 半成品 spec(锚点由 drawing 侧补)。
 * resolveRangeVals:按引用回表取值(调用方注入,含公式解引用)。
 */
function parseChartXml(
  xml: string,
  dom: DOMParser,
  resolveRangeVals: (sheet: string | null, range: string) => (string | number | null)[],
  palette: string[]
): Pick<
  ChartSpec,
  'title' | 'kind' | 'cats' | 'series' | 'vary' | 'valAxisReversed' | 'catAxisReversed' | 'accents'
> | null {
  const doc = dom.parseFromString(xml, 'application/xml')
  const plotArea = byName(doc, 'plotArea')[0]
  if (!plotArea) return null

  const KIND_TAGS: Array<{ tag: string; kind: ChartSpec['kind'] }> = [
    { tag: 'lineChart', kind: 'line' },
    { tag: 'areaChart', kind: 'line' },
    { tag: 'barChart', kind: 'col' },
    { tag: 'pieChart', kind: 'pie' },
    { tag: 'doughnutChart', kind: 'pie' }
  ]
  let kind: ChartSpec['kind'] | null = null
  let chartEl: Element | null = null
  for (const { tag, kind: k } of KIND_TAGS) {
    const el = byName(plotArea, tag)[0]
    if (el) {
      chartEl = el
      kind = k
      break
    }
  }
  if (!chartEl || !kind) return null
  // 条形图 = barChart + barDir val="bar"(竖柱是 "col")。
  if (chartEl.localName === 'barChart') {
    const dir = byName(chartEl, 'barDir')[0]?.getAttribute('val')
    if (dir === 'bar') kind = 'bar'
  }

  const titleEl = byName(doc, 'title')[0]
  const title = richText(titleEl)

  const valsFromRef = (f: string | null): (string | number | null)[] => {
    if (!f) return []
    const { sheet, range } = splitRef(f)
    return resolveRangeVals(sheet, range)
  }

  let cats: string[] = []
  const series: ChartSeries[] = []
  for (const ser of byName(chartEl, 'ser')) {
    const txEl = childElems(ser).find((c) => c.localName === 'tx')
    const nameRef = refOf(txEl)
    const name =
      (nameRef
        ? String(valsFromRef(nameRef)[0] ?? '')
        : (richText(txEl) ?? '')) || `系列${series.length + 1}`
    const catEl = childElems(ser).find((c) => c.localName === 'cat')
    const valEl = childElems(ser).find((c) => c.localName === 'val')
    const catVals = valsFromRef(refOf(catEl))
    if (catVals.length > cats.length) {
      cats = catVals.map((v) => (v == null ? '' : String(v)))
    }
    const vals = valsFromRef(refOf(valEl)).map((v) =>
      typeof v === 'number' ? v : v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : null
    )
    // dPt 逐点色:饼图的扇区色几乎都写在这里(ser 级 spPr 反而常常
    // 只有描边)——不解析它,饼图颜色永远对不上文件。
    let ptColors: (string | null)[] | null = null
    for (const dPt of byName(ser, 'dPt')) {
      const idx = Number(byName(dPt, 'idx')[0]?.getAttribute('val'))
      if (!Number.isInteger(idx) || idx < 0 || idx > 5000) continue
      const c = spPrColors(dPt, palette).color
      if (!c) continue
      ptColors ??= []
      ptColors[idx] = c
    }
    const sp = spPrColors(ser, palette)
    series.push({
      name,
      // 线图的惯例是把线色写在 a:ln 里(solidFill 是面积填充),按
      // 图型优先取线色;柱/饼反之。
      color: kind === 'line' ? (sp.lineColor ?? sp.color) : sp.color,
      lineColor: kind === 'line' ? null : sp.lineColor,
      ptColors,
      vals
    })
  }
  if (series.length === 0) return null
  const varyEl = byName(chartEl, 'varyColors')[0]
  const vary = varyEl ? varyEl.getAttribute('val') !== '0' : true
  // 轴方向:catAx/valAx 各自的 scaling>orientation。maxMin = 反向。
  // 条形图的数值轴反向(hospital「¥7,000→¥0」)不渲染的话,条的
  // 生长方向和类目排布都会和 Excel 相反。
  const axisReversed = (tag: string): boolean => {
    const ax = byName(plotArea, tag)[0]
    if (!ax) return false
    return byName(ax, 'orientation')[0]?.getAttribute('val') === 'maxMin'
  }
  return {
    title,
    kind,
    cats,
    series,
    vary,
    valAxisReversed: axisReversed('valAx'),
    catAxisReversed: axisReversed('catAx'),
    accents: palette.slice(4, 10)
  }
}

/** 浏览器可渲染的图片格式;emf/wmf 等矢量剪贴画渲染不了,跳过。 */
const IMG_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp'
}

/**
 * 主入口:xlsx 原始字节 → 按 sheet 名分组的 { 图表, 嵌入图片 }。
 * 两类都挂在 drawing 锚点上,一次遍历同时收。调用方 try/catch;
 * 单个锚点解析失败跳过不连坐。
 */
export async function parseSheetDrawings(
  bytes: Uint8Array,
  resolveRangeVals: (sheet: string | null, range: string) => (string | number | null)[],
  palette: string[] = DEFAULT_THEME
): Promise<Map<string, { charts: ChartSpec[]; images: SheetImageSpec[] }>> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const dom = new DOMParser()
  const text = async (path: string): Promise<string | null> => {
    const file = zip.file(path)
    return file ? file.async('string') : null
  }

  const out = new Map<string, { charts: ChartSpec[]; images: SheetImageSpec[] }>()
  for (const { name, path: sheetPath } of await sheetEntries(text, dom)) {
    const sheetDir = sheetPath.slice(0, sheetPath.lastIndexOf('/'))
    const sheetBase = sheetPath.slice(sheetPath.lastIndexOf('/') + 1)
    const sheetRelsXml = await text(`${sheetDir}/_rels/${sheetBase}.rels`)
    if (!sheetRelsXml) continue
    const sheetRels = parseRels(sheetRelsXml, sheetDir, dom)

    const charts: ChartSpec[] = []
    const images: SheetImageSpec[] = []
    for (const rel of sheetRels.values()) {
      if (!rel.type.endsWith('/drawing')) continue
      const drawingXml = await text(rel.target)
      if (!drawingXml) continue
      const drawingDir = rel.target.slice(0, rel.target.lastIndexOf('/'))
      const drawingBase = rel.target.slice(rel.target.lastIndexOf('/') + 1)
      const drawingRelsXml = await text(`${drawingDir}/_rels/${drawingBase}.rels`)
      const drawingRels = drawingRelsXml
        ? parseRels(drawingRelsXml, drawingDir, dom)
        : new Map<string, { type: string; target: string }>()

      const drawDoc = dom.parseFromString(drawingXml, 'application/xml')
      const anchors = [
        ...byName(drawDoc, 'oneCellAnchor'),
        ...byName(drawDoc, 'twoCellAnchor')
      ]
      for (const anchor of anchors) {
        try {
          const from = byName(anchor, 'from')[0]
          if (!from) continue
          const num = (parent: Element, tag: string): number => {
            const el = byName(parent, tag)[0]
            return el ? Number(el.textContent) || 0 : 0
          }
          // 尺寸两种形态:oneCellAnchor(openpyxl 惯用)带 ext 绝对
          // 尺寸;twoCellAnchor(Excel 手工插入惯用)只有 from/to 两
          // 个格锚——像素尺寸依赖列宽行高,交 buildSnapshot 回填。
          const ext = byName(anchor, 'ext')[0]
          const toEl = byName(anchor, 'to')[0]
          const cx = ext ? Number(ext.getAttribute('cx')) || 0 : 0
          const cy = ext ? Number(ext.getAttribute('cy')) || 0 : 0
          if (cx <= 0 && cy <= 0 && !toEl) continue
          const anchorBox: {
            fromR: number
            fromC: number
            offX: number
            offY: number
            wPx: number
            hPx: number
            to?: AnchorTo
          } = {
            fromR: num(from, 'row'),
            fromC: num(from, 'col'),
            offX: Math.round(num(from, 'colOff') / EMU_PER_PX),
            offY: Math.round(num(from, 'rowOff') / EMU_PER_PX),
            wPx: Math.round(cx / EMU_PER_PX),
            hPx: Math.round(cy / EMU_PER_PX)
          }
          if (toEl && (cx <= 0 || cy <= 0)) {
            anchorBox.to = {
              r: num(toEl, 'row'),
              c: num(toEl, 'col'),
              offX: Math.round(num(toEl, 'colOff') / EMU_PER_PX),
              offY: Math.round(num(toEl, 'rowOff') / EMU_PER_PX)
            }
          }
          // 图表锚点:graphicFrame → c:chart r:id。
          const chartRefEl = byName(anchor, 'chart')[0]
          const chartRid =
            chartRefEl?.getAttribute('r:id') ??
            chartRefEl?.getAttributeNS(RELNS, 'id')
          if (chartRid) {
            const chartPath = drawingRels.get(chartRid)?.target
            if (!chartPath) continue
            const chartXml = await text(chartPath)
            if (!chartXml) continue
            const parsed = parseChartXml(chartXml, dom, resolveRangeVals, palette)
            if (parsed) charts.push({ ...anchorBox, ...parsed })
            continue
          }
          // 图片锚点:xdr:pic → blipFill → a:blip r:embed → xl/media/*。
          const pic = byName(anchor, 'pic')[0]
          if (pic) {
            const blip = byName(pic, 'blip')[0]
            const rid =
              blip?.getAttribute('r:embed') ?? blip?.getAttributeNS(RELNS, 'embed')
            const target = rid ? drawingRels.get(rid)?.target : undefined
            if (!target) continue
            const mime =
              IMG_MIME[target.slice(target.lastIndexOf('.') + 1).toLowerCase()]
            if (!mime) continue
            const file = zip.file(target)
            if (!file) continue
            const b64 = await file.async('base64')
            images.push({ ...anchorBox, dataUrl: `data:${mime};base64,${b64}` })
          }
        } catch {
          // 单个锚点坏了跳过,别连坐同 sheet 其它图。
        }
      }
    }
    if (charts.length > 0 || images.length > 0) out.set(name, { charts, images })
  }
  return out
}

/* ──────────── sheet 默认行高列宽(sheetFormatPr) ──────────── */

/** `<sheetFormatPr defaultColWidth defaultRowHeight baseColWidth/>`。
 *  未显式设尺寸的行列吃这里的默认——不读它,预览的空白列/默认行与
 *  Excel 的宽高就对不上(2026-07-08 用户对照)。单位:列宽为「含
 *  padding 的字符数」(与 col width 同),行高为 pt。
 *  customHeightRows:带 customHeight="1" 的行号集合(0-based)。没有
 *  该标志的行高值只是「Excel 按它自己的字体度量算的 autofit 快照」
 *  ——mac/浏览器端宋体 fallback 的 line box 更高,照抄快照值会把
 *  12pt+ 的文字裁掉半截(2026-07-08 hospital 章节标题实拍),这类行
 *  预览端允许按自己的度量撑高。 */
export type SheetFormatSpec = {
  defColWidthCh?: number
  baseColWidthCh?: number
  defRowHeightPt?: number
  customHeightRows: Set<number>
}

export async function parseSheetFormats(
  bytes: Uint8Array
): Promise<Map<string, SheetFormatSpec>> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const dom = new DOMParser()
  const text = async (path: string): Promise<string | null> => {
    const file = zip.file(path)
    return file ? file.async('string') : null
  }

  const out = new Map<string, SheetFormatSpec>()
  for (const { name, path } of await sheetEntries(text, dom)) {
    const xml = await text(path)
    if (!xml) continue
    const spec: SheetFormatSpec = { customHeightRows: new Set() }
    if (xml.includes('<sheetFormatPr')) {
      const el = byName(dom.parseFromString(xml, 'application/xml'), 'sheetFormatPr')[0]
      if (el) {
        const numAttr = (attr: string): number | undefined => {
          const v = el.getAttribute(attr)
          const n = v === null ? NaN : Number(v)
          return Number.isFinite(n) && n > 0 ? n : undefined
        }
        spec.defColWidthCh = numAttr('defaultColWidth')
        spec.baseColWidthCh = numAttr('baseColWidth')
        spec.defRowHeightPt = numAttr('defaultRowHeight')
      }
    }
    // customHeight 行用正则扫(row 开标签属性平铺,格式稳定)——为了
    // 一个布尔属性对整个 sheet XML(可能上万行)再跑一轮 DOMParser
    // 不值当。
    for (const m of xml.matchAll(/<row [^>]*\bcustomHeight="1"/g)) {
      const r = /\br="(\d+)"/.exec(m[0])
      if (r) spec.customHeightRows.add(Number(r[1]) - 1)
    }
    if (
      spec.defColWidthCh ||
      spec.baseColWidthCh ||
      spec.defRowHeightPt ||
      spec.customHeightRows.size > 0
    ) {
      out.set(name, spec)
    }
  }
  return out
}

/* ──────────────── 冻结窗格(sheetView pane) ──────────────── */

export type FreezeSpec = {
  /** 冻结列数 / 行数。 */
  xSplit: number
  ySplit: number
  /** 可滚动区首行/首列(Univer 语义:冻结带 = [start - split, start),
   *  Excel 的顶部/左侧冻结恒等于 split 数;无该轴冻结时 -1)。 */
  startRow: number
  startColumn: number
}

/** sheet XML 的 `<pane xSplit ySplit state="frozen"/>` → 冻结窗格。
 *  ⚠️ topLeftCell 刻意忽略:它是 Excel 保存时刻的【滚动位置】,不是
 *  冻结带位置(hospital 看板存了 topLeftCell=A22,若拿它当 startRow,
 *  Univer 会把冻结带画到 17-20 行而不是 Excel 实际冻结的前 4 行——
 *  冒烟实测抓到的坑)。split(非冻结的拖分)不支持。 */
export async function parseSheetFreezes(
  bytes: Uint8Array
): Promise<Map<string, FreezeSpec>> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const dom = new DOMParser()
  const text = async (path: string): Promise<string | null> => {
    const file = zip.file(path)
    return file ? file.async('string') : null
  }

  const out = new Map<string, FreezeSpec>()
  for (const { name, path } of await sheetEntries(text, dom)) {
    const xml = await text(path)
    if (!xml || !xml.includes('<pane')) continue
    const pane = byName(dom.parseFromString(xml, 'application/xml'), 'pane')[0]
    if (!pane) continue
    const state = pane.getAttribute('state')
    if (state !== 'frozen' && state !== 'frozenSplit') continue
    const xSplit = Math.max(0, Math.floor(Number(pane.getAttribute('xSplit') ?? '0') || 0))
    const ySplit = Math.max(0, Math.floor(Number(pane.getAttribute('ySplit') ?? '0') || 0))
    if (xSplit === 0 && ySplit === 0) continue
    out.set(name, {
      xSplit,
      ySplit,
      startRow: ySplit > 0 ? ySplit : -1,
      startColumn: xSplit > 0 ? xSplit : -1
    })
  }
  return out
}

/* ──────────────── Excel Table(套用表格格式)解析 ──────────────── */

/**
 * 「深蓝表头 + 斑马纹」这类观感大多来自 Excel Table 的内置样式
 * (tableStyleInfo),不是单元格 fill——exceljs 的 cell.fill 与 SheetJS
 * 的 s.fgColor 都拿不到,必须读 xl/tables/*.xml 自己映射。内置样式
 * (TableStyleLight/Medium/Dark + 序号)的颜色是 Office 应用内置的,
 * xlsx 里只有名字:按「(序号-1) % 7 → 主题 accent 色」的官方排布规律
 * 近似映射,预览级足够。
 */
export type SheetTableStyle = {
  /** table 的 A1 范围(绝对坐标)。 */
  ref: string
  headerRow: boolean
  /** 行条纹(showRowStripes)。 */
  stripes: boolean
  /** 有 autoFilter → 表头画筛选下拉箭头装饰。 */
  autoFilter: boolean
  headerBg: string | null
  headerText: string
  stripeBg: string | null
}

/** 内置 table style 的 7 色循环(none/gray + accent1-6,Office 默认主题)。 */
const TABLE_STYLE_ACCENTS = [
  '#808080',
  '#4472C4',
  '#ED7D31',
  '#A5A5A5',
  '#FFC000',
  '#5B9BD5',
  '#70AD47'
]

/** 向白混合:ratio=0.84 → 只留 16% 原色(条纹浅底)。 */
function lighten(hex: string, ratio: number): string {
  const ch = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16))
    .map((v) => Math.round(v + (255 - v) * ratio))
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('')
}

function darken(hex: string, ratio: number): string {
  const ch = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16))
    .map((v) => Math.round(v * (1 - ratio)))
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** 内置样式名 → 预览色。认不出的名字(自定义样式)返回 null,调用方
 *  只画条纹占位灰。 */
function builtinTableColors(
  name: string | null
): { headerBg: string; headerText: string; stripeBg: string } | null {
  if (!name) return null
  const m = /^TableStyle(Light|Medium|Dark)(\d+)$/.exec(name)
  if (!m) return null
  const accent = TABLE_STYLE_ACCENTS[(Number(m[2]) - 1) % 7]!
  switch (m[1]) {
    case 'Light':
      // Light 系形态是白底彩字细边框,近似成浅色头 + 极浅条纹。
      return {
        headerBg: lighten(accent, 0.72),
        headerText: darken(accent, 0.45),
        stripeBg: lighten(accent, 0.92)
      }
    case 'Dark':
      return {
        headerBg: darken(accent, 0.3),
        headerText: '#ffffff',
        stripeBg: lighten(accent, 0.55)
      }
    default:
      // Medium(最常见,openpyxl 默认族):实底彩头白字 + 浅条纹。
      return {
        headerBg: accent,
        headerText: '#ffffff',
        stripeBg: lighten(accent, 0.84)
      }
  }
}

/**
 * xlsx 原始字节 → 按 sheet 名分组的 Excel Table 样式。走 sheet rels 的
 * `/table` Relationship 找 xl/tables/*.xml。任何失败调用方 try/catch。
 */
export async function parseSheetTables(
  bytes: Uint8Array
): Promise<Map<string, SheetTableStyle[]>> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const dom = new DOMParser()
  const text = async (path: string): Promise<string | null> => {
    const file = zip.file(path)
    return file ? file.async('string') : null
  }

  const out = new Map<string, SheetTableStyle[]>()
  for (const { name, path: sheetPath } of await sheetEntries(text, dom)) {
    const sheetDir = sheetPath.slice(0, sheetPath.lastIndexOf('/'))
    const sheetBase = sheetPath.slice(sheetPath.lastIndexOf('/') + 1)
    const sheetRelsXml = await text(`${sheetDir}/_rels/${sheetBase}.rels`)
    if (!sheetRelsXml) continue
    const sheetRels = parseRels(sheetRelsXml, sheetDir, dom)

    const tables: SheetTableStyle[] = []
    for (const rel of sheetRels.values()) {
      if (!rel.type.endsWith('/table')) continue
      const tableXml = await text(rel.target)
      if (!tableXml) continue
      const doc = dom.parseFromString(tableXml, 'application/xml')
      const tableEl = byName(doc, 'table')[0]
      if (!tableEl) continue
      const ref = tableEl.getAttribute('ref')
      if (!ref) continue
      // headerRowCount 缺省 = 1(OOXML 默认),写了 0 才是无表头。
      const headerAttr = tableEl.getAttribute('headerRowCount')
      const styleEl = byName(doc, 'tableStyleInfo')[0]
      const colors = builtinTableColors(styleEl?.getAttribute('name') ?? null)
      tables.push({
        ref,
        headerRow: headerAttr === null || headerAttr !== '0',
        stripes: styleEl?.getAttribute('showRowStripes') === '1',
        autoFilter: byName(doc, 'autoFilter').length > 0,
        headerBg: colors?.headerBg ?? null,
        headerText: colors?.headerText ?? '#1f2328',
        stripeBg: colors?.stripeBg ?? null
      })
    }
    if (tables.length > 0) out.set(name, tables)
  }
  return out
}

/* ──────────────── 批注(comments)解析 ──────────────── */

/** 带批注的格子(0-based 行列 + 纯文本内容)。预览只画 Excel 同款的
 *  右上角红三角标记,不渲染批注框——但解析层把文本带出来,标记的
 *  tooltip / 以后要做浮层都用得上。 */
export type SheetCommentSpec = { r: number; c: number; text: string }

/** sheet rels 的 comments Relationship → xl/comments*.xml 的
 *  commentList。exceljs 那份输入里批注已被 stripForExceljs 剥掉
 *  (它对 openpyxl 批注 rels 会崩),这里读的是原始字节。 */
export async function parseSheetComments(
  bytes: Uint8Array
): Promise<Map<string, SheetCommentSpec[]>> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const dom = new DOMParser()
  const text = async (path: string): Promise<string | null> => {
    const file = zip.file(path)
    return file ? file.async('string') : null
  }

  const out = new Map<string, SheetCommentSpec[]>()
  for (const { name, path: sheetPath } of await sheetEntries(text, dom)) {
    const sheetDir = sheetPath.slice(0, sheetPath.lastIndexOf('/'))
    const sheetBase = sheetPath.slice(sheetPath.lastIndexOf('/') + 1)
    const sheetRelsXml = await text(`${sheetDir}/_rels/${sheetBase}.rels`)
    if (!sheetRelsXml) continue
    const sheetRels = parseRels(sheetRelsXml, sheetDir, dom)

    const specs: SheetCommentSpec[] = []
    for (const rel of sheetRels.values()) {
      if (!rel.type.endsWith('/comments')) continue
      const xml = await text(rel.target)
      if (!xml) continue
      const doc = dom.parseFromString(xml, 'application/xml')
      for (const comment of byName(doc, 'comment')) {
        const ref = comment.getAttribute('ref')
        if (!ref) continue
        const m = /^([A-Z]{1,3})(\d+)$/.exec(ref)
        if (!m) continue
        let c = 0
        for (const ch of m[1]!) c = c * 26 + (ch.charCodeAt(0) - 64)
        const body = byName(comment, 'text')[0]
        specs.push({ r: Number(m[2]) - 1, c: c - 1, text: richText(body) ?? '' })
      }
    }
    if (specs.length > 0) out.set(name, specs)
  }
  return out
}

/* ─────────── 条件格式(dataBar / cellIs / colorScale)解析 ─────────── */

/**
 * AI 报表常用的三类条件格式:数据条(dataBar)、数值比较高亮
 * (cellIs,dxfId 指向 styles.xml 的 dxfs)、色阶(colorScale)。
 * SheetJS/exceljs 都不吐这些,自己解析后交给 Univer 的条件格式插件
 * 渲染(动态规则,非烘焙底色)。expression / iconSet 不支持,静默跳过。
 */
export type CondRule =
  | { kind: 'dataBar'; sqref: string; color: string }
  | {
      kind: 'cellIs'
      sqref: string
      op: string
      value: number
      /** dxf 命中样式(已转 CSS 色;null = dxf 没写该项)。 */
      bg: string | null
      color: string | null
    }
  | {
      kind: 'colorScale'
      sqref: string
      /** 2-3 个渐变停靠点(cfvo+color 按序配对)。 */
      stops: Array<{ type: string; value: number | undefined; color: string }>
    }

/** xlsx 的 rgb 属性('00C0392B' / 'FFC0392B')→ CSS 色(alpha 恒忽略,
 *  openpyxl 写 '00RRGGBB',按标准 ARGB 解析=全透明,历史教训)。 */
function rgbAttr(v: string | null): string | null {
  if (!v || v.length < 6) return null
  return '#' + v.slice(-6)
}

export async function parseSheetCondFmts(
  bytes: Uint8Array,
  palette: string[] = DEFAULT_THEME
): Promise<Map<string, CondRule[]>> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const dom = new DOMParser()
  const text = async (path: string): Promise<string | null> => {
    const file = zip.file(path)
    return file ? file.async('string') : null
  }

  // dxfs:按下标被 cfRule 的 dxfId 引用。只取 font color + fill 色。
  const dxfs: { bg: string | null; color: string | null }[] = []
  const stylesXml = await text('xl/styles.xml')
  if (stylesXml) {
    const sDoc = dom.parseFromString(stylesXml, 'application/xml')
    const dxfsEl = byName(sDoc, 'dxfs')[0]
    if (dxfsEl) {
      for (const dxf of childElems(dxfsEl)) {
        if (dxf.localName !== 'dxf') continue
        const fontEl = byName(dxf, 'font')[0]
        const fontColor = fontEl
          ? xmlColor(byName(fontEl, 'color')[0], palette)
          : null
        const fill = byName(dxf, 'patternFill')[0]
        const bg = fill ? xmlColor(byName(fill, 'fgColor')[0], palette) : null
        dxfs.push({ bg, color: fontColor })
      }
    }
  }

  const out = new Map<string, CondRule[]>()
  for (const { name, path } of await sheetEntries(text, dom)) {
    const sheetXml = await text(path)
    if (!sheetXml || !sheetXml.includes('<conditionalFormatting')) continue
    const doc = dom.parseFromString(sheetXml, 'application/xml')

    const rules: CondRule[] = []
    for (const cf of byName(doc, 'conditionalFormatting')) {
      const sqref = cf.getAttribute('sqref')
      if (!sqref) continue
      for (const rule of byName(cf, 'cfRule')) {
        const type = rule.getAttribute('type')
        if (type === 'dataBar') {
          const color = xmlColor(byName(rule, 'color')[0], palette)
          if (color) rules.push({ kind: 'dataBar', sqref, color })
        } else if (type === 'cellIs') {
          const op = rule.getAttribute('operator')
          const dxfId = Number(rule.getAttribute('dxfId'))
          const formula = byName(rule, 'formula')[0]?.textContent
          const value = formula !== undefined ? Number(formula) : NaN
          const dxf = Number.isFinite(dxfId) ? dxfs[dxfId] : undefined
          if (op && Number.isFinite(value) && dxf) {
            rules.push({ kind: 'cellIs', sqref, op, value, bg: dxf.bg, color: dxf.color })
          }
        } else if (type === 'colorScale') {
          const cs = byName(rule, 'colorScale')[0]
          if (!cs) continue
          const cfvos = byName(cs, 'cfvo')
          const colors = byName(cs, 'color')
          if (cfvos.length < 2 || cfvos.length !== colors.length) continue
          const stops = cfvos.map((v, i) => ({
            type: v.getAttribute('type') ?? 'min',
            value:
              v.getAttribute('val') !== null
                ? Number(v.getAttribute('val'))
                : undefined,
            color: xmlColor(colors[i], palette) ?? '#ffffff'
          }))
          rules.push({ kind: 'colorScale', sqref, stops })
        }
        // expression / iconSet:预览不做,跳过。
      }
    }
    if (rules.length > 0) out.set(name, rules)
  }
  return out
}

/* ─────────────────────── SVG 简绘 ─────────────────────── */

const AXIS_COLOR = '#d0d4da'
const GRID_COLOR = '#e8eaee'
const TEXT_COLOR = '#5a6270'
const TITLE_COLOR = '#2f3540'

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  return String(Math.round(v * 100) / 100)
}

/** Excel「自动」色:主题 accent1-6 按序循环(超过 6 个从头再来)。 */
function accentAt(spec: ChartSpec, i: number): string {
  const accents = spec.accents.length > 0 ? spec.accents : CHART_FALLBACK_COLORS
  return accents[i % accents.length]!
}

/** 系列色:文件显式色优先,没写按 Excel 规则用主题 accent 循环。 */
function seriesColorAt(spec: ChartSpec, s: ChartSeries, i: number): string {
  return s.color ?? accentAt(spec, i)
}

/**
 * 预览级图表绘制。viewBox 固定为文件里的锚框尺寸,width/height 100%
 * 填满宿主容器——Univer float DOM 的盒子随画布缩放变化,SVG 按
 * viewBox 等比跟缩,文字随图一起缩(与 Excel 缩放观感一致)。
 */
export const SheetMiniChart = memo(function SheetMiniChart({
  spec
}: {
  spec: ChartSpec
}): React.JSX.Element {
  const W = spec.wPx
  const H = spec.hPx
  // 图例:多系列按系列;饼图按分类(它只有一个系列,扇区即分类,
  // 色取 dPt 逐点色,与扇区一致)。
  const legendItems: Array<{ name: string; color: string }> =
    spec.kind === 'pie'
      ? spec.cats.map((cat, i) => ({
          name: cat,
          color: spec.series[0]?.ptColors?.[i] ?? accentAt(spec, i)
        }))
      : spec.series.map((s, i) => ({ name: s.name, color: seriesColorAt(spec, s, i) }))
  const hasLegend = spec.series.length > 1 || spec.kind === 'pie'
  const legendW = hasLegend ? Math.min(120, W * 0.28) : 0
  const titleH = spec.title ? 26 : 8

  let body: React.ReactNode
  if (spec.kind === 'pie') {
    body = <PieBody spec={spec} W={W - legendW} H={H} titleH={titleH} />
  } else if (spec.kind === 'bar') {
    body = <BarBody spec={spec} W={W - legendW} H={H} titleH={titleH} horizontal />
  } else if (spec.kind === 'col') {
    body = <BarBody spec={spec} W={W - legendW} H={H} titleH={titleH} horizontal={false} />
  } else {
    body = <LineBody spec={spec} W={W - legendW} H={H} titleH={titleH} />
  }

  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={spec.title ?? 'chart'}
    >
      <rect x={0} y={0} width={W} height={H} fill="#ffffff" />
      {spec.title && (
        <text
          x={(W - legendW) / 2}
          y={17}
          textAnchor="middle"
          fontSize={12}
          fontWeight={600}
          fill={TITLE_COLOR}
        >
          {spec.title}
        </text>
      )}
      {body}
      {hasLegend && (
        <g>
          {legendItems.map((item, i) => {
            // Excel 的右侧图例(legendPos="r")垂直居中,不是顶部对齐。
            const legendTop = Math.max(titleH + 10, (H - legendItems.length * 18) / 2 + 9)
            return (
              <g key={i} transform={`translate(${W - legendW + 6}, ${legendTop + i * 18})`}>
                <rect x={0} y={-8} width={10} height={10} rx={2} fill={item.color} />
                <text x={15} y={0} fontSize={10} fill={TEXT_COLOR}>
                  {item.name.length > 12 ? item.name.slice(0, 12) + '…' : item.name}
                </text>
              </g>
            )
          })}
        </g>
      )}
    </svg>
  )
})

/** 数值轴:向上取整齐上限(1/2/2.5/5 ×10^n 的步长)+ 等距刻度——
 *  28,000 → 上限 30,000、步长 5,000,与 Excel 的默认刻度一致。 */
function niceScale(rawMax: number): { max: number; ticks: number[] } {
  if (rawMax <= 0) return { max: 1, ticks: [0, 1] }
  const raw = rawMax / 5
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const stepN = norm >= 5 ? 5 : norm >= 2.5 ? 2.5 : norm >= 2 ? 2 : 1
  const step = stepN * mag
  const top = Math.ceil(rawMax / step) * step
  const ticks: number[] = []
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v)
  return { max: top, ticks }
}

function maxOf(spec: ChartSpec): number {
  let m = 0
  for (const s of spec.series) for (const v of s.vals) if (v != null && v > m) m = v
  return m || 1
}

/** 每根柱子的颜色:dPt 逐点色 > vary 逐点循环(单系列无显式色) >
 *  系列色。循环色一律走文件主题 accent。 */
function barFill(spec: ChartSpec, s: ChartSeries, si: number, ptIdx: number): string {
  const pt = s.ptColors?.[ptIdx]
  if (pt) return pt
  if (spec.vary && spec.series.length === 1 && !s.color) {
    return accentAt(spec, ptIdx)
  }
  return seriesColorAt(spec, s, si)
}

function LineBody({
  spec,
  W,
  H,
  titleH
}: {
  spec: ChartSpec
  W: number
  H: number
  titleH: number
}): React.JSX.Element {
  const padL = 56
  const padR = 10
  const padB = 26
  const plotW = Math.max(10, W - padL - padR)
  const plotH = Math.max(10, H - titleH - padB - 8)
  const top = titleH + 8
  const { max, ticks } = niceScale(maxOf(spec))
  const n = Math.max(1, spec.cats.length)
  const x = (i: number): number => padL + (plotW * (i + 0.5)) / n
  const y = (v: number): number => top + plotH - (plotH * v) / max
  return (
    <g>
      {ticks.map((tick, i) => (
        <g key={i}>
          <line x1={padL} x2={padL + plotW} y1={y(tick)} y2={y(tick)} stroke={i === 0 ? AXIS_COLOR : GRID_COLOR} strokeWidth={1} />
          <text x={padL - 5} y={y(tick) + 3} textAnchor="end" fontSize={9} fill={TEXT_COLOR}>
            {fmtNum(tick)}
          </text>
        </g>
      ))}
      {spec.cats.map((cat, i) => (
        <text key={i} x={x(i)} y={top + plotH + 14} textAnchor="middle" fontSize={9} fill={TEXT_COLOR}>
          {cat.length > 10 ? cat.slice(0, 10) + '…' : cat}
        </text>
      ))}
      {spec.series.map((s, si) => {
        const color = seriesColorAt(spec, s, si)
        const pts = s.vals
          .map((v, i) => (v == null ? null : `${x(i)},${y(v)}`))
          .filter(Boolean)
          .join(' ')
        return (
          <g key={si}>
            <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
            {s.vals.map((v, i) =>
              v == null ? null : <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={color} />
            )}
          </g>
        )
      })}
    </g>
  )
}

function BarBody({
  spec,
  W,
  H,
  titleH,
  horizontal
}: {
  spec: ChartSpec
  W: number
  H: number
  titleH: number
  horizontal: boolean
}): React.JSX.Element {
  const { max, ticks } = niceScale(maxOf(spec))
  const n = Math.max(1, spec.cats.length)
  const sCount = Math.max(1, spec.series.length)
  if (horizontal) {
    // 条形:分类在左,值向右(数值轴反向时向左,从右端生长)。
    const padL = Math.min(86, W * 0.3)
    const padR = 12
    const padB = 20
    const plotW = Math.max(10, W - padL - padR)
    const plotH = Math.max(10, H - titleH - padB - 6)
    const top = titleH + 6
    const band = plotH / n
    const barH = Math.max(2, (band * 0.62) / sCount)
    // Excel 条形图的类目轴竖直【向上】:OOXML 默认(minMax)是第一
    // 类目在底部,maxMin 反转后才在顶部——照排,否则条序与 Excel
    // 上下颠倒。
    const bandTop = (i: number): number =>
      spec.catAxisReversed ? top + band * i : top + plotH - band * (i + 1)
    // 数值轴反向(maxMin):0 在右端,条从右往左生长,刻度同步镜像。
    const rev = spec.valAxisReversed
    const vx = (v: number): number =>
      rev ? padL + plotW - (plotW * v) / max : padL + (plotW * v) / max
    return (
      <g>
        {ticks.map((tick, i) => {
          const tx = vx(tick)
          return (
            <g key={i}>
              <line x1={tx} x2={tx} y1={top} y2={top + plotH} stroke={i === 0 ? AXIS_COLOR : GRID_COLOR} strokeWidth={1} />
              <text x={tx} y={top + plotH + 12} textAnchor="middle" fontSize={9} fill={TEXT_COLOR}>
                {fmtNum(tick)}
              </text>
            </g>
          )
        })}
        {spec.cats.map((cat, i) => (
          <text key={i} x={padL - 5} y={bandTop(i) + band / 2 + 3} textAnchor="end" fontSize={9} fill={TEXT_COLOR}>
            {cat.length > 8 ? cat.slice(0, 8) + '…' : cat}
          </text>
        ))}
        {spec.series.map((s, si) => {
          return (
            <g key={si}>
              {s.vals.map((v, i) => {
                if (v == null) return null
                const yPos = bandTop(i) + (band - barH * sCount) / 2 + barH * si
                const barLen = (plotW * v) / max
                return (
                  <rect
                    key={i}
                    x={rev ? padL + plotW - barLen : padL}
                    y={yPos}
                    width={barLen}
                    height={barH}
                    fill={barFill(spec, s, si, i)}
                    stroke={s.lineColor ?? undefined}
                    strokeWidth={s.lineColor ? 1 : undefined}
                    rx={1}
                  />
                )
              })}
            </g>
          )
        })}
      </g>
    )
  }
  // 竖柱:分类在下。catAx maxMin 时水平镜像(最后一类在左)。竖柱的
  // 数值轴反向(柱从顶垂下)极罕见,不追。
  const padL = 48
  const padR = 10
  const padB = 26
  const plotW = Math.max(10, W - padL - padR)
  const plotH = Math.max(10, H - titleH - padB - 8)
  const top = titleH + 8
  const band = plotW / n
  const barW = Math.max(2, (band * 0.62) / sCount)
  const bandLeft = (i: number): number =>
    spec.catAxisReversed ? padL + plotW - band * (i + 1) : padL + band * i
  return (
    <g>
      {ticks.map((tick, i) => {
        const ty = top + plotH - (plotH * tick) / max
        return (
          <g key={i}>
            <line x1={padL} x2={padL + plotW} y1={ty} y2={ty} stroke={i === 0 ? AXIS_COLOR : GRID_COLOR} strokeWidth={1} />
            <text x={padL - 5} y={ty + 3} textAnchor="end" fontSize={9} fill={TEXT_COLOR}>
              {fmtNum(tick)}
            </text>
          </g>
        )
      })}
      {spec.cats.map((cat, i) => (
        <text key={i} x={bandLeft(i) + band / 2} y={top + plotH + 14} textAnchor="middle" fontSize={9} fill={TEXT_COLOR}>
          {cat.length > 6 ? cat.slice(0, 6) + '…' : cat}
        </text>
      ))}
      {spec.series.map((s, si) => {
        return (
          <g key={si}>
            {s.vals.map((v, i) => {
              if (v == null) return null
              const h = (plotH * v) / max
              const xPos = bandLeft(i) + (band - barW * sCount) / 2 + barW * si
              return (
                <rect
                  key={i}
                  x={xPos}
                  y={top + plotH - h}
                  width={barW}
                  height={h}
                  fill={barFill(spec, s, si, i)}
                  stroke={s.lineColor ?? undefined}
                  strokeWidth={s.lineColor ? 1 : undefined}
                  rx={1}
                />
              )
            })}
          </g>
        )
      })}
    </g>
  )
}

function PieBody({
  spec,
  W,
  H,
  titleH
}: {
  spec: ChartSpec
  W: number
  H: number
  titleH: number
}): React.JSX.Element {
  // 饼图取第一个系列;分类当扇区。扇区色:dPt 逐点色(文件几乎都
  // 写在这里)> 主题 accent 循环(Excel 对"自动"的行为)。
  const s = spec.series[0]
  const vals = (s?.vals ?? []).map((v) => (v == null || v < 0 ? 0 : v))
  const total = vals.reduce((a, b) => a + b, 0)
  const cx = W / 2
  const cy = titleH + (H - titleH) / 2
  const r = Math.max(10, Math.min(W, H - titleH) / 2 - 14)
  if (total <= 0) return <g />
  let acc = -Math.PI / 2 // Excel 从 12 点起顺时针
  const arcs = vals.map((v, i) => {
    const a0 = acc
    const frac = v / total
    acc += frac * Math.PI * 2
    const a1 = acc
    const large = a1 - a0 > Math.PI ? 1 : 0
    const x0 = cx + r * Math.cos(a0)
    const y0 = cy + r * Math.sin(a0)
    const x1 = cx + r * Math.cos(a1)
    const y1 = cy + r * Math.sin(a1)
    const mid = (a0 + a1) / 2
    return { i, frac, large, x0, y0, x1, y1, mid }
  })
  return (
    <g>
      {arcs.map((a) =>
        a.frac <= 0 ? null : (
          <path
            key={a.i}
            d={`M ${cx} ${cy} L ${a.x0} ${a.y0} A ${r} ${r} 0 ${a.large} 1 ${a.x1} ${a.y1} Z`}
            fill={s?.ptColors?.[a.i] ?? accentAt(spec, a.i)}
            stroke="#ffffff"
            strokeWidth={1}
          />
        )
      )}
      {arcs.map((a) =>
        a.frac < 0.04 ? null : (
          <text
            key={a.i}
            x={cx + r * 0.62 * Math.cos(a.mid)}
            y={cy + r * 0.62 * Math.sin(a.mid) + 3}
            textAnchor="middle"
            fontSize={9}
            fill="#ffffff"
          >
            {Math.round(a.frac * 100)}%
          </text>
        )
      )}
    </g>
  )
}
