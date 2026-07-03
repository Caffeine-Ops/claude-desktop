// genimage 指令块的生图发起器（配图密度③）。两个入口：
//   - autoFireProposalGenImages：FusionRuntimeProvider 在【落节时机】（end 入库 / AskUserQuestion
//     暂停时的轮内 syncSections）调用，扫全部正文节里的新指令块并自动发起。只有这两个实时路径
//     会调它——restore/reopen 重建草稿绝不自动发起（防重开会话重复烧生图费），重建出的指令块
//     渲染成「点此生成」手动卡（见 GenImageDirectiveCard）。
//   - fireGenImageDirective：单条发起（手动卡按钮 / 自动路径共用）。
// 幂等：genImageJobs 键存在即跳过（无论 pending/failed/done——failed 的重试是用户显式点按钮，
// 不归自动路径管）。防御上限 MAX_AUTO_FIRE_PER_SESSION 兜提示词失灵（AI 输出几十个指令块）的
// 极端场景：超限的指令块留成手动卡，用户看得见、点一下也能生成，不静默丢。
import {
  parseGenImageDirectives,
  genImageDirectiveKey,
  type GenImageDirective
} from '@shared/proposalGenImage'
import { useProposalStore } from '../stores/proposal'
import { friendlyImageError } from './imageErrorText'

const MAX_AUTO_FIRE_PER_SESSION = 5

/** 给生图模型的最终提示词：构图描述 + 统一风格约束（中文短标签、扁平商务、白底、无水印）。 */
export function buildGenImagePrompt(d: { caption: string; prompt: string }): string {
  return (
    `为售前建设方案绘制「${d.caption}」：${d.prompt}\n` +
    '风格要求：现代扁平商务信息图/架构示意图，蓝色系配色、白色背景、圆角矩形分层分区排布；' +
    '图中文字全部使用简体中文、少而大、清晰可读；不要出现水印、乱码或与内容无关的装饰元素。'
  )
}

/** 发起一条指令块的生图：登记 pending → IPC → 成功登记审阅卡+done / 失败记 error。 */
export async function fireGenImageDirective(
  sessionId: string,
  sectionId: string,
  d: GenImageDirective
): Promise<void> {
  const key = genImageDirectiveKey(sectionId, d.raw, d.occurrence)
  useProposalStore.getState().setGenImageJob(key, { status: 'pending' })
  try {
    const { path } = await window.chatApi.proposalImageGenerate({
      sessionId,
      prompt: buildGenImagePrompt(d)
    })
    const pstore = useProposalStore.getState()
    // 秒级网络往返期间节可能被删：生成已完成但无处挂审阅卡，静默丢弃（与 handleImageGenerate
    // 的既有立场一致）。job 不清——removeSection 已按 sectionId 前缀连带清理。
    if (!pstore.sections.some((s) => s.id === sectionId)) return
    pstore.addImageReview({
      sectionId,
      blockIndex: d.blockIndex,
      resultPath: path,
      mode: 'directive',
      directiveRaw: d.raw,
      directiveOccurrence: d.occurrence,
      caption: d.caption
    })
    pstore.setGenImageJob(key, { status: 'done' })
  } catch (err) {
    const pstore = useProposalStore.getState()
    // 节存在性守卫，与成功路径对称（Task 6 评审 Minor）：pending 期间用户「新建」清空草稿会
    // 换一批全新 section id，此时该节已不在当前 sections 里；若仍写表，失败回调会把旧节 id
    // 的孤儿键塞进新草稿的空 genImageJobs、白占自动发起配额（MAX_AUTO_FIRE_PER_SESSION 按
    // 表长度算，见 autoFireProposalGenImages）。节已删则直接 return，不落任何键。
    if (!pstore.sections.some((s) => s.id === sectionId)) return
    pstore.setGenImageJob(key, { status: 'failed', error: friendlyImageError(err, 'generate') })
  }
}

/** 落节时机的自动发起：扫全部正文节，对没登记过任务的指令块逐条 fire（不 await，互不阻塞）。 */
export function autoFireProposalGenImages(sessionId: string): void {
  const s = useProposalStore.getState()
  if (!s.active || s.sessionId !== sessionId) return
  // 发起配额由 genImageJobs 派生（任务表本身就是全部已发起记录，含手动发起——总量控制语义
  // 更正确），不再用模块级计数：配额与 genImageJobs 同生命周期，start/reset 清表即天然重置
  // 预算，不再有跨草稿残留（评审缺陷：模块级 Map 以 sessionId 为键永不清理，「新建方案」复用
  // 同一 sessionId 时旧草稿触顶会把新草稿的自动发起永久锁死）。
  // manual 键是 restore 重建预登记的哨兵（终审 I-1），不是本会话内真实发起过的生图记录，
  // 不该占用自动发起配额——否则一份带很多陈旧指令块的旧草稿会把新草稿的自动发起预算提前吃满。
  let fired = Object.values(s.genImageJobs).filter((j) => j.status !== 'manual').length
  for (const sec of s.sections) {
    if (sec.kind !== 'content') continue
    for (const d of parseGenImageDirectives(sec.markdown)) {
      const key = genImageDirectiveKey(sec.id, d.raw, d.occurrence)
      if (s.genImageJobs[key]) continue
      if (fired >= MAX_AUTO_FIRE_PER_SESSION) {
        console.warn('[proposal-genimage] 自动生图达每会话上限，其余指令块留手动生成', {
          sessionId,
          cap: MAX_AUTO_FIRE_PER_SESSION
        })
        return
      }
      fired++
      void fireGenImageDirective(sessionId, sec.id, d)
    }
  }
}
