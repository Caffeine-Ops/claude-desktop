import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const indexCss = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8');

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(indexCss);
  if (!match) throw new Error(`Missing CSS block for ${selector}`);
  return match[1] ?? '';
}

describe('default app background colors', () => {
  it('uses the shared design-token light background by default', () => {
    const root = cssBlock(':root');

    // The light surface palette now derives from the shared design tokens
    // (packages/design-tokens/tokens.css) so web matches the desktop app.
    // --bg / --bg-app resolve through the shared --background token
    // (hsl 240 7% 97% ≈ Apple's #f5f5f7) instead of the old hard-coded hex.
    expect(root).toContain('--bg: hsl(var(--background));');
    expect(root).toContain('--bg-app: hsl(var(--background));');
  });

  it('keeps the dark theme background unchanged', () => {
    const dark = cssBlock('[data-theme="dark"]');

    expect(dark).toContain('--bg: #1a1917;');
    expect(dark).toContain('--bg-app: #1a1917;');
  });
});
