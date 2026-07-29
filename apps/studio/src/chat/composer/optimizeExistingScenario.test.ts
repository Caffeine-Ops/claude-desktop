import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

// 主入口 prompt 是静态配置，没有可导入的纯函数，改用读源文件断言关键片段
// 在场（设计 §12 自动化测试 #3）。路径相对 `bun test` 的 cwd（apps/studio）；
// 数据若再搬家，此断言会大声失败——正是我们要的。
//
// 2026-07-29：数据从 ScenarioRail.tsx 搬到 lib/scenarioCatalogDefaults.ts
// （远端可配置化重构，分类归属/推荐 prompt 改成从后台下发，拉不到才回落这份
// 内置默认表）；同一时间「优化已有作品」在另一个提交里被合并改名成
// 「优化 / 改写」（改写+体检优化合一），断言随之更新到当前文案。
const DEFAULTS = readFileSync('src/chat/lib/scenarioCatalogDefaults.ts', 'utf8')

describe('scenarioCatalogDefaults · 优化 / 改写主入口', () => {
  it('writing 场景含「优化 / 改写」标签', () => {
    expect(DEFAULTS).toContain("label: '优化 / 改写'")
  })

  it('主入口 prompt 用【文稿文件】文件槽', () => {
    expect(DEFAULTS).toContain('帮我优化或改写【文稿文件】')
  })

  it('主入口 prompt 明确「确认修改强度前不改正文」硬约束', () => {
    expect(DEFAULTS).toContain('在我确认修改强度前不要改正文')
  })
})
