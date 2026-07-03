import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useAnalytics } from '../../analytics/provider';
import { trackSettingsMediaProvidersClick } from '../../analytics/events';
import { useI18n } from '../../i18n';
import { Icon } from '../shared/Icon';
import {
  isStoredMediaProviderEntryEmpty,
  isStoredMediaProviderEntryPresent,
  mergeDaemonMediaProviders,
} from '../../state/config';
import { MEDIA_PROVIDERS } from '../../media/models';
import type { MediaProvider } from '../../media/models';
import { XaiOAuthControl } from '../settings/XaiOAuthControl';
import type { AppConfig } from '../../types';
import { sanitizeHttpsUrl } from './settingsHelpers';

export function MediaProvidersSection({
  cfg,
  setCfg,
  mediaProvidersNotice,
  onReloadMediaProviders,
  pendingLocalProviderIds,
  onChange,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
  mediaProvidersNotice?: string | null;
  onReloadMediaProviders?: () => Promise<AppConfig['mediaProviders'] | null>;
  pendingLocalProviderIds: ReadonlySet<string>;
  onChange: (providerId: string) => void;
}) {
  const { t } = useI18n();
  const analytics = useAnalytics();
  const [reloadRunning, setReloadRunning] = useState(false);
  const [reloadNotice, setReloadNotice] = useState<{ kind: 'error' | 'success'; message: string } | null>(null);
  const [visibleApiKeys, setVisibleApiKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  useEffect(() => {
    setVisibleApiKeys((current) => {
      const next = new Set<string>();
      for (const providerId of current) {
        const apiKey = cfg.mediaProviders?.[providerId]?.apiKey ?? '';
        if (apiKey.trim()) next.add(providerId);
      }
      return next.size === current.size ? current : next;
    });
  }, [cfg.mediaProviders]);
  const visibleProviders = MEDIA_PROVIDERS.filter(
    (p) => p.settingsVisible !== false,
  );
  // Split the catalog into two surfaces:
  //   - "Available" — daemon ships a real client, user can paste a key
  //     and it works. Rendered as full editable cards.
  //   - "Coming soon" — listed for transparency / roadmap signaling but
  //     the daemon has no client yet, so the form fields would be
  //     disabled placeholders. Hiding them behind a <details> keeps the
  //     primary list focused (was 16 cards, now 8) without dropping the
  //     informational value.
  const availableProviders = visibleProviders
    .filter((p) => p.integrated)
    .slice()
    .sort((a, b) => {
      const aEntry = cfg.mediaProviders?.[a.id];
      const bEntry = cfg.mediaProviders?.[b.id];
      const aConfigured = isStoredMediaProviderEntryPresent(aEntry);
      const bConfigured = isStoredMediaProviderEntryPresent(bEntry);
      if (aConfigured !== bConfigured) return aConfigured ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  const comingSoonProviders = visibleProviders
    .filter((p) => !p.integrated)
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label));
  const updateProvider = (
    provider: MediaProvider,
    patch: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      apiKeyConfigured?: boolean;
      apiKeyTail?: string;
    },
  ) => {
    onChange(provider.id);
    setCfg((curr) => {
      const prev = curr.mediaProviders?.[provider.id] ?? { apiKey: '', baseUrl: '', model: '' };
      const next = { ...prev, ...patch };
      const map = { ...(curr.mediaProviders ?? {}) };
      if (isStoredMediaProviderEntryEmpty(next)) {
        delete map[provider.id];
      } else {
        map[provider.id] = next;
      }
      return { ...curr, mediaProviders: map };
    });
  };
  const handleReload = async () => {
    if (!onReloadMediaProviders || reloadRunning) return;
    setReloadRunning(true);
    setReloadNotice(null);
    try {
      const next = await onReloadMediaProviders();
      if (!next) {
        setReloadNotice({ kind: 'error', message: t('settings.mediaProviderReloadError') });
        return;
      }
      setCfg((curr) => mergeDaemonMediaProviders(curr, next, {
        preserveLocalProviderIds: pendingLocalProviderIds,
      }));
      setReloadNotice({ kind: 'success', message: t('settings.mediaProviderReloadSuccess') });
    } finally {
      setReloadRunning(false);
    }
  };
  // Successful reload acknowledgement lives on the button (✓ Reloaded)
  // for ~2s then disappears. Keeping it as a permanent paragraph under
  // the section header was noise — the user just clicked a button and
  // got a visible state change, an extra "we did the thing" line is
  // redundant. Errors stay sticky because they actually require user
  // attention.
  useEffect(() => {
    if (reloadNotice?.kind !== 'success') return;
    const handle = window.setTimeout(() => setReloadNotice(null), 2000);
    return () => window.clearTimeout(handle);
  }, [reloadNotice]);

  const toggleApiKeyVisibility = (providerId: string) => {
    setVisibleApiKeys((current) => {
      const next = new Set(current);
      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }
      return next;
    });
  };

  return (
    <section className="settings-section">
      {mediaProvidersNotice ? (
        <p className="hint" role="alert">{mediaProvidersNotice}</p>
      ) : null}
      {reloadNotice && reloadNotice.kind === 'error' ? (
        // Errors only — successful reload feedback now rides on the
        // button (see is-success-flash above) and clears itself after
        // 2s, so the section header doesn't get colonised by a
        // permanent "yes I did the thing" paragraph.
        <p className="hint" role="alert">{reloadNotice.message}</p>
      ) : null}
      {reloadNotice && reloadNotice.kind === 'success' ? (
        // Off-screen announcement so assistive tech still hears the
        // success state even though the visible feedback collapses
        // into a transient button label change.
        <span className="sr-only" role="status">
          {reloadNotice.message}
        </span>
      ) : null}
      {onReloadMediaProviders ? (
        <div className="media-provider-reload-row">
          <button
            type="button"
            className={`ghost media-provider-reload-btn${
              reloadNotice?.kind === 'success' ? ' is-success-flash' : ''
            }`}
            onClick={() => {
              trackSettingsMediaProvidersClick(analytics.track, {
                page_name: 'settings',
                area: 'media_providers',
                element: 'reload',
              });
              void handleReload();
            }}
            disabled={reloadRunning}
            aria-live="polite"
          >
            {reloadRunning ? (
              t('common.loading')
            ) : reloadNotice?.kind === 'success' ? (
              <>
                <Icon name="check" size={13} />
                <span style={{ marginLeft: 4 }}>Reloaded</span>
              </>
            ) : (
              <>
                <Icon name="refresh" size={13} />
                <span style={{ marginLeft: 4 }}>{t('settings.mediaProviderReload')}</span>
              </>
            )}
          </button>
        </div>
      ) : null}
      <div className="media-provider-list">
        {availableProviders.map((provider) => {
          const entry = cfg.mediaProviders?.[provider.id] ?? { apiKey: '', baseUrl: '', model: '' };
          const hasPendingEdit = Boolean(entry.apiKey.trim());
          const isSavedState = Boolean((hasPendingEdit || entry.apiKeyConfigured) && !hasPendingEdit);
          const tail = entry.apiKeyTail?.trim();
          // Every provider rendered in the main list is integrated by
          // construction (see availableProviders filter), so the inputs
          // are always editable here. Non-integrated entries live in
          // the "Coming soon" <details> below.
          const disabled = false;
          const supportsCustomModel = provider.supportsCustomModel === true;
          const clearable = isStoredMediaProviderEntryPresent(entry);
          const apiKeyVisible = visibleApiKeys.has(provider.id);
          return (
            <div key={provider.id} className="media-provider-row">
              <div className="media-provider-head">
                <div className="media-provider-meta">
                  {/*
                    Provider name + "Saved" badge sit on a single row.
                    The badge used to render below the name with a green
                    success-pill treatment, which clashed with the green
                    "Integrated" badge on the right of the same row and
                    pushed the model hint two lines down. Inline + a
                    neutral muted treatment keeps the row scannable: green
                    means "we support this", blue means "you configured
                    it", gray means "your key is persisted" — three
                    distinct hues, three distinct meanings.
                  */}
                  <div className="media-provider-name-row">
                    <span className="media-provider-name">{provider.label}</span>
                    {isSavedState ? (
                      <span
                        className="field-status-badge field-status-badge--inline"
                        title={t('settings.connectorsSavedTitle')}
                      >
                        {tail
                          ? t('settings.connectorsSavedWithTail', { tail })
                          : t('settings.connectorsSaved')}
                      </span>
                    ) : null}
                  </div>
                  <span className="media-provider-hint">{provider.hint}</span>
                </div>
                {/*
                  Right-side badges deliberately omitted now: every row
                  in this list is "Integrated" by definition and the
                  "Configured" pill duplicated the inline "Saved" chip
                  next to the provider name. Three pills per row read
                  as warnings; one chip reads as status.
                */}
              </div>
              {provider.id === 'grok' ? <XaiOAuthControl /> : null}
              <div className="media-provider-body">
                <div className="media-provider-secret-field">
                  <input
                    type={apiKeyVisible ? 'text' : 'password'}
                    value={entry.apiKey}
                    placeholder={isSavedState ? t('settings.connectorsReplaceKeyPlaceholder') : t('settings.mediaProviderPlaceholder')}
                    aria-label={`${provider.label} ${t('settings.mediaProviderApiKey')}`}
                    disabled={disabled}
                    onFocus={() => {
                      trackSettingsMediaProvidersClick(analytics.track, {
                        page_name: 'settings',
                        area: 'media_providers',
                        element: 'key_input',
                        providers_id: provider.id,
                        is_configured: clearable,
                      });
                    }}
                    onChange={(e) => updateProvider(provider, { apiKey: e.target.value })}
                  />
                  <button
                    type="button"
                    className="secret-visibility-button"
                    disabled={disabled}
                    aria-label={
                      apiKeyVisible
                        ? `${provider.label} ${t('settings.hideKey')}`
                        : `${provider.label} ${t('settings.showKey')}`
                    }
                    aria-pressed={apiKeyVisible}
                    onClick={() => toggleApiKeyVisibility(provider.id)}
                  >
                      <Icon name={apiKeyVisible ? 'eye' : 'eye-off'} size={15} />
                    </button>
                  </div>
                <input
                  value={entry.baseUrl}
                  placeholder={provider.defaultBaseUrl || t('settings.mediaProviderBaseUrlPlaceholder')}
                  aria-label={`${provider.label} ${t('settings.mediaProviderBaseUrl')}`}
                  disabled={disabled}
                  onFocus={() => {
                    trackSettingsMediaProvidersClick(analytics.track, {
                      page_name: 'settings',
                      area: 'media_providers',
                      element: 'url_input',
                      providers_id: provider.id,
                      is_configured: clearable,
                    });
                  }}
                  onChange={(e) => updateProvider(provider, { baseUrl: e.target.value })}
                />
                {supportsCustomModel ? (
                  <input
                    value={entry.model ?? ''}
                    placeholder="gemini-3.1-flash-image-preview"
                    aria-label={`${provider.label} model`}
                    disabled={disabled}
                    onChange={(e) => updateProvider(provider, { model: e.target.value })}
                  />
                ) : null}
                <button
                  type="button"
                  className="ghost"
                  disabled={!clearable}
                  onClick={() => {
                    trackSettingsMediaProvidersClick(analytics.track, {
                      page_name: 'settings',
                      area: 'media_providers',
                      element: 'clear',
                      providers_id: provider.id,
                      // The click reports the state at the moment the
                      // user pressed Clear; the actual clear only lands
                      // after they confirm the dialog below, but the
                      // dashboard cares about the intent signal.
                      is_configured: clearable,
                    });
                    // Match the existing window.confirm guard the rest of
                    // the app uses for destructive actions (conversation
                    // delete, design delete, file delete in FileWorkspace).
                    // Without this a stray click on the row's Clear button
                    // wipes the saved key with no recovery. Issue #737.
                    if (
                      !confirm(
                        t('settings.mediaProviderClearConfirm', {
                          name: provider.label,
                        }),
                      )
                    ) {
                      return;
                    }
                    updateProvider(provider, {
                      apiKey: '',
                      baseUrl: '',
                      model: '',
                      apiKeyConfigured: false,
                      apiKeyTail: '',
                    });
                  }}
                >
                  {t('settings.mediaProviderClear')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {comingSoonProviders.length > 0 ? (
        // Roadmap drawer. We still want to advertise that we know
        // these providers exist (so users don't ask "where is Fal?"),
        // but disabled placeholder cards in the main list were noise.
        // Closed by default — opens to a compact name + hint + docs
        // link list, no inputs because there's nothing to wire up yet.
        // TODO(i18n): inline English placeholders; promote to locale
        // keys when we touch this section again.
        <details className="library-group media-provider-coming-soon">
          <summary className="memory-details-summary">
            <span className="memory-details-title">
              {t('tasks.comingSoon')}
            </span>
            <span className="filter-pill-count">
              {comingSoonProviders.length}
            </span>
          </summary>
          <p className="hint" style={{ marginTop: 4, marginBottom: 8 }}>
            {t('settings.mediaProviderComingSoonHint')}
          </p>
          <ul className="media-provider-coming-soon-list">
            {comingSoonProviders.map((provider) => {
              const docsHref = sanitizeHttpsUrl(provider.docsUrl);
              return (
                <li
                  key={provider.id}
                  className="media-provider-coming-soon-item"
                >
                  <div className="media-provider-coming-soon-meta">
                    <span className="media-provider-name">
                      {provider.label}
                    </span>
                    <span className="media-provider-hint">
                      {provider.hint}
                    </span>
                  </div>
                  {docsHref ? (
                    <a
                      href={docsHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ghost-link"
                    >
                      {t('settings.agentInstall.docs')}
                      <Icon name="external-link" size={11} />
                    </a>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
