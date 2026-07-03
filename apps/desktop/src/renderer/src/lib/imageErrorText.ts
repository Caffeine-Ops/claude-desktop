// 出图/改图失败的统一错误分流（原在 ProposalPaper 内，genimage 自动发起管线也要用，抽到 lib
// 单一事实源）。可操作的错误按语义引导（缺配置 → 去设置；认证失败/格式不可嵌 → 透传 main 的
// 中文原文，它们本身就写给用户看）；其余归到按 mode 的泛化提示。
export function friendlyImageError(err: unknown, mode: 'edit' | 'generate' | 'directive'): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('未配置')) return '尚未配置出图 API，请到设置里填写 key 与地址后再试。'
  if (message.includes('认证失败') || message.includes('无法嵌入 Word')) return message
  return mode === 'edit' ? '改图失败，请稍后重试。' : '生成失败，请稍后重试。'
}
