import type { Dispatch, SetStateAction, JSX } from 'react';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { SettingCard, SettingGroup, SettingRow, SettingSwitchRow } from './SettingPrimitives';
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
    <section>
      {!hasMadeConsentDecision ? (
        <ConsentCard onShare={shareUsage} onDecline={declineUsage} />
      ) : (
        <>
          {/* 2026-09-02 P2：三个遥测开关原本各是一张 rounded-md 边框卡，
              改为共用一张组卡、内部发丝线分隔（见 SettingPrimitives.tsx）。
              ToggleRow 的两个交互特性都保住了：整行文字可点切换（labelFor）
              与选中后整行变底色。 */}
          <SettingGroup>
            <SettingCard>
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
            </SettingCard>
          </SettingGroup>

          <SettingGroup>
            <SettingCard>
            <SettingRow
              title={t('settings.privacyInstallationId')}
              hint={t('settings.privacyDataDeletionHint')}
              stack
            >
              <Input
                type="text"
                readOnly
                value={cfg.installationId ?? t('settings.privacyOptedOut')}
                aria-label={t('settings.privacyInstallationId')}
              />
            </SettingRow>
            <SettingRow stack>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
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
            </SettingRow>
            </SettingCard>
          </SettingGroup>
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
  // 2026-09-04：整行可点 + 开启后浅底这两个行为已抽进 SettingSwitchRow（tint），
  // 本地只剩一层 prop 改名，保留是为了不动下面的调用点。
  return <SettingSwitchRow title={label} hint={hint} checked={checked} onCheckedChange={onChange} tint />;
}

interface ConsentProps {
  onShare: () => void;
  onDecline: () => void;
}

function ConsentCard({ onShare, onDecline }: ConsentProps): JSX.Element {
  const t = useT();
  /* 2026-09-02 P2：同意书原本是一段裸文字 + 两个按钮，没有任何卡片容器，
     在其余页面都统一成组卡之后显得像"还没做完的那一页"。收进 SettingCard，
     与开关态（用户做过决定后看到的那屏）用同一套版式。
     dl/dt/dd 的语义结构保留——这两条是对"我们会收集什么"的正式说明，
     描述列表是正确的语义标签，只是搬进了 SettingRow 的排版里。 */
  return (
    <SettingGroup>
      <SettingCard>
        <SettingRow
          title={t('settings.privacyConsentKicker')}
          hint={t('settings.privacyConsentLead')}
        />

        <SettingRow stack>
          <dl className="m-0 flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <dt className="text-[13px] font-medium text-foreground">
                {t('settings.privacyMetrics')}
              </dt>
              <dd className="m-0 text-xs leading-relaxed text-muted-foreground">
                {t('settings.privacyMetricsHint')}
              </dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-[13px] font-medium text-foreground">
                {t('settings.privacyContent')}
              </dt>
              <dd className="m-0 text-xs leading-relaxed text-muted-foreground">
                {t('settings.privacyContentHint')}
              </dd>
            </div>
          </dl>
        </SettingRow>

        <SettingRow hint={t('settings.privacyConsentFooter')} />

        <SettingRow stack>
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
        </SettingRow>
      </SettingCard>
    </SettingGroup>
  );
}
