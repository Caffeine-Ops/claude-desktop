/**
 * 把一个 localStorage 基名加上当前租户后缀，实现按用户隔离的渲染进程偏好。
 *
 * tenantId 取自 preload 在加载时同步取得的 window.chatApi.tenantId（切租户会整页
 * reload，preload 重新执行 → 这里自然拿到新 tid）。未登录用 'anon'，其偏好不会
 * 泄漏给任何已登录用户。
 *
 * 注意：在模块加载期（zustand persist 创建、bootAppearance）调用是安全的——preload
 * 先于 renderer 脚本运行，此时 window.chatApi.tenantId 已就绪。
 */
export function tenantKey(base: string): string {
  const tid = window.chatApi?.tenantId ?? 'anon'
  return `${base}:${tid}`
}
