// Barrel for the ProjectView split (was a single 4200-line ProjectView.tsx).
// Re-exports exactly the original module's public surface so the existing
// `./components/ProjectView` import in App.tsx resolves unchanged.
export { ProjectView } from './ProjectView';
export { projectSplitClassName } from './layout';
export {
  clearStreamingConversationMarker,
  computeProducedFiles,
  finalizeActiveAssistantMessagesOnStop,
  findExistingArtifactProjectFile,
  mergeRecoveredArtifact,
  resolveRetryTarget,
  resolveSucceededRunStatus,
  shouldClearActiveRunRefs,
} from './runRecovery';
export type { RetryTarget } from './runRecovery';
