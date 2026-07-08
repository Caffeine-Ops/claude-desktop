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
  openPreview: (path) => set({ path }),
  closePreview: () => set({ path: null })
}))

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
