import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { APP_CHROME_FILE_ACTIONS_ID } from '../shared/AppChromeHeader';
import { usePortalMenuPosition } from '../shared/usePortalMenuPosition';
import {
  anonymizeArtifactId,
  artifactKindToTracking,
  type TrackingProjectKind,
} from '@open-design/contracts/analytics';
import { useAnalytics } from '../../analytics/provider';
import {
  trackArtifactExportResult,
  trackArtifactHeaderClick,
  trackArtifactToolbarClick,
  trackPageView,
  trackPresentPopoverClick,
  trackShareOptionPopoverClick,
  trackTweaksPopoverClick,
} from '../../analytics/events';
import { artifactRendererRegistry } from '../../artifacts/renderer-registry';
import { useT } from '../../i18n';
import {
  checkDeploymentLink,
  CLOUDFLARE_PAGES_PROVIDER_ID,
  DEFAULT_DEPLOY_PROVIDER_ID,
  deployProjectFile,
  fetchCloudflarePagesZones,
  fetchDeployConfig,
  fetchProjectDeployments,
  fetchProjectFileText,
  uploadProjectFiles,
  projectRawUrl,
  updateDeployConfig,
  type WebDeployConfigResponse,
  type WebCloudflarePagesDeploySelection,
  type WebDeploymentInfo,
  type WebDeployProjectFileResponse,
  type WebDeployProviderId,
  type WebUpdateDeployConfigRequest,
  writeProjectTextFile,
} from '../../providers/registry';
import {
  exportAsHtml,
  exportAsImage,
  exportAsMd,
  exportAsPdf,
  exportProjectAsPdf,
  exportProjectAsZip,
  openSandboxedPreviewInNewTab,
  requestPreviewSnapshot,
} from '../../runtime/exports';
import { buildLazySrcdocTransport, buildSrcdoc, canActivateSrcDocTransport } from '../../runtime/srcdoc';
import {
  hasTweaksTemplate,
  hasUrlModeBridge,
  htmlNeedsSandboxShim,
  parseForceInline,
  shouldUrlLoadHtmlPreview,
} from '../files/file-viewer-render-mode';
import { saveTemplate } from '../../state/projects';
import type {
  ChatCommentAttachment,
  PreviewComment,
  PreviewCommentTarget,
  ProjectFile,
} from '../../types';
import { Icon } from '../shared/Icon';
import { Toast } from '../shared/Toast';
import { PaletteTweaks, type PaletteId } from '../files/PaletteTweaks';
import { PreviewDrawOverlay, type PreviewDrawMode } from '../shared/PreviewDrawOverlay';
import {
  buildBoardCommentAttachments,
  commentsToAttachments,
  liveSnapshotForComment,
  targetFromSnapshot,
  type PreviewCommentSnapshot,
} from '../../comments';
import { applyPodMemberRemoval } from '../../lib/pod-members';
import { BoardComposerPopover } from '../files/BoardComposerPopover';
import { ManualEditPanel, emptyManualEditDraft, type ManualEditDraft } from '../files/ManualEditPanel';
import {
  applyManualEditPatch,
  isManualEditFullHtmlDocument,
  readManualEditAttributes,
  readManualEditFields,
  readManualEditOuterHtml,
  readManualEditStyles,
} from '../../edit-mode/source-patches';
import type { ManualEditBridgeMessage, ManualEditHistoryEntry, ManualEditPatch, ManualEditStyles, ManualEditTarget } from '../../edit-mode/types';
import { isRenderableSketchJson } from '../sketch/SketchPreview';
import type {
  BoardTool,
  CloudflarePagesZoneOption,
  DeployResultCard,
  InspectClickedDescendant,
  InspectStyleSnapshot,
  InspectTarget,
  ManualEditPendingStyleSave,
  PreviewViewportId,
  SlideState,
  StrokePoint,
} from './types';
import { htmlPreviewSlideState, setSlideStateCached } from './slide-state';
import {
  PreviewViewportControls,
  effectivePreviewScale,
  manualEditPreviewShellStyle,
  previewScaleShellStyle,
  previewViewportStyle,
  usePreviewCanvasSize,
} from './preview-viewport';
import {
  cancelManualEditPendingStyleSnapshot,
  manualEditInspectorStyleValue,
  manualEditPersistedValueMatchesSavedSnapshot,
  mergeManualEditInspectorStyles,
} from './manual-edit-helpers';
import {
  DEPLOY_PROVIDER_OPTIONS,
  deployResultState,
  getDeployProviderOption,
  isValidCloudflareDomainPrefixInput,
  normalizeCloudflareDomainPrefixInput,
} from './deploy-helpers';
import {
  applyInspectOverridesToSource,
  parseInspectOverridesFromSource,
  serializeInspectOverrides,
  updateInspectOverride,
  type InspectOverrideMap,
} from './inspect-overrides';
import {
  CommentPreviewOverlays,
  buildPodSnapshot,
  clampBridgeCoordinate,
  finiteBridgeInteger,
} from './comment-overlays';
import { CommentSidePanel } from './CommentSidePanel';
import { InspectPanel } from './InspectPanel';
import {
  AudioViewer,
  BinaryViewer,
  DocumentPreviewViewer,
  ImageViewer,
  MarkdownViewer,
  ReactComponentViewer,
  SketchViewer,
  SvgViewer,
  TextViewer,
  VideoViewer,
} from './media-viewers';

const EXPORT_READY_NUDGE_STORAGE_PREFIX = 'open-design:export-ready-nudge:';

interface Props {
  projectId: string;
  projectKind: TrackingProjectKind;
  file: ProjectFile;
  liveHtml?: string;
  filesRefreshKey?: number;
  isDeck?: boolean;
  onExportAsPptx?: ((fileName: string) => void) | undefined;
  streaming?: boolean;
  previewComments?: PreviewComment[];
  onSavePreviewComment?: (target: PreviewCommentTarget, note: string, attachAfterSave: boolean) => Promise<PreviewComment | null>;
  onRemovePreviewComment?: (commentId: string) => Promise<void>;
  onSendBoardCommentAttachments?: (attachments: ChatCommentAttachment[]) => Promise<void> | void;
  onFileSaved?: () => Promise<void> | void;
}

export function FileViewer({
  projectId,
  projectKind,
  file,
  liveHtml,
  filesRefreshKey = 0,
  isDeck,
  onExportAsPptx,
  streaming,
  previewComments = [],
  onSavePreviewComment,
  onRemovePreviewComment,
  onSendBoardCommentAttachments,
  onFileSaved,
}: Props) {
  const rendererMatch = artifactRendererRegistry.resolve({
    file,
    isDeckHint: Boolean(isDeck),
  });

  // studio_view artifact — fire once per (project, file) pair so the
  // activation funnel can attribute "user opened the produced artifact"
  // even when the sub-viewer below is HtmlViewer / MarkdownViewer / etc.
  // artifact_id is anonymized to satisfy the CSV's no-filename rule.
  const analytics = useAnalytics();
  const studioViewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${projectId}::${file.name}`;
    if (studioViewKeyRef.current === key) return;
    studioViewKeyRef.current = key;
    trackPageView(analytics.track, {
      page_name: 'artifact',
    });
  }, [projectId, projectKind, file.name, file.kind, rendererMatch?.renderer.id, analytics.track]);

  if (rendererMatch?.renderer.id === 'html' || rendererMatch?.renderer.id === 'deck-html') {
    return (
      <HtmlViewer
        projectId={projectId}
        projectKind={projectKind}
        file={file}
        liveHtml={liveHtml}
        filesRefreshKey={filesRefreshKey}
        isDeck={rendererMatch.renderer.id === 'deck-html'}
        onExportAsPptx={onExportAsPptx}
        streaming={Boolean(streaming)}
        previewComments={previewComments}
        onSavePreviewComment={onSavePreviewComment}
        onRemovePreviewComment={onRemovePreviewComment}
        onSendBoardCommentAttachments={onSendBoardCommentAttachments}
        onFileSaved={onFileSaved}
      />
    );
  }
  if (rendererMatch?.renderer.id === 'react-component') {
    return <ReactComponentViewer projectId={projectId} file={file} />;
  }
  if (rendererMatch?.renderer.id === 'markdown') {
    return <MarkdownViewer projectId={projectId} file={file} />;
  }
  if (rendererMatch?.renderer.id === 'svg') {
    return <SvgViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'image') {
    return <ImageViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'video') {
    return <VideoViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'audio') {
    return <AudioViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'sketch') {
    if (isRenderableSketchJson(file)) {
      return <SketchViewer projectId={projectId} file={file} />;
    }
    return <ImageViewer projectId={projectId} file={file} />;
  }
  if (file.kind === 'text' || file.kind === 'code') {
    return <TextViewer projectId={projectId} file={file} />;
  }
  if (
    file.kind === 'pdf' ||
    file.kind === 'document' ||
    file.kind === 'presentation' ||
    file.kind === 'spreadsheet'
  ) {
    return <DocumentPreviewViewer projectId={projectId} file={file} />;
  }
  return <BinaryViewer projectId={projectId} file={file} />;
}

function exportReadyNudgeKey(projectId: string, fileName: string): string {
  return `${EXPORT_READY_NUDGE_STORAGE_PREFIX}${projectId}:${fileName}`;
}

function hasSeenExportReadyNudge(projectId: string, fileName: string): boolean {
  try {
    return window.sessionStorage.getItem(exportReadyNudgeKey(projectId, fileName)) === '1';
  } catch {
    return false;
  }
}

function markExportReadyNudgeSeen(projectId: string, fileName: string) {
  try {
    window.sessionStorage.setItem(exportReadyNudgeKey(projectId, fileName), '1');
  } catch {
    // Ignore storage-denied contexts; the in-memory state still prevents loops.
  }
}

function HtmlViewer({
  projectId,
  projectKind,
  file,
  liveHtml,
  filesRefreshKey = 0,
  isDeck,
  onExportAsPptx,
  streaming,
  previewComments = [],
  onSavePreviewComment,
  onRemovePreviewComment,
  onSendBoardCommentAttachments,
  onFileSaved,
}: {
  projectId: string;
  projectKind: TrackingProjectKind;
  file: ProjectFile;
  liveHtml?: string;
  filesRefreshKey?: number;
  isDeck: boolean;
  onExportAsPptx?: ((fileName: string) => void) | undefined;
  streaming: boolean;
  previewComments?: PreviewComment[];
  onSavePreviewComment?: (target: PreviewCommentTarget, note: string, attachAfterSave: boolean) => Promise<PreviewComment | null>;
  onRemovePreviewComment?: (commentId: string) => Promise<void>;
  onSendBoardCommentAttachments?: (attachments: ChatCommentAttachment[]) => Promise<void> | void;
  onFileSaved?: () => Promise<void> | void;
}) {
  const t = useT();
  const analytics = useAnalytics();
  // Shared helper for the share menu: emit studio_click share_option on
  // entry and artifact_export_result on resolution. Sync exports report
  // success immediately after the call returns; async exports get .then
  // / .catch. The same request_id threads both events so PostHog can
  // stitch click → result via $insert_id correlation.
  const fireShareExport = (
    format:
      | 'pdf'
      | 'pptx'
      | 'zip'
      | 'html'
      | 'markdown'
      | 'template'
      | 'vercel'
      | 'cloudflare_pages',
    fn: () => Promise<unknown> | unknown,
  ) => {
    const requestId = analytics.newRequestId();
    const artifactId = anonymizeArtifactId({ projectId, fileName: file.name });
    const artifactKind = artifactKindToTracking({ fileKind: file.kind ?? null });
    trackShareOptionPopoverClick(
      analytics.track,
      {
        page_name: 'artifact',
        area: 'share_option_popover',
        artifact_id: artifactId,
        artifact_kind: artifactKind,
        element: format,
        project_id: projectId,
        project_kind: projectKind,
      },
      { requestId },
    );
    const started = performance.now();
    const finish = (result: 'success' | 'failed' | 'cancelled', errorCode?: string) => {
      trackArtifactExportResult(
        analytics.track,
        {
          page_name: 'artifact',
          area: 'share_option_popover',
          artifact_id: artifactId,
          artifact_kind: artifactKind,
          project_id: projectId,
          project_kind: projectKind,
          export_format: format,
          result,
          ...(errorCode ? { error_code: errorCode } : {}),
          export_duration_ms: Math.round(performance.now() - started),
        },
        { requestId },
      );
    };
    try {
      const out = fn();
      if (out && typeof (out as Promise<unknown>).then === 'function') {
        (out as Promise<unknown>).then(
          () => finish('success'),
          (err) => finish('failed', err instanceof Error ? err.name : 'UNKNOWN'),
        );
      } else {
        finish('success');
      }
    } catch (err) {
      finish('failed', err instanceof Error ? err.name : 'UNKNOWN');
    }
  };
  // P0 helpers — keep the artifact_id + artifact_kind derivation in one place
  // so each per-button onClick stays a one-liner. We compute lazily inside the
  // closure because `file.kind` / `file.name` can change as the user navigates
  // tabs without remounting HtmlViewer.
  const fireArtifactToolbarClick = (
    element:
      | 'reload'
      | 'preview'
      | 'source'
      | 'tweaks'
      | 'draw'
      | 'comment'
      | 'pods'
      | 'inspect'
      | 'edit'
      | 'zoom_out'
      | 'zoom_level_dropdown'
      | 'zoom_in',
  ) => {
    trackArtifactToolbarClick(analytics.track, {
      page_name: 'artifact',
      area: 'artifact_toolbar',
      element,
      artifact_id: anonymizeArtifactId({ projectId, fileName: file.name }),
      artifact_kind: artifactKindToTracking({ fileKind: file.kind ?? null }),
    });
  };
  const fireArtifactHeaderClick = (
    element: 'back' | 'edit' | 'present_dropdown' | 'share_dropdown' | 'settings',
  ) => {
    trackArtifactHeaderClick(analytics.track, {
      page_name: 'artifact',
      area: 'artifact_header',
      element,
      artifact_id: anonymizeArtifactId({ projectId, fileName: file.name }),
      artifact_kind: artifactKindToTracking({ fileKind: file.kind ?? null }),
    });
  };
  const firePresentPopoverClick = (
    element: 'in_this_tab' | 'fullscreen' | 'new_tab',
  ) => {
    trackPresentPopoverClick(analytics.track, {
      page_name: 'artifact',
      area: 'present_popover',
      element,
      artifact_id: anonymizeArtifactId({ projectId, fileName: file.name }),
      artifact_kind: artifactKindToTracking({ fileKind: file.kind ?? null }),
    });
  };
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [source, setSource] = useState<string | null>(liveHtml ?? null);
  const [inlinedSource, setInlinedSource] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [previewViewport, setPreviewViewport] = useState<PreviewViewportId>('desktop');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);
  const zoomMenuRef = useRef<HTMLDivElement | null>(null);
  const [presentMenuOpen, setPresentMenuOpen] = useState(false);
  const [shareMenuOpen, setShareMenuOpen] = useState(false);
  // Both menus portal to <body> to escape the chrome stacking context (the
  // dropdowns were painted under the viewer toolbar). The hook owns fixed
  // positioning + outside-click/Escape; see usePortalMenuPosition.
  const {
    wrapRef: presentWrapRef,
    menuRef: presentMenuRef,
    menuPos: presentMenuPos,
  } = usePortalMenuPosition(presentMenuOpen, setPresentMenuOpen);
  const {
    wrapRef: shareRef,
    menuRef: shareMenuRef,
    menuPos: shareMenuPos,
  } = usePortalMenuPosition(shareMenuOpen, setShareMenuOpen);
  const [exportReadyNudge, setExportReadyNudge] = useState(false);
  const exportReadyNudgeSeenRef = useRef<Set<string>>(new Set());
  // Template save UX. We surface a transient "Saved" pill in the share
  // menu so the user gets feedback without a noisy toast layer.
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateNote, setTemplateNote] = useState<string | null>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templateDescription, setTemplateDescription] = useState('');
  const [templateSaveError, setTemplateSaveError] = useState<string | null>(null);
  const [deployment, setDeployment] = useState<WebDeploymentInfo | null>(null);
  const [deploymentsByProvider, setDeploymentsByProvider] = useState<Partial<Record<WebDeployProviderId, WebDeploymentInfo>>>({});
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [deployConfig, setDeployConfig] = useState<WebDeployConfigResponse | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployPhase, setDeployPhase] = useState<'idle' | 'deploying' | 'preparing-link'>('idle');
  const [savingDeployConfig, setSavingDeployConfig] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployResult, setDeployResult] = useState<WebDeployProjectFileResponse | null>(null);
  const [copiedDeployLink, setCopiedDeployLink] = useState<string | null>(null);
  const [deployProviderId, setDeployProviderId] = useState<WebDeployProviderId>(DEFAULT_DEPLOY_PROVIDER_ID);
  const [deployToken, setDeployToken] = useState('');
  const [teamId, setTeamId] = useState('');
  const [teamSlug, setTeamSlug] = useState('');
  const [cloudflareAccountId, setCloudflareAccountId] = useState('');
  const [cloudflareZones, setCloudflareZones] = useState<CloudflarePagesZoneOption[]>([]);
  const [cloudflareZonesLoading, setCloudflareZonesLoading] = useState(false);
  const [cloudflareZonesError, setCloudflareZonesError] = useState<string | null>(null);
  const [cloudflareZoneId, setCloudflareZoneId] = useState('');
  const [cloudflareDomainPrefix, setCloudflareDomainPrefix] = useState('');
  const deployProviderLoadSeqRef = useRef(0);
  const [inTabPresent, setInTabPresent] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [boardMode, setBoardMode] = useState(false);
  const [boardTool, setBoardTool] = useState<BoardTool>('inspect');
  const [inspectMode, setInspectMode] = useState(false);
  const [palettePopoverOpen, setPalettePopoverOpen] = useState(false);
  const [selectedPalette, setSelectedPalette] = useState<PaletteId | null>(null);
  const [previewPalette, setPreviewPalette] = useState<PaletteId | null>(null);
  const [drawOverlayOpen, setDrawOverlayOpen] = useState(false);
  const [drawOverlayMode, setDrawOverlayMode] = useState<PreviewDrawMode>('click');
  // for hint managing hint box state
  const [openHintBox, setOpenHintBox] = useState(true);
  const [manualEditMode, setManualEditModeRaw] = useState(false);
  const [manualEditFrozenSource, setManualEditFrozenSource] = useState<string | null>(null);
  const [manualEditViewportWidth, setManualEditViewportWidth] = useState<number | null>(null);
  const [previewBodyRef, previewBodySize] = usePreviewCanvasSize<HTMLDivElement>();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const urlPreviewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const srcDocPreviewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const activatedSrcDocTransportHtmlRef = useRef<string | null>(null);
  const isActivePreviewIframeSource = useCallback((source: MessageEventSource | null) => {
    return !!source && source === iframeRef.current?.contentWindow;
  }, []);
  const isOurPreviewIframeSource = useCallback((source: MessageEventSource | null) => {
    if (!source) return false;
    return (
      source === iframeRef.current?.contentWindow ||
      source === urlPreviewIframeRef.current?.contentWindow ||
      source === srcDocPreviewIframeRef.current?.contentWindow
    );
  }, []);
  const previewScrollRestoreRef = useRef<{
    hostLeft: number;
    hostTop: number;
    frameLeft: number;
    frameTop: number;
    canvasLeft: number;
    canvasTop: number;
    expiresAt: number;
  } | null>(null);
  const previewScrollPositionRef = useRef({
    frameLeft: 0,
    frameTop: 0,
    canvasLeft: 0,
    canvasTop: 0,
  });
  const previewScrollRequestAtRef = useRef(0);
  const dcViewportRef = useRef({
    x: 0,
    y: 0,
    scale: 1,
  });
  const dcViewportRestoreAtRef = useRef(0);
  const setManualEditMode = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    setManualEditModeRaw((prev) => {
      const value = typeof next === 'function' ? (next as (p: boolean) => boolean)(prev) : next;
      if (value !== prev && !value) {
        setManualEditFrozenSource(null);
        setManualEditViewportWidth(null);
      }
      return value;
    });
  }, []);
  const capturePreviewScrollPosition = useCallback(() => {
    const host = previewBodyRef.current;
    let frameLeft = 0;
    let frameTop = 0;
    let canvasLeft = 0;
    let canvasTop = 0;
    try {
      const frameDocument = iframeRef.current?.contentWindow?.document;
      const frameScroll = frameDocument?.scrollingElement;
      const canvasScroll = frameDocument?.querySelector<HTMLElement>('.design-canvas');
      frameLeft = frameScroll?.scrollLeft ?? 0;
      frameTop = frameScroll?.scrollTop ?? 0;
      canvasLeft = canvasScroll?.scrollLeft ?? 0;
      canvasTop = canvasScroll?.scrollTop ?? 0;
    } catch {
      frameLeft = 0;
      frameTop = 0;
      canvasLeft = 0;
      canvasTop = 0;
    }
    previewScrollRestoreRef.current = {
      hostLeft: host?.scrollLeft ?? 0,
      hostTop: host?.scrollTop ?? 0,
      frameLeft: frameLeft || previewScrollPositionRef.current.frameLeft,
      frameTop: frameTop || previewScrollPositionRef.current.frameTop,
      canvasLeft: canvasLeft || previewScrollPositionRef.current.canvasLeft,
      canvasTop: canvasTop || previewScrollPositionRef.current.canvasTop,
      expiresAt: Date.now() + 5000,
    };
  }, []);
  const restorePreviewScrollPosition = useCallback(() => {
    const snapshot = previewScrollRestoreRef.current;
    if (!snapshot) return;
    if (Date.now() > snapshot.expiresAt) {
      previewScrollRestoreRef.current = null;
      return;
    }
    const apply = () => {
      const previewBody = previewBodyRef.current;
      if (typeof previewBody?.scrollTo === 'function') {
        previewBody.scrollTo(snapshot.hostLeft, snapshot.hostTop);
      }
      try {
        const frameDocument = iframeRef.current?.contentWindow?.document;
        frameDocument?.scrollingElement?.scrollTo(snapshot.frameLeft, snapshot.frameTop);
        frameDocument?.querySelector<HTMLElement>('.design-canvas')?.scrollTo(snapshot.canvasLeft, snapshot.canvasTop);
        iframeRef.current?.contentWindow?.postMessage({
          type: 'od:preview-scroll-restore',
          frameLeft: snapshot.frameLeft,
          frameTop: snapshot.frameTop,
          canvasLeft: snapshot.canvasLeft,
          canvasTop: snapshot.canvasTop,
        }, '*');
      } catch {}
    };
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        apply();
        window.setTimeout(apply, 80);
        window.setTimeout(() => {
          if (previewScrollRestoreRef.current === snapshot) {
            apply();
          }
        }, 260);
      });
    });
  }, []);
  const [manualEditTargets, setManualEditTargets] = useState<ManualEditTarget[]>([]);
  const [selectedManualEditTarget, setSelectedManualEditTarget] = useState<ManualEditTarget | null>(null);
  const selectedManualEditTargetIdRef = useRef<string | null>(null);
  const [manualEditDraft, setManualEditDraft] = useState<ManualEditDraft>(() => emptyManualEditDraft());
  const [manualEditHistory, setManualEditHistory] = useState<ManualEditHistoryEntry[]>([]);
  const [manualEditUndone, setManualEditUndone] = useState<ManualEditHistoryEntry[]>([]);
  const [manualEditError, setManualEditError] = useState<string | null>(null);
  const [manualEditSaving, setManualEditSaving] = useState(false);
  const manualEditSavingRef = useRef(false);
  const manualEditPendingStyleRef = useRef<ManualEditPendingStyleSave | null>(null);
  const manualEditStyleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualEditPreviewVersionRef = useRef(0);
  const sourceRef = useRef<string | null>(source);
  const sourceFileKeyRef = useRef<string | null>(null);
  const templateNameId = useId();
  const templateDescriptionId = useId();
  // Opt back into the legacy inline-asset srcDoc path via `?forceInline=1`
  // on the host page. Lets users escape-hatch around the URL-load default
  // for non-deck HTML that depends on the in-iframe localStorage shim.
  const forceInline = useMemo(
    () => (typeof window === 'undefined' ? false : parseForceInline(window.location.search)),
    [],
  );
  const [activeCommentTarget, setActiveCommentTarget] = useState<PreviewCommentSnapshot | null>(null);
  const [hoveredCommentTarget, setHoveredCommentTarget] = useState<PreviewCommentSnapshot | null>(null);
  const [hoveredPodMemberId, setHoveredPodMemberId] = useState<string | null>(null);
  const [activePreviewCommentId, setActivePreviewCommentId] = useState<string | null>(null);
  const [liveCommentTargets, setLiveCommentTargets] = useState<Map<string, PreviewCommentSnapshot>>(() => new Map());
  const liveCommentTargetsRef = useRef(liveCommentTargets);
  const [commentDraft, setCommentDraft] = useState('');
  // Inspect mode shares the iframe selection bridge with comment mode but
  // routes the picked element to a side panel that mutates per-element CSS
  // overrides via postMessage. The host owns the authoritative override map:
  // it is hydrated from the artifact's persisted <style> block on load and
  // mutated only by host-driven onApply / reset actions. Save-to-source
  // serializes that host map directly — iframe od:inspect-overrides messages
  // are preview acknowledgements and never feed save input, so artifact JS
  // forging a postMessage cannot tamper with what gets persisted.
  const [activeInspectTarget, setActiveInspectTarget] = useState<InspectTarget | null>(null);
  const [inspectOverrides, setInspectOverrides] = useState<InspectOverrideMap>(() =>
    typeof source === 'string' ? parseInspectOverridesFromSource(source) : {},
  );
  // Track which `source` value the host map was last hydrated from so the
  // setState-during-render hydration below only fires when the artifact
  // text actually changes (file switch, save round-trip, live edits). The
  // ref is initialised to `source` so the matching useState initialiser
  // above counts as the first hydration.
  const inspectHydratedSourceRef = useRef<string | null | undefined>(source);
  const [savingInspect, setSavingInspect] = useState(false);
  const [inspectSavedAt, setInspectSavedAt] = useState<number | null>(null);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [queuedBoardNotes, setQueuedBoardNotes] = useState<string[]>([]);
  const [sendingBoardBatch, setSendingBoardBatch] = useState(false);
  const [commentSavedToast, setCommentSavedToast] = useState<string | null>(null);
  const [templateSavedToast, setTemplateSavedToast] = useState<string | null>(null);
  const [selectedSideCommentIds, setSelectedSideCommentIds] = useState<Set<string>>(() => new Set());
  const [commentSidePanelCollapsed, setCommentSidePanelCollapsed] = useState(false);
  const [strokePoints, setStrokePoints] = useState<StrokePoint[]>([]);
  const [tweaksMode, setTweaksMode] = useState(false);
  const [tweaksAvailable, setTweaksAvailable] = useState(false);
  // Tracks the `file.name` for which we've already mirrored the artifact's
  // initial `__edit_mode_available` announcement into `tweaksMode`. Agent-
  // generated `.twk-panel` artifacts mount their panel visible by default,
  // so the toolbar toggle should also start ON — otherwise the user has to
  // click toggle-on → toggle-off to actually hide the panel they're seeing.
  // We only mirror ONCE per file: subsequent re-emissions (iframe remount
  // when the user flips render mode by opening Themes, etc.) would otherwise
  // re-toggle the user's choice.
  const firstEditModeAvailableSeenForFileRef = useRef<string | null>(null);
  const previewStateKey = `${projectId}:${file.name}`;
  const previewScale = zoom / 100;

  function deploymentMapForCurrentFile(items: WebDeploymentInfo[]) {
    const next: Partial<Record<WebDeployProviderId, WebDeploymentInfo>> = {};
    for (const option of DEPLOY_PROVIDER_OPTIONS) {
      const deploymentForProvider = items.find(
        (item) => item.fileName === file.name && item.providerId === option.id && item.url?.trim(),
      );
      if (deploymentForProvider) next[option.id] = deploymentForProvider;
    }
    return next;
  }

  function syncDeployFormFromConfig(
    providerId: WebDeployProviderId,
    config: WebDeployConfigResponse | null,
  ) {
    const matchingConfig = config?.providerId === providerId ? config : null;
    setDeployProviderId(providerId);
    setDeployConfig(matchingConfig);
    setDeployToken(matchingConfig?.tokenMask || '');
    setTeamId(matchingConfig?.teamId || '');
    setTeamSlug(matchingConfig?.teamSlug || '');
    setCloudflareAccountId(matchingConfig?.accountId || '');
    setCloudflareZoneId(matchingConfig?.cloudflarePages?.lastZoneId || '');
    setCloudflareDomainPrefix(matchingConfig?.cloudflarePages?.lastDomainPrefix || '');
  }

  function cloudflareConfigHintsFromForm() {
    const zone = cloudflareZones.find((item) => item.id === cloudflareZoneId);
    const hints = {
      ...(cloudflareZoneId.trim() ? { lastZoneId: cloudflareZoneId.trim() } : {}),
      ...((zone?.name || deployConfig?.cloudflarePages?.lastZoneName)
        ? { lastZoneName: zone?.name || deployConfig?.cloudflarePages?.lastZoneName }
        : {}),
      ...(cloudflareDomainPrefix.trim()
        ? { lastDomainPrefix: normalizeCloudflareDomainPrefixInput(cloudflareDomainPrefix) }
        : {}),
    };
    return Object.keys(hints).length > 0 ? hints : undefined;
  }

  function buildDeployConfigRequest(providerId: WebDeployProviderId): WebUpdateDeployConfigRequest {
    const token = deployToken.trim();
    if (providerId === CLOUDFLARE_PAGES_PROVIDER_ID) {
      return {
        providerId,
        token,
        accountId: cloudflareAccountId.trim(),
        cloudflarePages: cloudflareConfigHintsFromForm(),
      };
    }
    return {
      providerId,
      token,
      teamId: teamId.trim(),
      teamSlug: teamSlug.trim(),
    };
  }

  async function loadDeployProvider(
    providerId: WebDeployProviderId,
    options?: { fallbackToExisting?: boolean },
  ) {
    const requestSeq = ++deployProviderLoadSeqRef.current;
    setDeployProviderId(providerId);
    const deployments = await fetchProjectDeployments(projectId);
    const nextDeploymentsByProvider = deploymentMapForCurrentFile(deployments);
    const exactDeployment = nextDeploymentsByProvider[providerId] ?? null;
    const fallbackDeployment = options?.fallbackToExisting
      ? Object.values(nextDeploymentsByProvider)[0] ?? null
      : null;
    const currentDeployment = exactDeployment ?? fallbackDeployment;
    // Use the explicit providerId for config/form so a fallback deployment from
    // another provider only fills the existing-URL display, never the form/credentials.
    const config = await fetchDeployConfig(providerId);
    if (requestSeq !== deployProviderLoadSeqRef.current) {
      return { config: null, currentDeployment: null };
    }
    syncDeployFormFromConfig(providerId, config);
    setDeploymentsByProvider(nextDeploymentsByProvider);
    setDeployment(currentDeployment ?? null);
    setDeployResult(currentDeployment ?? null);
    if (providerId === CLOUDFLARE_PAGES_PROVIDER_ID && config?.configured) {
      void loadCloudflareZones(config, { requestSeq });
    }
    return { config, currentDeployment };
  }

  async function loadCloudflareZones(
    config: WebDeployConfigResponse | null = deployConfig,
    options?: { requestSeq?: number },
  ) {
    if (!config?.configured || config.providerId !== CLOUDFLARE_PAGES_PROVIDER_ID) return;
    const requestSeq = options?.requestSeq ?? deployProviderLoadSeqRef.current;
    setCloudflareZonesLoading(true);
    setCloudflareZonesError(null);
    try {
      const response = await fetchCloudflarePagesZones();
      if (requestSeq !== deployProviderLoadSeqRef.current) return;
      const zones = response?.zones ?? [];
      setCloudflareZones(zones);
      const hintedZoneId = response?.cloudflarePages?.lastZoneId || config.cloudflarePages?.lastZoneId || '';
      const nextZoneId = hintedZoneId && zones.some((zone) => zone.id === hintedZoneId)
        ? hintedZoneId
        : zones[0]?.id || '';
      setCloudflareZoneId(nextZoneId);
      const hintedPrefix = response?.cloudflarePages?.lastDomainPrefix || config.cloudflarePages?.lastDomainPrefix || '';
      if (hintedPrefix) setCloudflareDomainPrefix(hintedPrefix);
    } catch (err) {
      if (requestSeq !== deployProviderLoadSeqRef.current) return;
      setCloudflareZones([]);
      setCloudflareZonesError(err instanceof Error ? err.message : t('fileViewer.cloudflareZonesLoadFailed'));
    } finally {
      if (requestSeq === deployProviderLoadSeqRef.current) setCloudflareZonesLoading(false);
    }
  }

  // Slide deck nav state: the iframe posts the active index + total count
  // back to the host every time a slide settles. Host renders prev/next
  // controls in the toolbar and reflects the count beside them.
  const [slideState, setSlideState] = useState<SlideState | null>(
    () => htmlPreviewSlideState.get(previewStateKey) ?? null,
  );
  const overlayPreviewScale = effectivePreviewScale(previewViewport, previewScale, previewBodySize);
  const [chromeActionsHost, setChromeActionsHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    setChromeActionsHost(document.getElementById(APP_CHROME_FILE_ACTIONS_ID));
  }, []);

  useEffect(() => {
    liveCommentTargetsRef.current = liveCommentTargets;
  }, [liveCommentTargets]);

  useEffect(() => {
    const sourceFileKey = `${projectId}\0${file.name}\0${liveHtml === undefined ? 'raw' : 'live'}`;
    if (liveHtml !== undefined) {
      sourceFileKeyRef.current = sourceFileKey;
      setSource(liveHtml);
      sourceRef.current = liveHtml;
      return;
    }
    const fileChanged = sourceFileKeyRef.current !== sourceFileKey;
    sourceFileKeyRef.current = sourceFileKey;
    if (fileChanged) {
      setSource(null);
      sourceRef.current = null;
    }
    let cancelled = false;
    void fetchProjectFileText(projectId, file.name).then((text) => {
      if (!cancelled) {
        setSource(text);
        sourceRef.current = text;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, file.mtime, liveHtml, reloadKey, filesRefreshKey]);

  useEffect(() => {
    let cancelled = false;
    setDeployResult(null);
    setDeployError(null);
    setCopiedDeployLink(null);
    setDeployPhase('idle');
    void fetchProjectDeployments(projectId).then((items) => {
      if (cancelled) return;
      const nextDeploymentsByProvider = deploymentMapForCurrentFile(items);
      const current = nextDeploymentsByProvider[deployProviderId] ?? null;
      setDeploymentsByProvider(nextDeploymentsByProvider);
      setDeployment(current ?? null);
      setDeployResult(current ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, file.name, deployProviderId]);

  // Detect deck-shaped HTML even when the project's skill didn't declare
  // `mode: deck`. Freeform projects often produce a deck because the user
  // asked for one in plain prose; without this, prev/next and Present
  // never surface and the deck becomes a static, unnavigable preview.
  const looksLikeDeck = useMemo(() => {
    if (!source) return false;
    return /class\s*=\s*['"][^'"]*\bslide\b/i.test(source);
  }, [source]);
  const effectiveDeck = isDeck || looksLikeDeck;
  const livePreviewSource = inlinedSource ?? source;
  // Freeze the iframe input on the snapshot taken at Edit-mode entry. Any
  // source rewrite during edit (1.5s debounced set-style patches) stays
  // invisible to the iframe — live updates flow through od-edit-preview-style
  // postMessage instead, so the canvas never has to reload.
  useEffect(() => {
    if (manualEditMode && manualEditFrozenSource === null && livePreviewSource != null) {
      setManualEditFrozenSource(livePreviewSource);
    }
  }, [manualEditMode, manualEditFrozenSource, livePreviewSource]);
  const previewSource = (manualEditMode && manualEditFrozenSource !== null)
    ? manualEditFrozenSource
    : livePreviewSource;
  const manualEditPageStylesEnabled = typeof source === 'string' && isManualEditFullHtmlDocument(source);
  const drawClickSelectionMode = drawOverlayOpen && drawOverlayMode === 'click' && !manualEditMode;
  const urlModeBridge = hasUrlModeBridge(source);
  // When we URL-load the iframe directly, skip every in-host inlining /
  // srcDoc-rebuilding step. The browser does the asset resolution itself,
  // which is the whole point of the URL-load path.
  // Detect the class based tweaks template so we keep the srcDoc path on
  // first load: the bridge that emits `od:tweaks-available` is only injected
  // by buildSrcdoc, never on the URL load iframe.
  const tweaksBridgeRequired = hasTweaksTemplate(source);
  // Auto-fall back to the srcDoc path when the artifact will crash under
  // the URL-load iframe's bare `sandbox="allow-scripts"` — Babel-standalone
  // React prototypes and any HTML that reads Web Storage at mount throw
  // SecurityError without `allow-same-origin`. The srcDoc path runs
  // `injectSandboxShim` before any user script, so those artifacts render.
  // Memoized on `source` so HtmlViewer's frequent re-renders (board/inspect/
  // edit mode toggles, slide nav) don't re-scan the HTML each time.
  const needsSandboxShim = useMemo(
    () => source != null && htmlNeedsSandboxShim(source),
    [source],
  );
  const useUrlLoadPreview = shouldUrlLoadHtmlPreview({
    mode,
    isDeck: effectiveDeck,
    commentMode: boardMode || drawClickSelectionMode,
    editMode: manualEditMode,
    urlModeBridge,
    inspectMode,
    paletteActive: palettePopoverOpen || selectedPalette !== null,
    drawMode: drawOverlayOpen,
    tweaksBridge: tweaksBridgeRequired,
    forceInline: forceInline || needsSandboxShim,
  });
  const basePreviewSrcUrl = useMemo(
    () => `${projectRawUrl(projectId, file.name)}?v=${Math.round(file.mtime)}&r=${reloadKey}`,
    [projectId, file.name, file.mtime, reloadKey],
  );
  const [previewSrcUrl, setPreviewSrcUrl] = useState(basePreviewSrcUrl);
  const activePreviewSrcUrl = (
    previewSrcUrl === basePreviewSrcUrl ||
    previewSrcUrl.startsWith(`${basePreviewSrcUrl}&`)
  )
    ? previewSrcUrl
    : basePreviewSrcUrl;
  useEffect(() => {
    setPreviewSrcUrl(basePreviewSrcUrl);
  }, [basePreviewSrcUrl]);
  // Keep `iframeRef.current` aligned with whichever iframe is currently
  // visible so the existing postMessage send sites do not need to know that
  // there are two iframes mounted. Plain `useEffect` (rather than layout)
  // because all reads of `iframeRef.current` are in async user handlers or
  // postMessage callbacks, never synchronous during render, and `useEffect`
  // does not warn under `renderToStaticMarkup`.
  useEffect(() => {
    iframeRef.current = useUrlLoadPreview ? urlPreviewIframeRef.current : srcDocPreviewIframeRef.current;
  }, [useUrlLoadPreview]);
  // When the render mode flips, the now-active iframe has already loaded
  // (its `onLoad` fired when it first mounted, often long before the user
  // toggled), so we manually re-push the current bridge state instead of
  // relying on the iframe's load event. `syncBridgeModes` is a closure over
  // the latest state, so reading it through a ref keeps this effect's deps
  // honest while still firing the up-to-date sync function.
  const syncBridgeModesRef = useRef<() => void>(() => {});
  useEffect(() => {
    syncBridgeModesRef.current();
  }, [useUrlLoadPreview]);

  useEffect(() => {
    if (filesRefreshKey === 0) return;
    const nextSrc = `${basePreviewSrcUrl}&fr=${filesRefreshKey}`;
    const timeout = window.setTimeout(() => {
      if (useUrlLoadPreview && urlPreviewIframeRef.current?.contentWindow) {
        urlPreviewIframeRef.current.contentWindow.location.replace(nextSrc);
      } else {
        setPreviewSrcUrl(nextSrc);
      }
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [basePreviewSrcUrl, filesRefreshKey, useUrlLoadPreview]);

  useEffect(() => {
    setInlinedSource(null);
    if (useUrlLoadPreview) return;
    if (!source || effectiveDeck || !hasRelativeAssetRefs(source)) return;
    let cancelled = false;
    void inlineRelativeAssets(source, projectId, file.name).then((next) => {
      if (!cancelled) setInlinedSource(next);
    });
    return () => {
      cancelled = true;
    };
  }, [source, effectiveDeck, projectId, file.name, useUrlLoadPreview]);

  const srcDoc = useMemo(
    () => (previewSource ? buildSrcdoc(previewSource, {
      deck: effectiveDeck,
      baseHref: projectRawUrl(projectId, baseDirFor(file.name)),
      initialSlideIndex: htmlPreviewSlideState.get(previewStateKey)?.active ?? 0,
      selectionBridge: true,
      editBridge: manualEditMode,
      paletteBridge: true,
      initialPalette: selectedPalette,
    }) : ''),
    [previewSource, effectiveDeck, projectId, file.name, previewStateKey, manualEditMode, selectedPalette],
  );
  const lazySrcDocTransport = useMemo(() => buildLazySrcdocTransport(), []);
  const [hasLazySrcDocTransport, setHasLazySrcDocTransport] = useState(useUrlLoadPreview);
  const [srcDocTransportResetKey, setSrcDocTransportResetKey] = useState(0);
  const [srcDocShellReady, setSrcDocShellReady] = useState(false);
  const wasUrlLoadPreviewRef = useRef(useUrlLoadPreview);
  useEffect(() => {
    if (useUrlLoadPreview) setHasLazySrcDocTransport(true);
  }, [useUrlLoadPreview]);
  // Reset the shell-ready latch whenever the srcDoc iframe re-mounts. The
  // next shell will post `od:srcdoc-transport-ready` (or fire onLoad) and
  // flip this back to true. See #2253.
  useEffect(() => {
    setSrcDocShellReady(false);
  }, [srcDocTransportResetKey]);
  // Listen for the shell's ready handshake. Gating activation on this is
  // what fixes the #2253 race: opening Tweaks right after a key-driven
  // re-mount used to post `activate` before the shell's listener was
  // installed, dropping the message and stranding the iframe on the empty
  // 536-byte body.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.source !== srcDocPreviewIframeRef.current?.contentWindow) return;
      const data = ev.data as { type?: string } | null;
      if (data?.type !== 'od:srcdoc-transport-ready') return;
      setSrcDocShellReady(true);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  const useLazySrcDocTransport = useUrlLoadPreview || hasLazySrcDocTransport;
  const srcDocTransportContent = useLazySrcDocTransport ? lazySrcDocTransport : srcDoc;
  const urlTransportSrc = useUrlLoadPreview ? activePreviewSrcUrl : 'about:blank';
  const activateSrcDocTransport = useCallback((target: HTMLIFrameElement | null = srcDocPreviewIframeRef.current) => {
    if (!canActivateSrcDocTransport({
      srcDoc,
      useUrlLoadPreview,
      useLazySrcDocTransport,
      shellReady: srcDocShellReady,
      activatedHtml: activatedSrcDocTransportHtmlRef.current,
    })) return false;
    const win = target?.contentWindow;
    if (!win) return false;
    win.postMessage({ type: 'od:srcdoc-transport-activate', html: srcDoc }, '*');
    activatedSrcDocTransportHtmlRef.current = srcDoc;
    return true;
  }, [srcDoc, useLazySrcDocTransport, useUrlLoadPreview, srcDocShellReady]);
  useEffect(() => {
    if (useUrlLoadPreview) {
      activatedSrcDocTransportHtmlRef.current = null;
      if (!wasUrlLoadPreviewRef.current) {
        setSrcDocTransportResetKey((key) => key + 1);
      }
      wasUrlLoadPreviewRef.current = true;
      return;
    }
    wasUrlLoadPreviewRef.current = false;
    activateSrcDocTransport();
  }, [activateSrcDocTransport, useUrlLoadPreview]);
  useEffect(() => {
    restorePreviewScrollPosition();
  }, [boardMode, manualEditMode, srcDoc, restorePreviewScrollPosition]);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      if (!isActivePreviewIframeSource(ev.source)) return;
      const data = ev.data as {
        type?: string;
        frameLeft?: number;
        frameTop?: number;
        canvasLeft?: number;
        canvasTop?: number;
      } | null;
      if (!data || data.type !== 'od:preview-scroll') return;
      if (previewScrollRestoreRef.current && Number(data.canvasLeft || 0) === 0 && Number(data.canvasTop || 0) === 0) return;
      if (
        previewScrollPositionRef.current.canvasLeft !== 0 ||
        previewScrollPositionRef.current.canvasTop !== 0
      ) {
        const isInitialZeroReport = Number(data.canvasLeft || 0) === 0 && Number(data.canvasTop || 0) === 0;
        if (isInitialZeroReport && Date.now() - previewScrollRequestAtRef.current < 1200) return;
      }
      previewScrollPositionRef.current = {
        frameLeft: Number(data.frameLeft || 0),
        frameTop: Number(data.frameTop || 0),
        canvasLeft: Number(data.canvasLeft || 0),
        canvasTop: Number(data.canvasTop || 0),
      };
    }
    function onRestoreRequest(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      if (!isActivePreviewIframeSource(ev.source)) return;
      const data = ev.data as { type?: string } | null;
      if (!data || data.type !== 'od:preview-scroll-request') return;
      previewScrollRequestAtRef.current = Date.now();
      const snapshot = previewScrollRestoreRef.current;
      const scroll = snapshot ?? {
        frameLeft: previewScrollPositionRef.current.frameLeft,
        frameTop: previewScrollPositionRef.current.frameTop,
        canvasLeft: previewScrollPositionRef.current.canvasLeft,
        canvasTop: previewScrollPositionRef.current.canvasTop,
      };
      iframeRef.current?.contentWindow?.postMessage({
        type: 'od:preview-scroll-restore',
        frameLeft: scroll.frameLeft,
        frameTop: scroll.frameTop,
        canvasLeft: scroll.canvasLeft,
        canvasTop: scroll.canvasTop,
      }, '*');
    }
    function onDcViewportMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      if (!isActivePreviewIframeSource(ev.source)) return;
      const data = ev.data as {
        type?: string;
        x?: number;
        y?: number;
        scale?: number;
      } | null;
      if (!data || !data.type) return;
      if (data.type === '__dc_viewport') {
        const x = Number(data.x || 0);
        const y = Number(data.y || 0);
        const scale = Number(data.scale || 1);
        const hasExistingPosition = dcViewportRef.current.x !== 0 || dcViewportRef.current.y !== 0;
        const isInitialZeroReport = x === 0 && y === 0 && scale === 1;
        if (hasExistingPosition && isInitialZeroReport && Date.now() - dcViewportRestoreAtRef.current < 1500) return;
        dcViewportRef.current = {
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
        };
        return;
      }
      if (data.type === '__dc_viewport_request') {
        dcViewportRestoreAtRef.current = Date.now();
        iframeRef.current?.contentWindow?.postMessage({
          type: '__dc_set_viewport',
          ...dcViewportRef.current,
        }, '*');
      }
    }
    window.addEventListener('message', onMessage);
    window.addEventListener('message', onRestoreRequest);
    window.addEventListener('message', onDcViewportMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('message', onRestoreRequest);
      window.removeEventListener('message', onDcViewportMessage);
    };
  }, [isActivePreviewIframeSource, isOurPreviewIframeSource]);

  useEffect(() => {
    if (!effectiveDeck) {
      setSlideState(null);
      return;
    }
    setSlideState(htmlPreviewSlideState.get(previewStateKey) ?? null);
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      if (!isActivePreviewIframeSource(ev.source)) return;
      const data = ev?.data as
        | { type?: string; active?: number; count?: number }
        | null;
      if (!data || data.type !== 'od:slide-state') return;
      if (typeof data.active !== 'number' || typeof data.count !== 'number') return;
      const next = { active: data.active, count: data.count };
      setSlideStateCached(previewStateKey, next);
      setSlideState(next);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [effectiveDeck, isActivePreviewIframeSource, isOurPreviewIframeSource, previewStateKey]);

  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({
      type: 'od:comment-mode',
      enabled: boardMode || drawClickSelectionMode,
      mode: drawClickSelectionMode ? 'picker' : boardTool,
    }, '*');
  }, [boardMode, boardTool, drawClickSelectionMode, srcDoc]);

  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'od-edit-mode', enabled: manualEditMode }, '*');
    postSelectedManualEditTargetToIframe(manualEditMode ? selectedManualEditTarget?.id ?? null : null);
  }, [manualEditMode, selectedManualEditTarget?.id, srcDoc]);

  const previewStyleToIframe = useCallback((id: string, styles: Partial<ManualEditStyles>, version: number) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return false;
    win.postMessage({ type: 'od-edit-preview-style', id, styles, version }, '*');
    return true;
  }, []);

  function postSelectedManualEditTargetToIframe(id: string | null, target: HTMLIFrameElement | null = iframeRef.current) {
    const win = target?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'od-edit-selected-target', id }, '*');
  }

  function syncBridgeModes(target: HTMLIFrameElement | null = iframeRef.current) {
    const win = target?.contentWindow;
    if (!win) return;
    win.postMessage({
      type: 'od:comment-mode',
      enabled: boardMode || drawClickSelectionMode,
      mode: drawClickSelectionMode ? 'picker' : boardTool,
    }, '*');
    win.postMessage({ type: 'od-edit-mode', enabled: manualEditMode }, '*');
    postSelectedManualEditTargetToIframe(manualEditMode ? selectedManualEditTarget?.id ?? null : null, target);
    // Push the toolbar's current `tweaksMode` to both dialects so the artifact
    // aligns to host state on every load (including render-mode swaps that
    // expose a different iframe. e.g. opening the Themes popover). Without
    // this, an artifact that defaults to `open=true` would re-open on every
    // swap and visually contradict a toolbar that is currently off.
    win.postMessage({ type: 'od:tweaks-panel-visible', visible: tweaksMode }, '*');
    win.postMessage({ type: tweaksMode ? '__activate_edit_mode' : '__deactivate_edit_mode' }, '*');
    win.postMessage({ type: 'od:inspect-mode', enabled: inspectMode }, '*');
    const palette = previewPalette ?? selectedPalette;
    win.postMessage({ type: 'od:palette', palette }, '*');
  }
  // Keep the ref pointing at the latest `syncBridgeModes` closure so the
  // render-mode-swap effect above (which can fire before this declaration in
  // execution order) always calls the up-to-date function.
  syncBridgeModesRef.current = syncBridgeModes;

  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'od:inspect-mode', enabled: inspectMode }, '*');
  }, [inspectMode, srcDoc]);

  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const palette = previewPalette ?? selectedPalette;
    win.postMessage({ type: 'od:palette', palette }, '*');
  }, [previewPalette, selectedPalette, srcDoc]);

  // Mirror the bridge's `od:comment-targets` broadcast into
  // `liveCommentTargets` whenever EITHER Inspect or Comments mode is
  // active. The boardMode-only useEffect below still handles its
  // own comment-specific events (hover / click target / pod), but
  // the targets list itself is mode-agnostic — it's just "which
  // elements on the page carry data-od-id / data-screen-label".
  // Without this listener Inspect mode never learns the artifact's
  // annotation count, and the empty-state hint added for #890 would
  // misfire (always firing in Inspect mode, even on annotated
  // artifacts) because the comment-mode listener short-circuits on
  // `!boardMode`. Issue #890.
  useEffect(() => {
    if (!inspectMode && !boardMode && !drawClickSelectionMode) {
      setLiveCommentTargets((current) => (current.size > 0 ? new Map() : current));
      return;
    }
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as
        | {
            type?: string;
            targets?: Array<Partial<PreviewCommentSnapshot>>;
          }
        | null;
      if (data?.type !== 'od:comment-targets' || !Array.isArray(data.targets)) return;
      const next = new Map<string, PreviewCommentSnapshot>();
      data.targets.forEach((item) => {
        const elementId = String(item?.elementId || '');
        if (!elementId) return;
        next.set(elementId, {
          filePath: file.name,
          elementId,
          selector: String(item?.selector || ''),
          label: String(item?.label || ''),
          text: String(item?.text || ''),
          position: {
            x: clampBridgeCoordinate(item?.position?.x),
            y: clampBridgeCoordinate(item?.position?.y),
            width: clampBridgeCoordinate(item?.position?.width),
            height: clampBridgeCoordinate(item?.position?.height),
          },
          htmlHint: String(item?.htmlHint || ''),
          selectionKind: 'element',
          memberCount: undefined,
        });
      });
      setLiveCommentTargets(next);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [inspectMode, boardMode, drawClickSelectionMode, file.name, isOurPreviewIframeSource]);

  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    // Send all known dialects so the artifact can pick up whichever it speaks:
    //  - `od:tweaks-panel-visible` is the bridge protocol used by class-based
    //    panels emitted from the tweaks skill template (`.tw-panel`).
    //  - `__activate_edit_mode` / `__deactivate_edit_mode` is the protocol
    //    agent-generated artifacts use for their own React-mounted `.twk-panel`.
    // Deps intentionally exclude `srcDoc`: on iframe remount, sync happens via
    // `syncBridgeModes` (bridge) and the artifact's own
    // `__edit_mode_available` announcement (postMessage panels).
    win.postMessage({ type: 'od:tweaks-panel-visible', visible: tweaksMode }, '*');
    win.postMessage({ type: tweaksMode ? '__activate_edit_mode' : '__deactivate_edit_mode' }, '*');
  }, [tweaksMode]);

  // Receive tweaks-side state from the iframe. Supports both bridge messages
  // (`od:tweaks-*` for skill-template artifacts) and the artifact-native
  // edit-mode protocol (`__edit_mode_*` for agent-generated artifacts). Either
  // surface controls toolbar availability and mirrors local close into the
  // toolbar toggle state.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as { type?: string; available?: boolean; visible?: boolean } | null;
      if (!data?.type) return;
      if (data.type === 'od:tweaks-available') {
        // Scope this to the active iframe only. The hidden srcDoc iframe's
        // tweaks bridge always evaluates `document.querySelector('.tw-panel')`
        // and posts `available: false` for agent-protocol (`.twk-panel`)
        // artifacts that ship no class based panel. Without this guard that
        // `false` would land after `__edit_mode_available` had already set
        // `tweaksAvailable = true` and silently disable the toolbar button.
        // `__edit_mode_*` below stays accepted from either iframe — those
        // signals carry real artifact intent and must survive render mode
        // flips.
        if (ev.source !== iframeRef.current?.contentWindow) return;
        setTweaksAvailable(!!data.available);
      } else if (data.type === 'od:tweaks-panel-state') {
        setTweaksMode(!!data.visible);
      } else if (data.type === '__edit_mode_available') {
        setTweaksAvailable(true);
        // Mirror the artifact's reported default visibility into `tweaksMode`
        // exactly once per file. Per design-templates/tweaks/SKILL.md the
        // artifact MAY emit `{ visible: boolean }` on the availability
        // payload to declare a default-closed panel; if absent we treat it
        // as default-open because the SDK pattern is `useState(true)` and
        // omitting `visible` is the backward-compatible signal that the
        // panel is already on screen. Without this mirror, the toolbar reads
        // OFF while the panel is clearly visible and the user has to click
        // toggle-on then toggle-off to actually hide it. Guarded by
        // `firstEditModeAvailableSeenForFileRef` so a later iframe remount
        // (Themes popover flipping render mode, etc.) doesn't snap a
        // user-driven OFF back to ON. `syncBridgeModes` remains the source
        // of truth on every subsequent load: it pushes the current
        // `tweaksMode` into the artifact via `__activate_edit_mode` /
        // `__deactivate_edit_mode` so the artifact tracks the toolbar.
        if (firstEditModeAvailableSeenForFileRef.current !== file.name) {
          firstEditModeAvailableSeenForFileRef.current = file.name;
          setTweaksMode(data.visible !== false);
        }
      } else if (data.type === '__edit_mode_dismissed') {
        setTweaksMode(false);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // `file.name` is in the dep list so the handler's `firstEditMode-
    // AvailableSeenForFileRef.current !== file.name` guard compares against
    // the currently-displayed file. Without this, the listener would close
    // over the first-render `file.name`; switching to another `.twk-panel`
    // artifact would never re-mirror the new artifact's default-open state
    // because the stale closure's comparison kept matching. PR #1643 review.
  }, [file.name]);

  useEffect(() => {
    setActiveCommentTarget(null);
    setHoveredCommentTarget(null);
    setLiveCommentTargets(new Map());
    setCommentDraft('');
    setActiveInspectTarget(null);
    setInspectOverrides({});
    setInspectSavedAt(null);
    setInspectError(null);
    setQueuedBoardNotes([]);
    setStrokePoints([]);
    setManualEditFrozenSource(null);
    setManualEditViewportWidth(null);
    setManualEditTargets([]);
    setSelectedManualEditTarget(null);
    selectedManualEditTargetIdRef.current = null;
    setManualEditDraft(emptyManualEditDraft());
    setManualEditHistory([]);
    setManualEditUndone([]);
    setManualEditError(null);
    manualEditPendingStyleRef.current = null;
    clearManualEditStyleTimer();
    // Stale tweaks state can carry across files (especially toolbar "on" with
    // no panel underneath). Reset both and let the iframe bridge re-announce.
    setTweaksMode(false);
    setTweaksAvailable(false);
  }, [file.name]);

  // Selecting a new file or turning inspect off resets the panel target.
  useEffect(() => {
    if (!inspectMode) {
      setActiveInspectTarget(null);
      setInspectError(null);
    }
  }, [inspectMode]);

  // Hydrate the host-authoritative override map from the artifact source
  // synchronously, *before* React commits a render that carries a new
  // `srcDoc` to the iframe. A `useEffect([source])` would commit the new
  // source first and only re-render with the parsed map afterwards — if
  // the iframe finishes loading the new srcDoc in that window, its
  // `onLoad` handler captures the previous file's empty/stale map in its
  // closure and posts that map back over the bridge's freshly DOM-hydrated
  // overrides, leaving the preview without saved inspect styles until the
  // next reload or mode toggle. Setting state during render is React's
  // documented escape hatch for "store a value derived from props"
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes):
  // the in-flight render is discarded and React re-renders with the
  // updated state before commit, so the new `srcDoc` and the new
  // `inspectOverrides` always commit together. After hydration the map
  // only mutates from host-driven onApply / reset callbacks below, so
  // artifact JS forging an od:inspect-overrides message cannot tamper
  // with what saveInspectToSource will persist.
  if (inspectHydratedSourceRef.current !== source) {
    inspectHydratedSourceRef.current = source;
    setInspectOverrides(typeof source === 'string' ? parseInspectOverridesFromSource(source) : {});
  }

  useEffect(() => {
    sourceRef.current = source;
    if (source == null) return;
    setManualEditDraft((current) => (
      current.fullSource === source ? current : { ...current, fullSource: source }
    ));
  }, [source]);

  useEffect(() => {
    selectedManualEditTargetIdRef.current = selectedManualEditTarget?.id ?? null;
  }, [selectedManualEditTarget?.id]);

  useEffect(() => {
    const selectionMode = boardMode || drawClickSelectionMode;
    if (!selectionMode) {
      setActiveCommentTarget((current) => (current ? null : current));
      setHoveredCommentTarget((current) => (current ? null : current));
      setActivePreviewCommentId((current) => (current ? null : current));
      setLiveCommentTargets((current) => (current.size > 0 ? new Map() : current));
      setQueuedBoardNotes((current) => (current.length > 0 ? [] : current));
      setStrokePoints((current) => (current.length > 0 ? [] : current));
      return;
    }
    const snapshotFromData = (data: Partial<PreviewCommentSnapshot>): PreviewCommentSnapshot => ({
      filePath: file.name,
      elementId: String(data.elementId || ''),
      selector: String(data.selector || ''),
      label: String(data.label || ''),
      text: String(data.text || ''),
      position: {
        x: clampBridgeCoordinate(data.position?.x),
        y: clampBridgeCoordinate(data.position?.y),
        width: clampBridgeCoordinate(data.position?.width),
        height: clampBridgeCoordinate(data.position?.height),
      },
      htmlHint: String(data.htmlHint || ''),
      selectionKind: data.selectionKind === 'pod' ? 'pod' : 'element',
      memberCount: finiteBridgeInteger(data.memberCount),
      podMembers: Array.isArray(data.podMembers) ? data.podMembers : undefined,
    });
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as (Partial<PreviewCommentSnapshot> & {
        type?: string;
        targets?: Array<Partial<PreviewCommentSnapshot>>;
        points?: StrokePoint[];
      }) | null;
      if (!data?.type) return;
      if (data.type === 'od:comment-targets' && Array.isArray(data.targets)) {
        const next = new Map<string, PreviewCommentSnapshot>();
        data.targets.forEach((item) => {
          const snapshot = snapshotFromData(item);
          if (snapshot.elementId) next.set(snapshot.elementId, snapshot);
        });
        setLiveCommentTargets(next);
        setActiveCommentTarget((current) => (
          current
            ? current.selectionKind === 'pod'
              ? current
              : next.get(current.elementId) ?? null
            : null
        ));
        setHoveredCommentTarget((current) => (
          current
            ? current.selectionKind === 'pod'
              ? current
              : next.get(current.elementId) ?? null
            : null
        ));
        return;
      }
      if (data.type === 'od:comment-leave') {
        setHoveredCommentTarget(null);
        return;
      }
      if (data.type === 'od:comment-hover') {
        const snapshot = snapshotFromData(data);
        if (!snapshot.elementId) return;
        setHoveredCommentTarget(snapshot);
        setLiveCommentTargets((current) => new Map(current).set(snapshot.elementId, snapshot));
        return;
      }
      if (data.type === 'od:comment-target') {
        const snapshot = snapshotFromData(data);
        if (!snapshot.elementId) return;
        const existing = previewComments.find((comment) =>
          comment.filePath === file.name &&
          comment.status === 'open' &&
          comment.elementId === snapshot.elementId,
        );
        setActiveCommentTarget(snapshot);
        setHoveredCommentTarget(snapshot);
        setLiveCommentTargets((current) => new Map(current).set(snapshot.elementId, snapshot));
        if (boardMode) {
          setActivePreviewCommentId(existing?.id ?? null);
          setCommentDraft(existing?.note ?? '');
          setQueuedBoardNotes([]);
        }
        return;
      }
      if (data.type === 'od:pod-clear') {
        setStrokePoints([]);
        return;
      }
      if (data.type === 'od:pod-stroke' && Array.isArray(data.points)) {
        setStrokePoints(
          data.points.map((point) => ({
            x: clampBridgeCoordinate(point.x),
            y: clampBridgeCoordinate(point.y),
          })),
        );
        return;
      }
      if (data.type === 'od:pod-select' && Array.isArray(data.points)) {
        const points = data.points.map((point) => ({
          x: clampBridgeCoordinate(point.x),
          y: clampBridgeCoordinate(point.y),
        }));
        setStrokePoints(points);
        const nextTarget = buildPodSnapshot({
          filePath: file.name,
          strokePoints: points,
          liveTargets: liveCommentTargetsRef.current,
        });
        if (!nextTarget) {
          setStrokePoints([]);
          return;
        }
        setActiveCommentTarget(nextTarget);
        setHoveredCommentTarget(nextTarget);
        setActivePreviewCommentId(null);
        setQueuedBoardNotes([]);
        setCommentDraft('');
        setStrokePoints([]);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [boardMode, drawClickSelectionMode, file.name, isOurPreviewIframeSource, previewComments]);

  useEffect(() => {
    if (!manualEditMode) {
      setManualEditTargets([]);
      setSelectedManualEditTarget(null);
      setManualEditError(null);
      manualEditPendingStyleRef.current = null;
      if (manualEditStyleTimerRef.current) {
        clearTimeout(manualEditStyleTimerRef.current);
        manualEditStyleTimerRef.current = null;
      }
      return;
    }
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as ManualEditBridgeMessage | null;
      if (!data?.type) return;
      if (data.type === 'od-edit-targets' && Array.isArray(data.targets)) {
        setManualEditTargets(data.targets);
        // Target broadcasts can be briefly empty while the iframe/save path is
        // settling; keep the user's inspector selection unless a fresh copy is
        // available to update its metadata.
        setSelectedManualEditTarget((current) =>
          current ? data.targets.find((target) => target.id === current.id) ?? current : current,
        );
        const selectedId = selectedManualEditTargetIdRef.current;
        if (selectedId) setTimeout(() => postSelectedManualEditTargetToIframe(selectedId), 0);
        return;
      }
      if (data.type === 'od-edit-select') {
        void selectManualEditTarget(data.target);
        return;
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [isOurPreviewIframeSource, manualEditMode, source]);

  function nextManualEditPreviewVersion(): number {
    manualEditPreviewVersionRef.current += 1;
    return manualEditPreviewVersionRef.current;
  }

  function inspectorManualEditStyles(target: ManualEditTarget, baseSource: string): ManualEditStyles {
    const inlineStyles = readManualEditStyles(baseSource, target.id);
    return mergeManualEditInspectorStyles(inlineStyles, target.styles);
  }

  function reconcileManualEditStyleSave(
    id: string,
    savedStyles: Partial<ManualEditStyles>,
    savedSource: string,
  ) {
    if (id !== '__body__' && !readManualEditOuterHtml(savedSource, id)) {
      setManualEditError('The selected target no longer exists in the saved source. Refreshing the preview.');
      setSelectedManualEditTarget(null);
      setManualEditFrozenSource(null);
      setReloadKey((key) => key + 1);
      return;
    }
    const sourceStyles = readManualEditStyles(savedSource, id);
    const supersededStyles = manualEditPendingStyleRef.current?.id === id
      ? manualEditPendingStyleRef.current.styles
      : {};
    const repairStyles: Partial<ManualEditStyles> = {};
    for (const key of Object.keys(savedStyles) as Array<keyof ManualEditStyles>) {
      if (Object.prototype.hasOwnProperty.call(supersededStyles, key)) continue;
      const sourceValue = manualEditInspectorStyleValue(key, sourceStyles[key] ?? '');
      const savedValue = savedStyles[key] ?? '';
      if (manualEditPersistedValueMatchesSavedSnapshot(key, sourceValue, savedValue)) continue;
      repairStyles[key] = sourceValue;
    }
    if (Object.keys(repairStyles).length === 0) return;
    previewStyleToIframe(id, repairStyles, nextManualEditPreviewVersion());
    setManualEditDraft((current) => ({
      ...current,
      styles: { ...current.styles, ...repairStyles },
    }));
    setManualEditError('Saved styles differed from the active preview. Reconciled the selected target from source.');
  }

  function scheduleManualEditStyleSave() {
    if (manualEditStyleTimerRef.current) clearTimeout(manualEditStyleTimerRef.current);
    manualEditStyleTimerRef.current = setTimeout(() => {
      manualEditStyleTimerRef.current = null;
      void flushManualEditStyleSave();
    }, 1000);
  }

  function clearManualEditStyleTimer() {
    if (!manualEditStyleTimerRef.current) return;
    clearTimeout(manualEditStyleTimerRef.current);
    manualEditStyleTimerRef.current = null;
  }

  function cancelManualEditPendingStyles(id: string, keys: Array<keyof ManualEditStyles>) {
    const nextPending = cancelManualEditPendingStyleSnapshot(manualEditPendingStyleRef.current, id, keys);
    if (!nextPending) {
      manualEditPendingStyleRef.current = null;
      clearManualEditStyleTimer();
      return;
    }
    manualEditPendingStyleRef.current = nextPending;
  }

  async function handleManualEditStyleChange(id: string, styles: Partial<ManualEditStyles>, label: string) {
    const version = nextManualEditPreviewVersion();
    const currentPending = manualEditPendingStyleRef.current;
    const pendingStyles = currentPending?.id === id
      ? { ...currentPending.styles, ...styles }
      : styles;
    const pending: ManualEditPendingStyleSave = { id, styles: pendingStyles, label, version };
    manualEditPendingStyleRef.current = pending;
    setManualEditError(null);
    previewStyleToIframe(id, styles, version);
    scheduleManualEditStyleSave();
  }

  async function flushManualEditStyleSave(): Promise<boolean> {
    const pending = manualEditPendingStyleRef.current;
    if (!pending) return true;
    if (manualEditSavingRef.current) {
      scheduleManualEditStyleSave();
      return false;
    }
    manualEditPendingStyleRef.current = null;
    return applyManualEdit({ id: pending.id, kind: 'set-style', styles: pending.styles }, pending.label);
  }

  async function exitManualEditModeAfterFlush(): Promise<boolean> {
    const ok = await flushManualEditStyleSave();
    if (!ok) return false;
    setManualEditMode(false);
    return true;
  }

  async function selectManualEditTarget(target: ManualEditTarget) {
    if (!(await flushManualEditStyleSave())) return;
    const base = sourceRef.current ?? '';
    const fields = readManualEditFields(base, target.id);
    setSelectedManualEditTarget(target);
    setManualEditDraft({
      text: fields.text ?? target.fields.text ?? target.text,
      href: fields.href ?? target.fields.href ?? '',
      src: fields.src ?? target.fields.src ?? '',
      alt: fields.alt ?? target.fields.alt ?? '',
      styles: inspectorManualEditStyles(target, base),
      attributesText: JSON.stringify(readManualEditAttributes(base, target.id), null, 2),
      outerHtml: readManualEditOuterHtml(base, target.id) || target.outerHtml,
      fullSource: base,
    });
    setManualEditError(null);
  }

  async function clearManualEditTargetSelection() {
    if (!(await flushManualEditStyleSave())) return;
    setSelectedManualEditTarget(null);
    setManualEditDraft(emptyManualEditDraft(sourceRef.current ?? ''));
    setManualEditError(null);
  }

  async function applyManualEdit(patch: ManualEditPatch, label: string): Promise<boolean> {
    if (manualEditSavingRef.current) return false;
    if (sourceRef.current == null) return false;
    manualEditSavingRef.current = true;
    setManualEditSaving(true);
    setManualEditError(null);
    try {
      const baseSource = sourceRef.current;
      const result = applyManualEditPatch(baseSource, patch);
      if (!result.ok) {
        setManualEditError(result.error ?? 'Could not apply edit.');
        return false;
      }
      if (!(await confirmManualEditHistorySource(
        baseSource,
        'The file changed outside manual edit mode. Refreshing before applying manual edits.',
      ))) return false;
      const saved = await writeProjectTextFile(projectId, file.name, result.source, {
        artifactManifest: file.artifactManifest,
      });
      if (!saved) {
        setManualEditError('Could not save the edited file.');
        return false;
      }
      const entry: ManualEditHistoryEntry = {
        id: `${Date.now()}-${manualEditHistory.length}`,
        label,
        patch,
        beforeSource: baseSource,
        afterSource: result.source,
        createdAt: Date.now(),
      };
      setSource(result.source);
      sourceRef.current = result.source;
      setInlinedSource(null);
      if (patch.kind !== 'set-style') {
        setManualEditFrozenSource(result.source);
      }
      setManualEditHistory((current) => [entry, ...current]);
      setManualEditUndone([]);
      setManualEditDraft((current) => ({ ...current, fullSource: result.source }));
      if (patch.kind === 'set-style') {
        reconcileManualEditStyleSave(patch.id, patch.styles, result.source);
      }
      await onFileSaved?.();
      return true;
    } finally {
      manualEditSavingRef.current = false;
      setManualEditSaving(false);
      if (manualEditPendingStyleRef.current) scheduleManualEditStyleSave();
    }
  }

  async function confirmManualEditHistorySource(expectedSource: string, message: string): Promise<boolean> {
    const persisted = await fetchProjectFileText(projectId, file.name, {
      cache: 'no-store',
      cacheBustKey: Date.now(),
    });
    if (persisted == null || persisted === expectedSource) return true;
    setSource(persisted);
    sourceRef.current = persisted;
    setInlinedSource(null);
    setManualEditHistory([]);
    setManualEditUndone([]);
    manualEditPendingStyleRef.current = null;
    setManualEditDraft((current) => ({ ...current, fullSource: persisted }));
    setManualEditError(message);
    return false;
  }

  async function undoManualEdit() {
    if (manualEditSavingRef.current) return;
    const [latest, ...rest] = manualEditHistory;
    if (!latest) return;
    manualEditSavingRef.current = true;
    setManualEditSaving(true);
    try {
      if (!(await confirmManualEditHistorySource(
        latest.afterSource,
        'The file changed outside manual edit mode. History was cleared to avoid overwriting newer content.',
      ))) return;
      const saved = await writeProjectTextFile(projectId, file.name, latest.beforeSource, {
        artifactManifest: file.artifactManifest,
      });
      if (!saved) {
        setManualEditError('Could not save the undo result.');
        return;
      }
      setSource(latest.beforeSource);
      sourceRef.current = latest.beforeSource;
      setInlinedSource(null);
      setManualEditFrozenSource(latest.beforeSource);
      setManualEditHistory(rest);
      setManualEditUndone((current) => [latest, ...current]);
      setManualEditDraft((current) => ({ ...current, fullSource: latest.beforeSource }));
      await onFileSaved?.();
    } finally {
      manualEditSavingRef.current = false;
      setManualEditSaving(false);
    }
  }

  async function redoManualEdit() {
    if (manualEditSavingRef.current) return;
    const [latest, ...rest] = manualEditUndone;
    if (!latest) return;
    manualEditSavingRef.current = true;
    setManualEditSaving(true);
    try {
      if (!(await confirmManualEditHistorySource(
        latest.beforeSource,
        'The file changed outside manual edit mode. History was cleared to avoid overwriting newer content.',
      ))) return;
      const saved = await writeProjectTextFile(projectId, file.name, latest.afterSource, {
        artifactManifest: file.artifactManifest,
      });
      if (!saved) {
        setManualEditError('Could not save the redo result.');
        return;
      }
      setSource(latest.afterSource);
      sourceRef.current = latest.afterSource;
      setInlinedSource(null);
      setManualEditFrozenSource(latest.afterSource);
      setManualEditUndone(rest);
      setManualEditHistory((current) => [latest, ...current]);
      setManualEditDraft((current) => ({ ...current, fullSource: latest.afterSource }));
      await onFileSaved?.();
    } finally {
      manualEditSavingRef.current = false;
      setManualEditSaving(false);
    }
  }

  // Inspect-mode picker: same `od:comment-target` payload, different sink.
  // The bridge tags the message with a computed-style snapshot so the panel
  // can show real starting values for color / typography / spacing / radius.
  useEffect(() => {
    if (!inspectMode) return;
    function onMessage(ev: MessageEvent) {
      if (!isOurPreviewIframeSource(ev.source)) return;
      const data = ev.data as
        | {
            type?: string;
            elementId?: string;
            selector?: string;
            label?: string;
            text?: string;
            style?: InspectStyleSnapshot;
            clickedDescendant?: Partial<InspectClickedDescendant>;
          }
        | null;
      if (!data || data.type !== 'od:comment-target') return;
      if (!data.elementId || !data.selector) return;
      const clickedDescendant =
        data.clickedDescendant && typeof data.clickedDescendant === 'object'
          ? {
              label: String(data.clickedDescendant.label || ''),
              text: String(data.clickedDescendant.text || ''),
            }
          : null;
      setActiveInspectTarget({
        elementId: String(data.elementId),
        selector: String(data.selector),
        label: String(data.label || ''),
        text: String(data.text || ''),
        style: data.style && typeof data.style === 'object' ? data.style : {},
        ...(clickedDescendant ? { clickedDescendant } : {}),
      });
      setInspectError(null);
      setInspectSavedAt(null);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [inspectMode, isOurPreviewIframeSource]);

  function postSlide(action: 'next' | 'prev' | 'first' | 'last') {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'od:slide', action }, '*');
  }

  function postInspectSet(elementId: string, selector: string, prop: string, value: string) {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      { type: 'od:inspect-set', elementId, selector, prop, value },
      '*',
    );
  }

  function postInspectReset(elementId?: string) {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: 'od:inspect-reset', elementId }, '*');
  }

  // Replay the host's authoritative override map into the freshly loaded
  // iframe. The bridge inside the iframe only sees rules persisted in the
  // artifact source via its own hydrateOverridesFromDom() — any unsaved
  // edit lives on the host side until Save-to-source. Without this replay,
  // toggling Inspect off/on, switching to Comment mode, or any other
  // srcdoc rebuild reloads the iframe from previewSource without the
  // unsaved style block, so the preview drops the live edits while
  // saveInspectToSource() can still persist them later from the stale
  // host map. The bridge re-validates each entry under its own allow-list,
  // so a parent that posted a hostile replay can only land overrides the
  // bridge would also have accepted via od:inspect-set.
  //
  // The render-time hydration above keeps `inspectOverrides` aligned with
  // the current `source` whenever React commits, but the iframe `onLoad`
  // callback fires from a separate event-loop turn after the new srcDoc
  // is parsed; if it ever races a stale closure (e.g. an interleaved
  // remount), reading React state would post the previous file's map over
  // the bridge's DOM-hydrated one and silently strip the persisted styles
  // from preview. Re-derive synchronously from `source` whenever the
  // hydration ref disagrees so onLoad never sends a stale snapshot.
  function replayInspectOverridesToIframe(target: HTMLIFrameElement | null = iframeRef.current) {
    const win = target?.contentWindow;
    if (!win) return;
    const overrides = inspectHydratedSourceRef.current === source
      ? inspectOverrides
      : (typeof source === 'string' ? parseInspectOverridesFromSource(source) : {});
    win.postMessage({ type: 'od:inspect-replay', overrides }, '*');
  }

  // Persist accumulated inspect overrides into the artifact source: replace
  // (or insert) a single <style data-od-inspect-overrides> block in <head>.
  // The CSS body is serialized from the host's own override map, hydrated
  // from source on load and updated only by host-driven onApply / reset
  // callbacks. We deliberately do NOT round-trip through the iframe at save
  // time: artifact JS rendered inside the preview shares the same
  // contentWindow as the bridge and could forge an od:inspect-overrides
  // reply that flips allow-listed properties on elements the user never
  // touched. POSTing to /api/projects/:id/files upserts the file via
  // writeProjectFile (multipart-or-JSON; we use JSON).
  async function saveInspectToSource() {
    if (!source) return;
    setSavingInspect(true);
    setInspectError(null);
    try {
      const css = serializeInspectOverrides(inspectOverrides).trim();
      const next = applyInspectOverridesToSource(source, css);
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, content: next }),
      });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => null) as { error?: string; message?: string } | null;
        throw new Error(payload?.error || payload?.message || `Save failed (${resp.status})`);
      }
      setSource(next);
      setInspectSavedAt(Date.now());
      setReloadKey((k) => k + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed';
      setInspectError(msg);
      // The error banner inside the inspect panel is easy to miss when the
      // user is focused on the iframe preview — surface failures in the
      // console as well so quota/network errors aren't silently lost.
      console.error('[inspect] saveToSource failed:', err);
    } finally {
      setSavingInspect(false);
    }
  }

  // Keyboard nav on the host, so the user can press ←/→ even when focus
  // is on the chat composer or any other host control.
  useEffect(() => {
    if (!effectiveDeck || mode !== 'preview') return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        postSlide('next');
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        postSlide('prev');
      } else if (e.key === 'Home') {
        e.preventDefault();
        postSlide('first');
      } else if (e.key === 'End') {
        e.preventDefault();
        postSlide('last');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [effectiveDeck, mode]);

  useEffect(() => {
    if (!modeMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!modeMenuRef.current) return;
      if (!modeMenuRef.current.contains(e.target as Node)) setModeMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModeMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [modeMenuOpen]);

  useEffect(() => {
    if (!zoomMenuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!zoomMenuRef.current) return;
      if (!zoomMenuRef.current.contains(e.target as Node)) setZoomMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoomMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [zoomMenuOpen]);

  useEffect(() => {
    if (!inTabPresent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInTabPresent(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inTabPresent]);

  function openInNewTab() {
    if (!source) return;
    openSandboxedPreviewInNewTab(source, exportTitle, {
      deck: effectiveDeck,
      baseHref: projectRawUrl(projectId, baseDirFor(file.name)),
      initialSlideIndex: htmlPreviewSlideState.get(previewStateKey)?.active ?? 0,
    });
  }

  // Snapshot this project as a reusable template. The daemon snapshots
  // EVERY html/text/code file in the project (not just the file open in
  // the viewer), so the template captures the whole design, not a single
  // page. Surfaced here in the Share menu because that's where the user's
  // share / export mental model already lives.
  function openSaveAsTemplateModal() {
    setShareMenuOpen(false);
    const defaultName =
      file.name.replace(/\.html?$/i, '') || t('fileViewer.templateNameDefault');
    setTemplateName(defaultName);
    setTemplateDescription('');
    setTemplateSaveError(null);
    setTemplateModalOpen(true);
  }

  async function handleSaveAsTemplate() {
    const name = templateName.trim();
    if (!name) return;
    setSavingTemplate(true);
    setTemplateNote(null);
    setTemplateSaveError(null);
    let savedName: string | null = null;
    try {
      const tpl = await saveTemplate({
        name,
        description: templateDescription.trim() || undefined,
        sourceProjectId: projectId,
      });
      if (!tpl) {
        setTemplateSaveError(t('fileViewer.savedTemplateFail'));
        return;
      }
      savedName = tpl.name;
      setTemplateModalOpen(false);
      setTemplateName('');
      setTemplateDescription('');
      setTemplateNote(t('fileViewer.savedTemplate', { name: tpl.name }));
      // Show success toast
      setTemplateSavedToast(t('fileViewer.savedTemplate', { name: tpl.name }));
    } finally {
      setSavingTemplate(false);
      if (savedName) {
        // Auto-clear the note so the menu doesn't keep stale state next open.
        setTimeout(() => setTemplateNote(null), 4000);
      }
    }
  }

  async function openDeployModal(nextProviderId: WebDeployProviderId = deployProviderId) {
    setShareMenuOpen(false);
    setDeployModalOpen(true);
    setDeployError(null);
    setCopiedDeployLink(null);
    setDeployPhase('idle');
    await loadDeployProvider(nextProviderId, { fallbackToExisting: true });
  }

  async function changeDeployProvider(nextProviderId: WebDeployProviderId) {
    if (nextProviderId === deployProviderId) return;
    setDeployError(null);
    setDeployPhase('idle');
    await loadDeployProvider(nextProviderId);
  }

  async function saveDeployConfig() {
    setSavingDeployConfig(true);
    setDeployError(null);
    try {
      if (deployProviderId === CLOUDFLARE_PAGES_PROVIDER_ID) {
        if (!deployToken.trim()) {
          throw new Error(t('fileViewer.cloudflareApiTokenRequired'));
        }
        if (!cloudflareAccountId.trim()) {
          throw new Error(t('fileViewer.cloudflareAccountIdRequired'));
        }
      }
      const config = await updateDeployConfig(buildDeployConfigRequest(deployProviderId));
      if (!config || config.providerId !== deployProviderId) {
        throw new Error(t('fileViewer.deployProviderConfigSaveFailed', { provider: deployProviderLabel }));
      }
      syncDeployFormFromConfig(deployProviderId, config);
      if (deployProviderId === CLOUDFLARE_PAGES_PROVIDER_ID) {
        await loadCloudflareZones(config);
      }
      return config;
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : t('fileViewer.deployProviderConfigSaveFailed', { provider: deployProviderLabel }));
      return null;
    } finally {
      setSavingDeployConfig(false);
    }
  }

  function buildCloudflarePagesDeploySelection(): WebCloudflarePagesDeploySelection | undefined {
    if (deployProviderId !== CLOUDFLARE_PAGES_PROVIDER_ID) return undefined;
    const prefix = normalizeCloudflareDomainPrefixInput(cloudflareDomainPrefix);
    if (!prefix) return undefined;
    if (!isValidCloudflareDomainPrefixInput(prefix)) {
      throw new Error(t('fileViewer.cloudflareDomainPrefixInvalid'));
    }
    const zone = cloudflareZones.find((item) => item.id === cloudflareZoneId);
    if (!zone) {
      throw new Error(t('fileViewer.cloudflareZoneRequired'));
    }
    return {
      zoneId: zone.id,
      zoneName: zone.name,
      domainPrefix: prefix,
    };
  }

  async function deployToSelectedProvider() {
    setDeploying(true);
    setDeployPhase('deploying');
    setDeployError(null);
    setCopiedDeployLink(null);
    try {
      const cloudflarePagesSelection = buildCloudflarePagesDeploySelection();
      const typedToken = deployToken.trim();
      const hasNewToken = typedToken && typedToken !== deployConfig?.tokenMask;
      const cloudflareHints = cloudflareConfigHintsFromForm();
      const cloudflareHintsChanged = deployProviderId === CLOUDFLARE_PAGES_PROVIDER_ID && Boolean(
        cloudflareHints?.lastZoneId !== deployConfig?.cloudflarePages?.lastZoneId ||
        cloudflareHints?.lastZoneName !== deployConfig?.cloudflarePages?.lastZoneName ||
        cloudflareHints?.lastDomainPrefix !== deployConfig?.cloudflarePages?.lastDomainPrefix,
      );
      const needsConfigSave =
        hasNewToken ||
        teamId.trim() !== (deployConfig?.teamId || '') ||
        teamSlug.trim() !== (deployConfig?.teamSlug || '') ||
        cloudflareAccountId.trim() !== (deployConfig?.accountId || '') ||
        cloudflareHintsChanged ||
        !deployConfig?.configured;
      if (needsConfigSave) {
        const nextConfig = await saveDeployConfig();
        if (!nextConfig) return;
        if (!nextConfig?.configured) {
          const option = getDeployProviderOption(deployProviderId);
          throw new Error(t(option.tokenRequiredKey, { provider: t(option.labelKey) }));
        }
      }
      setDeployPhase('preparing-link');
      const next = await deployProjectFile(projectId, file.name, deployProviderId, cloudflarePagesSelection);
      setDeploymentsByProvider((current) => ({
        ...current,
        [next.providerId]: next,
      }));
      setDeployment(next);
      setDeployResult(next);
    } catch (err) {
      const option = getDeployProviderOption(deployProviderId);
      setDeployError(
        err instanceof Error ? err.message : t('fileViewer.deployProviderFailed', { provider: t(option.labelKey) }),
      );
    } finally {
      setDeploying(false);
      setDeployPhase('idle');
    }
  }

  async function retryDeploymentLink() {
    const current = deployResult || deployment;
    if (!current?.id) return;
    setDeployError(null);
    setDeployPhase('preparing-link');
    try {
      const next = await checkDeploymentLink(projectId, current.id);
      setDeploymentsByProvider((items) => ({
        ...items,
        [next.providerId]: next,
      }));
      setDeployment(next);
      setDeployResult(next);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : t('fileViewer.deployFailed'));
    } finally {
      setDeployPhase('idle');
    }
  }

  async function copyDeployLink(url: string) {
    const safeUrl = url.trim();
    if (!safeUrl) return;
    try {
      await navigator.clipboard.writeText(safeUrl);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = safeUrl;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.top = '-1000px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopiedDeployLink(safeUrl);
    window.setTimeout(() => {
      setCopiedDeployLink((current) => (current === safeUrl ? null : current));
    }, 1800);
  }

  function presentInThisTab() {
    setPresentMenuOpen(false);
    setInTabPresent(true);
  }

  function presentFullscreen() {
    setPresentMenuOpen(false);
    const el = previewBodyRef.current;
    if (el && typeof el.requestFullscreen === 'function') {
      el.requestFullscreen().catch(() => setInTabPresent(true));
    } else {
      setInTabPresent(true);
    }
  }

  function presentNewTab() {
    setPresentMenuOpen(false);
    openInNewTab();
  }

  function selectMode(nextMode: 'preview' | 'source') {
    if (nextMode === 'source') setDrawOverlayOpen(false);
    setMode(nextMode);
    setModeMenuOpen(false);
  }

  function activateBoard(nextTool?: BoardTool) {
    setMode('preview');
    setBoardMode(true);
    if (nextTool) setBoardTool(nextTool);
  }

  function clearBoardComposer() {
    setActiveCommentTarget(null);
    setHoveredCommentTarget(null);
    setHoveredPodMemberId(null);
    setActivePreviewCommentId(null);
    setCommentDraft('');
    setQueuedBoardNotes([]);
    setStrokePoints([]);
  }

  function queueCurrentDraft() {
    const note = commentDraft.trim();
    if (!note) return;
    setQueuedBoardNotes((current) => [...current, note]);
    setCommentDraft('');
  }

  async function sendBoardBatch() {
    if (!activeCommentTarget || !onSendBoardCommentAttachments) return;
    const nextNotes = [...queuedBoardNotes];
    if (commentDraft.trim()) nextNotes.push(commentDraft.trim());
    if (nextNotes.length === 0) return;
    setSendingBoardBatch(true);
    try {
      await onSendBoardCommentAttachments(
        buildBoardCommentAttachments({
          target: targetFromSnapshot(activeCommentTarget),
          notes: nextNotes,
        }),
      );
      clearBoardComposer();
    } finally {
      setSendingBoardBatch(false);
    }
  }

  async function savePersistentComment() {
    if (!activeCommentTarget || !commentDraft.trim() || !onSavePreviewComment) return;
    const isFreePin = activeCommentTarget.elementId.startsWith('pin-');
    const saved = await onSavePreviewComment(
      targetFromSnapshot(activeCommentTarget),
      commentDraft.trim(),
      false,
    );
    if (saved) {
      clearBoardComposer();
      setCommentSavedToast(isFreePin ? t('chat.comments.pinSavedToast') : t('chat.comments.savedToast'));
    }
  }

  const showPresent = source !== null;
  const canShare = source !== null;
  const exportTitle = file.name.replace(/\.html?$/i, '') || file.name;
  const canPptx = canShare && Boolean(onExportAsPptx) && !streaming;
  useEffect(() => {
    const nudgeKey = `${projectId}\n${file.name}`;
    if (!canShare || exportReadyNudgeSeenRef.current.has(nudgeKey)) return;
    exportReadyNudgeSeenRef.current.add(nudgeKey);
    if (hasSeenExportReadyNudge(projectId, file.name)) return;
    markExportReadyNudgeSeen(projectId, file.name);
    setExportReadyNudge(true);
    const timeout = window.setTimeout(() => setExportReadyNudge(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [canShare, file.name, projectId]);

  const openExportMenu = () => {
    fireArtifactHeaderClick('share_dropdown');
    setExportReadyNudge(false);
    markExportReadyNudgeSeen(projectId, file.name);
    setShareMenuOpen((v) => !v);
  };
  const visibleSideComments = useMemo(
    () => previewComments
      .filter((comment) => comment.filePath === file.name && comment.status === 'open')
      .sort((a, b) => b.createdAt - a.createdAt),
    [file.name, previewComments],
  );
  useEffect(() => {
    if (!boardMode || !activePreviewCommentId) return;
    const stillOpen = visibleSideComments.some((comment) => comment.id === activePreviewCommentId);
    if (!stillOpen) clearBoardComposer();
  }, [activePreviewCommentId, boardMode, visibleSideComments]);
  const activeDeployment = deployResult || deployment;
  const activeDeployedUrl = activeDeployment?.url?.trim() || '';
  const activeDeploymentDelayed = activeDeployment?.status === 'link-delayed';
  const activeDeploymentProtected = activeDeployment?.status === 'protected';
  const activeCloudflarePages = activeDeployment?.providerId === CLOUDFLARE_PAGES_PROVIDER_ID
    ? activeDeployment.cloudflarePages
    : undefined;
  const activeCloudflareCustomDomain = activeCloudflarePages?.customDomain;
  const deployProvider = getDeployProviderOption(deployProviderId);
  const deployProviderLabel = t(deployProvider.labelKey);
  const selectedCloudflareZone = cloudflareZones.find((zone) => zone.id === cloudflareZoneId) ?? null;
  const normalizedCloudflarePrefix = normalizeCloudflareDomainPrefixInput(cloudflareDomainPrefix);
  const cloudflareHostnamePreview =
    selectedCloudflareZone && normalizedCloudflarePrefix
      ? `${normalizedCloudflarePrefix}.${selectedCloudflareZone.name}`
      : '';
  const deployResultCards: DeployResultCard[] = activeCloudflarePages
    ? (() => {
        const cards: DeployResultCard[] = [];
        const pagesDevUrl = activeCloudflarePages.pagesDev?.url || activeDeployedUrl;
        if (pagesDevUrl) {
          cards.push({
            id: 'pages-dev',
            label: t('fileViewer.cloudflarePagesDevLinkLabel'),
            url: pagesDevUrl,
            status: activeCloudflarePages.pagesDev?.status || activeDeployment?.status || 'link-delayed',
            message: activeCloudflarePages.pagesDev?.statusMessage,
          });
        }
        if (activeCloudflareCustomDomain?.url) {
          cards.push({
            id: 'custom-domain',
            label: t('fileViewer.cloudflareCustomDomainLinkLabel'),
            url: activeCloudflareCustomDomain.url,
            status: activeCloudflareCustomDomain.status,
            message:
              activeCloudflareCustomDomain.errorMessage ||
              activeCloudflareCustomDomain.statusMessage,
          });
        }
        return cards;
      })()
    : activeDeployedUrl
      ? [{
          id: 'default',
          label: activeDeploymentProtected
            ? t('fileViewer.deployLinkProtectedLabel')
            : activeDeploymentDelayed
              ? t('fileViewer.deployLinkPreparingLabel')
              : t('fileViewer.deployResultLabel'),
          url: activeDeployedUrl,
          status: activeDeployment?.status || 'ready',
          message: activeDeploymentProtected
            ? t('fileViewer.deployLinkProtected')
            : activeDeploymentDelayed
              ? t('fileViewer.deployLinkDelayed')
              : activeDeployment?.statusMessage,
        }]
      : [];
  const deployActionLabelFor = (providerId: WebDeployProviderId) => {
    const option = getDeployProviderOption(providerId);
    const label = t(option.labelKey);
    const hasActiveDeploymentForProvider = Boolean(deploymentsByProvider[providerId]?.url?.trim());
    return hasActiveDeploymentForProvider
      ? t('fileViewer.redeployToProvider', { provider: label })
      : t('fileViewer.deployToProvider', { provider: label });
  };
  const deployCopyLinks = DEPLOY_PROVIDER_OPTIONS.map((option) => ({
    providerId: option.id,
    providerLabel: t(option.labelKey),
    url: deploymentsByProvider[option.id]?.url?.trim() || '',
  })).filter((item) => item.url);
  const deployButtonLabel =
    deployPhase === 'deploying'
      ? t('fileViewer.deployingToProvider', { provider: deployProviderLabel })
      : deployPhase === 'preparing-link'
        ? t('fileViewer.preparingPublicLink')
        : t('fileViewer.deployToProvider', { provider: deployProviderLabel });
  const copyDeployLabel = (url: string) =>
    copiedDeployLink === url.trim()
      ? t('fileViewer.copied')
      : t('fileViewer.copyDeployLink');
  const copyDeployMenuLabel = (providerLabel: string, url: string) =>
    copiedDeployLink === url.trim()
      ? t('fileViewer.copied')
      : `${t('fileViewer.copyDeployLink')} · ${providerLabel}`;
  const statusLabelFor = (state: ReturnType<typeof deployResultState>) => {
    if (state === 'ready') return t('fileViewer.deployLinkReady');
    if (state === 'protected') return t('fileViewer.deployLinkProtectedLabel');
    if (state === 'failed') return t('fileViewer.deployLinkFailed');
    return t('fileViewer.deployLinkPreparingLabel');
  };
  const boardAvailable = mode === 'preview' && source !== null;
  const showPreviewToolbarControls = mode === 'preview';

  return (
    <div className="viewer html-viewer">
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-left">
          <button
            type="button"
            className="icon-only"
            onClick={() => {
              fireArtifactToolbarClick('reload');
              setReloadKey((n) => n + 1);
            }}
            title={t('fileViewer.reload')}
            aria-label={t('fileViewer.reloadAria')}
          >
            <Icon name="reload" size={14} />
          </button>
          <div className="viewer-mode-menu" ref={modeMenuRef}>
            <button
              type="button"
              className="viewer-action viewer-mode-trigger"
              aria-haspopup="menu"
              aria-expanded={modeMenuOpen}
              onClick={() => setModeMenuOpen((v) => !v)}
            >
              <span>{mode === 'preview' ? t('fileViewer.preview') : t('fileViewer.source')}</span>
              <Icon name="chevron-down" size={11} />
            </button>
            {modeMenuOpen ? (
              <div className="viewer-mode-popover" role="menu">
                {([
                  ['preview', t('fileViewer.preview')],
                  ['source', t('fileViewer.source')],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={`viewer-mode-menu-item${mode === id ? ' active' : ''}`}
                    role="menuitem"
                    onClick={() => {
                      fireArtifactToolbarClick(id);
                      selectMode(id);
                    }}
                  >
                    <span>{label}</span>
                    {mode === id ? <Icon name="check" size={13} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {showPreviewToolbarControls ? (
            <>
              <span className="viewer-divider" aria-hidden />
              <PreviewViewportControls
                viewport={previewViewport}
                onViewport={setPreviewViewport}
                t={t}
              />
              <span className="viewer-divider" aria-hidden />
              <div className="zoom-menu" ref={zoomMenuRef}>
                <button
                  type="button"
                  className="viewer-action zoom-trigger"
                  aria-haspopup="menu"
                  aria-expanded={zoomMenuOpen}
                  onClick={() => {
                    fireArtifactToolbarClick('zoom_level_dropdown');
                    setZoomMenuOpen((v) => !v);
                  }}
                  style={{ minWidth: 64 }}
                >
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{zoom}%</span>
                  <Icon name="chevron-down" size={11} />
                </button>
                {zoomMenuOpen ? (
                  <div className="zoom-menu-popover" role="menu">
                    {[50, 75, 100, 125, 150, 200].map((level) => (
                      <button
                        key={level}
                        type="button"
                        className={`zoom-menu-item${zoom === level ? ' active' : ''}`}
                        role="menuitem"
                        onClick={() => {
                          setZoom(level);
                          setZoomMenuOpen(false);
                        }}
                      >
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{level}%</span>
                        {zoom === level ? (
                          <Icon name="check" size={13} />
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
          {showPreviewToolbarControls && effectiveDeck ? (
            <span
              className="deck-nav"
              role="group"
              aria-label={t('fileViewer.slideNavAria')}
            >
              <button
                type="button"
                className="icon-only"
                onClick={() => postSlide('prev')}
                title={t('fileViewer.previousSlide')}
                aria-label={t('fileViewer.previousSlide')}
                disabled={slideState !== null && slideState.active <= 0}
              >
                <Icon name="chevron-right" size={14} style={{ transform: 'rotate(180deg)' }} />
              </button>
              <span className="deck-nav-counter">
                {slideState
                  ? `${slideState.active + 1} / ${slideState.count}`
                  : '— / —'}
              </span>
              <button
                type="button"
                className="icon-only"
                onClick={() => postSlide('next')}
                title={t('fileViewer.nextSlide')}
                aria-label={t('fileViewer.nextSlide')}
                disabled={
                  slideState !== null &&
                  slideState.active >= slideState.count - 1
                }
              >
                <Icon name="chevron-right" size={14} />
              </button>
            </span>
          ) : null}
          <button
            type="button"
            className={`viewer-toggle${tweaksMode ? ' on' : ''}`}
            title={tweaksAvailable ? t('fileViewer.tweaks') : t('fileViewer.tweaksUnavailable')}
            aria-pressed={tweaksMode}
            disabled={!tweaksAvailable}
            data-coming-soon={!tweaksAvailable ? 'true' : undefined}
            onClick={() => setTweaksMode((v) => !v)}
          >
            <Icon name="tweaks" size={13} />
            <span>{t('fileViewer.tweaks')}</span>
            <span className="switch" aria-hidden />
          </button>
        </div>
        <div className="viewer-toolbar-actions">
          {showPreviewToolbarControls ? (
            <>
              <div className="palette-tweaks-anchor">
                <button
                  type="button"
                  className={`viewer-action${selectedPalette || palettePopoverOpen ? ' active' : ''}`}
                  data-testid="palette-tweaks-toggle"
                  title="Themes"
                  aria-haspopup="dialog"
                  aria-expanded={palettePopoverOpen}
                  onClick={() => {
                    fireArtifactToolbarClick('tweaks');
                    setPalettePopoverOpen((v) => !v);
                  }}
                >
                  <Icon name="paint-bucket" size={13} />
                  <span>Themes</span>
                  {selectedPalette ? (
                    <span
                      className="palette-tweaks-badge"
                      aria-hidden
                      style={{
                        backgroundColor:
                          selectedPalette === 'coral' ? '#ff5a3c' :
                          selectedPalette === 'electric' ? '#7c3aed' :
                          selectedPalette === 'acid-forest' ? '#16a34a' :
                          selectedPalette === 'risograph' ? '#e11d48' :
                          '#0a0a0a',
                      }}
                    />
                  ) : null}
                </button>
                <PaletteTweaks
                  open={palettePopoverOpen}
                  selected={selectedPalette}
                  onChange={(nextPalette) => {
                    // P0 ui_click area=tweaks_popover. status_before/after
                    // reflect whether THIS variant was selected. Picking
                    // "Original" (nextPalette === null) reads as turning
                    // off the previously selected variant — record that
                    // by passing the prior selection as variant_name.
                    const targetVariant = nextPalette ?? selectedPalette;
                    if (targetVariant) {
                      const wasSelected = selectedPalette === targetVariant;
                      const willBeSelected = nextPalette === targetVariant;
                      trackTweaksPopoverClick(analytics.track, {
                        page_name: 'artifact',
                        area: 'tweaks_popover',
                        element: 'variant_option',
                        variant_name: targetVariant,
                        artifact_id: anonymizeArtifactId({ projectId, fileName: file.name }),
                        artifact_kind: artifactKindToTracking({ fileKind: file.kind ?? null }),
                        status_before: wasSelected ? 'on' : 'off',
                        status_after: willBeSelected ? 'on' : 'off',
                      });
                    }
                    setSelectedPalette(nextPalette);
                  }}
                  onPreview={setPreviewPalette}
                  onClose={() => setPalettePopoverOpen(false)}
                />
              </div>
              <button
                className={`viewer-action${drawOverlayOpen ? ' active' : ''}`}
                type="button"
                data-testid="draw-overlay-toggle"
                title={t('fileViewer.draw')}
                aria-pressed={drawOverlayOpen}
                onClick={() => {
                  fireArtifactToolbarClick('draw');
                  const next = !drawOverlayOpen;
                  if (!next) {
                    setDrawOverlayOpen(false);
                    return;
                  }
                  const activateDraw = () => {
                    setBoardMode(false);
                    clearBoardComposer();
                    setInspectMode(false);
                    setDrawOverlayMode('draw');
                    setMode('preview');
                    setDrawOverlayOpen(true);
                  };
                  if (manualEditMode) {
                    void exitManualEditModeAfterFlush().then((ok) => {
                      if (ok) activateDraw();
                    });
                    return;
                  }
                  activateDraw();
                }}
              >
                <Icon name="draw" size={13} />
                <span>{t('fileViewer.draw')}</span>
              </button>
            </>
          ) : null}
          <button
            type="button"
            className={`viewer-action viewer-comment-toggle${boardMode ? ' active' : ''}`}
            data-testid="board-mode-toggle"
            title={t('fileViewer.comment')}
            aria-pressed={boardMode}
            onClick={() => {
              fireArtifactToolbarClick('comment');
              capturePreviewScrollPosition();
              if (boardMode) {
                setBoardMode(false);
                clearBoardComposer();
                return;
              }
              const activateComment = () => {
                clearBoardComposer();
                setInspectMode(false);
                setDrawOverlayOpen(false);
                setMode('preview');
                activateBoard(boardTool);
              };
              if (manualEditMode) {
                void exitManualEditModeAfterFlush().then((ok) => {
                  if (ok) activateComment();
                });
                return;
              }
              activateComment();
            }}
          >
            <Icon name="comment" size={13} />
            <span>{t('fileViewer.comment')}</span>
          </button>
          {boardMode ? (
            <>
              <button
                className={`viewer-action${boardTool === 'inspect' ? ' active' : ''}`}
                type="button"
                data-testid="comment-mode-toggle"
                title="Pick one element"
                aria-label="Picker"
                aria-pressed={boardTool === 'inspect'}
                onClick={() => activateBoard('inspect')}
              >
                <Icon name="edit" size={13} />
                <span>Picker</span>
              </button>
              <button
                className={`viewer-action${boardTool === 'pod' ? ' active' : ''}`}
                type="button"
                title="Draw a pod selection"
                aria-label="Pods"
                aria-pressed={boardTool === 'pod'}
                onClick={() => {
                  fireArtifactToolbarClick('pods');
                  activateBoard('pod');
                }}
              >
                <Icon name="draw" size={13} />
                <span>Pods</span>
              </button>
            </>
          ) : null}
          <button
            className={`viewer-action${inspectMode ? ' active' : ''}`}
            type="button"
            data-testid="inspect-mode-toggle"
            title="Inspect"
            aria-pressed={inspectMode}
            onClick={() => {
              fireArtifactToolbarClick('inspect');
              setInspectMode((v) => {
                const next = !v;
                if (next) {
                  setBoardMode(false);
                  clearBoardComposer();
                  setManualEditMode(false);
                  setDrawOverlayOpen(false);
                  setOpenHintBox(true);
                  setMode('preview');
                }
                return next;
              });
            }}
          >
            <Icon name="tweaks" size={13} />
            <span>Inspect</span>
          </button>
          <button
            className={`viewer-action${manualEditMode ? ' active' : ''}`}
            type="button"
            data-testid="manual-edit-mode-toggle"
            title={t('fileViewer.edit')}
            aria-pressed={manualEditMode}
            onClick={() => {
              fireArtifactToolbarClick('edit');
              capturePreviewScrollPosition();
              if (!manualEditMode) {
                setBoardMode(false);
                clearBoardComposer();
                setInspectMode(false);
                setDrawOverlayOpen(false);
                setMode('preview');
                setManualEditViewportWidth(previewBodyRef.current?.clientWidth ?? null);
                setManualEditMode(true);
                return;
              }
              void exitManualEditModeAfterFlush();
            }}
          >
            <Icon name="edit" size={13} />
            <span>{t('fileViewer.edit')}</span>
          </button>
        </div>
      </div>
      {((filePrimaryActions: ReactNode) => (
        chromeActionsHost ? createPortal(filePrimaryActions, chromeActionsHost) : filePrimaryActions
      ))(<>
          {showPresent ? (
            <div className="present-wrap chrome-present-wrap" ref={presentWrapRef}>
              <button
                className="chrome-action chrome-action-secondary present-trigger"
                aria-haspopup="menu"
                aria-expanded={presentMenuOpen}
                onClick={() => {
                  fireArtifactHeaderClick('present_dropdown');
                  setPresentMenuOpen((v) => !v);
                }}
              >
                <Icon name="present" size={13} />
                <span>{t('fileViewer.present')}</span>
                <Icon name="chevron-down" size={11} />
              </button>
              {presentMenuOpen && presentMenuPos && typeof document !== 'undefined'
                ? createPortal(
                <div
                  className="present-menu"
                  role="menu"
                  ref={presentMenuRef}
                  style={{ position: 'fixed', top: presentMenuPos.top, right: presentMenuPos.right }}
                >
                  <button role="menuitem" onClick={() => { firePresentPopoverClick('in_this_tab'); presentInThisTab(); }}>
                    <span className="present-icon"><Icon name="eye" size={13} /></span>{' '}
                    {t('fileViewer.presentInTab')}
                  </button>
                  <button role="menuitem" onClick={() => { firePresentPopoverClick('fullscreen'); presentFullscreen(); }}>
                    <span className="present-icon"><Icon name="play" size={13} /></span>{' '}
                    {t('fileViewer.presentFullscreen')}
                  </button>
                  <button role="menuitem" onClick={() => { firePresentPopoverClick('new_tab'); presentNewTab(); }}>
                    <span className="present-icon"><Icon name="share" size={13} /></span>{' '}
                    {t('fileViewer.presentNewTab')}
                  </button>
                </div>,
                    document.body,
                  )
                : null}
            </div>
          ) : null}
          {canShare ? (
            <div className="share-menu chrome-share-menu" ref={shareRef}>
              <button
                className={
                  'chrome-action chrome-action-primary chrome-action-export' +
                  (exportReadyNudge ? ' export-ready-nudge' : '')
                }
                aria-haspopup="menu"
                aria-expanded={shareMenuOpen}
                onClick={openExportMenu}
              >
                <Icon name="download" size={13} />
                <span>{t('fileViewer.shareLabel')}</span>
                <Icon name="chevron-down" size={11} />
              </button>
              {shareMenuOpen && shareMenuPos && typeof document !== 'undefined'
                ? createPortal(
                <div
                  className="share-menu-popover"
                  role="menu"
                  ref={shareMenuRef}
                  style={{ position: 'fixed', top: shareMenuPos.top, right: shareMenuPos.right }}
                >
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setShareMenuOpen(false);
                      fireShareExport('pdf', () => exportProjectAsPdf({
                        deck: effectiveDeck,
                        fallbackPdf: () => exportAsPdf(source ?? '', exportTitle, { deck: effectiveDeck }),
                        filePath: file.name,
                        projectId,
                        title: exportTitle,
                      }));
                    }}
                  >
                    <span className="share-menu-icon"><Icon name="file" size={14} /></span>
                    <span>
                      {effectiveDeck
                        ? t('fileViewer.exportPdfAllSlides')
                        : t('fileViewer.exportPdf')}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    disabled={!canPptx}
                    title={
                      onExportAsPptx
                        ? streaming
                          ? t('fileViewer.exportPptxBusy')
                          : t('fileViewer.exportPptxHint')
                        : t('fileViewer.exportPptxNa')
                    }
                    onClick={() => {
                      setShareMenuOpen(false);
                      fireShareExport('pptx', () => {
                        if (onExportAsPptx) onExportAsPptx(file.name);
                      });
                    }}
                  >
                    <span className="share-menu-icon"><Icon name="present" size={14} /></span>
                    <span>{t('fileViewer.exportPptx') + '…'}</span>
                  </button>
                  <div className="share-menu-divider" />
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setShareMenuOpen(false);
                      fireShareExport('zip', () => exportProjectAsZip({
                        projectId,
                        filePath: file.name,
                        fallbackHtml: source ?? '',
                        fallbackTitle: exportTitle,
                      }));
                    }}
                  >
                    <span className="share-menu-icon"><Icon name="download" size={14} /></span>
                    <span>{t('fileViewer.exportZip')}</span>
                  </button>
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setShareMenuOpen(false);
                      fireShareExport('html', () => exportAsHtml(source ?? '', exportTitle));
                    }}
                  >
                    <span className="share-menu-icon"><Icon name="file-code" size={14} /></span>
                    <span>{t('fileViewer.exportHtml')}</span>
                  </button>
                  {/* Export as Markdown — pass-through download of the
                      artifact source with a `.md` extension. No conversion
                      runs; the file body is identical to the Source view.
                      Useful for piping the artifact into markdown-aware
                      tooling (LLM context windows, vault apps). See
                      issue #279. */}
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setShareMenuOpen(false);
                      fireShareExport('markdown', () => exportAsMd(source ?? '', exportTitle));
                    }}
                  >
                    <span className="share-menu-icon"><Icon name="file" size={14} /></span>
                    <span>{t('fileViewer.exportMd')}</span>
                  </button>
                  {!useUrlLoadPreview ? (
                    <button
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={async () => {
                        setShareMenuOpen(false);
                        const iframe = iframeRef.current;
                        if (!iframe) return;
                        const snap = await requestPreviewSnapshot(iframe);
                        try {
                          if (snap) {
                            exportAsImage(snap.dataUrl, exportTitle);
                          } else {
                            console.warn('[exportAsImage] snapshot capture returned null');
                            alert(t('fileViewer.exportImageFailed'));
                          }
                        } catch (err) {
                          console.warn('[exportAsImage] failed to convert snapshot:', err);
                          alert(t('fileViewer.exportImageFailed'));
                        }
                      }}
                    >
                      <span className="share-menu-icon"><Icon name="image" size={14} /></span>
                      <span>{t('fileViewer.exportImage')}</span>
                    </button>
                  ) : null}
                  <div className="share-menu-divider" />
                  <button
                    type="button"
                    className="share-menu-item"
                    role="menuitem"
                    disabled={savingTemplate}
                    onClick={() => {
                      fireShareExport('template', () => {
                        openSaveAsTemplateModal();
                      });
                    }}
                  >
                    <span className="share-menu-icon"><Icon name="copy" size={14} /></span>
                    <span>
                      {savingTemplate
                        ? t('fileViewer.savingTemplate')
                        : templateNote
                          ? templateNote
                          : t('fileViewer.saveAsTemplate')}
                    </span>
                  </button>
                  <div className="share-menu-divider" />
                  {DEPLOY_PROVIDER_OPTIONS.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={() => {
                        const format =
                          option.id === 'cloudflare-pages'
                            ? 'cloudflare_pages'
                            : option.id === 'vercel-self'
                              ? 'vercel'
                              : 'vercel';
                        fireShareExport(format, () => openDeployModal(option.id));
                      }}
                    >
                      <span className="share-menu-icon"><Icon name="upload" size={14} /></span>
                      <span>{deployActionLabelFor(option.id)}</span>
                    </button>
                  ))}
                  {deployCopyLinks.length > 0 ? (
                    <div className="share-menu-divider" />
                  ) : null}
                  {deployCopyLinks.map((item) => (
                    <button
                      key={`copy-${item.providerId}`}
                      type="button"
                      className="share-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setShareMenuOpen(false);
                        void copyDeployLink(item.url);
                      }}
                    >
                      <span className="share-menu-icon"><Icon name="copy" size={14} /></span>
                      <span>{copyDeployMenuLabel(item.providerLabel, item.url)}</span>
                    </button>
                  ))}
                </div>,
                    document.body,
                  )
                : null}
            </div>
          ) : null}
        </>)}
      <div className="viewer-body" ref={previewBodyRef}>
        {source === null ? (
          <div className="viewer-empty">{t('fileViewer.loading')}</div>
        ) : mode === 'preview' ? (
          <div
            className={`${manualEditMode ? 'manual-edit-workspace' : 'comment-preview-layer'} preview-viewport preview-viewport-${previewViewport}`}
            style={previewViewportStyle(previewViewport, previewScale, previewBodySize)}
          >
            {manualEditMode ? (
              <ManualEditPanel
                targets={manualEditTargets}
                selectedTarget={selectedManualEditTarget}
                draft={manualEditDraft}
                history={manualEditHistory}
                error={manualEditError}
                canUndo={manualEditHistory.length > 0}
                canRedo={manualEditUndone.length > 0}
                busy={manualEditSaving}
                pageStylesEnabled={manualEditPageStylesEnabled}
                onSelectTarget={selectManualEditTarget}
                onDraftChange={setManualEditDraft}
                onStyleChange={(id, styles, label) => {
                  void handleManualEditStyleChange(id, styles, label);
                }}
                onInvalidStyle={cancelManualEditPendingStyles}
                onApplyPatch={(patch, label) => {
                  void applyManualEdit(patch, label);
                }}
                onError={setManualEditError}
                onClearSelection={() => {
                  void clearManualEditTargetSelection();
                }}
                onCancelDraft={() => {
                  if (selectedManualEditTarget) selectManualEditTarget(selectedManualEditTarget);
                }}
                onUndo={() => {
                  void undoManualEdit();
                }}
                onRedo={() => {
                  void redoManualEdit();
                }}
                onPickImage={async (pickedFile) => {
                  const result = await uploadProjectFiles(projectId, [pickedFile]);
                  const uploaded = result.uploaded[0];
                  if (!uploaded?.path) {
                    setManualEditError(result.error ?? t('manualEdit.uploadImageFailed'));
                    return null;
                  }
                  setManualEditError(null);
                  return toOwnerRelativePath(file.name, uploaded.path);
                }}
              />
            ) : null}
            <div className={manualEditMode ? 'manual-edit-canvas' : 'comment-frame-clip'}>
              <div
                style={
                  manualEditMode
                    ? manualEditPreviewShellStyle(previewViewport, previewScale, manualEditViewportWidth)
                    : previewScaleShellStyle(previewViewport, previewScale)
                }
              >
                <PreviewDrawOverlay
                  active={drawOverlayOpen}
                  onActiveChange={setDrawOverlayOpen}
                  onModeChange={setDrawOverlayMode}
                  captureTarget={drawClickSelectionMode ? activeCommentTarget : null}
                  filePath={file.name}
                  sendDisabled={streaming}
                  sendDisabledReason="当前正有任务在执行"
                >
                  <div className="artifact-preview-transport-stack">
                    <iframe
                      ref={urlPreviewIframeRef}
                      data-testid={useUrlLoadPreview ? 'artifact-preview-frame' : 'artifact-preview-frame-url-load'}
                      data-od-render-mode="url-load"
                      data-od-active={useUrlLoadPreview ? 'true' : 'false'}
                      aria-hidden={useUrlLoadPreview ? undefined : true}
                      tabIndex={useUrlLoadPreview ? 0 : -1}
                      title={file.name}
                      sandbox="allow-scripts allow-downloads"
                      src={urlTransportSrc}
                      onLoad={() => {
                        const frame = urlPreviewIframeRef.current;
                        if (useUrlLoadPreview) iframeRef.current = frame;
                        dcViewportRestoreAtRef.current = Date.now();
                        frame?.contentWindow?.postMessage({
                          type: '__dc_set_viewport',
                          ...dcViewportRef.current,
                        }, '*');
                        syncBridgeModes(frame);
                        if (useUrlLoadPreview) restorePreviewScrollPosition();
                      }}
                    />
                    <iframe
                      key={srcDocTransportResetKey}
                      ref={srcDocPreviewIframeRef}
                      data-testid={useUrlLoadPreview ? 'artifact-preview-frame-srcdoc' : 'artifact-preview-frame'}
                      data-od-render-mode="srcdoc"
                      data-od-active={useUrlLoadPreview ? 'false' : 'true'}
                      aria-hidden={useUrlLoadPreview ? true : undefined}
                      tabIndex={useUrlLoadPreview ? -1 : 0}
                      title={file.name}
                      sandbox="allow-scripts allow-downloads"
                      srcDoc={srcDocTransportContent}
                      onLoad={() => {
                        const frame = srcDocPreviewIframeRef.current;
                        if (!useUrlLoadPreview) iframeRef.current = frame;
                        // Any srcDoc iframe load means we are talking to a
                        // fresh document shell. Clear the activation dedupe so
                        // switching preview -> source -> preview cannot strand
                        // the new shell on the blank transport page.
                        activatedSrcDocTransportHtmlRef.current = null;
                        // Belt-and-suspenders for the ready handshake: if the
                        // postMessage racing the parent's listener registration
                        // ever loses, the load event still tells us the shell
                        // script ran to completion.
                        if (useLazySrcDocTransport) setSrcDocShellReady(true);
                        activateSrcDocTransport(frame);
                        dcViewportRestoreAtRef.current = Date.now();
                        frame?.contentWindow?.postMessage({
                          type: '__dc_set_viewport',
                          ...dcViewportRef.current,
                        }, '*');
                        replayInspectOverridesToIframe(frame);
                        syncBridgeModes(frame);
                        if (!useUrlLoadPreview) restorePreviewScrollPosition();
                      }}
                    />
                  </div>
                </PreviewDrawOverlay>
              </div>
            </div>
            {(boardMode || drawClickSelectionMode) ? (
              <CommentPreviewOverlays
                comments={boardMode ? visibleSideComments : []}
                liveTargets={liveCommentTargets}
                hoveredTarget={hoveredCommentTarget}
                hoveredPodMemberId={hoveredPodMemberId}
                activeTarget={activeCommentTarget}
                boardTool={boardTool}
                scale={overlayPreviewScale}
                strokePoints={strokePoints}
                onOpenComment={(comment, snapshot) => {
                  setActiveCommentTarget(snapshot);
                  setHoveredCommentTarget(snapshot);
                  setActivePreviewCommentId(comment.id);
                  setCommentDraft(comment.note);
                  setQueuedBoardNotes([]);
                }}
              />
            ) : null}
            {commentSavedToast ? (
              <div className="comment-toast-anchor">
                <Toast
                  message={commentSavedToast}
                  ttlMs={2200}
                  onDismiss={() => setCommentSavedToast(null)}
                />
              </div>
            ) : null}
            {templateSavedToast ? (
              <div className="comment-toast-anchor">
                <Toast
                  message={templateSavedToast}
                  ttlMs={2200}
                  onDismiss={() => setTemplateSavedToast(null)}
                />
              </div>
            ) : null}
            {boardMode && activeCommentTarget ? (
              <BoardComposerPopover
                target={activeCommentTarget}
                existing={visibleSideComments.find((comment) => comment.elementId === activeCommentTarget.elementId) ?? null}
                draft={commentDraft}
                notes={queuedBoardNotes}
                onDraft={setCommentDraft}
                onAddDraft={queueCurrentDraft}
                onRemoveQueuedNote={(index) =>
                  setQueuedBoardNotes((current) => current.filter((_, currentIndex) => currentIndex !== index))
                }
                onClose={clearBoardComposer}
                onSaveComment={savePersistentComment}
                onSendBatch={sendBoardBatch}
                onRemove={async (commentId) => {
                  if (!onRemovePreviewComment) return;
                  await onRemovePreviewComment(commentId);
                  clearBoardComposer();
                }}
                onRemoveMember={(elementId) => {
                  setActiveCommentTarget((current) => {
                    const { next, shouldClose } = applyPodMemberRemoval(current, elementId);
                    if (shouldClose) clearBoardComposer();
                    return next;
                  });
                  setHoveredPodMemberId((current) => (current === elementId ? null : current));
                }}
                onHoverMember={setHoveredPodMemberId}
                sending={sendingBoardBatch || streaming}
                t={t}
              />
            ) : null}
            {boardMode ? (
              <CommentSidePanel
                comments={visibleSideComments}
                selectedIds={selectedSideCommentIds}
                collapsed={commentSidePanelCollapsed}
                onCollapsedChange={setCommentSidePanelCollapsed}
                onClose={() => {
                  setBoardMode(false);
                  setCommentSidePanelCollapsed(false);
                  clearBoardComposer();
                }}
                onToggleSelect={(commentId) => {
                  setSelectedSideCommentIds((current) => {
                    const next = new Set(current);
                    if (next.has(commentId)) next.delete(commentId);
                    else next.add(commentId);
                    return next;
                  });
                }}
                onClearSelection={() => setSelectedSideCommentIds(new Set())}
                onReply={(comment) => {
                  // Reply == edit on a flat-thread model: prefill the
                  // popover with the existing note so the user sees and
                  // mutates the current text. Save runs through the
                  // same upsert path; matching project/conv/file/element
                  // updates note in place rather than creating a new row.
                  const snapshot = liveSnapshotForComment(comment, liveCommentTargets) ?? {
                    filePath: comment.filePath,
                    elementId: comment.elementId,
                    selector: comment.selector,
                    label: comment.label,
                    text: comment.text,
                    position: comment.position,
                    htmlHint: comment.htmlHint,
                    selectionKind: comment.selectionKind ?? 'element',
                    memberCount: comment.memberCount,
                    podMembers: comment.podMembers,
                  };
                  setActiveCommentTarget(snapshot);
                  setHoveredCommentTarget(snapshot);
                  setActivePreviewCommentId(comment.id);
                  setCommentDraft(comment.note);
                  setQueuedBoardNotes([]);
                }}
                onSendSelected={async () => {
                  if (!onSendBoardCommentAttachments) return;
                  const selected = visibleSideComments.filter(
                    (comment) => selectedSideCommentIds.has(comment.id),
                  );
                  if (selected.length === 0) return;
                  setSendingBoardBatch(true);
                  try {
                    await onSendBoardCommentAttachments(commentsToAttachments(selected));
                    setSelectedSideCommentIds(new Set());
                  } finally {
                    setSendingBoardBatch(false);
                  }
                }}
                sending={sendingBoardBatch || streaming}
                t={t}
              />
            ) : null}
            {inspectMode && activeInspectTarget ? (
              <InspectPanel
                target={activeInspectTarget}
                onApply={(prop, value) => {
                  const target = activeInspectTarget;
                  setInspectOverrides((current) =>
                    updateInspectOverride(current, target.elementId, target.selector, prop, value),
                  );
                  postInspectSet(target.elementId, target.selector, prop, value);
                }}
                onResetElement={(elementId) => {
                  setInspectOverrides((current) => {
                    if (!(elementId in current)) return current;
                    const next = { ...current };
                    delete next[elementId];
                    return next;
                  });
                  postInspectReset(elementId);
                  setActiveInspectTarget((current) => current && current.elementId === elementId
                    ? current
                    : current);
                }}
                onSaveToSource={() => {
                  void saveInspectToSource();
                }}
                onClose={() => setActiveInspectTarget(null)}
                saving={savingInspect}
                savedAt={inspectSavedAt}
                error={inspectError}
              />
            ) : null}
            {/*
              Hint banner for Inspect / Picker modes. The bridge in
              `apps/web/src/runtime/srcdoc.ts` posts `od:comment-targets`
              with every element annotated with `data-od-id` /
              `data-screen-label`, so `liveCommentTargets.size` is the
              authoritative annotation count for the current artifact.

              Two states:
              - "has targets": the existing copy ("Click any element with
                `data-od-id` to tune its style.") for users who just don't
                see the crosshair cursor.
              - "no targets" (issue #890): a freeform-generated artifact
                (e.g. PRD → HTML through a Claude-Code-compatible CLI
                without a skill) ships zero `data-od-id` annotations. The
                bridge's click handler walks up to <html>, finds nothing,
                and bails — clicks no-op silently. The static copy made
                this look broken; the empty-state copy explains what's
                missing and how to fix it. Mirrored across Inspect and
                Picker because the failure surface is identical.
            */}
            {(inspectMode || (boardMode && boardTool === 'inspect'))
              && openHintBox
              && !activeInspectTarget
              && !activeCommentTarget ? (
              <div
                className={`inspect-empty-hint-container${
                  boardMode && !commentSidePanelCollapsed ? ' comment-side-panel-open' : ''
                }`}
                data-testid="inspect-empty-hint-container"
              >
                {liveCommentTargets.size === 0 ? (
                  <div
                    className="inspect-empty-hint"
                    data-testid="inspect-empty-hint-no-targets"
                  >
                    This artifact has no <code>data-od-id</code>{' '}
                    annotations yet — ask the agent to add them to the
                    sections you want to{' '}
                    {inspectMode ? 'inspect' : 'comment on'}.
                  </div>
                ) : (
                  <div
                    className="inspect-empty-hint"
                    data-testid="inspect-empty-hint"
                  >
                    Click any element with <code>data-od-id</code> to{' '}
                    {inspectMode ? 'tune its style' : 'leave a comment'}.
                  </div>
                )}
                <button
                  type="button"
                  title="Close Inspect Hint"
                  aria-label="Close Inspect Hint"
                  onClick={() => setOpenHintBox(false)}
                  className="orbit-artifact-ghost"
                >
                  <Icon className="" name="close" size={12} />
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <pre className="viewer-source">{source}</pre>
        )}
      </div>
      {inTabPresent && source ? (
        <div
          className="present-overlay"
          role="dialog"
          aria-label={t('fileViewer.exitPresentation')}
        >
          <button
            className="present-exit"
            onClick={() => setInTabPresent(false)}
            aria-label={t('fileViewer.exitPresentation')}
          >
            <Icon name="close" size={13} /> {t('fileViewer.exitPresentation')}
          </button>
          {useUrlLoadPreview ? (
            <iframe
              title="present"
              sandbox="allow-scripts allow-downloads"
              data-od-render-mode="url-load"
              src={activePreviewSrcUrl}
            />
          ) : (
            <iframe
              title="present"
              sandbox="allow-scripts allow-downloads"
              data-od-render-mode="srcdoc"
              srcDoc={srcDoc}
            />
          )}
        </div>
      ) : null}
      {templateModalOpen ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal deploy-modal" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div className="kicker">TEMPLATE</div>
              <h2>{t('fileViewer.saveAsTemplate')}</h2>
              <p className="subtitle">{t('fileViewer.templateDescPrompt')}</p>
            </div>
            <div className="deploy-form">
              <label className="field" htmlFor={templateNameId}>
                <span className="field-label">{t('fileViewer.templateNamePrompt')}</span>
                <input
                  id={templateNameId}
                  type="text"
                  value={templateName}
                  placeholder={t('fileViewer.templateNameDefault')}
                  autoFocus
                  onChange={(e) => setTemplateName(e.target.value)}
                />
              </label>
              <label className="field" htmlFor={templateDescriptionId}>
                <span className="field-label">{t('fileViewer.templateDescPrompt')}</span>
                <textarea
                  id={templateDescriptionId}
                  rows={3}
                  value={templateDescription}
                  placeholder={t('fileViewer.optional')}
                  onChange={(e) => setTemplateDescription(e.target.value)}
                />
              </label>
              {templateSaveError ? <p className="deploy-error">{templateSaveError}</p> : null}
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="ghost-link button-like"
                disabled={savingTemplate}
                onClick={() => {
                  setTemplateModalOpen(false);
                  setTemplateSaveError(null);
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="viewer-action primary"
                disabled={savingTemplate || !templateName.trim()}
                onClick={() => {
                  void handleSaveAsTemplate();
                }}
              >
                {savingTemplate ? t('fileViewer.savingTemplate') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {deployModalOpen ? (
        <div className="modal-backdrop" role="presentation">
          <div className="modal deploy-modal deploy-flow-modal" role="dialog" aria-modal="true">
            <div className="modal-head">
              <div className="kicker">{deployProviderLabel}</div>
              <h2>{t('fileViewer.deployToProvider', { provider: deployProviderLabel })}</h2>
              <p className="subtitle">{t('fileViewer.deployModalSubtitle')}</p>
            </div>
            <div className="deploy-form">
              <label className="deploy-provider-field">
                <span>{t('fileViewer.deployProviderLabel')}</span>
                <select
                  value={deployProviderId}
                  onChange={(e) => {
                    void changeDeployProvider(e.target.value as WebDeployProviderId);
                  }}
                >
                  {DEPLOY_PROVIDER_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {t(option.labelKey)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field-label-row">
                <label htmlFor="deploy-token">{t(deployProvider.tokenLabelKey)}</label>
                <div className="field-label-note">
                  {deployConfig?.configured ? (
                    <p className="hint">{t(deployProvider.tokenReuseHintKey, { provider: deployProviderLabel })}</p>
                  ) : null}
                  {deployProviderId === CLOUDFLARE_PAGES_PROVIDER_ID ? (
                    <p className="hint">{t('fileViewer.cloudflareApiTokenScopeHint')}</p>
                  ) : null}
                  <a
                    href={deployProvider.tokenLink}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {t(deployProvider.tokenLinkKey)}
                  </a>
                </div>
              </div>
              <input
                id="deploy-token"
                type="password"
                value={deployToken}
                placeholder={t(deployProvider.tokenPlaceholderKey, { provider: deployProviderLabel })}
                onChange={(e) => setDeployToken(e.target.value)}
              />
              <div className="deploy-config-actions">
                <button
                  type="button"
                  className="ghost-link button-like"
                  disabled={savingDeployConfig}
                  onClick={() => {
                    void saveDeployConfig();
                  }}
                >
                  {savingDeployConfig ? t('fileViewer.savingConfig') : t('fileViewer.save')}
                </button>
              </div>
              {deployProviderId === CLOUDFLARE_PAGES_PROVIDER_ID ? (
                <>
                  <div className="deploy-field-grid single-field">
                    <label>
                      <span>{t('fileViewer.cloudflareAccountId')}</span>
                      <input
                        value={cloudflareAccountId}
                        onChange={(e) => setCloudflareAccountId(e.target.value)}
                      />
                      <span className="field-hint">{t('fileViewer.cloudflareAccountIdHint')}</span>
                    </label>
                  </div>
                  <div className="deploy-field-grid cloudflare-domain-grid">
                    <label>
                      <span>{t('fileViewer.cloudflareDomainPrefixLabel')}</span>
                      <input
                        value={cloudflareDomainPrefix}
                        placeholder={t('fileViewer.cloudflareDomainPrefixPlaceholder')}
                        onChange={(e) => setCloudflareDomainPrefix(e.target.value)}
                      />
                    </label>
                    <label>
                      <span>{t('fileViewer.cloudflareZoneLabel')}</span>
                      <select
                        value={cloudflareZoneId}
                        disabled={cloudflareZonesLoading || (!deployConfig?.configured && !cloudflareZones.length)}
                        onChange={(e) => setCloudflareZoneId(e.target.value)}
                      >
                        {cloudflareZones.length === 0 ? (
                          <option value="">{t('fileViewer.cloudflareZonePlaceholder')}</option>
                        ) : null}
                        {cloudflareZones.map((zone) => (
                          <option key={zone.id} value={zone.id}>
                            {zone.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="deploy-config-actions secondary">
                    <button
                      type="button"
                      className="ghost-link button-like"
                      disabled={cloudflareZonesLoading || !deployConfig?.configured}
                      onClick={() => {
                        void loadCloudflareZones();
                      }}
                    >
                      {cloudflareZonesLoading ? t('fileViewer.cloudflareZonesLoading') : t('fileViewer.cloudflareZonesRefresh')}
                    </button>
                  </div>
                  {cloudflareZonesError ? (
                    <p className="deploy-error">{cloudflareZonesError}</p>
                  ) : cloudflareZonesLoading ? (
                    <p className="hint">{t('fileViewer.cloudflareZonesLoading')}</p>
                  ) : deployConfig?.configured && cloudflareZones.length === 0 ? (
                    <p className="hint">{t('fileViewer.cloudflareZonesEmpty')}</p>
                  ) : (
                    <p className="hint">{t('fileViewer.cloudflareCustomDomainHint')}</p>
                  )}
                  {cloudflareDomainPrefix.trim() && !isValidCloudflareDomainPrefixInput(cloudflareDomainPrefix) ? (
                    <p className="deploy-error">{t('fileViewer.cloudflareDomainPrefixInvalid')}</p>
                  ) : cloudflareHostnamePreview ? (
                    <p className="hint">
                      {t('fileViewer.cloudflareHostnamePreview', { hostname: cloudflareHostnamePreview })}
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="deploy-field-grid">
                  <label>
                    <span>{t('fileViewer.vercelTeamId')}</span>
                    <input
                      value={teamId}
                      placeholder={t('fileViewer.optional')}
                      onChange={(e) => setTeamId(e.target.value)}
                    />
                  </label>
                  <label>
                    <span>{t('fileViewer.vercelTeamSlug')}</span>
                    <input
                      value={teamSlug}
                      placeholder={t('fileViewer.optional')}
                      onChange={(e) => setTeamSlug(e.target.value)}
                    />
                  </label>
                </div>
              )}
              <p className="hint">{t(deployProvider.previewHintKey)}</p>
              {deployError ? <p className="deploy-error">{deployError}</p> : null}
              {deployResultCards.length > 0 ? (
                <div className={`deploy-result-block ${deployResultState(activeDeployment?.status)}`}>
                  <div className="deploy-result-summary">
                    <div className="deploy-result-summary-head">
                      <div className="deploy-result-label">{t('fileViewer.deployResultLabel')}</div>
                      <div className={`deploy-result-badge ${deployResultState(activeDeployment?.status)}`}>
                        {statusLabelFor(deployResultState(activeDeployment?.status))}
                      </div>
                    </div>
                    {activeDeployment?.statusMessage ? (
                      <p className="deploy-result-message">{activeDeployment.statusMessage}</p>
                    ) : null}
                    <div className="deploy-result-links">
                      {deployResultCards.map((card) => {
                        const state = deployResultState(card.status);
                        const canRetry = state === 'delayed' || state === 'protected';
                        const isDisabled = state === 'protected' || state === 'failed';
                        return (
                          <div key={card.id} className={`deploy-result-link ${state}`}>
                            <div className="deploy-result-link-main">
                              <div className="deploy-result-link-head">
                                <span className="deploy-result-link-label">{card.label}</span>
                                <span className={`deploy-result-link-state ${state}`}>{statusLabelFor(state)}</span>
                              </div>
                              {card.message ? (
                                <p className="deploy-result-link-message">{card.message}</p>
                              ) : null}
                              <a
                                className="deploy-result-url"
                                href={card.url}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                {card.url}
                              </a>
                            </div>
                            <div className="deploy-result-actions">
                              {canRetry ? (
                                <button
                                  type="button"
                                  className="viewer-action"
                                  disabled={deployPhase === 'preparing-link'}
                                  onClick={() => {
                                    void retryDeploymentLink();
                                  }}
                                >
                                  {deployPhase === 'preparing-link'
                                    ? t('fileViewer.preparingPublicLink')
                                    : t('fileViewer.retryLink')}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="viewer-action"
                                onClick={() => {
                                  void copyDeployLink(card.url);
                                }}
                              >
                                <Icon name="copy" size={14} />
                                <span>{copyDeployLabel(card.url)}</span>
                              </button>
                              <a
                                className={`ghost-link ${isDisabled ? 'disabled' : ''}`}
                                href={isDisabled ? undefined : card.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                aria-disabled={isDisabled}
                              >
                                <Icon name="upload" size={14} />
                                {t('fileViewer.open')}
                              </a>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="modal-foot">
              <button
                type="button"
                className="ghost-link button-like"
                onClick={() => setDeployModalOpen(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="viewer-action primary"
                disabled={deploying || savingDeployConfig || deployPhase !== 'idle'}
                onClick={() => {
                  void deployToSelectedProvider();
                }}
              >
                {deployButtonLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function baseDirFor(fileName: string): string {
  const idx = fileName.lastIndexOf('/');
  return idx >= 0 ? fileName.slice(0, idx + 1) : '';
}

function toOwnerRelativePath(ownerFileName: string, targetPath: string): string {
  const normalize = (value: string) => decodeURIComponent(value).replace(/^\/+/, '');
  const squash = (parts: string[]) => {
    const out: string[] = [];
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (out.length > 0) out.pop();
        continue;
      }
      out.push(part);
    }
    return out;
  };
  const ownerDirPath = normalize(baseDirFor(ownerFileName));
  const targetFilePath = normalize(targetPath);
  const ownerParts = squash(ownerDirPath.split('/'));
  const targetParts = squash(targetFilePath.split('/'));

  let common = 0;
  while (
    common < ownerParts.length &&
    common < targetParts.length &&
    ownerParts[common] === targetParts[common]
  ) {
    common += 1;
  }

  const up = new Array(ownerParts.length - common).fill('..');
  const down = targetParts.slice(common);
  const rel = [...up, ...down].join('/');
  return rel || '.';
}

function hasRelativeAssetRefs(html: string): boolean {
  const attr = /\s(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = attr.exec(html)) !== null) {
    const value = match[1]?.trim();
    if (!value) continue;
    if (/^(?:https?:|data:|blob:|mailto:|tel:|#|\/)/i.test(value)) continue;
    return true;
  }
  return false;
}

async function inlineRelativeAssets(
  html: string,
  projectId: string,
  fileName: string,
): Promise<string> {
  const replacements: Array<Promise<{ from: string; to: string } | null>> = [];
  const links = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of links) {
    const rel = readHtmlAttr(tag, 'rel');
    const href = readHtmlAttr(tag, 'href');
    if (!rel || !/\bstylesheet\b/i.test(rel) || !href) continue;
    replacements.push(
      fetchProjectRelativeText(projectId, fileName, href).then((css) =>
        css == null
          ? null
          : {
              from: tag,
              to:
                `<style data-od-inline-asset="${escapeHtmlAttr(href)}">\n` +
                `${css.replace(/<\/style/gi, '<\\/style')}\n</style>`,
            },
      ),
    );
  }

  const scripts = html.match(/<script\b[^>]*\bsrc\s*=\s*["'][^"']+["'][^>]*>\s*<\/script>/gi) ?? [];
  for (const tag of scripts) {
    const src = readHtmlAttr(tag, 'src');
    if (!src) continue;
    replacements.push(
      fetchProjectRelativeText(projectId, fileName, src).then((js) => {
        if (js == null) return null;
        const open = tag.match(/^<script\b[^>]*>/i)?.[0] ?? '<script>';
        const attrs = open
          .replace(/^<script/i, '')
          .replace(/>$/i, '')
          .replace(/\ssrc\s*=\s*(['"])[\s\S]*?\1/i, '');
        return {
          from: tag,
          to: `<script${attrs}>\n${js.replace(/<\/script/gi, '<\\/script')}\n</script>`,
        };
      }),
    );
  }

  const resolved = (await Promise.all(replacements)).filter(
    (item): item is { from: string; to: string } => item !== null,
  );
  return resolved.reduce((next, { from, to }) => next.replace(from, () => to), html);
}

async function fetchProjectRelativeText(
  projectId: string,
  ownerFileName: string,
  assetRef: string,
): Promise<string | null> {
  const filePath = resolveProjectRelativePath(ownerFileName, assetRef);
  if (!filePath) return null;
  try {
    const resp = await fetch(projectRawUrl(projectId, filePath));
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

function resolveProjectRelativePath(ownerFileName: string, assetRef: string): string | null {
  if (/^(?:https?:|data:|blob:|mailto:|tel:|#|\/)/i.test(assetRef)) return null;
  try {
    const url = new URL(assetRef, `https://od.local/${baseDirFor(ownerFileName)}`);
    if (url.origin !== 'https://od.local') return null;
    return decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    return null;
  }
}

function readHtmlAttr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(['"])([\\s\\S]*?)\\1`, 'i'));
  return match?.[2] ?? null;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
