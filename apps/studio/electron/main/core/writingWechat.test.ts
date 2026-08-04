import { describe, expect, it } from 'bun:test'
import { FALLBACK_WECHAT_STYLE, loadWechatStyle, markdownToWechatHtml } from './writingWechat'

const STYLE = {
  h1: 'font-size:20px;font-weight:bold;',
  h2: 'font-size:17px;font-weight:bold;',
  p: 'font-size:15px;line-height:1.75;',
  li: 'font-size:15px;',
  strong: 'font-weight:bold;'
}

describe('markdownToWechatHtml', () => {
  it('样式全部内联进 style 属性——公众号编辑器会剥掉 <style> 和 class', () => {
    const html = markdownToWechatHtml('# 标题\n\n一段正文', STYLE)
    expect(html).toContain('style="font-size:20px;font-weight:bold;"')
    expect(html).not.toContain('<style')
    expect(html).not.toContain('class=')
  })

  it('渲染标题、段落与列表', () => {
    const html = markdownToWechatHtml('# 大标题\n\n## 小标题\n\n正文\n\n- 甲\n- 乙', STYLE)
    expect(html).toContain('大标题')
    expect(html).toContain('小标题')
    expect(html).toContain('正文')
    expect(html).toContain('甲')
    expect(html).toContain('乙')
  })

  it('转义 HTML 特殊字符，不透传原始标签（防注入）', () => {
    const html = markdownToWechatHtml('正文里有 <script>alert(1)</script> 和 & 符号', STYLE)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('加粗渲染成内联 strong', () => {
    const html = markdownToWechatHtml('这是**重点**内容', STYLE)
    expect(html).toContain('<strong')
    expect(html).toContain('重点')
  })

  it('空 markdown 返回空串', () => {
    expect(markdownToWechatHtml('', STYLE)).toBe('')
  })
})

// ── 与 skills/writing/scripts/export.py 的 md_to_wechat_html 对齐 ─────────────────────
// 任务书原稿假设 style 字段名是「h1/h2/p/li/strong」这种直觉命名；核对 export_styles/*.json
// 与 export.py 源码后发现段落键实际是 `body`（不是 `p`），且脚本还支持引用/分隔线/斜体/
// h4-h6 钳位。下面这组测试专门盯着这些被任务书遗漏、但 export.py 真实存在的行为，
// 防止预览产出的 HTML 与 skill 自己导出的 HTML 长成两个样子。
describe('markdownToWechatHtml · 与 export.py 的行为对齐', () => {
  const FULL_STYLE = {
    body: 'font-size:16px;',
    h1: 'font-size:22px;',
    h2: 'font-size:19px;',
    h3: 'font-size:17px;',
    quote: 'color:#666;',
    strong: 'font-weight:bold;',
    em: 'font-style:italic;',
    li: 'font-size:16px;',
    hr: 'border-top:1px solid #eee;'
  }

  it('段落样式键是 body，不是 p', () => {
    const html = markdownToWechatHtml('一段正文', FULL_STYLE)
    expect(html).toBe('<p style="font-size:16px;">一段正文</p>')
  })

  it('引用行渲染成内联样式的 blockquote', () => {
    const html = markdownToWechatHtml('> 一句引用', FULL_STYLE)
    expect(html).toBe('<blockquote style="color:#666;">一句引用</blockquote>')
  })

  it('分隔线渲染成内联样式的 hr（--- 与 *** 都认）', () => {
    expect(markdownToWechatHtml('---', FULL_STYLE)).toBe('<hr style="border-top:1px solid #eee;" />')
    expect(markdownToWechatHtml('***', FULL_STYLE)).toBe('<hr style="border-top:1px solid #eee;" />')
  })

  it('4-6 级标题钳到 h3，不原样泄漏 #### 给读者', () => {
    const html = markdownToWechatHtml('#### 四级标题', FULL_STYLE)
    expect(html).toContain('<h3 style="font-size:17px;">四级标题</h3>')
    expect(html).not.toContain('####')
  })

  it('单星号斜体渲染成内联 em', () => {
    const html = markdownToWechatHtml('这句*有点意思*。', FULL_STYLE)
    expect(html).toContain('<em style="font-style:italic;">有点意思</em>')
  })

  it('星号夹在汉字之间当乘号用，不被误判成斜体（长*宽*高）', () => {
    const html = markdownToWechatHtml('长*宽*高', FULL_STYLE)
    expect(html).not.toContain('<em')
    expect(html).toContain('长*宽*高')
  })

  it('转义不处理引号——对齐 export.py 的 html.escape(quote=False)', () => {
    const html = markdownToWechatHtml('他说"你好"', FULL_STYLE)
    expect(html).toContain('"你好"')
    expect(html).not.toContain('&quot;')
  })
})

// ── P1a 给 export.py 补的三样东西，这里是它们的 TS 对齐 ──────────────────────────────
// export.py 的 md_to_wechat_html 早于本轮任务就支持图片行、genimage/mermaid 占位框；
// TS 这份此前只覆盖了标题/段落/列表/引用/分隔线/粗斜体。下面三组用例专门盯住新补的行为，
// 用法与断言口径抄自 export.py 对应的 Python 单测（test_export.py 的 md_to_wechat_html 用例）。
describe('markdownToWechatHtml · 图片行（对齐 export.py 的独占一行规则）', () => {
  const IMG_STYLE = {
    body: 'font-size:16px;',
    img: 'display:block;max-width:100%;',
    figcaption: 'text-align:center;color:#999;'
  }

  it('独占一行的图片渲成 <img> + <figcaption>，不包进 <p>', () => {
    const html = markdownToWechatHtml('![一张示意图](../images/x.png)', IMG_STYLE)
    expect(html).toBe(
      '<img src="../images/x.png" alt="一张示意图" style="display:block;max-width:100%;" />\n' +
        '<figcaption style="text-align:center;color:#999;">一张示意图</figcaption>'
    )
    expect(html).not.toContain('<p')
  })

  it('图说为空时不产出 figcaption', () => {
    const html = markdownToWechatHtml('![](../images/x.png)', IMG_STYLE)
    expect(html).toContain('<img')
    expect(html).not.toContain('<figcaption')
  })

  it('图说里的 HTML 特殊字符要转义（alt 属性内连引号也要转义，否则提前闭合属性）', () => {
    const html = markdownToWechatHtml('![<b>"AI"</b> & 图](x.png)', IMG_STYLE)
    // alt 是属性值：& < > " 全部要转义，否则图说里的双引号会把 alt="..." 提前截断，
    // 后面的文本被解释成新属性——是一处真实的注入面。
    expect(html).toContain('alt="&lt;b&gt;&quot;AI&quot;&lt;/b&gt; &amp; 图"')
    expect(html).not.toContain('alt="<b>')
    // figcaption 是文本节点：& < > 转义，引号对齐 export.py 的 html.escape(quote=False) 不转义。
    expect(html).toContain('<figcaption style="text-align:center;color:#999;">&lt;b&gt;"AI"&lt;/b&gt; &amp; 图</figcaption>')
  })

  it('style 缺 img/figcaption 键时回退到内置默认样式，不渲染成完全无样式的裸元素', () => {
    const html = markdownToWechatHtml('![图说](x.png)', { body: 'font-size:16px;' })
    expect(html).toContain('style="display:block;max-width:100%;height:auto;margin:1.4em auto 0.4em auto;"')
    expect(html).toContain('style="display:block;text-align:center;font-size:13px;color:#999999;"')
  })

  it('句子中间夹的图（非独占一行）不渲成 <img>，原样当文字转义漏进 <p>——照抄 export.py 的取舍', () => {
    // export.py 的 md_to_wechat_html 本身对行内图片就是这个态度：真正拦这种稿子的硬闸
    // （inline_images）在 export.py 的 main() 里，是 CLI 专属前置校验，不属于这个纯渲染函数。
    const html = markdownToWechatHtml('这段话里夹了张 ![小图](x.png) 图片。', { body: 'font-size:16px;' })
    expect(html).not.toContain('<img')
    expect(html).toContain('<p')
    expect(html).toContain('![小图](x.png)')
  })

  it('普通 markdown 链接（无前导感叹号）不会被误判成图片', () => {
    const html = markdownToWechatHtml('[链接文字](https://example.com)', { body: 'font-size:16px;' })
    expect(html).not.toContain('<img')
    expect(html).toContain('<p')
    expect(html).toContain('[链接文字](https://example.com)')
  })
})

describe('markdownToWechatHtml · genimage/mermaid 占位框（对齐 export.py 的 fence_placeholder_html）', () => {
  it('```genimage 块渲成占位框，HTML 里不出现围栏源码，占位框里带图说', () => {
    const md = ['```genimage', '图说: 封面配图', '一只猫在写代码', '```'].join('\n')
    const html = markdownToWechatHtml(md, FALLBACK_WECHAT_STYLE)
    expect(html).toContain('封面配图')
    expect(html).toContain('待出图')
    expect(html).not.toContain('```')
    expect(html).not.toContain('图说:')
    expect(html).not.toContain('图说：')
    expect(html).not.toContain('一只猫在写代码')
  })

  it('```mermaid 块渲成占位框，HTML 里不出现 graph TD 之类的源码', () => {
    const md = ['```mermaid', '图说: 流程示意', 'graph TD', 'A-->B'].join('\n') + '\n```'
    const html = markdownToWechatHtml(md, FALLBACK_WECHAT_STYLE)
    expect(html).toContain('流程示意')
    expect(html).toContain('待渲染的信息图')
    expect(html).not.toContain('graph TD')
    expect(html).not.toContain('A-->B')
    expect(html).not.toContain('```')
  })

  it('没有图说的 mermaid 块不硬塞占位文案，只出占位框本体，不抛异常', () => {
    const md = ['```mermaid', 'graph TD', 'A-->B', '```'].join('\n')
    expect(() => markdownToWechatHtml(md, FALLBACK_WECHAT_STYLE)).not.toThrow()
    const html = markdownToWechatHtml(md, FALLBACK_WECHAT_STYLE)
    expect(html).toContain('待渲染的信息图')
    expect(html).not.toContain('graph TD')
  })

  it('空的 genimage 块（无正文无图说）渲成占位框，不抛异常', () => {
    const md = ['```genimage', '```'].join('\n')
    expect(() => markdownToWechatHtml(md, FALLBACK_WECHAT_STYLE)).not.toThrow()
    expect(markdownToWechatHtml(md, FALLBACK_WECHAT_STYLE)).toContain('待出图')
  })

  it('未闭合的围栏一路吃到文末，不抛异常也不泄漏源码', () => {
    const md = ['正文第一行', '```genimage', '图说: 没写完的图', '后面都被吃进围栏了'].join('\n')
    expect(() => markdownToWechatHtml(md, FALLBACK_WECHAT_STYLE)).not.toThrow()
    const html = markdownToWechatHtml(md, FALLBACK_WECHAT_STYLE)
    expect(html).toContain('正文第一行')
    expect(html).toContain('没写完的图')
    expect(html).not.toContain('后面都被吃进围栏了')
    expect(html).not.toContain('```')
  })

  it('其余语言的围栏块（如 ```python）不受影响，仍按逐行旧路径渲染——不是本次要修的通用代码块渲染', () => {
    const md = ['```python', 'print(1)', '```'].join('\n')
    const html = markdownToWechatHtml(md, FALLBACK_WECHAT_STYLE)
    expect(html).toContain('print(1)')
    expect(html).toContain('```python')
  })
})

describe('loadWechatStyle', () => {
  it('读到真实的 wechat-default 样式 JSON（字段名对齐 export.py 的 schema）', () => {
    const style = loadWechatStyle('wechat-default')
    expect(style).not.toBeNull()
    if (!style) return
    expect(style.body).toBeDefined()
    expect(style.h1).toBeDefined()
    expect(style.quote).toBeDefined()
    expect(style.hr).toBeDefined()
    // load_style() 在 Python 侧会把 `name` 元字段过滤掉（`k != "name"`），TS 侧同理不应带上。
    expect(style.name).toBeUndefined()
  })

  it('读到真实的 wechat-serif 样式 JSON', () => {
    const style = loadWechatStyle('wechat-serif')
    expect(style).not.toBeNull()
    if (!style) return
    expect(style.body).toContain('serif')
  })

  it('样式名不存在时回 null，不抛错', () => {
    expect(loadWechatStyle('does-not-exist')).toBeNull()
  })
})

describe('FALLBACK_WECHAT_STYLE', () => {
  it('字段名对齐真实 schema（body 而非 p），保证降级态仍有正文样式', () => {
    expect(FALLBACK_WECHAT_STYLE.body).toBeDefined()
    expect((FALLBACK_WECHAT_STYLE as Record<string, string>).p).toBeUndefined()
  })
})
