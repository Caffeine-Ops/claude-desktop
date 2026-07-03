import type { Dict } from '../../i18n/types';
import type {
  AudioKind,
  MediaAspect,
  ProjectKind,
  ProjectMetadata,
  ProjectPlatform,
  ProjectTemplate,
} from '../../types';
import {
  DESIGN_PLATFORMS,
  MEDIA_SURFACE_LABEL_KEYS,
  TAB_LABEL_KEYS,
  type CreateTab,
  type MediaSurface,
  type NewProjectPlatform,
  type PromptTemplatePick,
  type TranslateFn,
} from './types';

export function buildMetadata(input: {
  tab: CreateTab;
  mediaSurface: MediaSurface;
  fidelity: 'wireframe' | 'high-fidelity';
  platformTargets: NewProjectPlatform[];
  includeLandingPage: boolean;
  includeOsWidgets: boolean;
  speakerNotes: boolean;
  animations: boolean;
  templateId: string | null;
  templates: ProjectTemplate[];
  imageModel: string;
  imageAspect: MediaAspect;
  videoModel: string;
  videoAspect: MediaAspect;
  videoLength: number;
  audioKind: AudioKind;
  audioModel: string;
  audioDuration: number;
  voice: string;
  inspirationIds: string[];
  promptTemplate: PromptTemplatePick | null;
}): ProjectMetadata {
  const kind: ProjectKind =
    input.tab === 'live-artifact'
      ? 'prototype'
      : input.tab === 'media'
        ? input.mediaSurface
        : input.tab;
  const selectedPlatforms = normalizeSelectedPlatforms(input.platformTargets);
  const concreteTargets = platformTargetsFor(selectedPlatforms);
  const canIncludeOsWidgets = platformTargetsSupportOsWidgets(concreteTargets);
  const surfaceOptions = {
    ...(input.includeLandingPage ? { includeLandingPage: true } : {}),
    ...(input.includeOsWidgets && canIncludeOsWidgets ? { includeOsWidgets: true } : {}),
  };
  const base = {
    platform: selectedPlatforms[0],
    platformTargets: concreteTargets,
    ...surfaceOptions,
  };
  const inspirations = input.inspirationIds.length > 0
    ? { inspirationDesignSystemIds: input.inspirationIds }
    : {};
  if (input.tab === 'prototype' || input.tab === 'live-artifact') {
    return {
      kind,
      ...base,
      // Live artifact is locked to high fidelity (the picker is hidden in
      // the panel) — wireframe live artifacts don't make sense.
      fidelity: input.tab === 'live-artifact' ? 'high-fidelity' : input.fidelity,
      ...(input.tab === 'live-artifact' ? { intent: 'live-artifact' as const } : {}),
      ...inspirations,
    };
  }
  if (input.tab === 'deck') {
    return { kind, speakerNotes: input.speakerNotes, ...inspirations };
  }
  if (input.tab === 'template') {
    if (input.templateId == null) {
      return { kind, ...base, animations: input.animations, ...inspirations };
    }
    const tpl = input.templates.find((x) => x.id === input.templateId);
    // The fallback label is consumed by the agent prompt rather than the
    // UI, so we keep it in English to match the rest of the prompt corpus.
    return {
      kind,
      ...base,
      animations: input.animations,
      templateId: input.templateId,
      templateLabel: tpl?.name ?? 'Saved template',
      ...inspirations,
    };
  }
  if (input.tab === 'media') {
    if (input.mediaSurface === 'image') {
      return {
        kind,
        imageModel: input.imageModel,
        imageAspect: input.imageAspect,
        ...buildPromptTemplateMetadata(input.promptTemplate),
        ...inspirations,
      };
    }
    if (input.mediaSurface === 'video') {
      return {
        kind,
        videoModel: input.videoModel,
        videoAspect: input.videoAspect,
        videoLength: input.videoLength,
        ...buildPromptTemplateMetadata(input.promptTemplate),
        ...inspirations,
      };
    }
    return {
      kind,
      audioKind: input.audioKind,
      audioModel: input.audioModel,
      audioDuration: input.audioDuration,
      ...(input.audioKind === 'speech' && input.voice.trim()
        ? { voice: input.voice.trim() }
        : {}),
      ...inspirations,
    };
  }
  return { kind: 'other', ...base, ...inspirations };
}

function normalizeSelectedPlatforms(platforms: NewProjectPlatform[]): NewProjectPlatform[] {
  const seen = new Set<NewProjectPlatform>();
  for (const platform of platforms) {
    if (DESIGN_PLATFORMS.some((option) => option.value === platform)) {
      seen.add(platform);
    }
  }
  return seen.size > 0 ? [...seen] : ['responsive'];
}

function platformTargetsSupportOsWidgets(platforms: ProjectPlatform[] | NewProjectPlatform[]): boolean {
  return platforms.some((platform) =>
    platform === 'mobile-ios'
    || platform === 'mobile-android'
    || platform === 'tablet',
  );
}

function platformTargetsFor(platforms: NewProjectPlatform[]): ProjectPlatform[] {
  const targets = new Set<ProjectPlatform>();
  for (const platform of platforms) {
    switch (platform) {
      case 'responsive':
        targets.add('responsive');
        break;
      case 'web-desktop':
        targets.add('web-desktop');
        break;
      case 'mobile-ios':
        targets.add('mobile-ios');
        break;
      case 'mobile-android':
        targets.add('mobile-android');
        break;
      case 'tablet':
        targets.add('tablet');
        break;
      case 'desktop-app':
        targets.add('desktop-app');
        break;
      default: {
        const exhaustive: never = platform;
        targets.add(exhaustive);
      }
    }
  }
  return targets.size > 0 ? [...targets] : ['responsive'];
}

function buildPromptTemplateMetadata(
  pick: PromptTemplatePick | null,
): { promptTemplate?: ProjectMetadata['promptTemplate'] } {
  if (!pick) return {};
  const trimmed = pick.prompt.trim();
  if (trimmed.length === 0) return {};
  const { summary } = pick;
  return {
    promptTemplate: {
      id: summary.id,
      surface: summary.surface,
      title: summary.title,
      prompt: trimmed,
      summary: summary.summary || undefined,
      category: summary.category || undefined,
      tags: summary.tags && summary.tags.length > 0 ? summary.tags : undefined,
      model: summary.model,
      aspect: summary.aspect,
      source: summary.source
        ? {
            repo: summary.source.repo,
            license: summary.source.license,
            author: summary.source.author,
            url: summary.source.url,
          }
        : undefined,
    },
  };
}

export function titleForTab(
  tab: CreateTab,
  mediaSurface: MediaSurface,
  t: TranslateFn,
): string {
  switch (tab) {
    case 'prototype':
      return t('newproj.titlePrototype');
    case 'live-artifact':
      return t('newproj.titleLiveArtifact');
    case 'deck':
      return t('newproj.titleDeck');
    case 'template':
      return t('newproj.titleTemplate');
    case 'media': {
      // Title tracks the active surface so the heading still reads "New
      // image" / "New video" / "New audio" — the shared "Media" label only
      // appears on the tab strip itself.
      const key: keyof Dict =
        mediaSurface === 'image'
          ? 'newproj.titleImage'
          : mediaSurface === 'video'
            ? 'newproj.titleVideo'
            : 'newproj.titleAudio';
      return t(key);
    }
    case 'other':
      return t('newproj.titleOther');
  }
}

export function autoName(
  tab: CreateTab,
  mediaSurface: MediaSurface,
  t: TranslateFn,
): string {
  const stamp = new Date().toLocaleDateString();
  // For the Media tab the auto name reads "Image · {date}" / "Video · …" /
  // "Audio · …" so the project list still surfaces the actual surface.
  const labelKey: keyof Dict =
    tab === 'media' ? MEDIA_SURFACE_LABEL_KEYS[mediaSurface] : TAB_LABEL_KEYS[tab];
  return `${t(labelKey)} · ${stamp}`;
}
