import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ConnectorDetail } from '@open-design/contracts';
import { useT } from '../../i18n';
import type { ProjectTemplate } from '../../types';
import { Icon } from '../shared/Icon';
import { Skeleton } from '../shared/Loading';
import { DESIGN_PLATFORMS, type NewProjectPlatform } from './types';

export function PlatformPicker({
  value,
  onChange,
}: {
  value: NewProjectPlatform[];
  onChange: (v: NewProjectPlatform[]) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  function togglePlatform(next: NewProjectPlatform) {
    const active = value.includes(next);
    const updated = active
      ? value.filter((item) => item !== next)
      : [...value, next];
    onChange(updated.length > 0 ? updated : ['responsive']);
  }

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
    // mousedown that follows in the same event cycle.
    const tid = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(tid);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const primary = DESIGN_PLATFORMS.find((o) => o.value === value[0]) ?? null;
  const extraCount = Math.max(0, value.length - 1);

  return (
    <div
      className="newproj-section ds-picker platform-picker"
      ref={wrapRef}
    >
      <label className="newproj-label">Target platforms</label>
      <button
        type="button"
        className={`ds-picker-trigger${open ? ' open' : ''}${primary ? '' : ' empty'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
      >
        <span className="ds-picker-meta">
          <span className="ds-picker-title">
            {primary ? t(primary.labelKey) : 'Pick a platform'}
            {extraCount > 0 ? (
              <span className="ds-picker-extra-pill">+{extraCount}</span>
            ) : null}
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
        <div
          className="ds-picker-popover"
          id={listboxId}
          role="listbox"
          aria-label="Target platforms"
          aria-multiselectable="true"
        >
          <div className="ds-picker-list">
            {DESIGN_PLATFORMS.map((option) => {
              const active = value.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`ds-picker-item${active ? ' active' : ''}`}
                  onClick={() => togglePlatform(option.value)}
                >
                  <span className="ds-picker-item-text">
                    <span className="ds-picker-item-title">{t(option.labelKey)}</span>
                    <span className="ds-picker-item-sub">{t(option.hintKey)}</span>
                  </span>
                  <span
                    className={`ds-picker-mark check${active ? ' active' : ''}`}
                    aria-hidden
                  >
                    {active ? '✓' : ''}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SurfaceOptions({
  includeLandingPage,
  includeOsWidgets,
  onIncludeLandingPage,
  onIncludeOsWidgets,
}: {
  includeLandingPage: boolean;
  includeOsWidgets: boolean;
  onIncludeLandingPage: (v: boolean) => void;
  onIncludeOsWidgets: (v: boolean) => void;
}) {
  const t = useT();
  return (
    <div className="newproj-section surface-options">
      <label className="newproj-label">{t('newproj.surfaceOptionsLabel')}</label>
      <div className="compact-toggle-list">
        <CompactToggle
          label={t('newproj.includeLandingPage')}
          hint={t('newproj.includeLandingPageHint')}
          checked={includeLandingPage}
          onChange={onIncludeLandingPage}
        />
        <CompactToggle
          label={t('newproj.includeOsWidgets')}
          hint={t('newproj.includeOsWidgetsHint')}
          checked={includeOsWidgets}
          onChange={onIncludeOsWidgets}
        />
      </div>
    </div>
  );
}

// Lightweight inline toggle row. The hint moves to a native tooltip so the
// row stays one line tall — used by SurfaceOptions where the toggles are
// secondary controls and the full card treatment of ToggleRow felt too heavy.
function CompactToggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`compact-toggle${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      onClick={() => { if (!disabled) onChange(!checked); }}
      aria-pressed={checked}
      disabled={disabled}
      title={hint}
    >
      <span className="compact-toggle-label">{label}</span>
      <span className="compact-toggle-switch" aria-hidden />
    </button>
  );
}

export function FidelityPicker({
  value,
  onChange,
}: {
  value: 'wireframe' | 'high-fidelity';
  onChange: (v: 'wireframe' | 'high-fidelity') => void;
}) {
  const t = useT();
  return (
    <div className="newproj-section">
      <label className="newproj-label">{t('newproj.fidelityLabel')}</label>
      <div className="fidelity-grid">
        <FidelityCard
          active={value === 'wireframe'}
          onClick={() => onChange('wireframe')}
          label={t('newproj.fidelityWireframe')}
          variant="wireframe"
        />
        <FidelityCard
          active={value === 'high-fidelity'}
          onClick={() => onChange('high-fidelity')}
          label={t('newproj.fidelityHigh')}
          variant="high-fidelity"
        />
      </div>
    </div>
  );
}

/* ============================================================
   Connectors section (live-artifact only).
   - Lists configured connectors as compact chips so the user can
     see at a glance what data sources this artifact can pull from.
   - When no connector is configured (or the list hasn't loaded yet
     and ended up empty), shows a guidance card that, on click, opens
     the Settings → Connectors surface (the new home of the catalog).
   ============================================================ */
export function ConnectorsSection({
  connectors,
  loading,
  onOpenConnectorsTab,
}: {
  connectors?: ConnectorDetail[];
  loading: boolean;
  onOpenConnectorsTab?: () => void;
}) {
  const t = useT();
  const configured = useMemo(
    () => (connectors ?? []).filter((c) => c.status === 'connected'),
    [connectors],
  );
  const hasConfigured = configured.length > 0;

  if (loading && !connectors) {
    return (
      <div className="newproj-section newproj-connectors">
        <label className="newproj-label">{t('newproj.connectorsLabel')}</label>
        <Skeleton height={56} width="100%" radius={8} />
      </div>
    );
  }

  return (
    <div
      className="newproj-section newproj-connectors"
      data-testid="new-project-connectors"
    >
      <div className="newproj-connectors-head">
        <label className="newproj-label">{t('newproj.connectorsLabel')}</label>
        {hasConfigured ? (
          <button
            type="button"
            className="newproj-connectors-manage"
            onClick={() => onOpenConnectorsTab?.()}
            data-testid="new-project-connectors-manage"
          >
            {t('newproj.connectorsManage')}
          </button>
        ) : null}
      </div>

      {hasConfigured ? (
        <>
          <span className="newproj-connectors-hint">
            {configured.length === 1
              ? t('newproj.connectorsCountOne', { n: configured.length })
              : t('newproj.connectorsCountMany', { n: configured.length })}
            <span aria-hidden> · </span>
            {t('newproj.connectorsHint')}
          </span>
          <ul className="newproj-connectors-list" aria-label={t('newproj.connectorsLabel')}>
            {configured.map((c) => (
              <li
                key={c.id}
                className="newproj-connector-chip"
                title={c.name}
              >
                <span className="newproj-connector-dot" aria-hidden />
                <span className="newproj-connector-name">{c.name}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <button
          type="button"
          className="newproj-connectors-empty"
          onClick={() => onOpenConnectorsTab?.()}
          data-testid="new-project-connectors-empty"
          aria-label={t('newproj.connectorsEmptyCta')}
        >
          <span className="newproj-connectors-empty-icon" aria-hidden>
            <Icon name="link" size={14} />
          </span>
          <span className="newproj-connectors-empty-text">
            <span className="newproj-connectors-empty-title">
              {t('newproj.connectorsEmptyTitle')}
            </span>
            <span className="newproj-connectors-empty-body">
              {t('newproj.connectorsEmptyBody')}
            </span>
            <span className="newproj-connectors-empty-cta">
              {t('newproj.connectorsEmptyCta')}
            </span>
          </span>
        </button>
      )}
    </div>
  );
}

function FidelityCard({
  active,
  onClick,
  label,
  variant,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  variant: 'wireframe' | 'high-fidelity';
}) {
  return (
    <button
      type="button"
      className={`fidelity-card${active ? ' active' : ''}`}
      onClick={onClick}
      aria-pressed={active}
    >
      <span className={`fidelity-thumb fidelity-thumb-${variant}`} aria-hidden>
        {variant === 'wireframe' ? <WireframeArt /> : <HighFidelityArt />}
      </span>
      <span className="fidelity-label">{label}</span>
    </button>
  );
}

function WireframeArt() {
  return (
    <svg viewBox="0 0 120 70" width="100%" height="100%" aria-hidden>
      <rect x="6" y="8" width="46" height="6" rx="2" fill="#d8d4cb" />
      <rect x="6" y="20" width="34" height="4" rx="2" fill="#ebe8e1" />
      <rect x="6" y="28" width="38" height="4" rx="2" fill="#ebe8e1" />
      <rect x="6" y="36" width="30" height="4" rx="2" fill="#ebe8e1" />
      <circle cx="22" cy="56" r="6" fill="none" stroke="#d8d4cb" strokeWidth="1.4" />
      <rect x="64" y="8" width="50" height="54" rx="3" fill="none" stroke="#d8d4cb" strokeWidth="1.4" />
      <rect x="70" y="14" width="38" height="4" rx="2" fill="#ebe8e1" />
      <rect x="70" y="22" width="32" height="4" rx="2" fill="#ebe8e1" />
      <rect x="70" y="30" width="38" height="4" rx="2" fill="#ebe8e1" />
    </svg>
  );
}

function HighFidelityArt() {
  return (
    <svg viewBox="0 0 120 70" width="100%" height="100%" aria-hidden>
      <rect x="6" y="8" width="34" height="6" rx="2" fill="#1a1916" />
      <rect x="6" y="20" width="46" height="4" rx="2" fill="#74716b" />
      <rect x="6" y="28" width="42" height="4" rx="2" fill="#b3b0a8" />
      <rect x="6" y="40" width="22" height="9" rx="2" fill="#c96442" />
      <rect x="64" y="8" width="50" height="54" rx="4" fill="#fbeee5" />
      <rect x="70" y="14" width="38" height="4" rx="2" fill="#c96442" />
      <rect x="70" y="22" width="32" height="3" rx="1.5" fill="#74716b" />
      <rect x="70" y="29" width="36" height="3" rx="1.5" fill="#b3b0a8" />
      <rect x="70" y="36" width="20" height="6" rx="2" fill="#c96442" />
    </svg>
  );
}

export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`toggle-row${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}
      onClick={() => { if (!disabled) onChange(!checked); }}
      aria-pressed={checked}
      disabled={disabled}
    >
      <div className="toggle-row-text">
        <span className="toggle-row-label">{label}</span>
        {hint ? <span className="toggle-row-hint">{hint}</span> : null}
      </div>
      <span className="toggle-row-switch" aria-hidden />
    </button>
  );
}

export function TemplatePicker({
  templates,
  value,
  onChange,
  onDelete,
}: {
  templates: ProjectTemplate[];
  value: string | null;
  onChange: (id: string | null) => void;
  onDelete?: (id: string) => Promise<boolean>;
}) {
  const t = useT();
  const [confirmDelete, setConfirmDelete] = useState<
    { id: string; name: string } | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);

  function closeConfirm() {
    setConfirmDelete(null);
    setDeleting(false);
    setDeleteError(false);
  }

  async function runDelete() {
    if (!confirmDelete || !onDelete) return;
    setDeleting(true);
    setDeleteError(false);
    let ok = false;
    try {
      ok = await onDelete(confirmDelete.id);
    } catch {
      ok = false;
    }
    if (ok) {
      if (value === confirmDelete.id) onChange(null);
      closeConfirm();
    } else {
      setDeleting(false);
      setDeleteError(true);
    }
  }

  return (
    <div className="newproj-section">
      <label className="newproj-label">{t('newproj.templateLabel')}</label>
      {templates.length === 0 ? (
        <div className="template-howto">
          <span className="template-howto-title">
            {t('newproj.noTemplatesTitle')}
          </span>
          <span className="template-howto-body">
            {t('newproj.noTemplatesBody')}
          </span>
        </div>
      ) : (
        <div className="template-list">
          {templates.map((tpl) => {
            const fallbackDesc = `${t('newproj.savedTemplate')} · ${tpl.files.length} ${
              tpl.files.length === 1
                ? t('newproj.fileSingular')
                : t('newproj.filePlural')
            }`;
            return (
              <TemplateOption
                key={tpl.id}
                active={value === tpl.id}
                onClick={() => onChange(tpl.id)}
                onDelete={onDelete ? () => setConfirmDelete({ id: tpl.id, name: tpl.name }) : () => {}}
                name={tpl.name}
                description={tpl.description ?? fallbackDesc}
              />
            );
          })}
        </div>
      )}
      {confirmDelete ? (
        <div
          className="modal-backdrop"
          onClick={deleting ? undefined : closeConfirm}
        >
          <div
            className="modal modal-confirm"
            onClick={(e) => e.stopPropagation()}
            role="alertdialog"
            aria-modal="true"
          >
            <h2>{t('newproj.deleteTemplateTitle')}</h2>
            <p className="modal-confirm-message">
              {t('newproj.deleteTemplateConfirm', { name: confirmDelete.name })}
            </p>
            {deleteError ? (
              <p className="modal-confirm-error" role="alert">
                {t('newproj.deleteTemplateError')}
              </p>
            ) : null}
            <div className="row">
              <button type="button" onClick={closeConfirm} disabled={deleting}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary danger"
                autoFocus
                disabled={deleting}
                onClick={runDelete}
              >
                {t('newproj.deleteTemplateConfirmCta')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TemplateOption({
  active,
  onClick,
  onDelete,
  name,
  description,
}: {
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
  name: string;
  description: string;
}) {
  return (
    <div className={`template-option${active ? ' active' : ''}`}>
      <button
        type="button"
        className="template-option-select"
        onClick={onClick}
        aria-pressed={active}
      >
        <span className={`template-radio${active ? ' active' : ''}`} aria-hidden />
        <span className="template-option-text">
          <span className="template-option-name">{name}</span>
          <span className="template-option-desc">{description}</span>
        </span>
      </button>
      <button
        type="button"
        className="template-option-delete"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title="Delete template"
        aria-label={`Delete template ${name}`}
      >
        ✕
      </button>
    </div>
  );
}
