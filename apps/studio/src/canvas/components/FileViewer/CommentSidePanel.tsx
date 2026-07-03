import { Icon } from '../shared/Icon';
import type { PreviewComment } from '../../types';
import type { TranslateFn } from './types';

function formatCommentTime(ts: number, t: TranslateFn): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('common.justNow');
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return t('common.minutesAgo', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('common.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('common.daysAgo', { n: days });
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return t('common.weeksAgo', { n: weeks });
  return new Date(ts).toLocaleDateString();
}

function commentDisplayLabel(comment: PreviewComment, t: TranslateFn): string {
  if (comment.elementId.startsWith('pin-')) return t('chat.comments.pin');
  return comment.label || comment.elementId;
}

function commentAvatarInitial(comment: PreviewComment): string {
  const seed = comment.label || comment.elementId || '?';
  return seed.charAt(0).toUpperCase();
}

export function CommentSidePanel({
  comments,
  selectedIds,
  collapsed,
  onCollapsedChange,
  onClose,
  onToggleSelect,
  onClearSelection,
  onReply,
  onSendSelected,
  sending,
  t,
}: {
  comments: PreviewComment[];
  selectedIds: Set<string>;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onClose: () => void;
  onToggleSelect: (commentId: string) => void;
  onClearSelection: () => void;
  onReply: (comment: PreviewComment) => void;
  onSendSelected: () => void | Promise<void>;
  sending: boolean;
  t: TranslateFn;
}) {
  const sorted = [...comments].sort((a, b) => b.createdAt - a.createdAt);
  const visibleSelectedIds = new Set(comments.filter((comment) => selectedIds.has(comment.id)).map((comment) => comment.id));
  const selectedCount = visibleSelectedIds.size;
  const commentsLabel = t('chat.tabComments');
  if (collapsed) {
    return (
      <button
        type="button"
        className="comment-side-rail"
        data-testid="comment-side-collapsed-rail"
        aria-label={t('preview.showSidebar', { label: commentsLabel })}
        title={t('preview.showSidebar', { label: commentsLabel })}
        onClick={() => onCollapsedChange(false)}
      >
        <Icon name="comment" size={14} />
        <span>{commentsLabel}</span>
        {comments.length > 0 ? <strong>{comments.length}</strong> : null}
      </button>
    );
  }

  return (
    <aside className="comment-side-panel" data-testid="comment-side-panel" aria-label={commentsLabel}>
      <div className="comment-side-header">
        <div className="comment-side-title">
          <Icon name="comment" size={14} />
          <span>{commentsLabel}</span>
        </div>
        <button
          type="button"
          className="comment-side-close"
          aria-label={t('common.close')}
          title={t('common.close')}
          onClick={onClose}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      <div className="comment-side-list">
        {sorted.length === 0 ? (
          <div className="comment-side-empty">
            {t('chat.comments.emptySaved')}
          </div>
        ) : sorted.map((comment) => {
          const selected = visibleSelectedIds.has(comment.id);
          return (
            <div
              key={comment.id}
              className={`comment-side-item${selected ? ' selected' : ''}`}
              data-testid="comment-side-item"
            >
              <div className="comment-side-item-head">
                <span className="comment-side-author">
                  <span className="comment-side-avatar" aria-hidden>
                    {commentAvatarInitial(comment)}
                  </span>
                  <strong>{commentDisplayLabel(comment, t)}</strong>
                </span>
                <span className="comment-side-time">{formatCommentTime(comment.createdAt, t)}</span>
                <button
                  type="button"
                  className={`comment-side-check${selected ? ' checked' : ''}`}
                  aria-label={selected ? t('chat.comments.deselect') : t('chat.comments.select')}
                  aria-pressed={selected}
                  onClick={() => onToggleSelect(comment.id)}
                >
                  {selected ? <Icon name="check" size={11} /> : null}
                </button>
              </div>
              <div className="comment-side-body">{comment.note}</div>
              <button
                type="button"
                className="comment-side-reply"
                data-testid="comment-side-edit"
                onClick={() => onReply(comment)}
              >
                {t('chat.comments.edit')}
              </button>
            </div>
          );
        })}
      </div>
      {selectedCount > 0 ? (
        <div className="comment-side-selectbar" data-testid="comment-side-selectbar">
          <span className="comment-side-selectcount">{t('chat.comments.nSelected', { n: selectedCount })}</span>
          <button type="button" className="ghost" onClick={onClearSelection}>
            {t('chat.comments.clear')}
          </button>
          <button
            type="button"
            className="primary"
            data-testid="comment-side-send-claude"
            disabled={sending}
            onClick={() => void onSendSelected()}
          >
            {sending ? t('chat.comments.sending') : t('chat.comments.sendToChat')}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
