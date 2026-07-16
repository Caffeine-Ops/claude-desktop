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
import { useWorkspaceStore } from '../stores/workspace'
import { useMessageQueueStore } from '../stores/messageQueue'
import { useUnreadStore } from '../stores/unread'
import { useSessionTitleStore } from '../stores/sessionTitle'
import { useComposerModeStore } from '../stores/composerMode'
import { useI18n, useT } from '../i18n'
import { pushUiLog } from '../stores/uiLogs'
import { createOpenAIWhisperDictationAdapter } from './openaiWhisperDictationAdapter'
import { useDialogStore, type DialogKind } from '../stores/dialogs'
import type { ChatEvent, ThreadSummary } from '@desktop-shared/types'
import type { ChatImagePayload } from '@desktop-shared/ipc-channels'
import {
  applyChatEventToStore,
  createChatEventCtx,
  type ChatEventActions,
  type LiveHooks
} from './applyChatEventToStore'
import { isReplaySessionId } from '../replay/replayStore'
import { fileAttachmentAdapter, FILE_PATH_MIME } from './imageAttachmentAdapter'
import { useProposalStore } from '../stores/proposal'
import type { ProposalProduct, ProposalSection } from '../stores/proposal'
import {
  extractProposalDraftResult,
  detectContentSentinelAheadOfPhase
} from '@desktop-shared/proposal'
import { splitBlocks } from '@desktop-shared/proposalBlocks'
import { triggerProposalCitationVerification } from '../lib/proposalVerification'
import { autoFireProposalGenImages } from '../lib/proposalGenImageFire'
import { maybeNudgeStageConfirmAfterTurn } from '../lib/proposalStageGate'
import { matchProposalSlash } from '../lib/proposalSlash'
import { stripScenarioSlash } from '../lib/scenarioSlash'
import { useRailSessionsStore } from '../stores/railSessions'
import { buildGapFillRewriteMessage, drainRevisionQueue } from '../lib/sendProposalSectionRevision'
import { startOrReopenProposal } from '../lib/startOrReopenProposal'
import { matchProducts } from '../lib/kbProductMatch'

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
      // unverifiedSections。trigger 幂等（已校验 / 在飞 / 非 content / 截断节自动跳过）、
      // 异步、失败静默，不阻塞。
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
  // transcript 重建出的草稿：写进 store；持久化订阅器随后自动落盘建档。
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
  const t = useT()
  // onNew 拦截 /proposal-writer 空调用时要把引导模板写回 composer，但 onNew 是
  // useExternalStoreRuntime 参数对象里的闭包、定义时 runtime 还不存在——经 ref 间接
  // 引用（与下面 useThreadListAdapter 的 sessionIdRef 同一手法），调用期必已就绪。
  const runtimeRef = useRef<ReturnType<typeof useExternalStoreRuntime> | null>(null)
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
  //
  // 回放 slot（replay: 前缀）结构性排除：它是纯前端表演会话，main 侧没有
  // 对应 runtime——订阅它的 onEvent 只是空转，但配套的 queueList 种子会
  // 拿着假 id 打真 IPC。回放事件由 ReplayController 直接喂 store，不走
  // CHAT_EVENT，这里根本不需要它。
  const subscribedIdsKey = useMemo(() => {
    const merged = new Set<string>(activeRuntimeIds)
    if (sessionId && !isReplaySessionId(sessionId)) merged.add(sessionId)
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
      // 回放会话绝不发送：replay: slot 是纯前端表演，把它的 id 交给
      // chatApi.send 会让 main 为一个不存在的会话 spawn CLI。回放期
      // composer 因 streaming 只读，这里是最后一道结构性闸门（done 态
      // streaming 已翻 false，唯有这道守卫拦住误触）。读 LIVE 前台 id
      //（getState，同本回调内 streaming 的既有惯例——闭包可能 stale）。
      if (isReplaySessionId(useChatStore.getState().sessionId)) return
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

      // let（非 const）：/proposal-writer 拦截命中时会把两者改写成剥掉命令后的正文。
      let baseText = textParts.map((p) => p.text).join('\n').trim()

      // 代码开发场景伪命令（/daily-dev 等，ScenarioRail 二级导航标签）：
      // fusion-code 不认识它们，发送前必须剥掉、只发正文。放在 mention 后缀
      // 拼接之前——改写 baseText，下面的 text 组装自然拿到干净正文。没有
      // 任何模式激活语义（场景信息已蕴含在推荐 prompt 正文里），剥掉即完。
      const scenarioStripped = stripScenarioSlash(baseText)
      if (scenarioStripped) baseText = scenarioStripped.rest
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

      // Slides/spreadsheet/video mode's slash-prepend only belongs on this
      // session's FIRST message. The mode picker (Composer.tsx) hides itself
      // once a session has messages — mode can't change mid-session anymore
      // — so if mode is still e.g. 'video' on message #2+, it was already
      // 'video' at message #1 too, meaning message #1 already carried the
      // slash and re-invoked the skill. Re-prepending on every later send
      // (queued follow-ups included) put a raw literal `/claude-desktop:remotion`
      // in front of routine continuation text — every queued message, forever,
      // for the rest of the session (2026-07-09 user report: queue preview
      // showing the command repeated on a plain "2" follow-up). Proposal mode
      // right below already gets this right ("语义只属于「再入」"); slides/
      // spreadsheet/video lacked the equivalent guard until now.
      const isFirstMessage = useChatStore.getState().messages.length === 0

      // Slides 会话标记（ComposerModePicker 退役后的唯一写手，2026-07-16）：
      // 首条消息以 ppt-master 斜杠开头（EmptyState ScenarioRail 的「制作PPT」
      // chip、SkillPicker、或手敲 `/`，殊途同归都是 leading 命令）就把本会话
      // 标记为 slides 会话 → ThreadView 双分栏工作台。旧机制是「发送时全局
      // mode===slides 则 markIfSlides + 拼 /ppt-master 前缀」，模式入口收敛到
      // 技能 chip 后，斜杠本身就在正文里，不再需要拼前缀——spreadsheets /
      // remotion 两段同款拼前缀逻辑同理一并退役（chip 自带命令）。
      const alreadyPptSlash = /^\/(claude-desktop:)?ppt-master\b/.test(baseText)
      if (alreadyPptSlash && isFirstMessage && sessionId !== null) {
        useComposerModeStore.getState().markSlidesSession(sessionId)
      }

      // Rail 乐观新生行（2026-07-16 用户报「新开的对话左侧列表没看到」）：
      // 新会话的 jsonl 要等 CLI 冷启动 + 首条落盘才进 listShellSessions，
      // 空窗几秒到几十秒里 rail 见不到这个会话。首条消息发出的此刻就插一
      // 行占位（title=正文截断，与 main 侧 firstPrompt 回退同语义），落盘
      // 后的权威 reload 自动接管校正（保护机制见 railSessions 的
      // optimisticBirths）。turnCount 记 1（就是本条）。
      if (isFirstMessage && sessionId !== null) {
        const optimisticTitle = (baseText || text).slice(0, 120)
        useRailSessionsStore.getState().applyBirth({
          id: sessionId,
          title: optimisticTitle,
          updatedAt: Date.now(),
          firstPrompt: optimisticTitle,
          turnCount: 1
        })
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
      // 斜杠再入补播种标记：/proposal-writer 带尾随文字且草稿已存在（reopen）时置真，
      // 下方 proposal payload 计算据此对新需求文字补跑产品匹配（只增不减）。
      let proposalReopenedWithBrief = false
      if (images.length === 0 && filePaths.length === 0) {
        // 【优先级不变量】两套斜杠匹配按书写顺序生效：matchSlashCommand（DialogKind，
        // /skill、/mcp）先试、命中即 return——若未来某命令名同时出现在两边，先跑的
        // 静默赢。加新斜杠功能时先核对另一边的名单。
        const dialogKind = matchSlashCommand(baseText)
        if (dialogKind) {
          useDialogStore.getState().openDialog(dialogKind)
          return
        }

        // ─── /proposal-writer：写方案斜杠入口（拦截，不发给 CLI）────────
        // 方法论必须经 systemPrompt.append 无条件注入（硬门纪律不能靠模型自愿展开
        // skill），所以这个命令在 renderer 侧消化：激活方案模式后，空调用=引导语义
        // （预填引导模板），带尾随文字=剥掉命令、尾随文字当本轮用户消息继续走
        // 下面的正常发送路径。首发时 matchProducts 播种，reopen 再入时对新文字
        // 补充匹配、只增不减——见 proposal payload 计算。
        const proposalSlash = matchProposalSlash(baseText)
        if (proposalSlash) {
          if (sessionId === null) {
            console.error('[runtime] /proposal-writer：无前台会话，忽略')
            return
          }
          const outcome = startOrReopenProposal(sessionId)
          if (!proposalSlash.rest) {
            // 空调用：'started'（首发）才预填模板；'reopened' 绝不覆盖 composer。
            // queueMicrotask：assistant-ui send() 在 onNew 之后才清空 composer，
            // 同步 setText 会被那次清空吃掉，推迟一拍写入。
            if (outcome === 'started') {
              queueMicrotask(() => {
                runtimeRef.current?.thread.composer.setText(t('scenarioProposalPrompt'))
                document.querySelector<HTMLElement>('.ProseMirror')?.focus()
              })
            }
            return
          }
          baseText = proposalSlash.rest
          text = proposalSlash.rest
          proposalReopenedWithBrief = outcome === 'reopened'
        }
      }

      // （已退役，2026-07-16）「发送时全局 mode===proposal 则激活方案模式」——
      // ComposerModePicker 退役后写方案的唯一入口是 /proposal-writer 斜杠
      // （ScenarioRail chip / SkillPicker / 手敲），上方 matchProposalSlash
      // 拦截已完整承载激活语义，这里不再需要按全局 mode 兜底。

      // ─── 资料缺失·补料落地（发送时收口）─────────────────────────────
      // 用户在只读草稿点了某处缺口的「去对话框补充」→ pendingGapFill 记着「这一章有这处缺口正等你
      // 在对话框补料」。此刻用户发出的这条消息就是那段资料：把它【包进「只重写这一章、删缺口标记、
      // 按溯源规则标来源」的指令】发给引擎（sentTextOverride），并置 pendingRevision 让本轮产出的正文
      // 块经 end 分流【整节替换】该节；随即清掉标记。用户气泡（storeContent/队列面板）仍只显示他打的
      // 原文，包装指令只走引擎、不进 UI。前提是这条消息有正文（text 非空——纯图片不误触发补料）。
      // 时序：gap-fill 是「草稿已生成、用户复核缺口」时的动作，此时通常没有在飞的流，故直接置
      // pendingRevision 安全（不会撞上另一轮 content 产出的 end 分流把指针张冠李戴）。
      let sentTextOverride: string | null = null
      {
        const ps = useProposalStore.getState()
        const gap = ps.active && ps.sessionId === sessionId && text ? ps.pendingGapFill : null
        if (gap) {
          if (ps.sections.some((s) => s.id === gap.sectionId)) {
            sentTextOverride = buildGapFillRewriteMessage(gap.gapDesc, text)
            ps.setPendingRevision({ sectionId: gap.sectionId })
          }
          // 目标节即便已被删也照样消费掉意图，避免标记与提示条常驻。
          ps.setPendingGapFill(null)
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

      // 工作区切换在途（setSessionWorkspace IPC 未落定）→ 等它结束再发。
      // 迁移路径此刻正在 teardown 子进程 + 搬 transcript，这时 send 会在
      // main 侧重建 runtime 槽并按搬到一半的物理位置解析 cwd。flag 成败
      // 都会清（workspace store 的 finally），所以这里只是把竞态变成
      // 短暂排队；15s 兜底防 IPC 悬挂把发送永久卡死。
      if (useWorkspaceStore.getState().switching[targetSid]) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            unsub()
            resolve()
          }, 15_000)
          const unsub = useWorkspaceStore.subscribe((s) => {
            if (!s.switching[targetSid]) {
              clearTimeout(timer)
              unsub()
              resolve()
            }
          })
        })
      }

      // ─── 方案模式 payload 字段（queued / idle 两条 send 路径共用）───
      // 门控同 proposalMode——只有当前发送的 targetSid 与方案绑定的 sessionId
      // 相同才算（防泄漏到其他 tab / 后台 agent）。
      const buildProposalFields = async (): Promise<{
        proposalMode: boolean
        proposalProducts?: readonly ProposalProduct[]
        proposalRetrieve: boolean
      }> => {
        const ps = useProposalStore.getState()
        const isProposal = ps.active && ps.sessionId === targetSid
        if (!isProposal) return { proposalMode: false, proposalRetrieve: false }
        let proposalProducts: readonly ProposalProduct[] | undefined
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
          // 实际已发送的产品集发生分叉。
          const cur = useProposalStore.getState()
          if (cur.seeded) {
            proposalProducts = cur.products
          } else {
            const matched = matchProducts(text, idx)
            cur.seedProducts(matched)
            proposalProducts = matched
          }
        } else if (proposalReopenedWithBrief) {
          // 斜杠再入且带新需求文字：seeded=true 会短路 matchProducts，新需求若点名
          // 了别的产品/产品线，会被按旧草稿的产品集 grounding——用户以为换了主题，
          // AI 拿到的还是旧产品的文件清单。这里对新文字补跑一次匹配并【只增不减】
          // 并入产品集：加法自动（召回优先：多命中无害，同上），减法仍交给用户在
          // ProposalDocPanel 的 chip 上做；不动 seeded，「一次播种、不中途重播」的
          // 既有语义保持不变。
          const idx = await window.chatApi.readKbIndex()
          const matched = matchProducts(text, idx)
          const cur = useProposalStore.getState()
          // \u0000 作分隔：产品线/产品名可能含空格等常见字符，普通分隔符会串键。
          const key = (p: ProposalProduct): string =>
            `${p.productLine}\u0000${p.product}`
          const seen = new Set(cur.products.map(key))
          const added = matched.filter((p) => !seen.has(key(p)))
          if (added.length > 0) {
            cur.setProducts([...cur.products, ...added])
          }
          proposalProducts = useProposalStore.getState().products
        } else {
          proposalProducts = ps.products
        }
        return {
          proposalMode: true,
          proposalProducts,
          // 内容级召回：封面阶段外都开（phase !== 'cover'，即目录+正文）。composer
          // 自由输入也走这里——用户手敲推进语而非点按钮时 phase 滞后，卡 'content'
          // 会漏掉首个正文回合的召回。放宽到「非封面」让手敲/点按钮都触发；封面回合
          // （首发播种）不召回。零命中不注入，偶发目录回合触发无害。
          proposalRetrieve: useProposalStore.getState().phase !== 'cover'
        }
      }

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
          const proposalFields = await buildProposalFields()
          const { messageId } = await window.chatApi.send({
            sessionId: targetSid,
            // 补料落地时发【包装后的重写指令】，否则发用户原文（见上方 sentTextOverride 注释）。
            text: sentTextOverride ?? text,
            images: images.length > 0 ? images : undefined,
            ...proposalFields
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
        // 方案产品匹配在【预翻转之后】跑，保住「spinner 立刻亮、匹配在其后」的时序；
        // 其内 await 抛错也由本 catch 兜底。
        const proposalFields = await buildProposalFields()
        await window.chatApi.send({
          sessionId: targetSid,
          // Engine validator accepts empty strings when images are present.
          // We still pass an empty string (not undefined) so the wire
          // shape stays stable. 补料落地时发【包装后的重写指令】，否则发用户原文
          // （见上方 sentTextOverride 注释）。
          text: sentTextOverride ?? text,
          images: images.length > 0 ? images : undefined,
          ...proposalFields
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

  // onNew（/proposal-writer 空调用预填引导模板）经 ref 间接引用 runtime——
  // 定义 onNew 时 runtime 还不存在，调用期必已就绪。每次渲染刷新引用。
  runtimeRef.current = runtime

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
        // 镜像「会话 → 归属工作区」到 workspace store：composer 的
        // 「选择工作目录」chip 用它渲染锁定态（已有 transcript 的会话
        // 工作区不可改，展示归属即可）。整表替换 —— 来源是磁盘扫描。
        const wsMap: Record<string, string> = {}
        for (const t of result.threads) {
          if (t.workspacePath) wsMap[t.id] = t.workspacePath
        }
        useWorkspaceStore.getState().setSessionWorkspaces(wsMap)
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

  // 方案草稿防抖写盘：草稿任一改动后 ~800ms 落盘一次（合并连续键入）。timer 放 ref
  // 以便切换会话前同步 flush（防最后几笔手改还没落盘就被新会话覆盖）。
  const proposalSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushProposalSave = useCallback((): void => {
    if (proposalSaveTimer.current) {
      clearTimeout(proposalSaveTimer.current)
      proposalSaveTimer.current = null
    }
    const s = useProposalStore.getState()
    // 只存「有内容的活跃草稿」；空草稿不建档（避免起草前就生成空文件）。
    if (!s.active || !s.sessionId || s.sections.length === 0) return
    // 写盘是「尽力而为」（失败绝不阻塞会话切换/键入），但结果要回写 store 的
    // draftSaveFailed——失败（磁盘满/权限/路径）静默吞掉会让用户误以为已存、切走就丢。
    // 拿到 {ok:false} 或 IPC 抛错都置 true（面板显示「草稿未保存」常驻提示）；成功落盘
    // 置 false 自愈。
    window.chatApi
      .saveProposalDraft({
        version: 1,
        sessionId: s.sessionId,
        // 只持久化 ProposalDraftRecord 声明的字段。【显式裁剪】而非透传 s.sections：
        // verification（异步回填、易陈旧）与 baselineMarkdown（= markdown 的副本，
        // restoreFromDisk 会重新派生）都标注【不持久化】，但直接传 s.sections 这个加宽
        // 变量会跳过 TS 的 excess-property 检查、把它们一起写盘——违反持久化契约、盘上
        // 体积近翻倍。改用对象字面量 map：多余字段会被 excess-property 检查当场拦下。
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
      // 切走前把当前会话草稿的最后改动落盘（防抖可能还没触发）。
      flushProposalSave()
      // 【2026-07-14 修 composer 从底部 dock 跳到居中空态的抖动】
      // 关键坑：assistant-ui 的 thread.isEmpty = messages.length===0 && !isLoading
      // （@assistant-ui/core thread-runtime-client），isLoading 由 sessionLoading
      // 派生。新建对话的 composer 位置切换（dock ↔ 居中 EmptyState）是靠 isEmpty
      // 翻转驱动的——若这里像历史那样 setSessionLoading(true)，isEmpty 会被
      // `&& !isLoading` 卡住不翻，直到 finally 的 setSessionLoading(false) 第二拍
      // 才翻，于是出现「messages 已空、composer 却还钉在底部 dock，一拍后才猛地
      // 跳到中间」的晚跳/诡异抖动。
      //
      // 新建空会话根本没有需要等的 cold-start：newSession 只分配 id（不 spawn）、
      // switchSession(resume:false) 是 lazy 切指针（engine.ts 注释「~0ms」）、cli
      // 到首次 send 才 spawn。所以这里的 sessionLoading 是「人为」的 loading 窗口，
      // 没有任何真实等待要它遮。**新建路径不置 sessionLoading**：两次 ~0ms IPC 后
      // 的 setSession([]) 一拍就让 isEmpty 翻真、composer 一次到位，不再晚跳。
      // （sessionLoading 还驱动发送钮禁用/进度条——新建即可发、无冷启动进度可显，
      // 不置它反而语义更正确。）
      //
      // beginSessionSwitch 保留：它置的 sessionSwitching 会被 setSession 清掉，且
      // 切换 curtain 目前关着（SESSION_SWITCH_TRANSITION_ENABLED=false），无副作用。
      beginSessionSwitch()
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
      if (switchSeqRef.current === seq) {
        // Idempotent: setSession already cleared it on the success path;
        // this covers the throw path so the veil can't get stuck on.
        endSessionSwitch()
      }
    }
  }, [
    setSession,
    beginSessionSwitch,
    endSessionSwitch,
    flushProposalSave
  ])

  const onSwitchToThread = useCallback(
    async (id: string): Promise<void> => {
      if (!window.chatApi) return
      // Multi-runtime: non-destructive switch. See onSwitchToNewThread
      // for the rationale — the prev session keeps its cli alive in
      // the background, so there's nothing to interrupt.
      const seq = ++switchSeqRef.current
      try {
        // 切走前把当前会话草稿的最后改动落盘（防抖可能还没触发）。
        flushProposalSave()
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
          // 历史会话载入即重建方案草稿（内存优先→盘→transcript 兜底）。
          await rebuildProposalFromTranscript(id, messages as ThreadMessageLike[])
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
          // 冷路径同样重建方案草稿（盘优先、transcript 兜底），与历史一起就绪。
          await rebuildProposalFromTranscript(id, messages as ThreadMessageLike[])
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
          // 静默 fork 重绑：草稿也重绑到真实 id。
          await rebuildProposalFromTranscript(
            activeId,
            messages as ThreadMessageLike[]
          )
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
    [
      setSession,
      setSessionLoading,
      beginSessionSwitch,
      endSessionSwitch,
      flushProposalSave
    ]
  )

  // Cold-start auto-select. Ensures that by the time the user types
  // into the composer, `sessionId` is already non-null — no "No active
  // session" errors (the plain-send path hard-returns on a null id, see
  // onNew's `sessionId === null` guard), no need to click "New chat"
  // before typing.
  //
  // 【2026-07-14 用户定稿：reload 后一律停在新对话空态】
  // 历史行为是「有历史 → resume threads[0]（最近用过的会话）」，但那条
  // 分支制造了 reload 的抖动中间帧：先渲染 sessionId===null 的 EmptyState
  // 空态，等磁盘扫描的 listSessions() 回来（threadsLoaded=true）才切到
  // threads[0]——用户先看到「说说你的需求吧」空态闪一下，又被历史会话替
  // 换。用户要的是 reload 干脆停在新对话空态、不做这次切换。故两支合并成
  // 统一 onSwitchToNewThread()：不再读 threads[0]，中间帧从因果上消失
  // （不再有「空态→切历史」两拍，EmptyState 从头到尾稳定在屏）。
  //
  // 为什么仍需 onSwitchToNewThread 而不是「什么都不做、留 sessionId=null」：
  // 空态的 composer 要能直接打字发送，但 onNew 的 plain-send 对 null id 是
  // 硬报错 return（无自动建会话兜底）。onSwitchToNewThread 预建一个
  // sessionId（engine lazy-spawn，只分配 id、不 spawn cli，也不写盘——
  // transcript 要到第一次 send 才落地，故 reload 停在空态不发消息 = 零污染
  // 会话列表）。这样空态可发送，又不切走。
  //
  // 代价（用户已知情接受）：reload 不再回到「最近用过的会话」，要回历史
  // 会话得从左侧 rail 点。
  //
  // Guards:
  //   - `autoSelectedRef` latches true the instant we trigger, so this
  //     is idempotent even if `threads` changes later in the session.
  //   - wait for `threadsLoaded` before running — during the initial
  //     tick `threads` is `[]` because listSessions hasn't returned yet;
  //     waiting keeps the trigger deterministic (also lets a future
  //     branch tell empty-vs-populated workspaces apart if needed).
  //   - skip if the user has already picked a thread (`sessionId` set)
  //   - skip if a switch is already in flight (`sessionLoading`)
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    if (autoSelectedRef.current) return
    if (!threadsLoaded) return
    if (sessionId !== null) return
    if (sessionLoading) return
    autoSelectedRef.current = true
    void onSwitchToNewThread()
  }, [
    threads,
    threadsLoaded,
    sessionId,
    sessionLoading,
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
  //
  // 回放 slot 不豁免会撞车：replay: 前缀的 sessionId 永远不在 threads 里
  // （它是纯前端 id，没有对应的 ThreadSummary），这里会把它解析成 null 并
  // 覆盖掉 ReplayController.start() 刚写入 useSessionTitleStore 的录像
  // 标题——「新对话」顶栏就是这么来的（2026-07-13 实测）。回放期间这个
  // store 的唯一写手改为 ReplayController（start 写录像标题、exit 复位
  // 回退出会话的标题），这个 effect 对回放 slot 直接跳过，不要覆盖。
  useEffect(() => {
    if (isReplaySessionId(sessionId)) return
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
 * Build a ChatEvent handler bound to a single session id（薄壳）。
 *
 * core 的「event → store mutation」switch 已抽到 applyChatEventToStore（live
 * 流与 .claudereplay 回放共用同一份语义）。本函数只负责两件事：
 *   1. 建 per-handler 的 ChatEventCtx——每个订阅私有 toolNames/argsBuffers，
 *      并发会话流式 TodoWrite 不会互相污染右栏 partial-parse 状态；
 *   2. 组 LiveHooks：把 live 会话专属副作用（队列气泡补发 / 历史缓存失效 /
 *      方案模式全链路 / 后台未读 / 队列镜像）接到本模块的既有实现上。
 * 回放 driver 调 applyChatEventToStore 时 live 传 null 整体关断这些副作用。
 * Every mutation targets the captured `sid`, which is what keeps background
 * runtimes writing into their own perSession slot instead of the foreground.
 */
function makeSessionEventHandler(
  sid: string,
  actions: ChatEventActions
): (event: ChatEvent) => void {
  const ctx = createChatEventCtx()
  const live: LiveHooks = {
    takeQueuedTurn,
    invalidateHistoryCache,
    maybeAbortOnTocSkip,
    syncProposalDraftFromInflight,
    onTurnEnd: handleProposalTurnEnd,
    // Unread: a reply just finished. If the user isn't currently looking
    // at this session (it's a background task, or they're on the canvas /
    // another chat), flag it unread so the rail shows a dot until they
    // open it. A turn that finished in the foreground is already-read —
    // skip. Read the foreground id live from the store (getState, not a
    // render-time closure).
    markUnreadIfBackground: (s) => {
      if (useChatStore.getState().sessionId !== s) {
        useUnreadStore.getState().markUnread(s)
      }
    },
    // 选区改写排队·排空（复审 B 修正）：排队改写起飞后以 'error' 失败（子进程崩溃/abort/超时）时，
    // 若不在此补排空，队列剩余项会永久停摆——与 onTurnEnd 分支对称，同款 queueMicrotask 触发下一轮。
    onTurnError: () => {
      queueMicrotask(() => {
        void drainRevisionQueue()
      })
    },
    onQueueChanged: (s, queue) =>
      useMessageQueueStore.getState().setQueue(s, queue)
  }
  return (event: ChatEvent) =>
    applyChatEventToStore(sid, event, actions, ctx, live)
}

/**
 * 轮末（'end'）方案草稿处理：accumulate the just-finished assistant message's
 * DRAFT sections into the right-side document panel. We read HERE (at 'end',
 * once per message) rather than on 'chunk', because the store already holds
 * the fully assembled text and 'end' is the correct once-per-message point.
 *
 * 三道门，缺一不可：
 *   1. 会话门控：只累积方案绑定会话（ps.sessionId === sid）的输出，防止别的
 *      会话（多 tab / 后台 agent）的 end 污染方案草稿 sections。
 *   2. 消息级去重：按 messageId 记账，end 对同一 messageId 二次触发
 *      （异常路径重发等）时不重复累积同一段。
 *   3. 精确定位：用 messageId 找到刚结束的那条消息，而非倒序抓「最后
 *      一条 assistant」——后者会误抓错误占位等尾随消息、把报错写进草稿。
 *
 * 本函数同步抛错最终由 applyChatEventToStore 的 'end' case 兜住（endAssistantMessage
 * 落在那边的 finally——「抛错不得搁浅 spinner」的不变量由 core 保证），故这里不再 catch。
 * 但选区改写排队·排空（CEO 护栏#1/#6 在 drainRevisionQueue 内部）必须【无论方案草稿处理
 * 是否抛错】都触发，故本函数自带一层 try/finally（只 finally、不 catch——异常仍会继续向上
 * 抛给 core）：queueMicrotask 让 core finally 里的 endAssistantMessage 先落定
 *（streaming=false 对 drain 内的闸可见），再排空。
 */
function handleProposalTurnEnd(sid: string, messageId: string): void {
  try {
    const _ps = useProposalStore.getState()
    if (
      _ps.active &&
      _ps.sessionId === sid &&
      !_ps.consumedDraftIds.has(messageId)
    ) {
      const slot = useChatStore.getState().perSession[sid]
      const msg = slot?.messages.find((m) => m.id === messageId) as
        | { role: string; content: Array<{ type: string; text?: string }> }
        | undefined
      if (msg && msg.role === 'assistant') {
        // Collect all 'text' parts (skip 'reasoning' / tool-call parts).
        const fullText = msg.content
          .filter((p) => p.type === 'text' && p.text)
          .map((p) => p.text!)
          .join('')
        // 每个闭合哨兵块映射为一节；提问 / 过程对话不带哨兵 → 不入节。哨兵与
        // 抽取器在 shared/proposal.ts，与提示词规则同源。
        const { blocks, truncated } = extractProposalDraftResult(fullText)
        // 定向修订分流：pendingRevision 非空 = 上一动作（节重写/展开/精简/据来源
        // 修正/截断续写）要求本轮产出【整节替换】某节，而非 append 新节。三种结局：
        //   ① 目标节仍在 + 拿到 content 块 → reviseSection 整节替换，清指针，重新校验。
        //   ② 目标节仍在 + 本轮无可用产出（修订被截断/空）→ 放弃替换，原节不动，仅记账。
        //   ③ 目标节已不在（pending stale）→ 回退正常累积路径，绝不让产出被静默吞掉。
        const pending = useProposalStore.getState().pendingRevision
        const target = pending
          ? useProposalStore
              .getState()
              .sections.find((s) => s.id === pending.sectionId)
          : undefined
        const revised = blocks.find((b) => b.kind === 'content') ?? blocks[0]
        if (pending && target && revised) {
          useProposalStore.getState().setPendingRevision(null)
          if (pending.blockRange) {
            // blockRange 存在=选区即改：【不即时落地】。把「原文 vs 改写后」登记成一条挂在
            // 本条助手消息下的待审阅项，由 ThreadView 的 ProposalRevisionReview 在该消息
            // 下方渲染对照 + [应用/放弃/继续改]，用户点「应用」才 spliceBlocks 落地。
            const secBlocks = splitBlocks(target.markdown)
            const start = Math.max(
              0,
              Math.min(pending.blockRange.start, secBlocks.length - 1)
            )
            const end = Math.max(
              start,
              Math.min(pending.blockRange.end, secBlocks.length - 1)
            )
            useProposalStore.getState().addBlockReview(messageId, {
              sectionId: pending.sectionId,
              blockRange: { start, end },
              before: secBlocks.slice(start, end + 1).join('\n\n'),
              after: revised.markdown
            })
            // 记账：产出已转存进 blockReview，不能再被 appendSections 当新节追加。
            useProposalStore.getState().markDraftConsumed(messageId)
          } else {
            // 缺省=整章替换：即时落地整节替换，reviseSection（重置 verification
            // 触发重校验、更新 baseline、清 truncated）。
            useProposalStore
              .getState()
              .reviseSection(pending.sectionId, revised.markdown)
            triggerProposalCitationVerification()
          }
        } else if (pending && target) {
          // 修订轮被截断 / 空产出：保留原节（不变量：绝不用半截覆盖好内容），清指针 + 记账。
          console.warn(
            '[proposal-revise] 本轮修订未产出可用的【方案正文哨兵块】——模型可能跑偏（评估/写文件/闲聊），' +
              '未生成「应用/放弃」审阅项、正文保持不变。建议重试或新开方案会话。',
            {
              sectionId: pending.sectionId,
              blockRange: pending.blockRange,
              messageId
            }
          )
          useProposalStore.getState().setPendingRevision(null)
          useProposalStore.getState().markDraftConsumed(messageId)
        } else {
          // 无 pending，或 pending 已 stale → 回归正常累积。stale 指针在此一并清除。
          if (pending) useProposalStore.getState().setPendingRevision(null)
          if (blocks.length || truncated) {
            useProposalStore
              .getState()
              .appendSections(messageId, blocks, truncated)
            // 引用落地校验：appendSections 内部生成节 id，这里无法直接拿到新节，
            // 故扫一遍 store 对「未校验的正文节」异步触发——已校验/在飞的天然跳过，
            // 重复调用幂等、只补新节。封面/目录与截断残节不校验。
            triggerProposalCitationVerification()
          } else {
            useProposalStore.getState().markDraftConsumed(messageId)
          }
        }
        // genimage 自动发起：本轮入库/替换的节里可能带新指令块。放在分流之后统一扫
        // ——append 与 reviseSection 两条路径都可能引入指令块，扫描自身按 genImageJobs
        // 幂等，重复调用零成本。
        autoFireProposalGenImages(sid)
        // 阶段确认硬门的轮末兜底：本轮发生过「空口确认」拦截、模型补写了节却没重新
        // 发起确认就收工 → 自动补发一条催促。内部单发保险+阶段守卫，正常轮零成本。
        maybeNudgeStageConfirmAfterTurn(sid)
      }
      // msg 未找到（end 早于消息入 store 的竞态）或 role 非 assistant 时，
      // 刻意【不】记账：若 end 对同一 messageId 二次触发，第一次 msg 尚未就绪就
      // 记账会让第二次 msg 已就绪的正文被 consumedDraftIds 挡掉而永久丢失。
    }
  } finally {
    queueMicrotask(() => {
      void drainRevisionQueue()
    })
  }
}

/**
 * 流式硬门（方案模式·根因「目录阶段一直在思考」）：方案模式下，逐个 chunk 检查在飞消息——
 * 若当前 phase 还没确认目录（cover/toc）、AI 却已冒出【独占整行】的正文起始哨兵，说明它跳过
 * 了目录确认、正要跑飞整篇正文。此刻立即 abort 本轮，趁它刚起手就掐断（详见 shared/proposal.ts
 * detectContentSentinelAheadOfPhase）。
 *
 * abort 后引擎发 'end' → 'end' 处理把这段未闭合的越界正文经阶段门剔除并设 stageSkip →
 * ProposalDocPanel 的自动补救 effect 重发「只生成目录 + 发起确认」，把 AI 拉回正轨。
 * 故本函数只管「尽早掐断」，重发与上限（autoTocFix≤2）复用既有补救链，不在此另起循环。
 *
 * 去重：每条 messageId 至多 abort 一次（aborted 集合）——掐断后该轮仍可能再吐几个残 chunk，
 * 绝不重复 abort。phase==='content'（用户已确认目录）由 detect 内部短路，正文阶段零开销。
 */
function maybeAbortOnTocSkip(
  sid: string,
  messageId: string,
  aborted: Set<string>
): void {
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

/**
 * 轮内草稿同步：AI 在一个 SDK 轮里生成封面/目录后用 AskUserQuestion 暂停确认，但该轮的
 * 'end'（草稿入库的原触发点）要等模型彻底停下才到——期间右侧草稿一直空着（「对话说生成
 * 封面了、右侧还是空的」）。故在 AskUserQuestion 工具调用出现时（模型刚结束一段哨兵块、
 * 暂停发问），把当前在飞消息里【已闭合】的哨兵块即时同步进右侧草稿。
 *
 * 只取闭合块（truncated 丢弃）：半截内容会在后续流里闭合、轮末再正式入库；store.syncSections
 * 的内容级去重保证与轮末 appendSections 不重复、且不消费 messageId（同消息余下块仍走轮末）。
 * 门控同 'end' 路径：仅方案绑定会话（active && sessionId===sid）、按 messageId 精确取消息。
 */
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
  // AskUserQuestion 暂停时的轮内同步同样可能带入新指令块（AI 生成正文中途暂停确认）：
  // 与 end 路径同一入口，幂等由 genImageJobs 保证。
  autoFireProposalGenImages(sid)
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
