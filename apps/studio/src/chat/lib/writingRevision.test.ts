import { describe, expect, it } from 'bun:test'
import {
  WRITING_REVISION_BEGIN,
  WRITING_REVISION_END
} from '@desktop-shared/writing'
import { splitBlocks } from '@desktop-shared/proposalBlocks'
import { buildRevisionMessage, applyRevision, relocateTarget } from './writingRevision'

const SECTION = '# 小标题\n\n第一段正文。\n\n第二段正文。\n\n第三段正文。'

describe('buildRevisionMessage', () => {
  const target = {
    sectionName: '1-a.md',
    range: { start: 1, end: 1 },
    selectedText: '第一段正文。',
    beforeMarkdown: '第一段正文。'
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

  it('首尾双写「不要调用文件修改工具」的禁令 —— 单条尾部禁令会被长上文冲淡', () => {
    const msg = buildRevisionMessage({ sectionMarkdown: SECTION, target, instruction: 'x' })
    expect(msg).not.toBeNull()
    const hits = (msg as string).split('不要调用').length - 1
    expect(hits).toBeGreaterThanOrEqual(2)
  })

  it('明确排除「把整节重写后塞进哨兵」的解读 —— 那会在选段处插入一份重复整节', () => {
    const msg = buildRevisionMessage({ sectionMarkdown: SECTION, target, instruction: 'x' })
    expect(msg).toContain('不要放整节全文')
  })

  it('哨兵内的占位行自带「不要保留这行」的自指说明 —— 防止被字面照抄', () => {
    const msg = buildRevisionMessage({ sectionMarkdown: SECTION, target, instruction: 'x' })
    expect(msg).toContain('不要保留这行说明文字')
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

  it('beforeMarkdown 与当前切片不等（target 已过期）时返回 null，不把错段发给 AI', () => {
    // 正文没变，但 beforeMarkdown 记的是别的内容——模拟"排队等待期间这一节已被改写，
    // 调用方忘了先 relocateTarget 就直接拿旧 target 发消息"的场景。
    const stale = { ...target, beforeMarkdown: '一段早就不存在的原文' }
    expect(
      buildRevisionMessage({ sectionMarkdown: SECTION, target: stale, instruction: 'x' })
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

describe('relocateTarget · 源码级精确匹配', () => {
  it('beforeMarkdown 一致时定位回原区间，ambiguous: false', () => {
    const t = {
      sectionName: '1-a.md',
      range: { start: 2, end: 2 },
      selectedText: '第二段正文。',
      beforeMarkdown: '第二段正文。'
    }
    expect(relocateTarget(SECTION, t)).toEqual({ range: { start: 2, end: 2 }, ambiguous: false })
  })

  it('前面插了一块导致序号后移时，按 beforeMarkdown 重新定位到新位置', () => {
    const shifted = '# 小标题\n\n新插入的一段。\n\n第一段正文。\n\n第二段正文。\n\n第三段正文。'
    const t = {
      sectionName: '1-a.md',
      range: { start: 2, end: 2 },
      selectedText: '第二段正文。',
      beforeMarkdown: '第二段正文。'
    }
    expect(relocateTarget(shifted, t)).toEqual({ range: { start: 3, end: 3 }, ambiguous: false })
  })

  // 三轮模糊补丁都做不到的：selectedText 是渲染后的纯文本（没有 **），beforeMarkdown 是
  // 提交那一刻的源码切片（带 **）。旧的 locateBlockRangeByTextWithHint 拿 selectedText（去空白
  // 后是「本季度核心目标是把交付周期压缩到两周以内。」）去源码里 indexOf，源码里这段带着
  // `**` 标记（「本季度**核心目标**是…」），去空白也去不掉星号，连续子串匹配必然落空、
  // 实测返回 null——这正是三轮模糊补丁想弥补也没能根治的先天矛盾。现在的判据不依赖
  // selectedText，只比较源码切片本身，故能命中。
  it('跨内联标记的选区（beforeMarkdown 含 **加粗**）→ 命中', () => {
    const md = '一段前言。\n\n本季度**核心目标**是把交付周期压缩到两周以内。\n\n一段后记。'
    const t = {
      sectionName: '1-a.md',
      range: { start: 1, end: 1 },
      selectedText: '本季度核心目标是把交付周期压缩到两周以内。', // 渲染后纯文本，没有 **
      beforeMarkdown: '本季度**核心目标**是把交付周期压缩到两周以内。'
    }
    expect(relocateTarget(md, t)).toEqual({ range: { start: 1, end: 1 }, ambiguous: false })
  })

  it('跨多个列表项（beforeMarkdown 是整个列表块）→ 命中', () => {
    const md =
      '一段前言。\n\n- 第一条要点是收敛接口\n- 第二条要点是补上回归测试\n\n一段后记。'
    const listBlock = '- 第一条要点是收敛接口\n- 第二条要点是补上回归测试'
    const t = {
      sectionName: '1-a.md',
      range: { start: 1, end: 1 },
      selectedText: '第一条要点是收敛接口 第二条要点是补上回归测试', // 渲染后两个 <li> 的纯文本
      beforeMarkdown: listBlock
    }
    expect(relocateTarget(md, t)).toEqual({ range: { start: 1, end: 1 }, ambiguous: false })
  })

  it('表格块 → 命中', () => {
    const table = '| 阶段 | 负责人 |\n| --- | --- |\n| 设计 | 张三 |\n| 开发 | 李四 |'
    const md = `一段前言。\n\n${table}\n\n一段后记。`
    const t = {
      sectionName: '1-a.md',
      range: { start: 1, end: 1 },
      selectedText: '阶段负责人设计张三开发李四', // 渲染后表格的纯文本
      beforeMarkdown: table
    }
    expect(relocateTarget(md, t)).toEqual({ range: { start: 1, end: 1 }, ambiguous: false })
  })

  it('那几块内容已经被改写（beforeMarkdown 在正文里已不存在）时返回 null', () => {
    const t = {
      sectionName: '1-a.md',
      range: { start: 1, end: 1 },
      selectedText: '早就没有的句子',
      beforeMarkdown: '早就没有的句子'
    }
    expect(relocateTarget(SECTION, t)).toBeNull()
  })

  it('同一节里两段完全相同的块 → 命中离入队位置最近的一处，ambiguous: true', () => {
    const md =
      '标准免责声明段落。\n\n中间的正文一。\n\n标准免责声明段落。\n\n中间的正文二。\n\n标准免责声明段落。'
    // 三处命中在块序号 0 / 2 / 4。hint 故意给 3——模拟"原来选中的那一块所在的位置附近
    // 有块被删掉，序号往前挪了一格"这一真实形态（不是随便挑一个凑巧等于某处命中的数）。
    // 复审指出：若 hint 直接给 4（三处之一），"返回 4"这个断言在「挑最近」「挑最后一处」
    // 「直接返回 hint」三种不同实现下都会通过，根本没测出"挑最近"这个语义。
    // hint=3 时到 0/2/4 的距离分别是 3/1/1——2 和 4 平手，只有「挑最近」的实现能排除掉
    // 距离 3 的那处，而平手时按扫描顺序取靠前的一处（2），这一步顺带钉住平手时的约定，
    // 不是未定义行为。
    const t = {
      sectionName: '1-a.md',
      range: { start: 3, end: 3 },
      selectedText: '标准免责声明段落。',
      beforeMarkdown: '标准免责声明段落。'
    }
    expect(relocateTarget(md, t)).toEqual({ range: { start: 2, end: 2 }, ambiguous: true })
  })

  it('beforeMarkdown 跨两块以上（needle 多块）→ 精确命中，非固定宽度的滑窗要能扫到更宽的窗口', () => {
    const md =
      '一段前言。\n\n第一段落。\n\n第二段落。\n\n第三段落。\n\n一段后记。'
    const t = {
      sectionName: '1-a.md',
      range: { start: 1, end: 3 },
      selectedText: '第一段落。 第二段落。 第三段落。',
      beforeMarkdown: '第一段落。\n\n第二段落。\n\n第三段落。'
    }
    expect(relocateTarget(md, t)).toEqual({ range: { start: 1, end: 3 }, ambiguous: false })
  })

  // 复审 F1 的回归用例：canonicalize 只保证"字符串幂等"，不保证"块数幂等"。
  // 正文里列表和缩进续行段落之间隔了【两个】空行，splitBlocks 因此把它们切成两块
  // （两个空行会跳出"项间单空行才并入列表段"的合并规则）；但 beforeMarkdown 是
  // `blocks.slice(1,3).join('\n\n')` 拼出来的——join 永远只用【一个】空行，于是
  // beforeMarkdown 字符串里两者中间只剩一个空行。若再对这段 beforeMarkdown 单独调用
  // splitBlocks（旧实现算 needleBlocks.length 时正是这么干的），单空行会让它们被重新
  // 合并判定成【一块】：needleBlocks.length 从"应该是 2"变成"算出来是 1"，固定宽度的
  // 滑窗只扫宽度为 1 的窗口，永远找不到这个跨两块的选区——内容其实一个字都没变。
  // 现在的实现按内容【长度】剪枝、不依赖 needleBlocks.length，必须仍然精确命中。
  it('回归·列表 + 双空行 + 缩进续行：单独重切 beforeMarkdown 会并块，仍必须命中', () => {
    const md = '前言。\n\n- 甲项\n- 乙项\n\n\n   缩进的续行段落\n\n后记。'
    const blocks = splitBlocks(md)
    // 确认前提成立：正文里这是两块，不是一块（否则这条回归用例就测不到 F1 的场景）。
    expect(blocks).toEqual(['前言。', '- 甲项\n- 乙项', '   缩进的续行段落', '后记。'])
    const beforeMarkdown = blocks.slice(1, 3).join('\n\n')
    // 确认 F1 描述的"单独重切会并块"确实成立，否则这条回归用例名不副实。
    expect(splitBlocks(beforeMarkdown)).toEqual([beforeMarkdown])
    const t = {
      sectionName: '1-a.md',
      range: { start: 1, end: 2 },
      selectedText: '甲项 乙项 缩进的续行段落',
      beforeMarkdown
    }
    expect(relocateTarget(md, t)).toEqual({ range: { start: 1, end: 2 }, ambiguous: false })
  })
})
