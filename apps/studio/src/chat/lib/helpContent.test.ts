import { describe, it, expect } from 'bun:test'
import { HELP_GROUPS, buildHelpKeywords, type HelpGroup } from './helpContent'

describe('HELP_GROUPS 数据完整性', () => {
  it('组 id 与条目 id 全局唯一', () => {
    const groupIds = HELP_GROUPS.map((g) => g.id)
    expect(new Set(groupIds).size).toBe(groupIds.length)
    const itemIds = HELP_GROUPS.flatMap((g) => g.items.map((i) => i.id))
    expect(new Set(itemIds).size).toBe(itemIds.length)
  })

  it('每组有标题且至少一条；每条问题非空、回答至少一段且每段非空', () => {
    for (const g of HELP_GROUPS) {
      expect(g.title.trim().length).toBeGreaterThan(0)
      expect(g.items.length).toBeGreaterThan(0)
      for (const item of g.items) {
        expect(item.question.trim().length).toBeGreaterThan(0)
        expect(item.answer.length).toBeGreaterThan(0)
        for (const p of item.answer) expect(p.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('section 跳转目标只允许两个值（防止有人把类型放宽）', () => {
    const allowed = new Set(['skills', 'knowledgeBase'])
    for (const item of HELP_GROUPS.flatMap((g) => g.items)) {
      if (item.action?.kind === 'section') expect(allowed.has(item.action.section)).toBe(true)
    }
  })

  it('至少 5 组、至少 15 条（下限防误删整组，不钉死精确数免得改文案就红）', () => {
    expect(HELP_GROUPS.length).toBeGreaterThanOrEqual(5)
    expect(HELP_GROUPS.reduce((n, g) => n + g.items.length, 0)).toBeGreaterThanOrEqual(15)
  })
})

describe('buildHelpKeywords', () => {
  const groups: HelpGroup[] = [
    {
      id: 'a',
      title: '组A',
      items: [
        { id: 'a1', question: '怎么开始？', answer: ['x'], keywords: 'start 开始' },
        { id: 'a2', question: '怎么附件？', answer: ['y'] },
      ],
    },
  ]

  it('包含每个组标题、每条问题和额外关键词，空格分隔、无换行', () => {
    const out = buildHelpKeywords(groups)
    expect(out).toContain('组A')
    expect(out).toContain('怎么开始？')
    expect(out).toContain('怎么附件？')
    expect(out).toContain('start 开始')
    expect(out.includes('\n')).toBe(false)
  })

  it('对真实数据：包含每个组标题和每条问题（侧栏搜索靠它命中），且含走查用的「权限」「重试」', () => {
    const out = buildHelpKeywords(HELP_GROUPS)
    for (const g of HELP_GROUPS) {
      expect(out).toContain(g.title)
      for (const item of g.items) expect(out).toContain(item.question)
    }
    expect(out).toContain('权限')
    expect(out).toContain('重试')
  })
})
