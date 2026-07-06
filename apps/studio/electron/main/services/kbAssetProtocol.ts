/**
 * `kbasset://` 自定义协议 —— 让桌面渲染进程能显示知识库镜像里的本地图片（方案预览嵌图）。
 *
 * 为什么不用 file:// 直读：渲染进程 file:// 图常被 webSecurity 拦；且需要严格的路径逃逸
 * 防护，不能让 `kbasset://kb/<../../etc/passwd>` 读到 kb-index 目录外的任意文件。
 *
 * 具体实现收口在 localAssetProtocol.ts（与 proposalasset:// 共用，评审发现两 handler 曾是
 * 逐行克隆——安全加固会只修到一个 scheme）。本文件只保留 scheme 常量、KB 根解析与守卫的
 * 语义化导出。URL 形：`kbasset://kb/<encodeURIComponent(图的绝对路径)>`，渲染侧由
 * toKbAssetUrl 构造。
 */

/** 协议名。必须与 index.ts registerSchemesAsPrivileged 里登记的一致。 */
export const KB_ASSET_SCHEME = 'kbasset'

import { isPathInsideRoot, registerLocalAssetProtocol } from './localAssetProtocol'

/** 语义化别名，测试与旧调用点沿用此名；实现见 localAssetProtocol.isPathInsideRoot。 */
export function isPathInsideKbRoot(absPath: string, kbRoot: string): boolean {
  return isPathInsideRoot(absPath, kbRoot)
}

/**
 * 注册 kbasset:// handler。app.whenReady() 之后调用一次；registerSchemesAsPrivileged 必须
 * 已在 ready 前跑过（见 index.ts）。命中 → 流式读盘；越界/不存在 → 404，绝不抛。
 *
 * async 返回 Promise<void>：避免 fire-and-forget IIFE 吞掉 import 错误，同时确保 handler
 * 注册时机确定（而非延迟到微任务队列）。调用方在 app.whenReady 回调里 await。
 * kbOutDir 动态导入，避免模块顶层加载（影响测试）。
 */
export async function registerKbAssetProtocol(): Promise<void> {
  const { kbOutDir } = await import('../core/kbIndexStore')
  await registerLocalAssetProtocol(KB_ASSET_SCHEME, () => kbOutDir())
}
