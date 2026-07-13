/**
 * 回放会话的 UI 订阅面（控制条 / 各处守卫读这里）。写手只有
 * ReplayController——组件不要直接 set，一切控制操作走 controller 方法。
 */
import { create } from 'zustand'
import type { ReplayConfirmSnapshot } from '@desktop-shared/replayTypes'
import type { AskUserQuestionItem } from '../components/permissions/AskUserQuestionView'

/**
 * 回放会话 id 的前缀。带此前缀的 sessionId 是纯前端表演 slot：
 * 不对应任何 CLI 子进程/transcript，绝不能流入任何 window.chatApi 调用
 * （FusionRuntimeProvider 的订阅集/onNew 与 Composer 的 meta 拉取都按它
 * 短路，见各调用点注释）。
 */
export const REPLAY_SESSION_PREFIX = 'replay:'

export function isReplaySessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(REPLAY_SESSION_PREFIX)
}

export type ReplayStatus = 'idle' | 'playing' | 'paused' | 'done'
export type ReplaySpeed = 1 | 2 | 4 | 8

/** slides 录像的一页（manifest 权威清单，path 已被 main 注入解包路径）。 */
export interface ReplaySlide {
  path: string
  title: string
}

interface ReplayState {
  status: ReplayStatus
  /** 当前回放 slot 的 sessionId（replay:<uuid>）；idle 时 null。 */
  sessionId: string | null
  /** 进入回放前的前台会话，退出时归还（用户中途点走则不归还）。 */
  savedForegroundId: string | null
  /** 录像标题（控制条展示）。 */
  title: string | null
  /**
   * slides 录像的权威幻灯片清单（manifest.meta.slides，顺序即页序）；
   * 非 slides 录像或旧格式包为 null——查看器退回消息扫描兜底。
   */
  slides: ReplaySlide[] | null
  /**
   * ppt-master 八项确认的选择快照（manifest.meta.confirmSnapshots）——
   * CanvasConfirm 回放态离线渲染的唯一数据源（cat/rec 都从这里来，不 fetch
   * 真实 server）。旧格式包（此字段落地前导出的）为 null，SlidesWorkspace
   * 据此让「问题」tab 在 confirm 阶段直接跳过（聊天轨不受影响）。
   */
  confirmSnapshots: ReplayConfirmSnapshot[] | null
  /**
   * 「问题」tab 当前该挂哪个回放表演组件——回放态没有真实
   * server/pendingAsk 可判定 hasConfirm/hasQuestions（两者的数据源都是
   * live-only，见 SlidesWorkspace 头注释），这个字段是 ReplayController
   * 在遇到 confirm.open/askQuestion.open 时设置的显式替代信号。表演结束
   * （submitFinal/submit 落定）后清空，工作区退回幻灯片 tab。
   */
  activeQuestionsPanel: 'confirm' | 'questionnaire' | null
  /** activeQuestionsPanel==='questionnaire' 时的题目列表——ReplayController
   *  在 askQuestion.open 命中时 parse 出来写入，CanvasQuestionnaire 靠它
   *  离线渲染（不走 request/streamingArgsText，见该组件的 replayQuestions
   *  prop 注释）。 */
  activeQuestions: AskUserQuestionItem[] | null
  /** 虚拟时间轴位置/总长（gap-cap 压缩后），驱动进度条。 */
  positionMs: number
  durationMs: number
  speed: ReplaySpeed
  /** 仅 ReplayController 调用。 */
  _patch: (p: Partial<Omit<ReplayState, '_patch' | '_reset'>>) => void
  _reset: () => void
}

const INITIAL = {
  status: 'idle' as ReplayStatus,
  sessionId: null,
  savedForegroundId: null,
  title: null,
  slides: null,
  confirmSnapshots: null,
  activeQuestionsPanel: null,
  activeQuestions: null,
  positionMs: 0,
  durationMs: 0,
  speed: 1 as ReplaySpeed
}

export const useReplayStore = create<ReplayState>((set) => ({
  ...INITIAL,
  _patch: (p) => set(p),
  _reset: () => set(INITIAL)
}))
