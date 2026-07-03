import type { SlideState } from './types';

const MAX_CACHED_SLIDE_STATES = 64;
export const htmlPreviewSlideState = new Map<string, SlideState>();

export function setSlideStateCached(key: string, state: SlideState) {
  htmlPreviewSlideState.set(key, state);
  if (htmlPreviewSlideState.size > MAX_CACHED_SLIDE_STATES) {
    const oldest = htmlPreviewSlideState.keys().next().value;
    if (oldest != null) htmlPreviewSlideState.delete(oldest);
  }
}
