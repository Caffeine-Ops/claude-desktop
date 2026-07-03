/**
 * 空壳路由 —— 聊天面的实体不在这里。
 *
 * chat 与 canvas 两棵重型树常驻在根 layout 的 SurfaceHost 里（keep-alive，
 * 路由切换只翻显隐，不拆树不重挂——切换卡顿的治本），本 page 仅承担
 * 「/chat 命中一个路由」的职责。聊天面本体见 src/components/ChatSurface.tsx。
 */
export default function ChatPage() {
  return null
}
