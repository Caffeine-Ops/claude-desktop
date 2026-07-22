/**
 * ChatEvent → chat-store mutation 的核心分发器（原 FusionRuntimeProvider.
 * makeSessionEventHandler 的 switch 主体，机械搬移至此）。
 *
 * 为什么抽出来：live 流（CHAT_EVENT IPC）与会话回放（.claudereplay 演示）要吃
 * 同一套「事件 → store 增量」语义——回放 driver 合成 ChatEvent 后直接调本函数，
 * 与真实流式渲染像素级一致。两条路径的差异全部收敛在 `live` 参数：
 *
 *   - live = LiveHooks：真实会话。队列气泡补发、历史缓存失效、方案模式全链路
 *     （硬门 abort / 轮内草稿同步 / 轮末入库）、后台未读、队列镜像照常工作。
 *   - live = null：回放模式。上述副作用整体关断——它们要么会发真 IPC
 *     （chatApi.abort）、要么污染持久状态（unread / 方案草稿 / 历史缓存），
 *     在「假 session 表演」里都不该发生。
 *
 * TodoWrite → useTodosStore 刻意【留在 core】而不进 LiveHooks：右栏 todos 是
 * 回放要重现的表演内容（按 sid 隔离，replay: 前缀的 slot 退出时由 driver 清理），
 * 且它不发 IPC、无持久副作用。
 */
import type { ChatEvent } from '@desktop-shared/types'
import {
  useTodosStore,
  extractTodoWriteItems,
  parsePartialToolArgs
} from '../stores/todos'

/** chat store 的 15 个增量 setter（调用方从 useChatStore 取出后注入）。 */
export interface ChatEventActions {
  appendUserMessage: (
    sid: string,
    content: Array<{ type: string; [key: string]: unknown }>
  ) => void
  startAssistantMessage: (sid: string, messageId: string) => void
  appendAssistantDelta: (sid: string, messageId: string, delta: string) => void
  startReasoning: (sid: string, messageId: string) => void
  appendThinkingDelta: (sid: string, messageId: string, delta: string) => void
  startToolCall: (
    sid: string,
    messageId: string,
    toolUseId: string,
    toolName: string
  ) => void
  appendToolCallArgsDelta: (
    sid: string,
    toolUseId: string,
    delta: string
  ) => void
  finalizeToolCall: (sid: string, toolUseId: string) => void
  addToolCall: (
    sid: string,
    messageId: string,
    toolUseId: string,
    toolName: string,
    input: unknown
  ) => void
  updateToolCallResult: (sid: string, toolUseId: string, output: unknown) => void
  updateToolCallTasks: (
    sid: string,
    ev: Extract<ChatEvent, { type: 'task_update' }>
  ) => void
  setRetryInfo: (
    sid: string,
    ev: Extract<ChatEvent, { type: 'retry' }> | null
  ) => void
  setError: (sid: string, messageId: string, error: string) => void
  endAssistantMessage: (sid: string) => void
  setUsage: (
    sid: string,
    usage: {
      contextTokens: number
      outputTokens: number
      inputTokens: number
      cacheReadTokens: number
      cacheCreateTokens: number
    }
  ) => void
}

/**
 * 每个消费者实例（= 一个订阅 / 一次回放）私有的累加状态。owns per-tool-use
 * state，并发会话流式 TodoWrite 时互不串扰（原 makeSessionEventHandler 闭包
 * 里的三个容器，语义原样保留）。
 */
export interface ChatEventCtx {
  /** toolUseId → toolName（tool_use_delta/end 阶段回查工具名）。 */
  toolNames: Map<string, string>
  /** toolUseId → 累积的 partial JSON（TodoWrite 流式解析缓冲）。 */
  argsBuffers: Map<string, string>
  /** 方案流式硬门：每条 messageId 至多 abort 一次的去重集。 */
  tocGuardAborted: Set<string>
}

export function createChatEventCtx(): ChatEventCtx {
  return {
    toolNames: new Map(),
    argsBuffers: new Map(),
    tocGuardAborted: new Set()
  }
}

/**
 * live 会话专属的副作用挂钩。回放传 null 整体关断。
 * 各方法的语义/时序契约见 applyChatEventToStore 内各调用点注释——调用顺序与
 * 抽取前的原文完全一致，不要改动相对位置。
 */
export interface LiveHooks {
  /** 'start'：取出（并移除）该轮暂存的队列 user 气泡内容；普通轮返回 undefined。 */
  takeQueuedTurn: (
    sid: string,
    messageId: string
  ) => Array<{ type: string; [key: string]: unknown }> | undefined
  /** 'start'：transcript 即将增长，作废该会话的历史快照缓存。 */
  invalidateHistoryCache: (sid: string) => void
  /** 'chunk'：方案模式流式硬门（内部可能发真 chatApi.abort）。 */
  maybeAbortOnTocSkip: (
    sid: string,
    messageId: string,
    aborted: Set<string>
  ) => void
  /** AskUserQuestion 出现时的方案轮内草稿同步。 */
  syncProposalDraftFromInflight: (sid: string, messageId: string) => void
  /**
   * 'end'：方案草稿轮末入库/修订分流的整块处理（原 'end' case 的 try 体）。
   * 抛错由 core 兜住——endAssistantMessage 的 finally 不变量在 core 保证。
   */
  onTurnEnd: (sid: string, messageId: string) => void
  /** 'end' 尾：本轮在后台结束时给 rail 打未读点（前台判断在实现方内部做）。 */
  markUnreadIfBackground: (sid: string) => void
  /**
   * 'error'：本轮以失败收场（子进程崩溃/abort/超时）后的清尾钩子——目前承载选区
   * 改写排队的排空（drainRevisionQueue），与 'end' 分支对称：起飞的排队改写若在此
   * 不补排空，队列剩余项会永久停摆。sid/messageId 均透传，供未来扩展按会话/消息
   * 定位；当前实现只用 sid。
   */
  onTurnError: (sid: string, messageId: string) => void
  /** 'queue_changed'：main 的权威队列快照整体覆盖本地镜像。 */
  onQueueChanged: (
    sid: string,
    queue: Extract<ChatEvent, { type: 'queue_changed' }>['queue']
  ) => void
}

export function applyChatEventToStore(
  sid: string,
  event: ChatEvent,
  actions: ChatEventActions,
  ctx: ChatEventCtx,
  live: LiveHooks | null
): void {
  const { toolNames, argsBuffers, tocGuardAborted } = ctx
  switch (event.type) {
    case 'start': {
      // If this turn was drained from the queue, its user bubble was
      // withheld from the transcript until now (see rememberQueuedTurn).
      // Replay it just before opening the assistant bubble so the pair
      // appears together and in order. Ordinary idle turns stashed
      // nothing here — the composer already appended their user bubble.
      const queuedContent = live?.takeQueuedTurn(sid, event.messageId)
      if (queuedContent) {
        actions.appendUserMessage(sid, queuedContent)
      }
      // A new assistant turn is starting → this session's transcript is
      // about to grow. Drop any cached history snapshot so the next
      // switch-back re-reads fresh JSONL instead of the pre-turn copy.
      live?.invalidateHistoryCache(sid)
      actions.startAssistantMessage(sid, event.messageId)
      break
    }
    case 'chunk':
      actions.appendAssistantDelta(sid, event.messageId, event.delta)
      // 流式硬门（方案模式）：目录阶段若 AI 跳过确认、刚冒出正文哨兵，立即 abort
      // 本轮，避免它跑飞整篇正文（见 maybeAbortOnTocSkip）。非方案/正文阶段内部
      // 短路，开销可忽略。
      live?.maybeAbortOnTocSkip(sid, event.messageId, tocGuardAborted)
      break
    case 'thinking_start':
      actions.startReasoning(sid, event.messageId)
      break
    case 'thinking_delta':
      actions.appendThinkingDelta(sid, event.messageId, event.delta)
      break
    case 'thinking_end':
      break
    case 'tool_use_start':
      toolNames.set(event.toolUseId, event.toolName)
      argsBuffers.set(event.toolUseId, '')
      actions.startToolCall(sid, event.messageId, event.toolUseId, event.toolName)
      if (event.toolName === 'TodoWrite') {
        useTodosStore.getState().setTodos(sid, [])
      }
      // 方案模式：AI 生成封面/目录后用 AskUserQuestion 暂停确认，此刻把已闭合的哨兵块即时
      // 同步进右侧草稿——否则要等整轮 'end' 才入库，确认期间右侧一直空着。
      // 封面文本块先于本工具调用流完，故此时已在 store。幂等（内容级去重），与轮末不冲突。
      if (event.toolName === 'AskUserQuestion') {
        live?.syncProposalDraftFromInflight(sid, event.messageId)
      }
      break
    case 'tool_use_delta': {
      actions.appendToolCallArgsDelta(sid, event.toolUseId, event.partialJson)
      const toolName = toolNames.get(event.toolUseId)
      if (toolName !== 'TodoWrite') break
      const prev = argsBuffers.get(event.toolUseId) ?? ''
      const next = prev + event.partialJson
      argsBuffers.set(event.toolUseId, next)
      const parsed = parsePartialToolArgs(next)
      if (parsed !== null) {
        const items = extractTodoWriteItems(parsed, /* partial */ true)
        if (items) {
          useTodosStore.getState().setTodos(sid, items)
        }
      }
      break
    }
    case 'tool_use_end':
      actions.finalizeToolCall(sid, event.toolUseId)
      if (toolNames.get(event.toolUseId) === 'TodoWrite') {
        const text = argsBuffers.get(event.toolUseId) ?? ''
        try {
          const final = JSON.parse(text)
          const items = extractTodoWriteItems(final, /* partial */ false)
          if (items) {
            useTodosStore.getState().setTodos(sid, items)
          }
        } catch {
          // Keep whatever the partial parser produced last.
        }
      }
      toolNames.delete(event.toolUseId)
      argsBuffers.delete(event.toolUseId)
      break
    case 'tool_use':
      actions.addToolCall(
        sid,
        event.messageId,
        event.toolUseId,
        event.toolName,
        event.input
      )
      if (event.toolName === 'TodoWrite') {
        const items = extractTodoWriteItems(event.input)
        if (items) {
          useTodosStore.getState().setTodos(sid, items)
        }
      }
      // 同 tool_use_start：非流式 tool_use 路径也兜一道 AskUserQuestion 轮内同步（两条路径
      // 互斥触发，幂等故双触发也无害）。
      if (event.toolName === 'AskUserQuestion') {
        live?.syncProposalDraftFromInflight(sid, event.messageId)
      }
      break
    case 'tool_result':
      actions.updateToolCallResult(sid, event.toolUseId, event.output)
      break
    case 'task_update':
      // Workflow/Task subagent lifecycle — merge into the spawning
      // Task card's sub-task list. Routed by toolUseId/taskId inside
      // the store, independent of any active assistant turn.
      actions.updateToolCallTasks(sid, event)
      break
    case 'retry':
      // SDK transport-level auto-retry (502/529/rate-limit), fired
      // before any assistant content streams. Each attempt overwrites
      // the previous snapshot; 'start'/'end' clear it (see setRetryInfo
      // callers in chat.ts) so it can't outlive the pre-content gap.
      actions.setRetryInfo(sid, event)
      break
    case 'usage':
      actions.setUsage(sid, {
        contextTokens: event.contextTokens,
        outputTokens: event.outputTokens,
        inputTokens: event.inputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreateTokens: event.cacheCreateTokens
      })
      break
    case 'end':
      // 防御性兜底（不变量，抽取后依然由 core 而非 hooks 实现方保证）：
      // live.onTurnEnd（方案草稿轮末处理，抽取/入库/校验）一旦同步抛错，绝不能漏掉
      // 清 spinner 的 endAssistantMessage——否则 streaming 永远停在 true，聊天气泡的
      // ThinkingSpinner 与右栏「AI 生成中」两处 loading 都永久搁浅（「永远在思考」）。
      // 故 try 包 hook、endAssistantMessage 落在 finally；catch 只记日志、不重抛。
      try {
        live?.onTurnEnd(sid, event.messageId)
      } catch (err) {
        console.error(
          '[runtime] proposal end-handler threw (草稿可能未入库，turn 状态照常复位):',
          err
        )
      } finally {
        actions.endAssistantMessage(sid)
      }
      // Unread: a reply just finished. If the user isn't currently
      // looking at this session flag it unread so the rail shows a dot.
      // 前台判断在 hook 实现方内部做（读 store 的实时前台 id）。
      live?.markUnreadIfBackground(sid)
      break
    case 'error':
      actions.setError(sid, event.messageId, event.error)
      actions.endAssistantMessage(sid)
      live?.onTurnError(sid, event.messageId)
      break
    case 'queue_changed':
      // Authoritative queue snapshot from main — overwrite the local
      // mirror wholesale. Fires on enqueue, post-result promotion, and
      // every panel edit/remove/reorder. Independent of any active
      // turn, so it lives outside the `actions.*` (chat-store) surface.
      live?.onQueueChanged(sid, event.queue)
      break
    default:
      break
  }
}
