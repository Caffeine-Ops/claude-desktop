import { describe, expect, it } from 'bun:test'

import { resolveWindowBounds, type DisplayArea, type SavedWindowBounds } from './windowBounds'

/**
 * 「上次关掉时窗口多大、在哪」读回来之后，该按什么尺寸位置开。
 *
 * 这个函数存在的全部理由是：**存出去再读回来的那一刻，外部世界已经变了**。
 * 显示器可能被拔了、分辨率可能调小了、settings.json 可能被手改坏了。读回的
 * 值一律当不可信输入校验一遍，坏了就退回默认——主进程在窗口创建这一步崩掉
 * 的话，应用连界面都出不来。
 *
 * 零 electron 依赖（同 appSettingsNormalize 的纪律）：显示器信息由调用方传
 * `screen.getAllDisplays().map(d => d.workArea)` 进来，所以这里能在 bun test
 * 里跑。用 workArea 而不是 bounds——它已经扣掉了菜单栏和 Dock，窗口不该压在
 * 那下面。
 */

/** 窗口自己的约束，取自 tabRegistry 的 createShellWindow。 */
const DEFAULTS = { width: 1280, height: 800, minWidth: 1226, minHeight: 778 }

/** 一块 MacBook 主屏（扣掉菜单栏后的 workArea）。 */
const MAIN: DisplayArea = { x: 0, y: 38, width: 1512, height: 944 }
/** 一块挂在左边的副屏——mac 上副屏在主屏左侧时 x 是**负数**，这是真实形状。 */
const LEFT_SECOND: DisplayArea = { x: -1920, y: 0, width: 1920, height: 1080 }

const saved = (p: Partial<SavedWindowBounds> = {}): SavedWindowBounds => ({
  x: 100,
  y: 100,
  width: 1400,
  height: 900,
  maximized: false,
  ...p
})

describe('resolveWindowBounds — 没有可用的保存值时退回默认', () => {
  it('从没存过 → 默认尺寸，且**不给 x/y**（不给位置时 Electron 自己居中）', () => {
    const r = resolveWindowBounds(undefined, [MAIN], DEFAULTS)
    expect(r.width).toBe(1280)
    expect(r.height).toBe(800)
    expect(r.x).toBeUndefined()
    expect(r.y).toBeUndefined()
    expect(r.maximized).toBe(false)
  })

  it('一块显示器都没报上来（不该发生）→ 不崩；尺寸保留、位置作废回居中', () => {
    // 与下面「副屏被拔了」那条同一个语义：**位置不可用 ≠ 尺寸也不可信**。
    // 尺寸本身是合法的，没理由连它一起丢，只是不知道该把窗口放哪。
    const r = resolveWindowBounds(saved(), [], DEFAULTS)
    expect(r.width).toBe(1400)
    expect(r.height).toBe(900)
    expect(r.x).toBeUndefined()
    expect(r.y).toBeUndefined()
  })
})

describe('resolveWindowBounds — 正常恢复', () => {
  it('保存的窗口完全落在主屏内 → 原样恢复', () => {
    // 尺寸要真的放得下：MAIN 的 workArea 是 y=38 高 944（底边 982），
    // 所以 y=100 时窗口最高只能 882。写 900 的话底边 1000 会越界、被夹到
    // y=82——那是夹取在正确工作，不是 bug（第一版夹具就算错了这一下）。
    const r = resolveWindowBounds(saved({ x: 100, y: 100, width: 1400, height: 800 }), [MAIN], DEFAULTS)
    expect({ x: r.x, y: r.y, width: r.width, height: r.height }).toEqual({
      x: 100,
      y: 100,
      width: 1400,
      height: 800
    })
  })

  it('最大化标志原样透传——两个方向都断言，免得被一个恒定值蒙混过去', () => {
    expect(resolveWindowBounds(saved({ maximized: true }), [MAIN], DEFAULTS).maximized).toBe(true)
    expect(resolveWindowBounds(saved({ maximized: false }), [MAIN], DEFAULTS).maximized).toBe(false)
  })

  it('上次在副屏、这次副屏还在 → 回副屏，别自作主张拽回主屏', () => {
    // 副屏在左边，x 是负的。不认负坐标的实现会把窗口硬拉回主屏——
    // 对双屏用户来说这就是「窗口记忆根本没生效」。
    const r = resolveWindowBounds(
      saved({ x: -1800, y: 100, width: 1400, height: 900 }),
      [MAIN, LEFT_SECOND],
      DEFAULTS
    )
    expect(r.x).toBe(-1800)
    expect(r.y).toBe(100)
  })
})

describe('resolveWindowBounds — 显示器变了', () => {
  it('上次在副屏、这次副屏被拔了 → 窗口会落在屏幕外点不到，必须丢掉位置回居中', () => {
    // 这是本函数最该防住的那条：窗口整个在可见区域之外时，用户根本抓不到
    // 标题栏，应用看起来就是「打不开」。
    const r = resolveWindowBounds(
      saved({ x: -1800, y: 100, width: 1400, height: 900 }),
      [MAIN],
      DEFAULTS
    )
    expect(r.x).toBeUndefined()
    expect(r.y).toBeUndefined()
    // 尺寸仍然保留——只有位置不可用，大小没理由一起丢。
    expect(r.width).toBe(1400)
    expect(r.height).toBe(900)
  })

  it('右边超出屏幕（分辨率调小了）→ 夹回可见区域内', () => {
    // 主屏宽 1512，窗口 x=1400 宽 1400 → 右缘 2800，远超出去。
    const r = resolveWindowBounds(
      saved({ x: 1400, y: 100, width: 1400, height: 900 }),
      [MAIN],
      DEFAULTS
    )
    expect(r.x! + r.width).toBeLessThanOrEqual(MAIN.x + MAIN.width)
    expect(r.x).toBeGreaterThanOrEqual(MAIN.x)
  })

  it('下边超出屏幕 → 夹回可见区域内', () => {
    const r = resolveWindowBounds(
      saved({ x: 100, y: 900, width: 1300, height: 900 }),
      [MAIN],
      DEFAULTS
    )
    expect(r.y! + r.height).toBeLessThanOrEqual(MAIN.y + MAIN.height)
    expect(r.y).toBeGreaterThanOrEqual(MAIN.y)
  })

  it('夹回之后不会压在菜单栏下面（用的是 workArea 不是整块屏幕）', () => {
    // MAIN.y = 38 是菜单栏高度。y 传 0 的话夹取必须把它顶到 38。
    const r = resolveWindowBounds(saved({ x: 100, y: 0, width: 1300, height: 900 }), [MAIN], DEFAULTS)
    expect(r.y).toBeGreaterThanOrEqual(MAIN.y)
  })

  it('窗口比屏幕还大 → 缩到屏幕大小，而不是夹出一个负坐标', () => {
    const r = resolveWindowBounds(
      saved({ x: 0, y: 0, width: 3000, height: 2000 }),
      [MAIN],
      DEFAULTS
    )
    expect(r.width).toBeLessThanOrEqual(MAIN.width)
    expect(r.height).toBeLessThanOrEqual(MAIN.height)
    expect(r.x).toBeGreaterThanOrEqual(MAIN.x)
    expect(r.y).toBeGreaterThanOrEqual(MAIN.y)
  })
})

describe('resolveWindowBounds — 尺寸下限', () => {
  it('存的尺寸比窗口最小尺寸还小 → 提到最小尺寸', () => {
    // 手改 settings.json、或旧版本留下的值都可能是这样。小于 minWidth 的话
    // Electron 自己也会拒绝，但那时已经晚了——这里先摆正。
    const r = resolveWindowBounds(saved({ width: 400, height: 300 }), [MAIN], DEFAULTS)
    expect(r.width).toBe(1226)
    expect(r.height).toBe(778)
  })
})

describe('resolveWindowBounds — 坏数据不能让主进程崩', () => {
  const bad: Array<[string, unknown]> = [
    ['宽高是 NaN', { x: 0, y: 0, width: NaN, height: 800, maximized: false }],
    ['宽高是负数', { x: 0, y: 0, width: -1400, height: -900, maximized: false }],
    ['宽高是 0', { x: 0, y: 0, width: 0, height: 0, maximized: false }],
    ['坐标是 NaN', { x: NaN, y: NaN, width: 1400, height: 900, maximized: false }],
    ['坐标是 Infinity', { x: Infinity, y: 0, width: 1400, height: 900, maximized: false }],
    ['字段缺失', { width: 1400 }],
    ['整个不是对象', 'oops'],
    ['是 null', null]
  ]

  for (const [name, raw] of bad) {
    it(`${name} → 退回默认尺寸且不给位置，不抛异常`, () => {
      const r = resolveWindowBounds(raw as SavedWindowBounds | undefined, [MAIN], DEFAULTS)
      expect(r.width).toBe(1280)
      expect(r.height).toBe(800)
      expect(r.x).toBeUndefined()
      expect(r.y).toBeUndefined()
      expect(r.maximized).toBe(false)
    })
  }
})
