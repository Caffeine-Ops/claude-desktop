/**
 * 转换工具链探测 + 一键安装：管理页据此把导入按钮置灰、显示安装引导（spec ⑤）。
 * probeTooling 纯逻辑（DI 探针，可测）；detectTooling 是 execFileSync 薄包装。
 * 只主编机（managed 模式）会调——只读机不导入、不需要工具链。
 *
 * PATH 铁律：探测/安装/转换全部走 systemPath.augmentedPath()——GUI 启动的 app 继承 launchd
 * 精简 PATH，不补全就探不到 pipx/python/markitdown（即便装了）。convert.ts 也用同一补全，
 * 保证「探到 ⟺ 转换得了」，不出现「说就绪、转换却 ENOENT」的自相矛盾（评审：stripped-PATH）。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { augmentedPath, extraBinDirs } from './systemPath'
import type { KbToolingStatus, KbToolingInstallResult } from '../../shared/kbAdmin'

export interface KbToolingProbe { run: (cmd: string, args: string[]) => { ok: boolean } }

export function probeTooling(probe: KbToolingProbe): KbToolingStatus {
  return {
    markitdown: probe.run('markitdown', ['--version']).ok,
    soffice: probe.run('soffice', ['--version']).ok
  }
}

/**
 * markitdown / soffice 的探测：命令存在且能打印版本 → ok。任何异常（ENOENT/非零退出）→ ok:false。
 * env.PATH 用补全后的（含 ~/.local/bin、~/Library/Python/*​/bin 等），GUI 启动也能探到。
 */
export function detectTooling(): KbToolingStatus {
  const env = toolingExecEnv()
  return probeTooling({
    run: (cmd, args) => {
      try {
        // stdio ignore：只关心能不能起来、退出码，不要污染主进程日志。
        execFileSync(cmd, args, { stdio: 'ignore', timeout: 4000, env })
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }
  })
}

/**
 * markitdown / pipx / python 经 pip --user 安装后的用户级落点（除通用 extraBinDirs 外的领域专属）。
 * pip --user 在 macOS framework python 下落在 ~/Library/Python/<版本>/bin，版本按解释器而定——
 * 动态枚举整个 Library/Python，绝不写死 {3.11,3.12,3.13}（写死会漏 3.10/3.14 → 装成功却报失败）。
 * Windows 落在 %APPDATA%\Python\Python3XX\Scripts（同样枚举，别漏版本子目录）。
 */
function pythonUserBinDirs(): string[] {
  if (process.platform === 'win32') {
    const base = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Python')
    try {
      return readdirSync(base).map((v) => join(base, v, 'Scripts'))
    } catch {
      return []
    }
  }
  const base = join(homedir(), 'Library', 'Python')
  try {
    return readdirSync(base).map((v) => join(base, v, 'bin'))
  } catch {
    return []
  }
}

/**
 * 探测 / 安装 / 转换 markitdown 共用的执行环境：补全 PATH（通用 bin 目录 + Python 用户级 bin）。
 * convert.ts 用它给 execFileSync('markitdown'/'soffice') 注 env——保证「detectTooling 探得到」
 * 与「转换真能起 markitdown」用的是同一份 PATH，不出现「说就绪、转换却 ENOENT」的矛盾。
 */
export function toolingExecEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: augmentedPath(pythonUserBinDirs()) }
}

/**
 * 把 PATH + 补全目录里能找到的可执行文件解析成绝对路径；找不到返回 null。
 * 纯 existsSync 扫描，不起子进程（避免 which/where 的同步 execFileSync 冻主进程，评审 #111）。
 * Windows 依次试 .exe/.cmd/.bat（pipx 常是 .cmd shim），返回命中的完整路径。
 */
function resolveExecutable(cmd: string): string | null {
  const names = process.platform === 'win32' ? [`${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`, cmd] : [cmd]
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const dirs = [...pathDirs, ...extraBinDirs()]
  for (const d of dirs) {
    for (const name of names) {
      const p = join(d, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

const decode = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8')

/**
 * 异步跑一条命令到结束，收集 stdout/stderr。用 spawn 而非 spawnSync——安装可能耗时数分钟，
 * 同步会冻住整个 Electron 主进程（所有窗口 + IPC）。几处韧性处理：
 *  - Buffer.concat 后一次性 decode：避免多字节 UTF-8 被 chunk 边界切断解码成乱码（评审 #94）；
 *  - 非 Windows 用 detached 成进程组组长，超时 kill(-pid) 整组带走 pip/pipx 孙子进程，
 *    免得 UI 已报超时、后台却把 markitdown 偷偷装完（评审 #91）；
 *  - Windows 用 shell（pipx 常是 .cmd shim，非 shell spawn 起不来，评审 #89）；
 *  - env.PATH 补全，子进程自身的 which 也能解析。
 */
function runToCompletion(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ status: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32'
    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let done = false
    const finish = (r: { status: number | null; stdout: string; stderr: string; error?: string }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    const child = spawn(cmd, args, {
      windowsHide: true,
      shell: win,
      detached: !win,
      env: toolingExecEnv()
    })
    const timer = setTimeout(() => {
      try {
        if (!win && child.pid) process.kill(-child.pid, 'SIGTERM') // 杀整个进程组
        else child.kill()
      } catch {
        child.kill()
      }
      finish({ status: null, stdout: decode(outChunks), stderr: decode(errChunks), error: `安装超时（超过 ${Math.round(timeoutMs / 1000)}s）已中止` })
    }, timeoutMs)
    child.stdout?.on('data', (d) => { outChunks.push(Buffer.from(d)) })
    child.stderr?.on('data', (d) => { errChunks.push(Buffer.from(d)) })
    child.on('error', (e) => finish({ status: null, stdout: decode(outChunks), stderr: decode(errChunks), error: String(e) }))
    child.on('close', (code) => finish({ status: code, stdout: decode(outChunks), stderr: decode(errChunks) }))
  })
}

/**
 * 一键安装 markitdown（管理页「未检测到 markitdown」卡片调用）。
 * 策略：pipx 优先（隔离干净、PATH 行为好），退 `pip --user`；两者的前置都找不到（连 python 都没有）
 * 才判 unsupported，交给 UI 引导手动装 Python。前置探测走 resolveExecutable（扫 PATH + 补全目录，
 * 不再只信 launchd 精简 PATH，评审 #117）。装完用 detectTooling（同样补全 PATH）复检两态：
 *  - 补全 PATH 探到 → ok（convert.ts 用同一补全，转换即刻可用，无需重启）
 *  - 否则          → 失败，回传命令输出供排查
 * 不再有「装好但需重启」态——补全 PATH 是每次启动确定性重建的，重启不会改变结果（原 restartRequired
 * 对 pip --user 落点是永远好不了的死循环，评审 #137，已删）。
 * 命令与参数全部写死、无用户输入拼接（无命令注入面）。超时 5 分钟（pipx 首次建环境可能慢）。
 */
export async function installMarkitdown(): Promise<KbToolingInstallResult> {
  const before = detectTooling()
  if (before.markitdown) return { ok: true, unsupported: false, tooling: before, log: '' }

  const win = process.platform === 'win32'
  // macOS 直接 exec 解析到的绝对路径（绕开 PATH）；Windows 用 shell + 命令名（cmd.exe 经补全 env 解析，
  // 且能跑 .cmd shim）。resolveExecutable 仅用于「存在性判定 + macOS 取绝对路径」。
  let bareCmd: string
  let absCmd: string | null
  let args: string[]
  const pipxPath = resolveExecutable('pipx')
  if (pipxPath) {
    bareCmd = 'pipx'; absCmd = pipxPath; args = ['install', 'markitdown']
  } else {
    const primary = win ? 'py' : 'python3'
    absCmd = resolveExecutable(primary); bareCmd = primary
    if (!absCmd) { absCmd = resolveExecutable('python'); bareCmd = 'python' }
    if (!absCmd) {
      // 连 Python 都没有——不替用户乱装系统级东西，交给 UI 引导手动安装。
      return { ok: false, unsupported: true, tooling: before, log: '' }
    }
    args = ['-m', 'pip', 'install', '--user', 'markitdown']
  }

  const spawnCmd = win ? bareCmd : absCmd
  const r = await runToCompletion(spawnCmd, args, 300000)
  const log = [`$ ${spawnCmd} ${args.join(' ')}`, r.stdout, r.stderr, r.error ?? '']
    .filter(Boolean).join('\n').trim()

  // 用补全 PATH 复检；探到即 ok（convert.ts 同款补全，转换直接可用）。
  const after = detectTooling()
  if (after.markitdown) return { ok: true, unsupported: false, tooling: after, log }
  return { ok: false, unsupported: false, tooling: after, log }
}
