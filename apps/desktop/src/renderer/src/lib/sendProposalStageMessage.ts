import { useChatStore } from '../stores/chat'
import { useProposalStore } from '../stores/proposal'

/**
 * 从草稿面板的「阶段按钮」程序化发起一条方案推进消息（如「封面已确认，请生成目录」）。
 *
 * 为什么不复用 assistant-ui composer 的 onNew：那是 ComposerRuntime 适配器闭包，按钮
 * 拿不到。这里直接走与 onNew 等价的最小路径——append 用户气泡 + 预翻转 spinner +
 * window.chatApi.send，且带 proposalMode/products，使该轮落在方案进程、AI 拿到方案纪律。
 *
 * 前置：方案已 active 且已播种（按钮只在工作台里、首发之后出现，products 已定），故
 * 直接复用 ps.products，不再 readKbIndex/matchProducts。非方案前台调用是 no-op。
 */
export async function sendProposalStageMessage(text: string): Promise<void> {
  const ps = useProposalStore.getState()
  const chat = useChatStore.getState()
  const sid = ps.sessionId
  // 仅当方案会话就是当前前台会话才发（防泄漏到别的 tab/会话）。
  if (!ps.active || sid === null || chat.sessionId !== sid) return

  chat.appendUserMessage(sid, [{ type: 'text', text }])
  // 预翻转 spinner：与 composer 一致，避免冷启动期间界面静默。startAssistantMessage
  // 幂等，真正的 start 事件到达时对 turn meta 是 no-op。
  const pendingMessageId = `pending_${Date.now()}`
  chat.startAssistantMessage(sid, pendingMessageId)
  try {
    await window.chatApi.send({
      sessionId: sid,
      text,
      proposalMode: true,
      proposalProducts: ps.products
    })
  } catch (err) {
    console.error('[proposal-stage] send failed', err)
    const errMessageId = `err_${Date.now()}`
    chat.startAssistantMessage(sid, errMessageId)
    chat.setError(sid, errMessageId, err instanceof Error ? err.message : String(err))
    chat.endAssistantMessage(sid)
  }
}
