import { describe, expect, it } from 'bun:test'
import { detectWritingSource, pickFilePath, type WritingToolPart } from './writingDocSource'

function bash(resultText: string, commandText = ''): WritingToolPart {
  return { toolName: 'Bash', commandText, resultText, filePath: null }
}
function write(filePath: string): WritingToolPart {
  return { toolName: 'Write', commandText: '', resultText: '', filePath }
}

describe('detectWritingSource · 项目模式', () => {
  it('从脚本输出的 WRITING_PROJECT= 行抓项目目录', () => {
    const parts = [bash('已创建项目\nWRITING_PROJECT=/Users/k/写作/小说_2026-07-29\n')]
    expect(detectWritingSource(parts)).toEqual({
      kind: 'project',
      projectDir: '/Users/k/写作/小说_2026-07-29'
    })
  })

  it('多次 init 时取最后一个（用户开了第二个项目）', () => {
    const parts = [
      bash('WRITING_PROJECT=/a/proj1\n'),
      bash('WRITING_PROJECT=/a/proj2\n')
    ]
    expect(detectWritingSource(parts)).toEqual({ kind: 'project', projectDir: '/a/proj2' })
  })

  it('相对路径不接管——main 侧只收绝对路径，早点挡住避免无谓 IPC', () => {
    expect(detectWritingSource([bash('WRITING_PROJECT=relative/proj\n')])).toBeNull()
  })

  it('标记后面为空时不接管', () => {
    expect(detectWritingSource([bash('WRITING_PROJECT=\n')])).toBeNull()
  })
})

describe('detectWritingSource · 单文件模式', () => {
  it('认 Write 到「写作」目录下的 .md', () => {
    expect(detectWritingSource([write('/Users/k/proj/写作/本周周报.md')])).toEqual({
      kind: 'single',
      filePath: '/Users/k/proj/写作/本周周报.md'
    })
  })

  it('不在「写作」目录下的 md 不接管（AI 写别的文档不该弹工作区）', () => {
    expect(detectWritingSource([write('/Users/k/proj/docs/readme.md')])).toBeNull()
  })

  it('「写作」目录下的非 md 不接管', () => {
    expect(detectWritingSource([write('/Users/k/proj/写作/data.json')])).toBeNull()
  })

  it('多次写入取最后一个', () => {
    const parts = [write('/a/写作/一.md'), write('/a/写作/二.md')]
    expect(detectWritingSource(parts)).toEqual({ kind: 'single', filePath: '/a/写作/二.md' })
  })
})

describe('detectWritingSource · 优先级与兜底', () => {
  it('项目模式优先于单文件模式，与出现顺序无关', () => {
    const parts = [write('/a/写作/周报.md'), bash('WRITING_PROJECT=/a/proj\n')]
    expect(detectWritingSource(parts)).toEqual({ kind: 'project', projectDir: '/a/proj' })
    const reversed = [bash('WRITING_PROJECT=/a/proj\n'), write('/a/写作/周报.md')]
    expect(detectWritingSource(reversed)).toEqual({ kind: 'project', projectDir: '/a/proj' })
  })

  it('没有任何写作痕迹时返回 null（普通会话保持单栏）', () => {
    expect(detectWritingSource([bash('ls -la'), write('/a/src/index.ts')])).toBeNull()
  })

  it('空数组返回 null', () => {
    expect(detectWritingSource([])).toBeNull()
  })

  it('「我的写作笔记」这类含「写作」二字的目录不误命中', () => {
    expect(detectWritingSource([write('/Users/k/我的写作笔记/x.md')])).toBeNull()
  })
})

describe('detectWritingSource · Windows 路径', () => {
  it('认盘符绝对路径', () => {
    expect(detectWritingSource([write('C:\\Users\\k\\写作\\周报.md')])).toEqual({
      kind: 'single',
      filePath: 'C:\\Users\\k\\写作\\周报.md'
    })
  })

  it('认 UNC 路径（网络共享盘）', () => {
    const p = '\\\\server\\share\\写作\\周报.md'
    expect(detectWritingSource([write(p)])).toEqual({ kind: 'single', filePath: p })
  })

  it('项目标记也认 UNC 路径', () => {
    const parts = [bash('WRITING_PROJECT=\\\\server\\share\\proj_2026-07-29\n')]
    expect(detectWritingSource(parts)).toEqual({
      kind: 'project',
      projectDir: '\\\\server\\share\\proj_2026-07-29'
    })
  })
})

describe('detectWritingSource · 命令文本分支', () => {
  it('标记出现在 Bash 命令文本里也认（用户手敲 echo 调试）', () => {
    const parts = [bash('', 'echo "WRITING_PROJECT=/a/proj"')]
    expect(detectWritingSource(parts)).toEqual({ kind: 'project', projectDir: '/a/proj' })
  })

  it('命令文本与输出都有标记时，取输出里的那个（输出是脚本真实报数）', () => {
    const parts = [bash('WRITING_PROJECT=/a/real\n', 'echo "WRITING_PROJECT=/a/typed"')]
    expect(detectWritingSource(parts)).toEqual({ kind: 'project', projectDir: '/a/real' })
  })
})

describe('pickFilePath · 三字段兜底链', () => {
  it('优先 file_path', () => {
    expect(pickFilePath({ file_path: '/a.md', filePath: '/b.md', path: '/c.md' })).toBe('/a.md')
  })
  it('无 file_path 时退 filePath', () => {
    expect(pickFilePath({ filePath: '/b.md', path: '/c.md' })).toBe('/b.md')
  })
  it('前两个都没有时退 path', () => {
    expect(pickFilePath({ path: '/c.md' })).toBe('/c.md')
  })
  it('空串视为没有，继续往下兜', () => {
    expect(pickFilePath({ file_path: '', filePath: '/b.md' })).toBe('/b.md')
  })
  it('三个都没有返回 null', () => {
    expect(pickFilePath({ other: 1 })).toBeNull()
  })
  it('非对象入参返回 null', () => {
    expect(pickFilePath(null)).toBeNull()
    expect(pickFilePath('x')).toBeNull()
  })
  it('字段值不是字符串时跳过', () => {
    expect(pickFilePath({ file_path: 123, filePath: '/b.md' })).toBe('/b.md')
  })
})
