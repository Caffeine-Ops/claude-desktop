import { useChatStore } from '../stores/chat'
import { useWritingStore } from '../stores/writing'
import { dispatchChatTurn } from './dispatchChatTurn'

/**
 * 从写作纸面的选区气泡程序化发起一条改写请求。
 *
 * 结构照搬 `sendProposalStageMessage`（同样是「面板里的按钮要发一轮对话，但拿不到
 * assistant-ui composer 的 onNew 闭包」），但**刻意不复用它**：那个函数会读写 proposal
 * store 并带上 proposalMode / proposalProducts / proposalRetrieve，会让这一轮落进方案
 * 进程、AI 拿到一整套方案纪律。写作改写要的就是一轮**普通聊天轮**，payload 只有
 * sessionId + text。
 *
 * 会话一致性校验（与 proposal 同一理由）：写作工作区绑定的会话必须就是当前前台会话，
 * 否则这条改写会发进别的 tab 的会话里——用户在 A 窗口选中的段落，改写请求跑去 B 窗口，
 * B 的正文可能被改坏。
 *
 * 返回值 = 这一轮到底有没有发出去。调用方（submitRevision）据此决定要不要把
 * `pendingRevision` 收回来——没发出去却留着 pending，那条改写会永远停在「等 AI 回复」，
 * 后面排队的也跟着停摆（排空 effect 以 pendingRevision 为闸）。
 */
export async function sendWritingMessage(text: string): Promise<boolean> {
  const ws = useWritingStore.getState()
  const chat = useChatStore.getState()
  const sid = ws.sessionId
  if (sid === null || chat.sessionId !== sid) {
    // 诊断：这里静默 no-op 是「点了改写没反应」的头号落点——写作会话与前台会话漂移了。
    // 不打日志排查无从下手（proposal 那份的注释就是这么写的，这里同款）。
    console.warn('[writing-revise] 跳过发送：写作会话与前台会话不一致', {
      writingSid: sid,
      chatSid: chat.sessionId
    })
    return false
  }

  await dispatchChatTurn({
    sessionId: sid,
    storeContent: [{ type: 'text', text }],
    logTag: '[writing-revise]',
    payload: { sessionId: sid, text }
  })
  return true
}
