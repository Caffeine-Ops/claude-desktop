import { useProposalStore } from '../stores/proposal'

/**
 * 「写方案」的激活/再入语义，场景卡（ScenarioQuickStart）与斜杠入口
 * （FusionRuntimeProvider 拦截 /proposal-writer）共用的唯一实现。
 *
 * 只要还存在一份未被显式丢弃的草稿（active 为真，或 sections 非空），一律 reopen
 * 回工作台、【绝不】start()——start 会清空 sections/products 把用户已写的草稿冲掉，
 * 这是「再入永不丢草稿」的落点（丢草稿根因的修复，见 stores/proposal.ts reopen 注释）。
 * 返回值告诉调用方走了哪条路：'started' 时调用方可选择预填引导模板（首发体验），
 * 'reopened' 时绝不能覆盖 composer——用户可能写到一半。
 */
export function startOrReopenProposal(sessionId: string): 'started' | 'reopened' {
  const ps = useProposalStore.getState()
  if (ps.active || ps.sections.length > 0) {
    ps.reopen(sessionId)
    return 'reopened'
  }
  ps.start(sessionId)
  return 'started'
}
