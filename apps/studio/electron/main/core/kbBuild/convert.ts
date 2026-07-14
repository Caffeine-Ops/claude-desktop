import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { ScanEntry } from './scan'
import { extractDataUriImages } from './assets'
import { toolingExecEnv } from '../kbTooling'

export interface ConvertResult {
  markdown: string
  assets: string[]
  ok: boolean
  error?: string
}

function tryMarkitdown(
  src: string,
  assetsDir: string,
  keepDataUris: boolean
): { md: string; assets: string[] } {
  // markitdown 0.1.6 默认把 data-uri 截断为 "..."，必须传 --keep-data-uris 才保留完整 base64。
  // Task 3 的 extractDataUriImages 依赖完整 base64，因此首选带该标志。
  // 但 PptxConverter 带 --keep-data-uris 时，遇到「图片引用没有内嵌 blob」的 pptx 会抛
  // "ValueError: no embedded image"（图片美化型 PPT 实测踩中）；不带标志则文本正常导出。
  // 所以 convertFile 在首选失败后用 keepDataUris=false 重试：丢的只是这类文件本来就
  // 抽不出来的内嵌图，文本一字不丢——好过整个文件掉进 soffice txt 兜底（pptx 常失败）。
  mkdirSync(assetsDir, { recursive: true })
  const args = keepDataUris ? ['--keep-data-uris', src] : [src]
  const md = execFileSync('markitdown', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // 补全 PATH：GUI 启动的 app 继承 launchd 精简 PATH，裸调会 ENOENT。与 detectTooling 同款，
    // 保证「探到 ⟺ 转换得了」。
    env: toolingExecEnv()
  })
  // 内嵌图以 data-uri 形式留在 md 里，由 extractDataUriImages 统一抽取落盘。
  return { md, assets: [] }
}

function tryLibreOffice(src: string, tmpDir: string): string {
  mkdirSync(tmpDir, { recursive: true })
  execFileSync('soffice', [
    '--headless', '--convert-to', 'txt:Text', '--outdir', tmpDir, src
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: toolingExecEnv() })
  const base = basename(src).replace(/\.[^.]+$/, '.txt')
  const out = join(tmpDir, base)
  return existsSync(out) ? readFileSync(out, 'utf8') : ''
}

export async function convertFile(entry: ScanEntry, outDir: string): Promise<ConvertResult> {
  // 资产目录按相对源路径唯一化，与 mirrorPath 同源——避免同名不同扩展 / 深层同名
  // 文件的内嵌图（img-1.png…）落进同一目录互相覆盖（与 #4 镜像碰撞同根）。
  const assetsDir = join(outDir, 'assets', entry.relPath)
  if (entry.ext === '.txt') {
    return { markdown: readFileSync(entry.sourcePath, 'utf8'), assets: [], ok: true }
  }
  try {
    const { md } = tryMarkitdown(entry.sourcePath, assetsDir, true)
    const extracted = extractDataUriImages(md, assetsDir)
    if (extracted.markdown.trim().length > 0)
      return { markdown: extracted.markdown, assets: extracted.assets, ok: true }
    throw new Error('markitdown 输出为空')
  } catch (e1) {
    // 第二梯队：不带 --keep-data-uris 重试（原因见 tryMarkitdown 注释）。注意这个 catch 不只
    // 接「pptx no embedded image」——maxBuffer 溢出（图特别多的文件恰是最容易撞 64MB 的）、
    // extractDataUriImages 落盘失败等一律落到这里，成功的二档结果是【丢了全部内嵌图的降级品】。
    // 三条纪律（评审 #5）：① 降级必须出声（console.warn 带一档根因），静默 ok:true 会让
    // 「该文件为什么没有图资产」永远查无对证；② 二档输出必须清掉截断的 data-uri 图片引用
    // （markitdown 无标志时把 uri 截成 "..."，留着就是喂给 BM25/语义索引的垃圾）；③ 全灭时
    // error 要带上一档根因，只报 soffice 的错等于掩盖真凶。
    console.warn(`[kb-index] ${entry.relPath}: markitdown --keep-data-uris 失败，降级为纯文本重试（内嵌图全部丢失）：${String(e1)}`)
    try {
      const md = tryMarkitdown(entry.sourcePath, assetsDir, false)
      // 清掉截断 data-uri / "..." 目标的图片引用——这些链接永远打不开，只会污染镜像。
      const cleaned = md.md.replace(/!\[[^\]]*\]\((?:data:|\.\.\.)[^)]*\)/g, '')
      if (cleaned.trim().length > 0) return { markdown: cleaned, assets: [], ok: true }
      throw new Error('markitdown(无 data-uri) 输出为空')
    } catch (e2) {
      try {
        const txt = tryLibreOffice(entry.sourcePath, join(outDir, '.tmp'))
        if (txt.trim().length > 0) return { markdown: txt, assets: [], ok: true }
        return {
          markdown: '',
          assets: [],
          ok: false,
          error: `markitdown: ${String(e1)}; markitdown(无 data-uri): ${String(e2)}; soffice 输出为空`
        }
      } catch (e3) {
        return {
          markdown: '',
          assets: [],
          ok: false,
          error: `markitdown: ${String(e1)}; markitdown(无 data-uri): ${String(e2)}; soffice: ${String(e3)}`
        }
      }
    }
  }
}
