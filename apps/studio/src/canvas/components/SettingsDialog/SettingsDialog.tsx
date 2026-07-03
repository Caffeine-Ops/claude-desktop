import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  agentIdToTracking,
  byokProtocolToTracking,
  executionModeToTracking,
  settingsSectionToTracking,
} from '@open-design/contracts/analytics';
import { useAnalytics } from '../../analytics/provider';
import {
  trackSettingsByokTestResult,
  trackSettingsCliTestResult,
  trackSettingsByokFieldClick,
  trackSettingsByokProviderOptionClick,
  trackSettingsConnectorAuthResult,
  trackSettingsLanguageClick,
  trackSettingsLocalCliClick,
  trackSettingsExecutionModeTabClick,
  trackSettingsPrivacyClick,
  trackSettingsView,
} from '../../analytics/events';
import { LOCALE_LABEL, LOCALES, useI18n } from '../../i18n';
import type { Locale } from '../../i18n';
import { AgentIcon } from '../shared/AgentIcon';
import { ExportDiagnosticsRow } from '../settings/ExportDiagnosticsButton';
import { Icon } from '../shared/Icon';
import {
  CUSTOM_MODEL_SENTINEL,
  renderModelOptions,
} from '../shared/modelOptions';
import {
  KNOWN_PROVIDERS,
  hasAnyConfiguredProvider,
  syncComposioConfigToDaemon,
} from '../../state/config';
import {
  API_KEY_PLACEHOLDERS,
  API_PROTOCOL_LABELS,
  API_PROTOCOL_TABS,
  SUGGESTED_MODELS_BY_PROTOCOL,
} from '../../state/apiProtocols';
import {
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  modelMaxTokensDefault,
} from '../../state/maxTokens';
import type {
  ApiProtocol,
  ApiProtocolConfig,
  AppConfig,
  ConnectionTestResponse,
  OrbitRunSummary,
  ExecMode,
  ProviderModelOption,
} from '../../types';
import { testAgent, testApiProvider } from '../../providers/connection-test';
import { fetchProviderModels } from '../../providers/provider-models';
import { fetchLatestGithubReleaseInfo } from '../../providers/registry';
import { IMAGE_MODELS } from '../../media/models';
import { Toast } from '../shared/Toast';
import { PetSettings } from '../pet/PetSettings';
import { McpClientSection } from '../settings/McpClientSection';
import { SkillsSection } from '../settings/SkillsSection';
import { DesignSystemsSection } from '../design-system/DesignSystemsSection';
import { PrivacySection } from '../settings/PrivacySection';
import { RoutinesSection } from '../automations/RoutinesSection';
import { MemoryModelInline } from '../memory/MemoryModelInline';
import { MemorySection } from '../memory/MemorySection';
import {
  applyAppearanceToDocument,
  resolveAccentColor,
} from '../../state/appearance';
import { isAutosaveDraftOnlyChange } from '../../App';
import {
  API_KEY_CONSOLE_LINKS,
  AGENT_CLI_ENV_FIELDS,
  AGENT_SHORT_DESCRIPTIONS,
  agentRefreshOptionsForConfig,
  apiModelOptionLabel,
  byokProviderRequiresApiKey,
  canRunProviderConnectionTest,
  cleanAgentVersionLabel,
  codexPathRepairState,
  codexPathStrings,
  isValidApiBaseUrl,
  mergeProviderModelOptions,
  missingByokConnectionFields,
  missingByokModelFetchFields,
  providerConnectionTestKey,
  providerModelsCacheKey,
  sanitizeHttpsUrl,
  shouldShowCustomModelInput,
  switchApiProtocolConfig,
  testStatusVariant,
  updateAgentCliEnvValue,
  updateCurrentApiProtocolConfig,
} from './settingsHelpers';
import type {
  ByokPreconditionAction,
  ByokRequiredField,
  ProviderModelsState,
  RescanNotice,
  SettingsDialogProps,
  SettingsSection,
  TestState,
} from './settingsHelpers';
import { ConnectorSection } from './ConnectorSection';
import { OrbitSection } from './OrbitSection';
import { MediaProvidersSection } from './MediaProvidersSection';
import { IntegrationsSection } from './IntegrationsSection';
import { AppearanceSection } from './AppearanceSection';
import { LogAnalysisSection } from './LogAnalysisSection';
import { CritiqueTheaterSection } from './CritiqueTheaterSection';
import { NotificationsSection } from './NotificationsSection';

export function SettingsDialog({
  initial,
  agents,
  daemonLive,
  appVersionInfo,
  welcome,
  initialSection = 'execution',
  onPersist,
  onPersistComposioKey,
  composioConfigLoading = false,
  onClose,
  onRefreshAgents,
  daemonMediaProviders,
  daemonMediaProvidersFetchState = 'idle',
  mediaProvidersNotice,
  onReloadMediaProviders,
  embedded = false,
  controlledSection,
  onSectionChange,
}: SettingsDialogProps) {
  const { t, locale, setLocale } = useI18n();
  const analytics = useAnalytics();
  const [cfg, setCfg] = useState<AppConfig>(initial);
  const [pendingMediaProviderEditIds, setPendingMediaProviderEditIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const lastSavedAppearanceRef = useRef({
    theme: initial.theme ?? 'system',
    accentColor: resolveAccentColor(initial.accentColor),
  });

  // settings_view — fire on dialog open and on every section switch so the
  // configuration funnel can see which section the user spent time in.
  // The fire is keyed on section so a section bounce (open → switch →
  // close) emits one event per surface.
  const lastViewSectionRef = useRef<string | null>(null);

  useEffect(() => {
    lastSavedAppearanceRef.current = {
      theme: initial.theme ?? 'system',
      accentColor: resolveAccentColor(initial.accentColor),
    };
  }, [initial.theme, initial.accentColor]);

  // Revert the live theme preview to the most recently persisted appearance.
  // That is the initial appearance until autosave succeeds; after autosave,
  // closing Settings must not roll the document back to stale colors.
  useLayoutEffect(() => {
    return () => {
      applyAppearanceToDocument(lastSavedAppearanceRef.current);
    };
  }, []);
  const [showApiKey, setShowApiKey] = useState(false);
  // Active section is internal (non-embedded standalone dialog) but can be
  // controlled by the host shell in embedded mode. When `controlledSection`
  // is provided we read from it and report changes up via `onSectionChange`;
  // otherwise the local state owns it, exactly as before.
  const [internalSection, setInternalSection] =
    useState<SettingsSection>(initialSection);
  const activeSection = controlledSection ?? internalSection;
  const setActiveSection = useCallback(
    (next: SettingsSection) => {
      if (controlledSection !== undefined) {
        onSectionChange?.(next);
      } else {
        setInternalSection(next);
      }
    },
    [controlledSection, onSectionChange],
  );
  // Scroll the right-hand content pane back to the top whenever the user
  // picks a different settings section. Without this, switching from a
  // long section the user had scrolled (e.g. Library) into a short one
  // (About) keeps the previous scrollTop, so the new section's header
  // can land out of view and the panel reads as half-loaded. Issue #634.
  const settingsContentRef = useRef<HTMLDivElement | null>(null);
  const [agentRescanRunning, setAgentRescanRunning] = useState(false);
  const [agentRescanNotice, setAgentRescanNotice] =
    useState<RescanNotice | null>(null);
  const [agentTestState, setAgentTestState] = useState<TestState>({
    status: 'idle',
  });
  const [providerTestState, setProviderTestState] = useState<TestState>({
    status: 'idle',
  });
  const [byokPreconditionNotice, setByokPreconditionNotice] = useState<{
    action: ByokPreconditionAction;
    message: string;
  } | null>(null);
  const [providerModelsState, setProviderModelsState] =
    useState<ProviderModelsState>({ status: 'idle' });
  const [providerModelsCommittedKey, setProviderModelsCommittedKey] =
    useState<string | null>(() => {
      const protocol = initial.apiProtocol ?? 'anthropic';
      if (
        initial.mode !== 'api' ||
        protocol === 'azure' ||
        protocol === 'ollama' ||
        missingByokModelFetchFields(initial).length > 0 ||
        !isValidApiBaseUrl(initial.baseUrl)
      ) {
        return null;
      }
      return providerModelsCacheKey(
        protocol,
        initial.baseUrl,
        initial.apiKey,
        initial.apiVersion ?? '',
      );
    });
  const [providerModelsCache, setProviderModelsCache] = useState<
    Record<string, ProviderModelOption[]>
  >({});
  const agentTestAbortRef = useRef<AbortController | null>(null);
  const providerTestAbortRef = useRef<AbortController | null>(null);
  const providerModelsAbortRef = useRef<AbortController | null>(null);
  const pendingAgentInstallRescanRef = useRef(false);
  const agentTestRevisionRef = useRef(0);
  const providerTestRevisionRef = useRef(0);
  const providerModelsRevisionRef = useRef(0);
  const providerModelsFirstResetRef = useRef(true);
  const providerAutoTestKeyRef = useRef<string | null>(null);
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const baseUrlInputRef = useRef<HTMLInputElement | null>(null);
  const modelSelectRef = useRef<HTMLSelectElement | null>(null);
  const customModelInputRef = useRef<HTMLInputElement | null>(null);
  const focusByokRequiredFieldAfterProtocolSwitchRef = useRef(false);
  const [apiModelCustomEditing, setApiModelCustomEditing] = useState(false);
  const [agentCustomModelIds, setAgentCustomModelIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [versionChecking, setVersionChecking] = useState(false);
  const [aboutToast, setAboutToast] = useState<string | null>(null);

  const handleInstallLatest = useCallback(async () => {
    if (versionChecking || !appVersionInfo) return;
    setVersionChecking(true);
    try {
      const release = await fetchLatestGithubReleaseInfo();
      const latestTag = (release?.tagName ?? '').replace(/^v/, '');
      if (release?.stale !== true && latestTag && latestTag === appVersionInfo.version) {
        setAboutToast(t('settings.alreadyLatest'));
        return;
      }
    } catch {
      // network error — fall through to open releases page
    } finally {
      setVersionChecking(false);
    }
    window.open('https://github.com/nexu-io/open-design/releases', '_blank', 'noopener,noreferrer');
  }, [versionChecking, appVersionInfo, t]);

  // Imperative handle for the External MCP section. The dialog footer Save
  // routes through this when the MCP tab is active so the user can press the
  // single Save button at the bottom instead of hunting for the inner one.
  useEffect(() => {
    // Only the non-embedded dialog resets to initialSection here; in
    // embedded mode the host shell owns the active section, so syncing it
    // from here would fight the host's sidebar.
    if (controlledSection === undefined) {
      setInternalSection(initialSection);
    }
  }, [initialSection, controlledSection]);

  // settings_view — fires whenever the active section changes (and once on
  // mount). Keying the fire on a section+section-string lets us dedupe
  // accidental double-renders while still capturing genuine tab switches.
  useEffect(() => {
    if (lastViewSectionRef.current === activeSection) return;
    lastViewSectionRef.current = activeSection;
    // v2 settings_view collapses to `{ page=settings, area }`; the
    // execution_mode / has_available_cli / selected_cli_id signal that v1
    // tagged onto every view now lives in the configure-state global
    // properties (registered once and inherited by every event).
    trackSettingsView(analytics.track, {
      page_name: 'settings',
      area: settingsSectionToTracking(activeSection),
    });
  }, [activeSection, analytics.track]);
  useEffect(() => {
    const el = settingsContentRef.current;
    if (el) el.scrollTop = 0;
  }, [activeSection]);

  // Tests pin a result against the unsaved draft. Once the user edits any
  // field that feeds into the test, the result is no longer trustworthy —
  // clear it so we don't show a stale "Connected" line next to fresh input.
  // If a test is already running, leave the running state visible and let the
  // stale result be ignored when it returns; the button stays disabled so a
  // new smoke test cannot overlap the old one.
  const agentChoiceForTest = cfg.agentModels?.[cfg.agentId ?? ''];
  const selectedMemoryChatAgent =
    cfg.mode === 'daemon' && cfg.agentId
      ? agents.find((agent) => agent.id === cfg.agentId) ?? null
      : null;
  const selectedMemoryChatModel =
    cfg.mode === 'daemon' && cfg.agentId
      ? cfg.agentModels?.[cfg.agentId]?.model
      ?? selectedMemoryChatAgent?.models?.[0]?.id
      ?? null
    : null;
  useEffect(() => {
    agentTestRevisionRef.current += 1;
    setAgentTestState((state) =>
      state.status === 'running' ? state : { status: 'idle' },
    );
  }, [
    cfg.agentId,
    agentChoiceForTest?.model,
    agentChoiceForTest?.reasoning,
    cfg.agentCliEnv,
  ]);
  // Rescan notices are list-level feedback for a one-shot action and
  // shouldn't linger in the content stream. After 6s, fade them out so
  // repeated Rescan clicks don't pile up; the next click resets the
  // notice immediately, so this only affects "user moved on" cases.
  useEffect(() => {
    if (!agentRescanNotice) return;
    const id = window.setTimeout(() => setAgentRescanNotice(null), 6000);
    return () => window.clearTimeout(id);
  }, [agentRescanNotice]);
  useEffect(() => {
    providerTestRevisionRef.current += 1;
    providerAutoTestKeyRef.current = null;
    setByokPreconditionNotice(null);
    setProviderTestState((state) =>
      state.status === 'running' ? state : { status: 'idle' },
    );
  }, [
    cfg.apiProtocol,
    cfg.apiKey,
    cfg.baseUrl,
    cfg.model,
    cfg.apiVersion,
  ]);
  useEffect(() => {
    if (providerModelsFirstResetRef.current) {
      providerModelsFirstResetRef.current = false;
      return;
    }
    providerModelsRevisionRef.current += 1;
    providerModelsAbortRef.current?.abort();
    providerModelsAbortRef.current = null;
    setProviderModelsCommittedKey(null);
    setByokPreconditionNotice(null);
    setProviderModelsState({ status: 'idle' });
  }, [
    cfg.apiProtocol,
    cfg.apiKey,
    cfg.baseUrl,
    cfg.apiVersion,
  ]);
  // Releasing the abort controllers on unmount avoids the "setState after
  // unmount" warning if the dialog closes while a test is still running.
  useEffect(() => {
    return () => {
      agentTestAbortRef.current?.abort();
      providerTestAbortRef.current?.abort();
      providerModelsAbortRef.current?.abort();
    };
  }, []);

  const installedCount = useMemo(
    () => agents.filter((a) => a.available).length,
    [agents],
  );

  const setMode = (mode: ExecMode) => {
    setCfg((c) => {
      const modeBefore = executionModeToTracking(c.mode);
      const modeAfter = executionModeToTracking(mode);
      if (modeBefore !== modeAfter) {
        trackSettingsExecutionModeTabClick(analytics.track, {
          page_name: 'settings',
          area: 'configure_execution_mode',
          element: 'execution_mode_tab',
          action: 'switch_execution_mode',
          mode_before: modeBefore,
          mode_after: modeAfter,
        });
      }
      return { ...c, mode };
    });
  };
  const setApiProtocol = (protocol: ApiProtocol) => {
    setApiModelCustomEditing(false);
    focusByokRequiredFieldAfterProtocolSwitchRef.current = true;
    setCfg((c) => switchApiProtocolConfig(c, protocol));
  };
  const updateApiConfig = (patch: Partial<ApiProtocolConfig>) =>
    setCfg((c) => updateCurrentApiProtocolConfig(c, patch));
  const markAgentInstallIntent = () => {
    pendingAgentInstallRescanRef.current = true;
  };
  const handleRefreshAgents = async () => {
    if (agentRescanRunning) return;
    setAgentRescanRunning(true);
    setAgentRescanNotice(null);
    try {
      const refreshed = await onRefreshAgents(agentRefreshOptionsForConfig(cfg));
      const nextAgents = Array.isArray(refreshed) ? refreshed : agents;
      setAgentRescanNotice({
        kind: 'success',
        count: nextAgents.filter((a) => a.available).length,
      });
    } catch {
      setAgentRescanNotice({ kind: 'error' });
    } finally {
      setAgentRescanRunning(false);
    }
  };
  useEffect(() => {
    const handleReturnToSettings = () => {
      if (
        !pendingAgentInstallRescanRef.current ||
        agentRescanRunning ||
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      pendingAgentInstallRescanRef.current = false;
      void handleRefreshAgents();
    };
    document.addEventListener('visibilitychange', handleReturnToSettings);
    window.addEventListener('focus', handleReturnToSettings);
    return () => {
      document.removeEventListener('visibilitychange', handleReturnToSettings);
      window.removeEventListener('focus', handleReturnToSettings);
    };
  }, [agentRescanRunning, handleRefreshAgents]);

  const handleTestAgent = async () => {
    if (agentTestState.status === 'running') {
      return;
    }
    const selected = agents.find((a) => a.id === cfg.agentId && a.available);
    if (!selected) return;
    const choice = cfg.agentModels?.[selected.id] ?? {};
    const controller = new AbortController();
    const revision = agentTestRevisionRef.current;
    agentTestAbortRef.current = controller;
    setAgentTestState({ status: 'running' });
    const startedAt = performance.now();
    const cliProviderId = agentIdToTracking(selected.id);
    const clearIfStale = () => {
      if (agentTestAbortRef.current === controller) {
        setAgentTestState({ status: 'idle' });
      }
    };
    try {
      const result = await testAgent(
        {
          agentId: selected.id,
          model: choice.model || undefined,
          reasoning: choice.reasoning || undefined,
          agentCliEnv: cfg.agentCliEnv ?? {},
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (agentTestRevisionRef.current !== revision) {
        clearIfStale();
        return;
      }
      setAgentTestState({ status: 'done', result });
      trackSettingsCliTestResult(analytics.track, {
        page_name: 'settings',
        area: 'configure_execution_mode',
        cli_provider_id: cliProviderId,
        result: result.ok ? 'success' : 'failed',
        ...(result.ok ? {} : { error_code: result.kind || 'UNKNOWN' }),
        duration_ms: Math.round(performance.now() - startedAt),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (agentTestRevisionRef.current !== revision) {
        clearIfStale();
        return;
      }
      setAgentTestState({
        status: 'done',
        result: {
          ok: false,
          kind: 'unknown',
          latencyMs: 0,
          model: choice.model || 'default',
          detail: err instanceof Error ? err.message : 'Test request failed',
        },
      });
      trackSettingsCliTestResult(analytics.track, {
        page_name: 'settings',
        area: 'configure_execution_mode',
        cli_provider_id: cliProviderId,
        result: 'failed',
        error_code: err instanceof Error ? err.name : 'UNKNOWN',
        duration_ms: Math.round(performance.now() - startedAt),
      });
    } finally {
      if (agentTestAbortRef.current === controller) {
        agentTestAbortRef.current = null;
      }
    }
  };

  const handleTestProvider = async (
    options: { silentPreconditions?: boolean } = {},
  ) => {
    if (providerTestState.status === 'running') {
      return;
    }
    const missing = missingByokConnectionFields(cfg, {
      requiresApiKey: byokRequiresApiKey,
    });
    if (missing.length > 0) {
      if (options.silentPreconditions) {
        return;
      }
      showByokPreconditionNotice('test', missing);
      const byokProviderId = byokProtocolToTracking(apiProtocol);
      if (byokProviderId) {
        trackSettingsByokTestResult(analytics.track, {
          page_name: 'settings',
          area: 'execution_model',
          provider_id: byokProviderId,
          result: 'not_ready',
          duration_ms: 0,
        });
      }
      return;
    }
    const controller = new AbortController();
    const revision = providerTestRevisionRef.current;
    providerTestAbortRef.current = controller;
    setProviderTestState({ status: 'running' });
    const startedAt = performance.now();
    const clearIfStale = () => {
      if (providerTestAbortRef.current === controller) {
        setProviderTestState({ status: 'idle' });
      }
    };
    try {
      const result = await testApiProvider(
        {
          protocol: apiProtocol,
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: cfg.model,
          apiVersion:
            apiProtocol === 'azure'
              ? cfg.apiVersion?.trim() || undefined
              : undefined,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (providerTestRevisionRef.current !== revision) {
        clearIfStale();
        return;
      }
      setProviderTestState({ status: 'done', result });
      const byokProviderId = byokProtocolToTracking(apiProtocol);
      if (byokProviderId) {
        trackSettingsByokTestResult(analytics.track, {
          page_name: 'settings',
          area: 'execution_model',
          provider_id: byokProviderId,
          result: result.ok ? 'success' : 'failed',
          ...(result.ok ? {} : { error_code: result.kind || 'UNKNOWN' }),
          duration_ms: Math.round(performance.now() - startedAt),
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (providerTestRevisionRef.current !== revision) {
        clearIfStale();
        return;
      }
      setProviderTestState({
        status: 'done',
        result: {
          ok: false,
          kind: 'unknown',
          latencyMs: 0,
          model: cfg.model,
          detail: err instanceof Error ? err.message : 'Test request failed',
        },
      });
      const byokProviderId = byokProtocolToTracking(apiProtocol);
      if (byokProviderId) {
        trackSettingsByokTestResult(analytics.track, {
          page_name: 'settings',
          area: 'execution_model',
          provider_id: byokProviderId,
          result: 'failed',
          error_code: err instanceof Error ? err.name : 'UNKNOWN',
          duration_ms: Math.round(performance.now() - startedAt),
        });
      }
    } finally {
      if (providerTestAbortRef.current === controller) {
        providerTestAbortRef.current = null;
      }
    }
  };

  const handleAutoTestProvider = () => {
    if (providerTestState.status === 'running') {
      return;
    }
    if (
      missingByokConnectionFields(cfg, {
        requiresApiKey: byokRequiresApiKey,
      }).length > 0 ||
      !baseUrlValid
    ) {
      return;
    }
    const key = providerConnectionTestKey(apiProtocol, cfg);
    if (providerAutoTestKeyRef.current === key) {
      return;
    }
    providerAutoTestKeyRef.current = key;
    void handleTestProvider({ silentPreconditions: true });
  };

  const handleFetchProviderModels = async (
    options: { silent?: boolean } = {},
  ) => {
    if (providerModelsState.status === 'running') {
      return;
    }
    if (apiProtocol === 'azure') {
      if (!options.silent) {
        setByokPreconditionNotice({
          action: 'test',
          message: t('settings.fetchModelsUnsupportedAzure'),
        });
      }
      return;
    }
    if (apiProtocol === 'ollama') {
      if (!options.silent) {
        setByokPreconditionNotice({
          action: 'test',
          message: t('settings.fetchModelsUnsupportedOllama'),
        });
      }
      return;
    }
    const missing = missingByokModelFetchFields(cfg);
    if (missing.length > 0) {
      if (!options.silent) {
        showByokPreconditionNotice('test', missing);
      }
      return;
    }
    if (!baseUrlValid) {
      if (!options.silent) {
        setByokPreconditionNotice({
          action: 'test',
          message: t('settings.fetchModelsInvalidBaseUrl'),
        });
        focusByokRequiredField('base_url');
      }
      return;
    }
    const cacheKey = providerModelsCacheKey(
      apiProtocol,
      cfg.baseUrl,
      cfg.apiKey,
      cfg.apiVersion ?? '',
    );
    const cachedModels = providerModelsCache[cacheKey];
    if (cachedModels) {
      setProviderModelsState({
        status: 'done',
        cacheKey,
        result: {
          ok: true,
          kind: 'success',
          latencyMs: 0,
          models: cachedModels,
        },
      });
      return;
    }
    const controller = new AbortController();
    const revision = providerModelsRevisionRef.current;
    providerModelsAbortRef.current = controller;
    setProviderModelsState({ status: 'running', cacheKey });
    const clearIfStale = () => {
      if (providerModelsAbortRef.current === controller) {
        setProviderModelsState({ status: 'idle' });
      }
    };
    try {
      const result = await fetchProviderModels(
        {
          protocol: apiProtocol,
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (providerModelsRevisionRef.current !== revision) {
        clearIfStale();
        return;
      }
      if (result.ok && result.models?.length) {
        setProviderModelsCache((prev) => ({
          ...prev,
          [cacheKey]: result.models ?? [],
        }));
      }
      setProviderModelsState({ status: 'done', cacheKey, result });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      if (providerModelsRevisionRef.current !== revision) {
        clearIfStale();
        return;
      }
      setProviderModelsState({
        status: 'done',
        cacheKey,
        result: {
          ok: false,
          kind: 'unknown',
          latencyMs: 0,
          detail: err instanceof Error ? err.message : 'Model list request failed',
        },
      });
    } finally {
      if (providerModelsAbortRef.current === controller) {
        providerModelsAbortRef.current = null;
      }
    }
  };

  const renderTestMessage = (
    result: ConnectionTestResponse,
    kindForSuccess: 'api' | 'cli',
  ): string => {
    const ms = Math.max(0, Math.round(result.latencyMs));
    const sample = result.sample ?? '';
    const agentName = result.agentName ?? '';
    const testedModel = result.model ?? cfg.model;
    if (result.ok) {
      const baseMessage = kindForSuccess === 'api'
        ? t('settings.testSuccessApi', { ms, sample })
        : t('settings.testSuccessCli', { agentName, ms, sample });
      if (kindForSuccess === 'cli' && cfg.agentId === 'codex') {
        const codexStrings = codexPathStrings(locale);
        if (
          result.usedExecutableSource === 'configured' &&
          result.configuredExecutablePath
        ) {
          return `${baseMessage} ${codexStrings.configuredSuccess(result.configuredExecutablePath)}`;
        }
        if (
          result.usedExecutableSource === 'fallback_invalid' &&
          result.configuredExecutablePath &&
          result.detectedExecutablePath
        ) {
          return `${baseMessage} ${codexStrings.invalidFallback(
            result.configuredExecutablePath,
            result.detectedExecutablePath,
          )}`;
        }
        if (
          result.usedExecutableSource === 'fallback_failed' &&
          result.configuredExecutablePath &&
          result.detectedExecutablePath
        ) {
          return `${baseMessage} ${codexStrings.failedFallback(
            result.configuredExecutablePath,
            result.detectedExecutablePath,
          )}`;
        }
      }
      return result.detail ? `${baseMessage} ${result.detail}` : baseMessage;
    }
    switch (result.kind) {
      case 'auth_failed':
        return t('settings.testAuthFailed');
      case 'forbidden':
        return t('settings.testForbidden');
      case 'not_found_model':
        return t('settings.testNotFoundModel', { model: testedModel });
      case 'invalid_model_id':
        return t('settings.testInvalidModelId', { model: testedModel });
      case 'invalid_base_url':
        return t('settings.testInvalidBaseUrl');
      case 'rate_limited':
        return t('settings.testRateLimited');
      case 'upstream_unavailable':
        return t('settings.testUpstream', { status: result.status ?? 0 });
      case 'timeout':
        return t('settings.testTimeout', { ms });
      case 'agent_not_installed':
        return t('settings.testAgentMissing', { agentName });
      case 'agent_auth_required':
        return result.detail || 'Agent authentication is required.';
      case 'agent_spawn_failed':
        return t('settings.testAgentSpawn', {
          agentName,
          detail: result.detail ?? '',
        });
      default:
        return t('settings.testUnknown', { detail: result.detail ?? '' });
    }
  };

  const applyCodexDetectedPath = (detectedPath: string) => {
    setCfg((c) => updateAgentCliEnvValue(c, 'codex', 'CODEX_BIN', detectedPath));
    setAgentTestState({ status: 'idle' });
  };

  const clearCodexCustomPath = () => {
    setCfg((c) => updateAgentCliEnvValue(c, 'codex', 'CODEX_BIN', ''));
    setAgentTestState({ status: 'idle' });
  };

  const apiProtocol = cfg.apiProtocol ?? 'anthropic';
  const apiKeyConsoleLink = API_KEY_CONSOLE_LINKS[apiProtocol];
  const baseUrlValid = isValidApiBaseUrl(cfg.baseUrl);
  const baseUrlInvalid = Boolean(cfg.baseUrl.trim() && !baseUrlValid);
  const byokRequiredLabel = (field: ByokRequiredField): string => {
    switch (field) {
      case 'api_key':
        return t('settings.apiKey');
      case 'base_url':
        return t('settings.baseUrl');
      case 'model':
        return apiProtocol === 'azure'
          ? t('settings.azureDeploymentModel')
          : t('settings.model');
      default: {
        const exhaustive: never = field;
        return exhaustive;
      }
    }
  };
  const formatByokMissingFields = (fields: ByokRequiredField[]): string =>
    fields.map(byokRequiredLabel).join(', ');
  const focusByokRequiredField = (field: ByokRequiredField | undefined) => {
    if (!field) return;
    window.setTimeout(() => {
      if (field === 'api_key') {
        apiKeyInputRef.current?.focus();
        return;
      }
      if (field === 'base_url') {
        baseUrlInputRef.current?.focus();
        return;
      }
      if (customModelInputRef.current) {
        customModelInputRef.current.focus();
        return;
      }
      modelSelectRef.current?.focus();
    }, 0);
  };
  const showByokPreconditionNotice = (
    action: ByokPreconditionAction,
    fields: ByokRequiredField[],
  ) => {
    setByokPreconditionNotice({
      action,
      message: t('settings.testMissingFields', {
        fields: formatByokMissingFields(fields),
      }),
    });
    focusByokRequiredField(fields[0]);
  };
  // Autosave loop. Every committed edit to `cfg` schedules a debounced
  // sync to localStorage + the daemon. We keep a 400ms debounce so rapid
  // typing in text fields doesn't flood the daemon with PUTs while still
  // feeling near-instant for toggles/selects (which fire once and settle).
  // The Composio API key field is intentionally excluded from this loop —
  // see ConnectorSection for the explicit "Save key" gesture.
  // The status here drives the footer indicator: 'idle' = no draft to
  // flush, 'pending' = scheduled, 'saving' = request in flight, 'saved'
  // = recent successful sync, 'error' = recent failure.
  const [autosaveStatus, setAutosaveStatus] =
    useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle');
  // Skip the very first effect tick so just opening the dialog doesn't
  // appear to "save" anything before the user has touched a field.
  const autosaveSkipFirstRef = useRef(true);
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveSavedTimerRef = useRef<number | null>(null);
  const autosaveRetryTimerRef = useRef<number | null>(null);
  const autosavePendingFlushRef = useRef(false);
  const autosaveLatestRef = useRef<AppConfig>(cfg);
  // Baseline used by the draft-only detector: the snapshot at the most
  // recent successful autosave (or the initial cfg on mount). Compared
  // against the current snapshot to decide whether the only edits
  // since last save are intentionally-stripped fields like the
  // Composio API key — in which case we must NOT flash "All changes
  // saved", because the draft has not actually been persisted.
  const autosaveLastSavedRef = useRef<AppConfig>(cfg);
  const mediaProvidersChangeVersionRef = useRef(0);
  const lastSyncedMediaProvidersVersionRef = useRef(0);
  const [autosaveRetryTick, setAutosaveRetryTick] = useState(0);
  autosaveLatestRef.current = cfg;
  useEffect(() => {
    if (autosaveSkipFirstRef.current) {
      autosaveSkipFirstRef.current = false;
      autosaveLastSavedRef.current = cfg;
      return;
    }
    setAutosaveStatus('pending');
    if (autosaveSavedTimerRef.current != null) {
      window.clearTimeout(autosaveSavedTimerRef.current);
      autosaveSavedTimerRef.current = null;
    }
    if (autosaveRetryTimerRef.current != null) {
      window.clearTimeout(autosaveRetryTimerRef.current);
      autosaveRetryTimerRef.current = null;
    }
    if (autosaveTimerRef.current != null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosavePendingFlushRef.current = true;
    autosaveTimerRef.current = window.setTimeout(() => {
      autosavePendingFlushRef.current = false;
      autosaveTimerRef.current = null;
      const snapshot = autosaveLatestRef.current;
      const mediaProvidersVersion = mediaProvidersChangeVersionRef.current;
      const persistOptions = {
        forceMediaProviderSync: mediaProvidersVersion > lastSyncedMediaProvidersVersionRef.current,
      };
      // Draft-only edit (e.g. the user is mid-typing the Composio API
      // key, which only commits via the explicit "Save key" gesture):
      // the persisted shape would be identical to what is already on
      // disk, so a save would be a no-op that mis-reports "Saved" and
      // makes users trust that a sensitive key was persisted when it
      // was not. Skip the persist and settle the indicator to idle.
      // The forced media-provider sync path still runs because that
      // is a real outbound effect even when the persisted shape
      // hasn't changed.
      if (
        !persistOptions.forceMediaProviderSync
        && isAutosaveDraftOnlyChange(snapshot, autosaveLastSavedRef.current)
      ) {
        setAutosaveStatus('idle');
        return;
      }
      setAutosaveStatus('saving');
      void (async () => {
        try {
          await onPersist(snapshot, persistOptions);
          autosaveLastSavedRef.current = snapshot;
          lastSavedAppearanceRef.current = {
            theme: snapshot.theme ?? 'system',
            accentColor: resolveAccentColor(snapshot.accentColor),
          };
          // If a newer edit landed while the request was in flight,
          // leave the status as 'pending' so the next debounce tick
          // owns the indicator instead of flashing "Saved".
          if (autosaveLatestRef.current !== snapshot) {
            setAutosaveStatus('pending');
            return;
          }
          if (persistOptions.forceMediaProviderSync) {
            lastSyncedMediaProvidersVersionRef.current = mediaProvidersVersion;
            setPendingMediaProviderEditIds(new Set());
          }
          setAutosaveStatus('saved');
          autosaveSavedTimerRef.current = window.setTimeout(() => {
            autosaveSavedTimerRef.current = null;
            // Settle to idle after a moment so the indicator doesn't
            // stay on "Saved" forever and become noise.
            setAutosaveStatus((curr) => (curr === 'saved' ? 'idle' : curr));
          }, 1800);
        } catch {
          if (
            persistOptions.forceMediaProviderSync
            && autosaveLatestRef.current === snapshot
            && mediaProvidersChangeVersionRef.current === mediaProvidersVersion
            && lastSyncedMediaProvidersVersionRef.current < mediaProvidersVersion
          ) {
            setAutosaveStatus('pending');
            autosaveRetryTimerRef.current = window.setTimeout(() => {
              autosaveRetryTimerRef.current = null;
              if (
                autosaveLatestRef.current !== snapshot
                || mediaProvidersChangeVersionRef.current !== mediaProvidersVersion
                || lastSyncedMediaProvidersVersionRef.current >= mediaProvidersVersion
              ) {
                return;
              }
              setAutosaveRetryTick((tick) => tick + 1);
            }, 1500);
            return;
          }
          setAutosaveStatus('error');
        }
      })();
    }, 400);
    return () => {
      if (autosaveTimerRef.current != null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [cfg, onPersist, autosaveRetryTick]);
  // Flush any pending autosave on unmount so a fast-closing dialog
  // never strands an in-flight edit. We also clear the "Saved" toast
  // timer to avoid setState after unmount.
  useEffect(() => {
    return () => {
      if (autosavePendingFlushRef.current) {
        const mediaProvidersVersion = mediaProvidersChangeVersionRef.current;
        // Best-effort flush; if it rejects, localStorage already has
        // the latest copy from the synchronous saveConfig call inside
        // onPersist.
        autosavePendingFlushRef.current = false;
        void Promise.resolve(onPersist(autosaveLatestRef.current, {
          forceMediaProviderSync: mediaProvidersVersion > lastSyncedMediaProvidersVersionRef.current,
        })).catch(() => undefined);
      }
      if (autosaveSavedTimerRef.current != null) {
        window.clearTimeout(autosaveSavedTimerRef.current);
        autosaveSavedTimerRef.current = null;
      }
      if (autosaveRetryTimerRef.current != null) {
        window.clearTimeout(autosaveRetryTimerRef.current);
        autosaveRetryTimerRef.current = null;
      }
    };
  }, [onPersist]);

  // Global Escape closes the dialog. With no footer button anymore the
  // close affordances are: top-right X · backdrop click · Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const protocolProviders = useMemo(
    () => KNOWN_PROVIDERS.filter((p) => p.protocol === apiProtocol),
    [apiProtocol],
  );
  const showQuickFillProvider =
    protocolProviders.length > 1;
  const selectedProviderIndex =
    cfg.apiProviderBaseUrl == null
      ? -1
      : protocolProviders.findIndex(
          (p) => p.baseUrl === cfg.apiProviderBaseUrl && p.baseUrl === cfg.baseUrl,
        );
  const selectedProvider = selectedProviderIndex >= 0 ? protocolProviders[selectedProviderIndex] : undefined;
  const byokRequiresApiKey = byokProviderRequiresApiKey(
    apiProtocol,
    selectedProvider,
    cfg.baseUrl,
  );
  const providerModelsKey = useMemo(
    () => providerModelsCacheKey(
      apiProtocol,
      cfg.baseUrl,
      cfg.apiKey,
      cfg.apiVersion ?? '',
    ),
    [apiProtocol, cfg.baseUrl, cfg.apiKey, cfg.apiVersion],
  );
  const fetchedApiModelOptions = providerModelsCache[providerModelsKey] ?? [];
  const commitProviderModelsInputs = () => {
    if (missingByokModelFetchFields(cfg).length > 0 || !baseUrlValid) {
      setProviderModelsCommittedKey(null);
      return;
    }
    setProviderModelsCommittedKey(providerModelsKey);
  };
  useEffect(() => {
    if (cfg.mode !== 'api') return;
    if (apiProtocol === 'azure' || apiProtocol === 'ollama') return;
    if (missingByokModelFetchFields(cfg).length > 0) return;
    if (!baseUrlValid) return;
    if (providerModelsCommittedKey !== providerModelsKey) return;
    const timer = window.setTimeout(() => {
      void handleFetchProviderModels({ silent: true });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    apiProtocol,
    baseUrlValid,
    cfg.apiKey,
    cfg.baseUrl,
    cfg.mode,
    cfg.apiVersion,
    providerModelsCommittedKey,
    providerModelsKey,
  ]);
  const currentProviderModelsResult =
    providerModelsState.status === 'done' &&
    providerModelsState.cacheKey === providerModelsKey
      ? providerModelsState.result
      : null;
  const loadedAccountModelCount =
    currentProviderModelsResult?.ok && currentProviderModelsResult.models?.length
      ? currentProviderModelsResult.models.length
      : 0;
  const apiKeyAuthFailed =
    currentProviderModelsResult?.ok === false &&
    currentProviderModelsResult.kind === 'auth_failed';
  const providerModelsFailureMessage =
    currentProviderModelsResult?.ok === false && !apiKeyAuthFailed
      ? t('settings.fetchModelsFailed', {
          detail:
            currentProviderModelsResult.detail ||
            currentProviderModelsResult.kind,
        })
      : null;
  const suggestedApiModelIds = useMemo(
    () => Array.from(new Set(
      selectedProvider?.models?.length
        ? selectedProvider.models
        : SUGGESTED_MODELS_BY_PROTOCOL[apiProtocol],
    )),
    [apiProtocol, selectedProvider],
  );
  const apiModelOptions = useMemo(
    () => mergeProviderModelOptions(
      fetchedApiModelOptions,
      suggestedApiModelIds,
    ),
    [fetchedApiModelOptions, suggestedApiModelIds],
  );
  const apiModelIds = useMemo(
    () => apiModelOptions.map((m) => m.id),
    [apiModelOptions],
  );
  const apiModelCustomActive =
    shouldShowCustomModelInput(
      cfg.model,
      apiModelIds,
      apiModelCustomEditing,
    );
  const apiModelSelectValue = apiModelCustomActive
    ? CUSTOM_MODEL_SENTINEL
    : cfg.model;
  const baseUrlReadOnly =
    (apiProtocol === 'anthropic' || apiProtocol === 'google') &&
    cfg.apiProviderBaseUrl !== null &&
    Boolean(cfg.baseUrl.trim()) &&
    !baseUrlInvalid;
  const baseUrlPlaceholder =
    apiProtocol === 'azure'
      ? t('settings.azureBaseUrlPlaceholder')
      : apiProtocol === 'ollama'
        ? 'http://localhost:11434'
        : undefined;
  const renderByokBaseUrlField = () => (
    <label className={'field' + (baseUrlReadOnly ? ' settings-base-url-readonly' : '')}>
      <span className="field-label">
        {t('settings.baseUrl')}
        <span className="field-required" aria-label={t('settings.required')}>
          *
        </span>
      </span>
      <div className="field-row">
        <input
          ref={baseUrlInputRef}
          aria-label={t('settings.baseUrl')}
          type="url"
          inputMode="url"
          value={cfg.baseUrl}
          placeholder={baseUrlPlaceholder}
          readOnly={baseUrlReadOnly || undefined}
          aria-invalid={baseUrlInvalid || undefined}
          aria-describedby={
            baseUrlInvalid ? 'settings-base-url-error' : undefined
          }
          onFocus={() => {
            const byokProviderId = byokProtocolToTracking(apiProtocol);
            if (byokProviderId) {
              trackSettingsByokFieldClick(analytics.track, {
                page_name: 'settings',
                area: 'configure_execution_mode_byok',
                element: 'base_url',
                provider_id: byokProviderId,
                has_value: Boolean(cfg.baseUrl?.trim()),
              });
            }
          }}
          onBlur={commitProviderModelsInputs}
          onChange={(e) => updateApiConfig({ baseUrl: e.target.value, apiProviderBaseUrl: null })}
        />
        {baseUrlReadOnly ? (
          <button
            type="button"
            className="ghost icon-btn settings-base-url-customize"
            onClick={() => {
              updateApiConfig({ apiProviderBaseUrl: null });
              window.setTimeout(() => baseUrlInputRef.current?.focus(), 0);
            }}
          >
            {t('settings.baseUrlCustomize')}
          </button>
        ) : null}
      </div>
      {baseUrlInvalid ? (
        <span
          id="settings-base-url-error"
          className="settings-field-error"
          role="alert"
        >
          {t('settings.baseUrlInvalid')}
        </span>
      ) : null}
      {baseUrlReadOnly ? (
        <span className="field-inline-status">
          {t('settings.baseUrlDefaultHint')}
        </span>
      ) : null}
      {apiProtocol === 'azure' ? (
        <span className="field-inline-status">
          {t('settings.azureBaseUrlHint')}
        </span>
      ) : null}
    </label>
  );
  useEffect(() => {
    if (!focusByokRequiredFieldAfterProtocolSwitchRef.current) return;
    focusByokRequiredFieldAfterProtocolSwitchRef.current = false;
    focusByokRequiredField(
      missingByokConnectionFields(cfg, {
        requiresApiKey: byokRequiresApiKey,
      })[0],
    );
  }, [apiModelCustomActive, cfg, apiProtocol, byokRequiresApiKey]);

  // Header title/subtitle follow the active sidebar section so the dialog
  // header always reflects what the user is looking at, instead of being
  // pinned to one section's copy. The execution section's header doubles
  // as the section heading — there is no inner h3 inside the Local CLI /
  // BYOK content so "Local CLI" only renders once (in the seg-control tab),
  // not twice (heading + tab).
  const sectionHeader: Record<SettingsSection, { title: string; subtitle: string }> = {
    execution: { title: t('settings.title'), subtitle: t('settings.subtitle') },
    instructions: {
      title: 'Instructions / Rules',
      subtitle: 'Fixed behavior the assistant should follow',
    },
    media: { title: t('settings.mediaProviders'), subtitle: t('settings.mediaProvidersHint') },
    composio: { title: t('connectors.title'), subtitle: t('connectors.subtitle') },
    orbit: { title: t('settings.orbit.title'), subtitle: t('settings.orbit.lede') },
    routines: {
      title: t('routines.title'),
      subtitle: t('routines.subtitle'),
    },
    integrations: { title: t('settings.mcpServerTitle'), subtitle: t('settings.mcpServerHint') },
    mcpClient: { title: t('settings.externalMcpTitle'), subtitle: t('settings.externalMcpHint') },
    language: { title: t('settings.language'), subtitle: t('settings.languageHint') },
    appearance: { title: t('settings.appearance'), subtitle: t('settings.appearanceHint') },
    critiqueTheater: {
      title: t('critiqueTheater.settingsNav'),
      subtitle: t('critiqueTheater.settingsNavHint'),
    },
    notifications: { title: t('settings.notifications'), subtitle: t('settings.notificationsHint') },
    privacy: { title: t('settings.privacy'), subtitle: t('settings.privacyHint') },
    pet: { title: t('pet.title'), subtitle: t('pet.subtitle') },
    skills: { title: t('settings.skills'), subtitle: t('settings.skillsHint') },
    designSystems: {
      title: t('settings.designSystems'),
      subtitle: t('settings.designSystemsHint'),
    },
    memory: { title: t('settings.memory'), subtitle: t('settings.memoryHint') },
    logAnalysis: { title: '日志分析', subtitle: '查看与分析会话日志' },
    // 'library' is opened via EntryShell route — SettingsDialog doesn't
    // render it but SettingsSection must accept the token (see type def).
    library: { title: '', subtitle: '' },
    about: { title: t('settings.about'), subtitle: t('settings.aboutHint') },
  };
  const activeHeader = sectionHeader[activeSection];
  const installedAgents = agents.filter((a) => a.available);
  const unavailableAgents = agents.filter((a) => !a.available);

  // Embedded mode renders ONLY the section content pane (no dialog chrome),
  // so SettingsDialogV2 can host it inside its own `.sv2` shell. The content
  // pane itself is identical in both modes — it lives inline in the standard
  // return below; here we just early-return a bare version that reuses the
  // same `settingsContentRef` and section switch. We render the SAME JSX by
  // toggling chrome via the `embedded` flag inside the standard tree instead
  // of duplicating 1200 lines: see the conditional wrappers below.
  return (
    <div
      className={embedded ? 'settings-embedded-root' : 'modal-backdrop'}
      onClick={embedded ? undefined : onClose}
    >
      <div
        className={embedded ? 'settings-embedded-shell' : 'modal modal-settings'}
        role={embedded ? undefined : 'dialog'}
        aria-modal={embedded ? undefined : 'true'}
        aria-labelledby={embedded ? undefined : 'settings-dialog-title'}
        onClick={embedded ? undefined : (e) => e.stopPropagation()}
      >
        {/* Top-left back affordance — now that settings is a full-screen
            page (not a centered modal over a scrim), the primary "I'm
            done" gesture is a back button, mirroring the reference's
            「← 返回应用」. It calls the same `onClose` as the ✕ / Esc, so
            the close path (persist + tear down the desktop overlay view)
            is unchanged. The corner ✕ stays as a secondary affordance. */}
        {!embedded && (
          <button
            type="button"
            className="settings-back"
            onClick={onClose}
            aria-label={t('settings.backToApp')}
          >
            <Icon name="arrow-left" size={16} />
            <span>{t('settings.backToApp')}</span>
          </button>
        )}
        {/* Top-right chrome strip — anchored to the modal corner so the
            autosave indicator and the close button float above the
            sidebar/content rhythm without competing with the title.
            We use `position: absolute` instead of putting these inside
            `.modal-head` so the welcome variant's tall hero (kicker /
            title / subtitle / pet teaser) keeps its centred reading
            measure, and the close button always lands at the same
            optical location regardless of how much copy the header
            renders. */}
        {!embedded && (
        <>
        <div className="settings-chrome" aria-hidden={false}>
          {/* Autosave status pill. Only renders something while a save
              is in flight or has just completed — idle = invisible so
              first-open feels calm. The chrome strip itself stays
              mounted so the close button never shifts when the pill
              appears, and the pill is announced via aria-live for
              assistive tech. */}
          <div
            className={`settings-autosave is-${autosaveStatus}`}
            role="status"
            aria-live="polite"
          >
            {autosaveStatus === 'saving' || autosaveStatus === 'pending' ? (
              <>
                <Icon name="spinner" size={12} className="icon-spin" />
                <span>{t('settings.autosaveSaving')}</span>
              </>
            ) : autosaveStatus === 'saved' ? (
              <>
                <Icon name="check" size={12} />
                <span>{t('settings.autosaveSaved')}</span>
              </>
            ) : autosaveStatus === 'error' ? (
              <>
                <Icon name="close" size={12} />
                <span>{t('settings.autosaveError')}</span>
              </>
            ) : null}
          </div>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            {/* `✕` glyph (not an SVG icon) to match apps/desktop's shared
                DialogShell close button, so the close affordance reads the
                same across desktop dialogs and the web settings modal. */}
            ✕
          </button>
        </div>
        <header className="modal-head" id="settings-dialog-title">
          {welcome ? (
            <>
              <span className="kicker">{t('settings.welcomeKicker')}</span>
              <h2>{t('settings.welcomeTitle')}</h2>
              <p className="subtitle">{t('settings.welcomeSubtitle')}</p>
            </>
          ) : (
            <>
              <span className="kicker">{t('settings.kicker')}</span>
              <div className="modal-head-line">
                <h2>{activeHeader.title}</h2>
                <p className="subtitle">{activeHeader.subtitle}</p>
              </div>
            </>
          )}
        </header>
        </>
        )}

        <div className="modal-body">
          {!embedded && (
          <aside className="settings-sidebar" aria-label="Settings sections">
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'execution' ? ' active' : ''}`}
              onClick={() => setActiveSection('execution')}
            >
              <Icon name="sliders" size={18} />
              <span>
                <strong>{t('settings.envConfigure')}</strong>
                <small>{`${t('settings.localCli')} / ${t('settings.modeApiMeta')}`}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'instructions' ? ' active' : ''}`}
              onClick={() => setActiveSection('instructions')}
            >
              <Icon name="edit" size={18} />
              <span>
                <strong>Instructions / Rules</strong>
                <small>Fixed assistant behavior</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'memory' ? ' active' : ''}`}
              onClick={() => setActiveSection('memory')}
            >
              <Icon name="history" size={18} />
              <span>
                <strong>{t('settings.memory')}</strong>
                <small>{t('settings.memoryHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'media' ? ' active' : ''}`}
              onClick={() => setActiveSection('media')}
            >
              <Icon name="image" size={18} />
              <span>
                <strong>{t('settings.mediaProviders')}</strong>
                <small>Image / video / audio</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'skills' ? ' active' : ''}`}
              onClick={() => setActiveSection('skills')}
            >
              <Icon name="grid" size={18} />
              <span>
                <strong>{t('settings.skills')}</strong>
                <small>{t('settings.skillsHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'mcpClient' ? ' active' : ''}`}
              onClick={() => setActiveSection('mcpClient')}
            >
              <Icon name="sparkles" size={18} />
              <span>
                <strong>{t('settings.externalMcpTitle')}</strong>
                <small>{t('settings.externalMcpHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'composio' ? ' active' : ''}`}
              onClick={() => setActiveSection('composio')}
            >
              <Icon name="sliders" size={18} />
              <span>
                <strong>{t('connectors.title')}</strong>
                <small>{t('settings.connectorsNavHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'integrations' ? ' active' : ''}`}
              onClick={() => setActiveSection('integrations')}
            >
              <Icon name="link" size={18} />
              <span>
                <strong>{t('settings.mcpServerTitle')}</strong>
                <small>{t('settings.mcpServerHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'language' ? ' active' : ''}`}
              onClick={() => setActiveSection('language')}
            >
              <Icon name="languages" size={18} />
              <span>
                <strong>{t('settings.language')}</strong>
                <small>{t('settings.languageHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'appearance' ? ' active' : ''}`}
              onClick={() => setActiveSection('appearance')}
            >
              <Icon name="sun-moon" size={18} />
              <span>
                <strong>{t('settings.appearance')}</strong>
                <small>{t('settings.appearanceHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'critiqueTheater' ? ' active' : ''}`}
              onClick={() => setActiveSection('critiqueTheater')}
            >
              <Icon name="comment" size={18} />
              <span>
                <strong>{t('critiqueTheater.settingsNav')}</strong>
                <small>{t('critiqueTheater.settingsNavHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'notifications' ? ' active' : ''}`}
              onClick={() => setActiveSection('notifications')}
            >
              <Icon name="bell" size={18} />
              <span>
                <strong>{t('settings.notifications')}</strong>
                <small>{t('settings.notificationsHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'pet' ? ' active' : ''}`}
              onClick={() => setActiveSection('pet')}
            >
              <Icon name="sparkles" size={18} />
              <span>
                <strong>{t('pet.navTitle')}</strong>
                <small>{t('pet.navHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'designSystems' ? ' active' : ''}`}
              onClick={() => setActiveSection('designSystems')}
            >
              <Icon name="draw" size={18} />
              <span>
                <strong>{t('settings.designSystems')}</strong>
                <small>{t('settings.designSystemsHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'privacy' ? ' active' : ''}`}
              onClick={() => setActiveSection('privacy')}
            >
              <Icon name="eye" size={18} />
              <span>
                <strong>{t('settings.privacy')}</strong>
                <small>{t('settings.privacyHint')}</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'logAnalysis' ? ' active' : ''}`}
              onClick={() => setActiveSection('logAnalysis')}
            >
              <Icon name="history" size={18} />
              <span>
                <strong>日志分析</strong>
                <small>查看与分析会话日志</small>
              </span>
            </button>
            <button
              type="button"
              className={`settings-nav-item${activeSection === 'about' ? ' active' : ''}`}
              onClick={() => setActiveSection('about')}
            >
              <Icon name="settings" size={18} />
              <span>
                <strong>{t('settings.about')}</strong>
                <small>{t('settings.aboutHint')}</small>
              </span>
            </button>
          </aside>
          )}
          <div className="settings-content" ref={settingsContentRef}>
          {activeSection === 'execution' ? (
            <>
              <div
                className="seg-control"
                role="tablist"
                aria-label={t('settings.modeAria')}
                style={{ ['--seg-cols' as string]: 2 } as CSSProperties}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={cfg.mode === 'daemon'}
                  className={
                    'seg-btn seg-btn--inline' +
                    (cfg.mode === 'daemon' ? ' active' : '')
                  }
                  disabled={!daemonLive}
                  onClick={() => setMode('daemon')}
                  title={
                    daemonLive
                      ? t('settings.modeDaemonHelp')
                      : t('settings.modeDaemonOffline')
                  }
                >
                  <span className="seg-title">{t('settings.localCli')}</span>
                  <span className="seg-meta">
                    {daemonLive
                      ? t('settings.modeDaemonInstalledMeta', { count: installedCount })
                      : t('settings.modeDaemonOfflineMeta')}
                  </span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={cfg.mode === 'api'}
                  className={
                    'seg-btn seg-btn--inline' +
                    (cfg.mode === 'api' ? ' active' : '')
                  }
                  onClick={() => setMode('api')}
                >
                  <span className="seg-title">{t('settings.modeApiMeta')}</span>
                  <span className="seg-meta">{t('settings.modeApi')}</span>
                </button>
              </div>
              {cfg.mode === 'api' ? (
                <div
                  className="protocol-chips"
                  role="tablist"
                  aria-label={t('settings.protocolAria')}
                >
                  {API_PROTOCOL_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={apiProtocol === tab.id}
                      className={'protocol-chip' + (apiProtocol === tab.id ? ' active' : '')}
                      onClick={() => {
                        const byokProviderId = byokProtocolToTracking(tab.id);
                        if (byokProviderId) {
                          trackSettingsByokProviderOptionClick(analytics.track, {
                            page_name: 'settings',
                            area: 'configure_execution_mode_byok',
                            element: 'byok_provider_option',
                            action: 'select_byok_provider',
                            provider_id: byokProviderId,
                            is_selected: apiProtocol === tab.id,
                          });
                        }
                        setApiProtocol(tab.id);
                      }}
                    >
                      {tab.title}
                    </button>
                  ))}
                </div>
              ) : null}
          {cfg.mode === 'daemon' ? (
            <section className="settings-section">
              <div className="section-head">
                <div>
                  <p className="hint">{t('settings.codeAgentHint')}</p>
                </div>
              </div>
              {agents.length === 0 ? (
                <div className="empty-card">
                  {t('settings.noAgentsDetected')}
                </div>
              ) : (
                <>
                  <div className="agent-group">
                    <div className="agent-group-head">
                      <h4>
                        {t('settings.agentInstalledGroup', {
                          count: installedAgents.length,
                        })}
                      </h4>
                      <div className="agent-group-head-actions">
                        {agentRescanNotice ? (
                          <span
                            className={
                              'settings-rescan-status settings-rescan-status-inline ' +
                              agentRescanNotice.kind
                            }
                            role={
                              agentRescanNotice.kind === 'error'
                                ? 'alert'
                                : 'status'
                            }
                          >
                            {agentRescanNotice.kind === 'success'
                              ? t('settings.rescanSuccess', {
                                  count: agentRescanNotice.count,
                                })
                              : t('settings.rescanFailed')}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className={
                            'ghost icon-btn settings-rescan-btn agent-group-rescan-btn' +
                            (agentRescanRunning ? ' loading' : '')
                          }
                          onClick={() => void handleRefreshAgents()}
                          disabled={agentRescanRunning}
                          title={t('settings.rescanTitle')}
                        >
                          {agentRescanRunning ? (
                            <>
                              <Icon
                                name="spinner"
                                size={13}
                                className="icon-spin"
                              />
                              <span>{t('settings.rescanRunning')}</span>
                            </>
                          ) : (
                            t('settings.rescan')
                          )}
                        </button>
                      </div>
                    </div>
                    {installedAgents.length > 0 ? (
                      <div className="agent-grid agent-grid-installed">
                        {installedAgents.flatMap((a) => {
                          const active = cfg.agentId === a.id;
                          const running =
                            active && agentTestState.status === 'running';
                          const description = AGENT_SHORT_DESCRIPTIONS[a.id];
                          const versionLabel = cleanAgentVersionLabel(
                            a.name,
                            a.version,
                          );
                          const cardEl = (
                            <div
                              key={a.id}
                              className={
                                'agent-card agent-card-installed' +
                                (active ? ' active' : '')
                              }
                            >
                              <button
                                type="button"
                                className="agent-card-select"
                                onClick={() => {
                                  trackSettingsLocalCliClick(analytics.track, {
                                    page_name: 'settings',
                                    area: 'configure_execution_mode_local_cli',
                                    element: 'cli_provider',
                                    cli_provider_id: agentIdToTracking(a.id),
                                    install_status: 'installed',
                                  });
                                  setCfg((c) => ({ ...c, agentId: a.id }));
                                }}
                                aria-pressed={active}
                              >
                                <AgentIcon id={a.id} size={32} />
                                <div className="agent-card-body">
                                  <div className="agent-card-name">
                                    <span>{a.name}</span>
                                    {description ? (
                                      <>
                                        <span
                                          className="agent-card-name-divider"
                                          aria-hidden="true"
                                        >
                                          ·
                                        </span>
                                        <span className="agent-card-tagline">
                                          {description}
                                        </span>
                                      </>
                                    ) : null}
                                  </div>
                                  <div className="agent-card-meta">
                                    {a.authStatus === 'missing' ? (
                                      <span title={a.authMessage ?? a.path ?? ''}>
                                        {t('settings.agentAuthRequired')}
                                      </span>
                                    ) : a.authStatus === 'unknown' ? (
                                      <span title={a.authMessage ?? a.path ?? ''}>
                                        {t('settings.agentAuthUnknown')}
                                      </span>
                                    ) : versionLabel ? (
                                      <span title={a.path ?? ''}>
                                        {versionLabel}
                                      </span>
                                    ) : (
                                      <span title={a.path ?? ''}>
                                        {t('common.installed')}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </button>
                              {active ? (
                                <button
                                  type="button"
                                  className={
                                    'ghost icon-btn settings-test-btn agent-card-test-btn' +
                                    (running ? ' loading' : '')
                                  }
                                  onClick={() => void handleTestAgent()}
                                  disabled={running}
                                  title={t('settings.testTitle')}
                                >
                                  {running ? (
                                    <>
                                      <Icon
                                        name="spinner"
                                        size={13}
                                        className="icon-spin"
                                      />
                                      <span>{t('settings.test')}</span>
                                    </>
                                  ) : (
                                    t('settings.test')
                                  )}
                                </button>
                              ) : null}
                            </div>
                          );
                          if (active && agentTestState.status !== 'idle') {
                            const resultRow = (
                              <div
                                key={`${a.id}__test-result`}
                                className="agent-test-result-row"
                              >
                                {agentTestState.status === 'running' ? (
                                  <p
                                    className="settings-test-status running"
                                    role="status"
                                    aria-live="polite"
                                  >
                                    {t('settings.testRunning')}
                                  </p>
                                ) : (
                                  <>
                                    <p
                                      className={
                                        'settings-test-status ' +
                                        testStatusVariant(agentTestState.result)
                                      }
                                      role={
                                        agentTestState.result.ok
                                          ? 'status'
                                          : 'alert'
                                      }
                                    >
                                      {renderTestMessage(
                                        agentTestState.result,
                                        'cli',
                                      )}
                                    </p>
                                    {!agentTestState.result.ok ? (
                                      <div className="settings-test-actions">
                                        <div className="settings-test-actions-row">
                                          <button
                                            type="button"
                                            className="ghost icon-btn settings-test-btn"
                                            onClick={() => void handleTestAgent()}
                                          >
                                            <Icon name="reload" size={13} />
                                            <span>{t('settings.testRetry')}</span>
                                          </button>
                                        </div>
                                      </div>
                                    ) : null}
                                    {cfg.agentId === 'codex' && (() => {
                                      const repair = codexPathRepairState(
                                        agentTestState.result,
                                      );
                                      if (!repair) return null;
                                      const codexStrings = codexPathStrings(locale);
                                      return (
                                        <div className="settings-test-actions">
                                          <span className="settings-test-actions-hint">
                                            {codexStrings.repairHint}
                                          </span>
                                          <div className="settings-test-actions-row">
                                            {repair.canUseDetected ? (
                                              <button
                                                type="button"
                                                className="settings-test-btn"
                                                onClick={() =>
                                                  applyCodexDetectedPath(
                                                    repair.detectedPath,
                                                  )
                                                }
                                              >
                                                {codexStrings.useDetected}
                                              </button>
                                            ) : null}
                                            <button
                                              type="button"
                                              className="ghost icon-btn settings-rescan-btn"
                                              onClick={clearCodexCustomPath}
                                            >
                                              {codexStrings.clearCustom}
                                            </button>
                                          </div>
                                        </div>
                                      );
                                    })()}
                                  </>
                                )}
                              </div>
                            );
                            return [cardEl, resultRow];
                          }
                          return [cardEl];
                        })}
                      </div>
                    ) : (
                      <div className="empty-card">
                        {t('settings.noAgentsDetected')}
                      </div>
                    )}
                  </div>
              {(() => {
                const selected = agents.find(
                  (a) => a.id === cfg.agentId && a.available,
                );
                if (!selected) return null;
                const hasModels =
                  Array.isArray(selected.models) && selected.models.length > 0;
                const hasReasoning =
                  Array.isArray(selected.reasoningOptions) &&
                  selected.reasoningOptions.length > 0;
                if (!hasModels && !hasReasoning) return null;
                const choice = cfg.agentModels?.[selected.id] ?? {};
                const setChoice = (
                  next: { model?: string; reasoning?: string },
                ) => {
                  setCfg((c) => {
                    const prev = c.agentModels?.[selected.id] ?? {};
                    return {
                      ...c,
                      agentModels: {
                        ...(c.agentModels ?? {}),
                        [selected.id]: { ...prev, ...next },
                      },
                    };
                  });
                };
                const modelValue =
                  choice.model ?? selected.models?.[0]?.id ?? '';
                const reasoningValue =
                  choice.reasoning ??
                  selected.reasoningOptions?.[0]?.id ?? '';
                const customActive =
                  hasModels &&
                  shouldShowCustomModelInput(
                    modelValue,
                    selected.models!.map((m) => m.id),
                    agentCustomModelIds.has(selected.id),
                  );
                const selectValue = customActive
                  ? CUSTOM_MODEL_SENTINEL
                  : modelValue;
                const modelSource = selected.modelsSource ?? 'fallback';
                const modelSourceLabel =
                  modelSource === 'live'
                    ? t('settings.modelSourceLive')
                    : t('settings.modelSourceFallback');
                const modelSourceHint =
                  modelSource === 'live'
                    ? t('settings.modelPickerLiveHint')
                    : t('settings.modelPickerFallbackHint');
                return (
                  <div className="agent-model-row">
                    <div className="agent-model-row-head">
                      {t('settings.agentModelHead')} <strong>{selected.name}</strong>
                    </div>
                    {hasModels ? (
                      <>
                        <label className="field">
                          <span className="field-label">
                            {t('settings.modelPicker')}
                            <span
                              className={`agent-model-source-badge ${modelSource}`}
                            >
                              {modelSourceLabel}
                            </span>
                          </span>
                          <div className="agent-model-select-wrap">
                            <select
                              value={selectValue}
                              onChange={(e) => {
                                if (e.target.value === CUSTOM_MODEL_SENTINEL) {
                                  setAgentCustomModelIds((prev) => {
                                    const next = new Set(prev);
                                    next.add(selected.id);
                                    return next;
                                  });
                                  setChoice({ model: '' });
                                } else {
                                  setAgentCustomModelIds((prev) => {
                                    if (!prev.has(selected.id)) return prev;
                                    const next = new Set(prev);
                                    next.delete(selected.id);
                                    return next;
                                  });
                                  setChoice({ model: e.target.value });
                                }
                              }}
                            >
                              {renderModelOptions(selected.models!)}
                              <option value={CUSTOM_MODEL_SENTINEL}>
                                {t('settings.modelCustom')}
                              </option>
                            </select>
                            <Icon
                              name="chevron-down"
                              size={12}
                              className="agent-model-select-chevron"
                            />
                          </div>
                        </label>
                        <p className="hint agent-model-row-hint">
                          {modelSourceHint}
                        </p>
                      </>
                    ) : null}
                    {customActive ? (
                      <label className="field">
                        <span className="field-label">
                          {t('settings.modelCustomLabel')}
                        </span>
                        <input
                          type="text"
                          value={modelValue}
                          placeholder={t('settings.modelCustomPlaceholder')}
                          onChange={(e) =>
                            setChoice({ model: e.target.value.trim() })
                          }
                        />
                      </label>
                    ) : null}
                    {hasReasoning ? (
                      <label className="field">
                        <span className="field-label">
                          {t('settings.reasoningPicker')}
                        </span>
                        <div className="agent-model-select-wrap">
                          <select
                            value={reasoningValue}
                            onChange={(e) =>
                              setChoice({ reasoning: e.target.value })
                            }
                          >
                            {selected.reasoningOptions!.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.label}
                              </option>
                            ))}
                          </select>
                          <Icon
                            name="chevron-down"
                            size={12}
                            className="agent-model-select-chevron"
                          />
                        </div>
                      </label>
                    ) : null}
                  </div>
                );
              })()}
                  {unavailableAgents.length > 0 ? (
                    <details
                      className="agent-install-collapse"
                      open={installedAgents.length > 0 ? undefined : true}
                    >
                      <summary className="agent-install-collapse-summary">
                        <span>
                          {t('settings.agentInstallGroup', {
                            count: unavailableAgents.length,
                          })}
                        </span>
                      </summary>
                      <div className="agent-grid agent-grid-unavailable">
                        {unavailableAgents.map((a) => {
                          const installUrl = sanitizeHttpsUrl(a.installUrl);
                          const docsUrl = sanitizeHttpsUrl(a.docsUrl);
                          const hasLinks = Boolean(installUrl || docsUrl);
                          const description = AGENT_SHORT_DESCRIPTIONS[a.id];
                          const cardLabel = `${a.name} · ${t('common.notInstalled')}`;
                          return (
                            <div
                              key={a.id}
                              className="agent-card disabled agent-card-unavailable"
                              role="group"
                              aria-label={cardLabel}
                            >
                              <AgentIcon id={a.id} size={40} />
                              <div className="agent-card-body">
                                <div className="agent-card-name">{a.name}</div>
                                {description ? (
                                  <div className="agent-card-description">
                                    {description}
                                  </div>
                                ) : null}
                              </div>
                              {hasLinks ? (
                                <div className="agent-card-actions agent-card-actions--inline">
                                  {docsUrl ? (
                                    <a
                                      href={docsUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="agent-card-link agent-card-link--muted"
                                      onClick={markAgentInstallIntent}
                                    >
                                      {t('settings.agentInstall.docs')}
                                    </a>
                                  ) : null}
                                  {installUrl ? (
                                    <a
                                      href={installUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="agent-card-link agent-card-link--ghost"
                                      onClick={markAgentInstallIntent}
                                    >
                                      {t('settings.agentInstall.install')}
                                    </a>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  ) : null}
                  {/*
                    Show the install guide only when the user has *no*
                    working agent picked yet. Older logic surfaced it
                    whenever any agent on the support list was missing,
                    which fired for almost everyone (few people install
                    all 14 supported CLIs) — the four-step quickstart
                    then sat between the agent grid and the model picker
                    forever, even after the user had successfully picked
                    Claude Code months ago. Once a working agent is
                    selected, the guide has done its job and only adds
                    noise.
                  */}
                  {!agents.find(
                    (a) => a.id === cfg.agentId && a.available,
                  ) ? (
                    <div className="agent-install-guide">
                      <p className="hint agent-install-path-hint">
                        {t('settings.agentInstall.pathHint')}
                      </p>
                      <ol className="agent-install-steps">
                        <li>{t('settings.agentInstall.stepOpenLinks')}</li>
                        <li>{t('settings.agentInstall.stepAuth')}</li>
                        <li>{t('settings.agentInstall.stepRescan')}</li>
                        <li>{t('settings.agentInstall.stepSelect')}</li>
                      </ol>
                    </div>
                  ) : null}
                </>
              )}
              {(() => {
                const selected = agents.find(
                  (a) => a.id === cfg.agentId && a.available,
                );
                if (!selected) return null;
                const hasModels =
                  Array.isArray(selected.models) && selected.models.length > 0;
                const choice = cfg.agentModels?.[selected.id] ?? {};
                const modelValue =
                  choice.model ?? selected.models?.[0]?.id ?? '';
                return (
                  <details className="agent-cli-env settings-memory-advanced">
                    <summary className="agent-cli-env-summary">
                      <span className="agent-cli-env-summary-title">
                        {t('settings.memoryModelInlineLabel')}
                      </span>
                    </summary>
                    <div className="agent-cli-env-body">
                      <MemoryModelInline
                        mode="daemon"
                        apiProtocol={apiProtocol}
                        chatApiKey={cfg.apiKey}
                        chatBaseUrl={cfg.baseUrl}
                        chatApiVersion={cfg.apiVersion ?? ''}
                        chatModel={modelValue}
                        cliAgentId={selected.id}
                        cliModelOptions={
                          hasModels ? selected.models!.map((m) => m.id) : []
                        }
                      />
                    </div>
                  </details>
                );
              })()}
              {(() => {
                /*
                  Per-agent CLI environment overrides — proxy URLs, custom
                  config dirs, and a binary path override. The previous
                  layout listed every supported agent's variables in one
                  long always-expanded block; for users on Claude Code
                  the Codex fields were just visual filler (and vice
                  versa), and the section hijacked Settings real estate
                  on every open even though nine in ten users never
                  touch it. Now: filtered to the *currently selected*
                  agent only, and folded into a collapsed disclosure
                  that opens to "Advanced: proxy & custom paths" — power
                  users who route through LiteLLM or installed the
                  binary out-of-PATH still have one click access; new
                  users no longer wonder "are these fields I forgot to
                  fill in?".
                */
                const cliEnvFields = AGENT_CLI_ENV_FIELDS.filter(
                  (field) => field.agentId === cfg.agentId,
                );
                if (cliEnvFields.length === 0) return null;
                return (
                  <details
                    className="agent-cli-env"
                    data-testid="settings-cli-env"
                  >
                    <summary className="agent-cli-env-summary">
                      <span className="agent-cli-env-summary-title">
                        {t('settings.cliEnvTitle')}
                      </span>
                    </summary>
                    <div className="agent-cli-env-body">
                      <p className="hint">{t('settings.cliEnvHint')}</p>
                      <div className="agent-cli-env-grid">
                        {cliEnvFields.map((field) => (
                          <label
                            className="field"
                            key={`${field.agentId}:${field.envKey}`}
                          >
                            <span className="field-label">
                              {t(field.labelKey)}
                              {'labelSuffix' in field
                                ? ` (${field.labelSuffix})`
                                : ''}
                            </span>
                            <input
                              type={
                                'secret' in field && field.secret
                                  ? 'password'
                                  : 'text'
                              }
                              value={
                                cfg.agentCliEnv?.[field.agentId]?.[
                                  field.envKey
                                ] ?? ''
                              }
                              placeholder={field.placeholder}
                              spellCheck={false}
                              autoComplete="off"
                              onChange={(e) =>
                                setCfg((c) =>
                                  updateAgentCliEnvValue(
                                    c,
                                    field.agentId,
                                    field.envKey,
                                    e.target.value,
                                  ),
                                )
                              }
                            />
                          </label>
                        ))}
                      </div>
                    </div>
                  </details>
                );
              })()}
            </section>
          ) : (
            /*
              BYOK panel — wrap the per-protocol form in a bordered card so
              the chips above (Anthropic / OpenAI / Azure / Gemini / Ollama)
              visually own the content below. Without the card, the chip
              row and the form looked like two unrelated stripes; users
              had no anchor for "this is what I configured for the active
              tab", and switching tabs felt like the whole right column
              just reshuffled. The card lives on the same white-with-soft-
              border pattern as `.agent-model-row` so the two BYOK / CLI
              panels feel like the same family.
            */
            <section className="settings-section settings-section-card settings-section-byok">
              <div className="section-head">
                <div>
                  <h3>{API_PROTOCOL_LABELS[apiProtocol]}</h3>
                </div>
              </div>
              {byokPreconditionNotice ? (
                <p
                  className="settings-test-status error"
                  role="alert"
                  aria-live="polite"
                  data-action={byokPreconditionNotice.action}
                >
                  {byokPreconditionNotice.message}
                </p>
              ) : null}
              {showQuickFillProvider ? (
                <label className="field">
                  <span className="field-label">{t('settings.quickFillProvider')}</span>
                  <select
                    value={selectedProviderIndex >= 0 ? String(selectedProviderIndex) : ''}
                    onChange={(e) => {
                      if (e.target.value === '') {
                        setApiModelCustomEditing(false);
                        updateApiConfig({
                          baseUrl: '',
                          model: '',
                          apiProviderBaseUrl: null,
                        });
                        return;
                      }
                      const idx = Number(e.target.value);
                      if (!isNaN(idx) && protocolProviders[idx]) {
                        const p = protocolProviders[idx]!;
                        setApiModelCustomEditing(false);
                        updateApiConfig({
                          baseUrl: p.baseUrl,
                          model: p.model,
                          apiProviderBaseUrl: p.baseUrl,
                        });
                      }
                    }}
                  >
                    <option value="">{t('settings.customProvider')}</option>
                    {protocolProviders.map((p, i) => (
                      <option key={p.label} value={i}>{p.label}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="field">
                <span className="field-label-row">
                  <span className="field-label">
                    {t('settings.apiKey')}
                    {byokRequiresApiKey ? (
                      <span className="field-required" aria-label={t('settings.required')}>
                        *
                      </span>
                    ) : null}
                  </span>
                  {byokRequiresApiKey ? (
                    <a
                      className="field-label-link"
                      href={apiKeyConsoleLink.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t('settings.apiKeyGetLink', {
                        host: apiKeyConsoleLink.host,
                      })}
                    </a>
                  ) : null}
                </span>
                <div className="field-row">
                  <input
                    ref={apiKeyInputRef}
                    aria-label={t('settings.apiKey')}
                    type={showApiKey ? 'text' : 'password'}
                    placeholder={API_KEY_PLACEHOLDERS[apiProtocol]}
                    value={cfg.apiKey}
                    onChange={(e) => updateApiConfig({ apiKey: e.target.value })}
                    onBlur={() => {
                      commitProviderModelsInputs();
                      handleAutoTestProvider();
                    }}
                    onFocus={() => {
                      const byokProviderId = byokProtocolToTracking(apiProtocol);
                      if (byokProviderId) {
                        trackSettingsByokFieldClick(analytics.track, {
                          page_name: 'settings',
                          area: 'configure_execution_mode_byok',
                          element: 'api_key',
                          provider_id: byokProviderId,
                          has_value: Boolean(cfg.apiKey?.trim()),
                        });
                      }
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="ghost icon-btn"
                    onClick={() => setShowApiKey((v) => !v)}
                    title={
                      showApiKey ? t('settings.hideKey') : t('settings.showKey')
                    }
                  >
                    {showApiKey ? t('settings.hide') : t('settings.show')}
                  </button>
                </div>
                {apiKeyAuthFailed && providerTestState.status === 'idle' ? (
                  <span className="field-error" role="alert">
                    {t('settings.apiKeyInvalid')}
                  </span>
                ) : null}
                {providerTestState.status === 'running' ? (
                  <span
                    className="field-inline-status running"
                    role="status"
                    aria-live="polite"
                  >
                    {t('settings.testRunning')}
                  </span>
                ) : providerTestState.status === 'done' ? (
                  <span
                    className={
                      providerTestState.result.ok
                        ? 'field-inline-status success'
                        : 'field-error'
                    }
                    role={providerTestState.result.ok ? 'status' : 'alert'}
                  >
                    {renderTestMessage(providerTestState.result, 'api')}
                  </span>
                ) : null}
                <span className="field-inline-status">
                  {t('settings.apiHint')}
                </span>
                {canRunProviderConnectionTest(cfg, {
                  requiresApiKey: byokRequiresApiKey,
                }) && baseUrlValid ? (
                  <button
                    type="button"
                    className={
                      'ghost icon-btn settings-test-btn' +
                      (providerTestState.status === 'running' ? ' loading' : '')
                    }
                    onClick={() => void handleTestProvider()}
                    disabled={providerTestState.status === 'running'}
                    title={t('settings.testTitle')}
                  >
                    {providerTestState.status === 'running' ? (
                      <>
                        <Icon
                          name="spinner"
                          size={13}
                          className="icon-spin"
                        />
                        <span>{t('settings.test')}</span>
                      </>
                    ) : providerTestState.status === 'done' &&
                      !providerTestState.result.ok ? (
                      <>
                        <Icon name="reload" size={13} />
                        <span>{t('settings.testRetry')}</span>
                      </>
                    ) : (
                      t('settings.test')
                    )}
                  </button>
                ) : null}
              </label>
              <label className="field">
                <span className="field-label">
                  {apiProtocol === 'azure'
                    ? t('settings.azureDeploymentModel')
                    : t('settings.model')}
                  <span className="field-required" aria-label={t('settings.required')}>
                    *
                  </span>
                </span>
                <select
                  ref={modelSelectRef}
                  aria-label={
                    apiProtocol === 'azure'
                      ? t('settings.azureDeploymentModel')
                      : t('settings.model')
                  }
                  value={apiModelSelectValue}
                  onFocus={() => {
                    const byokProviderId = byokProtocolToTracking(apiProtocol);
                    if (byokProviderId) {
                      trackSettingsByokFieldClick(analytics.track, {
                        page_name: 'settings',
                        area: 'configure_execution_mode_byok',
                        element: 'model',
                        provider_id: byokProviderId,
                        has_value: Boolean(cfg.model?.trim()),
                      });
                    }
                  }}
                  onChange={(e) => {
                    if (e.target.value === CUSTOM_MODEL_SENTINEL) {
                      setApiModelCustomEditing(true);
                      updateApiConfig({ model: '' });
                    } else {
                      setApiModelCustomEditing(false);
                      updateApiConfig({ model: e.target.value });
                    }
                  }}
                >
                  {apiModelOptions.map((m) => (
                    <option value={m.id} key={m.id}>{apiModelOptionLabel(m)}</option>
                  ))}
                  <option value={CUSTOM_MODEL_SENTINEL}>{t('settings.modelCustom')}</option>
                </select>
                {loadedAccountModelCount > 0 ? (
                  <span className="field-inline-status success" role="status">
                    {t('settings.modelsLoadedFromAccount', {
                      count: loadedAccountModelCount,
                    })}
                  </span>
                ) : null}
                {providerModelsFailureMessage ? (
                  <span className="field-error" role="alert">
                    {providerModelsFailureMessage}
                  </span>
                ) : null}
              </label>
              {!selectedProvider ? (
                <p className="hint">{t('settings.suggestedModelsHint')}</p>
              ) : null}
              {apiProtocol === 'azure' ? (
                <p className="hint">{t('settings.azureModelFetchHint')}</p>
              ) : null}
              {apiProtocol === 'ollama' ? (
                <p className="hint">{t('settings.fetchModelsUnsupported')}</p>
              ) : null}
              {apiModelCustomActive ? (
                <label className="field">
                  <span className="field-label">
                    {t('settings.modelCustomLabel')}
                    <span className="field-required" aria-label={t('settings.required')}>
                      *
                    </span>
                  </span>
                  <input
                    ref={customModelInputRef}
                    aria-label={t('settings.modelCustomLabel')}
                    type="text"
                    value={cfg.model}
                    placeholder={t('settings.modelCustomPlaceholder')}
                    onChange={(e) => updateApiConfig({ model: e.target.value.trim() })}
                  />
                </label>
              ) : null}
              {renderByokBaseUrlField()}
              <details className="agent-cli-env settings-memory-advanced">
                <summary className="agent-cli-env-summary">
                  <span className="agent-cli-env-summary-title">
                    {t('settings.memoryModelInlineLabel')}
                  </span>
                </summary>
                <div className="agent-cli-env-body">
                  <MemoryModelInline
                    mode="api"
                    apiProtocol={apiProtocol}
                    chatApiKey={cfg.apiKey}
                    chatBaseUrl={cfg.baseUrl}
                    chatApiVersion={cfg.apiVersion ?? ''}
                    chatModel={cfg.model}
                  />
                </div>
              </details>
              {apiProtocol === 'azure' ? (
                <label className="field">
                  <span className="field-label">{t('settings.apiVersion')}</span>
                  <input
                    type="text"
                    value={cfg.apiVersion ?? ''}
                    placeholder="2024-10-21"
                    onBlur={commitProviderModelsInputs}
                    onChange={(e) => updateApiConfig({ apiVersion: e.target.value.trim() })}
                  />
                </label>
              ) : null}
              {apiProtocol === 'senseaudio' ? (
                <label className="field">
                  <span className="field-label">{t('settings.byokImageModel')}</span>
                  <select
                    value={cfg.byokImageModel ?? ''}
                    onChange={(e) =>
                      updateApiConfig({ byokImageModel: e.target.value })
                    }
                  >
                    {/* Default-empty option resolves to the registry default
                        on the daemon side (senseaudio-image-2.0-260319 today).
                        Listing it explicitly lets the picker show what the
                        unconfigured state actually means. */}
                    <option value="">
                      {IMAGE_MODELS.find((m) => m.provider === 'senseaudio')?.label
                        ?? 'senseaudio-image-2.0'}
                      {' (default)'}
                    </option>
                    {IMAGE_MODELS.filter((m) => m.provider === 'senseaudio').map(
                      (m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ),
                    )}
                  </select>
                </label>
              ) : null}
            </section>
          )}
            </>
          ) : null}

          {activeSection === 'media' ? (
            <MediaProvidersSection
              cfg={cfg}
              setCfg={setCfg}
              mediaProvidersNotice={mediaProvidersNotice}
              onReloadMediaProviders={onReloadMediaProviders}
              pendingLocalProviderIds={pendingMediaProviderEditIds}
              onChange={(providerId) => {
                mediaProvidersChangeVersionRef.current += 1;
                setPendingMediaProviderEditIds((current) => {
                  if (current.has(providerId)) return current;
                  const next = new Set(current);
                  next.add(providerId);
                  return next;
                });
              }}
            />
          ) : null}
          {activeSection === 'integrations' ? <IntegrationsSection /> : null}

          {activeSection === 'mcpClient' ? <McpClientSection /> : null}

          {activeSection === 'composio' ? (
            <ConnectorSection
              cfg={cfg}
              setCfg={setCfg}
              composioConfigLoading={composioConfigLoading}
              onPersistComposioKey={onPersistComposioKey}
              onConnectorAuthResult={({ connectorId, action, result, errorCode }) =>
                trackSettingsConnectorAuthResult(analytics.track, {
                  page_name: 'settings',
                  area: 'connectors',
                  connector_id: connectorId,
                  action,
                  result,
                  ...(errorCode ? { error_code: errorCode } : {}),
                })
              }
            />
          ) : null}

          {activeSection === 'routines' ? <RoutinesSection onClose={onClose} /> : null}

          {activeSection === 'orbit' ? (
            <OrbitSection
              cfg={cfg}
              setCfg={setCfg}
              composioApiKeyConfigured={Boolean(cfg.composio?.apiKeyConfigured)}
              daemonMediaProviders={daemonMediaProviders}
              daemonMediaProvidersFetchState={daemonMediaProvidersFetchState}
              onOpenComposioSection={() => setActiveSection('composio')}
              onLeaveForOrbitProject={(runConfig) => {
                // Persist any in-flight Orbit edits (toggle / time) before
                // navigating away so they aren't silently lost. The autosave
                // loop is best-effort; this synchronous flush guarantees the
                // run-config landed on the daemon before we tear the dialog
                // down. Closing the dialog drops the user on the
                // /projects/orbit view where the agent run streams in.
                void onPersist(runConfig);
                onClose();
              }}
            />
          ) : null}

          {activeSection === 'language' ? (
          <section className="settings-section">
            <div className="settings-language-grid" role="radiogroup" aria-label={t('settings.language')}>
              {LOCALES.map((code) => {
                const active = locale === code;
                return (
                  <button
                    key={code}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`settings-language-tile${active ? ' active' : ''}`}
                    onClick={() => {
                      // P1 ui_click area=language — record the locale id
                      // that was picked, regardless of whether it differs
                      // from the current one (user clicked = signal).
                      trackSettingsLanguageClick(analytics.track, {
                        page_name: 'settings',
                        area: 'language',
                        element: code,
                      });
                      setLocale(code as Locale);
                    }}
                  >
                    <span className="settings-language-tile-text">
                      <span className="settings-language-tile-title">
                        {LOCALE_LABEL[code]}
                      </span>
                      <span className="settings-language-tile-code">
                        {code}
                      </span>
                    </span>
                    {active ? <Icon name="check" size={16} /> : null}
                  </button>
                );
              })}
            </div>
          </section>
          ) : null}

          {activeSection === 'appearance' ? (
            <AppearanceSection cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'critiqueTheater' ? (
            <CritiqueTheaterSection />
          ) : null}

          {activeSection === 'notifications' ? (
            <NotificationsSection cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'pet' ? (
            <PetSettings cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'skills' ? (
            <SkillsSection cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'designSystems' ? (
            <DesignSystemsSection cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'instructions' ? (
            <section className="settings-section settings-section-card instructions-rules-section">
              <div className="memory-field-block instructions-rules-card">
                <div className="memory-block-head">
                  <div>
                    <h4>{t('settings.customInstructionsTitle')}</h4>
                    <p className="hint">
                      Fixed instructions OpenDesign follows in every chat. These are
                      not saved memories; use Memory for facts, preferences, and
                      project context.
                    </p>
                  </div>
                </div>
                <textarea
                  className="custom-instructions-input memory-global-rules-input instructions-rules-input"
                  rows={5}
                  maxLength={5000}
                  placeholder={t('settings.customInstructionsPlaceholder')}
                  value={cfg.customInstructions ?? ''}
                  onChange={(event) =>
                    setCfg({
                      ...cfg,
                      customInstructions: event.target.value || undefined,
                    })
                  }
                />
              </div>
            </section>
          ) : null}

          {activeSection === 'memory' ? (
            <MemorySection
              onOpenConnectors={() => setActiveSection('composio')}
              chatAgentId={cfg.mode === 'daemon' ? cfg.agentId ?? null : null}
              chatModel={selectedMemoryChatModel}
            />
          ) : null}

          {activeSection === 'logAnalysis' ? <LogAnalysisSection /> : null}

          {activeSection === 'privacy' ? (
            <PrivacySection cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'about' ? (
            <section className="settings-section">
              {appVersionInfo ? (
                <dl className="settings-about-list">
                  <div className="settings-about-version-row">
                    <div className="settings-about-version-left">
                      <dt>{t('settings.appVersion')}</dt>
                      <span className="settings-about-version-num">{appVersionInfo.version}</span>
                    </div>
                    <button
                      type="button"
                      className="settings-about-download-link"
                      disabled={versionChecking}
                      onClick={handleInstallLatest}
                    >
                      {versionChecking ? t('common.loading') : t('settings.installLatest')}
                    </button>
                  </div>
                  <div>
                    <dt>{t('settings.appChannel')}</dt>
                    <dd>{appVersionInfo.channel}</dd>
                  </div>
                  <div>
                    <dt>{t('settings.appRuntime')}</dt>
                    <dd>
                      {appVersionInfo.packaged
                        ? t('settings.runtimePackaged')
                        : t('settings.runtimeDevelopment')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('settings.appPlatform')}</dt>
                    <dd>{appVersionInfo.platform}</dd>
                  </div>
                  <div>
                    <dt>{t('settings.appArchitecture')}</dt>
                    <dd>{appVersionInfo.arch}</dd>
                  </div>
                </dl>
              ) : (
                <div className="empty-card">{t('settings.versionUnavailable')}</div>
              )}
              <div className="settings-about-diagnostics">
                <div className="settings-about-diagnostics-text">
                  <h4>{t('diagnostics.exportTitle')}</h4>
                  <p className="hint">{t('diagnostics.exportHint')}</p>
                </div>
                <ExportDiagnosticsRow />
              </div>
            </section>
          ) : null}
          {aboutToast ? (
            <Toast
              message={aboutToast}
              onDismiss={() => setAboutToast(null)}
            />
          ) : null}
          </div>
        </div>

        {/* Bottom status strip — mirrors the reference dialog: a hairline
            rule, an `Esc · close` keycap hint on the left, and a muted
            version marker on the right. Purely informational; the actual
            close affordances stay the corner X, backdrop click, and the
            global Escape handler above. */}
        {!embedded && (
        <footer className="settings-foot" aria-hidden="false">
          <span className="settings-foot-hint">
            <kbd>Esc</kbd>
            <span>{t('common.close')}</span>
          </span>
          {appVersionInfo?.version ? (
            <span className="settings-foot-version">
              v{appVersionInfo.version}
            </span>
          ) : null}
        </footer>
        )}
      </div>
    </div>
  );
}
