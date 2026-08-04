// 写作导出的纯逻辑（零 IO、零 electron 依赖），单独拆出来是为了能被 bun test 直接
// import——writingExport.ts 顶部 `import { dialog, type BrowserWindow } from 'electron'`，
// 在没有 Electron 运行时的 bun test 进程里会直接炸掉整个 import（同 appSettings.ts /
// appSettingsNormalize.ts 的拆分理由）。

import { isAbsolute, parse as parsePath, sep } from 'node:path'

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
 * `node:path` 已经按当前平台的分隔符规则正确工作（win32 用反斜杠、posix 用正斜杠），用它
 * 比再手搓一套「假装自己不知道宿主 OS」的归一化更准确，也少一份要跟渲染侧逐字对齐、否则
 * 悄悄漂移的重复逻辑（本文件其它函数头注释里反复出现的同一类教训）。
 *
 * 【2026-08-04 code review：算法从 `path.resolve` + `startsWith` 改成与渲染侧同款的「段栈
 * 模拟」】起初图省事直接用 `resolve(base, src)` 算结果、`resolved.startsWith(baseParent +
 * sep)` 判断有没有越界——但新增的跨进程 parity 测试（writingAssetPathParity.test.ts）当场
 * 拍出两处坏输入：① `baseParent` 恰好是文件系统根（`base` 是根下第一层目录，如 `/drafts`）
 * 时自身已收尾分隔符，`+ sep` 拼出 `//`，任何真实子路径都通不过 `startsWith`，单层 `..`
 * 本该放行却被误判越界；② 反过来，`base` 越浅、`resolve()` 对越界的 `..` 会在根处「钝化」
 * （多余的 `..` 到根就不再往上，不会报错也不会变成负数深度），导致 `resolved` 仍然落在
 * `baseParent` 子树内、`startsWith` 检查形同虚设，两层 `..` 本该拒绝却被放行。两个坏输入
 * 都出在「边界」上，根因是拿字符串前缀匹配去模拟一个本质是「栈深度」的判断。改成显式的段
 * 栈模拟（与渲染侧算法结构对齐，只是分隔符/取根方式各用各的工具）后两个问题一次性消失，
 * 且两侧现在是同一个算法的两份实现，天然不会再在边界值上分叉。
 *
 * 「不越界」安全阀比渲染侧更紧：只放行【一层】`..`（`drafts → images` 这两个兄弟目录的
 * 唯一合法场景），多跳一层就判非法——渲染侧的输出只是拼一个字符串交给 `writingasset://`
 * 协议，那个协议还有自己的 `/images/` 白名单二次把关（见 writingAssetProtocol.ts）；这里的
 * 输出会被直接喂进 `readFileSync` 塞进交付 Word/PDF，没有第二道闸，值得钉一个只覆盖「唯一
 * 合法场景」的更紧边界。
 *
 * @param base 资产基准目录的绝对路径（如 `<项目>/drafts`）。非绝对路径 / 空 → 原样返回 src
 *   （不做无意义的相对解析——项目侧调用方恒传绝对目录，非绝对多半是调用方没传 assetBaseDir）。
 * @param src markdown 里写的原始 src。非 `./` / `../` 开头（绝对路径、http(s) 外链……）原样返回。
 */
export function resolveWritingAssetPath(base: string | undefined, src: string): string {
  // typeof 守卫（2026-08-04 code review 补）：base 来自 IPC payload，类型标注是编译期约束，
  // 不是运行期保证——一个非串真值（畸形 payload / 未来某次改动传错类型）若只挡在 `!base`，
  // 会一路走到 `isAbsolute(非串)` 抛 TypeError，让整条导出 reject。提前挡在这里，比指望每个
  // 调用方各自守一遍更可靠（IPC handler 侧另有一道同款守卫，双保险不冲突）。
  if (typeof base !== 'string' || !base || typeof src !== 'string' || !src) return src
  if (!src.startsWith('./') && !src.startsWith('../')) return src
  if (!isAbsolute(base)) return src

  // 取 base 的「根」（posix 恒为 '/'；win32 是盘符形如 'C:\\'）与根之后的段。重建绝对路径
  // 时用 root + parts.join(sep)——不能直接对整个 base 按 sep 切分再直接 join，那样 posix
  // 下会丢失前导 '/'（'/a/b'.split('/') 产出 ['', 'a', 'b']，第一个空段过滤掉之后 join 不出
  // 前导斜杠），win32 下则要小心 'C:' 与 'Users' 之间到底该不该多插一个分隔符。用 parse().root
  // 明确切开「根」和「段」，两个平台的重建规则统一成 `root + parts.join(sep)`，不必分平台特判。
  const root = parsePath(base).root
  const baseParts = base.slice(root.length).split(sep).filter(Boolean)
  // 只放一层上跳：起始层数固定为「base 去掉最后一段」，与渲染侧 resolveRelativeAssetPath
  // 的 floor 同一语义（那边直接对 posixBase 的段数组做同款计算）。
  const floor = Math.max(0, baseParts.length - 1)
  // src 恒为 posix 形（markdown 里模型/写手产出的相对路径，不是文件系统路径字面量，与渲染侧
  // 同款前提——见 resolveRelativeAssetPath 头注释），故用 '/' 切分，不受宿主 sep 影响。
  const srcParts = src.split('/')
  for (const part of srcParts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (baseParts.length <= floor) return src // 跳出 base 的直接父目录之外——视为非法，原样返回
      baseParts.pop()
    } else {
      baseParts.push(part)
    }
  }
  return root + baseParts.join(sep)
}
