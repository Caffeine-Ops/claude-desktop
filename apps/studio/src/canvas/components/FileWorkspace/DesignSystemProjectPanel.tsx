import { useEffect, useMemo, useState } from 'react';
import {
  projectFileUrl,
  updateDesignSystemDraft,
} from '../../providers/registry';
import { deriveFileOps } from '../../runtime/file-ops';
import { latestTodosFromEvents } from '../../runtime/todos';
import {
  type AgentEvent,
  type DesignSystemSummary,
  type ProjectMetadata,
  type ProjectFile,
} from '../../types';
import { Icon } from '../shared/Icon';
import {
  buildDesignSystemReviewSections,
  designSystemGenerationProgress,
  designSystemGenerationReviewHasStarted,
  designSystemGithubEvidenceState,
  designSystemInitialGenerationSteps,
  designSystemReviewAgentTaskLabel,
  designSystemReviewGroups,
  designSystemReviewNeedsAttention,
  designSystemReviewTimeLabel,
  designSystemSectionActivity,
  designSystemSectionChangedAfterReview,
  designSystemSectionPreviewFile,
  designSystemSectionRunningNotice,
  designSystemSectionStatus,
  designSystemSectionStatusClass,
  designSystemSectionStatusLabel,
  designSystemSectionVisibleDuringGeneration,
  slugForTestId,
} from './designSystemHelpers';
import type {
  DesignSystemProjectSectionReview,
  DesignSystemReviewAgentTask,
  DesignSystemReviewDecision,
  DesignSystemReviewDetails,
} from './types';

export function DesignSystemProjectPanel({
  projectId,
  system,
  files,
  streaming,
  activityEvents,
  onOpenFile,
  onUploadAssets,
  defaultDesignSystemId,
  onSetDefaultDesignSystem,
  onDesignSystemsRefresh,
  onNeedsWork,
  designSystemReview,
  onReviewDecision,
  onUseDesignSystem,
}: {
  projectId: string;
  system: DesignSystemSummary;
  files: ProjectFile[];
  streaming: boolean;
  activityEvents: AgentEvent[];
  onOpenFile: (name: string) => void;
  onUploadAssets: () => void;
  defaultDesignSystemId?: string | null;
  onSetDefaultDesignSystem?: (id: string) => void;
  onDesignSystemsRefresh?: () => Promise<void> | void;
  onNeedsWork?: (
    sectionTitle: string,
    feedback: string,
    files: string[],
  ) => DesignSystemReviewAgentTask | void;
  designSystemReview?: ProjectMetadata['designSystemReview'];
  onReviewDecision?: (
    sectionTitle: string,
    decision: DesignSystemReviewDecision,
    details?: DesignSystemReviewDetails,
  ) => void;
  onUseDesignSystem?: (id: string, title: string) => void;
}) {
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, DesignSystemReviewDecision>>({});
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [feedbackSection, setFeedbackSection] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState('');
  const [status, setStatus] = useState(system.status ?? 'draft');
  const [statusBusy, setStatusBusy] = useState(false);
  useEffect(() => {
    setStatus(system.status ?? 'draft');
  }, [system.status]);
  useEffect(() => {
    const next: Record<string, DesignSystemReviewDecision> = {};
    for (const [sectionTitle, entry] of Object.entries(designSystemReview ?? {})) {
      next[sectionTitle] = entry.decision;
    }
    setReviewDecisions(next);
  }, [designSystemReview]);
  const allFileNames = files.map((file) => file.name);
  const fileByName = new Map(files.map((file) => [file.name, file]));
  const fontFiles = allFileNames.filter((name) =>
    /\.(otf|ttf|woff|woff2)$/i.test(name) || name.toLowerCase().includes('/fonts/'),
  );
  const githubEvidence = designSystemGithubEvidenceState(system, allFileNames);
  const sections = buildDesignSystemReviewSections(allFileNames, fileByName);
  const published = status === 'published';
  const isDefault = published && defaultDesignSystemId === system.id;
  const activityFileOps = useMemo(() => deriveFileOps(activityEvents), [activityEvents]);
  const activityTodos = useMemo(() => latestTodosFromEvents(activityEvents), [activityEvents]);
  const sectionReviews: DesignSystemProjectSectionReview[] = sections.map((section) => {
    const previewFile = designSystemSectionPreviewFile(section.files, fileByName);
    const reviewEntry = designSystemReview?.[section.title];
    const reviewDecision = reviewDecisions[section.title] ?? reviewEntry?.decision;
    const sectionActivity = designSystemSectionActivity(section, activityFileOps, activityTodos);
    const changedAfterFeedback = designSystemSectionChangedAfterReview(
      section.files,
      fileByName,
      reviewEntry,
    );
    const sectionStatus = designSystemSectionStatus(
      section,
      reviewDecision,
      changedAfterFeedback,
      sectionActivity,
    );
    return {
      section,
      previewFile,
      reviewEntry,
      sectionActivity,
      changedAfterFeedback,
      sectionStatus,
      sectionStatusLabel: designSystemSectionStatusLabel(section, sectionStatus, sectionActivity),
      reviewTimeLabel: reviewEntry?.updatedAt
        ? designSystemReviewTimeLabel(reviewEntry.updatedAt)
        : null,
    };
  });
  const generationReviewHasStarted = published || designSystemGenerationReviewHasStarted(sectionReviews);
  const visibleSectionReviews = streaming && !published && generationReviewHasStarted
    ? sectionReviews.filter((item) => designSystemSectionVisibleDuringGeneration(item))
    : sectionReviews;
  const needsReviewSectionReviews = visibleSectionReviews.filter(designSystemReviewNeedsAttention);
  const primaryNeedsReview = needsReviewSectionReviews.slice(0, 1);
  const groupedSectionReviews = designSystemReviewGroups(visibleSectionReviews);
  const creatingInitialDraft = streaming && !published;
  const generationSteps = designSystemInitialGenerationSteps({
    files,
    sectionReviews,
    system,
  });
  const generationProgress = designSystemGenerationProgress(generationSteps);

  async function togglePublished(nextPublished: boolean) {
    if (nextPublished && !githubEvidence.ready) return;
    setStatusBusy(true);
    try {
      const nextStatus = nextPublished ? 'published' : 'draft';
      const updated = await updateDesignSystemDraft(system.id, { status: nextStatus });
      if (updated) setStatus(updated.status ?? nextStatus);
      await onDesignSystemsRefresh?.();
    } finally {
      setStatusBusy(false);
    }
  }

  function markSectionReview(
    sectionTitle: string,
    decision: DesignSystemReviewDecision,
    details?: DesignSystemReviewDetails,
  ) {
    setReviewDecisions((current) => ({ ...current, [sectionTitle]: decision }));
    onReviewDecision?.(sectionTitle, decision, details);
    if (decision === 'looks-good' && feedbackSection === sectionTitle) {
      setFeedbackSection(null);
      setFeedbackText('');
    }
  }

  function toggleSection(sectionTitle: string) {
    setExpandedSections((current) => ({
      ...current,
      [sectionTitle]: !(current[sectionTitle] ?? false),
    }));
  }

  function openNeedsWorkFeedback(sectionTitle: string) {
    setReviewDecisions((current) => ({ ...current, [sectionTitle]: 'needs-work' }));
    setExpandedSections((current) => ({ ...current, [sectionTitle]: true }));
    setFeedbackSection(sectionTitle);
    setFeedbackText('');
  }

  function submitNeedsWorkFeedback(sectionTitle: string, sectionFiles: string[]) {
    const feedback = feedbackText.trim();
    if (!feedback) return;
    const agentTask = onNeedsWork?.(sectionTitle, feedback, sectionFiles);
    markSectionReview(sectionTitle, 'needs-work', {
      feedback,
      files: sectionFiles,
      ...(agentTask ? { agentTask } : {}),
    });
    setFeedbackSection(null);
    setFeedbackText('');
  }

  function renderReviewCard(
    item: DesignSystemProjectSectionReview,
    instanceId: string,
    defaultExpanded: boolean,
  ) {
    const {
      section,
      previewFile,
      reviewEntry,
      sectionActivity,
      changedAfterFeedback,
      sectionStatus,
      sectionStatusLabel,
    } = item;
    const expanded = (expandedSections[instanceId] ?? defaultExpanded) || sectionActivity.running;
    const needsAttention = designSystemReviewNeedsAttention(item);
    return (
      <section
        key={instanceId}
        className={[
          'ds-project-section',
          'ds-project-review-item',
          expanded ? 'is-expanded' : 'is-collapsed',
        ].join(' ')}
      >
        <div className="ds-project-section-head">
          <button
            type="button"
            className="ds-project-section-title"
            aria-expanded={expanded}
            onClick={() => toggleSection(instanceId)}
          >
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} />
            <span>
              <strong>{section.title}</strong>
              <small>{section.subtitle}</small>
            </span>
          </button>
          {expanded ? (
            <div className="ds-project-review-actions" aria-label={`${section.title} review`}>
              <button
                type="button"
                className={`ghost success ${reviewDecisions[section.title] === 'looks-good' ? 'active' : ''}`}
                data-testid={`design-system-review-good-${slugForTestId(section.title)}`}
                onClick={() => markSectionReview(section.title, 'looks-good')}
              >
                <Icon name="check" size={13} />
                Looks good
              </button>
              <button
                type="button"
                className={`ghost danger ${reviewDecisions[section.title] === 'needs-work' ? 'active' : ''}`}
                data-testid={`design-system-review-work-${slugForTestId(section.title)}`}
                onClick={() => openNeedsWorkFeedback(section.title)}
              >
                <Icon name="comment" size={13} />
                Needs work...
              </button>
              {feedbackSection === section.title ? (
                <form
                  className="ds-project-feedback-popover"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitNeedsWorkFeedback(section.title, section.files);
                  }}
                >
                  <label htmlFor={`ds-feedback-${slugForTestId(section.title)}`}>
                    Tell the agent what to change
                  </label>
                  <textarea
                    id={`ds-feedback-${slugForTestId(section.title)}`}
                    value={feedbackText}
                    rows={3}
                    placeholder={`e.g. tighten spacing in ${section.title}, regenerate this preview...`}
                    onChange={(event) => setFeedbackText(event.target.value)}
                    autoFocus
                  />
                  <div>
                    <button
                      type="button"
                      className="ghost compact"
                      onClick={() => {
                        setFeedbackSection(null);
                        setFeedbackText('');
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="primary compact"
                      disabled={!feedbackText.trim()}
                    >
                      Send
                    </button>
                  </div>
                </form>
              ) : null}
            </div>
          ) : (
            <span
              className={[
                'ds-project-section-state',
                'ds-project-section-dot',
                designSystemSectionStatusClass(sectionStatus),
              ].join(' ')}
              aria-label={sectionStatusLabel}
              title={sectionStatusLabel}
            >
              {needsAttention ? 'Needs review' : 'Looks good'}
            </span>
          )}
        </div>
        {expanded ? (
          <div className="ds-project-section-body">
            {sectionActivity.running ? (
              <div className="ds-project-review-notice is-running">
                <Icon name="sparkles" size={14} />
                <span>{designSystemSectionRunningNotice(section, sectionActivity)}</span>
              </div>
            ) : changedAfterFeedback || sectionActivity.mutated ? (
              <div className="ds-project-review-notice">
                <Icon name="check" size={14} />
                <span>
                  {changedAfterFeedback
                    ? 'This section changed after your feedback. Review it again before publishing.'
                    : 'This section changed during the latest run. Review it before publishing.'}
                </span>
              </div>
            ) : null}
            {reviewEntry?.decision === 'needs-work' && reviewEntry.feedback ? (
              <div className="ds-project-last-feedback">
                <Icon name="comment" size={14} />
                <span>
                  <strong>Last feedback</strong>
                  <small>{reviewEntry.feedback}</small>
                  {reviewEntry.agentTask ? (
                    <small>{designSystemReviewAgentTaskLabel(reviewEntry.agentTask)}</small>
                  ) : null}
                </span>
              </div>
            ) : null}
            {previewFile ? (
              <button
                type="button"
                className="ds-project-inline-preview"
                onClick={() => onOpenFile(previewFile.name)}
              >
                <DesignSystemInlinePreview projectId={projectId} file={previewFile} />
              </button>
            ) : (
              <div className="ds-project-preview-placeholder">
                <Icon name="sparkles" size={16} />
                <span>Generating preview...</span>
              </div>
            )}
          </div>
        ) : null}
      </section>
    );
  }

  if (creatingInitialDraft) {
    return (
      <div className="ds-project-panel ds-project-panel--generating">
        <div className="ds-project-generation-stage">
          <span className="ds-project-generation-mark">
            <Icon name="blocks" size={24} />
          </span>
          <h1>Creating your design system...</h1>
          <p>Keep this tab open. You can come back in a few minutes.</p>
          <div
            className="ds-project-generation-progress"
            role="progressbar"
            aria-label={`Design system generation progress ${generationProgress}%`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={generationProgress}
          >
            <span style={{ width: `${generationProgress}%` }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-project-panel">
      <div className="ds-project-main ds-project-main--review">
        <div className="ds-project-head ds-project-head--review">
          <h1>{published ? 'Your design system is ready' : 'Review draft design system'}</h1>
        </div>

        <div className="ds-project-publish-card ds-project-publish-card--review">
          <p>
            {published
              ? "Your team's new projects can use this design system as context by default."
              : 'Your design system is ready, but your feedback will improve it. Publish it when it is ready to use in future projects.'}
          </p>
          <div className="ds-project-publish-card__toggles">
            <label>
              <input
                type="checkbox"
                checked={published}
                disabled={statusBusy || (!published && !githubEvidence.ready)}
                title={!githubEvidence.ready ? 'GitHub connector evidence is required before publishing.' : undefined}
                onChange={(event) => void togglePublished(event.target.checked)}
              />
              Published
            </label>
            {published ? (
              <label>
                <input
                  type="checkbox"
                  checked={isDefault}
                  disabled={statusBusy}
                  onChange={(event) => {
                    if (event.target.checked) onSetDefaultDesignSystem?.(system.id);
                  }}
                />
                Default
              </label>
            ) : null}
          </div>
          {published ? (
            <div className="ds-project-use-row">
              <span>Use this system</span>
              <button
                type="button"
                className="ghost compact"
                onClick={() => onUseDesignSystem?.(system.id, system.title)}
              >
                <Icon name="external-link" size={13} />
                New design
              </button>
            </div>
          ) : null}
        </div>

        {!githubEvidence.ready ? (
          <div className="ds-project-warning-card">
            <Icon name="help-circle" size={16} />
            <span>
              <strong>Waiting for GitHub connector evidence</strong>
              <small>
                {githubEvidence.noteCount === 0
                  ? 'Run connector intake before publishing. Drafts cannot be used by other projects until repository evidence is captured.'
                  : 'Connector evidence notes exist; waiting for repository file snapshots before publishing.'}
              </small>
            </span>
            {githubEvidence.hasSourceManifest ? (
              <button type="button" className="ghost compact" onClick={() => onOpenFile('context/source-context.md')}>
                <Icon name="file" size={13} />
                Open source context
              </button>
            ) : null}
          </div>
        ) : null}

        {fontFiles.length === 0 ? (
          <div className="ds-project-warning-card">
            <Icon name="help-circle" size={16} />
            <span>
              <strong>Missing brand fonts</strong>
              <small>Open Design is rendering typography with substitute web fonts.</small>
            </span>
            <button type="button" className="ghost compact" onClick={onUploadAssets}>
              <Icon name="upload" size={13} />
              Upload fonts
            </button>
          </div>
        ) : null}

        <div className="ds-project-sections">
          {primaryNeedsReview.length > 0 ? (
            <div className="ds-project-section-group">
              {primaryNeedsReview.map((item, index) =>
                renderReviewCard(item, `needs-review:${item.section.title}`, index === 0),
              )}
            </div>
          ) : null}

          {groupedSectionReviews.map((group) => (
            <div key={group.title} className="ds-project-section-group">
              <h2>{group.title}</h2>
              {group.items.map((item) =>
                renderReviewCard(item, `${group.title}:${item.section.title}`, Boolean(item.previewFile)),
              )}
            </div>
          ))}

          {visibleSectionReviews.length === 0 ? (
            <div className="ds-project-empty-review">
              <Icon name="sparkles" size={18} />
              <span>Preview cards will appear here as the agent creates them.</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DesignSystemInlinePreview({
  projectId,
  file,
}: {
  projectId: string;
  file: ProjectFile;
}) {
  const url = projectFileUrl(projectId, file.name);
  if (file.kind === 'html') {
    return <iframe title={file.name} src={url} sandbox="allow-scripts" />;
  }
  return <img src={`${url}?v=${Math.round(file.mtime)}`} alt={file.name} />;
}
