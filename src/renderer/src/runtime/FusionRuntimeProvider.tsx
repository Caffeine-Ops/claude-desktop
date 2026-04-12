import { ReactNode, useEffect } from 'react'
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike
} from '@assistant-ui/react'

import { useChatStore } from '../stores/chat'
import { useDialogStore, type DialogKind } from '../stores/dialogs'
import {
  useTodosStore,
  extractTodoWriteItems,
  parsePartialToolArgs
} from '../stores/todos'
import type { ChatEvent } from '../../../shared/types'
import type { ChatImagePayload } from '../../../shared/ipc-channels'
import { imageAttachmentAdapter } from './imageAttachmentAdapter'

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
  const messages = useChatStore((s) => s.messages)
  const streaming = useChatStore((s) => s.streaming)
  const appendUserMessage = useChatStore((s) => s.appendUserMessage)
  const startAssistantMessage = useChatStore((s) => s.startAssistantMessage)
  const appendAssistantDelta = useChatStore((s) => s.appendAssistantDelta)
  const startToolCall = useChatStore((s) => s.startToolCall)
  const appendToolCallArgsDelta = useChatStore((s) => s.appendToolCallArgsDelta)
  const finalizeToolCall = useChatStore((s) => s.finalizeToolCall)
  const addToolCall = useChatStore((s) => s.addToolCall)
  const updateToolCallResult = useChatStore((s) => s.updateToolCallResult)
  const setError = useChatStore((s) => s.setError)
  const endAssistantMessage = useChatStore((s) => s.endAssistantMessage)

  // ── IPC subscription ────────────────────────────────────────────────
  useEffect(() => {
    if (!window.chatApi) {
      console.error(
        '[runtime] window.chatApi not found — preload did not load'
      )
      return
    }
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
    startToolCall,
    appendToolCallArgsDelta,
    finalizeToolCall,
    addToolCall,
    updateToolCallResult,
    setError,
    endAssistantMessage
  ])

  // ── ExternalStoreRuntime wiring ─────────────────────────────────────
  const runtime = useExternalStoreRuntime({
    messages: messages as ThreadMessageLike[],
    isRunning: streaming,
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
        // the failure instead of a silent void.
        startAssistantMessage(`err_${Date.now()}`)
        setError(`err_${Date.now()}`, msg)
        endAssistantMessage()
      }
    },

    onCancel: async () => {
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
      attachments: imageAttachmentAdapter
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
