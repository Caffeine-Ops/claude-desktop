import {
  BooleanNumber,
  BorderStyleTypes,
  HorizontalAlign,
  VerticalAlign,
  WrapStrategy,
  type CellValue,
  type ICellData,
  type IObjectMatrixPrimitiveType,
  type IRange,
  type IStyleData,
  type IWorkbookData,
  type IWorksheetData
} from '@univerjs/presets'

import {
  DEFAULT_THEME,
  applyTint,
  parseSheetComments,
  parseSheetCondFmts,
  parseSheetDrawings,
  parseSheetFormats,
  parseSheetFreezes,
  parseSheetTables,
  parseThemePalette,
  type ChartSpec,
  type CondRule,
  type SheetImageSpec
} from '../sheetCharts'
import {
  SHEET_DEFAULT_COL_W,
  SHEET_DEFAULT_ROW_H,
  SHEET_COL_HEADER_H,
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  SHEET_ROW_HEADER_W
} from './constants'

/* ────────────── 文件字节 → Univer IWorkbookData 转换层 ────────────── */

/**
 * 表格预览的解析管线(2026-07-08 迁 Univer 后的形态):渲染与交互全部
 * 交给 Univer,本模块只负责把文件翻译成它的 snapshot 数据模型。
 *
 * 双库分工延续迁移前的结构:
 *   - SheetJS(xlsx 包):单元格【值/公式】+【布局】(合并 !merges、
 *     列宽 !cols、行高 !rows);xlsx / xls / csv 全格式通用。公式一律
 *     塞给 Univer 的公式引擎(initialFormulaComputing=WHEN_EMPTY:有
 *     缓存值直接显示、openpyxl 不写缓存值的格子由引擎现算)——迁移前
 *     手写的求值器只保留给【图表数据解引用】(图表解析发生在 Univer
 *     实例存在之前,引用的又常是「=源表!B6」型引用格)。
 *   - exceljs:单元格【色彩样式】(填充/字体/对齐/边框)。喂之前照旧
 *     stripForExceljs(openpyxl 产物三连崩,见函数注释)。
 *   - OOXML 手解(sheetCharts.tsx):主题色板 / 图表 / 嵌入图片 /
 *     Excel Table 样式 / 条件格式 / 冻结窗格。
 *
 * 输出两份:snapshot(喂 univerAPI.createWorkbook)+ 每 sheet 的
 * extras(图表/图片/条件格式规则/尺寸——需要在 workbook 创建后经
 * facade 注入或供壳层 UI 消费的部分)。
 */

/** 条件格式规则 + 已解码的作用范围(sqref → IRange,按截断 clamp)。 */
export type SheetCfSpec = { rule: CondRule; ranges: IRange[] }

/** 图表 spec + 在 sheet 内容坐标系的像素位置(未含表头偏移)。 */
export type SheetChartSpec = { spec: ChartSpec; x: number; y: number }
/** 图片同构(图表/图片都走 float DOM 纯展示,定位同一套换算)。 */
export type SheetImagePos = { spec: SheetImageSpec; x: number; y: number }

/** 格子角落的装饰标记(float DOM 纯展示):
 *  - filter:Excel Table 表头的筛选下拉按钮【装饰】。曾注入
 *    preset-sheets-filter 真筛选,2026-07-09 用户定稿改纯装饰——
 *    预览是只读的"文件的样子",能真筛会改变显示状态;装饰观感
 *    直接仿 Excel(右下角带边框小方块▼)。
 *  - comment:批注标记(Excel 同款右上角红三角;tip=批注文本)。
 *  ⚠️ 矩形=【角标本身】(格子角落的小块),不是整个格子:装饰的
 *  float DOM 关掉了事件转发(eventPassThrough:false,否则转发回
 *  canvas 会命中 drawing 对象、被 transformer 拖走,2026-07-09 真
 *  机),盒子覆盖到哪,哪里的格子交互(框选/点选)就被吞掉——
 *  必须收到角标那十几像素。 */
export type SheetDecorPos = {
  kind: 'filter' | 'comment'
  x: number
  y: number
  w: number
  h: number
  tip?: string
}

/** 角标尺寸(px,zoom=1)。filter 是 Excel 风小方块,comment 是红三角
 *  的外接盒。 */
const DECOR_FILTER_SIZE = 14
const DECOR_COMMENT_SIZE = 8

export type SheetExtras = {
  name: string
  /** 文件真实规模(截断提示用)。 */
  totalRows: number
  totalCols: number
  charts: SheetChartSpec[]
  images: SheetImagePos[]
  cf: SheetCfSpec[]
  decors: SheetDecorPos[]
}

export type SheetSnapshotResult = {
  snapshot: Partial<IWorkbookData>
  sheets: SheetExtras[]
}

/**
 * exceljs 4.x 会被 openpyxl 写的两类部件崩掉(均为已知 bug,实测):
 *   - 批注:sheet rels 里 comments Relationship 的 Target 是相对路径,
 *     exceljs reconcile 按绝对 zip 路径索引 → undefined 上取属性
 *     TypeError(蜀芯云财务报告的 K 列汇率批注触发);
 *   - 图表:exceljs 的 parse 阶段按 zip 路径扫描 xl/drawings/ 目录本身
 *     (不经 sheet rels!),openpyxl 某些 drawing 形态被 parse 成
 *     undefined,reconcile 读 drawing.anchors 直接炸——只剥 sheet 侧
 *     引用救不了(员工信息示例实测:引用剥干净了照崩),必须把
 *     xl/drawings/ 与 xl/charts/ 整个目录从 zip 里删掉;
 *   - Excel Table:同一份文件删完 drawings 又崩在 worksheet.tables
 *     reconcile(table model 为 undefined 时取 table.name)。
 * 预览对这三样全都自渲染(图表/图片 parseSheetDrawings、套表样式
 * parseSheetTables、批注不渲染),exceljs 只需要出 cell 级样式——
 * 这些部件对它纯属地雷,喂之前一律剥:删 drawings/charts/tables 三个
 * 目录 + sheet rels 里 comments/drawing/table Relationship + sheet XML
 * 里的 `<drawing r:id/>` 与 `<tableParts>…</tableParts>` 引用节点(防
 * dangling 引用再炸一种)。zip 往返几十 ms,比「先崩一次再重试」省
 * (AI 报表带批注/图表/套表是常态不是例外)。
 * ⚠️ legacyDrawing(vmlDrawing rel)别动——它是另一种 Type,sheet XML
 * 的 legacyDrawing 节点引用它,删 rel 不删引用同样会炸。
 */
async function stripForExceljs(bytes: Uint8Array): Promise<Uint8Array> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  for (const zname of Object.keys(zip.files)) {
    if (/^xl\/(?:drawings|charts|tables)\//.test(zname)) {
      zip.remove(zname)
    } else if (/^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(zname)) {
      const xml = await zip.file(zname)!.async('string')
      const cleaned = xml.replace(
        /<Relationship\b[^>]*Type="[^"]*\/(?:comments|drawing|table)"[^>]*\/>/g,
        ''
      )
      if (cleaned !== xml) zip.file(zname, cleaned)
    } else if (/^xl\/worksheets\/[^/]+\.xml$/.test(zname)) {
      const xml = await zip.file(zname)!.async('string')
      // <drawing\b 不会误伤 <legacyDrawing(标签名整体不同)。
      const cleaned = xml
        .replace(/<drawing\b[^>]*\/>/g, '')
        .replace(/<tableParts\b[\s\S]*?<\/tableParts>/g, '')
        .replace(/<tableParts\b[^>]*\/>/g, '')
      if (cleaned !== xml) zip.file(zname, cleaned)
    }
  }
  return zip.generateAsync({ type: 'uint8array' })
}

/** SheetJS dense 单元格(含 CE 版 cellStyles 给的 s.fgColor fill)。 */
type DenseCell = {
  t?: string
  v?: unknown
  w?: string
  f?: string
  z?: string
  s?: { patternType?: string; fgColor?: { rgb?: string } }
}

/** exceljs 颜色对象 → CSS 色。
 *  ⚠️ argb 的 alpha 通道必须忽略:openpyxl 写的颜色一律 '00RRGGBB'
 *  (alpha=00),Excel 语义里它是不透明色——按标准 ARGB 解释会把整个
 *  文件的底色全解析成全透明。Excel 本就不支持单元格透明色。
 *  theme 索引经真实主题色板(parseThemePalette)+ tint 求值。 */
function excelColorToCss(color: unknown, palette: string[]): string | null {
  if (!color || typeof color !== 'object') return null
  const c = color as { argb?: string; theme?: number; tint?: number }
  if (typeof c.argb === 'string') {
    if (c.argb.length === 8) return '#' + c.argb.slice(2)
    if (c.argb.length === 6) return '#' + c.argb
    return null
  }
  if (typeof c.theme === 'number') {
    const base = palette[c.theme]
    if (!base) return null
    return applyTint(base, typeof c.tint === 'number' ? c.tint : 0)
  }
  return null
}

/** 行高纠偏用的字体度量:canvas measureText 的 fontBoundingBox——与
 *  Univer FontCache 同一来源,量出来的就是它渲染时占用的行内高度。
 *  font 串格式也仿它(`bold 12pt 宋体`,pt 单位)。非浏览器环境(bun
 *  冒烟脚本)返回 null,调用方跳过纠偏。 */
let measureCtx: CanvasRenderingContext2D | null | undefined
const lineBoxCache = new Map<string, number>()
function measureLineBox(font: string): number | null {
  if (measureCtx === undefined) {
    measureCtx =
      typeof document === 'undefined'
        ? null
        : document.createElement('canvas').getContext('2d')
  }
  if (!measureCtx) return null
  let v = lineBoxCache.get(font)
  if (v === undefined) {
    measureCtx.font = font
    const m = measureCtx.measureText('核Ag')
    v = (m.fontBoundingBoxAscent ?? 0) + (m.fontBoundingBoxDescent ?? 0)
    lineBoxCache.set(font, v)
  }
  return v
}

/** exceljs 边框线型 → Univer BorderStyleTypes(近似映射,预览级)。 */
function borderStyleOf(style: string): BorderStyleTypes {
  switch (style) {
    case 'medium':
      return BorderStyleTypes.MEDIUM
    case 'thick':
      return BorderStyleTypes.THICK
    case 'double':
      return BorderStyleTypes.DOUBLE
    case 'dotted':
      return BorderStyleTypes.DOTTED
    case 'dashed':
    case 'mediumDashed':
      return BorderStyleTypes.DASHED
    case 'hair':
      return BorderStyleTypes.HAIR
    default:
      return BorderStyleTypes.THIN
  }
}

/**
 * 主入口:base64 文件字节 + 扩展名 → snapshot + extras。
 * 抛错由调用方兜(壳层显示 error 态)。
 */
export async function buildSheetSnapshot(
  dataB64: string,
  ext: string,
  fileName: string
): Promise<SheetSnapshotResult> {
  // 双库 + OOXML 手解全部动态 import:本模块被壳层动态拉起,聊天首屏
  // bundle 零负担。
  const [XLSX, excelMod] = await Promise.all([
    import('xlsx'),
    ext === 'xlsx' ? import('exceljs') : Promise.resolve(null)
  ])
  // dense: 大表下 cell 走数组而非对象字典,解析+遍历都快一截。
  // cellStyles: CE 版借它填 !cols/!rows(列宽行高)与 s.fgColor
  // (fill 兜底);字体/对齐它不给。
  const wb = XLSX.read(dataB64, { type: 'base64', dense: true, cellStyles: true })

  const denseOf = (name: string): DenseCell[][] | undefined =>
    (wb.Sheets[name] as { '!data'?: DenseCell[][] } | undefined)?.['!data']

  /* ── 轻量公式求值(仅图表数据解引用用) ──
   * 值/公式本体已交给 Univer 引擎;但图表解析发生在实例创建之前,
   * 引用的格子又常是 openpyxl 不写缓存值的「=源表!B6」型引用格——
   * 不现算图表数据全空。覆盖:cell 引用(跨表/同表)、四则、括号、
   * 一元负号、字符串字面量、SUM/AVERAGE/COUNT/COUNTA/MAX/MIN、
   * SUMIF/COUNTIF/AVERAGEIF(criteria 支持等值与 >,<,>=,<=,<> 前缀,
   * 通配符不做——AI 透视报表的图表引用格几乎全是 SUMIF 汇总格,
   * 2026-07-09 销售透视示例)。其余返回 undefined,循环引用由 depth
   * 上限兜底。 */
  type FTok =
    | { k: 'ref'; sheet: string | null; a: string; b: string | null }
    | { k: 'num'; v: number }
    | { k: 'str'; v: string }
    | { k: 'fn'; name: string }
    | { k: 'op'; op: string }
  const FTOK_RE =
    /(?:(?:'([^']+)'|([A-Za-z_一-鿿][\w.一-鿿]*))!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?|([A-Za-z]+)(?=\()|(\d+(?:\.\d+)?)|([+\-*/(),])|"((?:[^"]|"")*)"|(\s+)/y
  const tokenizeFormula = (src: string): FTok[] | null => {
    const out: FTok[] = []
    FTOK_RE.lastIndex = 0
    while (FTOK_RE.lastIndex < src.length) {
      const m = FTOK_RE.exec(src)
      if (!m) return null // 认不出的字符(&、比较符…)→ 放弃
      if (m[9] !== undefined) continue // 空白
      if (m[3] !== undefined) {
        out.push({
          k: 'ref',
          sheet: m[1] ?? m[2] ?? null,
          a: m[3].replace(/\$/g, ''),
          b: m[4] ? m[4].replace(/\$/g, '') : null
        })
      } else if (m[5] !== undefined) out.push({ k: 'fn', name: m[5].toUpperCase() })
      else if (m[6] !== undefined) out.push({ k: 'num', v: Number(m[6]) })
      else if (m[7] !== undefined) out.push({ k: 'op', op: m[7] })
      else if (m[8] !== undefined) out.push({ k: 'str', v: m[8].replace(/""/g, '"') })
    }
    return out
  }

  const resolveValue = (
    sheetName: string,
    cell: DenseCell | undefined,
    depth = 0
  ): unknown => {
    if (!cell) return undefined
    // t:'z' 是 stub,其 v 不可信;其余类型直接用真值。
    if (cell.t !== 'z') return cell.v
    if (!cell.f || depth > 8) return undefined
    return evalFormula(cell.f, sheetName, depth)
  }

  const refValue = (sheet: string, a1: string, depth: number): unknown => {
    let addr: ReturnType<typeof XLSX.utils.decode_cell>
    try {
      addr = XLSX.utils.decode_cell(a1)
    } catch {
      return undefined
    }
    return resolveValue(sheet, denseOf(sheet)?.[addr.r]?.[addr.c], depth + 1)
  }

  const rangeCountA = (sheet: string, a1: string, b1: string, depth: number): number => {
    let rng: ReturnType<typeof XLSX.utils.decode_range>
    try {
      rng = XLSX.utils.decode_range(`${a1}:${b1}`)
    } catch {
      return 0
    }
    if ((rng.e.r - rng.s.r + 1) * (rng.e.c - rng.s.c + 1) > 20000) return 0
    let n = 0
    for (let r = rng.s.r; r <= rng.e.r; r++) {
      for (let c = rng.s.c; c <= rng.e.c; c++) {
        const v = resolveValue(sheet, denseOf(sheet)?.[r]?.[c], depth + 1)
        if (v !== undefined && v !== null && v !== '') n++
      }
    }
    return n
  }

  const rangeNums = (sheet: string, a1: string, b1: string, depth: number): number[] => {
    let rng: ReturnType<typeof XLSX.utils.decode_range>
    try {
      rng = XLSX.utils.decode_range(`${a1}:${b1}`)
    } catch {
      return []
    }
    const out: number[] = []
    // 聚合范围上限:防御手工文件里的 A:A 型超大 range 把主线程拖死。
    if ((rng.e.r - rng.s.r + 1) * (rng.e.c - rng.s.c + 1) > 20000) return []
    for (let r = rng.s.r; r <= rng.e.r; r++) {
      for (let c = rng.s.c; c <= rng.e.c; c++) {
        const v = resolveValue(sheet, denseOf(sheet)?.[r]?.[c], depth + 1)
        if (typeof v === 'number') out.push(v)
      }
    }
    return out
  }

  /** SUMIF/COUNTIF 的 criteria 匹配(Excel 语义的预览级子集):
   *  ">100" 等前缀比较、数字等值(宽松,'5'==5)、字符串等值(大小写
   *  不敏感)。通配符 * ? 不做。 */
  const matchCriteria = (v: unknown, crit: unknown): boolean => {
    if (typeof crit === 'string') {
      const m = /^(>=|<=|<>|>|<|=)([\s\S]*)$/.exec(crit)
      if (m) {
        const op = m[1]!
        const rhs = m[2]!
        const rhsNum = Number(rhs)
        if (rhs !== '' && Number.isFinite(rhsNum) && typeof v === 'number') {
          switch (op) {
            case '>':
              return v > rhsNum
            case '<':
              return v < rhsNum
            case '>=':
              return v >= rhsNum
            case '<=':
              return v <= rhsNum
            case '<>':
              return v !== rhsNum
            default:
              return v === rhsNum
          }
        }
        if (op === '=') return String(v ?? '') === rhs
        if (op === '<>') return String(v ?? '') !== rhs
        return false
      }
      return String(v ?? '').toLowerCase() === crit.toLowerCase()
    }
    if (typeof crit === 'number') {
      if (typeof v === 'number') return v === crit
      return v != null && v !== '' && Number(v) === crit
    }
    return false
  }

  /** SUMIF / COUNTIF / AVERAGEIF 的对齐遍历:按 Excel 语义,sum_range
   *  只取左上角,形状跟随 criteria range。 */
  const rangeIf = (
    mode: 'sum' | 'count' | 'avg',
    critRange: { sheet: string; a: string; b: string },
    crit: unknown,
    sumRange: { sheet: string; a: string; b: string } | null,
    depth: number
  ): number | undefined => {
    let rng: ReturnType<typeof XLSX.utils.decode_range>
    try {
      rng = XLSX.utils.decode_range(`${critRange.a}:${critRange.b}`)
    } catch {
      return undefined
    }
    if ((rng.e.r - rng.s.r + 1) * (rng.e.c - rng.s.c + 1) > 20000) return undefined
    let sumOrigin = rng.s
    let sumSheet = critRange.sheet
    if (sumRange) {
      try {
        sumOrigin = XLSX.utils.decode_range(`${sumRange.a}:${sumRange.b}`).s
      } catch {
        return undefined
      }
      sumSheet = sumRange.sheet
    }
    let sum = 0
    let n = 0
    for (let r = rng.s.r; r <= rng.e.r; r++) {
      for (let c = rng.s.c; c <= rng.e.c; c++) {
        const v = resolveValue(critRange.sheet, denseOf(critRange.sheet)?.[r]?.[c], depth + 1)
        if (!matchCriteria(v, crit)) continue
        if (mode === 'count') {
          n++
          continue
        }
        const sv = resolveValue(
          sumSheet,
          denseOf(sumSheet)?.[sumOrigin.r + (r - rng.s.r)]?.[sumOrigin.c + (c - rng.s.c)],
          depth + 1
        )
        if (typeof sv === 'number') {
          sum += sv
          n++
        }
      }
    }
    if (mode === 'count') return n
    if (mode === 'sum') return sum
    return n > 0 ? sum / n : undefined
  }

  const evalFormula = (
    f: string,
    sheetName: string,
    depth: number
  ): number | string | undefined => {
    const toks = tokenizeFormula(f)
    if (!toks) return undefined
    let i = 0
    const peek = (): FTok | undefined => toks[i]
    const isOp = (op: string): boolean => {
      const t = toks[i]
      return t?.k === 'op' && t.op === op
    }
    // 语法错/不支持时置 bad,一路冒泡成 undefined。
    let bad = false
    const num = (v: unknown): number => {
      if (typeof v === 'number') return v
      bad = true
      return NaN
    }
    const primary = (): unknown => {
      const t = peek()
      if (!t) {
        bad = true
        return undefined
      }
      if (t.k === 'num') {
        i++
        return t.v
      }
      if (t.k === 'str') {
        i++
        return t.v
      }
      if (t.k === 'ref') {
        i++
        if (t.b) {
          bad = true // 裸 range 出现在算式里(非聚合参数)不支持
          return undefined
        }
        return refValue(t.sheet ?? sheetName, t.a, depth)
      }
      if (t.k === 'fn') {
        i++
        if (!isOp('(')) {
          bad = true
          return undefined
        }
        i++
        // 参数按原始形态收集(range 保持 range 语义)——SUMIF 系需要
        // criteria range 与 sum range 对齐遍历,提前展开成数值就没法
        // 做了。
        type FArg = { range: { sheet: string; a: string; b: string } } | { v: unknown }
        const fnArgs: FArg[] = []
        if (!isOp(')')) {
          for (;;) {
            const arg = peek()
            if (arg?.k === 'ref' && arg.b) {
              i++
              fnArgs.push({ range: { sheet: arg.sheet ?? sheetName, a: arg.a, b: arg.b } })
            } else {
              fnArgs.push({ v: expr() })
            }
            if (isOp(',')) {
              i++
              continue
            }
            break
          }
        }
        if (!isOp(')')) {
          bad = true
          return undefined
        }
        i++
        // SUMIF/COUNTIF/AVERAGEIF:(critRange, criteria[, sumRange])。
        if (t.name === 'SUMIF' || t.name === 'COUNTIF' || t.name === 'AVERAGEIF') {
          const critArg = fnArgs[0]
          const critVal = fnArgs[1]
          const sumArg = fnArgs[2]
          if (!critArg || !('range' in critArg) || !critVal || 'range' in critVal) {
            bad = true
            return undefined
          }
          const mode = t.name === 'SUMIF' ? 'sum' : t.name === 'COUNTIF' ? 'count' : 'avg'
          const r = rangeIf(
            mode,
            critArg.range,
            critVal.v,
            sumArg && 'range' in sumArg ? sumArg.range : null,
            depth
          )
          if (r === undefined) bad = true
          return r
        }
        // 其余聚合:range 展开(COUNTA 数非空、其它取数值),标量直收。
        const nums: number[] = []
        for (const a of fnArgs) {
          if ('range' in a) {
            if (t.name === 'COUNTA') {
              nums.push(rangeCountA(a.range.sheet, a.range.a, a.range.b, depth))
            } else {
              nums.push(...rangeNums(a.range.sheet, a.range.a, a.range.b, depth))
            }
          } else if (t.name === 'COUNTA') {
            nums.push(a.v !== undefined && a.v !== null && a.v !== '' ? 1 : 0)
          } else {
            nums.push(num(a.v))
          }
        }
        switch (t.name) {
          case 'SUM':
          case 'COUNTA': // range 参数已换算成每段的非空计数,求和即总数
            return nums.reduce((a, b) => a + b, 0)
          case 'AVERAGE':
            return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : undefined
          case 'COUNT':
            return nums.length
          case 'MAX':
            return nums.length ? Math.max(...nums) : undefined
          case 'MIN':
            return nums.length ? Math.min(...nums) : undefined
          default:
            bad = true
            return undefined
        }
      }
      if (t.k === 'op' && t.op === '(') {
        i++
        const v = expr()
        if (!isOp(')')) {
          bad = true
          return undefined
        }
        i++
        return v
      }
      bad = true
      return undefined
    }
    const unary = (): unknown => {
      if (isOp('-')) {
        i++
        return -num(unary())
      }
      return primary()
    }
    const term = (): unknown => {
      let v = unary()
      while (isOp('*') || isOp('/')) {
        const op = (toks[i] as { op: string }).op
        i++
        const rhs = num(unary())
        v = op === '*' ? num(v) * rhs : num(v) / rhs
      }
      return v
    }
    const expr = (): unknown => {
      let v = term()
      while (isOp('+') || isOp('-')) {
        const op = (toks[i] as { op: string }).op
        i++
        const rhs = num(term())
        v = op === '+' ? num(v) + rhs : num(v) - rhs
      }
      return v
    }
    const result = expr()
    if (bad || i < toks.length) return undefined
    if (typeof result === 'number') {
      return Number.isFinite(result) ? result : undefined
    }
    return typeof result === 'string' ? result : undefined
  }

  /* ── xlsx 专属部件(exceljs 样式 + OOXML 手解),失败一律静默降级 ── */

  let bytes: Uint8Array | null = null
  if (excelMod) {
    const bin = atob(dataB64)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  }

  let palette = DEFAULT_THEME
  if (bytes) {
    try {
      palette = (await parseThemePalette(bytes)) ?? DEFAULT_THEME
    } catch {
      palette = DEFAULT_THEME
    }
  }

  let wb2: import('exceljs').Workbook | null = null
  if (excelMod && bytes) {
    try {
      const workbook = new excelMod.Workbook()
      await workbook.xlsx.load((await stripForExceljs(bytes)).buffer as ArrayBuffer)
      wb2 = workbook
    } catch {
      wb2 = null
    }
  }

  const chartResolver = (sheetName: string | null, rangeA1: string): (string | number | null)[] => {
    if (!sheetName) return []
    const dense = denseOf(sheetName)
    if (!dense) return []
    let rng: ReturnType<typeof XLSX.utils.decode_range>
    try {
      rng = XLSX.utils.decode_range(rangeA1)
    } catch {
      return []
    }
    const out: (string | number | null)[] = []
    for (let r = rng.s.r; r <= rng.e.r; r++) {
      for (let c = rng.s.c; c <= rng.e.c; c++) {
        const v = resolveValue(sheetName, dense[r]?.[c])
        out.push(typeof v === 'number' || typeof v === 'string' ? v : null)
      }
    }
    return out
  }

  let drawingsBySheet = new Map<string, { charts: ChartSpec[]; images: SheetImageSpec[] }>()
  let tablesBySheet = new Map<string, import('../sheetCharts').SheetTableStyle[]>()
  let condFmtBySheet = new Map<string, CondRule[]>()
  let freezeBySheet = new Map<string, import('../sheetCharts').FreezeSpec>()
  let formatBySheet = new Map<string, import('../sheetCharts').SheetFormatSpec>()
  let commentsBySheet = new Map<string, import('../sheetCharts').SheetCommentSpec[]>()
  if (bytes) {
    try {
      drawingsBySheet = await parseSheetDrawings(bytes, chartResolver, palette)
    } catch {
      drawingsBySheet = new Map()
    }
    try {
      tablesBySheet = await parseSheetTables(bytes)
    } catch {
      tablesBySheet = new Map()
    }
    try {
      condFmtBySheet = await parseSheetCondFmts(bytes, palette)
    } catch {
      condFmtBySheet = new Map()
    }
    try {
      freezeBySheet = await parseSheetFreezes(bytes)
    } catch {
      freezeBySheet = new Map()
    }
    try {
      formatBySheet = await parseSheetFormats(bytes)
    } catch {
      formatBySheet = new Map()
    }
    try {
      commentsBySheet = await parseSheetComments(bytes)
    } catch {
      commentsBySheet = new Map()
    }
  }

  /* ── 逐 sheet 组装 snapshot ── */

  // 样式表 workbook 级共享:相同样式对象只存一份(intern),cellData
  // 的 s 存 id。AI 报表整列同款样式是常态,不 intern 的话 styles 体积
  // 会按格数爆炸。
  const styles: Record<string, IStyleData> = {}
  const styleIds = new Map<string, string>()
  const internStyle = (st: IStyleData): string => {
    const key = JSON.stringify(st)
    let id = styleIds.get(key)
    if (!id) {
      id = 'p' + styleIds.size.toString(36)
      styleIds.set(key, id)
      styles[id] = st
    }
    return id
  }

  const sheetsRecord: Record<string, Partial<IWorksheetData>> = {}
  const sheetOrder: string[] = []
  const extras: SheetExtras[] = []

  wb.SheetNames.forEach((name, sheetIdx) => {
    const ws = wb.Sheets[name]
    const denseData = denseOf(name) ?? []
    const range = ws?.['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null
    const totalRows = range ? range.e.r + 1 : 0
    const totalCols = range ? range.e.c + 1 : 0
    const rowCount = Math.min(totalRows, SHEET_MAX_ROWS)
    const colCount = Math.min(totalCols, SHEET_MAX_COLS)

    /* 列宽/行高(px)。⚠️ SheetJS 的换算字段两个都不能直用(2026-07-08
     * 对照 Excel 实拍抓出):
     *   - !rows 的 hpx 在 cellStyles 模式下直通 hpt(pt 值),拿它当
     *     px 等于把所有显式行高压扁 25%——12pt 章节标题被裁半截的
     *     主根因。一律 hpt(pt)×4/3(96dpi)自己换算。
     *   - !cols 的 wpx 按它内置的 MDW=6 算,比 Excel 实际(MDW≈7)
     *     窄 ~15%。一律走字符数:width(含 padding)×7,等价于
     *     wch×7+5,与 sheetFormatPr 默认列宽同一套公式。 */
    const colsInfo = ws?.['!cols']
    const colPx: (number | null)[] = Array.from({ length: colCount }, (_, i) => {
      const ci = colsInfo?.[i]
      if (!ci) return null
      if (typeof ci.width === 'number') return Math.round(ci.width * 7)
      if (typeof ci.wch === 'number') return Math.round((ci.wch + 0.71) * 7)
      return typeof ci.wpx === 'number' ? Math.round(ci.wpx) : null
    })
    const rowsInfo = ws?.['!rows']
    const rowPx: (number | null)[] = Array.from({ length: rowCount }, (_, i) => {
      const ri = rowsInfo?.[i]
      if (typeof ri?.hpt === 'number') return Math.round((ri.hpt * 4) / 3)
      return typeof ri?.hpx === 'number' ? Math.round(ri.hpx) : null
    })

    /* 样式矩阵(exceljs 优先;全崩时 SheetJS 的 s.fgColor 兜一层填充
     * 色)。产物直接是 IStyleData,后续只补 numfmt 和套表样式。 */
    const styleGrid: (IStyleData | null)[][] = Array.from(
      { length: rowCount },
      () => new Array<IStyleData | null>(colCount).fill(null)
    )
    const ws2 = wb2?.getWorksheet(name)
    if (ws2) {
      ws2.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const r = rowNumber - 1
        if (r < 0 || r >= rowCount) return
        row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
          const c = colNumber - 1
          if (c < 0 || c >= colCount) return
          const st: IStyleData = {}
          const fill = cell.fill
          if (
            fill &&
            fill.type === 'pattern' &&
            fill.pattern !== 'none' &&
            fill.fgColor
          ) {
            const bg = excelColorToCss(fill.fgColor, palette)
            if (bg) st.bg = { rgb: bg }
          }
          const font = cell.font
          if (font) {
            if (font.bold) st.bl = BooleanNumber.TRUE
            if (font.italic) st.it = BooleanNumber.TRUE
            if (font.color) {
              const fc = excelColorToCss(font.color, palette)
              if (fc) st.cl = { rgb: fc }
            }
            if (typeof font.size === 'number' && font.size !== 11) {
              st.fs = font.size
            }
            if (typeof font.name === 'string' && font.name) st.ff = font.name
          }
          const alignment = cell.alignment
          if (alignment) {
            const h = alignment.horizontal
            if (h === 'left') st.ht = HorizontalAlign.LEFT
            else if (h === 'center') st.ht = HorizontalAlign.CENTER
            else if (h === 'right') st.ht = HorizontalAlign.RIGHT
            const v = alignment.vertical
            if (v === 'top') st.vt = VerticalAlign.TOP
            else if (v === 'middle') st.vt = VerticalAlign.MIDDLE
            else if (v === 'bottom') st.vt = VerticalAlign.BOTTOM
            if (alignment.wrapText) st.tb = WrapStrategy.WRAP
          }
          const bd = cell.border
          if (bd) {
            const edge = (
              e: { style?: string; color?: unknown } | undefined
            ): { s: BorderStyleTypes; cl: { rgb: string } } | undefined =>
              e?.style
                ? {
                    s: borderStyleOf(e.style),
                    cl: { rgb: excelColorToCss(e.color, palette) ?? '#8a9099' }
                  }
                : undefined
            const t = edge(bd.top)
            const b = edge(bd.bottom)
            const l = edge(bd.left)
            const rEdge = edge(bd.right)
            if (t || b || l || rEdge) {
              st.bd = {}
              if (t) st.bd.t = t
              if (b) st.bd.b = b
              if (l) st.bd.l = l
              if (rEdge) st.bd.r = rEdge
            }
          }
          if (Object.keys(st).length > 0) styleGrid[r]![c] = st
        })
      })
    } else {
      let any = false
      for (let r = 0; r < rowCount; r++) {
        for (let c = 0; c < colCount; c++) {
          const s = denseData[r]?.[c]?.s
          const rgb = s?.patternType === 'solid' ? s.fgColor?.rgb : undefined
          if (typeof rgb === 'string' && rgb.length >= 6) {
            styleGrid[r]![c] = { bg: { rgb: '#' + rgb.slice(-6) } }
            any = true
          }
        }
      }
      void any
    }

    /* Excel Table 样式垫底:表头实底白字粗体 + 行条纹。一律「只补缺失
     * 字段」——单元格自己的样式永远压过表格样式,与 Excel 层叠一致。
     * 表头的筛选箭头收集成【装饰格】(经 pxOf 换算后进 extras.decors,
     * float DOM 画 Excel 同款小方块▼)——不再注入真筛选,见
     * SheetDecorPos 注释。 */
    const filterHeaderCells: Array<{ r: number; c: number }> = []
    for (const tb of tablesBySheet.get(name) ?? []) {
      let rng: ReturnType<typeof XLSX.utils.decode_range>
      try {
        rng = XLSX.utils.decode_range(tb.ref)
      } catch {
        continue
      }
      const rEnd = Math.min(rng.e.r, rowCount - 1)
      const cEnd = Math.min(rng.e.c, colCount - 1)
      if (tb.autoFilter && tb.headerRow && rEnd > rng.s.r && rng.s.r >= 0) {
        for (let c = Math.max(0, rng.s.c); c <= cEnd; c++) {
          filterHeaderCells.push({ r: rng.s.r, c })
        }
      }
      for (let r = Math.max(0, rng.s.r); r <= rEnd; r++) {
        const isHeader = tb.headerRow && r === rng.s.r
        const dataIdx = r - rng.s.r - (tb.headerRow ? 1 : 0)
        const stripe =
          !isHeader && tb.stripes && tb.stripeBg !== null && dataIdx % 2 === 1
        if (!isHeader && !stripe) continue
        for (let c = Math.max(0, rng.s.c); c <= cEnd; c++) {
          const st = styleGrid[r]![c] ?? (styleGrid[r]![c] = {})
          if (isHeader) {
            if (tb.headerBg) {
              st.bg ??= { rgb: tb.headerBg }
              st.cl ??= { rgb: tb.headerText }
            }
            st.bl ??= BooleanNumber.TRUE
          } else {
            st.bg ??= { rgb: tb.stripeBg! }
          }
        }
      }
    }

    /* cellData 组装:值/公式 + 数字格式 + 样式 id。 */
    const cellData: IObjectMatrixPrimitiveType<ICellData> = {}
    for (let r = 0; r < rowCount; r++) {
      const drow = denseData[r]
      let rowOut: Record<number, ICellData> | null = null
      for (let c = 0; c < colCount; c++) {
        const cell = drow?.[c]
        let st = styleGrid[r]![c]
        // 数字格式:按查看格自己的 numFmt 交给 Univer 格式化(¥/%/日期
        // 等)。General 无信息量,不占样式条目。
        if (cell?.z && cell.z !== 'General') {
          st = st ? { ...st, n: { pattern: cell.z } } : { n: { pattern: cell.z } }
        }
        const out: ICellData = {}
        if (cell?.f) {
          // OOXML 的 f 不带前导 '=';Univer 引擎要带。有缓存值一并给
          // (WHEN_EMPTY 下直接显示,免一轮现算);openpyxl 的 t:'z'
          // stub 没有可信值,留空让引擎算。空串缓存(生成器写
          // `<v></v>` 占位)同样不可信——传了 WHEN_EMPTY 会当真值
          // 跳过计算,公式格全空。
          out.f = '=' + cell.f
          if (cell.t !== 'z' && cell.v !== undefined && cell.v !== null && cell.v !== '') {
            out.v = cell.v as CellValue
          }
        } else if (cell && cell.t !== 'z' && cell.v !== undefined && cell.v !== null) {
          if (cell.t === 'e') {
            out.v = cell.w ?? '#VALUE!'
          } else if (typeof cell.v === 'boolean') {
            out.v = cell.v
          } else if (typeof cell.v === 'number' || typeof cell.v === 'string') {
            out.v = cell.v
          } else {
            // Date 等罕见对象(cellDates 未开不该出现):退格式化文本。
            out.v = cell.w ?? String(cell.v)
          }
        }
        if (st) out.s = internStyle(st)
        if (out.v !== undefined || out.f !== undefined || out.s !== undefined) {
          rowOut ??= {}
          rowOut[c] = out
        }
      }
      if (rowOut) cellData[r] = rowOut
    }

    /* 合并单元格(clamp 进截断范围)。 */
    const mergeData: IRange[] = (ws?.['!merges'] ?? []).flatMap((m) => {
      const r = m.s.r
      const c = m.s.c
      if (r < 0 || c < 0 || r >= rowCount || c >= colCount) return []
      const endRow = Math.min(m.e.r, rowCount - 1)
      const endColumn = Math.min(m.e.c, colCount - 1)
      if (endRow - r < 1 && endColumn - c < 1) return []
      return [{ startRow: r, startColumn: c, endRow, endColumn }]
    })

    /* 默认行高列宽:文件的 sheetFormatPr 优先——未显式设尺寸的行列
     * 全吃它,不读则与 Excel 对不上(2026-07-08 用户对照)。换算与
     * 显式列宽同一套:defaultColWidth 已含 padding,直接 ×MDW(7);
     * baseColWidth 不含 padding,+0.71 字符(5px/7)再换算;行高
     * pt→px ×4/3。 */
    const fmt = formatBySheet.get(name)
    const defColW = fmt?.defColWidthCh
      ? Math.round(fmt.defColWidthCh * 7)
      : fmt?.baseColWidthCh
        ? Math.round((fmt.baseColWidthCh + 0.71) * 7)
        : SHEET_DEFAULT_COL_W
    const defRowH = fmt?.defRowHeightPt
      ? Math.round((fmt.defRowHeightPt * 4) / 3)
      : SHEET_DEFAULT_ROW_H

    /* 行高兜底:非 customHeight 行的 ht 只是 Excel 按【它自己的字体
     * 度量】存的 autofit 快照——本端「宋体」这类 Windows 字体走
     * fallback,line box 普遍更高。行高不足时 Univer 会裁字,但裁的
     * 前几像素是 fontBoundingBox 的字形外空隙(上下各 2-3px)+ 2px
     * 底 padding,肉眼无感;只有行高低于「line box − 4px 容忍」才会
     * 伤到字形墨迹。对这类行撑到该阈值——刻意收得这么紧,是为了让
     * 「行高只是紧凑」的正常行(默认字号数据行、pt→px 修复后的
     * hospital 章节标题)一个都不动:多撑 1px 都会顺着行高前缀和把
     * 图表/图片锚点整体推移。customHeight 行是用户显式设定,Excel
     * 行高不足时自己也裁,尊重不动。仅浏览器环境生效(度量要 canvas)。 */
    const customRows = fmt?.customHeightRows
    for (let r = 0; r < rowCount; r++) {
      if (customRows?.has(r)) continue
      let need = 0
      for (let c = 0; c < colCount; c++) {
        const st = styleGrid[r]![c]
        const fs = st?.fs
        if (!fs || fs <= 11) continue // 默认字号在默认行高里墨迹恒完整
        const cell = denseData[r]?.[c]
        if (!cell || (cell.v === undefined && !cell.f)) continue // 纯样式空格不算
        const font = `${st!.it ? 'italic ' : ''}${st!.bl ? 'bold ' : ''}${fs}pt ${st!.ff ?? 'Arial'}`
        const lb = measureLineBox(font)
        if (lb === null) {
          need = 0
          break // 非浏览器环境(冒烟脚本)测不了,整行放弃兜底
        }
        need = Math.max(need, Math.ceil(lb) - 4)
      }
      if (need > (rowPx[r] ?? defRowH)) rowPx[r] = need
    }

    /* 行高列宽 + 隐藏行列。 */
    const columnData: Record<number, { w?: number; hd?: BooleanNumber }> = {}
    colPx.forEach((w, i) => {
      const hidden = colsInfo?.[i]?.hidden === true
      if (w !== null || hidden) {
        columnData[i] = {}
        if (w !== null) columnData[i]!.w = w
        if (hidden) columnData[i]!.hd = BooleanNumber.TRUE
      }
    })
    const rowData: Record<number, { h?: number; hd?: BooleanNumber }> = {}
    rowPx.forEach((h, i) => {
      const hidden = rowsInfo?.[i]?.hidden === true
      if (h !== null || hidden) {
        rowData[i] = {}
        if (h !== null) rowData[i]!.h = h
        if (hidden) rowData[i]!.hd = BooleanNumber.TRUE
      }
    })

    /* 图表/图片锚点 → sheet 内容坐标 px(列宽/行高前缀和 + 格内偏
     * 移)。twoCellAnchor(无 ext)的尺寸在此按 to 锚点回填。隐藏行
     * 列不扣除(罕见形态,偏差可接受)。 */
    const colW = (i: number): number => colPx[i] ?? defColW
    const rowH = (i: number): number => rowPx[i] ?? defRowH
    const pxOf = (r: number, c: number, offX: number, offY: number): { x: number; y: number } => {
      let x = offX
      for (let i = 0; i < Math.min(c, SHEET_MAX_COLS); i++) x += colW(i)
      let y = offY
      for (let i = 0; i < Math.min(r, SHEET_MAX_ROWS); i++) y += rowH(i)
      return { x, y }
    }
    const backfillSize = (box: {
      fromR: number
      fromC: number
      offX: number
      offY: number
      wPx: number
      hPx: number
      to?: { r: number; c: number; offX: number; offY: number }
    }): { x: number; y: number } => {
      const p = pxOf(box.fromR, box.fromC, box.offX, box.offY)
      if (box.to && (box.wPx <= 0 || box.hPx <= 0)) {
        const q = pxOf(box.to.r, box.to.c, box.to.offX, box.to.offY)
        box.wPx = Math.max(16, Math.round(q.x - p.x))
        box.hPx = Math.max(16, Math.round(q.y - p.y))
      }
      return p
    }
    const chartsHere = drawingsBySheet.get(name)?.charts ?? []
    const charts: SheetChartSpec[] = chartsHere.map((spec) => {
      const p = backfillSize(spec)
      return { spec, x: p.x, y: p.y }
    })
    const images: SheetImagePos[] = (drawingsBySheet.get(name)?.images ?? []).map(
      (spec) => {
        const p = backfillSize(spec)
        return { spec, x: p.x, y: p.y }
      }
    )

    /* 装饰标记 → 角标小矩形像素(贴格子角落,见 SheetDecorPos 注
     * 释)。上限防御:超宽 Table(几十列)×多表也就百来个 float DOM,
     * 再多(异常文件)截断——每个装饰都是一个 DOM 节点。 */
    const decors: SheetDecorPos[] = []
    for (const { r, c } of filterHeaderCells) {
      if (decors.length >= 200) break
      const p = pxOf(r, c, 0, 0)
      // 贴右下角,四周留 1px(别压住格线)。
      decors.push({
        kind: 'filter',
        x: p.x + Math.max(0, colW(c) - DECOR_FILTER_SIZE - 1),
        y: p.y + Math.max(0, rowH(r) - DECOR_FILTER_SIZE - 1),
        w: DECOR_FILTER_SIZE,
        h: DECOR_FILTER_SIZE
      })
    }
    for (const cm of commentsBySheet.get(name) ?? []) {
      if (decors.length >= 200) break
      if (cm.r < 0 || cm.c < 0 || cm.r >= rowCount || cm.c >= colCount) continue
      const p = pxOf(cm.r, cm.c, 0, 0)
      // 贴右上角。
      decors.push({
        kind: 'comment',
        x: p.x + Math.max(0, colW(cm.c) - DECOR_COMMENT_SIZE),
        y: p.y,
        w: DECOR_COMMENT_SIZE,
        h: DECOR_COMMENT_SIZE,
        tip: cm.text
      })
    }

    /* 条件格式:sqref → IRange[](空格分隔多段,clamp)。 */
    const cf: SheetCfSpec[] = (condFmtBySheet.get(name) ?? []).flatMap((rule) => {
      const ranges: IRange[] = []
      for (const part of rule.sqref.split(/\s+/)) {
        try {
          const rng = XLSX.utils.decode_range(part)
          ranges.push({
            startRow: Math.max(0, rng.s.r),
            startColumn: Math.max(0, rng.s.c),
            endRow: Math.min(rng.e.r, rowCount - 1),
            endColumn: Math.min(rng.e.c, colCount - 1)
          })
        } catch {
          /* 坏 ref 跳过 */
        }
      }
      return ranges.length > 0 ? [{ rule, ranges }] : []
    })

    /* 空白网格余量:数据之外再铺一片(Excel 的「无限网格」观感,
     * canvas 虚拟渲染,行列数只是逻辑上限不占内存)。 */
    const sheetId = 's' + sheetIdx
    const freeze = freezeBySheet.get(name)
    sheetsRecord[sheetId] = {
      id: sheetId,
      name,
      cellData,
      mergeData,
      rowData,
      columnData,
      rowCount: Math.max(rowCount + 40, 100),
      columnCount: Math.max(colCount + 8, 30),
      defaultColumnWidth: defColW,
      defaultRowHeight: defRowH,
      rowHeader: { width: SHEET_ROW_HEADER_W },
      columnHeader: { height: SHEET_COL_HEADER_H },
      showGridlines: BooleanNumber.TRUE,
      ...(freeze
        ? {
            freeze: {
              xSplit: freeze.xSplit,
              ySplit: freeze.ySplit,
              startRow: freeze.startRow,
              startColumn: freeze.startColumn
            }
          }
        : {})
    }
    sheetOrder.push(sheetId)
    extras.push({
      name,
      totalRows,
      totalCols,
      charts,
      images,
      cf,
      decors
    })
  })

  return {
    snapshot: {
      id: 'sheet-preview',
      name: fileName,
      appVersion: '',
      sheetOrder,
      sheets: sheetsRecord,
      styles
    },
    sheets: extras
  }
}
