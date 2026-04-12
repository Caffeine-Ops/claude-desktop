import {
  ThreadListPrimitive,
  ThreadListItemPrimitive
} from '@assistant-ui/react'

/**
 * ThreadListSidebar
 * -----------------
 * Left-side chat/session list, built from @assistant-ui's
 * ThreadListPrimitive + ThreadListItemPrimitive.
 *
 * Current status — placeholder
 * ----------------------------
 * The runtime we hand to `AssistantRuntimeProvider` (the one coming out
 * of `useExternalStoreRuntime` in FusionRuntimeProvider) does not yet
 * implement a `ThreadListAdapter`, so `ThreadListPrimitive.Items` will
 * at most render the single default thread the runtime spins up on
 * its own. Every piece of wiring here is already the real, final
 * shape — clicking a future thread will call `.switchTo()`, new-chat
 * will call `.switchToNewThread()`, etc. The only missing piece is
 * the adapter that actually stores and lists thread ids.
 *
 * Once we wire a real list adapter (planned for after the main-process
 * session lifecycle lands), this component lights up without any
 * further UI changes.
 *
 * Layout note
 * -----------
 * `w-64 shrink-0` gives the sidebar a fixed 256px rail. The parent in
 * App.tsx is a horizontal flex row, and the main `<ThreadView />` sits
 * beside this sidebar with `flex-1` consuming the remaining width.
 */
export function ThreadListSidebar(): React.JSX.Element {
  return (
    <ThreadListPrimitive.Root className="flex h-full w-64 shrink-0 flex-col border-r border-zinc-800/70 bg-[#0a0a0c]">
      {/* Header row — section label, could grow to hold filters later. */}
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
          Chats
        </span>
      </div>

      {/* New chat button — wired to runtime.switchToNewThread() via the
          ThreadListPrimitive.New primitive. */}
      <div className="px-3 pb-3">
        <ThreadListPrimitive.New className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-[13px] font-medium text-zinc-200 shadow-sm transition hover:border-zinc-700 hover:bg-zinc-800">
          <span className="text-base leading-none">+</span>
          <span>New chat</span>
        </ThreadListPrimitive.New>
      </div>

      {/* Scrollable list. min-h-0 + flex-1 so the list body can shrink
          inside the flex-col sidebar instead of pushing the header off
          the top edge. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <ThreadListPrimitive.Items components={{ ThreadListItem }} />

        {/* Visual placeholder copy. Stays visible underneath the real
            list so it's clear the multi-session UI isn't wired up yet.
            Remove once a real ThreadListAdapter is connected. */}
        <div className="mt-4 rounded-md border border-dashed border-zinc-800/80 px-3 py-4 text-center text-[11px] leading-relaxed text-zinc-600">
          <div className="mb-1 font-medium text-zinc-500">
            Session list coming soon
          </div>
          <div>
            Placeholder rail using
            <br />
            <code className="rounded bg-zinc-900 px-1 py-0.5 text-[10.5px] font-mono text-zinc-400">
              ThreadListPrimitive
            </code>
          </div>
        </div>
      </div>
    </ThreadListPrimitive.Root>
  )
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
 * We deliberately don't show archive / delete actions yet — those come
 * later with hover state + an inline menu.
 */
function ThreadListItem(): React.JSX.Element {
  return (
    <ThreadListItemPrimitive.Root className="mb-0.5">
      <ThreadListItemPrimitive.Trigger className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[13px] text-zinc-300 transition hover:bg-zinc-800/70 data-[active]:bg-zinc-800 data-[active]:text-zinc-100">
        <span className="size-1.5 shrink-0 rounded-full bg-zinc-600" />
        <span className="truncate">
          <ThreadListItemPrimitive.Title fallback="New chat" />
        </span>
      </ThreadListItemPrimitive.Trigger>
    </ThreadListItemPrimitive.Root>
  )
}
