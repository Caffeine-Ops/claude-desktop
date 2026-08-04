/**
 * 把「写作项目配图的绝对路径」转成 `writingasset://` URL 供 <img> 加载。
 * 与 toKbAssetUrl / toProposalAssetUrl 并列：三者的路径特征互斥
 * （KB 图含 /kb-index/assets/、提案产出图含 /proposal-drafts/ + /assets/、
 * 写作配图含 /images/ 且不在前两者之下），所以调用方可以无脑链式尝试，
 * 不需要按场景传参决定用哪个。
 *
 * 判定谓词与 main 侧的 isWritingAssetPath 是同一套规则的两份实现——本文件
 * 不能 import main 侧模块（渲染进程拿不到 node:path）。两处规则若漂移，
 * 症状是「渲染侧转了 URL、main 侧判越界回 403」，图空白但控制台有 403，
 * 可查。改任一侧务必同步另一侧。
 */

import type { WritingDocSource } from '@desktop-shared/writing'

// 只服务位图与 svg，与 main 侧 writingAssetProtocol.ts 的白名单同步。
const ALLOWED_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

/**
 * win32 反斜杠路径 → 正斜杠副本，仅供判定用，不改原始字符串（toWritingAssetUrl 编码时
 * 仍用调用方传入的原始字节，main 侧按原样 decode 后落盘比对）。与 shared/proposalAsset.ts、
 * src/chat/lib/kbAssetUrl.ts 的 toPosix 同款处理——这是仓库里判定本地资产路径的统一惯例。
 */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

// posix 绝对路径以 `/` 开头；win32 绝对路径 toPosix 后形如 `C:/Users/...`，以
// "<盘符>:/" 开头。两种都算「绝对本地路径」，用来把 http(s) 外链（`https://…`）与相对路径
// （`../images/a.png`）排除在外——它们都不该被误当写作资产转协议。
const WIN32_DRIVE_RE = /^[a-zA-Z]:\//

function isAbsoluteLocalPath(posixPath: string): boolean {
  return posixPath.startsWith('/') || WIN32_DRIVE_RE.test(posixPath)
}

/**
 * 2026-08-03 code review CONFIRMED（Important 2）：此前只认 `src.startsWith('/')`，
 * Windows 绝对路径（`C:\Users\k\稿子\images\a.png`）在这一步就被判走「不是本地资产」，
 * 后续渲染既不转 writingasset:// URL，也过不了 AssistantMarkdown 的 assetAwareUrlTransform
 * （defaultUrlTransform 把 `C:` 当未知协议整体清空成空串）——图连 src 都没有，Windows 用户
 * 整条链恒断。现在先 toPosix 再判定，posix 与 win32 绝对路径都能识别。
 */
export function isWritingAssetSrc(src: string): boolean {
  if (!src || !ALLOWED_EXT_RE.test(src)) return false
  const posix = toPosix(src)
  if (!isAbsoluteLocalPath(posix)) return false // 外链 http(s) 与相对路径都不是本地资产
  if (posix.includes('/kb-index/assets/')) return false
  if (posix.includes('/proposal-drafts/')) return false
  return posix.includes('/images/')
}

export function toWritingAssetUrl(src: string): string {
  if (!src) return src
  if (isWritingAssetSrc(src)) return `writingasset://w/${encodeURIComponent(src)}`
  return src
}

/**
 * 把写作正文里的相对图路径（`../images/gen-1.png` / `./x.png`）解析成绝对路径。
 *
 * 为什么需要这个函数（简报之外，控制者裁定补的一环）：写作正文分节文件存在
 * `<项目>/drafts/` 下，配图存在 `<项目>/images/` 下——是兄弟目录，模型写正文时
 * 引用图片天然用相对路径。而 isLocalAssetPath（kb || proposal）与本文件的
 * isWritingAssetSrc 全是绝对路径谓词，相对路径原样进三条链没有一条会命中，
 * 结果是 <img src="../images/gen-1.png"> 直接当相对 URL 加载、右栏碎图，且不
 * 报错——协议守卫从未被触发，控制台没有任何线索。AssistantMarkdown 的 img 覆写
 * 必须先把相对路径「对齐」成绝对路径，再喂给 toKbAssetUrl → toProposalAssetUrl →
 * toWritingAssetUrl 那条链。
 *
 * 只手写 posix 语义（`/` 分隔、`..` 出栈、`.`/空段跳过）：渲染进程（Chromium
 * 沙箱里的前端代码）拿不到 `node:path`，不能借 path.posix.resolve/normalize；
 * 而写作正文里的相对路径本身也恒为 posix 形（模型产出、不是文件系统路径字面量）。
 * `base`（写作项目所在的操作系统目录）先 toPosix 再拼接——2026-08-03 code review
 * 指出的 Important 2：win32 上 `base.split('/')` 曾经把整条反斜杠路径当一段切不开，
 * `..` 一下把它 pop 光，结果返回 `images/a.png` 这种脱离 base 的裸相对路径。拼接结果
 * 统一吐 posix 分隔符（哪怕 base 是反斜杠输入）——这不影响后续正确性：main 侧
 * `existsSync(normalize(...))`（Node 的 path.normalize 在 win32 上把 `/` 也当合法
 * 分隔符处理）能吃下这种混合形态；这里只负责拼出「对不对」，不负责「像不像原生路径」。
 *
 * @param base 资产基准目录的绝对路径（如 `<项目>/drafts`，不带末尾斜杠）。
 *   空串表示调用方未提供 assetBaseDir（AssistantMarkdown 默认不传）——原样返回，
 *   这是「未传 assetBaseDir 时行为逐字不变」硬要求的落地点。
 * @param src markdown 里写的原始 src。非 `./` / `../` 开头（绝对路径、http(s) 外链、
 *   protocol:// URL……）一律原样返回，只有相对路径才需要这步。
 *
 * `..` 越界裁定（2026-08-04 code review Important 2 收紧）：只放行【一层】上跳
 * （`../images/x.png`，drafts → images 这两个兄弟目录的唯一合法场景），超过一层一律
 * 视为非法输入，原样返回未解析的 src。
 *
 * 【为什么从「放行 base 的所有上级层数」收紧到「只放一层」】此前的规则是「baseParts 弹空
 * 才算越界」，即 base 越深、允许 `..` 弹得越多——`base='/p/proj/drafts'` 时
 * `../../images/x.png` 曾被这份实现解析成功（`/p/images/x.png`），但 main 侧导出用的
 * `resolveWritingAssetPath`（electron/main/core/writingExportPure.ts）从一开始就只放一层
 * （钉死在 base 的直接父目录子树内，因为它的输出直接喂 `readFileSync` 塞进交付 Word/PDF，
 * 没有第二道闸）。两侧标准不一致的后果是真实的「预览=导出」破口：`../../images/x.png` 在
 * 预览里能解析出绝对路径、`writingasset://` 协议放行显示（该协议的白名单只查
 * 「含 /images/、扩展名合法」，不检查有没有走出项目目录）→ 图正常显示；导出时 main 侧判越界、
 * 原样返回相对串 → `readFileSync` 找不到 → 降级文字占位。同一张图，预览有、导出没有，
 * 且全程零报错——这正是 `proposalDocx.ts` 里 imageParagraphs 注释写的那条不变量
 * （"绝不出现『预览有图、成品 Word 没图』的静默丢失"）想堵住却被从外面绕过的情形。收紧
 * 到与 main 侧同一条边界后，这条不变量在两侧都成立。
 *
 * （2026-08-03 code review Minor 6 原始动机仍然成立，只是边界从「base 的所有上级层数」改
 * 收紧到「一层」：`base='/a'` + `src='../../../images/x.png'` 不该静默逃逸到 `/images/x.png`
 * 这样一个看似合法实则不相关的绝对路径——返回原样 src，后续链式判定统统不命中，图刷不出来，
 * 比算出一个不受控的绝对路径更安全。）
 */
export function resolveRelativeAssetPath(base: string, src: string): string {
  if (!base) return src
  if (!src.startsWith('./') && !src.startsWith('../')) return src

  const posixBase = toPosix(base)
  const baseParts = posixBase.split('/').filter(Boolean)
  // 只放一层上跳：起始层数固定为「base 去掉最后一段」，与 main 侧 resolveWritingAssetPath
  // 的 `resolve(base, '..')` 边界同一语义。低于这个楼层的 '..' 一律判越界。
  const floor = Math.max(0, baseParts.length - 1)
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

  // posixBase 是绝对路径（AssistantMarkdown 调用方恒传绝对目录）才补前导 '/'；
  // win32 盘符形态（`C:/Users/...`）本身已含「绝对」语义，不需要再补前导 '/'。
  const prefix = posixBase.startsWith('/') ? '/' : ''
  return prefix + baseParts.join('/')
}

/**
 * project/single 两种 {@link WritingDocSource} → 相对图路径解析的基准目录（`../images/x.png`
 * 就靠这个 base 走 {@link resolveRelativeAssetPath}）。**一处算，三处用**（纸面预览
 * WritingPaper.tsx + 右栏导出 WritingDocPanel.tsx 的 docx/PDF 两条导出链）——此前只有
 * WritingPaper.tsx 内联一份三元表达式，导出链本该抄同一条规则却各写各的，是任务书之外
 * 由控制者裁定要补的一环（task-7）。
 *
 * single 模式故意返回 undefined、不猜一个目录出来：单文件模式没有 `<项目>/drafts` 这层
 * 结构（source.filePath 就是文件本身，没有「项目根」可言），配图功能整体也只支持项目模式
 * （WRITING_IMAGE_GENERATE 只在 project 模式下触发，见 writingGenImageFire.ts）——single
 * 模式下正文里本就不该出现相对路径图。留空是安全的兜底：调用方（resolveRelativeAssetPath /
 * main 侧 resolveWritingAssetPath）在 base 为空时原样返回 src，未解析的相对路径过不了后续
 * 任何一条 asset 协议判定，最终只是那张图刷不出来／降级文字占位，不会算出一个臆测的、
 * 实际不存在的目录。
 */
export function writingAssetBaseDir(source: WritingDocSource | null): string | undefined {
  return source && source.kind === 'project' ? `${source.projectDir}/drafts` : undefined
}
