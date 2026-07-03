import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../shared/Icon';
import { ConnectorsBrowser } from '../settings/ConnectorsBrowser';
import type { AppConfig } from '../../types';

/**
 * The four UI states the Composio API key field can be in.
 *
 * `saved-pending` exists so the saved-key indicator stays visible while
 * the user types a draft replacement. Previously the badge was tied to
 * `!hasPendingEdit`, which made it vanish on the first keystroke and
 * trained users to think the original key had already been overwritten
 * (issue #741). Treating "saved key plus draft" as its own state lets
 * the badge stay anchored while the hint text differentiates the
 * unsaved replacement from a fully-saved value.
 */
export type ComposioCredentialState =
  | 'empty'
  | 'pending-new'
  | 'saved'
  | 'saved-pending';

export function deriveComposioCredentialState(
  composio: { apiKey?: string; apiKeyConfigured?: boolean } | null | undefined,
): ComposioCredentialState {
  const hasPendingEdit = Boolean(composio?.apiKey?.trim());
  const hasSavedKey = Boolean(composio?.apiKeyConfigured);
  if (hasSavedKey && hasPendingEdit) return 'saved-pending';
  if (hasSavedKey) return 'saved';
  if (hasPendingEdit) return 'pending-new';
  return 'empty';
}

export function ConnectorSection({
  cfg,
  setCfg,
  composioConfigLoading = false,
  onPersistComposioKey,
  onConnectorsTabClick,
  onConnectorAuthResult,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
  /** True while the daemon-backed Composio config is still hydrating on
   *  first paint. The credentials surface renders a skeleton over the
   *  input + buttons so the user does not mistake the temporarily empty
   *  input for "no saved key", and so accidental Save/Clear clicks
   *  cannot overwrite the saved state with `''` before hydration lands. */
  composioConfigLoading?: boolean;
  /** Persist the freshly typed Composio API key to the daemon. Returns
   *  once both localStorage and the daemon have caught up so the
   *  section-local Save button can flip from "Saving…" back to idle. */
  onPersistComposioKey: (composio: AppConfig['composio']) => Promise<void> | void;
  /** Optional analytics hook for the integrations surface. The parent
   *  (IntegrationsView) wires this so connectors-tab clicks emit on
   *  `page_name: 'integrations'`; when omitted (SettingsDialog uses the
   *  settings page family instead), no event is fired. */
  onConnectorsTabClick?: (
    element:
      | 'api_key_input'
      | 'save_key'
      | 'clear'
      | 'get_api_key'
      | 'provider_chip'
      | 'search_connectors',
  ) => void;
  /** Analytics hook for the per-connector authorization result. Wired
   *  by the parent so settings_connector_auth_result events fire on
   *  the settings page family. */
  onConnectorAuthResult?: (params: {
    connectorId: string;
    action: 'connect' | 'disconnect' | 'refresh';
    result: 'success' | 'failed' | 'cancelled';
    errorCode?: string;
  }) => void;
}) {
  const { t } = useI18n();
  const composio = cfg.composio ?? {};

  const updateComposio = (patch: NonNullable<AppConfig['composio']>) => {
    setCfg((curr) => ({ ...curr, composio: { ...(curr.composio ?? {}), ...patch } }));
  };
  const credentialState = deriveComposioCredentialState(composio);
  const hasSavedKey = credentialState === 'saved' || credentialState === 'saved-pending';
  const hasPendingEdit = credentialState === 'pending-new' || credentialState === 'saved-pending';
  const apiKeyConfigured = credentialState !== 'empty';
  const savedApiKeyConfigured = Boolean(composio.apiKeyConfigured || hasSavedKey);
  const tail = composio.apiKeyTail?.trim();

  // Section-local save state. The Composio key bypasses the dialog's
  // global autosave loop because it is a secret — we don't want
  // partial-typed keys leaving the browser on every keystroke. The
  // user explicitly clicks "Save key" when they're ready, the request
  // completes, the daemon returns a tail-only echo, and we land in
  // the saved state with the same UI as a key loaded from disk.
  const [keySaveStatus, setKeySaveStatus] =
    useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [catalogRefreshNonce, setCatalogRefreshNonce] = useState(0);
  const keySavedTimerRef = useRef<number | null>(null);
  // Clear the saved-state timer on unmount to avoid setState after unmount
  useEffect(() => {
    return () => {
      if (keySavedTimerRef.current != null) {
        window.clearTimeout(keySavedTimerRef.current);
      }
    };
  }, []);
  const handleSaveKey = async () => {
    if (keySaveStatus === 'saving') return;
    if (!hasPendingEdit) return;
    if (composioConfigLoading) return;
    // Clear any stale timer before transitioning to 'saving' to prevent
    // it from firing during the await and flipping the button back to idle.
    if (keySavedTimerRef.current != null) {
      window.clearTimeout(keySavedTimerRef.current);
      keySavedTimerRef.current = null;
    }
    const pendingKey = composio.apiKey ?? '';
    setKeySaveStatus('saving');
    try {
      await onPersistComposioKey(cfg.composio);
      // Mirror the parent's normalization so the local draft moves
      // into the saved state immediately: drop the secret from the
      // input, mark configured, and store the last-4 tail for the
      // status badge. The parent's setConfig won't propagate back to
      // the dialog because `initial` is read once at mount.
      updateComposio({
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: pendingKey.trim().slice(-4),
      });
      setCatalogRefreshNonce((nonce) => nonce + 1);
      // Clear any existing timer before starting a new one to avoid
      // a stale timeout flipping status back to 'idle' after a
      // subsequent save or clear.
      if (keySavedTimerRef.current != null) {
        window.clearTimeout(keySavedTimerRef.current);
      }
      setKeySaveStatus('saved');
      keySavedTimerRef.current = window.setTimeout(() => {
        setKeySaveStatus('idle');
      }, 2000);
    } catch {
      if (keySavedTimerRef.current != null) {
        window.clearTimeout(keySavedTimerRef.current);
      }
      setKeySaveStatus('error');
      keySavedTimerRef.current = null;
    }
  };

  // Action gating during hydration. Both Save and Clear are dangerous
  // before the daemon's response lands: Save would push whatever the
  // user typed (or didn't type) over the saved key, and Clear would
  // unconditionally wipe it. The skeleton state below makes this
  // visually obvious; the disabled flags here are the safety net.
  const actionsLocked = composioConfigLoading || keySaveStatus === 'saving';
  const saveDisabled = actionsLocked || !hasPendingEdit;
  const clearDisabled = actionsLocked || !apiKeyConfigured;

  // Two-stage destructive confirmation for "Clear". Clearing the saved
  // Composio API key cascades into disconnecting every connector that
  // depends on it, which is irreversible from the UI's standpoint —
  // accounts, OAuth grants, and tool access all unwind. To stop that
  // from happening on a stray click we gate the existing wipe behind
  //   1. an inline warning panel (must click "Continue"), then
  //   2. a final destructive confirmation panel with a brief arming
  //      window so the destructive button cannot be hit by reflex
  //      double-click, then
  //   3. the original clear behavior fires.
  // The panel collapses on Cancel, when the saved key disappears for
  // any other reason, or when the user navigates away from the section.
  const [clearStage, setClearStage] = useState<'idle' | 'confirm' | 'final'>('idle');
  const [clearArmed, setClearArmed] = useState(false);
  const finalConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  // Reset the flow if the underlying state stops being clearable
  // (e.g. the daemon reloaded and there's nothing saved anymore, or
  // hydration started). This avoids a stale confirmation panel sitting
  // open over a key that no longer exists.
  useEffect(() => {
    if (!apiKeyConfigured || composioConfigLoading) {
      setClearStage('idle');
      setClearArmed(false);
    }
  }, [apiKeyConfigured, composioConfigLoading]);
  // Arm the destructive button after a short delay once the user
  // reaches the final stage. Until then the button is visually hot
  // but inert — this is the "hold on a sec" moment that keeps a
  // reflex Enter / double-click from blowing through both stages.
  useEffect(() => {
    if (clearStage !== 'final') {
      setClearArmed(false);
      return;
    }
    setClearArmed(false);
    const timer = window.setTimeout(() => setClearArmed(true), 700);
    // Pull focus to the final confirm button so keyboard users can
    // see the arming animation finish and choose deliberately rather
    // than tabbing through stale focus state.
    const focusTimer = window.setTimeout(() => {
      finalConfirmButtonRef.current?.focus({ preventScroll: true });
    }, 720);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(focusTimer);
    };
  }, [clearStage]);
  const handleClearRequest = () => {
    if (clearDisabled) return;
    setClearStage('confirm');
  };
  const handleClearAbort = () => {
    setClearStage('idle');
    setClearArmed(false);
  };
  const handleClearContinue = () => {
    setClearStage('final');
  };
  const handleClearCommit = async () => {
    if (keySaveStatus === 'saving') return;
    if (!clearArmed) return;
    // Clear any stale timer before transitioning to 'saving', matching
    // handleSaveKey's pattern for consistency.
    if (keySavedTimerRef.current != null) {
      window.clearTimeout(keySavedTimerRef.current);
      keySavedTimerRef.current = null;
    }
    setKeySaveStatus('saving');
    try {
      const cleared = {
        apiKey: '',
        apiKeyConfigured: false,
        apiKeyTail: '',
      };
      await onPersistComposioKey(cleared);
      updateComposio(cleared);
      setCatalogRefreshNonce((nonce) => nonce + 1);
      setClearStage('idle');
      setClearArmed(false);
      setKeySaveStatus('idle');
    } catch {
      if (keySavedTimerRef.current != null) {
        window.clearTimeout(keySavedTimerRef.current);
      }
      setKeySaveStatus('error');
      keySavedTimerRef.current = null;
    }
  };

  return (
    <section className="settings-section settings-section-connectors">

      <label
        className={`field settings-section-connectors-credentials${composioConfigLoading ? ' is-loading' : ''}`}
        aria-busy={composioConfigLoading || undefined}
      >
        <span className="field-label-row">
          <span className="field-label-group">
            <span className="field-label">{t('settings.connectorsComposioApiKey')}</span>
            {composioConfigLoading ? (
              // Skeleton chip stands in for the "Saved · ••••XXXX" badge
              // while we wait for the daemon. Same footprint as the real
              // chip so the row geometry doesn't jump on resolve.
              <span
                className="field-status-badge field-status-badge-skeleton"
                aria-hidden="true"
              />
            ) : hasSavedKey ? (
              <span
                className="field-status-badge"
                title={t('settings.connectorsSavedTitle')}
              >
                {tail
                  ? t('settings.connectorsSavedWithTail', { tail })
                  : t('settings.connectorsSaved')}
              </span>
            ) : null}
          </span>
          <a
            className="field-label-link"
            href="https://app.composio.dev"
            target="_blank"
            rel="noreferrer"
            onClick={() => onConnectorsTabClick?.('get_api_key')}
          >
            {t('settings.connectorsGetApiKey')}
            <Icon name="external-link" size={11} />
          </a>
        </span>
        <div className="field-row">
          {/* Wrap the password input so the shimmer overlay can sit on
              top of it without affecting layout. The input itself stays
              mounted (rather than swapped for a placeholder div) so the
              browser keeps any in-progress autofill, focus, and
              accessibility tree intact when hydration completes. */}
          <span className="field-input-skeleton-wrap">
            <input
              type="password"
              value={composio.apiKey ?? ''}
              placeholder={
                composioConfigLoading
                  ? t('settings.connectorsLoadingSavedKey')
                  : hasSavedKey
                    ? t('settings.connectorsReplaceKeyPlaceholder')
                    : t('settings.connectorsApiKeyPlaceholder')
              }
              onFocus={() => onConnectorsTabClick?.('api_key_input')}
              onChange={(e) => updateComposio({ apiKey: e.target.value })}
              onKeyDown={(e) => {
                // Enter from the password field commits the key — the
                // most common save gesture for credential fields, and
                // it removes the need to mouse over to the button.
                if (
                  e.key === 'Enter'
                  && hasPendingEdit
                  && keySaveStatus !== 'saving'
                  && !composioConfigLoading
                ) {
                  e.preventDefault();
                  void handleSaveKey();
                }
              }}
              disabled={composioConfigLoading}
              aria-describedby="composio-api-key-help"
            />
            {composioConfigLoading ? (
              <span className="field-input-skeleton-shimmer" aria-hidden="true" />
            ) : null}
          </span>
          <button
            type="button"
            className={'primary settings-connectors-save' + (keySaveStatus === 'saving' ? ' is-busy' : '')}
            disabled={saveDisabled}
            onClick={() => {
              onConnectorsTabClick?.('save_key');
              void handleSaveKey();
            }}
            title={
              composioConfigLoading
                ? t('settings.connectorsLoadingSavedKey')
                : t('settings.connectorsSaveKeyTitle')
            }
          >
            {keySaveStatus === 'saving' ? (
              <>
                <Icon name="spinner" size={12} className="icon-spin" />
                <span>{t('settings.connectorsKeySaving')}</span>
              </>
            ) : keySaveStatus === 'saved' ? (
              <>
                <Icon name="check" size={12} />
                <span>{t('settings.connectorsKeySaved')}</span>
              </>
            ) : (
              t('settings.connectorsSaveKey')
            )}
          </button>
          <button
            type="button"
            className={
              'ghost settings-connectors-clear'
              + (clearStage !== 'idle' ? ' is-arming' : '')
            }
            disabled={clearDisabled}
            title={
              composioConfigLoading
                ? t('settings.connectorsLoadingSavedKey')
                : undefined
            }
            aria-expanded={clearStage !== 'idle'}
            aria-controls="composio-clear-confirm"
            onClick={() => {
              onConnectorsTabClick?.('clear');
              handleClearRequest();
            }}
          >
            {t('settings.connectorsClear')}
          </button>
        </div>
        {/* Two-stage destructive confirmation panel. Lives inside the
            credentials field so it visually grows out of the row that
            owns the action, instead of floating disconnected at the
            bottom of the section. The panel is destructive-styled
            (red border + soft red bg) and uses an alertdialog role so
            screen readers treat it as a modal blocker for the field. */}
        {clearStage !== 'idle' ? (
          <div
            id="composio-clear-confirm"
            className={
              'settings-connectors-clear-confirm is-' + clearStage
              + (clearStage === 'final' && clearArmed ? ' is-armed' : '')
            }
            role="alertdialog"
            aria-modal="false"
            aria-labelledby="composio-clear-confirm-title"
            aria-describedby="composio-clear-confirm-body"
          >
            <div className="settings-connectors-clear-confirm-icon" aria-hidden="true">
              <span className="settings-connectors-clear-confirm-glyph">!</span>
            </div>
            <div className="settings-connectors-clear-confirm-copy">
              <strong id="composio-clear-confirm-title">
                {clearStage === 'final'
                  ? t('settings.connectorsClearFinalTitle')
                  : t('settings.connectorsClearConfirmTitle')}
              </strong>
              <span id="composio-clear-confirm-body">
                {clearStage === 'final'
                  ? t('settings.connectorsClearFinalBody')
                  : t('settings.connectorsClearConfirmBody')}
              </span>
            </div>
            <div className="settings-connectors-clear-confirm-actions">
              <button
                type="button"
                className="ghost"
                onClick={handleClearAbort}
              >
                {t('settings.connectorsClearCancel')}
              </button>
              {clearStage === 'confirm' ? (
                <button
                  type="button"
                  className="settings-connectors-clear-step"
                  onClick={handleClearContinue}
                >
                  {t('settings.connectorsClearConfirmContinue')}
                  <Icon name="chevron-right" size={12} />
                </button>
              ) : (
                <button
                  ref={finalConfirmButtonRef}
                  type="button"
                  className={
                    'settings-connectors-clear-commit'
                    + (clearArmed ? ' is-armed' : '')
                  }
                  onClick={handleClearCommit}
                  disabled={!clearArmed}
                  aria-disabled={!clearArmed}
                >
                  <span className="settings-connectors-clear-commit-arm" aria-hidden="true" />
                  <span className="settings-connectors-clear-commit-label">
                    {clearArmed ? (
                      t('settings.connectorsClearFinalConfirm')
                    ) : (
                      <>
                        <Icon name="spinner" size={12} className="icon-spin" />
                        {t('settings.connectorsClearArming')}
                      </>
                    )}
                  </span>
                </button>
              )}
            </div>
          </div>
        ) : null}
        <span
          id="composio-api-key-help"
          className={`hint${composioConfigLoading ? ' field-hint-loading' : ''}`}
          role={composioConfigLoading ? 'status' : undefined}
          aria-live={composioConfigLoading ? 'polite' : undefined}
        >
          {composioConfigLoading ? (
            <>
              <Icon name="spinner" size={11} className="icon-spin" />
              <span>{t('settings.connectorsLoadingSavedKey')}</span>
            </>
          ) : keySaveStatus === 'error'
            ? t('settings.connectorsKeyError')
            : hasSavedKey
              ? t('settings.connectorsHelpSaved')
              : apiKeyConfigured
                ? t('settings.connectorsHelpUnsaved')
                : t('settings.connectorsHelpEmpty')}
        </span>
      </label>

      <ConnectorsBrowser
        composioConfigured={savedApiKeyConfigured}
        catalogRefreshKey={`${savedApiKeyConfigured ? 'configured' : 'empty'}:${tail ?? ''}:${catalogRefreshNonce}`}
        {...(onConnectorsTabClick ? { onConnectorsTabClick } : {})}
        {...(onConnectorAuthResult ? { onConnectorAuthResult } : {})}
      />
    </section>
  );
}
