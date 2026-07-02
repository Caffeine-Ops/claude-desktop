import { describe, it, expect } from 'bun:test'

import { removeImageOccurrence } from './proposalImageOps'

describe('removeImageOccurrence', () => {
  it('独占一行的图片被干净摘除（trim 后不留空白伪影）', () => {
    const block = '![alt](/a/b.png)'
    expect(removeImageOccurrence(block, '/a/b.png', 0)).toBe('')
  })

  it('inline 图片：前后都有文字时，摘除后用恰好一个空格衔接（Finding 1）', () => {
    const block = 'See image: ![alt](/a/b.png) shown above'
    expect(removeImageOccurrence(block, '/a/b.png', 0)).toBe('See image: shown above')
  })

  it('图片在行首：前面无文字，直接拼接后面文字、不留多余空格', () => {
    const block = '![alt](/a/b.png) rest of text'
    expect(removeImageOccurrence(block, '/a/b.png', 0)).toBe('rest of text')
  })

  it('图片在行尾：后面无文字，直接拼接前面文字、不留多余空格', () => {
    const block = 'some text ![alt](/a/b.png)'
    expect(removeImageOccurrence(block, '/a/b.png', 0)).toBe('some text')
  })

  it('图片独占中间一行（前后靠换行天然分隔）：不额外插入空格，换行原样保留', () => {
    const block = 'line before\n![alt](/a/b.png)\nline after'
    // 换行本身已经是分隔，不需要（也不应该）额外插一个空格；中间留下的双换行是既有行为
    // （旧实现同样不折叠内部空行，只在整块层面 trim 首尾），非本次修复范围。
    expect(removeImageOccurrence(block, '/a/b.png', 0)).toBe('line before\n\nline after')
  })

  it('同路径重复出现：occurrence=0 只删第一个，第二个原样保留', () => {
    const block = '![a](/x.png) 中间文字 ![a](/x.png)'
    expect(removeImageOccurrence(block, '/x.png', 0)).toBe('中间文字 ![a](/x.png)')
  })

  it('同路径重复出现：occurrence=1 只删第二个，第一个原样保留（Finding 2）', () => {
    const block = '![a](/x.png) 中间文字 ![a](/x.png)'
    expect(removeImageOccurrence(block, '/x.png', 1)).toBe('![a](/x.png) 中间文字')
  })

  it('路径不存在：原样返回，不做任何改动', () => {
    const block = 'text ![alt](/a/b.png) more text'
    expect(removeImageOccurrence(block, '/not/found.png', 0)).toBe(block)
  })

  it('occurrence 超出该路径实际出现次数：原样返回', () => {
    const block = '![a](/x.png) text'
    expect(removeImageOccurrence(block, '/x.png', 1)).toBe(block)
  })

  it('title 后缀与 <> 包裹路径也能正确归一化匹配', () => {
    expect(removeImageOccurrence('前 ![alt](<a b.png> "标题") 后', 'a b.png', 0)).toBe('前 后')
  })
})
