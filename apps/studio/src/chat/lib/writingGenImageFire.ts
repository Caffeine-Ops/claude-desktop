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
  genImageRawHash,
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

// 稳定判据的状态：节名 → 上一轮观察到的内容签名。**模块级变量，生命周期是整个渲染进程**，
// 键带 projectDir 前缀避免不同项目里同名节（如两份稿子都有 `1-开场.md`）互相污染签名。
//
// 【2026-08 审查 I-2：签名必须是内容本身（或其哈希），不能是 mtimeMs:length】旧实现用
// `${sec.mtimeMs}:${sec.markdown.length}`，恰好退回了 `stores/writing.ts` 里那段专门
// 花代价堵过的洞——那里的注释明写「若改写后新内容长度恰好相同、且两次写入落在同一毫秒内，
// 毫秒签名会与上一轮撞车，判定『未变化』而漏刷」，所以轮询的外层签名必须用纳秒精度的
// `mtimeNs`。但 `WritingSection`（读正文用的类型）只带毫秒精度的 `mtimeMs`，没有 `mtimeNs`
// ——用它当稳定判据的签名，等长替换（中文里「的→地」「，→、」这类单字符替换很常见）若又
// 恰好落在同一毫秒内，会被误判「未变化」，在文件其实还在被写的那一帧上发起出图（半截指令）。
// 这正是稳定判据存在的唯一理由，不能被它自己依赖的精度问题绕过去。改用内容哈希后不存在
// 这个精度问题：只要内容有哪怕一个字符不同，哈希必然不同（哈希碰撞概率对本场景可忽略），
// 且 `sections` 已经在内存里，不需要额外读盘或提升 mtime 精度。
//
// 不清空的理由（切换项目不清）：写作允许来回切换多个项目，这张表只影响"多等一轮"还是
// "立刻发起"，不影响正确性上限——真正的正确性防线是 genImageJobs 的幂等判定（守卫③）。
// 但**effect 每次重新开始轮询时会清空它**（见 stores/writing.ts 的 `resetWritingGenImageAutoFireState`
// 调用点及其注释）——那是为了保证"连续两轮"里的两轮确实是两次真实相隔 2 秒的观察，不是
// "现在"跟"几分钟前随便哪次"的比较，与本文件不清空的取舍并不矛盾：不清空是为了跨越"频繁的
// 心跳级 tick"共用签名基准，效果重启是为了不让"轮询暂停又恢复"的间隙污染稳定性保证。
const lastSectionSignature = new Map<string, string>()

// M-2：上限告警只在"这个项目第一次跨过阈值"时打一次，不是每 2 秒重复刷。写作靠轮询触发，
// 若不去重，一小时就是 1800 条带对象的 console.warn；提案侧没有这个问题是因为它挂在离散的
// 「落节」事件上，触顶最多告警几次。
const warnedProjects = new Set<string>()

/**
 * 供 `useWritingPoll` 在每次轮询 effect 重新开始时调用：清掉稳定判据的签名表与配额告警
 * 去重表。**不清 genImageJobs / imageReviews**——那两个是 zustand store 里的持久状态，
 * 生命周期由 `setSource` 管，本函数只管本文件内部这两张模块级的、纯粹用来"记住上一次观察
 * 到什么"的簿记表。见 `lastSectionSignature` 顶注为什么这两者的清空时机不同但不矛盾。
 */
export function resetWritingGenImageAutoFireState(): void {
  lastSectionSignature.clear()
  warnedProjects.clear()
}

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

  // M-3：顺手清掉"节已不在当前 sections 里"的孤儿 job 键（节被改名/删除后残留）。
  // `writingProject.ts` 的注释明写"AI 正在改名"是预期场景，目前写作流水线虽然还没有
  // 显式的改名指令、这条路径不可达，但孤儿键一旦出现有三重代价：① 若恰好是 pending，
  // 永远等不到 stillTargetable 通过、卡片永远转圈；② 白占 MAX_AUTO_FIRE_PER_WRITING_PROJECT
  // 配额；③ 改名后的同一条指令因为 key 含旧节名而变成"新"key，会被重新自动发起——
  // 对同一张图付两次钱。键格式是 `${sectionName}#${occurrence}#${hash}`（见
  // genImageDirectiveKey），用"是否以某个现存节名+`#`开头"判定归属。
  const validNames = new Set(s.sections.map((sec) => sec.name))
  const orphanKeys = Object.keys(s.genImageJobs).filter(
    (k) => ![...validNames].some((name) => k.startsWith(`${name}#`))
  )
  if (orphanKeys.length > 0) {
    useWritingStore.setState((st) => {
      const jobs = { ...st.genImageJobs }
      for (const k of orphanKeys) delete jobs[k]
      return { genImageJobs: jobs }
    })
  }

  // 守卫④的配额来源：genImageJobs 本身就是全部已发起记录（含手动发起），按它的长度算
  // 总量控制语义更正确；manual 态是重开会话预登记的哨兵、不是本次会话真实发起过的生图，
  // 不占自动发起配额——同 autoFireProposalGenImages 的既有取舍。用清理孤儿键之后的最新
  // 快照重取一次 genImageJobs（上面的 setState 已经生效，getState() 拿到的是新值）。
  const jobsAfterCleanup = useWritingStore.getState().genImageJobs
  let fired = Object.values(jobsAfterCleanup).filter((j) => j.status !== 'manual').length

  // M-4：契约自己声明的第一道花钱闸（spec_lock.md「## 配图」段的 image_count）只能收紧
  // 桌面端的硬上限，不能放宽——`imageCount` 来自 AI 写的文件，不可信；哪怕契约里填了
  // 100，最终上限也不会超过 MAX_AUTO_FIRE_PER_WRITING_PROJECT。契约值缺失/非法
  // （parseImageCount 已经把这些情况统一成 null）时退回桌面端默认上限。
  const cap = Math.min(s.imageCount ?? MAX_AUTO_FIRE_PER_WRITING_PROJECT, MAX_AUTO_FIRE_PER_WRITING_PROJECT)

  for (const sec of s.sections) {
    // 守卫②·稳定判据：该节这一轮的内容签名与上一轮不同 → 本轮不发起，只记签名。
    // AI 还在写这一节时文件仍在变，此刻的指令块可能是半截的（围栏未闭合、构图描述写了
    // 一半）——parseGenImageDirectives 对半截块本就解析不出东西，但下一秒它就会变成
    // 完整块，若那一刻立刻发起，等于把「刚好扫到的这一帧」当成定稿，稍有不慎就会撞上
    // AI 还没写完图说、只解析出半句 prompt 的畸形指令。连续两轮不变才发起，用轮询间隔
    // （2s）本身当"这一节先歇一会儿"的信号。签名用内容哈希而非 mtimeMs:length，理由见
    // `lastSectionSignature` 顶注（I-2）。
    const sigKey = `${projectDir}#${sec.name}`
    const signature = genImageRawHash(sec.markdown)
    const prevSignature = lastSectionSignature.get(sigKey)
    lastSectionSignature.set(sigKey, signature)
    if (signature !== prevSignature) continue

    for (const d of parseGenImageDirectives(sec.markdown)) {
      // 守卫③·幂等：键已存在（无论 pending/failed/done/manual）就跳过，防止同一指令块
      // 被下一轮轮询再次发起——这是本任务最重要的正确性要求，写作靠轮询触发、没有它
      // 就是每 2s 重复出图、重复烧钱。
      const key = genImageDirectiveKey(sec.name, d.raw, d.occurrence)
      if (jobsAfterCleanup[key]) continue
      // 守卫④：配额用尽，其余指令块留成手动卡（用户看得见、点一下也能生成，不静默丢）。
      // 告警只在这个项目第一次触顶时打一次（M-2），不是每轮重复刷。
      if (fired >= cap) {
        if (!warnedProjects.has(projectDir)) {
          warnedProjects.add(projectDir)
          console.warn('[writing-genimage] 自动生图达每写作项目上限，其余指令块留手动生成', {
            projectDir,
            cap
          })
        }
        return
      }
      fired++
      // 守卫⑤（画风取值）落在 fireWritingGenImage 内部现读 store，这里不重复传参——
      // 见该函数注释。
      void fireWritingGenImage(projectDir, sec.name, d)
    }
  }
}
