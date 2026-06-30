import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * LivePreviewEditor
 * -----------------
 * Native React replication of the ppt-master svg_editor live-preview editor
 * (skills/ppt-master/scripts/svg_editor/static/app.js), rendered inside the
 * 「幻灯片」canvas tab instead of iframing localhost:5050. It fetches the same
 * Flask server's `/api/slides` + `/api/slide/<name>`, lets the user select SVG
 * elements and attach edit instructions (annotations), and POSTs the SAME
 * contract back — the server is unchanged.
 *
 * Architecture (per the reference's design): the editor does NOT use a virtual
 * DOM for the slide. The server returns an SVG string with a stable `id` on
 * every element (backend assign_temp_ids); we inject it via innerHTML into a
 * ref'd container and operate the REAL SVG DOM imperatively — selection,
 * highlight classes, geometry — because geometry depends on the browser's live
 * layout (getBBox/getCTM/DOMMatrix). React state holds only METADATA: which ids
 * are selected, the annotation map, the slide list, the current page. We never
 * let React re-render the SVG internals (that would fight the imperative ops).
 *
 * MODULE 1 (this file, current scope): slide list + nav, element pick (click +
 * Ctrl/Cmd multi-select) with highlight, right-hand annotation panel ("N
 * selected" → edit instruction → Add annotation), annotation list + delete,
 * 应用修改 (save-all), 撤销 (undo), 退出预览 (shutdown). These cover the flow the
 * ppt-master pipeline actually uses (annotations are read by the AI to redo a
 * page).
 *
 * LATER MODULES (not here yet — marked `MODULE N:`): direct attribute editing
 * (X/Y/FILL/STROKE → /edit with the CTM/matrix geometry engine), marquee
 * rubber-band selection, drag/resize on canvas, tspan promotion.
 *
 * All fetches are absolute against `baseUrl` (the server's real origin from
 * usePreviewServer's stdout parse); CSP connect-src + the server's CORS hook
 * already permit the cross-origin calls.
 */

export interface LiveSlide {
  name: string
  annotated?: boolean
  annotation_count?: number
  ok?: boolean
  error?: string | null
  mtime?: number
}

interface SlideAnnotation {
  element_id: string
  tag?: string
  annotation: string
}

/** Rewrite a fetched slide's relative image refs to absolute server URLs so
 *  they load cross-origin. Mirror of the old SlidesLivePreview helper. */
function absolutizeSlideImages(svg: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '')
  return svg
    .replace(/(["'(])\.\.\/images\//g, `$1${base}/images/`)
    .replace(/(["'(])\.\.\/assets\//g, `$1${base}/assets/`)
    .replace(/(xlink:href|href)=("|')(?!https?:|data:|#|\/)([^"')]+\.(?:png|jpe?g|gif|webp|svg|bmp))\2/gi,
      (_m, attr, q, file) => `${attr}=${q}${base}/${file}${q}`)
}

const SKIP_TAGS = ['defs', 'style', 'title', 'desc', 'metadata', 'clippath', 'lineargradient', 'radialgradient', 'pattern', 'filter', 'mask', 'symbol']

export function LivePreviewEditor({
  baseUrl,
  onServerDownChange
}: {
  baseUrl: string
  // Reported up whenever reachability flips. The parent (SlidesWorkspace) uses
  // it to hide the 幻灯片 tab once the server is gone, so a stale launch URL in
  // the transcript no longer leaves a dead tab behind. The component keeps
  // polling while mounted, so it also reports recovery (false) if the URL comes
  // back to life before the parent unmounts it.
  onServerDownChange?: (down: boolean) => void
}): React.JSX.Element {
  const api = useCallback((p: string) => baseUrl.replace(/\/$/, '') + p, [baseUrl])

  const [slides, setSlides] = useState<LiveSlide[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Selection + annotations are METADATA (React state). The SVG DOM itself is
  // the source of truth for geometry; we only track ids here.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [annotations, setAnnotations] = useState<Record<string, string>>({})
  const [annotationText, setAnnotationText] = useState('')
  const [undoDepth, setUndoDepth] = useState(0)
  const [busy, setBusy] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  // True once the slide-list poll can't even reach the server (a network-level
  // "Failed to fetch", not an HTTP error). usePreviewServer resolves the URL
  // from the launch command in the transcript, which can outlive the server
  // (idle-timeout / manual stop) — so a dead URL would otherwise leave this tab
  // spinning on "等待幻灯片生成…(Failed to fetch)" forever. Detecting the
  // unreachable server lets us say so plainly instead. Recovers automatically
  // when the server comes back (a later poll succeeds).
  const [serverDown, setServerDown] = useState(false)

  // Refs so the poll closure / delegated handler always see latest values
  // without re-arming. activeRef gates late slide responses.
  const svgHostRef = useRef<HTMLDivElement | null>(null)
  const activeRef = useRef<string | null>(null)
  const mtimesRef = useRef<Record<string, number>>({})
  const followLatestRef = useRef(true)
  const selectedIdsRef = useRef<string[]>([])
  activeRef.current = active
  selectedIdsRef.current = selectedIds

  // Report reachability changes up to the parent (tab visibility).
  useEffect(() => {
    onServerDownChange?.(serverDown)
  }, [serverDown, onServerDownChange])

  // ── load one slide ───────────────────────────────────────────────────────
  const loadSlide = useCallback(
    async (name: string) => {
      try {
        const r = await fetch(api(`/api/slide/${encodeURIComponent(name)}`), { cache: 'no-store' })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const data = await r.json()
        if (typeof data?.content !== 'string') throw new Error('no content')
        if (typeof data.mtime === 'number') mtimesRef.current[name] = data.mtime
        if (activeRef.current !== name) return
        setContent(absolutizeSlideImages(data.content, baseUrl))
        setUndoDepth(typeof data.undo_depth === 'number' ? data.undo_depth : 0)
        // Seed annotations from the server's per-slide list.
        const list: SlideAnnotation[] = Array.isArray(data.annotations) ? data.annotations : []
        const map: Record<string, string> = {}
        list.forEach((a) => {
          if (a && a.element_id) map[a.element_id] = a.annotation
        })
        setAnnotations(map)
        setSelectedIds([])
        setError(null)
      } catch (e) {
        if (activeRef.current === name) setError(e instanceof Error ? e.message : String(e))
      }
    },
    [api, baseUrl]
  )

  // ── poll slide list (2s) ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const r = await fetch(api('/api/slides'), { cache: 'no-store' })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const data = await r.json()
        const list: LiveSlide[] = Array.isArray(data?.slides) ? data.slides : []
        if (cancelled) return
        setSlides(list)
        setError(null)
        setServerDown(false) // reachable again
        if (list.length === 0) return
        const cur = activeRef.current
        const newest = list[list.length - 1]?.name ?? null
        const want = cur === null || (followLatestRef.current && cur !== newest) ? newest : cur
        if (want && want !== cur) {
          setActive(want)
          activeRef.current = want
          void loadSlide(want)
          return
        }
        if (cur) {
          const entry = list.find((s) => s.name === cur)
          const seen = mtimesRef.current[cur]
          if (entry?.mtime !== undefined && entry.mtime !== seen) void loadSlide(cur)
        }
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        // A network-level failure (TypeError "Failed to fetch") means the URL
        // is unreachable — the server is gone (idle-timeout / stopped) even
        // though usePreviewServer still surfaces its stale launch URL. Flag it
        // so the empty state can say "服务已停止" instead of "等待生成".
        if (e instanceof TypeError) setServerDown(true)
      }
    }
    void poll()
    const id = window.setInterval(poll, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [api, loadSlide])

  const pickSlide = useCallback(
    (name: string): void => {
      followLatestRef.current = false // manual pick pins the view
      setActive(name)
      activeRef.current = name
      void loadSlide(name)
    },
    [loadSlide]
  )

  // ── imperative selection on the real SVG DOM ─────────────────────────────
  const svgRoot = useCallback((): SVGSVGElement | null => {
    return svgHostRef.current?.querySelector('svg') ?? null
  }, [])

  // Sync .svg-selected / .svg-annotated classes onto the real DOM whenever the
  // metadata or the injected content changes. This is the one place React state
  // drives imperative DOM — kept narrow (just two marker classes).
  useEffect(() => {
    const svg = svgRoot()
    if (!svg) return
    svg.querySelectorAll('.svg-selected').forEach((el) => el.classList.remove('svg-selected'))
    selectedIds.forEach((id) => {
      const el = svg.querySelector(`#${CSS.escape(id)}`)
      if (el) el.classList.add('svg-selected')
    })
  }, [selectedIds, content, svgRoot])

  useEffect(() => {
    const svg = svgRoot()
    if (!svg) return
    svg.querySelectorAll('.svg-annotated').forEach((el) => el.classList.remove('svg-annotated'))
    Object.keys(annotations).forEach((id) => {
      const el = svg.querySelector(`#${CSS.escape(id)}`)
      if (el) el.classList.add('svg-annotated')
    })
  }, [annotations, content, svgRoot])

  // Mark every element selectable (visual affordance) on each fresh injection.
  useEffect(() => {
    const svg = svgRoot()
    if (!svg) return
    svg.querySelectorAll('*').forEach((el) => {
      const tag = el.tagName.toLowerCase()
      if (SKIP_TAGS.indexOf(tag) !== -1 || el === svg) return
      el.classList.add('svg-selectable')
    })
  }, [content, svgRoot])

  // Delegated click selection (O(1) listener; backend gives every element an id).
  const onSvgClick = useCallback((e: React.MouseEvent): void => {
    const svg = svgRoot()
    if (!svg) return
    const target = e.target as Element
    if (target === svg) {
      setSelectedIds([])
      return
    }
    if (target.closest && target.closest('defs, style, title, desc')) return
    // Alt+click → pick the parent group; icon clicks resolve to the disk-backed
    // data-icon group (preview expands <use> into inner nodes).
    let picked: Element | null = e.altKey && target.closest ? target.closest('g[id]') : null
    picked = picked || (target.closest && target.closest('[data-icon][id]')) || target.closest('[id]')
    if (!picked || picked === svg) {
      setSelectedIds([])
      return
    }
    const id = picked.id
    if (!id) return
    const additive = e.ctrlKey || e.metaKey
    setSelectedIds((prev) => {
      if (additive) {
        return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      }
      return [id]
    })
  }, [svgRoot])

  // ── annotation actions ───────────────────────────────────────────────────
  const addAnnotation = useCallback(async () => {
    const name = activeRef.current
    const ids = selectedIdsRef.current
    const text = annotationText.trim()
    if (!name || ids.length === 0 || !text) return
    setBusy(true)
    try {
      await Promise.all(
        ids.map((eid) =>
          fetch(api(`/api/slide/${encodeURIComponent(name)}/annotate`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ element_id: eid, annotation: text })
          }).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            return r.json()
          })
        )
      )
      setAnnotations((prev) => {
        const next = { ...prev }
        ids.forEach((eid) => (next[eid] = text))
        return next
      })
      setAnnotationText('')
      setStatusMsg(null)
    } catch (e) {
      setStatusMsg('添加标注失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }, [api, annotationText])

  const removeAnnotation = useCallback(
    async (elementId: string) => {
      const name = activeRef.current
      if (!name) return
      try {
        await fetch(api(`/api/slide/${encodeURIComponent(name)}/annotate/${encodeURIComponent(elementId)}`), {
          method: 'DELETE'
        })
        setAnnotations((prev) => {
          const next = { ...prev }
          delete next[elementId]
          return next
        })
      } catch (e) {
        setStatusMsg('删除标注失败：' + (e instanceof Error ? e.message : String(e)))
      }
    },
    [api]
  )

  const applyChanges = useCallback(async () => {
    setBusy(true)
    setStatusMsg('正在应用…')
    try {
      const r = await fetch(api('/api/save-all'), { method: 'POST' })
      const data = await r.json()
      if (data.error) {
        setStatusMsg('应用失败：' + data.error)
      } else {
        setStatusMsg('已应用到 svg_output')
        setUndoDepth(0)
        // Reload the active slide so it reflects the written state.
        const name = activeRef.current
        if (name) void loadSlide(name)
      }
    } catch (e) {
      setStatusMsg('应用失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }, [api, loadSlide])

  const runUndo = useCallback(async () => {
    const name = activeRef.current
    if (!name) return
    setBusy(true)
    try {
      const r = await fetch(api(`/api/slide/${encodeURIComponent(name)}/undo`), { method: 'POST' })
      const data = await r.json()
      setUndoDepth(typeof data.undo_depth === 'number' ? data.undo_depth : 0)
      void loadSlide(name) // reload to reflect the rollback
    } catch (e) {
      setStatusMsg('撤销失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }, [api, loadSlide])

  const exitPreview = useCallback(async () => {
    try {
      await fetch(api('/api/shutdown'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'exit-preview' })
      })
    } catch {
      /* server gone — fine */
    }
    setStatusMsg('预览已退出')
  }, [api])

  const annotationEntries = useMemo(() => Object.entries(annotations), [annotations])

  // ── empty / loading state ────────────────────────────────────────────────
  if (slides.length === 0) {
    // serverDown: the URL is unreachable (server stopped) — say so plainly
    // rather than implying generation is still pending.
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-5">
        <div className="text-center">
          <div className="text-[14px] font-medium text-foreground">
            {serverDown ? '预览服务已停止' : '实时预览已就绪'}
          </div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            {serverDown
              ? '预览服务已关闭（空闲超时或已退出）。重新生成或重启预览后会再次出现。'
              : error
                ? `等待幻灯片生成…（${error}）`
                : '生成的幻灯片会在这里实时出现'}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* ── left: slide list ── */}
      <div className="w-40 shrink-0 overflow-y-auto border-r border-border/60 py-1.5">
        {slides.map((s, i) => {
          const on = s.name === active
          return (
            <button
              key={s.name}
              type="button"
              onClick={() => pickSlide(s.name)}
              className={
                'flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] transition-colors ' +
                (on
                  ? 'bg-foreground/[0.06] font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground/90')
              }
              title={s.name}
            >
              <span className="shrink-0 tabular-nums text-muted-foreground/50">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="min-w-0 truncate">{s.name}</span>
              {s.annotated && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-amber-500" />}
            </button>
          )
        })}
      </div>

      {/* ── center: slide stage (click-delegated selection) ── */}
      <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-4">
        {content ? (
          <div
            ref={svgHostRef}
            onClick={onSvgClick}
            className="w-full max-w-full [&_.svg-annotated]:outline [&_.svg-annotated]:outline-2 [&_.svg-annotated]:outline-amber-500/70 [&_.svg-selectable]:cursor-pointer [&_.svg-selected]:outline [&_.svg-selected]:outline-2 [&_.svg-selected]:outline-accent [&>svg]:h-auto [&>svg]:w-full [&>svg]:rounded [&>svg]:shadow-sm"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: content }}
          />
        ) : (
          <div className="text-[13px] text-muted-foreground">
            {error ? `加载失败：${error}` : '加载中…'}
          </div>
        )}
      </div>

      {/* ── right: annotation panel ── */}
      <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-l border-border/60">
        <div className="flex-1 overflow-y-auto px-3 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            已选元素
          </div>
          {selectedIds.length === 0 ? (
            <div className="mt-1 text-[12px] italic text-muted-foreground/70">
              点击幻灯片中的元素进行选择（Ctrl/Cmd+点击 多选）
            </div>
          ) : (
            <div className="mt-1 text-[13px] font-semibold text-accent">
              已选 {selectedIds.length} 个元素
            </div>
          )}

          {selectedIds.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">修改说明</div>
              <textarea
                rows={4}
                value={annotationText}
                onChange={(e) => setAnnotationText(e.target.value)}
                placeholder={`描述希望如何修改所选 ${selectedIds.length} 个元素…`}
                className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-[12px] text-foreground focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                disabled={busy || !annotationText.trim()}
                onClick={() => void addAnnotation()}
                className="mt-1.5 w-full rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                添加标注
              </button>
            </div>
          )}

          <div className="mt-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            本页标注
          </div>
          {annotationEntries.length === 0 ? (
            <div className="mt-1 text-[12px] italic text-muted-foreground/70">暂无标注</div>
          ) : (
            <div className="mt-1.5 flex flex-col gap-1.5">
              {annotationEntries.map(([eid, text]) => (
                <div
                  key={eid}
                  className="group rounded-md border border-border/60 bg-card/40 px-2.5 py-1.5"
                >
                  <div className="flex items-start gap-1.5">
                    <span className="min-w-0 flex-1 break-words text-[12px] text-foreground">{text}</span>
                    <button
                      type="button"
                      onClick={() => void removeAnnotation(eid)}
                      className="shrink-0 text-[11px] text-muted-foreground/60 hover:text-destructive"
                      title="删除"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/50">{eid}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* actions */}
        <div className="shrink-0 border-t border-border/60 px-3 py-2.5">
          {statusMsg && <div className="mb-2 text-[11px] text-muted-foreground">{statusMsg}</div>}
          <button
            type="button"
            disabled={busy || undoDepth === 0}
            onClick={() => void runUndo()}
            className="mb-1.5 w-full rounded-md border border-border bg-card/60 px-3 py-1.5 text-[12px] text-foreground transition hover:bg-muted disabled:opacity-40"
          >
            撤销{undoDepth > 0 ? ` (${undoDepth})` : ''}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyChanges()}
            className="mb-1.5 w-full rounded-md bg-amber-400 px-3 py-1.5 text-[12px] font-semibold text-amber-950 transition hover:bg-amber-300 disabled:opacity-50"
          >
            应用修改
          </button>
          <button
            type="button"
            onClick={() => void exitPreview()}
            className="w-full rounded-md border border-border bg-card/60 px-3 py-1.5 text-[12px] text-foreground transition hover:bg-muted"
          >
            退出预览
          </button>
        </div>
      </div>
    </div>
  )
}
