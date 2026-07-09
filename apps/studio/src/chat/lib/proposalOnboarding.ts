/**
 * 写方案「三阶段上手引导」的状态与判定。
 *
 * 开场空状态说明卡是【一次性】的：新用户第一次进来看一次，学会（草稿长出内容）或手动
 * 「知道了」后置位，此后再开空草稿也不再出现。标记跨会话持久到 localStorage——沿用
 * proposalStyle.ts / workspace.ts 的既有模式，不惊动主进程、不新增 IPC。
 */
const STORAGE_KEY = 'proposal-onboarding-seen-v1'

/** 读「是否已看过开场引导」。localStorage 不可用 → 当作没看过（fail-open 到「帮到人」）。 */
export function hasSeenProposalOnboarding(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** 置位「已看过」。持久化失败（隐私模式/配额）不致命：本次会话内引导已消失，下次再显示一次。 */
export function markProposalOnboardingSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // no-op
  }
}

/** 纯判定：没看过【且】草稿为空时才显示开场卡。逻辑与视图分离，供渲染层消费。 */
export function shouldShowProposalOnboarding(seen: boolean, sectionsEmpty: boolean): boolean {
  return !seen && sectionsEmpty
}
