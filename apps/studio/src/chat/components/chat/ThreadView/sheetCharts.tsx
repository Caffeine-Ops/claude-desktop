import { memo } from 'react'

/* ─────────────── xlsx 嵌入图表:解析 + SVG 简绘 ─────────────── */

/**
 * xlsx 原生图表(DrawingML chart)的预览级还原,配套
 * SpreadsheetPreviewPanel 使用。分两半:
 *
 *   parseSheetCharts —— 从原始 zip 字节走 OPC 关系链:
 *     workbook.xml(.rels) → sheet → sheet rels → drawing(锚点/尺寸)
 *     → drawing rels → chart XML(类型/标题/系列/引用)。
 *     openpyxl 写的 chart 不带 numCache(缓存值是 Excel 打开后才回填
 *     的),系列数据只能按引用回表取——取数函数由调用方注入
 *     (resolveRangeVals,内含跨表公式解引用),本模块不碰工作表数据。
 *
 *   SheetMiniChart —— 轻量 SVG 自绘(line / col / bar / pie 四类,
 *     doughnut 归 pie、area 归 line)。刻意不引图表库:ECharts 级依赖
 *     ~800KB 且观感与 Excel 原生图不符,预览要的是「一眼认出这是文件
 *     里那张图」——系列色取自文件(a:srgbClr),布局是 Excel 默认图表
 *     的简化仿写(顶部标题/右侧图例/浅网格)。
 *
 * 解析在渲染进程跑(DOMParser),任何一步失败都只丢图表不丢表格——
 * 调用方 try/catch 包死,图表是增强不是底线。
 */

export type ChartSeries = {
  name: string
  /** 文件里的系列色(#rrggbb);没写则用 FALLBACK_COLORS 按序补。 */
  color: string | null
  vals: (number | null)[]
}

export type ChartSpec = {
  /** 锚点格(0-based,oneCellAnchor 的 from)。 */
  fromR: number
  fromC: number
  /** 锚点格内偏移(px,EMU/9525)。 */
  offX: number
  offY: number
  /** 图表框尺寸(px,EMU/9525)。 */
  wPx: number
  hPx: number
  title: string | null
  kind: 'line' | 'col' | 'bar' | 'pie'
  cats: string[]
  series: ChartSeries[]
  /** 单系列柱图逐点变色(c:varyColors;缺省 true——Excel 对无显式
   *  系列色的单系列柱图默认逐点循环主题色,实测员工示例)。仅当系列
   *  自身没写颜色时生效,写了颜色以文件为准(hospital 的单色条形图)。 */
  vary: boolean
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

/** ns 无关取子孙元素(chart XML 混用默认 ns 与 a:/c: 前缀)。 */
function byName(root: Element | Document, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', name))
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

/** 系列色:ser>spPr 下第一个 srgbClr(线图在 a:ln 里、柱/饼在 solidFill
 *  里,取第一个已够预览)。 */
function seriesColor(ser: Element): string | null {
  const spPr = Array.from(ser.children).find((c) => c.localName === 'spPr')
  if (!spPr) return null
  const clr = byName(spPr, 'srgbClr')[0]
  const val = clr?.getAttribute('val')
  return val ? '#' + val : null
}

/**
 * 解析一个 chart XML → 半成品 spec(锚点由 drawing 侧补)。
 * resolveRangeVals:按引用回表取值(调用方注入,含公式解引用)。
 */
function parseChartXml(
  xml: string,
  dom: DOMParser,
  resolveRangeVals: (sheet: string | null, range: string) => (string | number | null)[]
): Pick<ChartSpec, 'title' | 'kind' | 'cats' | 'series' | 'vary'> | null {
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
    const txEl = Array.from(ser.children).find((c) => c.localName === 'tx')
    const nameRef = refOf(txEl)
    const name =
      (nameRef
        ? String(valsFromRef(nameRef)[0] ?? '')
        : (richText(txEl) ?? '')) || `系列${series.length + 1}`
    const catEl = Array.from(ser.children).find((c) => c.localName === 'cat')
    const valEl = Array.from(ser.children).find((c) => c.localName === 'val')
    const catVals = valsFromRef(refOf(catEl))
    if (catVals.length > cats.length) {
      cats = catVals.map((v) => (v == null ? '' : String(v)))
    }
    const vals = valsFromRef(refOf(valEl)).map((v) =>
      typeof v === 'number' ? v : v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : null
    )
    series.push({ name, color: seriesColor(ser), vals })
  }
  if (series.length === 0) return null
  const varyEl = byName(chartEl, 'varyColors')[0]
  const vary = varyEl ? varyEl.getAttribute('val') !== '0' : true
  return { title, kind, cats, series, vary }
}

/**
 * 主入口:xlsx 原始字节 → 按 sheet 名分组的 ChartSpec[]。
 * 调用方 try/catch;内部单个图表解析失败跳过不连坐。
 */
export async function parseSheetCharts(
  bytes: Uint8Array,
  resolveRangeVals: (sheet: string | null, range: string) => (string | number | null)[]
): Promise<Map<string, ChartSpec[]>> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const dom = new DOMParser()
  const text = async (path: string): Promise<string | null> => {
    const file = zip.file(path)
    return file ? file.async('string') : null
  }

  const out = new Map<string, ChartSpec[]>()
  const wbXml = await text('xl/workbook.xml')
  const wbRelsXml = await text('xl/_rels/workbook.xml.rels')
  if (!wbXml || !wbRelsXml) return out
  const wbRels = parseRels(wbRelsXml, 'xl', dom)

  const wbDoc = dom.parseFromString(wbXml, 'application/xml')
  for (const sheetEl of byName(wbDoc, 'sheet')) {
    const name = sheetEl.getAttribute('name')
    // r:id 属性带 ns 前缀,DOMParser 下按字面名与 NS 各试一次。
    const rid =
      sheetEl.getAttribute('r:id') ??
      sheetEl.getAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'id'
      )
    if (!name || !rid) continue
    const sheetPath = wbRels.get(rid)?.target
    if (!sheetPath) continue

    const sheetDir = sheetPath.slice(0, sheetPath.lastIndexOf('/'))
    const sheetBase = sheetPath.slice(sheetPath.lastIndexOf('/') + 1)
    const sheetRelsXml = await text(`${sheetDir}/_rels/${sheetBase}.rels`)
    if (!sheetRelsXml) continue
    const sheetRels = parseRels(sheetRelsXml, sheetDir, dom)

    const charts: ChartSpec[] = []
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
          const num = (tag: string): number => {
            const el = byName(from, tag)[0]
            return el ? Number(el.textContent) || 0 : 0
          }
          const ext = byName(anchor, 'ext')[0]
          if (!ext) continue // twoCellAnchor 无 ext 的形态先不支持
          const cx = Number(ext.getAttribute('cx')) || 0
          const cy = Number(ext.getAttribute('cy')) || 0
          if (cx <= 0 || cy <= 0) continue
          const chartRefEl = byName(anchor, 'chart')[0]
          const chartRid =
            chartRefEl?.getAttribute('r:id') ??
            chartRefEl?.getAttributeNS(
              'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
              'id'
            )
          if (!chartRid) continue
          const chartPath = drawingRels.get(chartRid)?.target
          if (!chartPath) continue
          const chartXml = await text(chartPath)
          if (!chartXml) continue
          const parsed = parseChartXml(chartXml, dom, resolveRangeVals)
          if (!parsed) continue
          charts.push({
            fromR: num('row'),
            fromC: num('col'),
            offX: Math.round(num('colOff') / EMU_PER_PX),
            offY: Math.round(num('rowOff') / EMU_PER_PX),
            wPx: Math.round(cx / EMU_PER_PX),
            hPx: Math.round(cy / EMU_PER_PX),
            ...parsed
          })
        } catch {
          // 单个锚点/图表坏了跳过,别连坐同 sheet 其它图。
        }
      }
    }
    if (charts.length > 0) out.set(name, charts)
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
  const wbXml = await text('xl/workbook.xml')
  const wbRelsXml = await text('xl/_rels/workbook.xml.rels')
  if (!wbXml || !wbRelsXml) return out
  const wbRels = parseRels(wbRelsXml, 'xl', dom)
  const wbDoc = dom.parseFromString(wbXml, 'application/xml')

  for (const sheetEl of byName(wbDoc, 'sheet')) {
    const name = sheetEl.getAttribute('name')
    const rid =
      sheetEl.getAttribute('r:id') ??
      sheetEl.getAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'id'
      )
    if (!name || !rid) continue
    const sheetPath = wbRels.get(rid)?.target
    if (!sheetPath) continue
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

/* ──────────────── 条件格式(dataBar / cellIs)解析 ──────────────── */

/**
 * AI 报表常用的两类条件格式:数据条(dataBar,如折合收入列的绿条)与
 * 数值比较高亮(cellIs,如负数红字红底)。规则在 sheet XML 的
 * conditionalFormatting 里,cellIs 的样式经 dxfId 指向 styles.xml 的
 * dxfs——SheetJS/exceljs 都不吐这些,自己解析。expression 型(公式
 * 斑马纹等)不支持,静默跳过。
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

/** xlsx 的 rgb 属性('00C0392B' / 'FFC0392B')→ CSS 色(alpha 恒忽略,
 *  同 excelColorToCss 的教训)。 */
function rgbAttr(v: string | null): string | null {
  if (!v || v.length < 6) return null
  return '#' + v.slice(-6)
}

export async function parseSheetCondFmts(
  bytes: Uint8Array
): Promise<Map<string, CondRule[]>> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const dom = new DOMParser()
  const text = async (path: string): Promise<string | null> => {
    const file = zip.file(path)
    return file ? file.async('string') : null
  }

  const out = new Map<string, CondRule[]>()
  const wbXml = await text('xl/workbook.xml')
  const wbRelsXml = await text('xl/_rels/workbook.xml.rels')
  if (!wbXml || !wbRelsXml) return out

  // dxfs:按下标被 cfRule 的 dxfId 引用。只取 font color + fill 色。
  const dxfs: { bg: string | null; color: string | null }[] = []
  const stylesXml = await text('xl/styles.xml')
  if (stylesXml) {
    const sDoc = dom.parseFromString(stylesXml, 'application/xml')
    const dxfsEl = byName(sDoc, 'dxfs')[0]
    if (dxfsEl) {
      for (const dxf of Array.from(dxfsEl.children)) {
        if (dxf.localName !== 'dxf') continue
        const fontColor = byName(dxf, 'font')[0]
          ? rgbAttr(byName(byName(dxf, 'font')[0]!, 'color')[0]?.getAttribute('rgb') ?? null)
          : null
        const fill = byName(dxf, 'patternFill')[0]
        const bg = fill
          ? rgbAttr(byName(fill, 'fgColor')[0]?.getAttribute('rgb') ?? null)
          : null
        dxfs.push({ bg, color: fontColor })
      }
    }
  }

  const wbRels = parseRels(wbRelsXml, 'xl', dom)
  const wbDoc = dom.parseFromString(wbXml, 'application/xml')
  for (const sheetEl of byName(wbDoc, 'sheet')) {
    const name = sheetEl.getAttribute('name')
    const rid =
      sheetEl.getAttribute('r:id') ??
      sheetEl.getAttributeNS(
        'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
        'id'
      )
    if (!name || !rid) continue
    const sheetPath = wbRels.get(rid)?.target
    if (!sheetPath) continue
    const sheetXml = await text(sheetPath)
    if (!sheetXml || !sheetXml.includes('<conditionalFormatting')) continue
    const doc = dom.parseFromString(sheetXml, 'application/xml')

    const rules: CondRule[] = []
    for (const cf of byName(doc, 'conditionalFormatting')) {
      const sqref = cf.getAttribute('sqref')
      if (!sqref) continue
      for (const rule of byName(cf, 'cfRule')) {
        const type = rule.getAttribute('type')
        if (type === 'dataBar') {
          const color = rgbAttr(
            byName(rule, 'color')[0]?.getAttribute('rgb') ?? null
          )
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
        }
        // expression / colorScale / iconSet:预览不做,跳过。
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

function seriesColorAt(s: ChartSeries, i: number): string {
  return s.color ?? CHART_FALLBACK_COLORS[i % CHART_FALLBACK_COLORS.length]!
}

/**
 * 预览级图表绘制。viewBox 固定为文件里的锚框尺寸,外层用 width/height
 * 乘 zoom 等比缩放,文字随图一起缩(与 Excel 缩放观感一致)。
 */
export const SheetMiniChart = memo(function SheetMiniChart({
  spec,
  scale
}: {
  spec: ChartSpec
  scale: number
}): React.JSX.Element {
  const W = spec.wPx
  const H = spec.hPx
  // 图例:多系列按系列;饼图按分类(它只有一个系列,扇区即分类)。
  const legendItems: Array<{ name: string; color: string }> =
    spec.kind === 'pie'
      ? spec.cats.map((cat, i) => ({
          name: cat,
          color: CHART_FALLBACK_COLORS[i % CHART_FALLBACK_COLORS.length]!
        }))
      : spec.series.map((s, i) => ({ name: s.name, color: seriesColorAt(s, i) }))
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
      width={W * scale}
      height={H * scale}
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
          {legendItems.map((item, i) => (
            <g key={i} transform={`translate(${W - legendW + 6}, ${titleH + 10 + i * 18})`}>
              <rect x={0} y={-8} width={10} height={10} rx={2} fill={item.color} />
              <text x={15} y={0} fontSize={10} fill={TEXT_COLOR}>
                {item.name.length > 12 ? item.name.slice(0, 12) + '…' : item.name}
              </text>
            </g>
          ))}
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

/** 单系列柱图逐点变色时每根柱子的颜色(否则回系列色)。 */
function barFill(spec: ChartSpec, s: ChartSeries, si: number, ptIdx: number): string {
  if (spec.vary && spec.series.length === 1 && !s.color) {
    return CHART_FALLBACK_COLORS[ptIdx % CHART_FALLBACK_COLORS.length]!
  }
  return seriesColorAt(s, si)
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
        const color = seriesColorAt(s, si)
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
    // 条形:分类在左,值向右。
    const padL = Math.min(86, W * 0.3)
    const padR = 12
    const padB = 20
    const plotW = Math.max(10, W - padL - padR)
    const plotH = Math.max(10, H - titleH - padB - 6)
    const top = titleH + 6
    const band = plotH / n
    const barH = Math.max(2, (band * 0.62) / sCount)
    return (
      <g>
        {ticks.map((tick, i) => {
          const tx = padL + (plotW * tick) / max
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
          <text key={i} x={padL - 5} y={top + band * i + band / 2 + 3} textAnchor="end" fontSize={9} fill={TEXT_COLOR}>
            {cat.length > 8 ? cat.slice(0, 8) + '…' : cat}
          </text>
        ))}
        {spec.series.map((s, si) => {
          const color = seriesColorAt(s, si)
          return (
            <g key={si}>
              {s.vals.map((v, i) => {
                if (v == null) return null
                const yPos = top + band * i + (band - barH * sCount) / 2 + barH * si
                return (
                  <rect key={i} x={padL} y={yPos} width={(plotW * v) / max} height={barH} fill={barFill(spec, s, si, i)} rx={1} />
                )
              })}
            </g>
          )
        })}
      </g>
    )
  }
  // 竖柱:分类在下。
  const padL = 48
  const padR = 10
  const padB = 26
  const plotW = Math.max(10, W - padL - padR)
  const plotH = Math.max(10, H - titleH - padB - 8)
  const top = titleH + 8
  const band = plotW / n
  const barW = Math.max(2, (band * 0.62) / sCount)
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
        <text key={i} x={padL + band * i + band / 2} y={top + plotH + 14} textAnchor="middle" fontSize={9} fill={TEXT_COLOR}>
          {cat.length > 6 ? cat.slice(0, 6) + '…' : cat}
        </text>
      ))}
      {spec.series.map((s, si) => {
        const color = seriesColorAt(s, si)
        return (
          <g key={si}>
            {s.vals.map((v, i) => {
              if (v == null) return null
              const h = (plotH * v) / max
              const xPos = padL + band * i + (band - barW * sCount) / 2 + barW * si
              return <rect key={i} x={xPos} y={top + plotH - h} width={barW} height={h} fill={barFill(spec, s, si, i)} rx={1} />
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
  // 饼图取第一个系列;分类当扇区,色取 fallback 色板(文件里 pie 的
  // per-point 颜色藏在 dPt 里,预览不追)。
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
            fill={CHART_FALLBACK_COLORS[a.i % CHART_FALLBACK_COLORS.length]}
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

