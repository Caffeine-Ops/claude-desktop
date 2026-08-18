import { describe, it, expect } from 'bun:test'

import type { ScenarioCase, ScenarioCaseGallery } from '@desktop-shared/ipc-channels'

import { casesForSkill } from './scenarioCases'

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
