import { describe, expect, it } from 'bun:test'

import { chatHeaderTitle, splitSlashTitle } from './chatTitle'

/**
 * 会话标题里的斜杠命令前缀拆分。原先内联在 ThreadView 的渲染体里，
 * 导出对话也要用同一份拆分结果（导出的标题必须和顶栏显示的一致——
 * 2026-09-28 真机走查就栽在这条），抽成纯函数后两边共用一个写手。
 */

describe('splitSlashTitle — 拆得开的形态', () => {
  it('带命名空间的技能命令：短名进 chip，参数才是标题', () => {
    const r = splitSlashTitle('/claude-desktop:ppt-creator 武汉大学介绍')
    expect(r.cmdFull).toBe('/claude-desktop:ppt-creator')
    expect(r.cmdShort).toBe('/ppt-creator')
    expect(r.restTitle).toBe('武汉大学介绍')
  })

  it('没有命名空间时，短名等于全名', () => {
    const r = splitSlashTitle('/news 今天的科技头条')
    expect(r.cmdFull).toBe('/news')
    expect(r.cmdShort).toBe('/news')
    expect(r.restTitle).toBe('今天的科技头条')
  })

  it('参数里有换行时整段保留（标题可能是多行的第一段）', () => {
    const r = splitSlashTitle('/writing 第一行\n第二行')
    expect(r.restTitle).toBe('第一行\n第二行')
  })

  it('参数中间的空格不当分隔符，只吃掉命令后的第一段空白', () => {
    const r = splitSlashTitle('/news  今天 的 头条')
    expect(r.restTitle).toBe('今天 的 头条')
  })
})

describe('splitSlashTitle — 不该拆的形态', () => {
  it('纯命令没有参数时不拆——命令本身就是用户看到的标题', () => {
    const r = splitSlashTitle('/news')
    expect(r.cmdFull).toBeNull()
    expect(r.cmdShort).toBeNull()
    expect(r.restTitle).toBe('/news')
  })

  it('不以斜杠开头的普通标题原样返回', () => {
    const r = splitSlashTitle('登录页报错文案')
    expect(r.cmdFull).toBeNull()
    expect(r.restTitle).toBe('登录页报错文案')
  })

  it('空标题不炸，也不会拆出空的 chip', () => {
    const r = splitSlashTitle('')
    expect(r.cmdFull).toBeNull()
    expect(r.restTitle).toBe('')
  })

  it('只有斜杠和空白（命令没打完）不拆', () => {
    const r = splitSlashTitle('/   ')
    expect(r.cmdFull).toBeNull()
    expect(r.restTitle).toBe('/   ')
  })
})

/**
 * chatHeaderTitle 是顶栏标题的**完整派生链**（剥协议标记 → 压 @mention →
 * 兜底 → 拆斜杠命令）。顶栏显示和导出文件名必须读同一份结果——两边各算
 * 一遍就是 2026-09-28 那个「导出的标题和屏幕上不一样」缺陷的成因。
 */
describe('chatHeaderTitle — 顶栏与导出共用的标题派生', () => {
  it('普通标题原样透出，restTitle 与 display 一致', () => {
    const r = chatHeaderTitle('登录页报错文案', '新对话')
    expect(r.display).toBe('登录页报错文案')
    expect(r.restTitle).toBe('登录页报错文案')
    expect(r.cmdFull).toBeNull()
  })

  it('标题为 null（会话还没命名）时用兜底文案', () => {
    const r = chatHeaderTitle(null, '新对话')
    expect(r.display).toBe('新对话')
    expect(r.restTitle).toBe('新对话')
  })

  it('标题只有空白时同样走兜底，不产生空标题', () => {
    expect(chatHeaderTitle('   ', '新对话').display).toBe('新对话')
  })

  it('斜杠命令标题：display 保留全文，restTitle 只留正文', () => {
    const r = chatHeaderTitle('/claude-desktop:ppt-creator 武汉大学介绍', '新对话')
    expect(r.display).toBe('/claude-desktop:ppt-creator 武汉大学介绍')
    expect(r.restTitle).toBe('武汉大学介绍')
    expect(r.cmdShort).toBe('/ppt-creator')
  })

  it('标题里的 @mention 绝对路径压成文件名，不把一整条路径带进导出名', () => {
    const r = chatHeaderTitle('帮我修改@"/Users/kika/deck.pptx"：换个封面', '新对话')
    expect(r.restTitle).not.toContain('/Users/kika')
    expect(r.restTitle).toContain('deck.pptx')
  })
})

describe('chatHeaderTitle — hasTitle（会话到底有没有标题）', () => {
  it('有真标题时为 true', () => {
    expect(chatHeaderTitle('登录页报错文案', '新对话').hasTitle).toBe(true)
  })

  it('null / 空白标题为 false', () => {
    expect(chatHeaderTitle(null, '新对话').hasTitle).toBe(false)
    expect(chatHeaderTitle('   ', '新对话').hasTitle).toBe(false)
  })

  it('标题字面就叫「新对话」时仍是 true——不能靠比对兜底文案来判', () => {
    // 拿 display 和兜底文案比对是个诱人的捷径，但真把会话命名成「新对话」
    // 的用户会被误判成「没标题」，重命名弹窗预填成空串。
    const r = chatHeaderTitle('新对话', '新对话')
    expect(r.hasTitle).toBe(true)
  })
})
