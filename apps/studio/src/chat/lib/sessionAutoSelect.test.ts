import { describe, expect, it } from 'bun:test'

import { shouldAutoCreateSession, type AutoSelectInputs } from './sessionAutoSelect'

/**
 * 「现在该不该自动补建一个空会话」的判定。
 *
 * 这组测试存在的理由是一个真实缺陷（2026-10-09）：原实现用 `autoSelectedRef`
 * 当**单向闸门**——`autoSelectedRef.current = true` 在 await 之前置位且永不
 * 复位。它把「**已经尝试过**」当成了「**已经有会话了**」，而这两件事不等价：
 * `sessionId` 回到 null 是设计内的合法状态（ReplayController 退出回放时
 * `setForegroundSession(saved)`，其注释原话「为 null 回空态首页」）。
 *
 * 一旦落进「闸门已关 + sessionId 为 null」，补建 effect 永不再跑，应用进入
 * **永久发不出消息**的状态——用户打完字按发送，文字消失、界面毫无变化，
 * 只在控制台留一行 `[runtime] No active session`。
 *
 * 下面 `describe('真实缺陷回归')` 那条用的就是当时探针抓到的状态组合。
 */

/** 一切就绪、确实需要补建的基线；每个用例只改它关心的那一个字段。 */
const BASE: AutoSelectInputs = {
  createInFlight: false,
  threadsLoaded: true,
  sessionId: null,
  sessionLoading: false
}

describe('shouldAutoCreateSession — 真实缺陷回归', () => {
  it('【这条就是那个 bug】之前建过、但 sessionId 又回到 null 时，必须能再建', () => {
    // 2026-10-09 探针实测到的现场：三个前置条件全满足、本该重建，却被
    // 那个永不复位的闸门挡死，应用从此发不出任何消息。
    //
    // 判定只看「此刻是不是正在建」（createInFlight），不看「历史上建过
    // 没有」——所以同样的现场在新逻辑下返回 true。
    expect(
      shouldAutoCreateSession({
        ...BASE,
        createInFlight: false, // 上一次早已结束
        sessionId: null, // 但会话又没了（如退出录像回放）
        threadsLoaded: true,
        sessionLoading: false
      })
    ).toBe(true)
  })

  it('补建成功之后不会反复建——幂等性由「已有会话」这个事实保证', () => {
    // 原闸门的本意（幂等）必须保住：threads 列表后续变化会让 effect 重跑，
    // 那时 sessionId 已非 null，这里就该拦住。
    expect(shouldAutoCreateSession({ ...BASE, sessionId: 'sess-1' })).toBe(false)
  })
})

describe('shouldAutoCreateSession — 该建的时候', () => {
  it('列表已加载、没有会话、没有任何事情在途 → 建', () => {
    expect(shouldAutoCreateSession(BASE)).toBe(true)
  })
})

describe('shouldAutoCreateSession — 不该建的时候', () => {
  it('已经有会话了 → 不建', () => {
    expect(shouldAutoCreateSession({ ...BASE, sessionId: 'sess-1' })).toBe(false)
  })

  it('已经有一次补建正在进行 → 不建第二个', () => {
    // 这是真正的幂等防线：effect 在同一拍里可能因多个依赖变化重跑，
    // 没有这道门会并发建出好几个空会话。
    expect(shouldAutoCreateSession({ ...BASE, createInFlight: true })).toBe(false)
  })

  it('会话列表还没回来 → 等它，别抢跑', () => {
    expect(shouldAutoCreateSession({ ...BASE, threadsLoaded: false })).toBe(false)
  })

  it('有一次会话切换在途 → 让它先落定', () => {
    expect(shouldAutoCreateSession({ ...BASE, sessionLoading: true })).toBe(false)
  })

  it('多个条件同时不满足时照样不建（不会被某一条「抵消」）', () => {
    expect(
      shouldAutoCreateSession({
        createInFlight: true,
        threadsLoaded: false,
        sessionId: 'sess-1',
        sessionLoading: true
      })
    ).toBe(false)
  })

  it('列表没加载完，但已经有会话了 → 仍然不建（已有会话优先于等列表）', () => {
    expect(
      shouldAutoCreateSession({ ...BASE, threadsLoaded: false, sessionId: 'sess-1' })
    ).toBe(false)
  })
})
