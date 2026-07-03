import { useEffect, useMemo, useRef, useState } from 'react';
import { createTabToTracking } from '@open-design/contracts/analytics';
import {
  isOpenDesignHostAvailable,
  pickAndImportHostProject,
  type OpenDesignHostProjectImportSuccess,
} from '@open-design/host';
import { useAnalytics } from '../../analytics/provider';
import {
  trackNewProjectModalElementClick,
  trackNewProjectModalSurfaceView,
  trackNewProjectModalTabClick,
} from '../../analytics/events';
import type { ConnectorDetail } from '@open-design/contracts';

import { useT } from '../../i18n';
import type {
  AudioKind,
  DesignSystemSummary,
  MediaAspect,
  ProjectTemplate,
  MediaProviderCredentials,
  PromptTemplateSummary,
  SkillSummary,
} from '../../types';
import {
  DEFAULT_AUDIO_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  MEDIA_ASPECTS,
  VIDEO_MODELS,
} from '../../media/models';
import { formatPickAndImportFailure } from '../../utils/pickAndImportError';
import { Icon } from '../shared/Icon';
import { Toast } from '../shared/Toast';
import {
  MEDIA_SURFACE_LABEL_KEYS,
  SFX_AUDIO_DURATIONS_SEC,
  TAB_LABEL_KEYS,
  type CreateInput,
  type CreateTab,
  type MediaSurface,
  type NewProjectPlatform,
  type PromptTemplatePick,
} from './types';
import {
  ConnectorsSection,
  FidelityPicker,
  PlatformPicker,
  SurfaceOptions,
  TemplatePicker,
  ToggleRow,
} from './controls';
import { PromptTemplatePicker } from './PromptTemplatePicker';
import { DesignSystemPicker } from './DesignSystemPicker';
import { MediaProjectOptions } from './MediaProjectOptions';
import { autoName, buildMetadata, titleForTab } from './metadata';

interface Props {
  skills: SkillSummary[];
  designSystems: DesignSystemSummary[];
  defaultDesignSystemId: string | null;
  templates: ProjectTemplate[];
  onDeleteTemplate?: (id: string) => Promise<boolean>;
  promptTemplates: PromptTemplateSummary[];
  onCreate: (input: CreateInput & { requestId?: string }) => void;
  onImportClaudeDesign?: (file: File) => Promise<void> | void;
  // Web fallback: the user types an absolute baseDir into the manual
  // input and the renderer POSTs `/api/import/folder` itself. Browser
  // builds have no `shell.openPath` surface, so the renderer naming a
  // path here cannot escalate (PR #974 trust model).
  onImportFolder?: (baseDir: string) => Promise<void> | void;
  // Host flow: the desktop main process owns the picker dialog and
  // the import call atomically (`pickAndImport` IPC). The renderer
  // never sees the path or the HMAC token; it only receives the
  // host-owned project identifiers and forwards them here so App-level
  // state can refresh through the daemon API.
  onImportFolderResponse?: (response: OpenDesignHostProjectImportSuccess) => Promise<void> | void;
  mediaProviders?: Record<string, MediaProviderCredentials>;
  connectors?: ConnectorDetail[];
  connectorsLoading?: boolean;
  onOpenConnectorsTab?: () => void;
  loading?: boolean;
  initialTab?: CreateTab;
}

export function defaultDesignSystemSelection(
  defaultDesignSystemId: string | null,
  designSystems: DesignSystemSummary[],
): string[] {
  if (!defaultDesignSystemId) return [];
  return designSystems.some((d) => d.id === defaultDesignSystemId)
    ? [defaultDesignSystemId]
    : [];
}

export function buildDesignSystemCreateSelection(
  showDesignSystemPicker: boolean,
  selectedIds: string[],
): { primary: string | null; inspirations: string[] } {
  return showDesignSystemPicker
    ? {
        primary: selectedIds[0] ?? null,
        inspirations: selectedIds.slice(1),
      }
    : { primary: null, inspirations: [] };
}

export function NewProjectPanel({
  skills,
  designSystems,
  defaultDesignSystemId,
  templates,
  onDeleteTemplate,
  promptTemplates,
  onCreate,
  onImportClaudeDesign,
  onImportFolder,
  onImportFolderResponse,
  mediaProviders,
  connectors,
  connectorsLoading = false,
  onOpenConnectorsTab,
  loading = false,
  initialTab = 'prototype',
}: Props) {
  const t = useT();
  const analytics = useAnalytics();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [baseDir, setBaseDir] = useState('');
  const [importingFolder, setImportingFolder] = useState(false);
  // PR #974 round-4 (mrcfps): pickAndImport now returns structured
  // failure shapes (`desktop auth secret not registered`, `web sidecar
  // URL not available`, `daemon returned HTTP X`) — surfacing them
  // gives the user a recovery hint instead of a silent no-op.
  // Shape: `{ message, details? }`. `null` means no toast.
  const [importFolderError, setImportFolderError] = useState<
    { message: string; details?: string } | null
  >(null);
  const [tab, setTab] = useState<CreateTab>(initialTab);
  // P0 analytics — fire surface_view once per (panel mount, tab) pair so the
  // funnel sees both initial open and tab switches without double-counting on
  // unrelated re-renders. Ref keys on a tab string because the panel is a
  // long-lived component the modal mounts/unmounts as the user opens/closes it.
  const newProjectViewedTabRef = useRef<string | null>(null);
  useEffect(() => {
    if (newProjectViewedTabRef.current === tab) return;
    newProjectViewedTabRef.current = tab;
    trackNewProjectModalSurfaceView(analytics.track, {
      page_name: 'home',
      area: 'new_project_modal',
      tab_name: createTabToTracking(tab),
    });
  }, [tab, analytics.track]);
  // Media tab consolidates image / video / audio. The active surface picks
  // which set of options + skill resolution applies; submission still maps
  // back to the existing image/video/audio ProjectKind branches so the
  // backend contract is unchanged.
  const [mediaSurface, setMediaSurface] = useState<MediaSurface>('image');
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [tabScroll, setTabScroll] = useState({ left: false, right: false });
  const [name, setName] = useState('');
  // Design-system selection is now an *array* internally so the same
  // component can drive both single-select and multi-select modes without
  // duplicating state. Single-select coerces to length 0/1.
  const initialDefaultDsSelection = useMemo(
    () => defaultDesignSystemSelection(defaultDesignSystemId, designSystems),
    [defaultDesignSystemId, designSystems],
  );
  const [selectedDsIds, setSelectedDsIds] = useState<string[]>(
    () => initialDefaultDsSelection,
  );
  const [dsSelectionTouched, setDsSelectionTouched] = useState(false);
  const [dsMulti, setDsMulti] = useState(false);

  // Per-tab metadata. Tracked independently so switching tabs preserves
  // each tab's pick rather than resetting to defaults.
  const [fidelity, setFidelity] = useState<'wireframe' | 'high-fidelity'>(
    'high-fidelity',
  );
  const [platformTargets, setPlatformTargets] = useState<NewProjectPlatform[]>(['responsive']);
  const [includeLandingPage, setIncludeLandingPage] = useState(false);
  const [includeOsWidgets, setIncludeOsWidgets] = useState(false);
  const [speakerNotes, setSpeakerNotes] = useState(false);
  const [animations, setAnimations] = useState(false);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [imageAspect, setImageAspect] = useState<MediaAspect>('1:1');
  const [videoModel, setVideoModel] = useState(DEFAULT_VIDEO_MODEL);
  const [videoModelTouched, setVideoModelTouched] = useState(false);
  const [videoAspect, setVideoAspect] = useState<MediaAspect>('16:9');
  const [videoLength, setVideoLength] = useState(5);
  const [audioKind, setAudioKind] = useState<AudioKind>('speech');
  const [audioModel, setAudioModel] = useState(DEFAULT_AUDIO_MODEL.speech);
  const [audioDuration, setAudioDuration] = useState(10);
  const [voice, setVoice] = useState('');
  // Per-surface curated prompt template the user picked. Tracked
  // independently for image vs video so flipping tabs doesn't clobber the
  // other one's pick. The body is editable in-line and the edited copy is
  // what gets carried to the agent — that's the "optimize the template"
  // affordance the design brief asks for.
  const [imagePromptTemplate, setImagePromptTemplate] =
    useState<PromptTemplatePick | null>(null);
  const [videoPromptTemplate, setVideoPromptTemplate] =
    useState<PromptTemplatePick | null>(null);

  // Design system is meaningful only for the structured/visual surfaces
  // (prototype, deck, template, and the freeform "other" canvas). The
  // media surfaces use prompt templates instead — design tokens don't map
  // onto image/video/audio generations, and the picker just adds noise
  // there. Keep this list explicit so future tabs declare their intent.
  const tabSupportsDesignSystem =
    tab === 'prototype' ||
    tab === 'deck' ||
    tab === 'template' ||
    tab === 'other';
  // Orbit briefings ship their own complete visual language baked into
  // example.html and explicitly opt out of DESIGN.md injection via
  // `od.design_system.requires: false`. Hide the picker only for those
  // Orbit scenario skills; the general prototype creation surface should
  // still honor the user's configured default design system even when a
  // non-Orbit default skill does not require one.
  const tabDefaultSkillForcesNoDs = useMemo(() => {
    const tabSkillId = ((): string | null => {
      if (tab === 'prototype' || tab === 'live-artifact') {
        const list = skills.filter((s) => s.mode === 'prototype');
        return list.find((s) => s.defaultFor.includes('prototype'))?.id
          ?? list[0]?.id ?? null;
      }
      if (tab === 'deck') {
        const list = skills.filter((s) => s.mode === 'deck');
        return list.find((s) => s.defaultFor.includes('deck'))?.id
          ?? list[0]?.id ?? null;
      }
      return null;
    })();
    if (!tabSkillId) return false;
    const s = skills.find((x) => x.id === tabSkillId);
    return s
      ? s.scenario === 'orbit' && s.designSystemRequired === false
      : false;
  }, [tab, skills]);
  const showDesignSystemPicker =
    tabSupportsDesignSystem && !tabDefaultSkillForcesNoDs;

  useEffect(() => {
    if (dsSelectionTouched) return;
    setSelectedDsIds(initialDefaultDsSelection);
  }, [dsSelectionTouched, initialDefaultDsSelection]);

  // When entering the template tab, snap to the first user-saved template
  // if there is one (and we don't already have a valid pick). The template
  // tab no longer offers a built-in fallback — the entire point is to
  // start from a template *the user* created via Share.
  useEffect(() => {
    if (tab !== 'template') return;
    if (templates.length === 0) {
      setTemplateId(null);
      return;
    }
    if (templateId == null || !templates.some((t) => t.id === templateId)) {
      setTemplateId(templates[0]!.id);
    }
  }, [tab, templates, templateId]);

  // The skill the request still routes through — kept so prototype/deck
  // pick a default-rendered skill (so the agent gets the right SKILL.md
  // body) without requiring the user to choose one explicitly.
  const skillIdForTab = useMemo(() => {
    if (tab === 'other') return null;
    if (tab === 'prototype') {
      const list = skills.filter((s) => s.mode === 'prototype');
      return list.find((s) => s.defaultFor.includes('prototype'))?.id
        ?? list[0]?.id
        ?? null;
    }
    if (tab === 'live-artifact') {
      const exact = skills.find((s) => s.id === 'live-artifact' || s.name === 'live-artifact');
      if (exact) return exact.id;
      const hinted = skills.find((s) => {
        const haystack = `${s.id} ${s.name} ${s.description} ${s.triggers.join(' ')}`.toLowerCase();
        return haystack.includes('live artifact') || haystack.includes('live-artifact');
      });
      if (hinted) return hinted.id;
      const prototypes = skills.filter((s) => s.mode === 'prototype');
      return prototypes.find((s) => s.defaultFor.includes('prototype'))?.id
        ?? prototypes[0]?.id
        ?? null;
    }
    if (tab === 'deck') {
      const list = skills.filter((s) => s.mode === 'deck');
      return list.find((s) => s.defaultFor.includes('deck'))?.id
        ?? list[0]?.id
        ?? null;
    }
    if (tab === 'media') {
      const list = skills.filter(
        (s) => s.mode === mediaSurface || s.surface === mediaSurface,
      );
      // The HyperFrames-HTML render path lives in the `hyperframes` skill.
      // When the user has chosen `hyperframes-html` (via dropdown or template),
      // pin the project to that skill explicitly.
      if (mediaSurface === 'video' && videoModel === 'hyperframes-html') {
        const hyper = list.find((s) => s.id === 'hyperframes');
        if (hyper) return hyper.id;
      }
      return list.find((s) => s.defaultFor.includes(mediaSurface))?.id
        ?? list[0]?.id
        ?? null;
    }
    return null;
  }, [tab, mediaSurface, skills, videoModel]);

  // When the user picks a curated prompt template, propagate the template's
  // declared `model` and `aspect` onto the actual project state. Without
  // this the user picks (e.g.) a HyperFrames template but `videoModel`
  // stays on the default seedance — the agent then dispatches the wrong
  // model and the render path mismatches the prompt.
  function handleImagePromptTemplate(pick: PromptTemplatePick | null) {
    setImagePromptTemplate(pick);
    const m = pick?.summary.model;
    if (m && IMAGE_MODELS.some((x) => x.id === m)) setImageModel(m);
    const a = pick?.summary.aspect;
    if (a && (MEDIA_ASPECTS as readonly string[]).includes(a)) {
      setImageAspect(a as MediaAspect);
    }
  }
  function handleVideoPromptTemplate(pick: PromptTemplatePick | null) {
    setVideoPromptTemplate(pick);
    const m = pick?.summary.model;
    if (m && VIDEO_MODELS.some((x) => x.id === m)) {
      setVideoModel(m);
      setVideoModelTouched(true);
    }
    const a = pick?.summary.aspect;
    if (a && (MEDIA_ASPECTS as readonly string[]).includes(a)) {
      setVideoAspect(a as MediaAspect);
    }
  }
  function handleVideoModel(id: string) {
    setVideoModel(id);
    setVideoModelTouched(true);
  }

  // The HyperFrames skill renders HTML compositions through a local
  // `npx hyperframes render` path, which dispatches under the
  // `hyperframes-html` model — not seedance/veo/sora. When the resolved
  // skill for the video tab is hyperframes, default `videoModel` so the
  // model dropdown matches the actual render path. Once the user has
  // explicitly chosen a model (via the dropdown or by picking a template
  // that declares a model), `videoModelTouched` latches and this effect
  // becomes a no-op for the rest of the panel session — re-entering the
  // Media tab's Video surface no longer silently rewrites their override back to
  // hyperframes-html.
  useEffect(() => {
    if (tab !== 'media' || mediaSurface !== 'video') return;
    if (skillIdForTab !== 'hyperframes') return;
    if (videoModelTouched) return;
    if (videoPromptTemplate) return;
    if (!VIDEO_MODELS.some((m) => m.id === 'hyperframes-html')) return;
    setVideoModel('hyperframes-html');
    // Intentionally leaving videoPromptTemplate / videoModel out of deps
    // so this only fires when the user toggles the tab or the skill
    // resolution shifts — not whenever the user changes the dropdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, mediaSurface, skillIdForTab, videoModelTouched]);

  const canCreate =
    !loading && (tab !== 'template' || templateId != null);

  function updateTabScrollState() {
    const el = tabsRef.current;
    if (!el) return;
    const maxLeft = el.scrollWidth - el.clientWidth;
    setTabScroll({
      left: el.scrollLeft > 2,
      right: el.scrollLeft < maxLeft - 2,
    });
  }

  function scrollTabs(direction: -1 | 1) {
    const el = tabsRef.current;
    if (!el) return;
    el.scrollBy({
      left: direction * Math.max(120, el.clientWidth * 0.65),
      behavior: 'smooth',
    });
  }

  function handleDesignSystemChange(ids: string[]) {
    setDsSelectionTouched(true);
    setSelectedDsIds(ids);
  }

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    updateTabScrollState();
    const onScroll = () => updateTabScrollState();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(updateTabScrollState);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    const el = tabsRef.current;
    const active = el?.querySelector<HTMLButtonElement>('.newproj-tab.active');
    active?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    window.setTimeout(updateTabScrollState, 180);
  }, [tab]);

  function handleCreate() {
    if (!canCreate) return;
    // Media surfaces don't carry a design system pick. Force the primary
    // and inspiration ids to empty there so the New Project panel can't
    // accidentally bind a stale DS that the user can no longer see in the
    // form (the picker is hidden for image/video/audio).
    const { primary: primaryDs, inspirations } =
      buildDesignSystemCreateSelection(showDesignSystemPicker, selectedDsIds);
    const promptTemplatePick =
      tab === 'media'
        ? mediaSurface === 'image'
          ? imagePromptTemplate
          : mediaSurface === 'video'
            ? videoPromptTemplate
            : null
        : null;
    const trimmedName = name.trim();
    const metadata = buildMetadata({
      tab,
      mediaSurface,
      fidelity,
      platformTargets,
      includeLandingPage,
      includeOsWidgets,
      speakerNotes,
      animations,
      templateId,
      templates,
      imageModel,
      imageAspect,
      videoModel,
      videoAspect,
      videoLength,
      audioKind,
      audioModel,
      audioDuration,
      voice,
      inspirationIds: inspirations,
      promptTemplate: promptTemplatePick,
    });
    // Generate the click→result correlation id here so the home_click and
    // the eventual project_create_result share request_id.
    const requestId = analytics.newRequestId();
    // v2 emits ui_click element=create on the New project modal; the
    // project_create_result correlated through `requestId` carries the
    // project_kind / fidelity payload, so we no longer duplicate them
    // on the click event.
    trackNewProjectModalElementClick(
      analytics.track,
      {
        page_name: 'home',
        area: 'new_project_modal',
        element: 'create',
        tab_name: createTabToTracking(tab),
      },
      { requestId },
    );
    onCreate({
      name: trimmedName || autoName(tab, mediaSurface, t),
      skillId: skillIdForTab,
      designSystemId: primaryDs,
      metadata: {
        ...metadata,
        nameSource: trimmedName ? 'user' : 'generated',
      },
      requestId,
    });
  }

  async function handleImportPicked(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file || !onImportClaudeDesign) return;
    setImporting(true);
    try {
      await onImportClaudeDesign(file);
    } finally {
      setImporting(false);
    }
  }

  // PR #974: the host bridge does not expose raw folder paths to the
  // renderer. The desktop flow uses `pickAndImport`, which performs the
  // picker + the HMAC-gated import atomically in the main process and
  // returns host-owned project identifiers.
  // The web fallback continues to use the manual baseDir input —
  // browser builds have no `shell.openPath` surface so a renderer-named
  // path cannot escalate.
  const hasHostPickAndImport = isOpenDesignHostAvailable();

  async function handleOpenFolder() {
    if (hasHostPickAndImport) {
      if (!onImportFolderResponse) return;
      setImportFolderError(null);
      setImportingFolder(true);
      try {
        const result = await pickAndImportHostProject({
          skillId: skillIdForTab,
        });
        if (!result) return;
        if (result.ok === true) {
          await onImportFolderResponse(result);
          return;
        }
        // Round-4 (mrcfps #2): every non-OK shape used to fall through
        // a silent `return`. Reserve silent for the explicit cancel
        // case; surface the structured reason for everything else
        // (auth-not-registered, web-sidecar-down, daemon HTTP errors,
        // network errors). The pickAndImport handler already pre-shapes
        // these into a `{ ok: false, reason, details? }` envelope.
        if ('canceled' in result && result.canceled === true) return;
        setImportFolderError(formatPickAndImportFailure(result));
      } finally {
        setImportingFolder(false);
      }
      return;
    }
    if (!onImportFolder) return;
    const trimmed = baseDir.trim();
    if (!trimmed) {
      setImportFolderError({ message: 'Path cannot be empty' });
      return;
    }
    setImportFolderError(null);
    setImportingFolder(true);
    try {
      await onImportFolder(trimmed);
    } catch (err) {
      setImportFolderError({
        message: err instanceof Error ? err.message : 'Failed to import folder',
      });
    } finally {
      setImportingFolder(false);
    }
  }

  return (
    <div className="newproj" data-testid="new-project-panel">
      <div className={`newproj-tabs-shell${tabScroll.left ? ' can-left' : ''}${tabScroll.right ? ' can-right' : ''}`}>
        <button
          type="button"
          className={`newproj-tabs-arrow left${tabScroll.left ? '' : ' hidden'}`}
          onClick={() => scrollTabs(-1)}
          aria-label="Scroll project types left"
          tabIndex={tabScroll.left ? 0 : -1}
        >
          <Icon name="chevron-left" size={16} strokeWidth={2} />
        </button>
        <div className="newproj-tabs" role="tablist" ref={tabsRef}>
          {(Object.keys(TAB_LABEL_KEYS) as CreateTab[]).map((entry) => (
            <button
              key={entry}
              role="tab"
              data-testid={`new-project-tab-${entry}`}
              aria-selected={tab === entry}
              className={`newproj-tab ${tab === entry ? 'active' : ''}`}
              onClick={() => {
                if (entry !== tab) {
                  trackNewProjectModalTabClick(analytics.track, {
                    page_name: 'home',
                    area: 'new_project_modal',
                    element: 'tab',
                    tab_name: createTabToTracking(entry),
                  });
                }
                setTab(entry);
              }}
            >
              {t(TAB_LABEL_KEYS[entry])}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`newproj-tabs-arrow right${tabScroll.right ? '' : ' hidden'}`}
          onClick={() => scrollTabs(1)}
          aria-label="Scroll project types right"
          tabIndex={tabScroll.right ? 0 : -1}
        >
          <Icon name="chevron-right" size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="newproj-body">
        <h3 className="newproj-title">
          <span className="newproj-title-text">{titleForTab(tab, mediaSurface, t)}</span>
          {tab === 'live-artifact' ? (
            // "Beta" is an internationally adopted brand-style status marker;
            // intentionally not run through t() (consistent with short product
            // status pills that read the same across our supported locales).
            <span className="newproj-title-badge" aria-label="Beta feature">Beta</span>
          ) : null}
        </h3>

        <input
          className="newproj-name"
          data-testid="new-project-name"
          placeholder={t('newproj.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        {showDesignSystemPicker ? (
          <DesignSystemPicker
            designSystems={designSystems}
            defaultDesignSystemId={defaultDesignSystemId}
            selectedIds={selectedDsIds}
            multi={dsMulti}
            onChangeMulti={setDsMulti}
            onChange={handleDesignSystemChange}
            loading={loading}
          />
        ) : null}

        {tab === 'media' ? (
          <div
            className="newproj-media-segmented"
            role="tablist"
            aria-label={t('newproj.tabMedia')}
          >
            {(Object.keys(MEDIA_SURFACE_LABEL_KEYS) as MediaSurface[]).map((surface) => (
              <button
                key={surface}
                type="button"
                role="tab"
                data-testid={`new-project-media-surface-${surface}`}
                aria-selected={mediaSurface === surface}
                className={`newproj-media-surface ${mediaSurface === surface ? 'active' : ''}`}
                onClick={() => setMediaSurface(surface)}
              >
                {t(MEDIA_SURFACE_LABEL_KEYS[surface])}
              </button>
            ))}
          </div>
        ) : null}

        {tab === 'media' && mediaSurface === 'image' ? (
          <PromptTemplatePicker
            surface="image"
            templates={promptTemplates}
            value={imagePromptTemplate}
            onChange={handleImagePromptTemplate}
          />
        ) : null}

        {tab === 'media' && mediaSurface === 'video' ? (
          <PromptTemplatePicker
            surface="video"
            templates={promptTemplates}
            value={videoPromptTemplate}
            onChange={handleVideoPromptTemplate}
          />
        ) : null}

        {tab === 'prototype' || tab === 'live-artifact' || tab === 'template' || tab === 'other' ? (
          <PlatformPicker value={platformTargets} onChange={setPlatformTargets} />
        ) : null}

        {tab === 'prototype' || tab === 'live-artifact' || tab === 'template' || tab === 'other' ? (
          <SurfaceOptions
            includeLandingPage={includeLandingPage}
            includeOsWidgets={includeOsWidgets}
            onIncludeLandingPage={setIncludeLandingPage}
            onIncludeOsWidgets={setIncludeOsWidgets}
          />
        ) : null}

        {/* Live artifact always renders at high fidelity — its whole point
            is data-bound polished UI, so the wireframe option is hidden. */}
        {tab === 'prototype' ? (
          <FidelityPicker value={fidelity} onChange={setFidelity} />
        ) : null}

        {tab === 'live-artifact' ? (
          <ConnectorsSection
            connectors={connectors}
            loading={connectorsLoading}
            onOpenConnectorsTab={onOpenConnectorsTab}
          />
        ) : null}

        {tab === 'deck' ? (
          <ToggleRow
            label={t('newproj.toggleSpeakerNotes')}
            hint={t('newproj.toggleSpeakerNotesHint')}
            checked={speakerNotes}
            onChange={setSpeakerNotes}
          />
        ) : null}

        {tab === 'template' ? (
          <>
            <TemplatePicker
              templates={templates}
              value={templateId}
              onChange={setTemplateId}
              onDelete={onDeleteTemplate}
            />
            <ToggleRow
              label={t('newproj.toggleAnimations')}
              hint={t('newproj.toggleAnimationsHint')}
              checked={animations}
              onChange={setAnimations}
            />
          </>
        ) : null}

        {tab === 'media' && mediaSurface === 'image' ? (
          <MediaProjectOptions
            surface="image"
            imageModel={imageModel}
            imageAspect={imageAspect}
            mediaProviders={mediaProviders}
            onImageModel={setImageModel}
            onImageAspect={setImageAspect}
          />
        ) : null}

        {tab === 'media' && mediaSurface === 'video' ? (
          <MediaProjectOptions
            surface="video"
            videoModel={videoModel}
            videoAspect={videoAspect}
            videoLength={videoLength}
            mediaProviders={mediaProviders}
            onVideoModel={handleVideoModel}
            onVideoAspect={setVideoAspect}
            onVideoLength={setVideoLength}
          />
        ) : null}

        {tab === 'media' && mediaSurface === 'audio' ? (
          <MediaProjectOptions
            surface="audio"
            audioKind={audioKind}
            audioModel={audioModel}
            audioDuration={audioDuration}
            voice={voice}
            mediaProviders={mediaProviders}
            onAudioKind={(kind) => {
              setAudioKind(kind);
              setAudioModel(DEFAULT_AUDIO_MODEL[kind]);
              if (kind === 'sfx') {
                setAudioDuration((duration) => Math.min(duration, SFX_AUDIO_DURATIONS_SEC.at(-1) ?? 30));
              }
            }}
            onAudioModel={setAudioModel}
            onAudioDuration={setAudioDuration}
            onVoice={setVoice}
          />
        ) : null}

        <button
          className="primary newproj-create"
          data-testid="create-project"
          onClick={handleCreate}
          disabled={!canCreate}
          title={
            tab === 'template' && templateId == null
              ? t('newproj.createDisabledTitle')
              : undefined
          }
        >
          <Icon name="plus" size={13} />
          <span>
            {tab === 'template'
              ? t('newproj.createFromTemplate')
              : tab === 'live-artifact'
                ? t('newproj.createLiveArtifact')
              : t('newproj.create')}
          </span>
        </button>
        {onImportClaudeDesign ? (
          <>
            <input
              ref={importInputRef}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={handleImportPicked}
            />
            <button
              type="button"
              className="ghost newproj-import"
              disabled={loading || importing}
              title={t('newproj.importClaudeZipTitle')}
              onClick={() => importInputRef.current?.click()}
            >
              <Icon name="import" size={13} />
              <span>
                {importing
                  ? t('newproj.importingClaudeZip')
                  : t('newproj.importClaudeZip')}
              </span>
            </button>
          </>
        ) : null}
        {(hasHostPickAndImport ? onImportFolderResponse : onImportFolder) ? (
          <div className="newproj-open-folder">
            {!hasHostPickAndImport ? (
              <input
                type="text"
                className="newproj-folder-input"
                placeholder="/path/to/project"
                value={baseDir}
                onChange={(e) => setBaseDir(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleOpenFolder(); }}
                disabled={importingFolder}
              />
            ) : null}
            <button
              type="button"
              className="ghost newproj-import"
              disabled={(!hasHostPickAndImport && !baseDir.trim()) || importingFolder}
              onClick={() => void handleOpenFolder()}
            >
              <Icon name="folder" size={13} />
              <span>{importingFolder ? 'Opening…' : 'Open folder'}</span>
            </button>
          </div>
        ) : null}
      </div>
      <div className="newproj-footer">{t('newproj.privacyFooter')}</div>
      {importFolderError ? (
        <Toast
          message={importFolderError.message}
          details={importFolderError.details ?? null}
          ttlMs={6000}
          onDismiss={() => setImportFolderError(null)}
        />
      ) : null}
    </div>
  );
}
