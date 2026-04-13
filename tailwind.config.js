/** @type {import('tailwindcss').Config} */
export default {
  // Tailwind only needs to scan the renderer source tree — main/preload
  // don't touch the DOM. We deliberately do NOT scan node_modules for
  // @assistant-ui/react: the primitives we import are unstyled (no class
  // names baked in); every class name in the Thread view lives inside
  // our own files.
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Display',
          'Inter',
          'sans-serif'
        ],
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace']
      },
      // shadcn-style HSL token system. Every token is wired through a
      // CSS variable defined in `index.css` (see `:root` for light and
      // `.dark` for dark). Per-user overrides written by the appearance
      // applier mutate the same variables on `documentElement.style`,
      // so e.g. `bg-accent` re-skins instantly when the user picks a
      // new color in Settings → Appearance.
      colors: {
        // The `<alpha-value>` placeholder lets utilities like
        // `bg-card/40` and `text-muted-foreground/80` work — Tailwind
        // substitutes it with the opacity from the `/N` modifier.
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)'
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)'
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar) / <alpha-value>)',
          foreground: 'hsl(var(--sidebar-foreground) / <alpha-value>)',
          accent: 'hsl(var(--sidebar-accent) / <alpha-value>)',
          border: 'hsl(var(--sidebar-border) / <alpha-value>)'
        }
      }
    }
  },
  plugins: []
}
