import { expandConfiguredEnv } from './paths.js';

type RuntimeEnvMap = NodeJS.ProcessEnv | Record<string, string>;

// Build the env passed to spawn() for a given agent adapter.
//
// The claude adapter strips ANTHROPIC_API_KEY so Claude Code's own auth
// resolution (claude login / Pro/Max plan) wins instead of silently
// falling back to API-key billing whenever the daemon happened to be
// launched from a shell that exported the key for SDK or scripting use.
// See issue #398.
//
// A custom ANTHROPIC_BASE_URL normally signals the user is intentionally
// routing Claude Code to a third-party gateway, in which case `claude login`
// is meaningless and the API key must be preserved. BUT we only honor that
// signal when it comes from the per-agent panel config (`configuredEnv`),
// NOT when it merely leaked in from the ambient process env. In this app the
// desktop shell loads env.json (a csdn.cloud gateway + gpt-5.4 model aliases)
// into process.env for the *fusion-code* desktop tab — and the daemon, spawned
// by that shell, inherits it. Without this distinction, picking "Local CLI /
// Claude Code" (the user's real anthropic.com login) gets silently hijacked
// onto csdn.cloud and reports gpt-5.4. So for the bundled-fusion-code use case
// the user explicitly wants: fusion-code keeps env.json, the local `claude`
// CLI does NOT. We therefore strip the whole ambient ANTHROPIC_* gateway set
// (base URL, auth token, API key, and the DEFAULT_*_MODEL aliases that force
// gpt-5.4) unless the panel config itself sets a base URL.
//
// The codex adapter has the symmetric problem: a stale BYOK
// OPENAI_API_KEY / CODEX_API_KEY left behind in app-config.json silently
// outranks Codex CLI's own `~/.codex/auth.json` (codex login) and trips
// 401 invalid_api_key whenever execution mode is switched back to
// Local CLI. Strip both keys unless the user has also configured a
// custom OPENAI_BASE_URL — i.e. they are intentionally routing Codex
// CLI through a third-party OpenAI-compatible gateway. See issue #2420.
//
// Windows env-var names are case-insensitive at the kernel level
// (`GetEnvironmentVariable`), but spreading `process.env` into a plain
// object loses Node's case-insensitive accessor — `Anthropic_Api_Key`
// would survive a literal `delete env.ANTHROPIC_API_KEY` and still reach
// the child. Iterate keys and compare case-insensitively to close that.
export function spawnEnvForAgent(
  agentId: string,
  baseEnv: RuntimeEnvMap,
  configuredEnv: unknown = {},
): NodeJS.ProcessEnv {
  const configured = expandConfiguredEnv(configuredEnv);
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...configured,
  };
  if (agentId === 'claude') {
    // Only an ANTHROPIC_BASE_URL coming from the panel config counts as an
    // intentional gateway. A base URL that merely leaked in from the ambient
    // process env (env.json's csdn.cloud, meant for the fusion-code desktop
    // tab) does NOT — strip the whole gateway set so the local `claude` CLI
    // falls back to its own anthropic.com login instead of being hijacked
    // onto csdn.cloud + gpt-5.4.
    if (!hasNonEmpty(configured, 'ANTHROPIC_BASE_URL')) {
      deleteKeys(env, [
        'ANTHROPIC_BASE_URL',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      ]);
    }
    return env;
  }
  if (agentId === 'codex') {
    stripUnlessCustomBaseUrl(env, 'OPENAI_BASE_URL', [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
    ]);
    return env;
  }
  return env;
}

// Case-insensitive "is this key set to a non-empty string" — same Windows
// casing caveat as stripUnlessCustomBaseUrl below.
function hasNonEmpty(env: RuntimeEnvMap, key: string): boolean {
  const upper = key.toUpperCase();
  return Object.keys(env).some(
    (k) =>
      k.toUpperCase() === upper &&
      typeof env[k] === 'string' &&
      (env[k] as string).trim() !== '',
  );
}

// Case-insensitive delete of every key in `keys` from `env`.
function deleteKeys(env: NodeJS.ProcessEnv, keys: readonly string[]): void {
  const upper = new Set(keys.map((k) => k.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (upper.has(key.toUpperCase())) delete env[key];
  }
}

// Remove `secretKeys` from `env` unless `baseUrlKey` is set to a non-empty
// value — in which case the user is intentionally routing the CLI through
// a custom endpoint and the secret is the credential that authenticates
// against it. Comparison is case-insensitive so Windows env names with
// mixed casing (`Openai_Api_Key`) cannot slip past a literal `delete`.
function stripUnlessCustomBaseUrl(
  env: NodeJS.ProcessEnv,
  baseUrlKey: string,
  secretKeys: readonly string[],
): void {
  const baseUrlKeyUpper = baseUrlKey.toUpperCase();
  const hasCustomBaseUrl = Object.keys(env).some(
    (k) =>
      k.toUpperCase() === baseUrlKeyUpper &&
      typeof env[k] === 'string' &&
      env[k].trim() !== '',
  );
  if (hasCustomBaseUrl) return;
  const secretKeysUpper = new Set(secretKeys.map((k) => k.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (secretKeysUpper.has(key.toUpperCase())) delete env[key];
  }
}
