// 阶段确认硬门（GUI 走查实锤的缺陷）：模型可能在【根本没输出封面/目录哨兵块】的情况下，
// 直接空口发起「封面确认/目录确认」的 AskUserQuestion——transcript 里只有 thinking 与工具调用、
// 没有一个字的哨兵文本（它把封面"写"在确认卡的问题描述里就当交差了）。用户看到右侧文档空白、
// 确认卡却说「封面已生成」，只能取消重开会话，一天连开三个会话都倒在同一步。
//
// 提示词早已写明「先输出哨兵块、后发确认」，但提示词管不住（目录跳阶的硬门是同一个教训：
// 软约束必须配硬门）。这里的硬门做在权限请求到达点：阶段确认的 AskUserQuestion 到达时，若
// 右侧草稿里没有对应 kind 的节、且在飞 assistant 文本里也扫不出闭合哨兵块，就【不给用户渲染
// 确认卡】，直接用纠偏文本自动作答打回——模型读到 tool_result 里的纠偏指令，补写哨兵块后
// 重新发起确认。误拦的最坏代价：封面/目录是单例 kind（appendDraftBlocks 替换而非追加），
// 模型重输出一遍也只是原地覆盖，无重复风险。
import {
  PROPOSAL_COVER_CONFIRM_HEADER,
  PROPOSAL_TOC_CONFIRM_HEADER,
  PROPOSAL_DRAFT_BEGIN,
  PROPOSAL_DRAFT_END,
  extractProposalDraftResult,
  type ProposalKind
} from '@shared/proposal'
import type { PermissionRequest } from '../../../shared/types'
import { useProposalStore } from '../stores/proposal'
import { useChatStore } from '../stores/chat'
import { sendProposalStageMessage } from './sendProposalStageMessage'

// 本会话内被硬门拦截过的阶段（sessionId → kind）。给轮末兜底催促用：拦截后模型可能补写了
// 哨兵块却【没有】重新发起确认就结束回合（GUI 走查实锤：模型自创「工具调用前的文字送不到
// 文档」的错误理论，故意把封面当最后一条消息输出、想下一轮再确认——回合结束它就没有下一轮
// 了，流程停摆）。每次拦截登记一次、轮末消费一次，绝不循环催促。
const interceptedStage = new Map<string, Extract<ProposalKind, 'cover' | 'toc'>>()

/** 从 AskUserQuestion input 里找阶段确认 header，映射到它宣称已完成的节 kind。 */
function confirmKindFromInput(input: unknown): Extract<ProposalKind, 'cover' | 'toc'> | null {
  if (!input || typeof input !== 'object') return null
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return null
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const header = (q as Record<string, unknown>).header
    if (header === PROPOSAL_COVER_CONFIRM_HEADER) return 'cover'
    if (header === PROPOSAL_TOC_CONFIRM_HEADER) return 'toc'
  }
  return null
}

function questionTexts(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const question = (q as Record<string, unknown>).question
    if (typeof question === 'string' && question) out.push(question)
  }
  return out
}

/**
 * 阶段确认硬门判定。返回 null=放行（照常渲染确认卡）；返回 answers=拦截（调用方直接以
 * allow-once + 该 answers 应答，确认卡不渲染，模型收到纠偏指令）。
 */
export function interceptPrematureStageConfirm(
  req: PermissionRequest
): { answers: Record<string, string> } | null {
  if (req.toolName !== 'AskUserQuestion') return null
  const ps = useProposalStore.getState()
  // 仅方案会话生效，绝不污染普通会话的 AskUserQuestion。
  if (!ps.active || ps.sessionId !== req.sessionId) return null
  const kind = confirmKindFromInput(req.input)
  if (!kind) return null
  if (ps.sections.some((s) => s.kind === kind)) {
    // 确认卡即将正常渲染——若本会话此前有过拦截登记，任务已完成，清掉它。否则「拦截→模型
    // 正确补发确认→用户点确认→本轮末」这条正常收尾路径上，残留登记会让轮末兜底误催一次
    // 「请发起确认」（用户明明刚确认完）。
    interceptedStage.delete(req.sessionId)
    return null
  }
  // 权限事件与聊天 chunk 事件到达顺序无保证：sections 里没有 ≠ 模型没写。放行前直接扫本会话
  // assistant 消息文本抢救一次——真有闭合哨兵块就放行（随后的 tool_use_start 轮内同步 / 轮末
  // end 会把它收进 sections）。消息量是「本会话轮数」级，includes 快路径先挡，代价可忽略。
  const slot = useChatStore.getState().perSession[req.sessionId]
  for (const m of slot?.messages ?? []) {
    const msg = m as { role?: string; content?: Array<{ type: string; text?: string }> }
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    const text = msg.content
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text!)
      .join('')
    if (!text.includes(PROPOSAL_DRAFT_BEGIN[kind])) continue
    if (extractProposalDraftResult(text).blocks.some((b) => b.kind === kind)) {
      interceptedStage.delete(req.sessionId) // 同上：放行即清登记
      return null
    }
  }
  const label = kind === 'cover' ? '封面' : '目录'
  const corrective =
    `【系统拦截·${label}尚未收到】右侧方案文档没有收到${label}——你只是在确认卡里描述了${label}，` +
    `并没有把${label}内容真正输出到消息里。请立即把完整的${label} markdown 包在哨兵 ` +
    `${PROPOSAL_DRAFT_BEGIN[kind]} 与 ${PROPOSAL_DRAFT_END[kind]} 之间输出（两行哨兵各自独立成行），` +
    `然后【在同一轮里紧接着】重新发起「${label}确认」。注意：同一条回复里先输出哨兵块、随后再调用 ` +
    `AskUserQuestion 完全没问题——系统按内容识别，与先后顺序无关；不要为「确保送达」而输出完就结束` +
    `回合，回合一结束你就无法发起确认了。`
  // 登记拦截，供轮末兜底催促（见 maybeNudgeStageConfirmAfterTurn）。
  interceptedStage.set(req.sessionId, kind)
  // 该调用里的每个问题都填同一句纠偏（阶段确认通常只有一个问题；万一模型把别的问题捆在
  // 同一次调用里，统一打回让它重新问，比留一半悬空更干净）。
  const answers: Record<string, string> = {}
  for (const q of questionTexts(req.input)) answers[q] = corrective
  return { answers }
}

/**
 * 轮末兜底催促：本轮发生过硬门拦截，且轮结束时对应节已经到位、阶段还停在待确认，说明模型
 * 「补写了内容但没重新发确认」就收工了——自动补发一条催促指令让它发起确认卡。
 *
 * 单发保险：登记在拦截时、消费在紧随其后的第一个 'end'，随手 delete——每次拦截至多催一炮，
 * 绝不与模型来回循环。模型这轮若已正确补发确认卡，AskUserQuestion 会阻塞在 canUseTool、
 * 'end' 根本不会触发，本函数天然不会误催（因此这里不需要、也不能去查 permission store——
 * permissions.ts 引用本模块，反向引用会成环）。
 */
export function maybeNudgeStageConfirmAfterTurn(sessionId: string): void {
  const kind = interceptedStage.get(sessionId)
  if (!kind) return
  interceptedStage.delete(sessionId)
  const ps = useProposalStore.getState()
  if (!ps.active || ps.sessionId !== sessionId) return
  // 节还没到位=模型连补写都没做，催「发确认」没有意义（它该做的是补写，纠偏文本已经说了）。
  if (!ps.sections.some((s) => s.kind === kind)) return
  // 阶段已过门（封面确认放行不动 phase、目录块落地才推 toc；目录确认放行推 content）→ 不催。
  if (kind === 'cover' && ps.phase !== 'cover') return
  if (kind === 'toc' && ps.phase !== 'toc') return
  const label = kind === 'cover' ? '封面' : '目录'
  console.warn('[proposal-stage-gate] 拦截后模型未重新发起确认，自动催促', { sessionId, kind })
  void sendProposalStageMessage(
    `${label}已收到、已显示在右侧文档里。请现在【立即】用 AskUserQuestion 工具发起「${label}确认」` +
      `（header 固定「${label}确认」，第 1 个选项为确认放行项）。不要重复输出${label}，也不要在用户` +
      `确认前写下一阶段的内容。`,
    { displayText: `${label}已收到，请发起${label}确认` }
  )
}
