import { describe, it, expect } from 'bun:test'

import {
  isGenImageDirectiveBlock,
  parseGenImageBlock,
  parseGenImageDirectives,
  stripGenImageDirectives,
  genImageDirectiveKey,
  replaceGenImageDirectiveBlock,
  removeGenImageDirectiveBlock
} from './proposalGenImage'

const DIRECTIVE = ['```genimage', '图说: 系统总体架构图', '分层架构：应用层、AI 能力层、数据层。', '```'].join('\n')

describe('isGenImageDirectiveBlock / parseGenImageBlock', () => {
  it('识别完整指令块并解析图说与构图描述', () => {
    expect(isGenImageDirectiveBlock(DIRECTIVE)).toBe(true)
    expect(parseGenImageBlock(DIRECTIVE)).toEqual({
      caption: '系统总体架构图',
      prompt: '分层架构：应用层、AI 能力层、数据层。'
    })
  })
  it('全角冒号的图说行同样解析', () => {
    const d = ['```genimage', '图说：业务闭环架构', '闭环描述。', '```'].join('\n')
    expect(parseGenImageBlock(d)).toEqual({ caption: '业务闭环架构', prompt: '闭环描述。' })
  })
  it('缺图说行退化：caption 用默认「配图」，全文当构图描述', () => {
    const d = ['```genimage', '只有构图描述一行。', '```'].join('\n')
    expect(parseGenImageBlock(d)).toEqual({ caption: '配图', prompt: '只有构图描述一行。' })
  })
  it('普通 mermaid / 代码块不误报', () => {
    expect(isGenImageDirectiveBlock('```mermaid\nflowchart LR\n```')).toBe(false)
    expect(isGenImageDirectiveBlock('普通段落')).toBe(false)
    expect(parseGenImageBlock('```ts\nconst a = 1\n```')).toBeNull()
  })
  it('内容为空的指令块视为无效（不产出空 prompt 的生图任务）', () => {
    expect(parseGenImageBlock('```genimage\n```')).toBeNull()
  })
})

describe('parseGenImageDirectives', () => {
  it('抽出全部指令块并带 blockIndex 与同内容 occurrence', () => {
    const md = ['正文一段。', '', DIRECTIVE, '', '又一段。', '', DIRECTIVE].join('\n')
    const out = parseGenImageDirectives(md)
    expect(out.length).toBe(2)
    expect(out[0].blockIndex).toBe(1)
    expect(out[0].occurrence).toBe(0)
    expect(out[1].blockIndex).toBe(3)
    expect(out[1].occurrence).toBe(1)
    expect(out[0].caption).toBe('系统总体架构图')
    expect(out[0].raw).toBe(DIRECTIVE)
  })
  it('反引号内联引用的伪指令不误报（幻影哨兵教训：必须独立成块）', () => {
    const md = '正文里内联提到 `\\`\\`\\`genimage` 字样不算指令。'
    expect(parseGenImageDirectives(md)).toEqual([])
  })
  it('空文档 → []', () => {
    expect(parseGenImageDirectives('')).toEqual([])
  })
})

describe('stripGenImageDirectives', () => {
  it('剥除指令块，其余正文原样保留', () => {
    const md = ['## 第一章', '', '正文。（据《白皮书》）', '', DIRECTIVE, '', '尾段。'].join('\n')
    const out = stripGenImageDirectives(md)
    expect(out).not.toContain('genimage')
    expect(out).not.toContain('图说')
    expect(out).toContain('## 第一章')
    expect(out).toContain('正文。（据《白皮书》）')
    expect(out).toContain('尾段。')
  })
  it('指令块在文档末尾（无尾随换行）也剥得掉', () => {
    const md = '正文。\n\n' + DIRECTIVE
    expect(stripGenImageDirectives(md)).not.toContain('genimage')
  })
  it('无指令块时原样返回（引用相等，零成本快路径）', () => {
    const md = '## 章\n\n正文。'
    expect(stripGenImageDirectives(md)).toBe(md)
  })
  it('不吞普通 mermaid 块', () => {
    const md = '```mermaid\nflowchart LR\nA-->B\n```'
    expect(stripGenImageDirectives(md)).toBe(md)
  })
  it('未闭合的指令块（流式截断）→ 原样返回，绝不吞后续正文', () => {
    const md = ['```genimage', '图说: 架构', '描述被截断', '', '正文段落。', '', '```mermaid', 'flowchart LR', 'A-->B', '```', '', '尾段。'].join('\n')
    expect(stripGenImageDirectives(md)).toBe(md)
  })
  it('指令块内部裸 ``` 行：剥除边界与 splitBlocks 一致，其余内容保留', () => {
    const md = ['```genimage', '图说: 架构', '举例：', '```', 'foo()', '', '尾段。'].join('\n')
    const out = stripGenImageDirectives(md)
    expect(out).not.toContain('genimage')
    expect(out).toContain('foo()')
    expect(out).toContain('尾段。')
  })
})

describe('genImageDirectiveKey', () => {
  it('同节同内容同序 → 键稳定；不同 occurrence / 不同内容 → 键不同', () => {
    const k1 = genImageDirectiveKey('sec-1', DIRECTIVE, 0)
    expect(genImageDirectiveKey('sec-1', DIRECTIVE, 0)).toBe(k1)
    expect(genImageDirectiveKey('sec-1', DIRECTIVE, 1)).not.toBe(k1)
    expect(genImageDirectiveKey('sec-1', '```genimage\n别的\n```', 0)).not.toBe(k1)
    expect(genImageDirectiveKey('sec-2', DIRECTIVE, 0)).not.toBe(k1)
  })
})

describe('replace / removeGenImageDirectiveBlock', () => {
  const blocks = ['正文一段。', DIRECTIVE, '又一段。', DIRECTIVE]
  it('按 occurrence 原地替换第二个同内容指令块', () => {
    const { blocks: next, changed } = replaceGenImageDirectiveBlock(blocks, DIRECTIVE, 1, '![系统总体架构图](/a/b.png)')
    expect(changed).toBe(true)
    expect(next[1]).toBe(DIRECTIVE) // 第一个不动
    expect(next[3]).toBe('![系统总体架构图](/a/b.png)')
    expect(blocks[3]).toBe(DIRECTIVE) // 纯函数：入参不被就地修改
  })
  it('删除：块被摘掉、数组变短', () => {
    const { blocks: next, changed } = removeGenImageDirectiveBlock(blocks, DIRECTIVE, 0)
    expect(changed).toBe(true)
    expect(next.length).toBe(3)
    expect(next.filter((b) => b === DIRECTIVE).length).toBe(1)
  })
  it('内容漂移（用户手改过指令文本）→ no-op，changed=false', () => {
    const { changed } = replaceGenImageDirectiveBlock(blocks, '```genimage\n改过了\n```', 0, '![x](/y.png)')
    expect(changed).toBe(false)
  })
  it('occurrence 越界 → no-op', () => {
    const { changed } = removeGenImageDirectiveBlock(blocks, DIRECTIVE, 5)
    expect(changed).toBe(false)
  })
})
