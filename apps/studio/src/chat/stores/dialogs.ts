import { create } from 'zustand'

/**
 * Modal dialog state for client-side slash commands, plus a couple of
 * globally-triggerable dialogs that don't come from a slash command
 * (`feedback`) but reuse this same "one dialog at a time, opened from
 * anywhere" plumbing since chat + canvas coexist in one document via
 * SurfaceHost — any component in either surface can call
 * `useDialogStore.getState().openDialog(...)` regardless of which
 * surface is currently visible.
 *
 * The renderer intercepts a small whitelist of `/<cmd>` inputs in
 * FusionRuntimeProvider's onNew callback before they're sent to
 * fusion-code, and dispatches them to one of these dialog kinds.
 * Adding a new slash command is a two-step change:
 *
 *   1. Add a string here (e.g. `'help'`).
 *   2. Add a switch case in FusionRuntimeProvider's slash dispatch.
 *   3. Mount the corresponding dialog component in App.tsx.
 *
 * Only one dialog can be open at a time. Opening a new one replaces
 * whichever was open before — `null` means none.
 */
// 注：'plugins' 曾在这里（PluginsDialog 弹窗）。2026-07-17 插件市场改成
// SurfaceHost 的第三个面（?market=1，rail 常驻 + 右侧换成市场，弹窗形态被
// 用户否掉），落点不再是弹窗，故从 DialogKind 移除——`/plugins` 斜杠命令与
// rail「插件」按钮统一走 stores/surfaceOverlay.ts 的 openSurfaceOverlay()。
export type DialogKind = 'skills' | 'mcp' | 'logs' | 'search' | 'feedback' | null

/** 问题反馈弹窗的类型分段——与 FeedbackDialog.tsx 的 KIND_META 一一对应，
 *  定义在这里（而非 FeedbackDialog 内部）是因为 openFeedbackDialogFor
 *  的调用方（消息操作栏的喜欢/不喜欢按钮）需要引用同一个类型，单一
 *  来源避免两处字面量类型悄悄分叉。 */
export type FeedbackKind = 'bug' | 'idea' | 'other'

/** 消息级喜欢/不喜欢触发反馈弹窗时携带的预填上下文——kind 决定弹窗打开
 *  时预选哪个分段胶囊，context 是那条被评价的 AI 回复原文（提交时静默
 *  拼进 description，不写进用户可见/可编辑的 textarea，与既有的
 *  KIND_META[kind].prefix 隐藏前缀是同一手法）。 */
export interface FeedbackPrefill {
  kind: FeedbackKind
  context: string
}

interface DialogState {
  open: DialogKind
  feedbackPrefill: FeedbackPrefill | null
  openDialog: (kind: Exclude<DialogKind, null>) => void
  /** 带上下文打开反馈弹窗——消息操作栏的喜欢/不喜欢按钮走这个而不是
   *  openDialog('feedback')，好让 FeedbackDialog 预选类型 + 静默附带
   *  被评价消息的原文。 */
  openFeedbackDialog: (prefill: FeedbackPrefill) => void
  closeDialog: () => void
}

export const useDialogStore = create<DialogState>((set) => ({
  open: null,
  feedbackPrefill: null,
  // 通用入口（rail 菜单 / 设置页）：清空 prefill，弹窗回落到默认「问题」
  // 分段 + 空白 textarea，不携带任何消息上下文。
  openDialog: (kind) => set({ open: kind, feedbackPrefill: null }),
  openFeedbackDialog: (prefill) => set({ open: 'feedback', feedbackPrefill: prefill }),
  closeDialog: () => set({ open: null, feedbackPrefill: null })
}))
