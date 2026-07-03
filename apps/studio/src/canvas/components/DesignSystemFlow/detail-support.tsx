import { deriveFileOps } from '../../runtime/file-ops';
import { latestTodosFromEvents } from '../../runtime/todos';
import type {
  AgentEvent,
  ChatMessage,
  DesignSystemDetail,
  DesignSystemGenerationJob,
  DesignSystemProvenance,
  DesignSystemRevision,
} from '../../types';
import { Icon } from '../shared/Icon';

export function buildDesignSystemChatMessages({
  system,
  activeJob,
  revisions,
  generationActive,
}: {
  system: DesignSystemDetail | null;
  activeJob: DesignSystemGenerationJob | null;
  revisions: DesignSystemRevision[];
  generationActive: boolean;
}): ChatMessage[] {
  const createdAt = timestampFromIso(system?.createdAt) ?? Date.now();
  const messages: ChatMessage[] = [
    {
      id: 'design-system-create-request',
      role: 'user',
      content: 'Create design system',
      createdAt,
    },
    {
      id: activeJob ? `design-system-agent-${activeJob.id}` : 'design-system-agent-ready',
      role: 'assistant',
      content: designSystemAssistantMessage(system, activeJob, generationActive),
      events: [{ kind: 'text', text: designSystemAssistantMessage(system, activeJob, generationActive) }],
      createdAt: createdAt + 1,
      runId: activeJob?.id,
      runStatus: activeJob
        ? activeJob.status === 'failed'
          ? 'failed'
          : activeJob.status === 'succeeded'
            ? 'succeeded'
            : 'running'
        : undefined,
    },
  ];

  for (const revision of [...revisions].reverse()) {
    const revisionTs = timestampFromIso(revision.createdAt) ?? Date.now();
    messages.push({
      id: `design-system-revision-user-${revision.id}`,
      role: 'user',
      content: revision.sectionTitle
        ? `${revision.feedback}\n\nSection: ${revision.sectionTitle}`
        : revision.feedback,
      createdAt: revisionTs,
    });
    messages.push({
      id: `design-system-revision-assistant-${revision.id}`,
      role: 'assistant',
      content: designSystemRevisionAssistantMessage(revision),
      events: [{ kind: 'text', text: designSystemRevisionAssistantMessage(revision) }],
      createdAt: revisionTs + 1,
      runId: revision.jobId,
      runStatus: revision.status === 'pending' ? 'succeeded' : undefined,
    });
  }

  return messages;
}

function designSystemRevisionAssistantMessage(revision: DesignSystemRevision): string {
  if (revision.status === 'pending') {
    return 'I prepared a proposed update. Review the diff card on the right, then accept it or ask for another change.';
  }
  if (revision.status === 'accepted') {
    return 'Accepted. The design system draft now includes this update.';
  }
  return 'Rejected. I left the current design system unchanged.';
}

function designSystemAssistantMessage(
  system: DesignSystemDetail | null,
  activeJob: DesignSystemGenerationJob | null,
  generationActive: boolean,
): string {
  const summary = system?.summary?.trim();
  if (generationActive) {
    if (activeJob?.kind === 'revision') {
      return 'I am applying your feedback to the design system. You can keep reviewing the current draft while the revision runs.';
    }
    return 'I am creating the design system workspace, preview cards, and supporting files from the context you provided.';
  }
  const base = 'Your design system draft is ready. Review the Design System tab, inspect generated files, publish it, or ask me for changes here.';
  return summary ? `${base}\n\nCaptured direction: ${summary}` : base;
}

export function designSystemWorkspaceAgentPrompt(feedback: string): string {
  return [
    feedback,
    '',
    'Design system workspace instructions:',
    '- Treat this project folder as the editable design-system workspace.',
    '- Update DESIGN.md when the design guidance, tokens, components, brand rules, or review sections change.',
    '- Update supporting preview files, CSS tokens, assets, or UI kit examples when they help make the design system reviewable.',
    '- Keep changes scoped to this design system. Preserve existing file names unless a new supporting file is clearly needed.',
    '- After editing, briefly summarize what changed and which files are ready to review.',
  ].join('\n');
}

export function findWorkspaceActivityMessage(messages: ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    if (message.events?.some((event) => event.kind !== 'text')) return message;
    if (message.runStatus === 'queued' || message.runStatus === 'running') return message;
    if (message.runStatus === 'succeeded' || message.runStatus === 'failed' || message.runStatus === 'canceled')
      return message;
  }
  return null;
}

export function DesignSystemPackageCard({ system }: { system: DesignSystemDetail }) {
  const info = system.packageInfo;
  const manifest = info?.manifest;
  const evidence = info?.sourceEvidence;
  const sourceLabel = manifest?.source?.type ? sourceTypeLabel(manifest.source.type) : sourceTypeLabel(system.source);
  const previewPages = manifest?.preview?.pages ?? [];
  const sourceFiles = manifest?.sourceFiles;
  const sourceFileCount = [sourceFiles?.scanned, sourceFiles?.evidence, sourceFiles?.tokens, sourceFiles?.snippets]
    .filter(Boolean)
    .length;
  const protocolItems = [
    manifest?.usage ? manifest.usage : null,
    manifest?.files?.design ?? 'DESIGN.md',
    manifest?.files?.tokens ?? 'tokens.css',
    manifest?.files?.components,
    manifest?.componentsManifest,
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);
  const evidenceStats = [
    evidence?.scannedFileCount !== undefined ? { label: 'Scanned files', value: String(evidence.scannedFileCount) } : null,
    evidence?.tokenCount !== undefined ? { label: 'Source tokens', value: String(evidence.tokenCount) } : null,
    evidence?.snippetCount !== undefined ? { label: 'Snippets', value: String(evidence.snippetCount) } : null,
    manifest?.fonts?.length ? { label: 'Fonts', value: String(manifest.fonts.length) } : null,
  ].filter((item): item is { label: string; value: string } => item !== null);
  const confidence = evidence?.confidence ? Object.entries(evidence.confidence) : [];

  return (
    <section className="ds-package-card">
      <div className="ds-package-card__head">
        <span>
          <strong>{manifest ? 'Structured import package' : 'Legacy design system'}</strong>
          <small>
            {manifest
              ? `${sourceLabel} · ${manifest.importMode ?? 'normalized'} mode · manifest indexed`
              : `${sourceLabel} · DESIGN.md-only fallback`}
          </small>
        </span>
        <span className={manifest ? 'ds-package-pill is-ready' : 'ds-package-pill'}>
          {manifest ? 'Hybrid ready' : 'Fallback'}
        </span>
      </div>

      <div className="ds-package-grid">
        <div>
          <h2>Agent push layer</h2>
          <div className="ds-package-chips">
            {protocolItems.map((item) => (
              <code key={item}>{item}</code>
            ))}
          </div>
        </div>
        <div>
          <h2>Pull layer</h2>
          <div className="ds-package-metrics">
            <span><strong>{previewPages.length}</strong><small>Preview pages</small></span>
            <span><strong>{sourceFileCount}</strong><small>Evidence indexes</small></span>
            <span><strong>{manifest?.assetsDir ? 'Yes' : 'No'}</strong><small>Assets</small></span>
          </div>
        </div>
      </div>

      {evidenceStats.length > 0 || confidence.length > 0 ? (
        <div className="ds-evidence-panel">
          <div className="ds-evidence-stats">
            {evidenceStats.map((item) => (
              <span key={item.label}>
                <strong>{item.value}</strong>
                <small>{item.label}</small>
              </span>
            ))}
          </div>
          {confidence.length > 0 ? (
            <div className="ds-confidence-row">
              {confidence.map(([key, value]) => (
                <span key={key}>{key}: {String(value)}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {manifest ? (
        <div className="ds-package-files">
          <PackageFileGroup
            title="Preview"
            files={previewPages.map((page) => ({
              path: page.path ?? '',
              meta: [page.title, page.role].filter(Boolean).join(' · '),
            }))}
          />
          <PackageFileGroup
            title="Source evidence"
            files={[
              sourceFiles?.scanned ? { path: sourceFiles.scanned, meta: 'Scanned file inventory' } : null,
              sourceFiles?.evidence ? { path: sourceFiles.evidence, meta: 'Evidence notes' } : null,
              sourceFiles?.tokens ? { path: sourceFiles.tokens, meta: 'Token extraction evidence' } : null,
              sourceFiles?.snippets ? { path: sourceFiles.snippets, meta: 'Snippet index' } : null,
            ].filter((item): item is { path: string; meta: string } => item !== null)}
          />
        </div>
      ) : null}
      {evidence?.evidenceExcerpt ? (
        <pre className="ds-evidence-excerpt">{evidence.evidenceExcerpt}</pre>
      ) : null}
    </section>
  );
}

function PackageFileGroup({
  title,
  files,
}: {
  title: string;
  files: Array<{ path: string; meta?: string }>;
}) {
  const visibleFiles = files.filter((file) => file.path.length > 0);
  if (visibleFiles.length === 0) return null;
  return (
    <div>
      <h2>{title}</h2>
      <div className="ds-package-file-list">
        {visibleFiles.map((file) => (
          <span key={file.path}>
            <code>{file.path}</code>
            {file.meta ? <small>{file.meta}</small> : null}
          </span>
        ))}
      </div>
    </div>
  );
}

function sourceTypeLabel(value: string | undefined): string {
  if (value === 'github') return 'GitHub import';
  if (value === 'local') return 'Local import';
  if (value === 'bundled' || value === 'built-in') return 'Bundled';
  if (value === 'user') return 'User workspace';
  if (value === 'installed') return 'Installed';
  return 'Design system';
}

export function WorkspaceActivityCard({
  message,
  active,
}: {
  message: ChatMessage | null;
  active: boolean;
}) {
  const events = message?.events ?? [];
  const todos = latestTodosFromEvents(events);
  const fileOps = deriveFileOps(events);
  const status = workspaceActivityStatus(message, active);
  const statusDetail = latestStatusDetail(events);
  const hasActivity =
    active
    || todos.length > 0
    || fileOps.length > 0
    || statusDetail !== null
    || status === 'failed';

  if (!hasActivity) return null;

  const progress = workspaceActivityProgress(status, todos, fileOps);
  return (
    <section className={`ds-workspace-activity-card is-${status}`}>
      <div className="ds-workspace-activity-head">
        <Icon name={status === 'running' ? 'sparkles' : status === 'failed' ? 'help-circle' : 'check'} />
        <span>
          <strong>
            {status === 'running'
              ? 'Open Design is updating this system'
              : status === 'failed'
                ? 'Workspace update needs attention'
                : 'Workspace update ready'}
          </strong>
          <small>{statusDetail ?? workspaceActivityFallbackDetail(status)}</small>
        </span>
      </div>
      <div
        className="ds-generation-review-progress"
        role="progressbar"
        aria-label={`Workspace update progress ${progress}%`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      {todos.length > 0 ? (
        <div className="ds-workspace-todos">
          {todos.slice(0, 6).map((todo, index) => (
            <span key={`${todo.content}-${index}`} className={`is-${todoStatusClass(todo.status)}`}>
              {todo.status === 'completed' ? <Icon name="check" /> : null}
              {todo.content}
            </span>
          ))}
        </div>
      ) : (
        <div className="ds-generation-review-steps">
          {fallbackWorkspaceSteps(status, fileOps).map((step) => (
            <span key={step.title} className={`is-${step.status}`}>
              {step.status === 'succeeded' ? <Icon name="check" /> : null}
              {step.title}
            </span>
          ))}
        </div>
      )}
      {fileOps.length > 0 ? (
        <div className="ds-workspace-files-touched">
          <span>Files touched</span>
          <div>
            {fileOps.slice(0, 5).map((entry) => (
              <code key={entry.fullPath} className={`is-${entry.status}`}>
                {entry.path}
              </code>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function workspaceActivityStatus(
  message: ChatMessage | null,
  active: boolean,
): 'running' | 'succeeded' | 'failed' {
  if (active || message?.runStatus === 'queued' || message?.runStatus === 'running') return 'running';
  if (message?.runStatus === 'failed' || message?.runStatus === 'canceled') return 'failed';
  return 'succeeded';
}

function latestStatusDetail(events: AgentEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.kind !== 'status') continue;
    const label = event.label.replace(/[_-]/g, ' ');
    return event.detail ? `${label}: ${event.detail}` : label;
  }
  return null;
}

function workspaceActivityFallbackDetail(status: 'running' | 'succeeded' | 'failed'): string {
  if (status === 'running') return 'Watching project files and preparing the review draft.';
  if (status === 'failed') return 'The chat message has the run details. You can adjust the request and try again.';
  return 'Review the updated Design System and Design Files tabs.';
}

function workspaceActivityProgress(
  status: 'running' | 'succeeded' | 'failed',
  todos: ReturnType<typeof latestTodosFromEvents>,
  fileOps: ReturnType<typeof deriveFileOps>,
): number {
  if (status === 'succeeded' || status === 'failed') return 100;
  if (todos.length > 0) {
    const completed = todos.filter((todo) => todo.status === 'completed').length;
    const inProgress = todos.some((todo) => todo.status === 'in_progress') ? 0.5 : 0;
    return Math.max(18, Math.min(92, Math.round(((completed + inProgress) / todos.length) * 100)));
  }
  if (fileOps.some((entry) => entry.ops.includes('write') || entry.ops.includes('edit'))) return 72;
  if (fileOps.length > 0) return 38;
  return 18;
}

function todoStatusClass(status: ReturnType<typeof latestTodosFromEvents>[number]['status']): 'pending' | 'running' | 'succeeded' | 'failed' {
  if (status === 'completed') return 'succeeded';
  if (status === 'in_progress') return 'running';
  if (status === 'stopped') return 'failed';
  return 'pending';
}

function fallbackWorkspaceSteps(
  status: 'running' | 'succeeded' | 'failed',
  fileOps: ReturnType<typeof deriveFileOps>,
): Array<{ title: string; status: 'pending' | 'running' | 'succeeded' | 'failed' }> {
  const hasRead = fileOps.some((entry) => entry.ops.includes('read'));
  const hasMutation = fileOps.some((entry) => entry.ops.includes('write') || entry.ops.includes('edit'));
  const hasError = status === 'failed' || fileOps.some((entry) => entry.status === 'error');
  return [
    {
      title: 'Read current system',
      status: hasRead || hasMutation || status === 'succeeded' ? 'succeeded' : status === 'running' ? 'running' : 'pending',
    },
    {
      title: 'Update design files',
      status: hasError
        ? 'failed'
        : hasMutation
          ? fileOps.some((entry) => entry.status === 'running') ? 'running' : 'succeeded'
          : status === 'running'
            ? 'pending'
            : 'succeeded',
    },
    {
      title: 'Refresh review',
      status: status === 'succeeded' ? 'succeeded' : status === 'failed' ? 'failed' : 'pending',
    },
  ];
}

const WORKSPACE_FILE_MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'create_file', 'str_replace_edit', 'multi_edit']);

export function writableProjectFilePathFromToolUse(
  event: Extract<AgentEvent, { kind: 'tool_use' }>,
): string | null {
  if (!WORKSPACE_FILE_MUTATION_TOOLS.has(event.name)) return null;
  return filePathFromToolInput(event.input);
}

function filePathFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const filePath = record.file_path ?? record.path;
  return typeof filePath === 'string' && filePath.trim() ? filePath : null;
}

export function isDesignSystemSourcePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return normalized === 'design.md' || normalized.endsWith('/design.md');
}

function timestampFromIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function SourceContextCard({ provenance }: { provenance?: DesignSystemProvenance }) {
  const rows = provenanceRows(provenance);
  if (rows.length === 0) return null;
  return (
    <div className="ds-source-context-card">
      <strong>Source context</strong>
      {rows.map((row) => (
        <div key={row.label}>
          <span>{row.label}</span>
          <small>{row.value}</small>
        </div>
      ))}
    </div>
  );
}

export function GenerationStatusCard({ job }: { job: DesignSystemGenerationJob }) {
  const active = job.status === 'queued' || job.status === 'running';
  const noun = job.kind === 'revision' ? 'Revision' : 'Generation';
  return (
    <div className={`ds-generation-review-card is-${job.status}`}>
      <div>
        <Icon name={active ? 'sparkles' : job.status === 'failed' ? 'help-circle' : 'check'} />
        <span>
          <strong>
            {active
              ? job.kind === 'revision'
                ? 'Open Design is revising'
                : 'Open Design is still working'
              : job.status === 'failed'
                ? `${noun} needs attention`
                : `${noun} completed`}
          </strong>
          <small>
            {job.message
              ?? (active
                ? job.kind === 'revision'
                  ? 'Applying your feedback.'
                  : 'Preparing the remaining files.'
                : 'Review workspace is ready.')}
          </small>
        </span>
      </div>
      <div
        className="ds-generation-review-progress"
        role="progressbar"
        aria-label={`Generation progress ${job.progress}%`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={job.progress}
      >
        <span style={{ width: `${job.progress}%` }} />
      </div>
      <div className="ds-generation-review-steps">
        {job.steps.map((step) => (
          <span key={step.id} className={`is-${step.status}`}>
            {step.status === 'succeeded' ? <Icon name="check" /> : null}
            {step.title}
          </span>
        ))}
      </div>
    </div>
  );
}

export function RevisionDiffCard({
  revision,
  saving,
  onAccept,
  onReject,
}: {
  revision: DesignSystemRevision;
  saving: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const diff = revisionAddedText(revision);
  return (
    <section className="ds-revision-card">
      <div className="ds-revision-card__head">
        <span>
          <strong>Pending revision</strong>
          <small>
            {revision.sectionTitle ? `${revision.sectionTitle} · ` : ''}
            {formatDateTime(revision.createdAt)}
          </small>
        </span>
        <div>
          <button type="button" className="ghost danger" disabled={saving} onClick={onReject}>
            <Icon name="close" />
            Reject
          </button>
          <button type="button" className="ghost success" disabled={saving} onClick={onAccept}>
            <Icon name="check" />
            Accept
          </button>
        </div>
      </div>
      <p>{revision.feedback}</p>
      <div className="ds-revision-diff">
        <span>Proposed changes</span>
        <pre>{diff || revision.proposedBody}</pre>
      </div>
    </section>
  );
}

export function RevisionHistoryList({ revisions }: { revisions: DesignSystemRevision[] }) {
  return (
    <section className="ds-revision-history">
      <h2>Revision history</h2>
      {revisions.map((revision) => (
        <div key={revision.id}>
          <span className={`is-${revision.status}`}>{revision.status}</span>
          <strong>{revision.sectionTitle ?? 'General revision'}</strong>
          <small>{formatDateTime(revision.updatedAt)}</small>
        </div>
      ))}
    </section>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function revisionAddedText(revision: DesignSystemRevision): string {
  const baseLines = revision.baseBody.split(/\r?\n/);
  const proposedLines = revision.proposedBody.split(/\r?\n/);
  let index = 0;
  while (
    index < baseLines.length
    && index < proposedLines.length
    && baseLines[index] === proposedLines[index]
  ) {
    index += 1;
  }
  return proposedLines.slice(index).join('\n').trim();
}

function provenanceRows(provenance: DesignSystemProvenance | undefined): Array<{ label: string; value: string }> {
  if (!provenance) return [];
  return [
    provenance.companyBlurb ? { label: 'Company', value: truncateContext(provenance.companyBlurb) } : null,
    provenance.githubUrls?.length ? { label: 'GitHub', value: provenance.githubUrls.join(', ') } : null,
    provenance.localCodeFiles?.length ? { label: 'Code', value: provenance.localCodeFiles.join(', ') } : null,
    provenance.figFiles?.length ? { label: 'Figma', value: provenance.figFiles.join(', ') } : null,
    provenance.assetFiles?.length ? { label: 'Assets', value: provenance.assetFiles.join(', ') } : null,
    provenance.notes ? { label: 'Notes', value: truncateContext(provenance.notes) } : null,
    provenance.sourceNotes ? { label: 'Fetched context', value: truncateContext(provenance.sourceNotes) } : null,
  ].filter((row): row is { label: string; value: string } => row !== null);
}

function truncateContext(value: string): string {
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

export function parseDesignSystemSections(body: string): Array<{ title: string; subtitle: string; body: string }> {
  const matches = [...body.matchAll(/^##\s+(.+?)\s*$/gm)];
  if (matches.length === 0) {
    return [{ title: 'Design System', subtitle: 'Draft body', body: body.trim() || 'No content yet.' }];
  }
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? body.length;
    const title = match[1]?.replace(/^\d+\.\s*/, '').trim() || 'Section';
    const content = body.slice(start, end).trim();
    return {
      title,
      subtitle: sectionSubtitle(title),
      body: content || 'No details yet.',
    };
  });
}

function sectionSubtitle(title: string): string {
  const normalized = title.toLowerCase();
  if (normalized.includes('type')) return 'Text hierarchy and styles';
  if (normalized.includes('color')) return 'Palette and semantic roles';
  if (normalized.includes('spacing')) return 'Spacing scale and radius tokens';
  if (normalized.includes('component')) return 'Reusable interface patterns';
  if (normalized.includes('brand')) return 'Logo, voice and usage rules';
  return 'Design guidance';
}
