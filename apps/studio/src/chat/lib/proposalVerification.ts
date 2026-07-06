import { useProposalStore } from '../stores/proposal'

// 引用落地校验（#1）的「在飞」去重集：同一节的校验 IPC 未回来前不重复发起（多条 end 接连触发
// 时会重复扫 store）。模块级即可——校验是全局副作用、与组件实例无关。
const verifyingSectionIds = new Set<string>()

/**
 * 对当前草稿里「未校验的正文节」逐个异步发起引用落地校验，回填到 store。
 * 幂等：已校验（verification 非空）、在飞、非 content、截断残节都跳过。失败静默降级
 * （留 verification=undefined，UI 显示「未校验」灰态），绝不阻塞。
 *
 * 抽成独立模块（原在 FusionRuntimeProvider）：选区即改的「采用」按钮在 ThreadView 里，落地后
 * 也要补触发校验；从这里 import 一个纯函数，免得 ThreadView 反向 import 整个大 provider 成环。
 */
export function triggerProposalCitationVerification(): void {
  if (!window.chatApi?.verifyProposalCitations) return
  const { sections } = useProposalStore.getState()
  for (const sec of sections) {
    if (
      sec.kind !== 'content' ||
      sec.truncated ||
      sec.verification !== undefined ||
      verifyingSectionIds.has(sec.id)
    ) {
      continue
    }
    verifyingSectionIds.add(sec.id)
    void window.chatApi
      .verifyProposalCitations({ markdown: sec.markdown })
      .then((v) => useProposalStore.getState().setSectionVerification(sec.id, v))
      .catch(() => {
        /* 降级：留作未校验，绝不阻塞 */
      })
      .finally(() => verifyingSectionIds.delete(sec.id))
  }
}
