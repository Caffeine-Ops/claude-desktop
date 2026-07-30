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
import type { WritingRevisionTarget } from '../lib/writingRevision'
import { useChatStore } from './chat'

/** 轮询间隔。2s 是「AI 写完一节到你看见」的上限，对人眼足够；再密只是空转 IPC。 */
const POLL_MS = 2000

type WritingStatus = 'idle' | 'ready' | 'missing' | 'error'

/** 排队软上限。与 proposal 的 MAX_REVISION_QUEUE 对齐——同一个数只写一处，提示文案引用它。 */
export const MAX_WRITING_REVISION_QUEUE = 10

/** 排队中的改写。**不存最终块序号**：排队期间前面的改写可能落地、序号会漂，排空时用
 *  target.beforeMarkdown 重新定位（range 只当多处命中时"哪一处离原位置最近"的裁决提示）。 */
export interface QueuedWritingRevision {
  id: string
  target: WritingRevisionTarget
  instruction: string
}

/** 待用户裁决的改写。渲染成「原文 vs 改后」对照卡。瞬时 UI 信号，不持久化。 */
export interface WritingRevisionReview {
  target: WritingRevisionTarget
  before: string
  after: string
  /**
   * 这张对照卡**成卡那一刻**所依据的那一版正文的 mtime，写盘时当乐观锁基准。
   *
   * 【反直觉但必须如此，别改成「写盘时现读最新的 mtime」】：轮询每 2s 把 sections 连同
   * mtimeMs 从盘上刷一遍。若基准取写盘那一刻的最新值，下面这条链就会静默毁掉正文：
   *   T0 成卡（基于 M0/m0，range 与 before 都是对 M0 算的）
   *   T1 AI 又改了这一节 → 盘上变 M1/m1 → 轮询把 store 刷成 M1/m1
   *   T2 用户点「应用」→ 拿 m1 当基准 → 主进程比对相等、放行 → 按 M0 的块序号把内容
   *      拼进 M1 的错误位置，无冲突提示、不可逆
   * 也就是说「AI 在用户裁决期间又改过这一节」——乐观锁最该拦的那个场景——恰恰被漏掉，
   * 锁实际只覆盖了「最后一次轮询到写盘」那 2 秒。基准与 target/before **同源同刻**取，
   * 锁才真正覆盖整个用户裁决窗口。
   */
  baseMtimeMs: number
  /**
   * `relocateTarget` 在这一节里找到了**不止一处**与 `beforeMarkdown` 完全相同的连续块
   * （例如两段句式雷同的模板化文字），本次是按「离入队时的位置最近」挑的一处——挑中的
   * 那处**可能是错的**。
   *
   * 这不是模糊匹配的产物（源码级匹配本身是精确的、逐字节相等），而是正文里恰好存在重复
   * 内容这一事实本身带来的歧义，机器无法替用户判断该改哪一份。为真时卡面必须显眼地提醒
   * 用户核对左侧原文确实是他要改的那段——**最后一道闸只能是用户的眼睛**。为假 = 唯一命中，
   * 无需提醒。
   */
  ambiguous: boolean
}

interface WritingState {
  source: WritingDocSource | null
  /**
   * 工作区绑定的会话 id。**改写消息的收件人**——多 tab 时前台会话可能已切走，
   * 没有它就无从判断「这条改写该不该发」，会把请求泄漏进别的会话（proposal 的
   * ps.sessionId 是同一个理由）。随 setSource 一起记，两者永远同生同灭。
   */
  sessionId: string | null
  genre: WritingGenre
  outlineTotal: number | null
  sections: WritingSection[]
  status: WritingStatus
  errMsg: string
  /** 已发出、正在等 AI 回复的那一条改写。非空 = 本轮回复要走哨兵抽取而非普通对话。 */
  pendingRevision: WritingRevisionTarget | null
  queue: QueuedWritingRevision[]
  review: WritingRevisionReview | null
  /** 一次性提示条（写盘冲突 / 排队项定位失败 / 队列满）。展示后由用户或下一次操作清掉。 */
  conflictMsg: string
  /** 切换文档源：清空旧内容，避免上一篇的正文闪现在新文档里。 */
  setSource: (source: WritingDocSource | null) => void
  /**
   * 只重绑归属会话，**不动正文**。用于「源没变、前台会话换了」——同一篇稿子在另一个会话里
   * 接着写时 setSource 不会触发（源字面相同），sessionId 会留成旧会话的，之后每次点改写都
   * 撞 sendWritingMessage 的一致性校验静默 no-op，表现为「点了没反应」。
   * 走这条而不是重调 setSource：后者会清空 sections，而轮询的 lastSignature 只在 source
   * 引用变化时才重置——源引用没变就不会补拉，纸面会一直空着。
   */
  bindSession: (sessionId: string | null) => void
  applyScan: (v: { genre: WritingGenre; outlineTotal: number | null }) => void
  setSections: (sections: WritingSection[]) => void
  setStatus: (status: WritingStatus, errMsg?: string) => void
  /** 应用改写后就地替换一节的正文与 mtime（写盘成功后调用，避免等下一轮轮询才刷新）。 */
  replaceSectionMarkdown: (name: string, markdown: string, mtimeMs: number) => void
  setPendingRevision: (t: WritingRevisionTarget | null) => void
  /** 入队；返回 false = 队列已满、这一条被拒（调用方据此提示用户，别静默丢）。 */
  pushQueue: (item: QueuedWritingRevision) => boolean
  shiftQueue: () => QueuedWritingRevision | null
  setReview: (r: WritingRevisionReview | null) => void
  setConflictMsg: (msg: string) => void
}

export const useWritingStore = create<WritingState>((set, get) => ({
  source: null,
  sessionId: null,
  genre: 'workplace',
  outlineTotal: null,
  sections: [],
  status: 'idle',
  errMsg: '',
  pendingRevision: null,
  queue: [],
  review: null,
  conflictMsg: '',
  setSource: (source) =>
    set({
      source,
      // 会话 id 与文档源同生同灭：源是从【当前会话】的消息树推导出来的，故此刻的前台会话
      // 就是这篇稿子的归属会话。切源 = 换了篇稿子（多半也换了会话），一并刷新。
      sessionId: source ? useChatStore.getState().sessionId : null,
      sections: [],
      outlineTotal: null,
      status: 'idle',
      errMsg: '',
      // 改写态一律跟着源清空：pending/queue/review 里的 sectionName 只对旧文档有意义，
      // 留到新文档上会往错的文件里写内容——这类「跨文档串台」是不可逆的正文损坏。
      pendingRevision: null,
      queue: [],
      review: null,
      conflictMsg: ''
    }),
  bindSession: (sessionId) => {
    if (get().sessionId === sessionId) return
    // 换了归属会话就清改写态：旧会话的 pending 不该由新会话的轮末来兑现（那会把别的
    // 对话的回复当成这条改写的结果推给用户确认）。
    set({ sessionId, pendingRevision: null, queue: [], review: null, conflictMsg: '' })
  },
  applyScan: ({ genre, outlineTotal }) => set({ genre, outlineTotal }),
  setSections: (sections) => set({ sections }),
  setStatus: (status, errMsg = '') => set({ status, errMsg }),
  replaceSectionMarkdown: (name, markdown, mtimeMs) =>
    set((s) => ({
      sections: s.sections.map((sec) => (sec.name === name ? { ...sec, markdown, mtimeMs } : sec))
    })),
  setPendingRevision: (pendingRevision) => set({ pendingRevision }),
  pushQueue: (item) => {
    if (get().queue.length >= MAX_WRITING_REVISION_QUEUE) return false
    set((s) => ({ queue: [...s.queue, item] }))
    return true
  },
  shiftQueue: () => {
    const head = get().queue[0] ?? null
    if (head) set((s) => ({ queue: s.queue.slice(1) }))
    return head
  },
  setReview: (review) => set({ review }),
  setConflictMsg: (conflictMsg) => set({ conflictMsg })
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
