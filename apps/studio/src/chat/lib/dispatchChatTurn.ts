import type { ChatSendPayload } from '@desktop-shared/ipc-channels'
import { useChatStore } from '../stores/chat'

// appendUserMessage 的 content 入参类型（ContentPart[]）。从 store action 推导，免去把
// ContentPart 从 chat.ts 导出（它本是 store 的内部类型）。
type UserStoreContent = Parameters<
  ReturnType<typeof useChatStore.getState>['appendUserMessage']
>[1]

/**
 * 发起一轮对话的公共序列：append 用户气泡 → 预翻转 spinner → chatApi.send → 失败兜底。
 *
 * composer 的 onNew（FusionRuntimeProvider）与草稿面板的「阶段按钮」
 * （sendProposalStageMessage）此前各自手抄这段、且已分叉。抽到一处：发送契约 / 预翻转
 * 协议 / 错误气泡若要改只改这里，两条路径不再静默漂移（评审发现 10）。
 *
 * payload 允许是 thunk：onNew 需在【预翻转之后】再异步求值（方案首发要先 readKbIndex +
 * 匹配产品），用 thunk 保住「spinner 立刻亮、产品匹配在其后」的原时序；thunk 抛错也照样
 * 落进下面的 catch 兜底，与原行为一致。
 */
export async function dispatchChatTurn(opts: {
  sessionId: string
  storeContent: UserStoreContent
  payload: ChatSendPayload | (() => Promise<ChatSendPayload>)
  logTag?: string
}): Promise<void> {
  const { sessionId, storeContent, payload, logTag = '[chat]' } = opts
  const chat = useChatStore.getState()
  chat.appendUserMessage(sessionId, storeContent)
  // 预翻转 spinner：startAssistantMessage 幂等，真正的 'start' 事件到达时对 turn meta 是 no-op。
  chat.startAssistantMessage(sessionId, `pending_${Date.now()}`)
  try {
    const p = typeof payload === 'function' ? await payload() : payload
    await window.chatApi.send(p)
  } catch (err) {
    console.error(`${logTag} send failed`, err)
    // 把失败挂到一个合成 assistant 消息上，让用户看到错误而非静默。幂等的
    // startAssistantMessage 不会覆盖上面预翻转设的 turn meta。
    const errMessageId = `err_${Date.now()}`
    chat.startAssistantMessage(sessionId, errMessageId)
    chat.setError(sessionId, errMessageId, err instanceof Error ? err.message : String(err))
    chat.endAssistantMessage(sessionId)
  }
}
