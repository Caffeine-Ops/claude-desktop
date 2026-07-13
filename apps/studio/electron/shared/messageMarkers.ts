/**
 * 消息内嵌协议标记的纯解析逻辑——原住 src/chat/lib/messageMarkers.ts，
 * 2026-07-13 随「会话录制回放」迁入 shared：main 侧的回放编译器
 * （electron/main/replay/compileReplay.ts）要从 transcript 的 user 消息里
 * 反推图片编辑面板的 UI 表演轨，与 renderer 必须共用同一份 marker 解析
 * （否则两边对「什么算 image-edit 消息」各持一套判定，UI 轨会漂）。
 * shared 放运行时纯函数有先例（proposal.ts / proposalBlocks.ts），renderer
 * 侧旧路径保留 re-export shim，所有既有消费方 import 不变。
 *
 * 零依赖（无 zustand/window）：RailSessionList.tsx 明确禁止 import 任何
 * 求值期触碰 window 的 src/chat/ 模块（会破坏其所在 layout 的 SSR），而
 * filePreview.ts 顶层就有 `create<...>(...)` store 初始化 + `useChatStore`
 * 等链式 import。rail 展示层要识别这两种 marker 时只能从这个纯模块拿
 * parse 函数，不能碰 filePreview.ts 本体。
 */

/* ── 图片编辑消息协议 ──
 * 面板「发送」发出的消息首行嵌标记 + JSON 元数据；UserMessage 识别后渲染
 * 成紧凑卡片（图片名 + N 处标记 + 素材数），完整指令文本只进 CLI。display
 * 与 CLI 文本首行都带标记——transcript 存的是 CLI 侧文本，历史恢复也照样
 * 卡片化。 */

export const IMAGE_EDIT_MARKER = '[[image-edit]]'

export type ImageEditMeta = {
  /** 图片文件名（展示）与绝对路径（卡片点击重开编辑面板）。 */
  name: string
  path: string
  /** 标记列表：x/y 为图内百分比坐标（0~100，原点左上）。带 w/h = 框选
   * （x/y 是框左上角，w/h 是框宽高百分比）；不带 = 点标记（x/y 是圆心）。
   * note 为该处的改动描述。 */
  edits: { x: number; y: number; w?: number; h?: number; note: string }[]
  /** 底栏「（可选）添加额外编辑」的全图级要求；空串 = 未填。 */
  extra: string
  /** 融合素材图的绝对路径列表（作为额外 --image 输入与原图合成）。 */
  fusion: string[]
}

/** 消息文本 → 图片编辑元数据；非图片编辑消息返回 null。 */
export function parseImageEditMessage(text: string): ImageEditMeta | null {
  const nl = text.indexOf('\n')
  const firstLine = nl === -1 ? text : text.slice(0, nl)
  const idx = firstLine.indexOf(IMAGE_EDIT_MARKER)
  if (idx === -1) return null
  // marker 允许被 skill slash 领跑（CLI 文本形态 `/claude-desktop:imagegen
  // [[image-edit]]{…}`）：slash 必须占消息开头才能强制触发 imagegen skill，
  // 而 transcript 历史恢复渲染的是 CLI 侧文本。除 `/xxx ` 之外的前缀一律
  // 不认，防止正文里引用 marker 字样被误卡片化。
  if (idx > 0 && !/^\/[\w.:-]+\s+$/.test(firstLine.slice(0, idx))) return null
  const jsonStr = firstLine.slice(idx + IMAGE_EDIT_MARKER.length)
  try {
    const m = JSON.parse(jsonStr) as Partial<ImageEditMeta>
    if (typeof m.name === 'string' && Array.isArray(m.edits)) {
      return {
        name: m.name,
        path: typeof m.path === 'string' ? m.path : '',
        edits: m.edits.filter(
          (e): e is ImageEditMeta['edits'][number] =>
            typeof e === 'object' &&
            e !== null &&
            typeof (e as { note?: unknown }).note === 'string'
        ),
        extra: typeof m.extra === 'string' ? m.extra : '',
        fusion: Array.isArray(m.fusion)
          ? m.fusion.filter((f): f is string => typeof f === 'string')
          : []
      }
    }
  } catch {
    /* 坏 JSON → 当普通文本渲染 */
  }
  return null
}

/* ── 选区消息协议 ──
 * 预览面板「框选问 AI」发出的消息,首行嵌一个标记 + JSON 元数据;
 * UserMessage 识别后渲染成结构化卡片(文件名/范围/问题),而不是把
 * 原始长文本(含 TSV)糊在气泡里。发给 CLI 的 text 与气泡 display 首行
 * 都带标记——transcript 里存的是 CLI 侧文本,历史恢复也照样卡片化。 */

export const SHEET_SELECTION_MARKER = '[[sheet-selection]]'

export type SheetSelectionMeta = {
  /** 文件名(展示)与绝对路径(卡片点击重开预览)。 */
  name: string
  path: string
  sheet: string
  range: string
  /** 用户的问题(卡片正文;完整 TSV 只进 CLI 文本,不进卡片)。 */
  q: string
}

/** 消息文本 → 选区元数据;非选区消息返回 null。 */
export function parseSheetSelectionMessage(
  text: string
): SheetSelectionMeta | null {
  if (!text.startsWith(SHEET_SELECTION_MARKER)) return null
  const nl = text.indexOf('\n')
  const jsonStr = (nl === -1 ? text : text.slice(0, nl)).slice(
    SHEET_SELECTION_MARKER.length
  )
  try {
    const m = JSON.parse(jsonStr) as Partial<SheetSelectionMeta>
    if (typeof m.name === 'string' && typeof m.range === 'string') {
      return {
        name: m.name,
        path: typeof m.path === 'string' ? m.path : '',
        sheet: typeof m.sheet === 'string' ? m.sheet : '',
        range: m.range,
        q: typeof m.q === 'string' ? m.q : ''
      }
    }
  } catch {
    /* 坏 JSON → 当普通文本渲染 */
  }
  return null
}

/** 占位短语——marker 识别成功但 JSON 被截断解析不出来时的兜底展示。 */
const TRUNCATED_MARKER_PLACEHOLDER = '…'

/**
 * 会话标题/首条消息摘要的展示层归一化——识别上述两种 marker，返回人类
 * 可读的短文本；不是这两种协议消息则原样返回 raw（调用方再按自己的规则
 * 兜底，如 slash 命令拆分、空串兜底文案）。
 *
 * RailSessionList 的 displayTitle() 与 ThreadView 的 ChatHeader 标题解析
 * 都要吃这一层——否则 `[[sheet-selection]]{...}` / `[[image-edit]]{...}`
 * 这类协议 JSON 会被当成普通文本原样糊进标题栏（2026-07-13 事故：表格
 * 框选问 AI 的消息把整段 JSON + TSV 提示语顶成了会话标题）。
 *
 * **截断容错**（同日第二次事故）：这个函数吃的 `raw` 常常是
 * `ThreadSummary.title`/`firstPrompt`——SDK 落盘时按字符数截断过的字符串
 * （类型注释明确写着 truncated），marker JSON 可能被腰斩在字符串值中间。
 * 此时 `JSON.parse` 会抛错，`parseImageEditMessage`/`parseSheetSelectionMessage`
 * 按"非协议消息"语义返回 null——但这里 marker 前缀已经出现在开头（或紧跟
 * `/slash ` 之后），几乎可以断定就是协议消息只是被截断，不是巧合命中普通
 * 文本。两种情况必须分开处理：真正的"非协议消息"原样返回 raw 让调用方按
 * 普通文本兜底；"识别出 marker 但解析失败"绝不能把半成品 JSON 碎片吐给
 * 调用方，否则又变回同一个 bug 的另一种形态（截图：`[[image-edit]]
 * {"name":"...","path":"...","edits":[{"x":31.4...` 截断点正好落在 JSON
 * 内部）。
 *
 * 关键：截断只会发生在字符串**末尾**（SDK 按长度砍的），marker 前面的
 * slash 前缀（如 `/claude-desktop:imagegen `）永远完整——ChatHeader 靠
 * 这个前缀在 `cmdMatch` 里识别 skill chip（见 ThreadView.tsx）。所以这里
 * **保留原有的 `marker 之前` 部分**，只把 marker 本身连同其后不可解析的
 * JSON 残片换成占位符，而不是整串清空——清空会连累 skill chip 一起消失
 * （ChatHeader 的 cmdMatch 正则匹配不到 `/imagegen ` 前缀了）。
 */
export function stripMessageMarker(raw: string): string {
  const sheetSel = parseSheetSelectionMessage(raw)
  if (sheetSel) return sheetSel.q || sheetSel.name
  const sheetTruncated = truncatedMarkerPrefix(raw, SHEET_SELECTION_MARKER)
  if (sheetTruncated !== null) return sheetTruncated + TRUNCATED_MARKER_PLACEHOLDER

  const imgEdit = parseImageEditMessage(raw)
  if (imgEdit) return imgEdit.extra || imgEdit.name
  const imgTruncated = truncatedMarkerPrefix(raw, IMAGE_EDIT_MARKER)
  if (imgTruncated !== null) return imgTruncated + TRUNCATED_MARKER_PLACEHOLDER

  return raw
}

/**
 * marker 前缀命中但对应 parse 函数返回 null 时，返回「marker 之前」的
 * 部分（可能是空串，也可能是 `/claude-desktop:imagegen ` 这样的 slash
 * 前缀）；不认为是截断的协议消息则返回 null。判定只看前缀是否存在（marker
 * 出现在开头，或 image-edit 允许的 `/slash ` 领跑），不重新做 JSON 校验
 * ——parse 函数已经证明这段 JSON 解析不出来，这里只负责分类 + 截取。
 */
function truncatedMarkerPrefix(raw: string, marker: string): string | null {
  if (raw.startsWith(marker)) return ''
  const nl = raw.indexOf('\n')
  const firstLine = nl === -1 ? raw : raw.slice(0, nl)
  const idx = firstLine.indexOf(marker)
  if (idx === 0) return ''
  if (idx > 0 && /^\/[\w.:-]+\s+$/.test(firstLine.slice(0, idx))) {
    return firstLine.slice(0, idx)
  }
  return null
}
