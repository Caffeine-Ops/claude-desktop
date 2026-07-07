// 知识库索引产物契约。阶段 A 脚本产出、阶段 B app 消费，两端共享此文件。

/**
 * 嵌入模型 id —— TS 侧唯一事实源（embedWorker 运行期加载 + scripts/kb-index/embed.ts 离线
 * 向量化都从这里 import，本地目录布局为 <localModelPath>/<KB_MODEL_ID>/，远程拉取需加
 * `Xenova/` org 前缀）。.mjs 打包脚本因不能 import TS，另有
 * apps/desktop/scripts/kb-model-manifest.mjs 持有同名常量——改模型两处都要动，互相有指路注释。
 */
export const KB_MODEL_ID = 'bge-small-zh-v1.5'
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
  /** v3：首次入库时间。重转不刷新；同路径覆盖导入时由 build 以 now 重置。缺失（v2 索引）UI 显示「—」。 */
  importedAtMs?: number
  /** v3：原件字节数。缺失（v2 索引）UI 显示「—」。 */
  sizeBytes?: number
}

export interface KbIndex {
  // v3：新增 importedAtMs/sizeBytes（可选字段）。读取端对 v2 完全兼容——
  // 消费方不判 version 只读字段，缺失字段按「无数据」渲染，因此不做 stale 处理。
  version: 2 | 3
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

/** 语义检索命中（worker→main→renderer 全链共用）。score 是 RRF 融合分，只用于排序不展示语义。 */
export interface SemanticHit {
  title: string
  sourcePath: string
  mirrorPath: string
  productLine: string
  product: string
  /** 注入用全文 chunk（engine 自动召回把整段原文注入 prompt，确保 grounding 材料不被截断）。 */
  text: string
  /** UI 展示用短预览（text 的前 160 字）。 */
  snippet: string
  score: number
}
