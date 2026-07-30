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
