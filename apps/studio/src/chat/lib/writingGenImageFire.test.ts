import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { WritingSection } from '@desktop-shared/writing'
import {
  buildWritingGenImagePrompt,
  autoFireWritingGenImages,
  resetWritingGenImageAutoFireState,
  MAX_AUTO_FIRE_PER_WRITING_PROJECT
} from './writingGenImageFire'
import { useWritingStore } from '../stores/writing'

describe('buildWritingGenImagePrompt', () => {
  it('把契约锁定的画风拼进提示词——风格来自 spec_lock 的 image_style，不是硬编码', () => {
    const p = buildWritingGenImagePrompt(
      { caption: '深夜的便利店', prompt: '暖黄灯光，窗外下雨，人物背影' },
      '极简线条插画，低饱和暖色'
    )
    expect(p).toContain('深夜的便利店')
    expect(p).toContain('暖黄灯光，窗外下雨，人物背影')
    expect(p).toContain('极简线条插画，低饱和暖色')
  })

  it('画风为空时不拼出空的风格句', () => {
    const p = buildWritingGenImagePrompt({ caption: 'a', prompt: 'b' }, '')
    // 2026-08 审查 M-5 修复：旧断言 `not.toContain('风格要求：\n')` / `endsWith('：')`
    // 对任何实现都恒真（风格非空时拼的是 `风格要求：${style}。\n`，永远不会紧跟换行；
    // 风格为空时整句根本不拼）——测不出「空画风时漏拼了空风格句」这个它声称要防的 bug。
    // 直接断言整个「风格要求」字样都不该出现。
    expect(p).not.toContain('风格要求')
  })

  it('恒定要求「不要在图里写字」——生图模型的中文标注必糊，这是写作配图的硬伤', () => {
    const p = buildWritingGenImagePrompt({ caption: 'a', prompt: 'b' }, 'x')
    expect(p).toContain('不要在画面中出现任何文字')
  })
})

/** 造一个带 genimage 指令块的节，caption/prompt 按序号区分，保证多块 raw 互不相同。 */
function directiveBlock(i: number): string {
  return ['```genimage', `图说: 图${i}`, `构图描述${i}`, '```'].join('\n')
}

function section(name: string, markdown: string, mtimeMs = 1000): WritingSection {
  return { name, markdown, mtimeMs }
}

const PROJECT_DIR = '/proj'

let calls: { projectDir: string; prompt: string }[]

/** 等本轮 fireWritingGenImage 内部的 IPC await 与其后续同步代码都跑完。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  calls = []
  // window 在裸 bun 运行时不存在，需要自己搭一个最小桩——只有出图触发器用到的
  // chatApi.writingImageGenerate 这一个方法。
  ;(globalThis as { window?: unknown }).window = {
    chatApi: {
      writingImageGenerate: async (args: { projectDir: string; prompt: string }) => {
        calls.push(args)
        return { path: `${args.projectDir}/images/x.png`, relPath: '../images/x.png' }
      }
    }
  }
  // 稳定判据的签名表与配额告警去重表是模块级状态，会跨测试用例残留——每个用例开始前清零，
  // 否则前一个用例留下的"已稳定"签名会让下一个用例的第一轮就误判成稳定（同生产代码里
  // useWritingPoll 每次 effect 重启都要调用的理由一致）。
  resetWritingGenImageAutoFireState()
  useWritingStore.getState().setSource({ kind: 'project', projectDir: PROJECT_DIR })
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe('autoFireWritingGenImages · 幂等（守卫③）', () => {
  it('同一指令块的稳定判据通过后即便再调用也只发起一次生图', async () => {
    useWritingStore.getState().setSections([section('1-a.md', directiveBlock(0))])
    autoFireWritingGenImages() // tick1：内容第一次出现，只记签名，不发起
    autoFireWritingGenImages() // tick2：签名与上轮相同 → 稳定 → 发起
    autoFireWritingGenImages() // tick3：job key 已存在 → 幂等跳过
    await flush()
    expect(calls.length).toBe(1)
  })
})

describe('autoFireWritingGenImages · 稳定判据（守卫②）', () => {
  it('内容第一次出现的这一轮不发起，连续两轮内容不变才发起', async () => {
    useWritingStore.getState().setSections([section('1-a.md', directiveBlock(0))])
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(0)
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(1)
  })

  it('节内容每轮都在变化（AI 还在写）时永不发起——即使指令块本身没变', async () => {
    // 只有块后面追加的正文在变，指令块原文（raw）逐字相同：这恰恰是 I-2 要堵住的洞——
    // 若签名只看指令块自身或用 mtimeMs:length 这种粗粒度量度，会在文件其实还在被写的
    // 这一帧上把它当"稳定"。签名基于整节内容的哈希，节里任何字符变化都会让签名不同。
    useWritingStore.getState().setSections([section('1-a.md', directiveBlock(0) + '\n\n变化1')])
    autoFireWritingGenImages()
    useWritingStore.getState().setSections([section('1-a.md', directiveBlock(0) + '\n\n变化2')])
    autoFireWritingGenImages()
    useWritingStore.getState().setSections([section('1-a.md', directiveBlock(0) + '\n\n变化3')])
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(0)
  })
})

describe('autoFireWritingGenImages · 自动发起上限（守卫④）', () => {
  it('单节指令块数超过桌面端默认上限时只发起 MAX_AUTO_FIRE_PER_WRITING_PROJECT 条', async () => {
    const md = Array.from({ length: 6 }, (_, i) => directiveBlock(i)).join('\n\n')
    useWritingStore.getState().setSections([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(MAX_AUTO_FIRE_PER_WRITING_PROJECT)
  })

  it('M-4：契约 image_count 能收紧上限', async () => {
    useWritingStore
      .getState()
      .applyScan({ genre: 'workplace', outlineTotal: null, imageStyle: null, imageCount: 2 })
    const md = Array.from({ length: 4 }, (_, i) => directiveBlock(i)).join('\n\n')
    useWritingStore.getState().setSections([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(2)
  })

  it('M-4：契约 image_count 超过桌面端硬上限时被夹住，不会放宽', async () => {
    useWritingStore
      .getState()
      .applyScan({ genre: 'workplace', outlineTotal: null, imageStyle: null, imageCount: 100 })
    const md = Array.from({ length: 6 }, (_, i) => directiveBlock(i)).join('\n\n')
    useWritingStore.getState().setSections([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(MAX_AUTO_FIRE_PER_WRITING_PROJECT)
  })
})

describe('autoFireWritingGenImages · M-3 孤儿 job 键清理', () => {
  it('节已改名/删除后，指向它的旧 job 键会被清掉，不再占配额', () => {
    // 手工种一个"幽灵"键：格式对齐 genImageDirectiveKey(sectionName, raw, occurrence)，
    // 但 sectionName（ghost.md）不在当前 sections 里——模拟节被改名/删除后的残留。
    useWritingStore.getState().setGenImageJob('ghost.md#0#abc123', { status: 'pending' })
    useWritingStore.getState().setSections([section('1-a.md', '正文，没有指令块')])
    autoFireWritingGenImages()
    expect(useWritingStore.getState().genImageJobs['ghost.md#0#abc123']).toBeUndefined()
  })
})

describe('autoFireWritingGenImages · stillTargetable 守卫', () => {
  it('生图 IPC 返回前项目被切走：不写审阅卡，不留孤儿状态', async () => {
    useWritingStore.getState().setSections([section('1-a.md', directiveBlock(0))])
    autoFireWritingGenImages()
    autoFireWritingGenImages() // 稳定 → 发起，此刻 IPC 还没 resolve（mock 是 async 函数，
    // 第一个 await 之前的同步部分已经跑完并把 job 登记成 pending，但 promise 本身还没兑现）
    useWritingStore.getState().setSource({ kind: 'project', projectDir: '/other' })
    await flush()
    expect(useWritingStore.getState().imageReviews).toEqual([])
  })
})
