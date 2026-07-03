// Lovart-style centered hero for the entry Home view.
//
// The prompt textarea is the canonical creation surface: the user
// either types freely or selects a type below to reveal matching
// starters, then presses Run / Enter to spawn a project. The hero is
// kept dependency-free (no plugin list / project list) so it can be
// composed with the recent-projects strip and plugins section
// without owning their data lifecycles.


import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CSSProperties,
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type {
  ConnectorDetail,
  InputFieldSpec,
  InstalledPluginRecord,
  McpServerConfig,
} from '@open-design/contracts';
import type { SkillSummary } from '../../types';
import { isImeComposing } from '../../utils/imeComposing';
import { Icon, type IconName } from '../shared/Icon';
import { PluginInputsForm } from '../plugins/PluginInputsForm';
import {
  chipsForGroup,
  type HomeHeroChip,
} from '../home-hero/chips';
import {
  ProseMirrorComposerInput,
  type ProseMirrorComposerHandle,
  type SuggestionAdapter,
} from '../../composer/ProseMirrorComposerInput';
import { useI18n } from '../../i18n';
import {
  assignForwardedRef,
  connectorMatchesQuery,
  filesFromClipboard,
  formatFileSize,
  getContextMention,
  getPluginQueryPreview,
  getPluginSourceLabel,
  homeFileKey,
  isImageFile,
  mcpServerMatchesQuery,
  pluginMatchesQuery,
  replaceMentionTokenWithText,
  skillMatchesQuery,
} from './helpers';
import {
  InlineMentionToken,
  InlinePromptInput,
  InlinePromptOptionPopover,
  buildHomeMentionEntities,
  buildPromptMentionRanges,
  buildPromptOverlayParts,
  mentionSafeSelection,
} from './promptOverlay';
import {
  FooterInputOption,
  formatPromptInputValue,
  type HomeHeroDesignSystemOption,
} from './footerOptions';
import { ActiveTypeChip, RailGroup, ShortcutsMenu } from './rail';
import {
  PluginPromptPresets,
  homeHeroChipPromptExamples,
  homeHeroExamplePluginsForChip,
} from './presets';
import { INPUT_PLACEHOLDER_PATTERN } from './patterns';

export interface HomeHeroSubmitHandler {
  (): void;
}

interface Props {
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: HomeHeroSubmitHandler;
  activePluginTitle: string | null;
  activePluginRecord?: InstalledPluginRecord | null;
  activeChipId: string | null;
  onClearActivePlugin: () => void;
  onClearActiveChip?: () => void;
  activeSkillId?: string | null;
  activeSkillTitle?: string | null;
  onClearActiveSkill?: () => void;
  selectedPluginContexts?: InstalledPluginRecord[];
  onRemovePluginContext?: (pluginId: string) => void;
  onOpenPluginDetails?: (record: InstalledPluginRecord) => void;
  // Picked MCP servers / connectors. Like plugins, these now show as top
  // chips (selecting one no longer injects an `@token` into the prompt) so
  // the user can see + remove what they've added.
  selectedMcpServers?: McpServerConfig[];
  onRemoveMcpServer?: (serverId: string) => void;
  selectedConnectors?: ConnectorDetail[];
  onRemoveConnector?: (connectorId: string) => void;
  pluginInputFields?: InputFieldSpec[];
  pluginInputValues?: Record<string, unknown>;
  pluginInputTemplate?: string | null;
  onPluginInputValuesChange?: (values: Record<string, unknown>) => void;
  onPluginInputValidityChange?: (valid: boolean) => void;
  inlineEditableInputNames?: string[];
  showPluginInputsForm?: boolean;
  footerInputNames?: string[];
  designSystemOptions?: HomeHeroDesignSystemOption[];
  stagedFiles?: File[];
  onAddFiles?: (files: File[]) => void;
  onRemoveFile?: (index: number) => void;
  pluginOptions: InstalledPluginRecord[];
  pluginsLoading: boolean;
  skillOptions?: SkillSummary[];
  skillsLoading?: boolean;
  mcpOptions?: McpServerConfig[];
  mcpLoading?: boolean;
  connectorOptions?: ConnectorDetail[];
  pendingPluginId: string | null;
  pendingChipId: string | null;
  submitDisabled?: boolean;
  onPickPlugin: (record: InstalledPluginRecord, nextPrompt: string | null) => void;
  onPickExamplePlugin?: (record: InstalledPluginRecord, chipId: string, promptText: string) => void;
  onPickSkill?: (skill: SkillSummary, nextPrompt: string | null) => void;
  onPickMcp?: (server: McpServerConfig, nextPrompt: string) => void;
  onPickConnector?: (connector: ConnectorDetail, nextPrompt: string) => void;
  onPickChip: (chip: HomeHeroChip) => void;
  contextItemCount: number;
  error: string | null;
  showActivePluginChip?: boolean;
}

type HomeMentionTab = 'all' | 'plugins' | 'skills' | 'mcp' | 'connectors';

interface HomeMentionOption {
  id: string;
  icon: IconName;
  title: string;
  description: string;
  meta: string;
  pluginRecord?: InstalledPluginRecord;
  disabled?: boolean;
  onPick: () => void;
}

interface HomeMentionSection {
  id: Exclude<HomeMentionTab, 'all'>;
  label: string;
  options: HomeMentionOption[];
}

const HOME_HERO_PROMPT_MAX_HEIGHT = 180;
const HOME_HERO_AUTHORING_PROMPT_MAX_HEIGHT = 132;

export const HomeHero = forwardRef<HTMLTextAreaElement, Props>(function HomeHero(
  {
    prompt,
    onPromptChange,
    onSubmit,
    activePluginTitle,
    activePluginRecord = null,
    activeSkillId = null,
    activeSkillTitle = null,
    activeChipId,
    onClearActivePlugin,
    onClearActiveChip = onClearActivePlugin,
    onClearActiveSkill = () => undefined,
    selectedPluginContexts = [],
    onRemovePluginContext = () => undefined,
    onOpenPluginDetails = () => undefined,
    selectedMcpServers = [],
    onRemoveMcpServer = () => undefined,
    selectedConnectors = [],
    onRemoveConnector = () => undefined,
    pluginInputFields = [],
    pluginInputValues = {},
    pluginInputTemplate = null,
    onPluginInputValuesChange = () => undefined,
    onPluginInputValidityChange = () => undefined,
    inlineEditableInputNames = [],
    showPluginInputsForm = true,
    footerInputNames = [],
    designSystemOptions = [],
    stagedFiles = [],
    onAddFiles = () => undefined,
    onRemoveFile = () => undefined,
    pluginOptions,
    pluginsLoading,
    skillOptions = [],
    skillsLoading = false,
    mcpOptions = [],
    mcpLoading = false,
    connectorOptions = [],
    pendingPluginId,
    pendingChipId,
    submitDisabled = false,
    onPickPlugin,
    onPickExamplePlugin = () => undefined,
    onPickSkill = () => undefined,
    onPickMcp = () => undefined,
    onPickConnector = () => undefined,
    onPickChip,
    contextItemCount,
    error,
    showActivePluginChip = true,
  },
  ref,
) {
  const { locale, t } = useI18n();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mentionTab, setMentionTab] = useState<HomeMentionTab>('all');
  const [hoveredPlugin, setHoveredPlugin] = useState<InstalledPluginRecord | null>(null);
  const [promptScrollTop, setPromptScrollTop] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [openInlineInputName, setOpenInlineInputName] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const composingRef = useRef(false);
  const inputElementRef = useRef<HTMLTextAreaElement | null>(null);
  // The visible ProseMirror editor. The <textarea> below is now a hidden
  // controlled mirror of `prompt` (kept for the forwarded ref contract,
  // the test suite, AT/IME, and the selection-based example/insert
  // helpers); PM is what the user sees and edits. Both are downstream of
  // `prompt`. When a plugin slot template is active the textarea overlay
  // takes over (slots are interactive controls PM can't host), and PM is
  // hidden — see `promptHasSlots`.
  const pmRef = useRef<ProseMirrorComposerHandle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const shortcutsMenuRef = useRef<HTMLDivElement>(null);
  // A picked skill / plugin / context surface now lives ONLY as a chip
  // (no `@token` in the prompt body), so a selection alone — with an empty
  // prompt — is a valid turn to submit. Previously the injected token made
  // the prompt non-empty; dropping it means canSubmit must also recognize
  // an active selection, or "pick a skill then hit send" would be blocked.
  const hasActiveContext =
    Boolean(activePluginTitle) ||
    Boolean(activeSkillTitle) ||
    Boolean(activeSkillId) ||
    selectedPluginContexts.length > 0;
  const canSubmit =
    (prompt.trim().length > 0 || stagedFiles.length > 0 || hasActiveContext) &&
    !submitDisabled;
  const placeholder = activePluginTitle || activeSkillTitle
    ? t('homeHero.placeholderActive')
    : t('homeHero.placeholder');
  const mention = getContextMention(prompt);
  const mentionActive = Boolean(mention);
  const mentionQuery = mention?.query ?? '';
  const pluginMatches = useMemo(
    () =>
      mentionActive
        ? pluginOptions.filter((plugin) => pluginMatchesQuery(plugin, mentionQuery)).slice(0, 6)
        : [],
    [mentionActive, mentionQuery, pluginOptions],
  );
  const skillMatches = useMemo(
    () =>
      mentionActive
        ? skillOptions.filter((skill) => skillMatchesQuery(skill, mentionQuery)).slice(0, 6)
        : [],
    [mentionActive, mentionQuery, skillOptions],
  );
  const mcpMatches = useMemo(
    () =>
      mentionActive
        ? mcpOptions.filter((server) => mcpServerMatchesQuery(server, mentionQuery)).slice(0, 6)
        : [],
    [mcpOptions, mentionActive, mentionQuery],
  );
  const connectorMatches = useMemo(
    () =>
      mentionActive
        ? connectorOptions.filter((connector) => connectorMatchesQuery(connector, mentionQuery)).slice(0, 6)
        : [],
    [connectorOptions, mentionActive, mentionQuery],
  );
  const pickerOpen = mentionActive;
  const tabs: Array<{ id: HomeMentionTab; label: string; count: number }> = [
    { id: 'all', label: t('common.all'), count: pluginMatches.length + skillMatches.length + mcpMatches.length + connectorMatches.length },
    { id: 'plugins', label: t('entry.navPlugins'), count: pluginMatches.length },
    { id: 'skills', label: t('homeHero.skills'), count: skillMatches.length },
    { id: 'mcp', label: 'MCP', count: mcpMatches.length },
    { id: 'connectors', label: 'Connectors', count: connectorMatches.length },
  ];
  const showPlugins = mentionTab === 'all' || mentionTab === 'plugins';
  const showSkills = mentionTab === 'all' || mentionTab === 'skills';
  const showMcp = mentionTab === 'all' || mentionTab === 'mcp';
  const showConnectors = mentionTab === 'all' || mentionTab === 'connectors';
  const visibleSections: HomeMentionSection[] = [
    showPlugins
      ? {
          id: 'plugins',
          label: t('entry.navPlugins'),
          options: pluginMatches.map((plugin) => ({
            id: `plugin-${plugin.id}`,
            icon: 'sparkles',
            title: plugin.title,
            description: plugin.manifest?.description ?? plugin.id,
            meta: pendingPluginId === plugin.id ? t('homeHero.applying') : getPluginSourceLabel(plugin),
            pluginRecord: plugin,
            disabled: pendingPluginId !== null,
            onPick: () => pickPlugin(plugin),
          })),
        }
      : null,
    showSkills
      ? {
          id: 'skills',
          label: t('homeHero.skills'),
          options: skillMatches.map((skill) => ({
            id: `skill-${skill.id}`,
            icon: skill.id === activeSkillId ? 'check' : 'file',
            title: skill.name,
            description: skill.description || skill.id,
            meta: skill.id === activeSkillId ? t('common.active') : skill.mode,
            onPick: () => pickSkill(skill),
          })),
        }
      : null,
    showMcp
      ? {
          id: 'mcp',
          label: 'MCP',
          options: mcpMatches.map((server) => ({
            id: `mcp-${server.id}`,
            icon: 'link',
            title: server.label || server.id,
            description: server.url || server.command || server.id,
            meta: server.transport,
            onPick: () => pickMcp(server),
          })),
        }
      : null,
    showConnectors
      ? {
          id: 'connectors',
          label: 'Connectors',
          options: connectorMatches.map((connector) => ({
            id: `connector-${connector.id}`,
            icon: 'link',
            title: connector.name,
            description: connector.description || connector.provider || connector.id,
            meta: connector.accountLabel ?? connector.provider,
            onPick: () => pickConnector(connector),
          })),
        }
      : null,
  ].filter((section): section is HomeMentionSection => Boolean(section?.options.length));
  const visiblePickerOptions = visibleSections.flatMap((section) => section.options);
  const visibleLoading =
    (mentionTab === 'all' && (pluginsLoading || skillsLoading || mcpLoading)) ||
    (mentionTab === 'plugins' && pluginsLoading) ||
    (mentionTab === 'skills' && skillsLoading) ||
    (mentionTab === 'mcp' && mcpLoading);
  const promptMentionEntities = useMemo(
    () =>
      buildHomeMentionEntities({
        activePluginRecord,
        activeSkillId,
        activeSkillTitle,
        mcpOptions,
        pluginOptions,
        connectorOptions,
        selectedPluginContexts,
        skillOptions,
      }),
    [
      activePluginRecord,
      activeSkillId,
      activeSkillTitle,
      mcpOptions,
      pluginOptions,
      connectorOptions,
      selectedPluginContexts,
      skillOptions,
    ],
  );
  const pluginByMentionId = useMemo(() => {
    const map = new Map<string, InstalledPluginRecord>();
    for (const plugin of pluginOptions) map.set(plugin.id, plugin);
    for (const plugin of selectedPluginContexts) map.set(plugin.id, plugin);
    if (activePluginRecord) map.set(activePluginRecord.id, activePluginRecord);
    return map;
  }, [activePluginRecord, pluginOptions, selectedPluginContexts]);
  const promptOverlayParts = useMemo(
    () => buildPromptOverlayParts(
      pluginInputTemplate,
      pluginInputValues,
      prompt,
      promptMentionEntities,
    ),
    [pluginInputTemplate, pluginInputValues, prompt, promptMentionEntities],
  );
  const promptMentionRanges = useMemo(
    () => buildPromptMentionRanges(promptOverlayParts),
    [promptOverlayParts],
  );
  // Plugin slots (`{{key}}` → interactive InlinePromptInput) only appear
  // when a plugin input template is active. They are interactive overlay
  // controls PM can't host, so in that mode we keep the legacy textarea +
  // overlay surface and hide the PM editor. Free-text + @-mention (the
  // common case) renders through PM.
  const promptHasSlots = useMemo(
    () => Boolean(promptOverlayParts?.some((part) => part.kind === 'slot')),
    [promptOverlayParts],
  );
  // Literal `@<label>` tokens PM should render as chips even when they
  // contain spaces (e.g. `@1920 画布自由 Deck`).
  const knownMentionTokens = useMemo(
    () => promptMentionEntities.map((e) => e.token ?? `@${e.label}`),
    [promptMentionEntities],
  );
  // HomeHero has no slash commands and drives its own mention picker off
  // the hidden textarea (pickerOpen = mentionActive), so PM's in-editor
  // popovers are intentionally empty: PM only renders chips + owns the
  // chip-aware Backspace, never its own candidate list.
  const emptyAdapter = useMemo<SuggestionAdapter>(() => ({ search: () => [] }), []);
  const fieldByName = useMemo(
    () => new Map(pluginInputFields.map((field) => [field.name, field])),
    [pluginInputFields],
  );
  const editableInputNames = useMemo(
    () => new Set(inlineEditableInputNames),
    [inlineEditableInputNames],
  );
  const footerInputNameSet = useMemo(
    () => new Set(footerInputNames),
    [footerInputNames],
  );
  const openInlineInputField = openInlineInputName
    ? fieldByName.get(openInlineInputName) ?? null
    : null;
  // Filter out inputs whose values are already shown inline in the
  // prompt template, plus fields promoted into the compact footer.
  const templateFieldKeys = useMemo(() => {
    if (!pluginInputTemplate) return new Set<string>();
    const keys = new Set<string>();
    INPUT_PLACEHOLDER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INPUT_PLACEHOLDER_PATTERN.exec(pluginInputTemplate)) !== null) {
      if (match[1]) keys.add(match[1]);
    }
    return keys;
  }, [pluginInputTemplate]);
  const footerInputFields = useMemo(
    () => footerInputNames
      .map((name) => fieldByName.get(name))
      .filter((field): field is InputFieldSpec => Boolean(field)),
    [fieldByName, footerInputNames],
  );
  const remainingInputFields = useMemo(
    () => pluginInputFields.filter(
      (field) => !templateFieldKeys.has(field.name) && !footerInputNameSet.has(field.name),
    ),
    [footerInputNameSet, pluginInputFields, templateFieldKeys],
  );
  const activeCreateChip = useMemo(
    () => activeChipId
      ? chipsForGroup('create').find((chip) => chip.id === activeChipId) ?? null
      : null,
    [activeChipId],
  );
  const activeExamplePlugins = useMemo(
    () =>
      activeChipId
        ? homeHeroExamplePluginsForChip(activeChipId, pluginOptions, locale)
        : [],
    [activeChipId, locale, pluginOptions],
  );
  const activePromptExamples = useMemo(
    () => activeChipId && activeExamplePlugins.length === 0
      ? homeHeroChipPromptExamples(activeChipId, locale)
      : [],
    [activeChipId, activeExamplePlugins.length, locale],
  );
  const authoringLayoutActive =
    activeChipId === 'create-plugin' || pendingChipId === 'create-plugin';
  const promptMaxHeight = authoringLayoutActive
    ? HOME_HERO_AUTHORING_PROMPT_MAX_HEIGHT
    : HOME_HERO_PROMPT_MAX_HEIGHT;
  const inputCardStyle = {
    '--home-hero-prompt-max-height': `${promptMaxHeight}px`,
  } as CSSProperties;

  useEffect(() => {
    if (selectedIndex >= visiblePickerOptions.length) setSelectedIndex(0);
  }, [selectedIndex, visiblePickerOptions.length]);

  useEffect(() => {
    if (!pickerOpen) setHoveredPlugin(null);
  }, [pickerOpen]);

  useEffect(() => {
    setOpenInlineInputName(null);
  }, [activeChipId]);

  useEffect(() => {
    if (!shortcutsOpen) return;
    const closeOnPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && shortcutsMenuRef.current?.contains(target)) return;
      setShortcutsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShortcutsOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [shortcutsOpen]);

  useEffect(() => {
    setPromptScrollTop(inputElementRef.current?.scrollTop ?? 0);
  }, [prompt, promptOverlayParts]);

  // Auto-grow the prompt textarea until it reaches the composer cap.
  // Beyond that, the textarea scrolls internally so a long preset
  // prompt does not push the rest of Home off screen.
  useLayoutEffect(() => {
    const el = inputElementRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const nextHeight = Math.min(el.scrollHeight, promptMaxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > promptMaxHeight ? 'auto' : 'hidden';
    if (el.scrollHeight <= promptMaxHeight && el.scrollTop !== 0) {
      el.scrollTop = 0;
      setPromptScrollTop(0);
    } else {
      setPromptScrollTop(el.scrollTop);
    }
  }, [pluginInputValues, prompt, promptMaxHeight, promptOverlayParts]);

  const setInputRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      inputElementRef.current = node;
      assignForwardedRef(ref, node);
    },
    [ref],
  );

  // Picking a skill / plugin / MCP / connector now adds ONLY a top chip
  // (via onPick* → the home-hero__active row); it no longer injects an
  // `@token` into the prompt body. The chip is the single visible anchor +
  // remove affordance, and the backend identifies the selection through
  // the dedicated context fields (skillIds / mcpServerIds / …), not the
  // prompt text — so the `@token` was a redundant second copy that also
  // littered the input. We still strip the in-flight `@query` the user
  // typed to open the picker (replacement = '') so no stray `@de` is left.
  function pickPlugin(record: InstalledPluginRecord) {
    const nextPrompt = mention
      ? replaceMentionTokenWithText(prompt, mention, '')
      : prompt;
    onPickPlugin(record, nextPrompt);
  }

  function pickSkill(skill: SkillSummary) {
    const nextPrompt = mention
      ? replaceMentionTokenWithText(prompt, mention, '')
      : prompt;
    onPickSkill(skill, nextPrompt);
  }

  function pickMcp(server: McpServerConfig) {
    const nextPrompt = mention
      ? replaceMentionTokenWithText(prompt, mention, '')
      : prompt;
    onPickMcp(server, nextPrompt);
  }

  function pickConnector(connector: ConnectorDetail) {
    const nextPrompt = mention
      ? replaceMentionTokenWithText(prompt, mention, '')
      : prompt;
    onPickConnector(connector, nextPrompt);
  }

  function updatePluginInput(name: string, value: unknown) {
    onPluginInputValuesChange({ ...pluginInputValues, [name]: value });
  }

  function handleFiles(files: File[]) {
    if (files.length === 0) return;
    onAddFiles(files);
  }

  function usePromptExample(example: string) {
    onPromptChange(example);
    setSelectedIndex(0);
    requestAnimationFrame(() => {
      const input = inputElementRef.current;
      if (!input) return;
      input.focus();
      const position = example.length;
      input.setSelectionRange(position, position);
      input.scrollTop = input.scrollHeight;
    });
  }

  function handlePaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = filesFromClipboard(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    handleFiles(files);
  }

  function normalizeMentionSelection(input: HTMLTextAreaElement) {
    const nextSelection = mentionSafeSelection(
      input.selectionStart,
      input.selectionEnd,
      promptMentionRanges,
    );
    if (!nextSelection) return;
    requestAnimationFrame(() => {
      if (document.activeElement !== input) return;
      input.setSelectionRange(nextSelection.start, nextSelection.end);
    });
  }

  function deleteMentionTokenFromKey(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
    const input = event.currentTarget;
    if (input.selectionStart !== input.selectionEnd) return false;
    const caret = input.selectionStart;
    const range = promptMentionRanges.find((item) => (
      event.key === 'Backspace'
        ? caret > item.start && caret <= item.end
        : caret >= item.start && caret < item.end
    ));
    if (!range) return false;
    event.preventDefault();
    const nextPrompt = `${prompt.slice(0, range.start)}${prompt.slice(range.end)}`;
    onPromptChange(nextPrompt);
    requestAnimationFrame(() => {
      const nextInput = inputElementRef.current;
      if (!nextInput) return;
      nextInput.focus();
      nextInput.setSelectionRange(range.start, range.start);
    });
    return true;
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    setDragActive(false);
    handleFiles(files);
  }

  function openActivePluginDetails() {
    if (activePluginRecord) onOpenPluginDetails(activePluginRecord);
  }

  const showActiveContextRow =
    (showActivePluginChip && activePluginTitle) ||
    activeSkillTitle ||
    selectedPluginContexts.length > 0 ||
    selectedMcpServers.length > 0 ||
    selectedConnectors.length > 0;

  let optionRenderIndex = 0;

  return (
    <section className="home-hero" data-testid="home-hero">
      <h1 className="home-hero__title">{t('homeHero.title')}</h1>
      <p className="home-hero__subtitle">
        {t('homeHero.subtitlePrefix')} <kbd>Enter</kbd>.
      </p>

      <div
        className={`home-hero__input-card${
          authoringLayoutActive ? ' home-hero__input-card--compact-authoring' : ''
        }${dragActive ? ' is-drag-active' : ''}`}
        style={inputCardStyle}
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes('Files')) setDragActive(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget;
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
          setDragActive(false);
        }}
        onDrop={handleDrop}
      >
        {showActiveContextRow ? (
          <div className="home-hero__active">
            {selectedPluginContexts.map((plugin) => (
              <span
                key={plugin.id}
                className="home-hero__active-chip home-hero__active-chip--context"
                data-testid={`home-hero-context-plugin-${plugin.id}`}
              >
                <button
                  type="button"
                  className="home-hero__active-chip-body"
                  onClick={() => onOpenPluginDetails(plugin)}
                  title={t('homeHero.pluginTitle', { title: plugin.title })}
                >
                  <span className="home-hero__active-dot" aria-hidden />
                  <span>{plugin.title}</span>
                </button>
                <button
                  type="button"
                  className="home-hero__active-clear"
                  onClick={() => onRemovePluginContext(plugin.id)}
                  aria-label={t('homeHero.removePluginAria', { title: plugin.title })}
                  title={t('homeHero.removePlugin')}
                >
                  ×
                </button>
              </span>
            ))}
            {showActivePluginChip && activePluginTitle ? (
              <span className="home-hero__active-chip" data-testid="home-hero-active-plugin">
                <button
                  type="button"
                  className="home-hero__active-chip-body"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    openActivePluginDetails();
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    openActivePluginDetails();
                  }}
                  onClick={openActivePluginDetails}
                  disabled={!activePluginRecord}
                  title={activePluginRecord ? t('homeHero.pluginTitle', { title: activePluginRecord.title }) : undefined}
                >
                  <span className="home-hero__active-dot" aria-hidden />
                  <span>{activePluginTitle}</span>
                </button>
                <button
                  type="button"
                  className="home-hero__active-clear"
                  onClick={onClearActivePlugin}
                  aria-label={t('homeHero.clearActivePlugin')}
                  title={t('homeHero.clearActivePlugin')}
                >
                  ×
                </button>
              </span>
            ) : null}
            {activeSkillTitle ? (
              <span
                className="home-hero__active-chip home-hero__active-chip--skill"
                data-testid="home-hero-active-skill"
              >
                <span className="home-hero__active-dot" aria-hidden />
                <span>{t('homeHero.skillPrefix', { title: activeSkillTitle })}</span>
                <button
                  type="button"
                  className="home-hero__active-clear"
                  onClick={onClearActiveSkill}
                  aria-label={t('homeHero.clearActiveSkill')}
                  title={t('homeHero.clearActiveSkill')}
                >
                  ×
                </button>
              </span>
            ) : null}
            {selectedMcpServers.map((server) => (
              <span
                key={`mcp-${server.id}`}
                className="home-hero__active-chip home-hero__active-chip--context"
                data-testid={`home-hero-context-mcp-${server.id}`}
              >
                <span className="home-hero__active-dot" aria-hidden />
                <span>{server.label || server.id}</span>
                <button
                  type="button"
                  className="home-hero__active-clear"
                  onClick={() => onRemoveMcpServer(server.id)}
                  aria-label={`Remove MCP ${server.label || server.id}`}
                  title={t('common.delete')}
                >
                  ×
                </button>
              </span>
            ))}
            {selectedConnectors.map((connector) => (
              <span
                key={`connector-${connector.id}`}
                className="home-hero__active-chip home-hero__active-chip--context"
                data-testid={`home-hero-context-connector-${connector.id}`}
              >
                <span className="home-hero__active-dot" aria-hidden />
                <span>{connector.name}</span>
                <button
                  type="button"
                  className="home-hero__active-clear"
                  onClick={() => onRemoveConnector(connector.id)}
                  aria-label={`Remove connector ${connector.name}`}
                  title={t('common.delete')}
                >
                  ×
                </button>
              </span>
            ))}
            {contextItemCount > 0 ? (
              <span className="home-hero__context-summary">
                {t('homeHero.contextItemsResolved', { n: contextItemCount })}
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="home-hero__prompt-surface">
          <div
            className={`home-hero__prompt-editor${
              // Only dim the textarea text behind a *visible* overlay when
              // plugin slots are active. For free-text + @-mention, PM is
              // the visible editor and the overlay is a hidden mirror.
              promptHasSlots ? ' home-hero__prompt-editor--highlighted' : ''
            }`}
          >
            {/*
              The visible editor is ProseMirror (chips are real atom nodes,
              no drifting overlay). It is hidden when a plugin slot template
              is active — slots are interactive overlay controls PM can't
              host, so that mode keeps the legacy textarea + overlay.
            */}
            <ProseMirrorComposerInput
              ref={pmRef}
              value={prompt}
              placeholder={placeholder}
              slashAdapter={emptyAdapter}
              mentionAdapter={emptyAdapter}
              knownMentionTokens={knownMentionTokens}
              onChange={(text) => {
                onPromptChange(text);
                setSelectedIndex(0);
              }}
              onSubmit={() => {
                if (canSubmit) onSubmit();
              }}
              onPasteFiles={(files) => handleFiles(files)}
              className={promptHasSlots ? 'pm-composer-mirror' : 'home-hero__pm'}
            />
            {promptOverlayParts ? (
              <div
                className={promptHasSlots ? 'home-hero__prompt-highlight' : 'pm-composer-mirror--hidden'}
                data-testid="home-hero-prompt-highlight"
                style={{ ['--home-hero-prompt-scroll' as string]: `${promptScrollTop}px` }}
              >
                <div className="home-hero__prompt-highlight-inner">
                  {promptOverlayParts.map((part, index) => (
                    part.kind === 'slot' ? (
                      part.key && footerInputNameSet.has(part.key) ? (
                        <span key={`footer-slot-${part.key}-${index}`} aria-hidden>
                          {formatPromptInputValue(fieldByName.get(part.key) ?? null, pluginInputValues[part.key], part.text, t)}
                        </span>
                      ) : (
                        <InlinePromptInput
                          key={`${part.key}-${index}`}
                          field={part.key ? fieldByName.get(part.key) ?? null : null}
                          name={part.key ?? ''}
                          value={part.key ? pluginInputValues[part.key] : undefined}
                          fallbackText={part.text}
                          filled={part.filled === true}
                          editable={Boolean(part.key && editableInputNames.has(part.key))}
                          open={part.key === openInlineInputName}
                          onOpenChange={(open) => setOpenInlineInputName(open ? part.key ?? null : null)}
                        />
                      )
                    ) : (
                      part.kind === 'mention' ? (
                        <InlineMentionToken
                          key={`${part.entity.kind}-${part.entity.id}-${index}`}
                          entity={part.entity}
                          pluginRecord={pluginByMentionId.get(part.entity.id) ?? null}
                          text={part.text}
                          onOpenPluginDetails={onOpenPluginDetails}
                        />
                      ) : (
                        <span key={`text-${index}`} aria-hidden>
                          {part.text}
                        </span>
                      )
                    )
                  ))}
                </div>
              </div>
            ) : null}
            {/*
              In slot mode this is the visible editing surface (the overlay
              renders interactive slots on top of its transparent text). In
              free-text / @-mention mode it is a hidden controlled mirror:
              still a real, focusable textarea (forwarded-ref contract +
              test suite + AT/IME + selection-based example/insert helpers),
              just visually clipped behind the PM editor.
            */}
            <textarea
              ref={setInputRef}
              className={`home-hero__input${promptHasSlots ? '' : ' pm-composer-mirror'}`}
              data-testid="home-hero-input"
              {...(promptHasSlots ? {} : { 'aria-hidden': true, tabIndex: -1 })}
              value={prompt}
              spellCheck={false}
              onChange={(e) => {
                onPromptChange(e.target.value);
                setSelectedIndex(0);
              }}
              onPaste={handlePaste}
              onScroll={(event) => {
                setPromptScrollTop(event.currentTarget.scrollTop);
              }}
              onSelect={(event) => {
                normalizeMentionSelection(event.currentTarget);
              }}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              onKeyDown={(e) => {
                if (isImeComposing(e, composingRef.current)) return;
                if (deleteMentionTokenFromKey(e)) return;
                if (pickerOpen && visiblePickerOptions.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setSelectedIndex((idx) => (idx + 1) % visiblePickerOptions.length);
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSelectedIndex(
                      (idx) => (idx - 1 + visiblePickerOptions.length) % visiblePickerOptions.length,
                    );
                    return;
                  }
                  if (e.key === 'Tab') {
                    e.preventDefault();
                    const selected = visiblePickerOptions[selectedIndex] ?? visiblePickerOptions[0];
                    if (selected && !selected.disabled) selected.onPick();
                    return;
                  }
                }
                if (
                  e.key === 'Enter' &&
                  !e.shiftKey &&
                  !e.metaKey &&
                  !e.ctrlKey &&
                  !e.altKey
                ) {
                  e.preventDefault();
                  if (pickerOpen && visiblePickerOptions.length > 0) {
                    const selected = visiblePickerOptions[selectedIndex] ?? visiblePickerOptions[0];
                    if (selected && !selected.disabled) selected.onPick();
                    return;
                  }
                  if (canSubmit) onSubmit();
                }
              }}
              // Only the visible surface shows a placeholder. In slot mode
              // the textarea IS visible, so it keeps the placeholder; in
              // free-text/@-mention mode the PM editor is visible and shows
              // it instead, so the hidden mirror textarea must not (it would
              // leak over the PM text).
              placeholder={promptHasSlots ? placeholder : undefined}
              rows={3}
              aria-controls={pickerOpen ? 'home-hero-context-picker' : undefined}
              aria-expanded={pickerOpen}
            />
          </div>
          {openInlineInputField ? (
            <InlinePromptOptionPopover
              field={openInlineInputField}
              value={pluginInputValues[openInlineInputField.name]}
              onChange={(value) => {
                onPluginInputValuesChange({
                  ...pluginInputValues,
                  [openInlineInputField.name]: value,
                });
                if (openInlineInputField.type !== 'string') {
                  setOpenInlineInputName(null);
                }
              }}
            />
          ) : null}
          {showPluginInputsForm && remainingInputFields.length > 0 ? (
            <PluginInputsForm
              fields={remainingInputFields}
              values={pluginInputValues}
              onChange={onPluginInputValuesChange}
              onValidityChange={onPluginInputValidityChange}
            />
          ) : null}
        </div>
        {stagedFiles.length > 0 ? (
          <div className="home-hero__attachments" data-testid="home-hero-staged-files">
            {stagedFiles.map((file, index) => (
              <span
                key={homeFileKey(file, index)}
                className="home-hero__attachment-chip"
                title={`${file.name} · ${formatFileSize(file.size)}`}
              >
                <span className="home-hero__attachment-icon" aria-hidden>
                  <Icon name={isImageFile(file) ? 'image' : 'file'} size={13} />
                </span>
                <span className="home-hero__attachment-name">{file.name}</span>
                <span className="home-hero__attachment-size">
                  {formatFileSize(file.size)}
                </span>
                <button
                  type="button"
                  className="home-hero__attachment-remove"
                  onClick={() => onRemoveFile(index)}
                  aria-label={t('chat.removeAria', { name: file.name })}
                  title={t('homeHero.removeFile')}
                >
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {pickerOpen ? (
          <div
            id="home-hero-context-picker"
            className="home-hero__plugin-picker"
            role="listbox"
            aria-label={t('homeHero.contextSearchResults')}
            data-testid="home-hero-plugin-picker"
          >
            <div className="home-hero__mention-tabs" role="tablist" aria-label={t('homeHero.contextSurfaces')}>
              {tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={mentionTab === item.id}
                  className={`home-hero__mention-tab${mentionTab === item.id ? ' is-active' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setMentionTab(item.id);
                    setSelectedIndex(0);
                  }}
                >
                  <span>{item.label}</span>
                  {item.count > 0 ? <span>{item.count}</span> : null}
                </button>
              ))}
            </div>
            {visibleLoading && visiblePickerOptions.length === 0 ? (
              <div className="home-hero__plugin-picker-empty">{t('homeHero.loadingContext')}</div>
            ) : null}
            {!visibleLoading && visiblePickerOptions.length === 0 ? (
              <div className="home-hero__plugin-picker-empty">
                {mentionQuery ? (
                  <>{t('homeHero.noResults', { query: mentionQuery })}</>
                ) : (
                  <>{t('homeHero.searchPrompt')}</>
                )}
              </div>
            ) : null}
            {visibleSections.map((section) => (
              <div key={section.id} className="home-hero__mention-section">
                <div className="home-hero__mention-section-label">{section.label}</div>
                {section.options.map((item) => {
                  const optionIndex = optionRenderIndex;
                  optionRenderIndex += 1;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-selected={optionIndex === selectedIndex}
                      className={`home-hero__plugin-option${
                        optionIndex === selectedIndex ? ' is-active' : ''
                      }`}
                      onMouseEnter={() => {
                        setSelectedIndex(optionIndex);
                        setHoveredPlugin(item.pluginRecord ?? null);
                      }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        if (!item.disabled) item.onPick();
                      }}
                      disabled={item.disabled}
                    >
                      <span className="home-hero__plugin-option-icon" aria-hidden>
                        <Icon name={item.icon} size={13} />
                      </span>
                      <span className="home-hero__plugin-option-main">
                        <span>{item.title}</span>
                        <span>{item.description}</span>
                      </span>
                      <span className="home-hero__plugin-option-meta">
                        {item.meta}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {hoveredPlugin ? (
              <div
                className="home-hero__plugin-hover-card"
                data-testid="home-hero-plugin-hover-card"
              >
                <div>
                  <span className="home-hero__plugin-hover-kicker">
                    {getPluginSourceLabel(hoveredPlugin)}
                  </span>
                  <strong>{hoveredPlugin.title}</strong>
                  <p>{hoveredPlugin.manifest?.description ?? hoveredPlugin.id}</p>
                </div>
                <div className="home-hero__plugin-hover-meta">
                  <span>{t('homeHero.parameters', { n: (hoveredPlugin.manifest?.od?.inputs ?? []).length })}</span>
                  {getPluginQueryPreview(hoveredPlugin) ? (
                    <span>{getPluginQueryPreview(hoveredPlugin)}</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onOpenPluginDetails(hoveredPlugin)}
                >
                  {t('homeHero.details')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="home-hero__input-foot">
          <input
            ref={fileInputRef}
            data-testid="home-hero-file-input"
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              handleFiles(files);
              event.target.value = '';
            }}
          />
          <div className="home-hero__foot-left">
            <button
              type="button"
              className="home-hero__attach"
              data-testid="home-hero-attach"
              onClick={() => fileInputRef.current?.click()}
              title={t('chat.attachAria')}
              aria-label={t('chat.attachAria')}
            >
              <Icon name="attach" size={15} />
            </button>
            {activeCreateChip ? (
              <ActiveTypeChip chip={activeCreateChip} onClear={onClearActiveChip} />
            ) : null}
            {footerInputFields.length > 0 ? (
              <div className="home-hero__footer-options" data-testid="home-hero-footer-options">
                {footerInputFields.map((field) => (
                  <FooterInputOption
                    key={field.name}
                    field={field}
                    value={pluginInputValues[field.name]}
                    designSystemOptions={designSystemOptions}
                    onChange={(value) => {
                      onPluginInputValuesChange({
                        ...pluginInputValues,
                        [field.name]: value,
                      });
                    }}
                    t={t}
                  />
                ))}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="home-hero__submit"
            data-testid="home-hero-submit"
            onClick={onSubmit}
            disabled={!canSubmit}
            title={canSubmit ? t('homeHero.run') : t('homeHero.typeSomethingToRun')}
            aria-label={t('homeHero.run')}
          >
            <Icon name="arrow-up" size={17} />
          </button>
        </div>
      </div>

      {activeCreateChip ? null : (
        <RailGroup
          group="create"
          activeChipId={activeChipId}
          pendingChipId={pendingChipId}
          pendingPluginId={pendingPluginId}
          pluginsLoading={pluginsLoading}
          onPickChip={onPickChip}
          variant="tabs"
        >
          <ShortcutsMenu
            activeChipId={activeChipId}
            pendingChipId={pendingChipId}
            pendingPluginId={pendingPluginId}
            pluginsLoading={pluginsLoading}
            open={shortcutsOpen}
            refNode={shortcutsMenuRef}
            onOpenChange={setShortcutsOpen}
            onPickChip={(chip) => {
              setShortcutsOpen(false);
              onPickChip(chip);
            }}
          />
        </RailGroup>
      )}

      {activeExamplePlugins.length > 0 && activeChipId ? (
        <PluginPromptPresets
          chipId={activeChipId}
          plugins={activeExamplePlugins}
          activePluginId={activePluginRecord?.id ?? null}
          pendingPluginId={pendingPluginId}
          locale={locale}
          onPick={onPickExamplePlugin}
        />
      ) : activePromptExamples.length > 0 ? (
        <div
          className="home-hero__prompt-examples"
          data-testid="home-hero-prompt-examples"
        >
          <div className="home-hero__prompt-examples-title">
            {t('homeHero.promptExamples')}
          </div>
          <div className="home-hero__prompt-examples-grid">
            {activePromptExamples.map((example) => (
              <button
                key={example}
                type="button"
                className="home-hero__prompt-example"
                data-testid="home-hero-prompt-example"
                onClick={() => usePromptExample(example)}
              >
                <span>{example}</span>
                <Icon name="external-link" size={14} aria-hidden />
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="home-hero__error">
          {error}
        </div>
      ) : null}
    </section>
  );
});
