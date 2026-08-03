import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { WritingSection } from '@desktop-shared/writing'
import { parseGenImageDirectives, genImageDirectiveKey } from '@desktop-shared/proposalGenImage'
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
// m-3 修复：收集每次 mock IPC 调用返回的 promise，flush() 直接 await 它们本身，而不是
// 盲猜"两轮 setTimeout(0) 够不够"。fireWritingGenImage 未来若多一个 await，固定次数的
// setTimeout 链会在"还没跑完"时就放行断言，calls.length 还是 0，上限/幂等那几条用例会
// 因此假绿（断言通过但根本没测到东西）；Promise.all 只要 mock 本身被调用过就一定等得到。
let pending: Promise<unknown>[]

/** 等目前为止已发起的全部 IPC 调用 resolve，再多等一轮微任务让它们各自的
 *  then 续体（addImageReview/setGenImageJob 等）跑完。 */
async function flush(): Promise<void> {
  await Promise.all(pending)
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  calls = []
  pending = []
  // window 在裸 bun 运行时不存在，需要自己搭一个最小桩——只有出图触发器用到的
  // chatApi.writingImageGenerate 这一个方法。
  ;(globalThis as { window?: unknown }).window = {
    chatApi: {
      writingImageGenerate: (args: { projectDir: string; prompt: string }) => {
        calls.push(args)
        const p = Promise.resolve({ path: `${args.projectDir}/images/x.png`, relPath: '../images/x.png' })
        pending.push(p)
        return p
      }
    }
  }
  // 稳定判据的签名表与配额告警去重表是模块级状态，会跨测试用例残留——每个用例开始前清零，
  // 否则前一个用例留下的"已稳定"签名会让下一个用例的第一轮就误判成稳定（同生产代码里
  // useWritingPoll 每次 effect 重启都要调用的理由一致）。
  resetWritingGenImageAutoFireState()
  // m-3 修复：useWritingStore 是跨整个 bun test 进程存活的模块级单例（目前只有本文件
  // 会碰它，但显式重置不依赖这个巧合）。**C-1 修复之后尤其必须显式清**：setSource 现在
  // 对"切回同一个项目"不再清 genImageJobs/imageReviews（那正是 C-1 要的行为），而下面
  // 这行每次都用同一个 PROJECT_DIR——如果不在这里显式清空，连续两个用例之间会共用同一份
  // job 表，前一个用例登记的 pending/done 会让下一个用例的幂等守卫误判"已经发起过"。
  useWritingStore.setState({ genImageJobs: {}, imageReviews: [] })
  useWritingStore.getState().setSource({ kind: 'project', projectDir: PROJECT_DIR })
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
  useWritingStore.setState({
    source: null,
    sessionId: null,
    sections: [],
    genImageJobs: {},
    imageReviews: [],
    imageStyle: null,
    imageCount: null
  })
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
    const md = directiveBlock(0)
    useWritingStore.getState().setSections([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages() // 稳定 → 发起，此刻 IPC 还没 resolve（mock 内部没有真实
    // 延迟，但 await 仍会让 fireWritingGenImage 让出一轮微任务，此刻 promise 还没被
    // "消费"完）
    useWritingStore.getState().setSource({ kind: 'project', projectDir: '/other' })
    await flush()
    expect(useWritingStore.getState().imageReviews).toEqual([])
    // 2026-08 审查 m-2：标题说"不留孤儿状态"，job 表这一半也要断言，不能只看
    // imageReviews。此刻 genImageJobs 因为切到了【真的不同的项目】已经被 setSource
    // 清空，这条断言确认的是 fireWritingGenImage 的完成回调本身没有在 stillTargetable
    // 判定失败之后又把 'done' 重新写回去（若判定失效，这里会重新冒出一条 done 记录）。
    const [d] = parseGenImageDirectives(md)
    const key = genImageDirectiveKey('1-a.md', d.raw, d.occurrence)
    expect(useWritingStore.getState().genImageJobs[key]).toBeUndefined()
  })
})

describe('autoFireWritingGenImages · C-1 回归：切走会话再切回同一项目', () => {
  it('切走再切回不会让已见过的指令块被当成新指令重新发起', async () => {
    // 首次打开：稳定判据走完两轮，正常发起一次。
    useWritingStore.getState().setSections([section('1-a.md', directiveBlock(0))])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(1)

    // 用户切到别的会话看一眼（setSource(null)），再切回同一个项目——两次 setSource
    // 都不该清 genImageJobs/imageReviews（C-1 修复的正是这一条）。sections 会被
    // setSource 清空又靠"轮询"重新填回来，这里手动模拟这个过程。
    useWritingStore.getState().setSource(null)
    useWritingStore.getState().setSource({ kind: 'project', projectDir: PROJECT_DIR })
    useWritingStore.getState().setSections([section('1-a.md', directiveBlock(0))])

    // 再跑两轮（对应轮询恢复后的第 1、2 次 tick）：如果 C-1 没修好，job 表在切回时
    // 已经被清空、这两轮会把同一个指令块当"从没见过"重新发起，calls 会变成 2。
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(1)
  })
})
