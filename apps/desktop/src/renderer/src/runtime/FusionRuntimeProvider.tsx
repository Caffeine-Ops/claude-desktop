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
import { useProposalStore } from '../stores/proposal'
import type { ProposalProduct, ProposalSection } from '../stores/proposal'
import { matchProducts } from '../lib/kbProductMatch'
import { dispatchChatTurn } from '../lib/dispatchChatTurn'
import { extractProposalDraftResult, detectContentSentinelAheadOfPhase } from '@shared/proposal'
import { splitBlocks } from '@shared/proposalBlocks'
import { triggerProposalCitationVerification } from '../lib/proposalVerification'
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
import { fileAttachmentAdapter, FILE_PATH_MIME } from './imageAttachmentAdapter'

/**
 * 打开一个会话后，按优先级重建方案草稿（内存→盘→transcript→非方案清空，四级）。
 *
 * 为什么需要：方案草稿（sections）只活在内存 zustand、从不持久化，但草稿正文都带着
 * 方案哨兵（PROPOSAL_DRAFT_*）写进了会话 JSONL。app 重启 / 切到别的历史方案会话后，
 * 内存里没有那份 sections，旧代码也不在载入时重建——于是「点之前生成草稿的对话，却
 * 看不到草稿」。这里在 loadSession 拿到 messages 后，从 assistant 消息里抽哨兵块重建。
 *
 * 关键前置（不覆盖内存手改）：若内存里【已】持有该会话的草稿（active && 同 sessionId &&
 * sections 非空），一律不重建——用户在纸面上的手改 / 重排 / 删节没进 transcript，用
 * transcript 覆盖会把这些编辑抹掉。此时只确保工作台可见即可。仅当内存里没有该会话草稿
 * （重启 / 跨会话）才据 transcript 重建。非方案会话（抽不到任何哨兵块）则清空前台 store，
 * 避免陈旧草稿被「写方案」误 reopen（第 4 级）。
 */
async function rebuildProposalFromTranscript(
  sessionId: string,
  messages: ThreadMessageLike[]
): Promise<void> {
  const ps = useProposalStore.getState()
  // 1. 内存里已有该会话草稿（含未保存手改，比盘上新）→ 保留，仅确保工作台可见。
  if (ps.active && ps.sessionId === sessionId && ps.sections.length > 0) {
    if (!ps.workspaceOpen) ps.setWorkspaceOpen(true)
    return
  }
  // 2. 盘上有持久草稿（含手改/产品/phase）→ 优先恢复。I/O 失败降级到 transcript，不抛。
  try {
    const rec = await window.chatApi.loadProposalDraft({ sessionId })
    if (rec && rec.sections.length > 0) {
      useProposalStore.getState().restoreFromDisk(rec)
      // 恢复路径补校验：verification 是派生信号、刻意不持久化，restore 回来的节 verification
      // 全是 undefined。校验此前只在实时生成路径（end / syncSections / reviseSection）触发过，
      // 重开会话 / 重启 app 后必须重新核对——否则引用徽标恒灰、导出埋点把整片记成
      // unverifiedSections（M-0 基线发现的回写缺口：实测旧会话导出全是 unverified:9）。
      // trigger 幂等（已校验 / 在飞 / 非 content / 截断节自动跳过）、异步、失败静默，不阻塞。
      triggerProposalCitationVerification()
      return
    }
  } catch (err) {
    console.warn('[runtime] loadProposalDraft failed:', err)
  }
  // 3. transcript 兜底：从 assistant 消息抽哨兵块重建（仅 AI 正文，不含手改）。
  const sections: ProposalSection[] = []
  const consumed = new Set<string>()
  for (const m of messages) {
    const mm = m as unknown as { id?: string; role?: string; content?: unknown }
    if (mm.role !== 'assistant') continue
    const text = Array.isArray(mm.content)
      ? (mm.content as Array<{ type?: string; text?: string }>)
          .filter((p) => p?.type === 'text' && p.text)
          .map((p) => p.text as string)
          .join('')
      : typeof mm.content === 'string'
        ? mm.content
        : ''
    if (!text) continue
    const { blocks, truncated } = extractProposalDraftResult(text)
    if (!blocks.length && !truncated) continue
    for (const b of blocks) {
      sections.push({ id: crypto.randomUUID(), markdown: b.markdown, kind: b.kind })
    }
    if (truncated) {
      sections.push({
        id: crypto.randomUUID(),
        markdown: truncated.markdown,
        kind: truncated.kind,
        truncated: true
      })
    }
    if (mm.id) consumed.add(mm.id)
  }
  if (sections.length === 0) {
    // 4. 非方案会话：清空前台 store（旧草稿已在盘上、无损），避免陈旧草稿被「写方案」误 reopen。
    if (useProposalStore.getState().active) useProposalStore.getState().reset()
    return
  }
  // transcript 重建出的草稿：写进 store；订阅器（Task 5）随后自动落盘建档。
  const phase = sections[sections.length - 1].kind
  useProposalStore
    .getState()
    .restoreFromTranscript({ sessionId, sections, consumedDraftIds: consumed, phase })
  // 同盘恢复路径：transcript 重建的节同样无 verification，补触发校验（幂等、异步、不阻塞）。
  triggerProposalCitationVerification()
}

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
        startAssistantMessage,
        appendAssistantDelta,
        startReasoning,
        appendThinkingDelta,
        startToolCall,
        appendToolCallArgsDelta,
        finalizeToolCall,
        addToolCall,
        updateToolCallResult,
        setError,
        endAssistantMessage,
        setUsage
      })
      const unsub = window.chatApi.onEvent(sid, handler)
      current.set(sid, unsub)
    }
    // Do NOT unsub on effect cleanup — only unmount should tear down
    // subscriptions. Effect cleanup runs on every deps change and
    // would churn the whole map even though the reconciler above
    // already computed an exact diff.
    return undefined
  }, [
    subscribedIdsKey,
    startAssistantMessage,
    appendAssistantDelta,
    startReasoning,
    appendThinkingDelta,
    startToolCall,
    appendToolCallArgsDelta,
    finalizeToolCall,
    addToolCall,
    updateToolCallResult,
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
      const text =
        mentionSuffix.length > 0
          ? baseText
            ? `${baseText} ${mentionSuffix}`
            : mentionSuffix
          : baseText

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

      // append 用户气泡 → 预翻转 spinner（应对 lazy 冷启动的静默期）→ send → 失败兜底，
      // 统一走 dispatchChatTurn（与阶段按钮 sendProposalStageMessage 共享，见发现 10）。
      // payload 用 thunk：方案产品匹配须在【预翻转之后】跑，保住「spinner 立刻亮、匹配在其
      // 后」的时序；其内 await 抛错也由 dispatchChatTurn 的 catch 兜底。
      await dispatchChatTurn({
        sessionId: targetSid,
        storeContent,
        logTag: '[runtime]',
        payload: async () => {
          // 方案模式：门控同 proposalMode——只有当前发送的 targetSid 与方案绑定
          // 的 sessionId 相同才算（防泄漏到其他 tab / 后台 agent）。
          const ps = useProposalStore.getState()
          const isProposal = ps.active && ps.sessionId === targetSid
          let proposalProducts: ProposalProduct[] | undefined
          if (isProposal) {
            if (!ps.seeded) {
              // 方案首发：仅在尚未播种时对用户文本匹配产品并【一次性】播种——即便零命中
              // 也置 seeded，从此固定这套集合。后续 turn（逐部分推进）一律复用，不再
              // readKbIndex/matchProducts，也不会在会话中途忽然命中而骤然收窄检索范围。
              // 召回优先：多命中无害（多一个可读目录，AI 仍按用户文字写），可在
              // ProposalDocPanel 的 chip 删（走 setProducts，不重置 seeded）。
              const idx = await window.chatApi.readKbIndex()
              // await 期间可能有并发的另一首发轮也已进入本分支（两轮都在 await 前读到
              // seeded=false）。await 之后这段 check+seed 没有 await、是同步原子执行的
              // （JS 单线程），故先再查一次：若已被那一轮播种，直接复用其产品集，绝不
              // 二次 matchProducts 覆盖——否则两轮各自匹配、后者覆盖前者，store/chip 与
              // 实际已发送的产品集发生分叉（评审发现 3）。
              const cur = useProposalStore.getState()
              if (cur.seeded) {
                proposalProducts = cur.products
              } else {
                const matched = matchProducts(text, idx)
                cur.seedProducts(matched)
                proposalProducts = matched
              }
            } else {
              proposalProducts = ps.products
            }
          }

          return {
            sessionId: targetSid,
            // Engine validator accepts empty strings when images are present.
            // We still pass an empty string (not undefined) so the wire
            // shape stays stable.
            text: text,
            images: images.length > 0 ? images : undefined,
            // 方案模式：透传给 engine，本次 spawn 据此烘焙方案系统提示词 +
            // 把识别产品的镜像子目录加进可读范围（零命中退回整库）。
            proposalMode: isProposal,
            proposalProducts,
            // 内容级召回（#2）：封面阶段外都开（phase !== 'cover'，即目录+正文）。composer
            // 自由输入也走这里——用户手敲推进语而非点按钮时 phase 滞后，卡 'content' 会漏掉首个
            // 正文回合的召回（实测踩到）。放宽到「非封面」让手敲/点按钮都触发；封面回合（首发
            // 播种）不召回。零命中不注入，偶发目录回合触发无害。
            proposalRetrieve: isProposal && useProposalStore.getState().phase !== 'cover'
          }
        }
      })
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

  // 防抖写盘：草稿任一改动后 ~800ms 落盘一次（合并连续键入）。timer 放 ref 以便切换会话
  // 前同步 flush（防最后几笔手改还没落盘就被新会话覆盖）。
  const proposalSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushProposalSave = useCallback((): void => {
    if (proposalSaveTimer.current) {
      clearTimeout(proposalSaveTimer.current)
      proposalSaveTimer.current = null
    }
    const s = useProposalStore.getState()
    // 只存「有内容的活跃草稿」；空草稿不建档（避免起草前就生成空文件）。
    if (!s.active || !s.sessionId || s.sections.length === 0) return
    // P3-3：不再 fire-and-forget。写盘是「尽力而为」（失败绝不阻塞会话切换/键入），但结果要回写
    // store 的 draftSaveFailed——失败（磁盘满/权限/路径）原本被静默吞掉，用户误以为已存、切走就丢。
    // 拿到 {ok:false} 或 IPC 抛错都置 true（面板显示「草稿未保存」常驻提示）；成功落盘置 false 自愈。
    window.chatApi
      .saveProposalDraft({
        version: 1,
        sessionId: s.sessionId,
        // 只持久化 ProposalDraftRecord 声明的字段。【显式裁剪】而非透传 s.sections：verification
        // （异步回填、易陈旧）与 baselineMarkdown（= markdown 的副本，restoreFromDisk 会重新派生）
        // 都标注【不持久化】，但直接传 s.sections 这个加宽变量会跳过 TS 的 excess-property 检查、
        // 把它们一起写盘——违反持久化契约、盘上体积近翻倍（评审发现）。改用对象字面量 map：多余
        // 字段会被 excess-property 检查当场拦下，反过来兜住此类越界。
        sections: s.sections.map((sec) => ({
          id: sec.id,
          markdown: sec.markdown,
          kind: sec.kind,
          truncated: sec.truncated
        })),
        products: s.products,
        phase: s.phase,
        updatedAt: Date.now()
      })
      .then((r) => useProposalStore.getState().setDraftSaveFailed(!r.ok))
      .catch(() => useProposalStore.getState().setDraftSaveFailed(true))
  }, [])

  // 订阅草稿 store：任一改动重置 800ms 防抖计时，到点落盘。卸载时清计时 + 退订。
  useEffect(() => {
    const unsub = useProposalStore.subscribe(() => {
      const s = useProposalStore.getState()
      if (!s.active || !s.sessionId || s.sections.length === 0) return
      if (proposalSaveTimer.current) clearTimeout(proposalSaveTimer.current)
      proposalSaveTimer.current = setTimeout(() => {
        proposalSaveTimer.current = null
        flushProposalSave()
      }, 800)
    })
    return () => {
      if (proposalSaveTimer.current) clearTimeout(proposalSaveTimer.current)
      unsub()
    }
  }, [flushProposalSave])

  const onSwitchToNewThread = useCallback(async (): Promise<void> => {
    if (!window.chatApi) return
    // Multi-runtime: switching away from a streaming session is now
    // non-destructive — the prev runtime keeps running in the
    // background and its deltas accumulate in its own perSession slot.
    // No interrupt confirmation needed; the old streamingGuard call
    // was a holdover from the single-runtime era when switching
    // teardowned the prev cli.
    try {
      // 切走前把当前会话草稿的最后改动落盘（防抖可能还没触发）。
      flushProposalSave()
      setSessionLoading(true)
      const { sessionId: newId } = await window.chatApi.newSession()
      // `--session-id newId` (no resume) — cli should honor it, but
      // use the returned activeId defensively in case of a rebind.
      const { sessionId: activeId } = await window.chatApi.switchSession({
        sessionId: newId,
        resume: false
      })
      setSession(activeId, [])
      // 新建空会话：以空 messages 走同一重建（盘上无该 id 草稿 → 走第 4 级 reset），清掉
      // 前台可能残留的别会话草稿，避免「写方案」把旧草稿 reopen 到新会话（陈旧草稿劫持）。
      await rebuildProposalFromTranscript(activeId, [])
    } catch (err) {
      console.error('[runtime] new thread failed', err)
    } finally {
      setSessionLoading(false)
    }
  }, [setSession, setSessionLoading, flushProposalSave])

  const onSwitchToThread = useCallback(
    async (id: string): Promise<void> => {
      if (!window.chatApi) return
      // Multi-runtime: non-destructive switch. See onSwitchToNewThread
      // for the rationale — the prev session keeps its cli alive in
      // the background, so there's nothing to interrupt.
      try {
        // 切走前把当前会话草稿的最后改动落盘（防抖可能还没触发）。
        flushProposalSave()
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
        // 历史会话载入即重建方案草稿（盘优先、transcript 兜底）。await 确保草稿与历史一起就绪。
        await rebuildProposalFromTranscript(id, messages as ThreadMessageLike[])

        // Wait for cli ready. In the rare fusion-code `--resume X`
        // silent-fork case the cli picks a different id Y for the
        // forward JSONL; main forwards Y here so we can rebind the
        // chat store + the IPC subscription key to the real id the
        // cli is emitting on. When activeId === id (the common path),
        // this second setSession is a no-op-ish rerender.
        const { sessionId: activeId } = await switchPromise
        if (activeId !== id) {
          setSession(activeId, messages as ThreadMessageLike[])
          // 静默 fork 重绑：草稿也重绑到真实 id。
          await rebuildProposalFromTranscript(activeId, messages as ThreadMessageLike[])
        }
      } catch (err) {
        console.error('[runtime] switch thread failed', err)
      } finally {
        setSessionLoading(false)
      }
    },
    [setSession, setSessionLoading, flushProposalSave]
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
  // 流式硬门（①）：每条 messageId 至多 abort 一次的去重集。模块/闭包级即可——掐断是会话级副作用。
  const tocGuardAborted = new Set<string>()
  return (event: ChatEvent) => {
    switch (event.type) {
      case 'start':
        actions.startAssistantMessage(sid, event.messageId)
        break
      case 'chunk':
        actions.appendAssistantDelta(sid, event.messageId, event.delta)
        // 流式硬门（①·根因「目录阶段一直在思考」）：方案目录阶段若 AI 跳过确认、刚冒出正文
        // 哨兵，立即 abort 本轮，避免它跑飞整篇正文（见 maybeAbortOnTocSkip）。非方案/正文阶段
        // 内部短路，开销可忽略。
        maybeAbortOnTocSkip(sid, event.messageId, tocGuardAborted)
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
        // 方案模式：AI 生成封面/目录后用 AskUserQuestion 暂停确认，此刻把已闭合的哨兵块即时
        // 同步进右侧草稿——否则要等整轮 'end' 才入库，确认期间右侧一直空着（用户报的 bug）。
        // 封面文本块先于本工具调用流完，故此时已在 store。幂等（内容级去重），与轮末不冲突。
        if (event.toolName === 'AskUserQuestion') {
          syncProposalDraftFromInflight(sid, event.messageId)
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
        // 同 tool_use_start：非流式 tool_use 路径也兜一道 AskUserQuestion 轮内同步（两条路径
        // 互斥触发，幂等故双触发也无害）。
        if (event.toolName === 'AskUserQuestion') {
          syncProposalDraftFromInflight(sid, event.messageId)
        }
        break
      case 'tool_result':
        actions.updateToolCallResult(sid, event.toolUseId, event.output)
        break
      case 'usage':
        actions.setUsage(sid, {
          contextTokens: event.contextTokens,
          outputTokens: event.outputTokens
        })
        break
      case 'end': {
        // Proposal mode: accumulate the just-finished assistant message's
        // DRAFT sections into the right-side document panel. We read HERE
        // (at 'end', once per message) rather than on 'chunk', because the
        // store already holds the fully assembled text and 'end' is the
        // correct once-per-message point.
        //
        // 三道门，缺一不可：
        //   1. 会话门控：只累积方案绑定会话（ps.sessionId === sid）的输出，防止别的
        //      会话（多 tab / 后台 agent）的 end 污染方案草稿 sections。
        //   2. 消息级去重：按 event.messageId 记账，end 对同一 messageId 二次触发
        //      （异常路径重发等）时不重复累积同一段（修复草稿重复）。
        //   3. 精确定位：用 event.messageId 找到刚结束的那条消息（store 里消息 id
        //      就是 messageId，见 chat.ts appendAssistantDelta），而非倒序抓「最后
        //      一条 assistant」——后者会误抓错误占位等尾随消息、把报错写进草稿。
        // 防御性兜底（根因·「一直在思考」）：下面整段方案草稿处理（抽取/入库/校验）一旦同步
        // 抛错，绝不能漏掉清 spinner 的 endAssistantMessage——否则 streaming 永远停在 true，
        // 聊天气泡的 ThinkingSpinner 与右栏 ProposalDocPanel/ProposalPaper 的「AI 生成中」两处
        // loading 都永久搁浅，表现为「永远在思考」。故把全段包进 try、endAssistantMessage 落在
        // finally，无论草稿处理成败都复位 turn 状态。catch 只记日志、不重抛——避免异常冒泡到
        // preload 的 onEvent（那里也无 try/catch，会丢到 ipcRenderer 监听器外）。代价仅是出错
        // 那一轮的草稿可能没入库（可恢复），远好于把整个会话钉死在思考态。
        try {
          const _ps = useProposalStore.getState()
          if (
            _ps.active &&
            _ps.sessionId === sid &&
            !_ps.consumedDraftIds.has(event.messageId)
          ) {
            const slot = useChatStore.getState().perSession[sid]
            const msg = slot?.messages.find((m) => m.id === event.messageId) as
              | { role: string; content: Array<{ type: string; text?: string }> }
              | undefined
            if (msg && msg.role === 'assistant') {
              // Collect all 'text' parts (skip 'reasoning' / tool-call parts).
              const fullText = msg.content
                .filter((p) => p.type === 'text' && p.text)
                .map((p) => p.text!)
                .join('')
              // 每个闭合哨兵块映射为一节；提问 / 过程对话不带哨兵 → 不入节（修复提问污染
              // 文档）。哨兵与抽取器在 shared/proposal.ts，与提示词规则 6 同源。appendSections
              // 内部按 messageId 去重并记账，分节入 store。
              //
              // 三态分流（B2）：
              //   - 有闭合块或截断残文 → appendSections（截断残文恢复成一节并标记，绝不静默丢）。
              //   - 完全无哨兵（纯对话轮）→ 仅记账，使同一 messageId 的 end 不再二次处理。
              const { blocks, truncated } = extractProposalDraftResult(fullText)
              // 定向修订分流（方案一）：pendingRevision 非空 = 上一动作（节重写/展开/精简/据来源
              // 修正/截断续写）要求本轮产出【整节替换】某节，而非 append 新节。三种结局：
              //   ① 目标节仍在 + 拿到 content 块 → reviseSection 整节替换，清指针，重新校验。
              //   ② 目标节仍在 + 本轮无可用产出（修订被截断/空）→ 放弃替换，原节不动，仅记账。
              //   ③ 目标节已不在（pending stale：节被删 / reopen 切到别的会话残留指针）→ 回退
              //      正常累积路径，绝不让产出走 reviseSection 的 no-op 而被静默吞掉（评审：
              //      reopen 新会话后 stale pending 会吃掉新会话首段正文）。
              const pending = useProposalStore.getState().pendingRevision
              const target = pending
                ? useProposalStore.getState().sections.find((s) => s.id === pending.sectionId)
                : undefined
              const revised = blocks.find((b) => b.kind === 'content') ?? blocks[0]
              if (pending && target && revised) {
                useProposalStore.getState().setPendingRevision(null)
                if (pending.blockRange) {
                  // blockRange 存在=选区即改：【不即时落地】。把「原文 vs 改写后」登记成一条挂在
                  // 本条助手消息（event.messageId）下的待审阅项，由 ThreadView 的 ProposalRevisionReview
                  // 在该消息下方渲染对照 + [应用/放弃/继续改]，用户点「应用」才 spliceBlocks 落地
                  // （见 ThreadView）。原文按【当时的】target.markdown 切块夹紧取，与 blockRange 同源。
                  const secBlocks = splitBlocks(target.markdown)
                  const start = Math.max(0, Math.min(pending.blockRange.start, secBlocks.length - 1))
                  const end = Math.max(start, Math.min(pending.blockRange.end, secBlocks.length - 1))
                  useProposalStore.getState().addBlockReview(event.messageId, {
                    sectionId: pending.sectionId,
                    blockRange: { start, end },
                    before: secBlocks.slice(start, end + 1).join('\n\n'),
                    after: revised.markdown
                  })
                  // 记账：产出已转存进 blockReview，不能再被 appendSections 当新节追加。
                  useProposalStore.getState().markDraftConsumed(event.messageId)
                } else {
                  // 缺省=整章替换（节重写/展开/精简/据来源修正/截断/补料）：仍即时落地整节替换，
                  // reviseSection（重置 verification 触发重校验、更新 baseline、清 truncated）。
                  useProposalStore.getState().reviseSection(pending.sectionId, revised.markdown)
                  triggerProposalCitationVerification()
                }
              } else if (pending && target) {
                // 修订轮被截断 / 空产出：保留原节（不变量：绝不用半截覆盖好内容），清指针 + 记账。
                // 诊断（「点了改写没反应」的核心落点）：模型这轮【没吐出方案哨兵块】——通常是它跑偏去
                // 评估/写文件/闲聊了，故拿不到 revised、不生成审阅项、正文也不变。把它显式打出来。
                console.warn(
                  '[proposal-revise] 本轮修订未产出可用的【方案正文哨兵块】——模型可能跑偏（评估/写文件/闲聊），' +
                    '未生成「应用/放弃」审阅项、正文保持不变。建议重试或新开方案会话。',
                  { sectionId: pending.sectionId, blockRange: pending.blockRange, messageId: event.messageId }
                )
                useProposalStore.getState().setPendingRevision(null)
                useProposalStore.getState().markDraftConsumed(event.messageId)
              } else {
                // 无 pending，或 pending 已 stale → 回归正常累积。stale 指针在此一并清除。
                if (pending) useProposalStore.getState().setPendingRevision(null)
                if (blocks.length || truncated) {
                  useProposalStore.getState().appendSections(event.messageId, blocks, truncated)
                  // 引用落地校验（#1）：appendSections 内部生成节 id，这里无法直接拿到新节，
                  // 故扫一遍 store 对「未校验的正文节」异步触发——已校验的（verification!==undefined）
                  // 与在飞的（verifyingSectionIds）天然跳过，故重复调用幂等、只补新节。封面/目录
                  // 与截断残节不校验（前者无来源标注，后者内容本就不完整）。
                  triggerProposalCitationVerification()
                } else {
                  useProposalStore.getState().markDraftConsumed(event.messageId)
                }
              }
            }
            // C4：msg 未找到（end 早于消息入 store 的竞态）或 role 非 assistant 时，
            // 刻意【不】记账。重构前这里有一条无条件兜底 markDraftConsumed，但那与 B2 相悖：
            // 若 end 对同一 messageId 二次触发（见上方注释「异常路径重发」），第一次 msg
            // 尚未就绪就记账，会让第二次 msg 已就绪的正文被 consumedDraftIds 挡掉而永久丢失。
            // 不记账则第一次空跑、第二次正常 append——只有「确实读到正文/截断/确认纯对话」
            // 才记账，更安全。未记账的孤儿 id 也无害：除本 handler 外无人读 consumedDraftIds。
          }
        } catch (err) {
          console.error('[runtime] proposal end-handler threw (草稿可能未入库，turn 状态照常复位):', err)
        } finally {
          actions.endAssistantMessage(sid)
        }
        break
      }
      case 'error':
        actions.setError(sid, event.messageId, event.error)
        actions.endAssistantMessage(sid)
        break
      default:
        break
    }
  }
}

/**
 * 轮内草稿同步：AI 在一个 SDK 轮里生成封面/目录后用 AskUserQuestion 暂停确认，但该轮的
 * 'end'（草稿入库的原触发点）要等模型彻底停下才到——期间右侧草稿一直空着（用户报的「对话
 * 说生成封面了、右侧还是空的」）。故在 AskUserQuestion 工具调用出现时（模型刚结束一段哨兵
 * 块、暂停发问），把当前在飞消息里【已闭合】的哨兵块即时同步进右侧草稿。
 *
 * 只取闭合块（truncated 丢弃）：半截内容会在后续流里闭合、轮末再正式入库；store.syncSections
 * 的内容级去重保证与轮末 appendSections 不重复、且不消费 messageId（同消息余下块仍走轮末）。
 * 门控同 'end' 路径：仅方案绑定会话（active && sessionId===sid）、按 messageId 精确取消息。
 */
/**
 * 流式硬门（①·根因「目录阶段一直在思考」）：方案模式下，逐个 chunk 检查在飞消息——若当前 phase
 * 还没确认目录（cover/toc）、AI 却已冒出【独占整行】的正文起始哨兵，说明它跳过了目录确认、正要
 * 跑飞整篇正文。此刻立即 abort 本轮，趁它刚起手就掐断（详见 shared/proposal.ts
 * detectContentSentinelAheadOfPhase）。
 *
 * abort 后引擎同步发 'end'（engine.ts:1253）→ 'end' 处理把这段未闭合的越界正文经阶段门剔除并设
 * stageSkip → ProposalDocPanel 的自动补救 effect 重发「只生成目录 + 发起确认」，把 AI 拉回正轨。
 * 故本函数只管「尽早掐断」，重发与上限（autoTocFix≤2）复用既有补救链，不在此另起循环。
 *
 * 去重：每条 messageId 至多 abort 一次（aborted 集合）——掐断后该轮仍可能再吐几个残 chunk，绝不
 * 重复 abort。phase==='content'（用户已确认目录）由 detect 内部短路，正文阶段零开销、绝不误伤。
 */
function maybeAbortOnTocSkip(sid: string, messageId: string, aborted: Set<string>): void {
  if (aborted.has(messageId)) return
  const ps = useProposalStore.getState()
  if (!ps.active || ps.sessionId !== sid || ps.phase === 'content') return
  const slot = useChatStore.getState().perSession[sid]
  const msg = slot?.messages.find((m) => m.id === messageId) as
    | { role: string; content: Array<{ type: string; text?: string }> }
    | undefined
  if (!msg || msg.role !== 'assistant') return
  const fullText = msg.content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('')
  if (!detectContentSentinelAheadOfPhase(fullText, ps.phase)) return
  aborted.add(messageId)
  console.warn(
    `[runtime] proposal: 正文哨兵出现在 ${ps.phase} 阶段（AI 跳过目录确认）→ abort 本轮，交自动补救拉回`,
    { sid }
  )
  void window.chatApi.abort({ sessionId: sid })
}

function syncProposalDraftFromInflight(sid: string, messageId: string): void {
  const ps = useProposalStore.getState()
  if (!ps.active || ps.sessionId !== sid) return
  const slot = useChatStore.getState().perSession[sid]
  const msg = slot?.messages.find((m) => m.id === messageId) as
    | { role: string; content: Array<{ type: string; text?: string }> }
    | undefined
  if (!msg || msg.role !== 'assistant') return
  const fullText = msg.content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('')
  const { blocks } = extractProposalDraftResult(fullText)
  if (!blocks.length) return
  useProposalStore.getState().syncSections(blocks)
  triggerProposalCitationVerification()
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
