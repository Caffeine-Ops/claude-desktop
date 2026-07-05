/*
 * 「更新应用」设置面（2026-07-05 重设计，方案 A：electron-updater + 公开
 * release 仓）。
 *
 * 数据面：不走 daemon——版本检查/下载/安装全部是 main 进程 appUpdater 的
 * 职责，这里经 window.chatApi 订阅它的状态流（UPDATER_STATE_CHANGED 推送
 * 全量 UpdaterState，整体替换不自己拼装）。纯浏览器直开（无 chatApi）时
 * 降级为只读：显示 daemon 版本号 + 「需在桌面应用内使用」提示。
 *
 * 视觉：一张分两区的信息卡——上半 hero 是「摘要在前」（app 图标 + 版本号 +
 * 状态 pill 徽章 + 主操作按钮），下半 detail 是「细节在后」（进度条 / 状态说明
 * / 自动检查提示）。状态用 pill 徽章 + 状态点编码（已是最新=品牌绿静态点、
 * 下载中=主题蓝脉冲点、失败=红点），一眼可扫；发现新版用「当前 → 新版」的
 * 版本迁移表达。不引入任何新色相：品牌绿=正向语义、主题蓝=发现新版、
 * destructive=错误，全部走已有 token。
 *
 * 技术栈：本目录在 chat 链 @source 内——shadcn 原语 + Tailwind utility，
 * 禁止 .settings-* / .sv2-* legacy 类（canvas CSS 未分层会压过 utility）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
} from 'lucide-react';

import { Button } from '@/src/components/ui/button';
import { cn } from '@/src/lib/utils';
import type { UpdaterState } from '@desktop-shared/ipc-channels';
import { useI18n } from '../../i18n';

type UpdateAppSectionProps = {
  /** daemon /api/version 的版本号——无 chatApi（纯浏览器）时的显示兜底。 */
  fallbackVersion: string | null;
};

/**
 * 状态 pill 徽章——右侧一个色点 + 文案，颜色随相位语义走。
 * variant 决定色系：latest=品牌绿、found=主题蓝（脉冲）、checking=中性、
 * error=destructive。
 */
function StatusBadge({
  variant,
  label,
}: {
  variant: 'latest' | 'found' | 'checking' | 'error';
  label: string;
}): React.JSX.Element {
  const styles = {
    latest: 'bg-[var(--brand)]/12 text-[var(--brand)]',
    found: 'bg-primary/12 text-primary',
    checking: 'bg-muted text-muted-foreground',
    error: 'bg-destructive/12 text-destructive',
  }[variant];
  const dot = {
    latest: 'bg-[var(--brand)]',
    // 脉冲点：发现新版是需要用户注意的正向事件，动一下把视线拉过来。
    found: 'bg-primary [animation:updater-pulse_1.8s_ease-out_infinite] motion-reduce:animate-none',
    checking: 'bg-muted-foreground',
    error: 'bg-destructive',
  }[variant];
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full py-1 pl-2 pr-2.5 text-xs font-medium leading-none',
        styles,
      )}
    >
      <span className={cn('size-1.5 rounded-full', dot)} />
      {label}
    </span>
  );
}

export function UpdateAppSection({
  fallbackVersion,
}: UpdateAppSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const chatApi = typeof window !== 'undefined' ? window.chatApi : undefined;

  // null = 还没拿到首个快照（或根本没有 chatApi）。
  const [state, setState] = useState<UpdaterState | null>(null);
  // 手动点过检查才把 'none' 渲染成「已是最新」确认徽章——启动时的后台静默
  // 检查也会把 phase 推到 none，没点过按钮就冒出绿色徽章很突兀。
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

  const currentVersion = state?.currentVersion ?? fallbackVersion ?? '—';
  const nextVersion = state?.availableVersion ?? '';
  const phase = state?.phase ?? 'idle';
  const supported = Boolean(chatApi) && (state?.supported ?? false);
  const busy =
    phase === 'checking' || phase === 'available' || phase === 'downloading';
  const showUpToDate = phase === 'none' && hasManuallyChecked;

  // hero 的三态：普通（当前版本）、发现新版（版本迁移）、就绪（新版号）。
  const isFound = phase === 'available' || phase === 'downloading';
  const isReady = phase === 'ready';

  // hero 左侧 app 图标的配色随相位切换。
  const glyphClass = isFound
    ? 'bg-primary/10 text-primary'
    : phase === 'error'
      ? 'bg-destructive/10 text-destructive'
      : 'bg-[var(--brand)]/10 text-[var(--brand)]';

  return (
    <section className="flex flex-col gap-6">
      {/* 脉冲动画：局部 keyframes（Tailwind 无内置的自定义脉冲环）。挂在
          section 里一次即可，@keyframes 名加 updater- 前缀避免与他处撞名。 */}
      <style>{`@keyframes updater-pulse{0%{box-shadow:0 0 0 0 hsl(var(--primary)/0.5)}70%{box-shadow:0 0 0 6px hsl(var(--primary)/0)}100%{box-shadow:0 0 0 0 hsl(var(--primary)/0)}}`}</style>

      <p className="-mt-3 text-sm leading-relaxed text-muted-foreground">
        {t('updateApp.subtitle')}
      </p>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {/* ── 上半 hero：摘要在前 ── */}
        <div className="flex items-center gap-4 p-5">
          <div
            className={cn(
              'grid size-12 shrink-0 place-items-center rounded-xl',
              glyphClass,
            )}
          >
            {isReady ? (
              <Check aria-hidden="true" className="size-6" />
            ) : isFound ? (
              <Download aria-hidden="true" className="size-6" />
            ) : phase === 'error' ? (
              <AlertCircle aria-hidden="true" className="size-6" />
            ) : (
              <RefreshCw aria-hidden="true" className="size-6" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">
              {isFound
                ? t('updateApp.foundVersion')
                : isReady
                  ? t('updateApp.readyTitle')
                  : t('updateApp.currentVersion')}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {isFound ? (
                // 版本迁移：当前 → 新版，主题蓝强调新版号。
                <span className="flex items-baseline gap-2 font-mono text-xl tracking-tight tabular-nums">
                  <span className="text-muted-foreground">{currentVersion}</span>
                  <ArrowRight
                    aria-hidden="true"
                    className="size-4 shrink-0 self-center text-muted-foreground"
                  />
                  <span className="font-semibold text-primary">{nextVersion}</span>
                </span>
              ) : (
                <span className="font-mono text-xl font-semibold tracking-tight tabular-nums text-foreground">
                  {isReady ? nextVersion : currentVersion}
                </span>
              )}

              {/* 状态 pill：相位决定 variant。idle/手动前不渲染。 */}
              {phase === 'checking' ? (
                <StatusBadge variant="checking" label={t('updateApp.badge.checking')} />
              ) : phase === 'downloading' || phase === 'available' ? (
                <StatusBadge variant="found" label={t('updateApp.badge.downloading')} />
              ) : isReady ? (
                <StatusBadge variant="latest" label={t('updateApp.badge.ready')} />
              ) : phase === 'error' ? (
                <StatusBadge variant="error" label={t('updateApp.badge.error')} />
              ) : showUpToDate ? (
                <StatusBadge variant="latest" label={t('updateApp.badge.latest')} />
              ) : null}
            </div>
          </div>

          {/* 主操作：就绪时「立即重启更新」（品牌绿），否则「检查更新」。
              下载中/检查中不给独立按钮（进度已在下半区表达，避免双重反馈）。 */}
          <div className="shrink-0">
            {isReady ? (
              <Button onClick={handleInstall} className="bg-[var(--brand)] text-[var(--brand-foreground)] hover:bg-[var(--brand)]/90">
                <RefreshCw aria-hidden="true" />
                {t('updateApp.installNow')}
              </Button>
            ) : phase === 'error' ? (
              <Button variant="outline" onClick={handleCheck} disabled={!supported || busy}>
                {t('updateApp.retry')}
              </Button>
            ) : (
              <Button variant="outline" onClick={handleCheck} disabled={!supported || busy}>
                {busy ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <RefreshCw aria-hidden="true" />
                )}
                {t('updateApp.check')}
              </Button>
            )}
          </div>
        </div>

        {/* ── 下半 detail：细节在后（分隔线上方）── */}
        <div className="flex flex-col gap-2.5 border-t border-border px-5 py-4">
          {phase === 'checking' ? (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              {t('updateApp.checking')}
            </p>
          ) : null}

          {phase === 'available' || phase === 'downloading' ? (
            <>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-[13px] text-muted-foreground">
                  <span>{t('updateApp.downloading', { version: nextVersion })}</span>
                  {state?.downloadPercent != null ? (
                    <span className="font-mono font-medium tabular-nums text-foreground">
                      {state.downloadPercent}%
                    </span>
                  ) : null}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{ width: `${state?.downloadPercent ?? 0}%` }}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('updateApp.downloadHint')}
              </p>
            </>
          ) : null}

          {isReady ? (
            <p className="flex items-center gap-2 text-[13px] font-medium text-foreground">
              <CheckCircle2 aria-hidden="true" className="size-4 text-[var(--brand)]" />
              {t('updateApp.ready', { version: nextVersion })}
            </p>
          ) : null}

          {phase === 'error' ? (
            <p className="text-[13px] text-destructive">
              {state?.errorMessage
                ? `${t('updateApp.error')}：${state.errorMessage}`
                : t('updateApp.error')}
            </p>
          ) : null}

          {/* 无异常相位（idle / none）时显示「自动检查」提示。不支持
              （dev / 浏览器）时降级成对应说明。 */}
          {!busy && !isReady && phase !== 'error' ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {supported
                ? t('updateApp.autoHint3h')
                : chatApi
                  ? t('updateApp.devUnavailable')
                  : t('updateApp.browserUnavailable')}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
