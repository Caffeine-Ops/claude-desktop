import { MANUAL_EDIT_STYLE_PROPS, type ManualEditStyles } from '../../edit-mode/types';
import type { ManualEditPendingStyleSave } from './types';

export function mergeManualEditInspectorStyles(
  sourceStyles: ManualEditStyles,
  previewStyles: ManualEditStyles,
): ManualEditStyles {
  return MANUAL_EDIT_STYLE_PROPS.reduce<ManualEditStyles>((acc, key) => {
    const sourceValue = sourceStyles[key]?.trim();
    const previewValue = previewStyles[key]?.trim();
    const value = sourceValue || previewValue || '';
    acc[key] = manualEditInspectorStyleValue(key, value);
    return acc;
  }, {} as ManualEditStyles);
}

export function manualEditInspectorStyleValue(key: keyof ManualEditStyles, value: string): string {
  if (!value) return '';
  if (key === 'color' || key === 'backgroundColor' || key === 'borderColor') {
    return normalizeManualEditInspectorColor(value);
  }
  return value;
}

function normalizeManualEditInspectorColor(value: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const r = trimmed[1]!, g = trimmed[2]!, b = trimmed[3]!;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const rgba = trimmed.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (!rgba) return trimmed;
  if (rgba[4] !== undefined && Number(rgba[4]) === 0) return '';
  const toHex = (raw: string) => Math.max(0, Math.min(255, Math.round(Number(raw))))
    .toString(16)
    .padStart(2, '0');
  return `#${toHex(rgba[1]!)}${toHex(rgba[2]!)}${toHex(rgba[3]!)}`;
}

export function manualEditPersistedValueMatchesSavedSnapshot(
  key: keyof ManualEditStyles,
  persistedValue: string,
  savedValue: string,
): boolean {
  return canonicalManualEditStyleValue(key, persistedValue) === canonicalManualEditStyleValue(key, savedValue);
}

function canonicalManualEditStyleValue(key: keyof ManualEditStyles, value: string): string {
  const normalized = manualEditInspectorStyleValue(key, value).trim();
  if (!normalized) return '';
  return normalized.toLowerCase();
}

export function cancelManualEditPendingStyleSnapshot(
  pending: ManualEditPendingStyleSave | null,
  id: string,
  keys: Array<keyof ManualEditStyles>,
): ManualEditPendingStyleSave | null {
  if (!pending || pending.id !== id || keys.length === 0) return pending;
  const nextStyles = { ...pending.styles };
  for (const key of keys) delete nextStyles[key];
  if (Object.keys(nextStyles).length === 0) return null;
  return { ...pending, styles: nextStyles };
}
