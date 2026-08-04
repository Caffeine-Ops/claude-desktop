import { describe, expect, it } from 'bun:test'
import { sanitizeBaseName, resolveWritingAssetPath } from './writingExportPure'

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

// 与渲染侧 resolveRelativeAssetPath（src/chat/lib/writingAssetUrl.test.ts）覆盖同一组语义
// 用例，用 node:path 而非手写 posix 解析——测试跑在 bun（真实宿主 OS，这里是 posix），故
// 断言按 posix 分隔符写；win32 主机上跑同一份测试，path 模块会自动换成 win32 语义，产出的
// 分隔符会不同，但那是 node:path 自己的职责，不是本函数要额外保证的东西。
describe('resolveWritingAssetPath', () => {
  it('../ 上跳一级到兄弟目录', () => {
    expect(resolveWritingAssetPath('/p/稿子/drafts', '../images/a.png')).toBe(
      '/p/稿子/images/a.png'
    )
  })

  it('./ 同级目录', () => {
    expect(resolveWritingAssetPath('/p/稿子/drafts', './x.png')).toBe('/p/稿子/drafts/x.png')
  })

  it('绝对路径原样返回', () => {
    expect(resolveWritingAssetPath('/p/稿子/drafts', '/other/abs.png')).toBe('/other/abs.png')
  })

  it('http(s) 外链原样返回', () => {
    expect(resolveWritingAssetPath('/p/稿子/drafts', 'https://example.com/a.png')).toBe(
      'https://example.com/a.png'
    )
  })

  it('base 为 undefined 时原样返回（single 模式：调用方不传 assetBaseDir）', () => {
    expect(resolveWritingAssetPath(undefined, '../images/a.png')).toBe('../images/a.png')
  })

  it('base 为空串时原样返回', () => {
    expect(resolveWritingAssetPath('', '../images/a.png')).toBe('../images/a.png')
  })

  it('src 为空串时原样返回', () => {
    expect(resolveWritingAssetPath('/p/稿子/drafts', '')).toBe('')
  })

  it('base 非绝对路径时原样返回（没法安全解析，防御式兜底）', () => {
    expect(resolveWritingAssetPath('relative/drafts', '../images/a.png')).toBe(
      '../images/a.png'
    )
  })

  // 安全阀比渲染侧更紧：这里只放「跳到 base 的直接父目录」这一层（drafts → 项目根），
  // 唯一合法场景就是 ../images/x.png。多跳一层（意图挖 base 父目录之外的任意文件）
  // 一律视为非法，原样返回未解析的 src——不会把这类路径喂进 readFileSync。
  it('.. 跳出 base 的直接父目录之外——视为非法，原样返回', () => {
    expect(resolveWritingAssetPath('/a/b/drafts', '../../etc/passwd')).toBe('../../etc/passwd')
  })

  it('单层 ../ 恰好落在 base 父目录本身（无附加路径段）也算合法', () => {
    expect(resolveWritingAssetPath('/a/b/drafts', '../')).toBe('/a/b')
  })
})
