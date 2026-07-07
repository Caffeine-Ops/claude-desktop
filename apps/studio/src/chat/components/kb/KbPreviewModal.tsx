import React, { useEffect, useState } from 'react'
import { useT } from '../../i18n'

/**
 * 只读预览弹窗——读镜像 md 纯文本，不渲染 markdown（管理页只是「看一眼内容对不对」，
 * 不是编辑器；富渲染留给写方案的正文预览，这里故意从简）。
 * relPath 变化时重新拉取；未到达前显示省略号占位，避免空白闪烁误读成「文档是空的」。
 */
export function KbPreviewModal({ relPath, title, onClose }: { relPath: string; title: string; onClose: () => void }): React.JSX.Element {
  const t = useT()
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    setText(null) // relPath 切换（连续点两个文档的预览）先清空，避免闪现上一份内容
    void window.chatApi.kbDocPreview(relPath).then((r) => setText(r.text))
  }, [relPath])
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-8" onClick={onClose}>
      <div className="flex max-h-[80vh] w-full max-w-[720px] flex-col rounded-xl border border-border bg-background shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
          <span className="truncate text-[13px] font-medium">{title}</span>
          <button type="button" onClick={onClose} className="rounded px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-muted">{t('backToApp')}</button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11.5px] leading-relaxed text-foreground/90">
          {text === null ? '…' : text || '（空）'}
        </pre>
      </div>
    </div>
  )
}
