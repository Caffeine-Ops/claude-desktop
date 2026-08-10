import { describe, it, expect } from 'bun:test'

import { DEFAULT_SCENARIO_CATALOG } from './scenarioCatalogDefaults'
import { findBuiltinSkillChipSpec } from '../composer/skillChipRegistry'
import { acceptForPlaceholder } from '../composer/filePlaceholderPlugin'

const TENDER_VALUE = '/claude-desktop:tender-review'

function allSkillItems() {
  return DEFAULT_SCENARIO_CATALOG.categories.flatMap((c) =>
    c.items.filter((i) => i.kind === 'skill')
  )
}

describe('内置场景目录 · 审标书', () => {
  it('日常办公分类里有审标书，且紧跟在写方案之后', () => {
    const daily = DEFAULT_SCENARIO_CATALOG.categories.find((c) => c.id === 'daily')
    expect(daily).toBeDefined()
    const values = daily!.items.map((i) => i.value)
    const proposalIdx = values.indexOf('/claude-desktop:proposal-writer')
    const tenderIdx = values.indexOf(TENDER_VALUE)
    expect(proposalIdx).toBeGreaterThanOrEqual(0)
    // 先审标、再写标是同一条业务链，摆放顺序即产品叙事
    expect(tenderIdx).toBe(proposalIdx + 1)
  })

  it('审标书有推荐 prompt，且每条都带招标文件槽', () => {
    const item = allSkillItems().find((i) => i.value === TENDER_VALUE)
    expect(item?.prompts?.length).toBeGreaterThan(0)
    for (const p of item!.prompts!) {
      expect(p.text).toContain('【招标文件】')
    }
  })

  it('招标文件槽能选到 PDF——这条槽此前落在"未命中任何关键词→不限制"档，没有专属格式引导，本条断言守的是 Task 4 新加的专属引导规则里含 .pdf', () => {
    expect(acceptForPlaceholder('招标文件')).toContain('.pdf')
  })
})

const DOC_CONVERT_VALUE = '/claude-desktop:doc-convert'

describe('内置场景目录 · 文档处理', () => {
  it('日常办公分类里有文档处理，且紧跟在处理表格之后', () => {
    const daily = DEFAULT_SCENARIO_CATALOG.categories.find((c) => c.id === 'daily')
    expect(daily).toBeDefined()
    const values = daily!.items.map((i) => i.value)
    const sheetsIdx = values.indexOf('/claude-desktop:spreadsheets')
    const docIdx = values.indexOf(DOC_CONVERT_VALUE)
    expect(sheetsIdx).toBeGreaterThanOrEqual(0)
    // 两者同属「处理已有文件」，摆放顺序即产品叙事
    expect(docIdx).toBe(sheetsIdx + 1)
  })

  it('PR1 首版恰好 4 条话术（B 类纯脚本），A 类 4 条属 PR2', () => {
    const item = allSkillItems().find((i) => i.value === DOC_CONVERT_VALUE)
    expect(item?.prompts?.length).toBe(4)
  })

  it('每条话术的文件槽都能选到它真正需要的格式', () => {
    // 槽关键词写错时 picker 会把正确格式置灰，用户以为功能坏了。
    // 这条断言把「关键词 → 格式」的映射钉死在测试里。
    expect(acceptForPlaceholder('Markdown 文件')).toContain('.md')
    expect(acceptForPlaceholder('Word 文件')).toContain('.docx')
    expect(acceptForPlaceholder('Excel 文件')).toContain('.csv')
    expect(acceptForPlaceholder('PDF 文件')).toContain('.pdf')
  })
})

describe('内置目录里每个技能条目都能查到 chip 外观', () => {
  // ScenarioRail 对 findSkillChipSpec 返回 null 的 chip 会整条静默跳过
  // （见 stores/scenarioCatalog.ts 的注释：「配了却看不见，最难查」）。
  // 这条断言覆盖全表而不只是新增项——任何人往内置目录加技能却忘了注册
  // chip，都会在这里当场失败，而不是等到肉眼发现卡片消失。
  it('无一遗漏', () => {
    // 收集缺失项再一次性断言，而不是循环里逐个 expect：失败时能直接看到
    // 「缺的是哪几个 value」。bun:test 的 expect 不接受第二个参数当消息
    // （那是 chai/vitest 的用法），循环里断言失败只会打印 "expected not null"。
    const missing = allSkillItems()
      .map((i) => i.value!)
      .filter((v) => findBuiltinSkillChipSpec(v) === null)
    expect(missing).toEqual([])
  })
})
