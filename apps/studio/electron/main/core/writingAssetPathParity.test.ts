import { describe, expect, it } from 'bun:test'
import { resolveWritingAssetPath } from './writingExportPure'
// 【测试专属的跨进程边界 import】CLAUDE.md 的「两个世界」铁律禁止 main 侧被打包代码依赖
// src/chat/（渲染进程构建产物），但这条铁律管的是**会被 electron-vite/Next 两个打包器
// 实际打进产物**的代码——本文件是 *.test.ts，两侧 tsconfig 都显式 exclude 它
// （tsconfig.node.json / tsconfig.json 头注释同一句话："*.test.ts 由 bun test 运行"），
// bun 的模块解析不经过任一打包器，跨目录 import 不会把渲染侧代码带进 main 产物。
// 这里刻意跨进程 import 两份独立实现，是本文件唯一的存在理由：单测各自验证「自己那份实现
// 对不对」，但两份实现必须对同一批输入给出【相同】结论，否则就是 2026-08-04 code review
// Important 2 抓到的那类「预览有图、导出没图」静默破口——没有这条对拍，两侧下次改动
// （比如又有人只改一侧的边界值）会重新漂移而没有测试能抓到。
import { resolveRelativeAssetPath } from '../../../src/chat/lib/writingAssetUrl'

// 与 main 侧 resolveWritingAssetPath 头注释同一份语义表：base 必须是绝对路径，src 非
// `./`/`../` 开头的一律原样返回，相对路径只放行一层 `..`（drafts → images 兄弟目录）。
// 渲染侧的实现手写 posix 语义、main 侧用 node:path——工具不同，但对下面每组输入必须给出
// 完全一致的结论，这正是「语义对齐、实现各写各的」这句话要兑现的地方。
const CASES: Array<{ label: string; base: string; src: string }> = [
  { label: '单层 .. 解析到兄弟目录', base: '/p/proj/drafts', src: '../images/a.png' },
  { label: './ 同级目录', base: '/p/proj/drafts', src: './x.png' },
  { label: '绝对路径原样返回', base: '/p/proj/drafts', src: '/other/abs.png' },
  { label: 'http(s) 外链原样返回', base: '/p/proj/drafts', src: 'https://example.com/a.png' },
  // 两层及以上：2026-08-04 收紧后两侧都应判越界、原样返回。
  { label: '两层 .. 越界', base: '/p/proj/drafts', src: '../../images/x.png' },
  { label: '三层 .. 越界（更深的 base 也不放行）', base: '/p/proj/sub/drafts', src: '../../../images/x.png' },
  // base 只有一段时，单层 '..' 弹到空——两侧都应算作已经落在「base 的父目录」（floor=0），
  // 但再来一层就必须越界。
  { label: '浅 base 单层 .. 仍放行', base: '/drafts', src: '../images/x.png' },
  { label: '浅 base 两层 .. 越界', base: '/drafts', src: '../../images/x.png' }
]

describe('resolveRelativeAssetPath（渲染侧）与 resolveWritingAssetPath（main 侧）对拍', () => {
  for (const { label, base, src } of CASES) {
    it(label, () => {
      const rendererResult = resolveRelativeAssetPath(base, src)
      const mainResult = resolveWritingAssetPath(base, src)
      // 两侧对「是否解析成功」的判断必须一致：要么都解析出同一个绝对路径，要么都原样
      // 返回未解析的 src——不允许一侧解析成功、另一侧判越界（那正是本轮 code review
      // 抓到的「预览=导出」不一致的机制）。
      expect(rendererResult).toBe(mainResult)
    })
  }
})
