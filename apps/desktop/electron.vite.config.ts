import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Vite config for the Electron wrapper.
 *
 * History note (Apr 2026): an earlier iteration imported free-code/src/
 * directly through Vite aliases and a 400-line compat transform plugin
 * (`freeCodeCompatPlugin`) to bridge Bun-only constructs (`bun:bundle`,
 * `MACRO.*` defines, `src/`-prefixed baseUrl imports, lazy CJS requires,
 * NAPI native modules, etc.) into Rollup's ESM output. That stack was
 * removed when ChatEngine was rewritten on top of `@anthropic-ai/
 * claude-agent-sdk`'s `query()` API: the SDK spawns the prebuilt
 * `free-code/cli` binary as a child process and talks to it over the
 * stream-json protocol, so we no longer need to bundle any free-code
 * source into the Electron main process.
 *
 * The result is the minimal electron-vite config below — just three
 * targets, three plugins, two aliases.
 */

const sharedResolve = {
  alias: [
    { find: /^@shared\/(.*)$/, replacement: resolve(__dirname, 'src/shared/$1') }
  ]
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    resolve: sharedResolve,
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // embedWorker 是 utilityProcess 独立入口：模型加载/向量检索全在子进程，
          // 绝不进 main 主线程（冷加载 ~6s 会冻住所有 tab 的 engine）。
          // Task 6 用 utilityProcess.fork('out/main/embedWorker.js') 指向此产物。
          embedWorker: resolve(__dirname, 'src/main/workers/embedWorker.ts')
        }
      },
      commonjsOptions: { transformMixedEsModules: true }
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: sharedResolve,
    build: {
      rollupOptions: {
        // Two preloads: the main one (chatApi/tabApi for chat tabs + shell)
        // and a tiny `settings` preload for the embedded web settings
        // overlay, which only needs a single `electronSettings.close()`
        // bridge — it must NOT get the full chatApi surface since it loads
        // the (external-origin) Open Design web app.
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          settings: resolve(__dirname, 'src/preload/settings.ts')
        }
      }
    }
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    }
  }
})
