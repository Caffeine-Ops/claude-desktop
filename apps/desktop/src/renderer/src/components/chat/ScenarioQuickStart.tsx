import { useCallback } from 'react'
import { useComposerRuntime } from '@assistant-ui/react'

import { useT, type StringKey } from '../../i18n'
import { useProposalStore } from '../../stores/proposal'
import { useChatStore } from '../../stores/chat'
import { startOrReopenProposal } from '../../lib/startOrReopenProposal'

/**
 * ScenarioQuickStart
 * ------------------
 * Compact "quick start" scenario list, pinned to the TOP of the left
 * sidebar (above the chat list). Replaces the old centered EmptyState
 * card grid — the scenarios are now always reachable, not just on a
 * fresh thread, so the user can prefill a starter prompt at any point.
 *
 * Clicking a row shoves `prompt` into the composer and focuses the
 * editor, mirroring how ChatGPT / Claude.ai handle their landing
 * suggestion tiles. The cards are intentionally a *starting line*, not
 * a full template — the user edits the bracketed placeholder before
 * sending.
 *
 * Why it lives in the sidebar, not ThreadView: the request was to move
 * this affordance out of the central hero and onto the rail so it sits
 * above the conversation list. The sidebar is rendered inside the same
 * AssistantRuntimeProvider as the thread (see App.tsx), so
 * `useComposerRuntime()` still resolves the main thread's composer here
 * — the runtime context is shared across the whole pane row.
 *
 * Localised copy lives in i18n.ts under the `scenario*` keys so the
 * EN/CN versions can diverge in tone.
 *
 * Adding a new card: append an entry here + add the matching i18n keys
 * in *both* locales. Keep the list short — a long list pushes the chat
 * rows off the visible rail.
 */
type ScenarioCard = {
  key: string
  iconClass: string
  icon: React.ReactNode
  titleKey: StringKey
  descKey: StringKey
  promptKey: StringKey
}

const SCENARIO_CARDS: ScenarioCard[] = [
  {
    key: 'ppt',
    iconClass: 'from-rose-500/20 to-rose-500/5 text-rose-400',
    icon: <PptIcon />,
    titleKey: 'scenarioPptTitle',
    descKey: 'scenarioPptDesc',
    promptKey: 'scenarioPptPrompt'
  },
  {
    key: 'officeHours',
    iconClass: 'from-amber-500/20 to-amber-500/5 text-amber-400',
    icon: <LightbulbIcon />,
    titleKey: 'scenarioOfficeHoursTitle',
    descKey: 'scenarioOfficeHoursDesc',
    promptKey: 'scenarioOfficeHoursPrompt'
  },
  {
    key: 'resumeScreen',
    iconClass: 'from-indigo-500/20 to-indigo-500/5 text-indigo-400',
    icon: <UserCheckIcon />,
    titleKey: 'scenarioResumeTitle',
    descKey: 'scenarioResumeDesc',
    promptKey: 'scenarioResumePrompt'
  },
  {
    key: 'analyze',
    iconClass: 'from-emerald-500/20 to-emerald-500/5 text-emerald-400',
    icon: <ChartIcon />,
    titleKey: 'scenarioAnalyzeTitle',
    descKey: 'scenarioAnalyzeDesc',
    promptKey: 'scenarioAnalyzePrompt'
  },
  {
    key: 'proposal',
    iconClass: 'from-sky-500/20 to-sky-500/5 text-sky-400',
    icon: <DocIcon />,
    titleKey: 'scenarioProposalTitle',
    descKey: 'scenarioProposalDesc',
    // 点击这张卡不再弹产品选择器，而是直接激活方案模式 + 把引导模板预填进
    // composer（见 onStartProposal）。scenarioProposalPrompt 现在就是那段引导模板。
    promptKey: 'scenarioProposalPrompt'
  }
]

export function ScenarioQuickStart(): React.JSX.Element {
  const t = useT()
  // Thread composer — resolved from the shared AssistantRuntimeProvider
  // that wraps both this sidebar and the chat view (see App.tsx). Lets a
  // sidebar click prefill the central composer without prop-drilling.
  const composer = useComposerRuntime()

  // Active session ID — the foreground session that the composer and the
  // right-rail todos panel are both bound to. `useChatStore` exposes
  // `sessionId: string | null` (set by `setForegroundSession` whenever the
  // user switches sessions). We fall back to the empty string if null, which
  // maps to the todos entry for an uninitialised session — harmless, because
  // a null sessionId means there is no foreground thread yet, so the todos
  // panel won't be visible anyway.
  const activeSessionId = useChatStore((s) => s.sessionId) ?? ''

  const leaveProposalMode = useProposalStore((s) => s.leaveMode)

  const onPickScenario = useCallback(
    (promptKey: StringKey) => {
      // 切到非方案场景时退出方案模式（active=false），避免 proposalMode 泄漏到普通会话。
      // 用 leaveMode 而非 reset：只收起、不清空 sections——否则用户若手滑点了别的场景卡，
      // 写到一半的方案草稿会被静默丢弃，再点「写方案」也回不来（丢草稿的根因之一）。
      leaveProposalMode()
      const text = t(promptKey)
      composer.setText(text)
      // Focus the editor so the user can immediately edit the bracketed
      // placeholder. The composer is a ProseMirror contenteditable (see
      // ProseMirrorComposerInput), NOT a <textarea>, so we target the
      // `.ProseMirror` node. Wait one microtask so React/PM has flushed
      // the setText commit before we move focus.
      queueMicrotask(() => {
        const el = document.querySelector<HTMLElement>('.ProseMirror')
        el?.focus()
      })
    },
    [composer, leaveProposalMode, t]
  )

  // 点「写方案」卡：激活/再入语义抽到 startOrReopenProposal（斜杠入口
  // /proposal-writer 与本卡共用同一实现，防两处分支漂移——见该 helper 注释）。
  // 'started'（首发）才预填引导模板并聚焦；'reopened' 不动 composer——用户可能写到一半。
  const onStartProposal = useCallback(() => {
    if (startOrReopenProposal(activeSessionId) === 'reopened') return
    composer.setText(t('scenarioProposalPrompt'))
    queueMicrotask(() => {
      const el = document.querySelector<HTMLElement>('.ProseMirror')
      el?.focus()
    })
  }, [activeSessionId, composer, t])

  return (
    <div className="shrink-0 px-2 pb-2 pt-2">
      <div className="px-2 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
          {t('sidebarQuickStart')}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {SCENARIO_CARDS.map((card) => (
          <button
            key={card.key}
            type="button"
            onClick={
              card.key === 'proposal'
                ? onStartProposal
                : () => onPickScenario(card.promptKey)
            }
            title={t(card.descKey)}
            className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.06]"
          >
            <span
              className={
                'flex size-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ' +
                card.iconClass
              }
            >
              {card.icon}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-foreground/85 group-hover:text-foreground">
                {t(card.titleKey)}
              </div>
              <div className="truncate text-[10.5px] leading-tight text-muted-foreground/70">
                {t(card.descKey)}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function PptIcon(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M3 18h18" />
      <path d="M8 22h8" />
      <path d="M12 18v4" />
      <path d="M8 11h4" />
      <path d="M8 8h8" />
    </svg>
  )
}

function LightbulbIcon(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2Z" />
    </svg>
  )
}

function UserCheckIcon(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="m16 11 2 2 4-4" />
    </svg>
  )
}

function ChartIcon(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 4 4 5-6" />
    </svg>
  )
}

function DocIcon(): React.JSX.Element {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  )
}
