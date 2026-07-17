import type { Transition } from 'motion/react';

/**
 * 市场页的动效 token —— 与 chat/shell/railMotion.ts 同一套哲学：参数对齐
 * 设计原型（docs/ui-prototype-plugins.html），集中在一处好让整个页面的节奏
 * 一致，别在组件里散落魔数。
 *
 * 全部动效都必须尊重 prefers-reduced-motion（各组件用 useReducedMotion 兜底）
 * ——这是动效的无障碍底线，不是可选项。
 */

/**
 * 已安装 tile 的入场（原型 .mini-tile 的 `pop-in`：
 * `scale(0.4)/opacity 0 → 1`，0.25s，cubic-bezier(0.2, 1.4, 0.5, 1)）。
 *
 * 用 spring 而非照抄 cubic-bezier：这个动画的触发时机是「装完一个插件，
 * tile 落进已安装区」——用户可能连装几个，spring 被打断时从当前 scale/速度
 * 续解，ease 曲线则会从头重放（同 railGliderSpring 的取舍）。bounce 0.35
 * 对应原曲线 1.4 的 overshoot 观感。
 */
export const tilePopIn: Transition = {
  type: 'spring',
  visualDuration: 0.25,
  bounce: 0.35,
};

/**
 * tab 切换 / 列表换页的内容淡入。expo-out、无回弹——内容切换不该比选中态
 * 更抢戏（同 railEaseOut 的理由）。刻意只做 opacity + 极小的 y 位移：
 * 市场列表一屏十几行，位移大了整片跟着晃，像页面在抖。
 */
export const contentEaseOut: Transition = {
  duration: 0.18,
  ease: [0.22, 1, 0.36, 1],
};

/** toast（安装成功/失败提示）的进出：从下方浮起，退场原路缩回。 */
export const toastSpring: Transition = {
  type: 'spring',
  visualDuration: 0.3,
  bounce: 0.2,
};
