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
 * 【2026-08 终审 #2】判定这一轮 `read.sections` 是不是「可疑地读空」——scan 阶段已经
 * 证明 drafts/ 下有文件（`scanFilesCount > 0`），但 read 阶段却一节都没读到
 * （`sectionsCount === 0`）。这个组合最可能的解释是：`readWritingSections` 内部对
 * `readdirSync(drafts)` 抛错时静默兜底成 `{ ok: true, sections: [] }`
 * （`writingProject.ts:230`，与轮询孤儿清扫的 M-1 那条窄缝同源）——不是「项目真的
 * 没有内容」，而是这一轮读盘本身不可信（网络共享盘抖动、目录正被 rename）。
 *
 * `useWritingPoll` 的 tick() 用它来决定这一轮要不要放行 `claimSeedSlot`：可疑的
 * 空读不能消耗 seed 名额——`claimSeedSlot` 只领一次，若在这种「读空」的假状态下
 * 被领走、又只 seed 了个空，往后文件正常回来时 `claimSeedSlot` 已经返回过 `false`、
 * 没人再补种 manual 哨兵，已有的指令块会被稳定判据当成「从没见过的新指令」两轮后
 * 整篇重新发起、重复扣费——与「表被清空但没人补种哨兵」这条本分支反复踩过的根因
 * 同构，只是这次的「清空」是「从没成功写入过」而不是「写入后被清掉」。
 *
 * 【不能只用 `sectionsCount > 0` 单独判断】新项目第一次真的只写出一节时，
 * `sectionsCount` 也是从 0 变成 >0 的这个瞬间——若因为「非空」就跳过 seed，等于把
 * AI 刚写完的第一条指令块直接标成 manual，这张图永远不会自动出，功能反而废掉。
 * 必须用 scan 阶段（`scanFilesCount`）与 read 阶段（`sectionsCount`）**两次独立观察
 * 之间的不一致**做判据，而不是只看某一次观察的绝对值——真·新项目是两次观察都是 0
 * （一致，放行 seed，seed 到的是空集合，无害）；「已有项目但这轮读空」是两次观察
 * 不一致（scan 非 0、read 是 0，拦住）。
 *
 * 【⚠️ 这条判据没有堵住什么 —— 2026-08 终审复审实证，别读成「这一族已收口」】
 * 本判据依赖 scan 与 read 内层 scan **两次观察的不一致**。但 `readWritingSections`
 * 内部会**重跑一次同款 `scanWritingDoc`**（`writingProject.ts:230`），两次 readdir
 * 之间只隔一次 IPC 往返（毫秒级）。因此：
 *
 * - 故障**恰好起始于两次 readdir 之间** → `scanFilesCount > 0`、read 空 → 本判据生效 ✅
 * - 故障**在外层 scan 之前就已经在进行中** → 两次一起兜底成空 → `scanFilesCount` 同样
 *   是 0 → **本判据不生效，C-1 在这条路径上原样成立**（seed 名额被空耗 → 文件回来后
 *   没人补种哨兵 → 整篇指令块被当新指令，两轮后重新发起、**重复扣费**）。
 *
 * 而网络共享盘抖动、目录 rename 这类真实故障**大多属于后者**（首个 tick 落进一段
 * 正在持续的故障，比恰好落在两次 readdir 的缝里概率高得多）。也就是说本判据覆盖的
 * 是较窄的那一半。要真正闭合，得让「seed 名额」与「确实成功读到过内容」绑定，
 * 而不是与「首次成功返回」绑定 —— 属结构性改动，未在收尾轮做，见账本残留清单。
 *
 * 另一条不区分的窄缝：「scan 那一刻文件还没创建、read 那一刻已创建但读失败」
 * （`scanFilesCount === 0` 但 read 其实该有内容）会被当成「新项目」提前 seed 成
 * manual —— 后果是这条新指令退化成「手动点一下才出图」，不烧钱，权衡后不处理。
 */
export function isReadSuspiciouslyEmpty(scanFilesCount: number, sectionsCount: number): boolean {
  return scanFilesCount > 0 && sectionsCount === 0
}

/**
 * 本次发起时项目是否仍然有效：① 仍是 project 模式且 projectDir 没变——网络往返期间
 * 用户可能切走了写作项目（甚至切成了另一份 project）；② 目标节仍在当前 sections 里
 * ——节可能已被删除/重命名。两条都不满足就不写表：生成已经完成（图已经落盘在旧项目的
 * images/ 里，写盘动作本身无害），但此刻已经没有「当下这份文档」可挂审阅卡/任务态，
 * 硬写只会把旧项目的状态串到新项目上。与提案侧 fireGenImageDirective 第 43-45 /
 * 58-62 行的节存在性守卫同一理由，这里多一条 projectDir 比对因为写作没有 sessionId
 * 那样天然绑定的归属会话。
 *
 * **导出**（2026-08 复审 I-3）：`WritingPaper` 的「重改」也走 `writingImageGenerate`
 * 这同一条十几到几十秒的网络往返，同样需要在写回 store 前核对项目没有被切走——不导出
 * 就只能在 `WritingPaper.tsx` 里重复一份一模一样的判断，两份迟早漂。
 */
export function stillTargetable(projectDir: string, sectionName: string): boolean {
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
    // 【2026-08 复审 C-1】`path` 是绝对路径，只给审阅卡预览 `<img>` 用；`relPath`
    // （`../images/<文件名>`）才是落位时要写进正文的那个——两者都要存，见
    // `ImageReview.relPath` 字段注释里「为什么不能用 path」的完整推演（含空格路径、
    // Windows 反斜杠两个失败场景）。此前这里只解出 `path`，`relPath` 被整个丢弃，
    // 审阅卡应用后写进正文的是绝对路径。
    const { path, relPath } = await window.chatApi.writingImageGenerate({
      projectDir,
      prompt: buildWritingGenImagePrompt(d, imageStyle)
    })
    if (!stillTargetable(projectDir, sectionName)) return
    const wstore = useWritingStore.getState()
    wstore.addImageReview({
      sectionId: sectionName,
      blockIndex: d.blockIndex,
      resultPath: path,
      relPath,
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
// 不清空的理由（切换项目不清）：写作允许来回切换多个项目，这张表只影响「多等一轮」还是
// 「立刻发起」，不影响正确性上限——真正的正确性防线是 genImageJobs 的幂等判定（守卫③）。
// 但**effect 每次重新开始轮询时会清空它**（见 stores/writing.ts 的 `resetWritingGenImageAutoFireState`
// 调用点及其注释）——那是为了保证「连续两轮」里的两轮确实是两次真实相隔 2 秒的观察，不是
// 「现在」跟「几分钟前随便哪次」的比较，与本文件不清空的取舍并不矛盾：不清空是为了跨越「频繁的
// 心跳级 tick」共用签名基准，效果重启是为了不让「轮询暂停又恢复」的间隙污染稳定性保证。
const lastSectionSignature = new Map<string, string>()

// M-2：上限告警只在「这个项目第一次跨过阈值」时打一次，不是每 2 秒重复刷。写作靠轮询触发，
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

  // 每节的指令块只解析一次，孤儿清理（下面）与发起循环（再下面）共用这份结果，
  // 避免 parseGenImageDirectives 对同一节内容跑两遍。
  const directivesBySection = s.sections.map((sec) => ({
    sec,
    directives: parseGenImageDirectives(sec.markdown)
  }))

  // 孤儿 job 键清理。判据升级为「这个键在当前正文里还找不找得到」（2026-08 审查 m-5，
  // 取代原来只判「节名还在不在」的 M-3 版本）：
  //
  // M-3 原版只能清掉【节被改名/删除】留下的键（键前缀=节名，节没了自然清得掉）；但
  // 【节还在、指令块内容被改过】的情况清不掉——key 的第三段是指令原文的内容哈希，
  // 改一次构图描述（「再暗一点」「换成俯视角」……）哈希就变、key 就变，旧 key 的节名
  // 前缀依然精确匹配「节还在」，永远留在表里。用户对同一张图反复调构图（很常见的
  // 用法）改 5 版就把 MAX_AUTO_FIRE_PER_WRITING_PROJECT 配额吃满，此后这篇稿子里
  // 任何真正的新指令块都不再自动出图，且因 M-2 的 warn 去重只在触顶那一次说一句话，
  // 用户完全无感（m-5 审查实测复现）。
  //
  // 修法：直接从当前 sections 解析出全部「合法」key（不区分节是否改名——节没了自然
  // 不会贡献任何 key，节还在但某条指令内容变了也不会贡献旧 key，两类孤儿一次性
  // 统一处理），凡是不在这个合法集合里的旧 key 一律清掉。
  //
  // 【为什么不会误伤在飞的 pending】fireWritingGenImage 发起那一刻，key 必然是从
  // 【当前正文】解析出的 `d.raw` 算出来的，只要内容在生图 IPC 往返期间没有再变，
  // 这里重新解析当前 sections 得到的合法集合里一定还有这个 key——差集不会把它清掉。
  // 只有当内容在往返期间又被改写（key 因内容变化而不再「合法」）时才会被清，而那种
  // 情况下原指令本身也已经不是「当下这份正文」的一部分了，清掉是正确的（fire 完成后
  // 会再把 done/failed 写回一个此刻已经孤立的 key，下一轮又会被这里清掉，自愈）。
  //
  // 【2026-08 审查第五轮 M-1：sections 空读的这一轮必须整体跳过清扫，这是本任务
  // 第 4 次踩「表被清空但没人重新登记哨兵」这同一个根因】上面差集清理的前提是
  // 「validKeys 是从可信的当前正文推出来的」。但 `s.sections` 本身也可能在某一轮
  // 恰好是空数组——不是「项目目录被删」（那条路走的是 scan 失败 dirMissing，
  // 在 setStatus+return 那一步就退出了，根本进不到这个函数），而是「scan 成功
  // （files: []）、但 read 阶段 readdirSync(drafts) 抛错」这种更窄的缝：项目目录
  // 还在，只是 drafts/ 恰好在这一帧被瞬时移走又重建，或者网络共享盘（writingDocSource.ts
  // 明确要支持 UNC 路径）抖了一下。这种情况下 read.ok 为真但一节都没读到，
  // `directivesBySection` 是空数组，`validKeys` 随之为空集，差集会把 genImageJobs
  // 全表键都判成孤儿、一次性抹光——而这条路径不经过 setSource，`seededProjects`
  // 里这个项目的「已 seed」标记完全不受影响，下一轮文件正常回来时没人会重新补种
  // manual 哨兵，稳定判据走完两轮之后，全篇指令块被当成「从没见过的新指令」重新
  // 发起，等价于把整篇稿子的配图重新生成一遍、重复扣费。
  // 「一节都没读到」本身不是可信的清理依据——不清扫，等下一轮 sections 非空时
  // 再正常跑差集（真实的孤儿清理，如「节被改名/删除」「指令内容改写」，参见上面
  // m-5 那段注释），照样能清干净，只是晚一轮，不会有任何正确性损失。
  const validKeys = new Set(
    directivesBySection.flatMap(({ sec, directives }) =>
      directives.map((d) => genImageDirectiveKey(sec.name, d.raw, d.occurrence))
    )
  )
  const orphanKeys =
    s.sections.length === 0 ? [] : Object.keys(s.genImageJobs).filter((k) => !validKeys.has(k))
  if (orphanKeys.length > 0) {
    useWritingStore.setState((st) => {
      const jobs = { ...st.genImageJobs }
      for (const k of orphanKeys) delete jobs[k]
      return { genImageJobs: jobs }
    })
  }

  // 孤儿审阅卡清理（2026-08 复审 M-1/M-4，与上面 job 键孤儿清理完全同构、复用同一份
  // validKeys）：`imageReviews` 挂着「待用户裁决」的出图产物，若它对应的指令块在
  // 当前正文里已经找不到（AI 在悬而未决期间整段重写了这一节，直接改掉了指令内容），
  // 指令卡与审阅卡在渲染层会一起消失（`WritingPaper` 靠内容键匹配，见其块渲染循环），
  // 但审阅项本身不清理的话会永远留在 store 里当一个渲不出来、也没人能点「应用/丢弃」
  // 的幽灵——用户看不到任何提示，已经生成的图就此不可达（M-4）。
  //
  // 判据与 job 键一致：审阅项换算出的 `genImageDirectiveKey(sectionId, directiveRaw,
  // directiveOccurrence)` 键不在 validKeys 里就清掉。**这不足以堵住 M-1 那类「同一节
  // 有三个及以上字面相同的指令块，处理了其中一个后兄弟卡 occurrence 错位」的问题**
  // ——内容完全相同的多个块在 key 空间里互相「可替身」，某个 occurrence 的 key 依然
  // 存在于 validKeys 不代表它此刻真的对应同一个原始块。那类漂移由 `WritingPaper` 在
  // 应用/丢弃成功后精确调用 `renumberSiblingGenImageReviews`（splice 语义决定的确定性
  // 位移，不是内容匹配的猜测）解决，与这里的差集清理是互补关系，不是同一件事——这里
  // 只管「指令内容被 AI 整个改掉/删掉」这一类。
  //
  // 不会误伤在飞的：`addImageReview` 是 IPC 成功回调里的同步调用，写进去的
  // `directiveRaw` 就是那一刻的当前内容，只要内容在生图 IPC 往返期间没有再变，这里
  // 重新解析当前 sections 得到的合法集合里一定还有这个 key。与 job 键清理同受
  // `s.sections.length === 0` 短路保护（理由见上方那段注释，此处不重复）。
  const orphanReviewIds =
    s.sections.length === 0
      ? []
      : s.imageReviews
          .filter(
            (r) =>
              r.mode === 'directive' &&
              !!r.directiveRaw &&
              !validKeys.has(genImageDirectiveKey(r.sectionId, r.directiveRaw, r.directiveOccurrence ?? 0))
          )
          .map((r) => r.id)
  if (orphanReviewIds.length > 0) {
    const orphanSet = new Set(orphanReviewIds)
    useWritingStore.setState((st) => ({
      imageReviews: st.imageReviews.filter((r) => !orphanSet.has(r.id))
    }))
  }

  // 守卫④的配额来源：genImageJobs 本身就是全部已发起记录（含手动发起），按它的长度算
  // 总量控制语义更正确；manual 态是重开会话预登记的哨兵、不是本次会话真实发起过的生图，
  // 不占自动发起配额——同 autoFireProposalGenImages 的既有取舍。用清理孤儿键之后的最新
  // 快照重取一次 genImageJobs（上面的 setState 已经生效，getState() 拿到的是新值）。
  const jobsAfterCleanup = useWritingStore.getState().genImageJobs
  let fired = Object.values(jobsAfterCleanup).filter((j) => j.status !== 'manual').length

  // M-4/m-4：契约自己声明的第一道花钱闸（spec_lock.md「## 配图」段的 image_count，
  // 含 image_plan: none/cover-only 覆写的隐含值）只能收紧桌面端的硬上限，不能放宽——
  // `imageCount` 来自 AI 写的文件，不可信；哪怕契约里填了 100，最终上限也不会超过
  // MAX_AUTO_FIRE_PER_WRITING_PROJECT。契约值缺失/非法（parseImageCount 已经把这些
  // 情况统一成 null）时退回桌面端默认上限。
  const cap = Math.min(s.imageCount ?? MAX_AUTO_FIRE_PER_WRITING_PROJECT, MAX_AUTO_FIRE_PER_WRITING_PROJECT)

  for (const { sec, directives } of directivesBySection) {
    // 守卫②·稳定判据：该节这一轮的内容签名与上一轮不同 → 本轮不发起，只记签名。
    // AI 还在写这一节时文件仍在变，此刻的指令块可能是半截的（围栏未闭合、构图描述写了
    // 一半）——parseGenImageDirectives 对半截块本就解析不出东西，但下一秒它就会变成
    // 完整块，若那一刻立刻发起，等于把「刚好扫到的这一帧」当成定稿，稍有不慎就会撞上
    // AI 还没写完图说、只解析出半句 prompt 的畸形指令。连续两轮不变才发起，用轮询间隔
    // （2s）本身当「这一节先歇一会儿」的信号。签名用内容哈希而非 mtimeMs:length，理由见
    // `lastSectionSignature` 顶注（I-2）。
    const sigKey = `${projectDir}#${sec.name}`
    const signature = genImageRawHash(sec.markdown)
    const prevSignature = lastSectionSignature.get(sigKey)
    lastSectionSignature.set(sigKey, signature)
    if (signature !== prevSignature) continue

    for (const d of directives) {
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
