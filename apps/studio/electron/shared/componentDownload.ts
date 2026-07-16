// 通用「按需下载组件」的前后端共享类型。范式对齐现有 kbModelDownload.ts，但把「单个模型」
// 泛化为「任意托管文件包组件」。本文件只放类型 + 纯函数，无 electron/node 依赖，可 bun test。
// P1a 只实现 strategy:'hosted-files'；pipx/detect-only 策略在 P1b 再加进联合类型。

/** 一个下载单元：一串候选地址（多镜像，按序试）+ sha256 指纹 + 真实字节数。 */
export interface DownloadUnit {
  urls: string[]
  sha256: string
  size: number
}

/** 散文件形态（模型类）：N 个文件直接落到 <root>/<destSubdir>/<relPath>。 */
export interface HostedFilesInstall {
  kind: 'files'
  destSubdir: string
  files: Array<DownloadUnit & { relPath: string; chmodExec?: boolean }>
  /** 省略 = 全部 files 就位即就绪；给定则以该相对路径文件存在为判据。 */
  readyCheck?: string
}

/** 压缩包形态（runtime 类）：下 1 个 tarball → 校验整包 → 解压到 destSubdir。 */
export interface HostedArchiveInstall {
  kind: 'archive'
  destSubdir: string
  archive: DownloadUnit
  format: 'tar.gz'
  /** tar 解压剥顶层目录层数（python-build-standalone 剥 1 层）。 */
  stripComponents?: number
  /** 解压后需 chmod +x 的相对路径（mac 的 bin/python3）。 */
  chmodExec?: string[]
  /** 解压后的「装好判据」文件（相对 destSubdir）。 */
  readyCheck: string
}

export type HostedInstall = HostedFilesInstall | HostedArchiveInstall

/** 一个可按需下载的组件档案卡。名册里一条即一个组件。 */
export interface ComponentDescriptor {
  id: string
  title: string
  description: string
  sizeEstimateBytes: number
  strategy: 'hosted-files'
  install: HostedInstall
}

/** 组件下载总字节数（进度分母）。files=各文件之和；archive=整包 size。 */
export function descriptorTotalBytes(d: ComponentDescriptor): number {
  const i = d.install
  return i.kind === 'files' ? i.files.reduce((s, f) => s + f.size, 0) : i.archive.size
}
