import { create } from 'zustand'

import { useChatStore } from './chat'
import { useComposerModeStore } from './composerMode'
import { useProposalStore, useProposalWorkspace } from './proposal'

/* marker 协议解析是纯函数，抽在 lib/messageMarkers.ts（无 zustand/window
 * 依赖）——RailSessionList 等 SSR 敏感组件要用同一套解析但不能 import 本
 * 文件（顶层有 store 求值）。这里 re-export 保持既有消费方 import 路径
 * 不变。 */
export {
  IMAGE_EDIT_MARKER,
  type ImageEditMeta,
  parseImageEditMessage,
  SHEET_SELECTION_MARKER,
  type SheetSelectionMeta,
  parseSheetSelectionMessage
} from '../lib/messageMarkers'

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

/**
 * useSplitWorkspaceBusy 的命令式快照版——给非 React 上下文用（附件
 * adapter 的 add() 在 assistant-ui runtime 层跑，没有 hook 环境）。判定
 * 逻辑必须与上面的 hook 逐项同步：proposal 半边内联的是
 * useProposalWorkspace 的展开（active + 前台会话匹配 + workspaceOpen，
 * 见 stores/proposal.ts），slides 半边同源。只做一次性读取不订阅——
 * 调用方都是「此刻要不要开面板」的瞬时决策，不需要响应后续变化。
 */
export function splitWorkspaceBusyNow(): boolean {
  const chatSid = useChatStore.getState().sessionId
  const p = useProposalStore.getState()
  const proposalBusy =
    p.active && p.sessionId !== null && p.sessionId === chatSid && p.workspaceOpen
  const slidesSessions = useComposerModeStore.getState().slidesSessions
  return proposalBusy || (chatSid !== null && slidesSessions[chatSid] === true)
}
