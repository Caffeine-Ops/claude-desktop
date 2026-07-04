import type { HomePromptHandoff } from '../components/home-hero/plugin-authoring';

/*
 * 跨页面的 home prompt-loop 交接暂存槽。
 *
 * 为什么存在：`homePromptHandoff` 是 EntryShell 的本地 useState——插件的
 * 「创建 / 使用」动作靠它把 handoff 递进首页 prompt loop。设置页迁移
 * （2026-07-04）后，插件库 section 宿主在 SettingsDialog 里，而设置 overlay
 * 模式下 App 提前 return、EntryShell 整棵未挂载，没法直接 setState。
 *
 * 机制：设置页的插件动作先 stash 再 navigate 回首页（URL 变化让
 * ?settings=1 消失、overlay 自动关闭）→ EntryShell 重新挂载 → 挂载 effect
 * take 走暂存并写进本地 state，流程与从首页 rail 发起完全一致。
 *
 * 一次性信箱语义：take 即清空，刷新/二次挂载不会重放旧 handoff。
 */
let pending: HomePromptHandoff | null = null;

export function stashHomePromptHandoff(handoff: HomePromptHandoff): void {
  pending = handoff;
}

export function takeHomePromptHandoff(): HomePromptHandoff | null {
  const taken = pending;
  pending = null;
  return taken;
}
