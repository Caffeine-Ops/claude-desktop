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
      }
    }
  },
  plugins: []
}
