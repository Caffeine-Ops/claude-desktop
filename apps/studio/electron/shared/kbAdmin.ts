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
export interface KbProduct { name: string; docs: KbDocEntry[] }
export interface KbProductLine { name: string; products: KbProduct[]; rootDocs: KbDocEntry[] }
export interface KbTree { lines: KbProductLine[] }
export interface KbToolingStatus { markitdown: boolean; soffice: boolean }
export interface KbDocsListResult { tree: KbTree; readOnly: boolean; total: number }
export interface KbImportPayload { paths: string[]; productLine: string; product: string; overwrite: boolean }
export interface KbImportResultDto { imported: string[]; conflicted: string[] }
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
// 中文按码点序，P2 可接受；真要拼音序是后续事，不在本期。
const byName = <T extends { name: string }>(a: T, b: T): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

export function buildKbTree(docs: readonly KbDocRaw[]): KbTree {
  // 按产品线聚合——lineMap 记住创建顺序，后续 [...lineMap.values()] 保证顺序。
  const lineMap = new Map<string, KbProductLine>()
  for (const d of docs) {
    let line = lineMap.get(d.productLine)
    if (!line) { line = { name: d.productLine, products: [], rootDocs: [] }; lineMap.set(d.productLine, line) }

    // 构造 KbDocEntry：取决于 ok 来源 → ok ? 'indexed' : 'failed'
    const entry: KbDocEntry = {
      relPath: d.relPath, title: d.title, ext: d.ext,
      sizeBytes: d.sizeBytes, importedAtMs: d.importedAtMs,
      status: d.ok ? 'indexed' : 'failed', error: d.error
    }

    // 根据 product 为空与否分类：空则入 rootDocs，否则入产品的 docs
    if (!d.product) { line.rootDocs.push(entry); continue }
    let prod = line.products.find((p) => p.name === d.product)
    if (!prod) { prod = { name: d.product, docs: [] }; line.products.push(prod) }
    prod.docs.push(entry)
  }

  // 排序：产品线按名排序；产品线内部的根文档按 title 排序；产品按名排序；产品内文档按 title 排序
  const byTitle = (a: KbDocEntry, b: KbDocEntry): number => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
  const lines = [...lineMap.values()].sort(byName)
  for (const l of lines) {
    l.rootDocs.sort(byTitle)
    l.products.sort(byName)
    for (const p of l.products) p.docs.sort(byTitle)
  }
  return { lines }
}
