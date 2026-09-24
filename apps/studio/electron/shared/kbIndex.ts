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

/**
 * 知识库检索命中（BM25 关键词检索的输出，engine 自动召回与 kb_search 工具共用）。
 * score 是 BM25 相关度分，只用于排序，不对用户展示。
 *
 * 2026-09-24：本类型原名 SemanticHit，字段 sourcePath/productLine/product 是向量腿的
 * vectors-meta 才有的来源元信息；向量化栈删除后 BM25 腿填不出它们，已随之去掉——
 * 消费方（renderRetrievedBlock / kb_search）本就只读 title/text/mirrorPath/score。
 */
export interface KbHit {
  title: string
  mirrorPath: string
  /** 注入用全文 chunk（engine 自动召回把整段原文注入 prompt，确保 grounding 材料不被截断）。 */
  text: string
  /** UI 展示用短预览（text 的前 160 字）。 */
  snippet: string
  score: number
}
