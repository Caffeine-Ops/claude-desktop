import type { AgentModelOption } from '../../types';

// Group model options for a model picker. When the list contains
// `provider/model` ids (opencode's listing has hundreds), we group them
// by provider so the dropdown is navigable. Flat lists (Claude, Codex,
// Gemini, Qwen) stay ungrouped.
//
// `'default'` is always pinned first (no group), so the user can return
// to "let the CLI decide" with one click.
//
// Pure data shaping — shared by the native-<select> renderer below
// (AvatarMenu, still on the canvas stack) and the shadcn Select renderer
// in SettingsDialog（chat 栈，SelectGroup/SelectLabel 对应 optgroup）.
export function groupModelOptions(models: AgentModelOption[]): {
  flat: AgentModelOption[];
  groups: [string, AgentModelOption[]][];
} {
  const groups = new Map<string, AgentModelOption[]>();
  const flat: AgentModelOption[] = [];
  for (const m of models) {
    const slash = m.id.indexOf('/');
    if (m.id === 'default' || slash <= 0) {
      flat.push(m);
      continue;
    }
    const provider = m.id.slice(0, slash);
    const arr = groups.get(provider) ?? [];
    arr.push(m);
    groups.set(provider, arr);
  }
  flat.sort((a, b) => (a.id === 'default' ? -1 : b.id === 'default' ? 1 : 0));
  return { flat, groups: Array.from(groups.entries()) };
}

// Strip the redundant `provider/` prefix from a label shown inside its
// own provider group; keep it in the value so the CLI sees the fully-
// qualified id.
export function stripProviderPrefix(label: string, provider: string): string {
  return label.startsWith(`${provider}/`)
    ? label.slice(provider.length + 1)
    : label;
}

// Render the `<option>` children for a native model `<select>`.
export function renderModelOptions(models: AgentModelOption[]) {
  const { flat, groups } = groupModelOptions(models);
  if (groups.length === 0) {
    return (
      <>
        {flat.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </>
    );
  }
  return (
    <>
      {flat.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
      {groups.map(([provider, items]) => (
        <optgroup key={provider} label={provider}>
          {items.map((m) => (
            <option key={m.id} value={m.id}>
              {stripProviderPrefix(m.label, provider)}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

// True when the picked model id isn't one of the listed options — i.e.
// the user has typed a custom id and we should keep the custom input
// visible / the dropdown showing "Custom…".
export function isCustomModel(
  modelId: string | null | undefined,
  models: AgentModelOption[],
): boolean {
  if (!modelId) return false;
  return !models.some((m) => m.id === modelId);
}

export const CUSTOM_MODEL_SENTINEL = '__custom__';
