import { describe, expect, test } from 'bun:test'
import { applyComponentPatch, mapPipxResult } from './componentOrchestrator.core'
import { initialComponentState, type ComponentTable } from '../../../shared/componentDownload'

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
