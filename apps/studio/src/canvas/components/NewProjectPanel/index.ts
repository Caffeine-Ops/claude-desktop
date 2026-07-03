// Barrel for the NewProjectPanel directory split. Re-exports exactly the
// public surface the original single-file NewProjectPanel.tsx exposed —
// intra-directory helpers (controls, metadata builders, sub-pickers) are
// exported by their own modules for internal reuse but intentionally not
// re-exported here.
export type { CreateInput, CreateTab, MediaSurface } from './types';
export {
  buildDesignSystemCreateSelection,
  defaultDesignSystemSelection,
  NewProjectPanel,
} from './NewProjectPanel';
export { supportedModels } from './MediaProjectOptions';
