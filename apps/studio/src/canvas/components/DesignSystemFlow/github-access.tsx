import { useState, type ReactNode } from 'react';
import type { ConnectorConnectResponse, ConnectorDetail, ConnectorStatusResponse } from '@open-design/contracts';
import { fetchConnectorStatuses } from '../../providers/registry';
import type { AppConfig } from '../../types';
import { Icon, type IconName } from '../shared/Icon';

export const GITHUB_CONNECTOR_ID = 'github';
const GITHUB_CONNECTOR_STATUS_TIMEOUT_MS = 5000;

type AccessBadgeTone = 'muted' | 'success' | 'warning' | 'danger' | 'loading';

interface GitHubAccessMethod {
  id: string;
  icon: IconName;
  title: string;
  badge: string;
  tone: AccessBadgeTone;
  description: string;
  action?: ReactNode;
  note?: string | null;
}

export function GitHubRepositoryAccessPanel({
  composioConfigured,
  connector,
  loading,
  action,
  authorizationPending,
  authorizationUrl,
  error,
  onOpenConnectorsTab,
  onConnect,
  onOpenAuthorization,
  onDisconnect,
}: {
  composioConfigured: boolean;
  connector: ConnectorDetail | null;
  loading: boolean;
  action: 'connect' | 'disconnect' | null;
  authorizationPending: boolean;
  authorizationUrl: string | null;
  error: string | null;
  onOpenConnectorsTab?: () => void;
  onConnect: () => void;
  onOpenAuthorization: () => void;
  onDisconnect: () => void;
}) {
  const [methodsExpanded, setMethodsExpanded] = useState(false);
  const connected = isGithubConnectorConnected(connector);
  const account = getDisplayableGithubAccountLabel(connector);
  const busy = action !== null;
  let composioBadge = 'Optional';
  let composioTone: AccessBadgeTone = 'muted';
  let composioDescription = 'Composio GitHub connector access for agent tools; repo URLs still work with local git or GitHub CLI.';
  let composioIcon: IconName = 'settings';

  if (!composioConfigured) {
    composioBadge = 'Not configured';
    composioDescription = 'Add a Composio API key only if this project needs connector-backed GitHub tools.';
  } else if (connected) {
    composioBadge = 'Connected';
    composioTone = 'success';
    composioIcon = 'github';
    composioDescription = account
      ? `Composio GitHub connector connected as ${account}; it is available as fallback when this device cannot read the repository.`
      : 'Composio GitHub connector is available as fallback when this device cannot read the repository.';
  } else if (authorizationPending) {
    composioBadge = 'Pending';
    composioTone = 'warning';
    composioIcon = 'external-link';
    composioDescription = 'Finish the Composio authorization window; local GitHub intake remains available.';
  } else if (loading) {
    composioBadge = 'Checking';
    composioTone = 'loading';
    composioIcon = 'spinner';
    composioDescription = 'Checking connector status in the background; URL intake is not blocked.';
  } else if (error) {
    composioBadge = 'Needs attention';
    composioTone = 'warning';
  } else if (connector?.status === 'error') {
    composioBadge = 'Needs attention';
    composioTone = 'danger';
    composioDescription = 'Reconnect the Composio GitHub connector, or continue with local git/GitHub CLI.';
  }

  const composioAction = !composioConfigured ? (
    <button type="button" className="ghost" onClick={onOpenConnectorsTab}>
      Configure Composio
    </button>
  ) : connected || authorizationPending ? (
    <>
      {authorizationPending && authorizationUrl ? (
        <button type="button" className="ghost" disabled={busy} onClick={onOpenAuthorization}>
          Open authorization
        </button>
      ) : null}
      <button type="button" className="ghost" disabled={busy} onClick={onDisconnect}>
        {action === 'disconnect' ? 'Disconnecting...' : 'Disconnect'}
      </button>
    </>
  ) : (
    <button type="button" className="ghost" disabled={busy} onClick={onConnect}>
      {action === 'connect' ? 'Connecting...' : 'Connect via Composio'}
    </button>
  );

  const methods: GitHubAccessMethod[] = [
    {
      id: 'local',
      icon: 'github',
      title: 'This device',
      badge: 'Automatic',
      tone: 'success',
      description: 'Uses public git clone, local git credentials, or GitHub CLI auth available on this machine.',
    },
    {
      id: 'native-oauth',
      icon: 'link',
      title: 'Open Design account',
      badge: 'Coming soon',
      tone: 'muted',
      description: 'Native GitHub sign-in managed by Open Design; this build does not use an OD-managed GitHub token yet.',
    },
    {
      id: 'composio',
      icon: composioIcon,
      title: 'Connector platform',
      badge: composioBadge,
      tone: composioTone,
      description: composioDescription,
      action: composioAction,
      note: error,
    },
  ];

  return (
    <div
      className={[
        'ds-github-access-panel',
        connected ? 'has-connected-connector' : '',
      ].filter(Boolean).join(' ')}
    >
      <div className="ds-github-access-header">
        <span>
          <strong>Repository access: Auto</strong>
          <p>Paste a GitHub URL. Open Design will use the first working access method.</p>
        </span>
        <button
          type="button"
          className="ghost ds-github-access-toggle"
          aria-expanded={methodsExpanded}
          aria-controls="ds-github-access-methods"
          onClick={() => setMethodsExpanded((current) => !current)}
        >
          <Icon name={methodsExpanded ? 'chevron-down' : 'chevron-right'} />
          {methodsExpanded ? 'Hide access methods' : 'Show access methods'}
        </button>
      </div>
      <div
        id="ds-github-access-methods"
        className={`accordion-collapsible ${methodsExpanded ? 'open' : ''}`}
        hidden={!methodsExpanded}
        aria-hidden={!methodsExpanded}
      >
        <div className="accordion-collapsible-inner">
          <div className="ds-github-access-methods" aria-label="GitHub repository access methods">
            {methods.map((method) => (
              <div key={method.id} className="ds-github-access-method">
                <Icon name={method.icon} />
                <span className="ds-github-access-method-copy">
                  <span className="ds-github-access-method-title">
                    <strong>{method.title}</strong>
                    <small className={`ds-github-access-badge is-${method.tone}`}>{method.badge}</small>
                  </span>
                  <p>{method.description}</p>
                  {method.note ? <em>{method.note}</em> : null}
                  {method.action ? <span className="ds-github-access-actions">{method.action}</span> : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function getDisplayableGithubAccountLabel(connector: ConnectorDetail | null): string | null {
  const label = connector?.accountLabel?.trim();
  if (!label) return null;
  // Composio may surface its connected-account id (`ca_...`) as the label.
  // That is useful internally, but it reads like a broken GitHub username in
  // this setup flow.
  if (/^ca_[A-Za-z0-9_-]+$/.test(label)) return null;
  return label;
}

export function openConnectorAuthorizationUrl(url: string | null): void {
  if (!url) return;
  const opened = window.open(url, '_blank');
  if (!opened) window.location.assign(url);
}

export function isComposioConfigured(composio: AppConfig['composio'] | undefined): boolean {
  return Boolean(composio?.apiKeyConfigured || composio?.apiKey?.trim());
}

export function isGithubConnectorConnected(connector: ConnectorDetail | null): boolean {
  return connector?.status === 'connected';
}

export async function fetchGithubConnectorStatusWithTimeout(): Promise<{ connector: ConnectorDetail | null; timedOut: boolean }> {
  let timeoutId: number | undefined;
  let timedOut = false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  try {
    const timeout = new Promise<null>((resolve) => {
      timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller?.abort();
        resolve(null);
      }, GITHUB_CONNECTOR_STATUS_TIMEOUT_MS);
    });
    const statuses = await Promise.race([
      fetchConnectorStatuses(controller ? { signal: controller.signal } : undefined),
      timeout,
    ]);
    return { connector: githubConnectorFromStatus(statuses?.[GITHUB_CONNECTOR_ID]), timedOut };
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

function githubConnectorFromStatus(
  status: ConnectorStatusResponse['statuses'][string] | undefined,
): ConnectorDetail | null {
  if (!status) return null;
  return {
    id: GITHUB_CONNECTOR_ID,
    name: 'GitHub',
    provider: 'composio',
    category: 'developer tools',
    status: status.status,
    tools: [],
    ...(status.accountLabel === undefined ? {} : { accountLabel: status.accountLabel }),
    ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
  };
}

export function isPendingConnectorAuth(auth: ConnectorConnectResponse['auth'] | undefined): boolean {
  return auth?.kind === 'redirect_required' || auth?.kind === 'pending';
}

export function isTrustedConnectorCallbackOrigin(origin: string, currentOrigin?: string): boolean {
  const expectedOrigin = currentOrigin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  if (origin === expectedOrigin) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '[::1]'
      || url.hostname === '::1';
  } catch {
    return false;
  }
}
