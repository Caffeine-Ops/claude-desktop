import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
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
 *   - dev: walk up from this bundle (apps/studio/out-electron/main) / cwd to
 *     the repo root and use its live `skills/`.
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

/**
 * One local fusion-code plugin registration for the SDK `query()` `plugins`
 * option. `pluginDir` is where `.claude-plugin/plugin.json` lives (what gets
 * fed as `{type:'local', path}`); `skillsDir` is documentation-only here (the
 * manifest's own `skills` field is what fusion-code actually reads) but kept
 * on the type so callers/tests can assert which physical directory a given
 * entry's SKILL.md subdirs are expected to live under.
 */
export interface CoworkPluginEntry {
  pluginDir: string
  skillsDir: string
}

/**
 * Resolve every user-installed marketplace plugin under `~/.cowork/skills`
 * (kind=skill) AND `~/.cowork/plugins` (kind=plugin, 2026-07-17 further
 * split — was a single `~/.cowork/skills` root for both kinds; now the
 * daemon installer picks the root by the market entry's `kind`, see
 * `marketRemoteDirFor()` in packages/contracts/src/skills-market.ts). Each
 * discovered item is registered as its OWN local fusion-code plugin — every
 * market item gets its own `<item>/.claude-plugin/plugin.json` with
 * `"skills": "./skills/"`, matching the on-disk layout documented in
 * packages/contracts/src/skills-market.ts. This is what lets one market
 * entry bundle more than one technical skill (multiple `skills/<subid>/`
 * dirs) without any further engine changes — each entry is independently
 * loaded regardless of how many SKILL.md subdirs it carries.
 *
 * A root-level `~/.cowork/skills/.claude-plugin/plugin.json` (`"skills":
 * "./"`) is ALSO recognized for backward compatibility with hand-placed flat
 * skills (SKILL.md dropped directly under `~/.cowork/skills/<name>/`, no
 * market install involved) — the daemon's skills-market installer writes
 * this on demand too (`ensureRootPluginManifest`). It can never collide with
 * market-installed items: their SKILL.md lives one level deeper
 * (`<id>/skills/<subid>/`), so the root's `"./"` scan simply finds nothing
 * there. There is deliberately NO equivalent root-level manifest for
 * `~/.cowork/plugins` — plugins only ever arrive via the market and always
 * carry their own per-item manifest, so there is no "hand-placed flat
 * plugin" scenario to support.
 *
 * All returned entries use `name: "cowork"` in their manifest — that value
 * is the skill namespace prefix (`cowork:<subid>`) and **must never change**
 * once published, or every already-installed skill's trigger name flickers.
 *
 * `COWORK_SKILLS_DIR` / `COWORK_PLUGINS_DIR` override the two roots for
 * diagnostics/tests and are intentionally the SAME envs the daemon installer
 * honors, so the writer and the loader can never diverge. Returns `[]`
 * before anything is installed — the engine then adds zero extra plugin
 * entries, zero cost.
 */
export function resolveCoworkPluginEntries(): CoworkPluginEntry[] {
  const skillsRoot = resolveEnvRoot('COWORK_SKILLS_DIR', 'skills')
  const pluginsRoot = resolveEnvRoot('COWORK_PLUGINS_DIR', 'plugins')

  const entries: CoworkPluginEntry[] = []
  // 根级兼容 manifest 只在 skills 根找——plugins 根没有"手放"场景（见上方注释）
  if (existsSync(join(skillsRoot, '.claude-plugin', 'plugin.json'))) {
    entries.push({ pluginDir: skillsRoot, skillsDir: skillsRoot })
  }
  entries.push(...scanChildPluginEntries(skillsRoot))
  entries.push(...scanChildPluginEntries(pluginsRoot))
  return entries
}

function resolveEnvRoot(envVar: string, defaultLeaf: 'skills' | 'plugins'): string {
  const envOverride = process.env[envVar]
  return envOverride && envOverride.trim() ? envOverride.trim() : join(homedir(), '.cowork', defaultLeaf)
}

function scanChildPluginEntries(root: string): CoworkPluginEntry[] {
  if (!existsSync(root)) return []
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    names = []
  }
  const entries: CoworkPluginEntry[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const itemDir = join(root, name)
    if (existsSync(join(itemDir, '.claude-plugin', 'plugin.json'))) {
      entries.push({ pluginDir: itemDir, skillsDir: join(itemDir, 'skills') })
    }
  }
  return entries
}
