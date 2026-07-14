import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useI18n } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { Icon } from '../shared/Icon';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { Switch } from '@/src/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/src/components/ui/select';
import {
  DEFAULT_ORBIT,
  syncConfigToDaemon,
  syncMediaProvidersToDaemon,
} from '../../state/config';
import { navigate as navigateRoute } from '../../router';
import type {
  AppConfig,
  OrbitStatusResponse,
  SkillSummary,
} from '../../types';
import {
  fetchConnectors,
  fetchDesignTemplates,
} from '../../providers/registry';

interface OrbitRunStartResponse {
  projectId: string;
  agentRunId: string;
}

export async function persistConfigAndRunOrbit(
  config: AppConfig,
  options?: {
    daemonProviders?: AppConfig['mediaProviders'] | null;
    syncMediaProviders?: boolean;
    locale?: string | null;
  },
): Promise<OrbitRunStartResponse> {
  if (options?.syncMediaProviders !== false) {
    await syncMediaProvidersToDaemon(config.mediaProviders, {
      daemonProviders: options?.daemonProviders,
    });
  }
  await syncConfigToDaemon(config, { throwOnError: true });
  const response = await fetch('/api/orbit/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: options?.locale ?? null }),
  });
  if (!response.ok) throw new Error('Orbit run failed');
  return await response.json() as OrbitRunStartResponse;
}

export function configForManualOrbitRun(config: AppConfig): AppConfig {
  const effectiveTemplateSkillId = config.orbit?.templateSkillId || DEFAULT_ORBIT.templateSkillId || '';
  if (!effectiveTemplateSkillId) return config;
  return {
    ...config,
    orbit: {
      ...(config.orbit ?? DEFAULT_ORBIT),
      templateSkillId: effectiveTemplateSkillId,
    },
  };
}

export function isOrbitRunDisabled(isBusy: boolean, connectedCount: number | null): boolean {
  return isBusy || connectedCount === null || connectedCount === 0;
}

function formatRelative(
  iso: string | undefined | null,
  t: (key: keyof Dict, vars?: Record<string, string | number>) => string,
): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  const absMin = Math.round(Math.abs(diffMs) / 60_000);
  if (absMin < 1) return t('common.justNow');
  if (absMin < 60) return t('common.minutesAgo', { n: absMin });
  const absHr = Math.round(absMin / 60);
  if (absHr < 24) return t('common.hoursAgo', { n: absHr });
  const absDay = Math.round(absHr / 24);
  return t('common.daysAgo', { n: absDay });
}

export function OrbitSection({
  cfg,
  setCfg,
  composioApiKeyConfigured,
  daemonMediaProviders,
  daemonMediaProvidersFetchState,
  onOpenComposioSection,
  onLeaveForOrbitProject,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
  /** Whether the user has already saved a Composio API key. Drives the
   *  Orbit configuration gate's copy/CTA. When false the gate explains
   *  that Orbit needs Composio first; when true (key present, just no
   *  connectors yet) it nudges the user toward the connector catalog. */
  composioApiKeyConfigured: boolean;
  daemonMediaProviders?: AppConfig['mediaProviders'] | null;
  daemonMediaProvidersFetchState?: 'idle' | 'ok' | 'error';
  /** Switch the parent settings dialog to the Connectors (Composio) tab.
   *  Used by the Orbit gate's primary CTA so the user can fix the
   *  prerequisite without leaving the dialog. */
  onOpenComposioSection: () => void;
  /** Called right before navigating to the generated Orbit project so the
   *  parent dialog can persist any unsaved Orbit edits and close itself. */
  onLeaveForOrbitProject: (runConfig: AppConfig) => void;
}) {
  const { locale, t } = useI18n();
  const orbit = cfg.orbit ?? DEFAULT_ORBIT;
  const [status, setStatus] = useState<OrbitStatusResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [legacyLastRunTemplateSkillId, setLegacyLastRunTemplateSkillId] = useState<string | null>(null);
  const legacyLastRunIdentity = status?.lastRun?.id
    ?? `${status?.lastRun?.completedAt ?? ''}:${status?.lastRun?.agentRunId ?? ''}:${status?.lastRun?.markdown ?? ''}`;
  // Orbit templates ship under the renderable design-templates registry after
  // the skills/design-templates split. We fetch on mount and keep three states
  // for graceful UX: `null` = still loading, `[]` = loaded with no Orbit
  // templates available, `SkillSummary[]` = ready. If the daemon is offline
  // the call resolves with [] (see fetchDesignTemplates) so the section never
  // throws — the rest of the Orbit controls keep working.
  const [orbitTemplates, setOrbitTemplates] = useState<SkillSummary[] | null>(null);
  // Connector presence drives the configuration gate at the top of the Orbit
  // tab. We track three states: `null` = still loading (skip rendering the
  // gate so it doesn't flash before data arrives), `0` = no connectors
  // present (gate is shown), `>0` = at least one connected integration
  // (gate is hidden). We only count connectors with `status === 'connected'`
  // because the catalog itself ships hundreds of available rows — what
  // matters for Orbit is whether anything has actually been wired up.
  const [connectedCount, setConnectedCount] = useState<number | null>(null);
  // Once the user clicks Generate we close Settings and navigate away. The ref
  // lets late-arriving handlers no-op without React warnings.
  const isMountedRef = useRef(true);
  useEffect(() => {
    // React Strict Mode replays mount effects in development. Reset the ref on
    // each setup so the synthetic cleanup from the first pass does not leave
    // async Orbit status / connector refreshes permanently thinking the panel
    // has unmounted.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const updateOrbit = (patch: Partial<NonNullable<AppConfig['orbit']>>) => {
    setCfg((curr) => ({
      ...curr,
      orbit: { ...(curr.orbit ?? DEFAULT_ORBIT), ...patch },
    }));
  };

  const refreshStatus = async () => {
    try {
      const response = await fetch('/api/orbit/status');
      if (!response.ok) return;
      if (!isMountedRef.current) return;
      setStatus(await response.json() as OrbitStatusResponse);
    } catch {
      // Daemon may be offline in API-only development; keep local controls usable.
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    if (!status?.running) return undefined;
    const interval = window.setInterval(() => {
      void refreshStatus();
    }, 3000);
    return () => window.clearInterval(interval);
  }, [status?.running]);

  // Fetch the design-template registry once on mount and filter to
  // scenario === 'orbit'. We tolerate fetch failure:
  // fetchDesignTemplates already swallows errors and returns []. The
  // component then transitions from "loading" → "empty" and the rest of the
  // Orbit panel stays fully functional.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const all = await fetchDesignTemplates();
      if (!alive) return;
      const filtered = all.filter((s) => s.scenario === 'orbit');
      // Stable order: featured first (higher number = more featured), then by name.
      filtered.sort((a, b) => {
        const af = a.featured ?? 0;
        const bf = b.featured ?? 0;
        if (af !== bf) return bf - af;
        return a.name.localeCompare(b.name);
      });
      setOrbitTemplates(filtered);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const refreshConnectedCount = useCallback(async () => {
    const list = await fetchConnectors();
    if (!isMountedRef.current) return;
    const connected = list.filter((c) => c.status === 'connected').length;
    setConnectedCount(connected);
  }, []);

  // Fetch the connector catalog on mount to determine whether the Orbit
  // configuration gate should render. fetchConnectors swallows errors and
  // returns []; if the daemon is offline we treat that as "0 connected" and
  // surface the gate so the user has a clear path forward instead of being
  // dropped into a broken Orbit configuration.
  useEffect(() => {
    void refreshConnectedCount();
  }, [refreshConnectedCount]);

  // Connector auth often completes in another window. Re-check when focus
  // returns so the Orbit gate reflects newly connected accounts without
  // requiring the user to close and reopen Settings.
  useEffect(() => {
    const onFocus = () => {
      void refreshConnectedCount();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshConnectedCount]);

  // The id used to drive the prompt template — coalesces a null/empty
  // saved value to the built-in default (DEFAULT_ORBIT.templateSkillId,
  // currently 'orbit-general'). The select no longer offers a "no template"
  // option, so legacy configs that stored null are presented as if they
  // were on the default. Manual runs persist this effective value before
  // launching so the daemon uses the same template the UI displays.
  const effectiveTemplateSkillId = orbit.templateSkillId || DEFAULT_ORBIT.templateSkillId || '';
  const supportsTemplateScopedHistory = status?.lastRunsByTemplate !== undefined;

  useEffect(() => {
    const hasTemplateScopedHistory = Object.keys(status?.lastRunsByTemplate ?? {}).length > 0;
    const hasLegacyUnscopedLastRun = Boolean(status?.lastRun && !status.lastRun.templateSkillId);
    if (!hasLegacyUnscopedLastRun || hasTemplateScopedHistory) {
      setLegacyLastRunTemplateSkillId(null);
      return;
    }
    setLegacyLastRunTemplateSkillId((current) => current ?? (effectiveTemplateSkillId || null));
  }, [effectiveTemplateSkillId, legacyLastRunIdentity, status]);

  const selectedTemplate = useMemo(() => {
    if (!effectiveTemplateSkillId || !orbitTemplates) return null;
    return orbitTemplates.find((s) => s.id === effectiveTemplateSkillId) ?? null;
  }, [effectiveTemplateSkillId, orbitTemplates]);

  const triggerNow = () => {
    if (running) return;
    setRunning(true);
    setNotice(null);

    void (async () => {
      try {
        const runConfig = configForManualOrbitRun(cfg);
        const payload = await persistConfigAndRunOrbit(runConfig, {
          daemonProviders: daemonMediaProviders,
          syncMediaProviders: daemonMediaProvidersFetchState === 'ok',
          locale,
        });
        if (!payload.projectId) throw new Error('Orbit run did not return a project');

        onLeaveForOrbitProject(runConfig);
        navigateRoute({
          kind: 'project',
          projectId: payload.projectId,
          conversationId: null,
          fileName: null,
        });
      } catch {
        if (!isMountedRef.current) return;
        setNotice({
          kind: 'error',
          message: t('settings.orbit.runError'),
        });
      } finally {
        if (!isMountedRef.current) return;
        setRunning(false);
        void refreshStatus();
      }
    })();
  };

  const templateScopedLastRun = effectiveTemplateSkillId
    ? status?.lastRunsByTemplate?.[effectiveTemplateSkillId] ?? null
    : null;
  const hasLegacyUnscopedLastRun = Boolean(
    status?.lastRun
    && !status.lastRun.templateSkillId
    && legacyLastRunTemplateSkillId
    && legacyLastRunTemplateSkillId === effectiveTemplateSkillId,
  );
  const lastRun = supportsTemplateScopedHistory
    ? (templateScopedLastRun ?? (hasLegacyUnscopedLastRun ? status?.lastRun ?? null : null))
    : status?.lastRun ?? null;
  const nextRunLabel = status?.nextRunAt ? new Date(status.nextRunAt).toLocaleString() : null;
  const lastRunAbs = lastRun ? new Date(lastRun.completedAt).toLocaleString() : null;
  const lastRunRel = formatRelative(lastRun?.completedAt, t);
  const liveArtifactHref = lastRun?.artifactId && lastRun?.artifactProjectId
    ? `/api/live-artifacts/${encodeURIComponent(lastRun.artifactId)}/preview?projectId=${encodeURIComponent(lastRun.artifactProjectId)}`
    : null;
  const isBusy = running || Boolean(status?.running);

  const copyMarkdown = async () => {
    if (!lastRun?.markdown) return;
    try {
      await navigator.clipboard.writeText(lastRun.markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access may be denied in some browsing contexts; silently skip.
    }
  };

  // Proportional widths for the run-result meter. We avoid showing 0-width
  // segments by falling back to a tiny sliver when a category has hits but
  // rounds to 0% — the visual "something happened here" cue matters more
  // than exact proportion at low counts.
  const total = lastRun
    ? Math.max(
        lastRun.connectorsSucceeded + lastRun.connectorsSkipped + lastRun.connectorsFailed,
        1,
      )
    : 1;
  const segPct = (n: number) => {
    if (!lastRun || n <= 0) return 0;
    const pct = (n / total) * 100;
    return pct < 3 ? 3 : pct;
  };
  const meterSucceeded = lastRun ? segPct(lastRun.connectorsSucceeded) : 0;
  const meterSkipped = lastRun ? segPct(lastRun.connectorsSkipped) : 0;
  const meterFailed = lastRun ? segPct(lastRun.connectorsFailed) : 0;

  const automationState = orbit.enabled ? 'active' : 'off';
  const triggerLabel = lastRun?.trigger === 'manual'
    ? t('settings.orbit.triggerManual')
    : t('settings.orbit.triggerScheduled');

  // Surface the configuration gate when we know for sure that the user has
  // no connected integrations. While `connectedCount === null` we are still
  // loading and intentionally hide the gate so the panel doesn't flash an
  // empty-state warning before data arrives. Once resolved, `0` triggers
  // the gate. The gate's copy + CTA branch on whether a Composio API key
  // has been saved: missing key → push toward configuring Composio first;
  // key present, no connections → push toward picking an integration.
  const showConfigGate = connectedCount === 0;
  const gateBodyKey = composioApiKeyConfigured
    ? 'settings.orbit.gateBody'
    : 'settings.orbit.gateBodyNoKey';
  const gateActionKey = composioApiKeyConfigured
    ? 'settings.orbit.gateAction'
    : 'settings.orbit.gateActionNoKey';
  // Disable the hero's "Run it now" CTA while the gate is visible: running
  // without any connector wired up surfaces a cryptic backend error. We
  // keep the button mounted so layout stays stable; a tooltip and the
  // adjacent gate make the disabled reason obvious.
  const runDisabled = isOrbitRunDisabled(isBusy, connectedCount);
  const runDisabledTitle = showConfigGate
    ? t('settings.orbit.gateTitle')
    : t('settings.orbit.runTitle');

  // When the configuration gate is visible (no connector available) we
  // also lock down every secondary control on the panel — schedule
  // toggle, time input, prompt template select, and the missing-template
  // Reset button. Touching any of them before a connector exists either
  // produces a no-op or persists state the user can't actually exercise.
  // Locking them keeps the panel honest, prevents "ghost configuration",
  // and reinforces the gate's CTA as the only meaningful next step.
  const controlsLocked = showConfigGate;
  const controlsLockedHint = controlsLocked
    ? t('settings.orbit.controlsLockedHint')
    : undefined;

  return (
    <section className="settings-section orbit-section">
      {/* ---------- 1. HEADER ZONE ---------- */}
      <header className="orbit-hero">
        <div className="orbit-hero-mark" aria-hidden="true">
          <Icon name="refresh" size={20} />
        </div>
        <div className="orbit-hero-copy">
          <span className="orbit-hero-eyebrow">{t('settings.orbit.eyebrow')}</span>
          <h3 className="orbit-hero-title">{t('settings.orbit.title')}</h3>
          <p className="orbit-hero-lede">
            {t('settings.orbit.lede')}
          </p>
        </div>
        <div className="orbit-hero-actions">
          <span
            className={`orbit-state-pill orbit-state-${automationState}`}
            title={
              orbit.enabled
                ? t('settings.orbit.statusOnTitle')
                : t('settings.orbit.statusOffTitle')
            }
          >
            <span className="orbit-state-dot" aria-hidden="true" />
            {orbit.enabled
              ? t('settings.orbit.statusActive')
              : t('settings.orbit.statusOff')}
          </span>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => void triggerNow()}
            disabled={runDisabled}
            title={runDisabledTitle}
          >
            {isBusy ? (
              <>
                <Icon name="spinner" size={14} className="icon-spin" />
                <span>{t('settings.orbit.running')}</span>
              </>
            ) : (
              <>
                <Icon name="play" size={14} />
                <span>{t('settings.orbit.runOpen')}</span>
              </>
            )}
          </Button>
        </div>
      </header>

      {/* ---------- 1b. CONFIGURATION GATE ----------
          Renders when no connected integrations are present. Orbit's job is
          to summarize connector activity, so without any wired-up
          connector there is literally nothing for it to report on.
          The gate uses the same orbit-themed accent surface as the
          automation card to feel like a first-class part of the panel
          rather than an inline error, and routes the user back to the
          Connectors tab inside the same settings dialog (no navigation
          off the page). The copy/CTA branch on whether a Composio API
          key has been saved already, because the prerequisite chain is:
          API key → connector connected → Orbit can run. */}
      {showConfigGate ? (
        <div
          className="orbit-config-gate"
          role="region"
          aria-label={t('settings.orbit.gateAriaLabel')}
          data-testid="orbit-config-gate"
        >
          <div className="orbit-config-gate-glyph" aria-hidden="true">
            <span className="orbit-config-gate-ring orbit-config-gate-ring-outer" />
            <span className="orbit-config-gate-ring orbit-config-gate-ring-inner" />
            <span className="orbit-config-gate-icon">
              <Icon name="link" size={16} />
            </span>
          </div>
          <div className="orbit-config-gate-copy">
            <span className="orbit-config-gate-eyebrow">
              {t('settings.orbit.gateEyebrow')}
            </span>
            <h4 className="orbit-config-gate-title">
              {t('settings.orbit.gateTitle')}
            </h4>
            <p className="orbit-config-gate-body">
              {t(gateBodyKey)}
            </p>
          </div>
          <div className="orbit-config-gate-actions">
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={onOpenComposioSection}
              data-testid="orbit-config-gate-action"
            >
              <span>{t(gateActionKey)}</span>
              <Icon name="chevron-right" size={13} />
            </Button>
          </div>
        </div>
      ) : null}

      {/* ---------- 2. AUTOMATION CARD ----------
          Single unified configuration surface for Orbit: the daily-summary
          switch, the run-time schedule, and the prompt-template selection
          all live inside one card, separated by hairline dividers. The
          template row was previously a parallel card; folding it in here
          collapses the "two paired panels" pattern into one cohesive
          stack so users configure Orbit in one place. */}
      <div
        className={`orbit-automation${orbit.enabled ? ' is-on' : ''}${selectedTemplate ? ' has-template' : ''}${controlsLocked ? ' is-locked' : ''}`}
        aria-busy={orbitTemplates === null || undefined}
        aria-disabled={controlsLocked || undefined}
        data-testid="orbit-automation-card"
      >
        {controlsLocked ? (
          <div
            className="orbit-automation-lock-banner"
            role="note"
            aria-label={t('settings.orbit.controlsLockedHint')}
          >
            <Icon name="link" size={12} />
            <span className="orbit-automation-lock-badge">
              {t('settings.orbit.controlsLockedBadge')}
            </span>
            <span className="orbit-automation-lock-text">
              {t('settings.orbit.controlsLockedHint')}
            </span>
          </div>
        ) : null}
        <div className="orbit-automation-row orbit-automation-switch-row">
          <div className="orbit-automation-label">
            <span className="orbit-automation-title">{t('settings.orbit.dailySummaryTitle')}</span>
            <span className="orbit-automation-sub">
              {t('settings.orbit.dailySummarySub')}
            </span>
          </div>
          <label
            className={`flex items-center gap-2.5 text-xs font-semibold tracking-[0.02em] ${
              controlsLocked ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'
            } ${orbit.enabled ? 'text-primary' : 'text-muted-foreground'}`}
            title={controlsLockedHint}
          >
            <Switch
              aria-label={t('settings.orbit.dailySummaryTitle')}
              checked={orbit.enabled}
              disabled={controlsLocked}
              onCheckedChange={(next) => updateOrbit({ enabled: next })}
            />
            <span className="min-w-[22px] text-right tabular-nums">
              {orbit.enabled ? t('settings.orbit.on') : t('settings.orbit.off')}
            </span>
          </label>
        </div>

        <div className="orbit-automation-divider" aria-hidden="true" />

        <div className="orbit-automation-row orbit-automation-schedule-row">
          <div className="orbit-automation-label">
            <span className="orbit-automation-title">{t('settings.orbit.runTimeTitle')}</span>
            <span className="orbit-automation-sub">
              {t('settings.orbit.runTimeSub')}
            </span>
          </div>
          <div className="orbit-automation-schedule-controls">
            <Input
              type="time"
              className="w-[140px] text-center tabular-nums tracking-[0.02em]"
              value={orbit.time}
              onChange={(e) => updateOrbit({ time: e.target.value || DEFAULT_ORBIT.time })}
              aria-label={t('settings.orbit.runTimeAria')}
              aria-disabled={controlsLocked || undefined}
              disabled={controlsLocked}
              title={controlsLockedHint}
            />
            <div className="orbit-next-run" aria-live="polite">
              {orbit.enabled ? (
                nextRunLabel ? (
                  <>
                    <span className="orbit-next-run-label">{t('settings.orbit.nextRun')}</span>
                    <span className="orbit-next-run-value">{nextRunLabel}</span>
                  </>
                ) : (
                  <>
                    <span className="orbit-next-run-label">{t('settings.orbit.nextRun')}</span>
                    <span className="orbit-next-run-value muted">{t('settings.orbit.nextRunScheduledAfterSave')}</span>
                  </>
                )
              ) : (
                <>
                  <span className="orbit-next-run-label">{t('settings.orbit.schedule')}</span>
                  <span className="orbit-next-run-value muted">{t('settings.orbit.pausedManualOnly')}</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="orbit-automation-divider" aria-hidden="true" />

        {/* Prompt template row — folded into the automation card so users
            configure schedule and prompt steering in one place. The select
            picks which scenario === 'orbit' skill template gets injected
            into the Orbit prompt. There is no separate preview slab below
            the select: the dropdown's option label is the source of
            truth for the active template, and each option carries the
            skill description as a `title` tooltip. The only state that
            still needs explicit surfacing is "saved id no longer in the
            registry" — that warning replaces the row's normal sub-copy
            and inlines a Reset action when the missing id differs from
            the default. */}
        <div className="orbit-automation-row orbit-automation-template-row">
          <div className="orbit-automation-label">
            {/* Title aligns with the other automation rows ("Daily summary",
                "Run time") — a single short label. */}
            <span className="orbit-automation-title">{t('settings.orbit.templateTitle')}</span>
            {orbitTemplates &&
            effectiveTemplateSkillId &&
            !orbitTemplates.some((s) => s.id === effectiveTemplateSkillId) ? (
              // The saved skill id is no longer installed — surface a
              // soft warning right under the title, with an inline Reset
              // action that pushes back to DEFAULT_ORBIT (currently
              // `orbit-general`). Reset is hidden when the missing id
              // already equals the default, so the control never loops
              // on itself.
              <span
                className="orbit-automation-sub orbit-automation-sub-warning"
                role="status"
              >
                <Icon name="history" size={11} />
                <span>
                  {t('settings.orbit.templateMissing', { id: effectiveTemplateSkillId })}{' '}
                  {orbitTemplates.length === 0
                    ? t('settings.orbit.templateMissingInstall')
                    : t('settings.orbit.templateMissingPickAnother')}
                </span>
                {DEFAULT_ORBIT.templateSkillId &&
                effectiveTemplateSkillId !== DEFAULT_ORBIT.templateSkillId ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="ml-auto"
                    disabled={controlsLocked}
                    aria-disabled={controlsLocked || undefined}
                    onClick={() =>
                      updateOrbit({ templateSkillId: DEFAULT_ORBIT.templateSkillId })
                    }
                    title={
                      controlsLocked
                        ? t('settings.orbit.controlsLockedHint')
                        : t('settings.orbit.templateResetTitle', {
                            id: DEFAULT_ORBIT.templateSkillId,
                          })
                    }
                  >
                    {t('settings.orbit.templateReset')}
                  </Button>
                ) : null}
              </span>
            ) : (
              <span className="orbit-automation-sub">
                {t('settings.orbit.templateHelp')}
              </span>
            )}
          </div>
          <div className="orbit-automation-template-controls">
            {/* Radix Select provides its own chevron + portal listbox, so the
                former absolute-positioned chevron and the wrapper divs are
                gone. The trigger stretches to fill the column via w-full.
                onChange(e)=>e.target.value became onValueChange(next). */}
            <Select
              value={effectiveTemplateSkillId || undefined}
              disabled={orbitTemplates === null || controlsLocked}
              onValueChange={(next) => {
                // Guard against an empty value making it through — only
                // persist real skill ids.
                if (!next) return;
                updateOrbit({ templateSkillId: next });
              }}
            >
              <SelectTrigger
                id="orbit-template-select"
                size="sm"
                className="w-full"
                aria-label={t('settings.orbit.templateAria')}
                aria-disabled={controlsLocked || undefined}
                title={controlsLockedHint}
              >
                {/* While the skill registry is still loading (orbitTemplates
                    === null) no item matches, so SelectValue falls back to
                    this loading placeholder. Once resolved the selected
                    template's name shows. */}
                <SelectValue placeholder={t('settings.orbit.templatesLoading')} />
              </SelectTrigger>
              <SelectContent>
                {/* If the saved id no longer exists in the registry, surface
                    it as its own (disabled) item so the controlled Select
                    still renders a label for the current value instead of
                    silently showing the loading placeholder. The inline
                    warning above offers the explicit Reset action. */}
                {orbitTemplates &&
                effectiveTemplateSkillId &&
                !orbitTemplates.some((s) => s.id === effectiveTemplateSkillId) ? (
                  <SelectItem value={effectiveTemplateSkillId} disabled>
                    {t('settings.orbit.templateMissingOption', {
                      id: effectiveTemplateSkillId,
                    })}
                  </SelectItem>
                ) : null}
                {orbitTemplates && orbitTemplates.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>{t('settings.orbit.templatesOptgroup')}</SelectLabel>
                    {orbitTemplates.map((s) => (
                      <SelectItem
                        key={s.id}
                        value={s.id}
                        // Browser-native tooltip — surfaces the skill
                        // description on hover without needing a
                        // dedicated preview panel.
                        title={s.description ?? undefined}
                      >
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* ---------- 4. RUN RESULT / RECEIPT ---------- */}
      {/* When there is no last run yet, the "receipt" metaphor doesn't fit —
          there's nothing to report. We swap to a first-run prompt with its
          own composed layout (orbit-glyph · copy · inline CTA) so the empty
          state feels intentional and rhythmically balanced with the hero,
          automation card, and (eventual) artifact strip. */}
      {lastRun ? (
        <div className="orbit-receipt">
          <div className="orbit-receipt-head">
            <div className="orbit-receipt-head-left">
              <span className="orbit-receipt-eyebrow">
                <Icon name="history" size={12} />
                {t('settings.orbit.lastRun')}
              </span>
              <span
                className="orbit-receipt-timestamp"
                title={lastRunAbs ?? undefined}
              >
                {lastRunRel ?? lastRunAbs}
              </span>
            </div>
            <span
              className={`orbit-trigger-pill orbit-trigger-${lastRun.trigger ?? 'scheduled'}`}
            >
              {triggerLabel}
            </span>
          </div>

          {notice ? (
            <div
              className={`orbit-inline-notice is-${notice.kind}`}
              role={notice.kind === 'error' ? 'alert' : 'status'}
            >
              <Icon name={notice.kind === 'error' ? 'close' : 'check'} size={12} />
              <span>{notice.message}</span>
            </div>
          ) : null}

          <div
            className="orbit-meter"
            role="img"
            aria-label={t('settings.orbit.meterAria', {
              succeeded: lastRun.connectorsSucceeded,
              skipped: lastRun.connectorsSkipped,
              failed: lastRun.connectorsFailed,
              checked: lastRun.connectorsChecked,
            })}
          >
            {meterSucceeded > 0 ? (
              <span
                className="orbit-meter-seg is-succeeded"
                style={{ width: `${meterSucceeded}%` }}
              />
            ) : null}
            {meterSkipped > 0 ? (
              <span
                className="orbit-meter-seg is-skipped"
                style={{ width: `${meterSkipped}%` }}
              />
            ) : null}
            {meterFailed > 0 ? (
              <span
                className="orbit-meter-seg is-failed"
                style={{ width: `${meterFailed}%` }}
              />
            ) : null}
            {meterSucceeded + meterSkipped + meterFailed === 0 ? (
              <span className="orbit-meter-seg is-empty" />
            ) : null}
          </div>
          <dl className="orbit-counts">
            <div className="orbit-count">
              <dt>{t('settings.orbit.countChecked')}</dt>
              <dd>{lastRun.connectorsChecked}</dd>
            </div>
            <div className="orbit-count is-succeeded">
              <dt>{t('settings.orbit.countSucceeded')}</dt>
              <dd>{lastRun.connectorsSucceeded}</dd>
            </div>
            <div className="orbit-count is-skipped">
              <dt>{t('settings.orbit.countSkipped')}</dt>
              <dd>{lastRun.connectorsSkipped}</dd>
            </div>
            <div className="orbit-count is-failed">
              <dt>{t('settings.orbit.countFailed')}</dt>
              <dd>{lastRun.connectorsFailed}</dd>
            </div>
          </dl>
        </div>
      ) : notice ? (
        <div
          className={`orbit-inline-notice is-${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          <Icon name={notice.kind === 'error' ? 'close' : 'check'} size={12} />
          <span>{notice.message}</span>
        </div>
      ) : null}

      {/* ---------- 5. LIVE ARTIFACT STRIP ---------- */}
      {lastRun ? (
        <div
          className={`orbit-artifact-strip${liveArtifactHref ? '' : ' is-legacy'}`}
        >
          <div className="orbit-artifact-strip-icon" aria-hidden="true">
            <Icon name="file-code" size={18} />
          </div>
          <div className="orbit-artifact-strip-copy">
            <span className="orbit-artifact-strip-kicker">
              {liveArtifactHref
                ? t('settings.orbit.artifactKickerLive')
                : t('settings.orbit.artifactKickerLegacy')}
            </span>
            <span className="orbit-artifact-strip-title">
              {t('settings.orbit.artifactTitle')}
            </span>
            <span className="orbit-artifact-strip-meta">
              {liveArtifactHref
                ? t('settings.orbit.artifactMetaLive')
                : t('settings.orbit.artifactMetaLegacy')}
            </span>
          </div>
          <div className="orbit-artifact-strip-actions">
            {lastRun.markdown ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void copyMarkdown()}
                title={t('settings.orbit.copyMarkdownTitle')}
              >
                {copied ? (
                  <>
                    <Icon name="check" size={13} />
                    <span>{t('settings.orbit.copied')}</span>
                  </>
                ) : (
                  <>
                    <Icon name="copy" size={13} />
                    <span>{t('settings.orbit.copy')}</span>
                  </>
                )}
              </Button>
            ) : null}
            {liveArtifactHref ? (
              <a
                className="orbit-artifact-open"
                href={liveArtifactHref}
                target="_blank"
                rel="noreferrer"
              >
                <span>{t('settings.orbit.openArtifact')}</span>
                <Icon name="external-link" size={13} />
              </a>
            ) : null}
          </div>
          {lastRun.markdown ? (
            <details className="orbit-artifact-peek">
              <summary>
                <Icon name="chevron-right" size={12} />
                <span>{t('settings.orbit.sourceMarkdown')}</span>
              </summary>
              <pre>{lastRun.markdown}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
