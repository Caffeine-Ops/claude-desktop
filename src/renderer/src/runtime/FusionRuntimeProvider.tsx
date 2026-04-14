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
import { useI18n } from '../i18n'
import { pushUiLog } from '../stores/uiLogs'
import { createOpenAIWhisperDictationAdapter } from './openaiWhisperDictationAdapter'
import { useDialogStore, type DialogKind } from '../stores/dialogs'
import {
  useTodosStore,
  extractTodoWriteItems,
  parsePartialToolArgs
} from '../stores/todos'
import type { ChatEvent, ThreadSummary } from '../../../shared/types'
import type { ChatImagePayload } from '../../../shared/ipc-channels'
import { imageAttachmentAdapter } from './imageAttachmentAdapter'
import { confirmStreamingInterrupt } from './streamingGuard'

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
  const setError = useChatStore((s) => s.setError)
  const endAssistantMessage = useChatStore((s) => s.endAssistantMessage)

  const threadListAdapter = useThreadListAdapter()

  // ── IPC subscription ────────────────────────────────────────────────
  useEffect(() => {
    if (!window.chatApi) {
      console.error(
        '[runtime] window.chatApi not found — preload did not load'
      )
      return
    }
    // No active session ⇒ nothing to subscribe to. This happens on
    // cold start (before the user picks a thread) and during the
    // brief instant a switch is in flight. The effect will re-run as
    // soon as `sessionId` becomes non-null.
    if (sessionId === null) return
    // Per-tool-use-id state the subscription needs across events:
    //   - toolNames: start-time name lookup, so a `tool_use_delta` can
    //     tell whether the id is a `TodoWrite` without waiting for end.
    //   - argsBuffers: accumulated argsText per tool-use, mirror of
    //     the chat store's argsText but kept here so the TodoWrite
    //     partial parser can run on every delta without reaching into
    //     React state.
    // Both live inside this effect closure so they reset naturally
    // when the subscription re-mounts (e.g. on sessionId change).
    const toolNames = new Map<string, string>()
    const argsBuffers = new Map<string, string>()

    const unsub = window.chatApi.onEvent(sessionId, (event: ChatEvent) => {
      switch (event.type) {
        case 'start':
          startAssistantMessage(event.messageId)
          break
        case 'chunk':
          appendAssistantDelta(event.messageId, event.delta)
          break
        case 'thinking_start':
          // Pre-create an empty reasoning part so the "正在思考…"
          // dot/label appears the moment the SDK opens the thinking
          // block. Without this we'd wait for the first thinking
          // delta, and Claude's extended-thinking blocks routinely
          // sit silent for several seconds before producing any
          // delta — long enough that the user perceives the UI as
          // stuck. The chat store keeps this idempotent so a second
          // thinking_start in the same turn doesn't double-insert.
          startReasoning(event.messageId)
          break
        case 'thinking_delta':
          appendThinkingDelta(event.messageId, event.delta)
          break
        case 'thinking_end':
          // No-op: the reasoning part is already complete the moment
          // the last delta appended into it. The visible "thinking"
          // shimmer is driven off `streaming` (turn-level), not a
          // per-block flag, so there's nothing to flip here.
          break
        case 'tool_use_start':
          toolNames.set(event.toolUseId, event.toolName)
          argsBuffers.set(event.toolUseId, '')
          startToolCall(event.messageId, event.toolUseId, event.toolName)
          // Reset the right rail proactively when the model begins
          // writing a new TodoWrite call. Otherwise the previous list
          // would hang on screen until the first parsable partial
          // arrives, producing a confusing "stuck then jump" feel.
          if (event.toolName === 'TodoWrite') {
            useTodosStore.getState().setTodos(sessionId, [])
          }
          break
        case 'tool_use_delta': {
          appendToolCallArgsDelta(event.toolUseId, event.partialJson)
          // Run the lenient partial parser for TodoWrite every delta
          // so the right-rail panel fills in row by row as the model
          // types. Non-TodoWrite tool calls just accumulate argsText
          // for the inline card, nothing else to do on delta.
          const toolName = toolNames.get(event.toolUseId)
          if (toolName !== 'TodoWrite') break
          const prev = argsBuffers.get(event.toolUseId) ?? ''
          const next = prev + event.partialJson
          argsBuffers.set(event.toolUseId, next)
          const parsed = parsePartialToolArgs(next)
          if (parsed !== null) {
            const items = extractTodoWriteItems(parsed, /* partial */ true)
            if (items) {
              useTodosStore.getState().setTodos(sessionId, items)
            }
          }
          break
        }
        case 'tool_use_end':
          finalizeToolCall(event.toolUseId)
          // On finalize, run the non-partial extractor against the
          // fully closed JSON for TodoWrite. This upgrades any
          // "best-effort" partial state to the authoritative list.
          if (toolNames.get(event.toolUseId) === 'TodoWrite') {
            const text = argsBuffers.get(event.toolUseId) ?? ''
            try {
              const final = JSON.parse(text)
              const items = extractTodoWriteItems(final, /* partial */ false)
              if (items) {
                useTodosStore.getState().setTodos(sessionId, items)
              }
            } catch {
              // Keep whatever the partial parser produced last — the
              // finalize path isn't supposed to blank the panel.
            }
          }
          toolNames.delete(event.toolUseId)
          argsBuffers.delete(event.toolUseId)
          break
        case 'tool_use':
          // Non-streaming path: SDK handed us the completed tool_use
          // block without the content_block_start/delta/stop fan-out.
          // Add the card in one shot and mirror TodoWrite into the
          // right rail. Engine.ts guarantees this event is NOT emitted
          // for ids that already went through the streaming path, so
          // we don't need to dedupe here.
          addToolCall(
            event.messageId,
            event.toolUseId,
            event.toolName,
            event.input
          )
          if (event.toolName === 'TodoWrite') {
            const items = extractTodoWriteItems(event.input)
            if (items) {
              useTodosStore.getState().setTodos(sessionId, items)
            }
          }
          break
        case 'tool_result':
          updateToolCallResult(event.toolUseId, event.output)
          break
        case 'end':
          endAssistantMessage()
          break
        case 'error':
          setError(event.messageId, event.error)
          endAssistantMessage()
          break
        default:
          break
      }
    })
    return unsub
  }, [
    sessionId,
    startAssistantMessage,
    appendAssistantDelta,
    appendThinkingDelta,
    startToolCall,
    appendToolCallArgsDelta,
    finalizeToolCall,
    addToolCall,
    updateToolCallResult,
    setError,
    endAssistantMessage
  ])

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
  const runtime = useExternalStoreRuntime({
    messages: messages as ThreadMessageLike[],
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
        }[]
      }> =
        message.role === 'user' && 'attachments' in message
          ? (message.attachments ?? [])
          : []

      // Flatten attachment.content[] into image parts. Every attachment
      // may in theory carry multiple parts (text + image), but our
      // imageAttachmentAdapter always produces a single image part —
      // still, iterate defensively in case a future adapter fans out.
      const imageParts: Array<{
        image: string
        filename?: string
      }> = []
      for (const att of rawAttachments) {
        if (!att.content) continue
        for (const part of att.content) {
          if (part.type === 'image' && typeof part.image === 'string') {
            imageParts.push({
              image: part.image,
              filename: part.filename ?? att.name
            })
          }
        }
      }

      const text = textParts.map((p) => p.text).join('\n').trim()
      const images: ChatImagePayload[] = imageParts.map((p) => ({
        dataUrl: p.image,
        filename: p.filename
      }))

      console.log('[runtime] onNew', {
        textLength: text.length,
        contentPartCount: message.content.length,
        attachmentCount: rawAttachments.length,
        imageCount: images.length
      })

      // Allow empty text when images are attached — "just sending a
      // screenshot" is a valid flow. Only error when BOTH are empty.
      if (!text && images.length === 0) {
        throw new Error('Empty user message')
      }

      // ─── Slash command interception ────────────────────────────
      // Mirrors fusion-code's terminal behavior: when the user types
      // a `/cmd` we know about, open a local dialog instead of
      // sending the prompt to the model. Skip when the user attached
      // images — a `/skill` with a screenshot is almost certainly a
      // typo and definitely not a recognized slash-command flow.
      if (images.length === 0) {
        const dialogKind = matchSlashCommand(text)
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
      appendUserMessage(storeContent)

      // 2) Hand the prompt to the main-process ChatEngine. The assistant
      // response comes back as ChatEvents via the IPC subscription above;
      // we don't await the full stream here — `start` will arrive as an
      // event and flip `streaming` true.
      if (sessionId === null) {
        const msg = 'No active session — create or pick one from the sidebar.'
        console.error('[runtime]', msg)
        startAssistantMessage(`err_${Date.now()}`)
        setError(`err_${Date.now()}`, msg)
        endAssistantMessage()
        return
      }

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
      startAssistantMessage(pendingMessageId)

      try {
        await window.chatApi.send({
          sessionId,
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
        startAssistantMessage(`err_${Date.now()}`)
        setError(`err_${Date.now()}`, msg)
        endAssistantMessage()
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
      attachments: imageAttachmentAdapter,
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

  const onSwitchToNewThread = useCallback(async (): Promise<void> => {
    if (!window.chatApi) return
    // Mid-turn guard: the runtime calls this both from cold-start
    // auto-select (streaming === false, no prompt) and from the
    // sidebar's New chat button (potentially mid-turn). Only the
    // latter sees the confirm.
    if (!(await confirmStreamingInterrupt())) return
    try {
      setSessionLoading(true)
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
      setSessionLoading(false)
    }
  }, [setSession, setSessionLoading])

  const onSwitchToThread = useCallback(
    async (id: string): Promise<void> => {
      if (!window.chatApi) return
      // Same mid-turn guard as new-thread: skip when not streaming
      // (cold-start auto-select path) and prompt otherwise.
      if (!(await confirmStreamingInterrupt())) return
      try {
        setSessionLoading(true)

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
        const loadPromise = window.chatApi.loadSession({ sessionId: id })
        const switchPromise = window.chatApi.switchSession({
          sessionId: id,
          resume: true
        })

        // Optimistically mount the thread under the requested id. The
        // overwhelming majority of the time this is what the cli will
        // end up using — the silent-fork rebind below is a rare edge
        // case we still need to handle for correctness.
        const { messages } = await loadPromise
        setSession(id, messages as ThreadMessageLike[])

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
        setSessionLoading(false)
      }
    },
    [setSession, setSessionLoading]
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

  // Map ThreadSummary[] → ExternalStoreThreadData<'regular'>[] once
  // per threads change. Memoized so the runtime's rerender path
  // doesn't fire diff-by-identity on every parent rerender.
  const threadData = useMemo(
    () =>
      threads.map((t) => ({
        status: 'regular' as const,
        id: t.id,
        title: t.title
      })),
    [threads]
  )

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
