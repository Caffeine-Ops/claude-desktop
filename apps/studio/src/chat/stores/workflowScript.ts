import { create } from 'zustand'

/**
 * Workflow 脚本面板的开关状态（面板本体见 WorkflowScriptPanel.tsx）。
 *
 * 面板有两种打开途径，对应两个字段：
 *   - 自动：前台会话有一个还在流式写入的 Workflow tool call（AI 正在
 *     「写脚本」），或它 spawn 的 run 还在飞（「跑任务」，任务树实时
 *     跳动）→ 面板自动打开跟随。这两个信号不存这里——分别由 chat
 *     store 的 useStreamingWorkflowCallId / useActiveWorkflowRunId 派生，
 *     存副本必然过期。这里只存它们共用的否决票 `dismissedToolCallId`：
 *     用户在任一自动阶段点了关闭，同一个 toolCallId 的自动展示就此闭嘴
 *     （新的 Workflow 调用是新 id，照常弹）。
 *   - 手动：用户点某张 Workflow 卡片里的脚本入口 → `manualToolCallId`
 *     记下目标，面板从 messages 里按 id 捞完整脚本 + 最终任务树展示。
 *
 * 优先级在面板组件里定：正在流式的自动内容 > 手动指定的历史脚本——
 * AI 开写新脚本时抢过画面是符合直觉的（同 SlidesWorkspace 问题 tab 的
 * 自动聚焦逻辑）。
 *
 * 会话切换不需要显式清理：两个 id 都指向某条消息里的 tool-call part，
 * 切走后在新会话的 messages 里查无此 id → 面板自然不渲染；切回来面板
 * 恢复原样（用户没关它，就该还开着）。
 */
type WorkflowScriptPanelStore = {
  manualToolCallId: string | null
  dismissedToolCallId: string | null
  openManual: (toolCallId: string) => void
  /** 关闭自动弹出的流式面板（记否决票，本次调用不再自动弹）。 */
  dismissStreaming: (toolCallId: string) => void
  closeManual: () => void
}

export const useWorkflowScriptPanelStore = create<WorkflowScriptPanelStore>((set) => ({
  manualToolCallId: null,
  dismissedToolCallId: null,
  // 手动打开同时清掉否决票——用户点入口 = 明确想看，之前的「别烦我」
  // 只针对当时的自动弹出。
  openManual: (toolCallId) =>
    set({ manualToolCallId: toolCallId, dismissedToolCallId: null }),
  dismissStreaming: (toolCallId) =>
    set({ dismissedToolCallId: toolCallId, manualToolCallId: null }),
  closeManual: () => set({ manualToolCallId: null })
}))
