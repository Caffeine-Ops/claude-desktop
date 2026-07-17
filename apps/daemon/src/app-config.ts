// Daemon-backed app preferences (onboarding state, agent/skill/DS selection).
//
// The web frontend pushes preferences here via PUT /api/app-config; the
// daemon persists them to <dataDir>/app-config.json (where dataDir defaults
// to <projectRoot>/.od but follows OD_DATA_DIR when set, keeping test and
// multi-namespace runs isolated). This survives browser storage resets and
// origin changes so onboarding and agent selection don't reappear unexpectedly.
//
// `agentCliEnv` is intentionally limited by allowlist below. It may include
// proxy/auth overrides for local CLIs (for example ANTHROPIC_BASE_URL +
// ANTHROPIC_API_KEY for Claude Code, or OPENAI_BASE_URL + OPENAI_API_KEY for
// Codex). Those values are local-only and should not be logged or returned
// outside this machine.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

// Plugin-system env knobs. See docs/plans/plugins-implementation.md F6 / F9.
// Phase 1 only reads them; the GC worker that enforces snapshot expiry lands
// in Phase 5. Centralized here to keep daemon modules from sprinkling magic
// numbers across the codebase.
export interface PluginEnvKnobs {
  // Hard ceiling on devloop iterations per stage (spec §10.2).
  maxDevloopIterations: number;
  // Days before an unreferenced applied_plugin_snapshots row expires. A
  // value of 0 means "keep forever" (operators can opt out of GC entirely).
  snapshotUnreferencedTtlDays: number;
  // Optional cap on how long even a referenced snapshot stays around once
  // its run/conversation/project is terminal. Default unset -> unlimited.
  snapshotRetentionDays: number | null;
  // GC worker tick interval. Phase 5 reads this; Phase 1 just exposes the
  // knob through `od config get` so operators can plan ahead.
  snapshotGcIntervalMs: number;
}

function intFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function nullableIntFromEnv(key: string): number | null {
  const raw = process.env[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

export function readPluginEnvKnobs(): PluginEnvKnobs {
  return {
    maxDevloopIterations:        intFromEnv('OD_MAX_DEVLOOP_ITERATIONS', 10),
    snapshotUnreferencedTtlDays: intFromEnv('OD_SNAPSHOT_UNREFERENCED_TTL_DAYS', 30),
    snapshotRetentionDays:       nullableIntFromEnv('OD_SNAPSHOT_RETENTION_DAYS'),
    snapshotGcIntervalMs:        intFromEnv('OD_SNAPSHOT_GC_INTERVAL_MS', 6 * 60 * 60 * 1000),
  };
}

export interface AgentModelPrefs {
  model?: string;
  reasoning?: string;
}

export type AgentCliEnvPrefs = Record<string, Record<string, string>>;

export interface TelemetryPrefs {
  metrics?: boolean;
  content?: boolean;
  artifactManifest?: boolean;
}

export interface OrbitConfigPrefs {
  enabled: boolean;
  time: string;
  templateSkillId?: string | null;
}

// Mirror of @open-design/contracts ThemeOverridesPrefs / AppearancePrefs.
// The daemon keeps its own copy (it doesn't import the contracts package) so
// the validators below can run without a dependency on the shared types.
// Keep these two in sync with packages/contracts/src/api/app-config.ts.
export interface ThemeOverridesPrefs {
  presetName?: string;
  accent?: string;
  background?: string;
  foreground?: string;
  contrast?: number;
  translucentSidebar?: boolean;
}

// Sits at the top of AppearancePrefs (not inside light/dark) — one image
// serves both modes; the veil opacity is derived from the semantic
// --card/--sidebar tokens at apply time, so it repaints for free on mode
// flip. themeId absent/null means the feature is off.
export interface BackgroundPrefs {
  themeId?: string | null;
  scrim?: number;
  focusX?: number;
  focusY?: number;
}

export interface AppearancePrefs {
  themeMode?: 'light' | 'dark' | 'system';
  light?: ThemeOverridesPrefs;
  dark?: ThemeOverridesPrefs;
  uiFontSize?: number;
  codeFontSize?: number;
  usePointerCursor?: boolean;
  background?: BackgroundPrefs;
}

export interface AppConfigPrefs {
  onboardingCompleted?: boolean;
  agentId?: string | null;
  agentModels?: Record<string, AgentModelPrefs>;
  agentCliEnv?: AgentCliEnvPrefs;
  skillId?: string | null;
  designSystemId?: string | null;
  disabledSkills?: string[];
  disabledDesignSystems?: string[];
  installationId?: string | null;
  telemetry?: TelemetryPrefs;
  privacyDecisionAt?: number | null;
  orbit?: OrbitConfigPrefs;
  customInstructions?: string | null;
  appearance?: AppearancePrefs;
}

const ALLOWED_KEYS: ReadonlySet<keyof AppConfigPrefs> = new Set([
  'onboardingCompleted',
  'agentId',
  'agentModels',
  'agentCliEnv',
  'skillId',
  'designSystemId',
  'disabledSkills',
  'disabledDesignSystems',
  'installationId',
  'telemetry',
  'privacyDecisionAt',
  'orbit',
  'customInstructions',
  'appearance',
] as const);

function configFile(dataDir: string): string {
  return path.join(dataDir, 'app-config.json');
}

const AGENT_MODEL_KEYS: ReadonlySet<string> = new Set(['model', 'reasoning']);

const TELEMETRY_KEYS: ReadonlySet<string> = new Set([
  'metrics',
  'content',
  'artifactManifest',
]);

function validateTelemetry(raw: unknown): TelemetryPrefs | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, boolean> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor') continue;
    if (!TELEMETRY_KEYS.has(k)) continue;
    if (typeof v === 'boolean') result[k] = v;
  }
  return Object.keys(result).length > 0 ? (result as TelemetryPrefs) : undefined;
}

const AGENT_CLI_ENV_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['claude', new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_BIN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'])],
  ['codex', new Set(['CODEX_HOME', 'CODEX_BIN', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'OPENAI_API_KEY'])],
  ['copilot', new Set(['COPILOT_BIN'])],
  ['cursor-agent', new Set(['CURSOR_AGENT_BIN'])],
  ['deepseek', new Set(['DEEPSEEK_BIN'])],
  ['devin', new Set(['DEVIN_BIN'])],
  ['gemini', new Set(['GEMINI_BIN'])],
  ['hermes', new Set(['HERMES_BIN'])],
  ['kimi', new Set(['KIMI_BIN'])],
  ['kiro', new Set(['KIRO_BIN'])],
  ['kilo', new Set(['KILO_BIN'])],
  ['opencode', new Set(['OPENCODE_BIN'])],
  ['pi', new Set(['PI_BIN'])],
  ['qoder', new Set(['QODER_BIN'])],
  ['qwen', new Set(['QWEN_BIN'])],
  ['vibe', new Set(['VIBE_BIN'])],
]);

function isValidAgentModelEntry(v: unknown): v is AgentModelPrefs {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!AGENT_MODEL_KEYS.has(k)) return false;
    if (obj[k] !== undefined && typeof obj[k] !== 'string') return false;
  }
  return true;
}

function validateAgentModels(
  raw: unknown,
): Record<string, AgentModelPrefs> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, AgentModelPrefs> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor') continue;
    if (isValidAgentModelEntry(v)) {
      result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function validateAgentCliEnv(raw: unknown): AgentCliEnvPrefs | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: AgentCliEnvPrefs = Object.create(null);
  for (const [agentId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (agentId === '__proto__' || agentId === 'constructor') continue;
    const allowed = AGENT_CLI_ENV_KEYS.get(agentId);
    if (!allowed || typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }
    const env: Record<string, string> = Object.create(null);
    for (const [envKey, envValue] of Object.entries(value as Record<string, unknown>)) {
      if (!allowed.has(envKey)) continue;
      if (typeof envValue !== 'string') continue;
      const trimmed = envValue.trim();
      if (!trimmed) continue;
      env[envKey] = trimmed;
    }
    if (Object.keys(env).length > 0) result[agentId] = env;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function isValidOrbitTime(time: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function validateOrbit(raw: unknown): OrbitConfigPrefs | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : false;
  const time = typeof obj.time === 'string' && isValidOrbitTime(obj.time)
    ? obj.time
    : '08:00';
  const orbit: OrbitConfigPrefs = { enabled, time };

  if (Object.hasOwn(obj, 'templateSkillId')) {
    orbit.templateSkillId = typeof obj.templateSkillId === 'string' && obj.templateSkillId.trim()
      ? obj.templateSkillId.trim()
      : null;
  }

  return orbit;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const THEME_OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  'presetName',
  'accent',
  'background',
  'foreground',
  'contrast',
  'translucentSidebar',
]);

const BACKGROUND_KEYS: ReadonlySet<string> = new Set([
  'themeId',
  'scrim',
  'focusX',
  'focusY',
]);

// 'preset-*' (bundled, generated at build time) or 'u-<id>' (user-imported,
// written by the background-theme import IPC). This regex is also the first
// line of defense against path traversal — the main-process theme lookup
// re-derives a userData-relative path from this id, so anything outside
// [a-z0-9-] never reaches the filesystem.
const BACKGROUND_THEME_ID = /^[a-z0-9-]{1,64}$/;

// Font-size bounds mirror the desktop appearance store's clamps so a value
// written by either frontend stays inside the range the other will render.
const UI_FONT_MIN = 11;
const UI_FONT_MAX = 18;
const CODE_FONT_MIN = 10;
const CODE_FONT_MAX = 18;

function clampNumber(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

function validateThemeOverrides(raw: unknown): ThemeOverridesPrefs | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor') continue;
    if (!THEME_OVERRIDE_KEYS.has(k)) continue;
    if (k === 'presetName') {
      if (typeof v === 'string') result[k] = v.slice(0, 64);
    } else if (k === 'accent' || k === 'background' || k === 'foreground') {
      // Only accept #rrggbb. A malformed color would otherwise be written onto
      // documentElement.style verbatim and silently break the theme.
      if (typeof v === 'string' && HEX_COLOR.test(v.trim())) {
        result[k] = v.trim().toLowerCase();
      }
    } else if (k === 'contrast') {
      if (typeof v === 'number' && Number.isFinite(v)) {
        result[k] = clampNumber(v, 0, 100);
      }
    } else if (k === 'translucentSidebar') {
      if (typeof v === 'boolean') result[k] = v;
    }
  }
  return Object.keys(result).length > 0
    ? (result as ThemeOverridesPrefs)
    : undefined;
}

function validateBackground(raw: unknown): BackgroundPrefs | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor') continue;
    if (!BACKGROUND_KEYS.has(k)) continue;
    if (k === 'themeId') {
      if (v === null) result[k] = null;
      else if (typeof v === 'string' && BACKGROUND_THEME_ID.test(v)) result[k] = v;
    } else if (k === 'scrim') {
      if (typeof v === 'number' && Number.isFinite(v)) result[k] = clampNumber(v, 0, 100);
    } else if (k === 'focusX' || k === 'focusY') {
      // Not clampNumber: focus is a 0-1 fraction, not a percent, and must
      // stay unrounded or the applier's background-position math degrades
      // to 0%/100% steps.
      if (typeof v === 'number' && Number.isFinite(v)) {
        result[k] = Math.max(0, Math.min(1, v));
      }
    }
  }
  return Object.keys(result).length > 0
    ? (result as BackgroundPrefs)
    : undefined;
}

function validateAppearance(raw: unknown): AppearancePrefs | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const result: AppearancePrefs = Object.create(null);

  if (
    obj.themeMode === 'light' ||
    obj.themeMode === 'dark' ||
    obj.themeMode === 'system'
  ) {
    result.themeMode = obj.themeMode;
  }

  const light = validateThemeOverrides(obj.light);
  if (light) result.light = light;
  const dark = validateThemeOverrides(obj.dark);
  if (dark) result.dark = dark;

  if (typeof obj.uiFontSize === 'number' && Number.isFinite(obj.uiFontSize)) {
    result.uiFontSize = clampNumber(obj.uiFontSize, UI_FONT_MIN, UI_FONT_MAX);
  }
  if (
    typeof obj.codeFontSize === 'number' &&
    Number.isFinite(obj.codeFontSize)
  ) {
    result.codeFontSize = clampNumber(
      obj.codeFontSize,
      CODE_FONT_MIN,
      CODE_FONT_MAX,
    );
  }
  if (typeof obj.usePointerCursor === 'boolean') {
    result.usePointerCursor = obj.usePointerCursor;
  }

  const background = validateBackground(obj.background);
  if (background) result.background = background;

  return Object.keys(result).length > 0 ? result : undefined;
}

export function agentCliEnvForAgent(
  prefs: AgentCliEnvPrefs | undefined,
  agentId: string,
): Record<string, string> {
  if (!prefs || typeof agentId !== 'string') return {};
  const env = prefs[agentId];
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  return { ...env };
}

function applyConfigValue(
  target: Record<string, unknown>,
  key: keyof AppConfigPrefs,
  value: unknown,
): void {
  if (key === 'onboardingCompleted') {
    if (typeof value === 'boolean') target[key] = value;
    return;
  }
  if (key === 'agentId' || key === 'skillId' || key === 'designSystemId') {
    if (typeof value === 'string' || value === null) target[key] = value;
    return;
  }
  if (key === 'agentModels') {
    const validated = validateAgentModels(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
  }
  if (key === 'agentCliEnv') {
    const validated = validateAgentCliEnv(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
  }
  if (key === 'disabledSkills' || key === 'disabledDesignSystems') {
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      target[key] = value;
    } else {
      delete target[key];
    }
  }
  if (key === 'installationId') {
    if (typeof value === 'string' || value === null) target[key] = value;
    return;
  }
  if (key === 'telemetry') {
    const validated = validateTelemetry(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
  }
  if (key === 'privacyDecisionAt') {
    if (
      value === null ||
      (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    ) {
      target[key] = value;
    } else {
      delete target[key];
    }
    return;
  }
  if (key === 'orbit') {
    const validated = validateOrbit(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
  }
  if (key === 'customInstructions') {
    if (typeof value === 'string') {
      target[key] = value.slice(0, 5000);
    } else if (value === null) {
      target[key] = value;
    }
    return;
  }
  if (key === 'appearance') {
    const validated = validateAppearance(value);
    if (validated === undefined) return;
    // Deep-merge into any existing appearance so a partial PUT (e.g. the web
    // tab sending only `{ themeMode }`) doesn't wipe the per-mode colors the
    // desktop shell wrote earlier. `light`/`dark` are merged one level deeper
    // for the same reason — patching `light.accent` must not drop
    // `light.background`. (`target` is a shallow clone of the stored config in
    // doWrite, so reading target.appearance here gives the prior value.)
    const prev = (target[key] as AppearancePrefs | undefined) ?? {};
    const merged: AppearancePrefs = { ...prev, ...validated };
    if (prev.light || validated.light) {
      merged.light = { ...prev.light, ...validated.light };
    }
    if (prev.dark || validated.dark) {
      merged.dark = { ...prev.dark, ...validated.dark };
    }
    // Same reasoning as light/dark above: a scrim-only patch from the
    // settings slider must not wipe the themeId the import flow just wrote.
    if (prev.background || validated.background) {
      merged.background = { ...prev.background, ...validated.background };
    }
    target[key] = merged;
    return;
  }
}

function filterAllowedKeys(obj: Record<string, unknown>): AppConfigPrefs {
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(obj)) {
    if (ALLOWED_KEYS.has(key as keyof AppConfigPrefs)) {
      applyConfigValue(result, key as keyof AppConfigPrefs, obj[key]);
    }
  }
  return result as AppConfigPrefs;
}

export async function readAppConfig(dataDir: string): Promise<AppConfigPrefs> {
  try {
    const raw = await readFile(configFile(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return filterAllowedKeys(parsed as Record<string, unknown>);
    }
    console.warn('[app-config] Invalid shape in config file, returning empty');
    return {};
  } catch (err: unknown) {
    const e = err as { code?: string; name?: string; message?: string };
    if (e.code === 'ENOENT') return {};
    if (e.name === 'SyntaxError') {
      console.error('[app-config] Corrupted JSON, returning empty:', e.message);
      return {};
    }
    throw err;
  }
}

// Serialize concurrent writes to the same dataDir so the read-modify-write
// cycle doesn't lose updates when two PUT requests overlap.
const writeLocks = new Map<string, Promise<unknown>>();

export async function writeAppConfig(
  dataDir: string,
  partial: Record<string, unknown>,
): Promise<AppConfigPrefs> {
  const prev = writeLocks.get(dataDir) ?? Promise.resolve();
  const task = prev.catch(() => {}).then(() => doWrite(dataDir, partial));
  writeLocks.set(dataDir, task);
  try {
    return await task;
  } finally {
    if (writeLocks.get(dataDir) === task) writeLocks.delete(dataDir);
  }
}

async function doWrite(
  dataDir: string,
  partial: Record<string, unknown>,
): Promise<AppConfigPrefs> {
  const existing = await readAppConfig(dataDir);
  const next: Record<string, unknown> = { ...existing };
  for (const key of Object.keys(partial)) {
    if (!ALLOWED_KEYS.has(key as keyof AppConfigPrefs)) continue;
    applyConfigValue(next, key as keyof AppConfigPrefs, partial[key]);
  }
  const file = configFile(dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp';
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await rename(tmp, file);
  return next as AppConfigPrefs;
}
