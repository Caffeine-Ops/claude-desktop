import { useProposalStore, type ProposalSection } from '../stores/proposal'
import { useChatStore } from '../stores/chat'
import { USER_SUPPLIED_SOURCE } from '@desktop-shared/proposal'
import { splitBlocks } from '@desktop-shared/proposalBlocks'
import { resolveRevisionTarget } from './proposalRevisionGuards'
import { sendProposalStageMessage } from './sendProposalStageMessage'
import { buildSelectionRevisionMessage, groundingSuffix } from './proposalRevisionMessages'

/**
 * 三个定向修订入口（整章重写/补料续写/选区块修订）的公共骨架：并发守卫 → 取 content 节 →
 * 构造消息 → 置 pendingRevision → 发消息。把「pendingRevision 单槽被并发覆盖」的守卫收口在一处
 * （review V1 根治 + #10 去重）——任一修订在飞时其余入口一律拒绝，堵住指针被覆盖致 end 分流
 * 张冠李戴/丢产出（原先只在块修订里挡，整章/补料两条路是对称漏洞）。build 返回 null=放弃
 * （缺口/空指令/空节）；blockRange 存在则 end 走块区间 spliceBlocks，否则整节替换。
 */
async function dispatchSectionRevision(
  sectionId: string,
  build: (
    sec: ProposalSection
  ) => { message: string; displayText?: string; blockRange?: { start: number; end: number } } | null
): Promise<void> {
  const ps = useProposalStore.getState()
  // 并发守卫（review V1 根治 + 复审 Issue#1 收尾）：一轮正在飞时拒绝新修订，否则第二次 setPendingRevision
  // 会覆盖在飞那次的单槽指针、令其 end 分流张冠李戴/丢产出。
  // 闸用【streaming】而非 pendingRevision：streaming 在 'end' 与 'error' 两个终止路径都必被
  // endAssistantMessage 清（连 dispatchChatTurn 吞掉的 send 早退错误也走 endAssistantMessage 兜底），
  // 故永不卡死；而 pendingRevision 只在 'end' 清，用它当闸会因一次「没起飞/出错」的修订永久锁死后续
  // 所有修订。若真有 stale pendingRevision（没起飞的那次留下），streaming=false 时新修订照常放行、
  // setPendingRevision 覆盖它自愈（回归本次收口前的鲁棒行为）。
  const sid = ps.sessionId
  const streaming = sid ? (useChatStore.getState().perSession[sid]?.streaming ?? false) : false
  // 诊断：这几处静默 no-op 是「点了改写没反应」最可能的落点，打日志把原因显式化（原先全静默）。
  if (streaming) {
    console.warn('[proposal-revise] 跳过：上一轮仍在生成中（streaming），请等它结束再改。')
    return
  }
  const sec = ps.sections.find((s) => s.id === sectionId)
  // 目标节存在即放行——封面/目录也支持选区即改（用户要求）。原先限死 content 会让封面/目录选区
  // 弹出的「AI 改写」气泡点了没反应：dispatch 在此静默 no-op，SDK 轮根本没起飞、对话框毫无动作。
  // 整章重写/展开/精简/补料/续写等 content 专属入口不经封面/目录触发（其按钮仅正文节渲染），故放宽
  // 中央闸不会误伤；溯源措辞由各 build 按 sec.kind 走 groundingSuffix 自行分叉。
  if (!sec) {
    console.warn('[proposal-revise] 跳过：目标节不存在（可能已删除/切换会话）', { sectionId })
    return
  }
  const built = build(sec)
  if (!built || !built.message) {
    console.warn('[proposal-revise] 跳过：build 返回空（该节切不出块/指令为空）', { sectionId })
    return
  }
  // 指针在 await 前置好（end 分流靠它分流本轮产出）；无需回滚——streaming 闸已保证不会因 stale 指针锁死。
  // 与补料黏性指针互斥：发起一次直接修订即取消任何待补料意图，防两指针并存致 end 分流交叉捕获。
  ps.setPendingGapFill(null)
  ps.setPendingRevision(built.blockRange ? { sectionId, blockRange: built.blockRange } : { sectionId })
  await sendProposalStageMessage(built.message, { displayText: built.displayText })
}

/**
 * 对【某一节正文】发起定向修订（方案一·节内联 AI 修订循环）。
 *
 * 与「阶段推进消息」的区别：推进是整段往后走、产出 append 成新节；修订是只重写【这一章】、
 * 产出【整节替换】原节。两者都走 sendProposalStageMessage（带 proposalMode/products，且在
 * content 阶段必触发知识库召回，故修订也吃到原文片段、能继续标《来源》），区别只在：修订前
 * 先置 pendingRevision 指针，FusionRuntimeProvider 的 end 分流据此把本轮产出替换进目标节
 * （而非 append）。指针在 end 分流后即清，故修订永远只作用一轮。
 *
 * 纪律不松口：每个 intent 的指令都重申「严禁引入知识库之外的内容、段末按既有规则标《来源》」，
 * 守住溯源不变量——修订不能成为绕过 trigram 校验的后门。
 */
export type ReviseIntent = 'rewrite' | 'expand' | 'shorten' | 'resume' | 'fixSource'

const INTENT_INSTRUCTION: Record<ReviseIntent, string> = {
  rewrite: '请重写下面这一章，保持同一主题，换一种更好的组织方式与措辞，质量更高',
  expand: '请把下面这一章写得更详尽（补充细节、数据、案例），但严禁引入知识库之外的内容',
  shorten: '请把下面这一章精简到要点，删去冗余与重复',
  resume: '下面是上一轮被中断、可能不完整的半截内容，请在其基础上补全，并【整章重新完整输出】',
  fixSource:
    '下面这一章里有内容在所引《来源》原文中找不到对应依据（疑似编造或过度改写），请严格只依据所引文件原文重写本章，凡无来源支撑的表述一律删除或改写'
}

/**
 * 发起一节正文的定向修订。仅对 content 节生效（封面/目录不标来源、无修订语义）；非方案前台
 * 或目标节不存在时静默 no-op。fixSource 可传 note 覆盖默认指令（红条「据来源修正」用）。
 */
export async function reviseProposalSection(
  sectionId: string,
  intent: ReviseIntent,
  note?: string
): Promise<void> {
  const instruction = intent === 'fixSource' ? (note ?? INTENT_INSTRUCTION.fixSource) : INTENT_INSTRUCTION[intent]
  const displayText =
    intent === 'fixSource'
      ? '据来源修正这一章'
      : intent === 'resume'
        ? '继续写完这一章'
        : instruction
  // build 拿到 content 节，拼「整章替换」指令；并发守卫/置指针/发消息在 dispatchSectionRevision 收口。
  await dispatchSectionRevision(sectionId, (sec) => ({
    displayText,
    message:
      `【定向修订·只重写这一章，不要改动其它任何章节】${instruction}：\n\n${sec.markdown}\n\n` +
      `仍用方案【正文】哨兵包裹（与逐章撰写同款），段末按既有规则标注《来源》，绝不臆造。`
  }))
}

/**
 * 资料缺失·发起对话框补料（P3-2 阶段二·改版）：用户在【只读】草稿点某处缺口的「去对话框补充」时调用。
 * 【不发任何消息给 AI】——只置待补料标记 pendingGapFill（指向这一章 + 缺口描述）并把焦点移到左侧输入框。
 * 之后：输入框上方据标记弹一条提示条把「缺什么」告诉用户、请其在下方输入这段资料并发送；用户发送那条
 * 消息时，onNew 发送收口据标记调 buildGapFillRewriteMessage 把原文包进「只重写这一章」的指令、并置
 * pendingRevision，AI 这才运行、一轮内整节替换重写。这样 AI 只在用户真正给了资料后才跑，草稿保持只读。
 *
 * 不设 streaming 守卫——点按钮本身不发任何消息、无并发之虞（真正的发送并发由 onNew 那条路径承担）。
 * 非方案前台 / 目标节不存在时静默 no-op。
 */
export function startProposalGapFill(sectionId: string, gapDesc: string): void {
  const ps = useProposalStore.getState()
  if (!(ps.active && ps.sessionId)) return
  if (!ps.sections.some((s) => s.id === sectionId)) return
  // 与直接修订指针互斥：清掉任何残留 pendingRevision，防其在 end 分流里抢先捕获后续产出。
  ps.setPendingRevision(null)
  ps.setPendingGapFill({ sectionId, gapDesc })
  // 焦点移到左侧输入框，方便用户直接开打（DOM 聚焦，与 onNew 里 /proposal-writer 预填模板同款手法）。
  queueMicrotask(() => document.querySelector<HTMLElement>('.ProseMirror')?.focus())
}

/**
 * 补料重写指令构造：把用户在对话框里给出的资料原文，包成「只重写这一章、删缺口标记、按溯源规则标
 * 来源」的一条消息发给引擎。由 onNew 在用户发出补料消息时调用（此前 pendingGapFill 记着缺口描述），
 * 同时那里会置 pendingRevision 让 end 分流整节替换。溯源纪律与旧版就地补料一致：外部补料标
 * 《${USER_SUPPLIED_SOURCE}》；补料里指认了知识库文件则 Read 后按真实《文件名》标注。用户气泡仍只
 * 显示他打的原文（displayText），这条包装消息只走引擎、不进 UI。
 */
export function buildGapFillRewriteMessage(gapDesc: string, material: string): string {
  return (
    `【资料缺失·补料续写·只重写这一章，不要改动其它任何章节】本章里有一处标注的缺口：` +
    `「⚠️ 资料缺失：${gapDesc}」。用户为此在对话框补充了以下资料：\n\n${material}\n\n` +
    `请把这段补料自然融入本章对应位置、并【删除那一行「⚠️ 资料缺失：${gapDesc}」标记】，重写并【整章完整输出】。溯源纪律：` +
    `① 据上面这段【外部补料文字】写出的内容，段末标注（据《${USER_SUPPLIED_SOURCE}》）；` +
    `② 若补料里指认了知识库中的某个文件，请实际 Read 该文件、据其原文撰写并按真实《文件名》标注来源；` +
    `③ 本章其它原有内容与其《来源》标注保持不变；④ 绝不臆造补料和知识库之外的内容。` +
    `仍用方案【正文】哨兵包裹（与逐章撰写同款）。`
  )
}

/**
 * 选区即改（Canvas/Artifacts 式）：用户在编辑态选中一段文字，对【选区覆盖的那一/几个块】
 * 发起定向修订。与 reviseProposalSection（整章）的区别只在作用域——这里置
 * pendingRevision.blockRange，end 分流用 spliceBlocks 只把 AI 产出拼回那几块、本章其余内容
 * 原样不动。selectedText 作为「用户特别想改的这句」焦点提示传给 AI，但替换单位仍是【块】
 * （见 proposalBlocks.ts 注释：按块替换避开选区↔源码子串脆映射）。
 *
 * instruction 是【用户最终敲定的自然语言指令】：浮层的快捷动作（润色/精简/扩写…）只是把中文
 * 指令模板【填进输入框】供用户再编辑，真正发起永远经「改」按钮/回车走这里——故不再有预设 action
 * 分支，一律按用户给的整句指令拼进提示词。溯源纪律由 groundingSuffix 兜住：正文节标《来源》，
 * 封面/目录节改走「只改这一小段、不标来源、不臆造」的措辞（不因指令自由化而松口）。
 *
 * 正文/封面/目录节均生效（封面/目录也支持选区即改，用户要求）；非方案前台 / 目标节不存在 /
 * 指令为空时静默 no-op。
 */
export async function reviseProposalSectionBlocks(
  sectionId: string,
  blockRange: { start: number; end: number },
  instruction: string,
  selectedText: string
): Promise<void> {
  const trimmed = instruction.trim()
  if (!trimmed) return
  const focus = selectedText.trim()

  // build 在守卫通过后按【当时的】sec.markdown 切块、夹紧、拼上下文，并把夹紧后的 blockRange 交回
  // dispatch 置指针——保证「拼进提示词的 context」与「end 要 splice 的 [start,end]」出自同一次切分。
  await dispatchSectionRevision(sectionId, (sec) => {
    const blocks = splitBlocks(sec.markdown)
    if (blocks.length === 0) return null
    const start = Math.max(0, Math.min(blockRange.start, blocks.length - 1))
    const end = Math.max(start, Math.min(blockRange.end, blocks.length - 1))
    const context = blocks.slice(start, end + 1).join('\n\n')
    return {
      blockRange: { start, end },
      displayText: trimmed,
      message: buildSelectionRevisionMessage({
        instruction: trimmed,
        focus,
        context,
        kind: sec.kind
      })
    }
  })
}

/**
 * 选区即改·继续改（对话审阅循环）：用户对一版【尚未落地】的改写稿点「继续改」并再给一句指令，
 * AI 在【当前这版改写稿 baseText】的基础上继续修改（而非再从原节切块）。blockRange 原样透传
 * （仍指向同几块），end 分流据此再登记一条新的 blockReview，形成「改→审阅→继续改→再审阅」循环，
 * 直到用户点「应用」才 spliceBlocks 落地。溯源纪律由 groundingSuffix 按节类型兜住（同上）。
 *
 * 正文/封面/目录节均生效；非方案前台 / 目标节不存在 / 指令为空 / 一轮在飞时静默 no-op（守卫在 dispatch）。
 */
export async function continueProposalSectionBlocks(
  sectionId: string,
  blockRange: { start: number; end: number },
  baseText: string,
  instruction: string
): Promise<void> {
  const trimmed = instruction.trim()
  if (!trimmed) return
  const base = baseText.trim()
  if (!base) return
  // build 只用 sec.kind 选溯源措辞（base 是上一版改写稿、非节内原文）；blockRange 原样透传给 end
  // 分流 splice/审阅。封面/目录的「继续改」同样走 groundingSuffix 免标《来源》。
  await dispatchSectionRevision(sectionId, (sec) => ({
    blockRange,
    displayText: trimmed,
    message:
      // 同 reviseProposalSectionBlocks 的硬边界：防 agent 把「继续改这一小段」误当收尾去评估/写文件。
      `【就地小改·硬性边界】这是针对方案正文里【某一小段】改写稿的又一次就地修改，不是新任务、更不是收尾。` +
      `你【唯一要做的事】：在下面这版改写稿上按要求继续改，并用方案【正文】哨兵原样返回。` +
      `【严禁】写入或创建任何文件、评估或点评整份方案、总结或交付、另起新章节、输出这一小段以外的任何内容。\n\n` +
      `继续修改要求：${trimmed}\n\n` +
      `当前这版改写稿如下：\n\n${base}\n\n` +
      `只输出【继续修改后的这一小段本身】（不要重复章节标题、不要写章节序号），仍用方案【正文】哨兵包裹，` +
      groundingSuffix(sec.kind)
  }))
}

// 并发闸（CEO 护栏#1）：end 事件可能对同一 messageId 双触发，两个 queueMicrotask 里的 drain 会各自
// dequeue 到不同队头、各自 send，破坏"一次只一个改写在飞"铁律。用模块级闸串行化：抢到闸才进，
// 发起后到下一轮 end 由新的 drain 再抢。闸是模块单例——proposal 同一时刻只有一个前台会话在排空，
// 不会跨会话争用（sessionId 已在 store 里自持）。
let draining = false

// 队列跳过项的统一提示文案（复审 M5：提示【绝不】被清成 null，只由用户「知道了」清——否则用户
// 没盯着面板就再也看不到「我排的改写被跳过了」，违反零静默失败）。
function skipNotice(n: number): string {
  return `${n} 个排队改写被跳过（原文已变化，或与待确认的改写重叠）`
}

/**
 * 排空改写队列（选区改写排队·消费端）。一轮 end/error 后由 FusionRuntimeProvider 调用。
 * 护栏就地落实：
 *  #1 并发闸 draining——防 end 双触发导致并发 send；
 *  #4 重叠拦截 + #3 重定位——收口在 resolveRevisionTarget，与直发路径同一判定（复审 H1）；
 *  H3 起飞判定——reviseProposalSectionBlocks【不会 reject】（dispatchChatTurn 吞掉 send 失败），故
 *      不能靠 catch 判成败（那是死代码，复审查实）。改判 streaming：发起后仍为假=这轮没起飞
 *      （streaming 守卫 no-op / 切走会话早退 / send 被吞），head 已消费→计跳过、继续下一项，绝不空等
 *      一个永不到来的 end；为真=真起飞→返回等这轮 end/error 再排下一个。这样任何失败都不会让队列停摆。
 *  #2/M5 跳过提示——跳过项累计后置持久提示（不清空）。
 *
 * 串行不变量：任一时刻最多一个改写在飞（并发闸 + 起飞后即返回）。
 */
export async function drainRevisionQueue(): Promise<void> {
  if (draining) return // 护栏#1：已有 drain 在跑，直接退（另一个 end/error 触发的重入）
  draining = true
  try {
    const ps = useProposalStore.getState()
    if (!ps.active || !ps.sessionId) return
    const sid = ps.sessionId
    const isStreaming = (): boolean => useChatStore.getState().perSession[sid]?.streaming ?? false
    if (isStreaming()) return // 忙时按兵不动（下一轮 end/error 会再来）

    let skipped = 0
    // 逐项处理：节已删/原文找不到/与待审阅卡重叠 → 计跳过、继续下一项；成功【真起飞】→ 返回等 end。
    for (;;) {
      const head = useProposalStore.getState().dequeueRevision()
      if (!head) break // 队列空
      const cur = useProposalStore.getState()
      const sec = cur.sections.find((s) => s.id === head.sectionId)
      if (!sec) {
        skipped++
        console.warn('[proposal-queue] 跳过排队项：目标节已不存在', { sectionId: head.sectionId })
        continue
      }
      // 复审 H1/H2/M4：定位（带 hint 距离上限）+ 审阅卡重叠，与直发路径共用 resolveRevisionTarget。
      const target = resolveRevisionTarget({
        markdown: sec.markdown,
        blockReviews: cur.blockReviews,
        sectionId: head.sectionId,
        selectedText: head.selectedText,
        hintRange: head.hintRange
      })
      if (target.status !== 'ok') {
        skipped++
        console.warn(
          `[proposal-queue] 跳过排队项：${target.status === 'missing' ? '原文已变化找不到' : '与待确认改写重叠'}`,
          { sectionId: head.sectionId }
        )
        continue
      }
      // 发起。见函数头 H3 注释：不靠 catch（不会 reject），靠发起后 streaming 是否为真判「有没有起飞」。
      try {
        await reviseProposalSectionBlocks(head.sectionId, target.range, head.instruction, head.selectedText)
      } catch (err) {
        console.error('[proposal-queue] 发起排队改写意外抛错', err)
      }
      if (isStreaming()) {
        if (skipped > 0) useProposalStore.getState().setRevisionQueueNotice(skipNotice(skipped))
        return // 真起飞，等这轮 end/error 触发下一次 drain
      }
      // 没起飞：这一项没发出去（已消费）。计跳过、继续排下一项，绝不空等 end（否则队列永久停摆）。
      skipped++
      console.warn('[proposal-queue] 跳过排队项：本轮未能起飞（可能已切走会话/发送失败）', {
        sectionId: head.sectionId
      })
    }
    // 队列排空。仅在有跳过项时置提示；【绝不】把提示清成 null（复审 M5）——留给用户「知道了」清。
    if (skipped > 0) useProposalStore.getState().setRevisionQueueNotice(skipNotice(skipped))
  } finally {
    draining = false // 务必释放，否则一次异常永久锁死排空
  }
}
