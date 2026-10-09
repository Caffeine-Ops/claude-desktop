import { describe, expect, it } from 'bun:test'

import { userMessageCopyText } from './userMessageCopy'

/**
 * 用户气泡「复制」钮的判定与取文。
 *
 * 这个纯函数替组件回答两件事：这条消息该不该长出复制钮（null = 不该），
 * 以及按下后往剪贴板写什么。抠出来的理由就是下面那组「协议消息」用例——
 * 以后新增一种首行协议标记的卡片气泡时，忘了在这里排除，复制钮就会长在
 * 卡片底下、把内部 JSON 吐进剪贴板，而这种缺陷手工点一遍永远碰不到
 * （得正好选中一个表格区域去问 AI 才复现）。
 */

describe('userMessageCopyText — 普通消息原样复制', () => {
  it('普通一句话原样返回', () => {
    expect(userMessageCopyText('帮我看看这个部署脚本')).toBe('帮我看看这个部署脚本')
  })

  it('多行消息保留换行——复制回输入框要能原样重发', () => {
    const raw = '第一行\n第二行\n\n第四行'
    expect(userMessageCopyText(raw)).toBe(raw)
  })

  it('文件引用保留 @"路径" 原始写法，不压缩成文件名', () => {
    // 2026-10-09 用户拍板：复制自己发的话主要是为了粘回输入框改两个字
    // 重发，所以要原始格式——mention chip 粘回去才能原样恢复。压缩成
    // 「deploy.sh」好看，但粘回输入框就只是一段普通文字了。
    const raw = '你看下 @"/Users/kika/project/x/scripts/deploy.sh" 有没有问题'
    expect(userMessageCopyText(raw)).toBe(raw)
  })

  it('首尾空白不裁——复制的是用户原文，不是归一化后的文本', () => {
    expect(userMessageCopyText('  留着两边的空格  ')).toBe('  留着两边的空格  ')
  })

  it('斜杠命令消息照常可复制（它就是用户真发出去的那行）', () => {
    expect(userMessageCopyText('/news 今天的科技头条')).toBe('/news 今天的科技头条')
  })
})

describe('userMessageCopyText — 不该长复制钮的消息', () => {
  it('空消息（纯图片消息的文本部分）→ null', () => {
    expect(userMessageCopyText('')).toBeNull()
  })

  it('只有空白（空格/换行/Tab）→ null，别给一个复制空气的钮', () => {
    expect(userMessageCopyText('   \n\t  \n ')).toBeNull()
  })

  it('表格框选问 AI 的协议消息 → null（屏幕上是卡片，不是这段 JSON）', () => {
    const raw =
      '[[sheet-selection]]{"name":"销售表.xlsx","path":"/p/销售表.xlsx",' +
      '"sheet":"Sheet1","range":"A1:C9","q":"这几列的增长率算一下"}\n' +
      'A1\tB1\tC1\n1\t2\t3'
    expect(userMessageCopyText(raw)).toBeNull()
  })

  it('图片标记编辑的协议消息 → null', () => {
    const raw =
      '[[image-edit]]{"name":"封面.png","path":"/p/封面.png",' +
      '"edits":[{"x":31.4,"y":22,"note":"这里换成蓝色"}],"extra":"","fusion":[]}'
    expect(userMessageCopyText(raw)).toBeNull()
  })

  it('图片标记协议消息被 skill slash 领跑时同样 → null', () => {
    // CLI 文本形态：slash 必须占开头才能强制触发 imagegen skill，历史恢复
    // 渲染的就是这一版（见 messageMarkers 的 parseImageEditMessage 注释）。
    const raw =
      '/claude-desktop:imagegen [[image-edit]]{"name":"封面.png","path":"/p/封面.png",' +
      '"edits":[{"x":10,"y":10,"note":"去掉水印"}],"extra":"","fusion":[]}'
    expect(userMessageCopyText(raw)).toBeNull()
  })

  it('协议标记认得出但 JSON 被截断 → 仍然 null', () => {
    // 这一条是最容易漏的：JSON 解析失败时 parse 函数返回 null，组件会
    // 退回普通气泡渲染，于是屏幕上显示的是半截 JSON。给它一个复制钮等于
    // 把残片喂进剪贴板。messageMarkers 的 stripMessageMarker 为同一类
    // 截断踩过两次事故（2026-07-13），这里按同样的保守口径处理。
    const raw = '[[image-edit]]{"name":"封面.png","path":"/p/封面.png","edits":[{"x":31.4'
    expect(userMessageCopyText(raw)).toBeNull()
  })
})

describe('userMessageCopyText — 不能把普通文本误判成协议消息', () => {
  it('正文里提到标记字样（前面有正常文字）→ 照常可复制', () => {
    const raw = '我看到 [[image-edit]] 这个标记是什么意思？'
    expect(userMessageCopyText(raw)).toBe(raw)
  })

  it('标记出现在第二行（首行是正常文字）→ 照常可复制', () => {
    const raw = '这段日志里有个奇怪的东西：\n[[sheet-selection]]{"a":1}'
    expect(userMessageCopyText(raw)).toBe(raw)
  })

  it('表格标记不接受 slash 领跑——它的协议要求顶格，领跑的就是普通文本', () => {
    // parseSheetSelectionMessage 用的是 startsWith，不像 image-edit 那样
    // 放行 `/slash ` 前缀。这里跟着它走，免得两处判定漂移。
    const raw = '/news [[sheet-selection]]{"name":"a.xlsx","range":"A1"}'
    expect(userMessageCopyText(raw)).toBe(raw)
  })
})
