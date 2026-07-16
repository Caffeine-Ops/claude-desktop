// 「下载文件包」专办员。本文件的纯函数（判据/路径/tar 参数）可单测；install() 编排（下载+校验+
// 解压+chmod）是 io，靠 typecheck + 手动验证。isComponentInstalled 只看磁盘、不联网，判据同
// kbBuildWorker.modelReady（readyCheck 文件存在）。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { downloadWithMirrors, downloadOneUrl } from './downloadUnit'
import type { ComponentDescriptor, DownloadUnit, HostedArchiveInstall } from '../../../shared/componentDownload'

/** readyCheck 的绝对路径：root/destSubdir/readyCheck。 */
export function readyCheckAbsPath(d: ComponentDescriptor, root: string): string {
  return join(root, d.install.destSubdir, d.install.readyCheck ?? '')
}

/**
 * 是否已就绪：只看磁盘。有 readyCheck → 该文件存在即就绪；files 形态且无 readyCheck → 全部
 * 文件都在才就绪。exists 注入便于单测（生产传 fs.existsSync）。
 */
export function isComponentInstalled(
  d: ComponentDescriptor, root: string, exists: (p: string) => boolean
): boolean {
  const i = d.install
  if (i.readyCheck) return exists(readyCheckAbsPath(d, root))
  if (i.kind === 'files') {
    return i.files.every((f) => exists(join(root, i.destSubdir, f.relPath)))
  }
  return false // archive 必须给 readyCheck（类型上 readyCheck 必填，这里兜底）
}

/** tar 解压参数：-xzf <tmp> [--strip-components N] -C <destDir>。 */
export function tarExtractArgs(
  install: HostedArchiveInstall, tmp: string, destDir: string
): string[] {
  const args = ['-xzf', tmp]
  if (install.stripComponents != null) args.push('--strip-components', String(install.stripComponents))
  args.push('-C', destDir)
  return args
}

export interface InstallProgress { percent: number; currentFile: string | null }

async function sha256File(p: string): Promise<string> {
  return createHash('sha256').update(await readFile(p)).digest('hex')
}

// 下 1 个 DownloadUnit 到 dest：临时 .part → 精确 size + sha256 双校验 → rename 到位。
// 已存在且 sha 匹配则幂等跳过（累加 size 让进度不倒退）。校验失败删 .part 并抛。
async function fetchUnit(
  unit: DownloadUnit, dest: string, signal: AbortSignal,
  base: number, onBytes: (done: number) => void
): Promise<void> {
  if (existsSync(dest) && (await sha256File(dest)) === unit.sha256) {
    onBytes(base + unit.size); return
  }
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  try {
    // downloadWithMirrors 的回调 n 是「本次数据块的增量字节」，不是累计值——本地累加成 local
    // 后再叠加 base，避免 onBytes(base + n) 那种把增量当累计用导致的进度乱跳/倒退。
    let local = 0
    await downloadWithMirrors(unit.urls, tmp, signal, (n) => { local += n; onBytes(base + local) }, downloadOneUrl)
    const size = statSync(tmp).size
    if (size !== unit.size || (await sha256File(tmp)) !== unit.sha256) {
      rmSync(tmp, { force: true })
      throw new Error(`文件校验失败：${dest}`)
    }
    renameSync(tmp, dest)
    onBytes(base + unit.size)
  } catch (err) {
    rmSync(tmp, { force: true }) // 清半截，防污染幂等跳过
    throw err
  }
}

/**
 * 下载并安装一个组件到 <root>/<destSubdir>/。files：逐文件下+校验落盘。archive：下整包+校验+
 * tar 解压 strip + chmod +x。抛错前清残留。进度按真实字节数（分母=descriptorTotalBytes）。
 * 不做业务收尾（重热/重建索引）——那由调用方在成功后单独隔离 try 执行（成功/收尾分账）。
 */
export async function installComponent(
  d: ComponentDescriptor, root: string, signal: AbortSignal,
  onProgress: (p: InstallProgress) => void
): Promise<void> {
  const i = d.install
  const total = i.kind === 'files' ? i.files.reduce((s, f) => s + f.size, 0) : i.archive.size
  let done = 0
  const push = (abs: number, file: string | null): void => {
    done = abs
    onProgress({ percent: Math.min(100, Math.round((done / total) * 100)), currentFile: file })
  }

  if (i.kind === 'files') {
    for (const f of i.files) {
      const dest = join(root, i.destSubdir, f.relPath)
      const base = done
      await fetchUnit(f, dest, signal, base, (abs) => push(abs, f.relPath))
      if (f.chmodExec) chmodSync(dest, 0o755)
      push(base + f.size, null)
    }
    return
  }

  // archive：下整包到 <destSubdir>.tar.gz.part → 校验 → tar 解压到 destSubdir → chmod → 判据
  const destDir = join(root, i.destSubdir)
  mkdirSync(destDir, { recursive: true })
  const tmp = join(root, `${i.destSubdir}.tar.gz.part`)
  try {
    // 同 fetchUnit：n 是增量字节，本地累加成 local 再叠加 done（下载开始前的已完成基数）。
    let local = 0
    await downloadWithMirrors(i.archive.urls, tmp, signal, (n) => { local += n; push(done + local, i.destSubdir) }, downloadOneUrl)
    if (statSync(tmp).size !== i.archive.size || (await sha256File(tmp)) !== i.archive.sha256) {
      rmSync(tmp, { force: true }); throw new Error(`整包校验失败：${d.id}`)
    }
    execFileSync('tar', tarExtractArgs(i, tmp, destDir))
    for (const rel of i.chmodExec ?? []) chmodSync(join(destDir, rel), 0o755)
    rmSync(tmp, { force: true })
    push(total, null)
  } catch (err) {
    rmSync(tmp, { force: true }); throw err
  }
}
