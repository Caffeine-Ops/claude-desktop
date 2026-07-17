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
  /** Local 24-hour clock time in HH:mm format. Defaults to 08:00. */
  time: string;
  /** Optional skill id from the examples gallery where scenario === "orbit". */
  templateSkillId?: string | null;
}

/**
 * One theme's color/contrast overrides. Modelled on the desktop app's
 * `ThemeOverrides` so the daemon can hold the richer desktop shape as a
 * superset; the web frontend (single accent + theme) maps onto a subset.
 *
 * Colors are `#rrggbb` hex strings — they round-trip cleanly to/from JSON
 * and both frontends convert them to their own CSS variable formats (the
 * desktop applier turns hex into `"H S% L%"`, the web one feeds hex into
 * `color-mix`). Keeping the canonical store as hex avoids baking either
 * frontend's CSS representation into the cross-process contract.
 */
export interface ThemeOverridesPrefs {
  presetName?: string;
  accent?: string;
  background?: string;
  foreground?: string;
  contrast?: number;
  translucentSidebar?: boolean;
}

/**
 * Background art (wallpaper) preferences. Sits at the top of `AppearancePrefs`
 * rather than inside `light`/`dark` — one image serves both modes, the veil
 * opacity is derived from the semantic `--card`/`--sidebar` tokens at apply
 * time so it repaints for free when the mode flips. `themeId` absent/null
 * means the feature is off and every consumer must render byte-identical to
 * pre-feature output.
 */
export interface BackgroundPrefs {
  /** `preset-*` (bundled) or `u-<id>` (user-imported). Null/absent = off. */
  themeId?: string | null;
  /** Veil strength, 0-100. Defaults to 55. */
  scrim?: number;
  /** 0-1 focal point override; unset falls back to the theme's analyzed focus. */
  focusX?: number;
  focusY?: number;
}

/**
 * Cross-process appearance preferences. The daemon is the single source of
 * truth for theme so the desktop shell and the embedded Open Design web tab
 * stay in lockstep — both read this on boot and write every change back.
 *
 * The shape is a superset of what either frontend exposes today:
 *  - desktop drives all of it (per-mode overrides + font sizes + cursor).
 *  - web maps `themeMode` ↔ its `theme`, and writes its single accent into
 *    whichever mode (`light`/`dark`) is currently effective.
 *
 * Every field is optional so a partial PUT only patches what changed and an
 * older daemon config (missing `appearance`) rehydrates without crashing.
 */
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
  /**
   * Unix-millis timestamp of when the user resolved the first-run privacy
   * consent surface (Share or Decline). Set on first decision and on
   * subsequent toggles in Settings → Privacy. Independent of
   * installationId so that "Delete my data" can rotate the id without
   * re-popping the consent banner.
   */
  privacyDecisionAt?: number | null;
  orbit?: OrbitConfigPrefs;
  customInstructions?: string | null;
  /**
   * Theme / appearance preferences shared between the desktop shell and the
   * embedded web tab. See `AppearancePrefs`. Absent on configs written before
   * this field existed — both frontends fall back to their local defaults.
   */
  appearance?: AppearancePrefs;
}

export interface AppConfigResponse {
  config: AppConfigPrefs;
}

export type UpdateAppConfigRequest = Partial<AppConfigPrefs>;
