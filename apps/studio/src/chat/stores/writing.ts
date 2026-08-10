import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

import type { WritingDocSource, WritingGenre, WritingSection } from '@desktop-shared/writing'
import {
  parseGenImageDirectives,
  genImageDirectiveKey
} from '@desktop-shared/proposalGenImage'
import {
  detectWritingSource,
  isWritingInProgress,
  pickFilePath,
  toolResultText,
  type WritingToolPart
} from '../lib/writingDocSource'
import { pushBounded } from '../lib/writingEdit'
import type { WritingRevisionTarget } from '../lib/writingRevision'
import type { GenImageJob, ImageReview } from '../lib/imageReviewTypes'
import {
  autoFireWritingGenImages,
  isReadSuspiciouslyEmpty,
  resetWritingGenImageAutoFireState
} from '../lib/writingGenImageFire'
import { useChatStore } from './chat'

/** 轮询间隔。2s 是「AI 写完一节到你看见」的上限，对人眼足够；再密只是空转 IPC。 */
const POLL_MS = 2000

type WritingStatus = 'idle' | 'ready' | 'missing' | 'error'

/** 排队软上限。与 proposal 的 MAX_REVISION_QUEUE 对齐——同一个数只写一处，提示文案引用它。 */
export const MAX_WRITING_REVISION_QUEUE = 10

/**
 * 撤销栈上限。20 步足够覆盖「刚才手滑那几下」，而这是个纯内存栈（关窗即失），
 * 不设上限的话长时间写一篇长文会把每一节的历史全副本堆在内存里。
 */
export const MAX_WRITING_UNDO = 20

/**
 * 一步可撤销的修改：**改之前**那一节长什么样。
 *
 * 刻意不存 mtime：撤销的语义是「把它现在变回旧样子」，写盘基准应取**撤销那一刻**盘上的
 * 最新 mtime，而不是当初改动前的。存了反而会诱使实现去用那个陈旧值——那样一来，用户改了
 * 三步再撤销，基准是三步之前的，乐观锁必然误报冲突。
 */
export interface WritingUndoEntry {
  sectionName: string
  markdown: string
}

/** 排队中的改写。**不存最终块序号**：排队期间前面的改写可能落地、序号会漂，排空时用
 *  target.beforeMarkdown 重新定位（range 只当多处命中时"哪一处离原位置最近"的裁决提示）。 */
export interface QueuedWritingRevision {
  id: string
  target: WritingRevisionTarget
  instruction: string
}

/** 待用户裁决的改写。渲染成「原文 vs 改后」对照卡。瞬时 UI 信号，不持久化。 */
export interface WritingRevisionReview {
  target: WritingRevisionTarget
  before: string
  after: string
  /**
   * 这张对照卡**成卡那一刻**所依据的那一版正文的 mtime，写盘时当乐观锁基准。
   *
   * 【反直觉但必须如此，别改成「写盘时现读最新的 mtime」】：轮询每 2s 把 sections 连同
   * mtimeMs 从盘上刷一遍。若基准取写盘那一刻的最新值，下面这条链就会静默毁掉正文：
   *   T0 成卡（基于 M0/m0，range 与 before 都是对 M0 算的）
   *   T1 AI 又改了这一节 → 盘上变 M1/m1 → 轮询把 store 刷成 M1/m1
   *   T2 用户点「应用」→ 拿 m1 当基准 → 主进程比对相等、放行 → 按 M0 的块序号把内容
   *      拼进 M1 的错误位置，无冲突提示、不可逆
   * 也就是说「AI 在用户裁决期间又改过这一节」——乐观锁最该拦的那个场景——恰恰被漏掉，
   * 锁实际只覆盖了「最后一次轮询到写盘」那 2 秒。基准与 target/before **同源同刻**取，
   * 锁才真正覆盖整个用户裁决窗口。
   */
  baseMtimeMs: number
  /**
   * `relocateTarget` 在这一节里找到了**不止一处**与 `beforeMarkdown` 完全相同的连续块
   * （例如两段句式雷同的模板化文字），本次是按「离入队时的位置最近」挑的一处——挑中的
   * 那处**可能是错的**。
   *
   * 这不是模糊匹配的产物（源码级匹配本身是精确的、逐字节相等），而是正文里恰好存在重复
   * 内容这一事实本身带来的歧义，机器无法替用户判断该改哪一份。为真时卡面必须显眼地提醒
   * 用户核对左侧原文确实是他要改的那段——**最后一道闸只能是用户的眼睛**。为假 = 唯一命中，
   * 无需提醒。
   */
  ambiguous: boolean
}

interface WritingState {
  source: WritingDocSource | null
  /**
   * 工作区绑定的会话 id。**改写消息的收件人**——多 tab 时前台会话可能已切走，
   * 没有它就无从判断「这条改写该不该发」，会把请求泄漏进别的会话（proposal 的
   * ps.sessionId 是同一个理由）。随 setSource 一起记，两者永远同生同灭。
   */
  sessionId: string | null
  genre: WritingGenre
  outlineTotal: number | null
  /**
   * 契约锁定的配图画风（spec_lock.md「## 配图」段的 image_style 字段），随 WRITING_SCAN
   * 一起回来（见该通道注释：不新开通道读 Markdown，main 侧顺路解析）。null 有三种
   * 正常成因：没有 spec_lock（单文件模式 / 职场快道）、没有「## 配图」段、字段本身留空
   * （`image_plan: none` 时按模板约定不填）——三种都不是错误，UI/提示词按空串兜底。
   */
  imageStyle: string | null
  /**
   * 契约锁定的配图张数上限（spec_lock.md「## 配图」段的 image_count 字段），随
   * WRITING_SCAN 顺路回来（同 imageStyle）。spec_lock_reference.md 原话：「生图是要
   * 花钱的，这是第一道闸（第二道在桌面端的自动触发上限）」——autoFireWritingGenImages
   * 取 `min(imageCount ?? 桌面默认上限, 桌面默认上限)`，契约值只能收紧、不能放宽桌面端
   * 自己的硬上限（契约来自 AI 写的文件，不可信，见 parseImageCount 顶注）。null 三种
   * 正常成因同 imageStyle。
   */
  imageCount: number | null
  sections: WritingSection[]
  /**
   * `drafts/` 里判为「不是节」、没计入正文的 .md 文件名（随 WRITING_SCAN 回来）。
   * 判据与事故背景见 electron/shared/writing.ts 的 selectSectionNames 顶注。
   * 纸面用它摆一行提示——命名判据必然有误伤面，静默少一节正文比多播一节更难被发现。
   */
  excludedFiles: string[]
  status: WritingStatus
  errMsg: string
  /**
   * 右栏「可以露面了」——**有实际内容可看**（或有错要说）之后才置真，右栏门控读它。
   *
   * 【为什么不是 source !== null 就开门（2026-07-31 改）】写作是长流水线：探测到文档源
   * （AI 建好项目目录、打出 WRITING_PROJECT= 标记）之后，四角色还要串行跑规划 / 写
   * spec_lock / 列大纲，往往几分钟才落下第一节正文。旧门控在这一刻就把右栏撑开，用户
   * 盯着一句「还没有正文」干等好几分钟——看起来像功能卡死，而不是「正在准备」。
   *
   * **粘滞（一旦为真就不再回落，直到 setSource 换源/清源）**：轮询读盘偶发失败会让
   * sections 短暂为空，非粘滞的话右栏会整个抖掉（用户正在读的稿子突然消失）。
   * `status` 为 error/missing 时也置真：那两种情况没有正文可看，但**有错要说**，
   * 右栏是唯一能说的地方——不开门就等于把错误咽掉，用户只看到右栏永远不出现。
   */
  revealed: boolean
  /** 已发出、正在等 AI 回复的那一条改写。非空 = 本轮回复要走哨兵抽取而非普通对话。 */
  pendingRevision: WritingRevisionTarget | null
  queue: QueuedWritingRevision[]
  review: WritingRevisionReview | null
  /** 一次性提示条（写盘冲突 / 排队项定位失败 / 队列满）。展示后由用户或下一次操作清掉。 */
  conflictMsg: string
  /**
   * 撤销栈。**AI 改写「应用」与手动编辑共用**——用户心里只有一个「后悔」的概念，
   * 不该因为这次改动来自哪条通道而行为不同。只在内存，不持久化（关窗即失）。
   */
  undoStack: WritingUndoEntry[]
  pushUndo: (entry: WritingUndoEntry) => void
  /** 弹出栈顶；空栈回 null。弹出即消费，撤销失败也不回填——不做重做。 */
  popUndo: () => WritingUndoEntry | null
  /**
   * genimage 指令块的生图任务态。键 = genImageDirectiveKey(节名, 指令块原文, 出现序)。
   * 三重职责与提案侧同源：① 幂等 seen 集合——键存在（无论何态）即不再自动发起，
   * 这是防重复烧钱的核心，写作靠轮询触发、每几秒跑一次，没有它就是每轮重复出图；
   * ② 驱动指令块卡片的多态渲染；③ manual 态是重开会话时预登记的哨兵。
   * 用【节名】而不是节 id 当键的一部分：写作的节就是磁盘文件，文件名即身份。
   */
  genImageJobs: Record<string, GenImageJob>
  /** 待用户裁决的出图审阅卡。切换项目时清空——未决提议不跨项目留存。 */
  imageReviews: ImageReview[]
  /** 切换文档源：清空旧内容，避免上一篇的正文闪现在新文档里。 */
  setSource: (source: WritingDocSource | null) => void
  /**
   * 只重绑归属会话，**不动正文**。用于「源没变、前台会话换了」——同一篇稿子在另一个会话里
   * 接着写时 setSource 不会触发（源字面相同），sessionId 会留成旧会话的，之后每次点改写都
   * 撞 sendWritingMessage 的一致性校验静默 no-op，表现为「点了没反应」。
   * 走这条而不是重调 setSource：后者会清空 sections，而轮询的 lastSignature 只在 source
   * 引用变化时才重置——源引用没变就不会补拉，纸面会一直空着。
   */
  bindSession: (sessionId: string | null) => void
  applyScan: (v: {
    genre: WritingGenre
    outlineTotal: number | null
    imageStyle: string | null
    imageCount: number | null
    excludedFiles: string[]
  }) => void
  setSections: (sections: WritingSection[]) => void
  setStatus: (status: WritingStatus, errMsg?: string) => void
  /** 出图任务态登记（pending/done/failed/manual）。fireWritingGenImage 与手动重试共用。 */
  setGenImageJob: (key: string, job: GenImageJob) => void
  /** 登记一张待审阅出图，返回生成的稳定 id（crypto.randomUUID()），供 Task 11 增删引用。 */
  addImageReview: (review: Omit<ImageReview, 'id'>) => string
  removeImageReview: (id: string) => void
  /**
   * 重开会话时的预登记：把【当下已存在】的 genimage 指令块全部登记成 manual 态哨兵，
   * 堵住「轮询把重开会话前就有的陈旧指令块当新块自动补发生图」的扣费泄漏
   * （与提案侧 restoreFromTranscript/restoreFromDisk 的 seedManualGenImageJobs 同一理由）。
   * 调用点见 useWritingPoll：只在本次轮询生命周期的【首次成功读取】时调用一次。
   */
  seedManualGenImageJobs: (sections: WritingSection[]) => void
  /** 应用改写后就地替换一节的正文与 mtime（写盘成功后调用，避免等下一轮轮询才刷新）。 */
  replaceSectionMarkdown: (name: string, markdown: string, mtimeMs: number) => void
  setPendingRevision: (t: WritingRevisionTarget | null) => void
  /** 入队；返回 false = 队列已满、这一条被拒（调用方据此提示用户，别静默丢）。 */
  pushQueue: (item: QueuedWritingRevision) => boolean
  shiftQueue: () => QueuedWritingRevision | null
  setReview: (r: WritingRevisionReview | null) => void
  setConflictMsg: (msg: string) => void
}

/**
 * 供 `setSource` 判定「这是不是真的换了项目」：记的是【最近一次非 null 的 source】的
 * key，不是「上一次调用 setSource 时的 source」。2026-08 审查 C-1：用户切走会话时
 * `source` 会先变成 null，若比较对象是「上一次调用的值」，切回来那次调用看到的
 * `get().source` 已经是 null，永远判定成「变了」——等于没有这条判据。必须单独存一份
 * 「最近一次真正处于活跃状态的项目是谁」，跨越 null 这个中间态存活。模块级变量（不进
 * store，UI 不需要读它）——与 `writingGenImageFire.ts` 里 `lastSectionSignature` /
 * `warnedProjects` 同一惯例。
 */
let lastNonNullSourceKey: string | null = null

/**
 * 「这个项目在本次挂载生命周期内是否已经 seed 过」——键与 `lastNonNullSourceKey`
 * 同源（`JSON.stringify(source)`）。**2026-08 审查 C-1'：从 `useWritingPoll` 内部
 * 的 `useRef` 挪到这里，变成模块级、且 `setSource` 够得着它**。
 *
 * 【为什么必须挪】C-1 修复只堵住了「切走（source→null）再切回同一项目」这一条路：
 * 那条路上 `isGenuinelyNewProject` 判定为假，`genImageJobs` 不清，本来就不需要
 * 重新 seed。但「A → 切到另一个写作项目 B → 切回 A」是**另一条路**——A→B 与 B→A
 * 都满足「新 source 与上一个非 null source 不同」，两次都会清表（这是对的，否则
 * B 的 job 键留在表里、键的第一段是节名，两份稿子撞同名节时会把 B 的记录误认成
 * A 的，反而「该出图却不出图」）。旧版 `seededProjects` 是组件 ref，`setSource`
 * 物理上碰不到它——于是 B→A 清表时没人同步撤销 A 的「已 seed」标记，A 的 job 表
 * 空了但 `useWritingPoll` 因为「A 已经 seed 过」而跳过补种，两轮稳定判据之后全篇
 * 指令块被当新指令重新发起（与 C-1 同一机制，只是中间态从 null 换成了另一个项目）。
 *
 * 挪成模块级之后，`setSource` 每次清表（`isGenuinelyNewProject` 为真）时可以
 * 顺手把【即将进入的】那个 source 的 key 从这个 Set 里删掉——见下面 `setSource`
 * 实现。这样任何一次清表都会同步撤销对应的 seed 标记，`useWritingPoll` 下一次
 * 成功读取时会看到「这个项目没 seed 过」、重新补种（把当下已存在的指令块登记回
 * manual），而不是把它们当新指令自动重发。
 *
 * 不朝「job 表按 source key 分槽」方向改（每个项目各自一份 `genImageJobs`）：那是
 * 结构性改造，爆炸半径大，此处只需要「清表的同时补种」这一条不变量就够，分槽方案
 * 留档以后真有需要再做。这也意味着**来回切换项目时，非当前项目的审阅卡/任务态
 * 无法跨项目共存**——切到 B 时 A 的 5 张「已完成」审阅卡确实会被清空（这是清表的
 * 直接后果，不是本次修复要解决的问题），但重新补种保证了它不会引发「重新生成、
 * 重复扣费」，指令块只是退回「点此手动生成」的哨兵态。
 */
const seededProjects = new Set<string>()

/**
 * 供 `useWritingPoll` 在首次成功读取时判定「要不要 seed」，并把判定结果登记回去
 * （查询与登记合并成一次调用，调用方不用自己管 Set 的读写）。返回 `true` = 这个
 * 项目本次挂载期间还没 seed 过，调用方现在就该做；`false` = 已经 seed 过，跳过。
 *
 * 导出成独立函数（而不是把 `seededProjects` 整个 Set 露出去）是为了让 C-1' 的
 * 判定逻辑可以脱离 `useWritingPoll`（一个 React hook，本仓库的测试目录不含
 * `src/chat/stores`，没法直接渲染它）被单独测试——`writingGenImageFire.test.ts`
 * 直接调用这个函数配合 `setSource` 验证「A → 切到 B → 切回 A」之后这个函数
 * 会不会正确地重新返回 `true`，不需要渲染整个 hook。
 *
 * 【2026-08 审查第五轮 n-3：改名 shouldSeedProject → claimSeedSlot】旧名字读起来
 * 像一次无副作用的纯查询（「我该不该 seed？」），但函数体第二行就 `seededProjects.add(key)`
 * ——同一个 key 在同一次 tick 里调用第二次就会返回 false。目前只有 `useWritingPoll`
 * 这一个调用点，副作用不会被意外触发第二次，暂时无害；但名字本身会骗后来者以为可以
 * 安全地多次调用（比如日志/调试代码里顺手加一次探测调用）。改成 `claimSeedSlot`——
 * 「claim」（占用/领取）这个动词本身就暗示了「调一次就把名额领走了，别人/下一次调用
 * 拿不到」，与 `seededProjects.add` 的真实语义对齐。
 */
export function claimSeedSlot(source: WritingDocSource): boolean {
  const key = JSON.stringify(source)
  if (seededProjects.has(key)) return false
  seededProjects.add(key)
  return true
}

/**
 * 【2026-08 审查第五轮 n-2】测试专用重置：清空 `seededProjects`。
 *
 * 这张表是模块级 Set，生命周期是整个渲染进程（生产代码里合理——见顶注，`setSource`
 * 在真的换项目时会同步删除对应 key，不需要「整表清零」这种操作）。但测试文件里没有
 * 任何入口能清它：`writingGenImageFire.test.ts` 的 `beforeEach` 只重置了
 * `useWritingStore` 与 `lastSectionSignature`/`warnedProjects`（经
 * `resetWritingGenImageAutoFireState`），唯独漏了这张表——之所以现在还是绿的，
 * 纯粹是因为全文件只有一条用例（C-1' 回归）调用 `claimSeedSlot`，且那条用例内部
 * 自己完成了一次「A→B→A」的完整往返、把 A 的 key 显式清干净，没有把「已 seed」
 * 状态泄漏给下一条用例。这是**用例执行顺序与调用次数的巧合**，不是设计保证——
 * 谁再加一条调用 `claimSeedSlot` 的用例（比如 M-1 的回归测试就需要，见
 * `writingGenImageFire.test.ts`），跑在 C-1' 用例前后都可能因为共享的模块级状态
 * 而假绿/假红。给它配一个同类 reset，在 `beforeEach` 里调用，与
 * `resetWritingGenImageAutoFireState` 同一套惯例（该函数的顶注也点了这个先例）。
 */
export function resetSeededProjectsState(): void {
  seededProjects.clear()
}

export const useWritingStore = create<WritingState>((set, get) => ({
  source: null,
  sessionId: null,
  genre: 'workplace',
  outlineTotal: null,
  imageStyle: null,
  imageCount: null,
  sections: [],
  excludedFiles: [],
  status: 'idle',
  errMsg: '',
  revealed: false,
  pendingRevision: null,
  queue: [],
  review: null,
  conflictMsg: '',
  undoStack: [],
  genImageJobs: {},
  imageReviews: [],
  setSource: (source) => {
    // 2026-08 审查 C-1：genImageJobs / imageReviews 的清空条件必须比「每次 setSource
    // 都清」更窄，只在【真的换了项目/文件】时才清——不是「切走」（source 变 null），也
    // 不是「切回同一个项目」。
    //
    // 【为什么旧版「每次都清」是个 Critical】旧注释的理由是「旧文档的节名对新文档没有
    // 意义」，但那只在【真的换了项目】时成立。切到别的会话看一眼再切回来，必然连续
    // 触发两次 setSource（切走 source→null，切回 source→A），旧实现把这两次都当「换
    // 文档」处理，5 张已经生成完、正等用户裁决的审阅卡连同 job 表一起被清空；随后
    // seededProjects（下方模块级 Set）因为「这个项目本次挂载期间已经 seed 过」而跳过
    // 补种 manual 哨兵——表空了却没人补——两轮轮询之后，稳定判据把全篇指令块当成
    // 「从没见过的新指令」重新发起，5 张图重复生成、重复扣费。且 MAX_AUTO_FIRE_PER_WRITING_PROJECT
    // 的配额是从 genImageJobs 表长度算的，表被清空 = 预算一起清零，切 N 次就是 5N 张图，
    // 没有任何累计上限——触发动作只是「切个会话看一眼」这种一天几十次的日常操作。
    //
    // 判定用 lastNonNullSourceKey（见其顶注）而不是 get().source：本次调用时 store 里
    // 的 source 可能已经是 null（切走那一步已经把它置空），要比较的是「离开前那个真正
    // 活跃的项目」，不是「上一次调用传了什么」。
    const incomingKey = source ? JSON.stringify(source) : null
    const isGenuinelyNewProject = incomingKey !== null && incomingKey !== lastNonNullSourceKey
    if (incomingKey !== null) lastNonNullSourceKey = incomingKey
    // 2026-08 审查 C-1'：清表的同时必须撤销这个项目的「已 seed」标记，否则重新进入
    // 时 useWritingPoll 会因为「以为已经 seed 过」而跳过补种——job 表空了却没人
    // 登记 manual 哨兵，两轮之后全篇指令块被当新指令重新发起。见 seededProjects
    // 顶注。
    if (isGenuinelyNewProject && incomingKey !== null) seededProjects.delete(incomingKey)

    set({
      source,
      // 会话 id 与文档源同生同灭：源是从【当前会话】的消息树推导出来的，故此刻的前台会话
      // 就是这篇稿子的归属会话。切源 = 换了篇稿子（多半也换了会话），一并刷新。
      sessionId: source ? useChatStore.getState().sessionId : null,
      sections: [],
      excludedFiles: [],
      outlineTotal: null,
      imageStyle: null,
      imageCount: null,
      status: 'idle',
      errMsg: '',
      // 换源 = 换了篇稿子，右栏重新回到「等第一节正文」的关门状态；不清的话切到一篇
      // 刚起步的新稿子时，右栏会带着上一篇的 revealed 直接撑开一片空白。这一批字段
      // （sections/outlineTotal/imageStyle/imageCount/status/errMsg/revealed）不受
      // isGenuinelyNewProject 保护、依旧每次 setSource 都清——它们几秒内会被下一轮
      // 轮询重新填满（同一个项目会填回一模一样的值），代价只是一次短暂的「重新加载」
      // 观感，不是数据丢失，与 genImageJobs/imageReviews 那种不可逆的丢失不是一回事。
      revealed: false,
      // 改写态一律跟着源清空：pending/queue/review 里的 sectionName 只对旧文档有意义，
      // 留到新文档上会往错的文件里写内容——这类「跨文档串台」是不可逆的正文损坏。
      pendingRevision: null,
      queue: [],
      review: null,
      conflictMsg: '',
      // 换源 = 换了篇稿子，旧稿的 sectionName 对新稿没有意义。留着它撤销会把上一篇的
      // 内容写进这一篇的同名文件——这类跨文档串台是不可逆的正文损坏，与上面 pending/queue
      // 必须跟着清空是同一个理由。
      undoStack: [],
      // genImageJobs 的键 = 节名（磁盘文件名）+ 内容哈希，imageReviews 挂 sectionId = 节名
      // ——只有【真的换了项目】时旧文档的这些键才对新文档没有意义；切回同一个项目时，
      // 键对当前这份文档依然精确有效，清空只会造成上面 C-1 描述的重复发起，且会把用户
      // 还没裁决的审阅卡凭空清没（用户会觉得「我的审阅卡怎么不见了」）。
      ...(isGenuinelyNewProject ? { genImageJobs: {}, imageReviews: [] } : {})
    })
  },
  bindSession: (sessionId) => {
    if (get().sessionId === sessionId) return
    // 换了归属会话就清改写态：旧会话的 pending 不该由新会话的轮末来兑现（那会把别的
    // 对话的回复当成这条改写的结果推给用户确认）。
    set({ sessionId, pendingRevision: null, queue: [], review: null, conflictMsg: '' })
  },
  applyScan: ({ genre, outlineTotal, imageStyle, imageCount, excludedFiles }) =>
    set({ genre, outlineTotal, imageStyle, imageCount, excludedFiles }),
  // 判据是「有非空正文」而不是 sections.length > 0：AI 有可能先把一节的空文件建出来
  // （占位、或写到一半被打断），文件在但一个字没有——那时开门看到的还是空白纸面。
  setSections: (sections) =>
    set((s) => ({
      sections,
      revealed: s.revealed || sections.some((sec) => sec.markdown.trim() !== '')
    })),
  // error/missing 也开门：见 revealed 字段注释——没有正文但有错要说，右栏是唯一的出口。
  setStatus: (status, errMsg = '') =>
    set((s) => ({
      status,
      errMsg,
      revealed: s.revealed || status === 'error' || status === 'missing'
    })),
  replaceSectionMarkdown: (name, markdown, mtimeMs) =>
    set((s) => ({
      sections: s.sections.map((sec) => (sec.name === name ? { ...sec, markdown, mtimeMs } : sec))
    })),
  setPendingRevision: (pendingRevision) => set({ pendingRevision }),
  pushQueue: (item) => {
    if (get().queue.length >= MAX_WRITING_REVISION_QUEUE) return false
    set((s) => ({ queue: [...s.queue, item] }))
    return true
  },
  shiftQueue: () => {
    const head = get().queue[0] ?? null
    if (head) set((s) => ({ queue: s.queue.slice(1) }))
    return head
  },
  setReview: (review) => set({ review }),
  setConflictMsg: (conflictMsg) => set({ conflictMsg }),
  pushUndo: (entry) => set((s) => ({ undoStack: pushBounded(s.undoStack, entry, MAX_WRITING_UNDO) })),
  popUndo: () => {
    const stack = get().undoStack
    if (stack.length === 0) return null
    const top = stack[stack.length - 1]
    set({ undoStack: stack.slice(0, -1) })
    return top
  },
  setGenImageJob: (key, job) =>
    set((s) => ({ genImageJobs: { ...s.genImageJobs, [key]: job } })),
  addImageReview: (review) => {
    const id = crypto.randomUUID()
    set((s) => ({ imageReviews: [...s.imageReviews, { ...review, id }] }))
    return id
  },
  removeImageReview: (id) =>
    set((s) => ({ imageReviews: s.imageReviews.filter((r) => r.id !== id) })),
  seedManualGenImageJobs: (sections) =>
    set((s) => {
      const jobs = { ...s.genImageJobs }
      for (const sec of sections) {
        for (const d of parseGenImageDirectives(sec.markdown)) {
          const key = genImageDirectiveKey(sec.name, d.raw, d.occurrence)
          // ??= 而不是无条件覆写（2026-08 审查 I-1 修复）：这张表在调用时可能已经有该键的
          // 真实记录（pending 正在发起中 / done 已经生成完成），无条件覆写会把它们打回
          // manual——卡片从「生成中/已完成」倒退回「点此生成」，用户再点一次就是对同一张图
          // 付两次钱（这次是用户手点的，但界面骗了他）。只在键还不存在时才登记哨兵。
          jobs[key] ??= { status: 'manual' }
        }
      }
      return { genImageJobs: jobs }
    })
}))

/**
 * 从一条消息的 content 里摘出 tool-call 摘要，喂给 writingDocSource.ts 的纯函数判定用。
 * `useWritingSource`（扫全部历史消息）与 `useWritingInProgress`（只扫最后一条）共用同一套
 * 摘取逻辑，避免两处各写一份、字段映射漂移。
 */
function toolPartsOf(content: unknown): WritingToolPart[] {
  if (!Array.isArray(content)) return []
  const parts: WritingToolPart[] = []
  for (const p of content as {
    type: string
    toolName?: string
    args?: Record<string, unknown>
    result?: unknown
  }[]) {
    if (p.type !== 'tool-call' || !p.toolName) continue
    const args = p.args ?? {}
    // **只有 Bash 才算 commandText / resultText**。两个理由，都别退回去：
    //  1) 语义：判定只从 Bash 的命令文本与 stdout 里找 WRITING_PROJECT= 标记
    //     （detectWritingSource 对非 Bash 的 part 压根不看这两个字段），非 Bash 算了也白算。
    //  2) 性能：这个函数被 useWritingSource 用，而 useWritingSource 订阅整个 chat store
    //     ——流式期间**每个 delta** 都会把会话全部历史消息重扫一遍。无条件把每条
    //     Read/Write/Grep 的结果（可能是几十 KB 正文）都转成文本，等于在最热的路径上
    //     反复做与判定无关的字符串搬运。它抄的模板 usePreviewServer（chat.ts）第一步
    //     就是 `if (p.toolName !== 'Bash') continue`，恰恰避开了这个坑。
    const isBash = p.toolName === 'Bash'
    parts.push({
      toolName: p.toolName,
      commandText: isBash && typeof args.command === 'string' ? args.command : '',
      // 不用 JSON.stringify 兜底：数组形态的 tool result 被 JSON 化后真实换行变成 `\`+`n`
      // 两个字符，PROJECT_LINE 的 `[^\r\n]+` 不认，会一路吞到 JSON 末尾抓出带尾巴的假路径
      // （静默表现为右栏永远「写作项目目录已不存在」）。完整推演见 toolResultText 头注释。
      resultText: isBash ? toolResultText(p.result) : '',
      filePath: pickFilePath(args)
    })
  }
  return parts
}

/**
 * 从当前会话的消息树推导文档源。订阅 messages 会随流式每 delta 重算，故用 useShallow +
 * 把重活关在纯函数里（detectWritingSource 只扫 tool-call、不碰正文文本）。
 */
export function useWritingSource(): WritingDocSource | null {
  return useChatStore(
    useShallow((s): WritingDocSource | null => {
      const parts: WritingToolPart[] = []
      for (const m of s.messages) parts.push(...toolPartsOf(m.content))
      return detectWritingSource(parts)
    })
  )
}

/**
 * 写作右栏**此刻是否占着屏幕**。「探测到了文档源」还不够，得 `revealed`（有正文可看
 * 或有错要说）——见 revealed 字段注释。
 *
 * 判据必须与 ThreadView 的 isWritingMode 半边**逐字同源**：filePreview.ts 的
 * useSplitWorkspaceBusy / splitWorkspaceBusyNow 拿它决定表格卡片点击要不要降级回系统
 * 应用打开，两边脱节的后果（点击死 + 脏 path 事后弹旧预览）在那两个函数的注释里有完整推演。
 */
export function useWritingWorkspace(): boolean {
  return useWritingStore((s) => s.source !== null && s.revealed)
}

/**
 * 写作右栏的总闸 **兼数据泵**——ThreadView 调用它，返回「现在该不该渲染右栏」。
 *
 * 【为什么推导 / 绑会话 / 轮询这三件事必须住在这里，而不是面板里（2026-07-31 重构）】
 * 门控一旦收紧成「有正文才开门」，就出现了一个自锁环：正文由轮询拉取 → 轮询原先跑在
 * WritingDocPanel 内部 → 面板要门开了才挂载 → 门要有正文才开 → 永远没有正文。
 * 旧代码靠「消息推导 || store 已开」这个或把门先撞开来绕过它（推导与面板挂载无关），
 * 但那正是「一探测到就撑开右栏」的根源，与本次要修的体验问题是同一件事。
 * 所以把泵移到门外：**推导与轮询无条件先跑（右栏关着也在拉）**，门只管「拉到东西没有」。
 *
 * 这样 WritingDocPanel 退化成纯展示组件（只读 store、不再自己灌数据），
 * ThreadView 是唯一的调用点——**别在别处再调一次**，那会变成两个泵同时轮询同一个目录。
 */
export function useWritingWorkspaceGate(): boolean {
  // 从前台会话消息树推导，与右栏挂载与否无关——这是整条链的源头。
  const derived = useWritingSource()
  const storeSource = useWritingStore((s) => s.source)
  const setSource = useWritingStore((s) => s.setSource)
  const bindSession = useWritingStore((s) => s.bindSession)
  const chatSessionId = useChatStore((s) => s.sessionId)

  // 【必须在 effect 里 setState】渲染期直接 set 会触发 React 的 "Cannot update a component
  // while rendering a different component"，StrictMode 下还会重复执行。用序列化字符串当依赖，
  // 避免推导出的对象每帧新引用导致死循环。
  const derivedKey = derived ? JSON.stringify(derived) : ''
  const storeKey = storeSource ? JSON.stringify(storeSource) : ''
  useEffect(() => {
    if (derivedKey !== storeKey) setSource(derived)
  }, [derivedKey, storeKey, derived, setSource])

  // 归属会话补同步：「切到另一个写同一篇稿子的会话」时源字面没变、上面那条 effect 不触发，
  // sessionId 会留成旧的，之后每次点改写都撞一致性校验静默 no-op（表现为「点了没反应」）。
  useEffect(() => {
    if (derived) bindSession(chatSessionId)
  }, [derived, chatSessionId, bindSession])

  useWritingPoll(storeSource !== null)

  return useWritingWorkspace()
}

/**
 * 这一轮 AI 是不是正在往当前文档源里落字（供纸面底部的进度骨架用）。
 *
 * **只扫最后一条消息**，不是全部历史——每条 assistant 消息对应一轮（同 messageId 的增量
 * 都合并进同一条，见 chat.ts 的 appendAssistantDelta），故「最后一条」= 当前/刚结束的这一轮。
 * 全文写完后用户另起一轮提问，会话级 `streaming` 依然会在这轮变真，但这轮的 parts 里没有
 * 写 drafts/ 的文件调用，isWritingInProgress 判定为 false——骨架不会再误挂着「正在写第 N 节」。
 *
 * `streaming` 与 parts 一起喂给判定函数，缺了它「本轮已结束但还没有下一轮」这个静止态会
 * 恒判为真（那条带 Write 调用的 assistant 消息一直躺在尾部）——见 isWritingInProgress 头注释。
 * 两者都取 chat store 的**顶层镜像**（前台会话，见 chat.ts 的 mirrorFromSlot），天然同源；
 * 不要把其中一个换成 `perSession[某 sid]` 读法，那会变成拿 A 会话的忙闲去判 B 会话的消息。
 */
export function useWritingInProgress(): boolean {
  const source = useWritingStore((s) => s.source)
  return useChatStore((s) => {
    const last = s.messages[s.messages.length - 1] as { role?: string; content?: unknown } | undefined
    if (!last || last.role !== 'assistant') return false
    return isWritingInProgress(toolPartsOf(last.content), source, s.streaming)
  })
}

/**
 * 轮询副作用。只在 `active`（面板挂载且当前会话是写作会话）时跑。
 *
 * 三个必须守住的点：
 *  1) **只在内容变了才拉正文**。scan 回的是文件名+内容哈希（sha1，见 `WritingFileMeta.contentHash`
 *     顶注）+size，与上一轮签名一致就什么都不做——否则每 2s 把万字正文搬一遍，长篇会明显卡。
 *     签名用内容哈希而不是 mtime：这里历史上用过纳秒精度的 `mtimeNs`，论断是「纳秒精度下
 *     『等长改写 + 同一纳秒写入』不可能同时成立」——**这个论断在 Windows 上被证伪**：CI 的
 *     Windows 腿上两次真实写入拿到完全相同的 mtimeNs（时间源粒度远粗于纳秒），等长改写
 *     （中文里「的→地」「，→、」这类单字符替换很常见）会让三要素全部不变、判定「未变化」
 *     而漏刷——静默失效、界面停在旧内容且不报错，那个被认为堵死的洞原样存在。改用内容
 *     哈希后不存在这个问题：只要内容有哪怕一个字符不同，哈希必然不同，且与「文件被 touch
 *     但内容没变」这类假阳性无关（mtime 变但哈希不变，签名也不变，不会触发无谓重读）。
 *     当初否决内容哈希的理由（「每轮要读全部文件内容，清空『scan 只回元信息』的设计意义」）
 *     已被实测证伪：40 节 / 820KB / 28 万字规模下，本机实测纯 stat 每轮约 0.06ms，
 *     stat+读全文+sha1 每轮约 0.76ms，差值约 0.7ms，占 2000ms 轮询间隔约 0.035%，
 *     可忽略不计，且文件必然在系统页缓存里（2s 轮询一次，不存在冷读）。
 *
 *     **签名不再拼 mtime**（既不用 mtimeMs 也没有 mtimeNs 字段了）：内容哈希已经是「内容
 *     变没变」的充分必要判据，mtime 能带来的唯一额外信号是「文件被 touch 但内容没变」，
 *     那种情况下哈希不变、拼不拼 mtime 都不该触发重读——拼上只会在这类场景徒增一次无谓的
 *     `writingReadSections` 往返，没有对应的正确性收益，所以干脆不拼。
 *  2) **cancelled 闸门**。一轮里有两次 await，期间面板可能卸载/`active` 变 false/文档源切换；
 *     晚到的响应必须丢弃，不能覆盖新文档的内容（proposal 预览的 objectURL 竞态是同一类问题）。
 *  3) **世代号（generation）闸门**。`cancelled` 只在 effect 卸载/依赖变化时才置真，同一个
 *     `active` 窗口内先后触发的两次 `tick()` 之间光靠 `cancelled` 挡不住——轮询间隔固定 2s，
 *     但单次扫描耗时不固定（网络共享盘、大项目，`writingDocSource.ts` 明确要支持 UNC 路径
 *     不是假设场景），如果某次 `tick()` 耗时超过 2s、与下一次定时触发的 `tick()` 重叠，
 *     可能后完成的是较早发出的那次（「后发先至」），会用旧数据反写 `lastSignature.current`
 *     和 `sections`，把已经刷新的内容「倒退」回旧版本。故每次 `tick()` 进入时领一个自增票号，
 *     每次 await 之后都要确认「我这一号是不是仍是最新」，不是就丢弃、不写 store 也不写
 *     `lastSignature`——两轮都属于同一个 effect 生命周期，只能靠世代号而非 cancelled 分辨新旧。
 */
export function useWritingPoll(active: boolean): void {
  const source = useWritingStore((s) => s.source)
  const lastSignature = useRef<string | null>(null)
  // seed 机制本身（「这个项目在本次挂载期间是否已经 seed 过」）的完整设计理由、
  // 以及它为什么现在是模块级而不是这里的 useRef，见 `seededProjects` 顶注
  // （2026-08 审查 I-1 → C-1 → C-1' 三轮演进都记在那里，不在这里重复）。

  useEffect(() => {
    if (!active || !source) return
    lastSignature.current = null
    // 稳定判据（lastSectionSignature）与配额告警去重都要在此清零。
    //
    // 【2026-08 审查 C-1 追问：genImageJobs 已经不再清空了，这里还要不要清？—— 依然要清，
    // 但理由变了】C-1 修复后，已经登记过的 job 键（pending/done/failed/manual）在「切走
    // 再切回」时不会丢，它们的幂等判定（守卫③）不依赖这张签名表，清不清都不影响它们的
    // 正确性——真正受影响的只是【本次挂载期间从未见过、也还没登记 job 键的全新指令块】。
    // 对这批全新内容而言，清零只是让「连续两轮不变才发起」的计数从头重来一遍，最坏后果是
    // 多等一轮（~2s）才发起，不是错误发起——这张表本来就不承诺「正确性」（那是 genImageJobs
    // 的职责），只承诺「多一层保守的节流」。反过来，如果不清零，「切走时内容恰好没有变化」
    // 的全新指令块会在恢复轮询的第一轮就被判定「和记忆里的签名一样、已经稳定」而立即发起
    // ——虽然这在逻辑上其实是安全的（内容全程没变=确定不是半截块），但为了让「连续两轮」
    // 这个不变量的措辞始终成立、不必逐案例论证「这次例外为什么安全」，仍选择无条件清零，
    // 用一次可忽略的额外延迟换取判据本身简单、好推理。
    resetWritingGenImageAutoFireState()
    let cancelled = false
    let generation = 0

    async function tick(): Promise<void> {
      if (!source) return
      const myGeneration = ++generation
      const scan = await window.chatApi.writingScan({ source })
      if (cancelled || myGeneration !== generation) return
      const st = useWritingStore.getState()
      if (!scan.ok) {
        st.setStatus(scan.dirMissing ? 'missing' : 'error', scan.error)
        return
      }
      // 【为什么要对一个类型上「必填」的字段做运行时兜底】dev 下 main 与 renderer 是两个
      // **独立重载**的进程：改 renderer 走 Next 热更新、秒级生效；改 main 要等 electron-vite
      // 重启主进程。于是每次给 IPC 结果加新字段，都必然有一段「新 renderer 拿着旧 main 的
      // 返回体」的窗口期——`excluded` 刚加那次就当场炸了（`scan.excluded.map` → Cannot read
      // properties of undefined，2026-08-04）。类型系统在这个窗口期帮不上任何忙：它描述的是
      // 源码里的约定，不是运行中那个进程的实际版本。**跨进程边界收到的东西一律当外部输入**，
      // 与 preload 那侧对 payload 的态度一致。
      const excluded = Array.isArray(scan.excluded) ? scan.excluded : []
      st.applyScan({
        genre: scan.genre,
        outlineTotal: scan.outlineTotal,
        imageStyle: scan.imageStyle,
        imageCount: scan.imageCount,
        excludedFiles: excluded
      })
      // 签名要带上 excluded：被排除的文件不进正文，但它的出现/消失要能让提示条跟着变。
      // 只用 files 的话，写手刚把 full.md 放进 drafts/ 或用户刚把它删掉，签名都纹丝不动
      // ——纸面提示会一直停在上一轮的状态，直到某一节正文恰好也变了才顺带刷新。
      // 只记名字不记 mtime/size：排除文件的内容改了与正文无关，不值得为它触发一次重读。
      const signature = [
        ...scan.files.map((f) => `${f.name}:${f.contentHash}:${f.size}`),
        ...excluded.map((n) => `x:${n}`)
      ].join('|')
      // 出图触发器与轮询同拍：磁盘元信息没变 = 正文真没变（含指令块），沿用 store 里已有的
      // sections 就能安全跑一次自动发起的稳定判据比对，不必等下一次真正的重读——两条分支都要
      // 调用 autoFireWritingGenImages，否则「AI 写完不再改」这一刻永远等不到第二轮确认。
      //
      // 【2026-08 复审 I-2：别在别处再加一次调用】P1b task 5 曾经在 FusionRuntimeProvider 的
      // onTurnEnd 里额外调过一次 autoFireWritingGenImages()，已经删掉——那次调用夹在两次真实
      // 磁盘重读之间，中间没有任何重新读盘，稳定判据「与上一次观察到的内容哈希相同」的比较对象
      // 还是这里刚记的签名，于是必然判定「连续两轮不变」而立即对可能只写了一半的陈旧内容发起，
      // 且下一轮真实轮询读到最终内容后旧 key 被孤儿清理、又会把它当成没见过的新指令重新发起
      // ——同一张配图付两次钱，且第一张图的审阅卡因 directiveRaw 对不上任何块而永远渲染不出来。
      // 这两处轮询分支已经覆盖「正文变了」与「正文没变」全部情形，不需要、也不应该再加调用点。
      if (signature === lastSignature.current) {
        st.setStatus('ready')
        autoFireWritingGenImages()
        return
      }
      const read = await window.chatApi.writingReadSections({ source, names: [] })
      if (cancelled || myGeneration !== generation) return
      if (!read.ok) {
        useWritingStore.getState().setStatus('error', read.error)
        return
      }
      lastSignature.current = signature
      // 见 seededProjects / claimSeedSlot 顶注：只在「这个项目本次挂载期间还没
      // seed 过」时才登记 manual 哨兵。
      //
      // 【2026-08 终审 #2】`claimSeedSlot` 不能无条件在这里领走名额——`read.sections`
      // 可能是这一轮读盘瞬时失败（`readdirSync(drafts)` 抛错）静默兜底出的空数组，
      // 与「项目本来就没有文件」在这里长得一模一样（都是 `read.ok === true` 且
      // `sections === []`）。若不加区分地领走名额，名额在这一轮被空耗（seed 到的是
      // 空集合），往后 sections 恢复正常时 `claimSeedSlot` 已经返回过一次 `false`，
      // 没人再补种 manual 哨兵——已有的指令块被稳定判据当成「从没见过的新指令」，
      // 两轮之后整篇重新发起、重复扣费（cap 张以内）。判据与理由见
      // `isReadSuspiciouslyEmpty` 的完整注释；`scan.files.length` 取自本轮 tick()
      // 前面那次 scan 调用的结果，与 `read.sections` 是两次独立观察，用它们之间的
      // 不一致做判据，不是只看 `read.sections.length` 的绝对值。
      if (!isReadSuspiciouslyEmpty(scan.files.length, read.sections.length) && claimSeedSlot(source)) {
        useWritingStore.getState().seedManualGenImageJobs(read.sections)
      }
      useWritingStore.getState().setSections(read.sections)
      useWritingStore.getState().setStatus('ready')
      autoFireWritingGenImages()
    }

    /**
     * 单轮失败不许打挂整条轮询。
     *
     * 【为什么必须包这一层】`tick` 是 async，里面任何一处抛出都会变成一条 unhandled
     * rejection，而**抛出点之后的 `setSections` / `setStatus` 全部执行不到**；下一轮
     * setInterval 照常进来、在同一个地方再挂一次。表现是纸面永远停在旧内容、状态卡在上一次
     * 成功值，界面上没有任何提示——比直接报错难查得多。上面 `excluded` 那条兜底修的是
     * 「这一次为什么抛」，这一层修的是「抛了之后为什么会全线冻结」，两件事分开修。
     *
     * **吞掉但留 console.error**：静默吞异常会让下一个同类 bug 彻底隐形，这里只保证轮询
     * 活着，不保证问题被隐藏。
     */
    function safeTick(): void {
      void tick().catch((err: unknown) => {
        console.error('[writing-poll] 本轮轮询失败，下一轮继续', err)
      })
    }

    safeTick()
    const timer = window.setInterval(safeTick, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, source])
}
