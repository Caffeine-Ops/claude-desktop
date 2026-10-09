import { create } from 'zustand'

/**
 * 对话内查找（⌘F）的 UI 状态。
 *
 * **刻意只存这三样**：开关、搜索词、当前跳到第几条命中。命中列表本身不进
 * store——它是「消息数组 + 搜索词」的纯派生值（lib/threadFind 的
 * findInMessages），由 FindBar 用 useMemo 现算。存进来就有两份真相：消息
 * 流式追加时 store 里那份会立刻过期，而过期的命中列表会把用户滚到一条
 * 早就不在那个位置的消息上。
 *
 * `current` 是命中列表的下标，-1 = 还没选中任何一条（刚打开、或改了搜索词
 * 还没按「下一个」）。为什么不用 0 表示未选中：0 是个合法下标，调用方拿去
 * 索引会读到一条真实命中并把用户滚过去——「刚打开查找栏画面就自己跳了」。
 */
interface ThreadFindState {
  open: boolean
  query: string
  current: number
  /** 每次「请求聚焦查找框」自增。见 openFind 注释。 */
  focusSeq: number
  /**
   * 当前命中落在**完整**消息数组的哪个下标上，-1 = 没有。
   *
   * 消息组件靠它给自己加高亮。这是 `current` + 命中列表的派生值，但命中
   * 列表只活在 FindBar 里（刻意不进 store，见上），消息组件够不着——所以
   * 由 FindBar 在跳转时写进来当「广播」用。**FindBar 是唯一写手**。
   */
  activeMessageIndex: number
  openFind: () => void
  closeFind: () => void
  setQuery: (q: string) => void
  setCurrent: (i: number) => void
  setActiveMessageIndex: (i: number) => void
}

export const useThreadFindStore = create<ThreadFindState>((set) => ({
  open: false,
  query: '',
  current: -1,
  focusSeq: 0,
  activeMessageIndex: -1,

  /**
   * ⌘F。**不是 toggle**（⌘K 那个是）——全平台 ⌘F 的既有行为是「已经开着
   * 时再按＝重新聚焦并全选搜索词」，关闭走 Esc 或 ✕。把它做成 toggle 会在
   * 用户想改词时把整条栏关掉。
   *
   * 已开着时保留 `current`：用户可能正停在第 3 条上，只是想换个词继续找，
   * 没理由把位置清掉；真改了词，setQuery 会负责重置。
   *
   * 聚焦靠 `focusSeq` 自增而不是一个布尔：栏已经开着时 `open` 不变，
   * 光凭它 FindBar 的 effect 不会再跑，表现成「第二次按 ⌘F 没反应」。
   */
  openFind: () =>
    set((s) => ({
      open: true,
      focusSeq: s.focusSeq + 1,
      current: s.open ? s.current : -1
    })),

  // 关栏必须连高亮一起清——留着的话，转录里会有一条消息永远亮着，而用户
  // 已经没有任何入口去取消它了。
  closeFind: () => set({ open: false, current: -1, activeMessageIndex: -1 }),

  // 改词就回到「未选中」：旧的 current 指向的是上一个词的命中列表，留着它
  // 会在新列表里指到一条毫不相干的消息。高亮同理。
  setQuery: (query) => set({ query, current: -1, activeMessageIndex: -1 }),

  setCurrent: (current) => set({ current }),

  setActiveMessageIndex: (activeMessageIndex) => set({ activeMessageIndex })
}))
