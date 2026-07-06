import { readFileSync } from 'node:fs'

import type { ProposalProductScope } from './proposalPrompt'
import {
  chunkText,
  rankChunks,
  clampPassageText,
  type RetrievalChunk,
  type RetrievedPassage,
  type RetrieveOpts
} from './proposalRetrieve.core'

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
