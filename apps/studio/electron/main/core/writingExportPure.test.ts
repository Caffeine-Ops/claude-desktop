import { describe, expect, it } from 'bun:test'
import { sanitizeBaseName } from './writingExportPure'

describe('sanitizeBaseName', () => {
  it('原样保留正常标题', () => {
    expect(sanitizeBaseName('周报 0729')).toBe('周报 0729')
  })

  it('去掉首尾空白', () => {
    expect(sanitizeBaseName('  标题  ')).toBe('标题')
  })

  it('替换路径分隔符（正斜杠）', () => {
    expect(sanitizeBaseName('2026/07 周报')).toBe('2026_07 周报')
  })

  it('替换路径分隔符（反斜杠）', () => {
    // 冒号也是 Windows 保留字符（下面「Windows 保留字符」测试块专门覆盖），
    // 故这里的期望值从最初的 'C:_临时_标题' 改为 'C__临时_标题'——`:` 与 `\` 都被替换。
    expect(sanitizeBaseName('C:\\临时\\标题')).toBe('C__临时_标题')
  })

  it('空串回退「文稿」', () => {
    expect(sanitizeBaseName('')).toBe('文稿')
  })

  it('纯空白回退「文稿」', () => {
    expect(sanitizeBaseName('   ')).toBe('文稿')
  })

  it('null/undefined 视同空串，回退「文稿」', () => {
    expect(sanitizeBaseName(null as unknown as string)).toBe('文稿')
    expect(sanitizeBaseName(undefined as unknown as string)).toBe('文稿')
  })

  it('Windows 保留字符一律换成下划线（导出物常要发给别人，跨平台可搬运优先）', () => {
    expect(sanitizeBaseName('Q3 报告: 增长分析?')).toBe('Q3 报告_ 增长分析_')
  })

  it('引号、尖括号、竖线、星号同样净化', () => {
    expect(sanitizeBaseName('a"b<c>d|e*f')).toBe('a_b_c_d_e_f')
  })

  it('Windows 保留设备名不能直接当文件名', () => {
    expect(sanitizeBaseName('CON')).not.toBe('CON')
    expect(sanitizeBaseName('com1')).not.toBe('com1')
    // 追加下划线而非整体回退「文稿」：用户仍认得出这是他那份「CON」标题的稿子。
    expect(sanitizeBaseName('CON')).toBe('CON_')
    expect(sanitizeBaseName('com1')).toBe('com1_')
  })

  it('非保留名的普通词不受设备名规则影响（哪怕前缀相同，如 CONcert）', () => {
    expect(sanitizeBaseName('CONcert')).toBe('CONcert')
    expect(sanitizeBaseName('COM10')).toBe('COM10')
  })

  it('开头的点去掉（否则在 Unix 上变成隐藏文件，用户以为导出失败）', () => {
    expect(sanitizeBaseName('.周报')).toBe('周报')
  })

  it('超长标题截到 80 个字符', () => {
    const long = '标'.repeat(200)
    expect([...sanitizeBaseName(long)].length).toBe(80)
  })

  it('按码点截断，不把中文/emoji 劈成半个字符', () => {
    const s = sanitizeBaseName('🎉'.repeat(100))
    expect([...s].length).toBe(80)
    expect(s.includes('�')).toBe(false)
  })
})
