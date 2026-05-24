export default {
  plugins: {
    // Tailwind v4 ships its own PostCSS plugin. It replaces the v3
    // `tailwindcss` plugin AND bundles autoprefixer + postcss-import,
    // so neither is listed here anymore (mirrors apps/web).
    '@tailwindcss/postcss': {}
  }
}
