import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { DesignSystemSummary } from '../../types';
import { Icon } from '../shared/Icon';
import { Skeleton } from '../shared/Loading';

/* ============================================================
   Design system picker — custom popover (replaces native <select>).
   - Single-select by default. Toggle in the popover header switches to
     multi-select, which lets users blend up to a few inspirations
     (first pick is the primary; the rest go into metadata).
   - Trigger card mirrors the claude.ai/design treatment: a tiny brand
     swatch strip + title + "Default" subtitle + chevron.
   ============================================================ */
export function DesignSystemPicker({
  designSystems,
  defaultDesignSystemId,
  selectedIds,
  multi,
  onChange,
  onChangeMulti,
  loading,
}: {
  designSystems: DesignSystemSummary[];
  defaultDesignSystemId: string | null;
  selectedIds: string[];
  multi: boolean;
  onChange: (ids: string[]) => void;
  onChangeMulti: (v: boolean) => void;
  loading: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const byId = useMemo(() => {
    const map = new Map<string, DesignSystemSummary>();
    for (const d of designSystems) map.set(d.id, d);
    return map;
  }, [designSystems]);

  // Sort: selected first (in pick order), then default DS, then alpha
  // by category then title. Keeps the popover scannable while honoring
  // the user's existing picks.
  const ordered = useMemo(() => {
    const picked = selectedIds
      .map((id) => byId.get(id))
      .filter((d): d is DesignSystemSummary => Boolean(d));
    const pickedSet = new Set(picked.map((d) => d.id));
    const rest = designSystems
      .filter((d) => !pickedSet.has(d.id))
      .sort((a, b) => {
        if (a.id === defaultDesignSystemId) return -1;
        if (b.id === defaultDesignSystemId) return 1;
        const ca = a.category || 'Other';
        const cb = b.category || 'Other';
        if (ca !== cb) return ca.localeCompare(cb);
        return a.title.localeCompare(b.title);
      });
    return [...picked, ...rest];
  }, [designSystems, byId, selectedIds, defaultDesignSystemId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((d) => {
      return (
        d.title.toLowerCase().includes(q) ||
        (d.summary || '').toLowerCase().includes(q) ||
        (d.category || '').toLowerCase().includes(q)
      );
    });
  }, [ordered, query]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    // Defer listener registration by a tick so the very click that opened
    // the popover doesn't get re-interpreted as an outside-click on the
    // mousedown that follows in the same event cycle (StrictMode also
    // double-invokes the effect, which can race the same event).
    const t = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle(id: string) {
    if (multi) {
      // Multi-select: tapping toggles membership; the *first* id in the
      // array is treated as the primary across the rest of the app.
      const has = selectedIds.includes(id);
      if (has) {
        onChange(selectedIds.filter((x) => x !== id));
      } else {
        onChange([...selectedIds, id]);
      }
    } else {
      onChange([id]);
      setOpen(false);
    }
  }

  function clearAll() {
    onChange([]);
    if (!multi) setOpen(false);
  }

  const primaryId = selectedIds[0] ?? null;
  const primary = primaryId ? byId.get(primaryId) ?? null : null;
  const extraCount = Math.max(0, selectedIds.length - 1);
  const isDefault = !!primary && primary.id === defaultDesignSystemId;

  if (loading && designSystems.length === 0) {
    return (
      <div className="newproj-section">
        <label className="newproj-label">{t('newproj.designSystem')}</label>
        <Skeleton height={56} width="100%" radius={8} />
      </div>
    );
  }

  return (
    <div className="newproj-section ds-picker" data-testid="design-system-picker" ref={wrapRef}>
      <label className="newproj-label">{t('newproj.designSystem')}</label>
      <button
        type="button"
        data-testid="design-system-trigger"
        className={`ds-picker-trigger${open ? ' open' : ''}${primary ? '' : ' empty'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <DesignSystemAvatar system={primary} extraCount={extraCount} />
        <span className="ds-picker-meta">
          <span className="ds-picker-title">
            {primary ? primary.title : t('newproj.dsNoneFreeform')}
            {extraCount > 0 ? (
              <span className="ds-picker-extra-pill">+{extraCount}</span>
            ) : null}
          </span>
          <span className="ds-picker-sub">
            {primary
              ? isDefault
                ? t('common.default')
                : primary.category || t('newproj.dsCategoryFallback')
              : t('newproj.dsNoneSubtitleEmpty')}
          </span>
        </span>
        <Icon
          name="chevron-down"
          size={14}
          className="ds-picker-chevron"
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        />
      </button>
      {open ? (
        <div className="ds-picker-popover" role="listbox">
          <div className="ds-picker-head">
            <input
              ref={searchRef}
              data-testid="design-system-search"
              className="ds-picker-search"
              placeholder={t('newproj.dsSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div
              className="ds-picker-mode"
              role="tablist"
              aria-label={t('newproj.dsModeAria')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={!multi}
                className={`ds-picker-mode-btn${!multi ? ' active' : ''}`}
                onClick={() => {
                  onChangeMulti(false);
                  if (selectedIds.length > 1) onChange(selectedIds.slice(0, 1));
                }}
              >
                {t('newproj.dsModeSingle')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={multi}
                className={`ds-picker-mode-btn${multi ? ' active' : ''}`}
                onClick={() => onChangeMulti(true)}
              >
                {t('newproj.dsModeMulti')}
              </button>
            </div>
          </div>
          <div className="ds-picker-list ds-picker-list-design-systems">
            <DsPickerItem
              active={selectedIds.length === 0}
              multi={multi}
              onClick={clearAll}
              avatar={<NoneAvatar />}
              title={t('newproj.dsNoneTitle')}
              subtitle={t('newproj.dsNoneSub')}
            />
            {filtered.length === 0 ? (
              <div className="ds-picker-empty">
                {t('newproj.dsEmpty', { query })}
              </div>
            ) : (
              filtered.map((d) => {
                const active = selectedIds.includes(d.id);
                const order = active ? selectedIds.indexOf(d.id) : -1;
                return (
                  <DsPickerItem
                    key={d.id}
                    active={active}
                    multi={multi}
                    order={order}
                    onClick={() => toggle(d.id)}
                    avatar={<DesignSystemAvatar system={d} />}
                    title={d.title}
                    badge={
                      d.id === defaultDesignSystemId
                        ? t('newproj.dsBadgeDefault')
                        : undefined
                    }
                    subtitle={d.summary || d.category || ''}
                  />
                );
              })
            )}
          </div>
          {multi && selectedIds.length > 1 ? (
            <div className="ds-picker-foot">
              <span className="ds-picker-foot-text">
                <strong>{primary?.title ?? t('newproj.dsPrimaryFallback')}</strong>{' '}
                {extraCount === 1
                  ? t('newproj.dsFootSingular')
                  : t('newproj.dsFootPlural')}
              </span>
              <button
                type="button"
                className="ds-picker-clear"
                onClick={clearAll}
              >
                {t('newproj.dsFootClear')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DsPickerItem({
  active,
  multi,
  order,
  onClick,
  avatar,
  title,
  subtitle,
  badge,
}: {
  active: boolean;
  multi: boolean;
  order?: number;
  onClick: () => void;
  avatar: React.ReactNode;
  title: string;
  subtitle: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`ds-picker-item${active ? ' active' : ''}`}
      onClick={onClick}
    >
      <span className="ds-picker-item-avatar">{avatar}</span>
      <span className="ds-picker-item-text">
        <span className="ds-picker-item-title">
          {title}
          {badge ? <span className="ds-picker-item-badge">{badge}</span> : null}
        </span>
        <span className="ds-picker-item-sub">{subtitle}</span>
      </span>
      <span
        className={`ds-picker-mark ${multi ? 'check' : 'radio'}${active ? ' active' : ''}`}
        aria-hidden
      >
        {multi ? (
          active ? (order != null && order >= 0 ? order + 1 : '✓') : ''
        ) : null}
      </span>
    </button>
  );
}

function DesignSystemAvatar({
  system,
  extraCount = 0,
}: {
  system: DesignSystemSummary | null;
  extraCount?: number;
}) {
  if (!system) return <NoneAvatar />;
  const swatches = system.swatches && system.swatches.length > 0
    ? system.swatches.slice(0, 4)
    : fallbackSwatches(system.title);
  return (
    <span className="ds-avatar" aria-hidden>
      <span className="ds-avatar-grid">
        {swatches.map((c, i) => (
          <span key={i} className="ds-avatar-cell" style={{ background: c }} />
        ))}
      </span>
      {extraCount > 0 ? (
        <span className="ds-avatar-stack">+{extraCount}</span>
      ) : null}
    </span>
  );
}

export function NoneAvatar() {
  return (
    <span className="ds-avatar ds-avatar-none" aria-hidden>
      <svg viewBox="0 0 24 24" width="16" height="16">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <line x1="6" y1="18" x2="18" y2="6" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    </span>
  );
}

// Deterministic fallback swatches for design systems whose DESIGN.md doesn't
// expose its tokens via the bold-and-hex format. Keeps the avatar visually
// distinct per-system without extra metadata fetches.
function fallbackSwatches(seed: string): string[] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const base = h % 360;
  return [
    `hsl(${base}, 18%, 96%)`,
    `hsl(${(base + 90) % 360}, 22%, 78%)`,
    `hsl(${(base + 180) % 360}, 30%, 32%)`,
    `hsl(${(base + 30) % 360}, 70%, 52%)`,
  ];
}
