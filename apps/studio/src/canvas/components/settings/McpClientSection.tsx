// External MCP servers panel.
//
// Open Design connects to the configured servers as a CLIENT and surfaces
// their tools to the underlying agent (Claude Code, Hermes, Kimi for v1).
// This panel is the user-facing form; persistence flows through
// `state/mcp.ts` -> daemon `/api/mcp/servers`.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAnalytics } from '../../analytics/provider';
import { trackIntegrationsMcpTabClick } from '../../analytics/events';
import {
  disconnectMcpOAuth,
  fetchMcpOAuthStatus,
  fetchMcpServers,
  saveMcpServers,
  startMcpOAuth,
  suggestMcpServerId,
} from '../../state/mcp';
import type {
  McpOAuthStatusResponse,
  McpServerConfig,
  McpTemplate,
} from '../../state/mcp';
import { fetchAgents } from '../../providers/registry';
import type { AgentInfo } from '../../types';
import { Icon } from '../shared/Icon';
import { useT } from '../../i18n';
import { Button } from '@/src/components/ui/button';
import { Input } from '@/src/components/ui/input';
import { Textarea } from '@/src/components/ui/textarea';
import { Switch } from '@/src/components/ui/switch';
import { Badge } from '@/src/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/src/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/src/components/ui/select';

interface Props {
  // Receive a notification when servers list changes so the parent can
  // re-render dependent affordances (e.g. composer chip count). Optional.
  onServersChanged?: (servers: McpServerConfig[]) => void;
  // Surface the dirty/save state up to the dialog footer so a single
  // "Save" button can drive both the global config and this section.
  onDirtyChange?: (dirty: boolean) => void;
}

// Imperative handle: lets the dialog footer Save button trigger this
// section's save without us having to lift the entire row state up.
export interface McpClientSectionHandle {
  save: () => Promise<boolean>;
  hasDirty: () => boolean;
}

interface DraftRow extends McpServerConfig {
  // Local-only flags. Stripped before sending to the daemon.
  _isNew?: boolean;
  // Free-form text for the env / headers panel — committed back to a real
  // map when the user steps away from the field.
  _envText?: string;
  _headersText?: string;
  // Per-instance local id to use as a stable React `key` independent of
  // the editable `id` field (avoids remounts & focus loss while editing).
  _localId: string;
}

// Simple incrementing local id generator for row keys. Kept module-scoped
// and deterministic for the lifetime of this UI instance.
let NEXT_LOCAL_ID = 1;
function genLocalId(): string {
  return `mcp-row-${NEXT_LOCAL_ID++}`;
}

function isLoopbackMcpUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const host = new URL(rawUrl)
      .hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase()
      .replace(/\.+$/g, '');
    if (host === 'localhost' || host === '::1') return true;
    if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
    return /^::ffff:127(?:\.\d{1,3}){3}$/i.test(host);
  } catch {
    return false;
  }
}

function inferMcpAuthMode(url: string | undefined): NonNullable<McpServerConfig['authMode']> {
  return isLoopbackMcpUrl(url) ? 'none' : 'oauth';
}

function effectiveMcpAuthMode(
  row: Pick<McpServerConfig, 'transport' | 'url' | 'authMode'>,
): NonNullable<McpServerConfig['authMode']> {
  if (row.transport !== 'http' && row.transport !== 'sse') return 'none';
  return row.authMode ?? inferMcpAuthMode(row.url);
}

function authModeAfterUrlChange(
  row: Pick<McpServerConfig, 'url' | 'authMode'>,
  nextUrl: string,
): NonNullable<McpServerConfig['authMode']> {
  const previousInferred = inferMcpAuthMode(row.url);
  if (!row.authMode || row.authMode === previousInferred) {
    return inferMcpAuthMode(nextUrl);
  }
  return row.authMode;
}

function rowsFromServers(servers: McpServerConfig[]): DraftRow[] {
  return servers.map((s) => ({
    ...s,
    ...(s.transport === 'http' || s.transport === 'sse'
      ? { authMode: effectiveMcpAuthMode(s) }
      : {}),
    _envText: s.env ? mapToText(s.env) : '',
    _headersText: s.headers ? mapToText(s.headers) : '',
    _localId: genLocalId(),
  }));
}

function mapToText(m: Record<string, string>): string {
  return Object.entries(m)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function textToMap(text: string | undefined): Record<string, string> | undefined {
  if (!text) return undefined;
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function rowsToServers(rows: DraftRow[]): McpServerConfig[] {
  return rows.map((r) => {
    const out: McpServerConfig = {
      id: r.id,
      transport: r.transport,
      enabled: r.enabled,
    };
    if (r.label) out.label = r.label;
    if (r.templateId) out.templateId = r.templateId;
    if (r.transport === 'stdio') {
      if (r.command) out.command = r.command;
      if (r.args && r.args.length > 0) out.args = r.args;
      const env = textToMap(r._envText);
      if (env) out.env = env;
    } else {
      out.authMode = effectiveMcpAuthMode(r);
      if (r.url) out.url = r.url;
      const headers = textToMap(r._headersText);
      if (headers) out.headers = headers;
    }
    return out;
  });
}

function rowFromTemplate(
  tpl: McpTemplate,
  taken: ReadonlySet<string>,
): DraftRow {
  const id = suggestMcpServerId(tpl.id, taken);
  const env: Record<string, string> = {};
  for (const f of tpl.envFields ?? []) env[f.key] = '';
  const headers: Record<string, string> = {};
  for (const f of tpl.headerFields ?? []) headers[f.key] = '';
  return {
    id,
    label: tpl.label,
    templateId: tpl.id,
    transport: tpl.transport,
    enabled: true,
    ...(tpl.transport === 'http' || tpl.transport === 'sse'
      ? { authMode: tpl.authMode ?? inferMcpAuthMode(tpl.url) }
      : {}),
    command: tpl.command,
    args: tpl.args ? [...tpl.args] : undefined,
    url: tpl.url,
    _envText: Object.keys(env).length > 0 ? mapToText(env) : '',
    _headersText: Object.keys(headers).length > 0 ? mapToText(headers) : '',
    _isNew: true,
    _localId: genLocalId(),
  };
}

function rowFromBlank(taken: ReadonlySet<string>): DraftRow {
  return {
    id: suggestMcpServerId('custom', taken),
    label: '',
    transport: 'stdio',
    enabled: true,
    command: '',
    args: [],
    _envText: '',
    _headersText: '',
    _isNew: true,
    _localId: genLocalId(),
  };
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

// Picker grouping. Mirrors `McpTemplateCategory` in `packages/contracts`.
// The order here is the *display* order in the picker — keep it intentional
// so the most useful categories for Open Design (visual generation, then
// editing, then publishing surfaces) sit at the top.
const CATEGORY_ORDER: ReadonlyArray<{
  id: NonNullable<McpTemplate['category']>;
  label: string;
  hint: string;
}> = [
  {
    id: 'image-generation',
    label: 'Image generation',
    hint: 'Models that produce raster, vector or video assets.',
  },
  {
    id: 'image-editing',
    label: 'Image editing',
    hint: 'Local post-processing, OCR and CV-driven edits.',
  },
  {
    id: 'web-capture',
    label: 'Web capture',
    hint: 'Render a URL into an image so the agent can see what it built.',
  },
  {
    id: 'design-systems',
    label: 'Design systems',
    hint: 'Figma read/write, design-token translation, brand inspiration.',
  },
  {
    id: 'ui-components',
    label: 'UI components',
    hint: 'Designer-grade components, blocks and landing-page material.',
  },
  {
    id: 'data-viz',
    label: 'Data viz',
    hint: 'Charts and diagrams as proper image artifacts.',
  },
  {
    id: 'publishing',
    label: 'Publishing',
    hint: 'Push generated artifacts to a public URL.',
  },
  {
    id: 'utilities',
    label: 'Utilities',
    hint: 'Filesystem, fetch, GitHub and similar generic tools.',
  },
];

function templateMatchesQuery(tpl: McpTemplate, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    tpl.label.toLowerCase().includes(needle) ||
    tpl.id.toLowerCase().includes(needle) ||
    (tpl.description?.toLowerCase().includes(needle) ?? false) ||
    (tpl.example?.toLowerCase().includes(needle) ?? false)
  );
}

function validateRow(r: DraftRow): string | null {
  if (!ID_PATTERN.test(r.id)) {
    return 'ID must start with a letter or digit and only contain letters, digits, dash, or underscore (max 64 chars).';
  }
  if (r.transport === 'stdio') {
    if (!r.command || !r.command.trim()) return 'Command is required for stdio transport.';
  } else {
    if (!r.url || !r.url.trim()) return 'URL is required for SSE / HTTP transport.';
    try {
      const parsed = new URL(r.url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'URL must use http:// or https://.';
      }
    } catch {
      return 'URL is malformed.';
    }
  }
  return null;
}

// Stable signature used to detect dirty state — cheap diff against the
// last-known-saved server list. Avoids a deep equality library.
function signature(rows: DraftRow[]): string {
  return JSON.stringify(rowsToServers(rows));
}

export const McpClientSection = forwardRef<McpClientSectionHandle, Props>(
  function McpClientSection({ onServersChanged, onDirtyChange }, ref) {
  const t = useT();
  const analytics = useAnalytics();
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [savedSig, setSavedSig] = useState<string>('[]');
  const [templates, setTemplates] = useState<McpTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Free-text filter at the top of the picker. Empty string = show all.
  // Lives in the section (not the picker render block) so toggling the
  // picker preserves the user's last query while they scan through it.
  const [pickerQuery, setPickerQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Cached agent list so the support banner can tell the user which of the
  // installed CLI agents will actually receive the MCP servers below.
  // Without this, OpenCode / Codex / Gemini users save a server and have
  // no way to learn it never reached the agent (issue #2142).
  const [agents, setAgents] = useState<AgentInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await fetchMcpServers();
      if (cancelled) return;
      if (!data) {
        setError(t('mcpClient.daemonError'));
        setLoaded(true);
        return;
      }
      const fresh = rowsFromServers(data.servers);
      setRows(fresh);
      setSavedSig(signature(fresh));
      setTemplates(data.templates);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await fetchAgents();
      if (cancelled) return;
      setAgents(list);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = useMemo(() => signature(rows) !== savedSig, [rows, savedSig]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const updateRow = (idx: number, patch: Partial<DraftRow>) => {
    setRows((curr) => curr.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const removeRow = (idx: number) => {
    setRows((curr) => curr.filter((_, i) => i !== idx));
  };

  const moveRow = (idx: number, dir: -1 | 1) => {
    setRows((curr) => {
      const next = [...curr];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return curr;
      [next[idx], next[target]] = [next[target]!, next[idx]!];
      return next;
    });
  };

  const addFromTemplate = (tpl: McpTemplate) => {
    setPickerOpen(false);
    setRows((curr) => [...curr, rowFromTemplate(tpl, new Set(curr.map((r) => r.id)))]);
  };

  const addBlank = () => {
    setPickerOpen(false);
    setRows((curr) => [...curr, rowFromBlank(new Set(curr.map((r) => r.id)))]);
  };

  const save = async (): Promise<boolean> => {
    for (const r of rows) {
      const err = validateRow(r);
      if (err) {
        setError(`${r.label || r.id}: ${err}`);
        return false;
      }
    }
    setError(null);
    setSaving(true);
    const payload = rowsToServers(rows);
    const data = await saveMcpServers(payload);
    setSaving(false);
    if (!data) {
      setError(t('mcpClient.saveFailed'));
      return false;
    }
    const fresh = rowsFromServers(data.servers);
    setRows(fresh);
    setSavedSig(signature(fresh));
    setTemplates(data.templates);
    onServersChanged?.(data.servers);
    return true;
  };

  useImperativeHandle(ref, () => ({
    save,
    hasDirty: () => dirty,
  }), [save, dirty]);

  if (!loaded) {
    return (
      <section>
        <p className="text-muted-foreground">{t('common.loading')}</p>
      </section>
    );
  }

  return (
    <section>
      {/* 2026-09-02 走查实锤：这里原有 <h3>{mcpClient.title}</h3>＝「外部 MCP
          服务器」，而外层页面标题是「外部 MCP」——两行叠在一起近乎重复念了
          两遍。删 h3 留副标题（副标题才是真正解释这页干嘛的那句）。
          同 CritiqueTheaterSection 的同款修正。 */}
      <div className="mb-4 flex items-start justify-between gap-6">
        <div>
          <p className="text-muted-foreground">{t('mcpClient.subtitle')}</p>
        </div>
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => {
            trackIntegrationsMcpTabClick(analytics.track, {
              page_name: 'integrations',
              area: 'mcp_tab',
              element: 'add_server',
            });
            setPickerOpen((v) => !v);
          }}
          aria-expanded={pickerOpen}
        >
          <Icon name="sparkles" size={13} />
          <span>{t('mcpClient.addServer')}</span>
        </Button>
      </div>

      <McpAgentSupportBanner agents={agents} />

      {pickerOpen ? (
        <PickerPanel
          templates={templates}
          query={pickerQuery}
          onQueryChange={setPickerQuery}
          onPick={addFromTemplate}
          onPickBlank={addBlank}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      {error ? (
        <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-destructive/35 bg-destructive/[0.07] px-3.5 py-3 text-destructive">
          <Icon name="info" size={15} />
          <span>{error}</span>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card/50 px-8 py-10 text-center">
          <div className="mx-auto mb-3.5 flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Icon name="link" size={19} />
          </div>
          <strong className="mb-1.5 block text-sm font-medium">
            {t('mcpClient.emptyTitle')}
          </strong>
          <p className="mx-auto max-w-[46ch] text-muted-foreground">
            {t('mcpClient.emptyBody')}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row, idx) => (
            <McpRow
              key={row._localId}
              row={row}
              idx={idx}
              total={rows.length}
              template={
                row.templateId
                  ? templates.find((t) => t.id === row.templateId)
                  : undefined
              }
              onChange={(patch) => updateRow(idx, patch)}
              onRemove={() => removeRow(idx)}
              onMoveUp={idx > 0 ? () => moveRow(idx, -1) : undefined}
              onMoveDown={idx < rows.length - 1 ? () => moveRow(idx, 1) : undefined}
            />
          ))}
        </div>
      )}

      {/* 保存条：状态是文字、不是按钮。旧版把「已保存」渲染成一个 disabled
          的 Button——一个长得完全可点、实则永远点不动的控件，用户会反复去点。
          现在保存按钮只在 dirty / saving 时存在，其余时候这里只有一行状态。 */}
      <div className="mt-5 flex items-center gap-3 border-t pt-3.5">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          {saving ? (
            <>
              <span
                className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
                aria-hidden
              />
              {t('settings.autosaveSaving')}
            </>
          ) : dirty ? (
            <>
              <Icon name="info" size={14} />
              {t('mcpClient.unsavedChanges')}
            </>
          ) : (
            <>
              <Icon name="check" size={14} />
              {t('settings.autosaveSaved')}
            </>
          )}
        </span>
        {dirty || saving ? (
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => {
              trackIntegrationsMcpTabClick(analytics.track, {
                page_name: 'integrations',
                area: 'mcp_tab',
                element: 'saved',
              });
              void save();
            }}
            disabled={saving}
          >
            {t('mcpClient.saveChanges')}
          </Button>
        ) : null}
        <span className="flex-1" />
        <span className="text-muted-foreground">
          {t('mcpClient.storedAt')}{' '}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px] text-foreground">
            .od/mcp-config.json
          </code>
        </span>
      </div>
    </section>
  );
});

interface PickerPanelProps {
  templates: McpTemplate[];
  query: string;
  onQueryChange: (q: string) => void;
  onPick: (tpl: McpTemplate) => void;
  onPickBlank: () => void;
  onClose: () => void;
}

/**
 * The "Add server" picker, broken out so we can give it categorized
 * `<details>` groups, an inline filter and a sticky close affordance.
 *
 * UX rules:
 *  - Groups are collapsed by default once the catalog crosses ~12 entries
 *    so the picker fits in a normal viewport. We pre-expand all groups
 *    when the user types a search so matches are immediately visible.
 *  - Groups with zero matching templates are hidden entirely while a
 *    search is active to avoid a wall of empty headers.
 *  - "Custom server" lives in its own footer card pinned below the groups
 *    so users can always reach it even after scrolling through templates.
 */
function PickerPanel({
  templates,
  query,
  onQueryChange,
  onPick,
  onPickBlank,
  onClose,
}: PickerPanelProps) {
  const grouped = useMemo(() => {
    const buckets = new Map<McpTemplate['category'], McpTemplate[]>();
    for (const tpl of templates) {
      const list = buckets.get(tpl.category) ?? [];
      list.push(tpl);
      buckets.set(tpl.category, list);
    }
    return buckets;
  }, [templates]);

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;

  // Total visible across all groups so we can show an empty-state if the
  // search filters everything out.
  let visibleTotal = 0;
  const renderGroups = CATEGORY_ORDER.map((cat) => {
    const all = grouped.get(cat.id) ?? [];
    const matched = all.filter((t) => templateMatchesQuery(t, trimmed));
    visibleTotal += matched.length;
    if (all.length === 0) return null;
    if (hasQuery && matched.length === 0) return null;
    // Default-expanded for the first three groups (the visual-asset
    // pipeline most users will land here for); collapsed otherwise.
    // Active query forces every visible group open so matches surface
    // without an extra click.
    const defaultOpen =
      hasQuery ||
      cat.id === 'image-generation' ||
      cat.id === 'image-editing' ||
      cat.id === 'web-capture';
    return (
      <details key={cat.id} className="group" open={defaultOpen}>
        <summary
          data-slot="mcp-picker-group"
          className="flex cursor-pointer list-none select-none items-center gap-2 border-b bg-muted/55 px-3.5 py-2.5 hover:bg-hover [&::-webkit-details-marker]:hidden"
        >
          <span className="font-medium">{cat.label}</span>
          <span className="rounded-md border px-1.5 py-px font-mono text-[10px] text-muted-foreground">
            {hasQuery ? `${matched.length}/${all.length}` : all.length}
          </span>
          <span className="ml-auto text-muted-foreground">{cat.hint}</span>
        </summary>
        <div className="grid grid-cols-2 gap-2 border-b p-3.5">
          {matched.map((tpl) => (
            <PickerCard key={tpl.id} tpl={tpl} onPick={() => onPick(tpl)} />
          ))}
        </div>
      </details>
    );
  });

  return (
    <div className="mb-3.5 overflow-hidden rounded-xl border border-input bg-card shadow-sm">
      <div className="border-b p-3.5">
        <div className="mb-1 flex items-center justify-between">
          <strong className="text-sm font-[650]">Pick a template</strong>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={onClose}
            title="Close picker"
            aria-label="Close picker"
          >
            ×
          </Button>
        </div>
        <p className="mb-2.5 text-muted-foreground">
          Pre-fills the form. You can still edit any field after.
        </p>
        <Input
          type="search"
          placeholder="Filter by name, transport, capability…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          spellCheck={false}
          autoFocus
        />
      </div>

      <div className="max-h-[340px] overflow-y-auto">
        {renderGroups}
        {hasQuery && visibleTotal === 0 ? (
          <div className="px-3.5 py-4 text-muted-foreground">
            No templates match &ldquo;{trimmed}&rdquo;. Try clearing the filter
            or use the custom server option below.
          </div>
        ) : null}
      </div>

      <div className="p-3.5">
        <button
          type="button"
          data-slot="mcp-picker-custom"
          className="flex w-full cursor-pointer flex-col gap-0.5 rounded-lg border border-dashed bg-transparent p-2.5 text-left transition-colors hover:border-primary/50 hover:bg-muted/50"
          onClick={onPickBlank}
        >
          <span className="flex items-center gap-1.5">
            <Icon name="settings" size={13} />
            <strong className="font-medium">Custom server</strong>
          </span>
          <span className="text-muted-foreground">
            Empty form. Pick stdio or SSE / HTTP and fill the fields yourself.
          </span>
        </button>
      </div>
    </div>
  );
}

function PickerCard({
  tpl,
  onPick,
}: {
  tpl: McpTemplate;
  onPick: () => void;
}) {
  return (
    <div className="flex flex-col rounded-lg border bg-background transition-colors hover:border-primary/55">
      <button
        type="button"
        data-slot="mcp-picker-card"
        className="flex flex-1 cursor-pointer flex-col gap-1 bg-transparent p-2.5 text-left"
        onClick={onPick}
        title={tpl.description}
      >
        <span className="flex items-center gap-1.5">
          <Icon name="link" size={13} />
          <strong className="font-medium">{tpl.label}</strong>
          <Badge variant="secondary" className="font-mono text-[10px] uppercase">
            {tpl.transport}
          </Badge>
        </span>
        <span className="text-muted-foreground">{tpl.description}</span>
        {tpl.example ? (
          <span className="text-muted-foreground">
            <span className="font-medium">Try:</span> <span className="italic">"{tpl.example}"</span>
          </span>
        ) : null}
      </button>
      {tpl.homepage ? (
        <a
          className="flex items-center gap-1 border-t px-2.5 py-1.5 text-muted-foreground hover:text-foreground"
          href={tpl.homepage}
          target="_blank"
          rel="noreferrer noopener"
          title={tpl.homepage}
        >
          <Icon name="external-link" size={11} />
          <span>Homepage</span>
        </a>
      ) : null}
    </div>
  );
}

interface RowProps {
  row: DraftRow;
  idx: number;
  total: number;
  // The original built-in template this row was instantiated from, when the
  // user picked a preset. Lets us surface description / homepage / example
  // hints inline so the saved row isn't a wall of opaque form fields.
  template?: McpTemplate;
  onChange: (patch: Partial<DraftRow>) => void;
  onRemove: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
}

function McpRow({ row, idx, total, template, onChange, onRemove, onMoveUp, onMoveDown }: RowProps) {
  const isHttpLike = row.transport === 'http' || row.transport === 'sse';
  const usesManagedOAuth = isHttpLike && effectiveMcpAuthMode(row) === 'oauth';
  const [expanded, setExpanded] = useState<boolean>(false);
  const summaryTitle = row.label?.trim() || row.id || 'Unnamed MCP server';
  const [showMcpExample, setShowMcpExample] = useState<boolean>(false);
  const helperId = `mcp-json-helper-panel-${row._localId}`;
  const t = useT();

  // 折叠态副行：不展开也能认出这台服务器是什么。stdio 显示实际会 spawn 的
  // 命令行，HTTP/SSE 显示 URL —— 旧版折叠行只有一个名字，用户想确认配置
  // 必须逐个展开。
  const summarySubtitle =
    row.transport === 'stdio'
      ? [row.command, ...(row.args ?? [])].filter(Boolean).join(' ')
      : row.url ?? '';

  return (
    <div
      data-expanded={expanded ? '' : undefined}
      data-off={row.enabled ? undefined : ''}
      className="group/row rounded-xl border bg-card shadow-xs transition-all hover:border-input data-[expanded]:border-input data-[expanded]:shadow-sm data-[off]:opacity-60"
    >
      <div className="flex items-center gap-2.5 py-2.5 pl-2.5 pr-2.5">
        <Switch
          checked={row.enabled}
          onCheckedChange={(checked) => onChange({ enabled: checked })}
          aria-label="Enable this MCP server"
          title={row.enabled ? 'Enabled' : 'Disabled'}
        />

        {expanded ? (
          <Input
            type="text"
            className="h-8 flex-1"
            value={row.label ?? ''}
            placeholder="Display name (optional)"
            onChange={(e) => onChange({ label: e.target.value })}
          />
        ) : (
          <button
            type="button"
            data-slot="mcp-row-summary"
            className="flex min-w-0 flex-1 cursor-pointer flex-col gap-px bg-transparent p-0 text-left"
            onClick={() => setExpanded(true)}
            title="Expand to edit"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={`truncate text-sm font-medium ${row.enabled ? '' : 'text-muted-foreground'}`}
              >
                {summaryTitle}
              </span>
              <Badge
                variant="secondary"
                className="font-mono text-[10px] uppercase tracking-wide"
                aria-label={`Transport: ${row.transport}`}
              >
                {row.transport}
              </Badge>
            </span>
            {summarySubtitle ? (
              <span className="w-full truncate font-mono text-[11.5px] text-muted-foreground">
                {summarySubtitle}
              </span>
            ) : null}
          </button>
        )}

        {/* 启用状态。旧版这里是 `idx+1 / total` 计数器——占着视觉重心却零
            信息量（用户不关心这是第几行）。工具数 / 连接活性才是真正有用的
            信息，但 daemon 目前不返回，所以先只表达 enabled。 */}
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          {row.enabled ? (
            <>
              <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
              {t('mcpClient.rowEnabled')}
            </>
          ) : (
            t('mcpClient.rowDisabled')
          )}
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          {/* 旧版把上移 / 下移 / 删除三个裸符号按钮（↑ ↓ ×）常驻并排，
              一行四个控件抢注意力，且 × 紧挨展开箭头极易误删。收进菜单后
              行内只剩「开关 + 展开」两个高频动作。 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* 平时隐身、hover 行才浮现，避免三个次要动作长期占视觉带宽。
                  展开态 = 用户正在编辑这一行，此时常驻显示。 */}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100 group-data-[expanded]/row:opacity-100 data-[state=open]:opacity-100"
                title={t('mcpClient.rowMore')}
                aria-label={t('mcpClient.rowMore')}
              >
                <Icon name="more-horizontal" size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={!onMoveUp} onSelect={() => onMoveUp?.()}>
                {t('mcpClient.rowMoveUp')}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!onMoveDown} onSelect={() => onMoveDown?.()}>
                {t('mcpClient.rowMoveDown')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onRemove()}>
                {t('mcpClient.rowRemove')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse this MCP server' : 'Expand this MCP server'}
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <span className={expanded ? 'block rotate-180 transition-transform' : 'block transition-transform'}>
              <Icon name="chevron-down" size={13} />
            </span>
          </Button>
        </div>
      </div>

      {expanded ? (
        <div className="flex flex-col gap-3 border-t p-3.5">
          {template ? (
            <div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2.5 text-muted-foreground">
              <span className="mt-0.5 shrink-0">
                <Icon name="info" size={14} />
              </span>
              <span>
                {template.description ? (
                  <>
                    <strong className="font-medium text-foreground">{template.label}</strong>
                    {' — '}
                    {template.description}{' '}
                  </>
                ) : null}
                {template.homepage ? (
                  <a
                    className="text-primary underline-offset-4 hover:underline"
                    href={template.homepage}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={template.homepage}
                  >
                    {t('mcpClient.templateHomepage')}
                  </a>
                ) : null}
                {template.example ? (
                  <span
                    className="mt-1 block"
                    title="Paste this prompt into the chat composer to try the server end-to-end"
                  >
                    <span className="font-medium">{t('mcpClient.templateTry')}</span>{' '}
                    <span className="italic">"{template.example}"</span>
                  </span>
                ) : null}
              </span>
            </div>
          ) : null}

          {isHttpLike && !row._isNew && row.id ? (
            usesManagedOAuth ? (
              <McpOAuthControl serverId={row.id} />
            ) : (
              <div className="rounded-lg bg-muted px-3 py-2.5 text-muted-foreground">
                <strong className="font-medium text-foreground">No managed OAuth.</strong>{' '}
                Open Design will use this server as configured. Add headers below
                if the server needs a token.
              </div>
            )
          ) : null}
          {isHttpLike && row._isNew && usesManagedOAuth ? (
            <div className="rounded-lg bg-muted px-3 py-2.5 text-muted-foreground">
              Save first, then click <strong className="font-medium text-foreground">Connect</strong>{' '}
              to grant Open Design access via the provider's OAuth flow.
            </div>
          ) : null}
          {isHttpLike && row._isNew && !usesManagedOAuth ? (
            <div className="rounded-lg bg-muted px-3 py-2.5 text-muted-foreground">
              <strong className="font-medium text-foreground">No managed OAuth.</strong>{' '}
              Save this server and Open Design will use it directly.
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-muted-foreground">ID</span>
              <Input
                type="text"
                className="font-mono"
                value={row.id}
                onChange={(e) => onChange({ id: e.target.value })}
                spellCheck={false}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-muted-foreground">Transport</span>
              <Select
                value={row.transport}
                onValueChange={(v) => {
                  const transport = v as DraftRow['transport'];
                  onChange({
                    transport,
                    ...(transport === 'http' || transport === 'sse'
                      ? { authMode: row.authMode ?? inferMcpAuthMode(row.url) }
                      : { authMode: undefined }),
                  });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">stdio</SelectItem>
                  <SelectItem value="sse">SSE</SelectItem>
                  <SelectItem value="http">streamable HTTP</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>

          {row.transport === 'stdio' ? (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="font-medium text-muted-foreground">Command</span>
                <Input
                  type="text"
                  className="font-mono"
                  value={row.command ?? ''}
                  placeholder="e.g. npx, node, /path/to/binary"
                  onChange={(e) => onChange({ command: e.target.value })}
                  spellCheck={false}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="font-medium text-muted-foreground">Args</span>
                <Input
                  type="text"
                  className="font-mono"
                  value={(row.args ?? []).join(' ')}
                  placeholder="space-separated"
                  onChange={(e) =>
                    onChange({
                      args: e.target.value
                        .split(/\s+/)
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  spellCheck={false}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="font-medium text-muted-foreground">Env (KEY=VALUE)</span>
                <Textarea
                  className="font-mono"
                  rows={Math.max(2, (row._envText ?? '').split('\n').length)}
                  value={row._envText ?? ''}
                  placeholder="GITHUB_TOKEN=ghp_…"
                  onChange={(e) => onChange({ _envText: e.target.value })}
                  spellCheck={false}
                />
              </label>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="font-medium text-muted-foreground">OAuth mode</span>
                <Select
                  value={effectiveMcpAuthMode(row)}
                  onValueChange={(v) =>
                    onChange({
                      authMode: v as NonNullable<McpServerConfig['authMode']>,
                    })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No managed OAuth</SelectItem>
                    <SelectItem value="oauth">Managed OAuth</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="font-medium text-muted-foreground">URL</span>
                <Input
                  type="text"
                  className="font-mono"
                  value={row.url ?? ''}
                  placeholder="https://mcp.higgsfield.ai/mcp"
                  onChange={(e) => {
                    const url = e.target.value;
                    onChange({ url, authMode: authModeAfterUrlChange(row, url) });
                  }}
                  spellCheck={false}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="font-medium text-muted-foreground">Headers (KEY=VALUE)</span>
                <Textarea
                  className="font-mono"
                  rows={Math.max(2, (row._headersText ?? '').split('\n').length)}
                  value={row._headersText ?? ''}
                  placeholder="Authorization=Bearer …"
                  onChange={(e) => onChange({ _headersText: e.target.value })}
                  spellCheck={false}
                />
              </label>
            </>
          )}

          <div className="overflow-hidden rounded-md border">
            <button
              type="button"
              data-slot="mcp-json-helper-toggle"
              className="flex w-full cursor-pointer select-none items-center gap-2 bg-transparent px-3 py-2.5 text-left text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
              aria-expanded={showMcpExample}
              aria-controls={helperId}
              onClick={() => setShowMcpExample((prev) => !prev)}
            >
              <span className="shrink-0">
                <Icon name="eye" size={14} />
              </span>
              <span className="flex-1">
                Need help? Map your MCP server's JSON config using the example below.
              </span>
              <span className={showMcpExample ? 'shrink-0 rotate-180 transition-transform' : 'shrink-0 transition-transform'}>
                <Icon name="chevron-down" size={14} />
              </span>
            </button>

            {showMcpExample && (
              <div className="px-3 pb-3" id={helperId}>
                <div className="mb-1.5 font-medium text-muted-foreground">
                  Example MCP JSON
                </div>
                <pre className="mb-2.5 overflow-x-auto rounded-md bg-muted p-3 font-mono text-[11.5px] leading-relaxed">
                  <code>
                    <span className="text-muted-foreground">{"{"}</span>
                    {"\n  "}
                    <span className="text-primary">"mcpServers"</span>
                    <span className="text-muted-foreground">: {"{"}</span>
                    {"\n    "}
                    <span className="text-primary">"tdesign"</span>
                    <span className="text-muted-foreground">: {"{"}</span>
                    {"\n      "}
                    <span className="text-primary">"command"</span>
                    <span className="text-muted-foreground">:</span>{" "}
                    <span className="text-brand">"npx"</span>
                    <span className="text-muted-foreground">,</span>
                    {"\n      "}
                    <span className="text-primary">"args"</span>
                    <span className="text-muted-foreground">: [</span>
                    <span className="text-brand">"-y"</span>
                    <span className="text-muted-foreground">, </span>
                    <span className="text-brand">"tdesign-mcp-server@latest"</span>
                    <span className="text-muted-foreground">],</span>
                    {"\n      "}
                    <span className="text-primary">"env"</span>
                    <span className="text-muted-foreground">: {"{"}</span>
                    {"\n        "}
                    <span className="text-primary">"API_KEY"</span>
                    <span className="text-muted-foreground">:</span>{" "}
                    <span className="text-brand">"your-key-here"</span>
                    {"\n      "}
                    <span className="text-muted-foreground">{"}"}</span>
                    {"\n    "}
                    <span className="text-muted-foreground">{"}"}</span>
                    {"\n  "}
                    <span className="text-muted-foreground">{"}"}</span>
                    {"\n"}
                    <span className="text-muted-foreground">{"}"}</span>
                  </code>
                </pre>
                <div className="grid grid-cols-[84px_1fr] items-center gap-x-3 gap-y-1.5">
                  <strong className="font-medium text-muted-foreground">Command</strong>
                  <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px]">npx</code>
                  <strong className="font-medium text-muted-foreground">Args</strong>
                  <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px]">-y tdesign-mcp-server@latest</code>
                  <strong className="font-medium text-muted-foreground">Env</strong>
                  <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px]">API_KEY = your-key-here</code>
                  <strong className="font-medium text-muted-foreground">HTTP / SSE</strong>
                  <code className="w-fit rounded bg-muted px-1.5 py-0.5 font-mono text-[11.5px]">use url + headers instead of command / args</code>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Connect" / "Disconnect" panel for an HTTP/SSE MCP server.
 *
 * The OAuth flow is fully owned by the daemon — this component just kicks
 * it off (POST /api/mcp/oauth/start), opens the returned authorize URL in
 * a new tab, listens for the postMessage from the callback page, and
 * refreshes the local status badge. There's also a fallback poll every
 * 2 seconds while a connect is pending in case the callback page can't
 * reach back via postMessage (cross-origin tab opener edge cases).
 */
function McpOAuthControl({ serverId }: { serverId: string }) {
  const [status, setStatus] = useState<McpOAuthStatusResponse | null>(null);
  const [busy, setBusy] = useState<'idle' | 'starting' | 'awaiting' | 'disconnecting' | 'refreshing'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Holds the authorize URL while we are waiting on the user to complete
  // OAuth in their browser. Surfaced as a fallback `<a>` so the user can
  // re-open the tab if they accidentally closed it (or if the system
  // browser ate the popup-open call without giving us feedback).
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = async () => {
    const data = await fetchMcpOAuthStatus(serverId);
    if (data) setStatus(data);
    return data;
  };

  useEffect(() => {
    void refresh();
  }, [serverId]);

  // Listen for the postMessage that the callback HTML page emits when the
  // OAuth flow completes. We accept messages from any origin because the
  // callback page is served by THIS daemon, but we still validate the
  // payload shape before reacting to it.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      if (data.type !== 'mcp-oauth') return;
      if (data.serverId && data.serverId !== serverId) return;
      if (data.ok) {
        setError(null);
        setPendingAuthUrl(null);
        void refresh();
      } else if (typeof data.message === 'string') {
        setError(data.message);
      }
      setBusy('idle');
      stopPoll();
    }
    window.addEventListener('message', onMessage);
    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel('open-design-mcp-oauth');
      bc.onmessage = (ev) => onMessage(ev as MessageEvent);
    }
    return () => {
      window.removeEventListener('message', onMessage);
      if (bc) bc.close();
      stopPoll();
    };
  }, [serverId]);

  function stopPoll() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  function startPoll() {
    stopPoll();
    let elapsed = 0;
    pollTimer.current = setInterval(() => {
      elapsed += 2000;
      void (async () => {
        const data = await refresh();
        // Auto-stop when the daemon reports connected — handles the
        // Electron / system-browser case where postMessage can never
        // reach back across processes, so polling IS the delivery
        // channel for "auth completed" events.
        if (data?.connected) {
          setBusy('idle');
          setError(null);
          setPendingAuthUrl(null);
          stopPoll();
        }
      })();
      // Top out at 5 minutes — same as the daemon-side state cache TTL.
      if (elapsed >= 5 * 60 * 1000) stopPoll();
    }, 2000);
  }

  const onConnect = async () => {
    setError(null);
    setPendingAuthUrl(null);
    setBusy('starting');
    const result = await startMcpOAuth(serverId);
    if (!result.ok) {
      setBusy('idle');
      setError(result.message);
      return;
    }
    setBusy('awaiting');
    setPendingAuthUrl(result.response.authorizeUrl);
    startPoll();
    // Best-effort: try to open the tab automatically. We deliberately do
    // NOT treat a null return value as failure — Electron's
    // setWindowOpenHandler always returns deny (so window.open returns
    // null) but actually invokes shell.openExternal under the hood, so
    // the URL DID open in the system browser. The fallback link below
    // covers the rare case where neither path actually opens a tab.
    try {
      window.open(
        result.response.authorizeUrl,
        '_blank',
        'noopener=no,noreferrer=no',
      );
    } catch {
      // ignore — fallback anchor is always rendered while pending
    }
  };

  // Manual fallback for the user to push when they've completed auth in
  // another tab/window but the postMessage handshake didn't fire (closed
  // opener tab, cross-origin Electron BrowserWindow, etc.).
  const onRefreshStatus = async () => {
    setBusy('refreshing');
    const data = await refresh();
    setBusy('idle');
    if (data?.connected) {
      setError(null);
      setPendingAuthUrl(null);
      stopPoll();
    } else if (busy === 'awaiting' || pendingAuthUrl) {
      // Still pending — keep the awaiting indicator visible so the user
      // knows we're still listening for the callback.
      setBusy('awaiting');
    }
  };

  const onCancelPending = () => {
    setPendingAuthUrl(null);
    setBusy('idle');
    setError(null);
    stopPoll();
  };

  const onDisconnect = async () => {
    setBusy('disconnecting');
    const ok = await disconnectMcpOAuth(serverId);
    setBusy('idle');
    if (ok) {
      setError(null);
      setPendingAuthUrl(null);
      setStatus({ connected: false });
    } else {
      setError('Disconnect failed. Check daemon logs.');
    }
  };

  const connected = Boolean(status?.connected);
  const expiresLabel =
    status?.expiresAt && status.expiresAt > 0
      ? new Date(status.expiresAt).toLocaleString()
      : null;
  const isAwaiting = busy === 'awaiting' || (Boolean(pendingAuthUrl) && !connected);

  return (
    // 2026-09-01：XaiOAuthControl 也迁完了，.mcp-oauth-* / .xai-oauth-*
    // 两族 CSS 已从 mcp-settings.css 整段删除（零消费者才动手）。这里与
    // 那边的观感重新对齐——两个面板的 utility 结构是逐行同构的，改一边
    // 记得看另一边。
    <div className="flex flex-col gap-2.5 rounded-lg border bg-background p-3 dark:bg-input/30">
      <div className="flex items-center gap-2" aria-live="polite">
        {connected ? (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
            <span>
              <strong className="font-medium">Connected.</strong>{' '}
              <span className="text-muted-foreground">
                {expiresLabel ? `Token expires ${expiresLabel}.` : 'Non-expiring token.'}
              </span>
            </span>
          </>
        ) : isAwaiting ? (
          <>
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
            <span>
              <strong className="font-medium">Waiting for authorization…</strong>{' '}
              <span className="text-muted-foreground">
                Approve in the browser tab that opened. We'll catch the callback
                automatically — or click Refresh below if you completed it
                already.
              </span>
            </span>
          </>
        ) : (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
            <span>
              <strong className="font-medium">Not connected.</strong>{' '}
              <span className="text-muted-foreground">
                Click Connect to grant Open Design access via the provider's OAuth flow.
              </span>
            </span>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {connected ? (
          <>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={onConnect}
              disabled={busy !== 'idle' && busy !== 'refreshing'}
              title="Reauthenticate (replaces the existing token)"
            >
              {busy === 'starting' || busy === 'awaiting' ? 'Connecting…' : 'Reconnect'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefreshStatus}
              disabled={busy !== 'idle' && busy !== 'refreshing'}
              title="Re-check token status against the daemon"
            >
              {busy === 'refreshing' ? 'Checking…' : 'Refresh'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onDisconnect}
              disabled={busy !== 'idle' && busy !== 'refreshing'}
            >
              {busy === 'disconnecting' ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </>
        ) : isAwaiting ? (
          <>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={onRefreshStatus}
              disabled={busy === 'refreshing'}
              title="I've completed authorization — check connection status now"
            >
              {busy === 'refreshing' ? 'Checking…' : 'I\u2019ve approved — Refresh'}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onCancelPending}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onConnect}
            disabled={busy !== 'idle'}
          >
            {busy === 'starting' ? 'Starting…' : 'Connect'}
          </Button>
        )}
      </div>

      {pendingAuthUrl && !connected ? (
        <div className="text-muted-foreground">
          Browser didn't open?{' '}
          <a
            href={pendingAuthUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline-offset-4 hover:underline"
          >
            Open authorization page
          </a>
          .
        </div>
      ) : null}

      {error ? <div className="text-destructive">{error}</div> : null}
    </div>
  );
}

/**
 * Renders a compact two-line banner showing which installed CLI agents
 * receive the user's external MCP servers at spawn time and which do not.
 * The truth source is the daemon `/api/agents` payload — every runtime def
 * carries an `externalMcpInjection` discriminator (one of
 * `claude-mcp-json` / `acp-merge` / `opencode-env-content`, or undefined
 * when no native injection is wired yet).
 *
 * The banner replaces the previous silent-failure UX from issue #2142:
 * users were configuring servers under OpenCode / Codex / Gemini and
 * never learning the daemon never forwarded them to the agent process.
 * Rendered above the picker so it is the first thing the user reads.
 */
function McpAgentSupportBanner({ agents }: { agents: AgentInfo[] }) {
  const t = useT();
  // Empty payload = either still loading or daemon unreachable. Either
  // way, render nothing — the error banner below already covers the
  // "daemon unreachable" path and we don't want to flash an empty hint
  // during the initial fetch.
  if (agents.length === 0) return null;
  // `/api/agents` returns every runtime def the daemon knows about,
  // including CLIs the user hasn't installed (those carry
  // `available: false`). Splitting the full catalog into "Forwarded to /
  // Not forwarded to" would mention adapters the user can't even launch,
  // which is misleading. Scope the banner to installed CLIs only.
  const installed = agents.filter((a) => a.available);
  if (installed.length === 0) return null;
  const supported = installed.filter(
    (a) => typeof a.externalMcpInjection === 'string',
  );
  const unsupported = installed.filter(
    (a) => !a.externalMcpInjection,
  );
  if (supported.length === 0 && unsupported.length === 0) return null;
  // ACP adapters (Hermes / Kimi / Kilo / Kiro / Vibe / Devin) currently
  // accept stdio MCP servers only — `buildAcpMcpServers()` in
  // `apps/daemon/src/mcp-config.ts` filters to `transport === 'stdio'`
  // because the ACP `mcpServers` descriptor itself has no slot for
  // HTTP / SSE entries. Tag those runtimes inline so the banner does
  // not silently claim full forwarding for HTTP MCP servers, which
  // would re-introduce the very silent-failure UX we are removing.
  // 旧版把两组 agent 名拼成一整段密集英文散文（外加一大段 ACP / 配置文件
  // 说明），信息密度高但一眼读不出「谁收得到、谁收不到」。改成一行一组的
  // Badge：名字本身成为可扫视的单元，长解释收进折叠，只在用户主动想读时展开。
  const sortNames = (list: AgentInfo[]) =>
    list.slice().sort((a, b) => a.name.localeCompare(b.name));
  const hasAcpSupported = supported.some(
    (a) => a.externalMcpInjection === 'acp-merge',
  );
  return (
    <div className="mb-3.5 overflow-hidden rounded-xl border bg-card shadow-xs">
      {supported.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3.5 py-2.5">
          <span className="flex w-[74px] shrink-0 items-center gap-1.5 font-medium text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
            {t('mcpClient.forwardedTo')}
          </span>
          {sortNames(supported).map((a) => (
            <Badge key={a.id} variant="secondary" className="gap-1.5">
              {a.name}
              {a.externalMcpInjection === 'acp-merge' ? (
                <span className="border-l border-border pl-1.5 font-mono text-[10px] text-muted-foreground">
                  {t('mcpClient.stdioOnly')}
                </span>
              ) : null}
            </Badge>
          ))}
        </div>
      ) : null}

      {unsupported.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-t px-3.5 py-2.5">
          <span className="flex w-[74px] shrink-0 items-center gap-1.5 font-medium text-muted-foreground">
            {/* 没有 --warning 语义 token（见文件头注），用中性点 + 弱化文字
                表达「不生效」，不自造色相。 */}
            <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />
            {t('mcpClient.notForwardedTo')}
          </span>
          {sortNames(unsupported).map((a) => (
            <Badge key={a.id} variant="secondary" className="text-muted-foreground">
              {a.name}
            </Badge>
          ))}
        </div>
      ) : null}

      <details className="group border-t bg-muted/50">
        <summary
          data-slot="mcp-forward-more"
          className="flex cursor-pointer list-none select-none items-center gap-1.5 px-3.5 py-2 text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden"
        >
          <span className="transition-transform group-open:rotate-180">
            <Icon name="chevron-down" size={13} />
          </span>
          {t('mcpClient.howToConfigure')}
        </summary>
        <div className="max-w-[62ch] pb-3 pl-8 pr-3.5 text-muted-foreground">
          {unsupported.length > 0 ? (
            <p>
              {t('mcpClient.notForwardedHelp')}{' '}
              <code className="rounded bg-muted px-1.5 py-px text-[12px] text-foreground">
                ~/.codex/config.toml
              </code>
              、
              <code className="rounded bg-muted px-1.5 py-px text-[12px] text-foreground">
                ~/.gemini/settings.json
              </code>
              。
            </p>
          ) : null}
          {hasAcpSupported ? (
            <p className={unsupported.length > 0 ? 'mt-2' : undefined}>
              {t('mcpClient.acpStdioHelp')}
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
}
