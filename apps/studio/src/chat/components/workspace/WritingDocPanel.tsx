import { useCallback, useEffect, useState } from 'react'

import { Button } from '@/src/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/src/components/ui/dropdown-menu'
import { cn } from '@/src/lib/utils'
import { splitBlocks } from '@desktop-shared/proposalBlocks'
import { joinWritingSections, shouldPageBreak } from '@desktop-shared/writing'
import { useChatStore } from '../../stores/chat'
import {
  MAX_WRITING_REVISION_QUEUE,
  useWritingInProgress,
  useWritingStore
} from '../../stores/writing'
import {
  applyRevision,
  buildRevisionMessage,
  relocateTarget,
  type WritingRevisionTarget
} from '../../lib/writingRevision'
import { sendWritingMessage } from '../../lib/sendWritingMessage'
import { replaceBlockAt } from '../../lib/writingEdit'
import { writingStyleFor } from '../../lib/writingGenreStyle'
import { renderProposalPdfHtml } from '../../lib/renderProposalPdfHtml'
import { deriveWritingExportBaseName } from '../../lib/writingExportInput'
import { buildWechatCopyMsg } from '../../lib/writingWechatCopyMsg'
import { writingAssetBaseDir } from '../../lib/writingAssetUrl'
import { extractMermaidBlocks, renderMermaidImageMap } from '../../lib/mermaidRender'
// 顶栏图标与方案面板同源（proposalIcons 是历史位置，不代表只归方案用）——两处右栏
// 的导出入口要长成一套，图标就不能各挑各的。
import { ChevronDownIcon, FileCodeIcon, FileIcon, FileTextIcon } from './proposalIcons'
import { WritingPaper } from './WritingPaper'
import { WritingRevisionReviewCard } from './WritingRevisionReview'

/**
 * 写作工作区右栏：一块文稿纸面（可选区改写的排版视图）。
 *
 * 【2026-07-31 去掉了「打印预览」tab】原本顶栏有「文稿 ｜ 打印预览」segmented，预览走
 * 与导出 PDF 完全相同的引擎渲染一份真 PDF。移除后导出仍在（下拉里的 PDF / Word /
 * 公众号 HTML 一个没少），只是不再在应用内先渲一遍给人看。要恢复的话，组件本体在
 * git 历史里（WritingPreview.tsx），它依赖的 usePreviewFrame / PreviewStateOverlay
 * 还留着（方案端预览仍在用）。
 *
 * 顶栏**不标 app-region:drag**：根 layout 的 .window-drag-strip 是全应用唯一的拖拽面，
 * 组件顶栏再标会复发「整窗拖不动 + 双击不缩放」（CLAUDE.md 记了 7 条同族事故）。
 * 反过来，顶栏又整条落在那条 46px 拖拽带里，所以**栏内交互控件必须 no-drag 挖洞**，
 * 否则点击被拖窗吞掉——两件事是一体两面，缺哪一半都出问题，详见顶栏那段行内注释。
 *
 * 本组件是选区改写闭环的调度中枢：气泡（在纸面里）派发 → 这里决定「直发还是排队」→
 * 轮末哨兵抽取（FusionRuntimeProvider）产出对照卡 → 用户点应用 → 乐观锁写盘。
 */
export function WritingDocPanel(): React.JSX.Element | null {
  // 只读 store，不自己灌数据：消息推导 → setSource → 轮询拉正文那一整套泵住在
  // useWritingWorkspaceGate（ThreadView 调用）里。**别把它们挪回来**——泵在面板里就意味着
  // 「门要有正文才开、正文要面板挂载才拉」的自锁环，那正是 2026-07-31 这次重构解开的东西。
  const storeSource = useWritingStore((s) => s.source)
  // 只用来决定「复制公众号 HTML」按钮是否显示；导出按钮点击时一律现读 getState()（见
  // buildExportInput），不吃这份渲染期快照。
  const genre = useWritingStore((s) => s.genre)
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

  // 顶栏活性徽章。三态与 ProposalDocPanel 的 badge 同构（live 品牌绿呼吸 / wait 琥珀 /
  // idle 中性灰），但触发条件按写作端自己的状态机映射——方案端的 wait 是「等你确认目录」，
  // 写作端对应的「卡着等你操作」有两种：待裁决的改写，和排队中的改写。
  //
  // 优先级 live > wait > idle 且 live 顺带带上排队数：AI 在写的同时可能还压着几条改写，
  // 两个信号都得说出来。**排队数原先是顶栏右侧一条游离的小字**，收进徽章后右侧只剩导出
  // 一个控件，与方案端右侧的形状对齐（否则「N 条改写排队中」会把新的导出下拉挤出栏外）。
  const badge: { tone: 'live' | 'wait' | 'idle'; text: string } | null = writing
    ? { tone: 'live', text: queueLen > 0 ? `撰写中 · ${queueLen} 条排队` : '撰写中' }
    : review
      ? { tone: 'wait', text: '待你裁决' }
      : queueLen > 0
        ? { tone: 'wait', text: `${queueLen} 条改写排队中` }
        : null

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
   * 把一节的新内容写回磁盘，并按结果更新 store / 提示文案。
   *
   * **AI 改写「应用」与手动编辑共用这一条**（2026-07-31 抽出）：两条通道的差别只在
   * 「新内容从哪来」，写盘、乐观锁冲突处理、store 更新、提示文案完全一样。两处各写一份
   * 必然在文案与更新顺序上漂——而这里每一条文案都对应一种「你的改动没生效」的具体原因，
   * 漂了就等于给用户指错下一步。
   *
   * `expectedMtimeMs` 一律由**调用方**传入，绝不在函数内部现读最新值：基准必须与调用方
   * 当初看到的那一版同源同刻，否则乐观锁只覆盖「最后一次轮询到写盘」那 2 秒，
   * 「期间被 AI 改过」这个最该拦的场景恰好漏掉（完整推演见 stores/writing.ts 的
   * baseMtimeMs 字段注释）。
   */
  const commitSection = useCallback(
    async (input: {
      sectionName: string
      markdown: string
      expectedMtimeMs: number
    }): Promise<'ok' | 'conflict' | 'conflict-missing' | 'error'> => {
      const src = useWritingStore.getState().source
      if (!src) return 'error'
      /**
       * 【2026-07-31 复审 I-1：IPC 是 reject，不是回 `{ ok: false }`】
       * `ipcRenderer.invoke` 在 main 侧 handler 抛异常、或通道压根没注册时，返回的 promise
       * 是 **reject** 的——不会走下面任何一条 `res.ok === false` 分支。不接住的话，异常会
       * 一路穿过 `editBlock` / `applyReview` / `undoLast`，最终落在调用点的 `void
       * commitEdit()` / `void undoLast()` 上变成 unhandled rejection：**用户一条提示都
       * 看不到**。
       *
       * 撤销那条最糟：`undoLast` 里 `popUndo()` 已经把栈顶消费掉了，用户看到的是「撤销按钮
       * 的计数少了一格、稿子却纹丝没动、界面零反馈」——他会以为撤销生效了。
       *
       * 【为什么接在这里而不是在每个 `void` 调用点补 `.catch`】三个调用方
       * （`editBlock` / `applyReview` / `undoLast`）**已经**都会处理 `'error'` 返回值
       * （给提示、不压撤销栈、保留编辑框）。在这里归一成 `'error'`，那三条已验证过的失败
       * 处理路径原样复用；在调用点各补一个 `.catch` 则是三份新代码、三处可能漂的文案。
       */
      let res: Awaited<ReturnType<typeof window.chatApi.writingWriteSection>>
      try {
        res = await window.chatApi.writingWriteSection({
          source: src,
          name: input.sectionName,
          markdown: input.markdown,
          expectedMtimeMs: input.expectedMtimeMs
        })
      } catch (err) {
        // 原始错误进 console 供排查；界面上给一句人话——IPC 层的错误文本（通道名、
        // 序列化失败）对用户没有意义，但「你的改动没存上」这件事必须说清。
        console.error('[writing-write-section]', err)
        const m = err instanceof Error ? err.message : String(err)
        useWritingStore.getState().setConflictMsg(`写入失败（与后台通信出错）：${m}`)
        return 'error'
      }
      const after = useWritingStore.getState()
      if (res.ok) {
        after.replaceSectionMarkdown(input.sectionName, input.markdown, res.mtimeMs)
        after.setConflictMsg('')
        return 'ok'
      }
      if (res.conflict) {
        // 乐观锁拦下：不覆盖，把盘上最新的灌回来。
        // res.current 为 null = 文件没了（被删/改名），不是「被改过」——两种情况必须两条
        // 文案：说成「已刷新到最新内容，请重新选中修改」会让用户再操作一次、再撞同样的墙。
        // 【2026-07-31 复审 ②：两种情况现在也要两个返回值】`editBlock` 需要知道具体是
        // 哪一种才能给出针对手动编辑通道的准确提示——若统一回 'conflict'，它没法区分
        // 「内容刷新了、原文案说『去复制内容』还讲得通」与「文件已经不在了、压根没有
        // 刷新到的内容可看」，无条件套用同一句会话在后一种情况下变成两句假话（详见
        // editBlock 里的调用点）。`applyReview`/`undoLast` 两处调用方判的都是
        // `outcome !== 'error'` / `outcome === 'ok'`，两种 conflict 变体都落在同一边，
        // 不受这次拆分影响，不用改。
        if (res.current) {
          after.replaceSectionMarkdown(
            input.sectionName,
            res.current.markdown,
            res.current.mtimeMs
          )
          after.setConflictMsg('这一节刚被 AI 改过，你的改动未生效。已刷新到最新内容，请重新选中修改。')
          return 'conflict'
        }
        after.setConflictMsg('这一节的文件已不存在（可能被删除或改名），改动未生效。')
        return 'conflict-missing'
      }
      after.setConflictMsg(`写入失败：${res.error}`)
      return 'error'
    },
    []
  )

  // 撤销在飞：防连点。连点会让第二次拿着已经被第一次改掉的 mtime 去写，必撞假冲突。
  const [undoing, setUndoing] = useState(false)
  const undoDepth = useWritingStore((s) => s.undoStack.length)

  /**
   * 撤销上一步。把栈顶那一节的旧内容**再写一次盘**（而不是只改 store）——磁盘是这个技能
   * 事实上的真相源：质检脚本、续写工作流、导出全都直接读盘，只改 store 会让屏幕上和盘上
   * 分家，用户以为撤销了，AI 续写时接的还是没撤销的那版。
   *
   * 基准取**当前** store 里那一节的 mtime（不是栈里存的）：撤销的语义是「把它现在变回
   * 旧样子」。若这中间 AI 又改过这一节，乐观锁会拦下并提示，不静默覆盖。
   */
  const undoLast = useCallback(async (): Promise<void> => {
    if (undoing) return
    const st = useWritingStore.getState()
    const entry = st.popUndo()
    if (!entry) return
    const sec = st.sections.find((s) => s.name === entry.sectionName)
    if (!sec) {
      st.setConflictMsg('这一节的文件已不在了，撤销未生效。')
      return
    }
    setUndoing(true)
    try {
      const outcome = await commitSection({
        sectionName: entry.sectionName,
        markdown: entry.markdown,
        expectedMtimeMs: sec.mtimeMs
      })
      // 撤销失败不把 entry 塞回栈：塞回去用户会以为还能再撤一次，而失败原因（这一节被
      // 改过 / 文件没了）多半下一次还在，只是让他再撞一次。冲突提示已经说清了发生什么。
      if (outcome !== 'ok') return
      /**
       * 【终审 #1】`entry.markdown` 是「应用/丢弃」成功前 `pushUndo` 存的那一版——
       * 恰好就是指令块**被删掉之前**的正文（见 WritingPaper.tsx 的 applyGenImageReview /
       * discardGenImageReview：两处都在移除指令块、写盘成功后才 `pushUndo(before)`）。
       * 撤销把它写回盘上，指令块原样重新出现在正文里。
       *
       * 但 `genImageJobs` 那张表不认识这次「复活」：应用/丢弃成功后，指令块已经从正文里
       * 消失，下一轮轮询的孤儿清扫（`autoFireWritingGenImages` 里按 validKeys 做差集）
       * 会把这个键从表里删掉——这是清扫机制的正常动作，删得没错，因为那一刻指令确实
       * 已经不在正文里了。`undoLast` 全程不碰 `genImageJobs`，若到此为止，撤销之后
       * 稳定判据会把这段「重新出现」的指令块当成「从没见过的新指令」，两轮之后自动
       * 重新发起——对一张已经应用过（或已经明确丢弃过）的指令重新出图、重新扣费，
       * 「丢弃 → 撤销」还会再弹一张新审阅卡，比什么都没做过更糟。
       *
       * 修法：对 `entry.markdown` 单独跑一次 `seedManualGenImageJobs`（复用它的 `??=`
       * 语义——只在键不存在时补 manual 哨兵，不会打扰其他节的记录，也不会覆盖这一节
       * 里其他仍在 pending/done 的键）。等价于「补种」动作的单节版：这个键刚被清空，
       * 立刻由同一处逻辑（这里）重新登记，不留「表空了没人补种」的窗口——与本分支反复
       * 踩过的那条根因教训对齐（见 progress.md）。
       *
       * 【这一步的已知代价 —— 2026-08 终审复审指出】撤销是**通用**动作，不只服务于
       * 「撤销一次配图应用」。所以撤销任意一次修改时，若这一节里还有一条「已经出现在
       * 正文里、但还没跑完两轮稳定判据、因而尚无 job 键」的**新**指令块，它会被 `??=`
       * 一并冻成 manual，此后不再自动出图、要用户手点「生成这张图」。窗口很窄（撤销按钮
       * `disabled={undoing || writing}`，AI 落字期间点不了，只剩 AI 收工后到自动发起前
       * 那 2–4 秒），且失败方向是安全的（不烧钱、有可用按钮），故接受这个取舍。
       *
       * 【测试覆盖的实情 —— 别读成「有回归测试守着」】`WritingDocPanel.tsx` 是组件文件，
       * 不在 `bun test` 的三个覆盖目录内。`writingGenImageFire.test.ts` 里那条 C-2 用例
       * 复刻的是「补种 manual 能挡住重新发起」这个**机制**，不是这一行接线——终审复审
       * 实测把下面这行整行删掉，全量测试仍然 827 pass / 6 fail 全绿。改动这一行时没有
       * 自动化保护，只能靠人工走查（清单见 progress.md）。
       */
      useWritingStore
        .getState()
        .seedManualGenImageJobs([{ name: entry.sectionName, markdown: entry.markdown, mtimeMs: sec.mtimeMs }])
    } finally {
      setUndoing(false)
    }
  }, [commitSection, undoing])

  /**
   * 手动编辑落地。与 AI 改写「应用」共用 commitSection 与撤销栈——两条通道的差别只在
   * 「新内容从哪来」。
   *
   * 返回 false 时纸面会停在编辑态让用户重试，所以这里**不能吞掉失败**：
   * 越界（编辑期间这一节被换掉了）与写盘冲突都要如实回 false 并留下提示。
   */
  const editBlock = useCallback(
    async (input: {
      sectionName: string
      blockIndex: number
      nextBlockMarkdown: string
      baseMtimeMs: number
    }): Promise<boolean> => {
      const st = useWritingStore.getState()
      const sec = st.sections.find((s) => s.name === input.sectionName)
      if (!sec) {
        st.setConflictMsg('这一节的文件已不在了，改动未写入。')
        return false
      }
      const next = replaceBlockAt(sec.markdown, input.blockIndex, input.nextBlockMarkdown)
      if (next === null) {
        // replaceBlockAt 越界回 null（它刻意不夹紧）：这一节在编辑期间被换掉了，
        // 硬写会把用户的字落进他没选的那一段。
        st.setConflictMsg('这一节的内容已经变了，改动未写入，请重新编辑。')
        return false
      }
      const before = sec.markdown
      const outcome = await commitSection({
        sectionName: input.sectionName,
        markdown: next,
        expectedMtimeMs: input.baseMtimeMs
      })
      if (outcome === 'conflict') {
        /**
         * 【2026-07-31 复审 I-4：commitSection 的冲突文案对手动编辑通道是个死胡同】
         * commitSection 冲突分支已经把 store 里这一节刷新成盘上最新版本（见其函数头
         * 注释），但纸面编辑框里的 `base`/`baseMtimeMs` 是调用方（WritingPaper）在
         * *进入编辑那一刻*快照的，不会跟着这次刷新变——纸面按规格「失败不关编辑框」，
         * 于是用户往后每点一次别处都会拿着同一个旧 `baseMtimeMs` 再提交一次、再撞
         * 同一堵墙，唯一走得出去的路是按 Esc（等于亲手销毁自己刚敲的字）。
         * commitSection 那句「已刷新到最新内容，请重新选中修改」是写给 AI 改写通道
         * 的（那边一冲突就会收起对照卡，「重新选中」说得通）；手动编辑通道需要一条
         * 点破这个死胡同的文案，明确提醒用户「先把字复制出来，再放弃这次编辑」。
         * 不改 commitSection 本身的文案——那是两条通道共用的一段，选区改写通道的
         * 措辞并没有问题，不该被这里的需求牵连着改掉。
         *
         * 【2026-07-31 复审 ②：只有块结构还在时，「去复制内容再 Esc」这条建议才成立】
         * commitSection 已经把 store 刷新成了盘上最新版本，若刷新后这一块的下标在
         * 新内容里越界了（AI 顺手把这一段也删了/合并了），WritingPaper 那边有一个
         * 独立的兜底 effect（见其头注释「M-8/④」）会因为块结构性消失而自动把编辑框
         * 关掉——「先复制内容再按 Esc」这句话会变成一句自相矛盾的假话：编辑框根本
         * 不会等到用户去按 Esc。这里现读一次新内容判断块是否还在，两种情况给两条
         * 不同的话。真正拦住 M-8 用它自己更笼统的兜底文案覆盖这里措辞的，不是
         * 「M-8 让路」（那套机制已在上一轮删除）——是 WritingPaper `commitEdit`
         * 的 else 分支自己在 `await onEditBlock` 的续体里抢先判断「块是否结构性
         * 消失」并提前关框（`setEditing(null)`）：这段续体是微任务，稳定抢在
         * M-8 所在的下一次渲染 effect（走 React Scheduler，是宏任务）之前跑完，
         * editing 先被清空，M-8 的 `if (!editing) return` 因此直接短路，永远看
         * 不到非空的 editing，也就没有机会覆盖这里刚设好的措辞。这条时序前提
         * 详见 WritingPaper.tsx `commitEdit` 尾部注释。
         */
        const freshSec = useWritingStore.getState().sections.find((s) => s.name === input.sectionName)
        const stillHasBlock = !!freshSec && input.blockIndex < splitBlocks(freshSec.markdown).length
        useWritingStore
          .getState()
          .setConflictMsg(
            stillHasBlock
              ? '这一节刚被 AI 改过，你刚才编辑框里的改动没能存上（内容已刷新到最新版本）。' +
                  '请先把编辑框里的文字复制出来，再按 Esc 关掉编辑框重新编辑。'
              : '这一节刚被 AI 改过，你刚才编辑的这一段已经不在了，编辑框里未保存的内容无法保留。'
          )
        return false
      }
      if (outcome !== 'ok') return false
      useWritingStore.getState().pushUndo({ sectionName: input.sectionName, markdown: before })
      return true
    },
    [commitSection]
  )

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
      const before = sec.markdown
      const next = applyRevision(sec.markdown, range, r.after)
      const outcome = await commitSection({
        sectionName: r.target.sectionName,
        markdown: next,
        expectedMtimeMs: r.baseMtimeMs
      })
      // 只在真的写进去了才压栈：冲突/失败时磁盘没变，压进去会让「撤销」把一个从未生效的
      // 状态写回磁盘——那不是撤销，是凭空改稿。
      if (outcome === 'ok') {
        useWritingStore.getState().pushUndo({ sectionName: r.target.sectionName, markdown: before })
      }
      // 成功与冲突都收掉对照卡：成功已落地；冲突时卡上的 range 与 before 已对不上盘上的
      // 内容，留着它用户只会再点一次、再撞一次同样的墙。
      // **写盘失败（error）时刻意保留对照卡** —— 那是「磁盘暂时写不进去」（权限 / 磁盘满），
      // 内容本身仍然有效，收掉卡等于让用户白等一轮 AI。这是原实现的行为，纯重构必须原样保留。
      if (outcome !== 'error') useWritingStore.getState().setReview(null)
    } finally {
      setApplying(false)
    }
  }, [commitSection])

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
      // 与 exportPdf 同源：mermaid 只能在 renderer 渲，先扫出正文里的块、逐个渲成 SVG 再
      // 栅格化 PNG。此前 Word 导出恒不传这个字段，PDF 有流程图、Word 是灰字「[图示]」占位，
      // 两条导出链不一致（2026-08-04 code review 补齐，对齐 ProposalDocPanel.handleExport
      // 里 `format === 'docx' ? await renderMermaidImageMap(...) : undefined` 的写法）。
      const mermaidImages = await renderMermaidImageMap(extractMermaidBlocks(markdown))
      const r = await window.chatApi.writingExportDocx({
        markdown,
        style: writingStyleFor(useWritingStore.getState().genre),
        defaultBaseName: baseName,
        // 正文里的图恒为相对路径（`../images/x.png`），main 侧 markdownToDocxBuffer 必须先把它
        // 解析成绝对路径才能 readFileSync 嵌图——与纸面预览（WritingPaper.tsx）同一条基准目录
        // 规则，见 writingAssetBaseDir 头注释。single 模式回传 undefined，main 侧据此跳过解析
        // （图片降级为文字占位，不静默产出一个臆测的错误路径）。
        assetBaseDir: writingAssetBaseDir(useWritingStore.getState().source),
        mermaidImages
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
      // 与 ProposalDocPanel.handleExportPdf 同源同法：mermaid 只能在 renderer 渲（main 无 DOM），
      // 先扫出正文里的 mermaid 块、逐个渲成 SVG 再栅格化成 PNG，交给 renderProposalPdfHtml 走
      // 「同一份 docx 引擎 → docx-preview → printToPDF」这条与预览/Word 逐像素一致的导出链。
      // 单块渲染失败（语法错误 / 流式未闭合）只跳过、不进映射（renderMermaidImageMap 内部保证），
      // main 侧查不到就降级一行文字占位，不会让一张坏图打断整篇 PDF 导出。
      const mermaidImages = await renderMermaidImageMap(extractMermaidBlocks(markdown))
      // 正文里的图恒为相对路径，PDF 导出复用 PROPOSAL_RENDER 通道生成 docx 字节再转 PDF——
      // 必须传同一条 assetBaseDir 规则（与上面 exportDocx 同源），否则这条链路只补了流程图、
      // 图片依旧因相对路径解析不出而降级成文字占位。
      //
      // 【两种模式都传 kind:'writing'，2026-08-04 code review 修】不能省略 single 模式的
      // kind——single 模式的 assetBaseDir 恒为 undefined，若 main 侧拿「有没有 assetBaseDir」
      // 当「是不是写作调用」的判据，single 模式会被误当方案调用、白挨一次方案专属的接地闸门
      // （collectUngroundedImagePaths），把写作自己的图错判成「未接地」剔除。kind 是独立于
      // assetBaseDir 的显式意图声明，两种模式都要传。
      const html = await renderProposalPdfHtml(
        markdown,
        writingStyleFor(useWritingStore.getState().genre),
        mermaidImages,
        writingAssetBaseDir(useWritingStore.getState().source),
        'writing'
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
      // 【终审 #4】剪贴板的 text/html flavor 没有 base URL，正文里 `![...](../images/x.png)`
      // 这种相对路径的图在公众号编辑器里解析不到、会被静默丢弃——绿色的「已复制」成功提示
      // 会掩盖这个事实。`buildWechatCopyMsg` 数出正文里的配图张数，有图时把提示降级成
      // 「已复制 + 需要手动上传」的如实告知，见该函数顶注的完整推演。
      setExportMsg(buildWechatCopyMsg(markdown, r.styleFallback))
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
      {/* 顶栏：h-[46px] + shrink-0，与 ChatHeader / ProposalDocPanel / slides tab 栏同参
          ——分栏各列顶栏底边必须对齐成一条（旧写法 px-3 py-2 + size="sm"(h-8) 自适应出
          48px，与左列 46px 差 2px）。
          【本栏整条落在根 .window-drag-strip（fixed 全宽 46px、app-region:drag）里，
          栏内每个交互控件都必须 no-drag 挖洞，否则点击被原生窗口拖拽整个吞掉】——
          这不是样式洁癖：漏挖洞的表现是「按钮点了没反应、按住会拖动窗口」，栏内控件
          （导出下拉）会哑掉，且控制台零报错。CLAUDE.md 里这是 errors/ 记了 7 条的同族
          事故。挖洞按「组」挖（右侧整组一次挖），不逐个挖：新增控件时自动继承，不会漏。
          注意顶栏本身仍**不标 drag** —— 全应用唯一的拖拽面是根 .window-drag-strip，
          组件顶栏再标会复发「整窗拖不动 + 双击不缩放」。

          布局：左=标题+活性徽章、右=单一导出下拉，justify-between 撑开（去掉打印预览后
          中段的 segmented 一并移除，与 ProposalDocPanel 的差异仅此一处）。 */}
      <div className="flex h-[46px] shrink-0 select-none items-center justify-between gap-2 border-b border-border px-3 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          <span className="whitespace-nowrap text-[13px] font-semibold text-foreground">写作草稿</span>
          {/* 活性徽章。品牌绿（--brand）是身份/活性色，刻意不用会随用户主题变的 --accent
              ——「在干活」的信号不该跟着主题色跑（与方案端同一条纪律）。 */}
          {badge && (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px]',
                badge.tone === 'live' && 'bg-brand/10 text-brand',
                badge.tone === 'wait' && 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
                badge.tone === 'idle' && 'bg-muted text-muted-foreground'
              )}
            >
              {badge.tone === 'live' ? (
                <span className="relative flex size-1.5 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-brand" />
                </span>
              ) : (
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    badge.tone === 'wait' ? 'bg-amber-500' : 'bg-muted-foreground/50'
                  )}
                />
              )}
              {badge.text}
            </span>
          )}
        </span>

        {/* no-drag 一次盖住右侧整组（导出反馈 + 导出下拉 trigger）。 */}
        <div className="flex min-w-0 items-center gap-2 [-webkit-app-region:no-drag]">
          {/* 撤销上一步。落在这个 no-drag 分组内（新增控件自动继承挖洞，不必逐个挖）——
              顶栏整条在根 .window-drag-strip 里，漏挖的表现是「按钮点了没反应、按住会拖动
              窗口」且控制台零报错。 */}
          {undoDepth > 0 && (
            /**
             * 【2026-07-31 复审 I-2：撤销必须跟「进入编辑」共用同一道 `writing` 闸】
             * 手动编辑那条通道明文规定「AI 正在落字时不许进编辑」（见 WritingPaper 的
             * beginEdit），但撤销走的是同一条写盘链、原先却完全不判 `writing`——两条
             * 通道的安全模型在这里是对不齐的，而对不齐的那一边会毁数据：
             *   1. AI 刚把第 3 节重写完落盘；
             *   2. 轮询（2s）把这一版连同新 mtime 刷进 store；
             *   3. 用户点撤销 —— `expectedMtimeMs` 取的是**当前** store 里的
             *      `sec.mtimeMs`（撤销的语义就是「把它现在变回旧样子」，基准本来就该
             *      是现在），于是它恒等于盘上的值 → **乐观锁必然放行**；
             *   4. AI 刚写的那一节被一个更早的旧快照整段覆盖，而且没有 redo。
             * 乐观锁在这条路上帮不上忙：它拦的是「基准过期」，而撤销的基准按设计就是最新的。
             * 唯一的拦法就是不让用户在 AI 落字期间按下去。
             * 禁用而不是隐藏：按钮消失会让用户以为撤销记录没了，title 里说清原因更好。
             */
            <span
              // title 挂在**外层 span** 而不是 button 上：Chromium 对 `disabled` 的
              // 按钮不派发鼠标事件，title 提示框根本不会浮出来——而这条 title 恰恰只在
              // 禁用时才有话要说（「为什么点不了」），挂在按钮上等于写了个看不见的解释。
              title={
                writing
                  ? 'AI 正在写这篇稿子，暂时不能撤销（撤销会把 AI 刚写的内容覆盖掉）'
                  : `撤销上一步修改（还可撤销 ${undoDepth} 步）`
              }
            >
              <Button
                size="xs"
                variant="ghost"
                disabled={undoing || writing}
                onClick={() => void undoLast()}
              >
                {undoing ? '撤销中…' : '撤销'}
              </Button>
            </span>
          )}
          {exportMsg && (
            <span
              className={cn(
                'max-w-[140px] truncate text-[11px]',
                exportMsg.tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
                exportMsg.tone === 'err' && 'text-rose-600 dark:text-rose-400',
                exportMsg.tone === 'muted' && 'text-muted-foreground'
              )}
              title={exportMsg.text}
            >
              {exportMsg.text}
            </span>
          )}
          {/* 导出下拉：取代原先平铺的「导出 Word / 导出 PDF / 复制公众号 HTML」三枚小按钮
              ——方案端早就收敛过这一步（其代码注释原话是取代「两处散落」的混乱布局），写作端
              此前还停在那个旧形态。每项带一句用途说明，让「这个按钮干嘛用」一目了然。
              写作端刻意**没有** Markdown 项：drafts/ 下本来就是 md 原文，用户直接拿即可，
              造一个导出等于把同一份东西复制一遍。 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-accent px-2.5 py-1 font-medium text-white shadow-sm hover:opacity-90 disabled:opacity-50"
                disabled={exportingDocx || exportingPdf || copyingWechat}
                title="导出文稿（Word / PDF）"
              >
                {exportingDocx || exportingPdf || copyingWechat ? (
                  '导出中…'
                ) : (
                  <>
                    导出
                    <ChevronDownIcon />
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem className="items-start" onSelect={() => void exportDocx()}>
                <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block font-medium">Word（.docx）</span>
                  <span className="block text-[11px] text-muted-foreground">投稿、交付，可继续编辑</span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem className="items-start" onSelect={() => void exportPdf()}>
                <FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block font-medium">PDF</span>
                  <span className="block text-[11px] text-muted-foreground">定稿发送、排版固定</span>
                </span>
              </DropdownMenuItem>
              {genre === 'wechat' && (
                <DropdownMenuItem className="items-start" onSelect={() => void copyWechat()}>
                  <FileCodeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block font-medium">复制公众号 HTML</span>
                    <span className="block text-[11px] text-muted-foreground">
                      粘进公众号编辑器，保留排版
                    </span>
                  </span>
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
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

      <div className="flex min-h-0 flex-1 flex-col">
        <WritingPaper
          writing={writing}
          busy={streaming || pendingRevision !== null}
          onRevise={(target, instruction) => void submitRevision(target, instruction)}
          onEditBlock={editBlock}
          // genimage 指令块「应用/丢弃」的写盘入口（task 5）：与手动编辑/AI 改写「应用」
          // 共用同一条 commitSection（乐观锁 + 撤销栈），不新开写盘入口。
          onCommitSection={commitSection}
        />
      </div>

      {/* 对照卡挂在纸面**之外**（面板级）：待裁决的改写会挡住队列排空（排空 effect 以
          review 为闸），裁决入口一旦被藏起来，用户看到的就是「排队几条一直不动、也不知道
          为什么」——等于让功能卡死。 */}
      <WritingRevisionReviewCard
        applying={applying}
        onApply={() => void applyReview()}
        onDiscard={() => useWritingStore.getState().setReview(null)}
      />
    </div>
  )
}
