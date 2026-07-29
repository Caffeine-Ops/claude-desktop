import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Vite config for the Electron 宿主层（electron/ = main + preload + shared，
 * 原 apps/desktop 并入本包后的位置）。
 *
 * 产物目录是 out-electron/ 而不是 electron-vite 默认的 out/：本包同时承载
 * Next 前端，next static export 固定写 out/——两条构建链共用一个目录会互相
 * 清对方的产物。package.json 的 "main" 与 electron-builder 的 files 都指
 * out-electron；out-electron/main 与旧 out/main 目录深度一致，main 代码里
 * 所有「从 bundle 位置向上找仓库根 / env.json」的相对解析不受影响。
 *
 * History note (Apr 2026): an earlier iteration imported free-code/src/
 * directly through Vite aliases and a 400-line compat transform plugin to
 * bridge Bun-only constructs into Rollup's ESM output. That stack was
 * removed when ChatEngine was rewritten on top of `@anthropic-ai/
 * claude-agent-sdk`'s `query()` API: the SDK spawns the prebuilt CLI binary
 * as a child process, so we no longer bundle any free-code source.
 */

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    build: {
      outDir: 'out-electron/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main/index.ts'),
          // embedWorker 是 utilityProcess 独立入口：KB 模型加载/向量检索全在
          // 子进程，绝不进 main 主线程（冷加载 ~6s 会冻住所有 tab 的 engine）。
          // kbSemanticSearch 用 utilityProcess.fork('out-electron/main/embedWorker.js')
          // 指向此产物——漏配该入口 fork 会静默失败 → 检索永久降级 BM25。
          embedWorker: resolve(__dirname, 'electron/main/workers/embedWorker.ts'),
          // kbBuildWorker 同理：kbBuildRunner 用 utilityProcess.fork('out-electron/main/
          // kbBuildWorker.js') 跑「扫描→转换→向量→写 index.json」。漏配此入口 = 产物不
          // 生成 → fork 找不到文件 → 构建 worker 当场异常退出 → 索引永远建不出、管理页恒空。
          kbBuildWorker: resolve(__dirname, 'electron/main/workers/kbBuildWorker.ts'),
          // pptSkillWorker 同理：ppt-creator skill 压缩 49MB、解压 12167 个
          // 文件，sha256 与解压全在子进程做，绝不进 main（那会把所有 tab 的
          // engine 连同 UI 一起冻住几十秒）。pptSkillInstaller 用
          // utilityProcess.fork('out-electron/main/pptSkillWorker.js') 指向此
          // 产物——漏配该入口 = fork 找不到文件 → 技能永远装不上、PPT 入口恒卡在下载中。
          pptSkillWorker: resolve(__dirname, 'electron/main/workers/pptSkillWorker.ts'),
          // componentWorker 同理：CLI 二进制压缩后 ~80MB、解压后 233MB，
          // 下载/sha256/gunzip 全在子进程做。componentInstaller 用
          // utilityProcess.fork('out-electron/main/componentWorker.js') 指向此产物——
          // 漏配该入口 = fork 找不到文件 → 必需组件永远装不上 → 全屏门永远挡着，
          // 应用整个不可用（比 pptSkill 那条严重得多，它只挡 PPT 入口）。
          componentWorker: resolve(__dirname, 'electron/main/workers/componentWorker.ts')
        }
      },
      commonjsOptions: { transformMixedEsModules: true }
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out-electron/preload',
      rollupOptions: {
        // 单一 preload：chatApi/tabApi，注入给 studio tab。
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts')
        }
      }
    }
  }

  // 刻意没有 renderer target：UI 是本包的 Next 侧（app/ + src/），dev 走
  // localhost:3100、prod 走 app://studio（static export 读盘），shell 窗口
  // 保持隐藏直到 studio 首帧就绪才 show（tabRegistry.activateTab）。
})
