import { useChatStore } from '../stores/chat'
import { useProposalStore } from '../stores/proposal'
import { dispatchChatTurn } from './dispatchChatTurn'

/**
 * 从草稿面板的「阶段按钮」程序化发起一条方案推进消息（如「封面已确认，请生成目录」）。
 *
 * 为什么不复用 assistant-ui composer 的 onNew：那是 ComposerRuntime 适配器闭包，按钮
 * 拿不到。改走与 onNew 共享的 dispatchChatTurn——append 用户气泡 + 预翻转 spinner +
 * window.chatApi.send + 失败兜底统一在一处，且带 proposalMode/products，使该轮落在方案
 * 进程、AI 拿到方案纪律。
 *
 * 前置：方案已 active 且已播种（按钮只在工作台里、首发之后出现，products 已定），故
 * 直接复用 ps.products，不再 readKbIndex/matchProducts。非方案前台调用是 no-op。
 */
export async function sendProposalStageMessage(
  text: string,
  opts?: { displayText?: string }
): Promise<void> {
  const ps = useProposalStore.getState()
  const chat = useChatStore.getState()
  const sid = ps.sessionId
  // 仅当方案会话就是当前前台会话才发（防泄漏到别的 tab/会话）。
  if (!ps.active || sid === null || chat.sessionId !== sid) {
    // 诊断：这里静默 no-op 是「点了改写没反应」的一种落点——方案会话与前台会话漂移了。
    console.warn('[proposal-stage] 跳过发送：方案会话与前台会话不一致', {
      active: ps.active,
      proposalSid: sid,
      chatSid: chat.sessionId
    })
    return
  }

  await dispatchChatTurn({
    sessionId: sid,
    storeContent: [{ type: 'text', text: opts?.displayText ?? text }],
    logTag: '[proposal-stage]',
    payload: {
      sessionId: sid,
      text,
      proposalMode: true,
      proposalProducts: ps.products,
      // 内容级召回（#2）：封面阶段外都开（phase !== 'cover'，即目录+正文）。原先卡死
      // phase==='content'，但 phase 只在点阶段按钮时才前进——用户【手敲】推进语（而非点
      // 按钮）时 phase 滞后，首个正文回合会漏召回（实测踩到）。放宽到「非封面」后，无论
      // 点按钮还是手敲，进了目录/正文都触发；封面回合（首发播种、问客户名）仍不召回。
      // 安全保底：召回零命中时不注入（renderRetrievedBlock 返回空串），偶尔在目录回合触发亦无害。
      proposalRetrieve: ps.phase !== 'cover'
    }
  })
}
