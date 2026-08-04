// 写作导出的纯逻辑（零 IO、零 electron 依赖），单独拆出来是为了能被 bun test 直接
// import——writingExport.ts 顶部 `import { dialog, type BrowserWindow } from 'electron'`，
// 在没有 Electron 运行时的 bun test 进程里会直接炸掉整个 import（同 appSettings.ts /
// appSettingsNormalize.ts 的拆分理由）。

import { isAbsolute, resolve, sep } from 'node:path'

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

/**
 * 把写作正文里的相对图路径（`../images/x.png` / `./x.png`）解析成绝对路径，供 docx/PDF
 * 导出的嵌图分支（proposalDocx.ts 的 blockToDocx）在 `readFileSync` 前调用。
 *
 * 与渲染侧 `resolveRelativeAssetPath`（src/chat/lib/writingAssetUrl.ts）同一语义，但**不
 * 直接复用那份实现**：那份是手写的纯 posix 语义解析——之所以手写，是因为渲染进程（Chromium
 * 沙箱里的前端代码）拿不到 `node:path`。main 进程没有这层限制，天生跑在真实宿主 OS 上，
 * `node:path` 已经按当前平台的分隔符规则正确工作（win32 用反斜杠、posix 用正斜杠、混合输入
 * 也能正确切分），用它比再手搓一套「假装自己不知道宿主 OS」的归一化更准确，也少一份要跟
 * 渲染侧逐字对齐、否则悄悄漂移的重复逻辑（本文件其它函数头注释里反复出现的同一类教训）。
 * 两侧唯一必须对齐的是下面这条「不越界」安全阀的**语义**（多深的 `..` 算越界），具体实现
 * 各写各的、用最适合自己进程的工具。
 *
 * 「不越界」安全阀比渲染侧更紧：渲染侧允许 `..` 一路弹到 base 的所有上级层数（受 base 自身
 * 深度限制，base 越深能跳得越高）；这里直接把解析结果钉死在 **base 的直接父目录**子树内
 * （不能比 `drafts → images` 这类兄弟目录跳跃更深）。理由——渲染侧的输出只是拼一个字符串
 * 交给 `writingasset://` 协议，那个协议还有自己的 `/images/` 白名单二次把关（见
 * writingAssetProtocol.ts）；这里的输出会被直接喂进 `readFileSync` 塞进交付 Word/PDF，没有
 * 第二道闸，值得钉一个只覆盖「唯一合法场景」的更紧边界，堵死其余可能的路径穿越。
 *
 * @param base 资产基准目录的绝对路径（如 `<项目>/drafts`）。非绝对路径 / 空 → 原样返回 src
 *   （不做无意义的相对解析——项目侧调用方恒传绝对目录，非绝对多半是调用方没传 assetBaseDir）。
 * @param src markdown 里写的原始 src。非 `./` / `../` 开头（绝对路径、http(s) 外链……）原样返回。
 */
export function resolveWritingAssetPath(base: string | undefined, src: string): string {
  if (!base || !src) return src
  if (!src.startsWith('./') && !src.startsWith('../')) return src
  if (!isAbsolute(base)) return src
  const resolved = resolve(base, src)
  const baseParent = resolve(base, '..')
  if (resolved !== baseParent && !resolved.startsWith(baseParent + sep)) return src // 越界，原样返回未解析的 src
  return resolved
}
