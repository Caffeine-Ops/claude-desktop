/*
 * 「新建项目」跨树请求信箱（2026-07-04 EntryNavRail 退役）。
 *
 * 新建项目按钮从画布首页 rail 迁到了壳层 AppRail（src/components/，chat 栈），
 * 而 NewProjectModal 的开关是 EntryShell 的本地 state——两棵树没有共同的
 * React 上下文。走「事件 + 一次性 pending」双通道：
 * - EntryShell 已挂载（SurfaceHost keep-alive 下即使 chat 面在前它也在）：
 *   事件监听直接开 modal；
 * - EntryShell 未挂载（canvas 停在项目视图等）：pending 存着，随 AppRail
 *   的 navigate 回首页后由挂载 effect 消费。
 * 两条都触发时 consume 的一次性语义保证只开一次。
 *
 * AppRail 侧必须动态 import 本模块（与 canvas/router 同款约束：canvas 模块
 * 链上有求值期触碰 window 的文件，静态 import 进 layout 树会炸 SSR）。
 */
export const NEW_PROJECT_REQUEST_EVENT = 'od:new-project-request';

let pending = false;

export function requestNewProject(): void {
  pending = true;
  window.dispatchEvent(new Event(NEW_PROJECT_REQUEST_EVENT));
}

export function consumeNewProjectRequest(): boolean {
  const had = pending;
  pending = false;
  return had;
}
