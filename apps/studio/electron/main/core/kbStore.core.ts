/**
 * 托管仓库纯核：路径规划 / 冲突检测 / 名称校验 / 移动时的索引条目改写。
 * electron-free、零 IO——执行层（kbStore.ts）与 P2 的 IPC 面都只消费这里的结论。
 *
 * relPath 是全库唯一键（与 scan.ts 同一约定：OS 分隔符、含扩展名），
 * 镜像/资产路径的派生公式必须与 kbBuild/build.ts 逐字一致——两处失同步
 * 的代价是移动后的文档被下一轮构建当新文件全量重转。
 */
import { join, sep, basename, extname, isAbsolute } from 'node:path'
import type { KbIndexFile } from '../../shared/kbIndex'

/**
 * relPath 安全闸门：renderer 传入的文档句柄必须是 kb-store 内的相对路径。
 * 拒绝绝对路径与任何 '..' 段——docPaths 只做 join 不归一化校验，穿越防线收口在这里。
 * 返回 true=安全。调用方非法即拒（handler 抛、不静默）。
 */
export function isSafeRelPath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.length === 0) return false
  if (isAbsolute(relPath)) return false
  // OS 分隔符与正斜杠都要切（renderer 可能传任一种）
  return !relPath.split(/[/\\]/).includes('..')
}

/**
 * null=合法。校验规则对齐下游的静默跳过项，这里是第一道门：
 * - dot 开头：scan.ts 与同步层 kbSync.ts（scanDiskAsManifest）双层都跳——放进来就是幽灵文档。
 * - ~$ 开头：scan.ts 当 Office 锁文件跳过。
 * - Windows 保留字符：app 有 Windows 打包目标，`: * ? " < > |` 在 NTFS 上直接建不出文件，
 *   必须在入口拒绝而不是等执行层 IO 报错。
 */
export function validateSegmentName(name: string): string | null {
  if (!name.trim()) return '名称不能为空'
  if (name !== name.trim()) return '名称不能以空白开头或结尾'
  if (name.includes('/') || name.includes('\\')) return '名称不能包含路径分隔符'
  if (/[:*?"<>|]/.test(name)) return '名称不能包含 Windows 保留字符'
  if (name.startsWith('.')) return '名称不能以点开头（会被扫描与同步静默跳过）'
  if (name.startsWith('~$')) return '名称不能以 ~$ 开头（会被当作 Office 锁文件跳过）'
  return null
}

export function docRelPath(productLine: string, product: string, fileName: string): string {
  return product ? join(productLine, product, fileName) : join(productLine, fileName)
}

export interface ImportPlanItem { fileName: string; relPath: string; conflict: boolean }

export function planImport(
  fileNames: string[], productLine: string, product: string, existing: ReadonlySet<string>
): ImportPlanItem[] {
  return fileNames.map((fileName) => {
    const relPath = docRelPath(productLine, product, fileName)
    return { fileName, relPath, conflict: existing.has(relPath) }
  })
}

export function moveRelPath(
  relPath: string, toProductLine: string, toProduct: string, newFileName?: string
): string {
  return docRelPath(toProductLine, toProduct, newFileName ?? basename(relPath))
}

export interface KbDocPaths {
  sourcePath: string
  mirrorPath: string
  assetsDir: string
  productLine: string
  product: string
  title: string
}

/** 派生公式与 kbBuild 逐字同源：mirror=<out>/<relPath>.md，assets=<out>/assets/<relPath>。 */
export function docPaths(relPath: string, storeDir: string, outDir: string): KbDocPaths {
  const segs = relPath.split(sep)
  // title 必须复刻 scan.ts 的两步推导（先 extname().toLowerCase() 再 basename）——
  // 包括它的大小写怪癖：`MyDoc.DOCX` 因小写化后的 ext 与原名不匹配而**不剥**扩展名
  // （title="MyDoc.DOCX"）。同源性比「更聪明的剥离」重要：两处推导一旦分叉，
  // 移动文档后 title 无声变化、下一轮全量构建又翻回去。
  const ext = extname(relPath).toLowerCase()
  return {
    sourcePath: join(storeDir, relPath),
    mirrorPath: `${join(outDir, relPath)}.md`,
    assetsDir: join(outDir, 'assets', relPath),
    productLine: segs[0] ?? '',
    product: segs.length > 2 ? (segs[1] ?? '') : '',
    title: basename(relPath, ext)
  }
}

/** 移动=改键不改内容：sha1/mtime/importedAtMs 原样保留，路径派生字段全部按新键重算。 */
export function rewriteMovedIndexFile(
  f: KbIndexFile, oldRelPath: string, newRelPath: string, storeDir: string, outDir: string
): KbIndexFile {
  const np = docPaths(newRelPath, storeDir, outDir)
  const op = docPaths(oldRelPath, storeDir, outDir)
  return {
    ...f,
    sourcePath: np.sourcePath,
    mirrorPath: np.mirrorPath,
    productLine: np.productLine,
    product: np.product,
    title: np.title,
    assets: f.assets.map((a) => (a.startsWith(op.assetsDir) ? np.assetsDir + a.slice(op.assetsDir.length) : a))
  }
}
