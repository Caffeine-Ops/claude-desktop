/**
 * 知识库管理页契约 + 纯函数把 index.json 折成「产品线/产品/文档」树。
 * electron-free、零 IO——main 侧 service 与 renderer store 共用同一份 DTO，
 * 树折叠逻辑放这里而非 renderer：可 bun 直测，且 renderer 拿到的就是渲染就绪的结构。
 *
 * relPath 是全库唯一键（与 scan/kbStore 同一约定）：删除/移动/预览/打开原件
 * 全部以它作句柄，renderer 不自己拼路径（拼错就和执行层的派生失同步）。
 */

export type KbDocStatus = 'indexed' | 'failed'
export interface KbDocEntry {
  relPath: string
  title: string
  ext: string
  sizeBytes: number | null
  importedAtMs: number | null
  status: KbDocStatus
  error: string | null
}
/**
 * n 级文件夹树节点：忠实反映本地文件夹的任意层级（产品线/产品/第三级/…/文件），
 * 不再拍平到固定两级。folders=子文件夹，docs=本文件夹里直接的文件（一个文件夹可两者兼有）。
 * path=该文件夹相对库根的 relPath 前缀（'/' 分隔），选中态/定位用它作句柄。
 */
export interface KbFolderNode { name: string; path: string; folders: KbFolderNode[]; docs: KbDocEntry[] }
export interface KbTree { roots: KbFolderNode[] }
export interface KbToolingStatus { markitdown: boolean; soffice: boolean }
/**
 * 一键安装工具链的结果（管理页「未检测到 markitdown」卡片用）。三态见
 * kbTooling.installMarkitdown 注释：ok=装上且（补全 PATH 后）即刻可用；unsupported=缺 Python/pipx
 * 前置、无法自动装，引导手动装；其余即失败。log=安装命令完整输出（失败时给用户排查）。
 */
export interface KbToolingInstallResult {
  ok: boolean
  unsupported: boolean
  tooling: KbToolingStatus
  log: string
}
export interface KbDocsListResult { tree: KbTree; readOnly: boolean; total: number }
export interface KbImportPayload { paths: string[]; productLine: string; product: string; overwrite: boolean }
export interface KbImportResultDto { imported: string[]; conflicted: string[] }
/** 本地文件夹增量同步结果：新增/更新/删除的文档数（供 UI 汇报）。 */
export interface KbLocalSyncResult { added: number; updated: number; deleted: number }
/**
 * 同步「预览」：不写盘，只算这次同步会怎么动库——给 UI 在真正删文件前弹确认用。
 * toDelete 是「库里有、源里已无」的 relPath（本地删了/改名了/改成不受支持扩展名的都在此）。
 * 静默删除是数据丢失事故的根源（改名把 .docx 改成 .doc → 扫描跳过 → 删旧不补新），
 * 故 deleted>0 时 UI 必须把 toDelete 摊给用户看、确认后才 apply。
 */
export interface KbSyncPreview { added: number; updated: number; deleted: number; toDelete: string[] }
export interface KbMovePayload { relPath: string; toProductLine: string; toProduct: string; newFileName?: string }
export interface KbCategoryPayload { productLine: string; product?: string }
export interface KbCategoryRenamePayload { prefix: string; newName: string }

/**
 * service 层用 kbStoreDir() 把每个 KbIndexFile 预处理成带 relPath/ext 的原料，纯核只做分组排序。
 */
export interface KbDocRaw {
  relPath: string
  productLine: string
  product: string
  title: string
  ext: string
  sizeBytes: number | null
  importedAtMs: number | null
  ok: boolean
  error: string | null
}

// 稳定排序用 code-unit 比较（同 manifest.ts）：不依赖 locale，测试跨环境结果一致。
// 中文按码点序，可接受；真要拼音序是后续事，不在本期。
const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const byTitle = (a: KbDocEntry, b: KbDocEntry): number => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)

/**
 * 把每个文件的完整 relPath 折成 n 级文件夹树：末段=文件挂到最深文件夹的 docs，途经段建/取文件夹。
 * relPath 可能用 '/' 或 '\\'（OS 分隔符），一律按两者切分兼容。文件夹节点可同时有 docs 与 folders。
 */
export function buildKbTree(docs: readonly KbDocRaw[]): KbTree {
  const root: KbFolderNode = { name: '', path: '', folders: [], docs: [] }
  for (const d of docs) {
    const segs = d.relPath.split(/[\\/]/).filter(Boolean)
    if (segs.length === 0) continue
    segs.pop() // 末段是文件名，不建文件夹；文件挂到其所在文件夹节点
    let node = root
    let acc = ''
    for (const seg of segs) {
      acc = acc ? acc + '/' + seg : seg
      let child = node.folders.find((f) => f.name === seg)
      if (!child) { child = { name: seg, path: acc, folders: [], docs: [] }; node.folders.push(child) }
      node = child
    }
    node.docs.push({
      relPath: d.relPath, title: d.title, ext: d.ext,
      sizeBytes: d.sizeBytes, importedAtMs: d.importedAtMs,
      status: d.ok ? 'indexed' : 'failed', error: d.error
    })
  }
  const sortNode = (n: KbFolderNode): void => {
    n.folders.sort(byName)
    n.docs.sort(byTitle)
    n.folders.forEach(sortNode)
  }
  sortNode(root)
  return { roots: root.folders }
}
