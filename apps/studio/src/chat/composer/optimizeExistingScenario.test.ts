import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

// 主入口 prompt 是 ScenarioRail.tsx 里的静态配置，没有可导入的纯函数，改用读
// 源文件断言关键片段在场（设计 §12 自动化测试 #3）。路径相对 `bun test` 的
// cwd（apps/studio）；ScenarioRail 若搬家，此断言会大声失败——正是我们要的。
const RAIL = readFileSync(
  'src/chat/components/chat/ThreadView/ScenarioRail.tsx',
  'utf8'
)

describe('ScenarioRail · 优化已有作品主入口', () => {
  it('writing 场景含「优化已有作品」标签', () => {
    expect(RAIL).toContain("label: '优化已有作品'")
  })

  it('主入口 prompt 用【文稿文件】文件槽', () => {
    expect(RAIL).toContain('帮我优化【文稿文件】')
  })

  it('主入口 prompt 明确「确认修改强度前不改正文」硬约束', () => {
    expect(RAIL).toContain('在我确认修改强度前，不要改正文')
  })
})
