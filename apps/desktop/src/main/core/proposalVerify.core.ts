import {
  parseCitations,
  parseImages,
  trigramOverlap,
  type CitationVerdict,
  type ImageVerdict,
  type SectionVerification
} from '../../shared/proposal'

/**
 * 「这段正文是否真出自所引原文」的支持阈值：段落正文的字符 trigram 有多大比例出现在
 * 所引文件原文里，≥ 此值判 supported。0.5 是保守初值——本功能立身于「忠实搬运」，AI
 * 本应在拷原文、重叠应很高；调低会放过更多改写/编造，调高会误报正常的轻微归纳。后续
 * 可据人工核对基线（backlog M-0）调参。
 */
export const TRIGRAM_THRESHOLD = 0.5

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
 * 无图时不带 imageVerdicts（向后兼容，UI 据此判要不要画图相关红绿）。resolveAssets 缺省
 * → assets 并集为空 → 有图即 ungrounded（安全默认，宁可标红也不放过来路不明的图）。
 *
 * 注意：「索引整体不可用 → degraded」的判定在 proposalVerify.ts 包装层（要先读索引），
 * 不在本核心——本核心只处理逐文件解析。
 */
export function verifyCitationsCore(
  markdown: string,
  resolveContent: (file: string) => string | null,
  resolveAssets?: (file: string) => string[]
): SectionVerification {
  const safe = typeof markdown === 'string' ? markdown : ''
  const paras = parseCitations(safe)
  const verdicts: CitationVerdict[] = []
  const citedFiles = new Set<string>()
  for (const { paragraph, files } of paras) {
    for (const file of files) {
      citedFiles.add(file)
      const content = resolveContent(file)
      if (content === null) {
        verdicts.push({ file, status: 'file-not-found' })
        continue
      }
      const overlap = trigramOverlap(paragraph, content)
      verdicts.push({
        file,
        status: overlap >= TRIGRAM_THRESHOLD ? 'supported' : 'unsupported',
        overlap
      })
    }
  }

  // 图片接地：图必属本节所引文件（citedFiles）的 assets 并集。无图 → 不带 imageVerdicts
  // （向后兼容，UI 据「有无该字段」决定要不要画图相关红绿）。resolveAssets 缺省 → 并集为空
  // → 有图即 ungrounded（安全默认：宁可标红也不放过来路不明的图）。
  const images = parseImages(safe)
  let imageVerdicts: ImageVerdict[] | undefined
  if (images.length > 0) {
    const allowed = new Set<string>()
    for (const f of citedFiles) for (const a of resolveAssets?.(f) ?? []) allowed.add(a)
    imageVerdicts = images.map((img) => ({
      path: img.path,
      status: allowed.has(img.path) ? ('grounded' as const) : ('ungrounded' as const)
    }))
  }

  const base: SectionVerification = { verdicts, citedFileCount: citedFiles.size }
  return imageVerdicts ? { ...base, imageVerdicts } : base
}
