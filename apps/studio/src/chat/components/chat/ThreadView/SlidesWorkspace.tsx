import { useEffect, useMemo, useRef, useState } from 'react'

import {
  useChatStore,
  useEditingSvgFile,
  useStreamingAskArgsText,
  usePreviewServer,
  useWrittenFiles,
  useImageFeeds
} from '../../../stores/chat'
import { usePendingAskUserQuestion } from '../../../stores/permissions'
import { isReplaySessionId, useReplayStore } from '../../../replay/replayStore'
import { CanvasConfirm } from '../CanvasConfirm'
import { LivePreviewEditor, usePreviewReadinessStore } from '../LivePreviewEditor'
import { OutlinePanel } from '../OutlinePanel'
import { CanvasQuestionnaire } from './CanvasQuestionnaire'
import { ImagesPanel, useImageFeedsLive } from './ImagesPanel'
import { ReplaySlidesViewer, useReplaySlideDeck } from './ReplaySlidesViewer'
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
  // 回放会话：大纲/文件/图片 tab 全是消息派生（useWrittenFiles /
  // useImageFeeds 走 s.messages），回放喂进消息后免费复活——工作区整体
  // 复用，只有依赖 live server 的部分（预览 tab / confirm 面板）按下面的
  // isReplay 分支替换或关断。
  const isReplay = isReplaySessionId(sessionId)
  // 回放版预览数据源：manifest 权威幻灯片清单 + 消息扫描揭示进度；非
  // 回放恒为 null（hook 内部短路，live 路径零开销）。
  const replayDeck = useReplaySlideDeck()
  // Two sources for the 问题 tab, covering the whole AskUserQuestion lifecycle:
  //   - streamingArgs: the tool's input WHILE it streams (no requestId yet →
  //     read-only preview, rendered from half-open JSON via parsePartialToolArgs).
  //   - pendingAsk: the permission request once canUseTool fires (has requestId
  //     → the form becomes answerable). pendingAsk supersedes streamingArgs.
  // 两者都读真实权限 broker / live 流状态，回放态恒为 null（回放不走真实
  // canUseTool）——回放态的问卷改由 ReplayController 写入 replayStore 的
  // activeQuestionsPanel/activeQuestions 驱动，见下方 replay* 变量。
  const pendingAsk = usePendingAskUserQuestion(sessionId)
  const streamingArgs = useStreamingAskArgsText()
  const replayActivePanel = useReplayStore((s) => s.activeQuestionsPanel)
  const replayQuestions = useReplayStore((s) => s.activeQuestions)
  const replayConfirmSnapshots = useReplayStore((s) => s.confirmSnapshots)
  const hasQuestions = isReplay
    ? replayActivePanel === 'questionnaire'
    : pendingAsk !== null || streamingArgs !== null
  // Active ppt-master server (kind + URL) when one is up, else null. Two phases:
  //   - kind 'confirm' → the Eight-Confirmations page, rendered NATIVELY in
  //     the 「问题」tab (CanvasConfirm — the old 浏览器 iframe tab is gone).
  //   - kind 'preview' → Executor live preview, rendered NATIVELY in
  //     「预览幻灯片」(LivePreviewEditor fetches the server's SVG itself).
  // See usePreviewServer in stores/chat.
  // 回放会话必须把 server 归零：回放消息里含真实的 launch 命令（URL 能被
  // usePreviewServer 解析出来），不归零的话 identity probe 会去 fetch
  // localhost:PORT——演示机上若恰有【别的会话】的预览 server 正在跑同一
  // 端口，回放的预览 tab 会错接到那个 live server（confirm 面板同理）。
  // 归零后 hasPreview/identity probe 自然关断；hasConfirm 单独在下面按
  // isReplay 分支改读 activeQuestionsPanel（confirm 面板离线渲染，不需要
  // 真实 server，见 CanvasConfirm 的 replaySnapshots prop）。
  const liveServer = usePreviewServer()
  const server = isReplay ? null : liveServer
  const hasConfirm = isReplay ? replayActivePanel === 'confirm' : server?.kind === 'confirm'
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
  // 回放版对齐同一语义：第一页在播放进度里被「生成出来」（揭示）之前 tab
  // 不存在——用户先看到大纲/文件逐步落地，随后预览 tab 出现并抢焦点，
  // 重现 live 的节奏。
  const showSlidesTab = isReplay
    ? (replayDeck?.ready.length ?? 0) > 0
    : hasPreview && !previewDown && identityOk
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
  // Edit/MultiEdit 改 deck 页时 writtenFiles（只认 Write）看不见——
  // useEditingSvgFile 给出前台会话此刻 in-flight 的 .svg 编辑目标。驱动
  // 两处：编辑中的 tab 抢焦点（下方 effect），以及幻灯片 tab 的脉冲点
  // （tabBusy）。LivePreviewEditor 里同源信号驱动跳页 + 骨架屏。
  const editingSvg = useEditingSvgFile()
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

  // AI 开始修改一张 deck 页（svg_output/ 下的 .svg 有 Edit/Write in flight）
  // → 抢焦点到 预览幻灯片：用户停在 文件/大纲 tab 时也立刻被带去看跳页 +
  // 骨架屏（LivePreviewEditor 挂载后自己会选中正在编辑的那页）。判定用
  // 路径而不是 slide 列表匹配——列表在 LivePreviewEditor 里，而它只在
  // slides tab 激活时才挂载，靠它上报会死锁（不挂载就永远没信号）。
  // 优先级：问题 tab 仍最高；声明在 图片 effect 之后，两信号同真时本
  // effect 后跑、编辑赢（AI 在改页面比图片生成更即时）。编辑期间用户手动
  // 切走不再强拽（editingDeckSvg 不变则不重跑）；下一轮编辑开始会再抢回。
  const editingDeckSvg =
    editingSvg !== null && /[/\\]svg_output[/\\]/.test(editingSvg.path)
  useEffect(() => {
    if (wantsQuestionsTab) return
    if (editingDeckSvg && showSlidesTab) setTab('slides')
  }, [editingDeckSvg, showSlidesTab, wantsQuestionsTab])

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
    slides: anySvgStreaming || editingDeckSvg,
    outline: designSpec?.streaming === true,
    files: anyPlainFileStreaming
  }

  // 幻灯片就绪进度（N/M + 进度条）：LivePreviewEditor 挂载期间写入、卸载
  // 清空——胶囊只在「预览幻灯片」tab 活跃时出现。它取代了 editor 里被删的
  // 56px 标题头（2026-07-07 工作区重设计），见 store 的头注释。
  const readiness = usePreviewReadinessStore((s) => s.readiness)

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
    // @container/workspace：分栏里视口断点失真，tab 栏的窄档适配（就绪
    // 胶囊降级）用容器查询。容器断点：lg=512 xl=576px。
    <div className="@container/workspace flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[4px] bg-card">
      {/* Tab bar —— 不再自带窗口拖拽 drag（2026-07-08 拖拽面收敛重构）：
          右列顶部的拖拽/双击缩放由根 layout 的 .window-drag-strip（常驻
          fixed 全宽 46px）覆盖，本 bar 曾经的 drag 声明随分栏开合反复
          增删矩形，是「上报竞态 → 整窗拖不动」的脆弱源之一（globals.css
          的 .window-drag-strip 注释有完整事故链）。tab 按钮保留 no-drag
          ——在 strip 上挖洞，点 tab 是切换视图不是拖窗。
          h-[46px] 与 ChatHeader 严格同高、同 hairline——分栏两根栏并排底边
          对齐成一条（2026-07-04 顶栏化改版）。 */}
      <div className="flex h-[46px] shrink-0 select-none items-center gap-0.5 border-b border-border/55 px-2">
        {tabs.map((tDef) => {
          const active = tDef.id === tab
          // Pulsing dot whenever this tab's content is changing — including the
          // tab currently in view (you're watching a file stream in; the dot is
          // the "still writing" signal). It clears the instant work settles.
          const busy = tabBusy[tDef.id] === true
          return (
            // whitespace-nowrap + min-w-0 + 文字 truncate（2026-07-16 用户
            // 实锤）：分栏拖窄时按钮曾把「大纲」挤成一行一个字的竖排惨状
            // ——文字默认可换行，宽度不够就断行。对齐图片查看器顶栏的
            // 处理：禁换行，窄时文字截断出省略号（图标恒显、shrink-0）。
            <button
              key={tDef.id}
              type="button"
              onClick={() => setTab(tDef.id)}
              className={
                'flex min-w-0 shrink items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[12px] transition-colors [-webkit-app-region:no-drag] ' +
                (active
                  ? 'bg-foreground/[0.06] font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground/90')
              }
            >
              <span className="shrink-0 [&>svg]:block">{CANVAS_TAB_ICONS[tDef.id]}</span>
              <span className="truncate">{tDef.label}</span>
              {busy && (
                <span aria-hidden className="relative ml-0.5 flex size-1.5 shrink-0">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-75" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
                </span>
              )}
            </button>
          )
        })}
        {/* 就绪进度胶囊（非交互，保持 bar 的 drag 语义）。emerald 与缩略
          * 图的就绪点同色。 */}
        {/* 窄档降级：≤576px 先收进度条（省 56px 给 tab），≤512px 整个
          * 胶囊让位——就绪数是 nice-to-have，tab 本体不能被挤断。 */}
        {readiness && (
          <div className="ml-auto flex items-center gap-2 rounded-full bg-foreground/[0.05] px-2.5 py-[5px] text-[11px] text-muted-foreground @max-lg/workspace:hidden">
            <span className="h-[3px] w-12 overflow-hidden rounded-full bg-foreground/[0.09] @max-xl/workspace:hidden">
              <span
                className="block h-full rounded-full bg-emerald-500 transition-[width] duration-300"
                style={{
                  width: `${Math.round((readiness.ready / Math.max(1, readiness.total)) * 100)}%`
                }}
              />
            </span>
            <span className="whitespace-nowrap">
              <span className="font-semibold tabular-nums text-foreground">
                {readiness.ready} / {readiness.total}
              </span>{' '}
              已就绪
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      {/* Confirm phase: the Eight-Confirmations page rendered NATIVELY (not an
          iframe). CanvasConfirm fetches the same Flask server's
          /api/catalogs + /api/recommendations off `server.url`, lets the user
          pick, and POSTs the SAME contract back to /api/confirm — the server's
          --wait-only loop (watching result.json) is unchanged.

          KEEP-ALIVE: this is rendered OUTSIDE the mutually-exclusive tab
          switch below and hidden with `hidden` (display:none) when another tab
          is active — NOT unmounted. CanvasConfirm holds the entire wizard
          progress (stage tier1→tier2, every picked option, phase) in local
          React state; unmounting it on a tab switch (e.g. peeking at 「文件」)
          would destroy all of that and remounting re-boots from
          recommendations.json, snapping the user back to stage-1 while the
          server's `_already_confirmed` flag persists — the "confirmed once but
          back at step one" bug. So it stays mounted for the whole confirm
          phase and only its visibility toggles. It still takes precedence over
          a questionnaire on the 问题 tab (the two never coincide, but if they
          did, the active confirm phase is the right surface — hence the
          `!hasConfirm` guard on the questionnaire branch below). */}
      {/* 回放态：CanvasConfirm 没有真实 server 可 fetch，baseUrl 只是占位
          key（组件内部 isReplay=replaySnapshots!==undefined 早退所有网络
          请求，见该组件头注释）——离线数据源是 replayConfirmSnapshots
          （manifest.meta.confirmSnapshots，ReplayController load() 时灌入
          replayStore）。旧格式包该字段为 null 时 hasConfirm 也不会为真
          （activeQuestionsPanel 只有 confirm.open 命中快照时才置位）。 */}
      {hasConfirm && (server || isReplay) && (
        <div
          className={
            tab === 'questions' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'
          }
        >
          {isReplay ? (
            <CanvasConfirm
              key="replay-confirm"
              baseUrl=""
              replaySnapshots={replayConfirmSnapshots ?? []}
            />
          ) : (
            <CanvasConfirm key={server!.url} baseUrl={server!.url} />
          )}
        </div>
      )}
      {/* When CanvasConfirm owns the 问题 tab (above), the fallback switch must
          render nothing — otherwise its trailing `else` occupancy placeholder
          would stack under the keep-alive confirm panel. */}
      {hasConfirm && (server || isReplay) && tab === 'questions' ? null : tab ===
          'questions' && !hasConfirm && hasQuestions ? (
        <CanvasQuestionnaire
          request={pendingAsk}
          streamingArgsText={streamingArgs}
          {...(isReplay ? { replayQuestions: replayQuestions ?? [] } : {})}
        />
      ) : tab === 'slides' && showSlidesTab && isReplay && replayDeck ? (
        // 回放：静态幻灯片查看器，数据 = 录像包里的 svg 资产（LivePreviewEditor
        // 依赖的 ppt-master server 回放时早已不在）。见 ReplaySlidesViewer。
        <ReplaySlidesViewer deck={replayDeck} />
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
