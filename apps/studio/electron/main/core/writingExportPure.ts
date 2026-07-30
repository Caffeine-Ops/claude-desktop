// 写作导出的纯逻辑（零 IO、零 electron 依赖），单独拆出来是为了能被 bun test 直接
// import——writingExport.ts 顶部 `import { dialog, type BrowserWindow } from 'electron'`，
// 在没有 Electron 运行时的 bun test 进程里会直接炸掉整个 import（同 appSettings.ts /
// appSettingsNormalize.ts 的拆分理由）。

/**
 * 默认文件名净化：去掉路径分隔符与首尾空白，空则回退「文稿」。保存对话框的默认文件名
 * 不该带目录（用户粘贴/AI 生成的标题理论上可能混进 `/`、`\`），也不该是空串（原生保存框
 * 对空 defaultPath 的行为因平台而异，不如统一兜底成一个可见占位）。
 */
export function sanitizeBaseName(name: string): string {
  const s = (name ?? '').replace(/[/\\]/g, '_').trim()
  return s.length > 0 ? s : '文稿'
}
