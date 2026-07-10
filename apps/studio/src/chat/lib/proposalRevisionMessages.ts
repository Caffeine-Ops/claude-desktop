import type { ProposalKind } from '@desktop-shared/proposal'

// 纯函数模块：只拼「选区即改」发给引擎的指令字符串，不碰任何 store / 副作用——故可被 bun test
// 单独加载单测（sendProposalSectionRevision.ts 因 import zustand store 等无法在 Node 里直接测）。

// 溯源后缀按节类型分叉：正文节要标《来源》、守 trigram 引用落地校验；封面/目录不引用知识库、无
// 溯源语义，故只要求「按指令改这一小段、保持简短、别臆造」——否则会逼 AI 给封面字段硬凑《来源》成噪声。
export function groundingSuffix(kind: ProposalKind): string {
  return kind === 'content'
    ? '段末按既有规则标注《来源》，绝不臆造知识库之外的内容。'
    : '这是封面/目录里的字段，只按指令改这一小段、保持简短，不要标注《来源》，也不要臆造任何事实信息。'
}

/**
 * 拼「选区即改·初次改写」发给引擎的一条消息。核心不变量：focus 非空时钉死「只改选中、其余一字不动、
 * 整段返回」——底层仍整块 spliceBlocks，靠这段措辞让 AI 只动选中句、段内其余逐字保留，从而消掉
 * 「多改了附近一整块」。focus 为空（防御性，选区气泡不会以空选区发起）退回「整段改写」旧措辞。
 * 同一句「其余原样」对「选了一句」与「选了整段」都通用：选了整段时「选中范围以外」为空，自然整段改。
 */
export function buildSelectionRevisionMessage(params: {
  instruction: string
  focus: string
  context: string
  kind: ProposalKind
}): string {
  const { instruction, focus, context, kind } = params

  // 硬边界（实测踩坑）：fusion-code 是带 Write/Bash 的 agent，连做几轮小改后会「自作主张」觉得
  // 方案该收尾了，转去评估整份方案 / 往桌面写报告，无视改写指令。方案系统提示词没禁这些，故在此
  // 把边界钉死：只改这一小段、只用哨兵返回、严禁写文件/评估/交付/另起任务。两个分支共用。
  const boundary =
    `【就地小改·硬性边界】这是针对方案正文里【某一小段】的一次就地改写，不是新任务、更不是收尾。` +
    `你【唯一要做的事】：按要求就地改写下面这一小段，并用方案【正文】哨兵原样返回。` +
    `【严禁】写入或创建任何文件（别碰桌面、别生成任何 .md/报告）、评估或点评整份方案、总结或交付、` +
    `另起新章节、输出这一小段以外的任何内容；如需核对来源仅用 Read，绝不调用任何写类工具。\n\n`

  const scope = focus
    ? `用户只选中了这段里的一部分文字要改：「${focus}」。请【只改写这部分选中的文字】，` +
      `本段里选中范围以外的其它文字【必须一字不动、原样保留】——不要顺手润色、调整或重写它们。\n\n` +
      `改写要求：${instruction}\n\n` +
      `这一小段的完整原文如下：\n\n${context}\n\n` +
      `请输出【整段完整内容】：选中部分按要求改写、其余部分逐字保持不变` +
      `（不要重复章节标题、不要写章节序号），`
    : `请把下面这一小段按要求改写。\n\n` +
      `改写要求：${instruction}\n\n` +
      `这一小段的原文如下：\n\n${context}\n\n` +
      `只输出【重写后的这一小段本身】（不要重复章节标题、不要写章节序号），`

  return boundary + scope + `仍用方案【正文】哨兵包裹，` + groundingSuffix(kind)
}
