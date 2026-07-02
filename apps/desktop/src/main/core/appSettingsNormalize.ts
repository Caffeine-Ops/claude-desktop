/**
 * Pure normalization functions for appSettings.
 * Separated from appSettings.ts to be testable without loading the electron module.
 */

import type { ImageApiConfig } from '../services/imageGenService'

export type CliBackend = 'bundled' | 'system'

export interface AppSettings {
  cliBackend: CliBackend
  imageApi?: ImageApiConfig
}

/**
 * Normalize imageApi from raw input. Returns undefined if invalid (not an object,
 * apiKey/baseURL not strings). Defaults model to 'gpt-image-2' if missing.
 */
export function normalizeImageApi(raw: unknown): ImageApiConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.apiKey !== 'string' || typeof r.baseURL !== 'string') return undefined
  return {
    apiKey: r.apiKey,
    baseURL: r.baseURL,
    model: typeof r.model === 'string' && r.model ? r.model : 'gpt-image-2'
  }
}

/**
 * Defensive field-by-field normalization so a malformed file doesn't poison
 * the engine. Unknown keys are dropped; invalid values are coerced to defaults.
 */
export function normalize(raw: Partial<AppSettings>): Partial<AppSettings> {
  const out: Partial<AppSettings> = {}
  if (raw.cliBackend === 'bundled' || raw.cliBackend === 'system') {
    out.cliBackend = raw.cliBackend
  }
  if (raw.imageApi !== undefined) {
    const img = normalizeImageApi(raw.imageApi)
    if (img) out.imageApi = img
  }
  return out
}
