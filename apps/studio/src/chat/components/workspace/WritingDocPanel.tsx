import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/src/components/ui/button'
import { cn } from '@/src/lib/utils'
import { splitBlocks } from '@desktop-shared/proposalBlocks'
import { joinWritingSections, shouldPageBreak } from '@desktop-shared/writing'
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
import { writingStyleFor } from '../../lib/writingGenreStyle'
import { renderProposalPdfHtml } from '../../lib/renderProposalPdfHtml'
import { deriveWritingExportBaseName } from '../../lib/writingExportInput'
import { WritingPaper } from './WritingPaper'
import { WritingPreview } from './WritingPreview'
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
  // 只用来决定「复制公众号 HTML」按钮是否显示；导出按钮点击时一律现读 getState()（见
  // buildExportInput），不吃这份渲染期快照。
  const genre = useWritingStore((s) => s.genre)
  const [tab, setTab] = useState<'doc' | 'preview'>('doc')
  // 导出反馈条：{tone,text} 而非纯字符串——'err' 用醒目色，'ok'/'muted' 用弱化色，与
  // ProposalDocPanel 的 exportMsg 同款约定（同一份代码里两处导出条不该长得不一样）。
  const [exportMsg, setExportMsg] = useState<{ tone: 'ok' | 'err' | 'muted'; text: string } | null>(
    null
  )
  // 导出在飞：防止用户连点弹出多个保存对话框。三种导出各自独立（Word 在飞不该锁住微信复制）。
  const [exportingDocx, setExportingDocx] = useState(false)
  const [exportingPdf, setExportingPdf] = useState(false)
  const [copyingWechat, setCopyingWechat] = useState(false)
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
      // 发送前先尝试重定位（复审 F2）：气泡从「算出 beforeMarkdown」到用户真正点「改写」
      // 之间可能过了几秒到几十秒，这期间 AI 若在这一节别处插入/删除了块（良性位移，
      // 选中的内容本身没变），target.range 会漂但 beforeMarkdown 仍然能在新位置找到。
      // 排空 effect 早已对排队改写这么做（见上面的 useEffect），这里是把同一处理
      // 补给「AI 空闲、直接发送」这条路径——否则这类良性位移会被下面的一致性校验当成
      // 「选区已失效」硬拒，而其实 relocateTarget 本可以救回来。relocate 失败（那几块
      // 真的被改写/删除了）就保留原 target，交给 buildRevisionMessage 走已有的拒绝路径。
      const relocated = relocateTarget(sec.markdown, target)
      const effectiveTarget = relocated ? { ...target, range: relocated.range } : target
      const msg = buildRevisionMessage({
        sectionMarkdown: sec.markdown,
        target: effectiveTarget,
        instruction
      })
      if (!msg) {
        // buildRevisionMessage 返回 null = 空指令或区间越界。静默会表现为「点了没反应」。
        console.warn('[writing-revise] 跳过：改写消息组装失败（空指令或区间越界）', target)
        st.setConflictMsg('这条改写没能组装出来（选区已失效），请重新选中再试。')
        return
      }
      // 先立 pending 再发：它同时是「防重入」和「轮末该走哨兵抽取」的闸，必须在任何 await
      // 之前同步生效（排空 effect 与用户连点都可能在这一瞬间再次进来）。存 effectiveTarget
      // （relocate 之后的 range）而不是原始 target——轮末 handleWritingTurnEnd 还要拿它再
      // relocate 一次，range 越准确，多处命中时"离哪里最近"这个提示就越可信。
      st.setPendingRevision(effectiveTarget)
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
      if ((!sent || !airborne) && nowSt.pendingRevision === effectiveTarget) {
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
    // 用提交那一刻的块源码切片重新定位。找不到 = 那几块已被 AI 重写，宁可跳过也不改错段落。
    // 这里只要 range：ambiguous（多处命中选错的风险）留给最终成卡的 handleWritingTurnEnd
    // 去透传给用户——这一步只是决定"这条排队改写该发给哪一段"，不产出对照卡。
    const relocated = relocateTarget(sec.markdown, head.target)
    if (!relocated) {
      st.shiftQueue()
      st.setConflictMsg('有一条排队的改写找不到原文了（那段可能已被 AI 重写），已跳过。')
      return
    }
    // 校验全过才出队。submitRevision 会在任何 await 之前同步立起 pendingRevision，
    // 故 StrictMode 的第二次进来会被上面的现读守卫挡住，不会重复消费。
    st.shiftQueue()
    void submitRevision({ ...head.target, range: relocated.range }, head.instruction)
  }, [streaming, pendingRevision, review, queueLen, submitRevision])

  /**
   * 应用改写：重定位 → 拼回整节 → 乐观锁写盘。冲突时不覆盖，提示用户并刷新到最新。
   *
   * 两条容易写错、写错就静默毁正文的规矩：
   *  1. **乐观锁基准用 `r.baseMtimeMs`（成卡那一刻的），不是 `sec.mtimeMs`（现读的）。**
   *     轮询每 2s 刷一次 sections 连同 mtime，用现读值当基准，锁就只覆盖「最后一次轮询到
   *     写盘」那 2 秒，而不是整个用户裁决窗口——「AI 在用户裁决期间又改过这一节」这个最该
   *     拦的场景反而被放行。完整推演见 WritingRevisionReview.baseMtimeMs 注释。
   *  2. **先做逐字节自检，对不上才重定位；重定位也失败就拒写。**
   *     自检 = 「卡上那几块是不是还原封不动待在原位」：
   *     `splitBlocks(现在的正文).slice(卡里的 range) === r.before`。
   *     `before` 本来就是用**同一个 splitBlocks、从同一版正文**切出来的，所以
   *     **内容真没变时必然逐字节相等，零误拒**；一旦那几块被动过（改了 / 被前面插入的段落挤走
   *     / 越界），立刻不相等，转去用「提交那一刻的块源码切片」（`r.target.beforeMarkdown`）
   *     重新定位，定位不到就别写。
   *     【为什么不无条件重定位（Task 11 之后）】：`relocateTarget` 现在是源码级精确匹配
   *     （见 writingRevision.ts），内容原地未变时它与这里的自检结果等价——不再有 Task 6/7
   *     那套渲染文本模糊定位器"跨 `**加粗**`/多列表项/表格必然落空"的弱点。保留自检优先仍
   *     值得：它是 O(1) 的原地相等判断，不无条件重定位是为了避免在「绝大多数情况下内容根本
   *     没变」这条热路径上，仍去扫一遍全节找所有匹配位置——纯粹是省一次没必要的工作，
   *     不再是"不然会误拒"这个正确性理由（那已随模糊匹配一起被删掉）。
   *     【为什么用内容自检而不是比 mtime】：mtime 相等只说明「文件时间戳没动」，盖不住
   *     时间戳精度不足、以及读节时 stat 与 read 之间那个窗口（拿到新正文配旧时间戳）。
   *     自检问的是「我要替换的那几块，确实还是给你看过的那几块吗」——那才是真正要确认的事。
   *
   * **这里的 `relocateTarget` 实际只承担一个角色：返回 null 时给出更准确的拒写提示。别误以为
   * 它在救场。** 推理链：能写进盘的充要条件是「盘上 mtime === `r.baseMtimeMs`」（乐观锁），
   * 而 store 的正文只可能等于或旧于盘上；两者 mtime 相同 ⟹ store 里这份就是成卡那一版 ⟹
   * 逐字节自检必过 ⟹ 根本走不到 relocate 分支。反过来，走到 relocate 分支就说明 store 已不是
   * 成卡那一版，此时即便重定位成功、后面的写盘也必然撞乐观锁冲突。
   * 所以「自检不过 → 重定位 → 成功 → 写入」这条路**不存在能真正落地的分支**，它的产出只是
   * 「拒写时告诉用户是『找不到原文』还是『被人改过』」。**若将来有人想让它真的救场，那要改的
   * 是锁基准（把 `expectedMtimeMs` 从 `r.baseMtimeMs` 换成 `sec.mtimeMs`），而那会推翻 H1 修复
   * 的语义前提——别顺手改，先回到 H1 的推演。**
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
    // 逐字节自检（理由见函数头注释第 2 条）：卡上那几块还原封不动待在原位 → 直接用卡里的
    // range；被动过 → 拿当初选中的原文重新定位；再定位不到 = 那段已被重写，此时照 stale range
    // 硬拼改的就是隔壁段落（spliceBlocks 还会把越界序号 clamp 到最后一块）——宁可不写，让用户重来。
    const blocks = splitBlocks(sec.markdown)
    const cardRange = r.target.range
    const intact =
      cardRange.start >= 0 &&
      cardRange.end >= cardRange.start &&
      cardRange.end < blocks.length &&
      blocks.slice(cardRange.start, cardRange.end + 1).join('\n\n') === r.before
    const range = intact ? cardRange : (relocateTarget(sec.markdown, r.target)?.range ?? null)
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

  // 导出反馈条 4s 后自动收起（同 ProposalDocPanel 的 exportMsg 约定）——它只是「刚才那次
  // 导出/复制成功与否」的一次性回执，不是需要用户手动确认的告警（那种用上面的 conflictMsg 条）。
  useEffect(() => {
    if (!exportMsg) return
    const id = setTimeout(() => setExportMsg(null), 4000)
    return () => clearTimeout(id)
  }, [exportMsg])

  /**
   * 导出用的完整 markdown 与默认文件名。**现读 getState()**：三个导出按钮共用这个函数，
   * 点击那一刻的 sections/genre 应该是最新的，不吃渲染期闭包（与本文件其余状态读取纪律一致）。
   * 文件名取拼合后全篇第一个一级标题，取不到用「文稿」（deriveWritingExportBaseName）。
   */
  function buildExportInput(): { markdown: string; baseName: string } {
    const st = useWritingStore.getState()
    const markdown = joinWritingSections(st.sections, { pageBreaks: shouldPageBreak(st.genre) })
    return { markdown, baseName: deriveWritingExportBaseName(markdown) }
  }

  async function exportDocx(): Promise<void> {
    if (exportingDocx) return
    const { markdown, baseName } = buildExportInput()
    if (!markdown) {
      setExportMsg({ tone: 'muted', text: '正文为空，无内容可导出' })
      return
    }
    setExportingDocx(true)
    try {
      const r = await window.chatApi.writingExportDocx({
        markdown,
        style: writingStyleFor(useWritingStore.getState().genre),
        defaultBaseName: baseName
      })
      setExportMsg(
        r.path ? { tone: 'ok', text: `已导出：${r.path}` } : { tone: 'muted', text: '已取消导出' }
      )
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      console.error('[writing-export docx]', err)
      setExportMsg({ tone: 'err', text: `导出失败：${m}` })
    } finally {
      setExportingDocx(false)
    }
  }

  async function exportPdf(): Promise<void> {
    if (exportingPdf) return
    const { markdown, baseName } = buildExportInput()
    if (!markdown) {
      setExportMsg({ tone: 'muted', text: '正文为空，无内容可导出' })
      return
    }
    setExportingPdf(true)
    try {
      // renderProposalPdfHtml 的第三个参数（预渲 mermaid 图）不是可选参数，写作体裁不支持
      // mermaid 代码块，必须显式传 undefined——漏传是 TS2554（Task 8 踩过的坑，见 WritingPreview）。
      const html = await renderProposalPdfHtml(
        markdown,
        writingStyleFor(useWritingStore.getState().genre),
        undefined
      )
      const { bytes } = await window.chatApi.renderProposalPdf({ html })
      const r = await window.chatApi.writingExportPdf({ bytes, defaultBaseName: baseName })
      setExportMsg(
        r.path ? { tone: 'ok', text: `已导出：${r.path}` } : { tone: 'muted', text: '已取消导出' }
      )
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      console.error('[writing-export pdf]', err)
      setExportMsg({ tone: 'err', text: `导出失败：${m}` })
    } finally {
      setExportingPdf(false)
    }
  }

  /**
   * 微信：复制而非存文件——公众号的工作流就是粘贴，存成 .html 还得再打开复制一次。
   * `ClipboardItem` 同时写 text/html 与 text/plain：公众号编辑器读 HTML flavor 才能保住样式，
   * 纯文本 flavor 是给其他编辑器（或粘贴到聊天框之类的场景）的兜底，不写它会导致普通编辑器
   * 粘贴出一整段裸 HTML 源码。
   */
  async function copyWechat(): Promise<void> {
    if (copyingWechat) return
    const { markdown } = buildExportInput()
    if (!markdown) {
      setExportMsg({ tone: 'muted', text: '正文为空，无内容可复制' })
      return
    }
    setCopyingWechat(true)
    try {
      const r = await window.chatApi.writingWechatHtml({ markdown, styleName: 'wechat-default' })
      if (!r.ok) {
        setExportMsg({ tone: 'err', text: `生成失败：${r.error}` })
        return
      }
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([r.html], { type: 'text/html' }),
          'text/plain': new Blob([r.html], { type: 'text/plain' })
        })
      ])
      setExportMsg(
        r.styleFallback
          ? { tone: 'muted', text: '已复制（样式文件未找到，用了内置样式）' }
          : { tone: 'ok', text: '已复制，可粘贴进公众号编辑器' }
      )
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      console.error('[writing-export wechat]', err)
      setExportMsg({ tone: 'err', text: `复制失败：${m}` })
    } finally {
      setCopyingWechat(false)
    }
  }

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
        {/* 右侧一组：排队计数 + 导出反馈 + 导出按钮。包一层 ml-auto 而不是挂在排队计数上——
            排队计数是条件渲染，若把 ml-auto 放它身上，队列一空右侧这组就会贴着 tab 按钮，
            导出按钮组的位置会跟着队列有无跳动。 */}
        <div className="ml-auto flex items-center gap-2">
          {/* 排队计数放顶栏：气泡发完就收起，没有它用户看不出「我排的那几条还在不在」。 */}
          {queueLen > 0 && (
            <span className="text-[11px] text-muted-foreground">{queueLen} 条改写排队中</span>
          )}
          {exportMsg && (
            <span
              className={cn(
                'max-w-[220px] truncate text-[11px]',
                exportMsg.tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
                exportMsg.tone === 'err' && 'text-rose-600 dark:text-rose-400',
                exportMsg.tone === 'muted' && 'text-muted-foreground'
              )}
              title={exportMsg.text}
            >
              {exportMsg.text}
            </span>
          )}
          <Button variant="ghost" size="xs" disabled={exportingDocx} onClick={() => void exportDocx()}>
            导出 Word
          </Button>
          <Button variant="ghost" size="xs" disabled={exportingPdf} onClick={() => void exportPdf()}>
            导出 PDF
          </Button>
          {genre === 'wechat' && (
            <Button
              variant="ghost"
              size="xs"
              disabled={copyingWechat}
              onClick={() => void copyWechat()}
            >
              复制公众号 HTML
            </Button>
          )}
        </div>
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
      {/* 用 hidden 类切换而非条件卸载：WritingPreview 内部靠 lastRendered 缓存跳过重渲，
          切走再切回若被卸载会丢掉这份缓存、每次都重新生成一遍 PDF/微信 HTML。 */}
      <div className={cn('flex min-h-0 flex-1 flex-col', tab === 'preview' ? '' : 'hidden')}>
        <WritingPreview active={tab === 'preview'} />
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
