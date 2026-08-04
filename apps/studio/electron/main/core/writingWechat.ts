import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveBundledSkillsPluginDir } from './skillsDir'

// 与 `skills/writing/scripts/export.py` 的 `md_to_wechat_html` 保持同一套正则/取舍——
// 这里是它的 TS 移植，不是另起一套转换逻辑（两处各写一份必然漂移，仓库有过 --accent
// token 被覆盖静默失效的事故）。这条指针是双向的：export.py 的模块 docstring 也指回本文件。
//
// **新增块级语法两边必须同步**：现有测试（这里与 export.py 的 test_export.py）只盯住已知
// 语法——加一种新的围栏占位块（比如以后要支持的 ```chart）或新的行级语法，只改一侧不会
// 让任何测试变红，只会让预览渲染的 HTML 与 skill 自己导出的 HTML 在未来某天悄悄长歪。
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

// 图片语法。前导 ! 是与普通链接的唯一区别；路径部分排除空白与右括号，后面可选一个 markdown
// 标题后缀 `"..."`（`![图说](路径 "标题")`）。这里直接锚定行首行尾（^…$），等价于
// export.py 的 `_IMAGE.fullmatch()`——只用来判定「整行就是一张图」而不是从长句子里挖出
// 子串，使用方要先对整行 trim 再拿去测（对齐 `_IMAGE.fullmatch(line.strip())` 的调用方式）。
// 与 export.py 同源的取舍：句子中间夹的图（非独占一行）**故意不处理成图**——见下面
// markdownToWechatHtml 里对该正则的调用处注释，以及 export.py 的 inline_images() 文档。
const IMAGE_FULLMATCH = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/

// 围栏块开头：3 个以上反引号，后面可选一个语言标记（```genimage / ```mermaid，不写就是
// 空串）。收尾围栏复用同一个正则（不检查语言，任何三个以上反引号的行都能收口）——与
// export.py 的 `_FENCE_OPEN = re.compile(r"^\s*```+\s*([^\s`]*)\s*$")` 语义相同，Python
// 正则里的「```+」在计数上等价于「至少 3 个反引号」，这里直接写成更直白的 `` `{3,}``。
const FENCE_OPEN = /^\s*`{3,}\s*([^\s`]*)\s*$/

// 图说行。全角/半角冒号都认——写手在中文正文里打全角冒号是本能，只认半角会漏掉一半图说，
// 而漏了图说的占位块只能告诉用户「这儿有张图」却不说是哪张，帮助有限。格式由
// skills/writing/references/illustrator.md 规定：块的首行写「图说: xxx」（这里扫全块见
// fenceCaption，不只看首行，理由同 export.py 的 FenceBlock.caption）。
const CAPTION_LINE = /^\s*图说\s*[:：]\s*(.*?)\s*$/

// P1a 阶段这两种围栏块都还没变成真图片：genimage 是待执行的出图指令，mermaid 是公众号
// 渲染不了、需要人工出图再贴的信息图源码。两者都不能把源码当正文段落漏进成品（配图
// 指令泄漏），也不能悄悄删掉（删了用户就不知道这里本该有图）——与 export.py 的
// `_PLACEHOLDER_LANGS` 同一份取舍。
const PLACEHOLDER_LANGS = new Set(['genimage', 'mermaid'])

/** 一个待处理的围栏块（genimage / mermaid）。对应 export.py 的 `FenceBlock` dataclass。 */
interface FenceBlock {
  lang: string
  lines: string[]
}

/**
 * 把正文行切成两种单元：普通行（string）与围栏块（FenceBlock）。对应 export.py 的
 * `split_blocks`——「genimage / mermaid 的源码绝不进成品」在这里只实现一次，不靠调用方
 * 每次都记得跳过围栏内容。
 *
 * 不成对的围栏（开了没关）一路吃到文末：与 export.py 同源的取舍——格式坏掉的围栏本来就会
 * 把全文渲染带歪，真去配对纠错比这层该担的事重得多。
 */
function splitBlocks(lines: string[]): (string | FenceBlock)[] {
  const units: (string | FenceBlock)[] = []
  let i = 0
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]!)
    const lang = open?.[1]?.toLowerCase()
    if (open && lang && PLACEHOLDER_LANGS.has(lang)) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !FENCE_OPEN.test(lines[i]!)) {
        body.push(lines[i]!)
        i += 1
      }
      i += 1 // 跳过收尾的 ```；若文件在此提前结束（未闭合），上面的 while 已经把剩余行全部吃进 body
      units.push({ lang, lines: body })
      continue
    }
    units.push(lines[i]!)
    i += 1
  }
  return units
}

/**
 * 围栏块里的图说：取第一条匹配「图说: xxx」的行。按 illustrator.md 的约定图说在首行，
 * 但这里扫全块而不是只看首行——写手偶尔会先写一行空行或把图说写在第二行，宽容一点不会
 * 误伤（正文描述行不会以「图说:」开头），严格一点却会白丢一条图说。没有就返回空串
 * （空串在 fencePlaceholderHtml 里会被判成「没图说」，整行 caption 提示不出现）。
 */
function fenceCaption(block: FenceBlock): string {
  for (const raw of block.lines) {
    const m = CAPTION_LINE.exec(raw)
    if (m) return m[1]!.trim()
  }
  return ''
}

/**
 * 未出图的围栏块 → 一个看得见的占位框。对应 export.py 的 `fence_placeholder_html`。
 *
 * 为什么是占位框而不是直接删掉：删了以后成品上什么都不剩，用户不知道这里本该有张图、
 * 更不知道图说是什么，等于把 P1a「先写指令、后出图」的半成品状态藏了起来。占位框把
 * 「这儿缺一张什么图」摆在原位。样式内联，理由同全篇（公众号编辑器会剥掉 <style> 与 class）。
 */
function fencePlaceholderHtml(block: FenceBlock): string {
  const caption = fenceCaption(block)
  // 没图说就整行不出。mermaid 块按 illustrator.md 的示例本来就常常不写图说，硬塞一句
  // 「（这个块没写图说）」是给读者看的噪音——占位框的正事是「这儿缺一张图」，图说有则
  // 锦上添花，没有也不该拿占位文案顶上。
  const capLine = caption ? `「${escapeHtml(caption)}」<br />` : ''
  let title: string
  let hint: string
  let border: string
  let bg: string
  let fg: string
  if (block.lang === 'genimage') {
    title = '待出图'
    hint = '出图指令保留在 Markdown 原稿里；出图后把图片按 <code>![图说](路径)</code> 换掉这个块，再重跑导出'
    border = '#d9a441'
    bg = '#fffaf0'
    fg = '#8a6d3b'
  } else {
    title = '待渲染的信息图（mermaid）'
    // 说清源码没丢，否则用户会以为导出把图弄丢了、回头去原稿里找不到而重画一遍。
    hint = '公众号编辑器不认 mermaid，源码原样保留在 Markdown 原稿里；请自行渲染成图片后插到这个位置'
    border = '#8ab4d9'
    bg = '#f5f9fc'
    fg = '#3f6b8f'
  }
  return (
    `<section style="border:1px dashed ${border};background:${bg};padding:1em 1.2em;` +
    `margin:1.4em 0;text-align:center;font-size:14px;line-height:1.7;color:${fg};">` +
    `<strong style="color:${fg};">${title}</strong><br />` +
    `${capLine}` +
    `<span style="font-size:12px;opacity:0.85;">${hint}</span>` +
    `</section>`
  )
}

// img/figcaption 的内联样式默认值。对应 export.py 的
// `style.get("img", "display:block;...")` / `style.get("figcaption", "...")`——用户传入的
// style JSON 不一定带这两个键（旧模板文件、单测精简 fixture），缺键时不能让图片和图说
// 变成完全没有样式的裸元素，与 export.py 用同一份兜底字符串。
const DEFAULT_IMG_STYLE = 'display:block;max-width:100%;height:auto;margin:1.4em auto 0.4em auto;'
const DEFAULT_FIGCAPTION_STYLE = 'display:block;text-align:center;font-size:13px;color:#999999;'

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
  // 【2026-08 终审 #3】断行必须认 Python `str.splitlines()` 认的那一整套，不能只认 LF/CRLF。
  // 旧实现 `replace(/\r\n/g,'\n').split('\n')` 只识别 `\n`/`\r\n`；`export.py` 侧的
  // `splitlines()` 还认单独的 `\r`、`\v`（垂直制表符）、`\f`（换页符）、`\x85`（NEL）、
  // U+2028（LINE SEPARATOR）、U+2029（PARAGRAPH SEPARATOR）——后两个从网页/JSON
  // 复制粘贴进来的文本里并不罕见。**这两个字符本身是 ECMAScript 语法认定的行终止符，
  // 连 `//` 单行注释都会被它们截断在原地**——本注释只能用 `U+2028` 这种转义写法指代它们，
  // 不能把字面字符直接写进注释文本（第一版实现踩过这个坑：字面字符出现在注释里，
  // 把这条注释自身从那里截断，之后的文字被解析器当成代码，整个文件语法错误）。
  // 若稿子里混进这类字符，genimage 围栏所在的整段
  // 会被当成一行，`FENCE_OPEN` 逐行匹配不上开合标记 → 占位框机制失效 → 围栏源码原样
  // 当成正文段落渲进 `<p>`，直接粘进公众号——这正是本任务新加的「围栏源码绝不进成品」
  // 这条保证要防的事，这行断行逻辑本身是未改动的既有代码，但现在才真正扛着这条保证。
  // `\r\n` 分支必须放在字符类之前：交替匹配从左到右尝试，先吃两字符的 CRLF 才不会被
  // 拆成两段空行，与旧实现「先合并 CRLF 再切」的效果一致。
  const lines = markdown.split(/\r\n|[\n\r\v\f\x85\u2028\u2029]/)
  const units = splitBlocks(lines)
  const out: string[] = []
  let inList = false

  function closeList(): void {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }

  for (const unit of units) {
    if (typeof unit !== 'string') {
      // 围栏占位块（genimage / mermaid）：先收列表再插占位框，避免占位框被吞进 <ul> 里
      // （紧跟在列表项后面的围栏块不该被当成第 N+1 个 li）。
      closeList()
      out.push(fencePlaceholderHtml(unit))
      continue
    }
    const raw = unit
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

    // 图片独占一行 → <img> + <figcaption>，不包进 <p>（公众号 <p> 的 margin 会把图和图说
    // 撑成两块不相干的东西）。判定前对整行两端都 trim，对齐 export.py 的
    // `_IMAGE.fullmatch(line.strip())`——这里特意两端 trim，与上面「只 rstrip 保留行首空格」
    // 的取舍不同：那是为了让缩进的 "# 标题" 落回段落，图片没有这层顾虑。
    //
    // 句子中间夹的图（这一行 trim 后不是「整行就是一张图」）**故意不在这里处理成 <img>**，
    // 会一路跌落到本函数末尾的 <p> 兜底分支，把 `![...]​(...)` 原样当文字转义输出——这不是
    // 遗漏，是照抄 export.py 的取舍：md_to_wechat_html 本身对行内图片就是这个态度，真正
    // 「拦下这种稿子」的硬闸（inline_images）在 export.py 的 main() 里，是 CLI 导出路径专属
    // 的前置校验，不属于这个纯渲染函数，TS 侧目前没有对应的 CLI 导出闸，故未移植该函数。
    const imgMatch = IMAGE_FULLMATCH.exec(line.trim())
    if (imgMatch) {
      closeList()
      const caption = imgMatch[1]!.trim()
      const src = imgMatch[2]!
      // 【与 export.py 的差异，原因如下】Python 那份在这一步会把 src 换成 copy_images() 复制
      // 后的文件名（`images/01-x.png`）——因为它的导出产物是「要交出去的一整包」，会把用到的
      // 图复制进输出目录旁边。TS 这条路径是「转成 HTML 复制到系统剪贴板」（见调用方
      // ipc/register.ts 里 IPC_CHANNELS.WRITING_WECHAT_HTML 的 handler），没有落盘的输出
      // 目录可以把图复制过去，所以 src 原样保留正文里写的相对路径——用户粘贴到公众号编辑器后
      // 本就要手工重新插图，这条相对路径本来就不会被公众号编辑器读取（编辑器只认上传后的图），
      // 不影响那一步。
      const href = src
      out.push(
        `<img src="${escapeHtmlAttr(href)}" alt="${escapeHtmlAttr(caption)}"${styleAttrWithDefault(style, 'img', DEFAULT_IMG_STYLE)} />`
      )
      if (caption) {
        out.push(
          `<figcaption${styleAttrWithDefault(style, 'figcaption', DEFAULT_FIGCAPTION_STYLE)}>${escapeHtml(caption)}</figcaption>`
        )
      }
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
 * 同 styleAttr，但缺键时不留空、而是回退到调用方给的默认样式字符串。对应 export.py 的
 * `style.get(key, default)`——img/figcaption 这两个键专用：老的 style JSON、单测精简
 * fixture 都可能没有这两个键，若沿用 styleAttr 的「缺键就留空」，图片和图说会渲染成完全
 * 没有内联样式的裸元素（在剥掉 <style> 的公众号编辑器里视觉上是错位的大图 + 无格式说明文字），
 * 比标题/段落缺样式更容易被用户当成 bug 看见。
 */
function styleAttrWithDefault(style: Record<string, string>, key: string, fallback: string): string {
  return ` style="${style[key] || fallback}"`
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
 * 属性值转义：在 escapeHtml 基础上再转义引号，对齐 export.py 的 `html.escape(s, quote=True)`
 * （Python 的 quote=True 会把 `"` 换成 `&quot;`、`'` 换成 `&#x27;`）。只用于会拼进双引号
 * 属性值的场合（这里是 `<img src="…" alt="…">`）——图说未转义引号时若原文含 `"`，会提前
 * 闭合 alt 属性、让后面的文本被解释成新属性/标签，是一处真实的注入面（自查项之一）。
 * 图说落进 <figcaption> 文本节点时不走这个函数，仍用 escapeHtml——文本节点里引号不需要
 * 转义，多转一层只会让肉眼比对 export.py 输出时对不上。
 */
function escapeHtmlAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
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
