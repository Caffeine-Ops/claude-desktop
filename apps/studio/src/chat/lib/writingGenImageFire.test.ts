import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { WritingSection } from '@desktop-shared/writing'
import { parseGenImageDirectives, genImageDirectiveKey } from '@desktop-shared/proposalGenImage'
import {
  buildWritingGenImagePrompt,
  autoFireWritingGenImages,
  resetWritingGenImageAutoFireState,
  MAX_AUTO_FIRE_PER_WRITING_PROJECT
} from './writingGenImageFire'
import { useWritingStore, shouldSeedProject } from '../stores/writing'

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
// 因此假绿（断言通过但根本没测到东西）；只要 mock 本身被调用过就一定等得到。
//
// m-6 修复：用 `Promise.allSettled` 而不是 `Promise.all`——后者一旦其中一个 promise
// reject 就会立刻抛出，让 `flush()` 本身失败，断言根本跑不到，错误堆栈也会指向
// flush 而不是真正想验的东西。失败路径用例（下面"失败路径"那条）就是靠这个改动才能
// 正常工作。
let pending: Promise<unknown>[]
// 控制 mock 是否本轮走失败分支：只有"失败路径"那条用例会置 true。
let shouldFail: boolean

/** 等目前为止已发起的全部 IPC 调用 settle（无论成功失败），再多等一轮微任务让它们
 *  各自的 then/catch 续体（addImageReview/setGenImageJob 等）跑完。 */
async function flush(): Promise<void> {
  await Promise.allSettled(pending)
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  calls = []
  pending = []
  shouldFail = false
  // window 在裸 bun 运行时不存在，需要自己搭一个最小桩——只有出图触发器用到的
  // chatApi.writingImageGenerate 这一个方法。
  ;(globalThis as { window?: unknown }).window = {
    chatApi: {
      writingImageGenerate: (args: { projectDir: string; prompt: string }) => {
        if (shouldFail) {
          const p = Promise.reject(new Error('未配置出图 API，请到设置里填写 key 与地址'))
          pending.push(p)
          return p
        }
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

describe('autoFireWritingGenImages · m-5 孤儿判据升级：节还在但指令内容变了', () => {
  it('反复调同一张图的构图描述不会让旧 key 永久累积、吃满配额', async () => {
    // 模拟"再暗一点""换成俯视角"……反复改写同一个 genimage 块 5 次：每次内容变
    // （raw 变 → 哈希变 → key 变）。M-3 原版的孤儿判据只看"节名还在不在"——节
    // （1-a.md）全程都在，旧版本的 key 永远清不掉，5 版之后表里堆 5 条陈旧记录，
    // MAX_AUTO_FIRE_PER_WRITING_PROJECT 配额被这些"已经不对应任何当前正文"的
    // 记录吃满。m-5 把判据换成"这个 key 在当前正文里还找不找得到"之后，每一版
    // 定稿都会把上一版的陈旧 key 清掉，表应该始终只有 1 条。
    for (let i = 0; i < 5; i++) {
      useWritingStore.getState().setSections([
        section('1-a.md', directiveBlock(i)),
        section('2-b.md', '正文，暂时没有指令块')
      ])
      autoFireWritingGenImages()
      autoFireWritingGenImages()
      await flush()
    }
    // 5 次修订都合法地各发起了一次生图——每次都是真正的新构图请求，发起本身没错，
    // 错的是"发起完之后旧记录赖着不走"。
    expect(calls.length).toBe(5)
    // 表里此刻应该只剩最后一版的 key，前 4 版的陈旧记录都该被清掉。
    expect(Object.keys(useWritingStore.getState().genImageJobs).length).toBe(1)

    // 关键验证：另一节（2-b.md）此刻才第一次冒出一个全新指令块——如果前面 4 版
    // 陈旧记录没被清掉，此刻 fired 计数会被那些跟当前正文毫无关系的旧记录撑到
    // 上限，这条真正的新指令会被上限静默拦住、用户毫无察觉。
    useWritingStore.getState().setSections([
      section('1-a.md', directiveBlock(4)),
      section('2-b.md', directiveBlock(99))
    ])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(6)
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

describe("autoFireWritingGenImages · C-1' 回归：切到另一个写作项目再切回", () => {
  it('A 首次打开(旧稿子) → 切到 B → 切回 A → 两轮 autoFire 不应重新发起', async () => {
    const A = { kind: 'project' as const, projectDir: PROJECT_DIR }
    const B = { kind: 'project' as const, projectDir: '/proj-b' }
    const md = directiveBlock(0)

    // A 首次打开：模拟"这是一份已经写了一半、带着旧指令块的稿子"——
    // useWritingPoll 首次成功读取时会调用 shouldSeedProject 决定要不要补种。
    useWritingStore.getState().setSource(A)
    useWritingStore.getState().setSections([section('1-a.md', md)])
    expect(shouldSeedProject(A)).toBe(true) // 第一次打开 A，应该 seed
    useWritingStore.getState().seedManualGenImageJobs([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(0) // seed 生效：manual 态不会被自动发起，正确

    // 切到另一个写作项目 B（真的换了项目，A 的 job 表被清空——这本身是对的，
    // 避免 B 的 job 键跟 A 撞同名节）。
    useWritingStore.getState().setSource(B)
    useWritingStore.getState().setSections([])

    // 切回 A：C-1' 的核心断言——`shouldSeedProject(A)` 这次必须重新返回 true。
    // 修复前，`seededProjects` 是 `useWritingPoll` 内部的组件 ref，`setSource`
    // 物理上碰不到它，A 会一直"以为自己已经 seed 过"、返回 false，没人再补种；
    // 表空了、稳定判据走完两轮后就会把这个旧指令块当"从没见过"重新发起。
    useWritingStore.getState().setSource(A)
    expect(shouldSeedProject(A)).toBe(true)
    useWritingStore.getState().setSections([section('1-a.md', md)])
    useWritingStore.getState().seedManualGenImageJobs([section('1-a.md', md)])

    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(0)
  })
})

describe('fireWritingGenImage · 失败路径', () => {
  it('IPC 失败时 job 置 failed，错误文案保留"未配置"字样（卡片据此显示"去设置"按钮）', async () => {
    shouldFail = true
    const md = directiveBlock(0)
    useWritingStore.getState().setSections([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()

    const [d] = parseGenImageDirectives(md)
    const key = genImageDirectiveKey('1-a.md', d.raw, d.occurrence)
    const job = useWritingStore.getState().genImageJobs[key]
    expect(job?.status).toBe('failed')
    // friendlyImageError 对含"未配置"字样的错误有专门文案（"尚未配置出图 API……"），
    // 卡片正是靠错误文案里还有没有"未配置"决定要不要显示"去设置"按钮。
    expect(job?.error).toContain('未配置')
  })
})
