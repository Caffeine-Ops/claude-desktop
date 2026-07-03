// `{{key}}` plugin-input placeholder matcher. The `g` flag makes the
// regex stateful (mutable `lastIndex`), and it has readers in several
// sibling modules (HomeHero, promptOverlay, presets) — so it lives in
// its own module to stay a single shared instance instead of being
// duplicated per file. Callers reset `lastIndex` before exec() loops,
// exactly as they did when everything was one file.
export const INPUT_PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g;
