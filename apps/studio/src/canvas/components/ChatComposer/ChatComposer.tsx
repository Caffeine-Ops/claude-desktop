import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useT } from '../../i18n';
import { useAnalytics } from '../../analytics/provider';
import {
  trackChatPanelClick,
} from '../../analytics/events';
import { IMAGE_MODELS } from "../../media/models";
import { uploadProjectFiles, openFolderDialog, fetchConnectors } from "../../providers/registry";
import { patchProject } from "../../state/projects";
import { fetchMcpServers } from "../../state/mcp";
import type { McpServerConfig, McpTemplate } from "../../state/mcp";
import { listPlugins } from "../../state/projects";
import type { AppConfig, ChatAttachment, ChatCommentAttachment, ProjectFile, ProjectMetadata, SkillSummary } from "../../types";
import type {
  ContextItem,
  ConnectorDetail,
  InstalledPluginRecord,
  ResearchOptions,
  RunContextSelection,
} from '@open-design/contracts';
import { buildVisualAnnotationAttachment } from '../../comments';
import { Icon } from "../shared/Icon";
import { PluginDetailsModal } from "../plugins/PluginDetailsModal";
import { PluginsSection, type PluginsSectionHandle } from "../plugins/PluginsSection";
import { BUILT_IN_PETS, CUSTOM_PET_ID } from "../pet/pets";
import {
  buildInlineMentionParts,
  inlineMentionToken,
} from '../../utils/inlineMentions';
import { isImeComposing } from '../../utils/imeComposing';
import { ANNOTATION_EVENT, type AnnotationEventDetail } from "../shared/PreviewDrawOverlay";
import {
  ProseMirrorComposerInput,
  type ProseMirrorComposerHandle,
  type SuggestionAdapter,
} from "../../composer/ProseMirrorComposerInput";
import type { SuggestionItem } from "../../composer/suggestionPlugin";
import { buildComposerMentionEntities } from './mentionEntities';
import { MentionPopover, SlashPopover } from './Popovers';
import {
  mcpServerMatchesQuery,
  pluginMatchesQuery,
  skillMatchesQuery,
  skillMentionRank,
} from './queryMatchers';
import {
  StagedAttachments,
  StagedCommentAttachments,
  StagedContextChips,
  StagedSkills,
} from './StagedChips';
import {
  ToolsImportPanel,
  ToolsMcpPanel,
  ToolsPluginsPanel,
  ToolsSkillsPanel,
} from './ToolsPanels';
import type { SlashCommand } from './types';

type ToolsTab = 'plugins' | 'skills' | 'mcp' | 'import' | 'pet';

const COMPOSER_TEXTAREA_MIN_HEIGHT = 88;
const COMPOSER_TEXTAREA_MAX_HEIGHT = 184;

function composerTextareaMaxHeight(): number {
  if (typeof window === 'undefined') return COMPOSER_TEXTAREA_MAX_HEIGHT;
  return Math.max(
    COMPOSER_TEXTAREA_MIN_HEIGHT,
    Math.min(COMPOSER_TEXTAREA_MAX_HEIGHT, Math.round(window.innerHeight * 0.34)),
  );
}

interface Props {
  projectId: string | null;
  projectFiles: ProjectFile[];
  streaming: boolean;
  sendDisabled?: boolean;
  initialDraft?: string;
  // Lazy ensure — the composer calls this before its first upload, so the
  // project folder exists on disk before files land in it. Returns the
  // project id when ready.
  onEnsureProject: () => Promise<string | null>;
  commentAttachments?: ChatCommentAttachment[];
  onRemoveCommentAttachment?: (id: string) => void;
  // Available skills the user can compose into a turn via @<skill>. The
  // chat layer already filters out disabled skills before passing them in
  // here, so the picker can render the list as-is. Keep this optional so
  // the composer still works on surfaces that don't show a skills picker
  // (e.g. tests, screenshot harnesses).
  skills?: SkillSummary[];
  onSend: (
    prompt: string,
    attachments: ChatAttachment[],
    commentAttachments: ChatCommentAttachment[],
    meta?: ChatSendMeta,
  ) => void;
  onStop: () => void;
  // Opens the global settings dialog (CLI / model / agent picker). The
  // composer's leading gear icon routes here so users can switch models
  // without leaving the chat.
  onOpenSettings?: () => void;
  // Opens settings on the External MCP tab. Wired from ChatPane → App.
  // The composer's `/mcp` slash command and the MCP picker button route here.
  onOpenMcpSettings?: () => void;
  // Optional pet wiring — when present, the composer renders a small
  // 🐾 button + popover so users can adopt / wake / tuck a pet without
  // leaving chat. Typing `/pet` (or `/pet wake|tuck|<id>`) is parsed
  // out of the draft and routed to the same handlers.
  petConfig?: AppConfig['pet'];
  onAdoptPet?: (petId: string) => void;
  onTogglePet?: () => void;
  onOpenPetSettings?: () => void;
  researchAvailable?: boolean;
  projectMetadata?: ProjectMetadata;
  onProjectMetadataChange?: (metadata: ProjectMetadata) => void;
  // SenseAudio BYOK image-model picker shown above the textarea. Hidden
  // when the active chat protocol is anything other than 'senseaudio',
  // so the composer stays clean for every other BYOK tab. The state
  // owner is ProjectView (per-session, reset on refresh); ChatComposer
  // is a fully controlled select.
  byokApiProtocol?: AppConfig['apiProtocol'];
  byokImageModel?: string;
  onChangeByokImageModel?: (model: string) => void;
  currentSkillId?: string | null;
  onProjectSkillChange?: (skillId: string | null) => void;
  // Set when the project was created with a plugin already pinned
  // (PluginLoopHome on Home). When provided, the in-composer plugin
  // rail collapses to the single pinned plugin so the user can see
  // which plugin is active without being offered every other installed
  // plugin (the user reported "选了 new-generation, 结果 composer 显
  // 示了多个 plugin"). The active plugin still appears as an
  // ActivePluginChip on each user message (see UserMessage in
  // ChatPane). Pass `null` (or omit) to render the full rail.
  pinnedPluginId?: string | null;
  footerAccessory?: ReactNode;
}

// Imperative handle so ancestors (e.g. example chips in ChatPane) can
// push text into the composer without owning its draft state.
export interface ChatComposerHandle {
  setDraft: (text: string) => void;
  focus: () => void;
}

export interface ChatSendMeta {
  research?: ResearchOptions;
  context?: RunContextSelection;
  // Per-turn skill ids picked via the @-mention popover. The chat layer
  // forwards these to the daemon's `skillIds` field so the system prompt
  // for this run only is composed with the extra skill bodies, without
  // touching the project's persistent `skillId`.
  skillIds?: string[];
}

/**
 * The chat composer: textarea + paste/drop/attach buttons + @-mention
 * picker. Attachments are uploaded into the active project's folder so
 * the agent can reference them by relative path on its next turn.
 *
 * `@` typed at a word boundary opens a popover listing project files.
 * Selecting one inserts `@<path>` into the prompt and stages it as an
 * attachment so the daemon also includes it explicitly.
 */
export const ChatComposer = forwardRef<ChatComposerHandle, Props>(
  function ChatComposer(
    {
      projectId,
      projectFiles,
      streaming,
      sendDisabled = false,
      initialDraft,
      onEnsureProject,
      commentAttachments = [],
      onRemoveCommentAttachment,
      skills = [],
      onSend,
      onStop,
      onOpenMcpSettings,
      petConfig,
      onAdoptPet,
      onTogglePet,
      onOpenPetSettings,
      researchAvailable = false,
      projectMetadata,
      onProjectMetadataChange,
      byokApiProtocol,
      byokImageModel,
      onChangeByokImageModel,
      currentSkillId = null,
      onProjectSkillChange,
      pinnedPluginId = null,
      footerAccessory,
    },
    ref
  ) {
    const t = useT();
    const analytics = useAnalytics();
    const [draft, setDraft] = useState(initialDraft ?? "");

    // chat_panel page_view fires from ProjectView (which outlives
    // conversation switches) so the event measures real chat-panel
    // entries rather than ChatComposer remounts. See PR #2285 review
    // 2026-05-20 04:08 for the rationale.
    const [staged, setStaged] = useState<ChatAttachment[]>([]);
    const [stagedVisualComments, setStagedVisualComments] = useState<ChatCommentAttachment[]>([]);
    const streamingAnnotationSendPendingRef = useRef(false);
    const [streamingAnnotationSendPending, setStreamingAnnotationSendPendingState] = useState(false);
    // Skills the user has @-mentioned for this turn. We dedupe on id and
    // strip the chip when the user removes the corresponding `@<skill>`
    // token from the draft, keeping draft and chips in sync.
    const [stagedSkills, setStagedSkills] = useState<SkillSummary[]>([]);
    const [stagedMcpServers, setStagedMcpServers] = useState<McpServerConfig[]>([]);
    const [stagedConnectors, setStagedConnectors] = useState<ConnectorDetail[]>([]);
    const [dragActive, setDragActive] = useState(false);
    const [mention, setMention] = useState<{
      q: string;
      cursor: number;
    } | null>(null);
    const [composerScrollTop, setComposerScrollTop] = useState(0);
    // Slash-command popover state — when the draft starts with `/` and
    // the cursor is still inside that token (no space committed yet),
    // we show a small palette of supported commands. The query is the
    // text after `/` so the user can type-to-filter.
    const [slash, setSlash] = useState<{
      q: string;
      cursor: number;
    } | null>(null);
    const [slashIndex, setSlashIndex] = useState(0);
    const [uploading, setUploading] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    // External MCP servers configured by the user. Fetched lazily on mount;
    // shown in the slash-command palette so `/mcp <id>` inserts a hint into
    // the prompt that nudges the model to use that server's tools.
    const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
    const [mcpTemplates, setMcpTemplates] = useState<McpTemplate[]>([]);
    const [connectors, setConnectors] = useState<ConnectorDetail[]>([]);
    // Installed plugins, fetched lazily for the tools-menu Plugins tab and
    // the @-mention picker. Both surfaces share the same list so applying
    // a plugin from either path lands on the same project context.
    const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginRecord[]>([]);
    // Detail modal — opened from a context chip click (kind === 'plugin')
    // or from the tools-menu "Details" affordance.
    const [detailsRecord, setDetailsRecord] = useState<InstalledPluginRecord | null>(null);
    const pluginsSectionRef = useRef<PluginsSectionHandle | null>(null);
    // Consolidated "tools" popover — a single dropdown anchored to the
    // leading sliders icon that hosts MCP / Import / Pet quick actions and
    // a shortcut to open the full Settings dialog. Replaces the previous
    // row of three standalone buttons (which overflowed in narrow chats).
    const [toolsOpen, setToolsOpen] = useState(false);
    const [toolsTab, setToolsTab] = useState<ToolsTab>('plugins');
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    // The visible ProseMirror editor. The textarea above is now a hidden
    // controlled mirror (kept for the test suite + AT + IME + the
    // selection-based insert helpers); PM is what the user actually sees
    // and edits. Both are downstream of `draft`.
    const pmRef = useRef<ProseMirrorComposerHandle | null>(null);
    const composingRef = useRef(false);
    const toolsMenuRef = useRef<HTMLDivElement | null>(null);
    const toolsTriggerRef = useRef<HTMLButtonElement | null>(null);
    const petEnabled = Boolean(onAdoptPet && onTogglePet);
    const linkedDirs = projectMetadata?.linkedDirs ?? [];
    // initialDraft is only honored on the first non-empty value the parent
    // hands us. After we seed once, the composer is fully under user control
    // — re-renders that pass the same prompt back must not reseed. If the
    // initial useState above already consumed a non-empty initialDraft we
    // mark it seeded immediately, so an early clear by the user (typing or
    // backspace before the parent stops passing initialDraft) does not get
    // overwritten by the effect.
    const seededRef = useRef(Boolean(initialDraft));

    useEffect(() => {
      if (seededRef.current) return;
      if (initialDraft && initialDraft !== draft) {
        setDraft(initialDraft);
        seededRef.current = true;
      } else if (initialDraft === undefined) {
        seededRef.current = true;
      }
    }, [initialDraft, draft]);

    useEffect(() => {
      if (!toolsOpen) return;
      function onPointer(e: MouseEvent) {
        const target = e.target as Node;
        if (toolsMenuRef.current?.contains(target)) return;
        if (toolsTriggerRef.current?.contains(target)) return;
        setToolsOpen(false);
      }
      function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') setToolsOpen(false);
      }
      document.addEventListener('mousedown', onPointer);
      document.addEventListener('keydown', onKey);
      return () => {
        document.removeEventListener('mousedown', onPointer);
        document.removeEventListener('keydown', onKey);
      };
    }, [toolsOpen]);

    // Lazy-fetch the user's external MCP servers list once on mount so the
    // `/mcp …` slash palette and the composer's MCP button popover have
    // something to render. We deliberately do not reactively re-fetch when
    // the user toggles servers from Settings — the dialog refreshes itself,
    // and the chat composer rehydrates next time the user re-opens it. A
    // background poll would be cheap but unnecessary for the typical
    // edit-once-then-chat workflow.
    useEffect(() => {
      let cancelled = false;
      void (async () => {
        const data = await fetchMcpServers();
        if (cancelled || !data) return;
        setMcpServers(data.servers);
        setMcpTemplates(data.templates);
      })();
      return () => {
        cancelled = true;
      };
    }, []);

    // Skills now come from the parent (App.tsx → ProjectView → ChatPane → ChatComposer)
    // pre-filtered by enabled/disabled state. We no longer fetch a fresh list
    // here to avoid showing skills the user has disabled via Settings.

    // Lazy-fetch installed plugins once on mount; the tools-menu Plugins
    // tab and the @-mention picker both consume this list.
    useEffect(() => {
      if (!projectId) return;
      let cancelled = false;
      void listPlugins().then((rows) => {
        if (cancelled) return;
        setInstalledPlugins(rows);
      });
      return () => {
        cancelled = true;
      };
    }, [projectId]);

    useEffect(() => {
      let cancelled = false;
      void fetchConnectors().then((rows) => {
        if (cancelled) return;
        setConnectors(rows.filter((connector) => connector.status === 'connected'));
      });
      return () => {
        cancelled = true;
      };
    }, []);

    // Composer-side plugin list: hide bundled atoms (pipeline-only). Keep
    // the full installed list available even when the project was created
    // from a pinned plugin, so users can switch or layer different plugin
    // context from the tools menu and @ picker.
    const pluginsForComposer = useMemo<InstalledPluginRecord[]>(() => {
      const allowedKinds = new Set(['skill', 'scenario', 'bundle']);
      return installedPlugins.filter((p) => {
        const k = p.manifest?.od?.kind;
        return !k || allowedKinds.has(k);
      });
    }, [installedPlugins]);

    const enabledMcpServers = useMemo(
      () => mcpServers.filter((s) => s.enabled),
      [mcpServers],
    );
    const composerMentionEntities = useMemo(
      () =>
        buildComposerMentionEntities({
          connectors,
          files: projectFiles,
          mcpServers: enabledMcpServers,
          plugins: pluginsForComposer,
          skills,
          staged,
        }),
      [connectors, enabledMcpServers, pluginsForComposer, projectFiles, skills, staged],
    );
    const composerMentionParts = useMemo(
      () => buildInlineMentionParts(draft, composerMentionEntities),
      [composerMentionEntities, draft],
    );
    // Literal `@<label>` tokens the PM editor should render as chips even
    // when they contain spaces (e.g. `@Slack MCP`). Derived from the same
    // entity set that powers the (legacy) overlay highlight.
    const knownMentionTokens = useMemo(
      () => composerMentionEntities.map((e) => e.token ?? `@${e.label}`),
      [composerMentionEntities],
    );

    function resizeTextarea() {
      const ta = textareaRef.current;
      if (!ta) return;
      const maxHeight = composerTextareaMaxHeight();
      ta.style.height = 'auto';
      const nextHeight = Math.min(
        Math.max(ta.scrollHeight, COMPOSER_TEXTAREA_MIN_HEIGHT),
        maxHeight,
      );
      ta.style.height = `${nextHeight}px`;
      ta.style.overflowY = ta.scrollHeight > maxHeight ? 'auto' : 'hidden';
    }

    useLayoutEffect(() => {
      resizeTextarea();
    }, [draft, composerMentionParts, staged.length, stagedSkills.length]);

    useEffect(() => {
      function onResize() {
        resizeTextarea();
      }
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, []);

    useEffect(() => {
      setComposerScrollTop(textareaRef.current?.scrollTop ?? 0);
    }, [composerMentionParts]);

    // Resolve which tabs to surface in the consolidated tools popover.
    // Plugins is always visible while a project is active so users can
    // apply context without leaving the composer. MCP shows when wired by
    // the parent (App); Import is always available. Pet controls stay out
    // of the project context picker so the @ panel remains project-scoped.
    const availableTabs = useMemo<ToolsTab[]>(() => {
      const tabs: ToolsTab[] = [];
      if (projectId) {
        tabs.push('plugins');
        tabs.push('skills');
      }
      if (onOpenMcpSettings) tabs.push('mcp');
      tabs.push('import');
      return tabs;
    }, [projectId, onOpenMcpSettings]);

    // When the popover opens, snap the active tab to the first available one
    // so the user never lands on an empty / hidden tab if their config
    // changes mid-session.
    useEffect(() => {
      if (!toolsOpen) return;
      if (!availableTabs.includes(toolsTab)) {
        const first = availableTabs[0];
        if (first) setToolsTab(first);
      }
    }, [toolsOpen, availableTabs, toolsTab]);

    // Catalog of supported slash commands. Each entry shows up in the
    // popover when the user types `/` in the composer. The `insert`
    // value is what we drop into the draft when the user picks the
    // entry — usually the canonical command form with a trailing space
    // ready for an argument.
    const slashCommands = useMemo<SlashCommand[]>(() => {
      const list: SlashCommand[] = [];
      // External MCP servers — `/mcp` opens settings, `/mcp <id>` inserts a
      // prompt-side hint nudging the model to use that server's tools. The
      // hint flows through to the agent verbatim; the daemon already wired
      // the MCP config into the agent's launch so the tools are callable.
      if (onOpenMcpSettings) {
        list.push({
          id: 'mcp',
          label: '/mcp',
          insert: '/mcp ',
          descKey: 'pet.slashPet',
          icon: 'sliders',
          argHint: 'open settings · <server-id> to insert hint',
        });
      }
      for (const s of enabledMcpServers) {
        list.push({
          id: `mcp-${s.id}`,
          label: `/mcp ${s.id}`,
          insert: `Use the \`${s.id}\` MCP server tools. `,
          descKey: 'pet.slashPet',
          icon: 'sparkles',
          argHint: s.label || s.transport,
        });
      }
      if (researchAvailable) {
        list.push({
          id: 'search',
          label: '/search',
          insert: '/search ',
          descKey: 'pet.slashSearch',
          icon: 'sparkles',
          argHint: t('pet.slashSearchArg'),
        });
      }
      if (petEnabled) {
        list.push(
          {
            id: 'pet',
            label: '/pet',
            insert: '/pet ',
            descKey: 'pet.slashPet',
            icon: 'sparkles',
            argHint: 'wake | tuck | <petId>',
          },
          {
            id: 'pet-wake',
            label: '/pet wake',
            insert: '/pet wake',
            descKey: 'pet.slashPetWake',
            icon: 'eye',
          },
          {
            id: 'pet-tuck',
            label: '/pet tuck',
            insert: '/pet tuck',
            descKey: 'pet.slashPetTuck',
            icon: 'eye',
          },
          {
            id: 'hatch',
            label: '/hatch',
            insert: '/hatch ',
            descKey: 'pet.slashHatch',
            icon: 'sparkles',
            argHint: t('pet.slashHatchArg'),
          },
        );
      }
      return list;
    }, [petEnabled, researchAvailable, t, enabledMcpServers, onOpenMcpSettings]);

    const filteredSlash = useMemo(() => {
      if (!slash) return [] as SlashCommand[];
      const q = slash.q.toLowerCase();
      if (!q) return slashCommands;
      return slashCommands.filter((c) => c.label.toLowerCase().includes(q));
    }, [slash, slashCommands]);

    function pickSlash(cmd: SlashCommand) {
      const ta = textareaRef.current;
      if (!ta || !slash) return;
      const before = draft.slice(0, slash.cursor);
      const after = draft.slice(slash.cursor);
      // Replace the in-flight `/<query>` token with the picked
      // command's canonical insertion text.
      const replaced = before.replace(/\/[^\s/]*$/, cmd.insert);
      const next = replaced + after;
      setDraft(next);
      setSlash(null);
      requestAnimationFrame(() => {
        ta.focus();
        const pos = replaced.length;
        ta.setSelectionRange(pos, pos);
      });
    }

    // Expand a `/hatch <concept>` draft into the canonical hatch-pet
    // skill prompt before sending. Returns null when the draft is not a
    // hatch command so the caller can fall through to the regular
    // submit path.
    function expandHatchCommand(input: string): string | null {
      const m = /^\/hatch(?:\s+([\s\S]*))?$/i.exec(input.trim());
      if (!m) return null;
      const concept = m[1]?.trim() ?? '';
      const intro = concept
        ? `Hatch a Codex-compatible animated pet for me. Concept: ${concept}.`
        : 'Hatch a Codex-compatible animated pet for me.';
      return [
        intro,
        '',
        'Use the @hatch-pet skill end-to-end:',
        '1. Generate the base look with $imagegen.',
        '2. Generate every row strip (idle, running-right, waving, jumping, failed, waiting, running, review).',
        '3. Mirror running-left from running-right only when the design is symmetric.',
        '4. Run the deterministic scripts (extract / compose / validate / contact-sheet / videos).',
        '5. Package the result into ${CODEX_HOME:-$HOME/.codex}/pets/<pet-name>/ with pet.json + spritesheet.webp.',
        '',
        'When the spritesheet is saved, tell me the absolute path and the pet folder name. I will adopt it from Settings → Pets → Recently hatched.',
      ].join('\n');
    }

    // `/mcp` (no arg) opens settings on the External MCP tab — pure UX hook,
    // never sent to the agent. `/mcp <id>` is intentionally NOT intercepted
    // here: the slash palette already replaces it with a natural-language
    // hint sentence ("Use the `<id>` MCP server tools."), and the user is
    // expected to keep typing the rest of the prompt before sending.
    function tryHandleMcpSlash(): boolean {
      if (!onOpenMcpSettings) return false;
      const trimmed = draft.trim();
      if (!/^\/mcp\s*$/i.test(trimmed)) return false;
      onOpenMcpSettings();
      setDraft('');
      return true;
    }

    function expandSearchCommand(input: string): { prompt: string; query: string } | null {
      const m = /^\/search(?:\s+([\s\S]*))?$/i.exec(input.trim());
      if (!m) return null;
      const query = m[1]?.trim() ?? '';
      if (!query) return null;
      return {
        query,
        prompt: [
          `Search for: ${query}`,
          '',
          'Before answering, your first tool action must be the OD research command for your shell.',
          'POSIX: "$OD_NODE_BIN" "$OD_BIN" research search --query "<search query>" --max-sources 5',
          'PowerShell: & $env:OD_NODE_BIN $env:OD_BIN research search --query "<search query>" --max-sources 5',
          'cmd.exe: "%OD_NODE_BIN%" "%OD_BIN%" research search --query "<search query>" --max-sources 5',
          'Use the canonical query below as the exact search query, with safe quoting for your shell.',
          '',
          'Canonical query:',
          '',
          '```text',
          query.replace(/```/g, '`\u200b`\u200b`'),
          '```',
          'If the OD command fails because Tavily is not configured or unavailable, report that error, then use your own search capability as fallback and label the fallback clearly.',
          'After the command returns JSON or fallback search results, write a reusable Markdown report into Design Files at `research/<safe-query-slug>.md` or another fresh project-relative path.',
          'The report must include the query, fetched time, short summary, key findings, source list with [1], [2] citations, and a note that source content is external untrusted evidence.',
          'Then summarize the findings with citations by source index and mention the Markdown report path.',
        ].join('\n'),
      };
    }

    // Parse a `/pet [arg]` slash command out of the draft. Recognized
    // forms: `/pet` (toggle wake/tuck), `/pet wake`, `/pet tuck`,
    // `/pet adopt` (open settings), or `/pet <id>` to adopt a built-in
    // by id. The slash is stripped from the draft on a successful match
    // so the user does not accidentally send the command to the agent.
    function tryHandlePetSlash(): boolean {
      if (!petEnabled) return false;
      const trimmed = draft.trim();
      const match = /^\/pet(?:\s+(\S+))?$/i.exec(trimmed);
      if (!match) return false;
      const arg = match[1]?.toLowerCase();
      if (!arg || arg === 'toggle') {
        onTogglePet?.();
      } else if (arg === 'wake' || arg === 'show') {
        if (petConfig?.adopted) {
          if (!petConfig.enabled) onTogglePet?.();
        } else {
          onOpenPetSettings?.();
        }
      } else if (arg === 'tuck' || arg === 'hide') {
        if (petConfig?.enabled) onTogglePet?.();
      } else if (arg === 'adopt' || arg === 'settings' || arg === 'change') {
        onOpenPetSettings?.();
      } else if (arg === CUSTOM_PET_ID) {
        onAdoptPet?.(CUSTOM_PET_ID);
      } else {
        const pet = BUILT_IN_PETS.find((p) => p.id === arg);
        if (pet) {
          onAdoptPet?.(pet.id);
        } else {
          return false;
        }
      }
      setDraft('');
      return true;
    }

    useImperativeHandle(
      ref,
      () => ({
        setDraft: (text: string) => {
          setDraft(text);
          seededRef.current = true;
          requestAnimationFrame(() => {
            const ta = textareaRef.current;
            if (!ta) return;
            ta.focus();
            const pos = text.length;
            ta.setSelectionRange(pos, pos);
          });
        },
        focus: () => {
          textareaRef.current?.focus();
        },
      }),
      []
    );

    function reset() {
      setDraft("");
      setStaged([]);
      setStagedVisualComments([]);
      setStagedSkills([]);
      setStagedMcpServers([]);
      setStagedConnectors([]);
      setUploadError(null);
      setMention(null);
      setSlash(null);
    }

    function currentCommentAttachments(extra: ChatCommentAttachment[] = []): ChatCommentAttachment[] {
      return [...commentAttachments, ...stagedVisualComments, ...extra];
    }

    function setStreamingAnnotationSendPending(value: boolean) {
      streamingAnnotationSendPendingRef.current = value;
      setStreamingAnnotationSendPendingState(value);
    }

    function currentRunContextMeta(): ChatSendMeta | undefined {
      const skillIds = stagedSkills.map((s) => s.id);
      const mcpServerIds = stagedMcpServers.map((s) => s.id);
      const connectorIds = stagedConnectors.map((c) => c.id);
      const context: RunContextSelection = {
        ...(skillIds.length > 0 ? { skillIds } : {}),
        ...(mcpServerIds.length > 0 ? { mcpServerIds } : {}),
        ...(connectorIds.length > 0 ? { connectorIds } : {}),
      };
      const meta: ChatSendMeta = {
        ...(skillIds.length > 0 ? { skillIds } : {}),
        ...(Object.keys(context).length > 0 ? { context } : {}),
      };
      return Object.keys(meta).length > 0 ? meta : undefined;
    }

    function sendComposedTurn(
      prompt: string,
      attachments: ChatAttachment[],
      nextCommentAttachments: ChatCommentAttachment[],
      meta?: ChatSendMeta,
    ): boolean {
      setStreamingAnnotationSendPending(false);
      if (!prompt && attachments.length === 0 && nextCommentAttachments.length === 0) return false;
      onSend(prompt, attachments, nextCommentAttachments, meta);
      reset();
      return true;
    }

    // Picking a skill / plugin / MCP / connector adds ONLY a staged chip
    // (StagedSkills row / context state); it no longer injects an `@token`
    // into the prompt body. The chip is the single visible anchor + remove
    // affordance, and the backend identifies the selection via the
    // dedicated context fields (skillIds / mcpServerIds / …), not the
    // prompt text. We still strip the in-flight `@query` the user typed to
    // open the picker (empty replacement) so no stray `@de` is left.
    async function insertSkillMention(skill: SkillSummary) {
      const applied = await applyProjectSkill(skill);
      if (!applied) return;
      replaceMentionWithText('');
    }

    function removeStagedSkill(id: string) {
      setStagedSkills((prev) => prev.filter((s) => s.id !== id));
      // Also strip the matching `@<id>` token from the draft so the chip
      // and the textarea stay in sync. We allow trailing whitespace to be
      // collapsed too.
      setDraft((d) =>
        d
          .replace(new RegExp(`(^|\\s)@${escapeRegExp(id)}(\\s|$)`, 'g'), '$1$2')
          .replace(/\s{2,}/g, ' '),
      );
    }

    async function ensureProject(): Promise<string | null> {
      if (projectId) return projectId;
      return onEnsureProject();
    }

    async function uploadFiles(files: File[]) {
      if (files.length === 0) return;
      const id = await ensureProject();
      if (!id) return;
      setUploading(true);
      setUploadError(null);
      try {
        const result = await uploadProjectFiles(id, files);
        if (result.uploaded.length > 0) {
          setStaged((s) => [...s, ...result.uploaded]);
        }
        if (result.failed.length > 0) {
          const failedCount = result.failed.length;
          const uploadedCount = result.uploaded.length;
          const detail = result.error ? ` (${result.error})` : '';
          setUploadError(
            uploadedCount > 0
              ? `Attached ${uploadedCount} file(s), but ${failedCount} failed${detail}.`
              : `Attachment upload failed for ${failedCount} file(s)${detail}.`,
          );
          console.warn('Some attachments failed to upload', result.failed);
        }
      } finally {
        setUploading(false);
      }
    }

    useEffect(() => {
      function onAnnotation(e: Event) {
        const detail = (e as CustomEvent<AnnotationEventDetail>).detail;
        if (!detail) return;
        void (async () => {
          let uploaded: ChatAttachment[] = [];
          let visualAttachmentInput: Parameters<typeof buildVisualAnnotationAttachment>[0] | null = null;
          let visualAttachment: ChatCommentAttachment | null = null;
          if (detail.file) {
            const id = await ensureProject();
            if (!id) return;
            setUploading(true);
            try {
              const result = await uploadProjectFiles(id, [detail.file]);
              if (result.uploaded.length > 0) {
                uploaded = result.uploaded;
                if (detail.action !== 'send') {
                  setStaged((s) => [...s, ...uploaded]);
                }
                const screenshot = uploaded[0];
                if (screenshot && detail.markKind && detail.bounds) {
                  visualAttachmentInput = {
                    order: 1,
                    idSeed: screenshot.path,
                    screenshotPath: screenshot.path,
                    markKind: detail.markKind,
                    note: detail.note,
                    bounds: detail.bounds,
                    target: detail.target
                      ? {
                          filePath: detail.target.filePath || detail.filePath || screenshot.path,
                          elementId: detail.target.elementId,
                          selector: detail.target.selector,
                          label: detail.target.label,
                          text: detail.target.text,
                          position: detail.target.position,
                          htmlHint: detail.target.htmlHint,
                        }
                      : {
                          filePath: detail.filePath || screenshot.path,
                          position: detail.bounds,
                        },
                  };
                  if (detail.action !== 'send') {
                    setStagedVisualComments((current) => [
                      ...current,
                      buildVisualAnnotationAttachment({
                        ...visualAttachmentInput!,
                        order: commentAttachments.length + current.length + 1,
                      }),
                    ]);
                  }
                }
              }
              if (result.failed.length > 0) {
                const detailText = result.error ? ` (${result.error})` : '';
                setUploadError(`Attachment upload failed for ${result.failed.length} file(s)${detailText}.`);
              }
            } finally {
              setUploading(false);
            }
          }

          if (detail.action === 'send') {
            if (streaming) {
              if (uploaded.length > 0) setStaged((s) => [...s, ...uploaded]);
              if (visualAttachmentInput) {
                setStagedVisualComments((current) => [
                  ...current,
                  buildVisualAnnotationAttachment({
                    ...visualAttachmentInput!,
                    order: commentAttachments.length + current.length + 1,
                  }),
                ]);
              }
              if (detail.note) setDraft((d) => (d ? `${d}\n${detail.note}` : detail.note));
              setStreamingAnnotationSendPending(true);
              textareaRef.current?.focus();
              return;
            }
            if (visualAttachmentInput) {
              visualAttachment = buildVisualAnnotationAttachment({
                ...visualAttachmentInput,
                order: commentAttachments.length + stagedVisualComments.length + 1,
              });
            }
            const prompt = [draft.trim(), detail.note].filter(Boolean).join('\n');
            const attachments = [...staged, ...uploaded];
            const nextCommentAttachments = currentCommentAttachments(visualAttachment ? [visualAttachment] : []);
            sendComposedTurn(prompt, attachments, nextCommentAttachments, currentRunContextMeta());
            return;
          }

          if (detail.note) {
            setDraft((d) => (d ? `${d}\n${detail.note}` : detail.note));
            textareaRef.current?.focus();
          }
        })();
      }
      window.addEventListener(ANNOTATION_EVENT, onAnnotation);
      return () => window.removeEventListener(ANNOTATION_EVENT, onAnnotation);
    }, [
      commentAttachments,
      draft,
      onSend,
      projectId,
      staged,
      stagedConnectors,
      stagedMcpServers,
      stagedSkills,
      stagedVisualComments,
      streaming,
    ]);

    useEffect(() => {
      if (!streamingAnnotationSendPending || !streamingAnnotationSendPendingRef.current) return;
      if (streaming || sendDisabled) return;
      const prompt = draft.trim();
      sendComposedTurn(prompt, staged, currentCommentAttachments(), currentRunContextMeta());
    }, [
      commentAttachments,
      draft,
      onSend,
      sendDisabled,
      staged,
      stagedConnectors,
      stagedMcpServers,
      stagedSkills,
      stagedVisualComments,
      streaming,
      streamingAnnotationSendPending,
    ]);

    function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        void uploadFiles(files);
      }
    }

    function handleDrop(e: React.DragEvent<HTMLDivElement>) {
      e.preventDefault();
      setDragActive(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length > 0) void uploadFiles(files);
    }

    async function handleLinkFolder() {
      if (!projectId) return;
      const selected = await openFolderDialog();
      if (!selected) return;
      const base = projectMetadata ?? { kind: 'prototype' as const };
      const existing = base.linkedDirs ?? [];
      if (existing.includes(selected)) return;
      const metadata: ProjectMetadata = { ...base, linkedDirs: [...existing, selected] };
      const result = await patchProject(projectId, { metadata });
      if (result?.metadata) onProjectMetadataChange?.(result.metadata);
    }

    async function handleUnlinkFolder(dir: string) {
      if (!projectId) return;
      const base = projectMetadata ?? { kind: 'prototype' as const };
      const existing = base.linkedDirs ?? [];
      const metadata: ProjectMetadata = { ...base, linkedDirs: existing.filter((d) => d !== dir) };
      const result = await patchProject(projectId, { metadata });
      if (result?.metadata) onProjectMetadataChange?.(result.metadata);
    }

    function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
      const value = e.target.value;
      const cursor = e.target.selectionStart;
      setDraft(value);
      // NOTE: we used to prune staged-skill chips whenever the draft no
      // longer contained their `@<id>` token. That coupling is gone now
      // that picking a skill adds ONLY a chip (no `@token` in the body) —
      // the token-presence check would delete every freshly-staged skill on
      // the next keystroke. The chip is now removed solely via its own ×
      // button (removeStagedSkill), and submit() reads stagedSkills
      // directly, so it stays in sync without mirroring the prompt text.
      // Detect a fresh @ at start or after whitespace; capture the typed
      // query up to the cursor.
      const before = value.slice(0, cursor);
      const m = /(^|\s)@([^\s@]*)$/.exec(before);
      if (m) setMention({ q: m[2] ?? "", cursor });
      else setMention(null);
      // Slash-command popover — open as soon as the draft starts with
      // `/` (and the cursor is still inside the bare command token, no
      // space yet). Closes once the user commits a space or moves past
      // the prefix.
      const slashMatch = /^\/([^\s/]*)$/.exec(before);
      if (slashMatch) {
        setSlash({ q: slashMatch[1] ?? '', cursor });
        setSlashIndex(0);
      } else {
        setSlash(null);
      }
    }

    function insertMention(filePath: string) {
      if (!mention) return;
      const ta = textareaRef.current;
      if (!ta) return;
      const cursor = mention.cursor;
      const before = draft.slice(0, cursor);
      const after = draft.slice(cursor);
      const replaced = before.replace(/@([^\s@]*)$/, `@${filePath} `);
      const next = replaced + after;
      setDraft(next);
      setMention(null);
      if (!staged.some((s) => s.path === filePath)) {
        setStaged((s) => [
          ...s,
          {
            path: filePath,
            name: filePath.split("/").pop() || filePath,
            kind: looksLikeImage(filePath) ? "image" : "file",
          },
        ]);
      }
      requestAnimationFrame(() => {
        ta.focus();
        const pos = replaced.length;
        ta.setSelectionRange(pos, pos);
      });
    }

    async function insertPluginMention(record: InstalledPluginRecord) {
      const cleared = replaceMentionWithText('');
      if (!cleared) return;
      await pluginsSectionRef.current?.applyById(record.id, record);
    }

    function replaceMentionWithText(text: string): boolean {
      if (!mention) return false;
      const ta = textareaRef.current;
      const cursor = mention.cursor;
      const before = draft.slice(0, cursor);
      const after = draft.slice(cursor);
      const replaced = before.replace(/(^|\s)@([^\s@]*)$/, `$1${text}`);
      const next = replaced + after;
      setDraft(next);
      setMention(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        const pos = replaced.length;
        ta.setSelectionRange(pos, pos);
      });
      return true;
    }

    function insertMcpMention(server: McpServerConfig) {
      setStagedMcpServers((current) => (
        current.some((item) => item.id === server.id) ? current : [...current, server]
      ));
      replaceMentionWithText('');
    }

    function insertConnectorMention(connector: ConnectorDetail) {
      setStagedConnectors((current) => (
        current.some((item) => item.id === connector.id) ? current : [...current, connector]
      ));
      replaceMentionWithText('');
    }

    async function applyProjectSkill(skill: SkillSummary): Promise<boolean> {
      if (!projectId) return false;
      const result = await patchProject(projectId, { skillId: skill.id });
      if (!result) return false;
      onProjectSkillChange?.(result.skillId ?? skill.id);
      return true;
    }

    function removeStaged(p: string) {
      setStaged((s) => s.filter((a) => a.path !== p));
      setStagedVisualComments((current) => current.filter((attachment) => attachment.screenshotPath !== p));
    }

    function removeCommentAttachment(id: string) {
      setStagedVisualComments((current) => current.filter((attachment) => attachment.id !== id));
      if (!stagedVisualComments.some((attachment) => attachment.id === id)) {
        onRemoveCommentAttachment?.(id);
      }
    }

    async function submit() {
      const prompt = draft.trim();
      if (sendDisabled) return;
      // Intercept `/pet …` and `/mcp` before sending so the slash command
      // never hits the agent — these are local UX hooks, not model prompts.
      if (tryHandlePetSlash()) return;
      if (tryHandleMcpSlash()) return;
      // `/hatch <concept>` expands into the canonical hatch-pet skill
      // prompt and *is* sent to the agent — the agent runs the skill,
      // packages a Codex pet under `~/.codex/pets/`, and the user
      // adopts it from "Recently hatched" in pet settings afterwards.
      const contextMeta = currentRunContextMeta();
      const hatched = expandHatchCommand(prompt);
      const nextCommentAttachments = currentCommentAttachments();
      if (hatched) {
        if (streaming) return;
        setStreamingAnnotationSendPending(false);
        onSend(hatched, staged, nextCommentAttachments, contextMeta);
        reset();
        return;
      }
      const search = researchAvailable ? expandSearchCommand(prompt) : null;
      if (search) {
        if (streaming) return;
        setStreamingAnnotationSendPending(false);
        onSend(search.prompt, staged, nextCommentAttachments, {
          ...contextMeta,
          research: { enabled: true, query: search.query },
        });
        reset();
        return;
      }
      if ((!prompt && staged.length === 0 && nextCommentAttachments.length === 0) || streaming) return;
      sendComposedTurn(prompt, staged, nextCommentAttachments, contextMeta);
    }

    // The @-picker offers a unified search across context surfaces:
    // project files, plugins, active MCP servers, and skills. Picked
    // entities keep an inline @ token for orientation while richer
    // context is still applied behind the scenes when available.
    const mentionQuery = mention ? mention.q.toLowerCase() : '';
    const filteredFiles = mention
      ? projectFiles
          .filter((f) => f.type === undefined || f.type === "file")
          .filter((f) => {
            const key = f.path ?? f.name;
            return key.toLowerCase().includes(mentionQuery);
          })
          .slice(0, 12)
      : [];
    const filteredPlugins = mention
      ? pluginsForComposer
          .filter((p) => {
            if (!mentionQuery) return true;
            return (
              p.title.toLowerCase().includes(mentionQuery) ||
              p.id.toLowerCase().includes(mentionQuery) ||
              (p.manifest?.description ?? '').toLowerCase().includes(mentionQuery) ||
              (p.manifest?.tags ?? []).join(' ').toLowerCase().includes(mentionQuery)
            );
          })
          .slice(0, 8)
      : [];
    const filteredMcpServers = mention
      ? enabledMcpServers
          .filter((s) => {
            if (!mentionQuery) return true;
            return [
              s.id,
              s.label ?? '',
              s.transport,
              s.url ?? '',
              s.command ?? '',
            ]
              .join(' ')
              .toLowerCase()
              .includes(mentionQuery);
          })
          .slice(0, 8)
      : [];
    const filteredConnectors = mention
      ? connectors
          .filter((connector) => {
            if (!mentionQuery) return true;
            return [
              connector.id,
              connector.name,
              connector.provider,
              connector.category,
              connector.description ?? '',
              connector.accountLabel ?? '',
            ]
              .join(' ')
              .toLowerCase()
              .includes(mentionQuery);
          })
          .slice(0, 8)
      : [];
    // Already-staged skills drop out of the suggestion list (carried over
    // from main) so the @-popover keeps moving forward as the user picks.
    const stagedSkillIds = new Set(stagedSkills.map((s) => s.id));
    const filteredSkills = mention
      ? skills
          .filter((s) => !stagedSkillIds.has(s.id))
          .filter((s) => skillMatchesQuery(s, mentionQuery))
          .sort((a, b) => skillMentionRank(a, mentionQuery) - skillMentionRank(b, mentionQuery))
      : [];

    // --- ProseMirror suggestion adapters --------------------------------
    // Drive the in-editor `@`/`/` popover (keystrokes that originate
    // inside the PM editor — real users). The legacy MentionPopover /
    // SlashPopover stay wired to the hidden mirror textarea so the test
    // suite is unaffected. Items carry a `value` (the literal text to
    // insert) and an `id` namespaced by source so `handlePmPickItem` can
    // replay the same side effects the textarea-path insert helpers do.
    const slashAdapter = useMemo<SuggestionAdapter>(
      () => ({
        search: (query: string): SuggestionItem[] => {
          const q = query.toLowerCase();
          return slashCommands
            .filter((c) => !q || c.label.toLowerCase().includes(q))
            .map((c) => ({
              id: `slash:${c.id}`,
              // Insert the canonical command form as a single slash atom.
              // We strip a trailing space (the chip + insertSuggestion's
              // own trailing space replaces it) and keep the leading `/`.
              value: c.insert.trimEnd(),
              label: c.label,
              description: t(c.descKey),
            }));
        },
      }),
      [slashCommands, t],
    );
    const mentionAdapter = useMemo<SuggestionAdapter>(
      () => ({
        search: (query: string): SuggestionItem[] => {
          const q = query.toLowerCase();
          const out: SuggestionItem[] = [];
          for (const p of pluginsForComposer) {
            if (q && !pluginMatchesQuery(p, q)) continue;
            out.push({ id: `plugin:${p.id}`, value: inlineMentionToken(p.title), label: p.title, description: p.manifest?.description ?? p.id });
          }
          for (const s of skills) {
            if (stagedSkillIds.has(s.id)) continue;
            if (q && !skillMatchesQuery(s, q)) continue;
            out.push({ id: `skill:${s.id}`, value: inlineMentionToken(s.name), label: s.name, description: s.description || s.id });
          }
          for (const s of enabledMcpServers) {
            const label = s.label || s.id;
            if (q && !mcpServerMatchesQuery(s, q)) continue;
            out.push({ id: `mcp:${s.id}`, value: inlineMentionToken(label), label, description: s.transport });
          }
          for (const c of connectors) {
            if (q && ![c.id, c.name, c.provider, c.category].join(' ').toLowerCase().includes(q)) continue;
            out.push({ id: `connector:${c.id}`, value: inlineMentionToken(c.name), label: c.name, description: c.description || c.provider });
          }
          for (const f of projectFiles) {
            if (f.type !== undefined && f.type !== 'file') continue;
            const key = f.path ?? f.name;
            if (q && !key.toLowerCase().includes(q)) continue;
            out.push({ id: `file:${key}`, value: inlineMentionToken(key), label: key });
            if (out.length > 40) break;
          }
          return out;
        },
      }),
      [pluginsForComposer, skills, stagedSkillIds, enabledMcpServers, connectors, projectFiles],
    );
    // Replay the textarea-path side effects when the user picks an item
    // inside the PM editor (text insertion already done by the editor).
    function handlePmPickItem(item: SuggestionItem) {
      const [source, ...rest] = item.id.split(':');
      const id = rest.join(':');
      if (source === 'plugin') {
        const record = installedPlugins.find((p) => p.id === id);
        if (record) void pluginsSectionRef.current?.applyById(record.id, record);
      } else if (source === 'skill') {
        const skill = skills.find((s) => s.id === id);
        if (skill) void applyProjectSkill(skill);
      } else if (source === 'mcp') {
        const server = enabledMcpServers.find((s) => s.id === id);
        if (server) setStagedMcpServers((cur) => (cur.some((x) => x.id === server.id) ? cur : [...cur, server]));
      } else if (source === 'connector') {
        const connector = connectors.find((c) => c.id === id);
        if (connector) setStagedConnectors((cur) => (cur.some((x) => x.id === connector.id) ? cur : [...cur, connector]));
      } else if (source === 'file') {
        if (!staged.some((s) => s.path === id)) {
          setStaged((s) => [...s, { path: id, name: id.split('/').pop() || id, kind: looksLikeImage(id) ? 'image' : 'file' }]);
        }
      }
    }

    return (
      <div
        className={`composer${dragActive ? " drag-active" : ""}`}
        data-testid="chat-composer"
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
      >
        <div className="composer-shell">
          {stagedSkills.length > 0 ? (
            <StagedSkills
              skills={stagedSkills}
              onRemove={removeStagedSkill}
              t={t}
            />
          ) : null}
          {stagedMcpServers.length > 0 ? (
            <StagedContextChips
              kind="mcp"
              items={stagedMcpServers.map((s) => ({ id: s.id, label: s.label || s.id }))}
              onRemove={(id) => setStagedMcpServers((prev) => prev.filter((s) => s.id !== id))}
              t={t}
            />
          ) : null}
          {stagedConnectors.length > 0 ? (
            <StagedContextChips
              kind="connector"
              items={stagedConnectors.map((c) => ({ id: c.id, label: c.name }))}
              onRemove={(id) => setStagedConnectors((prev) => prev.filter((c) => c.id !== id))}
              t={t}
            />
          ) : null}
          {staged.length > 0 ? (
            <StagedAttachments
              attachments={staged}
              projectId={projectId}
              onRemove={removeStaged}
              t={t}
            />
          ) : null}
          {linkedDirs.length > 0 ? (
            <div className="linked-dirs-row" data-testid="linked-dirs">
              {linkedDirs.map((dir) => (
                <div key={dir} className="linked-dir-chip">
                  <Icon name="folder" size={13} />
                  <span className="linked-dir-name" title={dir}>
                    {dir.split('/').pop() || dir}
                  </span>
                  <button
                    className="staged-remove"
                    onClick={() => handleUnlinkFolder(dir)}
                    title={t('chat.linkedFolderRemoveAria', { path: dir })}
                    aria-label={t('chat.linkedFolderRemoveAria', { path: dir })}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {currentCommentAttachments().length > 0 ? (
            <StagedCommentAttachments
              attachments={currentCommentAttachments()}
              onRemove={removeCommentAttachment}
              t={t}
            />
          ) : null}
          {byokApiProtocol === 'senseaudio' && onChangeByokImageModel ? (
            <div
              className="composer-byok-image-model"
              data-testid="composer-byok-image-model"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 8px',
                fontSize: 12,
                color: 'var(--text-muted, #888)',
              }}
            >
              <Icon name="image" size={13} />
              <label
                htmlFor="composer-byok-image-model-select"
                style={{ flexShrink: 0 }}
              >
                {t('settings.byokImageModel')}
              </label>
              <select
                id="composer-byok-image-model-select"
                value={byokImageModel ?? ''}
                onChange={(e) => onChangeByokImageModel(e.target.value)}
                style={{
                  background: 'transparent',
                  border: '1px solid var(--od-border, #444)',
                  borderRadius: 4,
                  padding: '2px 6px',
                  color: 'inherit',
                  fontSize: 12,
                }}
              >
                <option value="">
                  {(IMAGE_MODELS.find((m) => m.provider === 'senseaudio')?.label
                    ?? 'senseaudio-image-2.0') + ' (default)'}
                </option>
                {IMAGE_MODELS.filter((m) => m.provider === 'senseaudio').map(
                  (m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ),
                )}
              </select>
            </div>
          ) : null}
          {/*
            Spec §8.4 — context bar above the composer input. The
            section now behaves as a pure context bar: it renders the
            active plugin's chips + inputs form when one is applied,
            but never the always-on rail. Plugins are picked from the
            tools-menu Plugins tab or the @-mention popover so the
            composer chrome stays out of the way until the user wants
            to attach context.
          */}
          {projectId ? (
            <PluginsSection
              ref={pluginsSectionRef}
              projectId={projectId}
              showRail={false}
              onApplied={(brief) => {
                // Use functional setState so stale closures from the @-mention
                // flow (which awaits applyById after setDraft) still see the
                // latest draft value before deciding whether to seed.
                if (typeof brief === 'string' && brief.length > 0) {
                  setDraft((cur) => (cur.trim().length === 0 ? brief : cur));
                }
              }}
              onChipDetails={(item: ContextItem) => {
                if (item.kind !== 'plugin') return;
                const record = installedPlugins.find((p) => p.id === item.id);
                if (record) setDetailsRecord(record);
              }}
            />
          ) : null}
          <div
            className={`composer-input-wrap${
              composerMentionParts ? ' has-mention-overlay' : ''
            }`}
          >
            <div className="composer-textarea-layer">
              {/*
                The visible editor is now ProseMirror (chips are real atom
                nodes, no drifting overlay). The <textarea> below is kept
                as a hidden, controlled mirror of `draft` so:
                  - the test suite drives it (`fireEvent.change` + `.value`),
                  - AT / IME / the selection-based insert helpers
                    (insertMention etc.) keep a real form control, and
                  - paste-of-files + slash/mention popover keyboard nav
                    keep their existing wiring.
                PM edits write `draft` via onChange; `draft` flows back into
                both surfaces, so they never diverge.
              */}
              <ProseMirrorComposerInput
                ref={pmRef}
                value={draft}
                placeholder={t('chat.composerPlaceholder')}
                slashAdapter={slashAdapter}
                mentionAdapter={mentionAdapter}
                knownMentionTokens={knownMentionTokens}
                onChange={(text) => setDraft(text)}
                onSubmit={() => void submit()}
                onPickItem={handlePmPickItem}
                onPasteFiles={(files) => void uploadFiles(files)}
              />
              {/*
                Hidden semantic mirror of the parsed mention parts. The PM
                editor now renders chips visually; this node carries the
                same `@token` text for AT + the existing test assertions
                that read `chat-composer-mention-overlay`.textContent. It is
                visually clipped (pm-composer-mirror) — not a visible layer.
              */}
              {composerMentionParts ? (
                <div
                  className="pm-composer-mirror--hidden"
                  data-testid="chat-composer-mention-overlay"
                  aria-hidden="true"
                >
                  <div className="composer-input-overlay-inner">
                    {composerMentionParts.map((part, index) =>
                      part.kind === 'mention' ? (
                        <span
                          key={`${part.entity.kind}-${part.entity.id}-${index}`}
                          className={`composer-inline-mention composer-inline-mention--${part.entity.kind}`}
                          title={part.entity.title ?? part.text}
                        >
                          {part.text}
                        </span>
                      ) : (
                        <span key={`text-${index}`}>{part.text}</span>
                      ),
                    )}
                  </div>
                </div>
              ) : null}
              <textarea
                ref={textareaRef}
                data-testid="chat-composer-input"
                // ph-no-capture: prompt content is the most sensitive
                // surface in the product. PostHog autocapture skips this
                // element + subtree entirely.
                // pm-composer-mirror: visually hidden (clipped) but still a
                // real, focusable, controlled textarea — NOT the visible
                // editor. See the comment above; PM is what the user sees.
                className="ph-no-capture pm-composer-mirror"
                aria-hidden="true"
                tabIndex={-1}
                value={draft}
                // No placeholder: this textarea is the hidden mirror; the
                // visible PM editor renders the placeholder. A placeholder
                // here leaked over the PM text when a high-specificity rule
                // re-expanded the textarea.
                spellCheck={false}
                onChange={handleChange}
                onPaste={handlePaste}
                onScroll={(event) => {
                  setComposerScrollTop(event.currentTarget.scrollTop);
                }}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                onKeyDown={(e) => {
                  if (isImeComposing(e, composingRef.current)) return;
                  if (slash && filteredSlash.length > 0) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setSlashIndex((i) => (i + 1) % filteredSlash.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setSlashIndex(
                        (i) => (i - 1 + filteredSlash.length) % filteredSlash.length,
                      );
                      return;
                    }
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
                      e.preventDefault();
                      const safe = Math.min(slashIndex, filteredSlash.length - 1);
                      pickSlash(filteredSlash[safe]!);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setSlash(null);
                      return;
                    }
                  }
                  if (mention && e.key === "Escape") {
                    setMention(null);
                    return;
                  }
                  if (
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    !e.altKey &&
                    (e.metaKey || e.ctrlKey || !mention)
                  ) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            </div>
            {mention ? (
              <MentionPopover
                files={filteredFiles}
                plugins={filteredPlugins}
                skills={filteredSkills}
                mcpServers={filteredMcpServers}
                connectors={filteredConnectors}
                query={mention.q}
                currentSkillId={currentSkillId}
                onPickFile={insertMention}
                onPickPlugin={(record) => void insertPluginMention(record)}
                onPickSkill={(skill) => void insertSkillMention(skill)}
                onPickMcp={insertMcpMention}
                onPickConnector={insertConnectorMention}
              />
            ) : null}
            {slash && filteredSlash.length > 0 ? (
              <SlashPopover
                commands={filteredSlash}
                activeIndex={Math.min(slashIndex, filteredSlash.length - 1)}
                onPick={pickSlash}
                onHover={(i) => setSlashIndex(i)}
                t={t}
              />
            ) : null}
          </div>
          <div className="composer-row">
            <input
              ref={fileInputRef}
              data-testid="chat-file-input"
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                void uploadFiles(files);
                e.target.value = '';
              }}
            />
            <div className="composer-tools-wrap">
              <button
                ref={toolsTriggerRef}
                type="button"
                className={`icon-btn composer-tools-trigger${toolsOpen ? ' active' : ''}`}
                onClick={() => {
                  setToolsOpen((v) => {
                    const next = !v;
                    if (next) {
                      // P0 ui_click resources_popover_trigger — only emit on
                      // the open transition so accidental double-clicks
                      // don't pair an open + close into a "double tap" the
                      // dashboard can't interpret.
                      trackChatPanelClick(analytics.track, {
                        page_name: 'chat_panel',
                        area: 'chat_panel',
                        element: 'resources_popover_trigger',
                      });
                    }
                    return next;
                  });
                }}
                title={t('chat.cliSettingsTitle')}
                aria-haspopup="menu"
                aria-expanded={toolsOpen}
                aria-label={t('chat.cliSettingsAria')}
              >
                <span className="composer-tools-at" aria-hidden>
                  @
                </span>
              </button>
              {toolsOpen ? (
                <div
                  ref={toolsMenuRef}
                  className="composer-tools-menu"
                  role="menu"
                >
                  <div className="composer-tools-tabs" role="tablist">
                    {availableTabs.map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={toolsTab === tab}
                        className={`composer-tools-tab${toolsTab === tab ? ' active' : ''}`}
                        onClick={() => setToolsTab(tab)}
                      >
                        {tab === 'plugins' ? (
                          <>
                            <Icon name="sparkles" size={12} />
                            <span>Plugins</span>
                          </>
                        ) : null}
                        {tab === 'skills' ? (
                          <>
                            <Icon name="file" size={12} />
                            <span>Skills</span>
                          </>
                        ) : null}
                        {tab === 'mcp' ? (
                          <>
                            <Icon name="link" size={12} />
                            <span>MCP</span>
                          </>
                        ) : null}
                        {tab === 'import' ? (
                          <>
                            <Icon name="import" size={12} />
                            <span>{t('chat.importLabel')}</span>
                          </>
                        ) : null}
                      </button>
                    ))}
                  </div>

                  <div className="composer-tools-content">
                    {toolsTab === 'plugins' ? (
                      <ToolsPluginsPanel
                        plugins={pluginsForComposer}
                        activePluginId={pinnedPluginId}
                        onApply={async (record) => {
                          const result = await pluginsSectionRef.current?.applyById(
                            record.id,
                            record,
                          );
                          if (result) setToolsOpen(false);
                        }}
                        onShowDetails={(record) => {
                          setDetailsRecord(record);
                          setToolsOpen(false);
                        }}
                      />
                    ) : null}
                    {toolsTab === 'skills' ? (
                      <ToolsSkillsPanel
                        skills={skills}
                        currentSkillId={currentSkillId}
                        onPick={async (skill) => {
                          const applied = await applyProjectSkill(skill);
                          if (applied) setToolsOpen(false);
                        }}
                      />
                    ) : null}
                    {toolsTab === 'mcp' && onOpenMcpSettings ? (
                      <ToolsMcpPanel
                        servers={enabledMcpServers}
                        templates={mcpTemplates}
                        onInsert={(serverId) => {
                          const ta = textareaRef.current;
                          const server = enabledMcpServers.find((item) => item.id === serverId);
                          const insert = `${inlineMentionToken(server?.label || serverId)} `;
                          const cursor = ta?.selectionStart ?? draft.length;
                          const before = draft.slice(0, cursor);
                          const after = draft.slice(cursor);
                          const next = before + insert + after;
                          setDraft(next);
                          setToolsOpen(false);
                          requestAnimationFrame(() => {
                            const el = textareaRef.current;
                            if (!el) return;
                            el.focus();
                            const pos = before.length + insert.length;
                            el.setSelectionRange(pos, pos);
                          });
                        }}
                        onManage={() => {
                          setToolsOpen(false);
                          onOpenMcpSettings?.();
                        }}
                      />
                    ) : null}
                    {toolsTab === 'import' ? (
                      <ToolsImportPanel
                        t={t}
                        onLinkFolder={async () => {
                          setToolsOpen(false);
                          await handleLinkFolder();
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
            <button
              className="icon-btn"
              data-testid="chat-attach"
              onClick={() => {
                trackChatPanelClick(analytics.track, {
                  page_name: 'chat_panel',
                  area: 'chat_panel',
                  element: 'attachment',
                });
                fileInputRef.current?.click();
              }}
              title={t('chat.attachTitle')}
              disabled={uploading}
              aria-label={t('chat.attachAria')}
            >
              {uploading ? (
                <Icon name="spinner" size={15} />
              ) : (
                <Icon name="attach" size={15} />
              )}
            </button>
            {footerAccessory}
            <span className="composer-spacer" />
            {streaming ? (
              <button
                type="button"
                className="composer-send stop"
                onClick={onStop}
              >
                <Icon name="stop" size={13} />
                <span>{t('chat.stop')}</span>
              </button>
            ) : (
              <button
                type="button"
                className="composer-send"
                data-testid="chat-send"
                onClick={() => {
                  trackChatPanelClick(analytics.track, {
                    page_name: 'chat_panel',
                    area: 'chat_panel',
                    element: 'send',
                  });
                  void submit();
                }}
                disabled={
                  sendDisabled ||
                  (!draft.trim() && staged.length === 0 && currentCommentAttachments().length === 0)
                }
              >
                <Icon name="send" size={13} />
                <span>{t('chat.send')}</span>
              </button>
            )}
          </div>
        </div>
        {uploadError ? <span className="composer-hint">{uploadError}</span> : null}
        {detailsRecord ? (
          <PluginDetailsModal
            record={detailsRecord}
            onClose={() => setDetailsRecord(null)}
            onUse={async (record) => {
              await pluginsSectionRef.current?.applyById(record.id, record);
              setDetailsRecord(null);
            }}
          />
        ) : null}
      </div>
    );
  }
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name);
}
