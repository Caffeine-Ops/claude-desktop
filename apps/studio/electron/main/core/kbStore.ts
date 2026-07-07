/**
 * 托管仓库执行层：真实文件操作 + index.json 同步改写。
 * electron-free（目录经 KbStoreDirs 注入，kbIndexStore 在 main 侧提供真实值）——
 * 与 kbSync 同一可测性哲学：bun test 用 mkdtemp 直测，不 mock fs。
 *
 * 一致性分工：本层负责「原件/镜像/assets/index 条目」四者的即时一致；
 * vectors.bin 的收敛不归本层管，但幽灵行的**封口**归本层管——因果链：
 * 写操作命中条目即 bump builtAtMs → vectors fingerprint（=String(builtAtMs)）立即失配
 * → embedWorker 经 index.json mtime 回收重 fork 后判 stale → 语义检索降级 BM25
 * （BM25 走现存镜像，已删文档镜像已不在，天然无幽灵行）→ 调用方随后
 * scheduleKbBuild()（kbBuildRunner），下一轮构建以新 builtAtMs 重嵌恢复语义腿。
 * 若只改 files 不 bump，旧 fingerprint 在「删除/移动 → 下轮构建完成」的窗口期
 * 依旧匹配，语义检索会命中已删文档的向量行。
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type { KbIndex, KbIndexFile } from '../../shared/kbIndex'
import { docPaths, moveRelPath, planImport, rewriteMovedIndexFile } from './kbStore.core'

export interface KbStoreDirs { storeDir: string; outDir: string }
export interface ImportRequest { srcPath: string; fileName: string }
export interface ImportResult { imported: string[]; conflicted: string[] }

/** index.json 读-改-写。缺失/损坏当空表：文件操作的成败不能被索引状态绑架。 */
function readIndexOrNull(dirs: KbStoreDirs): KbIndex | null {
  const p = join(dirs.outDir, 'index.json')
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as KbIndex } catch { return null }
}

function writeIndex(dirs: KbStoreDirs, index: KbIndex): void {
  // tmp+rename 与 kbBuild/build.ts 同款：任何时刻崩溃不留半截 index.json
  const tmp = join(dirs.outDir, '.index.json.tmp')
  mkdirSync(dirs.outDir, { recursive: true })
  writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8')
  renameSync(tmp, join(dirs.outDir, 'index.json'))
}

function updateIndex(dirs: KbStoreDirs, fn: (files: KbIndexFile[]) => KbIndexFile[]): void {
  const idx = readIndexOrNull(dirs)
  if (!idx) return // 索引还没建过：无条目可改，构建时会全量生成
  // fn 是 filter/map 风格：未命中的条目按引用原样透传，所以「长度变了或任一引用换了」
  // 就是可靠的变更信号，不需要深比较。
  const next = fn(idx.files)
  const changed = next.length !== idx.files.length || next.some((f, i) => f !== idx.files[i])
  // 未变则不写盘——连 mtime 都不动，避免无谓触发 embedWorker 的 index.json mtime 回收。
  if (!changed) return
  // 命中条目必须 bump builtAtMs（见文件头因果链）：这是幽灵向量行的封口，
  // 让 vectors fingerprint 立即失配、窗口期语义检索降级 BM25。
  writeIndex(dirs, { ...idx, files: next, builtAtMs: Date.now() })
}

export function listStoreRelPaths(dirs: KbStoreDirs): Set<string> {
  const out = new Set<string>()
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name.startsWith('~$')) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.add(relative(dirs.storeDir, full))
    }
  }
  walk(dirs.storeDir)
  return out
}

export function importDocs(
  dirs: KbStoreDirs, reqs: ImportRequest[], productLine: string, product: string, overwrite: boolean
): ImportResult {
  const existing = listStoreRelPaths(dirs)
  const plan = planImport(reqs.map((r) => r.fileName), productLine, product, existing)
  const imported: string[] = []
  const conflicted: string[] = []
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i]!
    if (item.conflict && !overwrite) { conflicted.push(item.relPath); continue }
    // 覆盖导入 = 先删旧条目与旧产物再拷：build 侧 prev 消失 → 该文件按「全新入库」
    // 处理，importedAtMs 取本轮 now（「覆盖刷新入库时间」的语义在这里落地）
    if (item.conflict) deleteDoc(dirs, item.relPath)
    const dest = join(dirs.storeDir, item.relPath)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(reqs[i]!.srcPath, dest)
    imported.push(item.relPath)
  }
  return { imported, conflicted }
}

/**
 * 按「完整 relPath」导入（保全本地文件夹层级，不拍平）——migrate/sync 专用。
 * 与 importDocs 的区别：importDocs 把文件落到 productLine/product/fileName（拍平，丢第三级+同名互覆盖）；
 * 这里直接落到 storeDir/<传入的完整 relPath>，relPath 由 scanKb 相对源根算出、天然唯一。
 * conflict（同 relPath 已存在）：overwrite → 先 deleteDoc 旧条目再拷；否则计入 conflicted 跳过。
 */
export function importAtRelPaths(
  dirs: KbStoreDirs, items: readonly { srcPath: string; relPath: string }[], overwrite: boolean
): ImportResult {
  const existing = listStoreRelPaths(dirs)
  const imported: string[] = []
  const conflicted: string[] = []
  for (const it of items) {
    const conflict = existing.has(it.relPath)
    if (conflict && !overwrite) { conflicted.push(it.relPath); continue }
    if (conflict) deleteDoc(dirs, it.relPath)
    const dest = join(dirs.storeDir, it.relPath)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(it.srcPath, dest)
    imported.push(it.relPath)
  }
  return { imported, conflicted }
}

export function deleteDoc(dirs: KbStoreDirs, relPath: string): void {
  const p = docPaths(relPath, dirs.storeDir, dirs.outDir)
  // 先动文件、后改 index：崩在中间只会留「index 还认、磁盘已删」的悬空条目，
  // 下轮构建自然收敛；反序则可能让孤儿文件复活。updateIndex 命中条目时会
  // bump builtAtMs——已删文档的向量行在窗口期就被 fingerprint 失配封死（见文件头）。
  rmSync(p.sourcePath, { force: true })
  rmSync(p.mirrorPath, { force: true })
  rmSync(p.assetsDir, { recursive: true, force: true })
  updateIndex(dirs, (files) => files.filter((f) => f.sourcePath !== p.sourcePath))
}

export function moveDoc(
  dirs: KbStoreDirs, relPath: string, toProductLine: string, toProduct: string, newFileName?: string
): string {
  const newRel = moveRelPath(relPath, toProductLine, toProduct, newFileName)
  const op = docPaths(relPath, dirs.storeDir, dirs.outDir)
  const np = docPaths(newRel, dirs.storeDir, dirs.outDir)
  if (existsSync(np.sourcePath)) throw new Error(`目标已存在：${newRel}`)
  mkdirSync(dirname(np.sourcePath), { recursive: true })
  renameSync(op.sourcePath, np.sourcePath)
  if (existsSync(op.mirrorPath)) {
    mkdirSync(dirname(np.mirrorPath), { recursive: true })
    renameSync(op.mirrorPath, np.mirrorPath)
  }
  if (existsSync(op.assetsDir)) {
    mkdirSync(dirname(np.assetsDir), { recursive: true })
    renameSync(op.assetsDir, np.assetsDir)
  }
  updateIndex(dirs, (files) =>
    files.map((f) => (f.sourcePath === op.sourcePath ? rewriteMovedIndexFile(f, relPath, newRel, dirs.storeDir, dirs.outDir) : f))
  )
  return newRel
}

export function createCategory(dirs: KbStoreDirs, productLine: string, product?: string): void {
  mkdirSync(product ? join(dirs.storeDir, productLine, product) : join(dirs.storeDir, productLine), { recursive: true })
}

/** prefix：'线' 或 join('线','品')。重命名末段为 newName，三处目录 + index 条目跟随。 */
export function renameCategory(dirs: KbStoreDirs, prefix: string, newName: string): { moved: number } {
  const parent = dirname(prefix)
  const newPrefix = parent === '.' ? newName : join(parent, newName)
  // 两道守卫都要早于任何 rename：源不存在时给业务语义的错误（而不是 ENOENT），
  // 且绝不能在半路才发现——三处目录改了一半没有回滚。
  if (!existsSync(join(dirs.storeDir, prefix))) throw new Error(`分类不存在：${prefix}`)
  if (existsSync(join(dirs.storeDir, newPrefix))) throw new Error(`分类已存在：${newPrefix}`)
  // 目录级 rename 三处；assets 树与镜像树同构（assets/<relPath>），所以同一前缀搬法适用
  renameSync(join(dirs.storeDir, prefix), join(dirs.storeDir, newPrefix))
  if (existsSync(join(dirs.outDir, prefix))) renameSync(join(dirs.outDir, prefix), join(dirs.outDir, newPrefix))
  if (existsSync(join(dirs.outDir, 'assets', prefix))) {
    mkdirSync(dirname(join(dirs.outDir, 'assets', newPrefix)), { recursive: true })
    renameSync(join(dirs.outDir, 'assets', prefix), join(dirs.outDir, 'assets', newPrefix))
  }
  let moved = 0
  // sep 后缀防前缀误伤：'线A' 不能匹配到 '线A2' 下的文档
  const oldSrcPrefix = join(dirs.storeDir, prefix) + sep
  updateIndex(dirs, (files) =>
    files.map((f) => {
      if (!f.sourcePath.startsWith(oldSrcPrefix)) return f
      const oldRel = relative(dirs.storeDir, f.sourcePath)
      const newRel = join(newPrefix, relative(prefix, oldRel))
      moved++
      return rewriteMovedIndexFile(f, oldRel, newRel, dirs.storeDir, dirs.outDir)
    })
  )
  return { moved }
}

export function deleteCategory(dirs: KbStoreDirs, prefix: string): { deletedDocs: number } {
  // 与 deleteDoc 同一崩溃语义：先动文件、后改 index。崩在中间留的是悬空 index 条目
  // （下轮构建自然收敛）；若先改 index 再删文件，崩溃会留下 index 不认的孤儿文件，
  // 下轮构建把它们当新文档复活。
  rmSync(join(dirs.storeDir, prefix), { recursive: true, force: true })
  rmSync(join(dirs.outDir, prefix), { recursive: true, force: true })
  rmSync(join(dirs.outDir, 'assets', prefix), { recursive: true, force: true })
  const srcPrefix = join(dirs.storeDir, prefix) + sep
  let deletedDocs = 0
  updateIndex(dirs, (files) =>
    files.filter((f) => {
      const hit = f.sourcePath.startsWith(srcPrefix)
      if (hit) deletedDocs++
      return !hit
    })
  )
  return { deletedDocs }
}
