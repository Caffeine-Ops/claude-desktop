/**
 * 管理页编排层——IPC handler 的唯一入口，收口两条 P1 终审点名的红线：
 *   ① 校验红线：任何建目录/改名/移动/导入，先对每一路径段跑 validateSegmentName
 *      （kbStore 执行层信任入参、不内校验，这里是唯一防线；漏一处 = rename(线,'a/b')
 *       静默建嵌套目录、或 dotfile 目录进得了本机索引出不了同步）。
 *   ② 写后构建红线：任何真实写盘后 schedule()（增量构建），否则镜像/向量不收敛。
 * 依赖注入（dirs/index/schedule）→ bun 直测，不碰 electron。
 */
import { basename, extname, sep } from 'node:path'
import * as store from './kbStore'
import { validateSegmentName, isSafeRelPath } from './kbStore.core'
import { scanKb } from './kbBuild/scan'
import { buildKbTree, type KbDocRaw, type KbDocsListResult, type KbImportPayload, type KbImportResultDto, type KbMovePayload, type KbCategoryPayload, type KbCategoryRenamePayload } from '../../shared/kbAdmin'
import type { KbStoreDirs } from './kbStore'
import type { KbIndex } from '../../shared/kbIndex'

export interface KbAdminDeps { dirs: KbStoreDirs; index: () => KbIndex | null; schedule: () => void }

/**
 * 可选段：空/undefined = 合法省略（不落一层目录），非空才校验（product、newFileName）。
 * 消息就是 validateSegmentName 的中文原文，直达 UI toast。
 */
function assertOptionalSegments(...names: (string | undefined)[]): void {
  for (const n of names) {
    if (n === undefined || n === '') continue
    const err = validateSegmentName(n)
    if (err) throw new Error(err)
  }
}

/**
 * 必填段：空串也是非法（productLine、newName、导入文件名）——validateSegmentName 本身把 ''
 * 判为「名称不能为空」。红线：不能对必填空段一律 continue，否则 productLine:'' 会被 path.join
 * 吞掉首段、文档错位归类且无报错（评审 Important 命中点）。
 */
function assertRequiredSegments(...names: string[]): void {
  for (const n of names) {
    const err = validateSegmentName(n)
    if (err) throw new Error(err)
  }
}

/** 从 KbIndex 补出 relPath/ext（纯核 buildKbTree 要 KbDocRaw）：sourcePath = <storeDir>/<relPath>。 */
function toRaw(dirs: KbStoreDirs, index: KbIndex | null): KbDocRaw[] {
  if (!index) return []
  const prefix = dirs.storeDir + sep
  return index.files.map((f) => {
    const relPath = f.sourcePath.startsWith(prefix) ? f.sourcePath.slice(prefix.length) : f.sourcePath
    // ext 与 kbStore.core.docPaths 同款（extname 对无扩展名返回 ''，等价旧逻辑）。
    const ext = extname(relPath).toLowerCase()
    return {
      relPath, productLine: f.productLine, product: f.product, title: f.title, ext,
      sizeBytes: f.sizeBytes ?? null, importedAtMs: f.importedAtMs ?? null,
      ok: f.ok, error: f.error ?? null
    }
  })
}

export function listDocs(deps: KbAdminDeps, readOnly: boolean): KbDocsListResult {
  const raws = toRaw(deps.dirs, deps.index())
  return { tree: buildKbTree(raws), readOnly, total: raws.length }
}

export function importDocs(deps: KbAdminDeps, payload: KbImportPayload): KbImportResultDto {
  assertRequiredSegments(payload.productLine)
  assertOptionalSegments(payload.product)
  for (const p of payload.paths) assertRequiredSegments(basename(p))
  const reqs = payload.paths.map((srcPath) => ({ srcPath, fileName: basename(srcPath) }))
  const r = store.importDocs(deps.dirs, reqs, payload.productLine, payload.product, payload.overwrite)
  if (r.imported.length > 0) deps.schedule()
  return r
}

export function deleteDoc(deps: KbAdminDeps, relPath: string): void {
  // 源句柄穿越守卫：relPath 来自 renderer，store.deleteDoc→docPaths 只 join 不校验，
  // '..'/绝对路径能删库外任意文件——收口在这里（见 isSafeRelPath 注释）。
  if (!isSafeRelPath(relPath)) throw new Error('非法文档路径')
  store.deleteDoc(deps.dirs, relPath)
  deps.schedule()
}

export function moveDoc(deps: KbAdminDeps, payload: KbMovePayload): string {
  // 源句柄穿越守卫（目的段由下面 assertRequired/Optional 校验，源 relPath 这里补）。
  if (!isSafeRelPath(payload.relPath)) throw new Error('非法文档路径')
  assertRequiredSegments(payload.toProductLine)
  assertOptionalSegments(payload.toProduct, payload.newFileName)
  const newRel = store.moveDoc(deps.dirs, payload.relPath, payload.toProductLine, payload.toProduct, payload.newFileName)
  deps.schedule()
  return newRel
}

export function retryDoc(deps: KbAdminDeps, relPath: string): void {
  // 失败件的源还在 kb-store，构建按 ok:false（sha1 未变但上次失败）会重转——
  // 不需要动文件，触发一轮增量即可。relPath 仅用于 UI 定位，service 不真的读它，
  // 但入口一律过穿越守卫（与 delete/move 一致，杜绝将来有人在此加读盘时漏校验）。
  if (!isSafeRelPath(relPath)) throw new Error('非法文档路径')
  deps.schedule()
}

export function createCategory(deps: KbAdminDeps, payload: KbCategoryPayload): void {
  assertRequiredSegments(payload.productLine)
  assertOptionalSegments(payload.product)
  store.createCategory(deps.dirs, payload.productLine, payload.product)
  // 不 schedule：空目录无文档，构建是空转（下次真导入文档时才触发）。
}

export function renameCategory(deps: KbAdminDeps, payload: KbCategoryRenamePayload): void {
  // 分类穿越守卫：prefix 来自 renderer，store.renameCategory 直接 renameSync，
  // '..'/绝对路径能把库外任意目录改名进/移出 store——收口在这里（同 deleteDoc 的道理）。
  if (!isSafeRelPath(payload.prefix)) throw new Error('非法分类路径')
  assertRequiredSegments(payload.newName)
  store.renameCategory(deps.dirs, payload.prefix, payload.newName)
  deps.schedule()
}

export function deleteCategory(deps: KbAdminDeps, prefix: string): void {
  // 分类穿越守卫：prefix 直接下沉到 rmSync(recursive,force)，漏了会递归删库外任意目录。
  if (!isSafeRelPath(prefix)) throw new Error('非法分类路径')
  store.deleteCategory(deps.dirs, prefix)
  deps.schedule()
}

export function migrateFromFolder(deps: KbAdminDeps, folder: string): { imported: number } {
  // 保结构迁移：scanKb 已按 kbRoot 相对路径切出 productLine/product，逐组导入到 kb-store
  // 同 relPath（overwrite=false 跳过已存在，允许多次迁移幂等）。
  const entries = scanKb(folder)
  let imported = 0
  // 按 (productLine, product) 分组批量导入（importDocs 一次只接一个分类目标）。
  const groups = new Map<string, { productLine: string; product: string; reqs: { srcPath: string; fileName: string }[] }>()
  for (const e of entries) {
    const key = `${e.productLine}/${e.product}`
    let g = groups.get(key)
    if (!g) { g = { productLine: e.productLine, product: e.product, reqs: [] }; groups.set(key, g) }
    g.reqs.push({ srcPath: e.sourcePath, fileName: basename(e.sourcePath) })
  }
  for (const g of groups.values()) {
    const r = store.importDocs(deps.dirs, g.reqs, g.productLine, g.product, false)
    imported += r.imported.length
  }
  if (imported > 0) deps.schedule()
  return { imported }
}
