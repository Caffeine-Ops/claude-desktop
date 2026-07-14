import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@/src/components/ui/button';
// Type-only import across the process boundary — single source of truth for
// the entry shape (the old hand-copied DesktopRuntimeLogEntry drifted: it
// was missing the `studio` source, which NaN'd the tab badge counts).
import type { RuntimeLogEntry } from '@desktop-shared/ipc-channels';

/** Keep the panel's local buffer in step with the main-process ring cap. */
const LOG_VIEW_MAX = 2000;

const LOG_SOURCE_COLOR: Record<RuntimeLogEntry['source'], string> = {
  main: '#7dd3fc', // sky — Electron main
  daemon: '#c4b5fd', // violet — daemon child
  web: '#86efac', // green — legacy web dev server
  studio: '#fda4af', // rose — studio (next dev) dev server
  renderer: '#fcd34d', // amber — renderer console
};

function logLevelColor(level: RuntimeLogEntry['level']): string {
  if (level === 'error') return '#f87171';
  if (level === 'warn') return '#fbbf24';
  if (level === 'debug') return 'var(--muted-foreground, #9ca3af)';
  return 'var(--foreground, #e5e7eb)';
}

function formatLogTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(
    d.getMilliseconds(),
    3,
  )}`;
}

/**
 * 「日志分析」section — a live tail of the desktop runtime logs (main process
 * console, daemon child stdout/stderr, dev servers, and renderer consoles),
 * fed by the `desktopLogs` preload bridge. Pulls a snapshot on mount, then
 * appends streamed lines; deduped by `seq` so the snapshot and the live
 * stream can't double-count an entry that straddles subscribe time.
 *
 * Desktop only: in a plain browser `window.desktopLogs` is absent, so we
 * render a short "desktop only" empty state instead of a dead console.
 * (NOT `window.electronSettings` — that was the dead settings-overlay
 * preload's bridge, and its absence now signals unified-studio mode in
 * App.tsx, so it must stay unset.)
 */
export function LogAnalysisSection() {
  const bridge = typeof window !== 'undefined' ? window.desktopLogs : undefined;
  const [logs, setLogs] = useState<RuntimeLogEntry[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [activeSource, setActiveSource] = useState<
    'all' | RuntimeLogEntry['source']
  >('all');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastSeqRef = useRef<number>(-1);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;

    // Append helper shared by snapshot + stream. Drops entries we've already
    // shown (seq <= lastSeq) and trims to the ring cap.
    const append = (incoming: RuntimeLogEntry[]) => {
      setLogs((prev) => {
        const fresh = incoming.filter((e) => e.seq > lastSeqRef.current);
        const last = fresh[fresh.length - 1];
        if (!last) return prev;
        lastSeqRef.current = last.seq;
        const next = prev.concat(fresh);
        return next.length > LOG_VIEW_MAX
          ? next.slice(next.length - LOG_VIEW_MAX)
          : next;
      });
    };

    bridge
      .getLogs()
      .then((snapshot) => {
        if (!cancelled) append(snapshot);
      })
      .catch(() => {
        /* overlay-only; ignore in browser / on error */
      });

    const unsubscribe = bridge.onLog((entry) => {
      if (!cancelled) append([entry]);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  // Stick to the bottom as new lines arrive (and when switching source tabs),
  // unless the user scrolled up.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, autoScroll, activeSource]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Within 24px of the bottom counts as "following"; scrolling up pauses
    // auto-scroll so the user can read history without it yanking back down.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  };

  const handleClear = () => {
    void bridge?.clearLogs();
    setLogs([]);
    lastSeqRef.current = -1;
  };

  if (!bridge) {
    return (
      <section className="settings-section">
        <div className="empty-card">仅在桌面应用内可用（需要 Electron 运行时）。</div>
      </section>
    );
  }

  // Per-source counts for the tab badges, plus the rows the active tab shows.
  const counts: Record<RuntimeLogEntry['source'], number> = {
    main: 0,
    daemon: 0,
    web: 0,
    studio: 0,
    renderer: 0,
  };
  for (const e of logs) counts[e.source] += 1;
  const visible =
    activeSource === 'all' ? logs : logs.filter((e) => e.source === activeSource);

  const tabs: { id: 'all' | RuntimeLogEntry['source']; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'main', label: 'main' },
    { id: 'daemon', label: 'daemon' },
    { id: 'studio', label: 'studio' },
    { id: 'renderer', label: 'renderer' },
  ];

  return (
    <section className="settings-section">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 10,
        }}
      >
        <div
          role="tablist"
          aria-label="日志来源"
          className="grid min-h-[42px] min-w-0 gap-0.5 rounded-lg border border-border bg-muted/50 p-[3px]"
          style={
            {
              gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))`,
            } as CSSProperties
          }
        >
          {tabs.map((tab) => {
            const active = activeSource === tab.id;
            const count = tab.id === 'all' ? logs.length : counts[tab.id];
            return (
              <Button
                key={tab.id}
                type="button"
                role="tab"
                variant="ghost"
                aria-selected={active}
                onClick={() => setActiveSource(tab.id)}
                className={
                  'h-auto min-w-0 rounded-md px-3 py-2 text-xs font-semibold ' +
                  (active
                    ? 'bg-background text-foreground shadow-sm hover:bg-background'
                    : 'text-muted-foreground')
                }
              >
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  {tab.id !== 'all' ? (
                    <span
                      className="inline-block size-[7px] shrink-0 rounded-full"
                      style={{ background: LOG_SOURCE_COLOR[tab.id] }}
                    />
                  ) : null}
                  <span className="truncate">{tab.label}</span>
                  <span className="tabular-nums opacity-60">{count}</span>
                </span>
              </Button>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {bridge.revealLogFile ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void bridge.revealLogFile?.()}
              title="在文件管理器中显示日志文件（面板内容 + 进程级错误都会持久化到该文件）"
            >
              查看日志文件
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClear}
            title="清空内存日志并删除磁盘上的日志文件"
          >
            清空
          </Button>
        </div>
      </div>

      {!autoScroll ? (
        <div
          style={{
            fontSize: 11,
            color: 'var(--muted-foreground, #9ca3af)',
            marginBottom: 6,
          }}
        >
          已暂停跟随（滚动到底部可恢复自动跟随）
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          height: 'min(60vh, 520px)',
          overflowY: 'auto',
          borderRadius: 8,
          border: '1px solid var(--od-border, #2a2a2a)',
          background: 'var(--card, #0c0c0c)',
          padding: '8px 10px',
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
          fontSize: 11.5,
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {visible.length === 0 ? (
          <div style={{ color: 'var(--muted-foreground, #9ca3af)', padding: 6 }}>
            {logs.length === 0
              ? '暂无日志。运行时输出会实时出现在这里。'
              : `${activeSource} 暂无日志。`}
          </div>
        ) : (
          visible.map((entry) => (
            <div key={entry.seq} style={{ display: 'flex', gap: 8 }}>
              <span
                style={{
                  color: 'var(--muted-foreground, #6b7280)',
                  flexShrink: 0,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatLogTime(entry.ts)}
              </span>
              {activeSource === 'all' ? (
                <span
                  style={{
                    color: LOG_SOURCE_COLOR[entry.source],
                    flexShrink: 0,
                    width: 64,
                    display: 'inline-block',
                  }}
                >
                  {entry.source}
                </span>
              ) : null}
              <span style={{ color: logLevelColor(entry.level), flex: 1 }}>
                {entry.text}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
