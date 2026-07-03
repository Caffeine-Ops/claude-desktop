import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streamViaDaemon } from '../../providers/daemon';
import {
  ensureDesignSystemWorkspace,
  fetchDesignSystemGenerationJob,
  fetchDesignSystem,
  fetchProjectFileText,
  fetchProjectFiles,
  fetchProjectDesignSystemPackageAudit,
  fetchDesignSystemRevisions,
  updateDesignSystemRevisionStatus,
  updateDesignSystemDraft,
  writeProjectTextFile,
} from '../../providers/registry';
import {
  createConversation,
  getProject,
  listConversations,
  listMessages,
  loadTabs,
  patchConversation,
  saveMessage,
  saveTabs,
} from '../../state/projects';
import { appendErrorStatusEvent } from '../../runtime/chat-events';
import {
  buildDesignSystemPackageAuditRepairPrompt,
  summarizeDesignSystemPackageAudit,
} from '../../runtime/design-system-package-audit';
import { randomUUID } from '../../utils/uuid';
import type {
  AgentEvent,
  AgentInfo,
  AppConfig,
  ChatAttachment,
  ChatCommentAttachment,
  ChatMessage,
  Conversation,
  DesignSystemDetail,
  DesignSystemGenerationJob,
  DesignSystemRevision,
  OpenTabsState,
  ProjectFile,
} from '../../types';
import { decideAutoOpenAfterWrite } from '../files/auto-open-file';
import { ChatPane } from '../chat/ChatPane';
import { FileWorkspace } from '../FileWorkspace';
import { Icon } from '../shared/Icon';
import { useAnalytics } from '../../analytics/provider';
import { trackPageView } from '../../analytics/events';
import {
  clearOnboardingSessionId,
  peekOnboardingSessionId,
} from '../../analytics/onboarding-session';
import type {
  TrackingDesignSystemStatus,
  TrackingDesignSystemsEntryFrom,
} from '@open-design/contracts/analytics';
import { useI18n } from '../../i18n';
import {
  buildDesignSystemChatMessages,
  DesignSystemPackageCard,
  designSystemWorkspaceAgentPrompt,
  findWorkspaceActivityMessage,
  GenerationStatusCard,
  isDesignSystemSourcePath,
  parseDesignSystemSections,
  RevisionDiffCard,
  RevisionHistoryList,
  WorkspaceActivityCard,
  writableProjectFilePathFromToolUse,
} from './detail-support';

interface DetailProps {
  id: string;
  selectedId: string | null;
  config: AppConfig;
  agents: AgentInfo[];
  onBack: () => void;
  onOpenProject?: (projectId: string) => void;
  onSetDefault: (id: string) => void;
  onSystemsRefresh?: () => Promise<void> | void;
  onProjectsRefresh?: () => Promise<void> | void;
}

type ReviewTab = 'system' | 'files';

interface ResolvedDesignSystemWorkspaceProject {
  projectId: string;
  files: ProjectFile[];
}

const GENERATION_JOB_STORAGE_PREFIX = 'od:design-system-generation-job:';

function generationJobStorageKey(designSystemId: string): string {
  return `${GENERATION_JOB_STORAGE_PREFIX}${designSystemId}`;
}

function readRememberedGenerationJob(designSystemId: string): string | null {
  try {
    return window.sessionStorage.getItem(generationJobStorageKey(designSystemId));
  } catch {
    return null;
  }
}

async function resolveDesignSystemWorkspaceProject(
  system: Pick<DesignSystemDetail, 'id' | 'projectId'>,
): Promise<ResolvedDesignSystemWorkspaceProject | null> {
  const workspace = await ensureDesignSystemWorkspace(system.id);
  if (workspace) {
    return {
      projectId: workspace.project.id,
      files: workspace.files,
    };
  }
  if (!system.projectId) return null;
  const fallbackProject = await getProject(system.projectId);
  if (!fallbackProject) return null;
  const files = await fetchProjectFiles(system.projectId);
  return {
    projectId: system.projectId,
    files,
  };
}

function clearRememberedGenerationJob(designSystemId: string): void {
  try {
    window.sessionStorage.removeItem(generationJobStorageKey(designSystemId));
  } catch {
    // Best-effort cleanup only.
  }
}

export function DesignSystemDetailView({
  id,
  selectedId,
  config,
  agents,
  onBack,
  onOpenProject,
  onSetDefault,
  onSystemsRefresh,
  onProjectsRefresh,
}: DetailProps) {
  const { locale } = useI18n();
  const [system, setSystem] = useState<DesignSystemDetail | null>(null);
  const [body, setBody] = useState('');
  const [tab, setTab] = useState<ReviewTab>('system');
  const [openSection, setOpenSection] = useState(0);
  const [saving, setSaving] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [generationJob, setGenerationJob] = useState<DesignSystemGenerationJob | null>(null);
  const [revisionJob, setRevisionJob] = useState<DesignSystemGenerationJob | null>(null);
  const [revisions, setRevisions] = useState<DesignSystemRevision[]>([]);
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, 'good' | 'work'>>({});
  const [feedbackSection, setFeedbackSection] = useState<string | null>(null);
  const [chatSeed, setChatSeed] = useState<{ id: string; text: string } | null>(null);
  const [workspaceProjectId, setWorkspaceProjectId] = useState<string | null>(null);
  const [workspaceProjectFiles, setWorkspaceProjectFiles] = useState<ProjectFile[]>([]);
  const [workspaceLoadError, setWorkspaceLoadError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [projectChatMessages, setProjectChatMessages] = useState<ChatMessage[]>([]);
  const [chatStreaming, setChatStreaming] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [workspaceTabsState, setWorkspaceTabsState] = useState<OpenTabsState>({
    tabs: [],
    active: null,
  });
  const [workspaceOpenRequest, setWorkspaceOpenRequest] = useState<{ name: string; nonce: number } | null>(null);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatCancelRef = useRef<AbortController | null>(null);
  const pendingWorkspaceFileWritesRef = useRef<Map<string, string>>(new Map());
  const workspaceTabsLoadedRef = useRef(false);
  const openedProjectRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSystem(null);
    setRevisions([]);
    setWorkspaceProjectId(null);
    setWorkspaceProjectFiles([]);
    setWorkspaceLoadError(null);
    setConversations([]);
    setActiveConversationId(null);
    setProjectChatMessages([]);
    setChatError(null);
    setChatSeed(null);
    setWorkspaceTabsState({ tabs: [], active: null });
    setWorkspaceOpenRequest(null);
    openedProjectRef.current = null;
    workspaceTabsLoadedRef.current = false;
    pendingWorkspaceFileWritesRef.current.clear();
    void fetchDesignSystem(id).then((detail) => {
      if (cancelled) return;
      setSystem(detail);
      setBody(detail?.body ?? '');
    });
    void fetchDesignSystemRevisions(id).then((next) => {
      if (cancelled) return;
      setRevisions(next);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!system) return undefined;
    const currentSystem = system;
    let cancelled = false;
    async function syncWorkspaceProject() {
      setWorkspaceLoadError(null);
      const resolved = await resolveDesignSystemWorkspaceProject(currentSystem);
      if (cancelled) return;
      if (!resolved) {
        setWorkspaceLoadError('Could not open the design system workspace.');
        return;
      }
      const projectId = resolved.projectId;
      setWorkspaceProjectId(projectId);
      setWorkspaceProjectFiles(resolved.files);
      if (onOpenProject && openedProjectRef.current !== projectId) {
        openedProjectRef.current = projectId;
        await onProjectsRefresh?.();
        if (!cancelled) onOpenProject(projectId);
      }
    }
    void syncWorkspaceProject();
    return () => {
      cancelled = true;
    };
  }, [onOpenProject, onProjectsRefresh, system]);

  useEffect(() => {
    if (!workspaceProjectId) return undefined;
    const projectId = workspaceProjectId;
    let cancelled = false;
    async function loadWorkspaceConversation() {
      const existing = await listConversations(projectId);
      if (cancelled) return;
      if (existing.length > 0) {
        setConversations(existing);
        setActiveConversationId(existing[0]!.id);
        return;
      }
      const fresh = await createConversation(projectId, 'Design system');
      if (cancelled) return;
      if (fresh) {
        setConversations([fresh]);
        setActiveConversationId(fresh.id);
      }
    }
    void loadWorkspaceConversation();
    return () => {
      cancelled = true;
    };
  }, [workspaceProjectId]);

  useEffect(() => {
    if (!workspaceProjectId) return undefined;
    const projectId = workspaceProjectId;
    let cancelled = false;
    workspaceTabsLoadedRef.current = false;
    void loadTabs(projectId).then((state) => {
      if (cancelled) return;
      setWorkspaceTabsState(state);
      workspaceTabsLoadedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceProjectId]);

  useEffect(() => {
    if (!workspaceProjectId || !activeConversationId) {
      setProjectChatMessages([]);
      return undefined;
    }
    let cancelled = false;
    void listMessages(workspaceProjectId, activeConversationId).then((messages) => {
      if (cancelled) return;
      setProjectChatMessages(messages);
    });
    return () => {
      cancelled = true;
    };
  }, [activeConversationId, workspaceProjectId]);

  useEffect(() => {
    return () => {
      chatAbortRef.current?.abort();
      chatAbortRef.current = null;
      chatCancelRef.current = null;
    };
  }, []);

  useEffect(() => {
    const jobId = readRememberedGenerationJob(id);
    if (!jobId) {
      setGenerationJob(null);
      return undefined;
    }
    const generationJobId = jobId;
    let cancelled = false;
    let timeoutId: number | undefined;

    async function pollGenerationJob() {
      const next = await fetchDesignSystemGenerationJob(generationJobId);
      if (cancelled) return;
      if (!next) {
        clearRememberedGenerationJob(id);
        setGenerationJob(null);
        return;
      }
      setGenerationJob(next);
      if (next.status === 'succeeded') {
        clearRememberedGenerationJob(id);
        const detail = await fetchDesignSystem(id);
        if (cancelled) return;
        if (detail) {
          setSystem(detail);
          setBody(detail.body);
        }
        await onSystemsRefresh?.();
        if (!cancelled) setStatusLine('Generation completed');
        return;
      }
      if (next.status === 'failed') {
        setStatusLine(next.error ? `Generation stopped: ${next.error}` : 'Generation stopped');
        return;
      }
      timeoutId = window.setTimeout(() => void pollGenerationJob(), 700);
    }

    void pollGenerationJob();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [id, onSystemsRefresh]);

  useEffect(() => {
    if (
      !revisionJob?.id
      || revisionJob.status === 'succeeded'
      || revisionJob.status === 'failed'
    ) {
      return undefined;
    }
    const jobId = revisionJob.id;
    let cancelled = false;
    let timeoutId: number | undefined;

    async function pollRevisionJob() {
      const next = await fetchDesignSystemGenerationJob(jobId);
      if (cancelled) return;
      if (!next) {
        setStatusLine('Could not read revision progress');
        return;
      }
      setRevisionJob(next);
      if (next.status === 'succeeded') {
        const nextRevisions = await fetchDesignSystemRevisions(id);
        if (cancelled) return;
        setRevisions(nextRevisions);
        await onSystemsRefresh?.();
        if (!cancelled) setStatusLine('Revision ready for review');
        return;
      }
      if (next.status === 'failed') {
        setStatusLine(next.error ? `Revision stopped: ${next.error}` : 'Revision stopped');
        return;
      }
      timeoutId = window.setTimeout(() => void pollRevisionJob(), 650);
    }

    timeoutId = window.setTimeout(() => void pollRevisionJob(), 250);
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [id, onSystemsRefresh, revisionJob?.id, revisionJob?.status]);

  const sections = useMemo(() => parseDesignSystemSections(body), [body]);
  const published = system?.status === 'published';
  const editable = system?.isEditable !== false;
  const activeJob = revisionJob ?? generationJob;
  const pendingRevision = revisions.find((revision) => revision.status === 'pending') ?? null;
  const recentRevisions = revisions.slice(0, 5);
  const generationActive =
    activeJob?.status === 'queued' || activeJob?.status === 'running';

  // Multi-surface DS page_view (v2 doc). One emission per
  // (system, generationActive) transition: while generation is
  // running we surface `area=design_system_generation`; once it
  // settles we surface `area=design_system_preview`. The fourth
  // onboarding step (`area=generation_progress`) piggy-backs on the
  // generation emission when an onboarding session id is present.
  const analytics = useAnalytics();
  const designSystemStatus: TrackingDesignSystemStatus = generationActive
    ? 'generating'
    : (system?.status as TrackingDesignSystemStatus | undefined) ?? 'unknown';
  useEffect(() => {
    if (!system) return;
    const onboardingSessionId = peekOnboardingSessionId();
    const entryFrom: TrackingDesignSystemsEntryFrom = onboardingSessionId
      ? 'onboarding'
      : 'unknown';
    if (generationActive) {
      trackPageView(analytics.track, {
        page_name: 'design_system_project',
        area: 'design_system_generation',
        view_type: 'page',
        entry_from: entryFrom,
        design_system_id: system.id,
        // Origin is the DS's provenance-style source. We don't yet
        // have a precise mapping from `system.source` / provenance
        // metadata to the v2 enum, so we report `unknown` rather
        // than mis-tag — dashboards still see the funnel via
        // `entry_from`. A follow-up can derive this honestly.
        design_system_source: 'unknown',
        design_system_status: 'generating',
      });
      if (onboardingSessionId) {
        trackPageView(analytics.track, {
          page_name: 'onboarding',
          area: 'generation_progress',
          step_index: 'progress',
          step_name: 'generation',
          onboarding_session_id: onboardingSessionId,
        });
        // Generation is the last onboarding step; clear so a later
        // DS visit unrelated to onboarding doesn't re-attribute.
        clearOnboardingSessionId();
      }
    } else {
      trackPageView(analytics.track, {
        page_name: 'design_system_project',
        area: 'design_system_preview',
        view_type: 'page',
        entry_from: entryFrom,
        design_system_id: system.id,
        design_system_source: 'unknown',
        design_system_status: designSystemStatus,
      });
    }
  }, [analytics.track, system?.id, generationActive, designSystemStatus, system]);
  const introChatMessages = useMemo(
    () => buildDesignSystemChatMessages({
      system,
      activeJob,
      revisions: recentRevisions,
      generationActive,
    }),
    [activeJob, generationActive, recentRevisions, system],
  );
  const chatMessages = projectChatMessages.length > 0 ? projectChatMessages : introChatMessages;
  const workspaceActivityMessage = useMemo(
    () => findWorkspaceActivityMessage(chatMessages),
    [chatMessages],
  );

  async function savePatch(input: Partial<DesignSystemDetail>) {
    if (!system || !editable) return null;
    setSaving(true);
    setStatusLine(null);
    try {
      const updated = await updateDesignSystemDraft(system.id, input);
      if (updated) {
        setSystem(updated);
        setBody(updated.body);
        await onSystemsRefresh?.();
      }
      return updated;
    } finally {
      setSaving(false);
    }
  }

  async function saveBody() {
    const nextBody = body;
    const updated = await savePatch({ body: nextBody });
    if (updated && workspaceProjectId) {
      await writeProjectTextFile(workspaceProjectId, 'DESIGN.md', nextBody);
      await refreshWorkspaceProjectFiles(workspaceProjectId);
    }
    setStatusLine(updated ? 'Saved DESIGN.md' : 'Could not save changes');
  }

  async function togglePublished(next: boolean) {
    const updated = await savePatch({ body, status: next ? 'published' : 'draft' });
    setStatusLine(updated ? (next ? 'Published' : 'Moved back to draft') : 'Could not update status');
  }

  async function ensureWorkspaceProject() {
    if (!system) return workspaceProjectId;
    if (workspaceProjectId) return workspaceProjectId;
    const resolved = await resolveDesignSystemWorkspaceProject(system);
    if (!resolved) return null;
    setWorkspaceProjectId(resolved.projectId);
    setWorkspaceProjectFiles(resolved.files);
    return resolved.projectId;
  }

  const refreshWorkspaceProjectFiles = useCallback(async (projectId: string) => {
    const next = await fetchProjectFiles(projectId);
    setWorkspaceProjectFiles(next);
    return next;
  }, []);

  const syncDesignSystemBodyFromWorkspace = useCallback(async (projectId: string) => {
    if (!system || !editable) return false;
    const nextBody = await fetchProjectFileText(projectId, 'DESIGN.md', {
      cache: 'no-store',
      cacheBustKey: Date.now(),
    });
    if (!nextBody || nextBody === body) return false;
    const updated = await updateDesignSystemDraft(system.id, { body: nextBody });
    if (!updated) return false;
    setSystem(updated);
    setBody(updated.body);
    await onSystemsRefresh?.();
    return true;
  }, [body, editable, onSystemsRefresh, system]);

  const refreshDesignSystemWorkspace = useCallback(async (projectId: string) => {
    const nextFiles = await refreshWorkspaceProjectFiles(projectId);
    await syncDesignSystemBodyFromWorkspace(projectId);
    return nextFiles;
  }, [refreshWorkspaceProjectFiles, syncDesignSystemBodyFromWorkspace]);

  const persistProjectMessage = useCallback(
    (projectId: string, conversationId: string | null, message: ChatMessage) => {
      if (!conversationId) return;
      void saveMessage(projectId, conversationId, message);
    },
    [],
  );

  const persistWorkspaceTabsState = useCallback(
    (next: OpenTabsState) => {
      setWorkspaceTabsState(next);
      if (workspaceProjectId && workspaceTabsLoadedRef.current) {
        void saveTabs(workspaceProjectId, next);
      }
    },
    [workspaceProjectId],
  );

  const requestWorkspaceFileOpen = useCallback((name: string) => {
    if (!name) return;
    setWorkspaceOpenRequest({ name, nonce: Date.now() });
  }, []);

  const sendProjectChatMessage = useCallback(
    async (
      prompt: string,
      attachments: ChatAttachment[],
      commentAttachments: ChatCommentAttachment[],
    ) => {
      const rawText = prompt.trim();
      if (!rawText || chatStreaming || !system) return;
      const text = feedbackSection ? `${rawText}\n\nFocus section: ${feedbackSection}` : rawText;
      const projectId = workspaceProjectId ?? await ensureWorkspaceProject();
      if (!projectId) {
        setChatError('Could not open the design system workspace.');
        return;
      }
      let conversationId = activeConversationId;
      if (!conversationId) {
        const fresh = await createConversation(projectId, 'Design system');
        if (!fresh) {
          setChatError('Could not create a design system conversation.');
          return;
        }
        setConversations([fresh]);
        setActiveConversationId(fresh.id);
        conversationId = fresh.id;
      }
      if (config.mode !== 'daemon' || !config.agentId) {
        setChatError('Pick a local agent first, then ask Open Design to update this design system.');
        return;
      }

      setChatError(null);
      setStatusLine(null);
      setChatSeed(null);
      setFeedbackSection(null);
      const startedAt = Date.now();
      const userMsg: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: text,
        createdAt: startedAt,
        attachments: attachments.length > 0 ? attachments : undefined,
        commentAttachments: commentAttachments.length > 0 ? commentAttachments : undefined,
      };
      const selectedAgent = agents.find((agent) => agent.id === config.agentId);
      const selectedModel = config.agentModels?.[config.agentId];
      const assistantMsg: ChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        agentId: config.agentId,
        agentName: [selectedAgent?.name ?? config.agentId, selectedModel?.model].filter(Boolean).join(' · '),
        events: [],
        createdAt: startedAt,
        startedAt,
        runStatus: 'running',
      };
      const previousMessages = projectChatMessages.length > 0 ? projectChatMessages : introChatMessages;
      const nextHistory = [...previousMessages, userMsg];
      const agentHistory = [
        ...previousMessages,
        {
          ...userMsg,
          content: designSystemWorkspaceAgentPrompt(text),
        },
      ];
      let assistantSnapshot = assistantMsg;
      const updateAssistant = (updater: (message: ChatMessage) => ChatMessage, persist = false) => {
        assistantSnapshot = updater(assistantSnapshot);
        setProjectChatMessages((current) =>
          current.map((message) => message.id === assistantSnapshot.id ? assistantSnapshot : message),
        );
        if (persist) persistProjectMessage(projectId, conversationId, assistantSnapshot);
      };

      setProjectChatMessages([...nextHistory, assistantMsg]);
      persistProjectMessage(projectId, conversationId, userMsg);
      if (projectChatMessages.length === 0) {
        setConversations((current) =>
          current.map((conversation) =>
            conversation.id === conversationId
              ? { ...conversation, title: text.slice(0, 60) || 'Design system' }
              : conversation,
          ),
        );
        void patchConversation(projectId, conversationId, {
          title: text.slice(0, 60) || 'Design system',
        });
      }

      const controller = new AbortController();
      const cancelController = new AbortController();
      chatAbortRef.current = controller;
      chatCancelRef.current = cancelController;
      pendingWorkspaceFileWritesRef.current.clear();
      setChatStreaming(true);

      void streamViaDaemon({
        agentId: config.agentId,
        history: agentHistory,
        signal: controller.signal,
        cancelSignal: cancelController.signal,
        projectId,
        conversationId,
        assistantMessageId: assistantMsg.id,
        clientRequestId: randomUUID(),
        skillId: null,
        designSystemId: system.id,
        attachments: attachments.map((attachment) => attachment.path),
        commentAttachments,
        model: selectedModel?.model ?? null,
        reasoning: selectedModel?.reasoning ?? null,
        locale,
        handlers: {
          onDelta: (delta) => {
            updateAssistant((message) => ({
              ...message,
              content: message.content + delta,
              events: [...(message.events ?? []), { kind: 'text', text: delta }],
            }));
          },
          onAgentEvent: (event: AgentEvent) => {
            if (event.kind === 'text') return;
            updateAssistant((message) => ({
              ...message,
              events: [...(message.events ?? []), event],
            }));
            if (event.kind === 'tool_use') {
              const filePath = writableProjectFilePathFromToolUse(event);
              if (filePath) pendingWorkspaceFileWritesRef.current.set(event.id, filePath);
              return;
            }
            if (event.kind === 'tool_result') {
              const filePath = pendingWorkspaceFileWritesRef.current.get(event.toolUseId);
              if (!filePath) return;
              pendingWorkspaceFileWritesRef.current.delete(event.toolUseId);
              if (event.isError) return;
              void refreshWorkspaceProjectFiles(projectId).then((nextFiles) => {
                const decision = decideAutoOpenAfterWrite(filePath, nextFiles);
                if (decision.shouldOpen && decision.fileName) {
                  requestWorkspaceFileOpen(decision.fileName);
                }
                if (isDesignSystemSourcePath(filePath)) {
                  void syncDesignSystemBodyFromWorkspace(projectId);
                }
              });
            }
          },
          onDone: () => {
            updateAssistant(
              (message) => ({
                ...message,
                endedAt: Date.now(),
                runStatus: message.runStatus === 'failed' || message.runStatus === 'canceled'
                  ? message.runStatus
                  : 'succeeded',
              }),
              true,
            );
            setChatStreaming(false);
            chatAbortRef.current = null;
            chatCancelRef.current = null;
            pendingWorkspaceFileWritesRef.current.clear();
            void (async () => {
              await refreshWorkspaceProjectFiles(projectId);
              const synced = await syncDesignSystemBodyFromWorkspace(projectId);
              const audit = await fetchProjectDesignSystemPackageAudit(projectId);
              const auditSummary = audit ? summarizeDesignSystemPackageAudit(audit) : null;
              if (auditSummary) {
                updateAssistant(
                  (message) => ({
                    ...message,
                    events: [...(message.events ?? []), { kind: 'status', label: 'audit', detail: auditSummary }],
                  }),
                  true,
                );
              }
              const repairPrompt = audit ? buildDesignSystemPackageAuditRepairPrompt(audit) : null;
              if (repairPrompt) {
                setChatSeed({ id: `audit-${Date.now()}`, text: repairPrompt });
              }
              if (auditSummary) {
                setStatusLine(
                  repairPrompt
                    ? `${auditSummary} The next repair prompt is ready in chat.`
                    : `Workspace updated. ${auditSummary}`,
                );
              } else {
                setStatusLine(
                  synced
                    ? 'Workspace updated and DESIGN.md synced for review.'
                    : 'Workspace updated. Review the files or ask for another change.',
                );
              }
              await onProjectsRefresh?.();
            })();
          },
          onError: (error) => {
            const message = error.message;
            setChatError(message);
            updateAssistant(
              (previous) => ({
                ...appendErrorStatusEvent(previous, message),
                endedAt: Date.now(),
                runStatus: 'failed',
              }),
              true,
            );
            setChatStreaming(false);
            chatAbortRef.current = null;
            chatCancelRef.current = null;
            pendingWorkspaceFileWritesRef.current.clear();
          },
        },
        onRunCreated: (runId) => {
          updateAssistant((message) => ({ ...message, runId, runStatus: 'queued' }), true);
        },
        onRunStatus: (runStatus) => {
          updateAssistant(
            (message) => ({
              ...message,
              runStatus,
              endedAt:
                runStatus === 'succeeded' || runStatus === 'failed' || runStatus === 'canceled'
                  ? message.endedAt ?? Date.now()
                  : message.endedAt,
            }),
            runStatus === 'succeeded' || runStatus === 'failed' || runStatus === 'canceled',
          );
        },
        onRunEventId: (lastRunEventId) => {
          updateAssistant((message) => ({ ...message, lastRunEventId }));
        },
      });
    },
    [
      activeConversationId,
      agents,
      chatStreaming,
      config.agentId,
      config.agentModels,
      config.mode,
      ensureWorkspaceProject,
      feedbackSection,
      introChatMessages,
      locale,
      onProjectsRefresh,
      persistProjectMessage,
      projectChatMessages,
      refreshWorkspaceProjectFiles,
      requestWorkspaceFileOpen,
      syncDesignSystemBodyFromWorkspace,
      system,
      workspaceProjectId,
    ],
  );

  const stopProjectChat = useCallback(() => {
    chatCancelRef.current?.abort();
    chatAbortRef.current?.abort();
    chatCancelRef.current = null;
    chatAbortRef.current = null;
    pendingWorkspaceFileWritesRef.current.clear();
    setChatStreaming(false);
  }, []);

  const createProjectChatConversation = useCallback(() => {
    const projectId = workspaceProjectId;
    if (!projectId) {
      setChatSeed({
        id: `general-${Date.now()}`,
        text: 'Update this design system: ',
      });
      return;
    }
    void createConversation(projectId, 'Design system').then((fresh) => {
      if (!fresh) return;
      setConversations((current) => [fresh, ...current]);
      setActiveConversationId(fresh.id);
      setProjectChatMessages([]);
      setChatSeed({
        id: `general-${Date.now()}`,
        text: 'Update this design system: ',
      });
    });
  }, [workspaceProjectId]);

  async function resolveRevision(
    revision: DesignSystemRevision,
    status: 'accepted' | 'rejected',
  ) {
    if (!system) return;
    setSaving(true);
    setStatusLine(null);
    try {
      const updatedRevision = await updateDesignSystemRevisionStatus(
        system.id,
        revision.id,
        status,
      );
      if (!updatedRevision) {
        setStatusLine(status === 'accepted' ? 'Could not accept revision' : 'Could not reject revision');
        return;
      }
      const [detail, nextRevisions] = await Promise.all([
        fetchDesignSystem(system.id),
        fetchDesignSystemRevisions(system.id),
      ]);
      if (detail) {
        setSystem(detail);
        setBody(detail.body);
      }
      setRevisions(nextRevisions);
      await onSystemsRefresh?.();
      setStatusLine(status === 'accepted' ? 'Revision accepted' : 'Revision rejected');
    } finally {
      setSaving(false);
    }
  }

  if (!system) {
    return (
      <div className="ds-setup-shell ds-setup-shell--center">
        <div className="ds-setup-center-card">
          <h1>Loading design system...</h1>
          <p>Opening the review workspace.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="ds-workspace">
      <aside className="ds-project-chat">
        <div className="ds-project-chat__bar">
          <button type="button" className="icon-only" onClick={onBack} aria-label="Back">
            <Icon name="arrow-left" />
          </button>
          <strong>{system.title}</strong>
          <span>{published ? 'Published' : 'Draft'}</span>
        </div>
        <div className="ds-project-chat__pane">
          <ChatPane
            key={`${activeConversationId ?? 'design-system-chat'}:${chatSeed?.id ?? 'ready'}`}
            messages={chatMessages}
            streaming={generationActive || saving || chatStreaming}
            error={chatError}
            projectId={workspaceProjectId}
            projectFiles={workspaceProjectFiles}
            onEnsureProject={ensureWorkspaceProject}
            onSend={(prompt, attachments, commentAttachments) => {
              void sendProjectChatMessage(prompt, attachments, commentAttachments);
            }}
            onStop={stopProjectChat}
            initialDraft={chatSeed?.text}
            conversations={conversations}
            activeConversationId={activeConversationId}
            onSelectConversation={setActiveConversationId}
            onDeleteConversation={() => {}}
            onNewConversation={createProjectChatConversation}
          />
        </div>
      </aside>

      <main className="ds-review-main">
        <header className="ds-review-tabs">
          <button type="button" className="ghost" onClick={onBack}>
            <Icon name="arrow-left" />
            Back
          </button>
          <div className="segmented">
            <button
              type="button"
              className={tab === 'system' ? 'active' : ''}
              onClick={() => setTab('system')}
            >
              Design System
            </button>
            <button
              type="button"
              className={tab === 'files' ? 'active' : ''}
              onClick={() => setTab('files')}
            >
              Design Files
            </button>
          </div>
          <button type="button" className="ghost">
            Share
          </button>
        </header>

        {tab === 'system' ? (
          <div className="ds-review-column">
            <h1>Review draft design system</h1>
            <div className="ds-review-rule" aria-hidden />
            {activeJob ? <GenerationStatusCard job={activeJob} /> : null}
            <div className="ds-publish-card">
              <p>
                {generationActive
                  ? activeJob?.kind === 'revision'
                    ? 'Open Design is applying your feedback. You can keep reviewing while the updated draft is prepared.'
                    : 'Open Design is still working, but you can start giving feedback on the work so far.'
                  : 'Open Design is ready for review. Give feedback on the work so far, then publish when it is useful for future projects.'}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={published}
                  disabled={!editable || saving}
                  onChange={(event) => void togglePublished(event.target.checked)}
                />
                Published
              </label>
              {selectedId !== system.id ? (
                <button type="button" className="ghost compact" onClick={() => onSetDefault(system.id)}>
                  Make default
                </button>
              ) : null}
            </div>
            <DesignSystemPackageCard system={system} />
            <div className="ds-warning-card">
              <Icon name="help-circle" />
              <span>
                <strong>Missing brand fonts</strong>
                Open Design is rendering typography with substitute web fonts.
              </span>
              <button type="button" className="ghost compact">
                <Icon name="upload" />
                Upload fonts
              </button>
            </div>
            {statusLine ? <div className="ds-status-line">{statusLine}</div> : null}
            <WorkspaceActivityCard message={workspaceActivityMessage} active={chatStreaming} />
            {pendingRevision ? (
              <RevisionDiffCard
                revision={pendingRevision}
                saving={saving}
                onAccept={() => void resolveRevision(pendingRevision, 'accepted')}
                onReject={() => void resolveRevision(pendingRevision, 'rejected')}
              />
            ) : null}

            <div className="ds-review-sections">
              {sections.map((section, index) => {
                const isOpen = index === openSection;
                return (
                  <article className="ds-review-section" key={`${section.title}-${index}`}>
                    <button
                      type="button"
                      className="ds-review-section__head"
                      onClick={() => setOpenSection(isOpen ? -1 : index)}
                    >
                      <span>
                        <strong>{section.title}</strong>
                        <small>{section.subtitle}</small>
                      </span>
                      <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} />
                    </button>
                    {isOpen ? (
                      <div className="ds-review-section__body">
                        <div className="ds-section-actions">
                          <button
                            type="button"
                            className={`ghost success ${reviewDecisions[section.title] === 'good' ? 'active' : ''}`}
                            onClick={() => {
                              setReviewDecisions((curr) => ({ ...curr, [section.title]: 'good' }));
                              setStatusLine(`${section.title} marked as looks good`);
                            }}
                          >
                            <Icon name="check" />
                            Looks good
                          </button>
                          <button
                            type="button"
                            className={`ghost danger ${reviewDecisions[section.title] === 'work' ? 'active' : ''}`}
                            onClick={() => {
                              setReviewDecisions((curr) => ({ ...curr, [section.title]: 'work' }));
                              setFeedbackSection(section.title);
                              setChatSeed({
                                id: `${section.title}-${Date.now()}`,
                                text: `Needs work on ${section.title}: `,
                              });
                            }}
                          >
                            <Icon name="comment" />
                            Needs work...
                          </button>
                        </div>
                        <pre>{section.body}</pre>
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
            <label className="ds-body-editor">
              DESIGN.md
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={16}
                disabled={!editable}
              />
            </label>
            <button type="button" className="primary" disabled={!editable || saving} onClick={() => void saveBody()}>
              Save DESIGN.md
            </button>
            {recentRevisions.length > 0 ? <RevisionHistoryList revisions={recentRevisions} /> : null}
          </div>
        ) : (
          <div className="ds-file-workspace-host">
            {workspaceProjectId ? (
              <FileWorkspace
                projectId={workspaceProjectId}
                projectKind="prototype"
                files={workspaceProjectFiles}
                liveArtifacts={[]}
                onRefreshFiles={() => {
                  void refreshDesignSystemWorkspace(workspaceProjectId);
                }}
                isDeck={false}
                streaming={chatStreaming || generationActive || saving}
                openRequest={workspaceOpenRequest}
                tabsState={workspaceTabsState}
                onTabsStateChange={persistWorkspaceTabsState}
              />
            ) : workspaceLoadError ? (
              <div className="viewer-empty">{workspaceLoadError}</div>
            ) : (
              <div className="viewer-empty">Opening the design system workspace...</div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
