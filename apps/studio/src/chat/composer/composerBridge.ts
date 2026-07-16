/**
 * 模块级「当前活跃 composer 编辑器」桥。
 *
 * 附件内联化（2026-07-16）需要从 composer 组件树之外往编辑器里插 mention
 * chip——ThreadView 的整列 dropzone 在 Composer 外层，够不到
 * composerInputRef。同一时刻只有一个 ProseMirrorComposerInput 实例在挂载
 * （EmptyState 的 hero composer 与底部 dock 由 ThreadPrimitive.If 互斥），
 * 所以一个模块级单槽就是正确的形状，不需要 Map/store。
 *
 * 独立成最小模块（而不是塞进 ProseMirrorComposerInput）是为了斩断
 * attachFiles ↔ ProseMirrorComposerInput 的循环依赖：编辑器注册、
 * attachFiles 消费，两边都只 import 这里。
 */

let activeInserter: ((path: string) => void) | null = null

/** 编辑器 mount 时注册、unmount 时传 null 注销（见 ProseMirrorComposerInput）。 */
export function registerFileMentionInserter(fn: ((path: string) => void) | null): void {
  activeInserter = fn
}

/**
 * 往当前活跃的 composer 编辑器末尾插一个 `@"path"` mention chip。
 * 没有活跃编辑器（听写接管、无会话等）时返回 false，调用方走
 * addAttachment 兜底。
 */
export function insertFileMentionIntoActiveComposer(path: string): boolean {
  if (!activeInserter) return false
  activeInserter(path)
  return true
}
