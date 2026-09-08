import { describe, expect, test } from 'bun:test'

import type { ShellStatFileInfo } from '@desktop-shared/ipc-channels'
import {
  EMPTY_OUTPUTS_FEED,
  feedClearFresh,
  feedOnEmptyCandidates,
  feedOnGenerated,
  feedOnStat,
  type OutputsFeedState
} from './sessionOutputsFeed'

const info = (path: string, mtimeMs = 1): ShellStatFileInfo => ({
  path,
  size: 10,
  mtimeMs
})

const paths = (files: readonly ShellStatFileInfo[]): string[] => files.map((f) => f.path)

describe('sessionOutputsFeed', () => {
  test('同一会话第一次拿到 stat 结果：当作历史已有，不算 fresh，files 最新在前', () => {
    const s = feedOnStat(EMPTY_OUTPUTS_FEED, 'A', [info('/a.pdf'), info('/b.png')], new Set())
    expect(paths(s.files)).toEqual(['/b.png', '/a.pdf'])
    expect(s.freshlyAdded.size).toBe(0)
    expect(s.sessionId).toBe('A')
  })

  test('同一会话后续新增的路径才算 fresh', () => {
    let s = feedOnStat(EMPTY_OUTPUTS_FEED, 'A', [info('/a.pdf')], new Set())
    s = feedOnStat(s, 'A', [info('/a.pdf'), info('/b.png')], new Set())
    expect([...s.freshlyAdded]).toEqual(['/b.png'])
  })

  test('全新会话（候选为空）就登记空基线：之后第一份产出算 fresh', () => {
    let s = feedOnEmptyCandidates(EMPTY_OUTPUTS_FEED, 'A')
    expect(s.files).toEqual([])
    s = feedOnStat(s, 'A', [info('/first.png')], new Set(['/first.png']))
    expect([...s.freshlyAdded]).toEqual(['/first.png'])
  })

  test('切到一个本来就有产出的会话：重新登记基线，不算 fresh，arrival 清零', () => {
    let s = feedOnStat(EMPTY_OUTPUTS_FEED, 'A', [info('/a.png')], new Set(['/a.png']))
    s = feedOnStat(s, 'A', [info('/a.png'), info('/b.png')], new Set(['/a.png', '/b.png']))
    expect(s.arrival?.path).toBe('/b.png')
    s = feedOnStat(s, 'B', [info('/x.png'), info('/y.png')], new Set(['/x.png', '/y.png']))
    expect(s.freshlyAdded.size).toBe(0)
    expect(s.arrival).toBeNull()
    expect(paths(s.images)).toEqual(['/y.png', '/x.png'])
  })

  test('images = files 里被判定为生成图的那些，保持最新在前', () => {
    const s = feedOnStat(
      EMPTY_OUTPUTS_FEED,
      'A',
      [info('/doc.pdf'), info('/gen.png'), info('/attach.png')],
      new Set(['/gen.png'])
    )
    expect(paths(s.images)).toEqual(['/gen.png'])
  })

  test('fresh 先于「判定为生成图」到达：先挂起，等 generated 追上再发 arrival', () => {
    // 复现 2026-09-07 真机场景：路径先以正文形式出现（文件已在盘上）→
    // stat 核实到、算 fresh；Bash 调用 settled 才被判为生成图。
    let s = feedOnEmptyCandidates(EMPTY_OUTPUTS_FEED, 'A')
    s = feedOnStat(s, 'A', [info('/late.png')], new Set())
    expect([...s.freshlyAdded]).toEqual(['/late.png'])
    expect(s.arrival).toBeNull()
    // 2.6s 后 fresh 被清空——挂起集合不受影响
    s = feedClearFresh(s)
    expect(s.freshlyAdded.size).toBe(0)
    // 工具 settled，generated 追上（候选没变，所以不会再 stat）
    s = feedOnGenerated(s, new Set(['/late.png']))
    expect(paths(s.images)).toEqual(['/late.png'])
    expect(s.arrival).toEqual({ path: '/late.png', seq: 1, sessionId: 'A' })
  })

  test('每次 arrival 的 seq 递增：同一路径被覆盖重生成也能再触发', () => {
    let s = feedOnEmptyCandidates(EMPTY_OUTPUTS_FEED, 'A')
    s = feedOnStat(s, 'A', [info('/a.png')], new Set(['/a.png']))
    expect(s.arrival?.seq).toBe(1)
    s = feedOnStat(s, 'A', [info('/a.png'), info('/b.png')], new Set(['/a.png', '/b.png']))
    expect(s.arrival).toEqual({ path: '/b.png', seq: 2, sessionId: 'A' })
  })

  test('arrival 带着它所属的会话 id：消费者切会话时能识别出这是旧会话的事件', () => {
    let s = feedOnEmptyCandidates(EMPTY_OUTPUTS_FEED, 'A')
    s = feedOnStat(s, 'A', [info('/a.png')], new Set(['/a.png']))
    expect(s.arrival?.sessionId).toBe('A')
  })

  test('同一路径被覆盖重生成（mtime 变了）：再次算 fresh，arrival 再触发', () => {
    // image_gen.py 对目录输出用固定文件名，--force 原地覆盖：路径不变、
    // 字节变了。只按路径记基线会永远认为「见过了」。
    let s = feedOnEmptyCandidates(EMPTY_OUTPUTS_FEED, 'A')
    s = feedOnStat(s, 'A', [info('/image_1.png', 100)], new Set(['/image_1.png']))
    expect(s.arrival?.seq).toBe(1)
    s = feedClearFresh(s)
    s = feedOnStat(s, 'A', [info('/image_1.png', 200)], new Set(['/image_1.png']))
    expect([...s.freshlyAdded]).toEqual(['/image_1.png'])
    expect(s.arrival).toEqual({ path: '/image_1.png', seq: 2, sessionId: 'A' })
    expect(s.images[0].mtimeMs).toBe(200)
  })

  test('mtime 没变的重复 stat 不算 fresh', () => {
    let s = feedOnEmptyCandidates(EMPTY_OUTPUTS_FEED, 'A')
    s = feedOnStat(s, 'A', [info('/a.png', 100)], new Set(['/a.png']))
    s = feedClearFresh(s)
    s = feedOnStat(s, 'A', [info('/a.png', 100)], new Set(['/a.png']))
    expect(s.freshlyAdded.size).toBe(0)
  })

  test('feedClearFresh 只清 freshlyAdded，其余不动', () => {
    const before: OutputsFeedState = feedOnStat(
      feedOnEmptyCandidates(EMPTY_OUTPUTS_FEED, 'A'),
      'A',
      [info('/a.png')],
      new Set(['/a.png'])
    )
    const after = feedClearFresh(before)
    expect(after.freshlyAdded.size).toBe(0)
    expect(after.files).toBe(before.files)
    expect(after.arrival).toBe(before.arrival)
  })

  test('切会话时 feedOnEmptyCandidates 清空 files/images 与挂起集合', () => {
    let s = feedOnEmptyCandidates(EMPTY_OUTPUTS_FEED, 'A')
    s = feedOnStat(s, 'A', [info('/a.png')], new Set())
    s = feedOnEmptyCandidates(s, 'B')
    expect(s.sessionId).toBe('B')
    expect(s.files).toEqual([])
    expect(s.images).toEqual([])
    expect(s.freshlyAdded.size).toBe(0)
    // B 的第一份产出要算 fresh（基线是空的）
    s = feedOnStat(s, 'B', [info('/b.png')], new Set(['/b.png']))
    expect([...s.freshlyAdded]).toEqual(['/b.png'])
  })
})
