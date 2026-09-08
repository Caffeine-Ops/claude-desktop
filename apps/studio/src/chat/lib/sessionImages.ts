import { detectImageGen } from './imageGenDetect'

/**
 * 会话产出物路径扫描（纯函数，无 React/window 依赖，bun test 直接覆盖）。
 *
 * 唯一的一套「扫本次会话产出了哪些文件」逻辑——OutputsPanel 的成果弹层与
 * 会话图库右栏都从这里取候选，**别再平行写第二套扫描**：两套代码迟早
 * 对不上（图库显示 5 张、成果弹层显示 4 张这种 bug 极难查）。
 *
 * 两个来源，与聊天流里已经渲染出来的卡片一一对应（面板不会突然冒出一个
 * 用户没见过卡片的文件）：
 *   - 正文提及：已完成的 assistant 文本里匹配 prosePathRe 的路径
 *     （AssistantDeliverables 的契约，「文件在这里」那一刻）；
 *   - 生成图：imagegen / gpt-image-2 的 Bash 调用 settled 后 stdout 里的
 *     成果路径（ImageGenCard 的契约）——这类路径很少再被正文复述，
 *     只扫文本会漏。
 *
 * 这里只产「候选」：返回的路径**尚未核实真存在**，调用方必须再走
 * `window.chatApi.statFiles` 去盘上确认（模型只是嘴上提过的路径不算）。
 */

/** 只按需要的字段做结构类型，不绑 stores/chat 的 message 类型——那边随
 *  assistant-ui 的 runtime 走，纯函数层用鸭子类型最稳。 */
type MessagePartLike = {
  type?: string
  text?: string
  toolName?: string
  args?: unknown
  result?: unknown
  endedAt?: unknown
}

type MessageLike = {
  status?: { type?: string }
  content?: unknown
}

/**
 * 按消息顺序走一遍会话，把每条命中路径按**首次出现**顺序去重收集。
 * prosePathRe 为 null 时只扫生成图（图库用）；否则正文与生成图交错收集
 * （成果弹层用）。正文正则必须带 g 标志——matchAll 的要求。
 */
function walkOutputPaths(
  messages: readonly unknown[],
  prosePathRe: RegExp | null,
  /** 可选：记录每条路径被 settled 的生成调用输出了几次（正文提及不计）。 */
  emissions?: Map<string, number>
): Set<string> {
  const seen = new Set<string>()
  for (const raw of messages) {
    const m = raw as MessageLike
    const running = m?.status?.type === 'running'
    const content = m?.content
    if (!Array.isArray(content)) continue
    for (const part of content as readonly MessagePartLike[]) {
      if (
        prosePathRe !== null &&
        !running &&
        part.type === 'text' &&
        typeof part.text === 'string'
      ) {
        for (const match of part.text.matchAll(prosePathRe)) seen.add(match[0])
      }
      if (part.type === 'tool-call' && part.toolName === 'Bash') {
        // settled 才算，按工具自身的信号而非消息 status（流式期间 status 还是
        // running，而工具早已结束）。两种戳任一即可：
        //   - endedAt：渲染层收到 result 时盖的运行时戳；
        //   - result 已存在：main 回放 JSONL 历史时**不带 endedAt**，只认它会让
        //     切回/重启后的会话一张图都扫不到（2026-09-07 真机复现）。
        const settled = typeof part.endedAt === 'number' || part.result !== undefined
        if (!settled) continue
        const info = detectImageGen(part.args, part.result, false)
        if (info) {
          for (const path of info.paths) {
            seen.add(path)
            emissions?.set(path, (emissions.get(path) ?? 0) + 1)
          }
        }
      }
    }
  }
  return seen
}

/** 成果弹层一次最多核实/展示的候选数（main 侧 SHELL_STAT_FILES 单次上限 50，
 *  留余量）。 */
const OUTPUT_CANDIDATE_CAP = 40

/**
 * 一趟扫描同时产出两份结果（数据泵用，每个 messages 变化只走一遍消息树）：
 *   - candidates：正文路径 + 生成图，首次出现顺序、最旧在前，最多 40 条
 *     （超限丢最旧）；
 *   - generated：其中哪些是生成图（不受 40 条上限影响；调用方按 files ∩
 *     generated 取图库列表，上限自然由 candidates 那边决定）。
 */
export function collectSessionOutputs(
  messages: readonly unknown[],
  prosePathRe: RegExp
): {
  candidates: string[]
  generated: ReadonlySet<string>
  /**
   * 每条路径被 settled 的生成调用输出了几次。数据泵把它拼进候选 key：
   * image_gen.py 对目录输出用固定文件名、--force 原地覆盖，路径不变但字节
   * 变了——只按路径去重的 key 不会变化，就永远不会再 statFiles、图库一直
   * 显示旧图（第二轮 code review 抓到）。次数变了 → key 变 → 重新 stat →
   * reducer 按 mtime 判出「同路径新版本」。
   */
  emissions: ReadonlyMap<string, number>
} {
  const emissions = new Map<string, number>()
  return {
    candidates: [...walkOutputPaths(messages, prosePathRe, emissions)].slice(-OUTPUT_CANDIDATE_CAP),
    generated: walkOutputPaths(messages, null),
    emissions
  }
}

/**
 * OutputsPanel 的候选扫描：正文路径 + 生成图，首次出现顺序，最多 40 条。
 * 返回顺序是「最旧在前」——调用方 stat 完再倒序展示。超限时**丢最旧的**
 * （slice(-CAP)）：旧实现 slice(0, CAP) 留最早的 40 条，长会话里刚生成的图
 * 反而进不了图库和成果弹层、零报错（2026-09-07 code review 抓到）。
 */
export function collectSessionOutputCandidates(
  messages: readonly unknown[],
  prosePathRe: RegExp
): string[] {
  return [...walkOutputPaths(messages, prosePathRe)].slice(-OUTPUT_CANDIDATE_CAP)
}

/**
 * 会话图库的数据源：**只收 AI 生成的图**（用户拖进对话的附件图、正文里
 * 顺嘴提到的图片路径都不算——图库的定位是「本次会话出过的图」），去重，
 * 最新在前。同一批次（generate-batch 一次出多张）内也按落盘顺序倒过来，
 * 与成果弹层的倒序语义一致。这里本身不设上限；但图库最终展示的是
 * useSessionOutputs 核实过的文件，受上面 40 条候选上限约束（超限丢最旧）。
 */
export function collectGeneratedImagePaths(messages: readonly unknown[]): string[] {
  return [...walkOutputPaths(messages, null)].reverse()
}
