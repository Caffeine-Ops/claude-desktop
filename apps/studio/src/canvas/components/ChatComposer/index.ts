// Barrel for the ChatComposer/ split (2026-07-03). Re-exports exactly the
// public surface of the original single-file ChatComposer.tsx — internal
// helpers (staged chips, tools panels, popovers, matchers) stay private.
export { ChatComposer } from './ChatComposer';
export type { ChatComposerHandle, ChatSendMeta } from './ChatComposer';
