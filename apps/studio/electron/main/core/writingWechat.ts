import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveBundledSkillsPluginDir } from './skillsDir'

// 与 `skills/writing/scripts/export.py` 的 `md_to_wechat_html` 保持同一套正则/取舍——
// 这里是它的 TS 移植，不是另起一套转换逻辑（两处各写一份必然漂移，仓库有过 --accent
// token 被覆盖静默失效的事故）。
//
// #{1,6}：h1–h6 全收，4–6 级钳到 h3 渲染（见下方 heading 分支），与 export.py 的
// `min(len(m.group(1)), 3)` 对齐——公众号正文极少用到 h4+，用 h3 样式呈现远好过让
// #### 原样泄漏给读者。
const HEADING = /^(#{1,6})\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const LIST_ITEM = /^[-*]\s+(.*)$/
const HR = /^\s*(?:-{3,}|\*{3,})\s*$/
const BOLD = /\*\*(.+?)\*\*/g
// 收尾星号后不能紧跟「词字」——排除「长*宽*高」这种把星号当乘号用的写法（收尾 * 后跟
// 汉字），避免被误当斜体吞掉星号；正常斜体收尾 * 后面是标点/空格/行尾，照常识别。
// 用 \p{L}\p{N}_ 而非 JS 原生 \w：原生 \w 只認 ASCII，Python re 的 \w 在 str 模式下按
// Unicode 匹配（含中文），若照搬 \w 会漏挡「星号后紧跟汉字」的场景，行为与 export.py 对不上。
const ITALIC = /(?<!\*)\*(?!\*)([^*]+?)\*(?![\p{L}\p{N}_*])/gu

/**
 * markdown → 公众号可粘贴的内联样式 HTML。
 *
 * **样式必须全内联进每个元素的 style 属性**：公众号编辑器会剥掉 `<style>` 标签和 class，
 * 不内联粘进去就是一片黑字（`skills/writing/scripts/export.py` 的注释已写明这条）。
 *
 * **只输出白名单标签、正文一律转义**：内容来自 AI 与本地文件，直接透传原始 HTML 等于
 * 把任意标签带进渲染层的 dangerouslySetInnerHTML。这里从行结构自己生成标签，正文过 escapeHtml。
 *
 * 行扫描而非完整 markdown AST：与 export.py 的 md_to_wechat_html 保持同一套取舍——
 * 公众号文案只用到标题/段落/列表/引用/分隔线/加粗斜体这几样，上一整套 remark 不划算。
 *
 * **`style` 的字段名对齐 `export_styles/*.json` 的真实 schema**（`body`/`h1`/`h2`/`h3`/
 * `quote`/`strong`/`em`/`li`/`hr`），**不是**「h1/h2/p/li/strong」这种直觉命名——
 * 段落样式键是 `body` 不是 `p`。这是任务书原稿的一处笔误，已核对 export.py 源码修正；
 * 若照搬错误键名，预览用的是一套样式、skill 自己导出的又是另一套，两边必然对不上。
 *
 * 缺键时不抛错、只是不给该标签内联样式（`styleAttr` 静默降级）——调用方传入的可能是
 * 单测里精简过的 style 对象，容错比对齐 Python `KeyError` 更适合这层。
 */
export function markdownToWechatHtml(markdown: string, style: Record<string, string>): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inList = false

  function closeList(): void {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  for (const raw of lines) {
    // 只去尾部空白，不去首部——对齐 export.py 的 `raw.rstrip()`。标题/引用/列表的正则都用 `^`
    // 锚点匹配整行，若像业余实现那样两端都 trim，缩进的 "# 标题" 会被判成标题，而
    // export.py 会把它当成普通段落（保留了行首空格）——两边输出必须一致。
    // 【已知边角差异，记录不修】Python `str.rstrip()` 按 Unicode 空白定义剥尾，连全角空格
    // （U+3000 `　`）也剥掉；这里的 `[ \t]+$` 只剥 ASCII 空格/制表符。中文稿段尾残留全角
    // 空格的概率极低，且浏览器渲染文本节点时本就会折叠空白，不影响最终视觉——但如果哪天
    // 逐字节比对 export.py 输出时字符串对不上，先查这一条。
    const line = raw.replace(/[ \t]+$/, '')
    if (!line.trim()) {
      closeList()
      continue
    }

    if (HR.test(line)) {
      closeList()
      out.push(`<hr${styleAttr(style, 'hr')} />`)
      continue
    }

    const h = HEADING.exec(line)
    if (h) {
      closeList()
      const level = Math.min(h[1]!.length, 3)
      const tag = `h${level}`
      out.push(`<${tag}${styleAttr(style, tag)}>${inline(h[2]!, style)}</${tag}>`)
      continue
    }

    const q = QUOTE.exec(line)
    if (q) {
      closeList()
      out.push(`<blockquote${styleAttr(style, 'quote')}>${inline(q[1]!, style)}</blockquote>`)
      continue
    }

    const li = LIST_ITEM.exec(line)
    if (li) {
      if (!inList) {
        // <ul> 的间距/缩进硬编码内联（不来自 style JSON），与 export.py 的
        // `<ul style="margin:1em 0;padding-left:1.4em;">` 对齐。
        out.push('<ul style="margin:1em 0;padding-left:1.4em;">')
        inList = true
      }
      out.push(`<li${styleAttr(style, 'li')}>${inline(li[1]!, style)}</li>`)
      continue
    }

    closeList()
    out.push(`<p${styleAttr(style, 'body')}>${inline(line, style)}</p>`)
  }
  closeList()
  return out.join('\n')
}

/** 有该键才拼 style 属性，没有就留空——不是每个调用方都会传全量样式表（如单测精简 fixture）。 */
function styleAttr(style: Record<string, string>, key: string): string {
  return style[key] ? ` style="${style[key]}"` : ''
}

/**
 * 行内格式：先转义，再把 `**x**` 换成 strong、`*x*` 换成 em。顺序不能反——先换标签会被
 * 转义吃掉；粗体必须先于斜体替换，否则 `**x**` 会被斜体正则先吃掉一层星号。
 */
function inline(text: string, style: Record<string, string>): string {
  const strongStyle = styleAttr(style, 'strong')
  const emStyle = styleAttr(style, 'em')
  return escapeHtml(text)
    .replace(BOLD, (_m, inner: string) => `<strong${strongStyle}>${inner}</strong>`)
    .replace(ITALIC, (_m, inner: string) => `<em${emStyle}>${inner}</em>`)
}

/**
 * 只转义 `&`/`<`/`>`，**不转义引号**——对齐 export.py 的 `html.escape(text, quote=False)`。
 * 这里的转义结果只会落进文本节点（`<p>…</p>` 之类），不会拼进属性值，转不转义引号在浏览器
 * 渲染上视觉等价；但要与 skill 自己导出的 HTML 逐字节一致（任务书要求的核对项之一），
 * 就必须原样对齐 Python 那边的转义范围，而不是想当然多转义一层。
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 读 skill 里的导出样式 JSON。**不在前端复刻一份**——两处各写一份必然漂移
 * （仓库有过 `--accent` token 被覆盖、静默失效零报错的事故）。读不到时回 null，
 * 调用方降级为内置默认样式并在 UI 角标提示。
 */
export function loadWechatStyle(name: string): Record<string, string> | null {
  const skills = resolveBundledSkillsPluginDir()
  if (!skills) return null
  try {
    const p = join(skills, 'writing', 'templates', 'export_styles', `${name}.json`)
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'))
    if (!parsed || typeof parsed !== 'object') return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // `name` 是 JSON 里给人看的模板显示名（如「公众号默认」），不是标签样式键——export.py 的
      // load_style() 同样把它过滤掉（`k != "name"`），这里对齐，否则它会以字符串形式混进样式表
      // （虽无标签会读 style['name']，但留着就是一个没人保证语义的杂质字段）。
      if (k !== 'name' && typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return null
  }
}

/**
 * 内置兜底样式：JSON 读不到时用，保证预览与复制始终可用。字段名对齐真实 schema
 * （`body` 而非 `p`），否则段落会静默丢样式（`styleAttr` 缺键不抛错，视觉上只是「正文没有
 * 内联样式」，不容易第一时间发现）。取值为中性配色，不复刻 `wechat-default.json` 的
 * 微信绿品牌色——降级态不该冒充某个具名模板。
 */
export const FALLBACK_WECHAT_STYLE: Record<string, string> = {
  body: 'font-size:16px;line-height:1.75;color:#333333;margin:0 0 1.2em 0;',
  h1: 'font-size:22px;font-weight:bold;color:#1a1a1a;margin:1.6em 0 0.8em 0;line-height:1.4;',
  h2: 'font-size:19px;font-weight:bold;color:#1a1a1a;margin:1.5em 0 0.7em 0;line-height:1.4;',
  h3: 'font-size:17px;font-weight:bold;color:#333333;margin:1.3em 0 0.6em 0;line-height:1.4;',
  quote:
    'font-size:15px;color:#666666;border-left:3px solid #dddddd;padding:0.6em 0 0.6em 1em;margin:1.2em 0;background:#fafafa;',
  strong: 'font-weight:bold;',
  em: 'font-style:italic;color:#666666;',
  li: 'font-size:16px;line-height:1.75;color:#333333;margin:0.4em 0;',
  hr: 'border:none;border-top:1px solid #eeeeee;margin:2em 0;'
}
