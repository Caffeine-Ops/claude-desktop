import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

/**
 * CanvasConfirm
 * -------------
 * Native React replication of the ppt-master confirm_ui Eight-Confirmations
 * page (skills/ppt-master/scripts/confirm_ui/static/app.js), rendered inside
 * the 「问题」canvas tab instead of iframing the Flask page. It fetches the
 * server's own `/api/catalogs` + `/api/recommendations`, lets the user pick,
 * and POSTs back to `/api/confirm` — the SAME data contract, so the server's
 * `--wait-only` loop (which only watches result.json) is unchanged. The Flask
 * server stays running exactly as before; we just paint its UI natively.
 *
 * `baseUrl` is the server's real (possibly auto-advanced) origin, resolved by
 * usePreviewServer from the launch command's stdout — never guessed. All fetch
 * calls MUST be absolute against it: the original app.js used relative paths
 * because it ran ON that origin; we run on the app's origin, so a relative
 * `/api/confirm` would hit the app, not the Flask server, and the confirm
 * would silently never land (the exact "spinner forever" failure class from
 * the iframe-era bug). CSP `connect-src http://localhost:*` already permits the
 * cross-origin fetch (see renderer/index.html).
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
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

export function CanvasConfirm({ baseUrl }: { baseUrl: string }): React.JSX.Element {
  const [lang, setLang] = useState<Lang>(detectLang)
  const t = useMemo(() => makeT(lang), [lang])

  const [cat, setCat] = useState<Catalogs | null>(null)
  const [rec, setRec] = useState<Recommendations | null>(null)
  const [stage, setStage] = useState<Stage>(1)
  const [state, setState] = useState<ConfirmState>({})
  const [phase, setPhase] = useState<'loading' | 'ready' | 'deriving' | 'confirmed' | 'error'>(
    'loading'
  )
  const [statusText, setStatusText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // Cancels an in-flight tier2 poll loop when the component unmounts.
  const pollAlive = useRef(true)

  const api = useCallback((path: string) => baseUrl.replace(/\/$/, '') + path, [baseUrl])

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

  // ── boot: fetch catalogs + recommendations (with startup retry) ──────────
  // usePreviewServer surfaces the server's URL the instant its stdout prints it
  // — which is BEFORE the detached Flask child has actually bound the port (the
  // launch / wait split: URL first, listen a beat later). So the very first
  // fetch can hit ERR_CONNECTION_REFUSED on a server that is moments from being
  // up. A single attempt would then strand the tab in an error state forever,
  // even though the server comes alive a second later. So we retry on failure
  // with a fixed backoff across the cold-start window before giving up. (curl
  // confirms the server, once bound, returns 200 + CORS — see the after_request
  // hook in confirm_ui/server.py.)
  useEffect(() => {
    pollAlive.current = true
    let cancelled = false
    const MAX_ATTEMPTS = 20 // ~16s at 800ms — covers a Flask cold start
    const RETRY_MS = 800

    const tryBoot = async (): Promise<boolean> => {
      // recommendations.json is the hard dependency; catalogs has a /static
      // fallback. A throw here (incl. ERR_CONNECTION_REFUSED → TypeError) means
      // "not ready yet" → caller retries.
      const recRes = await fetch(api('/api/recommendations'), { cache: 'no-store' }).then((r) => {
        if (!r.ok) throw new Error('load failed')
        return r.json()
      })
      const catRes = await fetch(api('/api/catalogs'))
        .then((r) => {
          if (r.ok) return r.json()
          throw new Error('no api')
        })
        .catch(() => fetch(api('/static/catalogs.json')).then((r) => r.json()))
      if (cancelled) return true
      const c = catRes as Catalogs
      const r = recRes as Recommendations
      // recommendations.json may pin a language; honor it only if the user
      // hasn't explicitly chosen one (no localStorage), matching app.js.
      // `effLang` is the language that will actually be in effect after this
      // boot — seed names with it (setLang is async; reading `lang` here would
      // use the stale value and the recommended card could miss highlight).
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
    // baseUrl changing means a different server → re-boot. lang/t excluded on
    // purpose: a language toggle must not re-fetch or reset selections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl])

  // ── tier-1 submit → deriving → poll for tier-2 ───────────────────────────
  const pollForTier2 = useCallback(() => {
    const tick = (): void => {
      if (!pollAlive.current) return
      fetch(api('/api/recommendations'), { cache: 'no-store' })
        .then((r) => {
          if (!r.ok) throw new Error('poll failed')
          return r.json()
        })
        .then((data) => {
          if (!pollAlive.current) return
          if (data && data.tier === 2) {
            // enterTier2: re-read realization fields, preserve tier-1 STATE.
            setRec(data)
            setState((prev) => ({ ...prev, ...seedTier2(cat as Catalogs, data, prev, lang) }))
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
  }, [api, cat, seedTier2, lang])

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
    fetch(api('/api/confirm'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then((r) => {
        if (!r.ok) throw new Error('tier1 failed')
        setPhase('deriving')
        setSubmitting(false)
        pollForTier2()
      })
      .catch(() => {
        setSubmitting(false)
        setStatusText(t('error_retry'))
      })
  }, [api, cat, state, pollForTier2, t])

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
    fetch(api('/api/confirm'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then((r) => {
        if (!r.ok) throw new Error('confirm failed')
        setPhase('confirmed')
        // fire-and-forget shutdown; server may already be exiting.
        fetch(api('/api/shutdown'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'confirmed' })
        }).catch(() => {
          /* server gone — fine */
        })
      })
      .catch(() => {
        setSubmitting(false)
        setStatusText(t('error_retry'))
      })
  }, [api, cat, rec, state, t])

  const onPrimary = useCallback(() => {
    if (stage === 1) submitTier1()
    else submitFinal()
  }, [stage, submitTier1, submitFinal])

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

  // ── render ───────────────────────────────────────────────────────────────
  if (phase === 'confirmed') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 py-10 text-center">
        <div className="text-[22px] font-bold text-emerald-600">{t('confirmed_title')}</div>
        <div className="max-w-md text-[13px] text-muted-foreground">{t('confirmed_hint')}</div>
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
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-10 text-[13px] text-muted-foreground">
        {t('deriving')}
      </div>
    )
  }

  const showAnchors = stage === 1 || stage === 'all'
  const showRealization = stage === 2 || stage === 'all'
  const primaryLabel = stage === 1 ? t('btn_next') : t('btn_confirm')
  // Section numbering runs 1..N within the rendered tier (matches app.js).
  let secNum = 0
  const next = (): number => (secNum += 1)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* topbar */}
      <div className="flex shrink-0 items-start justify-between gap-3 px-6 pb-3 pt-5">
        <div>
          <h2 className="text-[18px] font-bold text-foreground">{t('page_title')}</h2>
          <p className="mt-1 text-[12px] text-muted-foreground">{t('topbar_hint')}</p>
        </div>
        <button
          type="button"
          onClick={toggleLang}
          title={t('lang_toggle_title')}
          className="shrink-0 rounded-md border border-border bg-card/60 px-2.5 py-1 text-[12px] font-medium text-foreground transition hover:bg-muted"
        >
          {lang === 'zh' ? 'EN' : '中'}
        </button>
      </div>

      {/* scrollable sections */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        {showAnchors && (
          <>
            <Section num={next()} title={t('sec_canvas')}>
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
                baseUrl={baseUrl}
                lang={lang}
                t={t}
              />
            </Section>

            <Section num={next()} title={t('sec_audience')}>
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
                  baseUrl={baseUrl}
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

            <Section num={next()} title={t('sec_color')}>
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

            <Section num={next()} title={t('sec_type')}>
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

            <Section num={next()} title={t('sec_images')}>
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
      </div>

      {/* action bar */}
      <div
        className="flex shrink-0 items-center justify-end gap-3 px-6 py-3"
        style={{ boxShadow: 'inset 0 1px 0 rgba(0,0,0,0.06)' }}
      >
        {statusText && <span className="mr-auto text-[12px] text-muted-foreground">{statusText}</span>}
        <button
          type="button"
          disabled={submitting}
          onClick={onPrimary}
          className="rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-accent-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {primaryLabel}
        </button>
      </div>
    </div>
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
  return (
    <div className="border-b border-border/40 py-4 last:border-b-0">
      <div className="mb-3 flex items-center gap-2">
        <span className="inline-flex size-[20px] shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-semibold text-accent">
          {num}
        </span>
        <span className="text-[14px] font-semibold text-foreground">{title}</span>
        {note && <span className="text-[11px] text-muted-foreground">{note}</span>}
      </div>
      {children}
    </div>
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

  const chip = (o: CatalogOption): React.JSX.Element => {
    let label = optionLabel(o, lang)
    if (o.dim) label += ' · ' + o.dim
    const desc = optionDesc(o, lang)
    if (desc) label += (lang === 'zh' ? '：' : ' — ') + desc
    const spec = specById[o.id]
    if (spec && spec.note) label += ' · ' + spec.note
    const selected = !isCustom && o.id === cur
    const recommended = spec ? true : !hasSpectrum && o.id === recommendedId
    return (
      <button
        key={o.id}
        type="button"
        onClick={() => onChange(o.id)}
        className={
          'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors ' +
          (selected
            ? 'border-accent bg-accent/[0.12] text-accent'
            : 'border-border bg-card/40 text-foreground hover:bg-muted')
        }
      >
        <span>{label}</span>
        {recommended && (
          <span className="shrink-0 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
            ★ {spec ? spec.tag || t('recommended') : t('recommended')}
          </span>
        )}
      </button>
    )
  }

  const customChip = (): React.JSX.Element => {
    const recommended = !!recommendedId && ids.indexOf(recommendedId) === -1
    return (
      <button
        key="__custom__"
        type="button"
        onClick={() => onChange(customText || '')}
        className={
          'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors ' +
          (isCustom
            ? 'border-accent bg-accent/[0.12] text-accent'
            : 'border-border bg-card/40 text-foreground hover:bg-muted')
        }
      >
        <span>{t('custom')}</span>
        {recommended && (
          <span className="shrink-0 rounded-full bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
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
 * Previews are static PNGs served by the Flask server from
 * static/style-previews/<id>.png; the <img> loads cross-origin against the same
 * `baseUrl` the fetch calls use (CSP img-src + the server's CORS hook both
 * already permit it). A missing/failed image degrades to a styled placeholder
 * rather than a broken-image glyph, so a partial preview set never breaks layout.
 */
function VisualStyleField({
  list,
  recommendedId,
  value,
  onChange,
  spectrum,
  baseUrl,
  lang,
  t
}: {
  list: CatalogOption[] | undefined
  recommendedId: string | undefined
  value: string | undefined
  onChange: (v: string) => void
  spectrum?: SpectrumEntry[]
  baseUrl: string
  lang: Lang
  t: (k: string) => string
}): React.JSX.Element {
  const flat = flattenCatalog(list)
  const ids = flat.map((o) => o.id)
  const grouped = isGrouped(list)
  const previewBase = useMemo(() => baseUrl.replace(/\/$/, '') + '/static/style-previews/', [baseUrl])

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
  const [customText, setCustomText] = useState(isCustom && cur ? cur : '')

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
        src={previewBase + o.id + '.jpg'}
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
            : 'border-border bg-card/40 text-muted-foreground hover:bg-muted')
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
 *  recommendation badge. The image falls back to a labeled placeholder on load
 *  error so a missing PNG degrades gracefully instead of showing a broken glyph. */
function StyleCard({
  src,
  label,
  note,
  selected,
  badge,
  onClick
}: {
  src: string
  label: string
  note?: string
  selected: boolean
  badge?: string
  onClick: () => void
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      title={note || label}
      className={
        'group flex flex-col overflow-hidden rounded-lg border text-left transition-colors ' +
        (selected ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50')
      }
    >
      <div className="relative aspect-[16/10] w-full overflow-hidden bg-muted">
        {failed ? (
          <div className="flex size-full items-center justify-center px-2 text-center text-[11px] text-muted-foreground">
            {label}
          </div>
        ) : (
          <img
            src={src}
            alt={label}
            loading="lazy"
            draggable={false}
            onError={() => setFailed(true)}
            className="size-full object-cover"
          />
        )}
        {badge && (
          <span className="absolute left-1.5 top-1.5 rounded-full bg-amber-400/90 px-1.5 py-0.5 text-[10px] font-medium text-amber-950 shadow-sm">
            {badge}
          </span>
        )}
      </div>
      <div
        className={
          'flex flex-col gap-0.5 px-2 py-1.5 ' + (selected ? 'bg-accent/[0.08]' : 'bg-card/40')
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
 * Previews are static PNGs the Flask server serves from
 * static/canvas-previews/<id>.png; loaded cross-origin against `baseUrl` (CSP
 * img-src + the server CORS hook already permit it), with a graceful fallback to
 * the dim text when an image is missing.
 */
function CanvasField({
  list,
  recommendedId,
  value,
  onChange,
  allowCustom,
  baseUrl,
  lang,
  t
}: {
  list: CatalogOption[] | undefined
  recommendedId: string | undefined
  value: string | undefined
  onChange: (v: string) => void
  allowCustom?: boolean
  baseUrl: string
  lang: Lang
  t: (k: string) => string
}): React.JSX.Element {
  const flat = flattenCatalog(list)
  const ids = flat.map((o) => o.id)
  const previewBase = useMemo(() => baseUrl.replace(/\/$/, '') + '/static/canvas-previews/', [baseUrl])

  const isCustom = value != null && value !== '' && ids.indexOf(value) === -1
  const [customText, setCustomText] = useState(isCustom && value ? value : '')

  const card = (o: CatalogOption): React.JSX.Element => {
    const selected = !isCustom && o.id === value
    const recommended = o.id === recommendedId
    return (
      <CanvasCard
        key={o.id}
        src={previewBase + o.id + '.jpg'}
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
          : 'border-border bg-card/40 text-muted-foreground hover:bg-muted')
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
  src,
  label,
  dim,
  use,
  selected,
  recommended,
  recommendedLabel,
  onClick
}: {
  src: string
  label: string
  dim?: string
  use?: string
  selected: boolean
  recommended: boolean
  recommendedLabel: string
  onClick: () => void
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      onClick={onClick}
      title={use || label}
      className={
        'flex flex-col overflow-hidden rounded-xl border text-left transition-colors ' +
        (selected ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50')
      }
    >
      <div
        className={
          'relative flex h-[112px] items-center justify-center p-3 ' +
          (selected ? 'bg-accent/[0.08]' : 'bg-card/40')
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
          {failed ? (
            <div className="flex size-full items-center justify-center text-[10px] text-muted-foreground">
              {dim}
            </div>
          ) : (
            <img
              src={src}
              alt={label}
              loading="lazy"
              draggable={false}
              onError={() => setFailed(true)}
              className="size-full object-cover"
            />
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
                'flex flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors ' +
                (selected ? 'border-accent bg-accent/[0.08]' : 'border-border bg-card/40 hover:bg-muted')
              }
            >
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
              ? 'border-accent bg-accent/[0.08] text-accent'
              : 'border-dashed border-border bg-card/40 text-muted-foreground hover:bg-muted')
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
                'flex flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors ' +
                (selected ? 'border-accent bg-accent/[0.08]' : 'border-border bg-card/40 hover:bg-muted')
              }
            >
              <div className="flex flex-col gap-0.5">
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
              ? 'border-accent bg-accent/[0.08] text-accent'
              : 'border-dashed border-border bg-card/40 text-muted-foreground hover:bg-muted')
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
                        'flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors ' +
                        (selected ? 'border-accent bg-accent/[0.08]' : 'border-border bg-card/40 hover:bg-muted')
                      }
                    >
                      <div className="flex flex-col gap-0.5">
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
