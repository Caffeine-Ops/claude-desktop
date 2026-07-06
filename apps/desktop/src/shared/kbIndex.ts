// 知识库索引产物契约。阶段 A 脚本产出、阶段 B app 消费，两端共享此文件。
export interface KbIndexFile {
  sourcePath: string
  mirrorPath: string
  productLine: string
  product: string
  title: string
  mtimeMs: number
  sha1: string
  assets: string[]
  ok: boolean
  error?: string
}

export interface KbIndex {
  // v2：新增语义向量产物（vectors.bin + vectors-meta.json）。v1 索引被视为 stale → 提示重建。
  version: 2
  kbRoot: string
  builtAtMs: number
  files: KbIndexFile[]
}

/** vectors.bin 第 i 行向量对应的来源元信息（i = 全库唯一分块表行号 = chunk id）。 */
export interface VectorMeta {
  sourcePath: string
  mirrorPath: string
  productLine: string
  product: string
  title: string
  charStart: number
  charEnd: number
  /** chunk 全文——查询期 BM25 腿用它构 RetrievalChunk（不能只存 snippet，否则两路不同表）。 */
  text: string
  /** UI 展示用短预览（text 截断）。 */
  snippet: string
}

/** vectors-meta.json 顶层。fingerprint 绑 KbIndex.builtAtMs：不符 → 向量过期 → stale。 */
export interface VectorStoreMeta {
  version: 2
  dim: 512
  fingerprint: string
  rows: VectorMeta[]
}
