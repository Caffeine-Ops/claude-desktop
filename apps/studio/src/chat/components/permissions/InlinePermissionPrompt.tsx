import type { PermissionRequest } from '@desktop-shared/types'
import { identifyProposalStageConfirm } from '@desktop-shared/proposal'
import { useTFormat } from '../../i18n'
import { applyProposalStageConfirm } from '../../lib/proposalStageConfirm'
import { usePermissionStore } from '../../stores/permissions'
import { AskUserQuestionView } from './AskUserQuestionView'

/**
 * InlinePermissionPrompt — AskUserQuestion only (2026-07-07 narrowing)
 * --------------------------------------------------------------------
 * This used to carry TWO branches: the AskUserQuestion questionnaire
 * plus a default three-button allow/deny row for every other tool. The
 * default branch moved out to the floating permission card docked above
 * the composer (`PermissionFloatCard` / `PermissionFloatDock`) — the
 * inline amber prompt sat wherever the tool card happened to be, often
 * scrolled out of view, so the user stared at a stalled spinner with
 * the actual question hidden above the fold.
 *
 * AskUserQuestion deliberately stays INLINE (and in the canvas 问题 tab
 * for slides sessions): its questionnaire is contextual content, not a
 * gate — the user reads it as part of the conversation, and the answer
 * form can be tall (1-4 questions × options), which would bury the
 * composer if docked there.
 *
 * ToolCallCard is the router: AskUserQuestion → this component;
 * everything else → `PermissionWaitAnchor` (a one-line "waiting for
 * your approval" marker) while the floating card owns the decision.
 *
 * The store contract is unchanged from the multi-prompt days: keyed by
 * `requestId`, never a single slot — parallel `canUseTool` requests
 * each keep their own entry (the race that killed the old fullscreen
 * modal, see stores/permissions.ts).
 */
type Props = {
  request: PermissionRequest
}

export function InlinePermissionPrompt({ request }: Props): React.JSX.Element {
  const tf = useTFormat()
  const respond = usePermissionStore((s) => s.respond)
  // 方案阶段确认卡：前端确定性识别（不靠 AI 措辞），钉一行说明讲清「为什么停、点了会怎样」。
  // 非阶段卡（普通 AskUserQuestion）→ stage=null → 不渲染说明行。
  const stage = identifyProposalStageConfirm(request.input)

  return (
    <div
      className="overflow-hidden rounded-2xl bg-muted/40 ring-1 ring-black/[0.06] dark:ring-white/[0.06]"
      aria-label={tf('permissionAriaLabel', { toolName: request.toolName })}
    >
      {stage && (
        <div className="border-b border-black/[0.06] bg-brand/5 px-3 py-2 text-[12px] leading-snug text-muted-foreground dark:border-white/[0.06]">
          <span aria-hidden>📄</span> 这是【{stage === 'cover' ? '封面确认' : '目录确认'}】。点“确认”后 AI 才会
          {stage === 'cover' ? '继续下一步：生成目录' : '开始逐章撰写正文'}。
        </div>
      )}
      <AskUserQuestionView
        input={request.input}
        onSubmit={(updatedInput) => {
          // 方案模式：用户点了「确认目录/封面」放行项时，先同步推进 phase（先于 AI
          // 回包的 end 过阶段门），再把答案回传给 AI。非方案场景下是 no-op。
          applyProposalStageConfirm(request.input, updatedInput.answers)
          void respond(request.requestId, 'allow-once', updatedInput)
        }}
        onCancel={() => void respond(request.requestId, 'deny')}
      />
    </div>
  )
}
