/**
 * 系统 PATH 补全 —— 唯一真源。
 * ---------------------------------------------------------------------------
 * GUI（Finder/Dock）启动的 Electron 继承的是 launchd 的精简 PATH
 * （`/usr/bin:/bin:/usr/sbin:/sbin`），**不含**用户 shell rc 注入的 homebrew /
 * ~/.local/bin / nvm / bun 等目录。而本机 CLI（claude、markitdown、pipx、python…）
 * 几乎全装在这些目录里——不补全，主进程里所有 `which <cmd>` / `execFile(<cmd>)`
 * 在 GUI 启动下一律 ENOENT（agent 探测报「未检测到代理」，知识库探测报「未装 markitdown」，
 * 且即便真装了、转换时也照样 ENOENT）。
 *
 * 这份补丁原先散在 openDesignServices（spawnDaemon 给 daemon 补 agent PATH），现收敛到此，
 * 供 daemon 探测 + 知识库探测/安装/转换 markitdown 共用，避免各写一份漂移（评审 #52）。
 * 全部 existsSync 守卫，只增不减，不破坏已有解析；Windows 上这些 *nix 目录不存在会被自动过滤。
 */
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 用户级 bin 目录候选（仅返回真实存在的）。nvm 按版本分目录，枚举每个已装 Node 版本的 bin
 * （npm 全局 CLI 落在那）。跨 daemon / 知识库复用。
 */
export function extraBinDirs(): string[] {
  const home = process.env.HOME ?? homedir()
  const dirs = [
    join(home, '.local', 'bin'), // claude, cursor-agent, pipx, pip --user 脚本
    join(home, '.bun', 'bin'), // bun 装的全局 CLI
    '/opt/homebrew/bin', // Apple Silicon homebrew：codex, opencode, python, pipx
    '/usr/local/bin' // Intel homebrew / 手动安装
  ]
  const nvmVersions = join(home, '.nvm', 'versions', 'node')
  try {
    for (const ver of readdirSync(nvmVersions)) dirs.push(join(nvmVersions, ver, 'bin'))
  } catch {
    // 没装 nvm 或读不动，跳过
  }
  return dirs.filter((d) => existsSync(d))
}

/** 只返回补丁目录拼成的串（不含 process.env.PATH）；调用方自行前置既有 PATH。 */
export function extraBinPath(): string {
  return extraBinDirs().join(delimiter)
}

/**
 * 完整的补全后 PATH：既有 process.env.PATH + 调用方额外目录 + 通用补丁目录。
 * 直接塞进 execFile/spawn 的 `env.PATH`。extra 用于领域专属落点（如 markitdown 的
 * ~/Library/Python/*​/bin），同样只纳入真实存在的。
 */
export function augmentedPath(extra: string[] = []): string {
  return [process.env.PATH ?? '', ...extra.filter((d) => existsSync(d)), ...extraBinDirs()]
    .filter(Boolean)
    .join(delimiter)
}
