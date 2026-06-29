import { decideProposalStageConfirm } from '@shared/proposal'
import { useProposalStore } from '../stores/proposal'

/**
 * 在用户提交 AskUserQuestion 答案的同步路径里调用：若命中「阶段确认放行」，推进 phase。
 *
 * 为什么放在提交同步路径、而非等 AI 回包：toc→content 阶段门要在 AI 流式吐正文、'end'
 * 过门【之前】就放行（phase=content）。用户点选是同步事件，advancePhase 经 getState() 同步
 * 生效，早于后续 AI 回合的 end 处理，时序成立。
 *
 * 仅方案模式生效（ps.active 门控），不污染非方案场景的 AskUserQuestion。
 */
export function applyProposalStageConfirm(
  input: unknown,
  answers: Record<string, string>
): void {
  const ps = useProposalStore.getState()
  if (!ps.active) return
  const decision = decideProposalStageConfirm(input, answers)
  if (decision === 'advance-content') {
    // 防御：只从 toc 阶段推进到 content（目录确认卡只在 toc 阶段发出，此处显式守一手，
    // 杜绝异常态下越过 toc 直接跳 content）。
    if (ps.phase !== 'toc') return
    ps.clearStageSkip()
    ps.advancePhase('content')
  } else if (decision === 'clear-only') {
    ps.clearStageSkip()
  }
}
