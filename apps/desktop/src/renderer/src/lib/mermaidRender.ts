// Mermaid 渲染（renderer 侧·方案一二期）。
//
// 为什么渲染只能在 renderer：mermaid 依赖 DOM（render() 会往文档里挂临时节点量取尺寸），
// main（Node 无 DOM）渲不了。故架构是：renderer 把 mermaid 文本渲成 SVG —— 编辑/聊天态直接
// 显示 SVG；导出/真预览时把 SVG 交给 main，由 main 用 sharp(librsvg) 位图化成 PNG 嵌进 docx
// （见 proposalDocx）。两条路都用这同一份 SVG，守住「预览=导出一致」。
//
// htmlLabels:false 是【导出能成图】的前提：mermaid 默认用 foreignObject（SVG 里嵌 HTML）放
// 标签文字，而 sharp/librsvg 不支持 foreignObject —— 那样导出的 PNG 会丢掉所有节点文字。关掉
// 后 mermaid 改用纯 SVG <text>，librsvg 能正确栅格化。这条配置编辑态其实不需要，但两端必须
// 用同一份渲染配置才能保证「编辑态看到的」与「导出位图」一致，故统一在此初始化。
//
// 懒加载：mermaid 是数 MB 的大库，而 AssistantMarkdown 渲染每一条聊天消息。用 dynamic import
// 让 Vite 把 mermaid 切成独立 chunk，仅在【真出现 mermaid 图】时才下载/初始化，不拖累首屏。

import type { MermaidImage } from '@shared/ipc-channels'

type MermaidApi = (typeof import('mermaid'))['default']

let mermaidPromise: Promise<MermaidApi> | null = null

function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      const mermaid = m.default
      mermaid.initialize({
        startOnLoad: false,
        // strict：mermaid 会对生成的 SVG 做消毒，杜绝代码块里夹带的恶意标记（虽内容来自
        // KB 接地文本，仍按最严级别处理）。
        securityLevel: 'strict',
        // base + themeVariables（配图密度增强 ②）：素色 neutral 与客户方案里的专业彩图观感差距
        // 太大；base 是 mermaid 唯一官方支持 themeVariables 全量定制的主题。品牌蓝系浅底深框、
        // 白色画布（rasterizeSvg 导出时也刷白底，两端一致）。只调颜色/字号，不碰布局与标签渲染
        // 方式——htmlLabels:false 等导出不变量在下方逐字保留。
        theme: 'base',
        themeVariables: {
          primaryColor: '#eaf1fd', // 节点底：浅品牌蓝
          primaryTextColor: '#1e3a5f', // 节点文字：深蓝灰
          primaryBorderColor: '#3b74d9', // 节点框：品牌蓝
          lineColor: '#5b8def', // 连线
          secondaryColor: '#f4f8ff',
          tertiaryColor: '#fafcff',
          fontSize: '14px'
        },
        // 见文件头：纯 SVG <text>，栅格化时才能渲出文字。
        htmlLabels: false,
        flowchart: { htmlLabels: false, useMaxWidth: true },
        // 【关键】语法错误时不要把「Syntax error」炸弹图注入 document.body——默认行为会让
        // 失败的渲染把一张炸弹 SVG 漏到页面（流式期间半截 mermaid 反复解析失败，炸弹会成片
        // 堆积，实测 bug）。关掉后 render() 出错只抛异常，由调用侧 catch 降级显示源码。
        suppressErrorRendering: true
      })
      return mermaid
    })
  }
  return mermaidPromise
}

// render() 的 id 必须唯一且是合法 CSS id（mermaid 用它建临时容器）。模块级自增即可——
// 渲染是全局副作用、与组件实例无关；Date.now/Math.random 在某些环境被禁用，故不用。
let seq = 0

/**
 * 把一段 mermaid 文本渲成 SVG 字符串。失败（语法错误 / 流式未闭合）时抛出，由调用侧降级
 * （编辑态显示源码、导出时降级文字占位）。绝不返回半成品。
 */
export async function renderMermaid(code: string): Promise<string> {
  const mermaid = await getMermaid()
  seq += 1
  const id = `proposal-mermaid-${seq}`
  try {
    const { svg } = await mermaid.render(id, code)
    return svg
  } finally {
    // 防御兜底：mermaid 偶尔把临时渲染容器 / 残留图遗留在 document.body。按 id 清掉，杜绝
    // DOM 泄漏堆积到页面（suppressErrorRendering 已堵主路，这里再兜一道，覆盖成功/失败两路）。
    document.getElementById(id)?.remove()
    document.getElementById('d' + id)?.remove()
  }
}

// 抽取 markdown 里所有 ```mermaid 围栏块的源码（trim 后）。导出/真预览前用它扫出待预渲的图，
// 逐个 renderMermaid → 组装 code→svg 映射交给 main（见 proposalDocx 的 mermaid 嵌入）。
// key 用 trim 后的源码，与 main 侧 mdast code 节点 node.value.trim() 对齐，保证查得到。
const MERMAID_FENCE_RE = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g

/** 抽取所有 mermaid 块源码（去重、trim、保序）。无则 []。纯函数。 */
export function extractMermaidBlocks(markdown: string): string[] {
  if (!markdown) return []
  const out: string[] = []
  const seen = new Set<string>()
  MERMAID_FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MERMAID_FENCE_RE.exec(markdown)) !== null) {
    const code = m[1].trim()
    if (code && !seen.has(code)) {
      seen.add(code)
      out.push(code)
    }
  }
  return out
}

// ── SVG → PNG 栅格化（renderer canvas）─────────────────────────────────────
// 放 renderer 而非 main：① 不引原生依赖（sharp）；② Chromium 用与屏幕预览同一套字体栅格，
// 导出位图里的中文绝不缺字（这是 main 侧 librsvg 方案的最大坑）。scale=2 提清晰度，导出/打印不糊。

function svgIntrinsicSize(svg: string): { w: number; h: number } {
  // mermaid 输出带 viewBox="0 0 W H"，是最可靠的固有尺寸来源；取不到再退 width/height 属性。
  const vb = /viewBox="[\d.]+ [\d.]+ ([\d.]+) ([\d.]+)"/.exec(svg)
  if (vb) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) }
  const w = /\bwidth="([\d.]+)"/.exec(svg)
  const h = /\bheight="([\d.]+)"/.exec(svg)
  return { w: w ? parseFloat(w[1]) : 800, h: h ? parseFloat(h[1]) : 600 }
}

// 把 <svg> 根的 width/height 钉成像素固有值：mermaid 默认 width="100%"，<img> 加载这种 SVG
// 拿不到确定 intrinsic 尺寸、canvas 绘制会塌成默认 300×150。
function pinSvgSize(svg: string, w: number, h: number): string {
  return svg.replace(/<svg([^>]*?)>/, (_m, attrs: string) => {
    const cleaned = attrs.replace(/\s(?:width|height)="[^"]*"/g, '')
    return `<svg${cleaned} width="${w}" height="${h}">`
  })
}

async function rasterizeSvg(svg: string, scale = 2): Promise<MermaidImage> {
  const { w, h } = svgIntrinsicSize(svg)
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(pinSvgSize(svg, w, h))
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('mermaid svg 加载失败'))
    img.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context 不可用')
  // 白底：mermaid neutral 主题背景透明，docx 里需要白底才不透出页色 / 不变黑块。
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const dataUrl = canvas.toDataURL('image/png')
  return { png: dataUrl.slice(dataUrl.indexOf(',') + 1), width: canvas.width, height: canvas.height }
}

/**
 * 渲染一组 mermaid 源码为 code→图（PNG）映射，导出/真预览前调用。单块失败只跳过（不进映射，
 * main 端据此降级文字），绝不让一张坏图打断整篇导出。空输入 → {}。
 */
export async function renderMermaidImageMap(
  codes: readonly string[]
): Promise<Record<string, MermaidImage>> {
  const map: Record<string, MermaidImage> = {}
  await Promise.all(
    codes.map(async (code) => {
      try {
        const svg = await renderMermaid(code)
        map[code] = await rasterizeSvg(svg)
      } catch {
        // 渲染 / 栅格失败：跳过该块，main 端降级文字占位。
      }
    })
  )
  return map
}
