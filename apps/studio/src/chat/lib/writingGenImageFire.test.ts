import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { WritingSection } from '@desktop-shared/writing'
import { parseGenImageDirectives, genImageDirectiveKey } from '@desktop-shared/proposalGenImage'
import {
  buildWritingGenImagePrompt,
  autoFireWritingGenImages,
  resetWritingGenImageAutoFireState,
  isReadSuspiciouslyEmpty,
  MAX_AUTO_FIRE_PER_WRITING_PROJECT
} from './writingGenImageFire'
import { useWritingStore, claimSeedSlot, resetSeededProjectsState } from '../stores/writing'

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
  // 第五轮 n-2 修复：seededProjects（stores/writing.ts 的模块级 Set，claimSeedSlot
  // 读写它）此前没有任何测试入口能清零。全文件曾经只有 C-1' 那一条用例调用
  // claimSeedSlot、且它自己完成了一次「A→B→A」的完整往返把 key 清干净，绿灯纯粹是
  // 用例顺序与调用次数的巧合——再加一条调用它的用例（比如下面 M-1 的回归测试）就可能
  // 让「已 seed」状态跨用例泄漏，产生假绿/假红。每个用例开始前显式清零，同
  // resetWritingGenImageAutoFireState 一套惯例。
  resetSeededProjectsState()
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

describe('autoFireWritingGenImages · 第五轮 M-1 回归：空 sections 那一轮不清孤儿键', () => {
  it('scan.ok 但 sections 读成空数组的这一轮之后，文件正常回来也不会重复发起', async () => {
    // 第 1 步：正常发起一次，模拟稳定判据走完两轮后的真实首次生图。
    useWritingStore.getState().setSections([section('1-a.md', directiveBlock(0))])
    autoFireWritingGenImages() // tick1：记签名，不发起
    autoFireWritingGenImages() // tick2：签名稳定 → 发起
    await flush()
    expect(calls.length).toBe(1)

    // 第 2 步：模拟「scan 成功但 read 阶段 readdirSync(drafts) 抛错」那一帧——
    // sections 被设成空数组，但这条路径不经过 setSource，genImageJobs 与
    // seededProjects 都不受影响（与生产代码 useWritingPoll 的 read.ok 分支
    // 对齐：这一帧仍然会调用 autoFireWritingGenImages，因为「磁盘元信息没变」
    // 的短路分支与「元信息变了但重读失败」都不会跳过它）。
    useWritingStore.getState().setSections([])
    autoFireWritingGenImages()

    // 第 3 步：文件正常回来，内容与第 1 步完全相同——真实场景里网络盘抖动
    // 恢复后重读到的就是同一份正文。跑两轮（对应轮询恢复后的第 1、2 次 tick）。
    useWritingStore.getState().setSections([section('1-a.md', directiveBlock(0))])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()

    // 修复前：空 sections 那一轮的差集清扫会把 genImageJobs 全表键判成孤儿、一次
    // 清空；文件回来后幂等守卫（守卫③）找不到旧记录，会把这条已经生成过的指令块
    // 当成「从没见过的新指令」重新发起——calls.length 会变成 2，等价于重复扣费。
    // 修复后：空 sections 那一轮整体跳过清扫，job 键原样保留，幂等守卫照常拦住
    // 重复发起，calls.length 应该始终是 1。
    expect(calls.length).toBe(1)
    expect(Object.keys(useWritingStore.getState().genImageJobs).length).toBe(1)
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
    // useWritingPoll 首次成功读取时会调用 claimSeedSlot 决定要不要补种。
    useWritingStore.getState().setSource(A)
    useWritingStore.getState().setSections([section('1-a.md', md)])
    expect(claimSeedSlot(A)).toBe(true) // 第一次打开 A，应该 seed
    useWritingStore.getState().seedManualGenImageJobs([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(0) // seed 生效：manual 态不会被自动发起，正确

    // 切到另一个写作项目 B（真的换了项目，A 的 job 表被清空——这本身是对的，
    // 避免 B 的 job 键跟 A 撞同名节）。
    useWritingStore.getState().setSource(B)
    useWritingStore.getState().setSections([])

    // 切回 A：C-1' 的核心断言——`claimSeedSlot(A)` 这次必须重新返回 true。
    // 修复前，`seededProjects` 是 `useWritingPoll` 内部的组件 ref，`setSource`
    // 物理上碰不到它，A 会一直"以为自己已经 seed 过"、返回 false，没人再补种；
    // 表空了、稳定判据走完两轮后就会把这个旧指令块当"从没见过"重新发起。
    useWritingStore.getState().setSource(A)
    expect(claimSeedSlot(A)).toBe(true)
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

// 复审 C-1：WRITING_IMAGE_GENERATE 的契约明写 path=绝对路径（预览用）、
// relPath=`../images/<文件名>`（落位写正文用）。此前 fireWritingGenImage 只解出
// path、把 relPath 整个丢弃，写进 imageReviews 的审阅项没有任何字段能承载它——
// WritingPaper 应用时只能拿 resultPath（绝对路径）落位，项目路径含空格时正文里
// 会留下一行解析不出图片的源码字面量、且不含空格时预览照样正常显示，走查完全
// 抓不到这个 bug。钉住 relPath 确实从 IPC 一路原样流进 imageReviews。
describe('fireWritingGenImage · relPath 落位字段（复审 C-1）', () => {
  it('imageReviews 里的 relPath 与 IPC 契约回的 relPath 一致，且与 resultPath（绝对路径）不同', async () => {
    const md = directiveBlock(0)
    useWritingStore.getState().setSections([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()

    const review = useWritingStore.getState().imageReviews[0]
    expect(review).toBeDefined()
    expect(review.relPath).toBe('../images/x.png')
    // resultPath 恒为绝对路径（mock 里是 `${projectDir}/images/x.png`），relPath 恒为
    // 相对路径——两者形态不同，断言不相等能防止未来有人图省事又把 relPath 改回
    // 从 resultPath 派生（那正是 C-1 的根因）。
    expect(review.resultPath).not.toBe(review.relPath)
  })

  it('项目路径含空格时（C-1 的真实诱因，macOS 常态），relPath 原样流入，不受影响', async () => {
    // 临时替换本文件共享 mock：模拟项目路径与文件名都含空格的场景。
    ;(
      globalThis as {
        window: { chatApi: { writingImageGenerate: (a: { projectDir: string; prompt: string }) => Promise<unknown> } }
      }
    ).window.chatApi.writingImageGenerate = (args: { projectDir: string; prompt: string }) => {
      calls.push(args)
      const p = Promise.resolve({
        path: `${args.projectDir}/我的 项目/images/gen 1.png`,
        relPath: '../images/gen 1.png'
      })
      pending.push(p)
      return p
    }
    const md = directiveBlock(0)
    useWritingStore.getState().setSections([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()

    const review = useWritingStore.getState().imageReviews[0]
    expect(review.relPath).toBe('../images/gen 1.png')
  })
})

// 复审 M-1/M-4：与 genImageJobs 的孤儿键清理完全同构（复用同一份 validKeys）。
describe('autoFireWritingGenImages · imageReviews 孤儿清扫（复审 M-1/M-4）', () => {
  it('AI 在悬而未决期间重写了这一节导致指令块消失后，对应的审阅卡会被自动清掉', async () => {
    const md = directiveBlock(0)
    useWritingStore.getState().setSections([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(useWritingStore.getState().imageReviews.length).toBe(1)

    // AI 把这一节整个重写了，原指令块（连同它的内容）不再存在于当前正文。
    useWritingStore.getState().setSections([section('1-a.md', '全新的正文，不含任何指令块')])
    autoFireWritingGenImages()

    expect(useWritingStore.getState().imageReviews.length).toBe(0)
  })

  it('sections 空读的那一轮不清扫审阅卡（与 job 键共用同一条 M-1 保护，防网络盘抖动误清）', async () => {
    const md = directiveBlock(0)
    useWritingStore.getState().setSections([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(useWritingStore.getState().imageReviews.length).toBe(1)

    // 模拟「scan 成功但 read 阶段读盘瞬时失败」：sections 读成空数组的这一帧不该清扫。
    useWritingStore.getState().setSections([])
    autoFireWritingGenImages()
    expect(useWritingStore.getState().imageReviews.length).toBe(1)
  })

  it('指令块内容还在（尚未被处理）时审阅卡不受任何影响，不会被自己的清扫逻辑误伤', async () => {
    const md = directiveBlock(0)
    useWritingStore.getState().setSections([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(useWritingStore.getState().imageReviews.length).toBe(1)

    // 再跑几轮轮询，内容完全没变——审阅卡应该原样保留。
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(useWritingStore.getState().imageReviews.length).toBe(1)
  })
})

// 终审 #1：`undoLast` 是 WritingDocPanel.tsx 里的 React 回调，本仓库的测试目录
// （electron/、src/chat/lib、src/chat/composer）够不到组件文件，测不了 undoLast 本身。
// 但它依赖的机制——"撤销把指令块写回正文后，必须立刻用 seedManualGenImageJobs 补种
// manual 哨兵，否则稳定判据会把它当新指令重新发起"——是纯 store 操作，可以在这里直接
// 复刻 undoLast 成功分支里新加的那一行调用，验证这个机制本身成立。
describe('终审 #1 回归：应用/丢弃 → 撤销后补种哨兵，不会自动重新出图、再扣一次费', () => {
  it('指令块被应用后消失、孤儿清扫删掉 job 键；撤销把它写回正文时若不补种，会被当新指令重新发起', async () => {
    const md = directiveBlock(0)
    const [d] = parseGenImageDirectives(md)
    const key = genImageDirectiveKey('1-a.md', d.raw, d.occurrence)

    // 第 1 步：正常发起一次，模拟指令块第一次被看到、稳定两轮后自动出图——
    // 对应用户看到审阅卡、点「应用」之前的状态。
    useWritingStore.getState().setSections([section('1-a.md', md)])
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(1)

    // 第 2 步：模拟「应用」成功——WritingPaper.applyGenImageReview 把指令块换成了
    // `![图说](../images/x.png)`，指令块从正文里消失。下一轮轮询的孤儿清扫会把这个
    // 键从 genImageJobs 里删掉，这一步本身是清扫机制的正常动作，不是 bug。
    useWritingStore.getState().setSections([section('1-a.md', '![图说](../images/x.png)')])
    autoFireWritingGenImages()
    expect(useWritingStore.getState().genImageJobs[key]).toBeUndefined()

    // 第 3 步：模拟「撤销」——undoLast 把 pushUndo 存的旧版正文（entry.markdown，仍
    // 带着指令块）重新写盘。指令块原样回到了正文里，但 genImageJobs 表对这个键毫无
    // 记忆（上一步刚清掉）。
    useWritingStore.getState().setSections([section('1-a.md', md)])

    // 【本条回归钉住的行为】undoLast 成功分支里新加的那一行：commitSection 成功后
    // 立刻对 entry.markdown 补种 manual 哨兵。这里直接调用同一个 store 方法
    // （WritingDocPanel.tsx 那一行就是这个调用），验证它确实能挡住重新发起。
    useWritingStore.getState().seedManualGenImageJobs([section('1-a.md', md)])
    expect(useWritingStore.getState().genImageJobs[key]?.status).toBe('manual')

    // 第 4 步：稳定判据走完两轮——如果第 3 步没有补种（旧行为，undoLast 全程不碰
    // genImageJobs），这里会把「重新出现」的指令块当成「从没见过的新指令」再次发起，
    // calls.length 会变成 2，等价于对同一张图重复扣费。
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(1)
  })
})

// 终审 #2：`useWritingPoll` 是 React hook（用到 useEffect/useRef），本仓库没有
// renderHook 一类的测试设施，够不到它本身。但它 tick() 里那句
// `if (!isReadSuspiciouslyEmpty(...) && claimSeedSlot(source)) seedManualGenImageJobs(...)`
// 是纯函数 + 两个已导出的 store 操作的组合，这里逐字复刻同一行验证名额不会被空读消耗。
describe('终审 #2 回归：claimSeedSlot 名额不被一次空读消耗', () => {
  it('scan 非空但 read 读空的这一轮不该领走 seed 名额，文件正常回来后仍能正确补种', async () => {
    const A = { kind: 'project' as const, projectDir: PROJECT_DIR }
    const md = directiveBlock(0)
    useWritingStore.getState().setSource(A)

    // 与 stores/writing.ts tick() 里那一行逐字同构，避免测试自己另造一份可能漂移的判断。
    function maybeSeed(scanFilesCount: number, sections: WritingSection[]): void {
      if (!isReadSuspiciouslyEmpty(scanFilesCount, sections.length) && claimSeedSlot(A)) {
        useWritingStore.getState().seedManualGenImageJobs(sections)
      }
    }

    // tick1：模拟「渲染进程刚启动、用户打开一份已有配图指令的项目，恰好撞上 drafts/
    // 短暂不可读」——scan 看到 1 个文件，但 read 阶段（readdirSync 抖动）读空。
    // 修复前：claimSeedSlot 在这里被无条件领走，名额已耗尽、seed 到的却是空集合。
    // 修复后：可疑空读短路掉 claimSeedSlot 调用，名额留到下一轮。
    maybeSeed(1, [])

    // tick2：文件正常回来，read 读到真实内容——这一节本来就带着一个 genimage 指令块
    // （模拟「已有配图指令的项目被重新打开」这个失败场景的前提）。
    maybeSeed(1, [section('1-a.md', md)])
    useWritingStore.getState().setSections([section('1-a.md', md)])

    const [d] = parseGenImageDirectives(md)
    const key = genImageDirectiveKey('1-a.md', d.raw, d.occurrence)
    // 修复后：名额在 tick2 被正确领到，指令块补种成了 manual 哨兵。
    // 修复前：名额已经在 tick1 被空耗，这里查不到任何记录（undefined）。
    expect(useWritingStore.getState().genImageJobs[key]?.status).toBe('manual')

    // 稳定判据走两轮：manual 哨兵应挡住幂等守卫（守卫③），不会被当成「从没见过的新
    // 指令」重新发起。修复前的行为（没有哨兵）会让这里 calls.length 变成 1——对一个
    // 项目重新打开时本就已经存在的指令块，凭空多生成一次、多扣一次费。
    autoFireWritingGenImages()
    autoFireWritingGenImages()
    await flush()
    expect(calls.length).toBe(0)
  })
})
