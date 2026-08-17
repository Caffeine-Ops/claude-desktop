import { useMemo } from 'react'
import { useAuiState } from '@assistant-ui/react'
import type { ScenarioCase } from '@desktop-shared/ipc-channels'

import { LEADING_SLASH_COMMAND_RE } from '../../../composer/skillChipRegistry'
import { casesForSkill } from '../../../lib/scenarioCases'
import { useScenarioCasesStore } from '../../../stores/scenarioCases'

export interface SkillCasesState {
  /** composer 里当前 leading 的技能命令（含前导 `/`），没有则 null。 */
  skillValue: string | null
  /** 该技能的案例（按裸名匹配）。 */
  cases: readonly ScenarioCase[]
  /**
   * 案例区此刻是否应该显示：选中了技能、chip 后正文为空、且该技能有案例。
   * EmptyState 用它切「紧凑模式」（大标题收成一行）——两处必须用同一份判定，
   * 否则会出现「标题缩了但案例没出来」或反过来。
   */
  visible: boolean
}

/**
 * 从 composer.text 派生「当前技能 + 它的案例」（与 ScenarioRail 同一真源、
 * 同一正则）。SkillCaseShowcase 与 EmptyState 共用。
 */
export function useSkillCases(): SkillCasesState {
  const gallery = useScenarioCasesStore((s) => s.gallery)
  const composerText = useAuiState(
    (s) => ((s as { composer?: { text?: string } }).composer?.text as string | undefined) ?? ''
  )
  const leading = LEADING_SLASH_COMMAND_RE.exec(composerText)
  const skillValue = leading?.[1] ?? null
  const bodyAfterChip = skillValue ? composerText.slice(skillValue.length).trim() : ''

  const cases = useMemo(
    () => (skillValue ? casesForSkill(gallery, skillValue) : []),
    [gallery, skillValue]
  )

  return {
    skillValue,
    cases,
    visible: skillValue !== null && bodyAfterChip === '' && cases.length > 0
  }
}
