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
        // Apple DESIGN.md §3: SF Pro with automatic optical sizing.
        // `-apple-system` is the magic keyword that on macOS maps to
        // SF Pro and lets the OS pick Display/Text variants by size.
        // We list SF Pro Text / Display explicitly as fallbacks for
        // cross-platform builds that don't resolve -apple-system.
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Text',
          'SF Pro Display',
          'Helvetica Neue',
          'Helvetica',
          'Arial',
          'sans-serif'
        ],
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'monospace']
      },
      // Apple DESIGN.md §5: tight, context-specific border-radii.
      // The signature 980px "pill" radius is reserved for CTA links;
      // everyday components sit between 5px and 12px.
      borderRadius: {
        'apple-xs': '5px',
        'apple-sm': '8px',
        'apple-md': '11px',
        'apple-lg': '12px',
        pill: '980px'
      },
      // Apple DESIGN.md §6: one soft diffused shadow or nothing.
      // Offset + wide blur mimics a studio softbox casting a natural
      // shadow beneath a physical object. Any component that needs
      // elevation uses `shadow-apple` (or goes flat).
      boxShadow: {
        apple: 'rgba(0, 0, 0, 0.22) 3px 5px 30px 0px'
      },
      // Apple DESIGN.md §3: negative tracking at all sizes. The em
      // values reproduce the DESIGN.md pixel targets divided by the
      // matching optical size — so `tracking-apple-body` applied to
      // 17px text yields the same -0.374px Apple ships.
      letterSpacing: {
        'apple-display': '-0.005em',
        'apple-body': '-0.022em',
        'apple-caption': '-0.016em',
        'apple-micro': '-0.010em'
      },
      // Apple DESIGN.md §3: the full hierarchy as a ready-to-use set.
      // Each entry bakes in line-height + tracking + weight so a
      // component can say `text-apple-body` and get Apple-correct
      // rhythm for free.
      fontSize: {
        'apple-display': [
          '56px',
          { lineHeight: '1.07', letterSpacing: '-0.005em', fontWeight: '600' }
        ],
        'apple-section': [
          '40px',
          { lineHeight: '1.10', letterSpacing: '0', fontWeight: '600' }
        ],
        'apple-tile': [
          '28px',
          { lineHeight: '1.14', letterSpacing: '0.007em', fontWeight: '400' }
        ],
        'apple-card-title': [
          '21px',
          { lineHeight: '1.19', letterSpacing: '0.011em', fontWeight: '700' }
        ],
        'apple-body': [
          '17px',
          { lineHeight: '1.47', letterSpacing: '-0.022em', fontWeight: '400' }
        ],
        'apple-body-emph': [
          '17px',
          { lineHeight: '1.24', letterSpacing: '-0.022em', fontWeight: '600' }
        ],
        'apple-caption': [
          '14px',
          { lineHeight: '1.43', letterSpacing: '-0.016em', fontWeight: '400' }
        ],
        'apple-caption-emph': [
          '14px',
          { lineHeight: '1.29', letterSpacing: '-0.016em', fontWeight: '600' }
        ],
        'apple-micro': [
          '12px',
          { lineHeight: '1.33', letterSpacing: '-0.010em', fontWeight: '400' }
        ],
        'apple-nano': [
          '10px',
          { lineHeight: '1.47', letterSpacing: '-0.008em', fontWeight: '400' }
        ]
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
