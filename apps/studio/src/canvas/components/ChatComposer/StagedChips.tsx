import { useEffect, useState } from "react";
import { projectRawUrl } from "../../providers/registry";
import type { ChatAttachment, ChatCommentAttachment, SkillSummary } from "../../types";
import { Icon } from "../shared/Icon";
import type { TranslateFn } from './types';

export function StagedAttachments({
  attachments,
  projectId,
  onRemove,
  t,
}: {
  attachments: ChatAttachment[];
  projectId: string | null;
  onRemove: (path: string) => void;
  t: TranslateFn;
}) {
  const [preview, setPreview] = useState<ChatAttachment | null>(null);
  const previewUrl = preview && projectId ? projectRawUrl(projectId, preview.path) : null;

  useEffect(() => {
    if (!preview) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setPreview(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview]);

  return (
    <>
      <div className="staged-row" data-testid="staged-attachments">
        {attachments.map((a) => {
          const canPreview = a.kind === "image" && Boolean(projectId);
          const imageUrl = canPreview ? projectRawUrl(projectId!, a.path) : null;
          return (
            <div key={a.path} className={`staged-chip staged-${a.kind}`}>
              {canPreview && imageUrl ? (
                <button
                  type="button"
                  className="staged-preview-trigger"
                  onClick={() => setPreview(a)}
                  title={a.path}
                  aria-label={`Preview ${a.name}`}
                >
                  <img src={imageUrl} alt="" aria-hidden />
                  <span className="staged-name">
                    {a.name}
                  </span>
                </button>
              ) : (
                <>
                  <span className="staged-icon" aria-hidden>
                    <Icon name="file" size={13} />
                  </span>
                  <span className="staged-name" title={a.path}>
                    {a.name}
                  </span>
                </>
              )}
              <button
                className="staged-remove"
                onClick={() => onRemove(a.path)}
                title={t('common.delete')}
                aria-label={t('chat.removeAria', { name: a.name })}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          );
        })}
      </div>
      {preview && previewUrl ? (
        <div
          className="staged-preview-modal"
          role="dialog"
          aria-modal="true"
          aria-label={preview.name}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPreview(null);
          }}
        >
          <div className="staged-preview-card">
            <div className="staged-preview-head">
              <span title={preview.path}>{preview.name}</span>
              <button
                type="button"
                className="icon-only"
                onClick={() => setPreview(null)}
                aria-label={t('common.close')}
                title={t('common.close')}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <img src={previewUrl} alt={preview.name} />
          </div>
        </div>
      ) : null}
    </>
  );
}

export function StagedSkills({
  skills,
  onRemove,
  t,
}: {
  skills: SkillSummary[];
  onRemove: (id: string) => void;
  t: TranslateFn;
}) {
  return (
    <div
      className="staged-row staged-skills-row"
      data-testid="staged-skills"
    >
      {skills.map((s) => (
        <div
          key={s.id}
          className={`staged-chip staged-skill staged-skill-${s.source ?? 'built-in'}`}
        >
          <span className="staged-icon" aria-hidden>
            <Icon name="sparkles" size={12} />
          </span>
          <span className="staged-name" title={s.description || s.name}>
            @{s.id}
          </span>
          <button
            className="staged-remove"
            onClick={() => onRemove(s.id)}
            title={t('common.delete')}
            aria-label={`Remove skill ${s.id}`}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

// Top chips for staged MCP servers / connectors. Skills already have
// StagedSkills; MCP + connectors previously had NO visible chip and relied
// solely on an `@token` in the prompt body. Now that picking a context
// surface no longer injects that token, this chip is their visible anchor
// + remove affordance (parallel to StagedSkills). The selection is still
// carried to the backend via meta.context (mcpServerIds / connectorIds).
export function StagedContextChips({
  kind,
  items,
  onRemove,
  t,
}: {
  kind: 'mcp' | 'connector';
  items: { id: string; label: string }[];
  onRemove: (id: string) => void;
  t: TranslateFn;
}) {
  return (
    <div
      className={`staged-row staged-context-row staged-context-row--${kind}`}
      data-testid={`staged-${kind}`}
    >
      {items.map((item) => (
        <div key={item.id} className={`staged-chip staged-context staged-context--${kind}`}>
          <span className="staged-icon" aria-hidden>
            <Icon name="link" size={12} />
          </span>
          <span className="staged-name" title={item.label}>
            {item.label}
          </span>
          <button
            className="staged-remove"
            onClick={() => onRemove(item.id)}
            title={t('common.delete')}
            aria-label={`Remove ${kind} ${item.label}`}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function StagedCommentAttachments({
  attachments,
  onRemove,
  t,
}: {
  attachments: ChatCommentAttachment[];
  onRemove: (id: string) => void;
  t: TranslateFn;
}) {
  const visibleAttachments = attachments.filter((attachment) => attachment.selectionKind !== 'visual');
  if (visibleAttachments.length === 0) return null;
  return (
    <div className="staged-row comment-staged-row" data-testid="staged-comment-attachments">
      {visibleAttachments.map((a) => (
        <div key={a.id} className="staged-chip staged-comment">
          <span className="staged-name" title={`${a.screenshotPath ? `${a.screenshotPath}: ` : ''}${a.elementId}: ${a.comment}`}>
            <strong>{a.selectionKind === 'visual' ? 'Visual mark' : a.elementId}</strong>
            <span>{a.comment}</span>
          </span>
          <button
            className="staged-remove"
            onClick={() => onRemove(a.id)}
            title={t('chat.comments.removeAttachment')}
            aria-label={t('chat.comments.removeAttachmentAria', { name: a.elementId })}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
