import { describe, expect, test, mock } from 'bun:test'
import type { ComponentTable } from '../../../shared/componentDownload'

// componentOrchestrator.ts 顶层 import 了 kbModelDir/kbSemanticSearch/kbBuildRunner/kbIndexStore，
// 它们各自顶层 `import { app } from 'electron'`——bun test 不在真实 Electron 运行时里跑，
// node_modules/electron/index.js 只是「找二进制路径」的 CLI 桩，没有 app/utilityProcess 具名
// 导出，静态 import 它们会在模块求值阶段直接抛 SyntaxError（哪怕只是想用两个不碰 electron 的
// 纯函数）。用 bun:test 的 mock.module 在真正 import 被测模块之前把 'electron' 换成够用的桩；
// mock.module 必须先于 import 执行，故下面用动态 import（顶层 await）而非静态 import 加载
// 被测模块——静态 import 会被提升到文件顶部、抢在 mock.module 之前执行。
// 只测两个不碰 electron 的纯函数（applyComponentPatch/mapPipxResult）；其余 io 编排靠
// typecheck + 手动验证（*.test.ts 不进 tsc，见 tsconfig.node.json exclude）。
mock.module('electron', () => ({
  app: { getPath: () => '/tmp/component-orchestrator-test-userdata' },
  utilityProcess: { fork: () => ({ on: () => {}, kill: () => {}, postMessage: () => {} }) },
}))

const { applyComponentPatch, mapPipxResult } = await import('./componentOrchestrator')
const { initialComponentState } = await import('../../../shared/componentDownload')

describe('applyComponentPatch', () => {
  test('只改目标格、返回新对象、不动其他格', () => {
    const base: ComponentTable = { a: initialComponentState('a'), b: initialComponentState('b') }
    const next = applyComponentPatch(base, 'a', { status: 'installing', percent: 40 })
    expect(next.a.status).toBe('installing')
    expect(next.a.percent).toBe(40)
    expect(next.b).toBe(base.b)        // 未动的格同引用
    expect(next).not.toBe(base)        // 顶层新对象
    expect(base.a.status).toBe('idle') // 原表不被就地改
  })
  test('未知 id 补一格再打补丁', () => {
    const next = applyComponentPatch({}, 'x', { status: 'ready' })
    expect(next.x.status).toBe('ready')
    expect(next.x.id).toBe('x')
  })
})

describe('mapPipxResult', () => {
  test('ok → ready', () => {
    expect(mapPipxResult({ ok: true, unsupported: false, tooling: { markitdown: true, soffice: false }, log: '' }))
      .toEqual({ status: 'ready', errorMessage: null })
  })
  test('unsupported → unavailable', () => {
    expect(mapPipxResult({ ok: false, unsupported: true, tooling: { markitdown: false, soffice: false }, log: 'x' }).status)
      .toBe('unavailable')
  })
  test('普通失败 → error（带 log 摘要）', () => {
    const r = mapPipxResult({ ok: false, unsupported: false, tooling: { markitdown: false, soffice: false }, log: 'boom' })
    expect(r.status).toBe('error')
    expect(r.errorMessage).toContain('boom')
  })
})
