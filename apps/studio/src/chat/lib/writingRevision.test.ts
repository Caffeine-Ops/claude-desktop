import { describe, expect, it } from 'bun:test'
import {
  WRITING_REVISION_BEGIN,
  WRITING_REVISION_END
} from '@desktop-shared/writing'
import { buildRevisionMessage, applyRevision, relocateTarget } from './writingRevision'

const SECTION = '# 小标题\n\n第一段正文。\n\n第二段正文。\n\n第三段正文。'

describe('buildRevisionMessage', () => {
  const target = {
    sectionName: '1-a.md',
    range: { start: 1, end: 1 },
    selectedText: '第一段正文。'
  }

  it('消息里带上选中原文、用户指令和哨兵格式要求', () => {
    const msg = buildRevisionMessage({
      sectionMarkdown: SECTION,
      target,
      instruction: '改口语一点'
    })
    expect(msg).not.toBeNull()
    expect(msg).toContain('第一段正文。')
    expect(msg).toContain('改口语一点')
    expect(msg).toContain(WRITING_REVISION_BEGIN)
    expect(msg).toContain(WRITING_REVISION_END)
  })

  it('明确要求 AI 不要自己改文件——落地由用户点应用后前端执行', () => {
    const msg = buildRevisionMessage({ sectionMarkdown: SECTION, target, instruction: 'x' })
    expect(msg).toContain('不要修改任何文件')
  })

  it('空指令返回 null（不发一轮没有诉求的请求）', () => {
    expect(
      buildRevisionMessage({ sectionMarkdown: SECTION, target, instruction: '   ' })
    ).toBeNull()
  })

  it('区间越界（该节已被改短）返回 null', () => {
    const bad = { ...target, range: { start: 99, end: 99 } }
    expect(
      buildRevisionMessage({ sectionMarkdown: SECTION, target: bad, instruction: 'x' })
    ).toBeNull()
  })
})

describe('applyRevision', () => {
  it('用改后文本替换指定块区间，其余块原样保留', () => {
    const out = applyRevision(SECTION, { start: 1, end: 1 }, '改写后的第一段。')
    expect(out).toContain('改写后的第一段。')
    expect(out).not.toContain('第一段正文。')
    expect(out).toContain('第二段正文。')
    expect(out).toContain('# 小标题')
  })

  it('跨块区间整体替换成一块', () => {
    const out = applyRevision(SECTION, { start: 1, end: 2 }, '合并后的一段。')
    expect(out).toContain('合并后的一段。')
    expect(out).not.toContain('第一段正文。')
    expect(out).not.toContain('第二段正文。')
    expect(out).toContain('第三段正文。')
  })
})

describe('relocateTarget', () => {
  it('内容没变时定位回原区间', () => {
    const t = { sectionName: '1-a.md', range: { start: 2, end: 2 }, selectedText: '第二段正文。' }
    expect(relocateTarget(SECTION, t)).toEqual({ start: 2, end: 2 })
  })

  it('前面插了一块导致序号后移时，按原文重新定位', () => {
    const shifted = '# 小标题\n\n新插入的一段。\n\n第一段正文。\n\n第二段正文。\n\n第三段正文。'
    const t = { sectionName: '1-a.md', range: { start: 2, end: 2 }, selectedText: '第二段正文。' }
    expect(relocateTarget(shifted, t)).toEqual({ start: 3, end: 3 })
  })

  it('原文已不存在（那段被 AI 重写了）时返回 null', () => {
    const t = { sectionName: '1-a.md', range: { start: 1, end: 1 }, selectedText: '早就没有的句子' }
    expect(relocateTarget(SECTION, t)).toBeNull()
  })
})
