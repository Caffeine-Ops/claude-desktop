/* ─────────────── 表格预览的共享常量 ───────────────
 * 独立小模块的原因:壳层(index.tsx)不能静态 import buildSnapshot /
 * UniverSheetView——那两个模块带着 xlsx/exceljs/Univer 的运行时依赖,
 * 静态引用会把整个重链打进聊天首屏 bundle(壳层只 React.lazy /
 * 动态 import 它们)。跨三个模块要用的字面常量全放这里。 */

/** 渲染上限:超过就截断 + 顶部提示条(canvas 渲染本身不怕大表,贵的
 *  是 buildSnapshot 里的 JS 侧逐格转换)。 */
export const SHEET_MAX_ROWS = 1500
export const SHEET_MAX_COLS = 80

/** 文件连 sheetFormatPr 都没写时的兜底默认列宽/行高(px)。64 =
 *  Excel 标准默认列宽 8.43 字符(Calibri 11,MDW 7)的像素;20 =
 *  15pt 默认行高。真实文件优先吃 sheetFormatPr 的 per-sheet 默认
 *  (parseSheetFormats),这两个常量只兜 csv / 解析失败。 */
export const SHEET_DEFAULT_COL_W = 64
export const SHEET_DEFAULT_ROW_H = 20

/** 行号列宽 / 列头行高(px):写死进 snapshot,float DOM 的像素锚点
 *  含表头偏移,依赖这两个值确定。 */
export const SHEET_ROW_HEADER_W = 46
export const SHEET_COL_HEADER_H = 20

/** 缩放范围(Univer 引擎支持 0.1–4,产品上收口到 25%–400%)。 */
export const SHEET_ZOOM_MIN = 0.25
export const SHEET_ZOOM_MAX = 4

/** 发送给 AI 的选区行数上限(整片拖选可能上千行,别撑爆上下文)。 */
export const SHEET_MAX_SEND_ROWS = 300
