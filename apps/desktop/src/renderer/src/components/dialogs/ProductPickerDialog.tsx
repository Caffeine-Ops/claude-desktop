import { useEffect, useState } from 'react'
import type { KbIndex } from '../../../../shared/kbIndex'

/**
 * ProductPickerDialog
 * -------------------
 * Modal that loads the knowledge-base index via `chatApi.readKbIndex()` and
 * lets the user pick a product line + product before starting a proposal
 * session. Opened by the "写方案" scenario card in ScenarioQuickStart.
 *
 * Null-index path: if `readKbIndex()` returns null (no index built yet) we
 * show an inline hint rather than crashing or silently doing nothing — the
 * user needs to know to run kb:index first.
 *
 * The dialog is implemented as a portal-less overlay (fixed inset-0) rather
 * than a Radix/Headless modal because: a) the app currently uses simple
 * fixed overlays for all other dialogs (LogsDialog, McpDialog, etc.), and
 * b) we want zero new deps for this feature.
 *
 * Click-outside-to-close works via the backdrop div's onClick; stopPropagation
 * on the inner panel prevents the backdrop handler from firing when the user
 * clicks inside.
 */

interface Props {
  open: boolean
  onClose: () => void
  onPick: (productLine: string, product: string) => void
}

export function ProductPickerDialog({
  open,
  onClose,
  onPick
}: Props): React.JSX.Element | null {
  const [index, setIndex] = useState<KbIndex | null | 'loading'>('loading')

  useEffect(() => {
    if (!open) return
    setIndex('loading')
    void window.chatApi.readKbIndex().then((idx) => {
      setIndex(idx)
    })
  }, [open])

  if (!open) return null

  // Build productLine → Set<product> tree from the index files.
  // We skip files with an empty product field — those are line-level docs
  // without a specific product attachment.
  const tree = new Map<string, Set<string>>()
  const files = index !== 'loading' && index !== null ? index.files : []
  for (const f of files) {
    if (!tree.has(f.productLine)) tree.set(f.productLine, new Set())
    if (f.product) tree.get(f.productLine)!.add(f.product)
  }

  const isEmpty = tree.size === 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="选择产品"
    >
      <div
        className="max-h-[70vh] w-[480px] overflow-auto rounded-xl bg-neutral-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-200">选择产品</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-0.5 text-neutral-500 hover:text-neutral-200"
            aria-label="关闭"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {index === 'loading' && (
          <p className="text-xs text-neutral-400">正在加载知识库索引…</p>
        )}

        {index !== 'loading' && index === null && (
          <p className="text-xs text-neutral-400">
            尚未建立知识库索引，请先在设置里配置路径并运行{' '}
            <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-neutral-300">
              kb:index
            </code>
            。
          </p>
        )}

        {index !== 'loading' && index !== null && isEmpty && (
          <p className="text-xs text-neutral-400">
            知识库索引已存在，但未找到任何产品条目。请确认索引文件包含正确的产品线和产品字段。
          </p>
        )}

        {index !== 'loading' && index !== null && !isEmpty && (
          <div className="flex flex-col gap-2">
            {[...tree.entries()].map(([line, products]) => (
              <div key={line}>
                <div className="mb-0.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                  {line}
                </div>
                {[...products].map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="block w-full rounded px-2 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-800"
                    onClick={() => {
                      onPick(line, p)
                      onClose()
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
