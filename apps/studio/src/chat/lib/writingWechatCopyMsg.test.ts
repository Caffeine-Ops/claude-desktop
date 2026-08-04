import { describe, expect, it } from 'bun:test'
import { buildWechatCopyMsg, countMarkdownImages } from './writingWechatCopyMsg'

describe('countMarkdownImages', () => {
  it('数出正文里 markdown 图片语法的出现次数', () => {
    const md = '第一段\n\n![图说1](../images/a.png)\n\n第二段\n\n![图说2](../images/b.png)'
    expect(countMarkdownImages(md)).toBe(2)
  })

  it('没有图片时返回 0', () => {
    expect(countMarkdownImages('纯文字正文，没有配图')).toBe(0)
  })

  it('同一行出现多张图也都数进去', () => {
    const md = '![a](x.png)![b](y.png)'
    expect(countMarkdownImages(md)).toBe(2)
  })
})

describe('buildWechatCopyMsg · 终审 #4：公众号复制提示不能掩盖配图丢失', () => {
  it('正文没有配图、样式也正常时，维持原来的绿色成功提示', () => {
    const msg = buildWechatCopyMsg('纯文字正文', false)
    expect(msg).toEqual({ tone: 'ok', text: '已复制，可粘贴进公众号编辑器' })
  })

  it('正文含配图时，提示必须点出张数与「需要手动上传」——不能再是掩盖问题的绿色成功态', () => {
    // 【这是本条要钉住的行为】剪贴板 text/html flavor 没有 base URL，`![图说](../images/x.png)`
    // 这种相对路径在公众号编辑器里解析不到、会被静默丢弃。旧文案「已复制，可粘贴进公众号
    // 编辑器」在这种情况下是一句假话——图全丢了却还是绿色成功提示。
    const md = '正文\n\n![图说](../images/x.png)'
    const msg = buildWechatCopyMsg(md, false)
    expect(msg.tone).toBe('muted')
    expect(msg.text).toContain('1 张配图')
    expect(msg.text).toContain('需要在编辑器里手动上传')
  })

  it('正文含多张配图时，张数如实反映在提示里', () => {
    const md = ['![图1](../images/a.png)', '正文', '![图2](../images/b.png)', '![图3](../images/c.png)'].join(
      '\n\n'
    )
    const msg = buildWechatCopyMsg(md, false)
    expect(msg.text).toContain('3 张配图')
  })

  it('样式回退与配图丢失同时发生时，两条提示都要保留，互不覆盖', () => {
    const md = '正文\n\n![图说](../images/x.png)'
    const msg = buildWechatCopyMsg(md, true)
    expect(msg.tone).toBe('muted')
    expect(msg.text).toContain('样式文件未找到，用了内置样式')
    expect(msg.text).toContain('1 张配图')
  })

  it('只有样式回退、没有配图时，维持原来那句一字不变的样式回退提示（本次修复不该动这个分支）', () => {
    const msg = buildWechatCopyMsg('纯文字正文', true)
    expect(msg).toEqual({ tone: 'muted', text: '已复制（样式文件未找到，用了内置样式）' })
  })
})
