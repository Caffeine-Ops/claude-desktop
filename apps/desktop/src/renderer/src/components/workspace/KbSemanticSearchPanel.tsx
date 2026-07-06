/**
 * KbSemanticSearchPanel — 语义搜索面板（Task 8）
 *
 * 供写方案工作台主动探库：输入自然语言关键词 → 混合(向量+BM25)检索 → 展示命中片段+出处。
 * 与「召回预览」（BM25 词面）互补：语义搜索能召回同义词/英文缩写/跨语言表述，
 * 用户可决定要不要据此调整产品集或关键词再生成。
 *
 * 动作说明：
 * - 「复制引用」：把 `（据《title》）text` 整段复制到剪贴板。
 *   为什么不直接插草稿：草稿持久化靠 transcript 哨兵重建（见 memory proposal-draft-persistence-model），
 *   面板内直接写 store 的内容在 reopen 后会静默蒸发；真正"插入"需要走 AI-turn 路径（P2）。
 *   剪贴板是 P1 诚实做法——用户自行粘贴，语义明确。
 * - 「打开文档」：`chatApi.openPath` 走 shell.openPath；sourcePath 优先、fallback mirrorPath；
 *   两者都空则隐藏按钮。
 * - staleIndex=true 时显「需重建索引」条（向量过期，当前结果为 BM25 降级）。
 */

import { useState } from 'react'
import type { SemanticHit } from '@shared/kbIndex'
import type { KbSemanticSearchResult } from '@shared/ipc-channels'
import {
  AlertTriangleIcon,
  CheckIcon
} from './proposalIcons'
import type { ProposalProduct } from '../../stores/proposal'

interface KbSemanticSearchPanelProps {
  /** 当前产品集——用于收窄检索范围，与生成时保持同基准。 */
  products: ProposalProduct[]
}

export function KbSemanticSearchPanel({ products }: KbSemanticSearchPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<KbSemanticSearchResult | null>(null)
  // copiedIndex: 哪张卡片当前显「已复制」反馈（transient）
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)

  async function runSearch(): Promise<void> {
    if (loading) return
    const q = query.trim()
    if (!q) return
    setLoading(true)
    try {
      const r = await window.chatApi.kbSemanticSearch({ query: q, products })
      setResult(r)
    } catch {
      setResult({ hits: [], staleIndex: false })
    } finally {
      setLoading(false)
    }
  }

  async function copyHit(hit: SemanticHit, idx: number): Promise<void> {
    // 复制全文（hit.text），不是 snippet——引用要完整才能作为 grounding 材料。
    // 格式复用现有「来源字段」约定（proposal-citation-strip-and-highlight）：
    //   `（据《title》）text` — 编辑态高亮来源、预览/导出剥除括号注。
    const cite = `（据《${hit.title}》）${hit.text}`
    try {
      await navigator.clipboard.writeText(cite)
      setCopiedIndex(idx)
      setTimeout(() => setCopiedIndex((prev) => (prev === idx ? null : prev)), 2000)
    } catch {
      // clipboard 失败静默——降级不崩
    }
  }

  function openHit(hit: SemanticHit): void {
    const p = hit.sourcePath || hit.mirrorPath
    if (!p) return
    void window.chatApi.openPath({ absPath: p })
  }

  function hasOpenPath(hit: SemanticHit): boolean {
    return !!(hit.sourcePath || hit.mirrorPath)
  }

  return (
    <div className="proposal-anim-fade space-y-1.5 border-b border-border px-3 py-2">
      {/* 说明文字：语义搜索与召回预览（BM25）互补，支持同义词 / 英文缩写 / 跨语言。 */}
      <div className="text-[11px] leading-snug text-muted-foreground">
        混合语义检索（向量 + BM25）——同义词、英文缩写、跨语言均可召回。
        命中片段可「复制引用」后手动粘贴到草稿，或「打开文档」查看原文。
      </div>

      {/* staleIndex 警告条：向量过期 → 当前结果为 BM25 降级，提示重建索引。 */}
      {result?.staleIndex && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-400/40 bg-amber-50/60 px-2 py-1.5 dark:border-amber-500/30 dark:bg-amber-900/20">
          <AlertTriangleIcon className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
          <span className="text-[11px] leading-snug text-amber-700 dark:text-amber-400">
            知识库索引需重建（<code className="font-mono text-[10px]">bun scripts/build-kb-index.ts</code>）——当前结果为词面降级，非向量语义检索。
          </span>
        </div>
      )}

      {/* 搜索框 + 按钮 */}
      <div className="flex items-center gap-1">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch()
          }}
          placeholder={
            products.length === 0
              ? '先添加产品，再输自然语言检索词…'
              : '输入自然语言检索词，语义搜索知识库…'
          }
          className="h-7 flex-1 rounded-md border border-border bg-card px-2 text-[12px] text-foreground outline-none focus:border-accent"
        />
        <button
          type="button"
          className="rounded bg-accent px-2 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
          disabled={loading || !query.trim() || products.length === 0}
          onClick={() => void runSearch()}
        >
          {loading ? '检索中…' : '搜索'}
        </button>
      </div>

      {/* 结果区 */}
      {result !== null && (
        result.hits.length === 0 ? (
          <div className="text-[11px] leading-snug text-muted-foreground">
            {products.length === 0
              ? '请先添加产品后再搜索。'
              : '没有找到相关片段。尝试换个说法，或添加更多产品扩大检索范围。'}
          </div>
        ) : (
          <div className="max-h-72 space-y-2 overflow-auto">
            {result.hits.map((hit, i) => (
              <div key={i} className="rounded-md border border-border bg-card/50 px-2 py-1.5">
                {/* 标题行：文档名 + 产品线/产品（subtle，非空时才展示） */}
                <div className="mb-0.5 flex items-baseline justify-between gap-1">
                  <div className="truncate text-[11px] font-medium text-accent">
                    《{hit.title}》
                  </div>
                  {(hit.productLine || hit.product) && (
                    <div className="shrink-0 text-[10px] text-muted-foreground/70">
                      {[hit.productLine, hit.product].filter(Boolean).join(' / ')}
                    </div>
                  )}
                </div>

                {/* snippet 预览 */}
                <div className="max-h-24 overflow-hidden whitespace-pre-wrap text-[11px] leading-snug text-foreground/80">
                  {hit.snippet || hit.text.slice(0, 160)}
                </div>

                {/* score — 只作排序参考，不转百分比、不夸大语义 */}
                <div className="mt-0.5 text-[10px] text-muted-foreground/50">
                  相关度 {hit.score.toFixed(3)}
                </div>

                {/* 动作行 */}
                <div className="mt-1 flex items-center gap-1.5">
                  {/* 复制引用：把 `（据《title》）fulltext` 送进剪贴板。
                      为什么不走 AI turn / store 写入：见文件头注释。 */}
                  <button
                    type="button"
                    className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-accent hover:text-accent"
                    onClick={() => void copyHit(hit, i)}
                  >
                    {copiedIndex === i ? (
                      <>
                        <CheckIcon className="h-2.5 w-2.5" />
                        已复制
                      </>
                    ) : (
                      <>
                        复制引用
                      </>
                    )}
                  </button>

                  {/* 打开文档：sourcePath 优先，fallback mirrorPath；两者都空则隐藏。 */}
                  {hasOpenPath(hit) && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-accent hover:text-accent"
                      onClick={() => openHit(hit)}
                      title={hit.sourcePath || hit.mirrorPath}
                    >
                      打开文档
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}
