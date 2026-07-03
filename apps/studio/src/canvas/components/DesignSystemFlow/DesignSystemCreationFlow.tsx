import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectorDetail } from '@open-design/contracts';
import {
  connectConnector,
  createDesignSystemDraft,
  disconnectConnector,
  ensureDesignSystemWorkspace,
  openFolderDialog,
} from '../../providers/registry';
import type { AppConfig, Project } from '../../types';
import { Icon } from '../shared/Icon';
import { useAnalytics } from '../../analytics/provider';
import { trackPageView } from '../../analytics/events';
import { peekOnboardingSessionId } from '../../analytics/onboarding-session';
import {
  buildProvenance,
  buildSourceNotes,
  dedupeLocalCodeFiles,
  dedupeResourceFiles,
  githubRepoLabel,
  inferDesignSystemTitle,
  localCodeRelativePath,
  localCodeSourceLabels,
  normalizeGithubUrl,
  prepareCreatedDesignSystemProject,
  resourceRelativePath,
  scheduleAfterProjectHandoff,
  selectAssetFiles,
  selectFigmaFiles,
  selectLocalCodeFiles,
  type SetupState,
} from './creation-context';
import { DropZone } from './DropZone';
import {
  fetchGithubConnectorStatusWithTimeout,
  GITHUB_CONNECTOR_ID,
  GitHubRepositoryAccessPanel,
  isComposioConfigured,
  isPendingConnectorAuth,
  isTrustedConnectorCallbackOrigin,
  openConnectorAuthorizationUrl,
} from './github-access';

interface CreationProps {
  onBack: () => void;
  onCreated: (projectId: string, project?: Project) => void;
  onProjectPrepared?: (project: Project) => void;
  onSystemsRefresh?: () => Promise<void> | void;
  config?: AppConfig;
  onOpenConnectorsTab?: () => void;
  chrome?: 'standalone' | 'embedded';
}

type SetupStep = 'setup' | 'confirm';

const EMPTY_SETUP: SetupState = {
  company: '',
  githubUrl: '',
  githubUrls: [],
  codeFiles: [],
  codeFolders: [],
  codeFileObjects: [],
  figFiles: [],
  figFileObjects: [],
  assetFiles: [],
  assetFileObjects: [],
  notes: '',
};

const CONNECTOR_CALLBACK_MESSAGE_TYPE = 'open-design:connector-connected';

export function DesignSystemCreationFlow({
  onBack,
  onCreated,
  onProjectPrepared,
  onSystemsRefresh,
  config,
  onOpenConnectorsTab,
  chrome = 'standalone',
}: CreationProps) {
  const [step, setStep] = useState<SetupStep>('setup');
  const [state, setState] = useState<SetupState>(EMPTY_SETUP);
  const [error, setError] = useState<string | null>(null);
  const [generationStarting, setGenerationStarting] = useState(false);
  const composioConfigured = isComposioConfigured(config?.composio);
  const [githubConnector, setGithubConnector] = useState<ConnectorDetail | null>(null);
  const [githubConnectorLoading, setGithubConnectorLoading] = useState(false);
  const [githubConnectorError, setGithubConnectorError] = useState<string | null>(null);
  const [githubConnectorAction, setGithubConnectorAction] = useState<'connect' | 'disconnect' | null>(null);
  const [githubAuthorizationPending, setGithubAuthorizationPending] = useState(false);
  const [githubAuthorizationUrl, setGithubAuthorizationUrl] = useState<string | null>(null);
  const githubConnectorRefreshId = useRef(0);
  const githubConnectorRequestInFlight = useRef(false);
  const embedded = chrome === 'embedded';

  // DS create page_view (v2 doc). Only fires for the standalone
  // /design-systems/create route — the embedded variant lives inside
  // OnboardingView, which owns the `area=design_system` step page_view.
  const analytics = useAnalytics();
  const creationPageViewFiredRef = useRef(false);
  useEffect(() => {
    if (embedded) return;
    if (creationPageViewFiredRef.current) return;
    creationPageViewFiredRef.current = true;
    const onboardingSessionId = peekOnboardingSessionId();
    trackPageView(analytics.track, {
      page_name: 'design_systems',
      area: 'design_system_create',
      view_type: 'page',
      entry_from: onboardingSessionId ? 'onboarding' : 'design_systems_page',
    });
  }, [analytics.track, embedded]);

  const refreshGithubConnector = useCallback(async () => {
    if (!composioConfigured) {
      githubConnectorRefreshId.current += 1;
      githubConnectorRequestInFlight.current = false;
      setGithubConnector(null);
      setGithubConnectorLoading(false);
      setGithubConnectorError(null);
      setGithubAuthorizationPending(false);
      setGithubAuthorizationUrl(null);
      return;
    }
    if (githubConnectorRequestInFlight.current) return;
    const refreshId = ++githubConnectorRefreshId.current;
    githubConnectorRequestInFlight.current = true;
    setGithubConnectorLoading(true);
    setGithubConnectorError(null);
    try {
      const { connector, timedOut } = await fetchGithubConnectorStatusWithTimeout();
      if (githubConnectorRefreshId.current !== refreshId) return;
      setGithubConnector(connector);
      if (connector?.status === 'connected') {
        setGithubAuthorizationPending(false);
        setGithubAuthorizationUrl(null);
      }
      if (connector?.status === 'error' && connector.lastError) {
        setGithubConnectorError(connector.lastError);
      }
      if (timedOut) {
        setGithubConnectorError(
          'Could not finish checking GitHub connector. You can still add repository URLs or connect GitHub manually.',
        );
      }
    } catch (err) {
      if (githubConnectorRefreshId.current !== refreshId) return;
      setGithubConnector(null);
      setGithubConnectorError(err instanceof Error ? err.message : 'Could not check the GitHub connector.');
    } finally {
      if (githubConnectorRefreshId.current === refreshId) {
        githubConnectorRequestInFlight.current = false;
      }
      if (githubConnectorRefreshId.current === refreshId) {
        setGithubConnectorLoading(false);
      }
    }
  }, [composioConfigured]);

  useEffect(() => {
    void refreshGithubConnector();
  }, [refreshGithubConnector]);

  useEffect(() => {
    if (!composioConfigured) return undefined;
    function handleConnectorMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if ((data as { type?: unknown }).type !== CONNECTOR_CALLBACK_MESSAGE_TYPE) return;
      if (!isTrustedConnectorCallbackOrigin(event.origin)) return;
      void refreshGithubConnector();
    }
    function handleFocus() {
      void refreshGithubConnector();
    }
    window.addEventListener('message', handleConnectorMessage);
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('message', handleConnectorMessage);
      window.removeEventListener('focus', handleFocus);
    };
  }, [composioConfigured, refreshGithubConnector]);

  async function handleConnectGithub() {
    if (!composioConfigured || githubConnectorAction) return;
    setGithubConnectorAction('connect');
    setGithubConnectorError(null);
    try {
      const result = await connectConnector(GITHUB_CONNECTOR_ID);
      if (result.error) setGithubConnectorError(result.error);
      if (result.connector) setGithubConnector(result.connector);
      if (result.auth?.redirectUrl) setGithubAuthorizationUrl(result.auth.redirectUrl);
      if (isPendingConnectorAuth(result.auth)) setGithubAuthorizationPending(true);
      if (result.auth?.kind === 'connected' || result.connector?.status === 'connected') {
        setGithubConnectorError(null);
        setGithubAuthorizationPending(false);
        setGithubAuthorizationUrl(null);
      }
    } catch (err) {
      setGithubConnectorError(err instanceof Error ? err.message : 'Could not start GitHub authorization.');
    } finally {
      setGithubConnectorAction(null);
    }
  }

  async function handleDisconnectGithub() {
    if (!composioConfigured || githubConnectorAction) return;
    setGithubConnectorAction('disconnect');
    setGithubConnectorError(null);
    try {
      const connector = await disconnectConnector(GITHUB_CONNECTOR_ID);
      setGithubConnector(connector);
      setGithubAuthorizationPending(false);
      setGithubAuthorizationUrl(null);
    } catch (err) {
      setGithubConnectorError(err instanceof Error ? err.message : 'Could not disconnect GitHub.');
    } finally {
      setGithubConnectorAction(null);
    }
  }

  function handleAddGithubUrl() {
    const nextUrl = normalizeGithubUrl(state.githubUrl);
    if (!nextUrl) return;
    setState((curr) => ({
      ...curr,
      githubUrl: '',
      githubUrls: Array.from(new Set([...curr.githubUrls, nextUrl])),
    }));
  }

  function handleRemoveGithubUrl(url: string) {
    setState((curr) => ({
      ...curr,
      githubUrls: curr.githubUrls.filter((item) => item !== url),
    }));
  }

  async function handlePickCodeFolder() {
    const selected = await openFolderDialog();
    if (!selected) return;
    setState((curr) => ({
      ...curr,
      codeFolders: Array.from(new Set([...curr.codeFolders, selected])),
    }));
  }

  function handleRemoveCodeFolder(folder: string) {
    setState((curr) => ({
      ...curr,
      codeFolders: curr.codeFolders.filter((item) => item !== folder),
      ...(curr.codeFolders.includes(folder) ? {} : { codeFiles: [], codeFileObjects: [] }),
    }));
  }

  async function generate() {
    if (generationStarting) return;
    setGenerationStarting(true);
    setError(null);
    try {
      const title = inferDesignSystemTitle(state);
      const created = await createDesignSystemDraft({
        title,
        summary: state.company,
        category: 'Custom',
        surface: 'web',
        status: 'draft',
        artifactMode: 'agent-managed',
        sourceNotes: buildSourceNotes(state),
        provenance: buildProvenance(state),
      });
      if (!created) {
        setError('Could not generate this design system.');
        setStep('setup');
        return;
      }
      const workspace = await ensureDesignSystemWorkspace(created.id);
      if (!workspace) {
        setError('Could not open the design system workspace.');
        setStep('setup');
        return;
      }
      const project = workspace.project;
      const setupState = state;
      const connector = githubConnector;
      onCreated(project.id, project);
      scheduleAfterProjectHandoff(() => {
        void prepareCreatedDesignSystemProject({
          project,
          state: setupState,
          composioConfigured,
          githubConnector: connector,
          onProjectPrepared,
          onSystemsRefresh,
        });
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not prepare the design system project.');
      setStep('setup');
    } finally {
      setGenerationStarting(false);
    }
  }

  if (step === 'confirm') {
    return (
      <div className="ds-setup-shell ds-setup-shell--center">
        <div className="ds-setup-center-card">
          <h1>It will take about 5 minutes to generate your design system.</h1>
          <p>You can step away. Keep the tab open in the background.</p>
          <div className="ds-setup-actions">
            <button type="button" className="ghost" onClick={() => setStep('setup')}>
              <Icon name="arrow-left" />
              Back
            </button>
            <button
              type="button"
              className="primary"
              disabled={generationStarting}
              onClick={() => void generate()}
            >
              <Icon name="sparkles" />
              {generationStarting ? 'Opening project...' : 'Generate'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`ds-setup-shell${embedded ? ' ds-setup-shell--embedded' : ''}`}>
      {embedded ? null : (
        <header className="ds-setup-topbar">
          <button type="button" className="ghost" onClick={onBack}>
            <Icon name="arrow-left" />
            Back
          </button>
          <span className="ds-setup-mark">
            <Icon name="blocks" />
          </span>
          <button
            type="button"
            className="primary"
            disabled={!state.company.trim()}
            onClick={() => {
              if (!state.company.trim()) {
                setError('Tell Open Design about the company or design system first.');
                return;
              }
              setStep('confirm');
            }}
          >
            Continue to generation
            <Icon name="chevron-right" />
          </button>
        </header>
      )}

      <main className="ds-setup-form">
        <h1>Generate from your material</h1>
        <p>Start with a short description, then add any source files you already have.</p>

        <label className="ds-setup-field">
          <span>Describe your brand or product</span>
          <textarea
            rows={4}
            value={state.company}
            onChange={(event) => setState((curr) => ({ ...curr, company: event.target.value }))}
            placeholder="e.g. Mission Impastabowl: fast-casual pasta restaurant with in-store touchscreen kiosk, mobile app and website"
          />
        </label>

        <section className="ds-resource-section">
          <h2>Add source material <span>(optional)</span></h2>
          <p>Use anything that shows your current style.</p>
          <div className="ds-resource-card">
            <div className="ds-resource-row">
              <strong>GitHub repo</strong>
              <div className="ds-resource-inline">
                <input
                  value={state.githubUrl}
                  onChange={(event) => setState((curr) => ({ ...curr, githubUrl: event.target.value }))}
                  placeholder="https://github.com/owner/repo"
                />
                <button
                  type="button"
                  className="ghost"
                  disabled={!state.githubUrl.trim()}
                  onClick={handleAddGithubUrl}
                >
                  Add
                </button>
              </div>
              {state.githubUrls.length > 0 ? (
                <div className="ds-github-url-list" aria-label="Added GitHub repositories">
                  {state.githubUrls.map((url) => (
                    <span key={url}>
                      <Icon name="github" />
                      {githubRepoLabel(url)}
                      <button
                        type="button"
                        aria-label={`Remove ${githubRepoLabel(url)}`}
                        onClick={() => handleRemoveGithubUrl(url)}
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <GitHubRepositoryAccessPanel
                composioConfigured={composioConfigured}
                connector={githubConnector}
                loading={githubConnectorLoading}
                action={githubConnectorAction}
                authorizationPending={githubAuthorizationPending}
                authorizationUrl={githubAuthorizationUrl}
                error={githubConnectorError}
                onOpenConnectorsTab={onOpenConnectorsTab}
                onConnect={() => void handleConnectGithub()}
                onOpenAuthorization={() => openConnectorAuthorizationUrl(githubAuthorizationUrl)}
                onDisconnect={() => void handleDisconnectGithub()}
              />
            </div>
            <DropZone
              label="Link local code"
              helper="Use a folder or selected files from this computer."
              prompt="Drag a folder here or browse"
              names={localCodeSourceLabels(state)}
              directory
              onBrowseFolder={() => void handlePickCodeFolder()}
              onRemoveName={handleRemoveCodeFolder}
              onFiles={(_names, files) => {
                const stagedFiles = selectLocalCodeFiles(files);
                const stagedNames = stagedFiles.map((file) => localCodeRelativePath(file));
                setState((curr) => ({
                  ...curr,
                  codeFiles: Array.from(new Set([...curr.codeFiles, ...stagedNames])),
                  codeFileObjects: dedupeLocalCodeFiles([...curr.codeFileObjects, ...stagedFiles]),
                }));
              }}
            />
            <DropZone
              label="Upload .fig"
              helper="Parsed locally; only a summary is added."
              prompt="Drop .fig here or browse"
              accept=".fig"
              names={state.figFiles}
              onFiles={(_names, files) => {
                const stagedFiles = selectFigmaFiles(files);
                const stagedNames = stagedFiles.map((file) => resourceRelativePath(file));
                setState((curr) => ({
                  ...curr,
                  figFiles: Array.from(new Set([...curr.figFiles, ...stagedNames])),
                  figFileObjects: dedupeResourceFiles([...curr.figFileObjects, ...stagedFiles]),
                }));
              }}
            />
            <DropZone
              label="Add assets"
              prompt="Drag files here or browse"
              names={state.assetFiles}
              onFiles={(_names, files) => {
                const stagedFiles = selectAssetFiles(files);
                const stagedNames = stagedFiles.map((file) => resourceRelativePath(file));
                setState((curr) => ({
                  ...curr,
                  assetFiles: Array.from(new Set([...curr.assetFiles, ...stagedNames])),
                  assetFileObjects: dedupeResourceFiles([...curr.assetFileObjects, ...stagedFiles]),
                }));
              }}
            />
          </div>
        </section>

        {embedded ? null : (
          <label className="ds-setup-field">
            <span>Notes</span>
            <textarea
              rows={4}
              value={state.notes}
              onChange={(event) => setState((curr) => ({ ...curr, notes: event.target.value }))}
              placeholder="e.g. We use a warm, earthy color palette with rounded corners. Our brand voice is playful but professional..."
            />
          </label>
        )}
        {error ? <div className="ds-editor-error">{error}</div> : null}
        {embedded ? (
          <div className="ds-setup-actions ds-setup-actions--embedded">
            <button type="button" className="ghost" onClick={onBack}>
              <Icon name="arrow-left" />
              Back
            </button>
            <button
              type="button"
              className="primary"
              disabled={!state.company.trim()}
              onClick={() => {
                if (!state.company.trim()) {
                  setError('Tell Open Design about the company or design system first.');
                  return;
                }
                setStep('confirm');
              }}
            >
              Generate
              <Icon name="chevron-right" />
            </button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
