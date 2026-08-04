import { describe, expect, it } from 'bun:test'
import { applyGenImageToSection, discardGenImageFromSection } from './writingGenImageApply'

const RAW = '```genimage\n图说: 深夜的便利店\n暖黄灯光\n```'
const MD = `第一段。\n\n${RAW}\n\n第二段。`

describe('applyGenImageToSection', () => {
  it('指令块原地换成图片引用，前后正文不动', () => {
    const out = applyGenImageToSection(MD, RAW, 0, '深夜的便利店', '../images/gen-1.png')
    expect(out).toBe('第一段。\n\n![深夜的便利店](../images/gen-1.png)\n\n第二段。')
  })

  it('同内容多个指令块按 occurrence 精确定位第二个', () => {
    const two = `${RAW}\n\n中间。\n\n${RAW}`
    const out = applyGenImageToSection(two, RAW, 1, '图', '../images/a.png')
    expect(out).toBe(`${RAW}\n\n中间。\n\n![图](../images/a.png)`)
  })

  it('定位不到回 null——审阅悬而未决期间该节可能被改写，绝不能瞎猜位置乱替换', () => {
    expect(applyGenImageToSection('别的内容', RAW, 0, '图', '../images/a.png')).toBeNull()
  })
})

describe('discardGenImageFromSection', () => {
  it('删掉指令块且不留下连续空行', () => {
    const out = discardGenImageFromSection(MD, RAW, 0)
    expect(out).toBe('第一段。\n\n第二段。')
  })

  it('定位不到回 null', () => {
    expect(discardGenImageFromSection('别的内容', RAW, 0)).toBeNull()
  })
})
