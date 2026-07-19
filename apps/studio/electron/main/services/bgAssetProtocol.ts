/**
 * `bgasset://` 自定义协议 —— 让渲染进程显示用户导入的背景主题图。与 kbasset:// /
 * proposalasset:// 的区别只在守卫根目录换成 `<userData>/background-themes`。
 *
 * 具体实现收口在 localAssetProtocol.ts（三个 scheme 共用同一个工厂——评审发现
 * kbasset/proposalasset 曾是逐行克隆的双胞胎 handler，第三份不再重蹈）。URL 形：
 * `bgasset://local/<encodeURIComponent(图的绝对路径)>`，渲染侧由 bgAssetUrl.ts 构造。
 * 内置预设图不走本协议——它们是 public/bg-presets/ 下的静态资源，走 app://。
 */

export const BG_ASSET_SCHEME = 'bgasset'

import { isPathInsideRoot, registerLocalAssetProtocol } from './localAssetProtocol'

/** 语义化别名，供 backgroundThemes.ts 复用同一份路径守卫。 */
export function isPathInsideBackgroundThemesRoot(absPath: string, root: string): boolean {
  return isPathInsideRoot(absPath, root)
}

/** `<userData>/background-themes`（惰性取，函数内 require electron，保持 bun test import-safe）。 */
export function backgroundThemesRoot(): string {
  const { app } = require('electron') as typeof import('electron')
  const { join } = require('node:path') as typeof import('node:path')
  return join(app.getPath('userData'), 'background-themes')
}

/**
 * 注册 bgasset:// handler。app.whenReady() 之后调用一次；registerSchemesAsPrivileged
 * 必须已在 ready 前跑过（见 index.ts）。命中 → 流式读盘；越界/不存在 → 404，绝不抛。
 */
export async function registerBgAssetProtocol(): Promise<void> {
  await registerLocalAssetProtocol(BG_ASSET_SCHEME, () => backgroundThemesRoot())
}
