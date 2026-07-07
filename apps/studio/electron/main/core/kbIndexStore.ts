/**
 * Knowledge-base path configuration and index reader (main-process side).
 *
 * Two responsibilities:
 *  1. Persist / read the KB config in `userData/kb-config.json`.
 *     This is a simple JSON file — no migration needed because it only ever
 *     holds `{ kbRoot?: string, remote?: KbRemoteConfig }` and we parse
 *     defensively (parsing itself lives in `../../shared/kbConfig` so it's
 *     bun-testable without pulling in Electron).
 *  2. Read the built index from `userData/kb-index/index.json`.
 *     The file is written by the Phase-A build script; this module just
 *     reads it and returns the typed result (or null when absent).
 *
 * All paths are computed lazily via `app.getPath('userData')` so this file
 * can be imported at module level without triggering Electron's "app not
 * ready" error — the path is only resolved when an IPC handler actually
 * calls one of these functions, by which point `app.ready` has fired.
 */

import { app } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { KbIndex } from '../../shared/kbIndex'
import type { KbConfig, KbMode, KbRemoteConfig } from '../../shared/kbConfig'
import { parseKbConfig } from '../../shared/kbConfig'

/** Absolute path to the KB path config file. Evaluated lazily. */
const configPath = (): string => join(app.getPath('userData'), 'kb-config.json')

/**
 * The fixed output directory where the Phase-A build script drops
 * `index.json` and mirrored assets. Exposed so the IPC handler can
 * return it alongside `kbRoot` in a single round-trip — the renderer
 * needs both values to build the settings UI.
 */
export const kbOutDir = (): string => join(app.getPath('userData'), 'kb-index')

/** 托管仓库根目录（原件树，目录即分类）。P1 起 kb-store 取代旧「用户自选 kbRoot 文件夹」。 */
export const kbStoreDir = (): string => join(app.getPath('userData'), 'kb-store')

/**
 * local-kb（通用本地文件知识库）的固定单一目录：`~/.cowork`（用户主目录下的隐藏目录）。
 * 里面就一份 `KB-INDEX.md`——每个被「添加到知识库」的文件一行「路径 + 一句话概览」，
 * 逐文件累积（见 skills/local-kb/SKILL.md）。恒可写。
 *
 * 为什么放 ~/.cowork 而非 userData/kb-local：主目录的隐藏目录（如 .ssh/.config）用户
 * 找得到、也认得出「这是我的知识库数据」；埋在 Electron 的 Application Support 深处则
 * 难以发现、不便用户直接查看/备份那份 KB-INDEX.md。用 homedir() 而非 app.getPath('home')
 * 与 sessionStore 的 ~/.claude 同套路，跨平台一致。
 *
 * 为什么是「一个全局库」而非「每个文件夹一个库」：真实交互是用户点某个文件「添加到
 * 知识库」——单个任意路径的文件，没有"库根文件夹"可言。一份全局 md 逐条追加最贴合这个
 * 心智，也免去 agent 追问"这个文件归哪个库"。
 */
export const kbLocalDir = (): string => join(homedir(), '.cowork')

/**
 * imagegen skill 生成图片的默认落盘目录：`~/.cowork/imagegen`。
 *
 * 与 kbLocalDir 同套路、同一个 `~/.cowork` 根——用户主目录下的隐藏目录，用户
 * 找得到、能备份、恒可写，且不碰 macOS 上只读签名的 `.app` 内部。生成的图是
 * 用户的产出物，跟知识库文件一样应落在用户能触达的地方，而非埋进 Application
 * Support 深处，也不落项目根目录。
 *
 * `~` 的真实位置只有 main 侧算得出（skill 脚本是用户机器上的裸子进程），故由
 * engine 把这个绝对路径经 `CLAUDE_DESKTOP_IMAGEGEN_DIR` 注入给 image_gen.py。
 */
export const imagegenOutDir = (): string => join(kbLocalDir(), 'imagegen')

/**
 * 本地库要加进 agent `additionalDirectories`（可读+可写）的目录：就是 kbLocalDir 本身，
 * 让 agent 能读/写 KB-INDEX.md。用户文件的绝对路径由「添加到知识库」的消息现给，agent
 * 用绝对路径 Read，不需要预先把某个用户目录整体加进可读范围。
 * 恒定返回这一个目录——local-kb 是常驻能力，不像方案模式要按会话开关。
 */
export function localKbReadDirs(): string[] {
  return [kbLocalDir()]
}

/** 读整份 KB 配置。文件缺失/损坏 → 全空配置（防御哲学见 parseKbConfig）。 */
export function getKbConfig(): KbConfig {
  const p = configPath()
  let raw: string | null = null
  try {
    raw = existsSync(p) ? readFileSync(p, 'utf8') : null
  } catch {
    // existsSync 后读仍可能失败（TOCTOU/EACCES/EISDIR）——配置读取的不变量是
    // 「任何残缺退安全默认、绝不抛」：读失败与文件缺失同待遇，退全空配置。
    raw = null
  }
  return parseKbConfig(raw)
}

/**
 * Read the persisted KB root path. Returns null when the config file
 * doesn't exist yet or when it can't be parsed (e.g. corrupted JSON).
 */
export function getKbRoot(): string | null {
  return getKbConfig().kbRoot
}

/**
 * 读-合并-写：早期实现整文件覆盖 {kbRoot}，remote 字段加入后那样写会把远程配置
 * 静默抹掉（用户改一次本地路径 = 断开服务器），必须合并。setKbRemote 同理。
 * Throws on filesystem error (e.g. userData dir not writable) — the
 * IPC handler lets that surface as an invoke rejection so the renderer
 * can show an error toast.
 */
export function setKbRoot(kbRoot: string): void {
  const cur = getKbConfig()
  writeFileSync(configPath(), JSON.stringify({ ...cur, kbRoot }), 'utf8')
}

/** 持久化远程配置（或清空为 null）。同样走读-合并-写，理由见 setKbRoot 注释。 */
export function setKbRemote(remote: KbRemoteConfig | null): void {
  const cur = getKbConfig()
  writeFileSync(configPath(), JSON.stringify({ ...cur, remote }), 'utf8')
}

/** 持久化模式（managed=主编可写 / remote=只读同步）。读-合并-写，理由见 setKbRoot。 */
export function setKbMode(mode: KbMode): void {
  const cur = getKbConfig()
  writeFileSync(configPath(), JSON.stringify({ ...cur, mode }), 'utf8')
}

/**
 * 通用读-合并-写补丁（同 setKbRoot 的合并纪律）。localDocsScan 的目录管理
 * 一次要动 extraDirs / disabledPresets 两个字段，逐字段 setter 会写两次盘，
 * 收敛成一个 patch 入口。
 */
export function patchKbConfig(patch: Partial<KbConfig>): void {
  const cur = getKbConfig()
  writeFileSync(configPath(), JSON.stringify({ ...cur, ...patch }), 'utf8')
}

/**
 * Read the built knowledge-base index from `outDir/index.json`.
 * Returns null when the file doesn't exist (index not yet built) or
 * when JSON.parse fails (index file partially written). The renderer
 * treats null as "not ready" and shows the build CTA.
 */
export function readKbIndex(): KbIndex | null {
  const p = join(kbOutDir(), 'index.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as KbIndex
  } catch {
    return null
  }
}
