import { dispatchChatTurn } from './dispatchChatTurn'
import { useChatStore } from '../stores/chat'

/**
 * 「回复中断」提示条的重试动作：取出上一轮的原始载荷（store 同时删掉失败的 AI 气泡、
 * 清掉标记），不追加用户气泡，走公共发送序列原样再发一次。再失败会再次落成错误气泡 +
 * 重试条，用户可以一直点。
 */
export async function retryFailedTurn(sessionId: string): Promise<void> {
  const payload = useChatStore.getState().takeFailedTurnForRetry(sessionId)
  if (!payload) return
  await dispatchChatTurn({ sessionId, storeContent: null, payload, logTag: '[retry]' })
}
