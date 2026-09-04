import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { Monitor, Send, Volume2 } from 'lucide-react';

import { Button } from '@/src/components/ui/button';
import { SettingCard, SettingGroup, SettingRow, SettingSwitchRow } from '../settings/SettingPrimitives';
import { useTt } from './settingsHelpers';
import { cn } from '@/src/lib/utils';
import { useAnalytics } from '../../analytics/provider';
import { trackSettingsNotificationsClick } from '../../analytics/events';
import { useI18n } from '../../i18n';
import { DEFAULT_NOTIFICATIONS } from '../../state/config';
import type { AppConfig } from '../../types';
import {
  FAILURE_SOUNDS,
  SUCCESS_SOUNDS,
  notificationPermission,
  playSound,
  requestNotificationPermission,
  showCompletionNotification,
} from '../../utils/notifications';

/* 2026-07-14 迁 chat 栈（shadcn + Tailwind utility）：seg-control/seg-btn/
   settings-notify-card/settings-field/settings-section/hint 等 legacy 类全部
   退役。二元开关（完成提示音 / 桌面通知总开关）用 shadcn Switch（与
   AppearanceSection 的指针光标开关同构件）；提示音多选（成功/失败音）保持
   分段式裸 button + data-slot 逃逸 canvas reset（同 AppearanceSection 的
   cli-backend-tab 模式，Radix 组件对这种「选一个还带试听副作用」的组不贴）。 */


// Map the runtime SoundId (hyphenated, used by utils/notifications.ts) onto
// the contract's underscored enum. Sounds that don't have a tracking entry
// drop to undefined so we never emit an off-enum value.
function soundIdToTracking(
  id: string,
):
  | 'ding'
  | 'chime'
  | 'two_tone_up'
  | 'pluck'
  | 'buzz'
  | 'two_tone_down'
  | 'thud'
  | undefined {
  switch (id) {
    case 'ding':
      return 'ding';
    case 'chime':
      return 'chime';
    case 'two-tone-up':
      return 'two_tone_up';
    case 'pluck':
      return 'pluck';
    case 'buzz':
      return 'buzz';
    case 'two-tone-down':
      return 'two_tone_down';
    case 'thud':
      return 'thud';
    default:
      return undefined;
  }
}

export function NotificationsSection({
  cfg,
  setCfg,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const { t } = useI18n();
  const tt = useTt();
  const analytics = useAnalytics();
  const notif = cfg.notifications ?? DEFAULT_NOTIFICATIONS;
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    () => notificationPermission(),
  );
  const [testStatus, setTestStatus] = useState<ReturnType<typeof testNotificationStatusText> | null>(null);

  const updateNotif = (
    patch: Partial<NonNullable<AppConfig['notifications']>>,
  ) => {
    setCfg((c) => ({
      ...c,
      notifications: { ...DEFAULT_NOTIFICATIONS, ...(c.notifications ?? {}), ...patch },
    }));
  };

  const toggleSound = () => {
    const next = !notif.soundEnabled;
    // P1 ui_click area=notifications element=completion_sound — the toggle
    // emits the post-click state on `completion_sound_status` so a single
    // event captures intent + outcome.
    trackSettingsNotificationsClick(analytics.track, {
      page_name: 'settings',
      area: 'notifications',
      element: 'completion_sound',
      completion_sound_status: next ? 'on' : 'off',
    });
    updateNotif({ soundEnabled: next });
    // Give the user immediate audible feedback when turning the master
    // switch on so they know which sound they're signing up for. Resuming
    // the AudioContext also bakes in their gesture for later auto-plays.
    if (next) playSound(notif.successSoundId);
  };

  const toggleDesktop = async () => {
    if (notif.desktopEnabled) {
      trackSettingsNotificationsClick(analytics.track, {
        page_name: 'settings',
        area: 'notifications',
        element: 'desktop_notification',
        desktop_notification_status: 'off',
      });
      updateNotif({ desktopEnabled: false });
      return;
    }
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === 'granted') {
      trackSettingsNotificationsClick(analytics.track, {
        page_name: 'settings',
        area: 'notifications',
        element: 'desktop_notification',
        desktop_notification_status: 'on',
      });
      updateNotif({ desktopEnabled: true });
    } else {
      trackSettingsNotificationsClick(analytics.track, {
        page_name: 'settings',
        area: 'notifications',
        element: 'desktop_notification',
        desktop_notification_status: 'off',
      });
      updateNotif({ desktopEnabled: false });
    }
  };

  const sendTestNotification = async () => {
    const result = await showCompletionNotification({
      status: 'succeeded',
      title: t('notify.successTitle'),
      body: t('notify.successBody'),
    });
    setPermission(notificationPermission());
    setTestStatus(testNotificationStatusText(result));
  };

  return (
    <section>
      {/* 2026-09-02 P2 版式统一：原本每个设置项各占一张 rounded-xl 卡片，
          一屏下来五六张卡各自浮着、边框数量等于设置项数量。改成「一组一张卡 +
          内部发丝线分隔」（SettingCard/SettingRow，见 SettingPrimitives.tsx），
          边框降到每组一圈。逻辑一行没动：handler、埋点、条件渲染全部照搬，
          这是纯版式重构。 */}
      {/* 2026-09-04 精细化（样稿 v4）：提示音与桌面通知原是两张卡，合成「提醒
          方式」一张组卡；开关行换 SettingSwitchRow（整行可点，此前这页两处漏了
          labelFor）；行首图标；脚注说明触发时机。测试通知单独成组，标题常驻——
          原先标题跟着 testStatus 才出现，点一下按钮会从左边跳到右边。 */}
      <SettingGroup
        label={tt('settings.notifyGroupWays', '提醒方式')}
        footnote={tt(
          'settings.notifyFootnote',
          '提示音与桌面通知只在你没盯着这个窗口时出现，前台工作不会被打断。',
        )}
      >
        <SettingCard>
          <SettingSwitchRow
            icon={<Volume2 />}
            title={t('settings.notifyCompletionSound')}
            hint={t('settings.notifyCompletionSoundHint')}
            checked={notif.soundEnabled}
            onCheckedChange={toggleSound}
          />

          {notif.soundEnabled ? (
            <>
              <SettingRow title={t('settings.notifySuccessSound')} stack>
                <SoundPicker
                  ariaLabel={t('settings.notifySuccessSound')}
                  sounds={SUCCESS_SOUNDS}
                  selectedId={notif.successSoundId}
                  onSelect={(sound) => {
                    const trackingSoundId = soundIdToTracking(sound.id);
                    trackSettingsNotificationsClick(analytics.track, {
                      page_name: 'settings',
                      area: 'notifications',
                      element: 'success_sound',
                      ...(trackingSoundId ? { sound_id: trackingSoundId } : {}),
                    });
                    updateNotif({ successSoundId: sound.id });
                    playSound(sound.id);
                  }}
                  label={(sound) => t(sound.labelKey)}
                />
              </SettingRow>

              <SettingRow title={t('settings.notifyFailureSound')} stack>
                <SoundPicker
                  ariaLabel={t('settings.notifyFailureSound')}
                  sounds={FAILURE_SOUNDS}
                  selectedId={notif.failureSoundId}
                  onSelect={(sound) => {
                    const trackingSoundId = soundIdToTracking(sound.id);
                    trackSettingsNotificationsClick(analytics.track, {
                      page_name: 'settings',
                      area: 'notifications',
                      element: 'failure_sound',
                      ...(trackingSoundId ? { sound_id: trackingSoundId } : {}),
                    });
                    updateNotif({ failureSoundId: sound.id });
                    playSound(sound.id);
                  }}
                  label={(sound) => t(sound.labelKey)}
                />
              </SettingRow>
            </>
          ) : null}

          <SettingSwitchRow
            icon={<Monitor />}
            title={t('settings.notifyDesktop')}
            hint={t('settings.notifyDesktopHint')}
            checked={notif.desktopEnabled}
            disabled={permission === 'unsupported'}
            onCheckedChange={() => {
              void toggleDesktop();
            }}
          />

          {permission === 'unsupported' ? (
            <SettingRow hint={t('settings.notifyDesktopUnsupported')} />
          ) : null}
          {permission === 'denied' ? (
            <SettingRow hint={t('settings.notifyDesktopBlocked')} />
          ) : null}
        </SettingCard>
      </SettingGroup>

      {notif.desktopEnabled && permission === 'granted' ? (
        <SettingGroup label={tt('settings.notifyTestGroup', '测试')}>
          <SettingCard>
            {/* testStatus 保留 role="status"：它是发完测试通知后的结果播报，
               读屏软件靠这个 live region 才会念出来。 */}
            <SettingRow
              icon={<Send />}
              title={tt('settings.notifyTestTitle', '发送一条测试通知')}
              hint={
                testStatus ? (
                  <span role="status">{t(testStatus)}</span>
                ) : (
                  tt('settings.notifyTestHint', '确认提示音与系统通知都能正常弹出。')
                )
              }
            >
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  trackSettingsNotificationsClick(analytics.track, {
                    page_name: 'settings',
                    area: 'notifications',
                    element: 'send_test',
                  });
                  void sendTestNotification();
                }}
              >
                {t('settings.notifyTest')}
              </Button>
            </SettingRow>
          </SettingCard>
        </SettingGroup>
      ) : null}
    </section>
  );
}

/**
 * Segmented sound picker — pick one sound from a group, with an audible
 * preview side-effect on select. Kept as data-slot bare buttons (not Radix)
 * for the same reason AppearanceSection keeps its cli-backend-tab group bare:
 * one-of-N + preview doesn't map cleanly onto a Radix primitive, and the
 * data-slot escapes the canvas bare-element reset. Skinned with utility only.
 */
function SoundPicker<S extends { id: string }>({
  ariaLabel,
  sounds,
  selectedId,
  onSelect,
  label,
}: {
  ariaLabel: string;
  sounds: readonly S[];
  selectedId: string;
  onSelect: (sound: S) => void;
  label: (sound: S) => string;
}) {
  return (
    <div
      className="flex flex-wrap gap-1.5 rounded-[10px] bg-secondary p-[3px]"
      role="group"
      aria-label={ariaLabel}
    >
      {sounds.map((sound) => {
        const active = selectedId === sound.id;
        return (
          <button
            key={sound.id}
            type="button"
            data-slot="sound-option"
            aria-pressed={active}
            className={cn(
              'min-w-0 flex-1 cursor-pointer truncate rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-[background-color,color,box-shadow]',
              active
                ? 'bg-card text-foreground shadow-[0_1px_3px_hsl(240_6%_10%/0.12),0_0_0_1px_hsl(240_6%_10%/0.04)]'
                : 'hover:text-foreground/80',
            )}
            onClick={() => onSelect(sound)}
          >
            {label(sound)}
          </button>
        );
      })}
    </div>
  );
}

function testNotificationStatusText(
  result: Awaited<ReturnType<typeof showCompletionNotification>>,
):
  | 'settings.notifyTestSent'
  | 'settings.notifyDesktopBlocked'
  | 'settings.notifyDesktopUnsupported'
  | 'settings.notifyTestFailed' {
  if (result === 'shown') return 'settings.notifyTestSent';
  if (result === 'permission-denied') return 'settings.notifyDesktopBlocked';
  if (result === 'unsupported') return 'settings.notifyDesktopUnsupported';
  return 'settings.notifyTestFailed';
}
