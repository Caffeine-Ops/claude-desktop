// Barrel for the FileViewer directory. Re-exports exactly the public surface
// the original single-file FileViewer.tsx exposed — nothing more.
export { FileViewer } from './FileViewer';
export { LiveArtifactViewer, LiveArtifactRefreshHistoryPanel } from './LiveArtifactViewer';
export { CommentSidePanel } from './CommentSidePanel';
export { CommentTargetOverlay } from './comment-overlays';
export { SvgViewer } from './media-viewers';
export { effectivePreviewScale } from './preview-viewport';
export { cancelManualEditPendingStyleSnapshot } from './manual-edit-helpers';
export {
  applyInspectOverridesToSource,
  parseInspectOverridesFromSource,
  serializeInspectOverrides,
  updateInspectOverride,
} from './inspect-overrides';
export type { InspectOverrideEntry, InspectOverrideMap } from './inspect-overrides';
export type { ManualEditPendingStyleSave } from './types';
