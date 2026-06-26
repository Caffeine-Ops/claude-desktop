import {
  parseCitations,
  trigramOverlap,
  type CitationVerdict,
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
 * 注意：「索引整体不可用 → degraded」的判定在 proposalVerify.ts 包装层（要先读索引），
 * 不在本核心——本核心只处理逐文件解析。
 */
export function verifyCitationsCore(
  markdown: string,
  resolveContent: (file: string) => string | null
): SectionVerification {
  const paras = parseCitations(typeof markdown === 'string' ? markdown : '')
  if (paras.length === 0) return { verdicts: [], citedFileCount: 0 }
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
  return { verdicts, citedFileCount: citedFiles.size }
}
