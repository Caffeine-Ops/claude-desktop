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
  if (ps.sections.some((s) => s.kind === kind)) return null
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
    if (extractProposalDraftResult(text).blocks.some((b) => b.kind === kind)) return null
  }
  const label = kind === 'cover' ? '封面' : '目录'
  const corrective =
    `【系统拦截·${label}尚未收到】右侧方案文档没有收到${label}——你只是在确认卡里描述了${label}，` +
    `并没有把${label}内容真正输出到消息里。请立即把完整的${label} markdown 包在哨兵 ` +
    `${PROPOSAL_DRAFT_BEGIN[kind]} 与 ${PROPOSAL_DRAFT_END[kind]} 之间输出（两行哨兵各自独立成行），` +
    `然后再重新发起「${label}确认」。`
  // 该调用里的每个问题都填同一句纠偏（阶段确认通常只有一个问题；万一模型把别的问题捆在
  // 同一次调用里，统一打回让它重新问，比留一半悬空更干净）。
  const answers: Record<string, string> = {}
  for (const q of questionTexts(req.input)) answers[q] = corrective
  return { answers }
}
