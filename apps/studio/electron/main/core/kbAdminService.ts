/**
 * 管理页编排层——IPC handler 的唯一入口，收口两条 P1 终审点名的红线：
 *   ① 校验红线：任何建目录/改名/移动/导入，先对每一路径段跑 validateSegmentName
 *      （kbStore 执行层信任入参、不内校验，这里是唯一防线；漏一处 = rename(线,'a/b')
 *       静默建嵌套目录、或 dotfile 目录进得了本机索引出不了同步）。
 *   ② 写后构建红线：任何真实写盘后 schedule()（增量构建），否则镜像/向量不收敛。
 * 依赖注入（dirs/index/schedule）→ bun 直测，不碰 electron。
 */
import { basename, extname, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as store from './kbStore'
import { validateSegmentName, isSafeRelPath } from './kbStore.core'
import { scanKb } from './kbBuild/scan'
import { planLocalSync, type LocalSyncSourceFile } from './kbLocalSync.core'
import { buildKbTree, type KbDocRaw, type KbDocsListResult, type KbImportPayload, type KbImportResultDto, type KbLocalSyncResult, type KbSyncPreview, type KbMovePayload, type KbCategoryPayload, type KbCategoryRenamePayload } from '../../shared/kbAdmin'
import type { LocalSyncPlan } from './kbLocalSync.core'
import type { KbStoreDirs } from './kbStore'
import type { KbIndex } from '../../shared/kbIndex'

/** 异步读文件算 sha1（fs.promises.readFile 让 IO 离开主线程；逐文件 await 之间事件循环能喘气，
 *  避免同步读+算 2.8G 把主进程冻死）。 */
async function sha1OfFileAsync(path: string): Promise<string> {
  return createHash('sha1').update(await readFile(path)).digest('hex')
}

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
  // 保全层级迁移：直接按 scanKb 的**完整 relPath** 落库（产品线/产品/第三级/…/文件，不拍平），
  // overwrite=false 跳过已存在，允许多次迁移幂等。深层同名文件因完整 relPath 唯一而不再互相覆盖。
  const entries = scanKb(folder)
  const items = entries.map((e) => ({ srcPath: e.sourcePath, relPath: e.relPath }))
  const r = store.importAtRelPaths(deps.dirs, items, false)
  if (r.imported.length > 0) deps.schedule()
  return { imported: r.imported.length }
}

/**
 * 算这次同步的计划（不写盘）：把本地 folder 的当前状态与库副本对比，得出 toCopy/toDelete。
 * preview（弹确认）与 apply（真同步）共用它，杜绝两处逻辑漂移——否则「确认时说删 3 个、
 * 实际删 5 个」就是新的信任事故。
 *
 * 关键：库内 relPath 用 scanKb 的**完整 relPath**（保全层级、天然唯一）落库——与 migrate/
 * importAtRelPaths 完全一致（不拍平）。早期误用拍平 relPath 去比完整 relPath → 一个都对不上
 * → 全判为「新」→ 整库重拷+全量重建（2026-07-07 事故）。
 *
 * 「变没变」：库里已有该 relPath 且大小与索引一致才算 sha1 做内容级确认；大小不同=必变（免算）、
 * 库里没有=新（免算）。sha1 走异步 readFile 逐文件让路，避免同步读算 2.8G 冻死主进程。
 */
async function buildSyncPlan(
  deps: KbAdminDeps, folder: string
): Promise<{ plan: LocalSyncPlan; added: number; updated: number }> {
  const entries = scanKb(folder)
  const storeRelPaths = store.listStoreRelPaths(deps.dirs)
  const prefix = deps.dirs.storeDir + sep
  const indexSha1ByRel = new Map<string, string>()
  const indexSizeByRel = new Map<string, number>()
  for (const f of deps.index()?.files ?? []) {
    const rel = f.sourcePath.startsWith(prefix) ? f.sourcePath.slice(prefix.length) : f.sourcePath
    indexSha1ByRel.set(rel, f.sha1)
    if (f.sizeBytes != null) indexSizeByRel.set(rel, f.sizeBytes)
  }

  const source: LocalSyncSourceFile[] = []
  for (const e of entries) {
    // 完整 relPath（保全层级、天然唯一，无需拍平/去重）。
    const relPath = e.relPath
    // sha1 占位 ''：只有「库已有该 relPath 且大小与索引一致」才真去读文件算 sha1 确认没变；
    // 否则留 '' —— planLocalSync 里 '' 必不等于索引记录的 sha1 → 归 toCopy（新/大小已变者都在此拷）。
    let sha1 = ''
    if (storeRelPaths.has(relPath)) {
      const idxSize = indexSizeByRel.get(relPath)
      if (idxSize === undefined || idxSize === statSync(e.sourcePath).size) {
        sha1 = await sha1OfFileAsync(e.sourcePath)
      }
    }
    source.push({ relPath, sha1, productLine: e.productLine, product: e.product, sourcePath: e.sourcePath })
  }
  const plan = planLocalSync(source, storeRelPaths, indexSha1ByRel)
  // added/updated 用同步前的 storeRelPaths 快照分：库里原本没有=新增，否则=更新。
  const added = plan.toCopy.filter((c) => !storeRelPaths.has(c.relPath)).length
  const updated = plan.toCopy.length - added
  return { plan, added, updated }
}

/**
 * 同步「预览」：只算不写盘，供 UI 在真删文件前弹确认（防静默删除，见 KbSyncPreview 注释）。
 * toDelete 摊给用户看——改名成不受支持扩展名（.docx→.doc）会表现为「删旧不补新」，静默执行=丢文件。
 */
export async function previewSyncFromLocal(deps: KbAdminDeps, folder: string): Promise<KbSyncPreview> {
  const { plan, added, updated } = await buildSyncPlan(deps, folder)
  return { added, updated, deleted: plan.toDelete.length, toDelete: plan.toDelete }
}

/**
 * 从本地源文件夹增量同步（「刷新」）：把 kb-store 对齐成 folder 的当前状态。
 * 增/改 → 拷（overwrite=true）；本地删/改名 → 删库里多出的。只重转变动件由构建自理
 * （build.ts 增量：mtime→sha1 跳过未变），故这里只负责把文件集对齐 + schedule 一轮。
 * 计划由 buildSyncPlan 统一算出——与 previewSyncFromLocal 同源，确保「确认所见=实际所删」。
 */
export async function syncFromLocal(deps: KbAdminDeps, folder: string): Promise<KbLocalSyncResult> {
  const { plan, added, updated } = await buildSyncPlan(deps, folder)

  // 先删（toDelete 的 relPath 来自磁盘扫描、非 renderer 入参，天然无穿越风险）。
  for (const rel of plan.toDelete) store.deleteDoc(deps.dirs, rel)
  // 再拷：按完整 relPath 落库，overwrite=true（改动件先删旧条目再拷）。
  store.importAtRelPaths(deps.dirs, plan.toCopy.map((c) => ({ srcPath: c.sourcePath, relPath: c.relPath })), true)

  if (plan.toCopy.length > 0 || plan.toDelete.length > 0) deps.schedule()
  return { added, updated, deleted: plan.toDelete.length }
}
