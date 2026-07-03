import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { APP_CHROME_FILE_ACTIONS_ID } from '../shared/AppChromeHeader';
import { usePortalMenuPosition } from '../shared/usePortalMenuPosition';
import { useT, useI18n } from '../../i18n';
import type { Locale } from '../../i18n/types';
import {
  fetchLiveArtifact,
  fetchLiveArtifactCode,
  fetchLiveArtifactRefreshes,
  liveArtifactPreviewUrl,
  LiveArtifactRefreshError,
  refreshLiveArtifact,
} from '../../providers/registry';
import type {
  LiveArtifactEventItem,
  LiveArtifact,
  LiveArtifactRefreshLogEntry,
  LiveArtifactViewerTab,
  LiveArtifactWorkspaceEntry,
} from '../../types';
import { Icon } from '../shared/Icon';
import { PreviewDrawOverlay } from '../shared/PreviewDrawOverlay';
import type { PreviewViewportId, TranslateFn } from './types';
import {
  PreviewViewportControls,
  previewScaleShellStyle,
  previewViewportStyle,
  usePreviewCanvasSize,
} from './preview-viewport';

export function LiveArtifactViewer({
  projectId,
  liveArtifact,
  liveArtifactEvents = [],
  onRefreshArtifacts,
}: {
  projectId: string;
  liveArtifact: LiveArtifactWorkspaceEntry;
  liveArtifactEvents?: LiveArtifactEventItem[];
  onRefreshArtifacts?: () => Promise<void> | void;
}) {
  const t = useT();
  const tabs = useMemo(() => liveArtifactViewerTabs(t), [t]);
  const [mode, setMode] = useState<LiveArtifactViewerTab>('preview');
  const [detail, setDetail] = useState<LiveArtifact | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [zoom, setZoom] = useState(100);
  const [previewViewport, setPreviewViewport] = useState<PreviewViewportId>('desktop');
  const [previewBodyRef, previewBodySize] = usePreviewCanvasSize<HTMLDivElement>();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshSuccess, setRefreshSuccess] = useState<string | null>(null);
  const [refreshEvents, setRefreshEvents] = useState<LiveArtifactRefreshEvent[]>([]);
  const [refreshHistory, setRefreshHistory] = useState<LiveArtifactRefreshLogEntry[]>([]);
  const [presentMenuOpen, setPresentMenuOpen] = useState(false);
  const [inTabPresent, setInTabPresent] = useState(false);
  // Present menu portals to <body> to clear the chrome stacking context (the
  // dropdown was painted under the viewer toolbar otherwise). The hook owns
  // the fixed positioning measured from presentWrapRef + outside-click/Escape.
  const {
    wrapRef: presentWrapRef,
    menuRef: presentMenuRef,
    menuPos: presentMenuPos,
  } = usePortalMenuPosition(presentMenuOpen, setPresentMenuOpen);
  const [chromeActionsHost, setChromeActionsHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    setChromeActionsHost(document.getElementById(APP_CHROME_FILE_ACTIONS_ID));
  }, []);

  useEffect(() => {
    setRefreshError(null);
    setRefreshSuccess(null);
    setRefreshEvents([]);
  }, [projectId, liveArtifact.artifactId]);

  useEffect(() => {
    if (!refreshSuccess) return;
    const timeout = window.setTimeout(() => setRefreshSuccess(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [refreshSuccess]);

  const processedLiveArtifactEventIdRef = useRef(0);

  useEffect(() => {
    const pendingEvents = liveArtifactEvents.filter((item) => item.id > processedLiveArtifactEventIdRef.current);
    if (pendingEvents.length === 0) return;
    processedLiveArtifactEventIdRef.current = pendingEvents[pendingEvents.length - 1]?.id ?? processedLiveArtifactEventIdRef.current;

    for (const { event: liveArtifactEvent } of pendingEvents) {
    if (
      (liveArtifactEvent.kind !== 'live_artifact' && liveArtifactEvent.kind !== 'live_artifact_refresh') ||
      liveArtifactEvent.projectId !== projectId ||
      liveArtifactEvent.artifactId !== liveArtifact.artifactId
    ) {
      continue;
    }

    if (liveArtifactEvent.kind === 'live_artifact') {
      setRefreshError(null);
      if (liveArtifactEvent.action === 'deleted') {
        setRefreshSuccess(`Live artifact deleted: ${liveArtifactEvent.title}`);
        continue;
      }
      setRefreshSuccess(
        liveArtifactEvent.action === 'created'
          ? `Live artifact created: ${liveArtifactEvent.title}`
          : `Live artifact updated: ${liveArtifactEvent.title}`,
      );
      void fetchLiveArtifact(projectId, liveArtifact.artifactId).then((next) => {
        if (next) setDetail(next);
      });
      void fetchLiveArtifactRefreshes(projectId, liveArtifact.artifactId).then(setRefreshHistory);
      setReloadKey((n) => n + 1);
      continue;
    }

    if (liveArtifactEvent.phase === 'started') {
      setRefreshing(true);
      setRefreshError(null);
      setRefreshSuccess(null);
      setRefreshEvents((prev) => appendRefreshEvent(prev, { phase: 'started' }));
      continue;
    }

    if (liveArtifactEvent.phase === 'failed') {
      setRefreshing(false);
      setRefreshError(liveArtifactEvent.error ?? t('liveArtifact.refresh.genericFailure'));
      setRefreshEvents((prev) =>
        appendRefreshEvent(prev, {
          phase: 'failed',
          error: liveArtifactEvent.error ?? undefined,
        }),
      );
      void fetchLiveArtifact(projectId, liveArtifact.artifactId).then((next) => {
        if (next) setDetail(next);
      });
      void fetchLiveArtifactRefreshes(projectId, liveArtifact.artifactId).then(setRefreshHistory);
      continue;
    }

    setRefreshing(false);
    setRefreshError(null);
    setRefreshEvents((prev) =>
      appendRefreshEvent(prev, {
        phase: 'succeeded',
        refreshedSourceCount: liveArtifactEvent.refreshedSourceCount ?? 0,
      }),
    );
    if ((liveArtifactEvent.refreshedSourceCount ?? 0) > 0) {
      setRefreshSuccess(t('liveArtifact.refresh.successOne'));
    } else {
      setRefreshError(t('liveArtifact.refresh.noSourceTitle'));
    }
    void fetchLiveArtifact(projectId, liveArtifact.artifactId).then((next) => {
      if (next) setDetail(next);
    });
    void fetchLiveArtifactRefreshes(projectId, liveArtifact.artifactId).then(setRefreshHistory);
    setReloadKey((n) => n + 1);
    }
  }, [liveArtifactEvents, liveArtifact.artifactId, projectId, t]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    void fetchLiveArtifact(projectId, liveArtifact.artifactId).then((next) => {
      if (cancelled) return;
      setDetail(next);
      setLoading(false);
    });
    void fetchLiveArtifactRefreshes(projectId, liveArtifact.artifactId).then((next) => {
      if (!cancelled) setRefreshHistory(next);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, liveArtifact.artifactId, liveArtifact.updatedAt]);

  const previewUrl = useMemo(
    () => `${liveArtifactPreviewUrl(projectId, liveArtifact.artifactId)}&v=${reloadKey}`,
    [projectId, liveArtifact.artifactId, reloadKey],
  );
  const previewScale = zoom / 100;
  const previewActive = mode === 'preview';

  function bumpZoom(delta: number) {
    setZoom((z) => Math.max(25, Math.min(200, z + delta)));
  }

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    setRefreshSuccess(null);
    setRefreshEvents((prev) => appendRefreshEvent(prev, { phase: 'started' }));
    try {
      const result = await refreshLiveArtifact(projectId, liveArtifact.artifactId);
      setDetail(result.artifact);
      void fetchLiveArtifactRefreshes(projectId, liveArtifact.artifactId).then(setRefreshHistory);
      setReloadKey((n) => n + 1);
      setRefreshEvents((prev) =>
        appendRefreshEvent(prev, {
          phase: 'succeeded',
          refreshedSourceCount: result.refresh.refreshedSourceCount,
        }),
      );
      if (result.refresh.refreshedSourceCount > 0) {
        setRefreshSuccess(t('liveArtifact.refresh.successOne'));
      } else {
        setRefreshError(t('liveArtifact.refresh.noSourceTitle'));
      }
      await onRefreshArtifacts?.();
    } catch (error) {
      const message = refreshErrorMessage(error, t);
      setRefreshError(message);
      setRefreshEvents((prev) => appendRefreshEvent(prev, { phase: 'failed', error: message }));
    } finally {
      setRefreshing(false);
    }
  }

  const dataPayload = detail?.document?.dataJson ?? null;
  const currentRefreshStatus = detail?.refreshStatus ?? liveArtifact.refreshStatus;
  const isRunning = refreshing || currentRefreshStatus === 'running';

  const presentInThisTab = () => {
    setPresentMenuOpen(false);
    setMode('preview');
    setInTabPresent(true);
  };
  const presentFullscreen = () => {
    setPresentMenuOpen(false);
    setMode('preview');
    const target = previewBodyRef.current ?? iframeRef.current;
    if (target?.requestFullscreen) {
      void target.requestFullscreen().catch(() => {});
    }
  };
  const presentNewTab = () => {
    setPresentMenuOpen(false);
    if (typeof window === 'undefined') return;
    window.open(liveArtifactPreviewUrl(projectId, liveArtifact.artifactId), '_blank', 'noopener,noreferrer');
  };
  useEffect(() => {
    if (!inTabPresent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInTabPresent(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inTabPresent]);

  return (
    <div className={`viewer html-viewer live-artifact-viewer${inTabPresent ? ' is-tab-present' : ''}`}>
      {((node: ReactNode) => (
        chromeActionsHost ? createPortal(node, chromeActionsHost) : node
      ))(
        <div className="present-wrap chrome-present-wrap" ref={presentWrapRef}>
          <button
            className="chrome-action chrome-action-secondary present-trigger"
            aria-haspopup="menu"
            aria-expanded={presentMenuOpen}
            onClick={() => setPresentMenuOpen((v) => !v)}
          >
            <Icon name="present" size={13} />
            <span>{t('fileViewer.present')}</span>
            <Icon name="chevron-down" size={11} />
          </button>
          {presentMenuOpen && presentMenuPos && typeof document !== 'undefined'
            ? createPortal(
            <div
              className="present-menu"
              role="menu"
              ref={presentMenuRef}
              style={{ position: 'fixed', top: presentMenuPos.top, right: presentMenuPos.right }}
            >
              <button role="menuitem" onClick={presentInThisTab}>
                <span className="present-icon"><Icon name="eye" size={13} /></span>{' '}
                {t('fileViewer.presentInTab')}
              </button>
              <button role="menuitem" onClick={presentFullscreen}>
                <span className="present-icon"><Icon name="play" size={13} /></span>{' '}
                {t('fileViewer.presentFullscreen')}
              </button>
              <button role="menuitem" onClick={presentNewTab}>
                <span className="present-icon"><Icon name="share" size={13} /></span>{' '}
                {t('fileViewer.presentNewTab')}
              </button>
            </div>,
                document.body,
              )
            : null}
        </div>
      )}
      {inTabPresent ? (
        <button
          type="button"
          className="present-exit-btn"
          onClick={() => setInTabPresent(false)}
          title={t('common.exitFullscreen')}
          aria-label={t('common.exitFullscreen')}
        >
          <Icon name="close" size={14} />
        </button>
      ) : null}
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <button
            type="button"
            className="icon-only"
            onClick={() => setReloadKey((n) => n + 1)}
            title={t('fileViewer.reload')}
            aria-label={t('fileViewer.reloadAria')}
          >
            <Icon name="reload" size={14} />
          </button>
        </div>
        <div className="viewer-toolbar-actions">
          <div className="viewer-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`viewer-tab ${mode === tab.id ? 'active' : ''}`}
                onClick={() => setMode(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div
            className="viewer-preview-controls"
            data-active={previewActive ? 'true' : 'false'}
            aria-hidden={previewActive ? undefined : true}
          >
            <span className="viewer-divider" aria-hidden />
            <PreviewViewportControls
              viewport={previewViewport}
              onViewport={setPreviewViewport}
              t={t}
              tabIndex={previewActive ? 0 : -1}
            />
            <span className="viewer-divider" aria-hidden />
            <button
              type="button"
              className="icon-only"
              onClick={() => bumpZoom(-25)}
              title={t('fileViewer.zoomOut')}
              aria-label={t('fileViewer.zoomOut')}
              tabIndex={previewActive ? 0 : -1}
            >
              <Icon name="minus" size={14} />
            </button>
            <button
              type="button"
              className="viewer-action viewer-zoom-level"
              onClick={() => setZoom(100)}
              title={t('fileViewer.resetZoom')}
              tabIndex={previewActive ? 0 : -1}
            >
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{zoom}%</span>
            </button>
            <button
              type="button"
              className="icon-only"
              onClick={() => bumpZoom(25)}
              title={t('fileViewer.zoomIn')}
              aria-label={t('fileViewer.zoomIn')}
              tabIndex={previewActive ? 0 : -1}
            >
              <Icon name="plus" size={14} />
            </button>
            <span className="viewer-divider" aria-hidden />
            <a
              className="ghost-link"
              href={liveArtifactPreviewUrl(projectId, liveArtifact.artifactId)}
              target="_blank"
              rel="noreferrer noopener"
              tabIndex={previewActive ? 0 : -1}
            >
              {t('fileViewer.open')}
            </a>
          </div>
          <span className="viewer-divider" aria-hidden />
          <button
            type="button"
            className="viewer-action primary"
            data-running={isRunning ? 'true' : 'false'}
            onClick={() => void handleRefresh()}
            disabled={isRunning}
            aria-busy={isRunning}
            aria-label={isRunning ? t('liveArtifact.refresh.running') : t('liveArtifact.refresh.button')}
            title={
              isRunning
                ? t('liveArtifact.refresh.running')
                : t('liveArtifact.refresh.buttonTitle')
            }
          >
            <Icon name={isRunning ? 'spinner' : 'reload'} size={13} />
            <span>{isRunning ? t('liveArtifact.refresh.running') : t('liveArtifact.refresh.button')}</span>
          </button>
        </div>
      </div>
      <div className="viewer-body" ref={previewBodyRef}>
        {refreshError ? (
          <LiveArtifactRefreshNotice
            tone="error"
            message={refreshError}
            action={t('liveArtifact.refresh.failureAction')}
          />
        ) : refreshSuccess ? (
          <LiveArtifactRefreshNotice
            tone="success"
            message={refreshSuccess}
            action={t('liveArtifact.refresh.successAction')}
            onDismiss={() => setRefreshSuccess(null)}
            dismissLabel={t('common.close')}
          />
        ) : isRunning ? (
          <LiveArtifactRefreshNotice
            tone="running"
            message={t('liveArtifact.refresh.runningMessage')}
            action={t('liveArtifact.refresh.runningAction')}
          />
        ) : currentRefreshStatus === 'failed' ? (
          <LiveArtifactRefreshNotice
            tone="error"
            message={t('liveArtifact.refresh.previousFailure', { message: t('liveArtifact.refresh.genericFailure') })}
            action={t('liveArtifact.refresh.failureAction')}
          />
        ) : null}
        <div
          className={`live-artifact-preview-layer preview-viewport preview-viewport-${previewViewport}`}
          data-active={previewActive ? 'true' : 'false'}
          aria-hidden={previewActive ? undefined : true}
          style={previewViewportStyle(previewViewport, previewScale, previewBodySize)}
        >
          <div className="preview-frame-clip">
            <div style={previewScaleShellStyle(previewViewport, previewScale)}>
              <PreviewDrawOverlay>
                <iframe
                  ref={iframeRef}
                  data-testid="live-artifact-preview-frame"
                  title={liveArtifact.title}
                  sandbox="allow-scripts allow-popups allow-downloads"
                  src={previewUrl}
                />
              </PreviewDrawOverlay>
            </div>
          </div>
        </div>
        {previewActive ? null : loading ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : mode === 'code' ? (
          <LiveArtifactCodePanel
            projectId={projectId}
            artifactId={liveArtifact.artifactId}
            reloadKey={reloadKey}
          />
        ) : mode === 'data' ? (
          <JsonPanel value={dataPayload} emptyLabel={t('liveArtifact.viewer.dataEmpty')} />
        ) : (
          <LiveArtifactRefreshHistoryPanel
            liveArtifact={detail}
            fallbackRefreshStatus={liveArtifact.refreshStatus}
            fallbackLastRefreshedAt={liveArtifact.lastRefreshedAt}
            isRunning={isRunning}
            sessionEvents={refreshEvents}
            persistedEvents={refreshHistory}
          />
        )}
      </div>
    </div>
  );
}

function LiveArtifactRefreshNotice({
  tone,
  message,
  action,
  onDismiss,
  dismissLabel,
}: {
  tone: 'running' | 'success' | 'error';
  message: string;
  action: string;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  return (
    <div
      className={`live-artifact-refresh-notice ${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-label={`${message} ${action}`}
    >
      <span className="live-artifact-refresh-notice-copy">
        <strong>{message}</strong>
        <span>{action}</span>
      </span>
      {onDismiss ? (
        <button type="button" className="icon-only" onClick={onDismiss} aria-label={dismissLabel}>
          ×
        </button>
      ) : null}
    </div>
  );
}

function refreshErrorMessage(error: unknown, t: TranslateFn): string {
  if (error instanceof LiveArtifactRefreshError && error.status === 0) {
    return t('liveArtifact.refresh.networkFailure');
  }
  if (error instanceof LiveArtifactRefreshError && error.code === 'LIVE_ARTIFACT_REFRESH_UNAVAILABLE') {
    return t('liveArtifact.refresh.noSourceTitle');
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return t('liveArtifact.refresh.genericFailure');
}

function liveArtifactViewerTabs(t: TranslateFn): Array<{ id: LiveArtifactViewerTab; label: string }> {
  return [
    { id: 'preview', label: t('liveArtifact.viewer.tabPreview') },
    { id: 'code', label: t('liveArtifact.viewer.tabCode') },
    { id: 'data', label: t('liveArtifact.viewer.tabData') },
    { id: 'refresh-history', label: t('liveArtifact.viewer.tabRefreshHistory') },
  ];
}

type LiveArtifactCodeVariant = 'template' | 'rendered-source';

function LiveArtifactCodePanel({
  projectId,
  artifactId,
  reloadKey,
}: {
  projectId: string;
  artifactId: string;
  reloadKey: number;
}) {
  const t = useT();
  const [variant, setVariant] = useState<LiveArtifactCodeVariant>('template');
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setCode(null);
    void fetchLiveArtifactCode(projectId, artifactId, variant).then((next) => {
      if (cancelled) return;
      setCode(next);
      setFailed(next == null);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [artifactId, projectId, reloadKey, variant]);

  return (
    <div className="live-artifact-code-panel">
      <div className="live-artifact-code-header">
        <div className="live-artifact-code-copy">
          <strong>
            {variant === 'template'
              ? t('liveArtifact.viewer.code.templateHeading')
              : t('liveArtifact.viewer.code.renderedHeading')}
          </strong>
          <span>
            {variant === 'template'
              ? t('liveArtifact.viewer.code.templateHelp')
              : t('liveArtifact.viewer.code.renderedHelp')}
          </span>
        </div>
        <div
          className="viewer-tabs live-artifact-code-tabs"
          aria-label={t('liveArtifact.viewer.code.variantAria')}
        >
          <button
            type="button"
            className={`viewer-tab ${variant === 'template' ? 'active' : ''}`}
            onClick={() => setVariant('template')}
          >
            {t('liveArtifact.viewer.code.variantTemplate')}
          </button>
          <button
            type="button"
            className={`viewer-tab ${variant === 'rendered-source' ? 'active' : ''}`}
            onClick={() => setVariant('rendered-source')}
          >
            {t('liveArtifact.viewer.code.variantRendered')}
          </button>
        </div>
      </div>
      {loading ? (
        <div className="viewer-empty">{t('liveArtifact.viewer.code.loading')}</div>
      ) : failed ? (
        <div className="viewer-empty">{t('liveArtifact.viewer.code.unavailable')}</div>
      ) : code && code.trim().length > 0 ? (
        <pre className="viewer-source">{code}</pre>
      ) : (
        <div className="viewer-empty">{t('liveArtifact.viewer.code.empty')}</div>
      )}
    </div>
  );
}

function JsonPanel({ value, emptyLabel }: { value: unknown; emptyLabel: string }) {
  if (value == null) return <div className="viewer-empty">{emptyLabel}</div>;
  return <pre className="viewer-source">{JSON.stringify(value, null, 2)}</pre>;
}

function liveArtifactMetadataPayload(liveArtifact: LiveArtifact): unknown {
  return {
    artifact: {
      id: liveArtifact.id,
      title: liveArtifact.title,
      slug: liveArtifact.slug,
      status: liveArtifact.status,
      pinned: liveArtifact.pinned,
      preview: liveArtifact.preview,
      refreshStatus: liveArtifact.refreshStatus,
      createdAt: liveArtifact.createdAt,
      updatedAt: liveArtifact.updatedAt,
      lastRefreshedAt: liveArtifact.lastRefreshedAt,
    },
    document: liveArtifact.document
      ? {
          format: liveArtifact.document.format,
          templatePath: liveArtifact.document.templatePath,
          generatedPreviewPath: liveArtifact.document.generatedPreviewPath,
          dataPath: liveArtifact.document.dataPath,
          dataSchemaJson: liveArtifact.document.dataSchemaJson,
          sourceJson: liveArtifact.document.sourceJson,
        }
      : null,
  };
}

function liveArtifactProvenancePayload(liveArtifact: LiveArtifact): unknown {
  return {
    documentSource: liveArtifact.document?.sourceJson ?? null,
  };
}

function liveArtifactRefreshPayload(liveArtifact: LiveArtifact): unknown {
  return {
    refreshStatus: liveArtifact.refreshStatus,
    lastRefreshedAt: liveArtifact.lastRefreshedAt ?? null,
  };
}

type LiveArtifactRefreshStatus = LiveArtifact['refreshStatus'];

interface LiveArtifactRefreshEvent {
  id: number;
  phase: 'started' | 'succeeded' | 'failed';
  at: number;
  durationMs?: number;
  refreshedSourceCount?: number;
  error?: string;
}

let refreshEventSequence = 0;

function appendRefreshEvent(
  prev: LiveArtifactRefreshEvent[],
  next: Omit<LiveArtifactRefreshEvent, 'id' | 'at' | 'durationMs'>,
): LiveArtifactRefreshEvent[] {
  const at = Date.now();
  refreshEventSequence += 1;
  const event: LiveArtifactRefreshEvent = { ...next, id: refreshEventSequence, at };
  if (next.phase !== 'started') {
    // Pair with the most recent 'started' to compute duration.
    for (let i = prev.length - 1; i >= 0; i -= 1) {
      const candidate = prev[i];
      if (candidate && candidate.phase === 'started') {
        event.durationMs = Math.max(0, at - candidate.at);
        break;
      }
    }
  }
  // Cap at 25 entries to keep the panel lightweight.
  const MAX = 25;
  const combined = [...prev, event];
  return combined.length > MAX ? combined.slice(combined.length - MAX) : combined;
}

function formatAbsoluteDateTime(iso: string | number | undefined): string | null {
  if (iso === undefined || iso === null) return null;
  const date = typeof iso === 'number' ? new Date(iso) : new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return date.toISOString();
  }
}

function formatRelativeTime(
  iso: string | number | undefined,
  now = Date.now(),
  locale: Locale = 'en',
  t?: TranslateFn,
): string | null {
  if (iso === undefined || iso === null) return null;
  const ms = typeof iso === 'number' ? iso : new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const deltaSec = Math.round((ms - now) / 1000);
  const abs = Math.abs(deltaSec);
  if (abs < 5) {
    // "just now" lives in the i18n dict because Intl.RelativeTimeFormat's
    // "0 seconds ago" reads awkwardly in narrow style and we want a
    // single canonical translation per locale. Fall back to the English
    // literal only when called without t (background utilities, tests).
    return t ? t('liveArtifact.refresh.justNow') : 'just now';
  }
  // Intl.RelativeTimeFormat handles tense (past / future), pluralisation,
  // and word-order per locale so the panel matches the rest of the
  // localised UI instead of mixing in English units like `5s ago`.
  // `style: 'narrow'` keeps the English output close to the historical
  // `5s ago` shape; `numeric: 'always'` forces numeric output so we
  // don't get "yesterday" / "now" mixed in unexpectedly with the
  // bucketing above.
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { style: 'narrow', numeric: 'always' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { style: 'narrow', numeric: 'always' });
  }
  const value = deltaSec; // negative = past, positive = future
  if (abs < 60) return rtf.format(value, 'second');
  if (abs < 3600) return rtf.format(Math.round(value / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(value / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(value / 86400), 'day');
  if (abs < 86400 * 365) return rtf.format(Math.round(value / (86400 * 30)), 'month');
  return rtf.format(Math.round(value / (86400 * 365)), 'year');
}

function formatDurationMs(ms: number | undefined): string | null {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return null;
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

interface RefreshStatusDescriptor {
  label: string;
  tone: 'neutral' | 'running' | 'success' | 'warning' | 'error';
  description: string;
}

function describeRefreshStatus(
  status: LiveArtifactRefreshStatus,
  t: TranslateFn,
): RefreshStatusDescriptor {
  switch (status) {
    case 'running':
      return {
        label: t('liveArtifact.refresh.statusRunning'),
        tone: 'running',
        description: t('liveArtifact.refresh.statusRunningDescription'),
      };
    case 'succeeded':
      return {
        label: t('liveArtifact.refresh.statusSucceeded'),
        tone: 'success',
        description: t('liveArtifact.refresh.statusSucceededDescription'),
      };
    case 'failed':
      return {
        label: t('liveArtifact.refresh.statusFailed'),
        tone: 'error',
        description: t('liveArtifact.refresh.statusFailedDescription'),
      };
    case 'idle':
      return {
        label: t('liveArtifact.refresh.statusReady'),
        tone: 'neutral',
        description: t('liveArtifact.refresh.statusReadyDescription'),
      };
    case 'never':
    default:
      return {
        label: t('liveArtifact.refresh.statusNever'),
        tone: 'warning',
        description: t('liveArtifact.refresh.statusNeverDescription'),
      };
  }
}

function describeEventPhase(
  event: LiveArtifactRefreshEvent,
  t: TranslateFn,
): { label: string; tone: 'running' | 'success' | 'error' } {
  if (event.phase === 'started')
    return { label: t('liveArtifact.refresh.eventStarted'), tone: 'running' };
  if (event.phase === 'succeeded')
    return { label: t('liveArtifact.refresh.eventSucceeded'), tone: 'success' };
  return { label: t('liveArtifact.refresh.eventFailed'), tone: 'error' };
}

function describePersistedStatus(
  status: LiveArtifactRefreshLogEntry['status'],
  t: TranslateFn,
): string {
  switch (status) {
    case 'succeeded':
      return t('liveArtifact.refresh.persistedStatusSucceeded');
    case 'running':
      return t('liveArtifact.refresh.persistedStatusRunning');
    case 'failed':
      return t('liveArtifact.refresh.persistedStatusFailed');
    case 'cancelled':
      return t('liveArtifact.refresh.persistedStatusCancelled');
    case 'skipped':
      return t('liveArtifact.refresh.persistedStatusSkipped');
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function LiveArtifactRefreshHistoryPanel({
  liveArtifact,
  fallbackRefreshStatus,
  fallbackLastRefreshedAt,
  isRunning,
  sessionEvents,
  persistedEvents = [],
}: {
  liveArtifact: LiveArtifact | null;
  fallbackRefreshStatus: LiveArtifactRefreshStatus;
  fallbackLastRefreshedAt?: string;
  isRunning: boolean;
  sessionEvents: LiveArtifactRefreshEvent[];
  persistedEvents?: LiveArtifactRefreshLogEntry[];
}) {
  const t = useT();
  const { locale } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Keep relative timestamps fresh; 30s cadence is enough for "x minutes ago" feel.
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const status: LiveArtifactRefreshStatus = isRunning
    ? 'running'
    : liveArtifact?.refreshStatus ?? fallbackRefreshStatus;
  const descriptor = describeRefreshStatus(status, t);
  const lastRefreshedAt = liveArtifact?.lastRefreshedAt ?? fallbackLastRefreshedAt;
  const createdAt = liveArtifact?.createdAt;
  const updatedAt = liveArtifact?.updatedAt;
  const documentSource = liveArtifact?.document?.sourceJson ?? null;
  const reversedEvents = [...sessionEvents].reverse();
  const reversedPersistedEvents = [...persistedEvents].reverse().slice(0, 25);
  const rawDebugPayload = liveArtifact
    ? {
        refresh: liveArtifactRefreshPayload(liveArtifact),
        metadata: liveArtifactMetadataPayload(liveArtifact),
        provenance: liveArtifactProvenancePayload(liveArtifact),
      }
    : null;

  return (
    <div className="live-artifact-refresh-panel">
      <section className="live-artifact-refresh-hero">
        <div className="live-artifact-refresh-hero-main">
          <span
            className={`live-artifact-badge refresh-status tone-${descriptor.tone}`}
            data-testid="live-artifact-refresh-status-badge"
          >
            {descriptor.label}
          </span>
          <p className="live-artifact-refresh-hero-desc">{descriptor.description}</p>
        </div>
        <div className="live-artifact-refresh-hero-meta">
          <div className="live-artifact-refresh-hero-metric">
            <span className="live-artifact-refresh-label">
              {t('liveArtifact.refresh.heroLastRefreshedLabel')}
            </span>
            {lastRefreshedAt ? (
              <>
                <span className="live-artifact-refresh-value">
                  {formatRelativeTime(lastRefreshedAt, now, locale, t) ?? '—'}
                </span>
                <span
                  className="live-artifact-refresh-sub"
                  title={formatAbsoluteDateTime(lastRefreshedAt) ?? undefined}
                >
                  {formatAbsoluteDateTime(lastRefreshedAt) ?? ''}
                </span>
              </>
            ) : (
              <span className="live-artifact-refresh-value muted">
                {t('liveArtifact.refresh.heroLastRefreshedNever')}
              </span>
            )}
          </div>
        </div>
      </section>

      <section className="live-artifact-refresh-facts">
        <LiveArtifactRefreshFact
          label={t('liveArtifact.refresh.factCreated')}
          iso={createdAt}
          emptyLabel={t('liveArtifact.refresh.factUnknown')}
          now={now}
          locale={locale}
          t={t}
        />
        <LiveArtifactRefreshFact
          label={t('liveArtifact.refresh.factLastUpdated')}
          iso={updatedAt}
          emptyLabel={t('liveArtifact.refresh.factUnknown')}
          now={now}
          locale={locale}
          t={t}
        />
      </section>

      <section className="live-artifact-refresh-section">
        <header className="live-artifact-refresh-section-header">
          <h4>{t('liveArtifact.refresh.persistedTitle')}</h4>
          <span className="live-artifact-refresh-hint">
            {t('liveArtifact.refresh.persistedHint')}
          </span>
        </header>
        {reversedPersistedEvents.length === 0 ? (
          <div className="live-artifact-refresh-empty">
            {t('liveArtifact.refresh.persistedEmpty')}
          </div>
        ) : (
          <ol className="live-artifact-refresh-timeline">
            {reversedPersistedEvents.map((event) => {
              const tone = event.status === 'succeeded'
                ? 'success'
                : event.status === 'running'
                  ? 'running'
                  : event.status === 'failed' || event.status === 'cancelled'
                    ? 'error'
                    : 'running';
              const duration = formatDurationMs(event.durationMs);
              return (
                <li key={`${event.refreshId}:${event.sequence}`} className={`live-artifact-refresh-event tone-${tone}`}>
                  <span className="live-artifact-refresh-event-dot" aria-hidden />
                  <div className="live-artifact-refresh-event-body">
                    <div className="live-artifact-refresh-event-row">
                      <span className={`live-artifact-badge refresh-status tone-${tone}`}>
                        {describePersistedStatus(event.status, t)}
                      </span>
                      <strong>{event.step}</strong>
                      <span className="live-artifact-refresh-event-time">
                        {formatRelativeTime(event.startedAt, now, locale, t)
                          ?? t('liveArtifact.refresh.justNow')}
                      </span>
                    </div>
                    <div className="live-artifact-refresh-event-meta">
                      <span>{event.refreshId}</span>
                      {duration ? <span>{duration}</span> : null}
                      {event.error?.message ? <span>{event.error.message}</span> : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="live-artifact-refresh-section">
        <header className="live-artifact-refresh-section-header">
          <h4>{t('liveArtifact.refresh.sessionTitle')}</h4>
          <span className="live-artifact-refresh-hint">
            {t('liveArtifact.refresh.sessionHint')}
          </span>
        </header>
        {reversedEvents.length === 0 ? (
          <div className="live-artifact-refresh-empty">
            {t('liveArtifact.refresh.timelineEmpty')}
          </div>
        ) : (
          <ol className="live-artifact-refresh-timeline">
            {reversedEvents.map((event) => {
              const phase = describeEventPhase(event, t);
              const duration = formatDurationMs(event.durationMs);
              const refreshedCount = event.refreshedSourceCount ?? 0;
              return (
                <li key={event.id} className={`live-artifact-refresh-event tone-${phase.tone}`}>
                  <span className="live-artifact-refresh-event-dot" aria-hidden />
                  <div className="live-artifact-refresh-event-body">
                    <div className="live-artifact-refresh-event-row">
                      <span
                        className={`live-artifact-badge refresh-status tone-${phase.tone}`}
                      >
                        {phase.label}
                      </span>
                      <span
                        className="live-artifact-refresh-event-time"
                        title={formatAbsoluteDateTime(event.at) ?? undefined}
                      >
                        {formatRelativeTime(event.at, now, locale, t) ?? ''}
                      </span>
                    </div>
                    <div className="live-artifact-refresh-event-detail">
                      {event.phase === 'succeeded' ? (
                        <span>
                          {t(
                            refreshedCount === 1
                              ? 'liveArtifact.refresh.sourcesUpdatedOne'
                              : 'liveArtifact.refresh.sourcesUpdatedMany',
                            { n: refreshedCount },
                          )}
                          {duration ? ` · ${duration}` : ''}
                        </span>
                      ) : event.phase === 'failed' ? (
                        <span>
                          {event.error ?? t('liveArtifact.refresh.genericFailure')}
                          {duration ? ` · ${duration}` : ''}
                        </span>
                      ) : (
                        <span>{t('liveArtifact.refresh.eventStartedDetail')}</span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {documentSource ? (
        <section className="live-artifact-refresh-section">
          <header className="live-artifact-refresh-section-header">
            <h4>{t('liveArtifact.refresh.docSourceTitle')}</h4>
            <span className="live-artifact-refresh-hint">
              {t('liveArtifact.refresh.docSourceHint')}
            </span>
          </header>
          <dl className="live-artifact-refresh-kv">
            <div>
              <dt>{t('liveArtifact.refresh.docSourceType')}</dt>
              <dd>{documentSource.type}</dd>
            </div>
            {documentSource.toolName ? (
              <div>
                <dt>{t('liveArtifact.refresh.docSourceTool')}</dt>
                <dd>
                  <code>{documentSource.toolName}</code>
                </dd>
              </div>
            ) : null}
            {documentSource.connector ? (
              <div>
                <dt>{t('liveArtifact.refresh.docSourceConnector')}</dt>
                <dd>
                  {documentSource.connector.accountLabel ??
                    documentSource.connector.connectorId}
                </dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}

      {rawDebugPayload != null ? (
        <details className="live-artifact-refresh-raw">
          <summary>{t('liveArtifact.refresh.debugSummary')}</summary>
          <p className="live-artifact-refresh-raw-note">
            {t('liveArtifact.refresh.debugNote')}
          </p>
          <pre className="viewer-source">{JSON.stringify(rawDebugPayload, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

function LiveArtifactRefreshFact({
  label,
  iso,
  value,
  helper,
  emptyLabel,
  now,
  locale,
  t,
}: {
  label: string;
  iso?: string;
  value?: string;
  helper?: string;
  emptyLabel?: string;
  now?: number;
  locale?: Locale;
  t?: TranslateFn;
}) {
  const relative = iso !== undefined ? formatRelativeTime(iso, now, locale, t) : null;
  const absolute = iso !== undefined ? formatAbsoluteDateTime(iso) : null;
  const resolved = value ?? relative ?? emptyLabel ?? '—';
  const sub = helper ?? (iso !== undefined ? absolute ?? '' : '');
  return (
    <div className="live-artifact-refresh-fact">
      <span className="live-artifact-refresh-label">{label}</span>
      <span className="live-artifact-refresh-value" title={absolute ?? undefined}>
        {resolved}
      </span>
      {sub ? <span className="live-artifact-refresh-sub">{sub}</span> : null}
    </div>
  );
}
