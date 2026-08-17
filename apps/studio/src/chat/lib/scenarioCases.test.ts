import { describe, it, expect } from 'bun:test'

import type { ScenarioCase, ScenarioCaseGallery } from '@desktop-shared/ipc-channels'

import { casesForSkill, pageCount, pageSlice, SHOWCASE_PAGE_SIZE } from './scenarioCases'

function mk(id: string, skill: string): ScenarioCase {
  return {
    id,
    skill,
    title: id,
    cover: `https://cdn/${id}.jpg`,
    images: [],
    prompt: 'p'
  }
}

const gallery: ScenarioCaseGallery = {
  version: 1,
  cases: [
    mk('a', '/cowork:ppt-creator'),
    mk('b', '/cowork:image-gen'),
    mk('c', '/ppt-creator'),
    mk('d', '/cowork:ppt-creator')
  ]
}

describe('casesForSkill', () => {
  it('按裸名匹配：命名空间形态与裸名形态共享同一批案例，保持配置顺序', () => {
    expect(casesForSkill(gallery, '/cowork:ppt-creator').map((c) => c.id)).toEqual(['a', 'c', 'd'])
    expect(casesForSkill(gallery, '/ppt-creator').map((c) => c.id)).toEqual(['a', 'c', 'd'])
    expect(casesForSkill(gallery, '/claude-desktop:ppt-creator').map((c) => c.id)).toEqual([
      'a',
      'c',
      'd'
    ])
  })

  it('没有匹配 / gallery 为 null → 空数组', () => {
    expect(casesForSkill(gallery, '/nope')).toEqual([])
    expect(casesForSkill(null, '/cowork:ppt-creator')).toEqual([])
  })
})

describe('pageSlice / pageCount（换一批）', () => {
  const items = Array.from({ length: 12 }, (_, i) => i)

  it('默认一页 5 张', () => {
    expect(SHOWCASE_PAGE_SIZE).toBe(5)
  })

  it('不足一页时只有 1 页，slice 就是全部', () => {
    expect(pageCount(3, 5)).toBe(1)
    expect(pageSlice([1, 2, 3], 0, 5)).toEqual([1, 2, 3])
  })

  it('顺序翻页，最后一页不足时取剩余；page 越界按页数取模回头', () => {
    expect(pageCount(items.length, 5)).toBe(3)
    expect(pageSlice(items, 0, 5)).toEqual([0, 1, 2, 3, 4])
    expect(pageSlice(items, 1, 5)).toEqual([5, 6, 7, 8, 9])
    expect(pageSlice(items, 2, 5)).toEqual([10, 11])
    expect(pageSlice(items, 3, 5)).toEqual([0, 1, 2, 3, 4])
  })

  it('空数组 → 0 页、空 slice', () => {
    expect(pageCount(0, 5)).toBe(0)
    expect(pageSlice([], 0, 5)).toEqual([])
  })
})
