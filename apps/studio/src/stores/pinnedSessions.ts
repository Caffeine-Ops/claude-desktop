import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * 被用户置顶的会话 id 集合。
 *
 * **为什么不写进会话自己的 jsonl**（重命名就是那么干的）：那条路只对
 * 重命名成立——`{"type":"custom-title",…}` 是 **fusion-code 上游自己的
 * 格式**（它的 `/rename` 斜杠命令写同一行、SDK 的 reader 也认），我们只是
 * 搭车，没有发明新字段。置顶没有对应的上游概念，自创一个 `pinned` 类型
 * 就成了往别人的文件格式里塞私货：上游哪天真用了这个 key、或对未知 type
 * 变严格，都是静默的坑。sessionStore.ts 头注释那句「磁盘仍是唯一事实源
 * —— 本模块不新增任何状态」正是这个纪律。
 *
 * 所以置顶是**我们自己的**状态，走 localStorage。形状与写法逐字照抄
 * chat/stores/composerMode.ts 的 slidesSessions：`Record<id, true>` 而不是
 * Set，zustand 的 persist 才能不带自定义 replacer 直接 JSON 序列化。
 *
 * 落点在 src/stores 而非 chat/stores：侧栏（AppRail / RailSessionList）是
 * chat 与 canvas **两面共享**的根层外壳，塞进任一面的私有目录会让另一面
 * 读不到——理由同隔壁 rail.ts。
 *
 * **陈旧键**：会话可能在别处被删除（另一台机器、直接删 jsonl），键会留在
 * 这里。无害——buildItems 按「实际命中了几行」决定要不要画置顶组，扫不到
 * 的键自然被忽略（见 railGrouping.ts 的注释与测试）。应用内删除会话时
 * RailSessionList 会顺手调 unpin 清掉，不主动做全量对账：一次 listSessions
 * 扫盘偶发少返回几条就把用户的置顶抹了，比留几个死键坏得多。
 */
interface PinnedSessionsState {
  pinned: Record<string, true>
  /** 置顶 ⇄ 取消置顶。 */
  toggle: (sessionId: string) => void
  /** 只取消置顶（删除会话时清键用），未置顶时是 no-op。 */
  unpin: (sessionId: string) => void
  isPinned: (sessionId: string | null | undefined) => boolean
}

export const usePinnedSessionsStore = create<PinnedSessionsState>()(
  persist(
    (set, get) => ({
      pinned: {},
      toggle: (sessionId) => {
        if (!sessionId) return
        set((s) => {
          const next = { ...s.pinned }
          if (next[sessionId]) delete next[sessionId]
          else next[sessionId] = true
          return { pinned: next }
        })
      },
      unpin: (sessionId) => {
        if (!sessionId || !get().pinned[sessionId]) return
        set((s) => {
          const next = { ...s.pinned }
          delete next[sessionId]
          return { pinned: next }
        })
      },
      isPinned: (sessionId) => (sessionId ? get().pinned[sessionId] === true : false)
    }),
    { name: 'claude-desktop:pinned-sessions' }
  )
)
