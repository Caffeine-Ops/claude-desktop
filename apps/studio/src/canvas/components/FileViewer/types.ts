import type { Dict } from '../../i18n/types';
import type { ManualEditStyles } from '../../edit-mode/types';
import type { WebDeployProviderId } from '../../providers/registry';

export type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;
export type SlideState = { active: number; count: number };
export type BoardTool = 'inspect' | 'pod';
export type StrokePoint = { x: number; y: number };
export type ManualEditPendingStyleSave = {
  id: string;
  styles: Partial<ManualEditStyles>;
  label: string;
  version: number;
};
export type PreviewViewportId = 'desktop' | 'tablet' | 'mobile';
export type PreviewCanvasSize = { width: number; height: number };
export type PreviewViewportPreset = {
  id: PreviewViewportId;
  width: number | null;
  height: number | null;
  labelKey: keyof Dict;
  titleKey: keyof Dict;
};
export type DeployProviderOption = {
  id: WebDeployProviderId;
  labelKey: 'fileViewer.vercelProvider' | 'fileViewer.cloudflarePagesProvider';
  tokenLink: string;
  tokenLinkKey: 'fileViewer.vercelTokenGetLink' | 'fileViewer.cloudflareApiTokenGetLink';
  tokenPlaceholderKey:
    | 'fileViewer.vercelTokenPlaceholder'
    | 'fileViewer.cloudflareApiTokenPlaceholder';
  tokenReuseHintKey: 'fileViewer.vercelTokenReuseHint' | 'fileViewer.cloudflareApiTokenReuseHint';
  tokenRequiredKey: 'fileViewer.vercelTokenRequired' | 'fileViewer.cloudflareApiTokenRequired';
  previewHintKey: 'fileViewer.vercelPreviewOnly' | 'fileViewer.cloudflarePagesPreviewHint';
  tokenLabelKey:
    | 'fileViewer.vercelToken'
    | 'fileViewer.cloudflareApiToken';
  accountIdLabelKey?: 'fileViewer.cloudflareAccountId';
  accountIdHintKey?: 'fileViewer.cloudflareAccountIdHint';
};
export type CloudflarePagesZoneOption = {
  id: string;
  name: string;
  status?: string;
  type?: string;
};
export type DeployResultCard = {
  id: string;
  label: string;
  url: string;
  status: string;
  message?: string;
};

// The five basic style facets the inspect panel exposes. Kept narrow on
// purpose — open-slide's design tokens panel only edits global tokens, so
// the per-element delta is small + obvious + cheap to read back from
// getComputedStyle on the iframe side.
export type InspectStyleSnapshot = {
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  fontWeight?: string;
  paddingTop?: string;
  paddingRight?: string;
  paddingBottom?: string;
  paddingLeft?: string;
  borderRadius?: string;
  textAlign?: string;
  fontFamily?: string;
  lineHeight?: string;
};

export type InspectClickedDescendant = {
  label: string;
  text: string;
};

export type InspectTarget = {
  elementId: string;
  selector: string;
  label: string;
  text: string;
  style: InspectStyleSnapshot;
  clickedDescendant?: InspectClickedDescendant;
};
