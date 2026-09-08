import { create } from 'zustand'

import { EMPTY_OUTPUTS_FEED, type OutputsFeedState } from '../lib/sessionOutputsFeed'

/**
 * 前台会话的产出物快照（已核实存在的文件 / 其中的生成图 / 刚落盘集合 / 到达
 * 事件）。**只有一个写手**：ThreadView 里挂载一次的 SessionOutputsFeed 数据泵
 * （状态迁移是 lib/sessionOutputsFeed 的纯函数）。成果弹层按钮、图库按钮、
 * 图库面板都只读这里——别再在组件里各自 statFiles（2026-09-07 收敛前正是
 * 三份实例：三倍 IPC、面板打开先闪空态、面板自己的基线吞掉触发它的那张图）。
 *
 * 只存前台会话：切会话时泵会重置，消费者永远看到的是当前会话。
 */
export const useSessionOutputsStore = create<OutputsFeedState>(() => EMPTY_OUTPUTS_FEED)
