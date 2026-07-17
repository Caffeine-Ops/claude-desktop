import { execAgentFile } from './invocation.js';
import { AGENT_DEFS } from './registry.js';
import { DEFAULT_MODEL_OPTION, rememberLiveModels } from './models.js';
import { applyAgentLaunchEnv, resolveAgentLaunch } from './launch.js';
import { spawnEnvForAgent } from './env.js';
import { probeAgentAuthStatus } from './auth.js';
import { agentCapabilities } from './capabilities.js';
import { installMetaForAgent } from './metadata.js';
import type {
  DetectedAgent,
  RuntimeAgentDef,
  RuntimeCapabilityMap,
  RuntimeModelSource,
  RuntimeModelOption,
} from './types.js';

type FetchedRuntimeModels = {
  models: RuntimeModelOption[];
  source: RuntimeModelSource;
};

async function fetchModels(
  def: RuntimeAgentDef,
  resolvedBin: string,
  env: NodeJS.ProcessEnv,
): Promise<FetchedRuntimeModels> {
  if (typeof def.fetchModels === 'function') {
    try {
      const parsed = await def.fetchModels(resolvedBin, env);
      if (!parsed || parsed.length === 0) {
        return { models: def.fallbackModels, source: 'fallback' };
      }
      return { models: parsed, source: 'live' };
    } catch {
      return { models: def.fallbackModels, source: 'fallback' };
    }
  }
  if (!def.listModels) {
    return { models: def.fallbackModels, source: 'fallback' };
  }
  try {
    const { stdout } = await execAgentFile(resolvedBin, def.listModels.args, {
      env,
      timeout: def.listModels.timeoutMs ?? 5000,
      // Models lists from popular CLIs (e.g. opencode) easily exceed the
      // default 1MB buffer once you include every openrouter model. Bump
      // it so we don't truncate the listing.
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = def.listModels.parse(String(stdout));
    // Empty / null parse result means the CLI didn't actually return a
    // usable list (e.g. cursor-agent's "No models available"); fall back
    // to the static hint so the picker isn't stuck on Default-only.
    if (!parsed || parsed.length === 0) {
      return { models: def.fallbackModels, source: 'fallback' };
    }
    return { models: parsed, source: 'live' };
  } catch {
    return { models: def.fallbackModels, source: 'fallback' };
  }
}

type VersionProbeOutcome =
  | { kind: 'not-invocable' }
  | { kind: 'spawned'; version: string | null };

/**
 * Run the agent's `--version` probe and classify the result. The probe
 * has two distinct failure modes the catch arm has to discriminate:
 *
 *   - **Not invocable.** The OS rejected the spawn outright (ENOENT
 *     for a vanished target, EACCES for a stripped-x bit, ENOTDIR
 *     for a broken parent), OR the wrapper script spawned but its
 *     underlying interpreter / target is missing and the shim exits
 *     with code 127 ("command not found") / 126 ("not executable").
 *     127 is the canonical POSIX shell signal for "I ran but the
 *     thing I delegate to is gone"; 126 is the perm/not-a-binary
 *     sibling. Both shapes are reproducible by leftover npm bin
 *     shims, mise/nvm/fnm pointer files, and Windows `.CMD` shims
 *     whose target was uninstalled. We mark the agent unavailable
 *     so Settings does not advertise a ghost entry (issue #658,
 *     lefarcen review P2 on PR #1301).
 *
 *   - **Spawned but `--version` was unhappy.** The binary itself ran
 *     (any other rejection: timeout, generic non-zero exit, stderr
 *     noise) so the CLI is invocable; we just can't read a version
 *     string. Adapters whose `--version` flag is unsupported land
 *     here and must keep working with `version: null`.
 *
 * `child_process.execFile` reports OS-level rejections with a string
 * `err.code` (`'ENOENT'`, `'EACCES'`, `'ENOTDIR'`) and non-zero exit
 * codes with a *numeric* `err.code` equal to the exit status, so the
 * two arms below are unambiguous.
 */
async function probeVersionAtPath(
  def: RuntimeAgentDef,
  resolved: string,
  env: NodeJS.ProcessEnv,
): Promise<VersionProbeOutcome> {
  try {
    const { stdout } = await execAgentFile(resolved, def.versionArgs, {
      env,
      timeout: 3000,
    });
    const version = String(stdout).trim().split('\n')[0] ?? null;
    return { kind: 'spawned', version };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (typeof code === 'string') {
      if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
        return { kind: 'not-invocable' };
      }
    } else if (typeof code === 'number' && (code === 126 || code === 127)) {
      return { kind: 'not-invocable' };
    }
    return { kind: 'spawned', version: null };
  }
}

function unavailableAgent(def: RuntimeAgentDef): DetectedAgent {
  return {
    ...stripFns(def),
    models: def.fallbackModels ?? [DEFAULT_MODEL_OPTION],
    modelsSource: 'fallback',
    available: false,
    ...installMetaForAgent(def.id),
  };
}

async function probe(
  def: RuntimeAgentDef,
  configuredEnv: Record<string, string> = {},
): Promise<DetectedAgent> {
  // Detection must probe the exact path the runtime will spawn, not just the
  // PATH-visible shim. This is load-bearing for Codex under nvm/fnm/mise:
  // the discovered `codex` entry is often a `#!/usr/bin/env node` wrapper
  // that is not invocable from a GUI-launched app's stripped PATH, while the
  // launch resolver can still upgrade it to the packaged native Codex binary.
  // If detection probes the shim but chat/run spawns the native binary, the
  // UI incorrectly reports "not installed" until the user pins CODEX_BIN by
  // hand even though the real launch path is healthy.
  const launch = resolveAgentLaunch(def, configuredEnv);
  if (!launch.selectedPath || !launch.launchPath) {
    return unavailableAgent(def);
  }
  const probeEnv = applyAgentLaunchEnv(
    spawnEnvForAgent(
      def.id,
      {
        ...process.env,
        ...(def.env || {}),
      },
      configuredEnv,
    ),
    launch,
  );
  const outcome = await probeVersionAtPath(def, launch.launchPath, probeEnv);
  if (outcome.kind === 'not-invocable') {
    return unavailableAgent(def);
  }
  // Probe `--help` once per agent and record which flags the installed CLI
  // advertises. Cached on `agentCapabilities` for buildArgs to consult.
  if (def.helpArgs && def.capabilityFlags) {
    const caps: RuntimeCapabilityMap = {};
    try {
      const { stdout } = await execAgentFile(launch.launchPath, def.helpArgs, {
        env: probeEnv,
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      });
      for (const [flag, key] of Object.entries(def.capabilityFlags)) {
        caps[key] = String(stdout).includes(flag);
      }
    } catch {
      // If --help fails, leave caps empty so buildArgs falls back to the safe
      // baseline (no optional flags).
    }
    agentCapabilities.set(def.id, caps);
  }
  const modelResult = await fetchModels(def, launch.launchPath, probeEnv);
  const auth = await probeAgentAuthStatus(def.id, launch.launchPath, probeEnv);
  return {
    ...stripFns(def),
    models: modelResult.models,
    modelsSource: modelResult.source,
    available: true,
    path: launch.selectedPath,
    version: outcome.version,
    ...(auth
      ? {
          authStatus: auth.status,
          ...(auth.message ? { authMessage: auth.message } : {}),
        }
      : {}),
    ...installMetaForAgent(def.id),
  };
}

function stripFns(
  def: RuntimeAgentDef,
): Omit<DetectedAgent, 'models' | 'modelsSource' | 'available' | 'path' | 'version'> {
  // Drop the buildArgs / listModels closures but keep declarative metadata
  // (reasoningOptions, streamFormat, name, bin, etc.). `models` is
  // populated separately by `fetchModels`, so we strip the static
  // `fallbackModels` slot here too. `helpArgs` / `capabilityFlags` /
  // `fallbackBins` / `maxPromptArgBytes` / `env` are probe-or-spawn-only
  // metadata and shouldn't bleed into the API response either.
  const {
    buildArgs,
    listModels,
    fetchModels,
    fallbackModels,
    helpArgs,
    capabilityFlags,
    fallbackBins,
    maxPromptArgBytes,
    env,
    ...rest
  } = def;
  return rest;
}

// ── 检测结果缓存 ────────────────────────────────────────────────────────
// 一次全量探测 = 对全部 agent def（17 个内置 + 本地 profiles）并行跑
// --version / --help / listModels / auth status——每个已安装 CLI 最多 4 次
// 子进程 spawn，且多为 node 冷启动。瞬时几十个进程把 CPU 打满：
// /api/agents 自身 5-7s，还把 daemon（单事件循环）同期的所有轻请求连坐
// 拖到秒级（2026-07-16 线上实测：config 4ms → 2.6s）。而检测输入在一次
// 会话里几乎不变——CLI 装卸 / re-auth / agentCliEnv 修改都是低频的用户
// 主动动作——所以默认返回缓存，规则如下：
//
//   - 缓存的是 **Promise**：并发调用（多个窗口 tab 同时 bootstrap 打
//     /api/agents）合并进同一次 in-flight 探测，不会各自掀进程风暴。
//   - key = agentCliEnv 的 JSON 序列化。env 一变 key 就换、立刻重探，
//     所以「改 env 后刷新」不依赖 TTL。
//   - TTL 只兜「用户在终端里装/卸/re-auth 而 UI 没人点刷新」的被动感知；
//     主动动作（设置页重新检测、HTTP ?refresh=1）传 { refresh: true }
//     无条件穿透。
//   - 探测 reject 时清掉缓存条目——瞬时失败不能被钉住一个 TTL。
//     （probe 内部把单 agent 失败吞成 unavailable，整体 reject 很罕见，
//     但语义上必须兜。）
//
// 单槽即可：agentCliEnv 全局只有一份（app-config），不存在多 key 并存，
// 换 key 直接覆盖旧槽。
const DETECT_CACHE_TTL_MS = 5 * 60_000;

type DetectCacheEntry = {
  key: string;
  promise: Promise<DetectedAgent[]>;
  /** null = 探测仍 in-flight；resolve 后打上时间戳供 TTL 判断。 */
  settledAt: number | null;
};

let detectCache: DetectCacheEntry | null = null;

export async function detectAgents(
  configuredEnvByAgent: Record<string, Record<string, string>> = {},
  options: { refresh?: boolean } = {},
) {
  const key = JSON.stringify(configuredEnvByAgent ?? {});
  const hit = detectCache;
  if (
    !options.refresh &&
    hit != null &&
    hit.key === key &&
    (hit.settledAt == null || Date.now() - hit.settledAt < DETECT_CACHE_TTL_MS)
  ) {
    return hit.promise;
  }
  const entry: DetectCacheEntry = {
    key,
    settledAt: null,
    promise: runDetection(configuredEnvByAgent),
  };
  detectCache = entry;
  entry.promise.then(
    () => {
      entry.settledAt = Date.now();
    },
    () => {
      if (detectCache === entry) detectCache = null;
    },
  );
  return entry.promise;
}

async function runDetection(
  configuredEnvByAgent: Record<string, Record<string, string>>,
): Promise<DetectedAgent[]> {
  const results = await Promise.all(
    AGENT_DEFS.map((def) => probe(def, configuredEnvByAgent?.[def.id] ?? {})),
  );
  // Refresh the validation cache from whatever we just surfaced to the UI
  // so /api/chat can accept any model the user could have just picked,
  // including ones that only showed up after a CLI re-auth.
  for (const agent of results) {
    rememberLiveModels(agent.id, agent.models);
  }
  return results;
}
