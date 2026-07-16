// 「下载文件包」专办员。本文件的纯函数（判据/路径/tar 参数）可单测；install() 编排（下载+校验+
// 解压+chmod）是 io，靠 typecheck + 手动验证。isComponentInstalled 只看磁盘、不联网，判据同
// kbBuildWorker.modelReady（readyCheck 文件存在）。
import { join } from 'node:path'
import type { ComponentDescriptor, HostedArchiveInstall } from '../../../shared/componentDownload'

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
