import { useEffect, useMemo, useRef, useState } from 'react'

import {
  useChatStore,
  useStreamingAskArgsText,
  usePreviewServer,
  useWrittenFiles,
  useImageFeeds
} from '../../../stores/chat'
import { usePendingAskUserQuestion } from '../../../stores/permissions'
import { CanvasConfirm } from '../CanvasConfirm'
import { LivePreviewEditor } from '../LivePreviewEditor'
import { OutlinePanel } from '../OutlinePanel'
import { CanvasQuestionnaire } from './CanvasQuestionnaire'
import { ImagesPanel, useImageFeedsLive } from './ImagesPanel'
import { WrittenFilesPanel } from './WrittenFilesPanel'

/* ─────────────────────── Slides workspace ───────────────────── */

type CanvasTab = 'slides' | 'outline' | 'files' | 'images' | 'questions'

const CANVAS_TAB_ICONS: Record<CanvasTab, React.ReactNode> = {
  slides: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  ),
  outline: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  ),
  files: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  images: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="m3 16 5-4 4 3 3-2 6 5" />
    </svg>
  ),
  questions: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 .9-1 1.7M12 17h.01" />
    </svg>
  )
}

/**
 * Right-hand canvas workspace, shown beside the chat in slides mode. Tabs:
 * 幻灯片 / 大纲 / 文件 are still static shells; 「问题」is live — it appears
 * only while this session has a pending AskUserQuestion and hosts the
 * questionnaire there (instead of inline in the chat stream — ThreadView
 * suppresses the inline prompt for AskUserQuestion, see suppressAskInline).
 * When a question arrives we auto-switch to 「问题」; after the user submits,
 * the tab disappears and we fall back to 幻灯片.
 */
export function SlidesWorkspace(): React.JSX.Element {
  const sessionId = useChatStore((s) => s.sessionId)
  // Two sources for the 问题 tab, covering the whole AskUserQuestion lifecycle:
  //   - streamingArgs: the tool's input WHILE it streams (no requestId yet →
  //     read-only preview, rendered from half-open JSON via parsePartialToolArgs).
  //   - pendingAsk: the permission request once canUseTool fires (has requestId
  //     → the form becomes answerable). pendingAsk supersedes streamingArgs.
  const pendingAsk = usePendingAskUserQuestion(sessionId)
  const streamingArgs = useStreamingAskArgsText()
  const hasQuestions = pendingAsk !== null || streamingArgs !== null
  // Active ppt-master server (kind + URL) when one is up, else null. Two phases:
  //   - kind 'confirm' → the Eight-Confirmations page, rendered NATIVELY in
  //     the 「问题」tab (CanvasConfirm — the old 浏览器 iframe tab is gone).
  //   - kind 'preview' → Executor live preview, rendered NATIVELY in
  //     「预览幻灯片」(LivePreviewEditor fetches the server's SVG itself).
  // See usePreviewServer in stores/chat.
  const server = usePreviewServer()
  const hasConfirm = server?.kind === 'confirm'
  const hasPreview = server?.kind === 'preview'
  // usePreviewServer resolves the preview URL from the launch command in the
  // transcript, which OUTLIVES the server when it stops by idle-timeout or
  // self-exit (no `--shutdown` line ever lands to clear it). LivePreviewEditor
  // polls the URL and reports reachability up here; once it's unreachable we
  // treat the preview as gone and drop the 幻灯片 tab — a stale launch URL must
  // not leave a dead "预览服务已停止" tab behind. Keyed off server?.url so a
  // fresh launch (new URL) clears the flag and the tab returns.
  const [previewDown, setPreviewDown] = useState(false)
  const previewUrl = server?.url
  useEffect(() => {
    // New (or cleared) preview server → reset reachability for the new URL.
    setPreviewDown(false)
  }, [previewUrl])
  // Identity gate: ports are REUSED across sessions — the URL recorded in a
  // resumed session's transcript may now be answered by a DIFFERENT project's
  // editor (real incident: deck A's :5050 died overnight, deck B pinned
  // --port 5050, resuming deck A's session rendered deck B). Reachability
  // alone would happily paint the wrong deck, so before trusting a preview
  // server we ask WHO it is (/api/config reports `project`, see
  // svg_editor/server.py) and compare against the project the launch command
  // named (PreviewServer.project). Mismatch — or a server too old to report
  // its identity — keeps the tab hidden. No expected project (command-shape
  // extraction failed) → reachability-only, the previous behavior.
  const expectedProject = server?.project
  const [identityOk, setIdentityOk] = useState(false)
  useEffect(() => {
    if (!hasPreview || !previewUrl) {
      setIdentityOk(false)
      return
    }
    if (!expectedProject) {
      setIdentityOk(true)
      return
    }
    setIdentityOk(false)
    let cancelled = false
    let attempt = 0
    const probe = async (): Promise<void> => {
      attempt += 1
      try {
        const res = await fetch(`${previewUrl}/api/config`)
        const cfg = (await res.json()) as { project?: unknown }
        if (cancelled) return
        setIdentityOk(cfg.project === expectedProject)
      } catch {
        if (cancelled) return
        // A transient loopback hiccup would otherwise hide the tab forever
        // (nothing re-probes this URL) — retry briefly, then give up. The
        // launched-then-dies case is LivePreviewEditor's polling's job.
        if (attempt < 3) setTimeout(probe, 700)
      }
    }
    void probe()
    return () => {
      cancelled = true
    }
  }, [hasPreview, previewUrl, expectedProject])
  // 预览幻灯片 exists ONLY while the live-preview server is up, reachable AND
  // verified to be THIS session's deck: the tab appears when the server
  // launches and drops out when it dies (idle-timeout / self-exit). No
  // pre-launch placeholder shell, no dead "预览服务已停止" tab lingering after
  // — the tab's presence IS the signal that a live deck is previewable now.
  const showSlidesTab = hasPreview && !previewDown && identityOk
  // Every file this session has written via Write. Drives the auto-focus on each
  // new write (which needs to see EVERY write, including .svg deck pages, to
  // route them to the right tab). See useWrittenFiles in stores/chat.
  const writtenFiles = useWrittenFiles()
  const hasFiles = writtenFiles.length > 0
  // Files shown in the 文件 tab: everything EXCEPT .svg deck pages. The SVG
  // pages are the deck itself — they render in the 幻灯片 tab (live preview),
  // so listing their raw source in 文件 is noise. design_spec.md stays (it has
  // its own 大纲 tab but is also a legitimate file to browse). Kept as a
  // separate memo so it recomputes only when the file list changes.
  const fileTabFiles = useMemo(
    () => writtenFiles.filter((f) => !/\.svg$/i.test(f.name)),
    [writtenFiles]
  )
  const hasFileTabFiles = fileTabFiles.length > 0
  // The deck's design spec (design_spec.md) written this session, if any. This
  // is the plan-of-record for the whole deck — Part/Slide breakdown, per-slide
  // layout/title/content — so it gets its own home in the 大纲 tab, rendered
  // as rich Markdown (not the raw-source shell the 文件 tab shows for arbitrary
  // writes). Matched by bare filename, case-insensitively, so a path prefix or
  // OS casing quirk doesn't hide it. If it's rewritten mid-session the latest
  // entry wins (useWrittenFiles dedupes by path, keeping content fresh).
  const designSpec =
    writtenFiles.find((f) => /^design_spec\.md$/i.test(f.name)) ?? null
  // ppt-master image acquisition runs — AI generation (`image_gen.py
  // --manifest`) and/or web download (`image_search.py --batch`). Each feed
  // names the worklist JSON to poll and whether that run is still in flight.
  // Drives the 「图片」tab: it appears once any run is detected and stays
  // (like 文件), and we auto-focus it while any run is live. See
  // useImageFeeds in stores/chat.
  const imageFeeds = useImageFeeds()
  const hasImages = imageFeeds.length > 0
  // Data-corrected liveness, NOT the raw command flag: a resumed session's
  // restored launch command claims "generating" forever (endedAt/tasks are
  // runtime-only fields the JSONL restore doesn't carry), so the busy dot /
  // auto-focus would never clear. useImageFeedsLive polls the worklist
  // itself and overrides the lie.
  const imagesGenerating = useImageFeedsLive(imageFeeds)
  // Default landing is 大纲 — 预览幻灯片 only exists once the live-preview
  // server is up (see showSlidesTab above), so it can't be the initial tab.
  const [tab, setTab] = useState<CanvasTab>('outline')

  // Auto-focus 问题 the moment a questionnaire OR the confirm server appears.
  // The confirm Eight-Confirmations page now renders NATIVELY in the 问题 tab
  // (CanvasConfirm), not as an iframe in 浏览器 — so both an AskUserQuestion
  // questionnaire and a confirm server drive focus to 问题. When both clear,
  // drop back to 幻灯片 if we were on 问题.
  const wantsQuestionsTab = hasQuestions || hasConfirm
  useEffect(() => {
    if (wantsQuestionsTab) setTab('questions')
    else setTab((t) => (t === 'questions' ? 'slides' : t))
  }, [wantsQuestionsTab])

  // Auto-focus 图片 while AI image generation is running. Sits between 问题
  // (highest) and the live-preview/write focus below: image generation is a
  // discrete, watchable phase (progress + thumbnails filling in), so once it
  // starts we drop the user into the 图片 tab and hold them there until it
  // finishes. On finish we DON'T jump away — the user wants to review the
  // results; a higher-priority event (a new questionnaire) or the user's own
  // click moves them on.
  const wantsImagesTab = imagesGenerating
  useEffect(() => {
    if (wantsQuestionsTab) return
    if (wantsImagesTab) setTab('images')
  }, [wantsImagesTab, wantsQuestionsTab])

  // Auto-focus the right tab for the live-preview server phase (unless the 问题
  // or 图片 tab is commanding focus): preview → 预览幻灯片 (which renders the
  // live SVG itself). The confirm phase is handled above (native 问题 tab).
  useEffect(() => {
    if (wantsQuestionsTab || wantsImagesTab) return
    // Keyed on showSlidesTab (not raw hasPreview) so the focus grab waits for
    // the identity probe — grabbing while the tab is still hidden would just
    // bounce off the redirect guard below and never come back.
    if (showSlidesTab) setTab('slides')
  }, [showSlidesTab, wantsQuestionsTab, wantsImagesTab])

  // Whenever we're pointed at 预览幻灯片 while the tab doesn't exist (server
  // not launched yet, or launched-then-died, or the questions fallback picked
  // 'slides' blindly), redirect to a tab that does exist: 文件 if there are
  // written files, else 大纲. `tab` is a dep on purpose — showSlidesTab alone
  // wouldn't re-fire when a later setTab('slides') lands while the tab is
  // hidden.
  useEffect(() => {
    if (showSlidesTab) return
    setTab((t) => (t === 'slides' ? (hasFileTabFiles ? 'files' : 'outline') : t))
  }, [showSlidesTab, hasFileTabFiles, tab])

  // Auto-focus the right tab on each new write so the user watches files land as
  // they're written (mirrors the 问题 auto-focus). Keyed off a "write
  // signature" — file count + the newest file's path — so it fires when a NEW
  // file appears or a fresh Write starts, but NOT on every streaming-content tick
  // of a file we've already focused (which would yank the user back if they
  // switched away mid-stream).
  //
  // Which tab we grab depends on WHAT was just written:
  //   - design_spec.md → 大纲 (outline). It's the deck's plan-of-record, and the
  //     大纲 tab renders it as rich Markdown. Writing/rewriting the spec should
  //     drop the user straight into the outline view.
  //   - a .svg page → no grab. These ARE the deck pages, but 预览幻灯片 only
  //     exists once the live-preview server is up — and this whole effect is
  //     suppressed while hasPreview is true. So an SVG write pre-preview just
  //     stays put (they're excluded from 文件 anyway); the server-up effect
  //     above lands the user on 预览幻灯片 the moment preview arrives.
  //   - anything else → 文件 (files), the raw-content shell for arbitrary writes.
  //
  // Focus precedence: 问题 (questionnaire/confirm) AND 幻灯片 (live preview) both
  // outrank this. Once the live-preview server is up, the deck has entered the
  // "generate SVG pages, watch them render" phase, and the preview effect above
  // already parks the user on 幻灯片; the explicit .svg → slides branch here
  // covers the pre-preview window (and the case preview never launches). We
  // still suppress the whole grab while hasPreview is true so we don't fight
  // that effect. Distinct deps from the server effects above.
  const lastWriteSigRef = useRef<string>('')
  const newestFile = writtenFiles[writtenFiles.length - 1]
  const writeSig = `${writtenFiles.length}|${newestFile?.path ?? ''}`
  const newestIsDesignSpec = newestFile
    ? /^design_spec\.md$/i.test(newestFile.name)
    : false
  const newestIsSvg = newestFile ? /\.svg$/i.test(newestFile.name) : false
  useEffect(() => {
    if (writeSig === lastWriteSigRef.current) return
    lastWriteSigRef.current = writeSig
    if (!hasFiles || wantsQuestionsTab || wantsImagesTab || hasPreview) return
    if (newestIsSvg) return
    setTab(newestIsDesignSpec ? 'outline' : 'files')
  }, [
    writeSig,
    hasFiles,
    wantsQuestionsTab,
    wantsImagesTab,
    hasPreview,
    newestIsDesignSpec,
    newestIsSvg
  ])

  // Which tabs currently have LIVE, CHANGING content — drives the pulsing dot
  // that nudges the user toward a tab whose content is updating while they're
  // looking elsewhere. Only "in-flight" signals count, so the dot clears the
  // moment work settles:
  //   - 图片: AI image generation is running.
  //   - 幻灯片: an SVG deck page is mid-write (a page is rendering).
  //   - 大纲: design_spec.md is mid-write.
  //   - 文件: some non-svg, non-spec file is mid-write.
  const anySvgStreaming = writtenFiles.some(
    (f) => f.streaming && /\.svg$/i.test(f.name)
  )
  const anyPlainFileStreaming = writtenFiles.some(
    (f) => f.streaming && !/\.svg$/i.test(f.name) && !/^design_spec\.md$/i.test(f.name)
  )
  const tabBusy: Partial<Record<CanvasTab, boolean>> = {
    images: imagesGenerating,
    slides: anySvgStreaming,
    outline: designSpec?.streaming === true,
    files: anyPlainFileStreaming
  }

  const tabs: { id: CanvasTab; label: string }[] = [
    // 预览幻灯片 only exists while the live-preview server is up and reachable
    // (appears on launch, drops out on idle-timeout / self-exit) — see
    // showSlidesTab above.
    ...(showSlidesTab ? [{ id: 'slides' as const, label: '预览幻灯片' }] : []),
    { id: 'outline', label: '大纲' },
    { id: 'files', label: '文件' },
    // 图片 tab: appears once this session ran an AI image-generation command
    // (image_gen.py --manifest) and stays for the rest of the session so the
    // user can revisit the generated previews. Auto-focused while generating.
    ...(hasImages ? [{ id: 'images' as const, label: '图片' }] : []),
    // 问题 tab: while a questionnaire is streaming/pending, OR while the
    // confirm server is up (the Eight-Confirmations page renders natively here
    // via CanvasConfirm — see body below).
    ...(wantsQuestionsTab ? [{ id: 'questions' as const, label: '问题' }] : [])
    // NOTE: the old 浏览器 iframe-fallback tab for the confirm phase is gone —
    // the native 问题 tab (CanvasConfirm) is the ONLY confirm surface now.
  ]

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[4px] bg-card">
      {/* Tab bar. 不再兼职窗口拖拽面——这条 bar 又窄又塞满按钮，拖拽收益
          趋零，窗口拖拽面由 ChatHeader（chat 列顶部）独自承担。
          「tab 点不动」的历史真因后来实锤并不是本 bar 的 drag/no-drag 嵌套：
          是 SurfaceHost 隐藏面（canvas）的全宽 drag 顶栏仍被 Electron 注册成
          原生窗口拖拽矩形、正好罩住这条 bar（app-region 收集不看 pointer-
          events）。修复在 globals.css 的 .surface-inactive，详见那段注释。 */}
      {/* h-[46px] 与 ChatHeader（chat 列顶栏）严格同高、同 hairline 透明度——
          分栏时两根栏并排，底边线必须对齐成一条（2026-07-04 顶栏化改版）。 */}
      <div className="flex h-[46px] shrink-0 select-none items-center gap-0.5 border-b border-border/55 px-2">
        {tabs.map((tDef) => {
          const active = tDef.id === tab
          // Pulsing dot whenever this tab's content is changing — including the
          // tab currently in view (you're watching a file stream in; the dot is
          // the "still writing" signal). It clears the instant work settles.
          const busy = tabBusy[tDef.id] === true
          return (
            <button
              key={tDef.id}
              type="button"
              onClick={() => setTab(tDef.id)}
              className={
                'flex items-center gap-1 rounded-md px-2 py-1 text-[12px] transition-colors ' +
                (active
                  ? 'bg-foreground/[0.06] font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground/90')
              }
            >
              {CANVAS_TAB_ICONS[tDef.id]}
              {tDef.label}
              {busy && (
                <span aria-hidden className="relative ml-0.5 flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-75" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Body */}
      {tab === 'questions' && hasConfirm && server ? (
        // Confirm phase: the Eight-Confirmations page rendered NATIVELY (not an
        // iframe). CanvasConfirm fetches the same Flask server's
        // /api/catalogs + /api/recommendations off `server.url`, lets the user
        // pick, and POSTs the SAME contract back to /api/confirm — the server's
        // --wait-only loop (watching result.json) is unchanged. confirm takes
        // precedence over a questionnaire here (the two never coincide, but if
        // they did, the active confirm phase is the right surface).
        <CanvasConfirm key={server.url} baseUrl={server.url} />
      ) : tab === 'questions' && hasQuestions ? (
        <CanvasQuestionnaire
          request={pendingAsk}
          streamingArgsText={streamingArgs}
        />
      ) : tab === 'slides' && showSlidesTab && server ? (
        // Live-preview phase: the native editor (replaces the old read-only
        // SlidesLivePreview). Fetches the svg_editor server's SVG and renders
        // it natively WITH the annotation/edit interactions (element select →
        // edit instruction → annotate / 应用修改 / 撤销 / 退出), the same flow the
        // browser editor at :5050 offered. See LivePreviewEditor.
        <LivePreviewEditor baseUrl={server.url} onServerDownChange={setPreviewDown} />
      ) : tab === 'files' && hasFileTabFiles ? (
        // 文件 tab: the full content of files written this session, two-pane
        // (file list + content) like SlidesLivePreview. The inline Write card's
        // content preview is suppressed in slides mode (see writeHandledByCanvas
        // in ToolCallCard) precisely so this is the single place that content
        // lives — no duplication. .svg deck pages are excluded (they belong to
        // the 幻灯片 tab), so we pass fileTabFiles and follow ITS newest entry.
        <WrittenFilesPanel
          files={fileTabFiles}
          newestPath={fileTabFiles[fileTabFiles.length - 1]?.path}
        />
      ) : tab === 'outline' && designSpec ? (
        // 大纲 tab: the deck's design_spec.md as a structured document reader
        // (OutlinePanel) — chapter TOC with scrollspy, roman-numeral chapter
        // headers, per-chapter write status while streaming. Chapter BODIES
        // still render through AssistantMarkdown; the panel only adds the
        // navigation layer, and falls back to flat markdown when the spec has
        // no H2 chapters. `key` by path resets scroll/follow on a fresh spec.
        <OutlinePanel key={designSpec.path} file={designSpec} />
      ) : tab === 'images' && imageFeeds.length > 0 ? (
        // 图片 tab: image acquisition progress + thumbnails, one panel per
        // run (AI generation / web download — a mixed deck runs both). Each
        // panel polls its worklist JSON (the runner rewrites it per
        // completion) via main-process IPC, since the renderer can't read the
        // local files. `key` by path so a fresh run remounts with clean
        // state. Single run keeps the full-height layout (header pinned, grid
        // scrolls); multiple runs stack in one scroll container with sticky
        // per-run headers.
        imageFeeds.length === 1 ? (
          <ImagesPanel key={imageFeeds[0].manifestPath} feed={imageFeeds[0]} fill />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {imageFeeds.map((f) => (
              <ImagesPanel key={f.manifestPath} feed={f} />
            ))}
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="text-[15px] font-semibold text-foreground">
            {tab === 'outline' ? '暂无大纲' : '未命名'}
          </div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            {tab === 'outline'
              ? '生成 design_spec.md 后将在此处展示大纲'
              : '确认大纲后将在此处展示幻灯片'}
          </div>
        </div>
      )}
    </div>
  )
}
