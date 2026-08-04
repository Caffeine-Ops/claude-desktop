import { describe, expect, it } from 'bun:test'
import { posix, win32 } from 'node:path'
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
// 用例，用 node:path 而非手写 posix 解析。
//
// 【2026-08-04 第四轮收尾：显式注入 path.posix，不再依赖「测试跑在 posix 机器上」】此前
// 这里不传 pathImpl、断言却写死 posix 形态的期望值（`/p/稿子/images/a.png`）——想当然地
// 假设「宿主原生 node:path 就是 posix」。但本仓库 CI 矩阵（.github/workflows/build.yml）
// 明确有 windows-latest 一条腿，且同样跑这份 `bun test`；Windows runner 上宿主原生就是
// path.win32，不传 pathImpl 时函数会用 `\` 拼接结果，这几条断言在 Windows CI 上必红
// （审查者用 `resolveWritingAssetPath(base, src, win32)` 复现确认）。这几条用例只关心
// 「相对路径解析的段栈逻辑对不对」，不关心分隔符风格，故显式传 `path.posix` 把输入输出都
// 钉死在 posix 语义——不再依赖「测试机器恰好是什么系统」这条脆弱的隐性前提。win32 专属的
// 分隔符/UNC/混合分隔符回归覆盖见下面「注入 path.win32」的 describe 块，两边职责不重叠。
describe('resolveWritingAssetPath', () => {
  it('../ 上跳一级到兄弟目录', () => {
    expect(resolveWritingAssetPath('/p/稿子/drafts', '../images/a.png', posix)).toBe(
      '/p/稿子/images/a.png'
    )
  })

  it('./ 同级目录', () => {
    expect(resolveWritingAssetPath('/p/稿子/drafts', './x.png', posix)).toBe(
      '/p/稿子/drafts/x.png'
    )
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
    // 同上：显式传 path.posix，断言的 '/a/b' 才不依赖测试机器是 posix 还是 win32。
    expect(resolveWritingAssetPath('/a/b/drafts', '../', posix)).toBe('/a/b')
  })
})

// 2026-08-04 第三轮 code review：Windows 上的 base 恒为混合分隔符（writingAssetBaseDir 用
// `${projectDir}/drafts` 字符串拼接，projectDir 来自 CLI stdout 是原生反斜杠，硬编码的
// `/drafts` 却是正斜杠）。跑测试的机器几乎总是 posix，host-native `path.isAbsolute('C:\\...')`
// 在 posix 上恒为 false，任何 win32 专属输入不注入 path.win32 就测不到——这正是上一轮
// parity 测试漏抓这条回归的原因（那份测试只喂了 posix 绝对路径）。这里显式传 win32 精确
// 复现目标平台语义，不依赖跑测试的机器是什么系统。
describe('resolveWritingAssetPath（注入 path.win32，模拟真实 Windows 运行时）', () => {
  it('纯反斜杠 base（未混合）：单层 .. 解析到兄弟目录', () => {
    expect(
      resolveWritingAssetPath('C:\\Users\\k\\稿子\\drafts', '../images/a.png', win32)
    ).toBe('C:\\Users\\k\\稿子\\images\\a.png')
  })

  // 【核心回归用例】base 尾段混着正斜杠（writingAssetBaseDir 拼接的真实产物）：修复前的
  // 段栈实现只按 `\` 切分，`稿子/drafts` 被当成一整段，一个 `..` 多弹一级，产出少一层的
  // 错误目录（审查者实测：`C:\Users\k\images\a.png`，把 `稿子` 那一级也弹没了）。
  it('base 尾段混着正斜杠（真实 Windows 上 writingAssetBaseDir 的拼接产物）——单层 .. 仍应只弹一级', () => {
    expect(
      resolveWritingAssetPath('C:\\Users\\k\\稿子/drafts', '../images/a.png', win32)
    ).toBe('C:\\Users\\k\\稿子\\images\\a.png')
  })

  // 更极端：base 整段全用正斜杠（比如未来某处改用 path.posix 风格拼接）——修复前会把整条
  // 路径当成一段，结果塌成 `C:/images\a.png` 这种胡乱拼接。
  it('base 整段全是正斜杠——同样应正确归一后解析', () => {
    expect(resolveWritingAssetPath('C:/Users/k/proj/drafts', '../images/a.png', win32)).toBe(
      'C:\\Users\\k\\proj\\images\\a.png'
    )
  })

  // UNC 路径（网络共享盘）：双反斜杠前缀是语义的一部分，归一化必须逐字符替换、不能用
  // `+` 合并连续分隔符，否则会把开头的 `\\` 压成一个 `\`、破坏 UNC 前缀。
  it('UNC 路径（网络共享盘）：双反斜杠前缀不被破坏', () => {
    expect(
      resolveWritingAssetPath('\\\\srv\\share\\稿子\\drafts', '../images/a.png', win32)
    ).toBe('\\\\srv\\share\\稿子\\images\\a.png')
  })

  it('两层 .. 在 win32 上同样判越界（与 posix 侧同一条 floor 规则）', () => {
    expect(
      resolveWritingAssetPath('C:\\Users\\k\\proj\\drafts', '../../images/a.png', win32)
    ).toBe('../../images/a.png')
  })

  it('win32 上非绝对路径（缺盘符）原样返回', () => {
    expect(resolveWritingAssetPath('Users\\k\\drafts', '../images/a.png', win32)).toBe(
      '../images/a.png'
    )
  })
})

// 2026-08-04 第三轮 code review：渲染侧 resolveRelativeAssetPath 没有 isAbsolute 守卫（只
// 检查 `!base`），main 侧 resolveWritingAssetPath 从最初版本起就显式拒绝非绝对 base——这是
// 一条真实存在、刻意为之的语义不对称（main 侧注释写着「不做无意义的相对解析——项目侧调用方
// 恒传绝对目录」），不是本轮要修的分歧。之所以从未在真实调用链上炸出问题，是因为
// writingAssetBaseDir() 的唯一输出形态就是 `${projectDir}/drafts`，而 projectDir 恒为绝对
// 路径（CLI 侧保证）。这里用测试把这条差异钉下来，不让它在归档时被读成"两侧行为一致"。
describe('resolveWritingAssetPath 对相对 base 的处理——与渲染侧刻意不同（记录差异，不是待修 bug）', () => {
  it('main 侧对非绝对 base 一律拒绝、原样返回 src（渲染侧对同样输入会尝试"解析"出一个相对串）', () => {
    // 对照：src/chat/lib/writingAssetUrl.test.ts 没有对应的"非绝对 base"用例（渲染侧从不
    // 检查 isAbsolute），若真传一个相对 base 进 resolveRelativeAssetPath，它会把 base 当
    // 绝对路径一样切分处理、吐出一个不带前导分隔符的相对字符串，而不是原样返回 src——两侧
    // 对这类输入的处理结论不同，是设计上的不对称，main 更保守。
    expect(resolveWritingAssetPath('relative/drafts', '../images/a.png')).toBe(
      '../images/a.png'
    )
  })
})
