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
      // 两侧都不传 pathImpl/额外处理——main 侧走生产默认（宿主原生 node:path），这才是
      // 真实调用形态（main 进程从不会给自己注入 posix，注入口子只为测试存在）。
      const rendererResult = resolveRelativeAssetPath(base, src)
      const mainResult = resolveWritingAssetPath(base, src)
      // 【2026-08-04 第四轮收尾：比对前先把两侧分隔符都归一成正斜杠，不是改成注入 posix】
      // 这条对拍在 Windows CI 上曾经必红：渲染侧 resolveRelativeAssetPath 的产出恒为 posix
      // 形态（它的消费者是 writingasset:// 协议，协议内部认正斜杠，见 writingAssetUrl.ts）；
      // main 侧 resolveWritingAssetPath 默认走宿主原生 node:path，它的产出要直接喂给
      // readFileSync，在 Windows 宿主上天然吐反斜杠——`/p/proj/images/a.png` vs
      // `\p\proj\images\a.png`，字符串不相等，但这不是一个真实的行为分歧，是两个消费者
      // 各自的分隔符契约不同，从函数设计之初就是故意的（main 侧头注释里也没承诺分隔符要
      // 跟渲染侧一致）。
      //
      // 权衡过另一种修法——给这里的 mainResult 调用也注入 pathImpl.posix（即
      // `resolveWritingAssetPath(base, src, posix)`）：那样确实也能让断言在任何宿主上都过，
      // 但代价是没有真正测到「main 在生产环境会怎么跑」——production 从不传 pathImpl，
      // 注入 posix 后这条对拍实际上变成「渲染侧 vs 被强制掰成 posix 模式的 main」，Windows
      // 宿主上真实会跑的 win32 分支反而被绕过没测到。
      //
      // 选的这版（归一化后比较）保留了「两侧都用各自的生产默认路径跑」这个前提，只在最后
      // 比较时抹平「二者对同一逻辑路径允许用不同分隔符表达」这条已知且刻意的差异——不会把
      // 对拍削弱成「比较两个都被同一函数处理过的结果」：真正要害的「解析成功 vs 判越界」
      // 那条分界线，在归一化前后完全不受影响（对于本文件 CASES 里判越界/原样返回的用例，
      // rendererResult/mainResult 都等于原始 src，src 本身在 CASES 里就是纯 posix 写死的
      // 相对路径字面量，归一化是恒等操作，不会把一条本该判越界的用例误判成通过）。
      // win32 场景下 main 侧分隔符/UNC/混合分隔符的精确回归，由 writingExportPure.test.ts
      // 里「注入 path.win32」的 describe 块专项覆盖（31 组输入的原始来源），不需要在这里
      // 重复验证「main 在 Windows 上是否吐对了反斜杠」——本文件的职责窄化到「两份独立实现
      // 对同一输入的解析决策是否一致」。
      expect(rendererResult.replace(/\\/g, '/')).toBe(mainResult.replace(/\\/g, '/'))
    })
  }
})
