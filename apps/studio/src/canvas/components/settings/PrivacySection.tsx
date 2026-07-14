import type { Dispatch, SetStateAction, JSX } from 'react';
import { useId } from 'react';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { Switch } from '@/src/components/ui/switch';
import { useAnalytics } from '../../analytics/provider';
import { trackSettingsPrivacyClick } from '../../analytics/events';
import { useT } from '../../i18n';
import { Icon } from '../shared/Icon';
import type { AppConfig, TelemetryConfig } from '../../types';

interface Props {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}

function generateInstallationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Older webviews / test runners that lack crypto.randomUUID. The output
  // is opaque and non-PII; we only need uniqueness across installs.
  return `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function PrivacySection({ cfg, setCfg }: Props): JSX.Element {
  const t = useT();
  const analytics = useAnalytics();
  const telemetry: TelemetryConfig = cfg.telemetry ?? {};
  // `privacyDecisionAt` gates the consent surface. installationId is only
  // the anonymous reporting id and can be rotated by Delete my data without
  // making the first-run banner appear again.
  const hasMadeConsentDecision = cfg.privacyDecisionAt != null;

  function patchTelemetry(patch: Partial<TelemetryConfig>): void {
    setCfg((c) => {
      const nextTelemetry = { ...(c.telemetry ?? {}), ...patch };
      const shouldHaveId = Object.values(nextTelemetry).some((v) => v === true);
      return {
        ...c,
        installationId:
          shouldHaveId && !c.installationId
            ? generateInstallationId()
            : c.installationId,
        privacyDecisionAt: Date.now(),
        telemetry: nextTelemetry,
      };
    });
  }

  function shareUsage(): void {
    setCfg((c) => ({
      ...c,
      installationId: generateInstallationId(),
      privacyDecisionAt: Date.now(),
      telemetry: { metrics: true, content: true, artifactManifest: false },
    }));
  }

  function declineUsage(): void {
    setCfg((c) => ({
      ...c,
      installationId: null,
      privacyDecisionAt: Date.now(),
      telemetry: { metrics: false, content: false, artifactManifest: false },
    }));
  }

  function deleteMyData(): void {
    setCfg((c) => ({
      ...c,
      installationId: generateInstallationId(),
      privacyDecisionAt: c.privacyDecisionAt ?? Date.now(),
      telemetry: { metrics: false, content: false, artifactManifest: false },
    }));
  }

  return (
    <section className="flex flex-col gap-3">
      {!hasMadeConsentDecision ? (
        <ConsentCard onShare={shareUsage} onDecline={declineUsage} />
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <ToggleRow
              label={t('settings.privacyMetrics')}
              hint={t('settings.privacyMetricsHint')}
              checked={telemetry.metrics === true}
              onChange={(v) => {
                trackSettingsPrivacyClick(analytics.track, {
                  page_name: 'settings',
                  area: 'privacy',
                  element: 'anonymous_metrics',
                  anonymous_metrics_status: v ? 'on' : 'off',
                });
                patchTelemetry({ metrics: v });
              }}
            />
            <ToggleRow
              label={t('settings.privacyContent')}
              hint={t('settings.privacyContentHint')}
              checked={telemetry.content === true}
              onChange={(v) => {
                trackSettingsPrivacyClick(analytics.track, {
                  page_name: 'settings',
                  area: 'privacy',
                  element: 'conversation_and_tool_content',
                  conversation_and_tool_content_status: v ? 'on' : 'off',
                });
                patchTelemetry({ content: v });
              }}
            />
            <ToggleRow
              label={t('settings.privacyArtifacts')}
              hint={t('settings.privacyArtifactsHint')}
              checked={telemetry.artifactManifest === true}
              onChange={(v) => {
                trackSettingsPrivacyClick(analytics.track, {
                  page_name: 'settings',
                  area: 'privacy',
                  element: 'project_artifacts_manifest',
                  project_artifacts_manifest_status: v ? 'on' : 'off',
                });
                patchTelemetry({ artifactManifest: v });
              }}
            />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 max-w-full">
                <h4 className="m-0 text-[13px] font-semibold tracking-[0.01em] text-foreground">
                  {t('settings.privacyInstallationId')}
                </h4>
                <p className="m-0 mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {t('settings.privacyDataDeletionHint')}
                </p>
              </div>
            </div>
            <Input
              type="text"
              readOnly
              value={cfg.installationId ?? t('settings.privacyOptedOut')}
              aria-label={t('settings.privacyInstallationId')}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-3 self-start"
              onClick={() => {
                trackSettingsPrivacyClick(analytics.track, {
                  page_name: 'settings',
                  area: 'privacy',
                  element: 'delete_my_data',
                });
                deleteMyData();
              }}
            >
              <Icon name="trash" size={13} />
              <span>{t('settings.privacyDataDeletion')}</span>
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

interface ToggleRowProps {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

// Migrated off the legacy .toggle-row button (label + hint + faux iOS switch)
// to the shadcn Switch primitive so the control reads native to the chat
// surface. The bordered row keeps the card-per-toggle feel; the label's
// htmlFor makes the whole text block toggle the switch, preserving the old
// "click anywhere in the row" affordance. Radix Switch already carries
// role="switch" + aria-checked, so the old aria-pressed is redundant.
function ToggleRow({ label, hint, checked, onChange }: ToggleRowProps): JSX.Element {
  const id = useId();
  return (
    <div
      className={`flex items-center gap-3 rounded-md border px-3.5 py-3 transition-colors ${
        checked ? 'border-input bg-muted/50' : 'border-border'
      }`}
    >
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5">
        <span className="text-[13px] text-foreground">{label}</span>
        <span className="text-[11.5px] leading-snug text-muted-foreground">{hint}</span>
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

interface ConsentProps {
  onShare: () => void;
  onDecline: () => void;
}

function ConsentCard({ onShare, onDecline }: ConsentProps): JSX.Element {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 max-w-full">
          <h4 className="m-0 text-[13px] font-semibold tracking-[0.01em] text-foreground">
            {t('settings.privacyConsentKicker')}
          </h4>
          <p className="m-0 mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {t('settings.privacyConsentLead')}
          </p>
        </div>
      </div>

      <dl className="m-0 flex flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <dt className="text-[13px] font-semibold text-foreground">{t('settings.privacyMetrics')}</dt>
          <dd className="m-0 text-xs text-muted-foreground">{t('settings.privacyMetricsHint')}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-[13px] font-semibold text-foreground">{t('settings.privacyContent')}</dt>
          <dd className="m-0 text-xs text-muted-foreground">{t('settings.privacyContentHint')}</dd>
        </div>
      </dl>

      <p className="m-0 text-xs leading-relaxed text-muted-foreground">
        {t('settings.privacyConsentFooter')}
      </p>

      <div
        className="grid grid-cols-2 gap-2"
        role="group"
        aria-label={t('settings.privacyConsentKicker')}
      >
        <Button type="button" variant="outline" onClick={onDecline}>
          {t('settings.privacyConsentDecline')}
        </Button>
        <Button type="button" variant="default" onClick={onShare}>
          {t('settings.privacyConsentShare')}
        </Button>
      </div>
    </div>
  );
}
