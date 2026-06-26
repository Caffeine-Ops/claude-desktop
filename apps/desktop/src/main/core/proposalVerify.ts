import { readFileSync } from 'node:fs'

import type { SectionVerification } from '../../shared/proposal'
import { readKbIndex } from './kbIndexStore'
import { verifyCitationsCore } from './proposalVerify.core'

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
      resolveAssets
    )
  } catch (err) {
    console.warn('[proposalVerify] verifyCitations failed:', err)
    return { verdicts: [], citedFileCount: 0, degraded: true }
  }
}
