// 写作导出的纯逻辑（零 IO、零 electron 依赖），单独拆出来是为了能被 bun test 直接
// import——writingExport.ts 顶部 `import { dialog, type BrowserWindow } from 'electron'`，
// 在没有 Electron 运行时的 bun test 进程里会直接炸掉整个 import（同 appSettings.ts /
// appSettingsNormalize.ts 的拆分理由）。

// Windows 保留字符（含路径分隔符）：这几个字符在 NTFS 文件名里非法，Windows 原生保存框
// 会直接拒绝、报「文件名语法不正确」。**macOS/Linux 上这些字符本来是合法文件名字符**（比如
// `Q3 报告: 增长分析` 在 mac 上能正常存盘），但项目确实打 Windows 包（package.json 有
// build:win + nsis target），且导出物的典型用途是发给别人/换机器打开——统一净化、不分平台
// 特判，换来的是「在任何一台机器上生成的默认文件名，在任何一台机器上都能直接保存」，比
// 「在我这台机器上合法」更值。默认文件名来自 markdown 一级标题（AI/用户写的自然语言），
// 半角冒号/问号/引号是常态，不是边界情况。
const WINDOWS_ILLEGAL_CHARS_RE = /[/\\:*?"<>|]/g

// Windows 保留设备名：即便加了扩展名，`CON.docx` 这类文件在 Windows 上依然无法创建
// （系统认的是不含扩展名的主干）。不区分大小写整串匹配——净化到这一步时已经不含扩展名，
// 直接比对主干即可。命中后追加下划线而非整体回退「文稿」：「CON_」仍能让用户认出这是
// 他那份「CON」标题的稿子，回退成「文稿」会丢失这点线索、且多份撞车时更难分辨。
const RESERVED_DEVICE_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

// Windows 单个路径组件上限 255 字符，但保存框的 defaultPath 还要拼上用户选的目录路径，
// 不能把额度全占满；80 字符也已经长到没有人会把它当「文件名」看待（更像是把标题整段搬过来），
// 留出充分余量的同时对用户也是合理上限。
const MAX_BASENAME_LENGTH = 80

/**
 * 默认文件名净化：Windows 保留字符/设备名 + 路径分隔符 + 首尾空白 + 开头的点 + 超长截断，
 * 空则回退「文稿」。保存对话框的默认文件名不该带目录分隔符（用户粘贴/AI 生成的标题理论上
 * 可能混进 `/`、`\`），也不该是空串（原生保存框对空 defaultPath 的行为因平台而异，不如统一
 * 兜底成一个可见占位）。
 *
 * 处理顺序：①替换非法字符 ②trim ③去掉开头的点（避免在 Unix 上变成隐藏文件——`.周报` 存盘后
 * 在 Finder/ls -a 之外直接“消失”，用户会以为导出失败了）④再 trim 一次（去点后可能露出新的
 * 前导空白）⑤空串在这里就回退，避免下面的保留名判断对空串做无意义匹配 ⑥保留设备名判断
 * ⑦按【码点】而非 UTF-16 码元截断长度——`.slice(0, n)` 是按码元切，会把代理对（surrogate
 * pair，如大多数 emoji、部分生僻字）从中间劈开，切完再显示会看到乱码替换符 `�`；展开成
 * 数组（`[...s]`）后再 slice 是按码点操作，任何字符不会被劈半。
 */
export function sanitizeBaseName(name: string): string {
  let s = (name ?? '')
    .replace(WINDOWS_ILLEGAL_CHARS_RE, '_')
    .trim()
    .replace(/^\.+/, '')
    .trim()
  if (s.length === 0) return '文稿'
  if (RESERVED_DEVICE_NAME_RE.test(s)) s = `${s}_`
  const codePoints = [...s]
  if (codePoints.length > MAX_BASENAME_LENGTH) {
    s = codePoints.slice(0, MAX_BASENAME_LENGTH).join('')
  }
  return s
}
