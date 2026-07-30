import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/src/components/ui/button'
import { cn } from '@/src/lib/utils'
import { useChatStore } from '../../stores/chat'
import {
  MAX_WRITING_REVISION_QUEUE,
  useWritingInProgress,
  useWritingPoll,
  useWritingSource,
  useWritingStore
} from '../../stores/writing'
import {
  applyRevision,
  buildRevisionMessage,
  relocateTarget,
  type WritingRevisionTarget
} from '../../lib/writingRevision'
import { sendWritingMessage } from '../../lib/sendWritingMessage'
import { WritingPaper } from './WritingPaper'
import { WritingRevisionReviewCard } from './WritingRevisionReview'

/**
 * 写作工作区右栏。两个 tab：文稿（可选区改写的排版纸面）与打印预览（真 PDF / 微信手机宽）。
 *
 * 顶栏**不标 app-region:drag**：根 layout 的 .window-drag-strip 是全应用唯一的拖拽面，
 * 组件顶栏再标会复发「整窗拖不动 + 双击不缩放」（CLAUDE.md 记了 7 条同族事故）。
 *
 * 本组件是选区改写闭环的调度中枢：气泡（在纸面里）派发 → 这里决定「直发还是排队」→
 * 轮末哨兵抽取（FusionRuntimeProvider）产出对照卡 → 用户点应用 → 乐观锁写盘。
 */
export function WritingDocPanel(): React.JSX.Element | null {
  const source = useWritingSource()
  const setSource = useWritingStore((s) => s.setSource)
  const storeSource = useWritingStore((s) => s.source)
  const [tab, setTab] = useState<'doc' | 'preview'>('doc')
  // 「这一轮在写这篇稿子」而非会话级 streaming——见 useWritingInProgress 头注释，
  // 避免全文写完后用户提问还挂着「正在写第 N 节」的骨架。
  const writing = useWritingInProgress()

  // 会话消息推导出的源与 store 里的不一致时同步（切会话 / 开了新项目）。
  // 【必须放 useEffect 里】：渲染期间直接调 setState 会触发 React 的
  // "Cannot update a component while rendering a different component" 警告，
  // 且在 StrictMode 下会重复执行。用序列化后的字符串当依赖，避免对象引用每帧变化导致死循环。
  const sourceKey = source ? JSON.stringify(source) : ''
  const storeSourceKey = storeSource ? JSON.stringify(storeSource) : ''
  useEffect(() => {
    if (sourceKey !== storeSourceKey) setSource(source)
  }, [sourceKey, storeSourceKey, source, setSource])

  // 归属会话补同步。source 是从【前台会话】的消息树推导的，故它非空时归属会话恒等于前台
  // 会话；但「切到另一个写同一篇稿子的会话」时源字面没变、上面那条 effect 不触发，
  // sessionId 会留成旧的，之后每次点改写都撞一致性校验静默 no-op（「点了没反应」）。
  const chatSessionId = useChatStore((s) => s.sessionId)
  const bindSession = useWritingStore((s) => s.bindSession)
  useEffect(() => {
    if (source) bindSession(chatSessionId)
  }, [source, chatSessionId, bindSession])

  useWritingPoll(storeSource !== null)

  // ── 选区改写调度 ────────────────────────────────────────────────────────
  // 会话级 streaming（不是 useWritingInProgress）：排队闸问的是「AI 这会儿忙不忙」，
  // 它跑 shell、回答问题时同样发不出第二轮，与「是否在落字」无关。
  const writingSid = useWritingStore((s) => s.sessionId)
  const streaming = useChatStore((s) =>
    writingSid ? (s.perSession[writingSid]?.streaming ?? false) : false
  )
  const queueLen = useWritingStore((s) => s.queue.length)
  const pendingRevision = useWritingStore((s) => s.pendingRevision)
  const review = useWritingStore((s) => s.review)
  const conflictMsg = useWritingStore((s) => s.conflictMsg)
  // 写盘在飞：禁用对照卡按钮防重入（同一条改写写两遍，第二遍必撞乐观锁刷出假冲突）。
  const [applying, setApplying] = useState(false)

  /**
   * 派发或排队。AI 忙时排队——写作是长流水线，AI 大部分时间在写下一节，照搬 proposal
   * 「streaming 时拒绝改写」的硬闸会让气泡永远点了没反应。
   *
   * 一切状态**现读 `getState()`**、不吃渲染期闭包：这个函数会被排空 effect 在任意时刻调用，
   * 那一刻的 sections / streaming 可能比渲染时新好几轮（AI 每 2s 就可能刷一次正文）。
   */
  const submitRevision = useCallback(
    async (target: WritingRevisionTarget, instruction: string): Promise<void> => {
      const st = useWritingStore.getState()
      const sid = st.sessionId
      const streamingNow = sid
        ? (useChatStore.getState().perSession[sid]?.streaming ?? false)
        : false
      if (streamingNow || st.pendingRevision) {
        // 忙：入队，等轮末/写盘完成后由排空 effect 串行发起。满了要出声，别静默吞掉指令。
        const ok = st.pushQueue({ id: crypto.randomUUID(), target, instruction })
        if (!ok) {
          st.setConflictMsg(`排队已满（上限 ${MAX_WRITING_REVISION_QUEUE} 条），等几条跑完再排。`)
        }
        return
      }
      const sec = st.sections.find((s) => s.name === target.sectionName)
      if (!sec) {
        console.warn('[writing-revise] 跳过：目标节已不在 sections 里', target.sectionName)
        return
      }
      const msg = buildRevisionMessage({
        sectionMarkdown: sec.markdown,
        target,
        instruction
      })
      if (!msg) {
        // buildRevisionMessage 返回 null = 空指令或区间越界。静默会表现为「点了没反应」。
        console.warn('[writing-revise] 跳过：改写消息组装失败（空指令或区间越界）', target)
        return
      }
      // 先立 pending 再发：它同时是「防重入」和「轮末该走哨兵抽取」的闸，必须在任何 await
      // 之前同步生效（排空 effect 与用户连点都可能在这一瞬间再次进来）。
      st.setPendingRevision(target)
      const sent = await sendWritingMessage(msg)
      if (!sent) {
        // 没发出去（会话漂移）却留着 pending，这条改写会永远停在「等 AI 回复」，
        // 后面排队的也跟着停摆——必须收回来。
        useWritingStore.getState().setPendingRevision(null)
        useWritingStore
          .getState()
          .setConflictMsg('改写没能发出（当前会话已切换），请回到这篇稿子的会话再试。')
      }
    },
    []
  )

  /**
   * 排空队列：AI 空闲、没有在飞的改写、也没有待裁决的对照卡时，取队首执行。
   *
   * effect 只负责【什么时候触发】（四个门控值任一变化就重估），队列本身与正文一律
   * 现读 store——排队期间前面的改写可能已落地、块序号漂了，渲染期闭包里的 sections 是旧的。
   * `review` 也在依赖里：用户点完「应用/放弃」后队列必须自己续上，否则剩下的永远停摆。
   */
  useEffect(() => {
    if (streaming || pendingRevision || review || queueLen === 0) return
    const st = useWritingStore.getState()
    const head = st.shiftQueue()
    if (!head) return
    const sec = st.sections.find((s) => s.name === head.target.sectionName)
    if (!sec) {
      st.setConflictMsg('有一条排队的改写找不到对应的章节文件了，已跳过。')
      return
    }
    // 用当初选中的原文重新定位。找不到 = 那段已被 AI 重写，宁可跳过也不改错段落。
    const range = relocateTarget(sec.markdown, head.target)
    if (!range) {
      st.setConflictMsg('有一条排队的改写找不到原文了（那段可能已被 AI 重写），已跳过。')
      return
    }
    void submitRevision({ ...head.target, range }, head.instruction)
  }, [streaming, pendingRevision, review, queueLen, submitRevision])

  /** 应用改写：拼回整节 → 乐观锁写盘。冲突时不覆盖，提示用户并刷新到最新。 */
  const applyReview = useCallback(async (): Promise<void> => {
    // 同上，一律现读：await 期间轮询可能已经刷过 sections（mtime 变了），用渲染期快照
    // 里的 mtime 当乐观锁基准会撞出假冲突。
    const st = useWritingStore.getState()
    const r = st.review
    const src = st.source
    if (!r || !src) return
    const sec = st.sections.find((s) => s.name === r.target.sectionName)
    if (!sec) {
      st.setConflictMsg('这一节的文件已不在了，改写未写入。')
      st.setReview(null)
      return
    }
    setApplying(true)
    try {
      const next = applyRevision(sec.markdown, r.target.range, r.after)
      const res = await window.chatApi.writingWriteSection({
        source: src,
        name: r.target.sectionName,
        markdown: next,
        expectedMtimeMs: sec.mtimeMs
      })
      const after = useWritingStore.getState()
      if (res.ok) {
        after.replaceSectionMarkdown(r.target.sectionName, next, res.mtimeMs)
        after.setReview(null)
        after.setConflictMsg('')
        return
      }
      if (res.conflict) {
        // 乐观锁拦下：AI 在用户裁决期间又改过这一节。**不覆盖**，把盘上最新的灌回来。
        if (res.current) {
          after.replaceSectionMarkdown(
            r.target.sectionName,
            res.current.markdown,
            res.current.mtimeMs
          )
        }
        after.setConflictMsg(
          '这一节刚被 AI 改过，你的改动未生效。已刷新到最新内容，请重新选中修改。'
        )
        after.setReview(null)
        return
      }
      after.setConflictMsg(`写入失败：${res.error}`)
    } finally {
      setApplying(false)
    }
  }, [])

  if (!storeSource) return null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border bg-background">
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
        {/* 排队计数放顶栏：气泡发完就收起，没有它用户看不出「我排的那几条还在不在」。 */}
        {queueLen > 0 && (
          <span className="ml-auto text-[11px] text-muted-foreground">{queueLen} 条改写排队中</span>
        )}
      </div>

      {/* 一次性提示条（写盘冲突 / 排队项被跳过 / 队列满）。可手动关掉，不自动消失
          ——自动消失的提示用户多半没看见，而这几条都意味着「你的改动没生效」。 */}
      {conflictMsg && (
        <div className="flex items-start gap-2 border-b border-border bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-400">
          <span className="flex-1">{conflictMsg}</span>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => useWritingStore.getState().setConflictMsg('')}
          >
            知道了
          </Button>
        </div>
      )}

      <div className={cn('flex min-h-0 flex-1 flex-col', tab === 'doc' ? '' : 'hidden')}>
        <WritingPaper
          writing={writing}
          busy={streaming || pendingRevision !== null}
          onRevise={(target, instruction) => void submitRevision(target, instruction)}
        />
      </div>
      {/* 打印预览在 Task 8 接入；此处先占位，避免切过去是一片空白无解释。 */}
      <div className={cn('grid flex-1 place-items-center', tab === 'preview' ? '' : 'hidden')}>
        <div className="text-[12.5px] text-muted-foreground">打印预览即将接入</div>
      </div>

      {/* 对照卡挂在**两个 tab 之外**（面板级），不随 tab 隐藏：待裁决的改写会挡住队列排空
          （排空 effect 以 review 为闸），若它藏在文稿 tab 里，用户切到打印预览时会看到
          「排队几条一直不动、也不知道为什么」——把裁决入口藏起来等于让功能卡死。 */}
      <WritingRevisionReviewCard
        applying={applying}
        onApply={() => void applyReview()}
        onDiscard={() => useWritingStore.getState().setReview(null)}
      />
    </div>
  )
}
