import { useEffect, useState } from 'react'

import { Button } from '@/src/components/ui/button'
import { cn } from '@/src/lib/utils'
import { useChatStore } from '../../stores/chat'
import { useWritingPoll, useWritingSource, useWritingStore } from '../../stores/writing'
import { WritingPaper } from './WritingPaper'

/**
 * 写作工作区右栏。两个 tab：文稿（可选区改写的排版纸面）与打印预览（真 PDF / 微信手机宽）。
 *
 * 顶栏**不标 app-region:drag**：根 layout 的 .window-drag-strip 是全应用唯一的拖拽面，
 * 组件顶栏再标会复发「整窗拖不动 + 双击不缩放」（CLAUDE.md 记了 7 条同族事故）。
 */
export function WritingDocPanel(): React.JSX.Element | null {
  const source = useWritingSource()
  const setSource = useWritingStore((s) => s.setSource)
  const storeSource = useWritingStore((s) => s.source)
  const [tab, setTab] = useState<'doc' | 'preview'>('doc')
  const sessionId = useChatStore((s) => s.sessionId)
  const streaming = useChatStore((s) =>
    sessionId ? (s.perSession[sessionId]?.streaming ?? false) : false
  )

  // 会话消息推导出的源与 store 里的不一致时同步（切会话 / 开了新项目）。
  // 【必须放 useEffect 里】：渲染期间直接调 setState 会触发 React 的
  // "Cannot update a component while rendering a different component" 警告，
  // 且在 StrictMode 下会重复执行。用序列化后的字符串当依赖，避免对象引用每帧变化导致死循环。
  const sourceKey = source ? JSON.stringify(source) : ''
  const storeSourceKey = storeSource ? JSON.stringify(storeSource) : ''
  useEffect(() => {
    if (sourceKey !== storeSourceKey) setSource(source)
  }, [sourceKey, storeSourceKey, source, setSource])

  useWritingPoll(storeSource !== null)

  if (!storeSource) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col border-l border-border bg-background">
      <div className="flex items-center gap-1 border-b border-border px-3 py-2">
        <Button
          variant={tab === 'doc' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setTab('doc')}
        >
          文稿
        </Button>
        <Button
          variant={tab === 'preview' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setTab('preview')}
        >
          打印预览
        </Button>
      </div>

      <div className={cn('flex min-h-0 flex-1 flex-col', tab === 'doc' ? '' : 'hidden')}>
        <WritingPaper streaming={streaming} />
      </div>
      {/* 打印预览在 Task 8 接入；此处先占位，避免切过去是一片空白无解释。 */}
      <div className={cn('grid flex-1 place-items-center', tab === 'preview' ? '' : 'hidden')}>
        <div className="text-[12.5px] text-muted-foreground">打印预览即将接入</div>
      </div>
    </div>
  )
}
