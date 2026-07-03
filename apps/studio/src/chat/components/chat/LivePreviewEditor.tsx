import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useDrag } from '@use-gesture/react'
import { useComposerRuntime } from '@assistant-ui/react'

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

/**
 * Warm the browser cache for every image an (absolutized) slide references,
 * BEFORE its innerHTML is swapped in. The swap rebuilds the whole SVG DOM,
 * so every `<image>` re-fetches from scratch — without warming, each swap
 * blanks all the photos for a network round-trip and the deck visibly
 * flashes on every regeneration (worst while the assistant is editing pages
 * in a loop). Warm cache = the rebuilt tree paints images synchronously.
 *
 * Missing images (still generating in the background → 404) settle fast and
 * resolve like everything else — the swap then shows the same blank spot it
 * showed before, i.e. no NEW flash. A slow straggler is capped by
 * `timeoutMs`: better to swap with one image late than hold the page on a
 * stale slide.
 */
function preloadSlideImages(svg: string, timeoutMs: number): Promise<void> {
  const urls = new Set<string>()
  const attrRe =
    /(?:xlink:href|href)=["'](https?:\/\/[^"']+\.(?:png|jpe?g|gif|webp|svg|bmp))["']/gi
  const cssRe =
    /url\((['"]?)(https?:\/\/[^)'"]+\.(?:png|jpe?g|gif|webp|svg|bmp))\1\)/gi
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(svg))) urls.add(m[1])
  while ((m = cssRe.exec(svg))) urls.add(m[2])
  if (urls.size === 0) return Promise.resolve()
  const loads = [...urls].map(
    (u) =>
      new Promise<void>((resolve) => {
        const img = new Image()
        img.onload = () => resolve()
        img.onerror = () => resolve()
        img.src = u
      })
  )
  return Promise.race([
    Promise.all(loads).then(() => undefined),
    new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs))
  ])
}

/** Strip the retry cache-buster off a probed image URL so failure bookkeeping
 *  always keys on the canonical URL. */
function canonicalImageUrl(url: string): string {
  return url.replace(/[?&]v=\d+$/, '')
}

const SKIP_TAGS = ['defs', 'style', 'title', 'desc', 'metadata', 'clippath', 'lineargradient', 'radialgradient', 'pattern', 'filter', 'mask', 'symbol']

/** A highlight box in stage-relative CSS px, plus the element id it tracks. */
interface OverlayRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/**
 * Resolve which element id a pointer landed on, mirroring the reference
 * editor's rules: alt → nearest ancestor group; otherwise the nearest
 * data-icon group (preview expands <use> into inner nodes) or nearest [id].
 * Returns null for the svg root / non-selectable defs. Pure so both the
 * click-tap path and marquee hit-test can share it.
 */
function resolvePickedId(
  target: Element,
  svg: SVGSVGElement,
  opts: { alt: boolean }
): string | null {
  if (target === svg) return null
  if (target.closest && target.closest('defs, style, title, desc')) return null
  let picked: Element | null = opts.alt && target.closest ? target.closest('g[id]') : null
  picked = picked || (target.closest && target.closest('[data-icon][id]')) || target.closest('[id]')
  if (!picked || picked === svg) return null
  return picked.id || null
}

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
  // The chat composer, so 应用修改 can prefill an instruction for the user to
  // send (LivePreviewEditor renders inside ThreadView's provider, so this is in
  // scope — same runtime the ProseMirror input drives via setText).
  const composerRuntime = useComposerRuntime()

  const [slides, setSlides] = useState<LiveSlide[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Per-slide SVG thumbnails for the rail. Keyed by slide name; each holds the
  // (image-absolutized) SVG string + the mtime it was fetched at, so we only
  // re-fetch a page when its mtime advances. SVG scales to the tiny thumb frame
  // by its own viewBox (vector, lossless), so this is a cheap real preview.
  const [thumbs, setThumbs] = useState<Record<string, { svg: string; mtime: number }>>({})

  // Whether the 已选元素 chip list is expanded. Collapsed (default) shows a
  // capped preview so a 60-element marquee doesn't blow the panel into an
  // endless scroll; expanded reveals all in a height-capped, self-scrolling box.
  const [selExpanded, setSelExpanded] = useState(false)

  // Selection + annotations are METADATA (React state). The SVG DOM itself is
  // the source of truth for geometry; we only track ids here.
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [annotations, setAnnotations] = useState<Record<string, string>>({})
  const [annotationText, setAnnotationText] = useState('')
  const [undoDepth, setUndoDepth] = useState(0)
  // ── interaction layer (hover / marquee) ──────────────────────────────────
  // The element under the cursor (drives the faint hover highlight box).
  const [hoverId, setHoverId] = useState<string | null>(null)
  // The rubber-band selection rectangle while dragging on the stage, in
  // stage-relative CSS px. Null when not marquee-dragging.
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  // Bumped to force the highlight overlay to re-measure element boxes: on page
  // change, container resize, image load, and scroll. Selection/hover changes
  // recompute on their own (they're effect deps), this is for geometry shifts
  // that don't change React state.
  const [geomVersion, setGeomVersion] = useState(0)
  const bumpGeom = useCallback(() => setGeomVersion((v) => v + 1), [])
  const reduceMotion = useReducedMotion()
  // The scrollable stage that hosts the SVG + overlay. Overlay boxes and
  // marquee coords are all measured relative to THIS element's rect.
  const stageRef = useRef<HTMLDivElement | null>(null)
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
  // Server image URLs that failed to load (canonical URL → probe attempts so
  // far). ppt-master writes SVG pages that reference images STILL BEING
  // generated in the background — those `<image>`s 404 and would stay blank
  // forever, because nothing re-requests them when the file finally lands
  // (the SVG's mtime doesn't change when a sibling PNG appears). The retry
  // loop below probes these and swaps them in place once servable.
  const failedImagesRef = useRef<Map<string, number>>(new Map())

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
        const absolutized = absolutizeSlideImages(data.content, baseUrl)
        // Only wait for the warm-up when a slide is already on screen — that's
        // the case where the innerHTML swap would flash. First paint (host not
        // mounted yet) should show content ASAP instead.
        if (svgHostRef.current) {
          await preloadSlideImages(absolutized, 1500)
          // Re-check after the await: the user may have switched pages while
          // we were warming this one's images.
          if (activeRef.current !== name) return
        }
        setContent(absolutized)
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

  // ── fetch per-slide SVG thumbnails for the rail ───────────────────────────
  // Runs whenever the slide list changes. For each slide whose thumbnail is
  // missing or stale (mtime advanced), fetch its SVG once and cache it. We read
  // `thumbs` through a ref so this effect isn't re-armed by its own setState
  // (which would loop). Fetches are fire-and-forget; each resolves into the map
  // independently, so thumbnails fill in as they arrive.
  const thumbsRef = useRef(thumbs)
  thumbsRef.current = thumbs
  useEffect(() => {
    let cancelled = false
    slides.forEach((s) => {
      const cached = thumbsRef.current[s.name]
      // Fetch when uncached, or when the list's mtime is newer than the cached
      // one (a page was regenerated). Slides with no mtime fetch once.
      if (cached && (s.mtime === undefined || cached.mtime >= s.mtime)) return
      void fetch(api(`/api/slide/${encodeURIComponent(s.name)}`), { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then(async (data) => {
          if (cancelled || !data || typeof data.content !== 'string') return
          const svg = absolutizeSlideImages(data.content, baseUrl)
          // Same warm-before-swap as loadSlide: a regenerated page replaces
          // its rail thumbnail's innerHTML too, and 15 tiny frames flashing
          // in a row reads worse than the main stage doing it once.
          await preloadSlideImages(svg, 1500)
          if (cancelled) return
          const mtime = typeof data.mtime === 'number' ? data.mtime : (s.mtime ?? 0)
          setThumbs((prev) => {
            const existing = prev[s.name]
            if (existing && existing.mtime >= mtime && existing.svg === svg) return prev
            return { ...prev, [s.name]: { svg, mtime } }
          })
        })
        .catch(() => {
          /* transient — a later slide-list poll re-triggers this effect */
        })
    })
    return () => {
      cancelled = true
    }
  }, [slides, api, baseUrl])

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

  // Sync the .svg-annotated marker class onto the real DOM. (Selection + hover
  // are NOT class-driven anymore — they're painted by the HighlightOverlay from
  // measured bounding boxes, which gives Figma-style fitted boxes + handles and
  // motion transitions that an `outline` class can't. The annotated amber dot
  // stays a class since it's a persistent, non-animated marker.)
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

  // Tap-select at a screen point (called from the useDrag tap branch). Uses
  // elementFromPoint so it works whether the tap originated on the stage or an
  // overlay — then resolves the real element id and applies the same
  // single/Ctrl-multi/Alt-parent rules the old delegated click had.
  const pickAt = useCallback(
    (clientX: number, clientY: number, mods: { alt: boolean; additive: boolean }): void => {
      const svg = svgRoot()
      if (!svg) return
      const target = document.elementFromPoint(clientX, clientY) as Element | null
      if (!target || !svg.contains(target)) {
        // Clicked outside any element (blank stage) → clear selection.
        setSelectedIds([])
        return
      }
      const id = resolvePickedId(target, svg, { alt: mods.alt })
      if (!id) {
        setSelectedIds([])
        return
      }
      setSelectedIds((prev) => {
        if (mods.additive) {
          return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
        }
        return [id]
      })
    },
    [svgRoot]
  )

  // ── highlight geometry: measure selected/hover element boxes ──────────────
  // Every box is stage-relative CSS px (getBoundingClientRect handles the
  // [&>svg]:w-full scaling for free). Recomputed when the selection/hover set,
  // the page content, or `geomVersion` (resize/scroll/image-load) changes.
  const measureRects = useCallback(
    (ids: string[]): OverlayRect[] => {
      const svg = svgRoot()
      const host = svgHostRef.current
      if (!svg || !host) return []
      // Base = the SVG host box. The overlay is absolutely positioned to cover
      // exactly this host (inset-0), so element rects measured relative to it
      // land dead-on regardless of stage padding / scroll / flex-centering.
      const base = host.getBoundingClientRect()
      const out: OverlayRect[] = []
      for (const id of ids) {
        const el = svg.querySelector(`#${CSS.escape(id)}`)
        if (!el) continue
        const r = (el as SVGGraphicsElement).getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        out.push({
          id,
          x: r.left - base.left,
          y: r.top - base.top,
          w: r.width,
          h: r.height
        })
      }
      return out
    },
    [svgRoot]
  )

  const selectedRects = useMemo(
    () => measureRects(selectedIds),
    // geomVersion intentionally in deps: a resize/scroll/load must re-measure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedIds, content, geomVersion, measureRects]
  )
  const hoverRect = useMemo(
    () => {
      // Don't draw a hover box over an already-selected element (avoids a
      // double frame); the selected box already reads as "active".
      if (!hoverId || selectedIds.includes(hoverId)) return null
      return measureRects([hoverId])[0] ?? null
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hoverId, selectedIds, content, geomVersion, measureRects]
  )

  // Collapse the chip list again once the selection is cleared, so the next
  // multi-select starts folded rather than remembering a stale expanded state.
  useEffect(() => {
    if (selectedIds.length === 0) setSelExpanded(false)
  }, [selectedIds.length])

  // ── geometry sync: bump on resize / scroll / image load / page change ─────
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const ro = new ResizeObserver(() => bumpGeom())
    ro.observe(stage)
    const svg = svgRoot()
    if (svg) ro.observe(svg)
    const onScroll = (): void => bumpGeom()
    stage.addEventListener('scroll', onScroll, { passive: true })
    // Late-loading <image> tags change bboxes after injection — re-measure on
    // each load. Capture phase so it fires for the descendant images.
    const onLoad = (): void => bumpGeom()
    stage.addEventListener('load', onLoad, true)
    return () => {
      ro.disconnect()
      stage.removeEventListener('scroll', onScroll)
      stage.removeEventListener('load', onLoad, true)
    }
  }, [content, bumpGeom, svgRoot])

  // Fresh page → clear transient hover/marquee so no stale box lingers.
  useEffect(() => {
    setHoverId(null)
    setMarquee(null)
  }, [content])

  // ── missing-image recovery ────────────────────────────────────────────────
  // Collect load failures for THIS server's images. A window capture-phase
  // listener sees resource `error` events (they don't bubble, but capture
  // reaches them — same mechanism as the geometry effect's `load` listener),
  // covering both the main stage and the thumbnail rail with one hook.
  // Filtering on the server origin keeps unrelated app images (avatars etc.)
  // out of the retry set.
  useEffect(() => {
    const base = baseUrl.replace(/\/$/, '')
    const onError = (e: Event): void => {
      const t = e.target
      let url = ''
      if (t instanceof SVGImageElement) url = t.href.baseVal
      else if (t instanceof HTMLImageElement) url = t.currentSrc || t.src
      if (!url || !url.startsWith(base)) return
      const canonical = canonicalImageUrl(url)
      if (!failedImagesRef.current.has(canonical)) {
        failedImagesRef.current.set(canonical, 0)
      }
    }
    window.addEventListener('error', onError, true)
    return () => window.removeEventListener('error', onError, true)
  }, [baseUrl])

  // Probe failed images on a slow tick. On success, repoint every matching
  // `<image>` in the live SVG at a cache-busted URL IN PLACE — no innerHTML
  // rebuild, so the rest of the page doesn't so much as blink while the
  // photo "develops" — and drop any cached rail thumbnails that referenced
  // it (the 2s slide-list poll re-arms the thumbnail effect, which re-fetches
  // them with the image now servable). Attempts are capped per URL so an
  // image that will never exist (generation genuinely failed) doesn't get
  // probed forever.
  useEffect(() => {
    const RETRY_MS = 3000
    const MAX_ATTEMPTS = 400 // × 3s ≈ 20min — beyond any real generation run
    const id = window.setInterval(() => {
      failedImagesRef.current.forEach((attempts, url) => {
        if (attempts >= MAX_ATTEMPTS) {
          failedImagesRef.current.delete(url)
          return
        }
        failedImagesRef.current.set(url, attempts + 1)
        const busted = `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`
        const probe = new Image()
        probe.onload = () => {
          failedImagesRef.current.delete(url)
          const host = svgHostRef.current
          if (host) {
            host.querySelectorAll('image').forEach((el) => {
              const cur =
                el.getAttribute('href') ?? el.getAttribute('xlink:href')
              if (cur === url) {
                el.setAttribute('href', busted)
                if (el.hasAttribute('xlink:href')) {
                  el.setAttribute('xlink:href', busted)
                }
              }
            })
          }
          setThumbs((prev) => {
            let changed = false
            const next: typeof prev = {}
            for (const [k, v] of Object.entries(prev)) {
              if (v.svg.includes(url)) {
                changed = true
                continue
              }
              next[k] = v
            }
            return changed ? next : prev
          })
          bumpGeom() // the developed image changes bboxes — re-measure overlay
        }
        probe.src = busted
      })
    }, RETRY_MS)
    return () => window.clearInterval(id)
  }, [bumpGeom])

  // ── hover pre-highlight (rAF-throttled delegated mousemove) ───────────────
  const hoverRafRef = useRef(0)
  const pendingHoverPtRef = useRef<{ x: number; y: number } | null>(null)
  // Set the instant a marquee drag starts (before the `marquee` state commits),
  // so the concurrent mousemove doesn't flicker a hover box mid-drag.
  const draggingRef = useRef(false)
  const onStageMouseMove = useCallback(
    (e: React.MouseEvent): void => {
      // While marquee-dragging, suppress hover (the box is the feedback).
      if (draggingRef.current || marquee) return
      pendingHoverPtRef.current = { x: e.clientX, y: e.clientY }
      if (hoverRafRef.current) return
      hoverRafRef.current = requestAnimationFrame(() => {
        hoverRafRef.current = 0
        const pt = pendingHoverPtRef.current
        const svg = svgRoot()
        if (!pt || !svg) return
        const target = document.elementFromPoint(pt.x, pt.y) as Element | null
        const id = target && svg.contains(target) ? resolvePickedId(target, svg, { alt: false }) : null
        setHoverId((prev) => (prev === id ? prev : id))
      })
    },
    [marquee, svgRoot]
  )
  const onStageMouseLeave = useCallback(() => setHoverId(null), [])
  useEffect(() => {
    return () => {
      if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current)
    }
  }, [])

  // ── marquee selection (drag) + tap-select, via @use-gesture ───────────────
  // filterTaps splits a <3px displacement into a `tap` (single/Ctrl select) vs
  // a drag (rubber-band marquee). Bound to the stage; coords are converted to
  // stage-relative for the marquee box and back to screen for the hit-test.
  const bindDrag = useDrag(
    ({ first, last, tap, initial: [ix, iy], xy: [cx, cy], event }) => {
      const host = svgHostRef.current
      const svg = svgRoot()
      if (!host || !svg) return
      const me = event as MouseEvent | undefined
      const mods = {
        alt: me?.altKey ?? false,
        additive: (me?.ctrlKey ?? false) || (me?.metaKey ?? false),
        shift: me?.shiftKey ?? false
      }
      if (tap) {
        // A click, not a drag → single/Ctrl-multi/Alt-parent select.
        draggingRef.current = false
        pickAt(cx, cy, { alt: mods.alt, additive: mods.additive })
        return
      }
      // Marquee coords are host-relative to match the overlay's origin.
      const base = host.getBoundingClientRect()
      const toHost = (px: number, py: number): { x: number; y: number } => ({
        x: px - base.left,
        y: py - base.top
      })
      if (first) {
        draggingRef.current = true
        setHoverId(null)
      }
      const a = toHost(ix, iy)
      const b = toHost(cx, cy)
      const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
      if (last) {
        draggingRef.current = false
        setMarquee(null)
        // Hit-test: screen-space intersection of the marquee with each id'd,
        // selectable element. Kept to the drag END (one pass, not per-frame).
        const mx1 = Math.min(ix, cx)
        const my1 = Math.min(iy, cy)
        const mx2 = Math.max(ix, cx)
        const my2 = Math.max(iy, cy)
        const hits: string[] = []
        svg.querySelectorAll<SVGGraphicsElement>('[id]').forEach((el) => {
          if (el === (svg as unknown as SVGGraphicsElement)) return
          const tag = el.tagName.toLowerCase()
          if (SKIP_TAGS.indexOf(tag) !== -1) return
          const r = el.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) return
          const intersects = r.left < mx2 && r.right > mx1 && r.top < my2 && r.bottom > my1
          if (intersects && el.id) hits.push(el.id)
        })
        setSelectedIds((prev) => {
          if (mods.additive || mods.shift) {
            const set = new Set(prev)
            hits.forEach((h) => set.add(h))
            return Array.from(set)
          }
          return hits
        })
        return
      }
      setMarquee(box)
    },
    { filterTaps: true, threshold: 4, pointer: { touch: true } }
  )

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
        setUndoDepth(0)
        const name = activeRef.current
        // Prefill the chat composer with an instruction to apply the annotations
        // we just saved, and nudge the user to send it. save-all wrote the
        // annotations into svg_output, so the AI can read them to redo the page;
        // this just hands the user a ready-to-send prompt instead of making them
        // type it. We DON'T auto-send — the user reviews and hits Enter.
        if (name) {
          void loadSlide(name) // reflect the written state
          composerRuntime.setText('应用我的标注')
          setStatusMsg('已填入输入框，按发送让 AI 修改')
        } else {
          setStatusMsg('已应用到 svg_output')
        }
      }
    } catch (e) {
      setStatusMsg('应用失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }, [api, loadSlide, composerRuntime])

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

  // ── deck-level derived state (top bar / breadcrumb / status bar) ──────────
  // Ready count: a slide is "ready" when it rendered without error (ok !== false).
  const readyCount = useMemo(() => slides.filter((s) => s.ok !== false).length, [slides])
  const activeIndex = useMemo(
    () => slides.findIndex((s) => s.name === active),
    [slides, active]
  )
  // Page label + display name, stripped of the leading "NN_" and ".svg".
  const activeNo = activeIndex >= 0 ? String(activeIndex + 1).padStart(2, '0') : '—'
  const activeDisplayName = active
    ? active.replace(/\.svg$/i, '').replace(/^\d+[_-]/, '')
    : ''
  // Step to the prev/next slide (drives the breadcrumb arrows + ← → keys).
  const stepSlide = useCallback(
    (delta: number): void => {
      if (activeIndex < 0 || slides.length === 0) return
      const next = activeIndex + delta
      if (next < 0 || next >= slides.length) return
      followLatestRef.current = false
      pickSlide(slides[next].name)
    },
    [activeIndex, slides, pickSlide]
  )

  // ← / → change slides (ignored while typing in the annotation textarea).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return
      if (e.key === 'ArrowLeft') stepSlide(-1)
      else if (e.key === 'ArrowRight') stepSlide(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stepSlide])

  // ── empty / loading state ────────────────────────────────────────────────
  if (slides.length === 0) {
    // serverDown: the URL is unreachable (server stopped) — say so plainly
    // (and statically: an inviting "materializing" animation would imply
    // generation is still pending, which is exactly the wrong signal here).
    if (serverDown) {
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-5">
          <div className="text-center">
            <div className="text-[14px] font-medium text-foreground">预览服务已停止</div>
            <div className="mt-1 text-[13px] text-muted-foreground">
              预览服务已关闭（空闲超时或已退出）。重新生成或重启预览后会再次出现。
            </div>
          </div>
        </div>
      )
    }
    // Server alive, no slides yet → the animated "materializing" empty state.
    return (
      <PreviewEmptyState
        hint={error ? `等待幻灯片生成…（${error}）` : '生成的幻灯片会在这里实时出现'}
      />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#FAFAFA]">
      {/* ── top app bar: deck title + ready progress ── */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border/60 bg-background px-4">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13.5px] font-semibold tracking-tight text-foreground">
            幻灯片预览
          </span>
          <span className="text-[11px] text-muted-foreground">
            <span className="tabular-nums">
              {readyCount} / {slides.length}
            </span>{' '}
            张幻灯片已就绪
          </span>
        </div>
      </header>

      {/* ── body: rail | stage | panel ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* ── left: thumbnail rail ── */}
        <aside className="flex w-44 shrink-0 flex-col border-r border-border/60 bg-background">
          <div className="flex items-center justify-between px-3.5 pb-2 pt-3">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              幻灯片
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground/70">
              {activeNo} / {String(slides.length).padStart(2, '0')}
            </span>
          </div>
          <div className="flex-1 space-y-1.5 overflow-y-auto px-2.5 pb-3">
            {slides.map((s, i) => {
              const on = s.name === active
              const ready = s.ok !== false
              return (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => pickSlide(s.name)}
                  className={
                    'flex w-full items-center gap-2 rounded-lg p-1.5 text-left transition-colors ' +
                    (on ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.04]')
                  }
                  title={s.name}
                >
                  <span
                    className={
                      'w-4 shrink-0 text-right text-[11px] tabular-nums ' +
                      (on ? 'font-semibold text-foreground' : 'text-muted-foreground/60')
                    }
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {/* Real per-slide SVG preview. The SVG scales to this frame by
                      its own viewBox; pointer-events-none + a transparent shield
                      keep it non-interactive (clicks go to the button). Falls
                      back to a light skeleton until the SVG arrives. */}
                  <span className="relative aspect-[16/9] flex-1 overflow-hidden rounded-md border border-border/60 bg-background">
                    {thumbs[s.name] ? (
                      <span
                        className="pointer-events-none absolute inset-0 block [&>svg]:h-full [&>svg]:w-full [&>svg]:object-contain"
                        // eslint-disable-next-line react/no-danger
                        dangerouslySetInnerHTML={{ __html: thumbs[s.name].svg }}
                      />
                    ) : (
                      <span className="absolute inset-0 flex flex-col justify-center gap-[3px] px-1.5">
                        <span className="h-[2px] w-5 rounded-full bg-muted-foreground/30" />
                        <span className="h-[4px] w-[70%] rounded-full bg-muted-foreground/40" />
                        <span className="h-[2px] w-full rounded-full bg-muted-foreground/20" />
                        <span className="h-[2px] w-[45%] rounded-full bg-muted-foreground/20" />
                      </span>
                    )}
                    {/* transparent shield so SVG internals never intercept clicks */}
                    <span className="absolute inset-0" />
                    <span
                      className={
                        'absolute right-1 top-1 size-[7px] rounded-full ring-2 ring-background ' +
                        (ready ? 'bg-emerald-500' : 'bg-muted-foreground/30')
                      }
                    />
                    {s.annotated && (
                      <span className="absolute bottom-1 right-1 size-1.5 rounded-full bg-amber-500" />
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        {/* ── center: breadcrumb + stage ── */}
        <section className="flex min-w-0 flex-1 flex-col bg-[#FAFAFA]">
          {/* breadcrumb: page no + name + prev/next */}
          <div className="flex items-center gap-2.5 px-5 py-3">
            <span className="rounded-md border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums tracking-wide text-muted-foreground">
              {activeNo}
            </span>
            <span className="truncate text-[13px] font-semibold text-foreground">
              {activeDisplayName || '未命名'}
            </span>
            <div className="flex-1" />
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => stepSlide(-1)}
                disabled={activeIndex <= 0}
                className="grid size-[30px] place-items-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                title="上一页"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <button
                type="button"
                onClick={() => stepSlide(1)}
                disabled={activeIndex < 0 || activeIndex >= slides.length - 1}
                className="grid size-[30px] place-items-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                title="下一页"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>
          </div>

          {/* stage: centres the canvas card. The CANVAS CARD is the drag/hover
              surface (not the whole stage) so marquee coords + overlay align to
              the card. select-none: a marquee drag must NOT native-select the
              SVG <text>. onMouseDown here clears the selection when the user
              clicks the empty margin AROUND the card (outside stageRef) — a
              natural "click blank to deselect" that the card's own handler
              can't cover since that whitespace isn't part of the card. */}
          <div
            className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 pb-6 pt-1"
            onMouseDown={(e) => {
              if (stageRef.current && !stageRef.current.contains(e.target as Node)) {
                setSelectedIds([])
              }
            }}
          >
            {content ? (
              <div className="flex w-full max-w-[900px] flex-col items-center gap-3.5">
                {/* Two nested layers so the selection overlay is NOT clipped by
                    the card's rounded corners:
                     - outer (stageRef): the drag/hover surface + overlay origin.
                       NO overflow-hidden, so boxes/handles on elements near the
                       edge render fully (they'd otherwise be cut by the round
                       corner — the bug this fixes).
                     - inner (svgHost): rounded-xl + overflow-hidden clips only
                       the SVG itself to the card shape + carries the shadow. */}
                <div
                  ref={stageRef}
                  {...bindDrag()}
                  onMouseMove={onStageMouseMove}
                  onMouseLeave={onStageMouseLeave}
                  className="relative w-full select-none"
                  style={{ touchAction: 'none' }}
                >
                  <div
                    ref={svgHostRef}
                    className="w-full max-w-full overflow-hidden rounded-xl bg-background shadow-[0_4px_16px_rgba(0,0,0,0.06)] [&_.svg-annotated]:outline [&_.svg-annotated]:outline-2 [&_.svg-annotated]:outline-amber-500/70 [&_.svg-selectable]:cursor-pointer [&>svg]:block [&>svg]:h-auto [&>svg]:w-full"
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: content }}
                  />
                  <HighlightOverlay
                    selected={selectedRects}
                    hover={hoverRect}
                    marquee={marquee}
                    reduceMotion={!!reduceMotion}
                  />
                </div>
                <div className="text-[12px] text-muted-foreground/70">
                  点击元素选择 · 拖拽框选多个 · Ctrl/Cmd 加选 · Alt 选父级 · 选中后在右侧填写修改说明
                </div>
              </div>
            ) : (
              <div className="text-[13px] text-muted-foreground">
                {error ? `加载失败：${error}` : '加载中…'}
              </div>
            )}
          </div>
        </section>

      {/* ── right: annotation panel ── */}
      <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-l border-border/60 bg-background">
        <div className="flex-1 space-y-4 overflow-y-auto px-3.5 py-3.5">
          {/* 已选元素 */}
          <section>
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                已选元素
                {selectedIds.length > 0 && (
                  <span className="ml-1.5 tabular-nums text-muted-foreground/60">
                    {selectedIds.length}
                  </span>
                )}
              </span>
              {selectedIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedIds([])}
                  className="text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"
                >
                  清空
                </button>
              )}
            </div>
            {selectedIds.length === 0 ? (
              <div className="mt-2 rounded-lg border border-dashed border-border/60 px-3 py-3 text-center text-[11.5px] leading-relaxed text-muted-foreground/70">
                点击元素选择 · 拖拽框选多个
                <br />
                <span className="text-muted-foreground/50">Ctrl/Cmd 加选 · Alt 选父级</span>
              </div>
            ) : (
              (() => {
                // Collapsed: show only the first SEL_COLLAPSED_MAX chips so a big
                // marquee doesn't create an endless list. Expanded: show all in a
                // height-capped, self-scrolling box (never grows the panel past
                // ~9 rows). The extra count folds into a "+N 更多" toggle.
                const SEL_COLLAPSED_MAX = 12
                const overflow = selectedIds.length - SEL_COLLAPSED_MAX
                const shown =
                  selExpanded || overflow <= 0
                    ? selectedIds
                    : selectedIds.slice(0, SEL_COLLAPSED_MAX)
                return (
                  <>
                    <div
                      className={
                        'mt-2 flex flex-wrap gap-1.5 ' +
                        (selExpanded ? 'max-h-56 overflow-y-auto pr-0.5' : '')
                      }
                    >
                      {shown.map((id) => (
                        <span
                          key={id}
                          className="group inline-flex max-w-full items-center gap-1 rounded-md bg-accent/10 py-1 pl-2 pr-1 text-[11px] font-medium text-accent ring-1 ring-inset ring-accent/20"
                          title={id}
                        >
                          <span className="min-w-0 max-w-[140px] truncate">{id}</span>
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedIds((prev) => prev.filter((x) => x !== id))
                            }
                            className="grid size-3.5 shrink-0 place-items-center rounded-sm text-accent/60 transition-colors hover:bg-accent/20 hover:text-accent"
                            title="取消选择"
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                    {overflow > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelExpanded((v) => !v)}
                        className="mt-1.5 text-[11px] font-medium text-accent/80 transition-colors hover:text-accent"
                      >
                        {selExpanded ? '收起' : `+${overflow} 更多`}
                      </button>
                    )}
                  </>
                )
              })()
            )}
          </section>

          {/* 修改说明 (only with a selection) */}
          {selectedIds.length > 0 && (
            <section>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                修改说明
              </div>
              <textarea
                rows={4}
                value={annotationText}
                onChange={(e) => setAnnotationText(e.target.value)}
                placeholder={`描述希望如何修改所选 ${selectedIds.length} 个元素…`}
                className="w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-[12px] leading-relaxed text-foreground transition-colors placeholder:text-muted-foreground/50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
              />
              <button
                type="button"
                disabled={busy || !annotationText.trim()}
                onClick={() => void addAnnotation()}
                className="mt-2 w-full rounded-lg bg-foreground px-3 py-2 text-[12px] font-semibold text-background shadow-sm transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100"
              >
                添加标注
              </button>
            </section>
          )}

          {/* 本页标注 */}
          <section>
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                本页标注
              </span>
              {annotationEntries.length > 0 && (
                <span className="grid min-w-[18px] place-items-center rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-600">
                  {annotationEntries.length}
                </span>
              )}
            </div>
            {annotationEntries.length === 0 ? (
              <div className="mt-2 text-[11.5px] text-muted-foreground/60">暂无标注</div>
            ) : (
              <div className="mt-2 flex flex-col gap-1.5">
                {annotationEntries.map(([eid, text]) => (
                  <div
                    key={eid}
                    className="group rounded-lg border border-border/60 bg-card/60 px-2.5 py-2 transition-colors hover:border-border"
                  >
                    <div className="flex items-start gap-1.5">
                      <span className="mt-0.5 size-1.5 shrink-0 rounded-full bg-amber-500" />
                      <span className="min-w-0 flex-1 break-words text-[12px] leading-relaxed text-foreground">
                        {text}
                      </span>
                      <button
                        type="button"
                        onClick={() => void removeAnnotation(eid)}
                        className="grid size-4 shrink-0 place-items-center rounded text-[11px] text-muted-foreground/50 opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                        title="删除标注"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="mt-1 truncate pl-3 font-mono text-[10px] text-muted-foreground/40">
                      {eid}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* actions (sticky footer) */}
        <div className="shrink-0 space-y-1.5 border-t border-border/60 bg-card/40 px-3.5 py-3">
          {statusMsg && (
            <div className="mb-1 rounded-md bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
              {statusMsg}
            </div>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void applyChanges()}
            className="w-full rounded-lg bg-foreground px-3 py-2 text-[12.5px] font-semibold text-background shadow-sm transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
          >
            应用修改
          </button>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy || undoDepth === 0}
              onClick={() => void runUndo()}
              className="flex-1 rounded-lg border border-border bg-background/60 px-3 py-1.5 text-[12px] text-foreground transition-all hover:bg-muted active:scale-[0.98] disabled:opacity-40 disabled:active:scale-100"
            >
              撤销{undoDepth > 0 ? ` (${undoDepth})` : ''}
            </button>
            <button
              type="button"
              onClick={() => void exitPreview()}
              className="flex-1 rounded-lg border border-border bg-background/60 px-3 py-1.5 text-[12px] text-muted-foreground transition-all hover:bg-muted hover:text-foreground active:scale-[0.98]"
            >
              退出预览
            </button>
          </div>
        </div>
      </div>
      </div>

      {/* ── bottom status bar ── */}
      <footer className="flex h-9 shrink-0 items-center gap-2.5 border-t border-border/60 bg-background px-4 text-[11.5px] text-muted-foreground">
        <span className="text-muted-foreground/80">16:9 · 1280 × 720 · HTML 幻灯片工作区</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5 text-muted-foreground/80">
          <kbd className="grid h-[18px] min-w-[18px] place-items-center rounded border border-border bg-muted/50 px-1 text-[10px]">←</kbd>
          <kbd className="grid h-[18px] min-w-[18px] place-items-center rounded border border-border bg-muted/50 px-1 text-[10px]">→</kbd>
          <span>切换页</span>
        </div>
      </footer>
    </div>
  )
}

/**
 * HighlightOverlay
 * ----------------
 * The Figma-style selection layer, painted from measured element boxes rather
 * than SVG `outline` classes. Covers the SVG host (inset-0, pointer-events-none
 * so it never eats the drag). Draws:
 *   - selected boxes: 1.5px accent border + 4 corner handles, motion-animated
 *     into position so re-selection / geometry shifts glide instead of jump.
 *   - a hover box: a fainter accent border, no handles (a "will select this"
 *     affordance), suppressed when the hovered element is already selected.
 *   - the marquee: the live rubber-band rectangle while dragging.
 *
 * Motion is skipped under prefers-reduced-motion (boxes snap to position).
 */
function HighlightOverlay({
  selected,
  hover,
  marquee,
  reduceMotion
}: {
  selected: OverlayRect[]
  hover: OverlayRect | null
  marquee: { x: number; y: number; w: number; h: number } | null
  reduceMotion: boolean
}): React.JSX.Element {
  const transition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 700, damping: 40, mass: 0.6 }
  // Corner handle offsets (relative to each box corner). 6px squares centred.
  const handles = [
    { left: -4, top: -4 },
    { right: -4, top: -4 },
    { left: -4, bottom: -4 },
    { right: -4, bottom: -4 }
  ]
  // No overflow-hidden on the root: selection boxes + corner handles on
  // elements near the card edge must render in full (clipping them was the
  // cut-corner bug). Handles sit a few px OUTSIDE the element box, so any clip
  // crops them. The marquee can also spill slightly past the edge — that reads
  // as normal drag-select behaviour, not a defect.
  return (
    <div className="pointer-events-none absolute inset-0">
      {/* hover box (behind selection) */}
      {hover && (
        <motion.div
          className="absolute rounded-[2px] border border-accent/50"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1, left: hover.x, top: hover.y, width: hover.w, height: hover.h }}
          transition={transition}
        />
      )}
      {/* selected boxes + corner handles */}
      <AnimatePresence>
        {selected.map((r) => (
          <motion.div
            key={r.id}
            className="absolute rounded-[2px] border-[1.5px] border-accent"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1, left: r.x, top: r.y, width: r.w, height: r.h }}
            exit={reduceMotion ? undefined : { opacity: 0 }}
            transition={transition}
          >
            {handles.map((h, i) => (
              <span
                key={i}
                className="absolute size-[6px] rounded-[1px] border border-white bg-accent shadow-sm"
                style={h}
              />
            ))}
          </motion.div>
        ))}
      </AnimatePresence>
      {/* marquee rubber-band */}
      {marquee && marquee.w > 1 && marquee.h > 1 && (
        <div
          className="absolute rounded-[1px] border border-accent/70 bg-accent/10"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}
    </div>
  )
}

/**
 * 空态「幻灯片显影」动画 — live-preview server 已就绪、第一页还没生成时的
 * 等待画面（原型:docs/preview-empty-state.html，用户选定「显影」变体）。
 *
 * 视觉语言与画布卡片一致：点阵展台（中心聚焦渐隐）上浮一叠 16:9 幽灵卡；
 * 主卡内是骨架内容（错峰微光），accent 扫描线周期性自上而下「显影」，
 * 描边彗星沿卡缘巡游，稀疏的生成尘埃自卡片下沿上浮。所有颜色走主题
 * token（hsl(var(--accent)) 等），换肤与深浅色自动跟随；动画类在
 * assets/main.css 的 pes- 段，reduced-motion 那里统一冻结。
 *
 * 尘埃参数（位置/时长/相位）用 useMemo 固定 —— 每次渲染重掷随机数会让
 * 微粒跳位，动画看起来像在闪。
 */
function PreviewEmptyState({ hint }: { hint: string }): React.JSX.Element {
  const sparkles = useMemo(
    () =>
      Array.from({ length: 12 }, () => ({
        left: 6 + Math.random() * 88,
        top: 55 + Math.random() * 50,
        dur: 3.4 + Math.random() * 3.2,
        delay: Math.random() * 6,
        peak: 0.35 + Math.random() * 0.4
      })),
    []
  )
  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-11 overflow-hidden">
      {/* 点阵展台：点层 → 四周渐隐罩 → accent 环境光，三层都不挡交互 */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, hsl(var(--foreground) / 0.13) 1px, transparent 1.2px)',
          backgroundSize: '24px 24px',
          backgroundPosition: 'center'
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 62% 55% at 50% 44%, transparent 32%, hsl(var(--background)) 78%)'
        }}
      />
      <div
        aria-hidden
        className="pes-ambient absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 40% 34% at 50% 42%, hsl(var(--accent) / 0.10), transparent 70%)'
        }}
      />

      {/* 幽灵卡组（16:9） */}
      <div className="relative z-[1] h-[169px] w-[300px]">
        <div className="pes-ghost-b absolute inset-0 rounded-[10px] border border-border/70 bg-card opacity-40 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]" />
        <div className="pes-ghost-a absolute inset-0 rounded-[10px] border border-border/70 bg-card opacity-60 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)]" />
        <div className="pes-bob absolute inset-0 flex flex-col gap-2.5 overflow-hidden rounded-[10px] border border-border/70 bg-card px-5 py-[18px] shadow-[0_1px_2px_rgba(0,0,0,0.05),0_12px_32px_-8px_rgba(0,0,0,0.16)]">
          <div className="pes-sk h-4 w-[58%]" />
          <div className="pes-sk flex-1" style={{ animationDelay: '.35s' }} />
          <div className="pes-sk h-2 w-[86%]" style={{ animationDelay: '.6s' }} />
          <div className="pes-sk h-2 w-[64%]" style={{ animationDelay: '.75s' }} />
          <div aria-hidden className="pes-scan" />
          <svg
            aria-hidden
            className="pes-comet pointer-events-none absolute -inset-px"
            viewBox="0 0 300 169"
            preserveAspectRatio="none"
          >
            <rect x="1" y="1" width="298" height="167" rx="10" />
          </svg>
        </div>
        {sparkles.map((s, i) => (
          <span
            key={i}
            aria-hidden
            className="pes-sparkle"
            style={
              {
                left: `${s.left}%`,
                top: `${s.top}%`,
                '--pes-dur': `${s.dur.toFixed(2)}s`,
                '--pes-delay': `${s.delay.toFixed(2)}s`,
                '--pes-peak': s.peak.toFixed(2)
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      {/* 状态文案：呼吸圆点复用 tab busy dot 的 ping 语言 */}
      <div className="relative z-[1] flex flex-col items-center gap-[7px] text-center">
        <div className="flex items-center gap-2">
          <span aria-hidden className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
          </span>
          <div className="text-[14px] font-medium text-foreground">实时预览已就绪</div>
        </div>
        <div className="text-[13px] text-muted-foreground">{hint}</div>
      </div>
    </div>
  )
}
