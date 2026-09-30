import { describe, it, expect } from 'bun:test'

import { normalizeReleaseNotes } from './releaseNotes'

describe('normalizeReleaseNotes — 空值与畸形输入', () => {
  it('没有更新说明时返回 null，而不是空串', () => {
    expect(normalizeReleaseNotes(null)).toBeNull()
    expect(normalizeReleaseNotes(undefined)).toBeNull()
    expect(normalizeReleaseNotes('')).toBeNull()
    expect(normalizeReleaseNotes('   \n  ')).toBeNull()
  })

  it('非字符串非数组一律当没有，绝不抛错', () => {
    expect(normalizeReleaseNotes(42)).toBeNull()
    expect(normalizeReleaseNotes({ note: 'x' })).toBeNull()
    expect(normalizeReleaseNotes(true)).toBeNull()
  })

  it('GitHub 的空占位「No content.」等于没有说明', () => {
    expect(normalizeReleaseNotes('No content.')).toBeNull()
  })
})

describe('normalizeReleaseNotes — HTML 形态（GitHub provider 给的就是这个）', () => {
  it('剥掉标签只留文字', () => {
    expect(normalizeReleaseNotes('<p>修了登录页的报错文案</p>')).toBe('修了登录页的报错文案')
  })

  it('列表项变成「- 」开头的行', () => {
    const out = normalizeReleaseNotes('<ul><li>新增导出对话</li><li>修了几个缺陷</li></ul>')
    expect(out).toBe('- 新增导出对话\n- 修了几个缺陷')
  })

  it('段落与换行标签变成真换行', () => {
    expect(normalizeReleaseNotes('<p>第一段</p><p>第二段</p>')).toBe('第一段\n\n第二段')
    expect(normalizeReleaseNotes('甲<br>乙')).toBe('甲\n乙')
  })

  it('标题标签自成一行，不和正文黏在一起', () => {
    expect(normalizeReleaseNotes('<h2>新功能</h2><p>导出对话</p>')).toBe('新功能\n\n导出对话')
  })

  it('HTML 实体要解码，别让用户看见 &amp;', () => {
    expect(normalizeReleaseNotes('<p>A &amp; B</p>')).toBe('A & B')
    expect(normalizeReleaseNotes('<p>&lt;script&gt;</p>')).toBe('<script>')
    expect(normalizeReleaseNotes('<p>it&#39;s</p>')).toBe("it's")
    expect(normalizeReleaseNotes('<p>&quot;引&quot;&nbsp;号</p>')).toBe('"引" 号')
  })

  it('不留连续空行——GitHub 的 HTML 里全是缩进和换行', () => {
    const html = '<ul>\n  <li>甲</li>\n\n  <li>乙</li>\n</ul>'
    expect(normalizeReleaseNotes(html)).toBe('- 甲\n- 乙')
  })
})

describe('normalizeReleaseNotes — Markdown 形态（GitHub API 回落给的是原文）', () => {
  it('Markdown 原样保留，不去动它的符号', () => {
    const md = '## 新功能\n\n- 导出对话\n- 键盘快捷键'
    expect(normalizeReleaseNotes(md)).toBe(md)
  })
})

describe('normalizeReleaseNotes — 数组形态（fullChangelog 时是这个）', () => {
  it('多版本按给定顺序拼起来，每段带版本号抬头', () => {
    const out = normalizeReleaseNotes([
      { version: '0.0.57', note: '<p>甲</p>' },
      { version: '0.0.56', note: '<p>乙</p>' }
    ])
    expect(out).toBe('0.0.57\n\n甲\n\n0.0.56\n\n乙')
  })

  it('note 为空的版本整条跳过，不留一个光秃秃的版本号', () => {
    const out = normalizeReleaseNotes([
      { version: '0.0.57', note: null },
      { version: '0.0.56', note: '<p>乙</p>' }
    ])
    expect(out).toBe('0.0.56\n\n乙')
  })

  it('整个数组都没内容时返回 null', () => {
    expect(normalizeReleaseNotes([{ version: '1', note: null }])).toBeNull()
  })

  it('数组里混进畸形项也不抛错', () => {
    const out = normalizeReleaseNotes([null, 'x', { version: '1', note: '好' }] as unknown)
    expect(out).toBe('1\n\n好')
  })
})

describe('normalizeReleaseNotes — 长度上限', () => {
  it('超长正文截断并加省略号，免得把设置页撑爆', () => {
    const out = normalizeReleaseNotes('甲'.repeat(9000))
    expect(out).not.toBeNull()
    expect(out!.length).toBeLessThanOrEqual(4001)
    expect(out!.endsWith('…')).toBe(true)
  })

  it('没超长就不动它，末尾不该凭空多个省略号', () => {
    expect(normalizeReleaseNotes('短说明')).toBe('短说明')
  })
})

describe('normalizeReleaseNotes — GitHub 自动生成的空正文（2026-09-30 实测发现）', () => {
  it('只有「Full Changelog」链接时等于没有说明——那是 GitHub 自动塞的，不是人写的', () => {
    const body = '**Full Changelog**: https://github.com/o/r/commits/v0.0.55'
    expect(normalizeReleaseNotes(body)).toBeNull()
  })

  it('HTML 形态的同款自动正文同样识别', () => {
    // GitHub 自动生成这行时，锚文本就是 URL 本身——剥标签后 URL 仍在。
    const url = 'https://github.com/o/r/commits/v0.0.55'
    const html = `<p><strong>Full Changelog</strong>: <a href="${url}">${url}</a></p>`
    expect(normalizeReleaseNotes(html)).toBeNull()
  })

  it('人写了真内容时保留内容，只摘掉末尾那行开发者链接', () => {
    const body = '## 新功能\n\n- 导出对话\n\n**Full Changelog**: https://github.com/o/r/compare/a...b'
    const out = normalizeReleaseNotes(body)
    expect(out).toBe('## 新功能\n\n- 导出对话')
    expect(out).not.toContain('Full Changelog')
  })

  it('正文里提到 changelog 字样但不是那行链接的，不能误删', () => {
    expect(normalizeReleaseNotes('- 重写了 changelog 生成脚本')).toBe('- 重写了 changelog 生成脚本')
  })
})
