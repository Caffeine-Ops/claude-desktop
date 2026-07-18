import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ReplayConfirmSnapshot } from '@desktop-shared/replayTypes'
import { railEaseOut, railGliderSpring } from '../../shell/railMotion'
import {
  type Catalogs,
  type CatalogOption,
  type ConfirmState,
  type Lang,
  type Recommendations,
  type Typography,
  PALETTE_ROLES,
  defaultBodySizeForCanvas,
  deliveryBodyPx,
  detectLang,
  flattenCatalog,
  groupLabel,
  imageStrategyCandidates,
  imageStrategySelectedIndex,
  isGrouped,
  isPptCanvas,
  hexOr,
  localized,
  makeT,
  mergeConfirmedAnchors,
  needsGeneratedImagesForUsage,
  normPalette,
  normTypography,
  normalizeTypographyForSubmit,
  optionDesc,
  optionLabel,
  previewFontStack,
  recId,
  recOrFirst,
  typographyBodySize,
  usesCustomImagePlanValue
} from './canvasConfirm.helpers'
import {
  registerConfirmDemoHandle,
  unregisterConfirmDemoHandle,
  type ConfirmDemoHandle
} from '../../replay/confirmDemoRegistry'

/**
 * CanvasConfirm
 * -------------
 * Native React replication of the ppt-master confirm_ui Eight-Confirmations
 * page (originally skills/ppt-master/scripts/confirm_ui/static/app.js, now
 * deleted along with the Flask server it ran on), rendered inside the
 * 「问题」canvas tab. There is no HTTP server on this path anymore: the data
 * contract is `<projectDir>/confirm_ui/{recommendations,result,catalogs}.json`
 * on disk, read via the CONFIRM_UI_READ IPC and written via
 * CONFIRM_UI_WRITE_RESULT (see electron/main/ipc/register.ts). The skill-side
 * synchronization point is `scripts/confirm_ui/confirm_wait.py`, a pure
 * stdlib script that blocks on the Bash tool call until the stage it's
 * watching shows up in result.json — it does not care who wrote that file,
 * so this component's IPC write and the old Flask server's HTTP write are
 * interchangeable from confirm_wait.py's point of view. Same reasoning as
 * always: it just paints the data natively.
 *
 * `projectDir` is the ppt-master project's absolute directory, resolved by
 * usePreviewServer from the confirm_wait.py command's own argument — never
 * guessed at a URL/port (there is none to guess anymore).
 *
 * STAGE ONE scope: every field is rendered and answerable, the tier1→tier2
 * polling state machine works, and the submit contract is byte-for-byte
 * app.js. Rich interactions deferred to stage two are marked `STAGE TWO:`
 *   - HEX per-role override grid with dual-target live swatch repaint
 *   - per-role size override grid with the fill-once-no-cascade ramp
 *   - the sticky combined StylePreview strip
 *   - body-size hint recompute
 * Color swatches and basic CJK/Latin font-family previews ARE rendered here.
 */

type Stage = 1 | 2 | 'all'

/** Deep clone via JSON — matches app.js `JSON.parse(JSON.stringify(STATE))`. */
/* ───────────────── motion ─────────────────
 *
 * 动效 token 一律复用 shell/railMotion 的两条（railEaseOut 入场 /
 * railGliderSpring 位移），不自立一套：全 app 的节奏统一比这一页「有自己
 * 的手感」重要得多，先例是 WorkflowAgentsView 同样借用了 rail 的 spring。
 *
 * 分工沿用 railMotion 头注释定的规矩：
 *  - **入场 = ease-out，不回弹**。「只做『出现』不做戏」——确认页是一屏
 *    需要**读**的决策项，卡片弹跳会把注意力从内容上拽走。
 *  - **位移/增删 = spring**。会被打断的动画（用户连点改选项时 chip 增删）
 *    必须能从当前位置和速度重新求解，ease 曲线被打断会从头重放，肉眼可见
 *    地「顿一下再走」。
 *
 * reduced-motion 不在这里处理：App.tsx 的 <MotionConfig reducedMotion="user">
 * 已对整个 renderer 生效，会自动把下面的 y/scale 降级、只留 opacity。
 */

/**
 * 卡片入场：淡入 + 上移 8px。8 是「看得出方向」与「不晃眼」的折中。
 *
 * 写 `transform: translateY()` 而不是独立的 `y: 8`：两者视觉等价，但只有
 * 整条 transform 字符串能走 WAAPI（合成器线程），独立 transform 会退回主
 * 线程 rAF。这里差别是实打实的——卡片入场恰好撞上主线程正在建这 7 张卡的
 * DOM，掉帧就掉在这一拍上（同族教训：骨架屏 JS 淡入撞主线程阻塞，峰值透明
 * 度只有 0.27）。两端都必须是完整 transform 值，不能一端写 none。
 */
const SECTION_VARIANTS = {
  hidden: { opacity: 0, transform: 'translateY(8px)' },
  show: {
    opacity: 1,
    transform: 'translateY(0px)',
    transition: { duration: 0.32, ease: railEaseOut }
  }
} as const

/**
 * 卡片容器：staggerChildren 0.045s —— 7 张卡片总共 ~0.3s 铺完，读起来是
 * 「依次落位」而不是「排队等待」。再大就拖沓（末卡要等半秒），再小就糊成
 * 一次性闪现、白做。
 */
const SECTIONS_CONTAINER = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045 } }
} as const

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

/** Pull `_meta.static_dir` out of the raw catalogs.json snapshot
 *  confirm_wait.py's `--fresh` step writes (see that script's
 *  `_prepare_fresh`) — the absolute path VisualStyleField/CanvasField read
 *  their preview JPEGs from via `useLocalPreviewImage`. Kept loose
 *  (`Record<string, unknown>`, not the `Catalogs` type) because `Catalogs`'s
 *  index signature is `CatalogOption[]` — `_meta` is a desktop-only addition
 *  the catalog schema itself doesn't know about. */
function extractStaticDir(catalogs: Record<string, unknown>): string | undefined {
  const meta = catalogs._meta
  if (!meta || typeof meta !== 'object') return undefined
  const dir = (meta as Record<string, unknown>).static_dir
  return typeof dir === 'string' ? dir : undefined
}

/**
 * Module-level cache: absolute image path → resolved data URL (`null` if the
 * IPC read failed). Survives component remounts within the renderer session
 * — a language toggle or tier1→tier2 transition re-renders StyleCard/
 * CanvasCard, but the same handful of style-previews/canvas-previews JPEGs
 * shouldn't be re-read from disk every time.
 */
const previewImageCache = new Map<string, string | null>()

/**
 * Read a local preview image (style-previews/<id>.jpg, canvas-previews/<id>.jpg)
 * via the existing IMAGE_FILE_READ IPC and return its data URL — replaces the
 * old `<img src="{baseUrl}/static/style-previews/{id}.jpg">` cross-origin
 * fetch now that there's no Flask server to serve `/static/*` from.
 * Undefined while loading OR on failure — StyleCard/CanvasCard already
 * degrade `src === undefined`-ish states to a labeled placeholder, so the two
 * cases don't need to be distinguished here (a fast local disk read makes the
 * "loading" flash imperceptible in practice).
 */
function useLocalPreviewImage(absPath: string | undefined): string | undefined {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!absPath || previewImageCache.has(absPath)) return
    let cancelled = false
    void window.chatApi.readImageFile({ absPath }).then((res) => {
      if (cancelled) return
      previewImageCache.set(absPath, res.ok && res.dataUrl ? res.dataUrl : null)
      bump((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [absPath])
  if (!absPath) return undefined
  return previewImageCache.get(absPath) ?? undefined
}

/**
 * Desktop-only wizard copy. Deliberately NOT in canvasConfirm.helpers'
 * MESSAGES — that dict is a 1:1 mirror of app.js and must stay re-portable;
 * the two-step stepper / deriving screen / rich button labels exist only in
 * this native rendering, so their strings live here.
 */
const UI_MESSAGES: Record<Lang, Record<string, string>> = {
  en: {
    step1_name: 'Anchors',
    step1_sub: 'Canvas · Audience · Style',
    step2_name: 'Realization',
    step2_sub: 'Color · Type · Images',
    deriving_title: 'Deriving realization options…',
    btn_next_rich: 'Next · Realization',
    btn_confirm_rich: 'Confirm & generate',
    note_canvas: 'Sets composition & density; cannot change later',
    note_audience: 'Drives narration tone and content depth',
    note_color: 'Six role colors swap together, staying harmonious',
    note_type: 'Heading & body picked as a pair — live samples',
    note_images: 'Where illustrations come from & how they look'
  },
  zh: {
    step1_name: '锚点确认',
    step1_sub: '画布 · 受众 · 风格',
    step2_name: '实现确认',
    step2_sub: '配色 · 字体 · 图片',
    deriving_title: '正在派生实现层建议…',
    btn_next_rich: '下一步 · 实现确认',
    btn_confirm_rich: '确认，开始生成',
    note_canvas: '决定构图与信息密度，之后不可换',
    note_audience: 'AI 依此决定叙述口吻与内容深度',
    note_color: '六个角色色一起换，保证整套和谐',
    note_type: '标题与正文成对确定，字样为实时预览',
    note_images: '决定插图从哪来、长什么样'
  }
}

export function CanvasConfirm({
  projectDir,
  replaySnapshots
}: {
  /** ppt-master project's absolute directory — the key CONFIRM_UI_READ /
   *  CONFIRM_UI_WRITE_RESULT read/write `confirm_ui/*.json` under. */
  projectDir: string
  /**
   * 回放态：manifest.meta.confirmSnapshots（该会话录制时命中的 tier1/final
   * 快照，按命中顺序排列，通常 0~2 条）。传入即视为回放模式——组件不走 IPC
   * 读盘（回放没有真实项目目录），改为等 confirmDemoHandle.open 用
   * toolUseId 取快照做离线初始化；projectDir 此时只是个占位 key（仍传因为
   * 上层 SlidesWorkspace 用它做 React key，见该文件 hasConfirm 分支）。
   */
  replaySnapshots?: ReplayConfirmSnapshot[]
}): React.JSX.Element {
  const isReplay = replaySnapshots !== undefined
  const [lang, setLang] = useState<Lang>(detectLang)
  const t = useMemo(() => makeT(lang), [lang])
  const uiT = useCallback(
    (key: string): string => (UI_MESSAGES[lang] || UI_MESSAGES.en)[key] ?? key,
    [lang]
  )

  const [cat, setCat] = useState<Catalogs | null>(null)
  const [rec, setRec] = useState<Recommendations | null>(null)
  const [stage, setStage] = useState<Stage>(1)
  const [state, setState] = useState<ConfirmState>({})
  const [phase, setPhase] = useState<'loading' | 'ready' | 'deriving' | 'confirmed' | 'error'>(
    'loading'
  )
  const [statusText, setStatusText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // Absolute dir the style-previews/canvas-previews JPEGs live under (from
  // catalogs.json's `_meta.static_dir`, written by confirm_wait.py's --fresh
  // step). Undefined until boot resolves it; VisualStyleField/CanvasField
  // degrade to placeholder cards while it's unset (same as a load failure).
  const [previewsDir, setPreviewsDir] = useState<string | undefined>(undefined)
  // Cancels an in-flight tier2 poll loop when the component unmounts.
  const pollAlive = useRef(true)
  // The scrollable sections container — reset to the top when the page first
  // becomes ready and on each stage change, so the confirm page always opens at
  // the top instead of wherever a prior scroll left it.
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // patch helper — STATE is mutated wholesale in app.js; here we merge.
  const patch = useCallback((p: Partial<ConfirmState>) => {
    setState((s) => ({ ...s, ...p }))
  }, [])

  // ── state seeding (mirror of initTier1State / initTier2State) ────────────
  const seedTier1 = useCallback(
    (c: Catalogs, r: Recommendations): Partial<ConfirmState> => ({
      canvas: recOrFirst(r, 'canvas', c.canvas),
      audience: (r.audience && r.audience.value) || '',
      content_divergence: (r.content_divergence && r.content_divergence.value) || '',
      mode: recOrFirst(r, 'mode', c.modes),
      visual_style: recOrFirst(r, 'visual_style', c.visual_styles),
      delivery_purpose: recId(r, 'delivery_purpose') || 'balanced'
    }),
    []
  )

  const seedTier2 = useCallback(
    (c: Catalogs, r: Recommendations, prev: ConfirmState, langArg: Lang): Partial<ConfirmState> => {
      const cc = (r.color && r.color.candidates) || []
      const csel = (r.color && r.color.selected) || 0
      const cIdx = Math.min(csel, Math.max(cc.length - 1, 0))
      const c0 = cc[cIdx] || {}

      const tc = (r.typography && r.typography.candidates) || []
      const tsel = (r.typography && r.typography.selected) || 0
      const tIdx = Math.min(tsel, Math.max(tc.length - 1, 0))
      const t0 = normTypography(tc[tIdx] || {})

      // Candidate `name` is usually null (only name_zh/name_en exist), so the
      // localized display name is the stable selection key — seed it here to
      // match what the cards store/compare on, or the recommended card won't
      // start highlighted. langArg is passed in (not a closure dep) so a
      // language toggle doesn't re-seed and wipe the user's picks.
      const colorName = localized(c0, 'name', langArg) || t('option_prefix') + ' ' + (cIdx + 1)
      const typoName = localized(tc[tIdx] || {}, 'name', langArg) || t('option_prefix') + ' ' + (tIdx + 1)

      const typography: Typography = {
        name: typoName,
        heading: t0.heading || {},
        body: t0.body || {},
        body_size: t0.body_size || typographyBodySize(r.typography),
        sizes: Object.assign({}, t0.sizes || {})
      }
      const canvas = prev.canvas
      const delivery_purpose = prev.delivery_purpose
      if (typography && !typography.body_size) {
        typography.body_size = defaultBodySizeForCanvas(c, canvas, delivery_purpose)
      }

      return {
        page_count:
          r.page_count && r.page_count.value != null
            ? String(r.page_count.value)
            : prev.page_count || '',
        color: { name: colorName, palette: Object.assign({}, normPalette(c0)) },
        icons: recOrFirst(r, 'icons', c.icons),
        typography,
        formula_policy: recOrFirst(r, 'formula_policy', c.formula_policy),
        image_usage: recOrFirst(r, 'image_usage', c.image_usage),
        image_ai_path: recOrFirst(r, 'image_ai_path', c.image_ai_path),
        generation_mode: recOrFirst(r, 'generation_mode', c.generation_mode),
        refine_spec: !!((r.refine_spec && r.refine_spec.value) || (r.recommend && r.recommend.refine_spec))
      }
    },
    []
  )

  // applyBoot: 从 catalogs+recommendations 落地 cat/rec/state/stage/phase，
  // 与数据来源无关（fetch 结果或回放快照都调它）——live boot 与 replay
  // open() 共用同一段 seed 逻辑，避免两条路径的初始化语义漂移。
  const applyBoot = useCallback(
    (c: Catalogs, r: Recommendations) => {
      // recommendations.json may pin a language; honor it only if the user
      // hasn't explicitly chosen one (no localStorage), matching app.js.
      let effLang: Lang = lang
      if (r.lang === 'zh' || r.lang === 'en') {
        let hasStored = false
        try {
          hasStored = !!window.localStorage.getItem('ppt_lang')
        } catch {
          /* ignore */
        }
        if (!hasStored) {
          effLang = r.lang
          setLang(r.lang)
        }
      }
      setCat(c)
      setRec(r)
      const tier1 = seedTier1(c, r)
      const tier2 = seedTier2(c, r, tier1 as ConfirmState, effLang)
      setState({ ...tier1, ...tier2 })
      setStage(r.tier === 1 ? 1 : r.tier === 2 ? 2 : 'all')
      setPhase('ready')
      if (r._already_confirmed) setStatusText(t('already_confirmed'))
    },
    [lang, seedTier1, seedTier2, t]
  )

  // ── boot: read confirm_ui/ files over IPC (with startup retry) ───────────
  // usePreviewServer lights this tab the instant confirm_wait.py's COMMAND
  // TEXT appears in the transcript — which is before the (blocking) tool call
  // has actually run, let alone finished its `--fresh` preprocessing that
  // writes catalogs.json. So the very first read can find recommendations.json
  // present but catalogs.json still missing. A single attempt would then
  // strand the tab in an error state forever, even though the file lands a
  // moment later. So we retry on "not ready" with a fixed backoff before
  // giving up — same budget the old fetch-based version used for a Flask
  // cold start, generous enough to cover this analogous race too.
  useEffect(() => {
    // 回放态：没有真实项目目录可读——离线初始化改由下面注册的
    // confirmDemoHandle.open() 驱动，在 ReplayController 决定表演开始的
    // 那一刻才发生（不是 mount 就抢跑，早于 chat 轨切到「问题」tab 会很怪）。
    if (isReplay) return
    pollAlive.current = true
    let cancelled = false
    const MAX_ATTEMPTS = 20 // ~16s at 800ms
    const RETRY_MS = 800

    const tryBoot = async (): Promise<boolean> => {
      const readRes = await window.chatApi.readConfirmUi({ projectDir })
      if (!readRes.ok) throw new Error(readRes.error || 'read failed')
      // recommendations.json is the hard dependency (Strategist writes it
      // before confirm_wait.py would even start waiting); catalogs.json only
      // exists once confirm_wait.py's --fresh step has run. Either missing
      // means "not ready yet" → caller retries.
      if (!readRes.recommendations || !readRes.catalogs) throw new Error('not ready')
      const previewsDirValue = extractStaticDir(readRes.catalogs)
      if (previewsDirValue) setPreviewsDir(previewsDirValue)
      let rec = { ...readRes.recommendations } as Recommendations
      // Mirrors the old confirm_ui Flask server's GET /api/recommendations:
      // mark whether a result already exists (re-open after confirm), and
      // fold Tier-1 anchors into a Tier-2 payload so a remount re-initializes
      // them from the user's actual choices instead of catalog defaults.
      if (readRes.result) {
        rec._already_confirmed = true
        if (rec.tier === 2) {
          rec = mergeConfirmedAnchors(rec, readRes.result)
        } else if ((readRes.result as { stage?: unknown }).stage === 'tier1') {
          // Tier 1 was confirmed (result.json says so) but recommendations.json
          // is STILL tier 1 — the AI hasn't overwritten it with Tier 2 yet
          // (mid re-derive, SKILL.md step 3). A boot landing exactly here (this
          // component remounting mid-derive — HMR, or the user tabbing away
          // and back) must NOT re-show the tier-1 form as if it's still
          // awaiting an answer: that reads as "confirm this again?" for a
          // choice the user already made and the AI is actively acting on.
          // Show the same waiting state a live UI-driven submit shows
          // (phase 'deriving') and poll the same way, so the panel flips to
          // Tier 2 on its own the instant recommendations.json catches up —
          // matching the "有问题才出现，回复完了没用的时候不显示" ask: nothing
          // actionable is shown while there's genuinely nothing to act on.
          const catalogs = readRes.catalogs as unknown as Catalogs
          if (cancelled) return true
          applyBoot(catalogs, rec)
          setPhase('deriving')
          pollForTier2(catalogs)
          return true
        }
      }
      if (cancelled) return true
      applyBoot(readRes.catalogs as unknown as Catalogs, rec)
      return true
    }

    ;(async () => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        if (cancelled) return
        try {
          await tryBoot()
          return
        } catch {
          // not up yet (or a transient error) — wait and retry unless this was
          // the last attempt.
          if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise((res) => setTimeout(res, RETRY_MS))
          }
        }
      }
      if (!cancelled) setPhase('error')
    })()

    return () => {
      cancelled = true
      pollAlive.current = false
    }
    // projectDir changing means a different project → re-boot. lang/t
    // excluded on purpose: a language toggle must not re-read or reset
    // selections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir, isReplay])

  // ── 回放态：注册命令式 handle，供 ReplayController 驱动 ──────────────────
  useEffect(() => {
    if (!replaySnapshots) return
    const byToolUseId = new Map(replaySnapshots.map((s) => [s.toolUseId, s]))
    const handle: ConfirmDemoHandle = {
      open(toolUseId) {
        const snap = byToolUseId.get(toolUseId)
        if (!snap) return false
        // catalogs 缺失（server.py 读取失败的 best-effort 落空）没法摆出
        // 选项列表——放弃这段表演，比渲染一个空壳页面更诚实。
        if (!snap.catalogs) return false
        const c = snap.catalogs as Catalogs
        // recommendations 缺失时退化成「只有 result 决定的选中态，没有推荐
        // 星标/候选」——仍然可以摆出选中态表演，用 result 兜底一个最小
        // Recommendations 形状（tier 从 stage 推、其余字段留空）。
        const r = (snap.recommendations as Recommendations | null) ?? {
          tier: snap.stage === 'tier1' ? 1 : 2
        }
        applyBoot(c, r)
        return true
      },
      selectField(field, value) {
        patch({ [field]: value } as Partial<ConfirmState>)
      },
      typeField(field, text) {
        patch({ [field]: text } as Partial<ConfirmState>)
      },
      advanceTier2() {
        setPhase('deriving')
        // 短暂展示 deriving 骨架屏后切到 tier2——tier2 的数据在下一次
        // open(toolUseId) 里才会到（对应 final 快照），这里只做视觉过渡。
        setTimeout(() => setPhase('ready'), 900)
      },
      submitFinal() {
        setPhase('confirmed')
      }
    }
    registerConfirmDemoHandle(handle)
    return () => unregisterConfirmDemoHandle(handle)
    // replaySnapshots 是每次渲染新数组？不——上层 SlidesWorkspace 从
    // manifest.meta.confirmSnapshots 直接传（同一个引用），不会每帧重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReplay, replaySnapshots, applyBoot, patch])

  // Reset the scroll position to the top whenever the page becomes ready or the
  // stage advances (tier1 → tier2). Without this the container keeps whatever
  // scroll offset a previous render left, so the confirm page can open already
  // scrolled halfway down (its header/first cards cut off).
  useEffect(() => {
    if (phase === 'ready' && scrollRef.current) scrollRef.current.scrollTop = 0
  }, [phase, stage])

  // ── tier-1 submit → deriving → poll for tier-2 ───────────────────────────
  // The poll doesn't need mergeConfirmedAnchors (unlike boot): the anchor
  // fields it would fold in (canvas/mode/visual_style/delivery_purpose) are
  // only ever rendered while `showAnchors` (stage 1) is true, and this
  // transition sets stage to 2 — those fields simply stop being displayed,
  // their already-confirmed values living on undisturbed in local `state`.
  // The merge only earns its keep on a boot/remount, where `state` doesn't
  // persist and has to be reconstructed from disk.
  // `catalogs` is an explicit param, not the `cat` state, so this can also be
  // kicked off from the boot path (see tryBoot below) BEFORE `cat` state has
  // landed from that same boot — closing over `cat` there would poll against
  // a stale null and crash seedTier2 once tier 2 actually shows up.
  const pollForTier2 = useCallback(
    (catalogs: Catalogs) => {
      const tick = (): void => {
        if (!pollAlive.current) return
        window.chatApi
          .readConfirmUi({ projectDir })
          .then((res) => {
            if (!pollAlive.current) return
            const data = res.ok ? (res.recommendations as Recommendations | null) : null
            if (data && data.tier === 2) {
              // enterTier2: re-read realization fields, preserve tier-1 STATE.
              setRec(data)
              setState((prev) => ({ ...prev, ...seedTier2(catalogs, data, prev, lang) }))
              setStage(2)
              setPhase('ready')
              setStatusText('')
            } else {
              setTimeout(tick, 1200)
            }
          })
          .catch(() => {
            if (pollAlive.current) setTimeout(tick, 1500)
          })
      }
      tick()
    },
    [projectDir, seedTier2, lang]
  )

  const submitTier1 = useCallback(() => {
    if (!cat) return
    const payload: Record<string, unknown> = {
      stage: 'tier1',
      canvas: state.canvas,
      audience: state.audience,
      content_divergence: state.content_divergence,
      mode: state.mode,
      visual_style: state.visual_style
    }
    // delivery_purpose is PPT-only — never write it as an anchor on non-PPT.
    if (isPptCanvas(cat, state.canvas)) payload.delivery_purpose = state.delivery_purpose
    setSubmitting(true)
    window.chatApi
      .writeConfirmUiResult({ projectDir, payload })
      .then((res) => {
        if (!res.ok) throw new Error(res.error || 'tier1 write failed')
        setPhase('deriving')
        setSubmitting(false)
        pollForTier2(cat)
      })
      .catch(() => {
        setSubmitting(false)
        setStatusText(t('error_retry'))
      })
  }, [projectDir, cat, state, pollForTier2, t])

  const submitFinal = useCallback(() => {
    if (!cat) return
    const payload = clone(state) as Record<string, any>
    normalizeTypographyForSubmit(cat, payload)
    payload.stage = 'final'
    const customImagePlan = usesCustomImagePlanValue(cat, payload.image_usage)
    if (
      payload.image_usage === 'custom' ||
      (customImagePlan && !String(payload.image_usage).trim())
    ) {
      setStatusText(t('image_usage_custom_required'))
      return
    }
    if (customImagePlan) payload.image_usage = String(payload.image_usage).trim()
    if (!needsGeneratedImagesForUsage(cat, rec, payload.image_usage)) {
      delete payload.image_ai_path
      delete payload.image_strategy
    }
    setSubmitting(true)
    // No shutdown call — there's no server to shut down. confirm_wait.py's
    // own blocking wait exits the instant this write lands (it polls
    // result.json directly), which is what used to require an explicit
    // POST /api/shutdown to make happen.
    window.chatApi
      .writeConfirmUiResult({ projectDir, payload })
      .then((res) => {
        if (!res.ok) throw new Error(res.error || 'confirm write failed')
        setPhase('confirmed')
      })
      .catch(() => {
        setSubmitting(false)
        setStatusText(t('error_retry'))
      })
  }, [projectDir, cat, rec, state, t])

  const onPrimary = useCallback(() => {
    // 回放态：面板只读，主按钮不触发任何 IPC 写入（没有真实项目目录，
    // projectDir 是占位值）——真实的「确认」结果早已由 chat 轨的 tool_result 呈现，
    // 这里的按钮点击视觉全由 confirmDemoHandle.selectField/advanceTier2/
    // submitFinal 驱动，见上面的回放 useEffect。
    if (isReplay) return
    if (stage === 1) submitTier1()
    else submitFinal()
  }, [isReplay, stage, submitTier1, submitFinal])

  const toggleLang = useCallback(() => {
    setLang((l) => {
      const next = l === 'zh' ? 'en' : 'zh'
      try {
        window.localStorage.setItem('ppt_lang', next)
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  // Live selection summary for the action bar — the user's last glance before
  // committing. Catalog ids resolve to their localized labels; a custom value
  // (not in the catalog) shows the user's own text verbatim. Kept as an array
  // (not pre-joined) so the action bar can render each choice as its own chip
  // — 2026-07-10 redesign, was a single "·"-joined string.
  const summaryParts = useMemo(() => {
    if (!cat) return []
    const labelFor = (list: CatalogOption[] | undefined, id: string | undefined): string | null => {
      if (!id) return null
      const o = flattenCatalog(list).find((x) => x.id === id)
      return o ? optionLabel(o, lang) : id
    }
    const parts =
      stage === 1
        ? [
            labelFor(cat.canvas, state.canvas),
            isPptCanvas(cat, state.canvas)
              ? labelFor(cat.delivery_purpose, state.delivery_purpose)
              : null,
            labelFor(cat.modes, state.mode),
            labelFor(cat.visual_styles, state.visual_style)
          ]
        : [
            labelFor(cat.canvas, state.canvas),
            labelFor(cat.visual_styles, state.visual_style),
            state.color?.name,
            state.typography?.name,
            state.typography?.body_size ? `${state.typography.body_size}px` : null
          ]
    return parts.filter((p): p is string => Boolean(p))
  }, [cat, state, stage, lang])

  // ── render ───────────────────────────────────────────────────────────────
  if (phase === 'confirmed') {
    // MESSAGES' confirmed_title carries its own "✓ " prefix (the web page had
    // no icon); the ring renders the check here, so strip it from the text.
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 py-10 text-center">
        <div className="grid size-[52px] place-items-center rounded-full bg-accent/15 text-accent">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
            <path d="M4.5 12.5l5 5L19.5 7" />
          </svg>
        </div>
        <div className="text-[16px] font-bold text-foreground">
          {t('confirmed_title').replace(/^✓\s*/, '')}
        </div>
        <div className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
          {t('confirmed_hint')}
        </div>
      </div>
    )
  }
  if (phase === 'error') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10 text-center text-[13px] text-destructive">
        {t('load_error')}
      </div>
    )
  }
  if (phase === 'loading' || !cat || !rec) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10 text-[13px] text-muted-foreground">
        {t('loading')}
      </div>
    )
  }
  if (phase === 'deriving') {
    // The tier1→tier2 wait made visible: spinner + copy + shimmering skeleton
    // cards, instead of the bare one-liner that read like a stall.
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 py-10 text-center">
        <div className="size-[34px] animate-spin rounded-full border-[3px] border-accent/25 border-t-accent" />
        <div className="text-[15px] font-semibold text-foreground">{uiT('deriving_title')}</div>
        <div className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">{t('deriving')}</div>
        <div className="mt-1.5 flex gap-2.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 w-28 animate-pulse rounded-lg bg-muted"
              style={{ animationDelay: `${i * 150}ms` }}
            />
          ))}
        </div>
      </div>
    )
  }

  const showAnchors = stage === 1 || stage === 'all'
  const showRealization = stage === 2 || stage === 'all'
  // Wizard-flavored labels ("Next · Realization" / "Confirm & generate") so the
  // button names the step it leads to, not just the verb.
  const primaryLabel = stage === 1 ? uiT('btn_next_rich') : uiT('btn_confirm_rich')
  // Section numbering runs 1..N within the rendered tier (matches app.js).
  let secNum = 0
  const next = (): number => (secNum += 1)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* topbar: title + hint + lang toggle, then the two-step wizard
          indicator. stage 'all' (legacy recs without a tier) renders both
          layers at once, so the stepper would lie — hide it there. */}
      <div className="shrink-0 border-b border-border/60 px-6 pb-3.5 pt-5">
        <div className="mx-auto w-full max-w-[860px]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-[17px] font-bold text-foreground">{t('page_title')}</h2>
              <p className="mt-1 text-[12px] text-muted-foreground">{t('topbar_hint')}</p>
            </div>
            <button
              type="button"
              onClick={toggleLang}
              title={t('lang_toggle_title')}
              className="shrink-0 rounded-md border border-border bg-card/60 px-2.5 py-1 text-[12px] font-medium text-foreground transition hover:bg-hover"
            >
              {lang === 'zh' ? 'EN' : '中'}
            </button>
          </div>
          {stage !== 'all' && <Stepper stage={stage} uiT={uiT} />}
        </div>
      </div>

      {/* scrollable sections */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-5">
        {/* stagger 容器：卡片依次落位。stage 1→2 时新增的 Section 以 hidden
            初始态挂载再 animate 到 show（Motion 默认行为），所以「下一步」
            换层同样是渐次入场，不用额外接线。 */}
        <motion.div
          initial="hidden"
          animate="show"
          variants={SECTIONS_CONTAINER}
          className="mx-auto flex w-full max-w-[860px] flex-col gap-3.5 pt-4"
        >
        {showAnchors && (
          <>
            <Section num={next()} title={t('sec_canvas')} note={uiT('note_canvas')}>
              <CanvasField
                list={cat.canvas}
                recommendedId={recOrFirst(rec, 'canvas', cat.canvas)}
                value={state.canvas}
                onChange={(v) => {
                  const tp = state.typography || { name: '', heading: {}, body: {} }
                  const body_size = tp.body_size || defaultBodySizeForCanvas(cat, v, state.delivery_purpose)
                  patch({ canvas: v, typography: { ...tp, body_size } })
                }}
                allowCustom
                previewsDir={previewsDir}
                lang={lang}
                t={t}
              />
            </Section>

            <Section num={next()} title={t('sec_audience')} note={uiT('note_audience')}>
              <TextField
                value={state.audience}
                onChange={(v) => patch({ audience: v })}
                placeholder={t('placeholder_audience')}
              />
              <SubField label={t('sub_divergence')}>
                <TextField
                  value={state.content_divergence}
                  onChange={(v) => patch({ content_divergence: v })}
                  placeholder={t('placeholder_divergence')}
                />
              </SubField>
              {isPptCanvas(cat, state.canvas) && (
                <SubField label={t('delivery_purpose')}>
                  <EnumField
                    list={cat.delivery_purpose}
                    recommendedId={recOrFirst(rec, 'delivery_purpose', cat.delivery_purpose)}
                    value={state.delivery_purpose}
                    onChange={(v) => patch({ delivery_purpose: v })}
                    lang={lang}
                    t={t}
                  />
                </SubField>
              )}
            </Section>

            <Section num={next()} title={t('sec_style')}>
              <SubLabel>{t('sub_mode')}</SubLabel>
              <EnumField
                list={cat.modes}
                recommendedId={recOrFirst(rec, 'mode', cat.modes)}
                value={state.mode}
                onChange={(v) => patch({ mode: v })}
                allowCustom
                lang={lang}
                t={t}
              />
              <SubField label={t('sub_visual')}>
                <VisualStyleField
                  list={cat.visual_styles}
                  recommendedId={recOrFirst(rec, 'visual_style', cat.visual_styles)}
                  value={state.visual_style}
                  onChange={(v) => patch({ visual_style: v })}
                  spectrum={rec.visual_style_spectrum}
                  previewsDir={previewsDir}
                  lang={lang}
                  t={t}
                />
              </SubField>
            </Section>
          </>
        )}

        {showRealization && (
          <>
            <StylePreview color={state.color} typography={state.typography} canvas={state.canvas} cat={cat} t={t} />
            <Section num={next()} title={t('sec_pages')}>
              <TextField
                value={state.page_count}
                onChange={(v) => patch({ page_count: v })}
                placeholder={t('placeholder_pages')}
                numeric
              />
            </Section>

            <Section num={next()} title={t('sec_color')} note={uiT('note_color')}>
              <ColorField
                candidates={(rec.color && rec.color.candidates) || []}
                value={state.color}
                onChange={(color) => patch({ color })}
                lang={lang}
                t={t}
              />
            </Section>

            <Section num={next()} title={t('sec_icons')}>
              <EnumField
                list={cat.icons}
                recommendedId={recOrFirst(rec, 'icons', cat.icons)}
                value={state.icons}
                onChange={(v) => patch({ icons: v })}
                allowCustom
                lang={lang}
                t={t}
              />
            </Section>

            <Section num={next()} title={t('sec_type')} note={uiT('note_type')}>
              <TypographyField
                candidates={(rec.typography && rec.typography.candidates) || []}
                value={state.typography}
                canvas={state.canvas}
                deliveryPurpose={state.delivery_purpose}
                cat={cat}
                onChange={(typography) => patch({ typography })}
                lang={lang}
                t={t}
              />
              <SubField label={t('formula_policy')}>
                <EnumField
                  list={cat.formula_policy}
                  recommendedId={recOrFirst(rec, 'formula_policy', cat.formula_policy)}
                  value={state.formula_policy}
                  onChange={(v) => patch({ formula_policy: v })}
                  lang={lang}
                  t={t}
                />
              </SubField>
            </Section>

            <Section num={next()} title={t('sec_images')} note={uiT('note_images')}>
              <ImageField
                cat={cat}
                rec={rec}
                state={state}
                onChangeUsage={(v) => patch({ image_usage: v })}
                onChangeAiPath={(v) => patch({ image_ai_path: v })}
                onChangeStrategy={(s) => patch({ image_strategy: s })}
                lang={lang}
                t={t}
              />
            </Section>

            <Section num={next()} title={t('sec_mode')} note={state.generation_mode === 'split' ? t('mode_split_desc') : t('mode_continuous_desc')}>
              <EnumField
                list={cat.generation_mode}
                recommendedId={recOrFirst(rec, 'generation_mode', cat.generation_mode)}
                value={state.generation_mode}
                onChange={(v) => patch({ generation_mode: v })}
                lang={lang}
                t={t}
              />
            </Section>

            <Section num={next()} title={t('sec_refine')} note={state.refine_spec ? t('refine_on_desc') : t('refine_off_desc')}>
              <EnumField
                list={[
                  { id: 'off', label: t('off_default') },
                  { id: 'on', label: t('on') }
                ]}
                recommendedId={state.refine_spec ? 'on' : 'off'}
                value={state.refine_spec ? 'on' : 'off'}
                onChange={(v) => patch({ refine_spec: v === 'on' })}
                lang={lang}
                t={t}
              />
            </Section>
          </>
        )}
        </motion.div>
      </div>

      {/* action bar: live selection summary (or a status/error, which takes
          priority) + the single primary action. No back button — tier1 has
          already been consumed by the server's --wait-only loop by the time
          tier2 renders, so "going back" has nothing to re-submit into. */}
      {/* bg-card —— 2026-07-17 定案，别再换回 bg-white / bg-background。

          本栏坐在 .shell-content-card 上（globals.css:399，`background:
          hsl(var(--card))`，整个右侧内容面都是它），所以它的底就该是 --card：
          「跟自己所在的那张面同色」，而不是去追某个绝对色值。

          历史（两版都错，错法相反）：
           1. `bg-background` —— 追错了对象。--background 是**页面**底，比内容
              面暗一档（--card = shiftLightness(bg, +3)），本栏用它必然比周围
              暗，暗档下用户一眼看出（截图取样实锤：卡片与页面底同为 #23221f
              而本栏 #1b1a18）。
           2. `bg-white dark:bg-background` —— 为「用户要白色 action bar」写死
              白，代价是彻底脱离主题体系：用户改背景色它纹丝不动。亮档之所以
              一直没露馅纯属巧合 —— 亮档默认 background #f5f5f7 (L=97%) 提亮
              3 点 clamp 到 100% 正好是白，写死的白恰好等于 --card。

          bg-card 同时满足两头，且不需要 dark: 变体：亮档默认下它**就是**白
          （见 appearance.applier 注释「the lift clamps to 100% = white cards」），
          原始诉求达成；暗档 #232220 与内容面严丝合缝；用户改主题色时它跟着
          走，不会再被钉死。 */}
      <div className="shrink-0 border-t border-border bg-card px-6 py-2.5">
        <div className="mx-auto flex w-full max-w-[860px] items-center gap-3">
          {statusText ? (
            <span
              className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground"
              title={statusText}
            >
              {statusText}
            </span>
          ) : (
            // Each choice as its own chip instead of one "·"-joined line —
            // reads as a set of tags rather than a sentence.
            //
            // 形态定稿 = 原型 V5「品牌绿点缀」（docs/
            // ui-prototype-confirm-actionbar-tags.html，2026-07-13 用户选
            // 定）：品牌绿淡底 + 绿字 + 勾选图标，与右侧确认按钮同色呼
            // 应——「这些是你确认过的选择」。配色沿用 app 里既有的同款
            // chip 词汇（ThreadListSidebar 的 bg-brand/[0.12]+text-brand、
            // PermissionFloatCard 的 bg-brand/[0.09]），全静态 brand
            // token：此前三轮「怎么调都发灰」的教训是 --card/--background
            // 会被外观设置运行时改写、深浅关系随用户主题漂移，brand 不在
            // applyThemeOverrides 的改写清单里（用户改的是 --accent），
            // dark 档位 tokens.css 自带。勾选 path 与本文件 confirmed
            // 状态页的大勾同一条，视觉语言一致。overflow-x-auto (not
            // wrap) keeps this single-line/fixed-height like the status
            // text it swaps with; scrollbar hidden since this is a
            // glance-only summary, not something meant to be scrolled
            // deliberately.
            <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {/* key 带上 part 而不只是 index：改选项时文本变了 key 才会变，
                  旧 chip 才走 exit、新 chip 才走 enter —— 纯 index 做 key 会
                  让内容原地替换，用户改了选择却看不到任何反馈。带上 i 是因为
                  两个维度理论上可能选出同名文案，纯 part 会撞 key。
                  mode="popLayout"：退场的 chip 立刻脱离布局流，剩下的用 layout
                  动画平滑补位，不会先空出一个洞再塌缩。
                  initial={false}：首屏不播 —— action bar 是跟着 7 张卡片一起
                  出现的，这里再 pop 一串就成了两处抢戏；chip 的动画只为「你
                  刚改了选择」这件事服务。 */}
              <AnimatePresence mode="popLayout" initial={false}>
              {summaryParts.map((part, i) => (
                <motion.span
                  key={`${i}-${part}`}
                  layout
                  initial={{ opacity: 0, scale: 0.85 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.85 }}
                  transition={railGliderSpring}
                  className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-brand/[0.09] px-3 py-1.5 text-[12px] font-medium text-brand"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="shrink-0"
                  >
                    <path d="M4.5 12.5l5 5L19.5 7" />
                  </svg>
                  {part}
                </motion.span>
              ))}
              </AnimatePresence>
            </div>
          )}
          <button
            type="button"
            disabled={submitting}
            onClick={onPrimary}
            className="rounded-lg bg-accent px-[18px] py-2 text-[13px] font-semibold text-accent-foreground shadow-sm transition-all hover:opacity-90 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100"
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ───────────────── two-step wizard indicator ───────────────── */

/**
 * Stepper
 * -------
 * Makes the server's two-tier flow (anchors → derived realization) visible:
 * step 1 shows a check once tier 2 is reached, the connector fills with the
 * accent, and the active step gets a soft accent ring. Only rendered for
 * tiered recommendations (stage 1 | 2) — 'all' shows every section at once.
 */
function Stepper({ stage, uiT }: { stage: 1 | 2; uiT: (k: string) => string }): React.JSX.Element {
  const dot = (active: boolean, done: boolean, label: string): React.JSX.Element => (
    <span
      className={
        'grid size-[22px] shrink-0 place-items-center rounded-full text-[11px] font-bold transition-all ' +
        (active
          ? 'bg-accent text-accent-foreground shadow-[0_0_0_3px_hsl(var(--accent)/0.25)]'
          : done
            ? 'bg-accent/15 text-accent'
            : 'border border-border bg-muted text-muted-foreground')
      }
    >
      {done ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5">
          <path d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        label
      )}
    </span>
  )
  const name = (active: boolean, nameKey: string, subKey: string): React.JSX.Element => (
    <span className="whitespace-nowrap">
      <span
        className={
          'text-[12px] ' + (active ? 'font-semibold text-foreground' : 'font-medium text-muted-foreground')
        }
      >
        {uiT(nameKey)}
      </span>{' '}
      <span className="text-[10.5px] text-muted-foreground/70">{uiT(subKey)}</span>
    </span>
  )
  return (
    <div className="mt-3.5 flex items-center gap-2.5">
      <div className="flex items-center gap-2">
        {dot(stage === 1, stage === 2, '1')}
        {name(stage === 1, 'step1_name', 'step1_sub')}
      </div>
      {/* 连接线：灰轨 + 绿条 scaleX 填充，而不是整条换 bg 类。换类是瞬时跳
          变（这里原本连 transition 都没有），而这条线是全页唯一表达「你推进
          了一步」的元件 —— 让它从左往右长出来，进度才有因果感。
          origin-left 决定生长方向；initial={false} 让「进来时就已在第 2 步」
          （恢复/回放）直接呈满格，不补播一次填充动画。
          用 spring 而非 ease：stage 可能被快速推进打断，spring 从当前进度接着
          走，ease 会从头重放。 */}
      <span className="relative h-[2px] w-11 shrink-0 overflow-hidden rounded-full bg-border">
        <motion.span
          className="absolute inset-0 origin-left rounded-full bg-accent"
          initial={false}
          animate={{ scaleX: stage === 2 ? 1 : 0 }}
          transition={railGliderSpring}
        />
      </span>
      <div className="flex items-center gap-2">
        {dot(stage === 2, false, '2')}
        {name(stage === 2, 'step2_name', 'step2_sub')}
      </div>
    </div>
  )
}

/** The selected-state corner check shared by every picker card. Parent must
 *  be `relative`. */
function SelTick(): React.JSX.Element {
  return (
    <span className="absolute right-2 top-2 z-[3] grid size-[18px] place-items-center rounded-full bg-accent text-accent-foreground shadow-sm">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5">
        <path d="M5 13l4 4L19 7" />
      </svg>
    </span>
  )
}

/* ───────────────── section wrappers ───────────────── */

function Section({
  num,
  title,
  note,
  children
}: {
  num: number
  title: string
  note?: string
  children: React.ReactNode
}): React.JSX.Element {
  // One card per confirmation — the flat border-b list read as one endless
  // form; discrete cards give each decision its own visual breath.
  //
  // variants 而非直接写 initial/animate：入场时机交给父容器的 staggerChildren
  // 统一编排，卡片自己不认识 index，也就不必把序号一路 prop 传下来。
  return (
    <motion.div
      variants={SECTION_VARIANTS}
      className="rounded-xl border border-border bg-card px-[18px] pb-[18px] pt-4 shadow-sm"
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="inline-flex size-[22px] shrink-0 -translate-y-px items-center justify-center self-center rounded-[7px] bg-accent/10 text-[11px] font-bold text-accent">
          {num}
        </span>
        <span className="text-[14px] font-semibold text-foreground">{title}</span>
        {note && <span className="text-[11px] text-muted-foreground">{note}</span>}
      </div>
      {children}
    </motion.div>
  )
}

function SubField({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mt-3">
      <SubLabel>{label}</SubLabel>
      {children}
    </div>
  )
}

function SubLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">{children}</div>
}

/* ───────────────── enum field (chips) ───────────────── */

/**
 * 选中高亮框。用 layoutId 让它在同组选项间**滑过去**，而不是在旧 chip 上
 * 消失、在新 chip 上出现 —— 后者是原来的做法（selected 直接换 border/bg
 * 类），换色有 transition-colors 兜着，但那圈框本身是瞬移的。
 *
 * 这正是 railGliderSpring 的本职（见 railMotion 头注释：glider 是会被连点
 * 打断的位移动画，spring 中断后从当前位置和速度重新求解，ease 会从头重放
 * 「顿一下再走」）—— rail 的选中态就是这么做的，这里复用同一条，两处手感
 * 一致。附带好处：chip 宽度不等，layout 动画会把宽高一起插值，框是「变形
 * 着滑过去」的。
 *
 * 为什么高亮框要单独一层而不是给 button 加类：layoutId 需要一个**跨 chip
 * 共享身份**的元素，只有它单独存在、并在同一时刻全组仅一个，Motion 才能
 * 把 A 上的它和 B 上的它认成同一个东西并做 FLIP。
 */
function ChipGlider({ layoutId }: { layoutId: string }): React.JSX.Element {
  return (
    <motion.span
      layoutId={layoutId}
      transition={railGliderSpring}
      aria-hidden="true"
      className="absolute inset-0 rounded-lg border border-accent bg-accent/10 ring-1 ring-accent"
    />
  )
}

type SpectrumEntry = { id: string; tag_zh?: string; tag_en?: string; note_zh?: string; note_en?: string }

function EnumField({
  list,
  recommendedId,
  value,
  onChange,
  allowCustom,
  spectrum,
  lang,
  t
}: {
  list: CatalogOption[] | undefined
  recommendedId: string | undefined
  value: string | undefined
  onChange: (v: string) => void
  allowCustom?: boolean
  spectrum?: SpectrumEntry[]
  lang: Lang
  t: (k: string) => string
}): React.JSX.Element {
  const flat = flattenCatalog(list)
  const ids = flat.map((o) => o.id)
  const grouped = isGrouped(list)
  const specById = useMemo(() => {
    const m: Record<string, { tag: string; note: string }> = {}
    if (spectrum && spectrum.length) {
      spectrum.forEach((s) => {
        if (s && s.id) m[s.id] = { tag: localized(s, 'tag', lang), note: localized(s, 'note', lang) }
      })
    }
    return m
  }, [spectrum, lang])
  const hasSpectrum = Object.keys(specById).length > 0

  const cur = value
  const isCustom = cur != null && cur !== '' && ids.indexOf(cur) === -1
  // Closed field with an out-of-catalog value → snap to recommended/first.
  useEffect(() => {
    if (!allowCustom && isCustom) {
      const snap = ids.indexOf(recommendedId || '') >= 0 ? (recommendedId as string) : ids[0]
      if (snap != null) onChange(snap)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCustom, allowCustom])

  const [customText, setCustomText] = useState(isCustom && cur ? cur : '')

  // 每个 EnumField 一个独立的 glider 身份。共用一个常量 layoutId 会让不同
  // 字段的高亮互相认亲：点「生成模式」时，「图片使用」那圈框会横跨半屏飞
  // 过来。useId 保证同页多实例各滑各的。
  const gliderId = `chip-glider-${useId()}`

  const chip = (o: CatalogOption): React.JSX.Element => {
    // Main label and description render as separate spans (weight + tone),
    // not one concatenated string — the option name has to be scannable.
    let main = optionLabel(o, lang)
    if (o.dim) main += ' · ' + o.dim
    const spec = specById[o.id]
    const sub = [optionDesc(o, lang), spec && spec.note].filter(Boolean).join(' · ')
    const selected = !isCustom && o.id === cur
    const recommended = spec ? true : !hasSpectrum && o.id === recommendedId
    // 选中态的 border/bg/ring 全部交给 ChipGlider 那一层，button 自己让出
    // border（transparent 而非去掉，否则盒子会缩 1px、整行跳一下）。文字层
    // 一律 relative：glider 是 absolute，不抬升就会盖住文字。
    return (
      <button
        key={o.id}
        type="button"
        onClick={() => onChange(o.id)}
        className={
          'relative inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors ' +
          (selected
            ? 'border-transparent text-accent'
            : 'border-border bg-background/60 text-foreground hover:bg-hover')
        }
      >
        {selected && <ChipGlider layoutId={gliderId} />}
        <span className="relative font-medium">{main}</span>
        {sub && (
          <span className={'relative ' + (selected ? 'text-accent/70' : 'text-muted-foreground')}>
            {sub}
          </span>
        )}
        {recommended && (
          <span className="relative shrink-0 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            ★ {spec ? spec.tag || t('recommended') : t('recommended')}
          </span>
        )}
      </button>
    )
  }

  const customChip = (): React.JSX.Element => {
    const recommended = !!recommendedId && ids.indexOf(recommendedId) === -1
    // 与上面的 chip 共用同一个 gliderId：「自定义」是这组选项的一员，从某个
    // 预设切到它时高亮该滑过来，而不是在那边灭、在这边亮。未选中保持 dashed
    // （「这里要你自己填」的既有语义），选中时框由 glider 接管、自然是实线。
    return (
      <button
        key="__custom__"
        type="button"
        onClick={() => onChange(customText || '')}
        className={
          'relative inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors ' +
          (isCustom
            ? 'border-transparent text-accent'
            : 'border-dashed border-border bg-background/60 text-muted-foreground hover:bg-hover')
        }
      >
        {isCustom && <ChipGlider layoutId={gliderId} />}
        <span className="relative font-medium">{t('custom')}</span>
        {recommended && (
          <span className="relative shrink-0 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            ★ {t('recommended')}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {grouped ? (
        (list || []).map((g, gi) => (
          <div key={gi} className="flex flex-col gap-1.5">
            {groupLabel(g, lang) && (
              <div className="text-[11px] font-medium text-muted-foreground">{groupLabel(g, lang)}</div>
            )}
            <div className="flex flex-wrap gap-1.5">{(g.items || []).map((o) => chip(o))}</div>
          </div>
        ))
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {flat.map((o) => chip(o))}
          {allowCustom && customChip()}
        </div>
      )}
      {grouped && allowCustom && <div className="flex flex-wrap gap-1.5">{customChip()}</div>}
      {/* 自定义输入框：height auto 展开而非瞬间蹦出。它是点「自定义」chip 后
          长出来的**因果结果**，撑开高度的过程把这层因果画出来；瞬间出现则会
          把下方内容一把推走，读者得重新找位置。
          overflow-hidden 是 height 动画的前提（否则内容在 0 高度时溢出可见）。
          exit 同样收起：取消自定义时不该留一个塌缩的空洞。
          ease-out 不用 spring：这是纯「出现/消失」，回弹会让输入框抖两下，
          而它下一拍就要接住 autoFocus 的光标。 */}
      <AnimatePresence initial={false}>
        {allowCustom && isCustom && (
          <motion.div
            key="custom-input"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: railEaseOut }}
            className="overflow-hidden"
          >
            <input
              type="text"
              value={customText}
              autoFocus
              onChange={(e) => {
                setCustomText(e.target.value)
                onChange(e.target.value || '')
              }}
              placeholder={t('custom_placeholder')}
              className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground focus:border-accent focus:outline-none"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ───────────────── visual-style field (image cards) ───────────────── */

/**
 * VisualStyleField
 * ----------------
 * The 「视觉风格」picker rendered as image cards instead of EnumField's text
 * chips: each style shows a unified-subject preview slide (the same imaginary
 * deck painted in that style), so the user picks by sight, not by reading a
 * paragraph. It mirrors EnumField's behavior for THIS field exactly — grouped
 * layout, the spectrum recommendation badges, the custom card + free-text input,
 * selection state — and submits the same value (a catalog `id`, or free text for
 * custom), so the result.json contract and `seedTier1`'s `recOrFirst` pick are
 * untouched. Kept separate from EnumField so the image treatment never leaks
 * into the other enum fields (canvas / mode / icons …) that share EnumField.
 *
 * Previews are JPEGs that ship with the skill at
 * <static_dir>/style-previews/<id>.jpg (static_dir = the `previewsDir` prop,
 * resolved from catalogs.json's `_meta.static_dir` — see extractStaticDir).
 * Each StyleCard reads its own file via IMAGE_FILE_READ (there's no Flask
 * `/static/*` route to cross-origin-fetch from anymore). A missing/failed
 * image degrades to a styled placeholder rather than a broken-image glyph,
 * so a partial preview set never breaks layout.
 */
function VisualStyleField({
  list,
  recommendedId,
  value,
  onChange,
  spectrum,
  previewsDir,
  lang,
  t
}: {
  list: CatalogOption[] | undefined
  recommendedId: string | undefined
  value: string | undefined
  onChange: (v: string) => void
  spectrum?: SpectrumEntry[]
  previewsDir: string | undefined
  lang: Lang
  t: (k: string) => string
}): React.JSX.Element {
  const flat = flattenCatalog(list)
  const ids = flat.map((o) => o.id)
  const grouped = isGrouped(list)
  const previewAbsPath = useCallback(
    (id: string): string | undefined =>
      previewsDir ? `${previewsDir}/style-previews/${id}.jpg` : undefined,
    [previewsDir]
  )

  const specById = useMemo(() => {
    const m: Record<string, { tag: string; note: string }> = {}
    if (spectrum && spectrum.length) {
      spectrum.forEach((s) => {
        if (s && s.id) m[s.id] = { tag: localized(s, 'tag', lang), note: localized(s, 'note', lang) }
      })
    }
    return m
  }, [spectrum, lang])
  const hasSpectrum = Object.keys(specById).length > 0

  // Coerce to a string: `value` is typed `string | undefined`, but a malformed
  // recommendation could still hand us an object at runtime — rendering that in
  // the free-text input below would show "[object Object]". Stringify defensively
  // (an object becomes '', not "[object Object]").
  const cur = typeof value === 'string' ? value : ''
  const isCustom = cur !== '' && ids.indexOf(cur) === -1
  const [customText, setCustomText] = useState(isCustom ? cur : '')

  const card = (o: CatalogOption): React.JSX.Element => {
    const label = optionLabel(o, lang)
    const desc = optionDesc(o, lang)
    const spec = specById[o.id]
    const note = spec && spec.note ? spec.note : desc
    const selected = !isCustom && o.id === cur
    const recommended = spec ? true : !hasSpectrum && o.id === recommendedId
    return (
      <StyleCard
        key={o.id}
        absPath={previewAbsPath(o.id)}
        label={label}
        note={note}
        selected={selected}
        badge={recommended ? '★ ' + (spec ? spec.tag || t('recommended') : t('recommended')) : undefined}
        onClick={() => onChange(o.id)}
      />
    )
  }

  // The custom card has no preview image — it's a dashed "describe your own"
  // tile that mirrors EnumField's custom chip and reveals the free-text input.
  const customCard = (): React.JSX.Element => {
    const recommended = !!recommendedId && ids.indexOf(recommendedId) === -1
    return (
      <button
        key="__custom__"
        type="button"
        onClick={() => onChange(customText || '')}
        className={
          'flex aspect-[16/10] flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-3 text-center text-[12px] font-medium transition-colors ' +
          (isCustom
            ? 'border-accent bg-accent/[0.08] text-accent'
            : 'border-border bg-background/60 text-muted-foreground hover:bg-hover')
        }
      >
        <span>{t('custom')}</span>
        {recommended && (
          <span className="rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            ★ {t('recommended')}
          </span>
        )}
      </button>
    )
  }

  // 2-up on narrow canvases, 3-up when there's room — image cards need width.
  const gridCls = 'grid grid-cols-2 gap-2 sm:grid-cols-3'

  return (
    <div className="flex flex-col gap-3">
      {grouped ? (
        (list || []).map((g, gi) => (
          <div key={gi} className="flex flex-col gap-1.5">
            {groupLabel(g, lang) && (
              <div className="text-[11px] font-medium text-muted-foreground">{groupLabel(g, lang)}</div>
            )}
            <div className={gridCls}>{(g.items || []).map((o) => card(o))}</div>
          </div>
        ))
      ) : (
        <div className={gridCls}>
          {flat.map((o) => card(o))}
          {customCard()}
        </div>
      )}
      {/* Grouped layout puts the custom tile on its own trailing row. */}
      {grouped && <div className={gridCls}>{customCard()}</div>}
      {isCustom && (
        <input
          type="text"
          value={customText}
          autoFocus
          onChange={(e) => {
            setCustomText(e.target.value)
            onChange(e.target.value || '')
          }}
          placeholder={t('custom_placeholder')}
          className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground focus:border-accent focus:outline-none"
        />
      )}
    </div>
  )
}

/** One visual-style image card: preview thumbnail + label + note + optional
 *  recommendation badge. Falls back to a labeled placeholder while the image
 *  is loading (or missing) so a partial preview set degrades gracefully
 *  instead of showing a broken glyph — see useLocalPreviewImage. */
function StyleCard({
  absPath,
  label,
  note,
  selected,
  badge,
  onClick
}: {
  absPath: string | undefined
  label: string
  note?: string
  selected: boolean
  badge?: string
  onClick: () => void
}): React.JSX.Element {
  const src = useLocalPreviewImage(absPath)
  return (
    <button
      type="button"
      onClick={onClick}
      title={note || label}
      className={
        'group relative flex flex-col overflow-hidden rounded-lg border text-left transition-colors ' +
        (selected ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50')
      }
    >
      {selected && <SelTick />}
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-muted">
        {src ? (
          <img
            src={src}
            alt={label}
            draggable={false}
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center px-2 text-center text-[11px] text-muted-foreground">
            {label}
          </div>
        )}
        {badge && (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-amber-400/90 px-1.5 py-0.5 text-[10px] font-medium text-amber-950 shadow-sm">
            {badge}
          </span>
        )}
      </div>
      <div
        className={
          'flex flex-col gap-0.5 px-2 py-1.5 ' + (selected ? 'bg-accent/[0.08]' : 'bg-background/40')
        }
      >
        <span className={'text-[12px] font-medium ' + (selected ? 'text-accent' : 'text-foreground')}>
          {label}
        </span>
        {note && <span className="line-clamp-2 text-[10px] text-muted-foreground">{note}</span>}
      </div>
    </button>
  )
}

/* ───────────────── canvas-format field (image cards) ───────────────── */

/**
 * CanvasField
 * -----------
 * The 「画布格式」picker as image cards instead of EnumField text chips. Cards
 * sit in a uniform equal-height grid (order), but each holds a "sheet" sized to
 * the format's REAL aspect ratio (from its `dim`, e.g. 1280×720 → 16:9), floated
 * on a dotted stage — so the SHAPE reads as the canvas (wide vs. tall vs. square),
 * which is the whole point of this field, while the grid stays tidy. Mirror of
 * VisualStyleField's contract: emits a catalog `id` (or free text for custom),
 * so seedTier1's `recOrFirst` pick and the result.json contract are unchanged.
 * Previews are JPEGs that ship with the skill at
 * <static_dir>/canvas-previews/<id>.jpg (see extractStaticDir / the
 * `previewsDir` prop); each CanvasCard reads its own file via
 * IMAGE_FILE_READ, with a graceful fallback to the dim text when an image is
 * missing.
 */
function CanvasField({
  list,
  recommendedId,
  value,
  onChange,
  allowCustom,
  previewsDir,
  lang,
  t
}: {
  list: CatalogOption[] | undefined
  recommendedId: string | undefined
  value: string | undefined
  onChange: (v: string) => void
  allowCustom?: boolean
  previewsDir: string | undefined
  lang: Lang
  t: (k: string) => string
}): React.JSX.Element {
  const flat = flattenCatalog(list)
  const ids = flat.map((o) => o.id)
  const previewAbsPath = useCallback(
    (id: string): string | undefined =>
      previewsDir ? `${previewsDir}/canvas-previews/${id}.jpg` : undefined,
    [previewsDir]
  )

  const isCustom = value != null && value !== '' && ids.indexOf(value) === -1
  const [customText, setCustomText] = useState(isCustom && value ? value : '')

  const card = (o: CatalogOption): React.JSX.Element => {
    const selected = !isCustom && o.id === value
    const recommended = o.id === recommendedId
    return (
      <CanvasCard
        key={o.id}
        absPath={previewAbsPath(o.id)}
        label={optionLabel(o, lang)}
        dim={o.dim}
        use={localized(o, 'use', lang)}
        selected={selected}
        recommended={recommended}
        recommendedLabel={t('recommended')}
        onClick={() => onChange(o.id)}
      />
    )
  }

  const customCard = (): React.JSX.Element => (
    <button
      key="__custom__"
      type="button"
      onClick={() => onChange(customText || '')}
      className={
        'flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed p-3 text-center text-[12px] font-medium transition-colors ' +
        (isCustom
          ? 'border-accent bg-accent/[0.08] text-accent'
          : 'border-border bg-background/60 text-muted-foreground hover:bg-hover')
      }
    >
      {t('custom')}
    </button>
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {flat.map((o) => card(o))}
        {allowCustom && customCard()}
      </div>
      {allowCustom && isCustom && (
        <input
          type="text"
          value={customText}
          autoFocus
          onChange={(e) => {
            setCustomText(e.target.value)
            onChange(e.target.value || '')
          }}
          placeholder={t('custom_placeholder')}
          className="mt-1 w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground focus:border-accent focus:outline-none"
        />
      )}
    </div>
  )
}

/** Parse "1280×720" → "16 / 9"-style CSS aspect-ratio; default 16/10. */
function dimAspect(dim: string | undefined): string {
  const m = String(dim || '').match(/(\d{2,5})\s*[×xX*]\s*(\d{2,5})/)
  return m ? `${parseInt(m[1], 10)} / ${parseInt(m[2], 10)}` : '16 / 10'
}

/** One canvas card: a real-aspect sheet on a dotted stage + label/dim row. The
 *  sheet caps at both 100% width and the stage height so wide formats fill width
 *  and stay short, tall formats grow within the fixed-height stage. */
function CanvasCard({
  absPath,
  label,
  dim,
  use,
  selected,
  recommended,
  recommendedLabel,
  onClick
}: {
  absPath: string | undefined
  label: string
  dim?: string
  use?: string
  selected: boolean
  recommended: boolean
  recommendedLabel: string
  onClick: () => void
}): React.JSX.Element {
  const src = useLocalPreviewImage(absPath)
  return (
    <button
      type="button"
      onClick={onClick}
      title={use || label}
      className={
        'relative flex flex-col overflow-hidden rounded-xl border text-left transition-colors ' +
        (selected ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50')
      }
    >
      {selected && <SelTick />}
      <div
        className={
          'relative flex h-[112px] items-center justify-center p-3 ' +
          (selected ? 'bg-accent/[0.08]' : 'bg-background/40')
        }
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, var(--color-border, rgba(0,0,0,0.12)) 1px, transparent 0)',
          backgroundSize: '10px 10px'
        }}
      >
        <div
          className="overflow-hidden rounded-[4px] border border-border bg-white shadow-[0_2px_6px_-2px_rgba(0,0,0,0.25)]"
          style={{ aspectRatio: dimAspect(dim), height: 88, maxHeight: 88, maxWidth: '100%' }}
        >
          {src ? (
            <img
              src={src}
              alt={label}
              draggable={false}
              className="size-full object-cover"
            />
          ) : (
            <div className="flex size-full items-center justify-center text-[10px] text-muted-foreground">
              {dim}
            </div>
          )}
        </div>
        {recommended && (
          <span className="absolute left-2 top-2 rounded-full bg-amber-400/90 px-1.5 py-0.5 text-[10px] font-medium text-amber-950 shadow-sm">
            ★ {recommendedLabel}
          </span>
        )}
      </div>
      <div
        className={
          'flex flex-col gap-0.5 border-t border-border/40 px-2.5 py-2 ' +
          (selected ? 'bg-accent/[0.08]' : '')
        }
      >
        <span className={'text-[12px] font-medium ' + (selected ? 'text-accent' : 'text-foreground')}>
          {label}
        </span>
        {dim && <span className="text-[10px] text-muted-foreground">{dim}</span>}
      </div>
    </button>
  )
}

/* ───────────────── text field ───────────────── */

function TextField({
  value,
  onChange,
  placeholder,
  numeric
}: {
  value: string | undefined
  onChange: (v: string) => void
  placeholder: string
  numeric?: boolean
}): React.JSX.Element {
  return (
    <input
      type="text"
      inputMode={numeric ? 'numeric' : undefined}
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground focus:border-accent focus:outline-none"
    />
  )
}

/* ───────────────── sticky style preview strip ───────────────── */

/**
 * StylePreview
 * ------------
 * The sticky "overall impression" strip pinned at the top of the Tier-2
 * realization sections — a faithful port of the original confirm_ui app.js
 * `renderStylePreview`. It synthesizes the LIVE color + typography choice into
 * one card so the user sees the combined feel while scrolling color / icon /
 * typography. Card bg = selected background; heading in the heading font + the
 * primary color at ~1.7× the body size; body in the body font + body_text, with
 * an accent bar; a right-hand chip shows the secondary-bg tile with a
 * secondary-accent dot. The "rough feel only" caveat stays in the UI font so it
 * can never pose as sample content. Pure derivation from `color`/`typography` —
 * no state of its own — so it repaints on every pick. `position: sticky` keeps
 * it visible; it pins inside the scroll container (top-0).
 *
 * This was the `STAGE TWO:` "sticky combined StylePreview strip" deferred when
 * the component was first ported; landing it here completes that item.
 */
function StylePreview({
  color,
  typography,
  canvas,
  cat,
  t
}: {
  color: ConfirmState['color']
  typography: Typography | undefined
  canvas: string | undefined
  cat: Catalogs
  t: (k: string) => string
}): React.JSX.Element {
  const pal = (color && color.palette) || {}
  const typ = typography || {}
  const head = typ.heading || {}
  const body = typ.body || {}
  const bg = hexOr(pal.background, '#ffffff')
  const sbg = hexOr(pal.secondary_bg, bg)
  const pri = hexOr(pal.primary, '#1a3a6b')
  const acc = hexOr(pal.accent, pri)
  const sacc = hexOr(pal.secondary_accent, acc)
  const txt = hexOr(pal.body_text, '#1d2430')
  // body_size is px everywhere; clamp to a sane preview range (mirror of app.js).
  const rawSize = parseFloat(String(typ.body_size)) || (isPptCanvas(cat, canvas) ? 24 : 18)
  const bodyPx = Math.max(12, Math.min(34, rawSize))
  const headCjk = previewFontStack(head.cjk, head.css)
  const headLat = previewFontStack(head.latin, head.css)
  const bodyCjk = previewFontStack(body.cjk, body.css)
  const bodyLat = previewFontStack(body.latin, body.css)

  return (
    <div className="sticky top-0 z-[5] bg-background pb-3 pt-2.5">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
        <span className="text-[12.5px] font-semibold text-muted-foreground">{t('style_preview_label')}</span>
        <span className="text-[11.5px] text-muted-foreground">{t('style_preview_body')}</span>
      </div>
      <div
        className="flex items-center gap-4 overflow-hidden rounded-lg border border-border px-[18px] py-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-16px_rgba(0,0,0,0.25)]"
        style={{ background: bg }}
      >
        <div className="min-w-0 flex-1">
          <div
            className="truncate font-bold leading-[1.25]"
            style={{ color: pri, fontSize: Math.round(bodyPx * 1.7) }}
          >
            <span style={{ fontFamily: headCjk || undefined }}>{head.sample_cjk || t('sample_cjk')}</span>
            <span className="ml-2.5 opacity-90" style={{ fontFamily: headLat || undefined }}>
              {head.sample_latin || t('sample_latin')}
            </span>
          </div>
          <div className="mt-1.5 flex items-stretch gap-2.5">
            <span className="w-1 shrink-0 rounded-sm" style={{ background: acc }} />
            <div className="min-w-0 flex-1 truncate leading-[1.5]" style={{ color: txt, fontSize: bodyPx }}>
              <span style={{ fontFamily: bodyCjk || undefined }}>{body.sample_cjk || t('sample_cjk')}</span>
              <span className="ml-2.5 opacity-90" style={{ fontFamily: bodyLat || undefined }}>
                {body.sample_latin || t('sample_latin')}
              </span>
            </div>
          </div>
        </div>
        <div
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-black/[0.06] px-3 py-[7px]"
          style={{ background: sbg }}
        >
          <span className="size-3 rounded-full" style={{ background: sacc }} />
          <span className="text-[12.5px]" style={{ color: txt }}>
            {t('role_secondary_bg')}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ───────────────── color field (swatches; STAGE TWO: HEX override) ───────── */

function ColorField({
  candidates,
  value,
  onChange,
  lang,
  t
}: {
  candidates: Record<string, any>[]
  value: ConfirmState['color']
  onChange: (c: NonNullable<ConfirmState['color']>) => void
  lang: Lang
  t: (k: string) => string
}): React.JSX.Element {
  const isCustom = value?.name === 'custom'
  const selectedName = value?.name

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {candidates.map((c, idx) => {
          const pal = normPalette(c)
          // Candidates often carry only name_zh / name_en (raw `name` is null),
          // so the localized display name is the stable per-card key for both
          // selection-match and what we store — using c.name (null → '') would
          // make every card share the same '' key and break selection.
          const cardName = localized(c, 'name', lang) || t('option_prefix') + ' ' + (idx + 1)
          const selected = !isCustom && cardName === selectedName
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onChange({ name: cardName, palette: { ...normPalette(c) } })}
              className={
                'relative flex flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors ' +
                (selected
                  ? 'border-accent bg-accent/[0.08] ring-1 ring-accent'
                  : 'border-border bg-background/60 hover:bg-hover')
              }
            >
              {selected && <SelTick />}
              <div className="flex gap-1">
                {PALETTE_ROLES.map((role) =>
                  pal[role] ? (
                    <div key={role} className="flex flex-col items-center gap-0.5">
                      <span
                        className="size-[26px] rounded border border-black/10"
                        style={{ background: pal[role] }}
                      />
                      <span className="text-[9px] text-muted-foreground">{t('role_' + role)}</span>
                    </div>
                  ) : null
                )}
              </div>
              <div className="text-[12px] font-medium text-foreground">{cardName}</div>
              {localized(c, 'note', lang) && (
                <div className="text-[11px] text-muted-foreground">{localized(c, 'note', lang)}</div>
              )}
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => onChange({ name: 'custom', custom: value?.custom || '', palette: {} })}
          className={
            'flex items-center justify-center rounded-lg border p-2.5 text-[12px] font-medium transition-colors ' +
            (isCustom
              ? 'border-accent bg-accent/[0.08] text-accent ring-1 ring-accent'
              : 'border-dashed border-border bg-background/60 text-muted-foreground hover:bg-hover')
          }
        >
          {t('custom_color')}
        </button>
      </div>
      {isCustom && (
        <textarea
          rows={2}
          value={value?.custom || ''}
          autoFocus
          onChange={(e) => onChange({ name: 'custom', custom: e.target.value, palette: {} })}
          placeholder={t('custom_color_placeholder')}
          className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground focus:border-accent focus:outline-none"
        />
      )}
      {/* STAGE TWO: per-role HEX override grid with dual-target live swatch repaint */}
    </div>
  )
}

/* ───────────────── typography field (basic preview; STAGE TWO: size ramp) ── */

function TypographyField({
  candidates,
  value,
  canvas,
  deliveryPurpose,
  cat,
  onChange,
  lang,
  t
}: {
  candidates: Record<string, any>[]
  value: Typography | undefined
  canvas: string | undefined
  deliveryPurpose: string | undefined
  cat: Catalogs
  onChange: (typ: Typography) => void
  lang: Lang
  t: (k: string) => string
}): React.JSX.Element {
  const isCustom = value?.name === 'custom'
  const selectedName = value?.name

  // Candidate `name` is usually null (only name_zh/name_en exist). Use the
  // localized display name (off the RAW candidate — normTypography drops the
  // bilingual keys) as the stable store/compare key, or selection breaks.
  const fontName = (raw: Record<string, any>, idx: number): string =>
    localized(raw, 'name', lang) || t('option_prefix') + ' ' + (idx + 1)

  const pickFont = (raw: Record<string, any>, idx: number): void => {
    const n = normTypography(raw)
    onChange({
      name: fontName(raw, idx),
      heading: n.heading || {},
      body: n.body || {},
      body_size: value?.body_size || n.body_size || '',
      sizes: { ...(value?.sizes || {}) }
    })
  }

  const sample = (slot: { cjk?: string; latin?: string; css?: string; sample_cjk?: string; sample_latin?: string }) => {
    const cjkStack = previewFontStack(slot.cjk, slot.css)
    const latStack = previewFontStack(slot.latin, slot.css)
    return (
      <div className="flex flex-wrap items-baseline gap-x-2 text-[15px] text-foreground">
        <span style={{ fontFamily: cjkStack || undefined }} title={cjkStack}>
          {slot.sample_cjk || t('sample_cjk')}
        </span>
        <span style={{ fontFamily: latStack || undefined }} title={latStack}>
          {slot.sample_latin || t('sample_latin')}
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2">
        {candidates.map((raw, idx) => {
          const c = normTypography(raw)
          const head = c.heading || {}
          const body = c.body || {}
          const cardName = fontName(raw, idx)
          const selected = !isCustom && cardName === selectedName
          const meta =
            `${t('font_heading')} ${t('cjk')}:${head.cjk || '—'} / ${t('latin')}:${head.latin || '—'}` +
            `  ·  ${t('font_body')} ${t('cjk')}:${body.cjk || '—'} / ${t('latin')}:${body.latin || '—'}` +
            (c.body_size ? `  ·  ${t('font_body_size')}:${c.body_size}px` : '')
          return (
            <button
              key={idx}
              type="button"
              onClick={() => pickFont(raw, idx)}
              className={
                'relative flex flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors ' +
                (selected
                  ? 'border-accent bg-accent/[0.08] ring-1 ring-accent'
                  : 'border-border bg-background/60 hover:bg-hover')
              }
            >
              {selected && <SelTick />}
              {/* pr-6 keeps the header clear of the corner check */}
              <div className="flex flex-col gap-0.5 pr-6">
                <span className="text-[12px] font-medium text-foreground">
                  {cardName}
                </span>
                <span className="text-[10px] text-muted-foreground">{meta}</span>
              </div>
              {sample(head)}
              {sample(body)}
              {localized(c, 'note', lang) && (
                <div className="text-[11px] text-muted-foreground">{localized(c, 'note', lang)}</div>
              )}
            </button>
          )
        })}
        <button
          type="button"
          onClick={() =>
            onChange({
              name: 'custom',
              custom: value?.custom || '',
              heading: {},
              body: {},
              body_size: value?.body_size || '',
              sizes: { ...(value?.sizes || {}) }
            })
          }
          className={
            'rounded-lg border p-2.5 text-left text-[12px] font-medium transition-colors ' +
            (isCustom
              ? 'border-accent bg-accent/[0.08] text-accent ring-1 ring-accent'
              : 'border-dashed border-border bg-background/60 text-muted-foreground hover:bg-hover')
          }
        >
          {t('custom_typography')}
        </button>
      </div>
      {isCustom && (
        <textarea
          rows={2}
          value={value?.custom || ''}
          autoFocus
          onChange={(e) =>
            onChange({
              name: 'custom',
              custom: e.target.value,
              heading: {},
              body: {},
              body_size: value?.body_size || '',
              sizes: { ...(value?.sizes || {}) }
            })
          }
          placeholder={t('custom_typography_placeholder')}
          className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground focus:border-accent focus:outline-none"
        />
      )}
      {/* Body baseline size (kept; the per-role ramp grid is STAGE TWO). */}
      <SubField label={t('font_body_size')}>
        <input
          type="number"
          min={8}
          max={96}
          step={1}
          value={(value?.body_size as string | number | undefined) ?? ''}
          placeholder={isPptCanvas(cat, canvas) ? '16 / 20 / 24' : '40 / 48'}
          onChange={(e) =>
            onChange({
              ...(value || { name: '', heading: {}, body: {} }),
              body_size: e.target.value
            })
          }
          className="w-28 rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground focus:border-accent focus:outline-none"
        />
        <div className="mt-1 text-[11px] text-muted-foreground">
          {t('font_body_size_hint')}{' '}
          {isPptCanvas(cat, canvas)
            ? t('body_size_hint_purpose').replace('{def}', String(deliveryBodyPx(deliveryPurpose).def))
            : ''}
        </div>
      </SubField>
    </div>
  )
}

/* ───────────────── image field ───────────────── */

function ImageField({
  cat,
  rec,
  state,
  onChangeUsage,
  onChangeAiPath,
  onChangeStrategy,
  lang,
  t
}: {
  cat: Catalogs
  rec: Recommendations
  state: ConfirmState
  onChangeUsage: (v: string) => void
  onChangeAiPath: (v: string) => void
  onChangeStrategy: (s: Record<string, string>) => void
  lang: Lang
  t: (k: string) => string
}): React.JSX.Element {
  const needsAi = needsGeneratedImagesForUsage(cat, rec, state.image_usage)
  const strategyCands = imageStrategyCandidates(rec)
  // Seed the strategy selection once when AI controls first become relevant.
  const seededRef = useRef(false)
  useEffect(() => {
    if (needsAi && !seededRef.current && strategyCands.length && !state.image_strategy) {
      seededRef.current = true
      const c = strategyCands[imageStrategySelectedIndex(rec)] || {}
      onChangeStrategy({
        name: localized(c, 'name', lang) || c.name || '',
        rendering: c.rendering || '',
        palette: c.palette || '',
        visual: localized(c, 'visual', lang) || '',
        color: localized(c, 'color', lang) || '',
        mood: localized(c, 'mood', lang) || ''
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAi])

  const selectedStrategyName = state.image_strategy?.name

  return (
    <div className="flex flex-col gap-2">
      <EnumField
        list={cat.image_usage}
        recommendedId={recOrFirst(rec, 'image_usage', cat.image_usage)}
        value={state.image_usage}
        onChange={onChangeUsage}
        allowCustom
        lang={lang}
        t={t}
      />
      {needsAi && (
        <>
          <SubField label={t('image_ai_path')}>
            <EnumField
              list={cat.image_ai_path}
              recommendedId={recOrFirst(rec, 'image_ai_path', cat.image_ai_path)}
              value={state.image_ai_path}
              onChange={onChangeAiPath}
              lang={lang}
              t={t}
            />
          </SubField>
          <SubField label={t('image_strategy')}>
            {strategyCands.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">{t('image_strategy_empty')}</div>
            ) : (
              <div className="flex flex-col gap-2">
                {strategyCands.map((c, idx) => {
                  const name = localized(c, 'name', lang) || c.name || t('option_prefix') + ' ' + (idx + 1)
                  const selected = name === selectedStrategyName
                  const meta: string[] = []
                  if (c.rendering) meta.push(t('image_strategy_rendering') + ':' + c.rendering)
                  if (c.palette) meta.push(t('image_strategy_palette') + ':' + c.palette)
                  const rows: [string, string][] = [
                    ['image_strategy_visual', localized(c, 'visual', lang)],
                    ['image_strategy_color', localized(c, 'color', lang)],
                    ['image_strategy_mood', localized(c, 'mood', lang)]
                  ]
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() =>
                        onChangeStrategy({
                          name,
                          rendering: c.rendering || '',
                          palette: c.palette || '',
                          visual: localized(c, 'visual', lang) || '',
                          color: localized(c, 'color', lang) || '',
                          mood: localized(c, 'mood', lang) || ''
                        })
                      }
                      className={
                        'relative flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors ' +
                        (selected
                          ? 'border-accent bg-accent/[0.08] ring-1 ring-accent'
                          : 'border-border bg-background/60 hover:bg-hover')
                      }
                    >
                      {selected && <SelTick />}
                      <div className="flex flex-col gap-0.5 pr-6">
                        <span className="text-[12px] font-medium text-foreground">{name}</span>
                        {meta.length > 0 && (
                          <span className="text-[10px] text-muted-foreground">{meta.join('  ·  ')}</span>
                        )}
                      </div>
                      {rows.map(([k, v]) =>
                        v ? (
                          <div key={k} className="text-[11px] text-muted-foreground">
                            {t(k)}：{v}
                          </div>
                        ) : null
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </SubField>
        </>
      )}
    </div>
  )
}
