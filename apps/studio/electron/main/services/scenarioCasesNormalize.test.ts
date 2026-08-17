import { describe, it, expect } from 'bun:test'

import { normalizeScenarioCaseGallery } from './scenarioCasesNormalize'

/**
 * 校验策略与 scenarioCatalogService 同源：顶层结构坏了整份拒收（返回 null），
 * 单条案例坏了只跳过那一条。服务端（sub2api）保存时已经从严校验过，这里是
 * 面向「缓存被手改 / 老版本格式」的第二道，从宽。
 */

const good = {
  id: 'c1',
  skill: '/cowork:ppt-creator',
  title: '案例一',
  cover: 'https://cdn.example.com/a.jpg',
  images: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
  description: '说明',
  prompt: '帮我做一份【PPT主题】的PPT'
}

describe('normalizeScenarioCaseGallery', () => {
  it('合法 payload 原样通过，version 保留', () => {
    const out = normalizeScenarioCaseGallery({ version: 7, cases: [good] })
    expect(out).toEqual({ version: 7, cases: [good] })
  })

  it('顶层不是对象 / cases 不是数组 → null（整份拒收）', () => {
    expect(normalizeScenarioCaseGallery(null)).toBeNull()
    expect(normalizeScenarioCaseGallery('x')).toBeNull()
    expect(normalizeScenarioCaseGallery({ version: 1 })).toBeNull()
    expect(normalizeScenarioCaseGallery({ version: 1, cases: 'nope' })).toBeNull()
  })

  it('空列表是合法的（运营清空了案例），不是 null', () => {
    expect(normalizeScenarioCaseGallery({ version: 2, cases: [] })).toEqual({
      version: 2,
      cases: []
    })
  })

  it('version 缺省/非法回落 0', () => {
    expect(normalizeScenarioCaseGallery({ cases: [] })!.version).toBe(0)
    expect(normalizeScenarioCaseGallery({ version: 'x', cases: [] })!.version).toBe(0)
  })

  it('单条坏案例被跳过，其余保留', () => {
    const out = normalizeScenarioCaseGallery({
      version: 1,
      cases: [
        good,
        { ...good, id: 'no-skill', skill: 'ppt' }, // 不是 slash 命令
        { ...good, id: 'no-title', title: '' },
        { ...good, id: 'bad-cover', cover: 'data:image/png;base64,AAAA' },
        { ...good, id: 'no-prompt', prompt: '   ' },
        'garbage',
        null
      ]
    })
    expect(out!.cases.map((c) => c.id)).toEqual(['c1'])
  })

  it('id 缺失时用下标兜底生成，保证渲染有稳定 key', () => {
    const { id: _drop, ...noId } = good
    void _drop
    const out = normalizeScenarioCaseGallery({ version: 1, cases: [noId, { ...noId, title: 'b' }] })
    expect(out!.cases[0]!.id).toBeTruthy()
    expect(out!.cases[1]!.id).toBeTruthy()
    expect(out!.cases[0]!.id).not.toBe(out!.cases[1]!.id)
  })

  it('images 里的坏 URL 单独丢弃、不连坐整条；超过 9 张截断', () => {
    const many = Array.from({ length: 12 }, (_, i) => `https://cdn.example.com/${i}.jpg`)
    const out = normalizeScenarioCaseGallery({
      version: 1,
      cases: [{ ...good, images: ['javascript:alert(1)', 'https://ok/1.jpg', ''] }, { ...good, id: 'c2', images: many }]
    })
    expect(out!.cases[0]!.images).toEqual(['https://ok/1.jpg'])
    expect(out!.cases[1]!.images).toHaveLength(9)
  })

  it('images / description 缺省 → 空数组 / undefined', () => {
    const { images: _i, description: _d, ...bare } = good
    void _i
    void _d
    const out = normalizeScenarioCaseGallery({ version: 1, cases: [bare] })
    expect(out!.cases[0]!.images).toEqual([])
    expect(out!.cases[0]!.description).toBeUndefined()
  })

  it('hidden 的案例不该出现在客户端 payload 里，但万一出现也剔掉', () => {
    const out = normalizeScenarioCaseGallery({
      version: 1,
      cases: [good, { ...good, id: 'h', hidden: true }]
    })
    expect(out!.cases.map((c) => c.id)).toEqual(['c1'])
  })
})
