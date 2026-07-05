import {
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type DictationAdapter,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike
} from '@assistant-ui/react'

import { useChatStore } from '../stores/chat'
import { useMessageQueueStore } from '../stores/messageQueue'
import { useUnreadStore } from '../stores/unread'
import { useSessionTitleStore } from '../stores/sessionTitle'
import { useComposerModeStore } from '../stores/composerMode'
import { useI18n } from '../i18n'
import { pushUiLog } from '../stores/uiLogs'
import { createOpenAIWhisperDictationAdapter } from './openaiWhisperDictationAdapter'
import { useDialogStore, type DialogKind } from '../stores/dialogs'
import {
  useTodosStore,
  extractTodoWriteItems,
  parsePartialToolArgs
} from '../stores/todos'
import type { ChatEvent, ThreadSummary } from '@desktop-shared/types'
import type { ChatImagePayload } from '@desktop-shared/ipc-channels'
import { fileAttachmentAdapter, FILE_PATH_MIME } from './imageAttachmentAdapter'

/**
 * Bridges our zustand chat store ↔ assistant-ui's ExternalStoreRuntime.
 *
 * Two responsibilities:
 *
 *  1. **IPC → store**: subscribe to `window.chatApi.onEvent` and fan
 *     ChatEvents out to the corresponding store mutations. The store
 *     shape already matches `ThreadMessageLike`, so Thread re-renders
 *     naturally when messages mutate.
 *
 *  2. **Thread → backend**: hand the runtime an `onNew` that (a) pushes
 *     the user turn into the store so the UI sees it immediately, and
 *     (b) calls `window.chatApi.send` to ask the main process to begin
 *     the assistant response. The response comes back as a stream of
 *     ChatEvents handled by the subscription above.
 *
 * `isRunning` comes from `store.streaming`, which flips true on the
 * `start` event and false on `end` / `error`. Thread uses it to show a
 * running indicator and enable/disable the composer send button.
 *
 * Placement note: this provider must wrap every component that renders
 * assistant-ui primitives (Thread, ThreadPrimitive, MessagePrimitive,
 * ComposerPrimitive). App.tsx wraps the chat view in it.
 */
export function FusionRuntimeProvider({
  children
}: {
  children: ReactNode
}): React.JSX.Element {
  const sessionId = useChatStore((s) => s.sessionId)
  const sessionLoading = useChatStore((s) => s.sessionLoading)
  const messages = useChatStore((s) => s.messages)
  const historyWindowStart = useChatStore((s) => s.historyWindowStart)
  const streaming = useChatStore((s) => s.streaming)
  const appendUserMessage = useChatStore((s) => s.appendUserMessage)
  const startAssistantMessage = useChatStore((s) => s.startAssistantMessage)
  const appendAssistantDelta = useChatStore((s) => s.appendAssistantDelta)
  const startReasoning = useChatStore((s) => s.startReasoning)
  const appendThinkingDelta = useChatStore((s) => s.appendThinkingDelta)
  const startToolCall = useChatStore((s) => s.startToolCall)
  const appendToolCallArgsDelta = useChatStore((s) => s.appendToolCallArgsDelta)
  const finalizeToolCall = useChatStore((s) => s.finalizeToolCall)
  const addToolCall = useChatStore((s) => s.addToolCall)
  const updateToolCallResult = useChatStore((s) => s.updateToolCallResult)
  const updateToolCallTasks = useChatStore((s) => s.updateToolCallTasks)
  const setError = useChatStore((s) => s.setError)
  const endAssistantMessage = useChatStore((s) => s.endAssistantMessage)
  const setUsage = useChatStore((s) => s.setUsage)

  // Track which sessions currently have a live runtime in main. Seeded
  // from listActiveRuntimeIds() on mount and refreshed on every
  // sessionListChanged broadcast. The foreground sessionId is always
  // added to this set even if main hasn't reported it yet, so the first
  // user turn on a fresh session is still captured by an active
  // subscription.
  const [activeRuntimeIds, setActiveRuntimeIds] = useState<readonly string[]>(
    []
  )

  useEffect(() => {
    if (!window.chatApi) return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      try {
        const res = await window.chatApi.listActiveRuntimeIds()
        if (cancelled) return
        setActiveRuntimeIds(res.sessionIds)
      } catch (err) {
        console.warn('[runtime] listActiveRuntimeIds failed', err)
      }
    }
    void refresh()
    const unsub = window.chatApi.onSessionListChanged(() => {
      void refresh()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  // Union of main-reported runtimes + foreground session — sorted +
  // stringified so the multi-subscription effect below only re-runs
  // when the set actually changes, not on every parent rerender.
  const subscribedIdsKey = useMemo(() => {
    const merged = new Set<string>(activeRuntimeIds)
    if (sessionId) merged.add(sessionId)
    return Array.from(merged).sort().join('|')
  }, [activeRuntimeIds, sessionId])

  const threadListAdapter = useThreadListAdapter()

  // ── Multi-runtime IPC subscription ──────────────────────────────────
  //
  // Each active runtime gets its own `onEvent(sid)` subscription so
  // events from background agent tasks still land in their own
  // perSession slot even when the user has switched the foreground to
  // a different thread. A shared reconciler map keeps the registered
  // set in sync with `subscribedIdsKey` — new ids get a fresh
  // subscription, dropped ids get unsub'd.
  //
  // Per-tool-use state (toolNames / argsBuffers) lives INSIDE each
  // session's handler closure so TodoWrite partial parsing doesn't
  // cross-contaminate between concurrent sessions streaming tool
  // calls at the same time.
  const subsRef = useRef<Map<string, () => void>>(new Map())
  useEffect(() => {
    if (!window.chatApi) {
      console.error(
        '[runtime] window.chatApi not found — preload did not load'
      )
      return
    }
    const desired = new Set(
      subscribedIdsKey.length > 0 ? subscribedIdsKey.split('|') : []
    )
    const current = subsRef.current

    // Remove subscriptions for ids no longer in the desired set.
    for (const [sid, unsub] of current) {
      if (!desired.has(sid)) {
        unsub()
        current.delete(sid)
      }
    }

    // Add subscriptions for new ids.
    for (const sid of desired) {
      if (current.has(sid)) continue
      const handler = makeSessionEventHandler(sid, {
        appendUserMessage,
        startAssistantMessage,
        appendAssistantDelta,
        startReasoning,
        appendThinkingDelta,
        startToolCall,
        appendToolCallArgsDelta,
        finalizeToolCall,
        addToolCall,
        updateToolCallResult,
        updateToolCallTasks,
        setError,
        endAssistantMessage,
        setUsage
      })
      const unsub = window.chatApi.onEvent(sid, handler)
      current.set(sid, unsub)
      // Seed the queue mirror for this session: a background runtime may
      // already have turns queued from before the renderer subscribed
      // (e.g. after a switch away and back). Live changes then flow in as
      // `queue_changed` events on the subscription above.
      void window.chatApi
        .queueList({ sessionId: sid })
        .then((queue) => useMessageQueueStore.getState().setQueue(sid, queue))
        .catch((err: unknown) =>
          console.warn('[runtime] queueList seed failed', err)
        )
    }
    // Do NOT unsub on effect cleanup — only unmount should tear down
    // subscriptions. Effect cleanup runs on every deps change and
    // would churn the whole map even though the reconciler above
    // already computed an exact diff.
    return undefined
  }, [
    subscribedIdsKey,
    appendUserMessage,
    startAssistantMessage,
    appendAssistantDelta,
    startReasoning,
    appendThinkingDelta,
    startToolCall,
    appendToolCallArgsDelta,
    finalizeToolCall,
    addToolCall,
    updateToolCallResult,
    updateToolCallTasks,
    setError,
    endAssistantMessage,
    setUsage
  ])

  // Component unmount cleanup — tear down every live subscription so
  // the renderer doesn't keep IPC listeners around after FusionRuntimeProvider
  // disappears (tab close / HMR).
  useEffect(() => {
    const subs = subsRef.current
    return () => {
      for (const unsub of subs.values()) unsub()
      subs.clear()
    }
  }, [])

  // ── Voice dictation adapter ─────────────────────────────────────────
  // We don't use assistant-ui's built-in WebSpeechDictationAdapter:
  // stock Electron's Chromium has no Google Cloud Speech key, so
  // SpeechRecognition reliably dies with ERR_FAILED at the network
  // layer. Instead, the custom adapter below records a raw mic
  // stream, chunks it via MediaRecorder, and proxies each chunk
  // through the main-process IPC to an OpenAI-compatible
  // `/audio/transcriptions` endpoint (OPENAI_BASE_URL +
  // OPENAI_API_KEY from env.json). The same MediaStream also feeds
  // an AnalyserNode into the audioLevel store for the waveform UI,
  // so we only open one mic session per dictation turn.
  //
  // Recreated whenever the UI language changes so the Whisper call
  // gets a fresh `language` hint. A thin logging wrapper sits on
  // top so every lifecycle event lands in the LogsDialog.
  const lang = useI18n((s) => s.lang)
  const dictationAdapter = useMemo(() => {
    const inner = createOpenAIWhisperDictationAdapter({
      language: lang
    })
    pushUiLog('dictation:adapter-ready', {
      engine: 'openai-whisper',
      language: lang
    })
    return wrapDictationWithLogging(inner)
  }, [lang])

  // ── ExternalStoreRuntime wiring ─────────────────────────────────────

  // Tail window: the runtime (and thus ThreadPrimitive.Messages) only sees
  // messages from `historyWindowStart` on — mounting a long transcript's
  // full history in one synchronous commit is what made session switches
  // jank (see the cursor's doc in chat.ts). Derived with useMemo from two
  // STABLE store fields, never sliced inside a selector (a fresh array per
  // selector run is the useShallow/getSnapshot infinite-loop trap).
  // Everything else (OutlinePanel, written-file derivations, event
  // handlers) keeps reading the FULL `messages` — only the thread's render
  // path is windowed.
  const visibleMessages = useMemo(
    () =>
      historyWindowStart > 0 ? messages.slice(historyWindowStart) : messages,
    [messages, historyWindowStart]
  )

  const runtime = useExternalStoreRuntime({
    messages: visibleMessages as ThreadMessageLike[],
    isRunning: streaming,
    // `isLoading` greys out the thread while main is spawning a new
    // fusion-code child (session switch) — the composer hides its
    // send button until the cold-start finishes.
    isLoading: sessionLoading,
    // IMPORTANT: we MUST pass a convertMessage (even identity), otherwise
    // ExternalStoreRuntimeCore takes the pass-through branch and feeds our
    // raw ThreadMessageLike objects straight into the message repository,
    // skipping `fromThreadMessageLike`. Downstream code (e.g.
    // `_getMessageRuntime`) then reads `message.metadata.submittedFeedback`
    // on objects that have no `metadata` field and throws
    // "Cannot read properties of undefined (reading 'submittedFeedback')".
    // An identity converter flips the runtime to the conversion branch,
    // which runs fromThreadMessageLike and synthesizes every required
    // runtime-only field (metadata, status, etc.).
    convertMessage: (m: ThreadMessageLike): ThreadMessageLike => m,

    onNew: async (message: AppendMessage) => {
      // ──────────────────────────────────────────────────────────────
      // Reading layout of AppendMessage (assistant-ui contract)
      // ──────────────────────────────────────────────────────────────
      // Looking at base-composer-runtime-core.js:send(), the composer
      // builds the message as:
      //
      //   {
      //     content: text ? [{ type: 'text', text }] : [],  // ONLY text
      //     attachments: await attachments,                  // CompleteAttachment[]
      //     ...
      //   }
      //
      // So `message.content` is strictly the typed text, and each image
      // sits inside `message.attachments[i].content` as an
      // ImageMessagePart. An earlier version of this file read images
      // from `message.content` which is always empty-of-images — hence
      // the "imageCount: 0" bug in engine logs even when the user saw
      // a chip in the composer.
      //
      // The shape of each CompleteAttachment (from our imageAttachmentAdapter.send):
      //
      //   {
      //     id, name, type: 'image',
      //     status: { type: 'complete' },
      //     content: [{ type: 'image', image: dataURL, filename }],
      //   }
      const textParts = message.content.filter(
        (p): p is { type: 'text'; text: string } => p.type === 'text'
      )

      // role narrowing: `attachments` only exists on user messages. The
      // composer always sends user messages (role = 'user') but the
      // AppendMessage union includes assistant/system so we guard.
      // The field can also be `undefined` on older payload shapes.
      const rawAttachments: ReadonlyArray<{
        readonly name: string
        readonly content?: readonly {
          readonly type: string
          readonly image?: string
          readonly filename?: string
          readonly data?: string
          readonly mimeType?: string
        }[]
      }> =
        message.role === 'user' && 'attachments' in message
          ? (message.attachments ?? [])
          : []

      // Flatten attachment.content[] into image parts AND file-path
      // parts. Every attachment may in theory carry multiple parts —
      // our fileAttachmentAdapter produces a single part each, but we
      // iterate defensively in case a future adapter fans out.
      //   - image part  → vision block (base64 data URL)
      //   - file  part  → on-disk absolute path (mimeType ===
      //     FILE_PATH_MIME), which we turn into an `@"path"` mention so
      //     fusion-code reads the file with its Read tool. The bytes
      //     never cross IPC; "the model receives the path".
      const imageParts: Array<{
        image: string
        filename?: string
      }> = []
      const filePaths: string[] = []
      for (const att of rawAttachments) {
        if (!att.content) continue
        for (const part of att.content) {
          if (part.type === 'image' && typeof part.image === 'string') {
            imageParts.push({
              image: part.image,
              filename: part.filename ?? att.name
            })
          } else if (
            part.type === 'file' &&
            part.mimeType === FILE_PATH_MIME &&
            typeof part.data === 'string' &&
            part.data.length > 0
          ) {
            filePaths.push(part.data)
          }
        }
      }

      const baseText = textParts.map((p) => p.text).join('\n').trim()
      const images: ChatImagePayload[] = imageParts.map((p) => ({
        dataUrl: p.image,
        filename: p.filename
      }))

      // Append each attached file as an `@"path"` mention. Quote
      // unconditionally — absolute paths can contain spaces, and the
      // quotes are stripped by fusion-code's quotedAtMentionRegex for
      // paths that don't. Mentions go AFTER the user's typed text so
      // the prompt reads naturally ("look at this: @/a/b.pdf").
      const mentionSuffix = filePaths.map((p) => `@"${p}"`).join(' ')
      let text =
        mentionSuffix.length > 0
          ? baseText
            ? `${baseText} ${mentionSuffix}`
            : mentionSuffix
          : baseText

      // Slides mode → drive the ppt-master skill. When the composer's mode
      // picker is on 幻灯片, prepend the skill's slash invocation so fusion-code
      // runs ppt-master for this turn. The bundled backend exposes it under the
      // plugin namespace as `/claude-desktop:ppt-master` (the chip registry
      // renders that verbatim as a「制作PPT」chip in the user bubble). Skip if
      // the user already typed a ppt-master slash so we never double-prefix.
      // Note: composerMode is read via getState() (not subscribed) — onNew runs
      // imperatively at send time, so a snapshot is exactly right.
      const SLIDES_SLASH = '/claude-desktop:ppt-master'
      const slidesMode = useComposerModeStore.getState().mode === 'slides'
      const alreadyPptSlash = /^\/(claude-desktop:)?ppt-master\b/.test(baseText)
      if (slidesMode && !alreadyPptSlash) {
        text = text ? `${SLIDES_SLASH} ${text}` : SLIDES_SLASH
      }

      console.log('[runtime] onNew', {
        textLength: text.length,
        contentPartCount: message.content.length,
        attachmentCount: rawAttachments.length,
        imageCount: images.length,
        fileCount: filePaths.length
      })

      // Allow empty typed text when images OR files are attached —
      // "just sending a screenshot / a file" is a valid flow. Only
      // error when ALL three are empty.
      if (!text && images.length === 0) {
        throw new Error('Empty user message')
      }

      // ─── Slash command interception ────────────────────────────
      // Mirrors fusion-code's terminal behavior: when the user types
      // a `/cmd` we know about, open a local dialog instead of
      // sending the prompt to the model. Skip when the user attached
      // images or files — a `/skill` with an attachment is almost
      // certainly a typo and definitely not a recognized slash-command
      // flow. (Match on baseText: the appended @mentions would never
      // be a slash command anyway, but baseText is the user's intent.)
      if (images.length === 0 && filePaths.length === 0) {
        const dialogKind = matchSlashCommand(baseText)
        if (dialogKind) {
          useDialogStore.getState().openDialog(dialogKind)
          return
        }
      }

      // 1) Push user turn into the store — Thread shows it instantly.
      // Build the content-part array we want the UI to render: the
      // text (if any) followed by image thumbnails. This mirrors what
      // the engine will send to the API a moment later.
      const storeContent: Array<{ type: string; [key: string]: unknown }> = []
      if (text) {
        storeContent.push({ type: 'text', text })
      }
      for (const img of imageParts) {
        storeContent.push({
          type: 'image',
          image: img.image,
          ...(img.filename ? { filename: img.filename } : {})
        })
      }
      // 2) Hand the prompt to the main-process ChatEngine. The assistant
      // response comes back as ChatEvents via the IPC subscription above;
      // we don't await the full stream here — `start` will arrive as an
      // event and flip `streaming` true.
      if (sessionId === null) {
        const msg = 'No active session — create or pick one from the sidebar.'
        console.error('[runtime]', msg)
        return
      }

      // Foreground session is the target of the composer. Bind a
      // local alias so every action below gets the right sid without
      // re-reading an outer closure that could theoretically drift.
      const targetSid = sessionId

      // Message queue: read the LIVE streaming flag (getState, not the
      // render-time `streaming` closure — this callback can fire against
      // a stale render). When a turn is already streaming, the engine
      // enqueues this send behind the active turn rather than clobbering
      // it. A QUEUED turn must NOT touch the transcript yet — it hasn't
      // been sent to the model, so showing it as a user bubble reads as
      // "already sent" and contradicts the queue panel (the bug this
      // path fixes). We stash its content keyed by the engine's real
      // messageId and replay it into the transcript only when the turn's
      // `start` event arrives (i.e. the queue drained it into the active
      // slot). The `start` handler pairs the stash → user bubble +
      // assistant bubble; see pendingQueuedTurns below.
      const isStreaming = useChatStore.getState().streaming
      if (isStreaming) {
        try {
          const { messageId } = await window.chatApi.send({
            sessionId: targetSid,
            text: text,
            images: images.length > 0 ? images : undefined
          })
          // Stash the exact content-part array so the drained turn
          // renders identically to an idle send (text + image thumbs),
          // not a text-only reconstruction.
          rememberQueuedTurn(targetSid, messageId, storeContent)
          // Optimistic panel row keyed by the engine's real messageId, so
          // the follow-up `queue_changed` snapshot (same id) reconciles
          // instead of duplicating.
          useMessageQueueStore.getState().optimisticEnqueue(targetSid, {
            messageId,
            text,
            imageCount: images.length
          })
        } catch (err) {
          console.error('[runtime] enqueue send failed', err)
        }
        return
      }

      // Idle path — the user's turn shows in the transcript immediately,
      // then we open an assistant turn.
      appendUserMessage(targetSid, storeContent)
      // The transcript just grew by the user's turn. Drop the cached
      // snapshot now (before the assistant's `start`) so a switch away +
      // back in the gap before the reply can't resurrect a copy that's
      // missing this message.
      invalidateHistoryCache(targetSid)
      // Pre-flip the spinner so the user sees feedback while the
      // main-process send awaits the lazy fusion-code cold start.
      // Background: engine.ts switchToSession is now lazy — it
      // records pendingResume and returns instantly, so the first
      // send() on a freshly-switched session is where the ~3-8s
      // cold start actually lives. Without this pre-flip, the UI
      // would sit silent for 8s waiting for the main-process
      // `start` event. startAssistantMessage is idempotent, so the
      // real `start` event arriving later is a no-op for the turn
      // meta (see chat.ts:startAssistantMessage).
      const pendingMessageId = `pending_${Date.now()}`
      startAssistantMessage(targetSid, pendingMessageId)

      try {
        await window.chatApi.send({
          sessionId: targetSid,
          // Engine validator accepts empty strings when images are present.
          // We still pass an empty string (not undefined) so the wire
          // shape stays stable.
          text: text,
          images: images.length > 0 ? images : undefined
        })
      } catch (err) {
        console.error('[runtime] send failed', err)
        const msg = err instanceof Error ? err.message : String(err)
        // Attach to a synthetic assistant message so the user sees
        // the failure instead of a silent void. Idempotent
        // startAssistantMessage means this call won't reset the
        // turn meta set by the pre-flip above.
        const errMessageId = `err_${Date.now()}`
        startAssistantMessage(targetSid, errMessageId)
        setError(targetSid, errMessageId, msg)
        endAssistantMessage(targetSid)
      }
    },

    onCancel: async () => {
      if (sessionId === null) return
      try {
        await window.chatApi.abort({ sessionId })
      } catch (err) {
        console.error('[runtime] abort failed', err)
      }
    },

    // Attachment plumbing. Wiring an adapter here unlocks:
    //   - ComposerPrimitive.Input's built-in addAttachmentOnPaste
    //     (default true): paste a screenshot → assistant-ui fires our
    //     adapter.add(), which wraps the File into a PendingAttachment
    //     that shows up in ComposerPrimitive.Attachments
    //   - ComposerPrimitive.AttachmentDropzone: dragging image files
    //     over the composer highlights the zone and drops produce the
    //     same PendingAttachment flow
    //   - ComposerPrimitive.AddAttachment: the "+" button opens the
    //     browser file picker filtered by adapter.accept ("image/*")
    //
    // On submit, assistant-ui calls adapter.send() for each pending
    // attachment (which resizes + encodes to data URL — see
    // imageAttachmentAdapter.ts) and merges the resulting
    // ImageMessagePart into AppendMessage.content before onNew fires.
    // That's why onNew above can just read message.content and find
    // both text and image parts inline.
    adapters: {
      attachments: fileAttachmentAdapter,
      // Powers the left sidebar. `useThreadListAdapter` reads the
      // session list from main-process IPC and stays in sync via the
      // `onSessionListChanged` broadcast. onSwitchToThread /
      // onSwitchToNewThread route back through IPC to
      // engine.switchToSession.
      threadList: threadListAdapter,
      // Web Speech API dictation. `undefined` when the browser doesn't
      // expose SpeechRecognition — ComposerPrimitive.Dictate's
      // useComposerDictate() returns `null` in that case and the mic
      // button auto-disables.
      dictation: dictationAdapter
    }
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  )
}

/**
 * Inspect the raw user prompt and decide whether it's a client-side
 * slash command we should intercept. Returns the dialog kind to open,
 * or null if the prompt should go through to the model normally.
 *
 * Recognized commands:
 *   /skill, /skills           → SkillsDialog
 *   /mcp                      → McpDialog
 *
 * Recognition is case-insensitive and ignores trailing args; the args
 * are dropped (the dialog UIs don't yet honor them — future work).
 *
 * Anything starting with `/` that isn't on this list falls through to
 * `chatApi.send` so the user can still send free-form text that
 * happens to begin with a slash (e.g. "/Users/foo/bar").
 */
/**
 * Bucket a thread's `updatedAt` (ms-since-epoch) into a coarse,
 * human-readable date group for the sidebar headings: 今天 / 昨天 /
 * 7 天内 / 更早. Compared against local-midnight boundaries so "今天"
 * means "since 00:00 today" rather than "within the last 24h" — matches
 * how users read a chat list. Anything in the future (clock skew) falls
 * into 今天.
 */
function dateGroupLabel(updatedAt: number): string {
  const now = new Date()
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime()
  const dayMs = 24 * 60 * 60 * 1000
  if (updatedAt >= startOfToday) return '今天'
  if (updatedAt >= startOfToday - dayMs) return '昨天'
  if (updatedAt >= startOfToday - 7 * dayMs) return '7 天内'
  return '更早'
}

/**
 * Tiny module-level LRU cache of `loadSession` results, keyed by session id.
 *
 * Why: `onSwitchToThread` reads `<id>.jsonl` off disk and JSON-parses it on
 * EVERY switch — even when flipping back to a session the user just read.
 * For long transcripts that fs + parse round-trip (tens to low-hundreds of
 * ms, plus an IPC hop) is the dominant cost between "clicked" and "history
 * on screen". Caching the mapped `ThreadMessageLike[]` lets a switch back to
 * a recently-visited session resolve SYNCHRONOUSLY → the content column swaps
 * in the same frame as the click, instead of after a disk round-trip.
 *
 * Correctness guards:
 *   - Bounded to `HISTORY_CACHE_MAX` entries (LRU eviction) so a long browsing
 *     session can't pin unbounded transcript arrays in renderer memory.
 *   - Invalidated for a session whenever that session receives a new turn /
 *     mutation — see `invalidateHistoryCache`, called from the IPC→store fan-out
 *     in `FusionRuntimeProvider`. Without this, a cached snapshot taken before
 *     the user sent a message would resurrect a stale (shorter) transcript on
 *     the next switch back. The live-state-wins guard in `setSession`
 *     (chat.ts) already protects background-running sessions, but a session
 *     that finished its turn and went idle has no live slot — so the cache is
 *     the source of truth and MUST be dropped on every append.
 *   - We cache only on a cold `loadSession`, never the optimistic empty array,
 *     so a half-mounted thread can't poison the cache.
 */
const HISTORY_CACHE_MAX = 8
const historyCache = new Map<string, readonly ThreadMessageLike[]>()

function getCachedHistory(id: string): readonly ThreadMessageLike[] | undefined {
  const hit = historyCache.get(id)
  if (hit === undefined) return undefined
  // Touch: re-insert so this id becomes the most-recently-used (Map preserves
  // insertion order, so delete+set moves it to the tail).
  historyCache.delete(id)
  historyCache.set(id, hit)
  return hit
}

function setCachedHistory(id: string, messages: readonly ThreadMessageLike[]): void {
  if (historyCache.has(id)) historyCache.delete(id)
  historyCache.set(id, messages)
  // Evict the least-recently-used (the head of insertion order) past the cap.
  while (historyCache.size > HISTORY_CACHE_MAX) {
    const oldest = historyCache.keys().next().value
    if (oldest === undefined) break
    historyCache.delete(oldest)
  }
}

/**
 * Drop a session's cached transcript. Called whenever that session's message
 * list mutates (a new turn arrives) so the next switch-back re-reads fresh
 * JSONL instead of serving a pre-turn snapshot. Cheap no-op when uncached.
 */
export function invalidateHistoryCache(id: string): void {
  historyCache.delete(id)
}

/**
 * Content of turns that were ENQUEUED (submitted while another turn was
 * streaming) and haven't yet been drained into the active slot. Keyed
 * `sessionId → messageId → content-parts`.
 *
 * A queued turn is deliberately kept OUT of the transcript until it
 * actually runs — otherwise it'd show as an already-sent user bubble
 * while it's still just sitting in the queue panel, which is
 * contradictory (the bug this stash fixes). When the engine finally
 * drains the queue and emits the turn's `start` event, the event
 * handler pulls the stash here and replays it as the user bubble right
 * before opening the assistant bubble — so a drained turn looks
 * identical to an idle send (same content parts, including image
 * thumbnails), just deferred.
 */
const pendingQueuedTurns = new Map<
  string,
  Map<string, Array<{ type: string; [key: string]: unknown }>>
>()

function rememberQueuedTurn(
  sid: string,
  messageId: string,
  content: Array<{ type: string; [key: string]: unknown }>
): void {
  let perSession = pendingQueuedTurns.get(sid)
  if (!perSession) {
    perSession = new Map()
    pendingQueuedTurns.set(sid, perSession)
  }
  perSession.set(messageId, content)
}

/**
 * Keep a stashed queued-turn's text in sync when the user edits it in
 * the queue panel. The engine is the source of truth for the queue, but
 * the stash holds the rich content-parts (incl. image thumbnails) the
 * transcript will replay — so an edit that only rewrites text must patch
 * the stash's text part too, or the drained turn would show the OLD
 * wording. Rebuilds the text part in place; leaves image parts intact.
 * Empty text (the panel treats that as a delete) drops the stash.
 */
export function updateQueuedTurnText(
  sid: string,
  messageId: string,
  text: string
): void {
  const perSession = pendingQueuedTurns.get(sid)
  const content = perSession?.get(messageId)
  if (!perSession || !content) return
  const next = text.trim()
  if (!next) {
    perSession.delete(messageId)
    return
  }
  const withoutText = content.filter((p) => p.type !== 'text')
  perSession.set(messageId, [{ type: 'text', text: next }, ...withoutText])
}

/**
 * Pull (and remove) a stashed queued-turn's content when its `start`
 * event arrives. Returns undefined for an ordinary (idle) turn whose
 * user bubble the renderer already appended locally — that path never
 * stashed anything, so the handler skips the replay.
 */
function takeQueuedTurn(
  sid: string,
  messageId: string
): Array<{ type: string; [key: string]: unknown }> | undefined {
  const perSession = pendingQueuedTurns.get(sid)
  if (!perSession) return undefined
  const content = perSession.get(messageId)
  if (content) perSession.delete(messageId)
  return content
}

/**
 * Resolve after the browser has composited one more frame (double rAF:
 * the first callback runs BEFORE the next paint, the second one after it).
 * Used to let the switch curtain's latest frame reach the screen before a
 * heavy synchronous mount grabs the main thread.
 */
function nextPaintFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/**
 * Powers the left sidebar. Talks only to `window.chatApi` — no direct
 * knowledge of the main process, file system, or the SDK. State lives
 * in `useState` + the chat store; this hook just glues them together.
 *
 * Lifecycle:
 *   1. Mount fetches the current list via `chatApi.listSessions()`.
 *   2. Subscribes to `onSessionListChanged` so new sessions (captured
 *      from fusion-code's `system init`) appear without a manual
 *      refresh.
 *   3. `onSwitchToNewThread` mints a fresh UUID, asks main to spawn
 *      the CLI on it (without `resume`), and clears the chat store's
 *      messages — the first user turn will materialize in the JSONL
 *      and the list will auto-refresh via step 2.
 *   4. `onSwitchToThread(id)` loads that session's history from main,
 *      tells main to teardown+respawn with `resume: true`, then
 *      replaces the chat store with the loaded history. UI pays the
 *      ~8s cold-start behind a `sessionLoading: true` flag.
 */
function useThreadListAdapter(): ExternalStoreThreadListAdapter {
  const sessionId = useChatStore((s) => s.sessionId)
  const sessionLoading = useChatStore((s) => s.sessionLoading)
  const setSession = useChatStore((s) => s.setSession)
  const setSessionLoading = useChatStore((s) => s.setSessionLoading)
  const beginSessionSwitch = useChatStore((s) => s.beginSessionSwitch)
  const endSessionSwitch = useChatStore((s) => s.endSessionSwitch)

  const [threads, setThreads] = useState<readonly ThreadSummary[]>([])
  // Flips true once the initial `listSessions()` has returned (success
  // or failure). The cold-start auto-select effect below waits for this
  // before deciding "empty workspace → auto-create new chat", otherwise
  // it would race the in-flight IPC and spawn a spurious new chat on
  // every launch even when the sidebar already has entries.
  const [threadsLoaded, setThreadsLoaded] = useState(false)

  // Keep the latest sessionId reachable from inside the IPC subscription
  // closure below without retriggering its effect. The subscription has
  // empty deps so it only registers once, but the race-fallback retry
  // needs to read the *current* active session id at fire time.
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    if (!window.chatApi) return
    let cancelled = false

    const refresh = async (): Promise<readonly ThreadSummary[] | null> => {
      try {
        const result = await window.chatApi.listSessions()
        if (cancelled) return null
        setThreads(result.threads)
        return result.threads
      } catch (err) {
        console.error('[runtime] listSessions failed', err)
        return null
      } finally {
        // Mark the initial load as done even on error so the
        // auto-select effect still progresses — a listSessions failure
        // shouldn't leave the user stranded with a null sessionId.
        if (!cancelled) setThreadsLoaded(true)
      }
    }

    void refresh()
    const unsub = window.chatApi.onSessionListChanged(() => {
      void (async () => {
        const result = await refresh()
        // Race fallback: main emits sessionListChanged from
        // updateSessionMeta() the moment fusion-code sends `system init`,
        // but the cli's jsonl write to disk and the SDK's directory scan
        // are not strictly ordered. The first listSessions() can come
        // back without the active session, leaving the sidebar one chat
        // behind until the next reload. If the active id is missing,
        // re-poll once after a short delay.
        if (!result) return
        const activeId = sessionIdRef.current
        if (!activeId) return
        if (result.some((t) => t.id === activeId)) return
        setTimeout(() => {
          if (!cancelled) void refresh()
        }, 200)
      })()
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  // Monotonic switch sequence. A switch's `finally` may run SECONDS after a
  // newer switch began (cold start awaits switchSession) — without this
  // guard, switch A's cleanup would clear the loading/switching flags that
  // switch B just raised, dropping B's veil mid-load. Only the newest
  // switch is allowed to clear the shared flags.
  const switchSeqRef = useRef(0)

  const onSwitchToNewThread = useCallback(async (): Promise<void> => {
    if (!window.chatApi) return
    // Multi-runtime: switching away from a streaming session is now
    // non-destructive — the prev runtime keeps running in the
    // background and its deltas accumulate in its own perSession slot.
    // No interrupt confirmation needed; the old streamingGuard call
    // was a holdover from the single-runtime era when switching
    // teardowned the prev cli.
    const seq = ++switchSeqRef.current
    try {
      setSessionLoading(true)
      // Switch chrome (ThreadView curtain): the two IPC round-trips below
      // leave the OLD transcript on screen until setSession mounts the empty
      // thread — the switching flag lets ThreadView veil that stale content.
      beginSessionSwitch()
      const { sessionId: newId } = await window.chatApi.newSession()
      // `--session-id newId` (no resume) — cli should honor it, but
      // use the returned activeId defensively in case of a rebind.
      const { sessionId: activeId } = await window.chatApi.switchSession({
        sessionId: newId,
        resume: false
      })
      setSession(activeId, [])
    } catch (err) {
      console.error('[runtime] new thread failed', err)
    } finally {
      if (switchSeqRef.current === seq) {
        setSessionLoading(false)
        // Idempotent: setSession already cleared it on the success path;
        // this covers the throw path so the veil can't get stuck on.
        endSessionSwitch()
      }
    }
  }, [setSession, setSessionLoading, beginSessionSwitch, endSessionSwitch])

  const onSwitchToThread = useCallback(
    async (id: string): Promise<void> => {
      if (!window.chatApi) return
      // Multi-runtime: non-destructive switch. See onSwitchToNewThread
      // for the rationale — the prev session keeps its cli alive in
      // the background, so there's nothing to interrupt.
      const seq = ++switchSeqRef.current
      try {
        setSessionLoading(true)
        // Switch chrome: veil the old transcript until the target one
        // mounts. On the cache-hit path below, setSession runs in this
        // same synchronous batch — subscribers never observe the flag as
        // true, so a fast switch renders zero switch chrome by design.
        beginSessionSwitch()

        // Fire both IPCs in parallel. They don't depend on each other:
        //   - loadSession reads `<id>.jsonl` off disk and maps it to
        //     ThreadMessageLike[] (~tens to hundreds of ms, dominated
        //     by fs + JSON.parse for long transcripts).
        //   - switchSession tears down the previous fusion-code child
        //     and spawns a fresh one with `--resume <id>`, then blocks
        //     until it sees `system init` (~3-8s, the real cold start).
        //
        // Running them sequentially used to make loadSession wait
        // behind switchSession — so the user sat through the full ~8s
        // looking at a blank thread, even though the history was
        // readable off disk in under 100ms. Now we render history the
        // moment loadSession resolves and let the cli cold start
        // continue in the background; the composer stays disabled via
        // `sessionLoading` → `useExternalStoreRuntime.isLoading` until
        // switchSession also resolves, so the user can read but not
        // send until the cli is actually accepting turns.
        //
        // switchSession still fires immediately (in parallel) regardless
        // of the cache — only the *display* of history is short-circuited
        // below; the cli cold start can't be cached and must always run.
        const switchPromise = window.chatApi.switchSession({
          sessionId: id,
          resume: true
        })

        // Fast path: a recently-visited session's transcript is already
        // mapped in memory. Mount it SYNCHRONOUSLY so the content column
        // swaps in the same frame as the click — no disk round-trip, no
        // blank gap. The cache is invalidated on every append (see
        // invalidateHistoryCache) so this can't serve a pre-turn snapshot.
        const cached = getCachedHistory(id)
        let messages: readonly ThreadMessageLike[]
        if (cached !== undefined) {
          messages = cached
          setSession(id, messages as ThreadMessageLike[])
        } else {
          // Cold path: read + parse off disk, then prime the cache.
          // Optimistically mount the thread under the requested id. The
          // overwhelming majority of the time this is what the cli will
          // end up using — the silent-fork rebind below is a rare edge
          // case we still need to handle for correctness.
          const loaded = await window.chatApi.loadSession({ sessionId: id })
          messages = loaded.messages as ThreadMessageLike[]
          setCachedHistory(id, messages)
          // 大 mount 前让一帧：loadSession 的 IPC resolve 落在帧中间，紧跟
          // 的 setSession 是一次同步大 commit（有尾部窗口后也还有 ~30 条 ×
          // markdown 的量）。双 rAF 让帘幕/骨架的最新一帧先合成上屏、排队
          // 的输入事件先冲掉，再做 mount。不用 startTransition：zustand 走
          // useSyncExternalStore，外部 store 更新必须同步渲染（防 tearing），
          // transition 对它不生效。
          await nextPaintFrame()
          // 让帧期间可能又开始了一次更新的切换（快速连点）；落后的 mount
          // 会把新切换刚上屏的内容打回去——直接弃权，flags 归新切换管。
          if (switchSeqRef.current !== seq) return
          setSession(id, messages as ThreadMessageLike[])
        }

        // Wait for cli ready. In the rare fusion-code `--resume X`
        // silent-fork case the cli picks a different id Y for the
        // forward JSONL; main forwards Y here so we can rebind the
        // chat store + the IPC subscription key to the real id the
        // cli is emitting on. When activeId === id (the common path),
        // this second setSession is a no-op-ish rerender.
        const { sessionId: activeId } = await switchPromise
        if (activeId !== id) {
          setSession(activeId, messages as ThreadMessageLike[])
        }
      } catch (err) {
        console.error('[runtime] switch thread failed', err)
      } finally {
        if (switchSeqRef.current === seq) {
          setSessionLoading(false)
          // Idempotent guard for the throw path (success path already
          // cleared via setSession) — a failed load must not strand the
          // ThreadView switch veil.
          endSessionSwitch()
        }
      }
    },
    [setSession, setSessionLoading, beginSessionSwitch, endSessionSwitch]
  )

  // Cold-start auto-select. Ensures that by the time the user types
  // into the composer, `sessionId` is already non-null — no "No active
  // session" errors on an empty workspace, no need to click "New chat"
  // before typing. Two branches:
  //
  //   - Workspace already has chats → resume the most recently updated
  //     one. `threads` is sorted newest-first by sessionStore.listSessions,
  //     so threads[0] is "the chat the user was most recently in".
  //   - Workspace is empty → auto-create a fresh chat, equivalent to
  //     clicking the "+ New chat" button at mount time. With engine.ts
  //     in lazy-spawn mode, this only allocates a sessionId; no cli
  //     is spawned until the user actually sends a message.
  //
  // Guards:
  //   - `autoSelectedRef` latches true the instant we trigger, so this
  //     is idempotent even if `threads` changes later in the session.
  //   - wait for `threadsLoaded` before running — during the initial
  //     tick `threads` is `[]` because listSessions hasn't returned yet,
  //     and acting on that stale value would create a spurious new
  //     chat in every launch of a workspace that actually has history.
  //   - skip if the user has already picked a thread (`sessionId` set)
  //   - skip if a switch is already in flight (`sessionLoading`)
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    if (autoSelectedRef.current) return
    if (!threadsLoaded) return
    if (sessionId !== null) return
    if (sessionLoading) return
    autoSelectedRef.current = true
    if (threads.length > 0) {
      void onSwitchToThread(threads[0].id)
    } else {
      void onSwitchToNewThread()
    }
  }, [
    threads,
    threadsLoaded,
    sessionId,
    sessionLoading,
    onSwitchToThread,
    onSwitchToNewThread
  ])

  // Shell-driven session switching. The session list now lives in the
  // shell's left rail (a separate webContents with no runtime of its own),
  // so when the user clicks a session there, main forwards the request here
  // (SHELL_SESSION_SWITCH). We run the SAME switch handlers a click in the
  // old in-tab sidebar would have — so setSession / loadSession /
  // sessionLoading all fire and the Thread view stays in lockstep. `null`
  // means "new chat". Only the active chat tab is targeted by main.
  useEffect(() => {
    if (!window.chatApi?.onShellSessionSwitch) return
    return window.chatApi.onShellSessionSwitch((id) => {
      if (id === null) {
        void onSwitchToNewThread()
      } else {
        void onSwitchToThread(id)
      }
    })
  }, [onSwitchToThread, onSwitchToNewThread])

  // Map ThreadSummary[] → ExternalStoreThreadData<'regular'>[] once
  // per threads change. Memoized so the runtime's rerender path
  // doesn't fire diff-by-identity on every parent rerender.
  //
  // We stash per-row date-grouping metadata in `custom` (assistant-ui
  // passes ThreadData.custom straight through to the row, readable via
  // useAuiState(s => s.threadListItem.custom)). `groupLabel` is the
  // bucket this row falls in (今天/昨天/7 天内/更早) computed from its
  // `updatedAt`; `isGroupFirst` is true only for the FIRST row of each
  // bucket, so the sidebar row can render a sticky group heading above
  // itself. `threads` is already sorted newest-first by main
  // (sessionStore.listSessions), so a single forward scan suffices and
  // the buckets come out in chronological order without re-sorting.
  const threadData = useMemo(() => {
    let prevGroup: string | null = null
    return threads.map((t) => {
      const groupLabel = dateGroupLabel(t.updatedAt)
      const isGroupFirst = groupLabel !== prevGroup
      prevGroup = groupLabel
      return {
        status: 'regular' as const,
        id: t.id,
        title: t.title,
        custom: { groupLabel, isGroupFirst }
      }
    })
  }, [threads])

  // Mirror the foreground session's title into the shared title store so the
  // chat header (ThreadView) can render it. The title lives in `threads` (the
  // ThreadSummary the sidebar uses), keyed by the chat store's `sessionId`;
  // ThreadView is a sibling under the runtime provider and can't take it as a
  // prop, so this is the seam. null when no session is selected yet, or while
  // a freshly-minted session isn't in `threads` yet (its first turn hasn't
  // hit the JSONL, so listSessions hasn't surfaced it) — the header falls back
  // to a placeholder in that window.
  useEffect(() => {
    const current = sessionId
      ? (threads.find((t) => t.id === sessionId)?.title ?? null)
      : null
    useSessionTitleStore.getState().setTitle(current)
  }, [threads, sessionId])

  return useMemo<ExternalStoreThreadListAdapter>(
    () => ({
      threadId: sessionId ?? undefined,
      isLoading: sessionLoading,
      threads: threadData,
      onSwitchToNewThread,
      onSwitchToThread
    }),
    [sessionId, sessionLoading, threadData, onSwitchToNewThread, onSwitchToThread]
  )
}

/**
 * Wrap a DictationAdapter so every lifecycle event flows into the
 * UI logs store. Preserves the adapter contract exactly — `status`
 * is exposed as a getter so assistant-ui's internal status polling
 * still sees the live value from the inner session instead of a
 * snapshot taken at wrap time.
 *
 * Events we surface:
 *   - `dictation:listen`          session created
 *   - `dictation:speech-start`    user started speaking
 *   - `dictation:speech-commit`   a final utterance landed in the composer
 *   - `dictation:speech-interim`  (throttled) interim partial arrived
 *   - `dictation:stop`            user hit the stop button
 *   - `dictation:cancel`          cancel() called by the runtime
 *   - `dictation:ended`           terminal status observed, with the
 *                                 reason (stopped / cancelled / error)
 *
 * The `ended` event is produced by polling `session.status` at 150ms
 * intervals — the adapter type doesn't expose a status change
 * callback, so polling is the only portable option. Polling stops
 * as soon as the terminal status is observed, so the overhead is
 * bounded to the active dictation window.
 */
function wrapDictationWithLogging(inner: DictationAdapter): DictationAdapter {
  return {
    listen() {
      pushUiLog('dictation:listen')
      const session = inner.listen()

      let lastInterimLog = 0
      const unsubSpeechStart = session.onSpeechStart(() => {
        pushUiLog('dictation:speech-start')
      })
      const unsubSpeech = session.onSpeech((result) => {
        // Throttle interim logs to ~2/s so a single sentence doesn't
        // flood the ring buffer with 30 near-identical rows.
        const now = Date.now()
        if (now - lastInterimLog < 500) return
        lastInterimLog = now
        pushUiLog('dictation:speech-interim', {
          len: result.transcript.length
        })
      })
      const unsubSpeechEnd = session.onSpeechEnd((result) => {
        pushUiLog('dictation:speech-commit', {
          len: result.transcript.length,
          final: result.isFinal ?? true
        })
      })

      let lastStatus = session.status.type
      const pollId = window.setInterval(() => {
        const current = session.status
        if (current.type === lastStatus) return
        lastStatus = current.type
        if (current.type === 'ended') {
          pushUiLog('dictation:ended', { reason: current.reason })
          window.clearInterval(pollId)
          unsubSpeechStart()
          unsubSpeech()
          unsubSpeechEnd()
        }
      }, 150)

      return {
        get status() {
          return session.status
        },
        stop: async () => {
          pushUiLog('dictation:stop')
          await session.stop()
        },
        cancel: () => {
          pushUiLog('dictation:cancel')
          session.cancel()
        },
        onSpeechStart: (cb) => session.onSpeechStart(cb),
        onSpeechEnd: (cb) => session.onSpeechEnd(cb),
        onSpeech: (cb) => session.onSpeech(cb)
      }
    },
    disableInputDuringDictation: inner.disableInputDuringDictation
  }
}

/**
 * Build a ChatEvent handler bound to a single session id. The closure
 * owns per-tool-use state (toolNames / argsBuffers) so concurrent
 * sessions streaming TodoWrite can't cross-contaminate their right-rail
 * partial-parse state. Every mutation targets the captured `sid`,
 * which is what keeps background runtimes writing into their own
 * perSession slot instead of the foreground.
 */
function makeSessionEventHandler(
  sid: string,
  actions: {
    appendUserMessage: (
      sid: string,
      content: Array<{ type: string; [key: string]: unknown }>
    ) => void
    startAssistantMessage: (sid: string, messageId: string) => void
    appendAssistantDelta: (
      sid: string,
      messageId: string,
      delta: string
    ) => void
    startReasoning: (sid: string, messageId: string) => void
    appendThinkingDelta: (
      sid: string,
      messageId: string,
      delta: string
    ) => void
    startToolCall: (
      sid: string,
      messageId: string,
      toolUseId: string,
      toolName: string
    ) => void
    appendToolCallArgsDelta: (
      sid: string,
      toolUseId: string,
      delta: string
    ) => void
    finalizeToolCall: (sid: string, toolUseId: string) => void
    addToolCall: (
      sid: string,
      messageId: string,
      toolUseId: string,
      toolName: string,
      input: unknown
    ) => void
    updateToolCallResult: (
      sid: string,
      toolUseId: string,
      output: unknown
    ) => void
    updateToolCallTasks: (
      sid: string,
      ev: Extract<ChatEvent, { type: 'task_update' }>
    ) => void
    setError: (sid: string, messageId: string, error: string) => void
    endAssistantMessage: (sid: string) => void
    setUsage: (
      sid: string,
      usage: { contextTokens: number; outputTokens: number }
    ) => void
  }
): (event: ChatEvent) => void {
  const toolNames = new Map<string, string>()
  const argsBuffers = new Map<string, string>()
  return (event: ChatEvent) => {
    switch (event.type) {
      case 'start': {
        // If this turn was drained from the queue, its user bubble was
        // withheld from the transcript until now (see rememberQueuedTurn).
        // Replay it just before opening the assistant bubble so the pair
        // appears together and in order. Ordinary idle turns stashed
        // nothing here — the composer already appended their user bubble.
        const queuedContent = takeQueuedTurn(sid, event.messageId)
        if (queuedContent) {
          actions.appendUserMessage(sid, queuedContent)
        }
        // A new assistant turn is starting → this session's transcript is
        // about to grow. Drop any cached history snapshot so the next
        // switch-back re-reads fresh JSONL instead of the pre-turn copy.
        invalidateHistoryCache(sid)
        actions.startAssistantMessage(sid, event.messageId)
        break
      }
      case 'chunk':
        actions.appendAssistantDelta(sid, event.messageId, event.delta)
        break
      case 'thinking_start':
        actions.startReasoning(sid, event.messageId)
        break
      case 'thinking_delta':
        actions.appendThinkingDelta(sid, event.messageId, event.delta)
        break
      case 'thinking_end':
        break
      case 'tool_use_start':
        toolNames.set(event.toolUseId, event.toolName)
        argsBuffers.set(event.toolUseId, '')
        actions.startToolCall(
          sid,
          event.messageId,
          event.toolUseId,
          event.toolName
        )
        if (event.toolName === 'TodoWrite') {
          useTodosStore.getState().setTodos(sid, [])
        }
        break
      case 'tool_use_delta': {
        actions.appendToolCallArgsDelta(sid, event.toolUseId, event.partialJson)
        const toolName = toolNames.get(event.toolUseId)
        if (toolName !== 'TodoWrite') break
        const prev = argsBuffers.get(event.toolUseId) ?? ''
        const next = prev + event.partialJson
        argsBuffers.set(event.toolUseId, next)
        const parsed = parsePartialToolArgs(next)
        if (parsed !== null) {
          const items = extractTodoWriteItems(parsed, /* partial */ true)
          if (items) {
            useTodosStore.getState().setTodos(sid, items)
          }
        }
        break
      }
      case 'tool_use_end':
        actions.finalizeToolCall(sid, event.toolUseId)
        if (toolNames.get(event.toolUseId) === 'TodoWrite') {
          const text = argsBuffers.get(event.toolUseId) ?? ''
          try {
            const final = JSON.parse(text)
            const items = extractTodoWriteItems(final, /* partial */ false)
            if (items) {
              useTodosStore.getState().setTodos(sid, items)
            }
          } catch {
            // Keep whatever the partial parser produced last.
          }
        }
        toolNames.delete(event.toolUseId)
        argsBuffers.delete(event.toolUseId)
        break
      case 'tool_use':
        actions.addToolCall(
          sid,
          event.messageId,
          event.toolUseId,
          event.toolName,
          event.input
        )
        if (event.toolName === 'TodoWrite') {
          const items = extractTodoWriteItems(event.input)
          if (items) {
            useTodosStore.getState().setTodos(sid, items)
          }
        }
        break
      case 'tool_result':
        actions.updateToolCallResult(sid, event.toolUseId, event.output)
        break
      case 'task_update':
        // Workflow/Task subagent lifecycle — merge into the spawning
        // Task card's sub-task list. Routed by toolUseId/taskId inside
        // the store, independent of any active assistant turn.
        actions.updateToolCallTasks(sid, event)
        break
      case 'usage':
        actions.setUsage(sid, {
          contextTokens: event.contextTokens,
          outputTokens: event.outputTokens
        })
        break
      case 'end':
        actions.endAssistantMessage(sid)
        // Unread: a reply just finished. If the user isn't currently
        // looking at this session (it's a background task, or they're on
        // the canvas / another chat), flag it unread so the rail shows a
        // dot until they open it. A turn that finished in the foreground
        // is already-read — skip. Read the foreground id live from the
        // store (getState, not a render-time closure).
        if (useChatStore.getState().sessionId !== sid) {
          useUnreadStore.getState().markUnread(sid)
        }
        break
      case 'error':
        actions.setError(sid, event.messageId, event.error)
        actions.endAssistantMessage(sid)
        break
      case 'queue_changed':
        // Authoritative queue snapshot from main — overwrite the local
        // mirror wholesale. Fires on enqueue, post-result promotion, and
        // every panel edit/remove/reorder. Independent of any active
        // turn, so it lives outside the `actions.*` (chat-store) surface.
        useMessageQueueStore.getState().setQueue(sid, event.queue)
        break
      default:
        break
    }
  }
}

function matchSlashCommand(text: string): Exclude<DialogKind, null> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const head = trimmed.slice(1).split(/\s+/, 1)[0]?.toLowerCase()
  if (!head) return null
  switch (head) {
    case 'skill':
    case 'skills':
      return 'skills'
    case 'mcp':
      return 'mcp'
    default:
      return null
  }
}
