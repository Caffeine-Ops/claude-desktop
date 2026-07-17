/**
 * 主题切换时掐掉全局过渡的闸门。
 *
 * 为什么需要
 * ----------
 * 切明暗是把一整套颜色 token 瞬间换掉，但**带 transition 的元素会把这次
 * 换色当成一次动画来演**：shadcn Button 基件的 `transition-all`、会话行的
 * `transition-colors` 都是 150ms。于是同一次切换里，没有 transition 的
 * rail 底色第一帧就到位，账户 chip 的灰底却要爬 150ms 才追上——用户看到的
 * 「这块背景色总比其他地方慢半拍」就是这 ~143ms 的差（2026-07-17 CDP 实测：
 * 改 token 后 rail 14ms 到位、chip 157ms 才稳定，逐帧爬色可见）。
 *
 * CSS transition 分不清「这次变色是 hover 还是换主题」——同一条声明管两者。
 * hover 的平滑要留，换主题的拖尾要去，只能在换主题这一拍把过渡整体掐掉。
 *
 * 为什么是同步 try/finally，而不是「加类 → rAF/setTimeout 移除」的脉冲
 * ------------------------------------------------------------------
 * region-refresh 的教训（2026-07-14，errors/）：瞬时改全局态再改回的 toggle
 * 是竞态温床——多写手争抢同一个全局类 + React cleanup 打断放回拍，让类永久
 * 残留把窗口拖拽卡死。next-themes 那种 `setTimeout(remove, 1)` 是同一族形状。
 *
 * 这里不需要跨帧：闸门的插入、换色、撤除全在一个同步执行流里完成，没有
 * pending 状态可残留，也就没有写手可争抢——两个主题写手（chat 的
 * appearance.applier / canvas 的 applyAppearanceToDocument）各自调用互不影响，
 * 甚至同一拍先后调用两次也只是各自开关一次。finally 保证抛异常也撤闸门。
 *
 * 三步顺序是硬约束，不能调换
 * -------------------------
 *   1. 插 `transition:none` 规则
 *   2. `apply()` 换色（此时闸门已生效，新色不会被过渡）
 *   3. **强制重算**让新色在闸门下真正落地 → 再撤规则
 *
 * 第 3 步的 reflow 少不得：浏览器的样式重算是惰性的，若换完色直接撤规则，
 * 「颜色变化」与「transition 恢复」会被合并进同一次重算——浏览器看到的是
 * 「background-color 从旧值变新值且 transition 可用」，照样给你演 150ms。
 * 反过来，reflow 放在 apply() 之前也没用：那时颜色还是旧的，落地的是旧值。
 */

/**
 * 造一个闸门。**每个主题写手持有自己的一个**，不共用。
 *
 * 返回的 `gate(nextDark, apply)` 只在「本写手上次写的明暗 ≠ 这次要写的」时
 * 才掐；相等时直接放行——调色板、字号、对比度等其它 apply 触发不该丢掉平滑
 * 感，拖色环时也不必每帧插拔闸门。首次调用（last === null）同样放行：那是
 * 首帧落地，没有旧色可过渡。
 *
 * 为什么状态必须 per-writer，而不是读 DOM 上的 `.dark`（2026-07-17 第一版
 * 的错，就是被这个 tab 抓出来的）
 * ---------------------------------------------------------------
 * 两个写手是**串联**的：从设置页切主题时，canvas 的 applyAppearanceToDocument
 * 先翻 .dark / data-theme 标记，chat 的 appearance.applier 随后才写
 * --background / --card 那批真正决定 chat 面主体颜色的 inline token。若判据
 * 取 DOM，第二个写手看到的标记已经被第一个翻成新值，会判「没翻转」而放行，
 * 于是那批 token 照样带 150ms 过渡换色——「设置页切主题这个 tab 反应也很慢」
 * 正是这个漏。
 *
 * 根子上：**DOM 标记是两个写手共享的输出，不是各自的输入历史**。「我上次写
 * 的是明还是暗」只有写手自己知道，共用一份状态同样会被前一个写手的更新污染。
 */
export function createThemeTransitionGate(): (
  nextDark: boolean,
  apply: () => void
) => void {
  let last: boolean | null = null

  return (nextDark, apply) => {
    const flipping = last !== null && last !== nextDark
    last = nextDark
    if (!flipping) {
      apply()
      return
    }

    const gate = document.createElement('style')
    // 只掐 transition 不碰 animation：animation:none 会把正在播的 spinner /
    // 权限卡呼吸点等重置回第一帧，那是另一种可见的「跳」。
    gate.textContent = '*,*::before,*::after{transition:none!important}'
    document.head.appendChild(gate)
    try {
      apply()
      // 强制样式重算，让新色在闸门下落地（读 offsetHeight 会 flush 样式+布局）。
      void document.documentElement.offsetHeight
    } finally {
      gate.remove()
    }
  }
}
