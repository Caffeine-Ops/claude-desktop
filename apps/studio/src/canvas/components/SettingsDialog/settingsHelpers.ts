import { validateBaseUrl } from '@open-design/contracts/api/connectionTest';
import type { Locale } from '../../i18n';
import { KNOWN_PROVIDERS } from '../../state/config';
import type { KnownProvider } from '../../state/config';
import type { SettingsWorkspaceHost } from '../settings/WorkspaceSections';
import type {
  AgentInfo,
  ApiProtocol,
  ApiProtocolConfig,
  AppConfig,
  AppVersionInfo,
  ConnectionTestResponse,
  ProviderModelOption,
  ProviderModelsResponse,
} from '../../types';

export type SettingsSection =
  // 账号（2026-07-21）：sub2api 真实账户资料——头像/用户名/角色/状态/
  // 余额/并发/注册时间。面板组件 AccountSection.tsx，经 window.chatApi
  // 的 ACCOUNT_GET_PROFILE / ACCOUNT_UPDATE_PROFILE 两个 IPC 读写，不吃
  // cfg/setCfg（账户数据不是 AppConfig 草稿的一部分）。
  | 'account'
  // 使用记录（2026-07-21）：对接 sub2api /api/v1/usage* 的统计卡片/图表/
  // 明细表，面板组件 UsageSection.tsx。原是账户菜单里的全屏 overlay
  // （UsageScreen.tsx），用户要求改成设置页普通一节，overlay 版已删除。
  | 'usage'
  | 'execution'
  | 'instructions'
  | 'media'
  | 'composio'
  | 'orbit'
  | 'routines'
  | 'integrations'
  | 'mcpClient'
  | 'language'
  | 'appearance'
  | 'critiqueTheater'
  | 'notifications'
  | 'pet'
  | 'skills'
  | 'designSystems'
  | 'memory'
  | 'logAnalysis'
  | 'privacy'
  // 「工作区」三节（2026-07-04 首页 rail 迁移）：项目 / 自动化 / 插件。
  // 内容由 WorkspaceSections.tsx 宿主，数据靠 workspaceHost prop 注入——
  // 没有 workspaceHost 时（理论上只有 canvas App 会开设置，防御性判空）
  // 这三节渲染为空。
  | 'projects'
  | 'automations'
  | 'plugins'
  // 'library' is consumed by the EntryShell library route — App opens it
  // via this same openSettings entry point, so SettingsSection must
  // accept the token even though SettingsDialog itself has no Library
  // section. Reconcile follow-up: route library through a dedicated
  // navigate() call so openSettings only owns dialog-bound sections.
  | 'library'
  // 自动更新（2026-07-05）：检查/下载/安装状态面。面板组件在
  // components/settings/UpdateAppSection.tsx（chat 栈），经 window.chatApi
  // 直连 main 的 appUpdater 状态流，不走 daemon。
  | 'appUpdate'
  | 'about';

export interface SettingsDialogProps {
  initial: AppConfig;
  agents: AgentInfo[];
  daemonLive: boolean;
  appVersionInfo: AppVersionInfo | null;
  welcome?: boolean;
  initialSection?: SettingsSection;
  /**
   * Persist the current draft. Invoked by the dialog's autosave loop on
   * every committed edit. Returns a promise that resolves once both
   * localStorage and the daemon have caught up so the footer status
   * indicator can flip from "Saving…" to "Saved". Should NOT close the
   * dialog and should NOT mutate onboarding state — it represents an
   * incremental save, not a final commit.
   */
  onPersist: (cfg: AppConfig, options?: { forceMediaProviderSync?: boolean }) => Promise<void> | void;
  /**
   * Persist the Composio API key separately from the broader autosave
   * loop. Composio secrets need an explicit user gesture so half-typed
   * keys never leave the browser, so this is wired to a section-local
   * "Save key" button rather than the autosave channel.
   */
  onPersistComposioKey: (composio: AppConfig['composio']) => Promise<void> | void;
  /**
   * True while the daemon-backed Composio config is still hydrating on
   * first paint after a dev-server / app restart. The Connectors section
   * renders a skeleton over the input + buttons during this window so
   * the user does not mistake the temporarily empty input for "no key
   * saved" and so accidental Save/Clear clicks cannot overwrite the
   * saved state with `''` before the daemon's response lands.
   */
  composioConfigLoading?: boolean;
  onClose: () => void;
  onRefreshAgents: (
    options?: AgentRefreshOptions,
  ) => AgentInfo[] | Promise<AgentInfo[] | void> | void;
  daemonMediaProviders?: AppConfig['mediaProviders'] | null;
  daemonMediaProvidersFetchState?: 'idle' | 'ok' | 'error';
  mediaProvidersNotice?: string | null;
  onReloadMediaProviders?: () => Promise<AppConfig['mediaProviders'] | null>;
  /**
   * Embedded mode — render ONLY the per-section content pane, with none of
   * this dialog's own chrome (backdrop, modal frame, back button, autosave
   * pill, header, sidebar nav, footer). SettingsDialogV2 uses this to host
   * the exact same section logic + autosave inside its own `.sv2` shell, so
   * V1 and V2 share one implementation and never drift. Default (false) =
   * the standalone dialog, unchanged.
   */
  embedded?: boolean;
  /**
   * In embedded mode the active section is owned by the host shell (V2's
   * sidebar drives it). When provided, this overrides the internal
   * `activeSection` state; `onSectionChange` reports user-initiated section
   * jumps from inside a panel (e.g. Memory's "open Connectors" link) back up
   * to the host. Ignored when `embedded` is false.
   */
  controlledSection?: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
  /**
   * 「工作区」sections（projects/automations/plugins）的数据与动作包。
   * 由 canvas App 在渲染设置时打包传入（数据在 App state、handler 内部
   * navigate() 会让 ?settings=1 消失从而自动关 overlay）。不传时这三节
   * 渲染为空——见 WorkspaceSections.tsx 头注释。
   */
  workspaceHost?: SettingsWorkspaceHost;
}

export interface AgentRefreshOptions {
  throwOnError?: boolean;
  agentCliEnv?: AppConfig['agentCliEnv'];
}

export function codexPathStrings(locale: Locale) {
  if (locale === 'zh-CN') {
    return {
      repairHint: '当前保存的 Codex 路径不适合继续使用。',
      useDetected: '使用检测到的 Codex',
      clearCustom: '清空自定义路径',
      configuredSuccess: (path: string) => `本次测试使用的是已配置的 Codex 路径：${path}。`,
      invalidFallback: (configuredPath: string, detectedPath: string) =>
        `已配置的 Codex 路径无效或不可执行：${configuredPath}。本次测试改用 PATH 中的 Codex CLI：${detectedPath}。建议更新 CODEX_BIN 或清空自定义路径。`,
      failedFallback: (configuredPath: string, detectedPath: string) =>
        `已配置的 Codex 路径启动失败：${configuredPath}。本次测试改用 PATH 中的 Codex CLI：${detectedPath}。建议更新 CODEX_BIN 或清空自定义路径。`,
    };
  }
  if (locale === 'zh-TW') {
    return {
      repairHint: '目前儲存的 Codex 路徑不適合繼續使用。',
      useDetected: '使用偵測到的 Codex',
      clearCustom: '清除自訂路徑',
      configuredSuccess: (path: string) => `本次測試使用的是已設定的 Codex 路徑：${path}。`,
      invalidFallback: (configuredPath: string, detectedPath: string) =>
        `已設定的 Codex 路徑無效或不可執行：${configuredPath}。本次測試改用 PATH 中的 Codex CLI：${detectedPath}。建議更新 CODEX_BIN 或清除自訂路徑。`,
      failedFallback: (configuredPath: string, detectedPath: string) =>
        `已設定的 Codex 路徑啟動失敗：${configuredPath}。本次測試改用 PATH 中的 Codex CLI：${detectedPath}。建議更新 CODEX_BIN 或清除自訂路徑。`,
    };
  }
  return {
    repairHint: 'The saved Codex path is not the binary this test should keep using.',
    useDetected: 'Use detected Codex',
    clearCustom: 'Clear custom path',
    configuredSuccess: (path: string) =>
      `This test used the configured Codex path: ${path}.`,
    invalidFallback: (configuredPath: string, detectedPath: string) =>
      `Configured Codex path is invalid or not executable: ${configuredPath}. This test used the PATH Codex CLI at ${detectedPath}. Update CODEX_BIN or clear the custom path to use the detected binary.`,
    failedFallback: (configuredPath: string, detectedPath: string) =>
      `Configured Codex path failed: ${configuredPath}. This test succeeded with the PATH Codex CLI at ${detectedPath}. Update CODEX_BIN or clear the custom path to use the detected binary.`,
  };
}

export function sanitizeHttpsUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export type RescanNotice =
  | { kind: 'success'; count: number }
  | { kind: 'error' };

export type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: ConnectionTestResponse };

export type ProviderModelsState =
  | { status: 'idle' }
  | { status: 'running'; cacheKey: string }
  | { status: 'done'; cacheKey: string; result: ProviderModelsResponse };

export type ByokRequiredField = 'api_key' | 'base_url' | 'model';
export type ByokPreconditionAction = 'test';

// Map a test result to the visual severity of its inline status node so
// the same green/red/amber palette as the Rescan status applies.
export function testStatusVariant(
  result: ConnectionTestResponse,
): 'success' | 'warn' | 'error' {
  if (result.ok) return 'success';
  if (result.kind === 'rate_limited') return 'warn';
  return 'error';
}

export function shouldShowCustomModelInput(
  modelValue: string,
  knownModelIds: readonly string[],
  explicitCustomMode: boolean,
): boolean {
  return (
    explicitCustomMode ||
    !modelValue ||
    !knownModelIds.includes(modelValue)
  );
}

export function canRunProviderConnectionTest(
  config: Pick<AppConfig, 'apiKey' | 'baseUrl' | 'model'>,
  options: { requiresApiKey?: boolean } = {},
): boolean {
  const requiresApiKey = options.requiresApiKey ?? true;
  return (
    (!requiresApiKey || Boolean(config.apiKey.trim())) &&
    Boolean(config.baseUrl.trim()) &&
    Boolean(config.model.trim())
  );
}

export function canFetchProviderModels(
  config: Pick<AppConfig, 'apiKey' | 'baseUrl'>,
  protocol: ApiProtocol,
): boolean {
  return (
    protocol !== 'azure' &&
    protocol !== 'ollama' &&
    Boolean(config.apiKey.trim()) &&
    Boolean(config.baseUrl.trim()) &&
    isValidApiBaseUrl(config.baseUrl)
  );
}

export function missingByokConnectionFields(
  config: Pick<AppConfig, 'apiKey' | 'baseUrl' | 'model'>,
  options: { requiresApiKey?: boolean } = {},
): ByokRequiredField[] {
  const requiresApiKey = options.requiresApiKey ?? true;
  const missing: ByokRequiredField[] = [];
  if (requiresApiKey && !config.apiKey.trim()) missing.push('api_key');
  if (!config.baseUrl.trim()) missing.push('base_url');
  if (!config.model.trim()) missing.push('model');
  return missing;
}

export function missingByokModelFetchFields(
  config: Pick<AppConfig, 'apiKey' | 'baseUrl'>,
): ByokRequiredField[] {
  const missing: ByokRequiredField[] = [];
  if (!config.apiKey.trim()) missing.push('api_key');
  if (!config.baseUrl.trim()) missing.push('base_url');
  return missing;
}

export function providerModelsCacheKey(
  protocol: ApiProtocol,
  baseUrl: string,
  apiKey: string,
  apiVersion = '',
): string {
  return [
    protocol,
    baseUrl.trim().replace(/\/+$/, ''),
    apiKey,
    protocol === 'azure' ? apiVersion.trim() : '',
  ].join('\n');
}

export function providerConnectionTestKey(
  protocol: ApiProtocol,
  config: Pick<AppConfig, 'apiKey' | 'baseUrl' | 'model' | 'apiVersion'>,
): string {
  return [
    protocol,
    config.baseUrl.trim().replace(/\/+$/, ''),
    config.apiKey.trim(),
    config.model.trim(),
    protocol === 'azure' ? config.apiVersion?.trim() ?? '' : '',
  ].join('\n');
}

function isLocalOllamaBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

export function byokProviderRequiresApiKey(
  protocol: ApiProtocol,
  provider: KnownProvider | undefined,
  baseUrl: string,
): boolean {
  if (provider?.requiresApiKey === false) return false;
  if (protocol === 'ollama' && isLocalOllamaBaseUrl(baseUrl)) return false;
  return true;
}

export const API_KEY_CONSOLE_LINKS: Record<ApiProtocol, { host: string; url: string }> = {
  anthropic: {
    host: 'console.anthropic.com',
    url: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    host: 'platform.openai.com',
    url: 'https://platform.openai.com/api-keys',
  },
  azure: {
    host: 'portal.azure.com',
    url: 'https://portal.azure.com/',
  },
  google: {
    host: 'aistudio.google.com',
    url: 'https://aistudio.google.com/apikey',
  },
  ollama: {
    host: 'ollama.com',
    url: 'https://ollama.com/settings/keys',
  },
  senseaudio: {
    host: 'docs.senseaudio.cn',
    url: 'https://docs.senseaudio.cn',
  },
};

export const AGENT_SHORT_DESCRIPTIONS: Record<string, string> = {
  claude: 'Anthropic official CLI',
  codex: 'OpenAI official CLI',
  'cursor-agent': 'Cursor command line',
  gemini: 'Google official CLI',
  opencode: 'Open-source agent CLI',
  qwen: 'Qwen coding CLI',
  copilot: 'GitHub coding CLI',
  devin: 'Cognition terminal CLI',
  kimi: 'Moonshot Kimi CLI',
  qoder: 'Alibaba coding CLI',
  pi: 'Inflection chat CLI',
  kiro: 'Kiro agent CLI',
  kilo: 'Kilo Code CLI',
  vibe: 'Mistral open-source CLI',
  deepseek: 'DeepSeek terminal UI',
  hermes: 'ACP agent CLI',
  'grok-build': 'xAI coding CLI',
};

export function cleanAgentVersionLabel(
  name: string,
  version: string | null | undefined,
): string {
  if (!version) return '';
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return version
    .replace(new RegExp(`\\s*\\(${escapedName}\\)\\s*$`, 'i'), '')
    .replace(new RegExp(`\\s+${escapedName}\\s*$`, 'i'), '')
    .trim();
}

export function mergeProviderModelOptions(
  fetchedModels: readonly ProviderModelOption[],
  suggestedModelIds: readonly string[],
): ProviderModelOption[] {
  const seen = new Set<string>();
  const out: ProviderModelOption[] = [];
  const add = (model: ProviderModelOption) => {
    const id = model.id.trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: model.label.trim() || id });
  };
  for (const model of fetchedModels) add(model);
  for (const id of suggestedModelIds) add({ id, label: id });
  return out;
}

export const AGENT_CLI_ENV_FIELDS = [
  {
    agentId: 'claude',
    envKey: 'CLAUDE_CONFIG_DIR',
    labelKey: 'settings.cliEnvClaudeConfigDir',
    placeholder: '~/.claude-2',
  },
  {
    agentId: 'claude',
    envKey: 'ANTHROPIC_BASE_URL',
    labelKey: 'settings.cliEnvClaudeBaseUrl',
    placeholder: 'https://your-proxy.example.com',
  },
  {
    agentId: 'claude',
    envKey: 'ANTHROPIC_API_KEY',
    labelKey: 'settings.cliEnvClaudeApiKey',
    placeholder: 'Paste proxy API key',
    secret: true,
  },
  {
    agentId: 'codex',
    envKey: 'CODEX_HOME',
    labelKey: 'settings.cliEnvCodexHome',
    placeholder: '~/.codex-alt',
  },
  {
    agentId: 'codex',
    envKey: 'CODEX_BIN',
    labelKey: 'settings.cliEnvCodexBin',
    placeholder: '/absolute/path/to/codex',
  },
  {
    agentId: 'codex',
    envKey: 'OPENAI_BASE_URL',
    labelKey: 'settings.cliEnvCodexBaseUrl',
    placeholder: 'https://your-proxy.example.com/v1',
  },
  {
    agentId: 'codex',
    envKey: 'CODEX_API_KEY',
    labelKey: 'settings.cliEnvCodexApiKey',
    labelSuffix: 'CODEX_API_KEY',
    placeholder: 'Paste CODEX_API_KEY',
    secret: true,
  },
  {
    agentId: 'codex',
    envKey: 'OPENAI_API_KEY',
    labelKey: 'settings.cliEnvCodexApiKey',
    labelSuffix: 'OPENAI_API_KEY · proxy/legacy',
    placeholder: 'Paste OPENAI_API_KEY',
    secret: true,
  },
] as const;

function defaultApiProtocolConfig(protocol: ApiProtocol): ApiProtocolConfig {
  const provider = KNOWN_PROVIDERS.find((p) => p.protocol === protocol);
  return {
    apiKey: '',
    baseUrl: provider?.baseUrl ?? '',
    model: provider?.model ?? '',
    apiVersion: '',
    apiProviderBaseUrl: provider ? provider.baseUrl : null,
  };
}

function providerFamilyLabel(provider: KnownProvider): string {
  return provider.label.replace(/\s+—\s+(Anthropic|OpenAI)$/u, '');
}

function siblingProviderForProtocol(
  providerBaseUrl: string | null | undefined,
  protocol: ApiProtocol,
): KnownProvider | null {
  if (!providerBaseUrl) return null;
  const currentProvider = KNOWN_PROVIDERS.find(
    (p) => p.baseUrl === providerBaseUrl,
  );
  if (!currentProvider) return null;

  const currentFamily = providerFamilyLabel(currentProvider);
  return (
    KNOWN_PROVIDERS.find(
      (p) => p.protocol === protocol && providerFamilyLabel(p) === currentFamily,
    ) ?? null
  );
}

function nextApiProtocolConfig(
  config: AppConfig,
  protocol: ApiProtocol,
): ApiProtocolConfig {
  const savedConfig = config.apiProtocolConfigs?.[protocol];
  if (savedConfig) return savedConfig;

  const currentConfig = currentApiProtocolConfig(config);
  const siblingProvider = siblingProviderForProtocol(
    currentConfig.apiProviderBaseUrl,
    protocol,
  );
  if (siblingProvider) {
    return {
      ...defaultApiProtocolConfig(protocol),
      baseUrl: siblingProvider.baseUrl,
      model: siblingProvider.model,
      apiProviderBaseUrl: siblingProvider.baseUrl,
    };
  }

  if (currentConfig.apiProviderBaseUrl === null) {
    return {
      ...currentConfig,
      apiKey: '',
      apiVersion: protocol === 'azure' ? currentConfig.apiVersion : '',
      apiProviderBaseUrl: null,
    };
  }

  return {
    ...defaultApiProtocolConfig(protocol),
  };
}

function currentApiProtocolConfig(config: AppConfig): ApiProtocolConfig {
  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    apiVersion: config.apiVersion ?? '',
    apiProviderBaseUrl: config.apiProviderBaseUrl ?? null,
    byokImageModel: config.byokImageModel ?? '',
  };
}

function applyApiProtocolConfig(
  config: AppConfig,
  protocol: ApiProtocol,
  apiConfig: ApiProtocolConfig,
): AppConfig {
  return {
    ...config,
    apiProtocol: protocol,
    apiKey: apiConfig.apiKey,
    baseUrl: apiConfig.baseUrl,
    model: apiConfig.model,
    apiProviderBaseUrl: apiConfig.apiProviderBaseUrl ?? null,
    apiVersion: protocol === 'azure' ? (apiConfig.apiVersion ?? '') : '',
    // byokImageModel is SenseAudio-only — flipping to another BYOK tab
    // shouldn't carry a SenseAudio image-model choice into, say, the
    // OpenAI form. Mirrors the apiVersion guarding above.
    byokImageModel:
      protocol === 'senseaudio' ? (apiConfig.byokImageModel ?? '') : '',
  };
}

export function isValidApiBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  const result = validateBaseUrl(trimmed);
  return Boolean(result.parsed && !result.error);
}

export function updateCurrentApiProtocolConfig(
  config: AppConfig,
  patch: Partial<ApiProtocolConfig>,
): AppConfig {
  const protocol = config.apiProtocol ?? 'anthropic';
  const nextApiConfig: ApiProtocolConfig = {
    ...currentApiProtocolConfig(config),
    ...patch,
  };
  return applyApiProtocolConfig(
    {
      ...config,
      apiProtocolConfigs: {
        ...(config.apiProtocolConfigs ?? {}),
        [protocol]: nextApiConfig,
      },
    },
    protocol,
    nextApiConfig,
  );
}

export function updateAgentCliEnvValue(
  config: AppConfig,
  agentId: string,
  envKey: string,
  rawValue: string,
): AppConfig {
  const value = rawValue.trim();
  const agentCliEnv = { ...(config.agentCliEnv ?? {}) };
  const nextAgentEnv = { ...(agentCliEnv[agentId] ?? {}) };
  if (value) {
    nextAgentEnv[envKey] = value;
  } else {
    delete nextAgentEnv[envKey];
  }

  if (Object.keys(nextAgentEnv).length > 0) {
    agentCliEnv[agentId] = nextAgentEnv;
  } else {
    delete agentCliEnv[agentId];
  }

  return {
    ...config,
    agentCliEnv: Object.keys(agentCliEnv).length > 0 ? agentCliEnv : {},
  };
}

export function agentRefreshOptionsForConfig(cfg: AppConfig): AgentRefreshOptions {
  return {
    throwOnError: true,
    agentCliEnv: cfg.agentCliEnv ?? {},
  };
}

export function apiModelOptionLabel(model: ProviderModelOption): string {
  return model.label && model.label !== model.id
    ? `${model.label} (${model.id})`
    : model.id;
}

export function codexPathRepairState(
  result: ConnectionTestResponse,
): { detectedPath: string; canUseDetected: boolean } | null {
  if (!result.ok) return null;
  if (
    result.usedExecutableSource !== 'fallback_invalid' &&
    result.usedExecutableSource !== 'fallback_failed'
  ) {
    return null;
  }
  const detectedPath = result.detectedExecutablePath?.trim() || '';
  if (!detectedPath) return null;
  return {
    detectedPath,
    canUseDetected: true,
  };
}

/**
 * Returns whether the modal's footer Save button should be enabled for the
 * currently active sidebar section.
 *
 * The mode-completeness check (BYOK requires apiKey + model + valid baseUrl;
 * Local CLI requires a selected available agent) is only meaningful on the
 * execution-mode section, where the user is actively editing those fields.
 * On every other sidebar section (language, appearance, composio, media,
 * integrations, notifications, pet, library, about), partial state from a
 * draft mode toggle (e.g. user clicked BYOK on the execution section without
 * filling in fields, then navigated to language) must NOT block saving
 * changes the user is making in those unrelated sections. Issue #739.
 */
export function shouldEnableSettingsSave(
  cfg: AppConfig,
  activeSection: SettingsSection,
  agents: ReadonlyArray<{ id: string; available: boolean }>,
  isBaseUrlValid: boolean,
): boolean {
  if (activeSection !== 'execution') return true;
  if (cfg.mode === 'daemon') {
    return Boolean(
      cfg.agentId && agents.find((a) => a.id === cfg.agentId)?.available,
    );
  }
  return Boolean(cfg.apiKey.trim() && cfg.model.trim() && isBaseUrlValid);
}

/**
 * Returns the config that should actually be persisted by `onSave`.
 *
 * Counterpart to {@link shouldEnableSettingsSave}: when Save is enabled on a
 * non-execution sidebar section but the user's draft execution config is
 * incomplete (e.g. they toggled BYOK on the execution section, never filled
 * in apiKey, then navigated to Language and clicked Save), the raw `cfg`
 * still carries that broken draft. Persisting it would leave the app in an
 * unusable execution state after the modal closes. This helper reverts the
 * execution-related fields to their `initial` values in that case, so saving
 * an unrelated section change never silently commits an incomplete execution
 * mode.
 *
 * Within the execution section, or when execution is already valid, the
 * config passes through unchanged. Issue #739.
 */
export function sanitizeSettingsSavePayload(
  cfg: AppConfig,
  initial: AppConfig,
  activeSection: SettingsSection,
  agents: ReadonlyArray<{ id: string; available: boolean }>,
  isBaseUrlValid: boolean,
): AppConfig {
  if (activeSection === 'execution') return cfg;
  // Reuse the existing execution-section validity gate so the two helpers
  // share one source of truth for "execution config is complete enough."
  const executionValid = shouldEnableSettingsSave(cfg, 'execution', agents, isBaseUrlValid);
  if (executionValid) return cfg;
  return {
    ...cfg,
    mode: initial.mode,
    apiKey: initial.apiKey,
    apiProtocol: initial.apiProtocol,
    apiVersion: initial.apiVersion,
    apiProtocolConfigs: initial.apiProtocolConfigs,
    apiProviderBaseUrl: initial.apiProviderBaseUrl,
    baseUrl: initial.baseUrl,
    model: initial.model,
    agentId: initial.agentId,
    agentCliEnv: initial.agentCliEnv,
    maxTokens: initial.maxTokens,
  };
}

export function switchApiProtocolConfig(
  config: AppConfig,
  protocol: ApiProtocol,
): AppConfig {
  const currentProtocol = config.apiProtocol ?? 'anthropic';
  const apiProtocolConfigs = {
    ...(config.apiProtocolConfigs ?? {}),
    [currentProtocol]: currentApiProtocolConfig(config),
  };
  const nextApiConfig = nextApiProtocolConfig(
    {
      ...config,
      apiProtocolConfigs,
    },
    protocol,
  );
  return applyApiProtocolConfig(
    {
      ...config,
      mode: 'api',
      apiProtocolConfigs,
    },
    protocol,
    nextApiConfig,
  );
}
