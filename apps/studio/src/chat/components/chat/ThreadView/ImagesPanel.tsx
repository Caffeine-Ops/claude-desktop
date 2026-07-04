import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'

import type {
  ImageManifestItem,
  ImageManifestReadResult
} from '@desktop-shared/ipc-channels'
import type { ImageFeed } from '../../../stores/chat'

/**
 * 图片 canvas tab body: one image-acquisition run's progress + thumbnail grid.
 *
 * Data comes from polling the run's worklist JSON (image_prompts.json for AI
 * generation, image_queries.json for web download) through the main process —
 * the renderer can't read the local files, and CSP forbids `file:` img
 * sources, so main decodes each finished image into a small `data:` thumbnail
 * (see the IMAGE_MANIFEST_READ handler). Both runners rewrite the worklist
 * per completion, so each poll reflects live progress.
 *
 * Polling lifecycle:
 *   - Poll immediately on mount, then every POLL_MS while `generating`.
 *   - When `generating` flips false, do ONE final poll (to catch the last
 *     image landing after the command returned) and stop.
 *   - Remount (new manifestPath via `key`) or unmount clears the interval.
 */
const IMAGES_POLL_MS = 1500

// Status vocabulary spans both runners: image_gen.py writes Generated /
// Failed, image_search.py writes Sourced / Needs-Manual. Either "done"
// flavor counts as finished; either failure flavor renders red.
function isDoneStatus(s: string): boolean {
  return s === 'Generated' || s === 'Sourced'
}
function isFailStatus(s: string): boolean {
  return s === 'Failed' || s === 'Needs-Manual'
}

/**
 * True when every worklist row reached a terminal state (image landed on
 * disk, or failed for good) — generation is OVER no matter what the
 * command-level `generating` flag says. That flag lies in a known way:
 * `endedAt`/`tasks` are renderer-runtime fields that JSONL history restore
 * doesn't carry, so on a resumed session every restored launch command
 * reads as "still running" forever ("AI 生成图片中" over a grid of 5/5
 * green ticks). The manifest on disk is ground truth; it wins.
 */
function manifestDataDone(res: ImageManifestReadResult | null): boolean {
  return (
    !!res &&
    res.ok &&
    res.items.length > 0 &&
    res.items.every(
      (it) => (isDoneStatus(it.status) && it.exists) || isFailStatus(it.status)
    )
  )
}

/**
 * Tab-level "any image run still live?" signal: each feed's `generating`
 * corrected against its worklist's own data (see manifestDataDone). Runs a
 * cheap metadata-only poll (withThumbnails:false — no decode cost) for
 * feeds that CLAIM to be generating, independent of whether ImagesPanel is
 * mounted — the tab's busy dot and auto-focus must be able to clear even
 * if the user never opens the 图片 tab. A feed marked done stays done
 * (per-image retries rewrite rows back to Pending AND re-run the command,
 * which yields a fresh feed signal anyway).
 */
export function useImageFeedsLive(feeds: ImageFeed[]): boolean {
  const [dataDone, setDataDone] = useState<Record<string, boolean>>({})
  const pendingKey = feeds
    .filter((f) => f.generating && !dataDone[f.manifestPath])
    .map((f) => f.manifestPath)
    .join('\n')
  useEffect(() => {
    if (!pendingKey) return
    const paths = pendingKey.split('\n')
    let cancelled = false
    const check = async (): Promise<void> => {
      for (const p of paths) {
        try {
          const res = await window.chatApi.readImageManifest({
            manifestPath: p,
            withThumbnails: false
          })
          if (cancelled) return
          if (manifestDataDone(res)) {
            setDataDone((prev) => (prev[p] ? prev : { ...prev, [p]: true }))
          }
        } catch {
          // transient IPC failure — next tick retries
        }
      }
    }
    void check()
    const id = window.setInterval(check, 3000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [pendingKey])
  return feeds.some((f) => f.generating && !dataDone[f.manifestPath])
}

/** Per-kind copy: the 图片 tab hosts both AI painting and web fetching, and
 *  the header/labels should say which one the user is watching. */
const FEED_COPY = {
  gen: {
    running: 'AI 生成图片中',
    done: '图片已生成',
    idle: 'AI 图片',
    activeVerb: '正在画',
    empty: '等待生成…',
    painting: '正在创建图片'
  },
  search: {
    running: '获取网络图片中',
    done: '图片已获取',
    idle: '网络图片',
    activeVerb: '正在找',
    empty: '等待获取…',
    painting: '正在搜索图片'
  }
} as const

export function ImagesPanel({
  feed,
  fill = false
}: {
  feed: ImageFeed
  /** True when this panel owns the whole tab (single run): header pinned,
   *  grid scrolls inside. False when stacked with sibling runs — natural
   *  height inside the tab's shared scroll container, sticky header. */
  fill?: boolean
}): React.JSX.Element {
  const { manifestPath, generating, kind } = feed
  const copy = FEED_COPY[kind]
  const [data, setData] = useState<ImageManifestReadResult | null>(null)
  // "Witnessed" gate for the develop animation: filenames we've seen in a
  // non-finished state. An item that later flips to Generated gets the
  // polaroid develop-in (imgp-develop) exactly because we watched it happen.
  // History restore / remount starts fresh — everything arrives already
  // finished, nothing was witnessed, nothing animates (same principle as the
  // tool cards' sawRunning gate: a screenful of simultaneous develop-ins on
  // restore reads as a glitch, not a delight).
  const pendingSeenRef = useRef<Set<string>>(new Set())
  const [developSet, setDevelopSet] = useState<Set<string>>(new Set())
  // The image currently open in the in-app lightbox, or null. A snapshot of
  // the item is fine — only finished images are openable, and a finished
  // row's fields don't change on later polls.
  const [lightboxItem, setLightboxItem] = useState<ImageManifestItem | null>(null)

  useEffect(() => {
    let cancelled = false
    // Freshest data across ticks, read inside the interval WITHOUT being an
    // effect dep — the interval must keep a stable identity, so it can't be
    // keyed on `data`.
    let latest: ImageManifestReadResult | null = null
    // Once we STOP generating, keep polling a few more cycles before giving up:
    // the last image(s) land — and their thumbnails get decoded main-side — a
    // beat AFTER the command returns. Without this tail the tab freezes on a
    // pre-final snapshot until you switch tabs and back (which remounts and
    // re-polls). While generating, the window is effectively unbounded.
    const GRACE_TICKS = 4
    let graceLeft = GRACE_TICKS

    // "Settled" = every item has either a thumbnail or a terminal status, i.e.
    // nothing is still mid-generation. We can stop polling once settled.
    const isSettled = (res: ImageManifestReadResult | null): boolean =>
      !!res &&
      res.ok &&
      res.items.length > 0 &&
      res.items.every((it) => it.thumbnail !== undefined || !isDoneStatus(it.status))

    const poll = async (): Promise<void> => {
      try {
        const res = await window.chatApi.readImageManifest({
          manifestPath,
          withThumbnails: true
        })
        if (cancelled) return
        latest = res
        if (res.ok) {
          // Track witnessed pendings → develop-in on completion (see the
          // pendingSeenRef comment above).
          const fresh: string[] = []
          for (const it of res.items) {
            const finished = isDoneStatus(it.status) && it.exists
            if (!finished) pendingSeenRef.current.add(it.filename)
            else if (pendingSeenRef.current.has(it.filename)) {
              pendingSeenRef.current.delete(it.filename)
              fresh.push(it.filename)
            }
          }
          if (fresh.length > 0) {
            setDevelopSet((prev) => new Set([...prev, ...fresh]))
          }
        }
        setData(res)
      } catch {
        // Transient IPC failure — keep the last good data, next tick retries.
      }
    }

    void poll() // immediate first read so the tab isn't blank for a poll cycle

    const id = setInterval(() => {
      // Stop conditions, checked BEFORE polling again:
      //   - generation finished AND the grid is settled → done, no more polls.
      //   - generation finished but not settled → burn a grace tick, keep going
      //     (covers late-landing thumbnails after the command returned).
      // "Finished" is EITHER the command flag flipping false OR the worklist
      // itself reaching all-terminal (manifestDataDone) — the latter matters
      // when `generating` is stuck true (resumed session: runtime fields
      // gone), which would otherwise keep polling at full rate forever.
      // While genuinely live we always keep polling — every tick may reveal
      // a newly-finished image.
      if (!generating || manifestDataDone(latest)) {
        if (isSettled(latest)) {
          clearInterval(id)
          return
        }
        graceLeft -= 1
        if (graceLeft < 0) {
          clearInterval(id)
          return
        }
      }
      void poll()
    }, IMAGES_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [manifestPath, generating])

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const generated = data?.generatedCount ?? 0
  const failed = items.filter((it) => isFailStatus(it.status)).length
  // Display-level liveness: the command flag CORRECTED by the worklist's own
  // data. A resumed session's restored command claims generating forever
  // (runtime fields gone) — but a grid of all-terminal rows IS finished, and
  // the header must say so instead of "AI 生成图片中" over 5/5 green ticks.
  const live = generating && !manifestDataDone(data)
  // image_gen.py generates sequentially, so "the one being painted right now"
  // is the first still-pending item. Only meaningful while live —
  // afterwards leftover pendings are just "didn't happen", not "in progress".
  // (image_search.py --batch runs a few queries concurrently, so for the
  // search kind this is an approximation — still the most useful single
  // "currently working on" pick, since statuses write back one by one.)
  const activeIdx = live
    ? items.findIndex(
        (it) => !(isDoneStatus(it.status) && it.exists) && !isFailStatus(it.status)
      )
    : -1
  const activeItem = activeIdx >= 0 ? items[activeIdx] : null
  const allDone = !live && total > 0 && generated >= total

  return (
    <div
      className={
        fill
          ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
          : 'flex flex-col'
      }
    >
      {/* Progress header: activity beacon + current subject + count, then a
          segmented bar (one segment per image — done/failed/painting/queued)
          so progress has SHAPE, not just a percentage. Stacked mode (multiple
          runs sharing one scroll container) pins it sticky so the run's
          identity stays visible while its grid scrolls by. */}
      <div
        className={
          'flex shrink-0 flex-col gap-2 border-b border-border/60 px-4 py-3' +
          (fill ? '' : ' sticky top-0 z-10 bg-card')
        }
      >
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="relative grid size-[18px] shrink-0 place-items-center"
          >
            {live ? (
              <>
                <span className="imgp-beacon-halo absolute inset-0 rounded-full bg-accent/25" />
                <span className="imgp-beacon-core size-2 rounded-full bg-accent" />
              </>
            ) : allDone ? (
              <svg viewBox="0 0 18 18" className="size-[18px]">
                <circle cx="9" cy="9" r="9" className="fill-accent" />
                <path
                  d="M5.4 9.4l2.4 2.4 4.8-5.2"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <span className="size-2 rounded-full bg-muted-foreground/40" />
            )}
          </span>
          <span className="shrink-0 text-[13px] font-semibold text-foreground">
            {live ? copy.running : allDone ? copy.done : copy.idle}
          </span>
          {/* Current subject — "which one is it painting/fetching" beats an
              anonymous percentage for trust that things are moving. */}
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
            {activeItem && (
              <>
                {copy.activeVerb}「{activeItem.altText || activeItem.purpose || activeItem.filename}」
                <code className="ml-1.5 font-mono text-[10.5px] text-muted-foreground/60">
                  {activeItem.filename}
                </code>
              </>
            )}
          </span>
          <span className="shrink-0 tabular-nums text-[12px] text-muted-foreground">
            <span className="text-[14px] font-semibold text-foreground">{generated}</span>
            /{total}
            {failed > 0 && <span className="ml-1.5 text-red-500">{failed} 失败</span>}
          </span>
        </div>
        {/* Segmented progress: one segment per image. */}
        {total > 0 && items.length > 0 ? (
          <div className="flex h-1 gap-1" aria-hidden>
            {items.map((it, i) => {
              const done = isDoneStatus(it.status) && it.exists
              const fail = isFailStatus(it.status)
              return (
                <span
                  key={it.filename}
                  className={
                    'flex-1 rounded-full transition-colors duration-500 ' +
                    (done
                      ? 'bg-accent'
                      : fail
                        ? 'bg-red-500'
                        : i === activeIdx
                          ? 'imgp-seg-active'
                          : 'bg-foreground/[0.08]')
                  }
                />
              )
            })}
          </div>
        ) : (
          <div className="h-1 rounded-full bg-foreground/[0.08]" aria-hidden />
        )}
      </div>

      {/* Thumbnail grid */}
      <div className={fill ? 'min-h-0 flex-1 overflow-y-auto p-4' : 'p-4'}>
        {items.length === 0 ? (
          <div
            className={
              'flex items-center justify-center text-[13px] text-muted-foreground ' +
              (fill ? 'h-full' : 'py-10')
            }
          >
            {data && !data.ok ? '读取图片清单失败' : copy.empty}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3">
            {items.map((it, i) => (
              <ImageCard
                key={it.filename}
                item={it}
                paintingLabel={copy.painting}
                pendingMode={
                  i === activeIdx ? 'painting' : live ? 'queued' : 'idle'
                }
                developing={developSet.has(it.filename)}
                layoutId={`imgp:${manifestPath}:${it.filename}`}
                onOpen={() => setLightboxItem(it)}
              />
            ))}
          </div>
        )}
      </div>
      {/* In-app lightbox. Portaled to <body> so the overlay isn't clipped by
          the panel's overflow; the shared layoutId still connects across the
          portal (Motion's layout projection is global). */}
      {createPortal(
        <AnimatePresence>
          {lightboxItem && (
            <ImageLightbox
              item={lightboxItem}
              layoutId={`imgp:${manifestPath}:${lightboxItem.filename}`}
              onClose={() => setLightboxItem(null)}
            />
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}

/**
 * In-app lightbox for a finished gallery image.
 *
 * Choreography (the open feels like ONE gesture, not three animations):
 *   1. The image FLIP-flies from its card into the center via the shared
 *      `layoutId` — an interruptible spring, so a quick open-close reverses
 *      mid-flight instead of snapping.
 *   2. The backdrop fades in underneath it (plain opacity, slightly faster).
 *   3. The caption bar follows with a small rise + fade, ~0.1s behind — it
 *      belongs to the destination, so it arrives after the image does.
 *
 * Image quality is progressive: the 320px thumbnail (already in memory —
 * same URL the card uses) renders instantly and the full-resolution file
 * streams in over IPC, cross-fading on top when ready — the same "develop"
 * language the gallery cards use. The container's aspect ratio starts at
 * the card's 4:3 and relaxes to the image's true ratio the moment the
 * thumbnail reports its natural size (usually before first paint, it's
 * cached); `layoutId` projection animates that reshape smoothly. Both
 * layers use object-cover, and since the container matches the true ratio,
 * cover ≡ contain — no crop pop during the flight.
 *
 * Close: Esc, backdrop click, or the ✕ — all reverse the flight.
 */
function ImageLightbox({
  item,
  layoutId,
  onClose
}: {
  item: ImageManifestItem
  layoutId: string
  onClose: () => void
}): React.JSX.Element {
  const [full, setFull] = useState<string | null>(null)
  const [ratio, setRatio] = useState<number | null>(null)

  // Fetch the full-resolution original (original bytes over IPC).
  useEffect(() => {
    let cancelled = false
    void window.chatApi
      .readImageFile({ absPath: item.absPath })
      .then((r) => {
        if (!cancelled && r.ok && r.dataUrl) setFull(r.dataUrl)
      })
      .catch(() => {
        /* thumbnail stays — still a usable preview */
      })
    return () => {
      cancelled = true
    }
  }, [item.absPath])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const r = ratio ?? 4 / 3
  return (
    <motion.div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 p-8"
      onClick={onClose}
    >
      {/* Frosted-glass scrim, NOT a black dim: the app is a light chrome and
          a black sheet reads as a different app taking over. The heavy blur
          does the separation work (content underneath dissolves into wash);
          the theme-token tint keeps it native in both light and dark. */}
      <motion.div
        className="absolute inset-0 bg-background/60 backdrop-blur-2xl"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.2, ease: 'easeIn' } }}
        transition={{ duration: 0.28, ease: 'easeOut' }}
      />
      {/* Image stage. Width solves the contain-fit by hand (aspect-ratio
          alone loses to max-height and would re-crop): height = width / r,
          capped by all three of 1100px / 88vw / 78vh. */}
      <motion.div
        layoutId={layoutId}
        onClick={(e) => e.stopPropagation()}
        className="relative overflow-hidden rounded-xl bg-card shadow-2xl"
        style={{
          width: `min(1100px, 88vw, calc(78vh * ${r}))`,
          aspectRatio: r
        }}
        transition={{ type: 'spring', bounce: 0.18, visualDuration: 0.38 }}
      >
        <img
          src={item.thumbnail}
          alt={item.altText || item.filename}
          onLoad={(e) => {
            const el = e.currentTarget
            if (el.naturalWidth > 0 && el.naturalHeight > 0) {
              setRatio(el.naturalWidth / el.naturalHeight)
            }
          }}
          className="absolute inset-0 h-full w-full object-cover"
        />
        {full && (
          <motion.img
            src={full}
            alt=""
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
      </motion.div>
      {/* Caption bar: arrives a beat after the image, leaves instantly. */}
      <motion.div
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', bounce: 0.2, visualDuration: 0.35, delay: 0.1 }}
        className="relative z-10 flex max-w-[88vw] items-center gap-3 rounded-full border border-border/60 bg-card/90 py-1.5 pl-4 pr-1.5 shadow-md backdrop-blur-md"
      >
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-foreground">
            {item.altText || item.purpose || item.filename}
          </span>
          {(item.altText || item.purpose) && (
            <code className="truncate font-mono text-[10px] text-muted-foreground/70">
              {item.filename}
            </code>
          )}
        </span>
        <button
          type="button"
          // data-slot：lightbox portal 到 body、脱离 .chat-app 豁免子树，
          // 防 canvas 裸 button reset 泄漏（描边卡片化）。下方关闭钮同理。
          data-slot="modal-action"
          onClick={() => void window.chatApi.openPath({ absPath: item.absPath })}
          className="inline-flex h-7 shrink-0 items-center rounded-full bg-muted px-3 text-[11.5px] font-medium text-foreground transition-colors hover:bg-border/70"
        >
          用系统查看器打开
        </button>
      </motion.div>
      {/* Close button, top-right. */}
      <motion.button
        type="button"
        data-slot="modal-action"
        aria-label="关闭"
        onClick={onClose}
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.12 } }}
        transition={{ type: 'spring', bounce: 0.3, visualDuration: 0.3, delay: 0.12 }}
        className="absolute right-5 top-5 z-10 grid size-9 place-items-center rounded-full border border-border/60 bg-card/90 text-foreground shadow-md backdrop-blur-md transition-colors hover:bg-muted"
      >
        <svg viewBox="0 0 14 14" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M2 2l10 10M12 2L2 12" />
        </svg>
      </motion.button>
    </motion.div>
  )
}

/**
 * One image cell in the 图片 grid: thumbnail (or a status-appropriate
 * placeholder) + filename + status badge. Clicking an already-generated image
 * opens the full-res original in the OS default viewer via SHELL_OPEN_PATH —
 * we only ever render the small thumbnail in-app.
 */
/**
 * DotGridLoader
 * -------------
 * The "generating…" placeholder for an image cell: an Apple-Intelligence-style
 * dot grid that breathes. A regular lattice of dots fills the cell; each dot's
 * radius/alpha is a Gaussian falloff from the cell centre (bright core, faint
 * edges) modulated by a slow ripple that radiates outward from the centre, so
 * the whole field pulses like it's "thinking".
 *
 * Rendered on a canvas (dozens of dots redrawn per frame is cheap and gives a
 * smooth continuous falloff a DOM grid can't). The canvas is sized to its
 * container via ResizeObserver + devicePixelRatio so dots stay crisp on retina.
 * Respects prefers-reduced-motion: a single static frame, no rAF loop.
 */
const DOT_GAP = 11 // px between dot centres (CSS px)
const DOT_MAX_R = 1.9 // px radius at the brightest core

function DotGridLoader({
  label = '正在创建图片'
}: {
  /** Cell caption — 「正在创建图片」 for AI generation, 「正在搜索图片」 for
   *  web download (same breathing dot field either way). */
  label?: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const reduce = useReducedMotion()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let start = 0
    let cssW = 0
    let cssH = 0

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect()
      cssW = rect.width
      cssH = rect.height
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.round(cssW * dpr))
      canvas.height = Math.max(1, Math.round(cssH * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    // Draw one frame at time `t` (ms since start). The dot field is centred;
    // brightness = Gaussian(distance) * (0.55 + 0.45*ripple), where ripple is a
    // travelling sine wave keyed to distance so it visibly moves outward.
    const draw = (t: number): void => {
      if (cssW === 0 || cssH === 0) return
      ctx.clearRect(0, 0, cssW, cssH)
      const cx = cssW / 2
      const cy = cssH / 2
      // Falloff radius: reach ~60% of the half-diagonal so the core is tight
      // and the edges fade fully, matching the reference's concentrated cloud.
      const sigma = Math.hypot(cssW, cssH) * 0.28
      const cols = Math.ceil(cssW / DOT_GAP) + 1
      const rows = Math.ceil(cssH / DOT_GAP) + 1
      // Centre the lattice so the brightest dot sits dead-centre.
      const offX = (cssW - (cols - 1) * DOT_GAP) / 2
      const offY = (cssH - (rows - 1) * DOT_GAP) / 2
      const phase = (t / 1000) * 1.6 // ripple angular speed

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = offX + c * DOT_GAP
          const y = offY + r * DOT_GAP
          const dist = Math.hypot(x - cx, y - cy)
          // Gaussian core → 0 at the edges.
          const g = Math.exp(-(dist * dist) / (2 * sigma * sigma))
          if (g < 0.02) continue
          // Ripple travels outward: subtract phase so crests move away from
          // centre over time. Reduced-motion → constant (no travel).
          const ripple = reduce ? 0.75 : 0.55 + 0.45 * Math.sin(dist / 26 - phase)
          const alpha = Math.min(1, g * ripple) * 0.5
          const radius = DOT_MAX_R * g * (reduce ? 1 : 0.7 + 0.3 * ripple)
          if (alpha < 0.015 || radius < 0.15) continue
          ctx.beginPath()
          ctx.arc(x, y, radius, 0, Math.PI * 2)
          // Neutral grey dots — matches the reference's monochrome field and
          // reads on both light and dark cell backgrounds.
          ctx.fillStyle = `rgba(120, 120, 128, ${alpha})`
          ctx.fill()
        }
      }
    }

    const loop = (now: number): void => {
      if (!start) start = now
      draw(now - start)
      raf = requestAnimationFrame(loop)
    }

    resize()
    const ro = new ResizeObserver(() => {
      resize()
      if (reduce) draw(0)
    })
    ro.observe(canvas)

    if (reduce) {
      draw(0)
    } else {
      raf = requestAnimationFrame(loop)
    }

    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [reduce])

  return (
    <div className="absolute inset-0 flex flex-col">
      <span className="px-3 pt-2.5 text-[12px] font-medium text-muted-foreground/80">
        {label}
      </span>
      <canvas ref={canvasRef} className="min-h-0 w-full flex-1" aria-hidden />
    </div>
  )
}

function ImageCard({
  item,
  pendingMode,
  developing,
  paintingLabel,
  layoutId,
  onOpen
}: {
  item: ImageManifestItem
  /** How a not-yet-finished cell presents: 'painting' = the one the
   *  sequential generator is on right now (dot-grid loader), 'queued' =
   *  behind it in line, 'idle' = the run ended without producing it. */
  pendingMode: 'painting' | 'queued' | 'idle'
  /** True once we've WATCHED this item finish (ImagesPanel's pendingSeen
   *  gate) — plays the polaroid develop-in + badge pop exactly once. */
  developing: boolean
  /** DotGridLoader caption for the in-progress cell (per feed kind). */
  paintingLabel: string
  /** Shared-element id linking this thumbnail to the lightbox's image —
   *  the open/close transition is a FLIP flight between the two. */
  layoutId: string
  /** Open the in-app lightbox for this (finished) image. */
  onOpen: () => void
}): React.JSX.Element {
  const done = isDoneStatus(item.status) && item.exists
  const failed = isFailStatus(item.status)
  const pending = !done && !failed
  // Chinese description leads, filename supports — regular users read
  // 「青花瓷」, not `porcelain_blue.png`. Fall back to the filename as the
  // title when the manifest carries no description (then skip the sub-line
  // so the same string doesn't render twice).
  const title = item.altText || item.purpose
  const openFull = (): void => {
    if (done) onOpen()
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* Photo paper: white mat + floating shadow, lifts on hover. Same
          paper-on-stage metaphor as the slides / files canvases. */}
      <button
        type="button"
        onClick={openFull}
        disabled={!done}
        title={done ? `查看大图：${item.filename}` : item.altText || item.filename}
        className={
          'group relative rounded-[10px] bg-card p-[5px] text-left transition-all duration-200 ' +
          (done
            ? 'cursor-zoom-in shadow-sm hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 active:scale-[0.985]'
            : 'cursor-default shadow-sm')
        }
      >
        <div
          className={
            'relative aspect-[4/3] overflow-hidden rounded-md ' +
            (failed
              ? 'bg-red-500/10'
              : pending && pendingMode !== 'painting'
                ? 'border border-dashed border-border'
                : 'bg-foreground/[0.03]')
          }
        >
          {item.thumbnail ? (
            // Shared element: the lightbox opens by FLIP-flying this exact
            // image out of the card (same layoutId there). Spring matches
            // the lightbox's so both directions feel like one gesture.
            // The hover zoom lives on a WRAPPER div — Motion's layout
            // projection owns the img's inline transform, so a CSS
            // group-hover scale on the img itself would fight it.
            <div
              className={
                'h-full w-full transition-transform duration-300' +
                (done ? ' group-hover:scale-[1.035]' : '')
              }
            >
              <motion.img
                layoutId={layoutId}
                transition={{ type: 'spring', bounce: 0.18, visualDuration: 0.38 }}
                src={item.thumbnail}
                alt={item.altText || item.filename}
                className={
                  'h-full w-full object-cover ' +
                  (developing ? 'imgp-develop' : '')
                }
              />
            </div>
          ) : failed ? (
            <div
              className="flex h-full w-full items-center justify-center px-2 text-center"
              title={item.lastError}
            >
              <span className="text-[11.5px] font-medium text-red-500">
                {item.status === 'Needs-Manual' ? '需手动获取' : '生成失败'}
              </span>
            </div>
          ) : pendingMode === 'painting' ? (
            // Painting right now: Apple-Intelligence dot-grid loader breathes
            // until the real thumbnail lands (next poll swaps in the <img>).
            <DotGridLoader label={paintingLabel} />
          ) : (
            <div className="grid h-full w-full place-items-center">
              <span className="text-[11px] text-muted-foreground/70">
                {pendingMode === 'queued' ? '排队中' : '未生成'}
              </span>
            </div>
          )}
          {/* Status corner badge: check / exclamation on a solid disc. Pops
              in only when witnessed live (same gate as the develop). */}
          {(done || failed) && (
            <span
              aria-hidden
              className={
                'absolute right-1.5 top-1.5 grid size-[18px] place-items-center rounded-full ' +
                (done ? 'bg-accent ' : 'bg-red-500 ') +
                (developing ? 'imgp-badge-in' : '')
              }
            >
              <svg
                viewBox="0 0 12 12"
                className="size-[10px]"
                fill="none"
                stroke="#fff"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {done ? (
                  <path d="M2.5 6.4l2.4 2.4 4.6-5" />
                ) : (
                  <path d="M6 2.6v4.2M6 9.4v.1" />
                )}
              </svg>
            </span>
          )}
          {/* Hover affordance on finished shots: bottom gradient + action
              pill. Click opens the in-app lightbox — this just makes that
              discoverable. */}
          {done && (
            <div className="pointer-events-none absolute inset-0 flex items-end bg-gradient-to-t from-black/45 via-black/0 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
              <span className="inline-flex h-[22px] items-center rounded-full bg-white/90 px-2.5 text-[10.5px] font-medium text-zinc-900 shadow-sm">
                查看大图
              </span>
            </div>
          )}
        </div>
      </button>
      {/* Caption: description leads, filename supports. */}
      <div className="flex min-w-0 flex-col px-0.5">
        <span
          className={
            'truncate text-[12px] ' +
            (done ? 'font-medium text-foreground/90' : 'text-muted-foreground')
          }
          title={title || item.filename}
        >
          {title || item.filename}
        </span>
        {title && (
          <code
            className="truncate font-mono text-[10px] text-muted-foreground/70"
            title={item.filename}
          >
            {item.filename}
          </code>
        )}
      </div>
    </div>
  )
}
