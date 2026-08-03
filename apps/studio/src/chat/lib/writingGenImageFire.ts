/**
 * 写作工作区的 genimage 指令块生图发起器。
 *
 * 与提案侧 proposalGenImageFire 的**根本差异**：提案的正文活在内存 store 里，
 * 有明确的「落节」事件可挂；写作的正文是磁盘上的 drafts/*.md，右栏靠
 * useWritingPoll 每几秒重扫（比对 name:mtimeNs:size 签名）。没有事件，只有轮询。
 * 这带来两个必须显式解决的问题：
 *
 * ① **幂等**——轮询每几秒跑一次，没有 job key 记账就是每一轮重复出图、重复烧钱。
 * ② **稳定判据**——AI 还在写这一节时文件仍在变，此刻的指令块可能是半截的
 *    （围栏未闭合、构图描述只写了一半）。所以只在该节签名**连续两轮不变**时才发起。
 *    提案侧靠「落节」天然规避了这个问题，写作必须显式做。
 *
 * 【circular import 提示】本文件 import useWritingStore，stores/writing.ts 反过来
 * import 本文件的 autoFireWritingGenImages（供 useWritingPoll 的 tick() 调用，轮询
 * 循环天然只能挂在 store 模块内部）。两边都只在函数体内引用对方的导出，不在模块顶层
 * 求值时使用——ESM 循环依赖下这是安全的（同 zustand store 与其消费 lib 互相 import
 * 的既有惯例，proposal 侧没有这个问题只是因为它的触发点在组件里而非 store 内部）。
 */
import {
  parseGenImageDirectives,
  genImageDirectiveKey,
  type GenImageDirective
} from '@desktop-shared/proposalGenImage'
import { useWritingStore } from '../stores/writing'
import { friendlyImageError } from './imageErrorText'

export const MAX_AUTO_FIRE_PER_WRITING_PROJECT = 5

/** 提示词 = 图说 + 构图描述 + 契约锁定的画风 + 三条恒定约束。 */
export function buildWritingGenImagePrompt(
  d: { caption: string; prompt: string },
  imageStyle: string
): string {
  const style = imageStyle.trim()
  return (
    `为一篇文章绘制配图「${d.caption}」：${d.prompt}\n` +
    (style ? `风格要求：${style}。\n` : '') +
    '恒定要求：不要在画面中出现任何文字（生图模型的中文标注必糊必错，' +
    '需要文字的信息图一律由 mermaid 承担）；不要水印；不要与内容无关的装饰元素。'
  )
}

/**
 * 本次发起时项目是否仍然有效：① 仍是 project 模式且 projectDir 没变——网络往返期间
 * 用户可能切走了写作项目（甚至切成了另一份 project）；② 目标节仍在当前 sections 里
 * ——节可能已被删除/重命名。两条都不满足就不写表：生成已经完成（图已经落盘在旧项目的
 * images/ 里，写盘动作本身无害），但此刻已经没有"当下这份文档"可挂审阅卡/任务态，
 * 硬写只会把旧项目的状态串到新项目上。与提案侧 fireGenImageDirective 第 43-45 /
 * 58-62 行的节存在性守卫同一理由，这里多一条 projectDir 比对因为写作没有 sessionId
 * 那样天然绑定的归属会话。
 */
function stillTargetable(projectDir: string, sectionName: string): boolean {
  const s = useWritingStore.getState()
  if (s.source?.kind !== 'project' || s.source.projectDir !== projectDir) return false
  return s.sections.some((sec) => sec.name === sectionName)
}

/** 发起一条指令块的生图：登记 pending → IPC → 成功登记审阅卡+done / 失败记 error。 */
export async function fireWritingGenImage(
  projectDir: string,
  sectionName: string,
  d: GenImageDirective
): Promise<void> {
  const key = genImageDirectiveKey(sectionName, d.raw, d.occurrence)
  useWritingStore.getState().setGenImageJob(key, { status: 'pending' })
  try {
    // 画风在发起这一刻现读（而不是由调用方传入）：fireWritingGenImage 也是手动卡按钮的
    // 发起入口（未来任务），现读能保证手动重试时用的是当下契约里最新的 image_style。
    const imageStyle = useWritingStore.getState().imageStyle ?? ''
    const { path } = await window.chatApi.writingImageGenerate({
      projectDir,
      prompt: buildWritingGenImagePrompt(d, imageStyle)
    })
    if (!stillTargetable(projectDir, sectionName)) return
    const wstore = useWritingStore.getState()
    wstore.addImageReview({
      sectionId: sectionName,
      blockIndex: d.blockIndex,
      resultPath: path,
      mode: 'directive',
      directiveRaw: d.raw,
      directiveOccurrence: d.occurrence,
      caption: d.caption
    })
    wstore.setGenImageJob(key, { status: 'done' })
  } catch (err) {
    if (!stillTargetable(projectDir, sectionName)) return
    useWritingStore
      .getState()
      .setGenImageJob(key, { status: 'failed', error: friendlyImageError(err, 'generate') })
  }
}

// 稳定判据的状态：节名 → 上一轮观察到的内容签名（mtimeMs:markdown 长度）。**模块级变量，
// 生命周期是整个渲染进程**，键带 projectDir 前缀避免不同项目里同名节（如两份稿子都有
// `1-开场.md`）互相污染签名——不这样做的话，A 项目稳定过一次的节签名可能被 B 项目同名但
// 内容不同的节意外命中「未变化」，跳过应有的稳定等待直接发起。切换项目不清空这张表：
// 写作允许来回切换多个项目，清空会让「刚切回来的项目」重新经历一次「首轮不发起」的等待，
// 且 genImageJobs 本身已经是幂等的最终防线——这张表只影响"多等一轮"还是"立刻发起"，
// 不影响正确性，多留几条旧项目的签名代价可忽略（远小于每次切换都重新等 2s 的体验代价）。
const lastSectionSignature = new Map<string, string>()

/**
 * 轮询触发的自动发起：扫当前写作项目全部节，对签名连续两轮不变、且没登记过任务的指令块
 * 逐条 fire（不 await，互不阻塞）。由 useWritingPoll 的 tick() 每次轮询都调用一次——包括
 * 「磁盘元信息没变」的短路分支，那种情况下正文确实没变，正好可以让稳定判据往前推进一轮。
 */
export function autoFireWritingGenImages(): void {
  const s = useWritingStore.getState()
  // 守卫①：单文件模式没有 images/ 落点（writingImageGenerate 只支持 project 模式，
  // relPath 的 `../images/` 相对路径假设了 <projectDir>/drafts 这层结构），直接不发起。
  if (s.source?.kind !== 'project') return
  const projectDir = s.source.projectDir

  // 守卫④的配额来源：genImageJobs 本身就是全部已发起记录（含手动发起），按它的长度算
  // 总量控制语义更正确；manual 态是重开会话预登记的哨兵、不是本次会话真实发起过的生图，
  // 不占自动发起配额——同 autoFireProposalGenImages 的既有取舍。
  let fired = Object.values(s.genImageJobs).filter((j) => j.status !== 'manual').length

  for (const sec of s.sections) {
    // 守卫②·稳定判据：该节这一轮的内容签名与上一轮不同 → 本轮不发起，只记签名。
    // AI 还在写这一节时文件仍在变，此刻的指令块可能是半截的（围栏未闭合、构图描述写了
    // 一半）——parseGenImageDirectives 对半截块本就解析不出东西，但下一秒它就会变成
    // 完整块，若那一刻立刻发起，等于把「刚好扫到的这一帧」当成定稿，稍有不慎就会撞上
    // AI 还没写完图说、只解析出半句 prompt 的畸形指令。连续两轮不变才发起，用轮询间隔
    // （2s）本身当"这一节先歇一会儿"的信号。
    const sigKey = `${projectDir}#${sec.name}`
    const signature = `${sec.mtimeMs}:${sec.markdown.length}`
    const prevSignature = lastSectionSignature.get(sigKey)
    lastSectionSignature.set(sigKey, signature)
    if (signature !== prevSignature) continue

    for (const d of parseGenImageDirectives(sec.markdown)) {
      // 守卫③·幂等：键已存在（无论 pending/failed/done/manual）就跳过，防止同一指令块
      // 被下一轮轮询再次发起——这是本任务最重要的正确性要求，写作靠轮询触发、没有它
      // 就是每 2s 重复出图、重复烧钱。
      const key = genImageDirectiveKey(sec.name, d.raw, d.occurrence)
      if (s.genImageJobs[key]) continue
      // 守卫④：配额用尽，其余指令块留成手动卡（用户看得见、点一下也能生成，不静默丢）。
      if (fired >= MAX_AUTO_FIRE_PER_WRITING_PROJECT) {
        console.warn('[writing-genimage] 自动生图达每写作项目上限，其余指令块留手动生成', {
          projectDir,
          cap: MAX_AUTO_FIRE_PER_WRITING_PROJECT
        })
        return
      }
      fired++
      // 守卫⑤（画风取值）落在 fireWritingGenImage 内部现读 store，这里不重复传参——
      // 见该函数注释。
      void fireWritingGenImage(projectDir, sec.name, d)
    }
  }
}
