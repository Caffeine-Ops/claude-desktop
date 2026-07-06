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
} from '@desktop-shared/proposal'
import type { PermissionRequest } from '@desktop-shared/types'
import { useProposalStore } from '../stores/proposal'
import { useChatStore } from '../stores/chat'
import { sendProposalStageMessage } from './sendProposalStageMessage'

// 已催促过的节（`${sessionId}#${kind}#${sectionId}`）——轮末兜底的单发保险。按【节 id】而非
// 会话：「新建方案」复用同一 sessionId 但节 id 全新，新草稿的兜底不被旧草稿的已催记录殃及。
const nudgedSections = new Set<string>()

// 纠偏回执的识别标记：轮末兜底扫聊天记录时，带这个前缀的 AskUserQuestion 结果=被硬门打回的
// 空口确认，不算「真问过用户」。与下方 corrective 文案的前缀保持一致。
const INTERCEPT_MARK = '【系统拦截·'

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
    `然后【在同一轮里紧接着】重新发起「${label}确认」。注意：同一条回复里先输出哨兵块、随后再调用 ` +
    `AskUserQuestion 完全没问题——系统按内容识别，与先后顺序无关；不要为「确保送达」而输出完就结束` +
    `回合，回合一结束你就无法发起确认了。`
  // 该调用里的每个问题都填同一句纠偏（阶段确认通常只有一个问题；万一模型把别的问题捆在
  // 同一次调用里，统一打回让它重新问，比留一半悬空更干净）。
  const answers: Record<string, string> = {}
  for (const q of questionTexts(req.input)) answers[q] = corrective
  return { answers }
}

// tool-call part 的 args 两种形态并存（流式路径先攒 JSON 串、非流式直接对象），统一解出对象。
function toolCallArgs(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  return raw
}

/**
 * 本会话聊天记录里是否已经出现过一张【真正渲染给用户】的 kind 阶段确认卡。
 * 判据：assistant 消息里的 AskUserQuestion tool-call、header 命中该阶段确认常量、且其结果
 * 不是硬门的纠偏回执（带 INTERCEPT_MARK 前缀的=被打回的空口确认，不算问过）。pending 未答、
 * 已答、用户点取消都算「问过」——问过而用户不选放行项，是用户的决定，兜底不越俎代庖。
 */
function hasRenderedStageConfirm(
  sessionId: string,
  kind: Extract<ProposalKind, 'cover' | 'toc'>
): boolean {
  const slot = useChatStore.getState().perSession[sessionId]
  for (const m of slot?.messages ?? []) {
    const msg = m as { role?: string; content?: unknown }
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as Array<Record<string, unknown>>) {
      if (part.type !== 'tool-call' || part.toolName !== 'AskUserQuestion') continue
      if (confirmKindFromInput(toolCallArgs(part.args)) !== kind) continue
      const result =
        typeof part.result === 'string' ? part.result : JSON.stringify(part.result ?? '')
      if (result.includes(INTERCEPT_MARK)) continue
      return true
    }
  }
  return false
}

/**
 * 轮末兜底催促（用户明确预期：封面/目录落地后【必须】弹确认卡）：轮结束时若某阶段的节已经
 * 到位、阶段还停在待确认、而聊天记录里找不到一张真正渲染过的该阶段确认卡，就自动补发一条
 * 催促让模型发卡。两种停摆都覆盖：①空口确认被硬门打回后，模型补写了节却不重发确认就收工
 * （GUI 走查实锤：模型自创「工具调用前的文字送不到文档」的错误理论，故意把封面当最后一条
 * 消息输出、想「下一轮」再确认——回合结束它没有下一轮）；②模型输出节后压根没尝试发确认。
 *
 * 防循环三道保险：nudgedSections 按节 id 单发（催一次后模型再摆烂也不再催，避免烧钱循环）；
 * 模型这轮若已正确发卡且用户未答，AskUserQuestion 阻塞 canUseTool、'end' 根本不触发；
 * hasRenderedStageConfirm 把已答/已取消的卡都算「问过」，用户刚确认完绝不会被误催。
 */
export function maybeNudgeStageConfirmAfterTurn(sessionId: string): void {
  const ps = useProposalStore.getState()
  if (!ps.active || ps.sessionId !== sessionId) return
  for (const kind of ['cover', 'toc'] as const) {
    // 阶段守卫：cover 待确认=phase 还在 cover（封面确认放行是 clear-only 不动 phase，目录块
    // 落地才推 toc）；toc 待确认=phase 在 toc（目录确认放行才推 content）。
    if (kind === 'cover' ? ps.phase !== 'cover' : ps.phase !== 'toc') continue
    const sec = ps.sections.find((s) => s.kind === kind)
    if (!sec) continue
    const nudgeKey = `${sessionId}#${kind}#${sec.id}`
    if (nudgedSections.has(nudgeKey)) continue
    if (hasRenderedStageConfirm(sessionId, kind)) continue
    nudgedSections.add(nudgeKey)
    const label = kind === 'cover' ? '封面' : '目录'
    console.warn('[proposal-stage-gate] 节已落地但确认卡缺席，自动催促', { sessionId, kind })
    void sendProposalStageMessage(
      `${label}已收到、已显示在右侧文档里。请现在【立即】用 AskUserQuestion 工具发起「${label}确认」` +
        `（header 固定「${label}确认」，第 1 个选项为确认放行项）。不要重复输出${label}，也不要在用户` +
        `确认前写下一阶段的内容。`,
      { displayText: `${label}已收到，请发起${label}确认` }
    )
    return // 一轮至多催一个阶段
  }
}
