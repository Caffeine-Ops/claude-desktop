import { describe, expect, it } from 'bun:test'
import { resolveRelativeAssetPath, toWritingAssetUrl } from './writingAssetUrl'

describe('toWritingAssetUrl', () => {
  it('写作项目配图转成 writingasset:// URL', () => {
    const p = '/Users/k/projects/稿子_20260803/images/gen-1.png'
    expect(toWritingAssetUrl(p)).toBe(`writingasset://w/${encodeURIComponent(p)}`)
  })

  it('非写作资产路径原样返回——链式判定靠这个不误伤外链与 KB 图', () => {
    expect(toWritingAssetUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(toWritingAssetUrl('/Users/k/kb-index/assets/x.png')).toBe('/Users/k/kb-index/assets/x.png')
  })

  it('空串原样返回', () => {
    expect(toWritingAssetUrl('')).toBe('')
  })
})

// 正文里的图路径恒为相对路径（正文分节文件在 <项目>/drafts/，图在 <项目>/images/，
// 是兄弟目录），AssistantMarkdown 的 img 覆写要先把它解析成绝对路径才能进
// kb → proposal → writing 链（三者判定都是绝对路径谓词）。见 task-1-brief.md
// 之外的控制者裁定：渲染进程拿不到 node:path，手写 posix 语义的归一化。
describe('resolveRelativeAssetPath', () => {
  it('../ 上跳一级到兄弟目录', () => {
    expect(resolveRelativeAssetPath('/p/稿子/drafts', '../images/a.png')).toBe(
      '/p/稿子/images/a.png'
    )
  })

  it('./ 同级目录', () => {
    expect(resolveRelativeAssetPath('/p/稿子/drafts', './x.png')).toBe('/p/稿子/drafts/x.png')
  })

  it('绝对路径原样返回', () => {
    expect(resolveRelativeAssetPath('/p/稿子/drafts', '/other/abs.png')).toBe('/other/abs.png')
  })

  it('http(s) 外链原样返回', () => {
    expect(resolveRelativeAssetPath('/p/稿子/drafts', 'https://example.com/a.png')).toBe(
      'https://example.com/a.png'
    )
  })

  it('base 为空串时原样返回', () => {
    expect(resolveRelativeAssetPath('', '../images/a.png')).toBe('../images/a.png')
  })
})
