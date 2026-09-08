/**
 * 「这个扩展名能不能进标记改图编辑器（ImageEditPanel）」的唯一判定。
 *
 * 编辑器只吃静态位图：gif 会丢动画、svg 不是像素图，都降级走系统应用打开。
 * 2026-09-07 收口前这条判定在成果卡 / 成果弹层（行式 + 图块）/ composer 附件卡 /
 * 附件 adapter / 会话图库各手抄一份，加一个格式要改六处，漏一处就会出现
 * 「图库肯给『改这张』、成果卡却拒绝」这种两边打架。别再内联 ext === 'png' …。
 */
export const EDITABLE_IMAGE_EXTS: ReadonlySet<string> = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp'
])

/** ext 不带点、任意大小写。 */
export function isEditableImageExt(ext: string): boolean {
  return EDITABLE_IMAGE_EXTS.has(ext.toLowerCase())
}
