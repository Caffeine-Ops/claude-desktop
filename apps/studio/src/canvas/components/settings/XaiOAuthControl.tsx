// xAI / SuperGrok OAuth control rendered inside the Grok provider row in
// the Settings → Media Providers panel.
//
// Mirrors the shape of McpOAuthControl in McpClientSection.tsx (state
// machine, polling cadence, CSS classes), but skips the postMessage /
// BroadcastChannel handshake because the xAI callback is served by the
// one-shot listener on 127.0.0.1:56121 — a separate process that can't
// talk to the OD UI directly. Polling /api/xai/auth/status is the only
// delivery channel for "auth completed".
//
// 2026-09-01 收尾：原来整块是 PoC 期的硬编码英文 + legacy .mcp-oauth-* /
// .xai-oauth-* 类 + 裸 button/input。现已（a）文案全进 canvas 翻译表
// `settings.xaiOauth.*`（en / zh-CN 两份，其余 18 个语言包靠 `...en` 兜底）；
// （b）markup 换 shadcn Button / Input + utility，结构逐行照抄同文件族里
// 已迁好的 McpOAuthControl（McpClientSection.tsx）——那边注释写着「等 Xai
// 那侧一并迁移」，迁完这两个面板的观感才重新对齐。
// 品牌名不写死：正文里的产品名读 `app.brand` 一个键（当前值仍是上游的
// "Open Design"，与安装包 productName "Cowork" 不一致——这是全仓几十处
// 共有的历史问题，不在本次换皮范围内，但至少这里不再多一处硬编码）。

'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { useT } from '../../i18n';

interface XaiAuthStatus {
  connected: boolean;
  listening?: boolean;
  expiresAt?: number | null;
  scope?: string | null;
  savedAt?: number;
}

interface StartResponse {
  authorizeUrl: string;
  state: string;
  callback: { host: string; port: number };
}

type Busy =
  | 'idle'
  | 'starting'
  | 'awaiting'
  | 'disconnecting'
  | 'refreshing';

async function fetchStatus(): Promise<XaiAuthStatus | null> {
  try {
    const r = await fetch('/api/xai/auth/status', { credentials: 'same-origin' });
    if (!r.ok) return null;
    return (await r.json()) as XaiAuthStatus;
  } catch {
    return null;
  }
}

async function startOAuth(): Promise<
  { ok: true; response: StartResponse } | { ok: false; message: string }
> {
  try {
    const r = await fetch('/api/xai/oauth/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: '{}',
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const message =
        typeof body?.error === 'string' && body.error
          ? body.error
          : `daemon returned HTTP ${r.status}`;
      return { ok: false, message };
    }
    return { ok: true, response: body as StartResponse };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

async function disconnectOAuth(): Promise<boolean> {
  try {
    const r = await fetch('/api/xai/oauth/disconnect', {
      method: 'POST',
      credentials: 'same-origin',
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function cancelInFlightOAuth(): Promise<void> {
  // Best-effort. If the daemon is unreachable the listener will still
  // self-close on its 30 min timeout; we don't surface a failure to
  // the user because Cancel is a UX affordance, not a critical action.
  try {
    await fetch('/api/xai/oauth/cancel', {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch {
    // ignore
  }
}

async function completeOAuthManual(
  state: string,
  code: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const r = await fetch('/api/xai/oauth/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ state, code }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const message =
        typeof body?.error === 'string' && body.error
          ? body.error
          : `daemon returned HTTP ${r.status}`;
      return { ok: false, message };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function XaiOAuthControl() {
  const t = useT();
  // 产品名走翻译表的单一来源，插值进各条文案（见文件头注释）。
  const brand = t('app.brand');
  const [status, setStatus] = useState<XaiAuthStatus | null>(null);
  const [busy, setBusy] = useState<Busy>('idle');
  const [error, setError] = useState<string | null>(null);
  // Authorize URL kept around as a fallback link in case the popup blocker
  // ate window.open or the user closed the tab and wants to re-open it.
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);
  // State emitted by /oauth/start. Needed to complete a paste-back when
  // xAI shows a manual code instead of redirecting to the loopback.
  const [pendingState, setPendingState] = useState<string | null>(null);
  const [pasteCode, setPasteCode] = useState('');
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = async () => {
    const data = await fetchStatus();
    if (data) setStatus(data);
    return data;
  };

  useEffect(() => {
    void refresh();
    return () => stopPoll();
  }, []);

  function stopPoll() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  function startPoll() {
    stopPoll();
    let elapsed = 0;
    pollTimer.current = setInterval(() => {
      elapsed += 2000;
      void (async () => {
        const data = await refresh();
        if (data?.connected) {
          setBusy('idle');
          setError(null);
          setPendingAuthUrl(null);
          setPendingState(null);
          setPasteCode('');
          stopPoll();
        }
        // Intentionally NOT auto-clearing the awaiting state when
        // `data.listening` flips false. xAI commonly shows a paste-back
        // page instead of redirecting, in which case the loopback
        // listener never receives a callback and self-closes after its
        // 30 min timeout — but the user still has a valid code in their
        // clipboard. Keeping pendingState live lets them paste it; the
        // `Cancel` button is the manual way out.
      })();
      // Hard cap at 30 min — same as the daemon-side listener timeout.
      if (elapsed >= 30 * 60 * 1000) stopPoll();
    }, 2000);
  }

  const onConnect = async () => {
    setError(null);
    setPendingAuthUrl(null);
    setPendingState(null);
    setPasteCode('');
    setBusy('starting');
    const result = await startOAuth();
    if (!result.ok) {
      setBusy('idle');
      setError(result.message);
      return;
    }
    setBusy('awaiting');
    setPendingAuthUrl(result.response.authorizeUrl);
    setPendingState(result.response.state);
    startPoll();
    try {
      // noopener,noreferrer breaks the auth.x.ai tab's reference back to
      // this Settings tab, defending against reverse-tabnabbing if the
      // remote page (or any redirect-target along the OAuth chain) ever
      // turns hostile. The xAI flow doesn't use postMessage — the
      // callback comes back through the daemon's :56121 listener (or
      // the paste-back input below), so opener access is unnecessary.
      window.open(
        result.response.authorizeUrl,
        '_blank',
        'noopener,noreferrer',
      );
    } catch {
      // Fallback anchor is always rendered while pending.
    }
  };

  const onPasteSubmit = async () => {
    const trimmed = pasteCode.trim();
    if (!pendingState || !trimmed) return;
    setBusy('refreshing');
    setError(null);
    const result = await completeOAuthManual(pendingState, trimmed);
    if (!result.ok) {
      setBusy('awaiting');
      setError(result.message);
      return;
    }
    setBusy('idle');
    setPendingAuthUrl(null);
    setPendingState(null);
    setPasteCode('');
    stopPoll();
    await refresh();
  };

  const onRefreshStatus = async () => {
    setBusy('refreshing');
    const data = await refresh();
    setBusy('idle');
    if (data?.connected) {
      setError(null);
      setPendingAuthUrl(null);
      stopPoll();
    } else if (busy === 'awaiting' || pendingAuthUrl) {
      setBusy('awaiting');
    }
  };

  const onCancelPending = () => {
    // Tell the daemon to stop its one-shot 127.0.0.1:56121 listener so
    // the singleton port doesn't sit pinned for the full 30 min server
    // timeout. Fire-and-forget — UI state clears immediately either way.
    void cancelInFlightOAuth();
    setPendingAuthUrl(null);
    setPendingState(null);
    setPasteCode('');
    setBusy('idle');
    setError(null);
    stopPoll();
  };

  const onDisconnect = async () => {
    setBusy('disconnecting');
    const ok = await disconnectOAuth();
    setBusy('idle');
    if (ok) {
      setError(null);
      setPendingAuthUrl(null);
      setStatus({ connected: false });
    } else {
      setError(t('settings.xaiOauth.disconnectFailed'));
    }
  };

  const connected = Boolean(status?.connected);
  const expiresLabel =
    status?.expiresAt && status.expiresAt > 0
      ? new Date(status.expiresAt).toLocaleString()
      : null;
  // "Awaiting" once we've started the dance: the authorize URL is open OR
  // a state is pending OR the daemon is processing a paste-back. Stays
  // true even when the loopback listener self-closes, so the paste-back
  // input stays interactive until the user cancels or the token lands.
  const isAwaiting =
    busy === 'awaiting'
    || busy === 'refreshing'
    || (Boolean(pendingState) && !connected)
    || (Boolean(pendingAuthUrl) && !connected);

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border bg-background p-3 dark:bg-input/30">
      <div className="flex items-center gap-2" aria-live="polite">
        {connected ? (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
            <span>
              <strong className="font-medium">{t('settings.xaiOauth.signedIn')}</strong>{' '}
              <span className="text-muted-foreground">
                {expiresLabel
                  ? t('settings.xaiOauth.signedInExpiry', { expires: expiresLabel })
                  : t('settings.xaiOauth.signedInConnected')}
              </span>
            </span>
          </>
        ) : isAwaiting ? (
          <>
            <span
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
              aria-hidden
            />
            <span>
              <strong className="font-medium">{t('settings.xaiOauth.awaiting')}</strong>{' '}
              <span className="text-muted-foreground">
                {t('settings.xaiOauth.awaitingHint', { brand })}
              </span>
            </span>
          </>
        ) : (
          <>
            <span
              className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
              aria-hidden
            />
            <span>
              <strong className="font-medium">{t('settings.xaiOauth.notSignedIn')}</strong>{' '}
              <span className="text-muted-foreground">
                {t('settings.xaiOauth.notSignedInHint', { brand })}
              </span>
            </span>
          </>
        )}
      </div>

      {/* xAI 常会渲染一个「无法建立连接」的页面，用户以为授权失败就跑去重试
          ——其实回调仍在后台送达。这条横幅就是拦这个误判的，故意用左粗边
          的强调条（不是 destructive 色：它不是错误，是「别慌、别重试」）。 */}
      {isAwaiting ? (
        <div
          className="rounded-md border border-l-[3px] border-primary bg-muted/50 px-3 py-2.5 text-xs leading-relaxed text-foreground"
          role="status"
        >
          <strong className="font-medium text-primary">
            {t('settings.xaiOauth.warningLead')}
          </strong>{' '}
          {t('settings.xaiOauth.warningBody', { brand })}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {connected ? (
          <>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={onConnect}
              disabled={busy !== 'idle' && busy !== 'refreshing'}
              title={t('settings.xaiOauth.reconnectTitle')}
            >
              {busy === 'starting' || busy === 'awaiting'
                ? t('settings.xaiOauth.connecting')
                : t('settings.xaiOauth.reconnect')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDisconnect}
              disabled={busy !== 'idle'}
            >
              {busy === 'disconnecting'
                ? t('settings.xaiOauth.disconnecting')
                : t('settings.xaiOauth.disconnect')}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={onConnect}
              disabled={busy !== 'idle'}
            >
              {busy === 'starting'
                ? t('settings.xaiOauth.openingBrowser')
                : t('settings.xaiOauth.signIn')}
            </Button>
            {isAwaiting ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onRefreshStatus}
                  disabled={busy === 'refreshing'}
                >
                  {busy === 'refreshing'
                    ? t('settings.xaiOauth.checking')
                    : t('settings.xaiOauth.refreshStatus')}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={onCancelPending}>
                  {t('common.cancel')}
                </Button>
              </>
            ) : null}
          </>
        )}
      </div>

      {pendingAuthUrl && !connected ? (
        <div className="text-xs leading-relaxed text-muted-foreground">
          {t('settings.xaiOauth.fallbackPrompt')}{' '}
          <a
            href={pendingAuthUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline-offset-4 hover:underline"
          >
            {t('settings.xaiOauth.fallbackLink')}
          </a>
        </div>
      ) : null}

      {isAwaiting && pendingState ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('settings.xaiOauth.pasteHint')}
          </p>
          <div className="flex items-stretch gap-1.5">
            <Input
              type="text"
              className="min-w-0 flex-1"
              value={pasteCode}
              placeholder={t('settings.xaiOauth.pastePlaceholder')}
              onChange={(e) => setPasteCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && pasteCode.trim()) {
                  void onPasteSubmit();
                }
              }}
              disabled={busy === 'refreshing'}
              aria-label={t('settings.xaiOauth.pastePlaceholder')}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onPasteSubmit}
              disabled={!pasteCode.trim() || busy === 'refreshing'}
            >
              {busy === 'refreshing'
                ? t('settings.xaiOauth.submitting')
                : t('settings.xaiOauth.submitCode')}
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="text-xs leading-relaxed text-destructive" role="alert">
          {error}
        </div>
      ) : null}

      {status?.scope ? (
        <div className="text-xs leading-relaxed text-muted-foreground">
          {t('settings.xaiOauth.grantedScopes')}{' '}
          <code data-slot="xai-oauth-scope" className="font-mono">
            {status.scope}
          </code>
        </div>
      ) : null}
    </div>
  );
}
