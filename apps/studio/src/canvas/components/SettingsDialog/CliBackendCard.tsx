import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { cn } from '@/src/lib/utils';
import { useI18n } from '../../i18n';
import { applyCliBackendToConfig } from '../../state/cliBackend';
import type { AppConfig } from '../../types';
import type { DesktopCliBackendState } from '../../App';
import { AgentIcon } from '../shared/AgentIcon';

/**
 * 统一 CLI 后端选择器 —— 执行模式「本机 CLI」tab 的主控件（2026-07-16
 * 起）。canvas 项目 run 与 chat 会话共用这一个「Bundled fusion-code /
 * System claude」二选一；原 17 家 agent 卡片列表随统一执行模型下线
 * （daemon 底层多 agent 适配保留，仅 UI 收敛）。
 *
 * 一次切换写两条链路（语义与传导机制见 state/cliBackend.ts 顶注）：
 *   1. chat 面：chatApi.setCliBackend —— main 持久化 + 回收所有 tab 的
 *      runtime，in-flight 回合保持当前后端、下一回合切换（即时生效）；
 *   2. canvas 面：applyCliBackendToConfig 写 cfg（agentCliEnv.claude.
 *      CLAUDE_BIN + agentId），经 SettingsDialog 的 autosave 管线落
 *      daemon app-config，下次 run 生效。
 *
 * 高亮以 main 返回的 state.mode 为准（真源）；cfg 只是它在 daemon 侧的
 * 投影，App.tsx bootstrap 有对账兜底。切换后派发 od:cli-backend-changed
 * 让 AppRail 底部 user chip 就地 re-pull（同 'od:appearance-changed'
 * 桥的跨面同步机制）。
 *
 * 纯浏览器（无 window.chatApi）显示禁用说明——backend 状态住在 Electron
 * main 进程，浏览器直开的 canvas 摸不到它。
 */
export function CliBackendCard({
  setCfg,
}: {
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const { t } = useI18n();
  const chatApi = typeof window !== 'undefined' ? window.chatApi : undefined;
  const [cliBackend, setCliBackend] = useState<DesktopCliBackendState | null>(null);
  const [cliBusy, setCliBusy] = useState(false);

  useEffect(() => {
    if (!chatApi?.getCliBackend) return;
    let cancelled = false;
    chatApi
      .getCliBackend()
      .then((s) => {
        if (!cancelled) setCliBackend(s);
      })
      .catch(() => {
        /* shell-only; ignore on error */
      });
    return () => {
      cancelled = true;
    };
  }, [chatApi]);

  if (!chatApi) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/40 p-4 text-xs text-muted-foreground">
        {t('settings.cliBackendDesktopOnly')}
      </div>
    );
  }

  const switchBackend = async (mode: 'bundled' | 'system') => {
    if (cliBusy || !chatApi.setCliBackend || cliBackend?.mode === mode) return;
    if (mode === 'system' && !cliBackend?.systemInfo) return;
    setCliBusy(true);
    try {
      const next = await chatApi.setCliBackend({ mode });
      setCliBackend(next);
      setCfg((c) => applyCliBackendToConfig(c, next.mode, next.bundledPath));
      window.dispatchEvent(
        new CustomEvent('od:cli-backend-changed', { detail: next })
      );
    } catch {
      /* ignore — 高亮仍跟随 main 返回的真实状态，失败即不动 */
    } finally {
      setCliBusy(false);
    }
  };

  const options = [
    {
      mode: 'bundled' as const,
      title: t('settings.cliBackendBundledTitle'),
      desc: t('settings.cliBackendBundledDesc'),
      meta: cliBackend?.bundledPath ?? '',
      metaLabel: t('settings.cliBackendBundledMeta'),
      disabled: cliBusy || !cliBackend,
    },
    {
      mode: 'system' as const,
      title: t('settings.cliBackendSystemTitle'),
      desc: t('settings.cliBackendSystemDesc'),
      meta: cliBackend?.systemInfo?.path ?? '',
      metaLabel: cliBackend?.systemInfo
        ? cliBackend.systemInfo.version
          ? `v${cliBackend.systemInfo.version}`
          : t('settings.cliBackendDetected')
        : t('settings.cliBackendNotInstalled'),
      disabled: cliBusy || !cliBackend || !cliBackend.systemInfo,
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-2">
        {options.map(({ mode, title, desc, meta, metaLabel, disabled }) => {
          const active = cliBackend?.mode === mode;
          return (
            <button
              key={mode}
              type="button"
              data-slot="cli-backend-option"
              aria-pressed={active}
              disabled={disabled && !active}
              onClick={() => void switchBackend(mode)}
              className={cn(
                /* agent 卡片同视觉语言：选中 = accent tint + 1px ring */
                'relative flex min-h-[70px] w-full cursor-pointer items-center gap-3 overflow-hidden rounded-xl border border-border bg-card py-2.5 pl-[18px] pr-3.5 text-left transition-[border-color,background-color,box-shadow,transform] duration-150',
                active
                  ? 'border-accent/50 bg-accent/[0.07] shadow-[0_0_0_1px] shadow-accent/25'
                  : 'hover:-translate-y-px hover:border-foreground/25 hover:shadow-[0_3px_12px_hsl(240_6%_10%/0.07)]',
                'disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:translate-y-0 disabled:hover:border-border disabled:hover:shadow-none',
              )}
            >
              <span
                className={cn(
                  'flex shrink-0 items-center justify-center rounded-[10px] border border-border p-[5px] transition-colors',
                  active ? 'border-accent/25 bg-accent/15' : 'bg-muted/60',
                )}
              >
                <AgentIcon id="claude" size={32} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex min-w-0 items-baseline gap-[5px] overflow-hidden whitespace-nowrap text-[12.5px] font-semibold text-foreground">
                  <span className="min-w-0 flex-initial truncate">{title}</span>
                  <span className="font-normal text-muted-foreground" aria-hidden="true">
                    ·
                  </span>
                  <span className="min-w-0 flex-1 truncate font-normal text-muted-foreground">
                    {desc}
                  </span>
                </div>
                <div
                  className="truncate text-[11px] leading-[1.35] tabular-nums text-muted-foreground"
                  title={meta}
                >
                  {metaLabel}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <p className="m-0 text-[11.5px] leading-relaxed text-muted-foreground">
        {t('settings.chatCliBackendHint')}
      </p>
    </div>
  );
}
