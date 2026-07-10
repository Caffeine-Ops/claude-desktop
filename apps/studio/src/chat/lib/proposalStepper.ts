import type { ProposalKind } from '@desktop-shared/proposal'

// 写方案面板顶部阶段条（封面①→目录②→正文③）单个节点的三态判断——从组件 JSX 里抽出来的纯函数，
// 好让「正文写完该显示完成」这类规则能被单测钉死（回归点见 proposalStepper.test.ts）。
// 纯函数：不碰 store、不碰 React，只吃 (阶段, 是否生成中, 节点下标) 吐状态。

// 阶段顺序即业务硬门顺序，与 stores/proposal 的 phase 推进、DocPanel 的 PROPOSAL_PHASES 一致。
export const PROPOSAL_PHASE_ORDER: readonly ProposalKind[] = ['cover', 'toc', 'content']

export type StepperNodeState = 'done' | 'current' | 'future'

/**
 * 阶段条上第 `nodeIdx` 个节点该显示成什么状态。
 * - `done`：已越过的阶段（绿勾）。
 * - `current`：当前阶段、还在进行或在等确认（描边高亮）。
 * - `future`：还没走到的阶段（灰点）。
 *
 * 关键规则（也是本函数存在的理由）：**只有终态「正文」阶段生成结束（generating=false）时，
 * 当前节点才翻成 done**。为什么不对所有阶段都「idle=完成」？因为封面/目录阶段的 idle 语义是
 * “等用户确认再进下一步”，阶段并没被越过，误标完成会让人以为可以往下走了；而正文是最后一步、
 * 后面没有确认门，写完就是真完成，该给一个收尾的绿勾（修复前这里一直卡在 current）。
 */
export function proposalStepperNodeState(
  phase: ProposalKind,
  generating: boolean,
  nodeIdx: number
): StepperNodeState {
  const phaseIdx = PROPOSAL_PHASE_ORDER.indexOf(phase)
  if (nodeIdx < phaseIdx) return 'done'
  if (nodeIdx > phaseIdx) return 'future'
  // nodeIdx === phaseIdx：当前阶段节点。唯有终态正文写完了才算完成，其余一律「进行中」。
  const isFinalPhase = phaseIdx === PROPOSAL_PHASE_ORDER.length - 1
  if (isFinalPhase && !generating) return 'done'
  return 'current'
}
