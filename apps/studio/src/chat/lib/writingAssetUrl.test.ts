import { describe, expect, it } from 'bun:test'
import { resolveRelativeAssetPath, toWritingAssetUrl, writingAssetBaseDir } from './writingAssetUrl'

describe('toWritingAssetUrl', () => {
  it('写作项目配图转成 writingasset:// URL', () => {
    const p = '/Users/k/projects/稿子_20260803/images/gen-1.png'
    expect(toWritingAssetUrl(p)).toBe(`writingasset://w/${encodeURIComponent(p)}`)
  })

  it('非写作资产路径原样返回——链式判定靠这个不误伤外链与 KB 图', () => {
    expect(toWritingAssetUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
    // 2026-08-03 code review Minor 6：此前这条用例是重言式——原路径本身不含 /images/，
    // 删掉 isWritingAssetSrc 里的 kb-index 排除分支它照样绿，没测到那行代码。换成一个
    // 真正会撞上 /images/ 白名单、必须靠 kb-index 排除分支才能拦住的输入。
    expect(toWritingAssetUrl('/Users/k/kb-index/assets/images/x.png')).toBe(
      '/Users/k/kb-index/assets/images/x.png'
    )
    // 同理：proposal-drafts 排除分支也要用会撞上 /images/ 的输入来测。
    expect(toWritingAssetUrl('/Users/k/proposal-drafts/s1/assets/images/x.png')).toBe(
      '/Users/k/proposal-drafts/s1/assets/images/x.png'
    )
  })

  it('空串原样返回', () => {
    expect(toWritingAssetUrl('')).toBe('')
  })

  // Important 2：win32 绝对路径此前在 isWritingAssetSrc 的 `startsWith('/')` 门槛上就被
  // 挡掉，整条链在 Windows 上恒断。toPosix 归一后应能识别，且编码仍用调用方传入的原始
  // 反斜杠字节（main 侧按原样 decode 后落盘比对，不能被这里悄悄改写分隔符）。
  it('win32 反斜杠绝对路径也能转成 writingasset:// URL（判定走 toPosix，编码保留原始字节）', () => {
    const p = 'C:\\Users\\k\\稿子\\images\\gen-1.png'
    expect(toWritingAssetUrl(p)).toBe(`writingasset://w/${encodeURIComponent(p)}`)
  })
})

// 正文里的图路径恒为相对路径（正文分节文件在 <项目>/drafts/，图在 <项目>/images/，
// 是兄弟目录），AssistantMarkdown 的 img 覆写要先把它解析成绝对路径才能进
// kb → proposal → writing 链（三者判定都是绝对路径谓词）。见 task-1-brief.md
// 之外的控制者裁定：渲染进程拿不到 node:path，手写 posix 语义的归一化。
describe('resolveRelativeAssetPath', () => {
  it('../ 上跳一级到兄弟目录', () => {
    expect(resolveRelativeAssetPath('/p/稿子/drafts', '../images/a.png')).toBe(
      '/p/稿子/images/a.png'
    )
  })

  it('./ 同级目录', () => {
    expect(resolveRelativeAssetPath('/p/稿子/drafts', './x.png')).toBe('/p/稿子/drafts/x.png')
  })

  it('绝对路径原样返回', () => {
    expect(resolveRelativeAssetPath('/p/稿子/drafts', '/other/abs.png')).toBe('/other/abs.png')
  })

  it('http(s) 外链原样返回', () => {
    expect(resolveRelativeAssetPath('/p/稿子/drafts', 'https://example.com/a.png')).toBe(
      'https://example.com/a.png'
    )
  })

  it('base 为空串时原样返回', () => {
    expect(resolveRelativeAssetPath('', '../images/a.png')).toBe('../images/a.png')
  })

  // Important 2：win32 base（写作项目所在的操作系统目录）此前 `base.split('/')` 切不开
  // 反斜杠串，一个 '..' 就把整条 base 当一段 pop 光，吐出脱离 base 的裸相对路径
  // （`images/a.png`）。toPosix 归一 base 后应能正确定位到兄弟目录。
  it('win32 base + 相对路径也能正确归一到兄弟目录', () => {
    expect(resolveRelativeAssetPath('C:\\Users\\k\\稿子\\drafts', '../images/a.png')).toBe(
      'C:/Users/k/稿子/images/a.png'
    )
  })

  // Minor 6 裁定：'..' 跳出 base 之外视为非法输入，不拼一个逃逸到不相关目录的绝对路径，
  // 原样返回未解析的 src——下游链式判定对着相对串不会命中任何一条 asset 协议，这张图
  // 刷不出来，但不会把用户导向一个越界的绝对路径。
  it('.. 跳出 base 之外——视为非法，原样返回，不静默逃逸到不相关目录', () => {
    expect(resolveRelativeAssetPath('/a', '../../../images/x.png')).toBe(
      '../../../images/x.png'
    )
  })

  // 2026-08-04 code review Important 2：此前的边界是「base 越深、'..' 能弹得越多」——
  // base='/p/proj/drafts'（3 段）时 '../../images/x.png' 曾被解析成功（'/p/images/x.png'）。
  // main 侧导出用的 resolveWritingAssetPath（electron/main/core/writingExportPure.ts）从
  // 一开始就只放一层，两侧标准不一致时这类两层 '..' 在预览里能显示、导出却降级成文字占位，
  // 是一处真实的「预览=导出」破口（回归测试锁住，不能再放开）。
  it('两层 .. 现在视为越界（即便 base 足够深、老规则本会放行）——原样返回', () => {
    expect(resolveRelativeAssetPath('/p/proj/drafts', '../../images/x.png')).toBe(
      '../../images/x.png'
    )
  })

  it('单层 .. 仍然放行（唯一合法场景：drafts → images 兄弟目录）', () => {
    expect(resolveRelativeAssetPath('/p/proj/drafts', '../images/x.png')).toBe(
      '/p/proj/images/x.png'
    )
  })
})

describe('writingAssetBaseDir', () => {
  it('project 模式返回 <projectDir>/drafts', () => {
    expect(writingAssetBaseDir({ kind: 'project', projectDir: '/p/稿子' })).toBe('/p/稿子/drafts')
  })

  it('single 模式返回 undefined（配图功能整体只支持项目模式，不猜一个目录出来）', () => {
    expect(writingAssetBaseDir({ kind: 'single', filePath: '/p/稿子.md' })).toBeUndefined()
  })

  it('source 为 null（尚未识别出写作项目）返回 undefined', () => {
    expect(writingAssetBaseDir(null)).toBeUndefined()
  })

  // 2026-08-04 第三轮 code review：拼接分隔符跟随 projectDir 自身风格，不再硬编码正斜杠
  // ——否则 win32 上 `${projectDir}/drafts` 会拼出混合分隔符字符串，main 侧一度因此算错
  // 目录（见 main 侧 resolveWritingAssetPath 头注释的完整事故记录）。
  it('projectDir 是纯 win32 反斜杠路径时，拼接也用反斜杠（不产出混合分隔符）', () => {
    expect(writingAssetBaseDir({ kind: 'project', projectDir: 'C:\\Users\\k\\稿子' })).toBe(
      'C:\\Users\\k\\稿子\\drafts'
    )
  })

  it('projectDir 已含正斜杠（哪怕同时也有反斜杠）时，仍用正斜杠拼接——不比现状更差', () => {
    expect(writingAssetBaseDir({ kind: 'project', projectDir: 'C:/Users/k/稿子' })).toBe(
      'C:/Users/k/稿子/drafts'
    )
  })
})
