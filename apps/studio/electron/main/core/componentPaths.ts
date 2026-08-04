import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'

import type { ComponentId } from '../../shared/runtimeComponents'

/**
 * 运行时组件的落盘位置与安装记账。
 *
 * **为什么单独一个模块、且住在 core/ 而不是 services/**：避免依赖环。
 * `componentInstaller`（services/）会 import `tabRegistry` → `engine` → `cliDetect`，
 * 所以 `cliDetect` 绝不能反向 import installer。把纯路径/记账逻辑拆出来，两边都只
 * 依赖它，它自己只依赖 node:fs/path + electron.app。
 */

/** 安装记账文件名（放在组件目录下，与组件内容同生共死）。 */
const RECORD_FILE = '.component.json'

/**
 * 所有运行时组件的安装根。
 *
 * ⚠️ **Windows 上刻意不用 `app.getPath('userData')`**。它在 Windows 解析到
 * `%APPDATA%`，也就是 **Roaming** 配置文件——任何启用了漫游配置或文件夹重定向的
 * 域环境里，这 200MB+ 会在每次登录/注销时同步到域服务器：配额爆掉、登录卡几分钟。
 * 组件是「本机的、可重新下载的缓存」，语义上属于 Local 而不是 Roaming。
 *
 * 取 userData 的 basename 拼到 LOCALAPPDATA 下，是为了保住 index.ts 那套
 * 「dev 与 prod 各自钉死自己的目录」的区分（见那里 setPath('userData') 的长注释）
 * ——两边 basename 不同，于是组件目录也天然分开，不会互相污染。
 *
 * 这是个一行的决定但**事后极难改**：改了等于让所有老用户重下一遍两百多兆。
 */
export function componentsRoot(): string {
  const override = process.env.COWORK_COMPONENTS_DIR
  if (override && override.trim()) return override.trim()

  const userData = app.getPath('userData')
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local && local.trim()) return join(local.trim(), basename(userData), 'components')
    // LOCALAPPDATA 缺失（极罕见的精简环境）时回落 userData——退化成 Roaming 好过
    // 完全装不上。
  }
  return join(userData, 'components')
}

/** 单个组件的安装目录。 */
export function componentDir(id: ComponentId): string {
  return join(componentsRoot(), id)
}

/**
 * `.part` 与 staging 的暂存目录。
 *
 * **必须与安装根同分区**：安装的最后一步是 `renameSync(staging → 目标)`，跨分区
 * 会直接 `EXDEV`。pptSkillWorker 用的是 `mkdtempSync(tmpdir())`，在 macOS 上恰好
 * 同卷所以一直没炸，但 Windows 上 `%TEMP%` 与 `%LOCALAPPDATA%` 完全可能在不同盘
 * （系统盘小的企业镜像很常见）。放在安装根下面，从结构上杜绝这个问题。
 */
export function componentCacheDir(): string {
  return join(componentsRoot(), '.cache')
}

export function ensureComponentDirs(): void {
  mkdirSync(componentsRoot(), { recursive: true })
  mkdirSync(componentCacheDir(), { recursive: true })
}

export interface ComponentRecord {
  id: ComponentId
  version: string
  /** 装的时候是哪个平台的产物，用于发现「用户把整个目录拷到了另一台机器」。 */
  platform: string
  /** 仅 executable：落盘文件的 sha256，供每次 spawn 前的廉价复验。 */
  contentSha256?: string
  installedAt: number
}

/**
 * 读安装记账**并核对 readyProbe 真在盘上**。
 *
 * 为什么两个条件都要：记账文件在、但内容被用户手删（或被杀软隔离）的情况真实存在。
 * 只认记账会让上层拿着一个不存在的路径去 spawn，失败现场（ENOENT / Exec format
 * error）离「组件没装好」这个真因十万八千里。宁可报「未安装」触发重装。
 * 这条纪律照搬 pptSkillInstaller.readInstalledVersion 的判断。
 */
export function readComponentRecord(id: ComponentId, readyProbe: string): ComponentRecord | null {
  const dir = componentDir(id)
  try {
    const raw = JSON.parse(readFileSync(join(dir, RECORD_FILE), 'utf-8')) as Partial<ComponentRecord>
    if (!raw.version || typeof raw.version !== 'string') return null
    if (!existsSync(join(dir, readyProbe))) return null
    return {
      id,
      version: raw.version,
      platform: typeof raw.platform === 'string' ? raw.platform : '',
      installedAt: typeof raw.installedAt === 'number' ? raw.installedAt : 0,
      ...(typeof raw.contentSha256 === 'string' ? { contentSha256: raw.contentSha256 } : {})
    }
  } catch {
    return null
  }
}

export function writeComponentRecord(rec: ComponentRecord): void {
  const dir = componentDir(rec.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, RECORD_FILE), `${JSON.stringify(rec, null, 2)}\n`, 'utf-8')
}
