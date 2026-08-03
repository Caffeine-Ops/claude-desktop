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
const ALLOWED_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

export function isWritingAssetSrc(src: string): boolean {
  if (!src || !ALLOWED_EXT_RE.test(src)) return false
  if (!src.startsWith('/')) return false // 外链 http(s) 与相对路径都不是本地资产
  if (src.includes('/kb-index/assets/')) return false
  if (src.includes('/proposal-drafts/')) return false
  return src.includes('/images/')
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
 *
 * @param base 资产基准目录的绝对路径（如 `<项目>/drafts`，不带末尾斜杠）。
 *   空串表示调用方未提供 assetBaseDir（AssistantMarkdown 默认不传）——原样返回，
 *   这是「未传 assetBaseDir 时行为逐字不变」硬要求的落地点。
 * @param src markdown 里写的原始 src。非 `./` / `../` 开头（绝对路径、http(s) 外链、
 *   protocol:// URL……）一律原样返回，只有相对路径才需要这步。
 */
export function resolveRelativeAssetPath(base: string, src: string): string {
  if (!base) return src
  if (!src.startsWith('./') && !src.startsWith('../')) return src

  const baseParts = base.split('/').filter(Boolean)
  const srcParts = src.split('/')
  for (const part of srcParts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (baseParts.length > 0) baseParts.pop()
    } else {
      baseParts.push(part)
    }
  }

  // base 是绝对路径（AssistantMarkdown 调用方恒传绝对目录）才补前导 '/'；
  // 理论上 base 若是相对路径也不报错，只是拼出的结果同样是相对的。
  const prefix = base.startsWith('/') ? '/' : ''
  return prefix + baseParts.join('/')
}
