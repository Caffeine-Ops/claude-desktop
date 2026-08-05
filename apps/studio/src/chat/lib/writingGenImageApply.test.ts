import { describe, expect, it } from 'bun:test'
import {
  applyGenImageToSection,
  discardGenImageFromSection,
  renumberSiblingGenImageReviews
} from './writingGenImageApply'

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

  // 复审 M-5②：应用/丢弃走的是 splitBlocks/joinBlocks 重拼整节这条路——与手动编辑
  // replaceBlockAt→spliceBlocks 是同一条既有精度（三个空行塌成一个、结尾多余换行丢失），
  // 不是本任务引入的缺陷。钉住这条既有行为，免得以后有人当 bug 误改。
  it('块间有多个空行时，joinBlocks 重拼会把它们规范化成单个空行（既有精度，非本任务缺陷）', () => {
    const messy = `第一段。\n\n\n\n${RAW}\n\n\n第二段。\n\n`
    const out = discardGenImageFromSection(messy, RAW, 0)
    expect(out).toBe('第一段。\n\n第二段。')
  })
})

// 复审 C-1：落位用的是相对路径 relPath（`../images/<文件名>`），调用方传什么这两个
// 纯函数就原样拼进 markdown，不做任何路径运算——路径含空格时同样必须原样保留（空格
// 是「绝对路径 vs 相对路径」这条 bug 的诱因，不是这两个纯函数自身的问题，但钉住这条
// 能防止未来有人在这两个函数内部加一层不必要的路径「规范化」而把空格弄坏）。
describe('applyGenImageToSection · 相对路径含空格（复审 C-1）', () => {
  it('relPath 含空格时原样拼进 markdown 图片引用，不被转义或截断', () => {
    const out = applyGenImageToSection(MD, RAW, 0, '深夜的便利店', '../images/我的 图 1.png')
    expect(out).toBe('第一段。\n\n![深夜的便利店](../images/我的 图 1.png)\n\n第二段。')
  })
})

// 复审 M-5③：CRLF 与正则元字符——splitBlocks/proposalGenImage 的定位链路里有多处正则，
// 图说/构图描述若含正则元字符、或整节用 CRLF 换行，理论上都可能踩坑。已实测通过，
// 钉住测试用例更省心（回归比人工再测一遍省事）。
describe('applyGenImageToSection · CRLF 与正则元字符（复审 M-5③）', () => {
  it('CRLF 换行的正文照样能定位到指令块并原地替换', () => {
    const crlfMd = MD.replace(/\n/g, '\r\n')
    const out = applyGenImageToSection(crlfMd, RAW, 0, '深夜的便利店', '../images/gen-1.png')
    // splitBlocks 内部把 \r\n 统一成 \n 再切块，输出天然是 \n——这里断言的是「定位与替换
    // 成功」，不是「保留原始换行符」，与 splitBlocks 顶注的既有语义一致。
    expect(out).toBe('第一段。\n\n![深夜的便利店](../images/gen-1.png)\n\n第二段。')
  })

  it('图说/构图描述含正则元字符（. * + ? [ ] ( ) 等）时定位不受干扰', () => {
    const tricky = '```genimage\n图说: 价格 $9.99 (含税)*[限量]\n背景+前景?边界.测试\n```'
    const md = `前言。\n\n${tricky}\n\n后记。`
    const out = applyGenImageToSection(md, tricky, 0, '价格 $9.99 (含税)*[限量]', '../images/p.png')
    expect(out).toBe('前言。\n\n![价格 $9.99 (含税)*[限量]](../images/p.png)\n\n后记。')
  })
})

// 复审 M-1：三块（及以上）字面完全相同的指令块场景下，处理掉靠前的一块后，兄弟审阅卡
// 挂着的旧 occurrence 会因为 splice 位移而错位——这不是位置猜测，是数组下标算术本身
// 决定的确定性位移，renumberSiblingGenImageReviews 就是把这份确定性位移同步给兄弟卡。
describe('renumberSiblingGenImageReviews（复审 M-1）', () => {
  type Fixture = { id: string; sectionId: string; directiveRaw?: string; directiveOccurrence?: number }

  it('同 (sectionId, directiveRaw) 下 occurrence 更大的兄弟项减一', () => {
    const reviews: Fixture[] = [
      { id: 'a', sectionId: 's1', directiveRaw: 'X', directiveOccurrence: 1 },
      { id: 'b', sectionId: 's1', directiveRaw: 'X', directiveOccurrence: 2 }
    ]
    const out = renumberSiblingGenImageReviews(reviews, 's1', 'X', 0)
    expect(out.find((r) => r.id === 'a')?.directiveOccurrence).toBe(0)
    expect(out.find((r) => r.id === 'b')?.directiveOccurrence).toBe(1)
  })

  it('occurrence 小于等于被处理的那个不受影响', () => {
    const reviews: Fixture[] = [{ id: 'a', sectionId: 's1', directiveRaw: 'X', directiveOccurrence: 0 }]
    const out = renumberSiblingGenImageReviews(reviews, 's1', 'X', 1)
    expect(out.find((r) => r.id === 'a')?.directiveOccurrence).toBe(0)
  })

  it('不同 sectionId 或不同 directiveRaw 的项不受影响', () => {
    const reviews: Fixture[] = [
      { id: 'a', sectionId: 's2', directiveRaw: 'X', directiveOccurrence: 2 },
      { id: 'b', sectionId: 's1', directiveRaw: 'Y', directiveOccurrence: 2 }
    ]
    const out = renumberSiblingGenImageReviews(reviews, 's1', 'X', 0)
    expect(out.find((r) => r.id === 'a')?.directiveOccurrence).toBe(2)
    expect(out.find((r) => r.id === 'b')?.directiveOccurrence).toBe(2)
  })

  it('三块场景端到端核对：连续应用三张字面相同的指令块，每次都精确命中"当初标记的那一块"', () => {
    // 三个字面完全相同的指令块（连内容都一样，靠 occurrence 区分身份）。不用独立的
    // caption/relPath 区分，就没法证明"renumber 后到底换对了没有"——三块长得一模一样，
    // 唯一能验证"没有踩错"的办法是给它们各自贴上不同的图说/路径，最后核对生成的图片
    // 顺序与原文顺序（左→右=occ0→occ2）严格一致。
    const three = `${RAW}\n\n${RAW}\n\n${RAW}`
    let reviews: Fixture[] = [
      { id: 'occ0', sectionId: 's1', directiveRaw: RAW, directiveOccurrence: 0 },
      { id: 'occ1', sectionId: 's1', directiveRaw: RAW, directiveOccurrence: 1 },
      { id: 'occ2', sectionId: 's1', directiveRaw: RAW, directiveOccurrence: 2 }
    ]
    let md: string = three

    // 每一步都模拟 WritingPaper 的真实调用顺序：apply → 用这一步实际用的 occurrence
    // （必须是"上一步 renumber 之后"的最新值，不是创建时的原始值）renumber 剩下的兄弟。
    function applyOne(id: string, caption: string, relPath: string): void {
      const card = reviews.find((r) => r.id === id)!
      const occ = card.directiveOccurrence ?? 0
      const next = applyGenImageToSection(md, RAW, occ, caption, relPath)
      expect(next).not.toBeNull() // 每一步都必须成功定位，不越界、不误判 null
      md = next as string
      reviews = renumberSiblingGenImageReviews(
        reviews.filter((r) => r.id !== id),
        's1',
        RAW,
        occ
      )
    }

    applyOne('occ0', '图0', '../images/0.png')
    // 处理完 occ0 后，occ1 应该被 renumber 成 0（下一步要用的就是这个新值）。
    expect(reviews.find((r) => r.id === 'occ1')?.directiveOccurrence).toBe(0)
    expect(reviews.find((r) => r.id === 'occ2')?.directiveOccurrence).toBe(1)

    applyOne('occ1', '图1', '../images/1.png')
    // 处理完 occ1（此刻它的 occurrence 已经是 0）后，occ2 应该从 1 再减到 0。
    expect(reviews.find((r) => r.id === 'occ2')?.directiveOccurrence).toBe(0)

    applyOne('occ2', '图2', '../images/2.png')

    // 若 renumber 有任何一步没做/做错，三块字面相同的指令块必然会有至少一张图落错
    // 位置（覆盖了另一张、或漏了中间那块），下面这个精确的顺序断言就会失败。
    expect(md).toBe('![图0](../images/0.png)\n\n![图1](../images/1.png)\n\n![图2](../images/2.png)')
  })
})
