import { describe, expect, test } from 'bun:test'
import { initialKbBuildStatus, reduceKbBuildStatus } from './kbBuildStatus'

describe('reduceKbBuildStatus', () => {
  test('start→progress→exit(ok) 生命周期', () => {
    let s = reduceKbBuildStatus(initialKbBuildStatus, { type: 'start' })
    expect(s.running).toBe(true)
    s = reduceKbBuildStatus(s, { type: 'progress', phase: 'convert', done: 3, total: 10 })
    expect(s.phase).toEqual({ phase: 'convert', done: 3, total: 10 })
    s = reduceKbBuildStatus(s, { type: 'exit', ok: true, error: null, atMs: 42 })
    expect(s).toEqual({ running: false, queued: false, phase: null, lastError: null, lastFinishedAtMs: 42 })
  })
  test('运行中 queue 置位；exit 保留 queued 供 runner 决定尾随再跑', () => {
    let s = reduceKbBuildStatus(initialKbBuildStatus, { type: 'start' })
    s = reduceKbBuildStatus(s, { type: 'queue' })
    expect(s.queued).toBe(true)
    s = reduceKbBuildStatus(s, { type: 'exit', ok: false, error: 'boom', atMs: 1 })
    expect(s.queued).toBe(true)   // 尾随意图不能被失败吞掉——排队的改动仍需一轮构建
    expect(s.lastError).toBe('boom')
    s = reduceKbBuildStatus(s, { type: 'start' })
    expect(s.queued).toBe(false)  // 尾随轮启动即消费掉排队标记
  })
})
