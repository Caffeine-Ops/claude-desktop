import { useProposalStore } from '../stores/proposal'
import { USER_SUPPLIED_SOURCE } from '@shared/proposal'
import { splitBlocks } from '@shared/proposalBlocks'
import { sendProposalStageMessage } from './sendProposalStageMessage'

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
  const ps = useProposalStore.getState()
  const sec = ps.sections.find((s) => s.id === sectionId)
  if (!sec || sec.kind !== 'content') return

  const instruction = intent === 'fixSource' ? (note ?? INTENT_INSTRUCTION.fixSource) : INTENT_INSTRUCTION[intent]
  // 先置指针：本轮 end 的 content 产出会整节替换该节（FusionRuntimeProvider end 分流）。
  ps.setPendingRevision({ sectionId })
  await sendProposalStageMessage(
    `【定向修订·只重写这一章，不要改动其它任何章节】${instruction}：\n\n${sec.markdown}\n\n` +
      `仍用方案【正文】哨兵包裹（与逐章撰写同款），段末按既有规则标注《来源》，绝不臆造。`
  )
}

/**
 * 资料缺失·补料续写（P3-2 阶段二）：用户为某章里某条「⚠️ 资料缺失：…」缺口补充了资料，
 * 让 AI【只重写这一章】、把补料融进缺口处、删掉那条缺失标记，产出整章替换原节。
 *
 * 复用与 reviseProposalSection 同一套机制（pendingRevision 指针 + end 分流整节替换 + 自动
 * 重新校验），区别只在指令：明确告知缺口描述与用户补料，并规定溯源——据【外部补料】写的内容
 * 标《${USER_SUPPLIED_SOURCE}》（校验侧识别为 user-supplied 中性态）；用户补料里若指认了知识库
 * 文件（如「见《某文件》」），则照常去 Read 该文件、按真实《文件名》标来源。两条路都不臆造。
 *
 * 仅对 content 节生效；非方案前台 / 目标节不存在 / 补料为空时静默 no-op。
 */
export async function fillProposalGap(
  sectionId: string,
  gapDesc: string,
  material: string
): Promise<void> {
  const trimmed = material.trim()
  if (!trimmed) return
  const ps = useProposalStore.getState()
  const sec = ps.sections.find((s) => s.id === sectionId)
  if (!sec || sec.kind !== 'content') return

  ps.setPendingRevision({ sectionId })
  await sendProposalStageMessage(
    `【资料缺失·补料续写·只重写这一章，不要改动其它任何章节】本章里有一处标注的缺口：「⚠️ 资料缺失：${gapDesc}」。` +
      `用户为此补充了以下资料：\n\n${trimmed}\n\n` +
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
 * 仅对 content 节生效；非方案前台 / 目标节不存在 / 指令为空时静默 no-op。
 */
export type BlockReviseAction = 'polish' | 'shorten' | 'expand' | 'rewrite' | 'fixSource' | 'custom'

const BLOCK_ACTION_INSTRUCTION: Record<Exclude<BlockReviseAction, 'custom'>, string> = {
  polish: '润色下面这一小段：改善措辞与流畅度，保持原意与信息量不变',
  shorten: '精简下面这一小段：删去冗余与重复，只留要点',
  expand: '把下面这一小段写得更详尽（补充细节、数据、案例），但严禁引入知识库之外的内容',
  rewrite: '重写下面这一小段，换一种更好的组织方式与措辞，质量更高',
  fixSource:
    '下面这一小段里有内容在所引《来源》原文中找不到依据（疑似编造或过度改写），请严格只依据所引文件原文重写，凡无来源支撑的表述一律删除或改写'
}

export async function reviseProposalSectionBlocks(
  sectionId: string,
  blockRange: { start: number; end: number },
  action: BlockReviseAction,
  selectedText: string,
  customInstruction?: string
): Promise<void> {
  const ps = useProposalStore.getState()
  // 并发守卫（review V1 根治）：pendingRevision 单槽——已有一次定向修订在飞时，再发起会 setPendingRevision
  // 覆盖旧指针，令先发起那次的 end 分流张冠李戴/丢产出。此处直接拒绝，堵住「选区气泡在生成中途被点」
  // 这条路（UI 侧还有 disabled 兜底）。整节修订/补料同样是单槽消费者，故任一在飞都拒绝。
  if (ps.pendingRevision) return
  const sec = ps.sections.find((s) => s.id === sectionId)
  if (!sec || sec.kind !== 'content') return

  const blocks = splitBlocks(sec.markdown)
  if (blocks.length === 0) return
  const start = Math.max(0, Math.min(blockRange.start, blocks.length - 1))
  const end = Math.max(start, Math.min(blockRange.end, blocks.length - 1))
  const context = blocks.slice(start, end + 1).join('\n\n')

  const instruction =
    action === 'custom' ? (customInstruction ?? '').trim() : BLOCK_ACTION_INSTRUCTION[action]
  if (!instruction) return
  const focus = selectedText.trim()

  // 置块区间指针：本轮 end 的 content 产出 spliceBlocks 进 [start,end]（其余块不动）。
  ps.setPendingRevision({ sectionId, blockRange: { start, end } })
  await sendProposalStageMessage(
    `【定向修订·只重写下面这一小段，不要改动本章其它内容、更不要动其它章节】${instruction}。\n\n` +
      (focus ? `用户特别想改的是这句：「${focus}」。\n\n` : '') +
      `这一小段的原文如下：\n\n${context}\n\n` +
      `只输出【重写后的这一小段本身】（不要重复章节标题、不要写章节序号），仍用方案【正文】哨兵包裹，` +
      `段末按既有规则标注《来源》，绝不臆造知识库之外的内容。`
  )
}
