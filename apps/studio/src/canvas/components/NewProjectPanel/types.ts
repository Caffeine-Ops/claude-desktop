import type { Dict } from '../../i18n/types';
import type {
  ProjectMetadata,
  ProjectPlatform,
  PromptTemplateSummary,
} from '../../types';
import { AUDIO_DURATIONS_SEC } from '../../media/models';

// Snapshot of a curated prompt template, captured at New Project time and
// folded into ProjectMetadata.promptTemplate. The user may have edited the
// prompt body before clicking Create — that edited copy lives here.
export type PromptTemplatePick = {
  summary: PromptTemplateSummary;
  prompt: string;
};

export const SFX_AUDIO_DURATIONS_SEC = AUDIO_DURATIONS_SEC.filter((sec) => sec <= 30);

export type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

export type NewProjectPlatform = Exclude<ProjectPlatform, 'auto'>;

export const DESIGN_PLATFORMS: Array<{
  value: NewProjectPlatform;
  labelKey: keyof Dict;
  hintKey: keyof Dict;
}> = [
  {
    value: 'responsive',
    labelKey: 'newproj.platform.responsive.label',
    hintKey: 'newproj.platform.responsive.hint',
  },
  {
    value: 'web-desktop',
    labelKey: 'newproj.platform.webDesktop.label',
    hintKey: 'newproj.platform.webDesktop.hint',
  },
  {
    value: 'mobile-ios',
    labelKey: 'newproj.platform.mobileIos.label',
    hintKey: 'newproj.platform.mobileIos.hint',
  },
  {
    value: 'mobile-android',
    labelKey: 'newproj.platform.mobileAndroid.label',
    hintKey: 'newproj.platform.mobileAndroid.hint',
  },
  {
    value: 'tablet',
    labelKey: 'newproj.platform.tablet.label',
    hintKey: 'newproj.platform.tablet.hint',
  },
  {
    value: 'desktop-app',
    labelKey: 'newproj.platform.desktopApp.label',
    hintKey: 'newproj.platform.desktopApp.hint',
  },
];

export type CreateTab = 'prototype' | 'live-artifact' | 'deck' | 'template' | 'media' | 'other';
export type MediaSurface = 'image' | 'video' | 'audio';

export interface CreateInput {
  name: string;
  skillId: string | null;
  designSystemId: string | null;
  metadata: ProjectMetadata;
}

export const TAB_LABEL_KEYS: Record<CreateTab, keyof Dict> = {
  prototype: 'newproj.tabPrototype',
  'live-artifact': 'newproj.tabLiveArtifact',
  deck: 'newproj.tabDeck',
  template: 'newproj.tabTemplate',
  media: 'newproj.tabMedia',
  other: 'newproj.tabOther',
};

export const MEDIA_SURFACE_LABEL_KEYS: Record<MediaSurface, keyof Dict> = {
  image: 'newproj.surfaceImage',
  video: 'newproj.surfaceVideo',
  audio: 'newproj.surfaceAudio',
};
