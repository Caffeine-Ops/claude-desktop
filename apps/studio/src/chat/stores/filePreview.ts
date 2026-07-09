import { create } from 'zustand'

import { useChatStore } from './chat'
import { useComposerModeStore } from './composerMode'
import { useProposalWorkspace } from './proposal'

/**
 * 应用内表格预览面板的开关状态（面板本体见
 * ThreadView/SpreadsheetPreviewPanel.tsx）。
 *
 * 打开途径只有一种：用户点了成果文件卡片里的表格文件（xlsx / xls /
 * csv，见 AssistantMessage 的 DeliverableCard）→ 记下绝对路径，
 * ThreadView 据此分栏、面板自己按 path 读盘解析。关闭 = 清路径。
 *
 * 与 workflowScript 面板不同，这里存的是磁盘路径而非消息内的
 * toolCallId——切会话后路径依然有效（文件还在盘上），但预览是「点开
 * 看一眼」的瞬时动作，跨会话残留一张旧表格反而突兀，所以 ThreadView
 * 在 sessionId 变化时显式 closePreview()。
 */
type SheetPreviewStore = {
  /** 正在预览的表格文件绝对路径；null = 面板关闭。 */
  path: string | null
  openPreview: (path: string) => void
  closePreview: () => void
}

export const useSheetPreviewStore = create<SheetPreviewStore>((set) => ({
  path: null,
  openPreview: (path) => {
    // 与图片编辑面板互斥：两个面板共用同一右栏，后开的赢。交叉关闭放
    // action 里（而非 ThreadView 渲染层 gate）——被顶掉的状态要真清掉，
    // 否则另一面板关闭时旧面板会突然弹回来。同模块内互引无循环依赖。
    useImageEditStore.getState().closeEditor()
    set({ path })
  },
  closePreview: () => set({ path: null })
}))

/* ── 图片标记编辑面板 ──
 * 点成果卡片里的图片文件（png/jpg/webp）→ 右栏展开标记编辑面板
 * （ThreadView/ImageEditPanel.tsx）：图上落编号标记 + 逐点描述改动 +
 * 可选融合素材图，发送后 agent 走 imagegen skill 的 edit 子命令改图。
 * 开关语义与表格预览完全同构（存磁盘绝对路径、切会话即关）。 */

type ImageEditStore = {
  /** 正在编辑的图片绝对路径；null = 面板关闭。 */
  path: string | null
  openEditor: (path: string) => void
  closeEditor: () => void
}

export const useImageEditStore = create<ImageEditStore>((set) => ({
  path: null,
  openEditor: (path) => {
    // 互斥另一半：开图片编辑就收表格预览（理由见 openPreview 内注释）。
    useSheetPreviewStore.getState().closePreview()
    set({ path })
  },
  closeEditor: () => set({ path: null })
}))

/* ── 图片编辑消息协议 ──
 * 与 sheet-selection 同一套路：面板「发送」发出的消息首行嵌标记 + JSON
 * 元数据；UserMessage 识别后渲染成紧凑卡片（图片名 + N 处标记 + 素材数），
 * 完整指令文本只进 CLI。display 与 CLI 文本首行都带标记——transcript 存
 * 的是 CLI 侧文本，历史恢复也照样卡片化。 */

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

/**
 * 右栏是否已被 slides / proposal 工作区占用 —— DeliverableCard 用它决定
 * 表格卡片的点击去向：占用时降级回系统应用打开（ThreadView 里预览面板
 * 对这两种分栏让位，点了不弹等于点了没反应）。判定逻辑与 ThreadView 的
 * isSplitMode 完全同源（slides 按会话启动模式标记、proposal 随激活实时
 * 切换），放这里而不放 ThreadView 是避免组件层互相 import。
 */
export function useSplitWorkspaceBusy(): boolean {
  const sessionId = useChatStore((s) => s.sessionId)
  const slidesSessions = useComposerModeStore((s) => s.slidesSessions)
  const proposal = useProposalWorkspace()
  return proposal || (sessionId !== null && slidesSessions[sessionId] === true)
}
