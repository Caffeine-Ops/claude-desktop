import { useCallback } from 'react'
import {
  ThreadListPrimitive,
  ThreadListItemPrimitive
} from '@assistant-ui/react'

import { useChatStore } from '../../stores/chat'

/**
 * ThreadListSidebar
 * -----------------
 * Left-side chat/session list, built from @assistant-ui's
 * ThreadListPrimitive + ThreadListItemPrimitive. Data is supplied by
 * the runtime's `threadList` adapter (see `useThreadListAdapter` in
 * FusionRuntimeProvider), which reads sessions from main process IPC
 * and mirrors them to assistant-ui's primitive tree — no direct store
 * access is needed here.
 *
 * Layout note
 * -----------
 * `w-64 shrink-0` gives the sidebar a fixed 256px rail. The parent in
 * App.tsx is a horizontal flex row, and the main `<ThreadView />` sits
 * beside this sidebar with `flex-1` consuming the remaining width.
 */
export function ThreadListSidebar({
  workspace
}: {
  workspace: string
}): React.JSX.Element {
  const sessionLoading = useChatStore((s) => s.sessionLoading)

  // Switching workspace requires a full app restart — the fusion-code
  // child's cwd is baked at spawn time, and the engine rejects a
  // second setWorkspace() call (see engine.ts:215). So we confirm,
  // then ask main to relaunch; on cold boot the gate re-appears and
  // the user drops a new folder.
  const onSwitchWorkspace = useCallback(() => {
    const ok = window.confirm(
      '切换 workspace 会重启应用，当前未保存的草稿会丢失。确定继续吗？'
    )
    if (!ok) return
    window.chatApi.relaunchApp().catch((err) => {
      console.error('[sidebar] relaunchApp failed', err)
    })
  }, [])

  return (
    <ThreadListPrimitive.Root className="flex h-full w-64 shrink-0 flex-col border-r border-zinc-800/70 bg-[#0a0a0c]">
      {/* Workspace row — shows the current folder's basename, full
          path in the tooltip. Clicking asks main to relaunch so the
          gate can pick a new folder. Lives above "Chats" so it reads
          as "these chats belong to this workspace". */}
      <div className="px-3 pb-3 pt-4">
        <button
          type="button"
          onClick={onSwitchWorkspace}
          title={`${workspace}\n点击切换 workspace（会重启应用）`}
          className="group flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-left transition hover:border-zinc-700 hover:bg-zinc-800/80"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-zinc-500 group-hover:text-zinc-300"
            aria-hidden
          >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          </svg>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium text-zinc-200">
              {basename(workspace)}
            </div>
            <div className="truncate text-[10.5px] text-zinc-500">
              {workspace}
            </div>
          </div>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-zinc-600 group-hover:text-zinc-400"
            aria-hidden
          >
            <path d="M8 9l4-4 4 4" />
            <path d="M8 15l4 4 4-4" />
          </svg>
        </button>
      </div>

      {/* Header row — section label, could grow to hold filters later. */}
      <div className="flex items-center justify-between border-t border-zinc-800/70 px-4 pb-2 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
          Chats
        </span>
      </div>

      {/* New chat button — wired to runtime.switchToNewThread() via the
          ThreadListPrimitive.New primitive. Dimmed while a session
          switch is in flight so rapid double-clicks don't stack. */}
      <div className="px-3 pb-3">
        <ThreadListPrimitive.New
          disabled={sessionLoading}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-[13px] font-medium text-zinc-200 shadow-sm transition hover:border-zinc-700 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="text-base leading-none">+</span>
          <span>New chat</span>
        </ThreadListPrimitive.New>
      </div>

      {/* Scrollable list. min-h-0 + flex-1 so the list body can shrink
          inside the flex-col sidebar instead of pushing the header off
          the top edge. Pointer events off during a switch so row
          clicks don't queue up while the previous switch is still
          finishing its cli cold start. The actual "Opening session…"
          feedback is now a fullscreen overlay rendered in App.tsx. */}
      <div
        className={
          'min-h-0 flex-1 overflow-y-auto px-2 pb-4 ' +
          (sessionLoading ? 'pointer-events-none opacity-60' : '')
        }
      >
        <ThreadListPrimitive.Items components={{ ThreadListItem }} />
      </div>
    </ThreadListPrimitive.Root>
  )
}

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return i >= 0 ? trimmed.slice(i + 1) : trimmed
}

/* ─────────────────── Individual thread row ─────────────────── */

/**
 * One entry in the thread list. Assembled from ThreadListItemPrimitive
 * parts so that assistant-ui owns the click-to-switch wiring.
 *
 *   Root    → wraps one thread; reads state from a ThreadListItem context
 *   Trigger → full-row button that calls runtime.threads.item(i).switchTo
 *   Title   → renders the thread's title, with a fallback when empty
 *
 * Active-state styling
 * --------------------
 * assistant-ui injects `data-active="true"` onto `ThreadListItemPrimitive.Root`
 * (see ThreadListItemRoot's `useAuiState(s => s.threads.mainThreadId === s.threadListItem.id)`),
 * NOT onto Trigger. Tailwind's `data-[active]:` variant only matches
 * attributes on the element itself, so writing `data-[active]:…` on
 * Trigger silently never fires. We fix that by tagging Root with a
 * named group (`group/thread`) and using `group-data-[active]/thread:`
 * on every descendant we want to restyle. The named group mirrors the
 * `group/tool` / `group/att` convention already used in ThreadView.tsx
 * so the sidebar doesn't accidentally collide with a stray `.group`
 * higher up the tree.
 *
 * We deliberately don't show archive / delete actions yet — those come
 * later with hover state + an inline menu.
 */
function ThreadListItem(): React.JSX.Element {
  return (
    <ThreadListItemPrimitive.Root className="group/thread mb-0.5">
      <ThreadListItemPrimitive.Trigger className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-zinc-300 transition hover:bg-zinc-800/70 group-data-[active]/thread:bg-zinc-800 group-data-[active]/thread:text-zinc-100">
        <span className="size-1.5 shrink-0 rounded-full bg-zinc-600 transition group-data-[active]/thread:bg-zinc-300" />
        <span className="truncate">
          <ThreadListItemPrimitive.Title fallback="New chat" />
        </span>
      </ThreadListItemPrimitive.Trigger>
    </ThreadListItemPrimitive.Root>
  )
}
