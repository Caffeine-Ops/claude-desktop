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

/** pipx 策略（markitdown 类）：跑 pipx/pip 装一个 python 包；无字节进度、不可取消。 */
export interface PipxInstall {
  kind: 'pipx'
  pkg: string        // pip 包名，如 'markitdown'
  probeCmd: string   // 「装没装好」的探测命令名，如 'markitdown'
}

/** detect-only 策略（soffice 类）：我们装不了，只探测本机有没有，没有就引导手动装。 */
export interface DetectOnlyInstall {
  kind: 'detect-only'
  probeCmd: string   // 探测命令名，如 'soffice'
  guideUrl?: string  // 「如何安装」引导链接
}

export type ComponentInstallSpec = HostedFilesInstall | HostedArchiveInstall | PipxInstall | DetectOnlyInstall

/** 一个可按需下载的组件档案卡。名册里一条即一个组件。 */
export interface ComponentDescriptor {
  id: string
  title: string
  description: string
  sizeEstimateBytes: number
  strategy: 'hosted-files' | 'pipx' | 'detect-only'
  install: ComponentInstallSpec
}

/** 仅托管形态（files/archive）的组件描述符，用于下载/安装操作。 */
export type HostedComponentDescriptor = Omit<ComponentDescriptor, 'strategy' | 'install'> & {
  strategy: 'hosted-files'
  install: HostedInstall
}

// ── 运行时状态（每组件一格，main 单一事实源、前台整块镜像；范式对齐 kbBuildStatus/updaterState）──

/** 一个组件当前所处状态。三种安装策略都归一到这五态。 */
export type ComponentStatus =
  | 'idle'          // 没装、但可装（hosted-files / pipx）
  | 'installing'    // 正在装；percent 有值=可测量进度（hosted-files），null=不定长（pipx 转圈）
  | 'ready'         // 装好了 / 本就存在（detect-only 探到也是此态）
  | 'error'         // 失败，errorMessage 有值
  | 'unavailable'   // 装不了、需用户手动（detect-only 没探到；或 pipx 连 python 都没有）

export interface ComponentState {
  id: string
  status: ComponentStatus
  percent: number | null      // 仅 installing 且可测量时有值，否则 null
  currentFile: string | null  // 下载型当前文件（供 UI 文本），否则 null
  errorMessage: string | null // error 态原因，否则 null
}

/** 整张组件状态表：组件 id → 状态。 */
export type ComponentTable = Record<string, ComponentState>

/** 一个组件的初始状态（未探测前的保守态）。 */
export function initialComponentState(id: string): ComponentState {
  return { id, status: 'idle', percent: null, currentFile: null, errorMessage: null }
}

/** 组件下载总字节数（进度分母）。files=各文件之和；archive=整包 size。 */
export function descriptorTotalBytes(d: ComponentDescriptor): number {
  const i = d.install
  if (i.kind === 'files') return i.files.reduce((s, f) => s + f.size, 0)
  if (i.kind === 'archive') return i.archive.size
  return d.sizeEstimateBytes // pipx/detect-only 无字节分母，回落体积估算
}
