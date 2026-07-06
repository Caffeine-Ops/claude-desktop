import { existsSync, readFileSync } from 'node:fs'

import type { SectionVerification } from '../../shared/proposal'
import { isPathInsideProposalRoot, proposalDraftsRoot } from '../services/proposalAssetProtocol'
import { readKbIndex } from './kbIndexStore'
import { verifyCitationsCore, collectUngroundedImagePathsCore } from './proposalVerify.core'

/**
 * 草稿产出图豁免接地的强校验谓词：路径形状（isProposalAssetPath，核心里已查）只是必要条件，
 * 这里补充分「真的在本机草稿根之下」+「文件真实存在」——AI 回灌重产时幻造的 proposal-drafts
 * 形路径过不了这两关，会掉回正常接地判定标红（评审 CONFIRMED：纯形状豁免让幻造图无声通过、
 * 绿横幅配裂图）。与 proposalasset:// 协议 handler 的 403 守卫同一把尺（同 isPathInsideProposalRoot
 * + 同根），保证「校验放行的图，预览一定能显示」。防御式 try/catch：谓词绝不抛（校验不阻塞主流程）。
 */
function isDraftAsset(absPath: string): boolean {
  try {
    return isPathInsideProposalRoot(absPath, proposalDraftsRoot()) && existsSync(absPath)
  } catch {
    return false
  }
}

/**
 * 核对一节正文 markdown 里的所有引用：把每段正文与其末尾 `（据《X》）` 所指的镜像原文
 * 做 trigram 重叠核对。仅主进程可调（要读 userData 下的镜像文件，renderer 读不到）。
 *
 * 本函数是 IO 包装层：读 KB 索引建 title→mirrorPath、按需读镜像（带缓存），把「逐文件取
 * 原文」的纯判定委托给 {@link verifyCitationsCore}。三态（supported / unsupported /
 * file-not-found）与阈值逻辑都在核心里。
 *
 * 防御式：索引缺失 → degraded（无法核对，≠「无编造」）；任意异常 → degraded。绝不抛——
 * 校验是叠加信号，绝不能阻塞正文生成、编辑或导出。无引用的正文返回空 verdicts 且不置
 * degraded（citedFileCount=0 由调用侧据此打「未引用来源」红灯）。
 */
export function verifyCitations(markdown: string): SectionVerification {
  try {
    const index = readKbIndex()
    if (!index) {
      // 索引未建/读不到：无法核对，降级（≠「无编造」）。注意：无引用的正文也会先到这里，
      // 但 citedFileCount=0 的「未引用」语义不依赖索引，故仅在「确有引用却无索引」时才算
      // degraded——核心对空引用直接返回 {verdicts:[],citedFileCount:0}，这里的 degraded 只
      // 在核心会真正用到索引时才有意义。为简单起见统一：无索引即 degraded，UI 对 content 段
      // 仍能用 citedFileCount=0 单独判「未引用」（核心在无引用时不读索引、不受影响）。
      const probe = verifyCitationsCore(typeof markdown === 'string' ? markdown : '', () => null)
      if (probe.citedFileCount === 0) return probe // 无引用：与索引无关，照常返回
      return { verdicts: [], citedFileCount: 0, degraded: true }
    }
    // title → mirrorPath，仅纳入转换成功（ok）的文件；同名取首个。
    const titleToPath = new Map<string, string>()
    // title → assets（图片绝对路径数组），同样仅 ok 文件、同名取首个——供图片接地核对。
    const titleToAssets = new Map<string, string[]>()
    for (const f of index.files) {
      if (f.ok && !titleToPath.has(f.title)) {
        titleToPath.set(f.title, f.mirrorPath)
        titleToAssets.set(f.title, f.assets ?? [])
      }
    }
    // 镜像内容读取缓存：一节里多段可能引同一文件，避免重复读盘。null = 不存在/读失败。
    const contentCache = new Map<string, string | null>()
    const resolveContent = (file: string): string | null => {
      const path = titleToPath.get(file)
      if (!path) return null
      const cached = contentCache.get(path)
      if (cached !== undefined) return cached
      let text: string | null
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        text = null
      }
      contentCache.set(path, text)
      return text
    }
    const resolveAssets = (file: string): string[] => titleToAssets.get(file) ?? []
    return verifyCitationsCore(
      typeof markdown === 'string' ? markdown : '',
      resolveContent,
      resolveAssets,
      isDraftAsset
    )
  } catch (err) {
    console.warn('[proposalVerify] verifyCitations failed:', err)
    return { verdicts: [], citedFileCount: 0, degraded: true }
  }
}

/**
 * 导出/预览闸门：算整篇方案 markdown 里所有【未接地】图的绝对路径（per-section 接地，与
 * {@link verifyCitations} 的 UI 红条同源）。markdownToDocxBuffer 据此把 ungrounded 图降级为
 * 文字占位——让「图必属本节所引文件 assets」这条接地底线不止是 UI 红条、更是 docx 导出的
 * 强制闸门（评审：接地校验本是安全底线，却没建在导出的必经收口上，ungrounded 图照样进交付）。
 *
 * 防御式：索引不可用 / 任意异常 → 空集（degraded 不强制挡）。导出绝不被校验阻塞——宁可嵌一张
 * 存疑的图、也不漏导出；degraded 时 UI 另有灰标提示「来源未校验」，不致让用户误以为已接地。
 * 仅主进程可调（要读 userData 下的镜像索引）。
 */
export function collectUngroundedImagePaths(markdown: string): Set<string> {
  try {
    const index = readKbIndex()
    if (!index) return new Set()
    // title → assets，仅 ok 文件、同名取首个（与 verifyCitations 一致）。
    const titleToAssets = new Map<string, string[]>()
    for (const f of index.files) {
      if (f.ok && !titleToAssets.has(f.title)) titleToAssets.set(f.title, f.assets ?? [])
    }
    const resolveAssets = (file: string): string[] => titleToAssets.get(file) ?? []
    // 接地只用 citedFiles + assets，不读镜像 content，故 resolveContent 传 () => null。
    return collectUngroundedImagePathsCore(
      typeof markdown === 'string' ? markdown : '',
      () => null,
      resolveAssets,
      isDraftAsset
    )
  } catch (err) {
    console.warn('[proposalVerify] collectUngroundedImagePaths failed:', err)
    return new Set()
  }
}
