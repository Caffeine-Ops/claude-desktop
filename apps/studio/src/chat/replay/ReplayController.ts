/**
 * 会话录像回放控制器（模块级单例，非 React）。
 *
 * 职责：把 .claudereplay 的多轨时间线在现有聊天界面里「演」出来——
 * chat 轨合成 ChatEvent 微步（打字机 chunk / 工具 args 流式 / result 落卡）
 * 统一喂 applyChatEventToStore(live=null)，渲染层（ThreadView / 工具卡 /
 * spinner）与真实流式像素级一致；ui 轨经 UiOpExecutor 驱动真实面板组件。
 *
 * 关键不变量：
 * - 回放 slot 是纯前端的（sessionId 带 replay: 前缀）：进入用
 *   setForegroundSession（零 IPC），清理只用 dropSession——绝不触碰
 *   setSession（live 优先语义会吞掉重复喂入）/switchSession/closeSessionRuntime。
 * - 表演全程不产生任何真实副作用：applyChatEventToStore 的 live 传 null
 *   关断方案模式/unread/队列/历史缓存；ui 轨的 pressSend 只做视觉。
 * - 用户点走（rail 切会话/新建）＝退出信号：订阅 chat store 的前台
 *   sessionId，一旦不再是本 slot 就地清理、且不抢回前台。
 *
 * 时间模型（三层）：
 * 1. 录像 t/durMs：真实毫秒（编译器保留原节奏）。
 * 2. 虚拟时间轴 playbackT：load 时预计算——块时长先 cap 出 effDur
 *    （超长打字/2 分钟生图压到演示友好的上限），相邻 item 的【空闲间隔】
 *    （扣除前块 effDur 后的部分）再 cap 到 GAP_CAP。进度条/seek 都在这条
 *    轴上。
 * 3. 播放速度 speed：tick 里 virtualNow += 真实流逝 × speed，只影响推进
 *    速率，不改时间轴本身——倍速即时生效且 seek 位置不漂。
 */
import type { ChatEvent } from '@desktop-shared/types'
import type {
  ReplayItem,
  ReplayMeta,
  ReplayTimeline,
  ReplayUiItem
} from '@desktop-shared/replayTypes'
import {
  ARGS_MAX_MS,
  ARGS_MS_PER_CHAR,
  RUN_MAX_MS,
  buildPlaybackSchedule,
  type ScheduledReplayItem
} from '@desktop-shared/replayTiming'

import { useChatStore } from '../stores/chat'
import { useTodosStore } from '../stores/todos'
import { useImageEditStore } from '../stores/filePreview'
import { useComposerModeStore } from '../stores/composerMode'
import { useSessionTitleStore } from '../stores/sessionTitle'
import {
  applyChatEventToStore,
  createChatEventCtx,
  type ChatEventActions,
  type ChatEventCtx
} from '../runtime/applyChatEventToStore'
import {
  REPLAY_SESSION_PREFIX,
  useReplayStore,
  type ReplaySpeed
} from './replayStore'
import { getImageEditDemoHandle } from './imageEditDemoRegistry'
import { getQuestionDemoHandle } from './questionDemoRegistry'
import { getConfirmDemoHandle } from './confirmDemoRegistry'
import { parseQuestions, type AskUserQuestionItem } from '../components/permissions/AskUserQuestionView'

/** 播放 tick 间隔。33ms ≈ 30fps 的打字机粒度足够顺滑。 */
const TICK_MS = 33

/** 面板 buffering（open 已发、handle 还没注册）的真实等待上限——超时整段
 *  表演放弃、聊天轨照常。倍速快进时 900ms 的虚拟缓冲会被压得很短，这个
 *  真实时限保证图片读盘慢也有机会演完。 */
const UI_BUFFER_TIMEOUT_MS = 2000

/**
 * 三种 ui 表演（imageEdit/askQuestion/confirm）各自独立的窄接口 handle，
 * 按 op 的命名空间前缀路由——open 类 op 不检查（它们自己负责让对应面板
 * 挂载），其余 op 到点时必须已有 handle 才能消费，否则转入 buffering。
 */
function uiHandleReady(op: string): boolean {
  if (op.startsWith('imageEdit.')) return getImageEditDemoHandle() !== null
  if (op.startsWith('askQuestion.')) return getQuestionDemoHandle() !== null
  if (op.startsWith('confirm.')) return getConfirmDemoHandle() !== null
  return true
}

/** imageEdit.open/askQuestion.open 不需要预先存在的 handle——它们本身就是
 *  「触发面板挂载」的动作，handle 是挂载后才注册的，所以豁免 buffering 前
 *  置检查。confirm.open 不豁免：它需要 handle.open(toolUseId) 去加载快照
 *  数据，跟 confirm.select 等后续步骤一样要等 handle 就绪（面板挂载本身由
 *  processItems 在判定 buffering 前先幂等触发，见该方法）。 */
function isOpenOp(op: string): boolean {
  return op === 'imageEdit.open' || op === 'askQuestion.open'
}

/** askQuestion.open 携带的 questionsJson（该 tool-call 的 args 原样）→
 *  AskUserQuestionItem[]，复用 AskUserQuestionView 的权威 parser（同一份
 *  判定逻辑，live 弹窗与回放表演对「什么算合法题目」不会漂）。 */
function parseAskUserQuestions(questionsJson: string): AskUserQuestionItem[] {
  try {
    return parseQuestions(JSON.parse(questionsJson))
  } catch {
    return []
  }
}

/** 预计算后的播放项（shared/replayTiming 的调度产物）。 */
type PlaybackItem = ScheduledReplayItem

/** 正在流式推进中的块（text/thinking/tool/面板逐字打字）。 */
interface InflightBlock {
  kind:
    | 'text'
    | 'thinking'
    | 'tool'
    | 'ui-note'
    | 'ui-extra'
    | 'ui-question-other'
    | 'ui-confirm-text'
  messageId: string
  startV: number
  /** text/thinking：全文；tool：argsJson。 */
  text: string
  sent: number
  /** text/thinking：整块时长；tool：args 段时长。 */
  durMs: number
  /* tool 专用 ↓ */
  toolUseId?: string
  toolName?: string
  runDurMs?: number
  result?: unknown
  tasks?: NonNullable<Extract<ReplayItem, { op: 'tool' }>['tasks']>
  /** tool 生命周期游标：args 流完 → 'run'（等 result）→ 完成移除。 */
  phase?: 'args' | 'run'
  /** run 阶段已亮起的子任务数。 */
  tasksEmitted?: number
  /** ui-question-other 专用：目标题面文本（answers 字典的 key）。 */
  question?: string
  /** ui-confirm-text 专用：目标字段名。 */
  field?: string
}

class ReplayControllerImpl {
  private sid: string | null = null
  private items: PlaybackItem[] = []
  private cursor = 0
  private inflight: InflightBlock[] = []
  private virtualNow = 0
  private durationMs = 0
  private speed: ReplaySpeed = 1
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastTickReal = 0
  private ctx: ChatEventCtx = createChatEventCtx()
  private actions: ChatEventActions | null = null
  private unsubForeground: (() => void) | null = null
  /**
   * 挂起 rail 防守订阅。seek 要 dropSession（前台瞬间变 null）再挂回——
   * 这两次 set 之间订阅会同步触发，把 controller 自己的前台腾挪误判成
   * 「用户切走」直接 exit（2026-07-13 实测：seek 即崩，durationMs 被
   * reset 后控制条显示 x/0:00）。凡 controller 自己动前台的窗口都置位。
   */
  private guardSuspended = false
  /** ui 表演已放弃：跳过后续 ui item 直到下一个 imageEdit.open 重新开演。 */
  private uiAbandoned = false
  /** 非 null = 正在等面板 handle 就绪（真实时刻戳）；期间虚拟时钟暂停。 */
  private uiBufferingSince: number | null = null

  /* ─────────── 生命周期 ─────────── */

  start(meta: ReplayMeta, timeline: ReplayTimeline): void {
    if (this.sid) this.exit({ restoreForeground: false })

    const chat = useChatStore.getState()
    const saved = chat.sessionId
    const sid = `${REPLAY_SESSION_PREFIX}${crypto.randomUUID()}`
    this.sid = sid
    this.actions = {
      appendUserMessage: chat.appendUserMessage,
      startAssistantMessage: chat.startAssistantMessage,
      appendAssistantDelta: chat.appendAssistantDelta,
      startReasoning: chat.startReasoning,
      appendThinkingDelta: chat.appendThinkingDelta,
      startToolCall: chat.startToolCall,
      appendToolCallArgsDelta: chat.appendToolCallArgsDelta,
      finalizeToolCall: chat.finalizeToolCall,
      addToolCall: chat.addToolCall,
      updateToolCallResult: chat.updateToolCallResult,
      updateToolCallTasks: chat.updateToolCallTasks,
      setRetryInfo: chat.setRetryInfo,
      setError: chat.setError,
      endAssistantMessage: chat.endAssistantMessage,
      setUsage: chat.setUsage
    }

    this.prepareTimeline(timeline.items)
    this.cursor = 0
    this.inflight = []
    this.virtualNow = 0
    this.speed = 1
    this.ctx = createChatEventCtx()
    this.uiAbandoned = false

    // 纯前端挂前台：slot 不存在时 setForegroundSession 会建空 slot。
    chat.dropSession(sid) // uuid 碰撞级防御，正常是 no-op
    chat.setForegroundSession(sid)
    // ChatHeader 读 useSessionTitleStore（真实会话由 FusionRuntimeProvider
    // 的 threads 派生 effect 写入，对 replay: 前缀的 sessionId 已跳过，见该
    // effect 注释）——回放期间这个 store 唯一写手是这里，exit() 时复位。
    useSessionTitleStore.getState().setTitle(meta.title)

    // slides 会话的录像 → 给 replay slot 打同款 per-session 标记撑开
    // 双分栏（ThreadView 的 isSlidesMode 就认这个）；右侧仍是
    // SlidesWorkspace，它按回放态把预览 tab 换成静态查看器（数据源 =
    // 下面 patch 进 replayStore 的权威清单，见 ReplaySlidesViewer）。
    // exit 时必须 unmark——标记持久化在 localStorage。
    if (meta.mode === 'slides') {
      useComposerModeStore.getState().markSlidesSession(sid)
    }

    useReplayStore.getState()._patch({
      status: 'playing',
      sessionId: sid,
      savedForegroundId: saved,
      title: meta.title,
      // manifest 权威幻灯片清单；path 由 main 导入时注入（旧格式包无此
      // 字段 → null，查看器退回消息扫描兜底）。
      slides:
        meta.slides
          ?.filter((s): s is typeof s & { path: string } => typeof s.path === 'string')
          .map((s) => ({ path: s.path, title: s.title })) ?? null,
      // manifest.meta.confirmSnapshots——CanvasConfirm 回放态离线渲染的
      // 唯一数据源；旧格式包无此字段时为 null（组件据此让 confirm.open
      // 表演跳过，见 confirmDemoRegistry 的 open() 契约）。
      confirmSnapshots: meta.confirmSnapshots ?? null,
      positionMs: 0,
      durationMs: this.durationMs,
      speed: 1
    })

    // rail 防守：用户切走（前台 sessionId 不再是本 slot）＝退出信号。
    // 必须在 setForegroundSession 之后订阅，否则自己这次切换就触发；
    // controller 自己的前台腾挪（seek 的 drop→挂回）经 guardSuspended 豁免。
    this.unsubForeground = useChatStore.subscribe((s) => {
      if (this.sid && !this.guardSuspended && s.sessionId !== this.sid) {
        this.exit({ restoreForeground: false })
      }
    })

    this.startTimer()
  }

  exit(opts: { restoreForeground?: boolean } = {}): void {
    const { restoreForeground = true } = opts
    if (!this.sid) return
    const sid = this.sid
    this.sid = null // 先置空：下面的 store 操作会触发 foreground 订阅，防重入
    this.stopTimer()
    this.unsubForeground?.()
    this.unsubForeground = null
    this.uiBufferingSince = null

    // 面板可能被 ui 轨打开着；先关再拆 slot。
    useImageEditStore.getState().closeEditor()
    const chat = useChatStore.getState()
    const saved = useReplayStore.getState().savedForegroundId
    chat.dropSession(sid)
    useTodosStore.getState().setTodos(sid, [])
    // slides 临时标记摘除（无标记时 no-op）——它持久化在 localStorage，
    // 不摘会残留死键。
    useComposerModeStore.getState().unmarkSlidesSession(sid)
    // 录像标题复位：setForegroundSession 触发的 FusionRuntimeProvider
    // threads-effect 会在下一帧重新算出真实标题（或 null），但那是异步
    // 的——这里同步清一次，避免下一帧提交前录像标题在真实会话顶栏上
    // 闪一下（跟切真实会话时「标题短暂为空再落定」的既有观感一致，不是
    // 新增行为）。
    useSessionTitleStore.getState().setTitle(null)
    if (restoreForeground) {
      // saved 的 slot 若还在 perSession 里则瞬时恢复；为 null 回空态首页。
      chat.setForegroundSession(saved)
    }
    useReplayStore.getState()._reset()
  }

  /* ─────────── 控制操作 ─────────── */

  play(): void {
    const st = useReplayStore.getState()
    if (!this.sid || st.status === 'playing') return
    // done 后再点播放 = 从头重演。
    if (st.status === 'done') {
      this.seekTo(0)
    }
    useReplayStore.getState()._patch({ status: 'playing' })
    this.startTimer()
  }

  pause(): void {
    if (!this.sid) return
    this.stopTimer()
    useReplayStore.getState()._patch({ status: 'paused' })
  }

  setSpeed(speed: ReplaySpeed): void {
    // 只改推进速率；虚拟时间轴不动，进度/seek 语义不受影响。
    this.speed = speed
    useReplayStore.getState()._patch({ speed })
  }

  /**
   * seek = 从头 instant flush 到目标虚拟时刻。事件流是 append-only 的，
   * 「回到过去」只能重建：drop slot → ctx 重置 → 把 startV ≤ target 的
   * chat item 全速重演（walk 同一条 processItems/advanceInflight 主循环，
   * 与实时播放共享全部语义）。ui 表演不参与 seek（面板动画没有中间态可
   * 恢复），seek 后一律关面板从纯聊天态继续。
   */
  seekTo(targetMs: number): void {
    if (!this.sid || !this.actions) return
    const wasPlaying = useReplayStore.getState().status === 'playing'
    this.stopTimer()

    const chat = useChatStore.getState()
    // dropSession 把前台清成 null 再挂回——这个窗口里 rail 防守订阅会
    // 同步触发，必须挂起（见 guardSuspended 注释），否则 seek 即自杀。
    this.guardSuspended = true
    try {
      chat.dropSession(this.sid)
      useTodosStore.getState().setTodos(this.sid, [])
      useImageEditStore.getState().closeEditor()
      this.uiBufferingSince = null
      chat.setForegroundSession(this.sid)
    } finally {
      this.guardSuspended = false
    }

    this.ctx = createChatEventCtx()
    this.cursor = 0
    this.inflight = []
    // seek 不重演 ui 表演（面板动画没有可恢复的中间态）：目标点前的 ui op
    // 全部跳过，abandoned 保持到下一个 imageEdit.open/askQuestion.open/
    // confirm.open 才重新开演。「问题」tab 表演同 image-edit 面板一样没有
    // 可恢复的中间态，一并清场（否则 seek 到早于/晚于该段的位置会把
    // confirm/questionnaire 晾在半场）。
    this.uiAbandoned = true
    useReplayStore.getState()._patch({ activeQuestionsPanel: null, activeQuestions: null })
    this.virtualNow = Math.max(0, Math.min(targetMs, this.durationMs))
    // 复用主循环推进到目标：processItems 吃掉所有 startV ≤ target 的 item，
    // advanceInflight 把跨过 target 的块推进到精确进度（部分打出的正文）。
    this.processItems()
    this.advanceInflight()

    useReplayStore.getState()._patch({
      positionMs: this.virtualNow,
      status: wasPlaying ? 'playing' : this.doneReached() ? 'done' : 'paused'
    })
    if (wasPlaying && !this.doneReached()) this.startTimer()
  }

  /* ─────────── 播放主循环 ─────────── */

  private startTimer(): void {
    if (this.timer !== null) return
    this.lastTickReal = performance.now()
    const loop = (): void => {
      this.timer = setTimeout(() => {
        this.tick()
        if (this.timer !== null) loop()
      }, TICK_MS)
    }
    loop()
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private tick(): void {
    const now = performance.now()
    const elapsed = now - this.lastTickReal
    this.lastTickReal = now

    // 面板 buffering：open 已发但 handle 还没注册（图在读盘/组件还没挂载）。
    // 虚拟时钟暂停等它——像视频播放器缓冲；真实超时则放弃整段表演继续走。
    if (this.uiBufferingSince !== null) {
      const pendingOp = this.items[this.cursor]?.item
      const ready = pendingOp && pendingOp.track === 'ui' ? uiHandleReady(pendingOp.op) : true
      if (ready) {
        this.uiBufferingSince = null
      } else if (now - this.uiBufferingSince > UI_BUFFER_TIMEOUT_MS) {
        this.uiBufferingSince = null
        this.uiAbandoned = true
      } else {
        return // 时钟冻结，本 tick 什么都不推进
      }
    }

    this.virtualNow = Math.min(this.virtualNow + elapsed * this.speed, this.durationMs)

    this.processItems()
    this.advanceInflight()

    useReplayStore.getState()._patch({ positionMs: this.virtualNow })

    if (this.doneReached()) {
      this.stopTimer()
      useReplayStore.getState()._patch({
        status: 'done',
        positionMs: this.durationMs
      })
    }
  }

  private doneReached(): boolean {
    return this.cursor >= this.items.length && this.inflight.length === 0
  }

  /** 吃掉所有已到点的 item（瞬时的直接生效，持续的进 inflight）。 */
  private processItems(): void {
    while (this.cursor < this.items.length) {
      const p = this.items[this.cursor]
      if (p.startV > this.virtualNow) break
      const it = p.item
      // confirm.open 需要 handle 才能加载快照（不像 imageEdit/askQuestion
      // 的 open 只是触发挂载）——但挂载本身得先发生 handle 才可能存在，
      // 所以在判定 buffering 前幂等地把面板打开（可以在同一位置反复设置，
      // store patch 是幂等的，不会重复触发挂载副作用）。
      if (it.track === 'ui' && it.op === 'confirm.open' && !this.uiAbandoned) {
        useReplayStore.getState()._patch({ activeQuestionsPanel: 'confirm' })
      }
      // 到点的 ui 表演步骤但面板 handle 还没就绪 → 不消费、转入 buffering
      //（open 本身随时可发；已放弃的段不等）。
      if (it.track === 'ui' && !isOpenOp(it.op) && !this.uiAbandoned && !uiHandleReady(it.op)) {
        if (this.uiBufferingSince === null) {
          this.uiBufferingSince = performance.now()
        }
        break
      }
      this.cursor++
      this.beginItem(p)
    }
  }

  private beginItem(p: PlaybackItem): void {
    const sid = this.sid
    const actions = this.actions
    if (!sid || !actions) return
    const it = p.item

    if (it.track === 'ui') {
      this.execUiOp(it, p)
      return
    }

    switch (it.op) {
      case 'user_message':
        actions.appendUserMessage(sid, it.content)
        break
      case 'turn_start':
        this.apply({ type: 'start', messageId: it.messageId })
        break
      case 'turn_end':
        this.apply({ type: 'end', messageId: it.messageId })
        break
      case 'text':
        this.inflight.push({
          kind: 'text',
          messageId: it.messageId,
          startV: p.startV,
          text: it.text,
          sent: 0,
          durMs: p.effDur
        })
        break
      case 'thinking':
        this.apply({ type: 'thinking_start', messageId: it.messageId })
        this.inflight.push({
          kind: 'thinking',
          messageId: it.messageId,
          startV: p.startV,
          text: it.text,
          sent: 0,
          durMs: p.effDur
        })
        break
      case 'tool': {
        this.apply({
          type: 'tool_use_start',
          messageId: it.messageId,
          toolUseId: it.toolUseId,
          toolName: it.toolName
        })
        const argsEff = Math.min(
          it.argsDurMs,
          it.argsJson.length * ARGS_MS_PER_CHAR,
          ARGS_MAX_MS
        )
        this.inflight.push({
          kind: 'tool',
          messageId: it.messageId,
          startV: p.startV,
          text: it.argsJson,
          sent: 0,
          durMs: argsEff,
          toolUseId: it.toolUseId,
          toolName: it.toolName,
          runDurMs: Math.min(it.runDurMs, RUN_MAX_MS),
          ...(it.result !== undefined ? { result: it.result } : {}),
          ...(it.tasks ? { tasks: it.tasks } : {}),
          phase: 'args',
          tasksEmitted: 0
        })
        break
      }
      default:
        break
    }
  }

  /** ui 轨表演步骤。面板整段不可用时置 uiAbandoned（下一个 open 复位）。
   *  三种表演（imageEdit/askQuestion/confirm）从不并发——同一时刻 cursor
   *  只指向一个 ui item，共用一个 uiAbandoned 标志是安全的。 */
  private execUiOp(it: ReplayUiItem, p: PlaybackItem): void {
    if (it.op === 'imageEdit.open') {
      // 新一段表演开演：复位放弃标记，打开右侧面板（store 驱动，组件挂载
      // 后读盘 → dataUrl 就绪才注册 demo handle，后续步骤靠 buffering 等它）。
      this.uiAbandoned = false
      useImageEditStore.getState().openEditor(it.path)
      return
    }
    if (it.op === 'askQuestion.open') {
      this.uiAbandoned = false
      const questions = parseAskUserQuestions(it.questionsJson)
      if (questions.length === 0) {
        // 解不出题目——没有面板可开，直接放弃这段表演。
        this.uiAbandoned = true
        return
      }
      useReplayStore.getState()._patch({
        activeQuestionsPanel: 'questionnaire',
        activeQuestions: questions
      })
      return
    }
    if (it.op === 'confirm.open') {
      // 面板挂载已经在 processItems 里幂等触发（confirm.open 不豁免
      // buffering，走到这里意味着 uiHandleReady 已经确认 handle 存在）。
      this.uiAbandoned = false
      const handle = getConfirmDemoHandle()
      if (!handle || !handle.open(it.toolUseId)) {
        // handle 存在但快照缺失（旧包/命中失败）——放弃这段表演，面板
        // 收起，回幻灯片 tab。
        this.uiAbandoned = true
        useReplayStore.getState()._patch({ activeQuestionsPanel: null })
      }
      return
    }
    if (this.uiAbandoned) return

    if (it.op.startsWith('imageEdit.')) {
      const handle = getImageEditDemoHandle()
      if (!handle && it.op !== 'imageEdit.close') {
        this.uiAbandoned = true
        return
      }
      switch (it.op) {
        case 'imageEdit.addMarker':
          handle!.addMarker(it.x, it.y, it.w, it.h)
          break
        case 'imageEdit.typeNote':
          this.inflight.push({
            kind: 'ui-note',
            messageId: '',
            startV: p.startV,
            text: it.text,
            sent: 0,
            durMs: p.effDur
          })
          break
        case 'imageEdit.commitMarker':
          handle!.commitDraft()
          break
        case 'imageEdit.typeExtra':
          this.inflight.push({
            kind: 'ui-extra',
            messageId: '',
            startV: p.startV,
            text: it.text,
            sent: 0,
            durMs: p.effDur
          })
          break
        case 'imageEdit.pressSend':
          handle!.pressSend()
          break
        case 'imageEdit.close':
          // pressSend 自带延迟关面板；这里兜底（表演被部分放弃时保证面板收场）。
          useImageEditStore.getState().closeEditor()
          break
        default:
          break
      }
      return
    }

    if (it.op.startsWith('askQuestion.')) {
      const handle = getQuestionDemoHandle()
      if (!handle) {
        this.uiAbandoned = true
        return
      }
      switch (it.op) {
        case 'askQuestion.select':
          handle.select(it.question, it.label)
          break
        case 'askQuestion.typeOther':
          this.inflight.push({
            kind: 'ui-question-other',
            messageId: '',
            startV: p.startV,
            text: it.text,
            sent: 0,
            durMs: p.effDur,
            question: it.question
          })
          break
        case 'askQuestion.submit':
          handle.submit()
          break
        default:
          break
      }
      return
    }

    if (it.op.startsWith('confirm.')) {
      const handle = getConfirmDemoHandle()
      if (!handle) {
        this.uiAbandoned = true
        return
      }
      switch (it.op) {
        case 'confirm.select':
          handle.selectField(it.field, it.value)
          break
        case 'confirm.typeText':
          this.inflight.push({
            kind: 'ui-confirm-text',
            messageId: '',
            startV: p.startV,
            text: it.text,
            sent: 0,
            durMs: p.effDur,
            field: it.field
          })
          break
        case 'confirm.advanceTier2':
          handle.advanceTier2()
          break
        case 'confirm.submitFinal':
          handle.submitFinal()
          // 表演落定——「问题」tab 短暂停留在 confirmed 视觉后自然回幻灯片
          // tab（工作区按 activeQuestionsPanel 判定，这里不立即清空，留给
          // SlidesWorkspace 展示 confirmed 终态；下一段 imageEdit/askQuestion/
          // confirm 的 open 会覆盖它）。
          break
        default:
          break
      }
      return
    }
  }

  /** 推进所有在飞块的切片/阶段（text chunk、tool args→run→result）。 */
  private advanceInflight(): void {
    const remaining: InflightBlock[] = []
    for (const b of this.inflight) {
      const alive = this.advanceBlock(b)
      if (alive) remaining.push(b)
    }
    this.inflight = remaining
  }

  /** 返回 false = 块已完成（从 inflight 移除）。 */
  private advanceBlock(b: InflightBlock): boolean {
    const progress =
      b.durMs <= 0 ? 1 : Math.min((this.virtualNow - b.startV) / b.durMs, 1)
    const target = Math.floor(b.text.length * progress)
    if (target > b.sent) {
      const delta = b.text.slice(b.sent, target)
      b.sent = target
      if (b.kind === 'text') {
        this.apply({ type: 'chunk', messageId: b.messageId, delta })
      } else if (b.kind === 'thinking') {
        this.apply({ type: 'thinking_delta', messageId: b.messageId, delta })
      } else if (b.kind === 'ui-note') {
        // 面板输入条是受控 value，不是流式追加——喂当前前缀全量。
        getImageEditDemoHandle()?.setDraftText(b.text.slice(0, target))
      } else if (b.kind === 'ui-extra') {
        getImageEditDemoHandle()?.setExtraText(b.text.slice(0, target))
      } else if (b.kind === 'ui-question-other') {
        getQuestionDemoHandle()?.typeOther(b.question!, b.text.slice(0, target))
      } else if (b.kind === 'ui-confirm-text') {
        getConfirmDemoHandle()?.typeField(b.field!, b.text.slice(0, target))
      } else {
        this.apply({
          type: 'tool_use_delta',
          messageId: b.messageId,
          toolUseId: b.toolUseId!,
          partialJson: delta
        })
      }
    }

    if (progress < 1) return true

    if (
      b.kind === 'text' ||
      b.kind === 'ui-note' ||
      b.kind === 'ui-extra' ||
      b.kind === 'ui-question-other' ||
      b.kind === 'ui-confirm-text'
    ) {
      return false
    }
    if (b.kind === 'thinking') {
      this.apply({ type: 'thinking_end', messageId: b.messageId })
      return false
    }

    // tool：args 流完 → 收口进入 run；run 期间子任务逐个亮起；到点落 result。
    if (b.phase === 'args') {
      this.apply({
        type: 'tool_use_end',
        messageId: b.messageId,
        toolUseId: b.toolUseId!
      })
      b.phase = 'run'
    }
    const runEnd = b.startV + b.durMs + (b.runDurMs ?? 0)
    if (b.tasks && b.tasks.length > 0) {
      // 子任务的 notification 均匀铺在 run 段内（live 时它们也是陆续到达的）。
      const span = Math.max(runEnd - (b.startV + b.durMs), 1)
      const due = Math.min(
        Math.floor(
          ((this.virtualNow - (b.startV + b.durMs)) / span) * b.tasks.length
        ) + 1,
        b.tasks.length
      )
      for (let i = b.tasksEmitted ?? 0; i < due; i++) {
        const t = b.tasks[i]
        this.apply({
          type: 'task_update',
          phase: 'notification',
          taskId: t.taskId,
          toolUseId: b.toolUseId,
          status: t.status,
          ...(t.summary !== undefined ? { summary: t.summary } : {}),
          ...(t.result !== undefined ? { result: t.result } : {}),
          ...(t.outputFile !== undefined ? { outputFile: t.outputFile } : {})
        } as ChatEvent)
        b.tasksEmitted = i + 1
      }
    }
    if (this.virtualNow < runEnd) return true
    if (b.result !== undefined) {
      this.apply({
        type: 'tool_result',
        messageId: b.messageId,
        toolUseId: b.toolUseId!,
        toolName: b.toolName!,
        output: b.result
      } as ChatEvent)
    }
    return false
  }

  private apply(event: ChatEvent): void {
    if (!this.sid || !this.actions) return
    // live=null：回放关断全部真实副作用（方案模式/unread/队列/历史缓存），
    // 见 applyChatEventToStore 头注释。
    applyChatEventToStore(this.sid, event, this.actions, this.ctx, null)
  }

  /* ─────────── 虚拟时间轴预计算（shared/replayTiming，main 侧时长角标同源） ─────────── */

  private prepareTimeline(items: ReplayItem[]): void {
    const { schedule, durationMs } = buildPlaybackSchedule(items)
    this.items = schedule
    this.durationMs = durationMs
  }
}

export const ReplayController = new ReplayControllerImpl()

// dev 调试口：配合 `window.chatApi.openReplay({path})` 可在 DevTools 里
// 全流程驱动回放（openReplay 的显式 path 分支不弹对话框），端到端排查
// 不必反复点菜单。prod 构建裁掉。
if (process.env.NODE_ENV !== 'production' && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__replayController =
    ReplayController
}
