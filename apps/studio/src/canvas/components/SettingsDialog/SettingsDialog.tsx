import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Loader2, RotateCw } from 'lucide-react';

import { Badge } from '@/src/components/ui/badge';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/src/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/src/components/ui/tabs';
import { cn } from '@/src/lib/utils';
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
  trackSettingsExecutionModeTabClick,
  trackSettingsPrivacyClick,
  trackSettingsView,
} from '../../analytics/events';
import { LOCALE_LABEL, LOCALES, useI18n } from '../../i18n';
import type { Locale } from '../../i18n';
import { ExportDiagnosticsRow } from '../settings/ExportDiagnosticsButton';
import { useDialogStore } from '@/src/chat/stores/dialogs';
import { Icon } from '../shared/Icon';
import {
  CUSTOM_MODEL_SENTINEL,
  groupModelOptions,
  stripProviderPrefix,
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
  AgentModelOption,
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
import { IMAGE_MODELS } from '../../media/models';
import { PetSettings } from '../pet/PetSettings';
import { McpClientSection } from '../settings/McpClientSection';
import { SkillsSection } from '../settings/SkillsSection';
import { DesignSystemsSection } from '../design-system/DesignSystemsSection';
import {
  WorkspaceAutomationsSection,
  WorkspacePluginsSection,
  WorkspaceProjectsSection,
} from '../settings/WorkspaceSections';
import { PrivacySection } from '../settings/PrivacySection';
import { UpdateAppSection } from '../settings/UpdateAppSection';
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
  agentRefreshOptionsForConfig,
  apiModelOptionLabel,
  byokProviderRequiresApiKey,
  canRunProviderConnectionTest,
  codexPathStrings,
  isValidApiBaseUrl,
  mergeProviderModelOptions,
  missingByokConnectionFields,
  missingByokModelFetchFields,
  providerConnectionTestKey,
  providerModelsCacheKey,
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
import { CliBackendCard } from './CliBackendCard';
import { LogAnalysisSection } from './LogAnalysisSection';
import { CritiqueTheaterSection } from './CritiqueTheaterSection';
import { NotificationsSection } from './NotificationsSection';
import { AccountSection } from './AccountSection';
import { UsageSection } from './UsageSection';

/* ── 执行模式面板已迁 chat 栈（shadcn + Tailwind utility），以下是迁移期的
   两件小基建。全部 section 迁完后考虑下沉到 src/components/ui/：
   - 下拉全部走 Radix Select（2026-07-04 换装）：原「不上 Radix」的两个障碍
     已解——optgroup 分组用 SelectGroup/SelectLabel 覆盖（renderModelSelectItems，
     与 AvatarMenu 共用的数据分组抽在 shared/modelOptions.groupModelOptions），
     空字符串 value 用 sentinel 常量映射（Radix SelectItem 禁止 value=''）。
   - TEST_STATUS_TONES：连接测试结果条的语义配色。var(--green*) 等状态色目前
     只在 canvas base.css 定义（明暗双套、全局可见），chat 链尚无对应 token——
     迁移期先引用全局变量，退役 canvas CSS 前要在 design-tokens 里转正。 */
/* renderModelOptions 的 Radix 版：同一 groupModelOptions 数据源，flat 项平铺、
   provider 组 SelectGroup+SelectLabel（对应原生 optgroup——当初不上 Radix 的
   两个障碍在此解决：分组用 SelectGroup 覆盖，空字符串 value 用下方 sentinel
   映射）。AvatarMenu 仍在 canvas 栈，继续用 shared/modelOptions 的原生版。 */
function renderModelSelectItems(models: AgentModelOption[]) {
  const { flat, groups } = groupModelOptions(models);
  return (
    <>
      {flat.map((m) => (
        <SelectItem key={m.id} value={m.id}>
          {m.label}
        </SelectItem>
      ))}
      {groups.map(([provider, items]) => (
        <SelectGroup key={provider}>
          <SelectLabel>{provider}</SelectLabel>
          {items.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {stripProviderPrefix(m.label, provider)}
            </SelectItem>
          ))}
        </SelectGroup>
      ))}
    </>
  );
}

/* Radix SelectItem 禁止空字符串 value（会 throw）——原生 <option value="">
   的两处「空=默认」语义改用 sentinel 表达，读写时映射回 ''。 */
const QUICK_FILL_CUSTOM_VALUE = '__custom_provider__';
const IMAGE_MODEL_DEFAULT_VALUE = '__registry_default__';

const TEST_STATUS_TONES: Record<string, string> = {
  success: 'border-[var(--green-border)] bg-[var(--green-bg)] text-[var(--green)]',
  error: 'border-[var(--red-border)] bg-[var(--red-bg)] text-[var(--red)]',
  warn: 'border-[var(--amber-border,var(--green-border))] bg-[var(--amber-bg,var(--green-bg))] text-[var(--amber,var(--green))]',
  running: 'border-[var(--accent-soft)] bg-[var(--accent-tint)] text-[var(--accent-strong)]',
};
const testStatusBoxCls =
  'm-0 break-words rounded-md border px-2.5 py-[7px] text-xs leading-normal';

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
  workspaceHost,
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
  const agentTestRevisionRef = useRef(0);
  const providerTestRevisionRef = useRef(0);
  const providerModelsRevisionRef = useRef(0);
  const providerModelsFirstResetRef = useRef(true);
  const providerAutoTestKeyRef = useRef<string | null>(null);
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const baseUrlInputRef = useRef<HTMLInputElement | null>(null);
  /* Radix SelectTrigger 是 <button>——focusByokRequiredField 聚焦目标随之换型 */
  const modelSelectRef = useRef<HTMLButtonElement | null>(null);
  const customModelInputRef = useRef<HTMLInputElement | null>(null);
  const focusByokRequiredFieldAfterProtocolSwitchRef = useRef(false);
  const [apiModelCustomEditing, setApiModelCustomEditing] = useState(false);
  const [agentCustomModelIds, setAgentCustomModelIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // 「关于」页的版本行动作（2026-07-05）：原 handleInstallLatest 检查的是
  // 上游 nexu-io/open-design 的 release（daemon 代理），与本应用自己的发版
  // 渠道早已无关——真正的更新走 main 的 electron-updater（设置页「更新
  // 应用」section），这里退化成一个跳转入口。

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
    <label className="flex flex-col gap-1">
      <span className="inline-flex items-center text-xs font-medium text-foreground">
        {t('settings.baseUrl')}
        <span className="ml-1 font-bold text-destructive" aria-label={t('settings.required')}>
          *
        </span>
      </span>
      <div className="flex items-stretch gap-1.5">
        <Input
          className={cn('flex-1', baseUrlReadOnly && 'cursor-default text-muted-foreground')}
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
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 whitespace-nowrap font-normal"
            onClick={() => {
              updateApiConfig({ apiProviderBaseUrl: null });
              window.setTimeout(() => baseUrlInputRef.current?.focus(), 0);
            }}
          >
            {t('settings.baseUrlCustomize')}
          </Button>
        ) : null}
      </div>
      {baseUrlInvalid ? (
        <span
          id="settings-base-url-error"
          className="text-[11.5px] leading-snug text-destructive"
          role="alert"
        >
          {t('settings.baseUrlInvalid')}
        </span>
      ) : null}
      {baseUrlReadOnly ? (
        <span className="text-[11.5px] leading-snug text-muted-foreground">
          {t('settings.baseUrlDefaultHint')}
        </span>
      ) : null}
      {apiProtocol === 'azure' ? (
        <span className="text-[11.5px] leading-snug text-muted-foreground">
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
    account: { title: '账号', subtitle: '个人资料与账户信息' },
    usage: { title: '使用记录', subtitle: '查看和分析您的 API 使用历史' },
    execution: { title: t('settings.title'), subtitle: t('settings.subtitle') },
    instructions: {
      title: t('settings.instructions'),
      subtitle: t('settings.instructionsHint'),
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
    // 「工作区」三节（2026-07-04 首页 rail 迁移）。标题沿用首页 rail 的
    // i18n key，副标题一句话说明来处。
    projects: { title: t('entry.navProjects'), subtitle: '' },
    automations: { title: t('entry.navTasks'), subtitle: '' },
    plugins: { title: t('entry.navPlugins'), subtitle: '' },
    // 'library' is opened via EntryShell route — SettingsDialog doesn't
    // render it but SettingsSection must accept the token (see type def).
    library: { title: '', subtitle: '' },
    appUpdate: { title: t('settings.appUpdate'), subtitle: t('settings.appUpdateHint') },
    about: { title: t('settings.about'), subtitle: t('settings.aboutHint') },
  };
  const activeHeader = sectionHeader[activeSection];

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
                <strong>{t('settings.instructions')}</strong>
                <small>{t('settings.instructionsHint')}</small>
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
              {/* 模式切换：Radix Tabs（chat 栈 idiom），只用 TabsList 作触发
                  器——两个面板依旧走下面的 cfg.mode 条件渲染，不套 TabsContent
                  以免改动渲染结构。 */}
              <Tabs
                value={cfg.mode}
                onValueChange={(v) => setMode(v as ExecMode)}
                aria-label={t('settings.modeAria')}
              >
                {/* h-auto 必须带同款变体前缀才能盖过 TabsList 基类的
                    group-data-[orientation=horizontal]/tabs:h-9（tw-merge 只
                    合并同前缀的同组 utility）——裸 h-auto 两条都保留，容器被
                    钉在 36px，两行 trigger 直接溢出容器盖住下方内容。 */}
                <TabsList className="grid w-full grid-cols-2 rounded-xl p-1 group-data-[orientation=horizontal]/tabs:h-auto">
                  <TabsTrigger
                    value="daemon"
                    disabled={!daemonLive}
                    className="h-auto flex-col gap-0.5 rounded-[9px] py-2"
                    title={
                      daemonLive
                        ? t('settings.modeDaemonHelp')
                        : t('settings.modeDaemonOffline')
                    }
                  >
                    <span className="text-[13.5px]">{t('settings.localCli')}</span>
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {daemonLive
                        ? t('settings.modeDaemonBackendMeta')
                        : t('settings.modeDaemonOfflineMeta')}
                    </span>
                  </TabsTrigger>
                  <TabsTrigger value="api" className="h-auto flex-col gap-0.5 rounded-[9px] py-2">
                    <span className="text-[13.5px]">{t('settings.modeApiMeta')}</span>
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {t('settings.modeApi')}
                    </span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              {cfg.mode === 'api' ? (
                /* 协议切换：分段式（secondary 底容器 + 选中段白卡凸起），与上方
                   模式双档同语言——原 outline 胶囊选中时整块 accent 实底，视觉
                   权重压过模式 tab，两排切换器打架。裸 <button> + data-slot
                   逃逸 canvas reset（同 agent-card-select）。 */
                <div
                  className="mt-1 flex min-w-0 rounded-[10px] bg-secondary p-[3px]"
                  role="tablist"
                  aria-label={t('settings.protocolAria')}
                >
                  {API_PROTOCOL_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      data-slot="byok-protocol-tab"
                      aria-selected={apiProtocol === tab.id}
                      className={cn(
                        'min-w-0 flex-1 cursor-pointer truncate rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-[background-color,color,box-shadow]',
                        apiProtocol === tab.id
                          ? 'bg-card text-foreground shadow-[0_1px_3px_hsl(240_6%_10%/0.12),0_0_0_1px_hsl(240_6%_10%/0.04)]'
                          : 'hover:text-foreground/80',
                      )}
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
            <section className="flex flex-col gap-3">
              <p className="m-0 text-xs leading-relaxed text-muted-foreground">
                {t('settings.codeAgentHint')}
              </p>
              {agents.length === 0 ? (
                <div className="rounded-md border border-dashed border-border bg-muted/40 p-4 text-xs text-muted-foreground">
                  {t('settings.noAgentsDetected')}
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="m-0 text-[13px] font-semibold text-foreground">
                        {t('settings.chatCliBackendTitle')}
                      </h4>
                      <div className="inline-flex min-w-0 items-center gap-2.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="rounded-[9px] border-accent/40 font-medium text-[var(--accent-strong)] shadow-none hover:border-accent/60 hover:bg-accent/10 hover:text-[var(--accent-strong)]"
                          onClick={() => void handleTestAgent()}
                          disabled={agentTestState.status === 'running'}
                          title={t('settings.testTitle')}
                        >
                          {agentTestState.status === 'running' ? (
                            <>
                              <Loader2 className="size-3.5 animate-spin" />
                              <span>{t('settings.test')}</span>
                            </>
                          ) : (
                            t('settings.test')
                          )}
                        </Button>
                        {agentRescanNotice ? (
                          <span
                            className={cn(
                              'whitespace-nowrap text-[11.5px]',
                              agentRescanNotice.kind === 'error'
                                ? 'text-[var(--red)]'
                                : 'text-[var(--green)]',
                            )}
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
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-w-[92px] rounded-[9px] font-normal shadow-none hover:border-accent/50 hover:bg-accent/5"
                          onClick={() => void handleRefreshAgents()}
                          disabled={agentRescanRunning}
                          title={t('settings.rescanTitle')}
                        >
                          {agentRescanRunning ? (
                            <>
                              <Loader2 className="size-3.5 animate-spin" />
                              <span>{t('settings.rescanRunning')}</span>
                            </>
                          ) : (
                            t('settings.rescan')
                          )}
                        </Button>
                      </div>
                    </div>
                    <CliBackendCard setCfg={setCfg} />
                    {agentTestState.status !== 'idle' ? (
                      <div className="flex flex-col gap-2">
                        {agentTestState.status === 'running' ? (
                          <p
                            className={cn(testStatusBoxCls, TEST_STATUS_TONES.running)}
                            role="status"
                            aria-live="polite"
                          >
                            {t('settings.testRunning')}
                          </p>
                        ) : (
                          <>
                            <p
                              className={cn(
                                testStatusBoxCls,
                                TEST_STATUS_TONES[
                                  testStatusVariant(agentTestState.result)
                                ],
                              )}
                              role={agentTestState.result.ok ? 'status' : 'alert'}
                            >
                              {renderTestMessage(agentTestState.result, 'cli')}
                            </p>
                            {!agentTestState.result.ok ? (
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="rounded-full font-normal shadow-none"
                                  onClick={() => void handleTestAgent()}
                                >
                                  <RotateCw className="size-3.5" />
                                  <span>{t('settings.testRetry')}</span>
                                </Button>
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                    ) : null}
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
                  <div className="flex flex-col gap-2 rounded-xl border border-border bg-secondary/40 p-4">
                    <div className="text-xs text-foreground">
                      {t('settings.agentModelHead')}{' '}
                      <strong className="font-semibold">{selected.name}</strong>
                    </div>
                    {hasModels ? (
                      <>
                        <label className="flex flex-col gap-1">
                          <span className="inline-flex flex-wrap items-center gap-2 text-[11.5px] uppercase tracking-[0.04em] text-muted-foreground">
                            {t('settings.modelPicker')}
                            {modelSource === 'live' ? (
                              <Badge
                                variant="outline"
                                className="rounded-full border-[var(--green-border)] bg-[var(--green-bg)] px-1.5 text-[10.5px] font-semibold normal-case text-[var(--green)]"
                              >
                                {modelSourceLabel}
                              </Badge>
                            ) : (
                              <span className="text-[11.5px] font-normal normal-case tracking-normal before:mr-1.5 before:content-['·']">
                                {modelSourceLabel}
                              </span>
                            )}
                          </span>
                          <Select
                            value={selectValue}
                            onValueChange={(v) => {
                              if (v === CUSTOM_MODEL_SENTINEL) {
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
                                setChoice({ model: v });
                              }
                            }}
                          >
                            <SelectTrigger className="w-full bg-card">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent position="popper">
                              {renderModelSelectItems(selected.models!)}
                              <SelectItem value={CUSTOM_MODEL_SENTINEL}>
                                {t('settings.modelCustom')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </label>
                        <p className="m-0 text-[11.5px] leading-relaxed text-muted-foreground">
                          {modelSourceHint}
                        </p>
                      </>
                    ) : null}
                    {customActive ? (
                      <label className="flex flex-col gap-1">
                        <span className="text-[11.5px] uppercase tracking-[0.04em] text-muted-foreground">
                          {t('settings.modelCustomLabel')}
                        </span>
                        <Input
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
                      <label className="flex flex-col gap-1">
                        <span className="text-[11.5px] uppercase tracking-[0.04em] text-muted-foreground">
                          {t('settings.reasoningPicker')}
                        </span>
                        <Select
                          value={reasoningValue}
                          onValueChange={(v) => setChoice({ reasoning: v })}
                        >
                          <SelectTrigger className="w-full bg-card">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent position="popper">
                            {selected.reasoningOptions!.map((r) => (
                              <SelectItem key={r.id} value={r.id}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>
                    ) : null}
                  </div>
                );
              })()}
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
                  <details className="group overflow-hidden rounded-xl border border-border bg-card">
                    <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3.5 py-3 transition-colors hover:bg-secondary/50 [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                      <span className="text-[13px] font-medium text-foreground">
                        {t('settings.memoryModelInlineLabel')}
                      </span>
                    </summary>
                    <div className="flex flex-col gap-2 border-t border-border/50 px-3.5 pb-4 pt-3">
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
                    className="group overflow-hidden rounded-xl border border-border bg-card"
                    data-testid="settings-cli-env"
                  >
                    <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3.5 py-3 transition-colors hover:bg-secondary/50 [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                      <span className="text-[13px] font-medium text-foreground">
                        {t('settings.cliEnvTitle')}
                      </span>
                    </summary>
                    <div className="flex flex-col gap-2 border-t border-border/50 px-3.5 pb-4 pt-3">
                      <p className="m-0 text-[11.5px] leading-relaxed text-muted-foreground">
                        {t('settings.cliEnvHint')}
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {cliEnvFields.map((field) => (
                          <label
                            className="flex min-w-0 flex-col gap-1"
                            key={`${field.agentId}:${field.envKey}`}
                          >
                            <span className="text-xs font-medium text-foreground">
                              {t(field.labelKey)}
                              {'labelSuffix' in field
                                ? ` (${field.labelSuffix})`
                                : ''}
                            </span>
                            <Input
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
            <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
              <h3 className="m-0 text-sm font-semibold text-foreground">
                {API_PROTOCOL_LABELS[apiProtocol]}
              </h3>
              {byokPreconditionNotice ? (
                <p
                  className={cn(testStatusBoxCls, TEST_STATUS_TONES.error)}
                  role="alert"
                  aria-live="polite"
                  data-action={byokPreconditionNotice.action}
                >
                  {byokPreconditionNotice.message}
                </p>
              ) : null}
              {showQuickFillProvider ? (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-foreground">{t('settings.quickFillProvider')}</span>
                  <Select
                    value={
                      selectedProviderIndex >= 0
                        ? String(selectedProviderIndex)
                        : QUICK_FILL_CUSTOM_VALUE
                    }
                    onValueChange={(v) => {
                      if (v === QUICK_FILL_CUSTOM_VALUE) {
                        setApiModelCustomEditing(false);
                        updateApiConfig({
                          baseUrl: '',
                          model: '',
                          apiProviderBaseUrl: null,
                        });
                        return;
                      }
                      const idx = Number(v);
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
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value={QUICK_FILL_CUSTOM_VALUE}>
                        {t('settings.customProvider')}
                      </SelectItem>
                      {protocolProviders.map((p, i) => (
                        <SelectItem key={p.label} value={String(i)}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              ) : null}
              <label className="flex flex-col gap-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center text-xs font-medium text-foreground">
                    {t('settings.apiKey')}
                    {byokRequiresApiKey ? (
                      <span className="ml-1 font-bold text-destructive" aria-label={t('settings.required')}>
                        *
                      </span>
                    ) : null}
                  </span>
                  {byokRequiresApiKey ? (
                    <a
                      className="text-xs text-[var(--accent-strong)] hover:underline"
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
                <div className="flex items-stretch gap-1.5">
                  <Input
                    className="flex-1"
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 whitespace-nowrap font-normal"
                    onClick={() => setShowApiKey((v) => !v)}
                    title={
                      showApiKey ? t('settings.hideKey') : t('settings.showKey')
                    }
                  >
                    {showApiKey ? t('settings.hide') : t('settings.show')}
                  </Button>
                </div>
                {apiKeyAuthFailed && providerTestState.status === 'idle' ? (
                  <span className="text-[11.5px] leading-snug text-destructive" role="alert">
                    {t('settings.apiKeyInvalid')}
                  </span>
                ) : null}
                {providerTestState.status === 'running' ? (
                  <span
                    className="text-[11.5px] leading-snug text-[var(--accent-strong)]"
                    role="status"
                    aria-live="polite"
                  >
                    {t('settings.testRunning')}
                  </span>
                ) : providerTestState.status === 'done' ? (
                  <span
                    className={
                      providerTestState.result.ok
                        ? 'text-[11.5px] leading-snug text-[var(--green)]'
                        : 'text-[11.5px] leading-snug text-destructive'
                    }
                    role={providerTestState.result.ok ? 'status' : 'alert'}
                  >
                    {renderTestMessage(providerTestState.result, 'api')}
                  </span>
                ) : null}
                <span className="text-[11.5px] leading-snug text-muted-foreground">
                  {t('settings.apiHint')}
                </span>
                {canRunProviderConnectionTest(cfg, {
                  requiresApiKey: byokRequiresApiKey,
                }) && baseUrlValid ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-start rounded-[9px] border-accent/40 font-medium text-[var(--accent-strong)] shadow-none hover:border-accent/60 hover:bg-accent/10 hover:text-[var(--accent-strong)]"
                    onClick={() => void handleTestProvider()}
                    disabled={providerTestState.status === 'running'}
                    title={t('settings.testTitle')}
                  >
                    {providerTestState.status === 'running' ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        <span>{t('settings.test')}</span>
                      </>
                    ) : providerTestState.status === 'done' &&
                      !providerTestState.result.ok ? (
                      <>
                        <RotateCw className="size-3.5" />
                        <span>{t('settings.testRetry')}</span>
                      </>
                    ) : (
                      t('settings.test')
                    )}
                  </Button>
                ) : null}
              </label>
              <label className="flex flex-col gap-1">
                <span className="inline-flex items-center text-xs font-medium text-foreground">
                  {apiProtocol === 'azure'
                    ? t('settings.azureDeploymentModel')
                    : t('settings.model')}
                  <span className="ml-1 font-bold text-destructive" aria-label={t('settings.required')}>
                    *
                  </span>
                </span>
                <Select
                  value={apiModelSelectValue}
                  onValueChange={(v) => {
                    if (v === CUSTOM_MODEL_SENTINEL) {
                      setApiModelCustomEditing(true);
                      updateApiConfig({ model: '' });
                    } else {
                      setApiModelCustomEditing(false);
                      updateApiConfig({ model: v });
                    }
                  }}
                >
                  <SelectTrigger
                    ref={modelSelectRef}
                    className="w-full"
                    aria-label={
                      apiProtocol === 'azure'
                        ? t('settings.azureDeploymentModel')
                        : t('settings.model')
                    }
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
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {apiModelOptions.map((m) => (
                      <SelectItem value={m.id} key={m.id}>
                        {apiModelOptionLabel(m)}
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_MODEL_SENTINEL}>
                      {t('settings.modelCustom')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {loadedAccountModelCount > 0 ? (
                  <span className="text-[11.5px] leading-snug text-[var(--green)]" role="status">
                    {t('settings.modelsLoadedFromAccount', {
                      count: loadedAccountModelCount,
                    })}
                  </span>
                ) : null}
                {providerModelsFailureMessage ? (
                  <span className="text-[11.5px] leading-snug text-destructive" role="alert">
                    {providerModelsFailureMessage}
                  </span>
                ) : null}
              </label>
              {!selectedProvider ? (
                <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('settings.suggestedModelsHint')}</p>
              ) : null}
              {apiProtocol === 'azure' ? (
                <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('settings.azureModelFetchHint')}</p>
              ) : null}
              {apiProtocol === 'ollama' ? (
                <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('settings.fetchModelsUnsupported')}</p>
              ) : null}
              {apiModelCustomActive ? (
                <label className="flex flex-col gap-1">
                  <span className="inline-flex items-center text-xs font-medium text-foreground">
                    {t('settings.modelCustomLabel')}
                    <span className="ml-1 font-bold text-destructive" aria-label={t('settings.required')}>
                      *
                    </span>
                  </span>
                  <Input
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
              <details className="group overflow-hidden rounded-xl border border-border bg-card">
                <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-3.5 py-3 transition-colors hover:bg-secondary/50 [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                  <span className="text-[13px] font-medium text-foreground">
                    {t('settings.memoryModelInlineLabel')}
                  </span>
                </summary>
                <div className="flex flex-col gap-2 border-t border-border/50 px-3.5 pb-4 pt-3">
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
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-foreground">{t('settings.apiVersion')}</span>
                  <Input
                    type="text"
                    value={cfg.apiVersion ?? ''}
                    placeholder="2024-10-21"
                    onBlur={commitProviderModelsInputs}
                    onChange={(e) => updateApiConfig({ apiVersion: e.target.value.trim() })}
                  />
                </label>
              ) : null}
              {apiProtocol === 'senseaudio' ? (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-foreground">{t('settings.byokImageModel')}</span>
                  <Select
                    value={cfg.byokImageModel || IMAGE_MODEL_DEFAULT_VALUE}
                    onValueChange={(v) =>
                      updateApiConfig({
                        byokImageModel: v === IMAGE_MODEL_DEFAULT_VALUE ? '' : v,
                      })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {/* Default sentinel（存储侧仍是 ''）resolves to the
                          registry default on the daemon side
                          (senseaudio-image-2.0-260319 today). Listing it
                          explicitly lets the picker show what the
                          unconfigured state actually means. */}
                      <SelectItem value={IMAGE_MODEL_DEFAULT_VALUE}>
                        {IMAGE_MODELS.find((m) => m.provider === 'senseaudio')?.label
                          ?? 'senseaudio-image-2.0'}
                        {' (default)'}
                      </SelectItem>
                      {IMAGE_MODELS.filter((m) => m.provider === 'senseaudio').map(
                        (m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.label}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
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

          {activeSection === 'account' ? <AccountSection /> : null}

          {activeSection === 'usage' ? <UsageSection /> : null}

          {activeSection === 'pet' ? (
            <PetSettings cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'skills' ? (
            <SkillsSection cfg={cfg} setCfg={setCfg} />
          ) : null}

          {activeSection === 'designSystems' ? (
            <DesignSystemsSection cfg={cfg} setCfg={setCfg} />
          ) : null}

          {/* 「工作区」三节（2026-07-04 首页 rail 迁移）：宿主组件见
              WorkspaceSections.tsx。V1 自己的侧栏没有这三项入口（V1 是
              legacy、一个 flag 之隔就删）；V2 的 NAV_GROUPS 提供导航，经
              controlledSection 驱动到这里渲染。workspaceHost 缺席时渲染
              空——只有 canvas App 会带着数据包打开设置。 */}
          {activeSection === 'projects' && workspaceHost ? (
            <WorkspaceProjectsSection host={workspaceHost} />
          ) : null}

          {activeSection === 'automations' && workspaceHost ? (
            <WorkspaceAutomationsSection host={workspaceHost} />
          ) : null}

          {activeSection === 'plugins' && workspaceHost ? (
            <WorkspacePluginsSection host={workspaceHost} />
          ) : null}

          {activeSection === 'instructions' ? (
            <section className="settings-section settings-section-card instructions-rules-section">
              <div className="memory-field-block instructions-rules-card">
                <div className="memory-block-head">
                  <div>
                    <h4>{t('settings.customInstructionsTitle')}</h4>
                    <p className="hint">{t('settings.customInstructionsHint')}</p>
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

          {activeSection === 'appUpdate' ? (
            <UpdateAppSection fallbackVersion={appVersionInfo?.version ?? null} />
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
                      onClick={() => setActiveSection('appUpdate')}
                    >
                      {t('updateApp.check')}
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
              {/* 新增行：shadcn 原语 + utility（本 about section 尚未整体迁移，
                  但新 markup 一律走 shadcn，见 CLAUDE.md 设置页迁移纪律）。
                  文案硬编码中文（不走 canvas i18n）：FeedbackDialog 本身也是
                  硬编码中文，见该文件头注释——它现在挂在根 layout 的
                  RailShell.tsx，不在 canvas 的 I18nProvider 边界内。 */}
              <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
                <div>
                  <h4 className="text-sm font-medium text-foreground">问题反馈</h4>
                  <p className="hint">描述你遇到的问题，最多可以附 4 张截图。</p>
                </div>
                {typeof window !== 'undefined' && window.chatApi ? (
                  <Button
                    variant="outline"
                    onClick={() => useDialogStore.getState().openDialog('feedback')}
                  >
                    反馈问题
                  </Button>
                ) : null}
              </div>
            </section>
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
