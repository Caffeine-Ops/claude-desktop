import { describe, it, expect } from 'bun:test'
import { buildSelectionRevisionMessage, groundingSuffix } from './proposalRevisionMessages'

describe('buildSelectionRevisionMessage', () => {
  const context = '第一句是背景。第二句要改的正是这里。第三句收尾。'

  it('选中子串（content 节）：钉死「只改选中、其余原样」，且带上选中原文/完整上下文/指令/《来源》约束', () => {
    const msg = buildSelectionRevisionMessage({
      instruction: '把它写得更专业',
      focus: '第二句要改的正是这里。',
      context,
      kind: 'content'
    })
    expect(msg).toContain('一字不动、原样保留')
    // focus 必须被拼进【选区框架文案】本身，而非只是碰巧作为 context 的子串蒙混过关（终审 Minor#1）：
    // 断言整句「用户只选中了这段里的一部分文字要改：「focus」」，独立锁住 focus 真的被注入选区分支。
    expect(msg).toContain('用户只选中了这段里的一部分文字要改：「第二句要改的正是这里。」')
    expect(msg).toContain(context)
    expect(msg).toContain('把它写得更专业')
    expect(msg).toContain('段末按既有规则标注《来源》')
    // 负向锁（终审 Minor#2）：focus 非空的选区分支【绝不】退回旧的整段重写口径——那正是本次 bug 的病灶措辞。
    expect(msg).not.toContain('只输出【重写后的这一小段本身】')
  })

  it('focus 为空（防御兜底）：退回「整段改写」措辞、不含「原样保留」约束', () => {
    const msg = buildSelectionRevisionMessage({
      instruction: '精简这段',
      focus: '',
      context,
      kind: 'content'
    })
    expect(msg).toContain('把下面这一小段按要求改写')
    expect(msg).not.toContain('一字不动、原样保留')
  })

  it('封面/目录节（cover）：走免标《来源》的溯源措辞', () => {
    const msg = buildSelectionRevisionMessage({
      instruction: '换个说法',
      focus: '武汉协和医院',
      context: '武汉协和医院',
      kind: 'cover'
    })
    expect(msg).toContain('不要标注《来源》')
    expect(msg).not.toContain('段末按既有规则标注《来源》')
  })
})

describe('groundingSuffix', () => {
  it('content 标《来源》，cover/toc 免标', () => {
    expect(groundingSuffix('content')).toContain('《来源》')
    expect(groundingSuffix('cover')).toContain('不要标注《来源》')
    expect(groundingSuffix('toc')).toContain('不要标注《来源》')
  })
})
