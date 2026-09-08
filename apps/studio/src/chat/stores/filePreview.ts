import { create } from 'zustand'

import { useChatStore } from './chat'
import { useComposerModeStore } from './composerMode'
import { useProposalStore, useProposalWorkspace } from './proposal'
import { useWritingStore, useWritingWorkspace } from './writing'

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
 * 聊天页右栏的「占用者」仲裁（2026-09-08 收敛，替代原来三个各自为政的
 * 面板 store）。
 *
 * 右栏同一时刻只能站一个人：表格预览（xlsx/xls/csv）、图片标记编辑器、
 * 会话图库。收敛前每个面板一个 store、互相交叉关闭——两两互斥在两个参与者
 * 时最省事，第三个一进来就是 N² 条规则：三处 store 六个交叉 close、ThreadView
 * 两个 effect 各关三次、两条布尔链每加一个面板就长一截，加第四个面板要改
 * 十来处，漏一处零报错（第二轮 code review 抓到：自动弹开就漏判了 workflow
 * 面板）。现在只有一个事实：`occupant`。
 *
 *   - open(o)：直接换人（后开的赢），不需要知道之前站的是谁；
 *   - close(kind?)：不带 kind 清空；带 kind 只在站着的正是它时才关——
 *     ReplayController 的「收起编辑器」不能误伤用户手动开的表格预览；
 *   - 切会话 / 进分栏：ThreadView 一个 effect 调 close() 即可。
 *
 * 存的是磁盘路径而非消息内 id：路径跨会话有效（文件还在盘上），但预览 /
 * 改图 / 看图都是「点开看一眼」的瞬时动作，跨会话残留读作串台，所以
 * ThreadView 在 sessionId 变化时清空。
 */
export type RightPanelOccupant =
  | { kind: 'sheet'; path: string }
  | { kind: 'image'; path: string }
  | { kind: 'gallery' }

export type RightPanelKind = RightPanelOccupant['kind']

type RightPanelStore = {
  occupant: RightPanelOccupant | null
  /**
   * 图库已经自动弹开过一次的会话 id 集合。规则：第一张图落盘时自动展开，同一
   * 会话只自动弹这一次——用户关掉后再出图不再打扰。用集合而不是单个布尔，
   * 是因为切走再切回同一会话时「弹过」这件事要还记得。
   */
  galleryAutoOpenedSessions: Record<string, true>
  open: (occupant: RightPanelOccupant) => void
  close: (kind?: RightPanelKind) => void
  /**
   * 图库自动弹开（幂等）：该会话没弹过、且右栏此刻**空着**时才开并记账。
   * 「空着」= 没被 slides / proposal / 写作分栏占着，也没有别的面板站着——
   * 用户正对着一张表看数据、或正在图上落标记，第一张图落盘就把它顶掉等于
   * 抢用户的活；用户显式开的面板永远优先于自动弹出。占着时**不记账**，
   * 下一张图落盘再试——否则用户关掉那个面板后图库这辈子都不会自动出现。
   * 图库自己已经开着视为成功（记账）。返回是否真的打开了 / 已在。
   * workflow 脚本面板的开关是 React 派生态，这里拿不到，由调用方
   * （ImageGalleryButton）先挡。
   */
  autoOpenGalleryOnce: (sessionId: string) => boolean
}

export const useRightPanelStore = create<RightPanelStore>((set, get) => ({
  occupant: null,
  galleryAutoOpenedSessions: {},
  open: (occupant) => set({ occupant }),
  close: (kind) =>
    set((s) => {
      if (s.occupant === null) return s
      if (kind !== undefined && s.occupant.kind !== kind) return s
      return { occupant: null }
    }),
  autoOpenGalleryOnce: (sessionId) => {
    const { galleryAutoOpenedSessions, occupant } = get()
    if (galleryAutoOpenedSessions[sessionId]) return false
    if (splitWorkspaceBusyNow()) return false
    if (occupant !== null && occupant.kind !== 'gallery') return false
    set({
      galleryAutoOpenedSessions: { ...galleryAutoOpenedSessions, [sessionId]: true },
      occupant: { kind: 'gallery' }
    })
    return true
  }
}))

/* ── 命令式入口（非 React 上下文 / 事件回调用） ── */
export function openRightPanel(occupant: RightPanelOccupant): void {
  useRightPanelStore.getState().open(occupant)
}
export function closeRightPanel(kind?: RightPanelKind): void {
  useRightPanelStore.getState().close(kind)
}

/* ── 选择器：给 useRightPanelStore(selectX) 用，返回原始值以免无谓重渲染 ── */
export const selectSheetPreviewPath = (s: RightPanelStore): string | null =>
  s.occupant?.kind === 'sheet' ? s.occupant.path : null
export const selectImageEditPath = (s: RightPanelStore): string | null =>
  s.occupant?.kind === 'image' ? s.occupant.path : null
export const selectGalleryOpen = (s: RightPanelStore): boolean =>
  s.occupant?.kind === 'gallery'
export const selectRightPanelKind = (s: RightPanelStore): RightPanelKind | null =>
  s.occupant?.kind ?? null

/**
 * 右栏是否已被 slides / proposal / 写作 工作区占用 —— DeliverableCard 用它
 * 决定表格卡片的点击去向：占用时降级回系统应用打开（ThreadView 里预览面板
 * 对这三种分栏让位，点了不弹等于点了没反应）。判定逻辑必须与 ThreadView 的
 * isSplitMode **完全同源**（slides 按会话启动模式标记、proposal 随激活实时
 * 切换、写作按 useWritingWorkspace 的 store.source + revealed 判定），放这里而不放
 * ThreadView 是避免组件层互相 import。
 *
 * 【为什么必须同源，别嫌麻烦】isSplitMode 决定 ThreadView 是否渲染预览面板
 * （showSheetPreview = path !== null && !isSplitMode）；这里决定要不要先调
 * openRightPanel 写占用者。两边脱节的后果是：写作分栏下这里判 false
 * → 五个 UI 调用点（AssistantMessage 成果卡、OutputsPanel 行式/图块、
 * ImageGenCard 生成图卡、Composer 附件卡）照常调 openRightPanel →
 * 占用者被写入 → 但 ThreadView 那边 isSplitMode 为真、面板不渲染——点击死、
 * 零报错，且脏占用者会在写作模式退出后突然弹出一张不相干的旧预览。isSplitMode 加第三个来源时若忘了同步这两个
 * 函数，就是这条缺陷本身（2026-07-29 复审发现）。
 */
export function useSplitWorkspaceBusy(): boolean {
  const sessionId = useChatStore((s) => s.sessionId)
  const slidesSessions = useComposerModeStore((s) => s.slidesSessions)
  const proposal = useProposalWorkspace()
  const writing = useWritingWorkspace()
  return (
    proposal || writing || (sessionId !== null && slidesSessions[sessionId] === true)
  )
}

/**
 * useSplitWorkspaceBusy 的命令式快照版——给非 React 上下文用（附件
 * adapter 的 add() 在 assistant-ui runtime 层跑，没有 hook 环境）。判定
 * 逻辑必须与上面的 hook 逐项同步：proposal 半边内联的是
 * useProposalWorkspace 的展开（active + 前台会话匹配 + workspaceOpen，
 * 见 stores/proposal.ts），slides 半边同源，写作半边内联的是
 * useWritingWorkspace 的展开（store.source !== null && store.revealed，见
 * stores/writing.ts；**revealed 这一项不能漏**——写作右栏在拿到第一节正文前
 * 并不占屏幕，此时判 busy 会让表格卡片白白降级去系统应用打开）。
 * 只做一次性读取不订阅——调用方都是「此刻要不要开面板」的瞬时决策，不需要
 * 响应后续变化。
 */
export function splitWorkspaceBusyNow(): boolean {
  const chatSid = useChatStore.getState().sessionId
  const p = useProposalStore.getState()
  const proposalBusy =
    p.active && p.sessionId !== null && p.sessionId === chatSid && p.workspaceOpen
  const slidesSessions = useComposerModeStore.getState().slidesSessions
  const w = useWritingStore.getState()
  const writingBusy = w.source !== null && w.revealed
  return (
    proposalBusy || writingBusy || (chatSid !== null && slidesSessions[chatSid] === true)
  )
}
