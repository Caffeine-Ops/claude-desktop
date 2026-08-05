import { describe, expect, it } from 'bun:test'
import { buildMissingImagesMsg, deriveWritingExportBaseName } from './writingExportInput'

describe('deriveWritingExportBaseName', () => {
  it('取第一个一级标题', () => {
    expect(deriveWritingExportBaseName('# 我的周报\n\n正文')).toBe('我的周报')
  })

  it('多节拼合后仍只取全篇第一个一级标题', () => {
    const md = '# 第一章\n\n正文一\n\n<!--proposal-pagebreak-->\n\n# 第二章\n\n正文二'
    expect(deriveWritingExportBaseName(md)).toBe('第一章')
  })

  it('标题前后空白被裁剪', () => {
    expect(deriveWritingExportBaseName('#   带空格的标题   \n\n正文')).toBe('带空格的标题')
  })

  it('二级标题不算数，只认一级', () => {
    expect(deriveWritingExportBaseName('## 不是一级标题\n\n正文')).toBe('文稿')
  })

  it('没有标题回退「文稿」', () => {
    expect(deriveWritingExportBaseName('只有正文，没有标题')).toBe('文稿')
  })

  it('空串回退「文稿」', () => {
    expect(deriveWritingExportBaseName('')).toBe('文稿')
  })

  it('一级标题内容为空白也回退「文稿」', () => {
    expect(deriveWritingExportBaseName('#    \n\n正文')).toBe('文稿')
  })
})

// 图片就位闸拦下导出时给用户看的那句话。**闸本身在 main 侧**（findMissingWritingImages，
// 它要碰磁盘），这里只管措辞——拆成纯函数才进得了 bun test 的覆盖目录（组件文件进不去）。
//
// 措辞要求：① 说清缺几张（用户据此判断是漏了一张还是整个 images/ 没同步过来）；
// ② 列出具体是哪几张（照着补图）；③ 明确「已中止」，不能让用户以为导出了一份不完整的。
describe('buildMissingImagesMsg', () => {
  it('缺 1 张：报数量 + 路径 + 已中止', () => {
    expect(buildMissingImagesMsg([{ src: '../images/cover.png', resolved: '/p/images/cover.png' }]))
      .toBe('缺 1 张配图，已中止导出：../images/cover.png')
  })

  it('缺多张：逐张列出', () => {
    const msg = buildMissingImagesMsg([
      { src: '../images/a.png', resolved: '/p/a.png' },
      { src: '../images/b.png', resolved: '/p/b.png' }
    ])
    expect(msg).toBe('缺 2 张配图，已中止导出：../images/a.png、../images/b.png')
  })

  it('超过 3 张只列前 3 张，但【明说】还有几张没列——截断必须可见，否则用户补完 3 张再导出又被拦，不知道为什么', () => {
    const msg = buildMissingImagesMsg(
      ['a', 'b', 'c', 'd', 'e'].map((n) => ({ src: `../images/${n}.png`, resolved: `/p/${n}.png` }))
    )
    expect(msg).toBe(
      '缺 5 张配图，已中止导出：../images/a.png、../images/b.png、../images/c.png（另有 2 张未列出）'
    )
  })
})
