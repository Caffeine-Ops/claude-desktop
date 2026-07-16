import type { ComposerRuntime } from '@assistant-ui/core'

import { insertFileMentionIntoActiveComposer } from './composerBridge'
import { autoOpenPreviewPanel } from '../runtime/imageAttachmentAdapter'

/**
 * 附件三入口（工具行「+」选择器 / 整列拖拽 / 粘贴）的统一分流（2026-07-16
 * 附件内联化，对齐 WorkBuddy 参考）：
 *
 *   - **有磁盘路径**（选择器、拖拽、Finder 复制的文件——webUtils.
 *     getPathForFile 解析成功）→ 直接往编辑器里插 `@"path"` mention chip，
 *     与 `@` 菜单挑文件产出完全同款；不再进输入框上方的 attachments 行。
 *     发送 wire 格式零变化：attachments 管线对有路径附件本来就在 send 时
 *     拼 `@"path"` mention（2026-07-09 定稿「图片一律发路径」），改的只是
 *     发送前的视觉承载。「上传即预览」（autoOpenPreviewPanel）保留。
 *
 *   - **无磁盘路径**（剪贴板截图这类 blob-backed File）→ 走原
 *     assistant-ui attachments 管线（顶部缩略图行 + 发送时 base64 vision
 *     block）——没有路径就没法 mention，这条兜底路径保留原样。
 *
 * 返回 true 表示至少处理了一个文件（调用方据此决定是否吞掉原生事件）。
 */
export async function attachFilesToComposer(
  files: readonly File[],
  runtime: ComposerRuntime
): Promise<boolean> {
  let handled = false
  for (const file of files) {
    const path = window.chatApi?.pathForFile(file) ?? ''
    if (path && insertFileMentionIntoActiveComposer(path)) {
      autoOpenPreviewPanel(file.name, path)
      handled = true
      continue
    }
    // 无路径（或编辑器不在挂载态）→ attachments 行兜底。
    try {
      await runtime.addAttachment(file)
      handled = true
    } catch (err) {
      console.error('[attachFiles] addAttachment failed', err)
    }
  }
  return handled
}
