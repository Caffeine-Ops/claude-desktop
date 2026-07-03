import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 从 cliDetect.ts 原样搬出（2026-07-03 skill 化改造）。为什么单独成模块：
// cliDetect 顶部 import electron 的 app，而本函数是纯 env + 路径探测、不碰 electron——
// proposalPrompt.ts 运行期读 skills/proposal-writer 模板要用它，且 proposalPrompt 的
// bun test（快照/契约）在无 electron 的进程里跑，依赖链上不允许出现 electron。
/**
 * Resolve the repo-root `skills/` directory, packaged as a local fusion-code
 * plugin (it carries `skills/.claude-plugin/plugin.json` with `"skills":
 * "./"`, so every immediate `skills/<name>/SKILL.md` subdir registers as the
 * plugin skill `claude-desktop:<name>`). The engine feeds the returned path
 * into the SDK `query()` `plugins` option so these skills become `/`-triggerable
 * in the chat tab — distinct from the daemon's own `/api/skills` surface, which
 * reads the same directory but over HTTP for the Settings → Skills panel.
 *
 * dev/prod split mirrors resolveBundledCliPath():
 *   - prod (packaged .app): electron-builder's extraResources copies the repo
 *     `skills/` into `<resourcesPath>/prebundled/skills` (see
 *     prebundle-daemon.mjs RESOURCE_DIRS). resolveRepoRoot() in
 *     openDesignServices.ts lands daemon PROJECT_ROOT on that same prebundled
 *     root, so the two consumers stay in lockstep.
 *   - dev: walk up from this bundle (apps/desktop/out/main) / cwd to the repo
 *     root and use its live `skills/`.
 *
 * Returns null when no `skills/` dir is found (the plugins option is then
 * simply omitted — the SDK wires no extra plugin, never an error). The
 * `FUSION_CODE_SKILLS_DIR` env overrides everything for diagnostics.
 */
export function resolveBundledSkillsPluginDir(): string | null {
  const envOverride = process.env.FUSION_CODE_SKILLS_DIR
  if (envOverride) return existsSync(envOverride) ? envOverride : null

  const selfDir = dirname(fileURLToPath(import.meta.url))
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath
  const candidates = [
    ...(resourcesPath ? [resolve(resourcesPath, 'prebundled', 'skills')] : []),
    resolve(process.cwd(), '../../skills'),
    resolve(process.cwd(), '../../../skills'),
    resolve(selfDir, '../../../skills'),
    resolve(selfDir, '../../../../skills')
  ]
  for (const p of candidates) {
    // Require the plugin manifest, not just the dir — a bare skills/ without
    // `.claude-plugin/plugin.json` would make fusion-code's `--plugin` reject
    // it, so only return a path that will actually load.
    if (existsSync(join(p, '.claude-plugin', 'plugin.json'))) return p
  }
  return null
}
