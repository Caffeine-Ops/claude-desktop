import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import type { WritingDocSource, WritingGenre, WritingSection } from '@desktop-shared/writing'
import { detectWritingSource, type WritingToolPart } from '../lib/writingDocSource'
import { useChatStore } from './chat'

/** 轮询间隔。2s 是「AI 写完一节到你看见」的上限，对人眼足够；再密只是空转 IPC。 */
const POLL_MS = 2000

type WritingStatus = 'idle' | 'ready' | 'missing' | 'error'

interface WritingState {
  source: WritingDocSource | null
  genre: WritingGenre
  outlineTotal: number | null
  sections: WritingSection[]
  status: WritingStatus
  errMsg: string
  /** 切换文档源：清空旧内容，避免上一篇的正文闪现在新文档里。 */
  setSource: (source: WritingDocSource | null) => void
  applyScan: (v: { genre: WritingGenre; outlineTotal: number | null }) => void
  setSections: (sections: WritingSection[]) => void
  setStatus: (status: WritingStatus, errMsg?: string) => void
  /** 应用改写后就地替换一节的正文与 mtime（写盘成功后调用，避免等下一轮轮询才刷新）。 */
  replaceSectionMarkdown: (name: string, markdown: string, mtimeMs: number) => void
}

export const useWritingStore = create<WritingState>((set) => ({
  source: null,
  genre: 'workplace',
  outlineTotal: null,
  sections: [],
  status: 'idle',
  errMsg: '',
  setSource: (source) =>
    set({ source, sections: [], outlineTotal: null, status: 'idle', errMsg: '' }),
  applyScan: ({ genre, outlineTotal }) => set({ genre, outlineTotal }),
  setSections: (sections) => set({ sections }),
  setStatus: (status, errMsg = '') => set({ status, errMsg }),
  replaceSectionMarkdown: (name, markdown, mtimeMs) =>
    set((s) => ({
      sections: s.sections.map((sec) => (sec.name === name ? { ...sec, markdown, mtimeMs } : sec))
    }))
}))

/**
 * 从工具调用参数里摘取文件路径。兼容三种字段名（`file_path`/`filePath`/`path`）——
 * 与 ToolCallCard.tsx 里的 pickFilePath 同源（那边没导出，故本处复刻一份；改一处要改两处）。
 * 只取 `file_path` 会漏掉部分用别名传参的工具调用，导致单文件模式的判定悄悄失效。
 */
function pickFilePath(args: Record<string, unknown>): string | null {
  const v = args.file_path ?? args.filePath ?? args.path
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * 从当前会话的消息树推导文档源。订阅 messages 会随流式每 delta 重算，故用 useShallow +
 * 把重活关在纯函数里（detectWritingSource 只扫 tool-call、不碰正文文本）。
 */
export function useWritingSource(): WritingDocSource | null {
  return useChatStore(
    useShallow((s): WritingDocSource | null => {
      const parts: WritingToolPart[] = []
      for (const m of s.messages) {
        if (!Array.isArray(m.content)) continue
        for (const p of m.content as unknown as {
          type: string
          toolName?: string
          args?: Record<string, unknown>
          result?: unknown
        }[]) {
          if (p.type !== 'tool-call' || !p.toolName) continue
          const args = p.args ?? {}
          parts.push({
            toolName: p.toolName,
            commandText: typeof args.command === 'string' ? args.command : '',
            resultText: typeof p.result === 'string' ? p.result : JSON.stringify(p.result ?? ''),
            filePath: pickFilePath(args)
          })
        }
      }
      return detectWritingSource(parts)
    })
  )
}

/** 右栏门控：有文档源即接管。与 proposal / slides 的互斥在 ThreadView 里裁决。 */
export function useWritingWorkspace(): boolean {
  return useWritingStore((s) => s.source !== null)
}

/**
 * 轮询副作用。只在 `active`（面板挂载且当前会话是写作会话）时跑。
 *
 * 两个必须守住的点：
 *  1) **只在元信息变了才拉正文**。scan 回的是文件名+mtime+size，与上一轮签名一致就什么都不做——
 *     否则每 2s 把万字正文搬一遍，长篇会明显卡。
 *  2) **cancelled 闸门**。一轮里有两次 await，期间可能切会话/换文档源；晚到的响应必须丢弃，
 *     不能覆盖新文档的内容（proposal 预览的 objectURL 竞态是同一类问题）。
 */
export function useWritingPoll(active: boolean): void {
  const source = useWritingStore((s) => s.source)
  const lastSignature = useRef<string | null>(null)

  useEffect(() => {
    if (!active || !source) return
    lastSignature.current = null
    let cancelled = false

    async function tick(): Promise<void> {
      if (!source) return
      const scan = await window.chatApi.writingScan({ source })
      if (cancelled) return
      const st = useWritingStore.getState()
      if (!scan.ok) {
        st.setStatus(scan.dirMissing ? 'missing' : 'error', scan.error)
        return
      }
      st.applyScan({ genre: scan.genre, outlineTotal: scan.outlineTotal })
      const signature = scan.files.map((f) => `${f.name}:${f.mtimeMs}:${f.size}`).join('|')
      if (signature === lastSignature.current) {
        st.setStatus('ready')
        return
      }
      const read = await window.chatApi.writingReadSections({ source, names: [] })
      if (cancelled) return
      if (!read.ok) {
        useWritingStore.getState().setStatus('error', read.error)
        return
      }
      lastSignature.current = signature
      useWritingStore.getState().setSections(read.sections)
      useWritingStore.getState().setStatus('ready')
    }

    void tick()
    const timer = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, source])
}
