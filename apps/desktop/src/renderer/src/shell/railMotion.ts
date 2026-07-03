import type { Transition } from 'motion/react'

/**
 * 左侧 rail 的统一动效 token —— nav 行（TabBar）与会话行
 * （ShellSessionList）共用，保证整根 rail 的选中动画节奏一致。
 * 参数对齐设计原型 docs/shell-prototype-v3.html 的 --ease-spring /
 * --d-med，是那份原型「滑动 glider」动效的 React 落地。
 */

/**
 * 高亮 glider（layoutId 共享布局动画）的手感。
 *
 * 为什么是 spring 而不是 duration+ease：glider 是会被连点打断的位移
 * 动画。spring 被中断时从当前位置和速度重新求解，衔接是连续的；
 * ease 曲线则会从头重放，肉眼可见地「顿一下再走」。这也是用 Motion
 * layoutId 替代原型里 CSS top 过渡的核心收益 —— FLIP 走 transform
 * 合成层 + 物理中断，两头都比手写定位丝滑。
 *
 * visualDuration 0.32 / bounce 0.18：到位干脆、带一点吸附回弹，
 * 与原型 cubic-bezier(0.34, 1.4, 0.44, 1) 的观感对齐。
 */
export const railGliderSpring: Transition = {
  type: 'spring',
  visualDuration: 0.32,
  bounce: 0.18
}

/**
 * 新会话行入场用的 expo-out（原型 --ease-out）。只做「出现」不做戏：
 * 快进缓停，无回弹 —— 列表条目的增删不该比选中态更抢戏。
 */
export const railEaseOut: [number, number, number, number] = [0.22, 1, 0.36, 1]
