import { readFileSync } from 'node:fs'

import type { ProposalProductScope } from './proposalPrompt'
import {
  chunkText,
  rankChunks,
  clampPassageText,
  passagesToHits,
  type RetrievalChunk,
  type RetrievedPassage,
  type RetrieveOpts
} from './proposalRetrieve.core'
import type { KbHit } from '../../shared/kbIndex'

export type { RetrievedPassage } from './proposalRetrieve.core'

/** 即时扫盘的防护上限：最多读这么多文件 / 这么多字节，防异常大库把 send 热路径拖垮。 */
const MAX_FILES = 40
const MAX_TOTAL_BYTES = 2_000_000

/**
 * 对已限定产品（scopes）的镜像原文做内容级召回：即时读文件 → 分块 → BM25 排序，返回
 * 与 query 最相关的 top-K 片段。不预建索引、不动 KbIndex 契约（产品通常仅几个~十几个
 * 文件，即时扫无感延迟）。
 *
 * 防御式：单文件读失败跳过；累计超 {@link MAX_FILES}/{@link MAX_TOTAL_BYTES} 按序截断；
 * 任意异常 → 返回 []（调用侧据此不注入召回块，AI 退回文件清单自查）。绝不抛。
 */
export function retrievePassages(
  query: string,
  scopes: readonly ProposalProductScope[],
  opts?: RetrieveOpts
): RetrievedPassage[] {
  try {
    const chunks: RetrievalChunk[] = []
    let fileCount = 0
    let byteCount = 0
    outer: for (const scope of scopes) {
      for (const f of scope.files) {
        if (fileCount >= MAX_FILES || byteCount >= MAX_TOTAL_BYTES) break outer
        let content: string
        try {
          content = readFileSync(f.mirrorPath, 'utf8')
        } catch {
          continue
        }
        fileCount++
        byteCount += content.length
        for (const text of chunkText(content)) {
          chunks.push({ text, title: f.title, mirrorPath: f.mirrorPath })
        }
      }
    }
    return rankChunks(query, chunks, opts)
  } catch (err) {
    console.warn('[proposalRetrieve] retrievePassages failed:', err)
    return []
  }
}

/**
 * 知识库检索对外入口：BM25 关键词召回 + 命中字段映射。engine 的自动召回（send 热路径）
 * 与 kb_search 工具都走这一条。
 *
 * 同步、不抛、绝不返 null——retrievePassages 自身吞掉所有异常返回 []，空 scopes（用户
 * 没选产品）同样返 []，调用侧据此不注入召回块即可，无需再判错。
 *
 * ── 为什么这里没有向量检索（2026-09-24 拆除记录，别照着历史注释复活它）──
 * 原本这一层叫 kbSemanticSearch，是个 ~170 行的包装：fork 一个 utilityProcess
 * （embedWorker）加载 bge 嵌入模型 + vectors.bin，向量腿与 BM25 腿各取 top-k 后用 RRF
 * 融合，配一整套降级机制（worker 未就绪 / 模型 stale / 1.5s 超时 → 退回 BM25）。
 *
 * 整条向量化栈已删除，原因不是「嫌它复杂」而是【它在正式版里从未生效过】：模型 23MB 从
 * 来没进过安装包（打包配置里没有对应的 extraResources，prebundle:kb-model /
 * verify:kb-model 两个脚本全链零调用），CI 又在 2026-07-06 因 runner 网络问题拆掉了下载
 * 步骤。也就是说所有用户的检索一直走的就是下面这条 BM25 路径——删除向量腿对线上行为
 * 【零变化】，只是把「看着像混合检索、实际永远降级」这个假象连同 52MB 依赖
 * （onnxruntime-node + @huggingface/transformers）一起去掉。
 *
 * 要再上语义检索，别按老路复活：模型必须走运行时按需下载（componentInstaller 那套基建），
 * 不能再指望打包进安装包。
 */
export function kbKeywordSearch(
  query: string,
  scopes: readonly ProposalProductScope[],
  k = 5
): KbHit[] {
  return passagesToHits(retrievePassages(query, scopes, { topK: k }))
}

/**
 * 把召回片段渲染成注入用户回合的文本块。带明确标签：让 AI 优先据这些原文撰写、按既有
 * 规则标注来源，不足之处再 Read 文件清单补查（与现有文件清单【并存、增量】，不替换）。
 * 空数组 → 空串（不注入）。
 */
export function renderRetrievedBlock(passages: readonly RetrievedPassage[]): string {
  if (passages.length === 0) return ''
  const body = passages
    // clampPassageText：单片段超 PASSAGE_MAX_CHARS（病态巨表）按行边界截断，防独占注入预算/撑爆提示词。
    .map((p) => `《${p.title}》\n${clampPassageText(p.text)}`)
    .join('\n\n- - -\n\n')
  return [
    '【知识库召回·以下是与本章最相关的原文片段，优先据此撰写、并按既有规则在段末标注来源；',
    '片段不足之处再 Read 上面清单里列出的文件补查，绝不臆造】',
    '',
    body
  ].join('\n')
}
