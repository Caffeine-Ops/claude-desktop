import type { ConnectorDetail } from '@open-design/contracts';
import { uploadProjectFile, writeProjectTextFile } from '../../providers/registry';
import { patchProject } from '../../state/projects';
import type { DesignSystemProvenance, Project, ProjectMetadata } from '../../types';
import { getDisplayableGithubAccountLabel, isGithubConnectorConnected } from './github-access';

export interface SetupState {
  company: string;
  githubUrl: string;
  githubUrls: string[];
  codeFiles: string[];
  codeFolders: string[];
  codeFileObjects: File[];
  figFiles: string[];
  figFileObjects: File[];
  assetFiles: string[];
  assetFileObjects: File[];
  notes: string;
}

const LOCAL_CODE_UPLOAD_ROOT = 'context/local-code';
const FIGMA_CONTEXT_ROOT = 'context/figma';
const ASSET_UPLOAD_ROOT = 'assets';
const SOURCE_CONTEXT_MANIFEST_PATH = 'context/source-context.md';
const MAX_LOCAL_CODE_UPLOAD_FILES = 120;
const MAX_LOCAL_CODE_FILE_BYTES = 1024 * 1024;
const MAX_FIGMA_CONTEXT_FILES = 10;
const MAX_FIGMA_PARSE_BYTES = 512 * 1024;
const MAX_ASSET_UPLOAD_FILES = 80;
const MAX_ASSET_FILE_BYTES = 12 * 1024 * 1024;

const UI_KIT_ENTRY_CONTRACT = [
  'Claude-style UI-kit entry contract:',
  '- When `ui_kits/app/components/*.jsx` or `*.tsx` files exist, `ui_kits/app/index.html` must behave like a runnable browser entry, not a static mock.',
  '- Use the same structure as Claude Design exports: load React, ReactDOM, and Babel standalone scripts, load `../../colors_and_type.css`, create a `#root`, load each component script from `components/`, then render the composed `App` component.',
  '- `App.jsx` must assign `window.App = App` (or `globalThis.App = App`), and every directly loaded component file must expose the same browser global for its component name.',
  '- Use this skeleton for direct JSX component kits, replacing the component list only when evidence supports different names:',
  '```html',
  '<script src="https://unpkg.com/react@18.3.1/umd/react.development.js"></script>',
  '<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js"></script>',
  '<script src="https://unpkg.com/@babel/standalone@7.29.0/babel.min.js"></script>',
  '<link rel="stylesheet" href="../../colors_and_type.css">',
  '<div id="root"></div>',
  '<script type="text/babel" src="components/Sidebar.jsx"></script>',
  '<script type="text/babel" src="components/AssistantsList.jsx"></script>',
  '<script type="text/babel" src="components/ChatArea.jsx"></script>',
  '<script type="text/babel" src="components/MessageBubble.jsx"></script>',
  '<script type="text/babel" src="components/InputBar.jsx"></script>',
  '<script type="text/babel" src="components/App.jsx"></script>',
  '<script type="text/babel">',
  'const { App } = window;',
  "const root = ReactDOM.createRoot(document.getElementById('root'));",
  'root.render(<App />);',
  '</script>',
  '```',
].join('\n');

const BUILD_ASSET_PRESERVATION_CONTRACT = [
  'Claude-style build asset contract:',
  '- When evidence includes `context/.../files/build/...`, create a root `build/` directory and copy representative runtime assets there with their original filenames and path intent, such as `build/icon.png`, `build/logo.png`, `build/tray_icon.png`, and `build/icon.ico`.',
  '- Copy those runtime assets byte-for-byte from the captured `context/.../files/...` snapshots. Do not redraw, re-encode, optimize, or substitute generated placeholders for files that the evidence already captured.',
  '- Do not satisfy build/runtime icon evidence by only renaming those files into `assets/`. `assets/` may include convenience aliases, but root `build/` must preserve the source runtime files for future agents and package consumers.',
  '- `preview/brand-assets.html` should reference at least some real preserved files from `build/` or `assets/` with `<img>`, `<picture>`, `<object>`, or CSS `url(...)`, and README.md / SKILL.md should mention `build/` in the package manifest when it exists.',
].join('\n');

export function inferDesignSystemTitle(state: SetupState): string {
  const clean = state.company.trim().replace(/\s+/g, ' ');
  const contextTitle = titleCandidateFromCompanyContext(clean);
  if (contextTitle) return designSystemTitle(contextTitle);

  const githubTitle = githubRepoTitleFromText(clean)
    ?? githubUrlsFromState(state).map(githubRepoTitleFromUrl).find((title): title is string => Boolean(title));
  if (githubTitle) return designSystemTitle(githubTitle);

  const urlTitle = genericUrlTitleFromText(clean);
  if (urlTitle) return designSystemTitle(urlTitle);

  return designSystemTitle(clean.split(/\s+/).slice(0, 4).join(' ') || 'Product');
}

function titleCandidateFromCompanyContext(clean: string): string | undefined {
  if (!clean || /^https?:\/\//iu.test(clean) || githubRepoTitleFromText(clean)) return undefined;
  const beforeColon = clean.split(':')[0]?.trim();
  if (beforeColon && !/^https?$/iu.test(beforeColon) && beforeColon.length <= 48) return beforeColon;
  return clean.split(/\s+/).slice(0, 4).join(' ') || undefined;
}

function designSystemTitle(title: string): string {
  const clean = title.trim().replace(/\s+/g, ' ');
  if (!clean) return 'Product Design System';
  return /design system$/iu.test(clean) ? clean : `${clean} Design System`;
}

function githubRepoTitleFromText(text: string): string | undefined {
  const match = /(?:https?:\/\/)?github\.com[:/]([^/\s]+)\/([^/\s#?]+)(?:\.git)?(?=$|[/?#\s])/iu.exec(text);
  return match ? humanizeRepositoryName(match[2] ?? '') : undefined;
}

function githubRepoTitleFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return humanizeRepositoryName(parts[1] ?? '');
  } catch {
    const shorthand = /(?:^|\s)([^/\s]+)\/([^/\s#?]+)(?:\.git)?(?:\s|$)/iu.exec(url);
    if (shorthand) return humanizeRepositoryName(shorthand[2] ?? '');
  }
  return undefined;
}

function genericUrlTitleFromText(text: string): string | undefined {
  const match = /https?:\/\/[^\s]+/iu.exec(text);
  if (!match) return undefined;
  try {
    const parsed = new URL(match[0]);
    const host = parsed.hostname.replace(/^www\./iu, '').split('.')[0] ?? '';
    return humanizeRepositoryName(host);
  } catch {
    return undefined;
  }
}

export function scheduleAfterProjectHandoff(task: () => void): void {
  if (typeof window === 'undefined') {
    task();
    return;
  }
  const run = () => window.setTimeout(task, 0);
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(run);
    return;
  }
  run();
}

export async function prepareCreatedDesignSystemProject({
  project,
  state,
  composioConfigured,
  githubConnector,
  onProjectPrepared,
  onSystemsRefresh,
}: {
  project: Project;
  state: SetupState;
  composioConfigured: boolean;
  githubConnector: ConnectorDetail | null;
  onProjectPrepared?: (project: Project) => void;
  onSystemsRefresh?: () => Promise<void> | void;
}): Promise<void> {
  try {
    const stagedLocalCode = await stageLocalCodeFiles(project.id, state.codeFileObjects);
    const stagedFigma = await stageFigmaFiles(project.id, state.figFileObjects);
    const stagedAssets = await stageAssetFiles(project.id, state.assetFileObjects);
    await writeProjectTextFile(
      project.id,
      SOURCE_CONTEXT_MANIFEST_PATH,
      buildSourceContextManifest(state, {
        composioConfigured,
        githubConnector,
        stagedLocalCode,
        stagedFigma,
        stagedAssets,
      }),
    );
    const metadata = mergeLinkedCodeFolders(project.metadata, state.codeFolders);
    const prompt = buildCreationAgentPrompt(
      state,
      stagedLocalCode,
      SOURCE_CONTEXT_MANIFEST_PATH,
      stagedAssets,
      stagedFigma,
    );
    const preparedProject = await patchProject(project.id, { pendingPrompt: prompt, metadata });
    try {
      window.sessionStorage.setItem(`od:auto-send-first:${project.id}`, '1');
    } catch {
      // If sessionStorage is unavailable, the project still opens with the
      // pending prompt ready for the user to send manually.
    }
    onProjectPrepared?.(preparedProject ?? {
      ...project,
      pendingPrompt: prompt,
      metadata,
    });
    void onSystemsRefresh?.();
  } catch (err) {
    console.error('Could not prepare the design system project after opening it.', err);
  }
}

function humanizeRepositoryName(repo: string): string | undefined {
  const words = repo.replace(/\.git$/iu, '').replace(/[-_]+/gu, ' ').trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return undefined;
  return words.map(titleCaseRepositoryWord).join(' ');
}

function titleCaseRepositoryWord(word: string): string {
  if (/^(ai|api|cli|css|html|js|llm|mcp|sdk|ui|url|ux)$/iu.test(word)) return word.toUpperCase();
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
}

export function normalizeGithubUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    return url.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/\/$/, '');
  }
}

export function githubRepoLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  } catch {
    // User-entered shorthand can still be useful context for the agent.
  }
  return url;
}

function githubUrlsFromState(state: SetupState): string[] {
  return Array.from(new Set([
    ...state.githubUrls,
    ...(state.githubUrl.trim() ? [normalizeGithubUrl(state.githubUrl)] : []),
  ].filter(Boolean)));
}

interface StagedLocalCodeContext {
  uploadedPaths: string[];
  skippedCount: number;
}

interface StagedFigmaContext {
  summaryPaths: string[];
  skippedCount: number;
}

interface FigmaLocalSummary {
  name: string;
  size: number;
  lastModified: number;
  parseBytes: number;
  colors: string[];
  textStyles: string[];
  namedLayers: string[];
  componentHints: string[];
  readableSample: string;
}

interface StagedAssetContext {
  uploadedPaths: string[];
  skippedCount: number;
}

const LOCAL_CODE_SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.turbo',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

export function localCodeRelativePath(file: File): string {
  const browserPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return normalizeLocalCodePath(browserPath || file.name);
}

export function normalizeLocalCodePath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
}

function shouldStageLocalCodeFile(file: File): boolean {
  const relativePath = localCodeRelativePath(file);
  if (!relativePath) return false;
  if (file.size > MAX_LOCAL_CODE_FILE_BYTES) return false;
  const parts = relativePath.split('/');
  return !parts.some((part) => LOCAL_CODE_SKIP_DIRS.has(part));
}

export function selectLocalCodeFiles(files: File[]): File[] {
  return dedupeLocalCodeFiles(files.filter(shouldStageLocalCodeFile)).slice(0, MAX_LOCAL_CODE_UPLOAD_FILES);
}

export function dedupeLocalCodeFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const next: File[] = [];
  for (const file of files) {
    const key = `${localCodeRelativePath(file)}:${file.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(file);
  }
  return next;
}

export function resourceRelativePath(file: File): string {
  const browserPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return normalizeLocalCodePath(browserPath || file.name);
}

function shouldStageAssetFile(file: File): boolean {
  const relativePath = resourceRelativePath(file);
  if (!relativePath) return false;
  if (file.size > MAX_ASSET_FILE_BYTES) return false;
  const parts = relativePath.split('/');
  return !parts.some((part) => LOCAL_CODE_SKIP_DIRS.has(part));
}

export function selectAssetFiles(files: File[]): File[] {
  return dedupeResourceFiles(files.filter(shouldStageAssetFile)).slice(0, MAX_ASSET_UPLOAD_FILES);
}

export function selectFigmaFiles(files: File[]): File[] {
  return dedupeResourceFiles(
    files.filter((file) => resourceRelativePath(file).toLowerCase().endsWith('.fig')),
  ).slice(0, MAX_FIGMA_CONTEXT_FILES);
}

export function dedupeResourceFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const next: File[] = [];
  for (const file of files) {
    const key = `${resourceRelativePath(file)}:${file.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(file);
  }
  return next;
}

function safeContextFileName(name: string, fallback: string): string {
  const leaf = name.split('/').filter(Boolean).pop() ?? fallback;
  const base = leaf.replace(/\.[^.]+$/, '');
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return `${slug || fallback}.md`;
}

export function localCodeSourceLabels(state: SetupState): string[] {
  return [
    ...state.codeFolders,
    ...(state.codeFiles.length ? [`${state.codeFiles.length} local code files selected`] : []),
  ];
}

function localCodeReferences(state: SetupState): string[] {
  return Array.from(new Set([...state.codeFolders, ...state.codeFiles]));
}

function mergeLinkedCodeFolders(metadata: ProjectMetadata | undefined, codeFolders: string[]): ProjectMetadata | undefined {
  if (codeFolders.length === 0) return metadata;
  return {
    kind: metadata?.kind ?? 'other',
    ...metadata,
    linkedDirs: Array.from(new Set([...(metadata?.linkedDirs ?? []), ...codeFolders])),
  };
}

async function stageLocalCodeFiles(projectId: string, files: File[]): Promise<StagedLocalCodeContext> {
  if (files.length === 0) return { uploadedPaths: [], skippedCount: 0 };
  const selected = selectLocalCodeFiles(files);
  const uploadedPaths: string[] = [];
  for (const file of selected) {
    const desiredName = `${LOCAL_CODE_UPLOAD_ROOT}/${localCodeRelativePath(file)}`;
    const uploaded = await uploadProjectFile(projectId, file, desiredName);
    if (uploaded) {
      uploadedPaths.push(uploaded.name);
    }
  }
  return {
    uploadedPaths,
    skippedCount: Math.max(0, files.length - selected.length),
  };
}

async function stageFigmaFiles(projectId: string, files: File[]): Promise<StagedFigmaContext> {
  if (files.length === 0) return { summaryPaths: [], skippedCount: 0 };
  const selected = selectFigmaFiles(files);
  const summaryPaths: string[] = [];
  for (const file of selected) {
    const summary = await summarizeFigmaFile(file);
    const desiredName = `${FIGMA_CONTEXT_ROOT}/${safeContextFileName(resourceRelativePath(file), 'figma-file')}`;
    const written = await writeProjectTextFile(projectId, desiredName, renderFigmaSummary(summary));
    if (written) {
      summaryPaths.push(written.name);
    }
  }
  return {
    summaryPaths,
    skippedCount: Math.max(0, files.length - selected.length),
  };
}

async function summarizeFigmaFile(file: File): Promise<FigmaLocalSummary> {
  const parseBytes = Math.min(file.size, MAX_FIGMA_PARSE_BYTES);
  let readable = '';
  try {
    readable = await file.slice(0, parseBytes).text();
  } catch {
    readable = '';
  }
  const normalized = readable
    .replace(/[^\t\n\r\x20-\x7e]+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const namedLayers = uniqueMatches(normalized, /"name"\s*:\s*"([^"]{2,80})"/g, 40);
  const textStyles = uniqueMatches(
    normalized,
    /"(?:fontFamily|fontPostScriptName|fontName|family|styleName)"\s*:\s*"([^"]{2,80})"/g,
    30,
  );
  const colors = Array.from(new Set(normalized.match(/#[0-9a-fA-F]{6,8}\b/g) ?? [])).slice(0, 40);
  const componentHints = namedLayers
    .filter((name) => /(button|card|modal|dialog|input|nav|tab|menu|toast|badge|avatar|table|list|toolbar|sidebar)/i.test(name))
    .slice(0, 30);
  return {
    name: resourceRelativePath(file),
    size: file.size,
    lastModified: file.lastModified,
    parseBytes,
    colors,
    textStyles,
    namedLayers,
    componentHints,
    readableSample: normalized.slice(0, 1600),
  };
}

function uniqueMatches(text: string, pattern: RegExp, limit: number): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(pattern)) {
    const value = match[1]?.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

function renderFigmaSummary(summary: FigmaLocalSummary): string {
  return [
    `# Figma Source Summary: ${summary.name}`,
    '',
    'The original .fig source was parsed locally in the browser. This markdown summary is the only Figma-derived context copied into the design-system project.',
    '',
    '## File',
    '',
    `- Name: ${summary.name}`,
    `- Size: ${formatBytes(summary.size)}`,
    `- Last modified: ${summary.lastModified ? new Date(summary.lastModified).toISOString() : 'unknown'}`,
    `- Local parse window: ${formatBytes(summary.parseBytes)}`,
    '',
    '## Extracted Signals',
    '',
    summary.colors.length ? `Colors:\n${summary.colors.map((color) => `- ${color}`).join('\n')}` : 'Colors: no readable color tokens found.',
    '',
    summary.textStyles.length ? `Text styles and font names:\n${summary.textStyles.map((style) => `- ${style}`).join('\n')}` : 'Text styles and font names: no readable text-style tokens found.',
    '',
    summary.componentHints.length ? `Component-like layer names:\n${summary.componentHints.map((name) => `- ${name}`).join('\n')}` : 'Component-like layer names: no obvious component names found.',
    '',
    summary.namedLayers.length ? `Readable layer names:\n${summary.namedLayers.map((name) => `- ${name}`).join('\n')}` : 'Readable layer names: no readable layer names found.',
    '',
    '## Readable Sample',
    '',
    summary.readableSample
      ? `\`\`\`text\n${summary.readableSample}\n\`\`\``
      : 'No readable text sample was available from the local parse window. Ask for screenshots, exports, or a Figma link if visual evidence is required.',
    '',
  ].join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

async function stageAssetFiles(projectId: string, files: File[]): Promise<StagedAssetContext> {
  if (files.length === 0) return { uploadedPaths: [], skippedCount: 0 };
  const selected = selectAssetFiles(files);
  const uploadedPaths: string[] = [];
  for (const file of selected) {
    const desiredName = `${ASSET_UPLOAD_ROOT}/${resourceRelativePath(file)}`;
    const uploaded = await uploadProjectFile(projectId, file, desiredName);
    if (uploaded) {
      uploadedPaths.push(uploaded.name);
    }
  }
  return {
    uploadedPaths,
    skippedCount: Math.max(0, files.length - selected.length),
  };
}

export function buildSourceNotes(state: SetupState): string {
  const githubUrls = githubUrlsFromState(state);
  const localCode = localCodeReferences(state);
  return [
    githubUrls.length ? `GitHub/code: ${githubUrls.join(', ')}` : '',
    localCode.length ? `Local code: ${localCode.join(', ')}` : '',
    state.figFiles.length ? `Figma files: ${state.figFiles.join(', ')}` : '',
    state.assetFiles.length ? `Fonts, logos and assets: ${state.assetFiles.join(', ')}` : '',
    state.notes.trim() ? `Additional notes: ${state.notes.trim()}` : '',
  ].filter(Boolean).join('\n');
}

function buildCreationAgentPrompt(
  state: SetupState,
  stagedLocalCode?: StagedLocalCodeContext,
  sourceContextManifestPath?: string,
  stagedAssets?: StagedAssetContext,
  stagedFigma?: StagedFigmaContext,
): string {
  const sourceNotes = buildSourceNotes(state);
  const githubUrls = githubUrlsFromState(state);
  const localCode = localCodeReferences(state);
  const githubRunbook = buildGithubConnectorRunbook(githubUrls);
  const localFolderRunbook = buildLocalFolderRunbook(state.codeFolders);
  const title = inferDesignSystemTitle(state);
  return [
    'Create this project as a complete Open Design design system workspace.',
    '',
    'Autonomy requirement:',
    '- Do not ask setup or clarification questions during design-system generation.',
    '- Do not emit `<question-form>`, "Quick brief — 30 seconds", `AskUserQuestion`, direction cards, choice cards, or any UI that waits for user input.',
    '- The setup page already collected the brief. If target surfaces, review priority, or workspace depth are missing, choose sensible defaults and begin generating the design-system artifacts immediately.',
    '',
    'Project boundary:',
    '- All GitHub extraction, local evidence intake, source reading, design-system construction, package audit, and final artifact writes must happen inside this project workspace and this project chat run.',
    '- Treat `/design-systems/create` as setup only. Do not depend on that page for progress, review, or generated output; the project is the source of truth.',
    '',
    'Use the files in this project as the design system source for future projects. Update `DESIGN.md` as the canonical rules document, and update supporting files when they make the system easier to review or reuse.',
    '',
    'Expected output:',
    '- A clear `DESIGN.md` with product context, visual foundations, color, type, spacing, layout, components, motion, voice, and anti-patterns.',
    '- A Claude Design-quality package: `README.md`, `SKILL.md`, `colors_and_type.css`, provenance notes, `assets/`, `build/` when runtime icons exist, optional `fonts/`, category-specific `preview/` cards, and a reusable `ui_kits/app/` example.',
    '- Write `README.md` as a reusable package guide, not only a generated file list. Include a source-backed Product Overview/Product Context section that explains what the product is, the primary UI surfaces, and the core capabilities evidenced by README/package/source files; include source repository or source folder references, package contents, preview manifest, and reuse workflow.',
    '- README.md must include a concrete `## Preview Manifest` section that lists each generated `preview/*.html` card by exact path, what reviewers should inspect there, and which source-backed components, tokens, assets, or fonts it demonstrates. Keep this manifest synchronized with the actual `preview/` files.',
    '- Preserve real source assets when evidence provides them: logos, app icons, tray icons, avatars, wordmarks, and font files belong in `assets/`, `build/`, or `fonts/`, not in prose-only notes. When source files include build/runtime icon assets such as installer icons, tray icons, app icons, or wordmarks under build/resources paths, preserve representative files under `build/` as Claude Design does. When multiple source logos/icons/fonts are captured, preserve a representative set instead of collapsing everything into one generic logo or font. If font files are preserved, bind them in `colors_and_type.css` with `@font-face`, `@import`, or `url(...)` references so previews and UI kits actually render the brand typeface.',
    BUILD_ASSET_PRESERVATION_CONTRACT,
    '- Preserve high-signal source component examples when evidence provides substantial app/component code. Copy at least a few real, substantive source-backed examples outside `context/` (for example `source_examples/SelectModelButton.tsx`, `source_examples/ChatNavBar/index.tsx`, or root/nested TSX files) so future agents can inspect the original implementation patterns without digging through intake snapshots. Do not replace captured source examples with tiny filename-only stubs.',
    '- Split review previews into focused cards instead of one generic page. Prefer cards such as `preview/colors-primary.html`, `preview/colors-theme-light.html`, `preview/colors-theme-dark.html`, `preview/typography-specimens.html`, `preview/spacing-tokens.html`, `preview/spacing-radius.html`, `preview/spacing-shadows.html`, `preview/components-buttons.html`, `preview/components-inputs.html`, and `preview/brand-assets.html` when evidence supports them. `preview/brand-assets.html` must visibly load the preserved files from `assets/` or `build/` with real `img`, `picture`, `object`, or CSS `url(...)` references; do not redraw brand marks as inline placeholders when source assets were captured.',
    '- Write `SKILL.md` as an agent-usable Claude Design-style skill entry, not only a loose Markdown note. Include YAML frontmatter with `name`, `description`, and `user-invocable`, then include reusable sections for `What is inside`, `Source context`, `When to use this skill`, `How to use`, and `Design system highlights`. Those sections should tell future agents to read README.md, DESIGN.md, colors_and_type.css, preview/, assets/, build/, fonts/, source_examples/, and ui_kits/app/ before generating artifacts.',
    '- Build `ui_kits/app/` as an applied interface kit with `index.html`, a reusable README, and modular component files when the evidence includes representative product surfaces. `ui_kits/app/README.md` should document the kit structure, component files, usage workflow, design notes, and source basis, not only say the kit exists. `ui_kits/app/index.html` must load `../../colors_and_type.css`, must load/import/compose the modular component files under `ui_kits/app/components/`, and must mount/render the composed interface into the page; if it directly loads `.jsx`/`.tsx` files, include React, ReactDOM, and Babel standalone scripts and expose each loaded component as `window.ComponentName` / `globalThis.ComponentName`, or write compiled browser-ready JavaScript instead. Do not leave the entry page as a standalone generic static mock or disconnected script list when component files exist. For chat/workspace evidence, include substantive role-based components under `ui_kits/app/components/`: `App.jsx`, `Sidebar.jsx`, a list/rail component such as `AssistantsList.jsx`, a main workspace component such as `ChatArea.jsx`, an input/composer such as `InputBar.jsx`, and a message/comment component such as `MessageBubble.jsx`; the app shell component must compose the role components into one product-like surface; do not write one-line placeholder components.',
    UI_KIT_ENTRY_CONTRACT,
    '- Preview cards and UI-kit visuals should name or model high-signal source components from the evidence, such as the captured sidebar, chat, composer, message, artifact, modal, avatar, or selector files. Avoid anonymous generic examples when concrete source component names are available.',
    '- If older scaffold names exist (`preview/colors-node-types.html`, `preview/colors-ui-palette.html`, `preview/typography-scale.html`, `preview/spacing-system.html`, `preview/logo-variants.html`, or `ui_kits/generated_interface/`), replace them with the focused Claude-style structure above instead of extending the old generic files.',
    '- Keep `README.md`, `SKILL.md`, `DESIGN.md`, and `ui_kits/app/README.md` in sync with the final file structure; do not leave manifest text pointing to older preview names or `ui_kits/generated_interface/`.',
    '- Reviewable previews must appear in the right-side `Design System` tab and show real modules with preview cards, not a standalone marketing page or a single placeholder panel.',
    '',
    'Core execution order:',
    '1. Read `context/source-context.md` first, then run every intake command it lists for linked GitHub repositories and linked local code folders before editing design-system files.',
    '2. Do not write `DESIGN.md`, token files, previews, UI-kit examples, or asset notes from URL text alone. When GitHub, local code, Figma, or assets were provided, preserve concrete evidence under `context/` and use it as the basis for the design-system files.',
    '3. Before writing the design-system files, inventory the local evidence for product identity, real color/theme tokens, font families, brand assets, app shell layout, navigation, chat/input surfaces, and reusable components. Use this inventory to avoid generic tokens.',
    '4. Copy high-signal source component examples from the snapshots when they explain the design system better than prose alone. Keep these examples outside `context/` as reusable package artifacts, not only as hidden evidence.',
    '5. After evidence is collected, update the project files directly and keep the `Design System` tab reviewable.',
    '',
    'Completion gate:',
    '- For each linked GitHub repository, there must be a `context/github/*.md` evidence note plus command-written snapshots under `context/github/*/files/` before writing final design-system rules or previews. The snapshots should include theme/token/source files and any available binary assets or fonts selected by the intake command.',
    '- For each linked local code folder, run the listed `local-design-context` command and use its `context/local-code/*.md` evidence note plus command-written snapshots under `context/local-code/*/files/` before writing final design-system rules or previews. Browser-copied snapshots already under `context/local-code/` are also valid local evidence.',
    '- Do not call GitHub connector tree/content/raw tools directly from the agent. Use only the bounded `github-design-context` command listed in `context/source-context.md`; it tries this-device git first, authenticated GitHub CLI second, then connector-platform fallback when local access cannot read the repository.',
    '- If the bounded command records `Read method: git-clone`, treat those this-device snapshots as the primary evidence. If it records `Read method: connector`, treat the connector-platform snapshots as valid fallback evidence and continue.',
    '- For private repositories, local git credentials or GitHub CLI authentication (`gh auth login --web`) are preferred intake paths because the command still writes local evidence snapshots.',
    '- If the bounded command cannot write snapshots at all, stop with the permission, GitHub CLI login, connection, rate-limit, or clone issue. Do not substitute ad-hoc public GitHub browsing, memory, or URL-only inference.',
    '- Finish only after the project contains reviewable design-system artifacts: `DESIGN.md`, `README.md`, `SKILL.md`, reusable token/style files, focused preview HTML cards, UI-kit examples, preserved assets/fonts when supported, and provenance/context notes.',
    '- Before your final response, run `"$OD_NODE_BIN" "$OD_BIN" tools connectors design-system-package-audit --path . --fail-on-warnings`. Fix every audit error and design-quality warning, including generic visual artifacts, thin source-backed modules, stale manifest paths, and missing representative assets/fonts. If an issue cannot be fixed because source evidence is missing, explain that blocker instead of claiming the design system is ready.',
    '',
    `Design system workspace title:\n${title}`,
    '',
    'Use this title for README.md, SKILL.md, DESIGN.md, preview labels, and ui_kits/app copy unless the inspected source evidence proves a better product name. Do not derive the title from URL protocol text such as `https`.',
    '',
    `Company / design system context:\n${state.company.trim()}`,
    sourceContextManifestPath
      ? `\nSource context manifest:\n- Read \`${sourceContextManifestPath}\` before drafting. It records GitHub access readiness, local folder links, copied code snapshots, uploaded resources, and the review contract for this design system project.`
      : '',
    sourceNotes ? `\nProvided resources:\n${sourceNotes}` : '',
    githubUrls.length
      ? githubRunbook
      : '',
    state.codeFolders.length
      ? `Read the linked local code folders that Open Design attached to this project: ${state.codeFolders.join(', ')}. Treat them as source context only unless the user asks you to edit them.\n\n${localFolderRunbook}`
      : '',
    stagedLocalCode?.uploadedPaths.length
      ? `Inspect the copied local code snapshot files in this project under \`${LOCAL_CODE_UPLOAD_ROOT}/\`: ${stagedLocalCode.uploadedPaths.slice(0, 20).join(', ')}${stagedLocalCode.uploadedPaths.length > 20 ? `, and ${stagedLocalCode.uploadedPaths.length - 20} more` : ''}.`
      : '',
    stagedLocalCode?.skippedCount
      ? `${stagedLocalCode.skippedCount} local code files were skipped because they were too large, duplicate, generated, or outside the focused upload limit.`
      : '',
    stagedFigma?.summaryPaths.length
      ? `Use the locally parsed Figma summaries in \`${FIGMA_CONTEXT_ROOT}/\`: ${stagedFigma.summaryPaths.join(', ')}. Treat these as evidence extracted from .fig files; the original .fig files were not uploaded.`
      : '',
    stagedFigma?.skippedCount
      ? `${stagedFigma.skippedCount} .fig files were skipped because they were duplicate or outside the focused parse limit.`
      : '',
    stagedAssets?.uploadedPaths.length
      ? `Use uploaded brand assets in \`${ASSET_UPLOAD_ROOT}/\`: ${stagedAssets.uploadedPaths.slice(0, 20).join(', ')}${stagedAssets.uploadedPaths.length > 20 ? `, and ${stagedAssets.uploadedPaths.length - 20} more` : ''}.`
      : '',
    stagedAssets?.skippedCount
      ? `${stagedAssets.skippedCount} asset files were skipped because they were too large, duplicate, generated, or outside the focused upload limit.`
      : '',
    localCode.length
      ? 'Use local code context to infer actual tokens, typography, spacing, components, assets, naming, and product surface patterns.'
      : '',
    '',
    'Keep this scoped to the design-system project. When finished, summarize which files should be reviewed first.',
  ].filter(Boolean).join('\n');
}

function buildSourceContextManifest(
  state: SetupState,
  options: {
    composioConfigured: boolean;
    githubConnector: ConnectorDetail | null;
    stagedLocalCode?: StagedLocalCodeContext;
    stagedFigma?: StagedFigmaContext;
    stagedAssets?: StagedAssetContext;
  },
): string {
  const githubUrls = githubUrlsFromState(state);
  const linkedFolders = state.codeFolders;
  const copiedSnapshots = options.stagedLocalCode?.uploadedPaths ?? [];
  const skippedCount = options.stagedLocalCode?.skippedCount ?? 0;
  const figmaSummaries = options.stagedFigma?.summaryPaths ?? [];
  const skippedFigma = options.stagedFigma?.skippedCount ?? 0;
  const uploadedAssets = options.stagedAssets?.uploadedPaths ?? [];
  const skippedAssets = options.stagedAssets?.skippedCount ?? 0;
  const title = inferDesignSystemTitle(state);
  const sections = [
    '# Design System Source Context',
    '',
    'This file is generated during setup and should be treated as source evidence for the design-system project. Use it before writing or revising DESIGN.md, previews, tokens, UI kit examples, or assets.',
    '',
    '## Company / Product',
    '',
    `Canonical design-system title: ${title}`,
    '',
    state.company.trim() || 'No company or product context provided yet.',
  ];

  sections.push('', '## GitHub Repositories', '');
  if (githubUrls.length > 0) {
    sections.push(...githubUrls.map((url) => `- ${url}`));
  } else {
    sections.push('- None linked.');
  }
  sections.push('', `Connector status: ${githubConnectorStatusForManifest(options)}`);
  if (githubUrls.length > 0) {
    sections.push('', '### GitHub Connector Intake Runbook', '', buildGithubConnectorRunbook(githubUrls));
  }

  sections.push('', '## Local Code', '');
  if (linkedFolders.length > 0) {
    sections.push('Linked folders readable by the local agent:');
    sections.push(...linkedFolders.map((folder) => `- ${folder}`));
    sections.push('', '### Local Folder Intake Runbook', '', buildLocalFolderRunbook(linkedFolders));
  } else {
    sections.push('Linked folders readable by the local agent: none.');
  }
  if (copiedSnapshots.length > 0) {
    sections.push('', `Copied browser-selected code snapshot files under \`${LOCAL_CODE_UPLOAD_ROOT}/\`:`);
    sections.push(...copiedSnapshots.slice(0, 40).map((filePath) => `- ${filePath}`));
    if (copiedSnapshots.length > 40) {
      sections.push(`- ...and ${copiedSnapshots.length - 40} more files.`);
    }
  } else {
    sections.push('', `Copied browser-selected code snapshot files under \`${LOCAL_CODE_UPLOAD_ROOT}/\`: none.`);
  }
  if (skippedCount > 0) {
    sections.push(`${skippedCount} local code files were skipped because they were too large, duplicate, generated, or outside the focused upload limit.`);
  }

  sections.push('', '## Design And Brand Resources', '');
  sections.push(state.figFiles.length ? `Figma files selected:\n${state.figFiles.map((name) => `- ${name}`).join('\n')}` : 'Figma files selected: none.');
  if (figmaSummaries.length > 0) {
    sections.push('', `Locally parsed Figma summaries under \`${FIGMA_CONTEXT_ROOT}/\`:`);
    sections.push(...figmaSummaries.map((filePath) => `- ${filePath}`));
  } else {
    sections.push('', `Locally parsed Figma summaries under \`${FIGMA_CONTEXT_ROOT}/\`: none.`);
  }
  if (skippedFigma > 0) {
    sections.push(`${skippedFigma} .fig files were skipped because they were duplicate or outside the focused parse limit.`);
  }
  sections.push(state.assetFiles.length ? `Fonts, logos, and assets selected:\n${state.assetFiles.map((name) => `- ${name}`).join('\n')}` : 'Fonts, logos, and assets selected: none.');
  if (uploadedAssets.length > 0) {
    sections.push('', `Uploaded brand asset files under \`${ASSET_UPLOAD_ROOT}/\`:`);
    sections.push(...uploadedAssets.slice(0, 40).map((filePath) => `- ${filePath}`));
    if (uploadedAssets.length > 40) {
      sections.push(`- ...and ${uploadedAssets.length - 40} more files.`);
    }
  } else {
    sections.push('', `Uploaded brand asset files under \`${ASSET_UPLOAD_ROOT}/\`: none.`);
  }
  if (skippedAssets > 0) {
    sections.push(`${skippedAssets} asset files were skipped because they were too large, duplicate, generated, or outside the focused upload limit.`);
  }

  sections.push('', '## Notes', '', state.notes.trim() || 'No additional notes provided.');

  sections.push(
    '',
    '## Review Contract',
    '',
    '- `/design-systems/create` only collected setup inputs. All GitHub extraction, local evidence intake, source reading, design-system construction, package audit, and artifact writes should happen inside this project workspace.',
    '- DESIGN.md is the canonical source of truth.',
    '- Use the canonical design-system title above for headings, README/SKILL names, preview labels, and UI-kit copy unless inspected evidence proves a more accurate product name. Never title the system from URL protocol text such as `https`.',
    '- colors_and_type.css should hold concrete reusable tokens when the source evidence supports them; if fonts/ contains preserved font files, colors_and_type.css must bind those files with @font-face, @import, or url(...) references so typography does not fall back to substitute fonts.',
    '- README.md and SKILL.md should make the extracted system reusable as a real Open Design design-system package.',
    '- README.md should include a source-backed Product Overview/Product Context section, source repository or source folder references, package contents, a concrete `## Preview Manifest` listing every generated `preview/*.html` card, and reuse workflow, similar to Claude Design exports.',
    '- SKILL.md should include YAML frontmatter with `name`, `description`, and `user-invocable`, plus Claude-style reusable skill sections: What is inside, Source context, When to use this skill, How to use, and Design system highlights. The usage guidance should point agents at README.md, DESIGN.md, colors_and_type.css, preview/, assets/, build/, fonts/, source_examples/, and ui_kits/app/.',
    '- README.md, SKILL.md, DESIGN.md, and ui_kits/app/README.md must describe the final focused preview cards and `ui_kits/app/` paths, not old scaffold names such as `preview/typography-scale.html` or `ui_kits/generated_interface/`.',
    '- preview/ should contain small reviewable HTML cards for typography, color themes, spacing, radius, shadows, brand assets, and component evidence.',
    '- source_examples/ or equivalent root/nested source files should preserve selected high-signal original components when snapshots include substantial app/component source, similar to Claude Design exports that keep files like SelectModelButton.tsx or ChatNavBar/index.tsx alongside the package. These examples should contain substantive original implementation code, not tiny stubs that only share the component name.',
    '- ui_kits/app/ should contain an applied interface example, plus substantive role-based files under `ui_kits/app/components/` when the source snapshots include representative app shells, navigation, chat/input surfaces, or reusable components. `ui_kits/app/README.md` should explain structure, component files, usage, design notes, and source basis. `ui_kits/app/index.html` must load `../../colors_and_type.css`, must load/import/compose the modular component files, and must mount/render the composed interface instead of staying as a standalone generic static mock or disconnected script list. If the entry directly loads `.jsx`/`.tsx` files, include React, ReactDOM, and Babel standalone scripts and expose each loaded component as `window.ComponentName` / `globalThis.ComponentName`, or write compiled browser-ready JavaScript instead. For chat/workspace evidence, cover app shell, sidebar/navigation, assistant/list rail, chat area, input bar/composer, and message bubble/comment roles; the app shell component must compose those roles into one product-like surface. Placeholder component shells are not sufficient.',
    UI_KIT_ENTRY_CONTRACT,
    '- Preview cards and UI-kit visuals should explicitly label or model source-backed modules from the captured evidence instead of generic placeholder modules.',
    '- assets/, build/, fonts/, and context/ should preserve logos, app icons, tray icons, installer/runtime icons, wordmarks, font files, provenance, and source notes for future projects.',
    BUILD_ASSET_PRESERVATION_CONTRACT,
    '- preview/brand-assets.html should visibly reference preserved files from assets/ or build/ instead of recreating logos/icons as inline placeholder drawings.',
    '- GitHub evidence must come from the bounded `github-design-context` command, not direct connector tree/content/raw tool calls. The command tries this-device git first, authenticated GitHub CLI second, and connector-platform fallback only when local access cannot read the repository.',
    '- Linked local folder evidence should come from the bounded `local-design-context` command, which writes a local evidence note and snapshots under `context/local-code/` before final design-system rules are drafted.',
    '- Before marking the design system ready, run `"$OD_NODE_BIN" "$OD_BIN" tools connectors design-system-package-audit --path . --fail-on-warnings` and fix every reported error or warning.',
    '- Draft design systems cannot be used by other projects until published.',
  );

  return `${sections.join('\n')}\n`;
}

function buildLocalFolderRunbook(folders: string[]): string {
  if (folders.length === 0) return '';
  const intakeCommands = folders
    .map((folder, index) => `   - \`"$OD_NODE_BIN" "$OD_BIN" tools connectors local-design-context --path ${shellQuote(folder)} --output context/local-code/${localEvidenceFileName(folder, index)}\``)
    .join('\n');
  return [
    'Local folder intake is required before drafting from linked local code folders:',
    '1. For each linked folder, run the bounded local intake command before writing design-system files:',
    intakeCommands,
    '2. The command selects design-system-relevant source files plus available logos/icons/fonts, writes a reviewable evidence note, and copies snapshots under `context/local-code/`.',
    '3. Inspect the generated evidence note plus snapshots for README, package manifests, Tailwind/theme/token files, global CSS, font declarations, component source, layout shells, icons/logos/assets, and representative app entry files.',
    '4. If the command cannot read a linked folder or write snapshots, stop and explain the local file access problem instead of inventing tokens from the folder name.',
  ].join('\n');
}

function buildGithubConnectorRunbook(githubUrls: string[]): string {
  if (githubUrls.length === 0) return '';
  const intakeCommands = githubUrls
    .map((url) => `   - \`"$OD_NODE_BIN" "$OD_BIN" tools connectors github-design-context --repo ${shellQuote(url)} --output context/github/${githubEvidenceFileName(url)}\``)
    .join('\n');
  return [
    'GitHub repository intake is required before drafting the design system:',
    '1. For each linked repository, run the bounded intake command before writing design-system files. The command tries this-device access first (`git clone`, then authenticated GitHub CLI via `gh auth login --web`) and uses the Composio GitHub connector only as a connector-platform fallback.',
    intakeCommands,
    '2. Do not call GitHub connector tree/content/raw tools directly from the agent. Large repositories can trigger `CONNECTOR_OUTPUT_TOO_LARGE`; the bounded intake command is the only allowed GitHub repository intake path for this workflow.',
    '3. The intake command selects design-system-relevant source files plus available logos/icons/fonts and writes a reviewable evidence note plus file snapshots under `context/github/`; keep those files as the source evidence for this design-system project.',
    '4. If you already hit `CONNECTOR_OUTPUT_TOO_LARGE` or `CONNECTOR_RATE_LIMITED` from a direct connector call, do not stop and do not retry the same direct tool. Run the bounded intake command above, then inspect the written snapshots.',
    '5. Treat `Read method: git-clone` as the preferred this-device path. Treat `Read method: connector` as valid connector-platform fallback evidence when local git/GitHub CLI could not read the repository.',
    '6. The command is strict: if the bounded intake command cannot write snapshot files, stop and explain the permission, GitHub CLI login, connection, rate-limit, or clone problem. Do not use ad-hoc public GitHub browsing, memory, or URL-only inference for design-system files.',
    '7. Inspect the generated evidence note plus snapshots for README, package manifests, Tailwind/theme/token files, global CSS, font declarations, component source for buttons/forms/navigation/cards/tables, layout shells, icons/logos/assets, and representative app entry files.',
    '8. Use that evidence to create or update `DESIGN.md`, `colors_and_type.css`, `README.md`, `SKILL.md`, `preview/`, `ui_kits/app/`, `assets/`, and `fonts/` so the Design System tab can review the output as a reusable package.',
  ].join('\n');
}

function localEvidenceFileName(folder: string, index: number): string {
  const parts = folder.split(/[\\/]+/u).filter(Boolean);
  const basename = sanitizeEvidenceSegment(parts.at(-1) ?? 'local-source');
  return `${basename}${index > 0 ? `-${index + 1}` : ''}.md`;
}

function githubEvidenceFileName(url: string): string {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/?#].*)?$/iu.exec(url)
    ?? /^([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/u.exec(url);
  const owner = sanitizeEvidenceSegment(match?.[1] ?? 'github');
  const repo = sanitizeEvidenceSegment(match?.[2] ?? 'repository');
  return `${owner}-${repo}.md`;
}

function sanitizeEvidenceSegment(value: string): string {
  return value.trim().replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '') || 'repo';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function githubConnectorStatusForManifest(options: {
  composioConfigured: boolean;
  githubConnector: ConnectorDetail | null;
}): string {
  if (!options.composioConfigured) {
    return 'GitHub connector is not configured; repository intake will use local git credentials or authenticated GitHub CLI when possible.';
  }
  if (isGithubConnectorConnected(options.githubConnector)) {
    const account = getDisplayableGithubAccountLabel(options.githubConnector);
    return account
      ? `connected as ${account}.`
      : 'connected.';
  }
  return 'Composio key is configured, but GitHub is not connected; repository intake can still use local git credentials or authenticated GitHub CLI when possible.';
}

export function buildProvenance(state: SetupState): DesignSystemProvenance {
  const githubUrls = githubUrlsFromState(state);
  const localCode = localCodeReferences(state);
  return {
    companyBlurb: state.company.trim(),
    ...(githubUrls.length ? { githubUrls } : {}),
    ...(localCode.length ? { localCodeFiles: localCode } : {}),
    ...(state.figFiles.length ? { figFiles: state.figFiles } : {}),
    ...(state.assetFiles.length ? { assetFiles: state.assetFiles } : {}),
    ...(state.notes.trim() ? { notes: state.notes.trim() } : {}),
    sourceNotes: buildSourceNotes(state),
  };
}
