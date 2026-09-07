import type { ShellStatFileInfo } from '@desktop-shared/ipc-channels'

/**
 * 会话产出物数据泵的状态迁移（纯函数，bun test 直接覆盖）。
 *
 * 泵本体是 ThreadView/SessionOutputsFeed.tsx 里那个只挂载一次的空组件：
 * 订阅前台会话 messages → collectSessionOutputs 扫候选 → statFiles 核实
 * → 把结果经这里的 reducer 写进 stores/sessionOutputs。成果弹层按钮、图库
 * 按钮、图库面板三处只读 store，不再各自扫描 / 各自 stat / 各自计 fresh
 * （2026-09-07 code review：三份实例 = 三倍 IPC，面板每次打开先闪一下空态，
 * 面板自己那份基线还把触发它打开的那张图当成「历史已有」）。
 *
 * 三条语义，历史上各踩过一次坑，别改坏：
 *   1. **freshlyAdded 只在同会话内真实新增时出现**：切到一个本来就有产出的
 *      会话不算「刚落盘」——基线在**同一次 stat 结果**里登记，而不是在
 *      sessionId 变化时单独登记（那会跟在途的上一会话 stat 竞态）。
 *   2. **全新会话要提前登记空基线**（feedOnEmptyCandidates）：否则第一份产出
 *      那次 stat 恰好是「首次见到该会话」，会被当历史吞掉。
 *   3. **arrival 与 fresh 不同拍**：一条路径可能先以正文形式被 stat 到（算
 *      fresh），Bash 调用 settled 后才被判为生成图进 images。fresh 2.6s 就清，
 *      所以要挂起到 pending，等它真正出现在 images 里再发 arrival；generated
 *      追上时候选未必变化（不会再 stat），故单独提供 feedOnGenerated。
 */
export type OutputsFeedState = {
  sessionId: string | null
  /** 已核实存在的产出物，最新在前。 */
  files: readonly ShellStatFileInfo[]
  /** files 里被判定为 AI 生成图的子集，最新在前。 */
  images: readonly ShellStatFileInfo[]
  /** 本会话刚落盘的路径；泵在 2.6s 后 feedClearFresh。 */
  freshlyAdded: ReadonlySet<string>
  /**
   * 一张生成图刚落盘并进入 images 的事件；seq 递增让同路径重生成也能触发。
   * 带 sessionId：store 只在泵的 effect 里异步重置，切会话那一帧消费者拿到的
   * 还是上一会话的 arrival——不比对会话就会用新会话 id 去记「已自动弹过」，
   * 把新会话唯一一次自动弹开烧掉（2026-09-07 第二轮 code review 抓到）。
   */
  arrival: { path: string; seq: number; sessionId: string | null } | null
  /** 基线：本会话已见过的路径 → 当时的 mtimeMs。mtime 变了 = 同路径新版本，
   *  照样算 fresh（--force 原地覆盖重生成的场景）。 */
  seen: ReadonlyMap<string, number>
  /** fresh 过但还没进 images 的路径（等 generated 追上）。 */
  pending: ReadonlySet<string>
  /** 最近一次已知的生成图判定，供 stat 结果到达时算 images。 */
  generated: ReadonlySet<string>
}

const EMPTY_SET: ReadonlySet<string> = new Set()
const EMPTY_MAP: ReadonlyMap<string, number> = new Map()

export const EMPTY_OUTPUTS_FEED: OutputsFeedState = {
  sessionId: null,
  files: [],
  images: [],
  freshlyAdded: EMPTY_SET,
  arrival: null,
  seen: EMPTY_MAP,
  pending: EMPTY_SET,
  generated: EMPTY_SET
}

/** 换会话：基线、挂起、fresh、arrival 全部归零；files/images 由调用方决定。 */
function resetForSession(state: OutputsFeedState, sessionId: string | null): OutputsFeedState {
  if (state.sessionId === sessionId) return state
  return {
    ...state,
    sessionId,
    freshlyAdded: EMPTY_SET,
    arrival: null,
    seen: EMPTY_MAP,
    pending: EMPTY_SET
  }
}

/** 从 files + pending + generated 推导 images，并把挂起里已到位的那张发成 arrival。 */
function settleImages(state: OutputsFeedState): OutputsFeedState {
  const images = state.files.filter((f) => state.generated.has(f.path))
  const hit = images.find((f) => state.pending.has(f.path))
  if (!hit) return { ...state, images }
  return {
    ...state,
    images,
    pending: EMPTY_SET,
    arrival: { path: hit.path, seq: (state.arrival?.seq ?? 0) + 1, sessionId: state.sessionId }
  }
}

/** 候选为空（全新会话 / 还没产出）：清列表，并**提前登记空基线**（语义 2）。 */
export function feedOnEmptyCandidates(
  state: OutputsFeedState,
  sessionId: string | null
): OutputsFeedState {
  const base = resetForSession(state, sessionId)
  if (base === state && state.files.length === 0 && state.images.length === 0) return state
  return { ...base, files: [], images: [] }
}

/**
 * statFiles 结果到达。infos 与候选同序（最旧在前），这里倒成最新在前。
 * 首次见到该会话 → 全部当历史登记基线（语义 1）；否则新增即 fresh 并挂起。
 */
export function feedOnStat(
  state: OutputsFeedState,
  sessionId: string | null,
  infos: readonly ShellStatFileInfo[],
  generated: ReadonlySet<string>
): OutputsFeedState {
  const firstSight = state.sessionId !== sessionId
  const base = resetForSession(state, sessionId)
  const files = [...infos].reverse()
  const seen = new Map(base.seen)
  const fresh: string[] = []
  for (const f of files) {
    // 没见过、或见过但 mtime 变了（同路径被覆盖重生成）都算新增。
    if (!firstSight && seen.get(f.path) !== f.mtimeMs) fresh.push(f.path)
    seen.set(f.path, f.mtimeMs)
  }
  const pending = fresh.length > 0 ? new Set([...base.pending, ...fresh]) : base.pending
  return settleImages({
    ...base,
    files,
    seen,
    pending,
    generated,
    // 与旧实现一致：没有新增时保留上一批 fresh（等 2.6s 计时器来清），
    // 别把正在播的入场动画中途掐断。
    freshlyAdded: fresh.length > 0 ? new Set(fresh) : base.freshlyAdded
  })
}

/** generated 判定变了但候选没变（不会再 stat）：只重算 images / arrival（语义 3）。 */
export function feedOnGenerated(
  state: OutputsFeedState,
  generated: ReadonlySet<string>
): OutputsFeedState {
  return settleImages({ ...state, generated })
}

/** 2.6s 计时器到点：只清 fresh。 */
export function feedClearFresh(state: OutputsFeedState): OutputsFeedState {
  if (state.freshlyAdded.size === 0) return state
  return { ...state, freshlyAdded: EMPTY_SET }
}
