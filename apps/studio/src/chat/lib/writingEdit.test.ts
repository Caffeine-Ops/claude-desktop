import { describe, expect, it } from 'bun:test'
import {
  blockSourceAt,
  replaceBlockAt,
  isBlockUnchanged,
  pushBounded,
  locateBlockBySource
} from './writingEdit'

const SECTION = '# 小标题\n\n第一段正文。\n\n第二段正文。\n\n第三段正文。'

describe('blockSourceAt', () => {
  it('取出指定序号那一块的源码', () => {
    expect(blockSourceAt(SECTION, 0)).toBe('# 小标题')
    expect(blockSourceAt(SECTION, 2)).toBe('第二段正文。')
  })

  it('序号越界或非整数一律回 null —— 调用方据此不进入编辑态', () => {
    expect(blockSourceAt(SECTION, -1)).toBeNull()
    expect(blockSourceAt(SECTION, 99)).toBeNull()
    expect(blockSourceAt(SECTION, 1.5)).toBeNull()
    expect(blockSourceAt(SECTION, NaN)).toBeNull()
  })
})

describe('replaceBlockAt', () => {
  it('只换目标那一块，其余块逐字节不变', () => {
    const next = replaceBlockAt(SECTION, 2, '换过的第二段。')
    expect(next).toBe('# 小标题\n\n第一段正文。\n\n换过的第二段。\n\n第三段正文。')
  })

  it('新内容里有空行 —— 存盘后自然切成两块（Markdown 正常语义，不拦）', () => {
    const next = replaceBlockAt(SECTION, 2, '前半句。\n\n后半句。')
    expect(next).toBe('# 小标题\n\n第一段正文。\n\n前半句。\n\n后半句。\n\n第三段正文。')
  })

  it('新内容为空 = 删除这一块，后面的块顺次前移', () => {
    const next = replaceBlockAt(SECTION, 2, '')
    expect(next).toBe('# 小标题\n\n第一段正文。\n\n第三段正文。')
  })

  it('只剩一块时清空它，整节变成空字符串（可撤销，故允许）', () => {
    expect(replaceBlockAt('只有一段。', 0, '')).toBe('')
  })

  it('序号越界回 null —— 绝不夹紧到最后一块后硬写，那会改到用户没选的段落', () => {
    expect(replaceBlockAt(SECTION, 99, 'x')).toBeNull()
    expect(replaceBlockAt(SECTION, -1, 'x')).toBeNull()
    expect(replaceBlockAt(SECTION, NaN, 'x')).toBeNull()
  })
})

describe('isBlockUnchanged', () => {
  it('逐字节相同 → 真（调用方据此跳过写盘）', () => {
    expect(isBlockUnchanged('第一段。', '第一段。')).toBe(true)
  })

  it('只多了首尾空行 → 仍算没变（splitBlocks 会把它们吃掉，写盘等于空转）', () => {
    expect(isBlockUnchanged('第一段。', '\n第一段。\n\n')).toBe(true)
  })

  it('内容真的变了 → 假', () => {
    expect(isBlockUnchanged('第一段。', '第一段！')).toBe(false)
  })

  it('清空 → 假（那是「删除这一段」这个真实意图，必须写盘）', () => {
    expect(isBlockUnchanged('第一段。', '')).toBe(false)
    expect(isBlockUnchanged('第一段。', '   \n  ')).toBe(false)
  })
})

describe('pushBounded', () => {
  it('未到上限时直接追加，不改动入参数组', () => {
    const stack = [1, 2]
    expect(pushBounded(stack, 3, 5)).toEqual([1, 2, 3])
    expect(stack).toEqual([1, 2])
  })

  it('超出上限时丢最老的一条，长度恒定', () => {
    expect(pushBounded([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
  })
})

describe('locateBlockBySource', () => {
  const SEC = '# 标题\n\n第一段。\n\n第二段。\n\n第三段。'

  // 切块后：0=「# 标题」 1=「第一段。」 2=「第二段。」 3=「第三段。」
  it('序号没漂时原样返回那个序号', () => {
    expect(locateBlockBySource(SEC, 1, '第一段。')).toBe(1)
  })

  it('前面的块被删掉、序号顶漂时，按内容找回真正的位置', () => {
    // 「# 标题」被删 → 原来的 1 号（第一段）现在是 0 号
    const after = '第一段。\n\n第二段。\n\n第三段。'
    expect(locateBlockBySource(after, 1, '第一段。')).toBe(0)
  })

  it('前面的块被拆成两块、序号后移时，同样能找回', () => {
    const after = '# 标题\n\n插入的一段。\n\n第一段。\n\n第二段。\n\n第三段。'
    expect(locateBlockBySource(after, 1, '第一段。')).toBe(2)
  })

  it('那一块已经不在了 → 回 null，调用方据此拒绝进入编辑', () => {
    const after = '# 标题\n\n第二段。\n\n第三段。'
    expect(locateBlockBySource(after, 1, '第一段。')).toBeNull()
  })

  it('多处内容完全相同时，挑离原序号最近的那一处', () => {
    // 三个「重复段。」分别在 0 / 2 / 4 号
    const dup = '重复段。\n\n中间。\n\n重复段。\n\n中间。\n\n重复段。'
    expect(locateBlockBySource(dup, 3, '重复段。')).toBe(2)
    expect(locateBlockBySource(dup, 5, '重复段。')).toBe(4)
    expect(locateBlockBySource(dup, 0, '重复段。')).toBe(0)
  })

  it('空源码一律回 null —— 空块不该成为定位锚点', () => {
    expect(locateBlockBySource(SEC, 1, '')).toBeNull()
    expect(locateBlockBySource(SEC, 1, '   ')).toBeNull()
  })
})
