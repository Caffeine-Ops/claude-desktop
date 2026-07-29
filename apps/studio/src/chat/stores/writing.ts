import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import type { WritingDocSource, WritingGenre, WritingSection } from '@desktop-shared/writing'
import {
  detectWritingSource,
  isWritingInProgress,
  pickFilePath,
  type WritingToolPart
} from '../lib/writingDocSource'
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
 * 从一条消息的 content 里摘出 tool-call 摘要，喂给 writingDocSource.ts 的纯函数判定用。
 * `useWritingSource`（扫全部历史消息）与 `useWritingInProgress`（只扫最后一条）共用同一套
 * 摘取逻辑，避免两处各写一份、字段映射漂移。
 */
function toolPartsOf(content: unknown): WritingToolPart[] {
  if (!Array.isArray(content)) return []
  const parts: WritingToolPart[] = []
  for (const p of content as {
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
  return parts
}

/**
 * 从当前会话的消息树推导文档源。订阅 messages 会随流式每 delta 重算，故用 useShallow +
 * 把重活关在纯函数里（detectWritingSource 只扫 tool-call、不碰正文文本）。
 */
export function useWritingSource(): WritingDocSource | null {
  return useChatStore(
    useShallow((s): WritingDocSource | null => {
      const parts: WritingToolPart[] = []
      for (const m of s.messages) parts.push(...toolPartsOf(m.content))
      return detectWritingSource(parts)
    })
  )
}

/** 右栏门控：有文档源即接管。与 proposal / slides 的互斥在 ThreadView 里裁决。 */
export function useWritingWorkspace(): boolean {
  return useWritingStore((s) => s.source !== null)
}

/**
 * 这一轮 AI 是不是正在往当前文档源里落字（供纸面底部的进度骨架用）。
 *
 * **只扫最后一条消息**，不是全部历史——每条 assistant 消息对应一轮（同 messageId 的增量
 * 都合并进同一条，见 chat.ts 的 appendAssistantDelta），故「最后一条」= 当前/刚结束的这一轮。
 * 全文写完后用户另起一轮提问，会话级 `streaming` 依然会在这轮变真，但这轮的 parts 里没有
 * 写 drafts/ 的文件调用，isWritingInProgress 判定为 false——骨架不会再误挂着「正在写第 N 节」。
 */
export function useWritingInProgress(): boolean {
  const source = useWritingStore((s) => s.source)
  return useChatStore((s) => {
    const last = s.messages[s.messages.length - 1] as { role?: string; content?: unknown } | undefined
    if (!last || last.role !== 'assistant') return false
    return isWritingInProgress(toolPartsOf(last.content), source)
  })
}

/**
 * 轮询副作用。只在 `active`（面板挂载且当前会话是写作会话）时跑。
 *
 * 三个必须守住的点：
 *  1) **只在元信息变了才拉正文**。scan 回的是文件名+纳秒 mtime+size，与上一轮签名一致就
 *     什么都不做——否则每 2s 把万字正文搬一遍，长篇会明显卡。签名用 `mtimeNs`（纳秒精度）
 *     而不是 `mtimeMs`（毫秒精度）：若改写后新内容长度恰好相同、且两次写入落在同一毫秒内，
 *     毫秒签名会与上一轮撞车，判定「未变化」而漏刷——静默失效、界面停在旧内容且不报错。
 *     纳秒精度下「等长改写 + 同一纳秒写入」不可能同时成立，缺口被彻底堵死（不用内容哈希：
 *     那要求每轮读全部文件内容，等于把「scan 只回元信息、正文按需拉」的设计意义清空）。
 *  2) **cancelled 闸门**。一轮里有两次 await，期间面板可能卸载/`active` 变 false/文档源切换；
 *     晚到的响应必须丢弃，不能覆盖新文档的内容（proposal 预览的 objectURL 竞态是同一类问题）。
 *  3) **世代号（generation）闸门**。`cancelled` 只在 effect 卸载/依赖变化时才置真，同一个
 *     `active` 窗口内先后触发的两次 `tick()` 之间光靠 `cancelled` 挡不住——轮询间隔固定 2s，
 *     但单次扫描耗时不固定（网络共享盘、大项目，`writingDocSource.ts` 明确要支持 UNC 路径
 *     不是假设场景），如果某次 `tick()` 耗时超过 2s、与下一次定时触发的 `tick()` 重叠，
 *     可能后完成的是较早发出的那次（「后发先至」），会用旧数据反写 `lastSignature.current`
 *     和 `sections`，把已经刷新的内容「倒退」回旧版本。故每次 `tick()` 进入时领一个自增票号，
 *     每次 await 之后都要确认「我这一号是不是仍是最新」，不是就丢弃、不写 store 也不写
 *     `lastSignature`——两轮都属于同一个 effect 生命周期，只能靠世代号而非 cancelled 分辨新旧。
 */
export function useWritingPoll(active: boolean): void {
  const source = useWritingStore((s) => s.source)
  const lastSignature = useRef<string | null>(null)

  useEffect(() => {
    if (!active || !source) return
    lastSignature.current = null
    let cancelled = false
    let generation = 0

    async function tick(): Promise<void> {
      if (!source) return
      const myGeneration = ++generation
      const scan = await window.chatApi.writingScan({ source })
      if (cancelled || myGeneration !== generation) return
      const st = useWritingStore.getState()
      if (!scan.ok) {
        st.setStatus(scan.dirMissing ? 'missing' : 'error', scan.error)
        return
      }
      st.applyScan({ genre: scan.genre, outlineTotal: scan.outlineTotal })
      const signature = scan.files.map((f) => `${f.name}:${f.mtimeNs}:${f.size}`).join('|')
      if (signature === lastSignature.current) {
        st.setStatus('ready')
        return
      }
      const read = await window.chatApi.writingReadSections({ source, names: [] })
      if (cancelled || myGeneration !== generation) return
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
