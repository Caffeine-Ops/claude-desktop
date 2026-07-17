import { useT } from '../../i18n'

/**
 * （2026-07-16 形态迁移）此文件曾经装着 PermissionFloatDock /
 * PermissionFloatCard —— composer 上方的 Codex 风浮动权限卡。权限决策 UI
 * 已迁入 composer 位的整卡接管面板（PermissionComposerPanel，与
 * AskUserComposerPanel 走同一个 AskComposerSwap 槽）：浮卡 + 下方仍在
 * 跳动的输入卡是两张视觉层，且回答权限期间输入区并无实际用处。浮卡
 * 组件已删，恢复从 git 历史。
 *
 * 留下的只有 PermissionWaitAnchor —— 挂在等待中工具卡里的轻量锚点，
 * 保持「这个 spinner 在等下面的问题」的指向关系；文件名不改，免得动
 * ToolCallCard 的 import 路径。
 */

/**
 * PermissionWaitAnchor
 * --------------------
 * The lightweight marker rendered INSIDE the waiting tool's card where
 * the old inline prompt used to be. The actual decision UI now lives in
 * the composer-takeover panel (PermissionComposerPanel / the ask panel)
 * — this row keeps the tool ↔ prompt relationship legible ("this
 * spinner is waiting on the question below") without duplicating the
 * choices.
 */
export function PermissionWaitAnchor({ ask = false }: { ask?: boolean } = {}): React.JSX.Element {
  const t = useT()
  return (
    <div className="flex items-center gap-2 rounded-[10px] bg-brand/[0.07] px-3 py-2 text-[12.5px] font-medium text-brand">
      <span aria-hidden className="perm-wait-dot size-1.5 shrink-0 rounded-full bg-brand" />
      {/* ask 变体（2026-07-16 提问面板迁移）：AskUserQuestion 的答题 UI 在
          composer 位的提问面板，不是浮动权限卡——文案指向输入区。 */}
      {t(ask ? 'askWaitAnchor' : 'permissionWaitAnchor')}
      <span className="ml-auto shrink-0 text-[12px] opacity-80" aria-hidden>
        {t(ask ? 'askWaitAnchorHint' : 'permissionWaitAnchorHint')}
      </span>
    </div>
  )
}
