import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { fetchPromptTemplate } from '../../providers/registry';
import type { PromptTemplateSummary } from '../../types';
import { Icon } from '../shared/Icon';
import { NoneAvatar } from './DesignSystemPicker';
import type { PromptTemplatePick } from './types';

/* ============================================================
   Prompt template picker — for the image/video tabs only.
   - Trigger card (mirrors the design-system trigger) opens a popover
     with a search field and a thumbnail-card list filtered by surface.
   - When a template is picked we lazily fetch the full prompt body via
     fetchPromptTemplate(...) and drop it into a textarea so the user
     can tune ("optimize") the wording before clicking Create.
   - The (possibly edited) body lands in metadata.promptTemplate.prompt
     and becomes part of the system prompt — the agent treats it as a
     stylistic + structural reference for the generation request.
   ============================================================ */
export function PromptTemplatePicker({
  surface,
  templates,
  value,
  onChange,
}: {
  surface: 'image' | 'video';
  templates: PromptTemplateSummary[];
  value: PromptTemplatePick | null;
  onChange: (next: PromptTemplatePick | null) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Last template we tried to pick that failed — kept so the inline
  // banner can offer a one-click retry without making the user re-find
  // the card in the popover (which auto-closed on success). Cleared as
  // soon as a pick succeeds or the user picks a different template.
  const [lastFailedPick, setLastFailedPick] =
    useState<PromptTemplateSummary | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const surfaceScoped = useMemo(
    () => templates.filter((tpl) => tpl.surface === surface),
    [templates, surface],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return surfaceScoped;
    return surfaceScoped.filter((tpl) => {
      return (
        tpl.title.toLowerCase().includes(q) ||
        tpl.summary.toLowerCase().includes(q) ||
        (tpl.category || '').toLowerCase().includes(q) ||
        (tpl.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [surfaceScoped, query]);

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => searchRef.current?.focus(), 30);
    return () => window.clearTimeout(id);
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
    const id = window.setTimeout(() => {
      document.addEventListener('mousedown', onPointer);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function pickTemplate(summary: PromptTemplateSummary) {
    setLoadingId(summary.id);
    setError(null);
    try {
      const detail = await fetchPromptTemplate(summary.surface, summary.id);
      if (!detail) {
        setError(t('promptTemplates.fetchError'));
        setLastFailedPick(summary);
        return;
      }
      onChange({ summary, prompt: detail.prompt });
      setLastFailedPick(null);
      setOpen(false);
      setQuery('');
    } catch {
      // fetchPromptTemplate already swallows errors and returns null in
      // the happy path; this catch is a defensive net for unexpected
      // throws so the inline banner still surfaces and the user can
      // retry instead of being stuck on a permanent loading spinner.
      setError(t('promptTemplates.fetchError'));
      setLastFailedPick(summary);
    } finally {
      setLoadingId(null);
    }
  }

  function clear() {
    onChange(null);
    setLastFailedPick(null);
    setError(null);
    setOpen(false);
    setQuery('');
  }

  const triggerTitle = value?.summary.title ?? t('newproj.promptTemplateNoneTitle');
  const triggerSub = value
    ? value.summary.category || value.summary.summary || t('newproj.promptTemplateRefSub')
    : t('newproj.promptTemplateNoneSub');

  return (
    <div className="newproj-section ds-picker prompt-template-picker" ref={wrapRef}>
      <label className="newproj-label">{t('newproj.promptTemplateLabel')}</label>
      <button
        type="button"
        data-testid="prompt-template-trigger"
        className={`ds-picker-trigger${open ? ' open' : ''}${value ? '' : ' empty'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <PromptTemplateAvatar summary={value?.summary ?? null} />
        <span className="ds-picker-meta">
          <span className="ds-picker-title">{triggerTitle}</span>
          <span className="ds-picker-sub">{triggerSub}</span>
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
              data-testid="prompt-template-search"
              className="ds-picker-search"
              placeholder={t('newproj.promptTemplateSearch')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="ds-picker-list">
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              className={`ds-picker-item${value === null ? ' active' : ''}`}
              onClick={clear}
            >
              <span className="ds-picker-item-avatar">
                <NoneAvatar />
              </span>
              <span className="ds-picker-item-text">
                <span className="ds-picker-item-title">
                  {t('newproj.promptTemplateNoneTitle')}
                </span>
                <span className="ds-picker-item-sub">
                  {t('newproj.promptTemplateNoneSub')}
                </span>
              </span>
            </button>
            {filtered.length === 0 ? (
              <div className="ds-picker-empty">
                {surfaceScoped.length === 0
                  ? t('newproj.promptTemplateEmpty')
                  : t('promptTemplates.emptyNoMatch')}
              </div>
            ) : (
              filtered.map((tpl) => {
                const active = value?.summary.id === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`ds-picker-item${active ? ' active' : ''}`}
                    onClick={() => void pickTemplate(tpl)}
                    disabled={loadingId === tpl.id}
                  >
                    <span className="ds-picker-item-avatar">
                      <PromptTemplateAvatar summary={tpl} />
                    </span>
                    <span className="ds-picker-item-text">
                      <span className="ds-picker-item-title">
                        {tpl.title}
                        {loadingId === tpl.id ? (
                          <span className="ds-picker-item-badge">
                            {t('common.loading')}
                          </span>
                        ) : null}
                      </span>
                      <span className="ds-picker-item-sub">
                        {tpl.summary || tpl.category}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
      {error ? (
        <div
          className="prompt-template-error"
          role="alert"
          data-testid="prompt-template-error"
        >
          <span className="prompt-template-error-msg">{error}</span>
          {lastFailedPick ? (
            <button
              type="button"
              className="ghost prompt-template-error-retry"
              data-testid="prompt-template-retry"
              onClick={() => void pickTemplate(lastFailedPick)}
              disabled={loadingId === lastFailedPick.id}
            >
              {loadingId === lastFailedPick.id
                ? t('common.loading')
                : t('promptTemplates.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
      {value ? (
        <div className="prompt-template-edit">
          <div className="prompt-template-edit-head">
            <span className="prompt-template-edit-label">
              {t('newproj.promptTemplateBodyLabel')}
            </span>
            <span className="prompt-template-edit-hint">
              {t('newproj.promptTemplateOptimizeHint')}
            </span>
          </div>
          <textarea
            data-testid="prompt-template-body"
            className="prompt-template-edit-textarea"
            value={value.prompt}
            rows={6}
            onChange={(e) =>
              onChange({ summary: value.summary, prompt: e.target.value })
            }
          />
          {value.prompt.trim().length === 0 ? (
            <div
              className="prompt-template-edit-empty"
              data-testid="prompt-template-empty-hint"
            >
              {t('newproj.promptTemplateBodyEmpty')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PromptTemplateAvatar({
  summary,
}: {
  summary: PromptTemplateSummary | null;
}) {
  if (!summary) return <NoneAvatar />;
  if (summary.previewImageUrl) {
    return (
      <span className="ds-avatar prompt-template-avatar" aria-hidden>
        <img
          src={summary.previewImageUrl}
          alt=""
          loading="lazy"
          draggable={false}
        />
      </span>
    );
  }
  return (
    <span className="ds-avatar prompt-template-avatar fallback" aria-hidden>
      <Icon name={summary.surface === 'video' ? 'play' : 'image'} size={14} />
    </span>
  );
}
