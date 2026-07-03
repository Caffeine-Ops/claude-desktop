import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../shared/Icon';

// Per-client install paths. Each entry's `snippet` is what the user
// copies; some clients also support a richer `deeplink` flow that
// triggers a one-click install with an in-client approval dialog.
//
// Schemas drift between clients in deliberate ways. VS Code keys
// servers under "servers" with a required "type" field; Zed uses
// "context_servers"; Cursor, Windsurf, and Antigravity share
// "mcpServers"; Claude Code is best served by its CLI which writes
// to the local config for you. Verified against each tool's official
// docs in May 2026.
//
// Important: every snippet uses absolute paths to the daemon's current
// Node-compatible runtime and built cli.js, fetched at runtime. macOS
// and Linux ship a system /usr/bin/od (octal-dump) that shadows any
// `od` we might add to PATH, and most Open Design users run from
// source where `od` is not installed globally. The installer panel
// must NOT reference bare `od`.
type McpClientId =
  | 'claude'
  | 'codex'
  | 'cursor'
  | 'vscode'
  | 'zed'
  | 'windsurf'
  | 'antigravity';

interface McpInstallInfo {
  command: string;
  args: string[];
  env?: Record<string, string>;
  daemonUrl: string;
  platform: 'darwin' | 'linux' | 'win32' | string;
  cliExists: boolean;
  nodeExists: boolean;
  buildHint: string | null;
}

interface McpStdioServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpClient {
  id: McpClientId;
  label: string;
  // Function so the dropdown can show different methods per OS
  // (Claude Code uses CLI on POSIX but JSON edit on Windows because
  // the bash/PowerShell/cmd.exe quoting is too fragile to reliably
  // emit a single command that works in every shell).
  buildMethod: (info: McpInstallInfo) => string;
  // Function so per-OS path hints (~/.cursor on POSIX vs
  // %USERPROFILE%\.cursor on Windows) and shortcut differences
  // (⌘⇧P vs Ctrl+Shift+P) can be rendered correctly.
  buildInstruction: (info: McpInstallInfo) => string;
  buildSnippet: (info: McpInstallInfo) => string;
  buildSnippetLang: (info: McpInstallInfo) => 'bash' | 'json' | 'toml';
  // Optional one-click install action. Currently only Cursor
  // supports deeplinks of this shape.
  buildDeeplink?: (info: McpInstallInfo) => string;
  deeplinkLabel?: () => string;
}

// Path hint per OS. Localizes the "where to paste" copy so a
// Windows user does not see ~/.cursor/mcp.json (which their shell
// will not expand) or a Linux user does not see %APPDATA% paths.
function homeConfigPath(
  platform: McpInstallInfo['platform'],
  posix: string,
  windows: string,
): string {
  return platform === 'win32' ? windows : posix;
}

function commandPaletteShortcut(platform: McpInstallInfo['platform']): string {
  return platform === 'darwin' ? '⌘⇧P' : 'Ctrl+Shift+P';
}

function settingsShortcut(platform: McpInstallInfo['platform']): string {
  return platform === 'darwin' ? '⌘,' : 'Ctrl+,';
}

// btoa() requires every input character be representable in Latin-1
// (codepoints 0-255). A Mac/Linux home directory like
// "/Users/Émile/.fnm/.../node" trips that and throws
// InvalidCharacterError. UTF-8-encode the string into bytes first,
// then map each byte back to a Latin-1 char before base64'ing.
function utf8Btoa(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function buildMcpStdioServerConfig(info: McpInstallInfo): McpStdioServerConfig {
  const env = info.env && Object.keys(info.env).length > 0 ? info.env : undefined;
  return {
    command: info.command,
    args: info.args,
    ...(env ? { env } : {}),
  };
}

function buildCodexEnvToml(info: McpInstallInfo): string {
  const entries = Object.entries(info.env ?? {});
  if (entries.length === 0) return '';
  return `

[mcp_servers.open-design.env]
${entries.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}`;
}

function buildSharedMcpJson(info: McpInstallInfo): string {
  const inner = buildMcpStdioServerConfig(info);
  const innerJson = JSON.stringify(inner, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : `    ${line}`))
    .join('\n');
  return `{
  "mcpServers": {
    "open-design": ${innerJson}
  }
}`;
}

export function IntegrationsSection() {
  const { t } = useI18n();

  const MCP_CLIENTS: McpClient[] = [
    {
      id: 'claude',
      label: 'Claude Code',
      buildMethod: () => t('settings.mcpMethodCli'),
      buildInstruction: () => t('settings.mcpInstructionCli'),
      buildSnippet: (info) => {
        const inner = JSON.stringify(buildMcpStdioServerConfig(info));
        return `claude mcp add-json --scope user open-design '${inner}'`;
      },
      buildSnippetLang: () => 'bash',
    },
    {
      id: 'codex',
      label: 'Codex',
      buildMethod: () => t('settings.mcpMethodToml'),
      buildInstruction: (info) => {
        const path = homeConfigPath(
          info.platform,
          '~/.codex/config.toml',
          '%USERPROFILE%\\.codex\\config.toml',
        );
        return t('settings.mcpInstructionCodex', { path });
      },
      buildSnippet: (info) => `[mcp_servers.open-design]\ncommand = ${JSON.stringify(info.command)}\nargs = ${JSON.stringify(info.args)}${buildCodexEnvToml(info)}`,
      buildSnippetLang: () => 'toml',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      buildMethod: () => t('settings.mcpMethodOneClick'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionCursor', {
          path: homeConfigPath(info.platform, '~/.cursor/mcp.json', '%USERPROFILE%\\.cursor\\mcp.json'),
        }),
      buildSnippet: buildSharedMcpJson,
      buildSnippetLang: () => 'json',
      buildDeeplink: (info) => {
        const inner = buildMcpStdioServerConfig(info);
        const encoded = utf8Btoa(JSON.stringify(inner));
        return `cursor://anysphere.cursor-deeplink/mcp/install?name=open-design&config=${encoded}`;
      },
      deeplinkLabel: () => t('settings.mcpDeeplinkInstallCursor'),
    },
    {
      id: 'vscode',
      label: 'VS Code',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionCopilot', {
          shortcut: commandPaletteShortcut(info.platform),
        }),
      buildSnippet: (info) => `{\n  "servers": {\n    "open-design": {\n      "type": "stdio",\n      "command": ${JSON.stringify(info.command)},\n      "args": ${JSON.stringify(info.args)}${info.env && Object.keys(info.env).length > 0 ? `,\n      "env": ${JSON.stringify(info.env)}` : ''}\n    }\n  }\n}`,
      buildSnippetLang: () => 'json',
    },
    {
      id: 'antigravity',
      label: 'Antigravity',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: () => t('settings.mcpInstructionAntigravity'),
      buildSnippet: buildSharedMcpJson,
      buildSnippetLang: () => 'json',
    },
    {
      id: 'zed',
      label: 'Zed',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionZed', {
          shortcut: settingsShortcut(info.platform),
        }),
      buildSnippet: (info) => `{\n  "context_servers": {\n    "open-design": {\n      "source": "custom",\n      "command": ${JSON.stringify(info.command)},\n      "args": ${JSON.stringify(info.args)}${info.env && Object.keys(info.env).length > 0 ? `,\n      "env": ${JSON.stringify(info.env)}` : ''}\n    }\n  }\n}`,
      buildSnippetLang: () => 'json',
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      buildMethod: () => t('settings.mcpMethodJson'),
      buildInstruction: (info) =>
        t('settings.mcpInstructionWindsurf', {
          path: homeConfigPath(info.platform, '~/.codeium/windsurf/mcp_config.json', '%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json'),
        }),
      buildSnippet: buildSharedMcpJson,
      buildSnippetLang: () => 'json',
    },
  ];

  const [clientId, setClientId] = useState<McpClientId>('claude');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [info, setInfo] = useState<McpInstallInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // The reset is wired through a ref-driven timer rather than effect
  // cleanup so re-clicks during the 2s window restart the countdown.
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // Close the dropdown on outside click or Escape.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  // Pull the absolute paths to node + cli.js from the running daemon
  // so snippets work even when `od` isn't on PATH (the realistic
  // case for source clones, plus macOS/Linux ship a /usr/bin/od that
  // shadows any global install). Fetched on mount; if the daemon is
  // unreachable we surface a clear error instead of a half-built
  // snippet that would silently fail when pasted.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/mcp/install-info')
      .then(async (res) => {
        if (!res.ok) throw new Error(`daemon ${res.status}`);
        return (await res.json()) as McpInstallInfo;
      })
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        setInfoError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setInfoError(String(err && err.message ? err.message : err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const client = MCP_CLIENTS.find((c) => c.id === clientId) ?? MCP_CLIENTS[0]!;
  const snippet = info ? client.buildSnippet(info) : '';
  const snippetLang: 'bash' | 'json' | 'toml' = info
    ? client.buildSnippetLang(info)
    : 'json';

  // Reset the "Copied" badge when the user flips to a different
  // client; otherwise the green check sits there next to a snippet
  // they haven't actually copied.
  useEffect(() => {
    setCopied(false);
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
  }, [clientId]);

  const onCopy = async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail under non-secure contexts; the snippet
      // is selectable so the user can still copy manually.
      setCopied(false);
    }
  };

  return (
    <section className="settings-section">
      <div className="mcp-client-body">
        {infoError ? (
          <div
            className="empty-card"
            style={{ marginBottom: 14, color: 'var(--danger-fg, #f88)' }}
          >
            {t('settings.mcpDaemonError', { error: infoError! })}
          </div>
        ) : null}

        {/* Group 1: what the MCP server does */}
        <div className="mcp-capabilities-card">
          <p className="mcp-capabilities-label">
            {t('settings.mcpCapabilitiesTitle')}
          </p>
          <ul className="mcp-capabilities-list">
            <li>{t('settings.mcpCapabilityRead')}</li>
            <li>{t('settings.mcpCapabilityPull')}</li>
            <li>{t('settings.mcpCapabilityDefault')}</li>
          </ul>
        </div>

        {/* Group 2: setup flow */}
        <div className="mcp-setup-card">
          <div
            className="ds-picker"
            ref={pickerRef}
          >
          <button
            type="button"
            className={`ds-picker-trigger${pickerOpen ? ' open' : ''}`}
            onClick={() => setPickerOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={pickerOpen}
          >
            <span className="ds-picker-meta">
              <span className="ds-picker-title">{client.label}</span>
              <span className="ds-picker-sub">
                {info ? client.buildMethod(info) : ''}
              </span>
            </span>
            <Icon
              name="chevron-down"
              size={14}
              className="ds-picker-chevron"
              style={{ transform: pickerOpen ? 'rotate(180deg)' : undefined }}
            />
          </button>
          {pickerOpen ? (
            <div className="ds-picker-popover" role="listbox">
              <div className="ds-picker-list">
                {MCP_CLIENTS.map((c) => {
                  const active = c.id === clientId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`ds-picker-item${active ? ' active' : ''}`}
                      onClick={() => {
                        setClientId(c.id);
                        setPickerOpen(false);
                      }}
                    >
                      <span className="ds-picker-item-text">
                        <span className="ds-picker-item-title">{c.label}</span>
                        <span
                          style={{
                            fontSize: 11,
                            color: 'var(--text-muted)',
                          }}
                        >
                          {info ? c.buildMethod(info) : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        {info ? (
          <p style={{ margin: 0 }}>{client.buildInstruction(info)}</p>
        ) : null}

        {client.buildDeeplink && info ? (
          <div style={{ marginBottom: 12 }}>
            <button
              type="button"
              className="primary"
              onClick={() => {
                // Use a hidden anchor so the cursor:// scheme is
                // handled the same way as a normal link click; some
                // browsers block window.location assignments to
                // unknown schemes from button handlers.
                const url = client.buildDeeplink!(info);
                const a = document.createElement('a');
                a.href = url;
                a.rel = 'noopener noreferrer';
                a.click();
              }}
              disabled={!info.cliExists || !info.nodeExists}
              style={{ padding: '6px 14px', fontSize: 13 }}
            >
              <Icon name="link" size={14} />
              <span style={{ marginLeft: 6 }}>{client.deeplinkLabel ? client.deeplinkLabel() : ''}</span>
            </button>
            <span
              style={{
                marginLeft: 10,
                fontSize: 12,
                color: 'var(--fg-2, #9aa0a6)',
              }}
            >
              {t('settings.mcpCursorApproval')}
            </span>
          </div>
        ) : null}

        <div style={{ position: 'relative' }}>
          <pre
            style={{
              background: 'var(--surface-2, #11141a)',
              color: 'var(--fg-1, #e6e6e6)',
              // Reserve top clearance for the absolutely-positioned
              // Copy button so the first line of the snippet does not
              // sit underneath it, and reserve right clearance so a
              // wrapped bash one-liner stops short of the button rather
              // than scrolling behind it. The right padding is sized
              // for the wider "Copied" post-click state (icon + text +
              // button padding + the 8px right offset) with a few px
              // of buffer for elevated font sizes / zoom. Issue #632.
              padding: '40px 104px 12px 14px',
              borderRadius: 8,
              overflowX: 'auto',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: 12,
              lineHeight: 1.55,
              margin: 0,
              userSelect: 'text',
              whiteSpace: snippetLang === 'bash' ? 'pre-wrap' : 'pre',
              wordBreak: snippetLang === 'bash' ? 'break-all' : 'normal',
              minHeight: 60,
            }}
            data-lang={snippetLang}
          >
            <code>
              {snippet ||
                (infoError
                  ? t('settings.mcpResolvingFailed')
                  : t('settings.mcpLoadingPaths'))}
            </code>
          </pre>
          <button
            type="button"
            className="ghost mcp-copy-btn"
            onClick={onCopy}
            disabled={!snippet}
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              padding: '4px 10px',
              fontSize: 12,
            }}
            aria-label={t('settings.mcpCopyAria')}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            <span style={{ marginLeft: 6 }}>{copied ? t('settings.mcpCopied') : t('settings.mcpCopy')}</span>
          </button>
        </div>

        {/* "Build the daemon first" lives here — next to the code
            block it explains — rather than at the top of the section
            before the user has seen anything. A dev-mode pre-condition
            warning at the very top reads as "something is broken"
            before the user has even picked their client. */}
        {info && (!info.cliExists || !info.nodeExists) ? (
          <div
            className="empty-card"
            style={{ borderLeft: '3px solid var(--warning-fg, #fbbf24)' }}
          >
            <strong>
              {!info.cliExists
                ? t('settings.mcpBuildDaemon')
                : t('settings.mcpNodeMissing')}
            </strong>{' '}
            {info.buildHint ?? t('settings.mcpBuildHint')}
          </div>
        ) : null}

        {/* Restart note is a "next step" after running the command,
            not an error — keep it right after the code block. */}
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--bg-subtle)',
            border: '1px solid var(--od-border)',
            borderLeft: '3px solid var(--border-strong)',
            borderRadius: 6,
            fontSize: 13,
            lineHeight: 1.5,
          }}
        >
          <strong>{t('settings.mcpRestartNote')}</strong>{' '}
          <span style={{ color: 'var(--text-muted)' }}>
            {t('settings.mcpRestartDetail')}
          </span>
        </div>

          <p className="mcp-running-note">
            {t('settings.mcpRunningNote')}
          </p>
        </div>{/* end mcp-setup-card */}
      </div>
    </section>
  );
}
