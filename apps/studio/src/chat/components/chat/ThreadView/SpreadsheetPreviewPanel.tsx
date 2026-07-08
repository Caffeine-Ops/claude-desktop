import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, Check, Copy, Minus, Plus, RotateCw, X } from 'lucide-react'

import { useT } from '../../../i18n'
import { useChatStore } from '../../../stores/chat'
import {
  SHEET_SELECTION_MARKER,
  useSheetPreviewStore,
  type SheetSelectionMeta
} from '../../../stores/filePreview'
import { dispatchChatTurn } from '../../../lib/dispatchChatTurn'
import { Button } from '@/src/components/ui/button'
import {
  parseSheetCharts,
  parseSheetCondFmts,
  parseSheetTables,
  SheetMiniChart,
  type ChartSpec
} from './sheetCharts'

/* ─────────────── Spreadsheet preview panel (right pane) ─────────────── */

/**
 * 右侧表格预览面板:用户点成果卡片里的 xlsx / xls / csv 文件时,在应用内
 * 直接铺开表格内容,替代跳出去开 Excel 的割裂体验(用户没装 Office 时
 * shell.openPath 甚至直接失败)。生命周期最简:
 *
 *   点卡片 → useSheetPreviewStore.openPreview(path) → ThreadView 分栏、
 *   本面板按 path 走 SHEET_FILE_READ 拿原始字节 → 解析 → 渲染;
 *   ✕ / 切会话 → closePreview。
 *
 * 布局与 workflow 脚本面板完全同构:chat 列收窄成持久化的 chatColWidth
 * rail 在左,面板 flex-1 吃大头在右(表格要宽)。slides / proposal 分栏时
 * 让位(卡片点击自身降级回系统应用打开,见 useSplitWorkspaceBusy)。
 *
 * 解析走【双库分工】——这是本组件最重要的结构决策:
 *   - SheetJS(xlsx 包):单元格【值】+【布局】(合并单元格 !merges、
 *     列宽 !cols、行高 !rows——cellStyles:true 时 CE 版就给);xlsx /
 *     xls / csv 全格式通用。值渲染含【单引用公式解引用】:AI 报表看板
 *     大量使用「=源表!B6」引用格,openpyxl 不写公式缓存值,不解引用整
 *     页数字全空;数字按查看格自己的 numFmt 经 XLSX.SSF 格式化。
 *   - exceljs:单元格【色彩样式】(填充色/字体色/粗斜体/字号/对齐)。
 *     SheetJS 社区版不解析这些(Pro 功能);exceljs 只支持 xlsx,csv 本
 *     无样式、xls 太罕见,都静默降级(SheetJS 的 s.fgColor 还能兜一层
 *     填充色)。喂 exceljs 前一律剥掉批注与图表引用(见 stripForExceljs
 *     ——两类 openpyxl 部件都会把它整个崩掉)。
 *   - 嵌入图表:sheetCharts 自己解析 drawing/chart XML + SVG 简绘,
 *     数据按引用回表取(经同一套解引用)。
 * 两库都在渲染进程动态 import(不进聊天首屏 bundle);解析是同步 CPU
 * 活,放 main 会卡所有窗口的 IPC,放这里最多卡本 tab 一两百毫秒。
 *
 * 交互层:
 *   - 缩放:顶栏 −/+ 控件 + ⌘/Ctrl+滚轮(触控板捏合即 ctrl+wheel)。
 *     用 CSS zoom(参与布局,sticky/滚动范围都正确)。丝滑关键:所有
 *     浮层(选区框/图表)都住在 zoom 容器【内部】、存【布局坐标】,
 *     缩放时浏览器一次 relayout 全搞定,零 JS 重测;wheel 按 rAF 合帧。
 *   - 框选问 AI:数据格拖矩形、行号/列头点选或拖选整行整列、左上角
 *     交叉格全选;松手弹浮动问答条(选区 TSV + 范围标注 + 文件路径
 *     经 dispatchChatTurn 发进当前会话)。表格本体是 memo 组件,拖选
 *     只重渲染浮层。
 *   - 行高列宽:行号下缘/列头右缘的 resize 手柄拖拽调整。拖拽全程
 *     直写 DOM(col/tr 的 style),松手才 setState 定稿——React 一次
 *     diff,拖拽零渲染。
 *   - 空白网格:数据范围外补空白行列(像 Excel 一样铺满),框选/行列
 *     选择在空白区照常可用。
 */

/** 渲染上限:超过就截断 + 顶部提示条。1500×80 已远超「看一眼数据长什么
 *  样」的需要;真要全量操作该去系统应用(顶栏常驻入口)。 */
const MAX_ROWS = 1500
const MAX_COLS = 80
/** 数据区外的空白网格:至少铺到这个规模,且给数据留出余量。 */
const MIN_GRID_ROWS = 60
const MIN_GRID_COLS = 20
const GRID_ROW_PAD = 12
const GRID_COL_PAD = 6
/** 发送给 AI 的选区行数上限(整列选择可能是上千行,别撑爆上下文)。 */
const MAX_SEND_ROWS = 300

const ZOOM_MIN = 0.25
const ZOOM_MAX = 4
/** 行号列宽(px,未缩放)。 */
const ROW_NO_COL_W = 44
/** 无列宽信息时的默认列宽(仅 fixed 布局参与总宽计算)。 */
const DEFAULT_COL_W = 64

/** 单元格显示样式(从 exceljs 提取,已换算成 CSS 可直接消费的值)。
 *  只对真的带样式的格子建对象,其余 null。 */
type CellStyle = {
  bg?: string
  color?: string
  bold?: boolean
  italic?: boolean
  align?: 'left' | 'center' | 'right'
  /** pt(Excel 原生单位),渲染时按 4/3 换算 px。 */
  fontSize?: number
  /** Excel Table 表头的筛选下拉箭头装饰(autoFilter)。 */
  filter?: boolean
  /** 自定义边框色(#rrggbb,thin/medium 一律画 1px)。bottom/right 画
   *  真 border;top/left 渲染时仅在相邻格没画对应边时以 inset shadow 补
   *  (否则相邻双线叠成 2px)。 */
  bB?: string
  bR?: string
  bT?: string
  bL?: string
  /** 条件格式数据条:色 + 0-100 填充百分比(背景渐变渲染)。 */
  bar?: { color: string; pct: number }
}

/** 合并单元格(0-based、相对显示矩阵、已按截断 clamp)。 */
type MergeSpec = { r: number; c: number; rowSpan: number; colSpan: number }

type ParsedSheet = {
  name: string
  /** 截断后的显示矩阵(全部为格式化字符串,空洞已补 '')。 */
  rows: string[][]
  totalRows: number
  totalCols: number
  /** 与 rows 同形的稀疏样式矩阵;非 xlsx 或 exceljs 解析失败时 null。 */
  styles: (CellStyle | null)[][] | null
  merges: MergeSpec[]
  /** 每列 px 宽;文件没写的列为 null。整体 null = 文件无列宽信息
   *  (csv),表格退回 auto 布局。 */
  colWidths: (number | null)[] | null
  /** 每行 px 高(对应截断后的 rows);null = 默认行高。 */
  rowHeights: (number | null)[] | null
  /** 本 sheet 的嵌入图表(仅 xlsx;解析失败为空数组)。 */
  charts: ChartSpec[]
}

type ParseState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; sheets: ParsedSheet[] }

type CellPos = { r: number; c: number }
/** 选区来源:数据格框选 / 行号整行 / 列头整列 / 交叉格全选。浮动问答
 *  条只对 cell 框选出现——行列头的点选是「看一眼范围」的轻量动作,
 *  弹输入框读作打扰(2026-07-08 用户反馈)。 */
type SelMode = 'cell' | 'row' | 'col' | 'all'
/** 归一化选区(含端点,已按 merge 扩展)。 */
type SelRange = { r1: number; c1: number; r2: number; c2: number }
/** 选区矩形——zoom 容器内的【布局坐标】(getBoundingClientRect 差值
 *  ÷ 当前 zoom)。浮层住在 zoom 容器里直接消费,缩放时随 CSS zoom 整体
 *  缩放、零重测;仅 zoom 外的问答条在渲染时乘 zoom 换回视觉坐标。 */
type SelRect = { left: number; top: number; width: number; height: number }

/** 0 → A, 25 → Z, 26 → AA … Excel 列字母,预览表头与范围标注用。 */
function colLetter(i: number): string {
  let s = ''
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s
  }
  return s
}

/** 数字观感启发式:纯数值/千分位/百分比/货币尾缀 → 右对齐(财务表格的
 *  阅读习惯)。文件自带 alignment 时以文件为准,这里只兜没写对齐的格子。 */
const NUMERIC_RE = /^-?[$¥€£]?[\d,]+(?:\.\d+)?%?$/

/** Office 默认主题色板(lt1 dk1 lt2 dk2 accent1-6)。exceljs 不解析
 *  theme XML,theme 索引色只能按默认主题近似。 */
const EXCEL_THEME = [
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
function applyTint(hex: string, tint: number): string {
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

/** exceljs 颜色对象 → CSS 色。
 *  ⚠️ argb 的 alpha 通道必须忽略:openpyxl 写的颜色一律 '00RRGGBB'
 *  (alpha=00),Excel 语义里它是不透明色——按标准 ARGB 解释会把整个
 *  文件的底色全解析成全透明。Excel 本就不支持单元格透明色。 */
function excelColorToCss(color: unknown): string | null {
  if (!color || typeof color !== 'object') return null
  const c = color as { argb?: string; theme?: number; tint?: number }
  if (typeof c.argb === 'string') {
    if (c.argb.length === 8) return '#' + c.argb.slice(2)
    if (c.argb.length === 6) return '#' + c.argb
    return null
  }
  if (typeof c.theme === 'number') {
    const base = EXCEL_THEME[c.theme]
    if (!base) return null
    return applyTint(base, typeof c.tint === 'number' ? c.tint : 0)
  }
  return null
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
 * 预览对这三样全都自渲染(图表 sheetCharts、套表样式 parseSheetTables、
 * 批注不渲染),exceljs 只需要出 cell 级样式(fill/font/alignment)——
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

/**
 * 表格本体(colgroup + 列字母表头 + 数据行 + 空白网格)。memo 隔离是
 * 交互性能的前提:拖选/拖宽过程中父组件的浮层 state 高频变化,而本组
 * 件的 props 全部引用稳定(仅 resize 定稿时变一次),十万级 td 的
 * diff 一次都不会跑。
 *
 * ⚠️ 表格画布是【固定浅色皮肤】,刻意不吃主题 token:格子底/网格线/
 * 行号列头全部写死浅色——文件自带样式(浅色 fill/边框/深字)是绝对
 * 色,底层 token 一随暗档翻深就混成花斑(2026-07-08 用户实拍)。语义
 * 上这块是「文件的纸面」,同 PDF 预览的白纸不随主题;别拿「chat 面板
 * 禁写死 bg-white」的教训来修正它——那条针对的是应用 UI 面,这里是
 * 内容画布。面板顶栏/tab 条/问答条等 UI 照常主题化。
 *
 * data 坐标契约(框选/行列选择/选区测量/resize 都靠它,别拆):
 *   - 列字母 th 带 data-c(每列必有,无合并——选区横向测量的锚)
 *   - 数据行 tr 带 data-r(每行必有——纵向测量的锚)
 *   - 数据/空白 td 带 data-r/data-c(命中判定;merge 只有左上格有 td)
 *   - 行号 td 带 data-rowhead(整行选择入口;它也在 tr[data-r] 里)
 *   - 左上交叉格 th 带 data-allhead(全选入口)
 *   - resize 手柄带 data-resize="col:N" / "row:N"(拖宽拖高入口,
 *     命中它时不进入框选)
 *   - colgroup col 带 data-ci(拖宽时直写 style.width 的目标)
 */
const SheetTable = memo(function SheetTable({
  sheet,
  spanMap,
  skipSet,
  gridRows,
  gridCols,
  colWidths,
  rowHeights,
  tableWidth
}: {
  sheet: ParsedSheet
  spanMap: Map<string, MergeSpec>
  skipSet: Set<string>
  gridRows: number
  gridCols: number
  /** 合成后(文件列宽 + 用户覆盖)的每列宽;null 元素 = 未指定。 */
  colWidths: (number | null)[]
  rowHeights: (number | null)[]
  tableWidth: number | undefined
}): React.JSX.Element {
  const fixed = tableWidth !== undefined
  const gridIdx = Array.from({ length: gridCols }, (_, i) => i)
  return (
    // border-separate + spacing-0:sticky 表头/行号列需要各 cell 自带
    // 边框(collapse 模式下 sticky 单元格滚动时边框会被留在原地)。
    <table
      style={fixed ? { width: tableWidth, tableLayout: 'fixed' } : undefined}
      className="border-separate border-spacing-0 text-[12px] leading-[1.5]"
    >
      <colgroup>
        <col style={{ width: ROW_NO_COL_W }} />
        {gridIdx.map((i) => (
          <col
            key={i}
            data-ci={i}
            style={{
              width: colWidths[i] ?? (fixed ? DEFAULT_COL_W : undefined)
            }}
          />
        ))}
      </colgroup>
      <thead>
        <tr>
          {/* 左上角交叉格:双向 sticky,z 最高;点击全选。 */}
          <th
            data-allhead
            className="sticky left-0 top-0 z-[3] min-w-10 cursor-pointer border-b border-r border-[#d9dde3] bg-[#f3f4f6] px-2 py-1 hover:bg-[#e9ecef]"
          />
          {gridIdx.map((c) => (
            <th
              key={c}
              data-c={c}
              className="group/colhead relative sticky top-0 z-[2] cursor-pointer border-b border-r border-[#d9dde3] bg-[#f3f4f6] px-2 py-1 text-center text-[11px] font-medium text-[#5f6672] hover:bg-[#e9ecef]"
            >
              {colLetter(c)}
              {/* 列宽 resize 手柄:贴右缘 5px(不伸出——伸出部分会被
                  下一个同 z 的 sticky 列头盖住点不到),hover 亮一条竖线。 */}
              <span
                data-resize={`col:${c}`}
                className="absolute right-0 top-0 z-[1] h-full w-[5px] cursor-col-resize hover:bg-accent/50"
              />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: gridRows }, (_, r) => {
          const row = sheet.rows[r]
          return (
            <tr
              key={r}
              data-r={r}
              className="group/row"
              style={rowHeights[r] != null ? { height: rowHeights[r]! } : undefined}
            >
              <td
                data-rowhead={r}
                className="group/rowhead relative sticky left-0 z-[1] cursor-pointer border-b border-r border-[#d9dde3] bg-[#f3f4f6] px-2 py-1 text-right text-[11px] tabular-nums text-[#5f6672] hover:bg-[#e9ecef]"
              >
                {r + 1}
                {/* 行高 resize 手柄:贴下缘 5px(同列手柄,不伸出)。 */}
                <span
                  data-resize={`row:${r}`}
                  className="absolute bottom-0 left-0 z-[1] h-[5px] w-full cursor-row-resize hover:bg-accent/50"
                />
              </td>
              {gridIdx.map((c) => {
                const key = r + ':' + c
                if (skipSet.has(key)) return null
                const span = spanMap.get(key)
                const cell = row?.[c] ?? ''
                const st = sheet.styles?.[r]?.[c] ?? null
                // 有底色没字色的格子按「浅底深字」假设钉深字——文件
                // 样式是浅色设计,暗档下面板的默认白字会糊在浅底上。
                const color = st?.color ?? (st?.bg ? '#1f2328' : undefined)
                const numeric = cell !== '' && NUMERIC_RE.test(cell)
                const align = st?.align ?? (numeric ? 'right' : 'left')
                // 自定义边框:bottom/right 画真 border(压过默认网格
                // 线);top/left 只在相邻格没画对应边时用 inset shadow
                // 补——两边都画会叠成 2px 双线。
                const insets: string[] = []
                if (st?.bT && !sheet.styles?.[r - 1]?.[c]?.bB) {
                  insets.push(`inset 0 1px 0 ${st.bT}`)
                }
                if (st?.bL && !sheet.styles?.[r]?.[c - 1]?.bR) {
                  insets.push(`inset 1px 0 0 ${st.bL}`)
                }
                return (
                  <td
                    key={c}
                    data-r={r}
                    data-c={c}
                    rowSpan={span?.rowSpan}
                    colSpan={span?.colSpan}
                    title={cell.length > 40 ? cell : undefined}
                    style={{
                      textAlign: align,
                      backgroundColor: st?.bg,
                      // 条件格式数据条:背景渐变画填充段,叠在底色之上。
                      backgroundImage: st?.bar
                        ? `linear-gradient(to right, ${st.bar.color}55 ${st.bar.pct}%, transparent ${st.bar.pct}%)`
                        : undefined,
                      color,
                      fontWeight: st?.bold ? 600 : undefined,
                      fontStyle: st?.italic ? 'italic' : undefined,
                      borderBottom: st?.bB ? `1px solid ${st.bB}` : undefined,
                      borderRight: st?.bR ? `1px solid ${st.bR}` : undefined,
                      boxShadow: insets.length ? insets.join(', ') : undefined,
                      // pt → px 精确换算(96dpi/72pt)。默认 11pt 走
                      // class 的 12px 阅读档,只有偏离默认才按真实字号。
                      fontSize: st?.fontSize
                        ? `${Math.round((st.fontSize * 4) / 3)}px`
                        : undefined
                    }}
                    className={
                      'max-w-[320px] truncate whitespace-nowrap border-b border-r border-[#e5e8ec] px-2 py-1 ' +
                      (st?.bg
                        ? ''
                        : 'bg-white text-[#24292f] group-hover/row:bg-[#f3f6fa] ') +
                      (numeric ? 'tabular-nums ' : '') +
                      (st?.filter ? 'relative pr-5' : '')
                    }
                  >
                    {cell}
                    {/* Excel Table 表头的筛选下拉箭头(装饰,不可交互
                        ——预览不做真筛选)。 */}
                    {st?.filter && (
                      <span
                        aria-hidden
                        className="absolute right-0.5 top-1/2 grid size-3.5 -translate-y-1/2 place-items-center rounded-[3px] bg-white/25 text-[7px] leading-none"
                      >
                        ▼
                      </span>
                    )}
                  </td>
                )
              })}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
})

export function SpreadsheetPreviewPanel(): React.JSX.Element | null {
  const t = useT()
  const path = useSheetPreviewStore((s) => s.path)
  const closePreview = useSheetPreviewStore((s) => s.closePreview)
  const sessionId = useChatStore((s) => s.sessionId)
  const streaming = useChatStore((s) => s.streaming)
  const [state, setState] = useState<ParseState>({ phase: 'loading' })
  const [activeSheet, setActiveSheet] = useState(0)
  const [zoom, setZoom] = useState(1)
  // 盘上文件变更检测:读文件时记 mtime/size 基准,打开期间轮询对比,
  // 变了浮「刷新」提示条;点刷新 bump reloadTick 重新解析(zoom/当前
  // sheet/行高列宽都保留,别把用户看到一半的状态抖掉)。
  const [stale, setStale] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const stampRef = useRef<{ m: number; s: number } | null>(null)
  /** 用户点 ✕ 忽略的那个版本——同版本不再弹,文件再变(新 mtime)照弹。 */
  const dismissedRef = useRef<{ m: number; s: number } | null>(null)
  // 用户拖出来的行高/列宽覆盖(布局 px,按当前 sheet 生效,切 sheet 清)。
  const [colOverrides, setColOverrides] = useState<Record<number, number>>({})
  const [rowOverrides, setRowOverrides] = useState<Record<number, number>>({})
  // 框选:拖动中(ref,不驱动渲染)、选区矩形(布局坐标,驱动 zoom 容器
  // 内的选区框)、定稿选区(驱动浮动问答条)。
  const dragRef = useRef<{ anchor: CellPos; head: CellPos; mode: SelMode } | null>(null)
  const [selRect, setSelRect] = useState<SelRect | null>(null)
  const [selection, setSelection] = useState<(SelRange & { mode: SelMode }) | null>(null)
  const [askText, setAskText] = useState('')
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /** zoom 容器(table 直接父级)——选区测量的 querySelector 范围 +
   *  浮层(选区框/图表)的定位父。 */
  const tableWrapRef = useRef<HTMLDivElement | null>(null)
  /** 内容层(zoom 容器 + 问答条的公共父)——缩放手势中的 transform
   *  直写目标(见 wheel handler)。 */
  const contentRef = useRef<HTMLDivElement | null>(null)
  /** zoom 的同步镜像:wheel/autoscroll 的原生 handler 闭包跨 render
   *  存活,读 state 会 stale。 */
  const zoomRef = useRef(1)
  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  // 换文件才回第一个 sheet;点「刷新」重载(reloadTick)保持当前 sheet。
  useEffect(() => {
    setActiveSheet(0)
  }, [path])

  useEffect(() => {
    if (path === null) return
    let cancelled = false
    setState({ phase: 'loading' })
    setStale(false)
    dismissedRef.current = null
    const ext = path.includes('.') ? path.split('.').pop()!.toLowerCase() : ''
    ;(async () => {
      const res = await window.chatApi.readSheetFile({ absPath: path })
      if (cancelled) return
      if (!res.ok || !res.data) {
        setState({ phase: 'error', message: res.error ?? 'read failed' })
        return
      }
      stampRef.current =
        res.mtimeMs !== undefined
          ? { m: res.mtimeMs, s: res.size ?? 0 }
          : null
      // 双库分工见文件头注释。exceljs 仅 xlsx 才拉起(csv/xls 用不上,
      // 省一次 ~1MB chunk 加载)。
      const [XLSX, excelMod] = await Promise.all([
        import('xlsx'),
        ext === 'xlsx' ? import('exceljs') : Promise.resolve(null)
      ])
      if (cancelled) return
      // dense: 大表下 cell 走数组而非对象字典,解析+遍历都快一截。
      // cellStyles: CE 版借它填 !cols/!rows(列宽行高)与 s.fgColor
      // (fill 兜底);字体/对齐它不给。
      const wb = XLSX.read(res.data, {
        type: 'base64',
        dense: true,
        cellStyles: true
      })

      const denseOf = (name: string): DenseCell[][] | undefined =>
        (wb.Sheets[name] as { '!data'?: DenseCell[][] } | undefined)?.['!data']

      // 轻量公式求值。openpyxl 不写公式缓存值(Excel 打开后才回填),
      // 公式格在 SheetJS 里是 t:'z' 的 stub——不求值整页数字全空(实测
      // hospital 看板、员工示例的「年薪=E4*12」)。覆盖 AI 报表的常见
      // 形态:cell 引用(跨表/同表)、四则、括号、一元负号、
      // SUM/AVERAGE/COUNT/MAX/MIN(range 或参数列表)。IF/文本连接等
      // 一律放弃(返回 undefined,格子显示空)——预览不做完整公式引擎,
      // 循环引用由 depth 上限兜底。
      type FTok =
        | { k: 'ref'; sheet: string | null; a: string; b: string | null }
        | { k: 'num'; v: number }
        | { k: 'fn'; name: string }
        | { k: 'op'; op: string }
      const FTOK_RE =
        /(?:(?:'([^']+)'|([A-Za-z_一-鿿][\w.一-鿿]*))!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?|([A-Za-z]+)(?=\()|(\d+(?:\.\d+)?)|([+\-*/(),])|(\s+)/y
      const tokenizeFormula = (src: string): FTok[] | null => {
        const out: FTok[] = []
        FTOK_RE.lastIndex = 0
        while (FTOK_RE.lastIndex < src.length) {
          const m = FTOK_RE.exec(src)
          if (!m) return null // 认不出的字符(&、"、比较符…)→ 放弃
          if (m[8] !== undefined) continue // 空白
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
        }
        return out
      }

      const resolveValue = (
        sheetName: string,
        cell: DenseCell | undefined,
        depth = 0
      ): { v: unknown; w?: string; z?: string } => {
        if (!cell) return { v: undefined }
        // t:'z' 是 stub,其 v 不可信;其余类型直接用真值。
        if (cell.t !== 'z') return { v: cell.v, w: cell.w, z: cell.z }
        if (!cell.f || depth > 8) return { v: undefined }
        return { v: evalFormula(cell.f, sheetName, depth), z: cell.z }
      }

      /** ref 单格取值(数字/字符串;经 resolveValue 递归求值)。 */
      const refValue = (sheet: string, a1: string, depth: number): unknown => {
        let addr: ReturnType<typeof XLSX.utils.decode_cell>
        try {
          addr = XLSX.utils.decode_cell(a1)
        } catch {
          return undefined
        }
        return resolveValue(sheet, denseOf(sheet)?.[addr.r]?.[addr.c], depth + 1).v
      }

      /** range 内非空格计数——COUNTA 用(文本也算)。 */
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
            const v = resolveValue(sheet, denseOf(sheet)?.[r]?.[c], depth + 1).v
            if (v !== undefined && v !== null && v !== '') n++
          }
        }
        return n
      }

      /** range 内全部数值(非数值格跳过)——聚合函数用。 */
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
            const v = resolveValue(sheet, denseOf(sheet)?.[r]?.[c], depth + 1).v
            if (typeof v === 'number') out.push(v)
          }
        }
        return out
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
            const nums: number[] = []
            if (!isOp(')')) {
              for (;;) {
                const arg = peek()
                if (arg?.k === 'ref' && arg.b) {
                  i++
                  // COUNTA 数「非空格」(含文本),其余聚合只吃数值。
                  if (t.name === 'COUNTA') {
                    nums.push(rangeCountA(arg.sheet ?? sheetName, arg.a, arg.b, depth))
                  } else {
                    nums.push(...rangeNums(arg.sheet ?? sheetName, arg.a, arg.b, depth))
                  }
                } else {
                  nums.push(num(expr()))
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

      // 显示文本:数字按【查看格自己的数字格式】(¥/% 等)经 SSF 格式
      // 化——引用格的格式常与源不同(源存 0.518,看板格标 0.0%);
      // 查看格无格式再退源格式、再退 w/原值。
      const displayOf = (sheetName: string, cell: DenseCell | undefined): string => {
        if (!cell) return ''
        const eff = resolveValue(sheetName, cell)
        if (eff.v === undefined || eff.v === null) return ''
        if (typeof eff.v === 'number') {
          const fmt =
            cell.z && cell.z !== 'General'
              ? cell.z
              : eff.z && eff.z !== 'General'
                ? eff.z
                : null
          if (fmt) {
            try {
              return XLSX.SSF.format(fmt, eff.v)
            } catch {
              /* 罕见格式串,退原值 */
            }
          }
          return eff.w ?? String(eff.v)
        }
        return eff.w ?? String(eff.v)
      }

      // exceljs 二次解析同一份字节,只为样式(字体/对齐/填充)。喂之前
      // 一律剥掉批注与图表引用(见 stripForExceljs);任何失败都静默降
      // 级——样式是增强,值才是底线。
      const bin = atob(res.data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      let wb2: import('exceljs').Workbook | null = null
      if (excelMod) {
        try {
          const workbook = new excelMod.Workbook()
          await workbook.xlsx.load(
            (await stripForExceljs(bytes)).buffer as ArrayBuffer
          )
          wb2 = workbook
        } catch {
          wb2 = null
        }
      }
      if (cancelled) return

      // 嵌入图表(仅 xlsx):自己解析 drawing/chart XML,数据按引用回
      // 表取(经 resolveValue,看板图表引用的格子本身就是引用公式)。
      let chartsBySheet = new Map<string, ChartSpec[]>()
      if (excelMod) {
        try {
          chartsBySheet = await parseSheetCharts(bytes, (sheetName, rangeA1) => {
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
                const eff = resolveValue(sheetName, dense[r]?.[c])
                out.push(
                  typeof eff.v === 'number' || typeof eff.v === 'string'
                    ? eff.v
                    : null
                )
              }
            }
            return out
          })
        } catch {
          chartsBySheet = new Map()
        }
      }
      if (cancelled) return

      // Excel Table(套用表格格式)的内置样式:深蓝表头/斑马纹这类观感
      // 不在单元格 fill 里,exceljs 拿不到——读 xl/tables/*.xml 自己映射
      // (见 sheetCharts.parseSheetTables)。
      let tablesBySheet = new Map<string, import('./sheetCharts').SheetTableStyle[]>()
      if (excelMod) {
        try {
          tablesBySheet = await parseSheetTables(bytes)
        } catch {
          tablesBySheet = new Map()
        }
      }
      // 条件格式(dataBar / cellIs):SheetJS/exceljs 都不吐,自己解析
      // (见 sheetCharts.parseSheetCondFmts)。
      let condFmtBySheet = new Map<string, import('./sheetCharts').CondRule[]>()
      if (excelMod) {
        try {
          condFmtBySheet = await parseSheetCondFmts(bytes)
        } catch {
          condFmtBySheet = new Map()
        }
      }
      if (cancelled) return

      const sheets: ParsedSheet[] = wb.SheetNames.map((name) => {
        const ws = wb.Sheets[name]
        const denseData = denseOf(name) ?? []
        // 显示矩阵按绝对坐标铺(A1 原点)——!ref 起点非 A1 时前部留
        // 空,与 Excel 打开的观感一致;merges/!cols/!rows/exceljs 全是
        // 绝对坐标,零偏移换算。
        const range = ws?.['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null
        const totalRows = range ? range.e.r + 1 : 0
        const totalCols = range ? range.e.c + 1 : 0
        const rowCount = Math.min(totalRows, MAX_ROWS)
        const colCount = Math.min(totalCols, MAX_COLS)
        const rows: string[][] = []
        for (let r = 0; r < rowCount; r++) {
          const drow = denseData[r]
          const out = new Array<string>(colCount)
          for (let c = 0; c < colCount; c++) out[c] = displayOf(name, drow?.[c])
          rows.push(out)
        }

        const merges: MergeSpec[] = (ws?.['!merges'] ?? []).flatMap((m) => {
          const r = m.s.r
          const c = m.s.c
          if (r < 0 || c < 0 || r >= rowCount || c >= colCount) return []
          const rowSpan = Math.min(m.e.r, rowCount - 1) - r + 1
          const colSpan = Math.min(m.e.c, colCount - 1) - c + 1
          if (rowSpan <= 1 && colSpan <= 1) return []
          return [{ r, c, rowSpan, colSpan }]
        })

        // 列宽:Excel 字符宽 → px(MDW≈7px/字符,近似换算,预览不追像素)。
        const colsInfo = ws?.['!cols']
        let colWidths: (number | null)[] | null = null
        if (colsInfo) {
          colWidths = Array.from({ length: colCount }, (_, i) => {
            const ci = colsInfo[i]
            if (!ci) return null
            if (ci.hidden) return 8
            if (typeof ci.wpx === 'number') return Math.round(ci.wpx)
            const wch = ci.wch ?? ci.width
            return typeof wch === 'number' ? Math.round((wch + 0.71) * 7) : null
          })
          if (colWidths.every((w) => w === null)) colWidths = null
        }

        const rowsInfo = ws?.['!rows']
        const rowHeights = rowsInfo
          ? rows.map((_, i) => {
              const h = rowsInfo[i]?.hpx
              return typeof h === 'number' ? Math.round(h) : null
            })
          : null

        // 色彩样式(exceljs,仅 xlsx)。稀疏矩阵:没样式的格子留 null。
        let styles: (CellStyle | null)[][] | null = null
        const ws2 = wb2?.getWorksheet(name)
        if (ws2) {
          const styleRows: (CellStyle | null)[][] = rows.map(
            (r) => new Array<CellStyle | null>(r.length).fill(null)
          )
          ws2.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            const r = rowNumber - 1
            if (r < 0 || r >= styleRows.length) return
            row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
              const c = colNumber - 1
              if (c < 0 || c >= colCount) return
              const st: CellStyle = {}
              const fill = cell.fill
              if (
                fill &&
                fill.type === 'pattern' &&
                fill.pattern !== 'none' &&
                fill.fgColor
              ) {
                const bg = excelColorToCss(fill.fgColor)
                if (bg) st.bg = bg
              }
              const font = cell.font
              if (font) {
                if (font.bold) st.bold = true
                if (font.italic) st.italic = true
                if (font.color) {
                  const fc = excelColorToCss(font.color)
                  if (fc) st.color = fc
                }
                if (typeof font.size === 'number' && font.size !== 11) {
                  st.fontSize = font.size
                }
              }
              const h = cell.alignment?.horizontal
              if (h === 'left' || h === 'center' || h === 'right') st.align = h
              const bd = cell.border
              if (bd) {
                const edge = (e: { style?: string; color?: unknown } | undefined): string | undefined =>
                  e?.style ? (excelColorToCss(e.color) ?? '#8a9099') : undefined
                const bB = edge(bd.bottom)
                const bR = edge(bd.right)
                const bT = edge(bd.top)
                const bL = edge(bd.left)
                if (bB) st.bB = bB
                if (bR) st.bR = bR
                if (bT) st.bT = bT
                if (bL) st.bL = bL
              }
              if (Object.keys(st).length > 0) styleRows[r][c] = st
            })
          })
          styles = styleRows
        }
        // exceljs 全崩时的 fill 兜底:SheetJS CE 在 cellStyles:true 下会
        // 给 s.fgColor(仅填充色,无字体/对齐)——有底色总比全素强。
        if (!styles) {
          let any = false
          const styleRows: (CellStyle | null)[][] = rows.map(
            (r) => new Array<CellStyle | null>(r.length).fill(null)
          )
          for (let r = 0; r < rowCount; r++) {
            for (let c = 0; c < colCount; c++) {
              const s = denseData[r]?.[c]?.s
              const rgb =
                s?.patternType === 'solid' ? s.fgColor?.rgb : undefined
              if (typeof rgb === 'string' && rgb.length >= 6) {
                styleRows[r]![c] = { bg: '#' + rgb.slice(-6) }
                any = true
              }
            }
          }
          if (any) styles = styleRows
        }

        // 条件格式应用(在 cell 级样式之上——Excel 里 cf 命中优先):
        // cellIs 数值比较命中 → 叠 dxf 的字色/底色;dataBar → 按范围内
        // 最大值算每格填充百分比,渲染层画背景渐变条。
        const cfs = condFmtBySheet.get(name) ?? []
        if (cfs.length > 0) {
          styles ??= rows.map(
            (r) => new Array<CellStyle | null>(r.length).fill(null)
          )
          const CMP: Record<string, (a: number, b: number) => boolean> = {
            lessThan: (a, b) => a < b,
            lessThanOrEqual: (a, b) => a <= b,
            greaterThan: (a, b) => a > b,
            greaterThanOrEqual: (a, b) => a >= b,
            equal: (a, b) => a === b,
            notEqual: (a, b) => a !== b
          }
          for (const rule of cfs) {
            for (const rangeStr of rule.sqref.split(/\s+/)) {
              let rng: ReturnType<typeof XLSX.utils.decode_range>
              try {
                rng = XLSX.utils.decode_range(rangeStr)
              } catch {
                continue
              }
              const rEnd = Math.min(rng.e.r, rowCount - 1)
              const cEnd = Math.min(rng.e.c, colCount - 1)
              const numAt = (r: number, c: number): number | null => {
                const v = resolveValue(name, denseData[r]?.[c]).v
                return typeof v === 'number' ? v : null
              }
              if (rule.kind === 'cellIs') {
                const cmp = CMP[rule.op]
                if (!cmp) continue
                for (let r = Math.max(0, rng.s.r); r <= rEnd; r++) {
                  for (let c = Math.max(0, rng.s.c); c <= cEnd; c++) {
                    const v = numAt(r, c)
                    if (v === null || !cmp(v, rule.value)) continue
                    const row = styles[r]!
                    const st = row[c] ?? (row[c] = {})
                    if (rule.bg) st.bg = rule.bg
                    if (rule.color) st.color = rule.color
                  }
                }
              } else {
                // dataBar:min 简化为 0(AI 报表的 cfvo 惯用 min=0),
                // 负值填充 0。
                let max = 0
                for (let r = Math.max(0, rng.s.r); r <= rEnd; r++) {
                  for (let c = Math.max(0, rng.s.c); c <= cEnd; c++) {
                    const v = numAt(r, c)
                    if (v !== null && v > max) max = v
                  }
                }
                if (max <= 0) continue
                for (let r = Math.max(0, rng.s.r); r <= rEnd; r++) {
                  for (let c = Math.max(0, rng.s.c); c <= cEnd; c++) {
                    const v = numAt(r, c)
                    if (v === null) continue
                    const row = styles[r]!
                    const st = row[c] ?? (row[c] = {})
                    st.bar = {
                      color: rule.color,
                      pct: Math.max(0, Math.min(100, (v / max) * 100))
                    }
                  }
                }
              }
            }
          }
        }

        // Excel Table 样式垫底:表头实底白字粗体 + 行条纹 + 筛选箭头。
        // 一律 ??=(只补缺失字段)——单元格自己的样式永远压过表格样式,
        // 与 Excel 的层叠顺序一致。
        const tbls = tablesBySheet.get(name) ?? []
        if (tbls.length > 0) {
          styles ??= rows.map(
            (r) => new Array<CellStyle | null>(r.length).fill(null)
          )
          for (const tb of tbls) {
            let rng: ReturnType<typeof XLSX.utils.decode_range>
            try {
              rng = XLSX.utils.decode_range(tb.ref)
            } catch {
              continue
            }
            const rEnd = Math.min(rng.e.r, rowCount - 1)
            const cEnd = Math.min(rng.e.c, colCount - 1)
            for (let r = Math.max(0, rng.s.r); r <= rEnd; r++) {
              const isHeader = tb.headerRow && r === rng.s.r
              const dataIdx = r - rng.s.r - (tb.headerRow ? 1 : 0)
              const stripe =
                !isHeader && tb.stripes && tb.stripeBg !== null && dataIdx % 2 === 1
              if (!isHeader && !stripe) continue
              for (let c = Math.max(0, rng.s.c); c <= cEnd; c++) {
                const row = styles[r]!
                const st = row[c] ?? (row[c] = {})
                if (isHeader) {
                  if (tb.headerBg) {
                    st.bg ??= tb.headerBg
                    st.color ??= tb.headerText
                  }
                  st.bold ??= true
                  if (tb.autoFilter) st.filter = true
                } else if (st.bg === undefined) {
                  st.bg = tb.stripeBg!
                }
              }
            }
          }
        }

        return {
          name,
          rows,
          totalRows,
          totalCols,
          styles,
          merges,
          colWidths,
          rowHeights,
          charts: chartsBySheet.get(name) ?? []
        }
      })
      setState({ phase: 'ready', sheets })
    })().catch((err: unknown) => {
      if (!cancelled) {
        setState({
          phase: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, reloadTick])

  // 盘上变更轮询:预览就绪期间每 3s stat 一次,mtime/size 偏离读取基准
  // 且不是已被忽略的版本 → 浮「刷新」提示条。
  useEffect(() => {
    if (path === null || state.phase !== 'ready') return
    const id = window.setInterval(() => {
      void window.chatApi.statSheetFile({ absPath: path }).then((r) => {
        if (!r.ok || r.mtimeMs === undefined) return
        const stamp = stampRef.current
        if (!stamp) return
        const changed = r.mtimeMs !== stamp.m || (r.size ?? 0) !== stamp.s
        if (!changed) return
        const dis = dismissedRef.current
        if (dis && dis.m === r.mtimeMs && dis.s === (r.size ?? 0)) return
        dismissedRef.current = null
        setStale(true)
      })
    }, 3000)
    return () => window.clearInterval(id)
  }, [path, state.phase])

  const sheets = state.phase === 'ready' ? state.sheets : []
  const sheet: ParsedSheet | undefined = sheets[activeSheet] ?? sheets[0]

  // 空白网格规模:数据之外再铺一片空行/空列(Excel 的「无限网格」观
  // 感的有限版),行列选择/框选在空白区照常可用。
  const dataRows = sheet?.rows.length ?? 0
  const dataCols = sheet ? Math.min(sheet.totalCols, MAX_COLS) : 0
  const gridRows = Math.min(MAX_ROWS, Math.max(dataRows + GRID_ROW_PAD, MIN_GRID_ROWS))
  const gridCols = Math.min(MAX_COLS, Math.max(dataCols + GRID_COL_PAD, MIN_GRID_COLS))

  // 合并单元格查找表:左上格 → span;被覆盖格 → skip(不渲染 td)。
  const { spanMap, skipSet } = useMemo(() => {
    const spanMap = new Map<string, MergeSpec>()
    const skipSet = new Set<string>()
    for (const m of sheet?.merges ?? []) {
      spanMap.set(m.r + ':' + m.c, m)
      for (let r = m.r; r < m.r + m.rowSpan; r++) {
        for (let c = m.c; c < m.c + m.colSpan; c++) {
          if (r !== m.r || c !== m.c) skipSet.add(r + ':' + c)
        }
      }
    }
    return { spanMap, skipSet }
  }, [sheet])

  // 文件列宽/行高 + 用户拖拽覆盖的合成(布局 px)。引用只在 sheet 或
  // 定稿的 overrides 变化时变——SheetTable 的 memo 依赖这一点。
  const effColWidths = useMemo(() => {
    return Array.from({ length: gridCols }, (_, i) =>
      colOverrides[i] ?? sheet?.colWidths?.[i] ?? null
    )
  }, [sheet, gridCols, colOverrides])
  const effRowHeights = useMemo(() => {
    return Array.from({ length: gridRows }, (_, i) =>
      rowOverrides[i] ?? sheet?.rowHeights?.[i] ?? null
    )
  }, [sheet, gridRows, rowOverrides])
  // 文件带列宽 → fixed 布局(显式总宽,窄容器横滚不压缩);csv → 恒
  // auto 布局按内容自适应(用户拖出的列宽在 auto 下作为 col 宽度提示
  // 生效——不因一次拖拽把整表突变成 fixed,否则其余列宽会集体跳变)。
  const tableWidth = sheet?.colWidths
    ? ROW_NO_COL_W + effColWidths.reduce<number>((s, w) => s + (w ?? DEFAULT_COL_W), 0)
    : undefined

  /* ── 框选 / 行列选择 ── */

  const clearSelection = (): void => {
    dragRef.current = null
    setSelRect(null)
    setSelection(null)
    setAskText('')
    setCopied(false)
  }

  // 切文件 / 切 sheet:选区坐标与行高列宽覆盖都只对当前矩阵有意义。
  // zoom 是阅读偏好,保留。
  useEffect(() => {
    clearSelection()
    setColOverrides({})
    setRowOverrides({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, activeSheet])

  /** anchor/head → 归一化矩形,并扩展到完整覆盖所有相交的合并格(Excel
   *  同款行为,迭代到不动点;merges 数量级很小,循环廉价)。 */
  const normalizeRange = (a: CellPos, b: CellPos): SelRange => {
    let r1 = Math.min(a.r, b.r)
    let c1 = Math.min(a.c, b.c)
    let r2 = Math.max(a.r, b.r)
    let c2 = Math.max(a.c, b.c)
    const merges = sheet?.merges ?? []
    for (let guard = 0; guard < 10; guard++) {
      let changed = false
      for (const m of merges) {
        const mr2 = m.r + m.rowSpan - 1
        const mc2 = m.c + m.colSpan - 1
        if (m.r > r2 || mr2 < r1 || m.c > c2 || mc2 < c1) continue
        if (m.r < r1) {
          r1 = m.r
          changed = true
        }
        if (m.c < c1) {
          c1 = m.c
          changed = true
        }
        if (mr2 > r2) {
          r2 = mr2
          changed = true
        }
        if (mc2 > c2) {
          c2 = mc2
          changed = true
        }
      }
      if (!changed) break
    }
    return { r1, c1, r2, c2 }
  }

  /** 选区 → zoom 容器内的布局坐标矩形。列用列字母 th(每列必有、无合
   *  并)、行用 tr 测量,完全不依赖具体数据 td(merge 覆盖区没有 td)。
   *  getBoundingClientRect 差值 ÷ 当前 zoom:滚动被相减消掉,除掉 zoom
   *  得布局 px——浮层住在 zoom 容器里,缩放时零重测。 */
  const measureRect = (range: SelRange): SelRect | null => {
    const wrap = tableWrapRef.current
    if (!wrap) return null
    const q = (sel: string): HTMLElement | null =>
      wrap.querySelector<HTMLElement>(sel)
    const thA = q(`th[data-c="${range.c1}"]`)
    const thB = q(`th[data-c="${range.c2}"]`)
    const trA = q(`tr[data-r="${range.r1}"]`)
    const trB = q(`tr[data-r="${range.r2}"]`)
    if (!thA || !thB || !trA || !trB) return null
    const base = wrap.getBoundingClientRect()
    const a = thA.getBoundingClientRect()
    const b = thB.getBoundingClientRect()
    const ra = trA.getBoundingClientRect()
    const rb = trB.getBoundingClientRect()
    return {
      left: (a.left - base.left) / zoom,
      top: (ra.top - base.top) / zoom,
      width: (b.right - a.left) / zoom,
      height: (rb.bottom - ra.top) / zoom
    }
  }

  /** 行高/列宽拖拽:mousedown 在 resize 手柄上启动,move 直写 DOM
   *  (col.style.width / tr.style.height,全程零 React 渲染),up 时
   *  setState 定稿一次。fixed 布局下同步改 table 总宽,否则改一列会
   *  挤压其它列。 */
  const startResize = (spec: string, startClientX: number, startClientY: number): void => {
    const wrap = tableWrapRef.current
    if (!wrap) return
    const [kind, idxStr] = spec.split(':')
    const index = Number(idxStr)
    if (!Number.isFinite(index)) return
    const table = wrap.querySelector<HTMLTableElement>('table')
    const z = zoom
    if (kind === 'col') {
      const colEl = wrap.querySelector<HTMLElement>(`col[data-ci="${index}"]`)
      const th = wrap.querySelector<HTMLElement>(`th[data-c="${index}"]`)
      if (!colEl || !th) return
      const startW = th.getBoundingClientRect().width / z
      const tableStartW = table?.style.width ? parseFloat(table.style.width) : null
      let lastW = startW
      const onMove = (ev: MouseEvent): void => {
        lastW = Math.max(24, Math.min(600, startW + (ev.clientX - startClientX) / z))
        colEl.style.width = `${Math.round(lastW)}px`
        if (table && tableStartW !== null) {
          table.style.width = `${Math.round(tableStartW + (lastW - startW))}px`
        }
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setColOverrides((prev) => ({ ...prev, [index]: Math.round(lastW) }))
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    } else {
      const trEl = wrap.querySelector<HTMLElement>(`tbody tr[data-r="${index}"]`)
      if (!trEl) return
      const startH = trEl.getBoundingClientRect().height / z
      let lastH = startH
      const onMove = (ev: MouseEvent): void => {
        lastH = Math.max(16, Math.min(400, startH + (ev.clientY - startClientY) / z))
        trEl.style.height = `${Math.round(lastH)}px`
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        setRowOverrides((prev) => ({ ...prev, [index]: Math.round(lastH) }))
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    }
  }

  const cellFromEvent = (e: React.MouseEvent): CellPos | null => {
    const td = (e.target as Element).closest('td[data-r][data-c]')
    if (!td) return null
    return {
      r: Number(td.getAttribute('data-r')),
      c: Number(td.getAttribute('data-c'))
    }
  }

  const applyDragRect = (drag: NonNullable<typeof dragRef.current>): void => {
    setSelRect(measureRect(normalizeRange(drag.anchor, drag.head)))
  }

  const onGridMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    const target = e.target as Element
    // 浮动问答条上的点击(输入/按钮)不碰选区。
    if (target.closest('[data-sheet-ask]')) return
    // resize 手柄:进入拖宽/拖高,不进入框选。
    const resizeSpec = target.closest('[data-resize]')?.getAttribute('data-resize')
    if (resizeSpec) {
      e.preventDefault()
      clearSelection()
      startResize(resizeSpec, e.clientX, e.clientY)
      return
    }
    clearSelection()
    // 行/列头与交叉格:整行/整列/全选。
    const colHead = target.closest('th[data-c]')
    const rowHead = target.closest('td[data-rowhead]')
    const allHead = target.closest('th[data-allhead]')
    if (allHead) {
      e.preventDefault()
      const range = { r1: 0, c1: 0, r2: gridRows - 1, c2: gridCols - 1 }
      setSelRect(measureRect(range))
      setSelection({ ...range, mode: 'all' })
      return
    }
    if (colHead) {
      e.preventDefault()
      const c = Number(colHead.getAttribute('data-c'))
      dragRef.current = { anchor: { r: 0, c }, head: { r: gridRows - 1, c }, mode: 'col' }
      applyDragRect(dragRef.current)
      startAutoScroll(e.clientX, e.clientY)
      return
    }
    if (rowHead) {
      e.preventDefault()
      const r = Number(rowHead.getAttribute('data-rowhead'))
      dragRef.current = { anchor: { r, c: 0 }, head: { r, c: gridCols - 1 }, mode: 'row' }
      applyDragRect(dragRef.current)
      startAutoScroll(e.clientX, e.clientY)
      return
    }
    const pos = cellFromEvent(e)
    if (!pos) return
    // 框选是数据格上的主交互,按下即接管——不 preventDefault 的话原生
    // 文本选择会跟拖选打架(复制诉求由问答条上的复制按钮承接)。
    e.preventDefault()
    dragRef.current = { anchor: pos, head: pos, mode: 'cell' }
    applyDragRect(dragRef.current)
    startAutoScroll(e.clientX, e.clientY)
  }

  /** 按命中元素扩展拖选 head——mouseover 与拖选自动滚动共用(后者的
   *  命中元素来自 elementFromPoint,不经事件)。 */
  const updateHeadFrom = (target: Element | null): void => {
    const drag = dragRef.current
    if (!drag || !target) return
    if (drag.mode === 'col') {
      // 划过列头或任何数据格都能扩展列范围(行恒全高)。
      const el = target.closest('[data-c]')
      if (!el) return
      const c = Number(el.getAttribute('data-c'))
      if (!Number.isFinite(c) || c === drag.head.c) return
      drag.head = { r: gridRows - 1, c }
      applyDragRect(drag)
      return
    }
    if (drag.mode === 'row') {
      const el = target.closest('[data-r], [data-rowhead]')
      if (!el) return
      const r = Number(el.getAttribute('data-r') ?? el.getAttribute('data-rowhead'))
      if (!Number.isFinite(r) || r === drag.head.r) return
      drag.head = { r, c: gridCols - 1 }
      applyDragRect(drag)
      return
    }
    const td = target.closest('td[data-r][data-c]')
    if (!td) return
    const pos = { r: Number(td.getAttribute('data-r')), c: Number(td.getAttribute('data-c')) }
    if (pos.r === drag.head.r && pos.c === drag.head.c) return
    drag.head = pos
    applyDragRect(drag)
  }

  const onGridMouseOver = (e: React.MouseEvent): void => {
    if (dragRef.current) updateHeadFrom(e.target as Element)
  }

  /**
   * 拖选边缘自动滚动:拖到滚动容器边缘(或拖出面板)时按溢出距离比例
   * 滚动,并用 elementFromPoint 反查此刻落点的格子继续扩选区——鼠标在
   * 容器外时 mouseover 不会再触发,不反查选区就停在边缘。mousedown 启
   * 动 rAF 循环,mouseup 自行清理。
   */
  const startAutoScroll = (startX: number, startY: number): void => {
    const pos = { x: startX, y: startY }
    let raf = 0
    const onMove = (ev: MouseEvent): void => {
      pos.x = ev.clientX
      pos.y = ev.clientY
    }
    const cleanup = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', cleanup)
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }
    const EDGE = 28
    const MAX_V = 32
    const step = (): void => {
      const sc = scrollRef.current
      if (!dragRef.current || !sc) {
        cleanup()
        return
      }
      const rect = sc.getBoundingClientRect()
      let dx = 0
      let dy = 0
      if (pos.x > rect.right - EDGE) dx = Math.min(MAX_V, (pos.x - rect.right + EDGE) * 0.4)
      else if (pos.x < rect.left + EDGE) dx = Math.max(-MAX_V, (pos.x - rect.left - EDGE) * 0.4)
      if (pos.y > rect.bottom - EDGE) dy = Math.min(MAX_V, (pos.y - rect.bottom + EDGE) * 0.4)
      else if (pos.y < rect.top + EDGE) dy = Math.max(-MAX_V, (pos.y - rect.top - EDGE) * 0.4)
      if (dx !== 0 || dy !== 0) {
        sc.scrollLeft += dx
        sc.scrollTop += dy
        // 反查落点:坐标 clamp 进视口内侧(避开 sticky 行号/列头带,
        // 落在上面 closest 不到数据格白滚一帧)。
        const z = zoomRef.current
        const cx = Math.min(
          Math.max(pos.x, rect.left + ROW_NO_COL_W * z + 6),
          rect.right - 8
        )
        const cy = Math.min(Math.max(pos.y, rect.top + 34 * z), rect.bottom - 8)
        updateHeadFrom(document.elementFromPoint(cx, cy))
      }
      raf = requestAnimationFrame(step)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', cleanup)
    raf = requestAnimationFrame(step)
  }

  // 松手定稿(挂 window:拖出面板外松手也要收口)+ Esc 清选区。
  useEffect(() => {
    const onUp = (): void => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      setSelection({ ...normalizeRange(drag.anchor, drag.head), mode: drag.mode })
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clearSelection()
    }
    window.addEventListener('mouseup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, gridRows, gridCols])

  // 行高列宽定稿后,选区矩形的布局坐标整体过期——布局落定后重测一次。
  // (zoom 变化【不】重测:浮层在 zoom 容器内,CSS 自己缩放。)
  useEffect(() => {
    if (selection) setSelRect(measureRect(selection))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colOverrides, rowOverrides])

  // 嵌入图表的锚点定位(布局坐标):sheet 就绪/行高列宽变化后测;zoom
  // 变化零重测(同上)。
  const [chartPos, setChartPos] = useState<({ left: number; top: number } | null)[]>([])
  useLayoutEffect(() => {
    const wrap = tableWrapRef.current
    const charts = sheet?.charts
    if (!wrap || !charts || charts.length === 0) {
      setChartPos([])
      return
    }
    const base = wrap.getBoundingClientRect()
    setChartPos(
      charts.map((ch) => {
        const th = wrap.querySelector<HTMLElement>(`th[data-c="${ch.fromC}"]`)
        const tr = wrap.querySelector<HTMLElement>(`tr[data-r="${ch.fromR}"]`)
        if (!th || !tr) return null
        return {
          left: (th.getBoundingClientRect().left - base.left) / zoom + ch.offX,
          top: (tr.getBoundingClientRect().top - base.top) / zoom + ch.offY
        }
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, state.phase, colOverrides, rowOverrides])

  /* ── 缩放 ── */

  const clampZoom = (z: number): number =>
    Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))

  // ⌘/Ctrl+滚轮缩放(触控板捏合在 Chromium 里就是 ctrl+wheel)。React 的
  // onWheel 挂在被动监听上、preventDefault 无效,必须原生非 passive 绑定。
  //
  // 丝滑关键——手势中不动真 zoom:CSS zoom 参与布局,大表逐帧改它 =
  // 逐帧全表 relayout,怎么合帧都糙。改为两段式:
  //   手势中:内容层直写 transform: scale(合成器级,纯 GPU 零重排),
  //           并以【鼠标位置为锚】同步换算 scroll,缩放围着指针进行;
  //   停手 140ms:一次性把累计倍率提交成真 zoom(单次 relayout),清
  //           transform——scroll 已在手势中按倍率换算到位,视觉无跳变。
  // 妥协:手势进行中 sticky 表头/行号会随内容缩放漂移(transform 祖先
  // 使 sticky 暂时失效),停手落定即恢复——比逐帧卡顿好得多。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let gesture: { scale: number; timer: number } | null = null
    const commit = (): void => {
      if (!gesture) return
      const g = gesture
      gesture = null
      if (contentRef.current) contentRef.current.style.transform = ''
      setZoom(clampZoom(zoomRef.current * g.scale))
    }
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const content = contentRef.current
      if (!content) return
      const g = gesture ?? { scale: 1, timer: 0 }
      gesture = g
      const prev = g.scale
      // 指数缩放:每 -100 deltaY ≈ ×4.5,捏合的小 delta 平滑连续。
      // (系数经用户多轮调快:0.0022 → 0.004 → 0.007 → 0.011 → 0.015;
      // 按钮步进独立,定格 1.25。)
      let next = prev * Math.exp(-e.deltaY * 0.015)
      // clamp 按总倍率(已提交 zoom × 手势倍率)收口到 25%–400%。
      next = clampZoom(zoomRef.current * next) / zoomRef.current
      if (next !== prev) {
        g.scale = next
        content.style.transformOrigin = '0 0'
        content.style.transform = `scale(${next})`
        // 鼠标锚:让指针下的内容点在缩放前后保持在指针下。
        const rect = el.getBoundingClientRect()
        const ax = e.clientX - rect.left
        const ay = e.clientY - rect.top
        const k = next / prev
        el.scrollLeft = (el.scrollLeft + ax) * k - ax
        el.scrollTop = (el.scrollTop + ay) * k - ay
      }
      window.clearTimeout(g.timer)
      g.timer = window.setTimeout(commit, 140)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (gesture) {
        window.clearTimeout(gesture.timer)
        commit()
      }
    }
  }, [state.phase])

  /* ── 选区 → AI / 剪贴板 ── */

  const selectionTsv = (maxRows?: number): string => {
    if (!selection || !sheet) return ''
    const rEnd = maxRows
      ? Math.min(selection.r2 + 1, selection.r1 + maxRows)
      : selection.r2 + 1
    return sheet.rows
      .slice(selection.r1, rEnd)
      .map((row) => row.slice(selection.c1, selection.c2 + 1).join('\t'))
      .join('\n')
  }

  // 范围标注:整行/整列用 Excel 的「3:5」「B:D」形态,其余 A1:B2。
  const rangeLabel = useMemo(() => {
    if (!selection) return ''
    const fullRows = selection.r1 === 0 && selection.r2 === gridRows - 1
    const fullCols = selection.c1 === 0 && selection.c2 === gridCols - 1
    if (fullRows && !fullCols) return `${colLetter(selection.c1)}:${colLetter(selection.c2)}`
    if (fullCols && !fullRows) return `${selection.r1 + 1}:${selection.r2 + 1}`
    return `${colLetter(selection.c1)}${selection.r1 + 1}:${colLetter(selection.c2)}${selection.r2 + 1}`
  }, [selection, gridRows, gridCols])

  const copySelection = (): void => {
    const tsv = selectionTsv()
    if (!tsv) return
    void navigator.clipboard.writeText(tsv).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  const askAI = async (): Promise<void> => {
    const q = askText.trim()
    if (!q || streaming || !sessionId || !selection || !sheet || !path) return
    // 截断标注按【实际有数据的行数】判断——整列选择的 r2 落在空白网格
    // 区,按选区行数判会对着 40 行数据谎报「仅附前 300 行」。
    const effRows =
      Math.min(selection.r2 + 1, sheet.rows.length) - selection.r1
    const truncated = effRows > MAX_SEND_ROWS
    const tsv = selectionTsv(MAX_SEND_ROWS)
    const fname = path.split('/').pop() ?? path
    // 首行协议标记:UserMessage 识别后把这条消息渲染成结构化卡片
    // (文件名/范围/问题)。CLI 文本与气泡 display 都带——transcript
    // 存的是 CLI 侧文本,历史恢复同样卡片化。
    const meta: SheetSelectionMeta = {
      name: fname,
      path,
      sheet: sheet.name,
      range: rangeLabel,
      q
    }
    const marker = SHEET_SELECTION_MARKER + JSON.stringify(meta)
    // 完整上下文给 AI(含文件路径——AI 可用工具读原文件做进一步分析);
    // 气泡侧由卡片渲染,不会把 TSV 糊出来。
    const text =
      `${marker}\n我正在查看表格文件 ${path} 的工作表「${sheet.name}」,选中了 ${rangeLabel} 区域,内容如下(制表符分隔,首行行号 ${selection.r1 + 1}${truncated ? `,数据较多仅附前 ${MAX_SEND_ROWS} 行` : ''}):\n\n` +
      '```\n' +
      tsv +
      '\n```\n\n' +
      q
    const display = `${marker}\n${q}`
    clearSelection()
    await dispatchChatTurn({
      sessionId,
      storeContent: [{ type: 'text', text: display }],
      logTag: '[sheet-preview]',
      payload: { sessionId, text }
    })
  }

  if (path === null) return null
  const fileName = path.split('/').pop() ?? path

  const refreshPreview = (): void => {
    setStale(false)
    setReloadTick((t) => t + 1)
  }
  const dismissStale = (): void => {
    setStale(false)
    // 记住被忽略的盘上版本:同版本不再弹,文件再变照弹。
    void window.chatApi.statSheetFile({ absPath: path }).then((r) => {
      if (r.ok && r.mtimeMs !== undefined) {
        dismissedRef.current = { m: r.mtimeMs, s: r.size ?? 0 }
      }
    })
  }

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[4px] bg-card">
      {/* 盘上文件变更提示条:悬浮在顶栏下方,点击重新解析(保留 zoom/
          当前 sheet/行高列宽),✕ 忽略本次变更。 */}
      {stale && (
        <div className="pointer-events-none absolute inset-x-0 top-[54px] z-30 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-foreground py-1 pl-3 pr-1 text-background shadow-[0_8px_24px_-6px_rgba(0,0,0,0.4)]">
            <button
              type="button"
              onClick={refreshPreview}
              className="flex items-center gap-1.5 text-[12.5px] font-medium"
            >
              <RotateCw className="size-3.5" />
              {t('sheetPreviewStale')}
            </button>
            <button
              type="button"
              aria-label={t('sheetPreviewStaleDismiss')}
              onClick={dismissStale}
              className="grid size-6 place-items-center rounded-full transition-colors hover:bg-background/20"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      )}
      {/* 顶栏 —— 46px 与 ChatHeader 同高同 hairline(同 WorkflowScriptPanel
          的对齐纪律)。窗口拖拽由根 layout 的 .window-drag-strip 统一负责,
          本栏不声明 drag;所有按钮 no-drag 在 strip 上挖洞。 */}
      <div className="flex h-[46px] shrink-0 select-none items-center gap-2.5 border-b border-border/55 px-3.5">
        {/* 表格徽章:与 DeliverableCard 的 X 徽章同色系,小一号。 */}
        <span
          aria-hidden
          className="grid size-5 shrink-0 place-items-center rounded-[5px] bg-[#217346] text-[10px] font-bold text-white"
        >
          X
        </span>
        <span
          title={path}
          className="min-w-0 truncate text-[13px] font-medium text-foreground"
        >
          {fileName}
        </span>
        {state.phase === 'ready' && sheet && (
          <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
            {t('sheetPreviewDims')
              .replaceAll('{rows}', String(sheet.totalRows))
              .replaceAll('{cols}', String(sheet.totalCols))}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
          {/* 缩放控件:− 百分比 +,点百分比回 100%。⌘/Ctrl+滚轮同步。 */}
          {state.phase === 'ready' && (
            <span className="mr-1 flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('sheetPreviewZoomOut')}
                disabled={zoom <= ZOOM_MIN}
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => setZoom((z) => clampZoom(z / 1.25))}
              >
                <Minus className="size-3.5" />
              </Button>
              <button
                type="button"
                title={t('sheetPreviewZoomReset')}
                onClick={() => setZoom(1)}
                className="min-w-11 rounded-md px-1 py-0.5 text-center text-[11.5px] tabular-nums text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {Math.round(zoom * 100)}%
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('sheetPreviewZoomIn')}
                disabled={zoom >= ZOOM_MAX}
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => setZoom((z) => clampZoom(z * 1.25))}
              >
                <Plus className="size-3.5" />
              </Button>
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-[12px] text-muted-foreground hover:text-foreground"
            onClick={() => {
              void window.chatApi.openPath({ absPath: path })
            }}
          >
            {t('sheetPreviewOpenExternal')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('sheetPreviewClose')}
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={closePreview}
          >
            <X className="size-4" />
          </Button>
        </span>
      </div>

      {/* Sheet tab 条 —— 多 sheet 才出现,横向滚动。 */}
      {sheets.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/55 px-2.5 py-1.5">
          {sheets.map((s, i) => (
            <button
              key={s.name + i}
              type="button"
              onClick={() => setActiveSheet(i)}
              className={
                'shrink-0 rounded-md px-2.5 py-1 text-[12px] transition-colors ' +
                (i === activeSheet
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground')
              }
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* 截断提示条 —— 只在当前 sheet 真被截了才出现。 */}
      {sheet && (sheet.totalRows > MAX_ROWS || sheet.totalCols > MAX_COLS) && (
        <div className="shrink-0 border-b border-border/55 bg-muted/40 px-3.5 py-1.5 text-[11.5px] text-muted-foreground">
          {t('sheetPreviewTruncated')
            .replaceAll('{rows}', String(Math.min(sheet.totalRows, MAX_ROWS)))
            .replaceAll('{total}', String(sheet.totalRows))}
        </div>
      )}

      {/* 内容区 */}
      {state.phase === 'loading' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12.5px] text-muted-foreground">
          <span
            aria-hidden
            className="tc-breathe inline-block size-1.5 rounded-full bg-brand"
          />
          <span className="tool-loading-dots">{t('sheetPreviewLoading')}</span>
        </div>
      ) : state.phase === 'error' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-[13px] text-muted-foreground">
            {t('sheetPreviewError')}
          </p>
          <p className="max-w-full break-all text-[11.5px] text-muted-foreground/70">
            {state.message}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[12.5px]"
            onClick={() => {
              void window.chatApi.openPath({ absPath: path })
            }}
          >
            {t('sheetPreviewOpenExternal')}
          </Button>
        </div>
      ) : sheet ? (
        <div
          ref={scrollRef}
          // bg-white:表格画布固定浅色皮肤的一部分(见 SheetTable 头注
          // 释)——数据区尽头的留白也得是纸面色,不能透出暗档面板底。
          className="min-h-0 flex-1 select-none overflow-auto bg-white"
          onMouseDown={onGridMouseDown}
          onMouseOver={onGridMouseOver}
        >
          {/* 外层 w-fit 撑滚动内容;内层是 zoom 容器 + 全部浮层(选区框/
              图表)的定位父——浮层存布局坐标、随 CSS zoom 整体缩放,
              这是缩放丝滑的关键(zoom 变化零 JS 测量)。仅问答条留在
              zoom 外(UI 不该被表格缩放牵连),坐标渲染时乘 zoom。
              contentRef 是缩放手势中的 transform 直写目标(见 wheel
              handler)。 */}
          <div ref={contentRef} className="relative w-fit">
            <div style={{ zoom }} ref={tableWrapRef} className="relative">
              <SheetTable
                sheet={sheet}
                spanMap={spanMap}
                skipSet={skipSet}
                gridRows={gridRows}
                gridCols={gridCols}
                colWidths={effColWidths}
                rowHeights={effRowHeights}
                tableWidth={tableWidth}
              />
              {/* 嵌入图表浮层:按文件锚点盖在网格上(Excel 同款浮动语
                  义)。pointer-events-none——图表下方格子的框选/复制交
                  互优先;白底卡片是文件的浅色设计,暗档也不翻。声明在
                  选区框之前 → 选区画在图表之上。 */}
              {sheet.charts.map((ch, i) => {
                const pos = chartPos[i]
                if (!pos) return null
                return (
                  <div
                    key={i}
                    aria-hidden
                    className="pointer-events-none absolute z-0 overflow-hidden rounded-lg border border-[#dfe3e8] bg-white shadow-[0_2px_10px_-2px_rgba(0,0,0,0.12)]"
                    style={{ left: pos.left, top: pos.top, width: ch.wPx, height: ch.hPx }}
                  >
                    <SheetMiniChart spec={ch} scale={1} />
                  </div>
                )
              })}
              {/* 选区框:z-0 → 盖数据格、被 sticky 行号(z-1)/表头
                  (z-2)正常遮挡,与 Excel 的滚动遮挡关系一致。 */}
              {selRect && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute z-0 rounded-[3px] border-2 border-accent bg-accent/10"
                  style={{
                    left: selRect.left,
                    top: selRect.top,
                    width: selRect.width,
                    height: selRect.height
                  }}
                />
              )}
            </div>
            {/* 浮动问答条(仅数据格框选定稿后出现——行列头/全选是轻量
                查看动作,不弹输入框):输入问题 → 选区 TSV + 范围标注 +
                文件路径一起发进当前会话。data-sheet-ask 让容器的
                mousedown 委托放行(点输入框不清选区)。 */}
            {selection && selRect && selection.mode === 'cell' && (
              <div
                data-sheet-ask
                className="absolute z-[5]"
                style={{
                  left: (selRect.left + selRect.width / 2) * zoom,
                  top: (selRect.top + selRect.height) * zoom + 6
                }}
              >
                <div className="flex -translate-x-1/2 items-center gap-1 rounded-full border border-border/70 bg-popover py-1 pl-3 pr-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.35),0_2px_8px_rgba(0,0,0,0.1)]">
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {rangeLabel}
                  </span>
                  <input
                    autoFocus
                    value={askText}
                    onChange={(e) => setAskText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && askText.trim()) {
                        e.preventDefault()
                        void askAI()
                      }
                    }}
                    placeholder={t('sheetPreviewAskPlaceholder')}
                    className="w-52 select-text bg-transparent px-1.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/60"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('sheetPreviewCopy')}
                    title={t('sheetPreviewCopy')}
                    className="size-6 text-muted-foreground hover:text-foreground"
                    onClick={copySelection}
                  >
                    {copied ? (
                      <Check className="size-3.5 text-brand" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </Button>
                  <Button
                    size="icon"
                    aria-label={t('sheetPreviewSend')}
                    title={t('sheetPreviewSend')}
                    disabled={!askText.trim() || streaming || !sessionId}
                    className="size-6 rounded-full"
                    onClick={() => void askAI()}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-[12.5px] text-muted-foreground">
          {t('sheetPreviewEmpty')}
        </div>
      )}
    </div>
  )
}
