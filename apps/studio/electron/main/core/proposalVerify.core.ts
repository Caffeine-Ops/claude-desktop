import {
  parseCitations,
  parseImages,
  trigramOverlap,
  PROPOSAL_SECTION_RE,
  USER_SUPPLIED_SOURCE,
  type CitationVerdict,
  type ImageVerdict,
  type SectionVerification
} from '../../shared/proposal'
import { isProposalAssetPath } from '../../shared/proposalAsset'

/**
 * 「这段正文是否真出自所引原文」的支持阈值：段落正文的字符 trigram 有多大比例出现在
 * 所引文件原文里，≥ 此值判 supported。0.5 是保守初值——本功能立身于「忠实搬运」，AI
 * 本应在拷原文、重叠应很高；调低会放过更多改写/编造，调高会误报正常的轻微归纳。后续
 * 可据人工核对基线（backlog M-0）调参。
 */
export const TRIGRAM_THRESHOLD = 0.5

/**
 * 可靠核对所需的最小正文长度（去空白字符数）。低于此的极短段——如引用组间的「。」、章节
 * 小标题式的「概述」——没有可靠的 trigram 信号：trigramOverlap 对 <3 字退化为「子串判定」，
 * 短串几乎恒命中返 1，若直接信它会让这类段恒判 supported、绕过编造核对（评审发现）。故过短
 * 段一律【不给 supported 绿灯】，落 unsupported 提示人工核对（客户级方案宁可误报、不可漏报）。
 * 取 3 与 trigram 的 3-gram 边界一致：恰好 3 字起就有真 trigram、走正常重叠核对。
 */
const MIN_VERIFIABLE_CHARS = 3

/**
 * verifyCitations 的纯核心：不碰 fs / electron / 索引，只靠注入的 `resolveContent` 取
 * 「某 title 的原文」。抽出来是为了能在 `bun test` 里直接单测（proposalVerify.ts 因 import
 * kbIndexStore 间接依赖 electron `app`，无法在测试进程加载）。
 *
 * 每条引用一条 verdict：
 *  - `resolveContent(file)` 返回 null（索引里没有 / 镜像读不到）→ `file-not-found`。
 *  - 否则按 trigram 重叠率与 {@link TRIGRAM_THRESHOLD} 判 `supported` / `unsupported`。
 * 无引用 → `{ verdicts: [], citedFileCount: 0 }`。citedFileCount 为去重后的引用文件数。
 *
 * 图片接地：第三参 `resolveAssets` 可选，返回某 title 文件的 assets 路径数组。若传入，
 * 对正文里的每张图判断其 path 是否属于【本节所引文件的 assets 并集】——grounded/ungrounded。
 * 无【受核对的】图时不带 imageVerdicts（向后兼容，UI 据「有无该字段」判要不要画图相关红绿；
 * 一节的图若全被草稿产出图豁免，字段同样缺省，不给空数组）。resolveAssets 缺省
 * → assets 并集为空 → 有图即 ungrounded（安全默认，宁可标红也不放过来路不明的图）。
 *
 * 注意：「索引整体不可用 → degraded」的判定在 proposalVerify.ts 包装层（要先读索引），
 * 不在本核心——本核心只处理逐文件解析。
 */
export function verifyCitationsCore(
  markdown: string,
  resolveContent: (file: string) => string | null,
  resolveAssets?: (file: string) => string[],
  // 草稿产出图的强校验谓词（真实根目录 + 存在性），由 main 包装层注入（见 proposalVerify.ts）。
  // 缺省时退回纯形状判定（isProposalAssetPath），保持纯核心可单测、旧调用不破。
  isDraftAsset?: (absPath: string) => boolean
): SectionVerification {
  const safe = typeof markdown === 'string' ? markdown : ''
  const paras = parseCitations(safe)
  const verdicts: CitationVerdict[] = []
  const citedFiles = new Set<string>()
  for (const { paragraph, files } of paras) {
    for (const file of files) {
      citedFiles.add(file)
      // 用户补料（P3-2 阶段二）：引用的是保留来源名《用户补充资料》——非 KB、无原文可 trigram
      // 核对，但属用户授权的真实资料。给独立 user-supplied 判定（不查 resolveContent、不当
      // file-not-found 红灯），仍计入 citedFiles 故不会触发「本段未标注来源」。
      if (file === USER_SUPPLIED_SOURCE) {
        verdicts.push({ file, status: 'user-supplied' })
        continue
      }
      const content = resolveContent(file)
      if (content === null) {
        verdicts.push({ file, status: 'file-not-found' })
        continue
      }
      const overlap = trigramOverlap(paragraph, content)
      // 过短段（去空白 <MIN_VERIFIABLE_CHARS）即便 overlap 达标也不判 supported：trigramOverlap
      // 对其退化为子串判定、几乎恒命中，信它即漏报。overlap 仍记真实值（它确实可能=1，只是段
      // 太短不足以据此判忠实搬运）——status 与 overlap 不矛盾：重叠高但样本过短，故不予绿灯。
      const tooShort = paragraph.replace(/\s+/g, '').length < MIN_VERIFIABLE_CHARS
      verdicts.push({
        file,
        status: !tooShort && overlap >= TRIGRAM_THRESHOLD ? 'supported' : 'unsupported',
        overlap
      })
    }
  }

  // 图片接地：图必属本节所引文件（citedFiles）的 assets 并集。无图 → 不带 imageVerdicts
  // （向后兼容，UI 据「有无该字段」决定要不要画图相关红绿）。resolveAssets 缺省 → 并集为空
  // → 有图即 ungrounded（安全默认：宁可标红也不放过来路不明的图）。
  //
  // 例外：草稿产出图（改图/文生图/上传，路径落在 proposal-drafts/*/assets 下，见
  // isProposalAssetPath）不是 KB 图，压根不该拿「是否属所引文件 assets」去核对——它们由用户
  // 当场生成/上传，来源就是用户本人，不存在挪用/编造问题。故短路：既不判 grounded（没查、
  // 不能瞎标绿）也不判 ungrounded（不能标红吓用户），直接不产出该图的 verdict。
  //
  // 但豁免不能只看路径形状（评审 CONFIRMED）：改图后整节 markdown 会回灌给 AI 重产，AI
  // 复读/篡改/幻造 proposal-drafts 形路径是常态流。纯子串判定会让幻造路径无声跳过校验——
  // 绿横幅 + 预览 403 + 导出静默降级，恰好绕开「宁可标红」底线。故形状命中后还要过注入的
  // isDraftAsset（真实草稿根 + 存在性）；不过 → 掉回正常接地判定（必 ungrounded 标红）。
  const images = parseImages(safe)
  let imageVerdicts: ImageVerdict[] | undefined
  if (images.length > 0) {
    const allowed = new Set<string>()
    for (const f of citedFiles) for (const a of resolveAssets?.(f) ?? []) allowed.add(a)
    const verdictList: ImageVerdict[] = []
    for (const img of images) {
      if (isProposalAssetPath(img.path) && (isDraftAsset ? isDraftAsset(img.path) : true)) continue
      verdictList.push({
        path: img.path,
        status: allowed.has(img.path) ? ('grounded' as const) : ('ungrounded' as const)
      })
    }
    // 全部被豁免时置回 undefined——契约是「imageVerdicts 字段存在 ⇔ 本节有受核对的图」，
    // 空数组是真值、会让按字段有无分支的消费方把「没核对」当「已核对」（评审发现）。
    imageVerdicts = verdictList.length > 0 ? verdictList : undefined
  }

  const base: SectionVerification = { verdicts, citedFileCount: citedFiles.size }
  return imageVerdicts ? { ...base, imageVerdicts } : base
}

/**
 * 把（docx 模式带 `<!--proposal-section:*-->` 标记的）整篇方案 markdown 按标记切成各节字符串，
 * 标记行本身剔除。无标记（裸 markdown / .md 模式）→ 整篇当一节。空串 → []。纯函数、可单测。
 * 接地是 per-section 概念（图必属【本节】所引文件 assets），故汇总 ungrounded 前要先按节切。
 */
export function splitMarkdownBySections(markdown: string): string[] {
  const safe = typeof markdown === 'string' ? markdown : ''
  if (!safe) return []
  const out: string[] = []
  let current: string[] = []
  let sawMark = false
  for (const line of safe.split('\n')) {
    if (PROPOSAL_SECTION_RE.test(line.trim())) {
      sawMark = true
      if (current.length) out.push(current.join('\n'))
      current = []
    } else {
      current.push(line)
    }
  }
  if (current.length) out.push(current.join('\n'))
  return sawMark ? out : [safe]
}

/**
 * 导出/预览闸门用：对整篇方案 markdown 按节算图片接地，汇总所有【未接地】图的绝对路径。
 * 每节复用 {@link verifyCitationsCore} 的 per-section 接地判定，故结论与 UI 红条同源一致。
 * 注入式 resolve（同 verifyCitationsCore），不碰 fs/electron，可纯单测；main 的 IO 包装见
 * proposalVerify.ts。接地只用 citedFiles + assets，不读 content，故调用方可对 resolveContent
 * 传 `() => null`（citation verdicts 在此被丢弃，只取 imageVerdicts）。
 *
 * 返回的是【路径全集】（不分节）：imageParagraphs 按 path 查它。若同一 path 图在某节判
 * ungrounded、另一节判 grounded，保守取「只要任一节未接地即降级」——符合「宁可多降级也不放过
 * 来路不明的图」的安全默认（同一图跨节且接地结论相反极罕见）。
 */
export function collectUngroundedImagePathsCore(
  markdown: string,
  resolveContent: (file: string) => string | null,
  resolveAssets: (file: string) => string[],
  isDraftAsset?: (absPath: string) => boolean
): Set<string> {
  const out = new Set<string>()
  for (const section of splitMarkdownBySections(markdown)) {
    const v = verifyCitationsCore(section, resolveContent, resolveAssets, isDraftAsset)
    for (const iv of v.imageVerdicts ?? []) {
      if (iv.status === 'ungrounded') out.add(iv.path)
    }
  }
  return out
}
