import { create } from 'zustand'
import type { ThreadSummary } from '@desktop-shared/types'

/** 两个 ThreadSummary 的**行显示相关**字段是否全等（驱动 RailSessionList
 * 行渲染的字段全集：标题 / 时间 / 首条提示 / 工作区标签路径）。用于 reload
 * 的引用复用——字段一致就沿用旧对象引用，让 SessionRow 的 memo 命中。 */
function sameThread(a: ThreadSummary, b: ThreadSummary): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.updatedAt === b.updatedAt &&
    a.firstPrompt === b.firstPrompt &&
    a.workspaceLabel === b.workspaceLabel &&
    a.workspacePath === b.workspacePath
  )
}

/**
 * 用新拉取的列表 `next` 校正旧列表 `prev`，最大化**引用复用**：
 *  - 逐位置比对，字段全等的元素**沿用 prev 的旧对象引用**（让下游 memo 行
 *    命中，不重渲那一行）；
 *  - 若最终每个元素都复用、且长度一致，**整个数组也沿用 prev 引用**——这样
 *    「磁盘数据没变的 reload」（fan-out 多条重复到达 / AI 回复中的
 *    sessionListChanged 高频触发）完全不换 threads 引用，RailSessionList
 *    连一次重渲都不会发生。
 *  - 任一元素变了则返回新数组，但未变的元素仍复用旧引用，只有真变的行重渲。
 * 复杂度 O(n)，用 id→旧对象的 Map 做跨位置匹配（排序/插入删除后位置会错位）。
 */
function reconcileThreads(
  prev: readonly ThreadSummary[],
  next: readonly ThreadSummary[]
): readonly ThreadSummary[] {
  const prevById = new Map(prev.map((t) => [t.id, t]))
  let allReused = next.length === prev.length
  const merged = next.map((n, i) => {
    const old = prevById.get(n.id)
    if (old && sameThread(old, n)) {
      // 字段没变：沿用旧引用。位置也没变时才可能整体复用。
      if (allReused && prev[i] !== old) allReused = false
      return old
    }
    allReused = false
    return n
  })
  return allReused ? prev : merged
}

/**
 * Rail 会话列表 store —— RailSessionList 的数据缓存层。
 *
 * 为什么是 store 而不是组件本地 state：RailSessionList 挂在 AppRail 的
 * `pathname.startsWith('/chat')` 三元里，chat ↔ 工作画布切面时被**整块
 * 卸载**。threads/loaded 若是组件 useState，每次切回都归零 → 骨架屏一拍
 * + 重新等 listShellSessions IPC（2026-07-08 用户反馈「每次切换页面都会
 * loading」）。与 2026-07-05「rail 选中态卸载丢失」同根：熬不过卸载的
 * 数据必须住进模块级 store。
 *
 * 语义是 stale-while-revalidate：重挂载首帧直接渲染缓存 threads（loaded
 * 一旦 true 跨挂载持久，不再回骨架屏），挂载 effect 照旧触发 reload——
 * 切面期间错过的列表变化（事件订阅已随卸载解除）由这次拉取补齐，数据
 * 到位后无感替换。骨架屏只在应用启动后的**第一次**拉取期间出现。
 *
 * SSR 安全：模块求值期不碰 window（与 unread.ts 同纪律，RailSessionList
 * 所在 layout 会被 SSR）；reload 运行时才探 window.tabApi。
 */
interface RailSessionsState {
  /** 会话列表（按 updatedAt 降序，reload 时排好）。 */
  threads: readonly ThreadSummary[]
  /**
   * 首次 listShellSessions 是否已返回（成功或失败都算）。没有它就分不清
   * 「IPC 还在路上」和「真的没有会话」——两者都是 threads=[]，而前者直接
   * 渲染空白会让 rail 看起来像坏了（2026-07-07 用户反馈），要给骨架屏。
   */
  loaded: boolean
  /** 从 main 拉全量列表。幂等，重复调用无害（多条刷新事件共用）。 */
  reload: () => void
  /** 乐观改标题：行文字立即更新，随后的 sessionListChanged / reload 校正。 */
  applyRename: (sessionId: string, title: string) => void
  /** 乐观新生：发送首条消息即插行（磁盘落盘前的空窗期由 optimisticBirths
   * 保护，权威数据出现后自动接管）。幂等——同 id 重复调用只更新占位内容。 */
  applyBirth: (thread: ThreadSummary) => void
  /** 乐观移除：驱动行折叠退场动画，并把 id 记进「删除中」墓碑集屏蔽复活
   * （见下方 tombstones 注释）。删除 IPC 完成后必须调 confirmRemove（成功）
   * 或 cancelRemove（失败）解除墓碑，否则该 id 永远无法再出现在列表里。 */
  applyRemove: (sessionId: string) => void
  /** 删除 IPC **成功**：解除墓碑。此刻磁盘已删，后续 reload 自然不含它，
   * 无需再动 threads（乐观移除早已把行折叠掉）。 */
  confirmRemove: (sessionId: string) => void
  /** 删除 IPC **失败**：解除墓碑 + reload，把乐观移除掉的行从磁盘拉回来。 */
  cancelRemove: (sessionId: string) => void
}

/**
 * 「删除中」墓碑集（模块级，不进 zustand state——它只是 reload 结果的过滤
 * 器，本身不驱动渲染）。
 *
 * 为什么需要（2026-07-16 事故）：applyRemove 是纯客户端乐观移除，而删除
 * IPC（closeSessionRuntime teardown cli 子进程 + 删盘）有约 1.2s 的异步窗口，
 * 期间磁盘上那条 jsonl 还在。窗口期内**任何来源**的 reload（尤其 cli 退出
 * 触发的 sessionListChanged，与删除无关却并发到达）都会拉回一份仍含被删
 * 会话的「权威」磁盘列表，把乐观移除覆盖掉 → 删除的行短暂复活，直到删盘
 * 真正完成后的 reload 才最终消失。墓碑集在 reload 结果里持续过滤掉这些
 * 「正在删除」的 id，堵死所有复活路径，直到删除 IPC 明确落定（成功摘除、
 * 失败摘除并 reload 拉回）才解禁。
 */
const tombstones = new Set<string>()

/**
 * 「新生」乐观行集（2026-07-16，用户报「新开的对话左侧列表没看到」）。
 *
 * 新会话的 jsonl 要等 CLI 冷启动 + 首条落盘后才进 listShellSessions 的
 * 权威数据（空窗几秒到几十秒），期间用户发完消息看 rail 是空的。发送首条
 * 消息时（FusionRuntimeProvider.onNew）乐观插入一行，让会话即刻可见。
 *
 * 与 tombstones 互为镜像的保护语义：空窗期内任何来源的 reload 拉到的
 * 磁盘列表都**还不含**新会话，直接 reconcile 会把乐观行冲掉——所以
 * reload 结果里缺席的新生 id 由本集补回；一旦权威数据里出现了（落盘
 * 完成），自动解除保护、以磁盘版为准（title/updatedAt/workspace 都校正）。
 */
const optimisticBirths = new Map<string, ThreadSummary>()

export const useRailSessionsStore = create<RailSessionsState>((set) => ({
  threads: [],
  loaded: false,

  reload: () => {
    if (typeof window === 'undefined' || !window.tabApi?.listShellSessions) {
      // 浏览器直开等无 tabApi 场景：不会有数据到来，标记 loaded 让渲染走
      // 真空态（null）——否则骨架屏永远挂着。
      set({ loaded: true })
      return
    }
    // TODO(debug 2026-07-08): 「发送后列表不刷新」排查用临时日志，定位后删。
    console.log('[RailSessionList] reload fired')
    window.tabApi
      .listShellSessions()
      .then((r) => {
        console.log(
          '[RailSessionList] got',
          r.threads.length,
          'threads, top3:',
          r.threads.slice(0, 3).map((t) => `${t.id.slice(0, 8)}:${t.title || '(空)'}`)
        )
        // 先过墓碑：删除窗口期内磁盘还含被删会话，过滤掉「删除中」的 id 才
        // 不会把乐观移除覆盖回来（见 tombstones 注释）。空集时是零成本直通。
        const visible = tombstones.size
          ? r.threads.filter((t) => !tombstones.has(t.id))
          : r.threads
        // 再补新生：磁盘还没来得及包含的乐观行补回（缺席→补、出现→解除
        // 保护，此后以磁盘版为准）。见 optimisticBirths 注释。
        const withBirths = [...visible]
        for (const [id, row] of optimisticBirths) {
          if (visible.some((t) => t.id === id)) optimisticBirths.delete(id)
          else withBirths.push(row)
        }
        const sorted = withBirths.sort((a, b) => b.updatedAt - a.updatedAt)
        // reconcile 而非无脑换引用：磁盘数据没变时沿用旧 threads 引用（zustand
        // set 同一引用不触发订阅），变了也只让真变的行换引用。这是「fan-out
        // 多条 reload / AI 回复中高频 sessionListChanged」不再整列表重渲的关键，
        // 也是 SessionRow memo 依赖的 thread 引用稳定性来源（2026-07-16）。
        set((s) => ({ threads: reconcileThreads(s.threads, sorted) }))
      })
      .catch((err: unknown) => console.warn('[RailSessionList] list failed', err))
      // 成功失败都收骨架：失败时留骨架等于用加载假象掩盖故障，宁可空白。
      .finally(() => set({ loaded: true }))
  },

  applyRename: (sessionId, title) =>
    set((s) => ({
      threads: s.threads.map((t) => (t.id === sessionId ? { ...t, title } : t))
    })),

  applyBirth: (thread) => {
    optimisticBirths.set(thread.id, thread)
    set((s) =>
      s.threads.some((t) => t.id === thread.id)
        ? {} // 已在列表（磁盘已落盘/重复调用）：不动，等 reload 校正。
        : { threads: [thread, ...s.threads] }
    )
  },

  applyRemove: (sessionId) => {
    tombstones.add(sessionId)
    set((s) => ({ threads: s.threads.filter((t) => t.id !== sessionId) }))
  },

  confirmRemove: (sessionId) => {
    tombstones.delete(sessionId)
  },

  cancelRemove: (sessionId) => {
    tombstones.delete(sessionId)
    // 墓碑解除后再 reload，把误删移除掉的行从磁盘拉回（此刻 reload 不再
    // 过滤这个 id）。
    useRailSessionsStore.getState().reload()
  }
}))
