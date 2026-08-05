// 写作导出的纯逻辑（零 IO、零 electron 依赖），单独拆出来是为了能被 bun test 直接
// import——writingExport.ts 顶部 `import { dialog, type BrowserWindow } from 'electron'`，
// 在没有 Electron 运行时的 bun test 进程里会直接炸掉整个 import（同 appSettings.ts /
// appSettingsNormalize.ts 的拆分理由）。

import nodePath, { type PlatformPath } from 'node:path'

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
 * `node:path` 按当前平台的分隔符规则解析【单一分隔符风格】的输入是对的（win32 认反斜杠、
 * posix 认正斜杠），用它比再手搓一套「假装自己不知道宿主 OS」的归一化更准确，也少一份要跟
 * 渲染侧逐字对齐、否则悄悄漂移的重复逻辑（本文件其它函数头注释里反复出现的同一类教训）——
 * 但【`node:path` 不会替调用方兜底混合分隔符输入】，这条留在下面第三轮 review 的注释里，
 * 别再想当然。
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
 * 【2026-08-04 第三轮 code review：base 必须先归一化分隔符，否则 win32 上算错目录】
 * `base` 是 `writingAssetBaseDir()`（渲染侧，`src/chat/lib/writingAssetUrl.ts`）用字符串
 * 拼接产出的——`` `${projectDir}/drafts` `` 硬编码正斜杠拼在 `projectDir`（来自 CLI stdout，
 * Windows 上是原生反斜杠）后面，结果 main 侧收到的 base 在 Windows 上恒为**混合分隔符**
 * （如 `C:\Users\k\稿子/drafts`）。上一版实现按段切分时只认 `sep`（win32 上是 `\`），
 * `稿子/drafts` 这种夹着正斜杠的尾段会被当成【一整段】，一个 `..` 就多弹一级——审查者用
 * `path.win32` 模拟 31 组输入，31 组里 15 组语义分歧，是本轮修复里最严重的一次回归（比
 * 「预览有图、导出没图」更糟：还可能撞上上一级目录里同名文件、静默嵌入错误的图）。
 *
 * 修法：切段前用【逐字符替换】（`/[\\/]/g`，不是 `+` 合并）把 `/` 和 `\` 都统一成 `sep`——
 * 逐字符而非合并连续分隔符是为了不破坏 UNC 路径的双反斜杠前缀（`\\srv\share\...` 的开头两个
 * `\` 各自独立替换成 `sep`，仍然是两个字符，前缀语义不丢）；只在 `sep === '\\'`（即 win32，
 * 包括下面测试用 `path.win32` 注入的场景）时才做这个替换——posix 上 `sep` 本来就是 `/`，若
 * 无差别地把 `\` 也替换成 `/`，会把 posix 文件名里合法的字面反斜杠字符（虽罕见但确实合法）
 * 错当分隔符切开，这不是要修的问题，反而会引入新问题。
 *
 * 【可测试性：注入 path 实现】`isAbsolute`/`parse`/`sep` 默认绑定宿主平台的 `node:path`，
 * 但本项目要出 Windows 包、bug 恰恰出在 win32 分支。
 *
 * 【2026-08-04 第四轮收尾更正】这里曾经写着「单测机器（CI/本地）几乎都是 posix」——这个
 * 前提对本仓库是错的：`.github/workflows/build.yml` 的 build 矩阵明确有 windows-latest
 * 一条腿，且**每条腿都跑同一份 `bun test`**（没有 `continue-on-error`，Windows 腿红了会
 * 卡住发版）。真实教训是反过来的：`bun test` 在本地开发机上多半跑在 posix（mac/Linux），
 * 但在 CI 的 Windows 腿上宿主原生就是 `path.win32`——`isAbsolute`/`parse`/`sep` 默认绑定
 * 的 `node:path` 会随 CI 跑在哪条腿而变、不是恒定的。断言里但凡写死了 posix 形态的期望值
 * （比如 `'/p/稿子/images/a.png'`）却不显式传 `pathImpl`，本地绿、Windows CI 红——这正是
 * 2026-08-04 第四轮收尾修的那批红灯（`writingExportPure.test.ts` 3 条 + 跨进程对拍
 * `writingAssetPathParity.test.ts` 3 条），根因就是想当然地假设了「测试机器是什么系统」。
 * 故这里的规矩是：**任何断言目标平台特定分隔符形态的用例，一律显式传 `pathImpl`
 * （`path.posix`/`path.win32`），不依赖跑测试的机器恰好是什么系统**——生产环境不传，用
 * 宿主原生 `node:path`；测试传 `path.win32`/`path.posix`，精确复现目标平台的
 * `isAbsolute`/`parse`/`sep` 语义。
 *
 * @param base 资产基准目录的绝对路径（如 `<项目>/drafts`）。非绝对路径 / 空 → 原样返回 src
 *   （不做无意义的相对解析——项目侧调用方恒传绝对目录，非绝对多半是调用方没传 assetBaseDir）。
 * @param src markdown 里写的原始 src。非 `./` / `../` 开头（绝对路径、http(s) 外链……）原样返回。
 * @param pathImpl 可选，默认宿主原生 `node:path`；测试传 `path.win32`/`path.posix` 精确复现
 *   目标平台语义，见上方「可测试性」段。
 */
export function resolveWritingAssetPath(
  base: string | undefined,
  src: string,
  pathImpl: Pick<PlatformPath, 'isAbsolute' | 'parse' | 'sep'> = nodePath
): string {
  // typeof 守卫（2026-08-04 code review 补）：base 来自 IPC payload，类型标注是编译期约束，
  // 不是运行期保证——一个非串真值（畸形 payload / 未来某次改动传错类型）若只挡在 `!base`，
  // 会一路走到 `isAbsolute(非串)` 抛 TypeError，让整条导出 reject。提前挡在这里，比指望每个
  // 调用方各自守一遍更可靠（IPC handler 侧另有一道同款守卫，双保险不冲突）。
  if (typeof base !== 'string' || !base || typeof src !== 'string' || !src) return src
  if (!src.startsWith('./') && !src.startsWith('../')) return src
  if (!pathImpl.isAbsolute(base)) return src

  const { sep } = pathImpl
  // 归一化分隔符：见函数头注释「base 必须先归一化」——只在 win32（sep 为反斜杠）时把正斜杠
  // 逐字符替换成反斜杠，posix 不动（避免误伤合法含字面反斜杠的文件名）。
  const normalizedBase = sep === '\\' ? base.replace(/[\\/]/g, sep) : base

  // 取 base 的「根」（posix 恒为 '/'；win32 是盘符形如 'C:\\'）与根之后的段。重建绝对路径
  // 时用 root + parts.join(sep)——不能直接对整个 base 按 sep 切分再直接 join，那样 posix
  // 下会丢失前导 '/'（'/a/b'.split('/') 产出 ['', 'a', 'b']，第一个空段过滤掉之后 join 不出
  // 前导斜杠），win32 下则要小心 'C:' 与 'Users' 之间到底该不该多插一个分隔符。用 parse().root
  // 明确切开「根」和「段」，两个平台的重建规则统一成 `root + parts.join(sep)`，不必分平台特判。
  const root = pathImpl.parse(normalizedBase).root
  const baseParts = normalizedBase.slice(root.length).split(sep).filter(Boolean)
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

/** 正文里一处「解析得出绝对路径、但磁盘上没有」的配图引用。 */
export interface MissingWritingImage {
  /** markdown 里原样写的 src——报给用户看的就是这个，与他在正文里看到的一致。 */
  src: string
  /** 解析后的绝对路径，即「该把文件放到哪」。 */
  resolved: string
}

// 图片语法。两种目标形态都要认：裸路径 `![a](../x.png)`，以及含空格时被 `<>` 包起来的
// `![a](<../我 的 图.png>)`——后者是 normalizeImageMarkdown 的产出形态（不补 `<>` 的话
// remark 不把它解析成 image 节点，图会整个丢掉），闸若只认裸形态就会对含空格的图恒放行。
// 与 proposal.ts / writingWechatCopyMsg.ts 的同类正则同一套取舍：不做 markdown AST 解析，
// 图片语法足够简单，正则够用。
const WRITING_IMAGE_RE = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))[^)]*\)/g

// 外链与内联数据：不是本地文件，就位闸管不着（也不该拦——用户把图挂在 CDN 上是合法用法）。
const REMOTE_SRC_RE = /^(?:https?:|data:)/i

/**
 * 导出前的「图片就位闸」：扫正文里全部配图引用，返回**解析得出绝对路径、但磁盘上不存在**的那些。
 *
 * 与 `skills/writing/scripts/export.py` 的 `missing_images` 同职责——那条闸只护住「AI 跑脚本
 * 导出」这一条路，右栏三个导出按钮走的是本进程这条链，2026-08-05 真机走查发现它当时没有闸：
 * 把图挪走后导出照常成功、产出无图的 docx、界面报绿色「已导出」。
 *
 * 【为什么解析不出绝对路径的不算缺失】single 模式（打开单个 .md 而非项目）恒无 assetBaseDir，
 * 相对路径解析不出来。那条路径的既定行为是「图片降级为文字占位」（见 markdownToDocxBuffer 的
 * assetBaseDir 注释），不是错误；在这里报缺会把 single 模式的每一次导出都挡死。
 * **无法验证 ≠ 缺失**——闸只对「能确定它该在哪、而它确实不在」的情况开火。
 *
 * @param exists 存在性判定，由调用方注入（main 传 `fs.existsSync`）。本模块零 IO，见文件头注释。
 * @param pathImpl 见 resolveWritingAssetPath 同名参数——测试必须显式传，别赌跑测试的机器是什么系统。
 */
export function findMissingWritingImages(
  markdown: string,
  assetBaseDir: string | undefined,
  exists: (absPath: string) => boolean,
  pathImpl: Pick<PlatformPath, 'isAbsolute' | 'parse' | 'sep'> = nodePath
): MissingWritingImage[] {
  if (typeof markdown !== 'string' || !markdown) return []
  const out: MissingWritingImage[] = []
  // 同一张图被引用多次只报一次：清单是给人照着补图用的，重复项只会让人数不清到底缺几张。
  const seen = new Set<string>()
  for (const m of markdown.matchAll(WRITING_IMAGE_RE)) {
    const src = (m[1] ?? m[2] ?? '').trim()
    if (!src || REMOTE_SRC_RE.test(src)) continue
    const resolved = resolveWritingAssetPath(assetBaseDir, src, pathImpl)
    // 原样返回 = 没解析成（没传 base / 非相对路径 / 上跳越界）。绝对路径则照常检查。
    if (!pathImpl.isAbsolute(resolved)) continue
    if (seen.has(resolved)) continue
    seen.add(resolved)
    if (!exists(resolved)) out.push({ src, resolved })
  }
  return out
}
