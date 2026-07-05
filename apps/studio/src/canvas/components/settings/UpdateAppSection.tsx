/*
 * 「更新应用」设置面（2026-07-05，方案 A：electron-updater + 公开 release 仓）。
 *
 * 数据面：不走 daemon——版本检查/下载/安装全部是 main 进程 appUpdater 的
 * 职责，这里经 window.chatApi 订阅它的状态流（UPDATER_STATE_CHANGED 推送
 * 全量 UpdaterState，整体替换不自己拼装）。纯浏览器直开（无 chatApi）时
 * 降级为只读：显示 daemon 版本号 + 「需在桌面应用内使用」提示。
 *
 * 技术栈：本目录在 chat 链 @source 内——shadcn 原语 + Tailwind utility，
 * 禁止 .settings-* / .sv2-* legacy 类（canvas CSS 未分层会压过 utility）。
 */

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/src/components/ui/button';
import type { UpdaterState } from '@desktop-shared/ipc-channels';
import { useI18n } from '../../i18n';

type UpdateAppSectionProps = {
  /** daemon /api/version 的版本号——无 chatApi（纯浏览器）时的显示兜底。 */
  fallbackVersion: string | null;
};

export function UpdateAppSection({
  fallbackVersion,
}: UpdateAppSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const chatApi = typeof window !== 'undefined' ? window.chatApi : undefined;

  // null = 还没拿到首个快照（或根本没有 chatApi）。
  const [state, setState] = useState<UpdaterState | null>(null);
  // 手动点过检查才把 'none' 渲染成「已是最新」确认行——启动时的后台静默
  // 检查也会把 phase 推到 none，没点过按钮就冒出一行绿色确认很突兀。
  const [hasManuallyChecked, setHasManuallyChecked] = useState(false);

  useEffect(() => {
    if (!chatApi?.getUpdaterState) return;
    let alive = true;
    void chatApi.getUpdaterState().then((s) => {
      if (alive) setState(s);
    });
    const unsubscribe = chatApi.onUpdaterStateChanged((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [chatApi]);

  const handleCheck = useCallback(() => {
    if (!chatApi?.checkForUpdates) return;
    setHasManuallyChecked(true);
    void chatApi.checkForUpdates().then(setState);
  }, [chatApi]);

  const handleInstall = useCallback(() => {
    void chatApi?.installUpdate?.();
  }, [chatApi]);

  const version = state?.currentVersion ?? fallbackVersion ?? '—';
  const phase = state?.phase ?? 'idle';
  const supported = Boolean(chatApi) && (state?.supported ?? false);
  const busy = phase === 'checking' || phase === 'available' || phase === 'downloading';

  return (
    <section className="flex flex-col gap-6">
      <p className="-mt-3 text-sm leading-relaxed text-muted-foreground">
        {t('updateApp.subtitle')}
      </p>

      <div className="flex items-start justify-between gap-6 rounded-xl border border-border bg-card p-5">
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="text-sm font-semibold text-foreground">
            {t('updateApp.currentVersion')}
          </h3>
          <div className="font-mono text-xl tracking-tight text-foreground">{version}</div>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {supported ? t('updateApp.autoHint') : null}
            {!supported && chatApi ? t('updateApp.devUnavailable') : null}
            {!chatApi ? t('updateApp.browserUnavailable') : null}
          </p>

          {/* 状态行：随 main 推送的相位切换，只渲染当前相位的一行。 */}
          {phase === 'checking' ? (
            <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              {t('updateApp.checking')}
            </p>
          ) : null}

          {phase === 'available' || phase === 'downloading' ? (
            <div className="space-y-1.5 pt-1">
              <p className="text-[13px] text-muted-foreground">
                {t('updateApp.downloading', {
                  version: state?.availableVersion ?? '',
                })}
                {state?.downloadPercent != null ? ` ${state.downloadPercent}%` : ''}
              </p>
              <div className="h-1.5 w-full max-w-72 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300"
                  style={{ width: `${state?.downloadPercent ?? 0}%` }}
                />
              </div>
            </div>
          ) : null}

          {phase === 'ready' ? (
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
              <CheckCircle2 aria-hidden="true" className="size-3.5 text-[var(--brand)]" />
              {t('updateApp.ready', { version: state?.availableVersion ?? '' })}
            </p>
          ) : null}

          {phase === 'none' && hasManuallyChecked ? (
            <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <CheckCircle2 aria-hidden="true" className="size-3.5" />
              {t('updateApp.upToDate')}
            </p>
          ) : null}

          {phase === 'error' ? (
            <p className="text-[13px] text-destructive">
              {t('updateApp.error')}
              {state?.errorMessage ? `：${state.errorMessage}` : ''}
            </p>
          ) : null}
        </div>

        {phase === 'ready' ? (
          <Button onClick={handleInstall} className="shrink-0">
            <RefreshCw aria-hidden="true" />
            {t('updateApp.installNow')}
          </Button>
        ) : (
          <Button onClick={handleCheck} disabled={!supported || busy} className="shrink-0">
            {busy ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
            {t('updateApp.check')}
          </Button>
        )}
      </div>
    </section>
  );
}
