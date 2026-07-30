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
        // 出声而不是静默 return：这条路径上用户的指令已经被消费掉了（气泡已收起 / 队列已出队），
        // 不给提示就是「指令凭空消失」。
        console.warn('[writing-revise] 跳过：目标节已不在 sections 里', target.sectionName)
        st.setConflictMsg(`「${target.sectionName}」已不在文稿里，这条改写没有发出。`)
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
        st.setConflictMsg('这条改写没能组装出来（选区已失效），请重新选中再试。')
        return
      }
      // 先立 pending 再发：它同时是「防重入」和「轮末该走哨兵抽取」的闸，必须在任何 await
      // 之前同步生效（排空 effect 与用户连点都可能在这一瞬间再次进来）。
      st.setPendingRevision(target)
      const sent = await sendWritingMessage(msg)
      // 起飞判定（照搬 proposal drainRevisionQueue 的 H3 判据）：**不能靠 catch 判成败**——
      // dispatchChatTurn 把 chatApi.send 的异常自己吞了（catch 里直接调 store 的
      // endAssistantMessage，不经事件管线），sendWritingMessage 照样正常返回，catch 是死代码。
      // 改判 streaming：发起后仍为假 = 这轮根本没起飞（会话漂移早退 / send 被吞），
      // 此时 'end' 与 'error' 都永远不会到，pendingRevision 没人清 —— 而它正是排空 effect 的闸，
      // 留着就是【整个改写队列永久锁死】且界面上零解释。故就地清掉 + 提示。
      const nowSt = useWritingStore.getState()
      const sidNow = nowSt.sessionId
      const airborne = sidNow
        ? (useChatStore.getState().perSession[sidNow]?.streaming ?? false)
        : false
      // `pendingRevision === target` 是精度闸：只有「我立的那个 pending 还在」时才由我收尾。
      // 别人（轮末钩子 / onTurnError / 换源）已经清过或换过，就别再插一脚——否则会在对照卡
      // 已经出来的情况下弹一条「没能发出去」的假警报。
      if ((!sent || !airborne) && nowSt.pendingRevision === target) {
        nowSt.setPendingRevision(null)
        nowSt.setConflictMsg(
          sent
            ? '这条改写没能发出去（发送失败或会话已结束），正文未改动，请重新发起。'
            : '改写没能发出（当前会话已切换），请回到这篇稿子的会话再试。'
        )
      }
    },
    []
  )

  /**
   * 排空队列：AI 空闲、没有在飞的改写、也没有待裁决的对照卡时，取队首执行。
   *
   * 依赖数组只回答「**什么时候**重新评估」，**所有判断本身一律现读 `getState()`**。
   * 两件事逼出这个纪律：
   *  - 渲染期快照会过期。StrictMode 下 effect 双跑，第二次拿的还是第一次那份快照
   *    （`pendingRevision` 仍是 null），若守卫信它就会再出队一条，而 submitRevision 现读
   *    发现 pending 已占 → 把它 pushQueue 回**队尾**（换了新 id）。数据不丢，但队列顺序漂了。
   *  - 排队期间前面的改写可能已落地、块序号漂了，闭包里的 sections 是旧的。
   *
   * **先校验、后出队**（peek → 校验 → shift），不是任务书原稿的「先出队再校验」：出了队
   * 才发现发不出去，只能塞回队尾（顺序漂）或就地丢弃（用户指令凭空消失），两条都不体面。
   *
   * `review` 也在依赖里：用户点完「应用/放弃」后队列必须自己续上，否则剩下的永远停摆。
   */
  useEffect(() => {
    const st = useWritingStore.getState()
    const sid = st.sessionId
    const streamingNow = sid
      ? (useChatStore.getState().perSession[sid]?.streaming ?? false)
      : false
    if (streamingNow || st.pendingRevision || st.review) return
    // peek：校验没过就不动队列，队首留在原位等下一次触发（下面两条跳过分支才真出队）。
    const head = st.queue[0]
    if (!head) return
    const sec = st.sections.find((s) => s.name === head.target.sectionName)
    if (!sec) {
      st.shiftQueue()
      st.setConflictMsg('有一条排队的改写找不到对应的章节文件了，已跳过。')
      return
    }
    // 用当初选中的原文重新定位。找不到 = 那段已被 AI 重写，宁可跳过也不改错段落。
    const range = relocateTarget(sec.markdown, head.target)
    if (!range) {
      st.shiftQueue()
      st.setConflictMsg('有一条排队的改写找不到原文了（那段可能已被 AI 重写），已跳过。')
      return
    }
    // 校验全过才出队。submitRevision 会在任何 await 之前同步立起 pendingRevision，
    // 故 StrictMode 的第二次进来会被上面的现读守卫挡住，不会重复消费。
    st.shiftQueue()
    void submitRevision({ ...head.target, range }, head.instruction)
  }, [streaming, pendingRevision, review, queueLen, submitRevision])

  /**
   * 应用改写：重定位 → 拼回整节 → 乐观锁写盘。冲突时不覆盖，提示用户并刷新到最新。
   *
   * 两条容易写错、写错就静默毁正文的规矩：
   *  1. **乐观锁基准用 `r.baseMtimeMs`（成卡那一刻的），不是 `sec.mtimeMs`（现读的）。**
   *     轮询每 2s 刷一次 sections 连同 mtime，用现读值当基准，锁就只覆盖「最后一次轮询到
   *     写盘」那 2 秒，而不是整个用户裁决窗口——「AI 在用户裁决期间又改过这一节」这个最该
   *     拦的场景反而被放行。完整推演见 WritingRevisionReview.baseMtimeMs 注释。
   *  2. **正文变过才重定位（第二道保险），没变过就直接信卡里的 range。**
   *     `sec.mtimeMs === r.baseMtimeMs` 时，store 里这份**就是**成卡时那一版，`r.target.range`
   *     是对它算出来的、逐字节有效，无需也不该再定位一次。只有 store 已被轮询刷成别的版本时
   *     才需要用「当初选中的原文」重新定位，找不到就别写。
   *     【为什么不无条件重定位】：`relocateTarget` 拿**渲染后的选中文字**去 markdown 源码里
   *     找，选区一旦跨了 `**加粗**` / 行内代码 / 链接 / 多个列表项 / 表格，必然定位失败（Task 6
   *     定位器的已知限制）。无条件重定位会让这类选区**连正文根本没变的正常情况都拒写**——
   *     职场文档、文章这类多加粗多项目符号的体裁，那是常态而非偶发，等于主路径直接不可用。
   *     用 mtime 把「需不需要重定位」判准，既保住了保险、又不误伤没变过的正文。
   * 其余状态一律现读 getState()，不吃渲染期闭包（await 期间轮询可能已经刷过 sections）。
   */
  const applyReview = useCallback(async (): Promise<void> => {
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
    // 双保险（仅在正文确实变过时才需要，理由见函数头注释第 2 条）：store 里这份若已不是成卡
    // 那一版，就拿当初选中的原文重新定位；拿不到 = 那段已被重写，此时照 stale range 硬拼改的
    // 就是隔壁段落——宁可不写，让用户重来。
    const range =
      sec.mtimeMs === r.baseMtimeMs ? r.target.range : relocateTarget(sec.markdown, r.target)
    if (!range) {
      st.setConflictMsg('这一节的原文已经变了，找不到当初选中的那段，改动未写入，请重新选中修改。')
      st.setReview(null)
      return
    }
    setApplying(true)
    try {
      const next = applyRevision(sec.markdown, range, r.after)
      const res = await window.chatApi.writingWriteSection({
        source: src,
        name: r.target.sectionName,
        markdown: next,
        expectedMtimeMs: r.baseMtimeMs
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
