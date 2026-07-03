import type { FileOpEntry } from '../../runtime/file-ops';
import type { TodoItem } from '../../runtime/todos';
import type { DesignSystemSummary, ProjectFile } from '../../types';
import type {
  DesignSystemGenerationStep,
  DesignSystemProjectSection,
  DesignSystemProjectSectionReview,
  DesignSystemReviewAgentTask,
  DesignSystemReviewCategory,
  DesignSystemReviewDecision,
  DesignSystemReviewEntry,
  DesignSystemSectionActivity,
  DesignSystemSectionActivityPhase,
  DesignSystemSectionStatus,
} from './types';

const DESIGN_SYSTEM_GUIDANCE_FILES = new Set([
  'design.md',
  'readme.md',
  'readme-print.md',
  'skill.md',
]);
const DESIGN_SYSTEM_IMAGE_OR_FONT_EXTENSIONS = /\.(svg|png|jpe?g|gif|webp|avif|ico|otf|ttf|woff2?)$/i;

function designSystemHasSourceContext(system: DesignSystemSummary): boolean {
  const provenance = system.provenance;
  if (!provenance) return false;
  return Boolean(
    provenance.companyBlurb?.trim() ||
    provenance.githubUrls?.length ||
    provenance.localCodeFiles?.length ||
    provenance.figFiles?.length ||
    provenance.assetFiles?.length ||
    provenance.notes?.trim() ||
    provenance.sourceNotes?.trim(),
  );
}

export function designSystemGithubEvidenceState(
  system: DesignSystemSummary,
  names: string[],
): {
  required: boolean;
  ready: boolean;
  noteCount: number;
  snapshotCount: number;
  hasSourceManifest: boolean;
} {
  const expectedRepos = system.provenance?.githubUrls?.length ?? 0;
  const required = expectedRepos > 0;
  if (!required) {
    return {
      required: false,
      ready: true,
      noteCount: 0,
      snapshotCount: 0,
      hasSourceManifest: names.some((name) => normalizeDesignSystemPath(name) === 'context/source-context.md'),
    };
  }
  const normalized = names.map(normalizeDesignSystemPath);
  const noteCount = normalized.filter((name) => /^context\/github\/[^/]+\.md$/u.test(name)).length;
  const snapshotCount = normalized.filter((name) => /^context\/github\/[^/]+\/files\//u.test(name)).length;
  return {
    required: true,
    ready: noteCount >= expectedRepos && snapshotCount > 0,
    noteCount,
    snapshotCount,
    hasSourceManifest: normalized.includes('context/source-context.md'),
  };
}

export function slugForTestId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function designSystemSectionPreviewFile(
  names: string[],
  fileByName: Map<string, ProjectFile>,
): ProjectFile | null {
  for (const name of names) {
    const file = fileByName.get(name);
    if (!file) continue;
    if (file.kind === 'html' || file.kind === 'image' || file.kind === 'sketch') return file;
  }
  return null;
}

export function buildDesignSystemReviewSections(
  names: string[],
  fileByName: Map<string, ProjectFile>,
): DesignSystemProjectSection[] {
  const artifactNames = names
    .filter((name) => isDesignSystemReviewArtifactFile(name, fileByName))
    .sort(designSystemReviewArtifactSort);
  if (artifactNames.length > 0) {
    const reviewNames = preferPreviewArtifactsOverRawAssets(artifactNames);
    return reviewNames.map((name) => {
      const title = designSystemReviewTitleFromPath(name);
      const category = inferDesignSystemReviewCategory(name, title);
      return {
        title,
        subtitle: designSystemReviewSubtitle(title, category),
        category,
        files: designSystemRelatedFilesForCategory(name, category, names),
      };
    });
  }
  return designSystemFallbackReviewSections(names);
}

function preferPreviewArtifactsOverRawAssets(names: string[]): string[] {
  const hasBrandPreview = names.some((name) => {
    const path = normalizeDesignSystemPath(name);
    const title = designSystemReviewTitleFromPath(name);
    return inferDesignSystemReviewCategory(name, title) === 'Brand'
      && (path.startsWith('preview/') || path.includes('/preview/') || path.endsWith('.html'));
  });
  if (!hasBrandPreview) return names;
  return names.filter((name) => {
    const path = normalizeDesignSystemPath(name);
    const title = designSystemReviewTitleFromPath(name);
    if (inferDesignSystemReviewCategory(name, title) !== 'Brand') return true;
    return path.startsWith('preview/') || path.includes('/preview/') || path.endsWith('.html');
  });
}

function isDesignSystemReviewArtifactFile(
  name: string,
  fileByName: Map<string, ProjectFile>,
): boolean {
  const path = normalizeDesignSystemPath(name);
  const file = fileByName.get(name);
  if (!file || isDesignSystemEvidenceFile(path) || path === 'metadata.json') return false;
  const isRenderable = file.kind === 'html' || file.kind === 'image' || file.kind === 'sketch';
  if (!isRenderable) return false;
  if (path === 'index.html') return true;
  if (path.startsWith('preview/') || path.includes('/preview/')) return true;
  if (path.startsWith('ui_kits/') || path.includes('/ui_kits/')) return true;
  if (
    path.startsWith('assets/')
    || path.startsWith('src/assets/')
    || path.startsWith('public/')
    || path.includes('/assets/')
    || path.includes('/logos/')
  ) {
    return /\b(brand|logo|mark|icon)\b/u.test(path) || DESIGN_SYSTEM_IMAGE_OR_FONT_EXTENSIONS.test(path);
  }
  return false;
}

function designSystemReviewArtifactSort(first: string, second: string): number {
  const firstCategory = inferDesignSystemReviewCategory(first, designSystemReviewTitleFromPath(first));
  const secondCategory = inferDesignSystemReviewCategory(second, designSystemReviewTitleFromPath(second));
  return designSystemReviewCategoryRank(firstCategory) - designSystemReviewCategoryRank(secondCategory)
    || designSystemReviewTitleFromPath(first).localeCompare(designSystemReviewTitleFromPath(second));
}

function designSystemReviewTitleFromPath(name: string): string {
  const path = normalizeDesignSystemPath(name);
  const parts = path.split('/').filter(Boolean);
  let basename = parts[parts.length - 1] ?? path;
  if (/^index\.(html?|png|jpe?g|svg|webp|avif)$/iu.test(basename) && parts.length > 1) {
    basename = parts[parts.length - 2] ?? basename;
  }
  return basename
    .replace(/\.(html?|png|jpe?g|gif|webp|avif|svg|fig|pen)$/iu, '')
    .replace(/_/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'overview';
}

function inferDesignSystemReviewCategory(name: string, title: string): DesignSystemReviewCategory {
  const text = `${normalizeDesignSystemPath(name)} ${title}`.toLowerCase();
  if (/\b(type|typography|font|text)\b/u.test(text)) return 'Type';
  if (/\b(color|colors|palette|theme)\b/u.test(text)) return 'Colors';
  if (/\b(space|spacing|radius|layout-grid)\b/u.test(text)) return 'Spacing';
  if (/\b(brand|logo|logos|mark|wordmark|icon)\b/u.test(text)) return 'Brand';
  return 'Components';
}

function designSystemReviewSubtitle(title: string, category: DesignSystemReviewCategory): string {
  const text = title.toLowerCase();
  if (text.includes('typography')) return 'Text hierarchy and styles';
  if (text.includes('font')) return 'Font family specimens';
  if (text.includes('node')) return 'Data type color coding system';
  if (text.includes('ui-palette') || text.includes('palette')) return 'Interface color palette';
  if (text.includes('dark')) return 'Dark theme color palette';
  if (text.includes('spacing') || text.includes('radius')) return 'Spacing scale and border radius tokens';
  if (text.includes('logo') || text.includes('brand')) return 'Brand logo marks';
  if (text.includes('interface') || text.includes('ui')) return 'Interface and component patterns';
  switch (category) {
    case 'Type':
      return 'Typography scale and font guidance';
    case 'Colors':
      return 'Color palette and token specimens';
    case 'Spacing':
      return 'Spacing and radius system';
    case 'Brand':
      return 'Brand assets and identity usage';
    case 'Components':
      return 'Reusable product interface examples';
  }
}

function designSystemRelatedFilesForCategory(
  artifactName: string,
  category: DesignSystemReviewCategory,
  names: string[],
): string[] {
  const related = names.filter((name) => {
    if (name === artifactName || isDesignSystemEvidenceFile(name)) return false;
    switch (category) {
      case 'Type':
      case 'Colors':
      case 'Spacing':
        return isDesignSystemTokenFile(name);
      case 'Components':
        return isDesignSystemUiKitFile(name);
      case 'Brand':
        return isDesignSystemAssetFile(name);
    }
  });
  return Array.from(new Set([artifactName, ...related])).slice(0, 12);
}

function designSystemFallbackReviewSections(names: string[]): DesignSystemProjectSection[] {
  const tokenFiles = names.filter(isDesignSystemTokenFile).slice(0, 8);
  const uiKitFiles = names.filter(isDesignSystemUiKitFile).slice(0, 8);
  const assetFiles = names.filter(isDesignSystemAssetFile).slice(0, 8);
  const sections: Array<DesignSystemProjectSection | null> = [
    tokenFiles.length > 0
      ? {
        title: 'colors-and-type',
        subtitle: 'Color, type, spacing, and token guidance',
        category: 'Colors',
        files: tokenFiles,
      }
      : null,
    uiKitFiles.length > 0
      ? {
        title: 'components',
        subtitle: 'Reusable interface examples',
        category: 'Components',
        files: uiKitFiles,
      }
      : null,
    assetFiles.length > 0
      ? {
        title: 'assets',
        subtitle: 'Brand logos, fonts, and uploaded assets',
        category: 'Brand',
        files: assetFiles,
      }
      : null,
  ];
  return sections.filter((section): section is DesignSystemProjectSection => section !== null);
}

export function designSystemReviewGroups(
  reviews: DesignSystemProjectSectionReview[],
): Array<{ title: DesignSystemReviewCategory; items: DesignSystemProjectSectionReview[] }> {
  const categories: DesignSystemReviewCategory[] = ['Type', 'Colors', 'Spacing', 'Components', 'Brand'];
  return categories
    .map((title) => ({
      title,
      items: reviews.filter((review) => review.section.category === title),
    }))
    .filter((group) => group.items.length > 0);
}

function designSystemReviewCategoryRank(category: DesignSystemReviewCategory): number {
  return ['Type', 'Colors', 'Spacing', 'Components', 'Brand'].indexOf(category);
}

export function designSystemReviewNeedsAttention(review: DesignSystemProjectSectionReview): boolean {
  return review.sectionStatus === 'needs-review'
    || review.sectionStatus === 'needs-work'
    || review.sectionStatus === 'updated'
    || review.sectionStatus === 'running'
    || review.sectionStatus === 'planned'
    || review.sectionStatus === 'missing';
}

function isDesignSystemEvidenceFile(name: string): boolean {
  const path = normalizeDesignSystemPath(name);
  return path.startsWith('context/') || path.includes('/context/');
}

function isDesignSystemGuidanceFile(name: string): boolean {
  const path = normalizeDesignSystemPath(name);
  if (path.includes('/')) return false;
  return DESIGN_SYSTEM_GUIDANCE_FILES.has(path);
}

function designSystemGuidanceSort(first: string, second: string): number {
  const order = ['design.md', 'readme.md', 'readme-print.md', 'skill.md'];
  const firstRank = order.indexOf(normalizeDesignSystemPath(first));
  const secondRank = order.indexOf(normalizeDesignSystemPath(second));
  return (firstRank === -1 ? order.length : firstRank)
    - (secondRank === -1 ? order.length : secondRank)
    || first.localeCompare(second);
}

function isDesignSystemTokenFile(name: string): boolean {
  const path = normalizeDesignSystemPath(name);
  if (isDesignSystemEvidenceFile(path)) return false;
  if (
    path.startsWith('preview/')
    || path.startsWith('ui_kits/')
    || path.startsWith('assets/')
    || path.startsWith('src/assets/')
    || path.startsWith('public/')
    || path.includes('/preview/')
    || path.includes('/ui_kits/')
    || path.includes('/assets/')
    || path.includes('/src/assets/')
    || DESIGN_SYSTEM_IMAGE_OR_FONT_EXTENSIONS.test(path)
  ) {
    return false;
  }
  const basename = designSystemBasename(path);
  if (basename.endsWith('.html')) return false;
  return basename === 'colors_and_type.css'
    || basename === 'tailwind.config.ts'
    || basename === 'tailwind.config.js'
    || basename === 'tailwind.config.mjs'
    || basename === 'theme.css'
    || basename === 'tokens.css'
    || basename === 'variables.css'
    || basename === 'design-tokens.json'
    || path.includes('/tokens/')
    || path.startsWith('src/tokens/')
    || path.startsWith('src/styles/')
    || path.startsWith('styles/')
    || /\b(color|colors|palette|typography|spacing|radius|theme|token)s?\b/u.test(path);
}

function isDesignSystemPreviewFile(name: string): boolean {
  const path = normalizeDesignSystemPath(name);
  if (isDesignSystemEvidenceFile(path) || path.startsWith('ui_kits/')) return false;
  const basename = designSystemBasename(path);
  return path.startsWith('preview/')
    || (path.split('/').length === 1 && basename.endsWith('.html'))
    || (basename.endsWith('.html') && /\b(index|overview|preview|showcase|styleguide)\b/u.test(path));
}

function isDesignSystemUiKitFile(name: string): boolean {
  const path = normalizeDesignSystemPath(name);
  if (isDesignSystemEvidenceFile(path)) return false;
  return path.startsWith('ui_kits/')
    || path.startsWith('src/components/')
    || path.startsWith('components/')
    || path.includes('/ui_kits/')
    || path.includes('/src/components/')
    || /\b(component|components|interface|ui-kit|uikit)\b/u.test(path);
}

function isDesignSystemAssetFile(name: string): boolean {
  const path = normalizeDesignSystemPath(name);
  if (isDesignSystemEvidenceFile(path)) return false;
  return path.startsWith('assets/')
    || path.startsWith('src/assets/')
    || path.startsWith('public/')
    || path.includes('/assets/')
    || path.includes('/src/assets/')
    || path.includes('/fonts/')
    || path.includes('/icons/')
    || path.includes('/logos/')
    || DESIGN_SYSTEM_IMAGE_OR_FONT_EXTENSIONS.test(path);
}

export function designSystemGenerationReviewHasStarted(
  sectionReviews: DesignSystemProjectSectionReview[],
): boolean {
  return sectionReviews.some((review) => {
    const { previewFile, section, sectionActivity } = review;
    if (previewFile) return true;
    if (section.files.length > 0 && sectionActivity.phase !== 'idle') return true;
    return sectionActivity.phase === 'writing'
      || sectionActivity.phase === 'updated'
      || sectionActivity.phase === 'planned';
  });
}

export function designSystemSectionVisibleDuringGeneration(
  review: DesignSystemProjectSectionReview,
): boolean {
  const { section, reviewEntry, sectionActivity, previewFile } = review;
  if (reviewEntry) return true;
  if (previewFile) return true;
  if (sectionActivity.phase !== 'idle') return true;
  return section.files.length > 0;
}

export function designSystemSectionStatus(
  section: DesignSystemProjectSection,
  decision: DesignSystemReviewDecision | undefined,
  changedAfterFeedback: boolean,
  activity: DesignSystemSectionActivity,
): DesignSystemSectionStatus {
  if (activity.running) return 'running';
  if (activity.phase === 'planned') return 'planned';
  if (changedAfterFeedback || activity.mutated) return 'updated';
  if (section.files.length === 0) return 'missing';
  if (decision === 'looks-good') return 'approved';
  if (decision === 'needs-work') return 'needs-work';
  return 'needs-review';
}

export function designSystemSectionStatusLabel(
  section: DesignSystemProjectSection,
  status: DesignSystemSectionStatus,
  activity: DesignSystemSectionActivity,
): string {
  switch (status) {
    case 'running':
      return designSystemSectionPhaseLabel(section, activity);
    case 'planned':
      return 'Queued';
    case 'updated':
      return 'Review updated files';
    case 'approved':
      return 'Looks good';
    case 'needs-work':
      return 'Needs work';
    case 'needs-review':
      return 'Needs review';
    case 'missing':
      return section.requiredFile ? `${section.requiredFile} missing` : 'No files yet';
  }
}

export function designSystemSectionStatusClass(status: DesignSystemSectionStatus): string {
  switch (status) {
    case 'running':
      return 'is-running';
    case 'planned':
      return 'is-planned';
    case 'updated':
      return 'is-review';
    case 'approved':
      return 'is-approved';
    case 'needs-work':
      return 'is-work';
    case 'needs-review':
      return 'is-ready';
    case 'missing':
      return 'is-missing';
  }
}

export function designSystemInitialGenerationSteps({
  files,
  sectionReviews,
  system,
}: {
  files: ProjectFile[];
  sectionReviews: DesignSystemProjectSectionReview[];
  system: DesignSystemSummary;
}): DesignSystemGenerationStep[] {
  const hasSourceContext =
    designSystemGithubEvidenceState(system, files.map((file) => file.name)).ready
    && (
      files.some((file) => normalizeDesignSystemPath(file.name).startsWith('context/')) ||
      designSystemHasSourceContext(system)
    );
  const fileNames = files.map((file) => file.name);
  const categoryHasReview = (category: DesignSystemReviewCategory) =>
    sectionReviews.some((review) => review.section.category === category);
  const categoryIsRunning = (category: DesignSystemReviewCategory) =>
    sectionReviews.some((review) => review.section.category === category && review.sectionActivity.running);
  const guidanceRunning = sectionReviews.some((review) =>
    review.sectionActivity.running
    && review.section.files.some((name) => isDesignSystemGuidanceFile(name)),
  );
  const steps: DesignSystemGenerationStep[] = [
    {
      id: 'source-context',
      title: 'Explore provided resources',
      detail: 'Company context, GitHub repositories, local code folders, Figma files, fonts, logos, and notes.',
      status: hasSourceContext ? 'succeeded' : 'running',
    },
    {
      id: 'guidance',
      title: 'Create DESIGN.md',
      detail: 'Canonical guidance used as project context.',
      status: fileNames.some(isDesignSystemGuidanceFile)
        ? 'succeeded'
        : guidanceRunning
          ? 'running'
          : 'pending',
    },
    {
      id: 'tokens',
      title: 'Create tokens',
      detail: 'Color, type, spacing, and radius evidence.',
      status: fileNames.some(isDesignSystemTokenFile)
        ? 'succeeded'
        : (categoryIsRunning('Type') || categoryIsRunning('Colors') || categoryIsRunning('Spacing'))
          ? 'running'
          : 'pending',
    },
    {
      id: 'previews',
      title: 'Create preview cards',
      detail: 'HTML review cards for the Design System tab.',
      status: sectionReviews.some((review) => review.previewFile)
        ? 'succeeded'
        : (categoryIsRunning('Type') || categoryIsRunning('Colors') || categoryIsRunning('Spacing') || categoryIsRunning('Brand'))
          ? 'running'
          : 'pending',
    },
    {
      id: 'ui-kit',
      title: 'Create UI kit',
      detail: 'Reusable interface examples.',
      status: categoryHasReview('Components') || fileNames.some(isDesignSystemUiKitFile)
        ? 'succeeded'
        : categoryIsRunning('Components')
          ? 'running'
          : 'pending',
    },
    {
      id: 'assets',
      title: 'Register assets',
      detail: 'Logos, icons, fonts, and brand files.',
      status: categoryHasReview('Brand') || fileNames.some(isDesignSystemAssetFile)
        ? 'succeeded'
        : categoryIsRunning('Brand')
          ? 'running'
          : 'pending',
    },
  ];
  if (!steps.some((step) => step.status === 'running')) {
    const firstPending = steps.find((step) => step.status === 'pending');
    if (firstPending) firstPending.status = 'running';
  }
  return steps;
}

export function designSystemGenerationProgress(steps: DesignSystemGenerationStep[]): number {
  if (steps.length === 0) return 8;
  const succeeded = steps.filter((step) => step.status === 'succeeded').length;
  const running = steps.some((step) => step.status === 'running') ? 0.45 : 0;
  return Math.max(8, Math.min(92, Math.round(((succeeded + running) / steps.length) * 100)));
}

export function designSystemSectionActivity(
  section: DesignSystemProjectSection,
  fileOps: FileOpEntry[],
  todos: TodoItem[],
): DesignSystemSectionActivity {
  const touched = fileOps.filter((entry) => designSystemFileOpBelongsToSection(entry, section));
  const touchedFiles = Array.from(new Set(touched.map((entry) => entry.path)));
  const todo = designSystemSectionTodo(section, todos);
  const hasRunningMutation = touched.some((entry) =>
    entry.status === 'running' && (entry.ops.includes('write') || entry.ops.includes('edit')),
  );
  const hasRunningRead = touched.some((entry) =>
    entry.status === 'running' && entry.ops.includes('read'),
  );
  const mutated = touched.some((entry) =>
    entry.status === 'done' && (entry.ops.includes('write') || entry.ops.includes('edit')),
  );
  const errored = touched.some((entry) => entry.status === 'error');
  const todoPhase = todo ? designSystemTodoActivityPhase(section, todo) : null;
  const hasRunningTodo = todo?.status === 'in_progress';
  const phase: DesignSystemSectionActivityPhase =
    errored
      ? 'error'
      : hasRunningMutation
        ? 'writing'
        : hasRunningRead
          ? 'reading'
          : hasRunningTodo && todoPhase
            ? todoPhase
            : mutated
              ? 'updated'
              : todoPhase
                ? todoPhase
                : 'idle';
  return {
    running: hasRunningMutation || hasRunningRead || hasRunningTodo,
    mutated,
    errored,
    phase,
    touchedFiles,
    todoText: todo?.content,
    todoStatus: todo?.status,
  };
}

function designSystemSectionTodo(
  section: DesignSystemProjectSection,
  todos: TodoItem[],
): TodoItem | undefined {
  return todos
    .filter((todo) => todo.status !== 'completed')
    .filter((todo) => designSystemTodoBelongsToSection(todo, section))
    .sort((first, second) => designSystemTodoRank(first) - designSystemTodoRank(second))[0];
}

function designSystemTodoRank(todo: TodoItem): number {
  if (todo.status === 'in_progress') return 0;
  if (todo.status === 'pending') return 1;
  return 2;
}

function designSystemTodoActivityPhase(
  section: DesignSystemProjectSection,
  todo: TodoItem,
): DesignSystemSectionActivityPhase {
  if (todo.status === 'pending') return 'planned';
  const text = designSystemTodoSearchText(todo);
  const isMutation = [
    'build',
    'copy',
    'create',
    'edit',
    'generate',
    'import',
    'register',
    'update',
    'write',
  ].some((keyword) => text.includes(keyword));
  if (isMutation) return 'writing';
  const isReading = [
    'analy',
    'browse',
    'explore',
    'fetch',
    'github',
    'inspect',
    'read',
    'repo',
    'search',
  ].some((keyword) => text.includes(keyword));
  if (isReading) return 'reading';
  return section.title === 'Preview' || section.title === 'UI kit' ? 'writing' : 'reading';
}

function designSystemTodoBelongsToSection(
  todo: TodoItem,
  section: DesignSystemProjectSection,
): boolean {
  const text = designSystemTodoSearchText(todo);
  if (section.files.some((name) => text.includes(designSystemReviewTitleFromPath(name)))) {
    return true;
  }
  switch (section.category) {
    case 'Type':
      return [
        'font',
        'type',
        'typography',
      ].some((keyword) => text.includes(keyword));
    case 'Colors':
      return [
        'color',
        'colors_and_type',
        'css variable',
        'palette',
        'theme',
        'token',
      ].some((keyword) => text.includes(keyword));
    case 'Spacing':
      return [
        'radius',
        'spacing',
        'space',
      ].some((keyword) => text.includes(keyword));
    case 'Components':
      return [
        'component',
        'interface',
        'prototype',
        'react',
        'ui kit',
        'ui_kit',
        'ui_kits',
      ].some((keyword) => text.includes(keyword));
    case 'Brand':
      return [
        'font',
        'icon',
        'logo',
        'brand',
        'asset',
        'upload',
      ].some((keyword) => text.includes(keyword));
  }
}

function designSystemTodoSearchText(todo: TodoItem): string {
  return `${todo.content} ${todo.activeForm ?? ''}`.toLowerCase();
}

function designSystemFileOpBelongsToSection(
  entry: FileOpEntry,
  section: DesignSystemProjectSection,
): boolean {
  const candidates = [entry.fullPath, entry.path].map(normalizeDesignSystemPath);
  const sectionFiles = [...section.files, section.requiredFile]
    .filter((name): name is string => Boolean(name))
    .map(normalizeDesignSystemPath);
  if (sectionFiles.some((name) => candidates.some((candidate) =>
    candidate === name || candidate.endsWith(`/${name}`),
  ))) {
    return true;
  }
  return candidates.some((path) => designSystemPathMatchesSection(path, section.category));
}

function designSystemPathMatchesSection(path: string, sectionTitle: string): boolean {
  const basename = designSystemBasename(path);
  switch (sectionTitle) {
    case 'Type':
      return !isDesignSystemEvidenceFile(path)
        && (isDesignSystemTokenFile(path) || DESIGN_SYSTEM_GUIDANCE_FILES.has(basename))
        && /\b(type|typography|font|text)\b/u.test(path);
    case 'Colors':
      return isDesignSystemTokenFile(path)
        && /\b(color|colors|palette|theme|token)\b/u.test(path);
    case 'Spacing':
      return isDesignSystemTokenFile(path)
        && /\b(space|spacing|radius)\b/u.test(path);
    case 'Components':
      return isDesignSystemUiKitFile(path);
    case 'Brand':
      return isDesignSystemAssetFile(path);
    default:
      return false;
  }
}

function normalizeDesignSystemPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();
}

function designSystemBasename(path: string): string {
  const segments = normalizeDesignSystemPath(path).split('/').filter(Boolean);
  return segments[segments.length - 1] ?? normalizeDesignSystemPath(path);
}

function designSystemSectionPhaseLabel(
  section: DesignSystemProjectSection,
  activity: DesignSystemSectionActivity,
): string {
  if (activity.phase === 'planned') {
    switch (section.category) {
      case 'Type':
        return 'Queued typography';
      case 'Colors':
        return 'Queued tokens';
      case 'Spacing':
        return 'Queued spacing';
      case 'Components':
        return 'Queued UI kit';
      case 'Brand':
        return 'Queued assets';
    }
  }
  if (activity.phase === 'reading') {
    switch (section.category) {
      case 'Type':
        return 'Reading typography';
      case 'Colors':
        return 'Reading tokens';
      case 'Spacing':
        return 'Reading spacing';
      case 'Components':
        return 'Reading UI kit';
      case 'Brand':
        return 'Reading assets';
    }
  }
  if (activity.phase === 'writing') {
    switch (section.category) {
      case 'Type':
        return 'Writing typography';
      case 'Colors':
        return 'Writing tokens';
      case 'Spacing':
        return 'Writing spacing';
      case 'Components':
        return 'Building UI kit';
      case 'Brand':
        return 'Updating assets';
    }
  }
  if (activity.phase === 'error') return 'Needs attention';
  if (activity.phase === 'updated') return 'Updated';
  return 'Needs review';
}

function designSystemSectionActivityLabel(
  section: DesignSystemProjectSection,
  activity: DesignSystemSectionActivity,
): string {
  if (activity.touchedFiles.length === 0) {
    return activity.todoText
      ? `${designSystemSectionPhaseLabel(section, activity)} from todo: ${truncateDesignSystemActivityText(activity.todoText)}`
      : designSystemSectionPhaseLabel(section, activity);
  }
  const label = activity.touchedFiles.slice(0, 3).join(', ');
  const suffix = activity.touchedFiles.length > 3 ? ` +${activity.touchedFiles.length - 3}` : '';
  if (activity.phase === 'idle') return `Read ${label}${suffix}`;
  return `${designSystemSectionPhaseLabel(section, activity)} ${label}${suffix}`;
}

function truncateDesignSystemActivityText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

export function designSystemSectionRunningNotice(
  section: DesignSystemProjectSection,
  activity: DesignSystemSectionActivity,
): string {
  if (activity.phase === 'reading') {
    return `Open Design is reading ${section.title} context for this section.`;
  }
  return `${designSystemSectionPhaseLabel(section, activity)} now.`;
}

export function designSystemReviewTimeLabel(value: string): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return `Last reviewed ${new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(time))}`;
}

export function designSystemReviewAgentTaskLabel(task: DesignSystemReviewAgentTask): string {
  switch (task.status) {
    case 'queued':
      return 'Feedback saved. The agent will pick it up when the current run finishes.';
    case 'sent':
      if (!task.sentAt) return 'Sent to agent.';
      {
        const label = designSystemReviewTimeLabel(task.sentAt)?.replace('Last reviewed', '').trim();
        return label ? `Sent to agent ${label}.` : 'Sent to agent.';
      }
    case 'failed':
      return task.error ? `Agent task failed: ${task.error}` : 'Agent task failed.';
  }
  return 'Agent task status unknown.';
}

export function designSystemSectionChangedAfterReview(
  names: string[],
  fileByName: Map<string, ProjectFile>,
  reviewEntry: DesignSystemReviewEntry | undefined,
): boolean {
  if (!reviewEntry || reviewEntry.decision !== 'needs-work') return false;
  const reviewedAt = Date.parse(reviewEntry.updatedAt);
  if (!Number.isFinite(reviewedAt)) return false;
  const trackedNames: string[] = reviewEntry.files && reviewEntry.files.length > 0
    ? reviewEntry.files
    : names;
  return trackedNames.some((name) => {
    const file = fileByName.get(name);
    return file ? file.mtime > reviewedAt : false;
  });
}
