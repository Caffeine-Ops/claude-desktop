/**
 * 「现在该不该自动补建一个空会话」的判定。
 *
 * 背景：这个应用**不允许** `sessionId` 长期为 null——composer 的 plain-send
 * 路径（FusionRuntimeProvider 的 onNew）对 null id 是硬 return，用户打完字
 * 按发送会被静默吞掉，只在控制台留一行
 * `[runtime] No active session — create or pick one from the sidebar.`。
 * 所以有个 effect 负责补建一个空会话（engine lazy-spawn，只分配 id 不写盘，
 * 不发消息就不污染会话列表）。
 *
 * 为什么把这组条件抠成纯函数（2026-10-09 修 bug 时）
 * --------------------------------------------------
 * 原实现用 `autoSelectedRef` 当**单向闸门**：
 *
 *     if (autoSelectedRef.current) return
 *     ...
 *     autoSelectedRef.current = true   // 在 await 之前置位，此后永不复位
 *     void onSwitchToNewThread()
 *
 * 闸门的本意是幂等（threads 列表后续变化时别重复建），但它把「**已经尝试
 * 过**」当成了「**已经有会话了**」——这两件事不等价：
 *
 *   - `sessionId` 回到 null 是**设计内的合法状态**。ReplayController 退出
 *     录像回放时就会 `setForegroundSession(saved)`，其注释原话是「为 null
 *     回空态首页」。
 *   - 预建那一次本身也可能没落地（IPC 未就绪、切换竞态）。
 *
 * 一旦落进「闸门已关 + sessionId 为 null」，effect 永不再跑，应用进入**永久
 * 发不出消息**的状态，而用户只看到控制台一行红字——界面上毫无反馈，打的字
 * 还被 composer 清掉了。2026-10-09 实测抓到过这个现场：
 * `{sessionId:null, threadsLoaded:true, sessionLoading:false, autoSelected:true}`
 * ——三个前置条件全满足、本该重建，却被闸门挡死。
 *
 * 修法：把记忆位从「已尝试过」换成「**此刻正在建**」（建完即复位）。幂等性
 * 改由 `sessionId !== null` 这个**事实**保证——事实会跟着状态回退，记忆位
 * 不会。这也是把它抠成纯函数的理由：条件组合就那么几种，但每一种都对应
 * 「用户能不能发出消息」，值得被钉死。
 */

/** 判定所需的全部输入。**全是当下事实**，没有一项是「历史上做过什么」。 */
export interface AutoSelectInputs {
  /**
   * 是否有一次补建**正在进行中**（await 尚未落定）。
   *
   * ⚠️ 语义是「此刻正在建」，不是「曾经建过」。调用方必须在 Promise
   * settle 后复位（finally），否则就退化成原来那个永不复位的闸门，
   * 上面描述的 bug 会原样复发。
   */
  readonly createInFlight: boolean
  /** 初次 listSessions 是否已返回（失败也算——见其 finally 的注释）。 */
  readonly threadsLoaded: boolean
  /** 当前前台会话；非 null 就说明不需要补建。 */
  readonly sessionId: string | null
  /** 是否有一次会话切换在途——让它先落定，别和它抢。 */
  readonly sessionLoading: boolean
}

/**
 * 该不该现在补建一个空会话。四个条件全部成立才建。
 *
 * 纯合取，顺序不影响结果；这里按「最能说明问题的放最前」排——
 * 「已经有会话」是幂等的真正依据，它排第一是想让读的人先看到这条。
 */
export function shouldAutoCreateSession(s: AutoSelectInputs): boolean {
  if (s.sessionId !== null) return false // 已有会话 → 不需要（幂等就靠这条）
  if (s.createInFlight) return false // 已经在建 → 别并发建出第二个
  if (!s.threadsLoaded) return false // 列表还没回来 → 等它，别抢跑
  if (s.sessionLoading) return false // 有切换在途 → 让它先落定
  return true
}
