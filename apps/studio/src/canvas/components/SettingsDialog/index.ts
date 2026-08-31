// Barrel for the SettingsDialog module (mechanical split of the former
// single-file components/SettingsDialog.tsx). Re-exports exactly the set
// of names the original file exported — nothing more: helpers/components
// that were file-private before the split stay directory-internal.
export { SettingsDialog } from './SettingsDialog';
export type {
  AgentRefreshOptions,
  SettingsDialogProps,
  SettingsSection,
} from './settingsHelpers';
export {
  agentRefreshOptionsForConfig,
  canFetchProviderModels,
  canRunProviderConnectionTest,
  isValidApiBaseUrl,
  mergeProviderModelOptions,
  providerModelsCacheKey,
  sanitizeSettingsSavePayload,
  shouldEnableSettingsSave,
  shouldShowCustomModelInput,
  switchApiProtocolConfig,
  testStatusVariant,
  updateAgentCliEnvValue,
  updateCurrentApiProtocolConfig,
  // useTt 是本次（2026-08-31）新增的唯一对外 helper：SettingsDialogV2 在 settings/
  // 目录，与本目录内的新 section 共用它，走 barrel 而不是深导入内部文件。
  useTt,
} from './settingsHelpers';
export type { ComposioCredentialState } from './ConnectorSection';
export {
  ConnectorSection,
  deriveComposioCredentialState,
} from './ConnectorSection';
export {
  configForManualOrbitRun,
  isOrbitRunDisabled,
  persistConfigAndRunOrbit,
} from './OrbitSection';
