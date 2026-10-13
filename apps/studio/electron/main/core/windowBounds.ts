/**
 * 窗口大小 / 位置的恢复逻辑——把「上次关掉时窗口在哪」读回来之后，算出
 * 这次该用什么尺寸位置开。
 *
 * 为什么需要这么一层，而不是把存的值直接塞给 BrowserWindow
 * -------------------------------------------------------
 * **存出去再读回来的那一刻，外部世界已经变了**：显示器可能被拔了、分辨率
 * 可能调小了、`settings.json` 可能被手改坏了。其中最要命的是「窗口整个落
 * 在可见区域之外」——用户抓不到标题栏，应用看起来就是**打不开**，而且他
 * 完全不会想到是窗口跑到不存在的那块屏上去了。
 *
 * 所以读回的值一律当不可信输入：形状不对、数值不是有限数、尺寸不合法，
 * 一概退回默认。这一步**绝不能抛异常**——它跑在窗口创建的路径上，抛了
 * 应用连界面都出不来。
 *
 * 零 electron 依赖（同 appSettingsNormalize 的纪律）：显示器信息由调用方
 * 传进来，所以这个模块能在 bun test 里跑。
 */

/** 一块显示器的**可用**区域。调用方传 `screen` 的 `workArea` 而不是
 *  `bounds`——workArea 已经扣掉菜单栏和 Dock，窗口不该压在它们下面。 */
export interface DisplayArea {
  x: number
  y: number
  width: number
  height: number
}

/** 落盘的形状（见 appSettingsNormalize 的 AppSettings.windowBounds）。 */
export interface SavedWindowBounds {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

/** 交给 BrowserWindow 的结果。`x`/`y` 省略 = 不指定位置，由 Electron 居中。 */
export interface ResolvedWindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface WindowDefaults {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

/** 有限实数才算数：NaN / Infinity 都会让后面的夹取算出更离谱的值。 */
function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * 形状校验。任一字段不合法就整体作废——半套坐标比没有更危险。
 *
 * 导出给 appSettingsNormalize 复用：读盘归一化和这里的夹取用**同一把尺子**，
 * 否则会出现「normalize 放行、resolve 又判死」的两头不一致。
 */
export function normalizeSavedWindowBounds(raw: unknown): SavedWindowBounds | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!finite(r.x) || !finite(r.y)) return null
  if (!finite(r.width) || !finite(r.height)) return null
  if (r.width <= 0 || r.height <= 0) return null
  return {
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
    maximized: r.maximized === true
  }
}

/** 两个矩形的相交面积；不相交为 0。 */
function overlapArea(a: SavedWindowBounds, d: DisplayArea): number {
  const w = Math.min(a.x + a.width, d.x + d.width) - Math.max(a.x, d.x)
  const h = Math.min(a.y + a.height, d.y + d.height) - Math.max(a.y, d.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * 算出这次该用的窗口尺寸位置。
 *
 * 位置的处理分三档：
 *   - 与某块屏有重叠 → 夹进**重叠最多**的那块屏（而不是无脑夹进主屏：
 *     双屏用户上次在副屏，拽回主屏对他就是「记忆没生效」）
 *   - 与所有屏都没重叠（显示器被拔了）→ **丢掉位置**，让 Electron 居中；
 *     尺寸仍然保留，没理由连大小一起忘掉
 *   - 没有合法保存值 → 默认尺寸 + 居中
 */
export function resolveWindowBounds(
  saved: SavedWindowBounds | undefined,
  displays: readonly DisplayArea[],
  defaults: WindowDefaults
): ResolvedWindowBounds {
  const s = normalizeSavedWindowBounds(saved)
  if (!s) {
    return { width: defaults.width, height: defaults.height, maximized: false }
  }

  // 尺寸先摆正到窗口自己的下限。Electron 也会拒绝过小的值，但那时窗口已经
  // 在创建中了，这里先改好更可控。
  let width = Math.max(s.width, defaults.minWidth)
  let height = Math.max(s.height, defaults.minHeight)

  const target = displays.reduce<{ d: DisplayArea; area: number } | null>((best, d) => {
    const area = overlapArea({ ...s, width, height }, d)
    return area > 0 && (!best || area > best.area) ? { d, area } : best
  }, null)

  // 没有一块屏跟它有交集（典型：上次在副屏，这次副屏拔了）——位置作废。
  if (!target) return { width, height, maximized: s.maximized }

  const d = target.d
  // 窗口比那块屏还大时先缩到屏幕大小，否则下面夹取会算出负坐标
  // （x 的上界 d.x + d.width - width 会小于 d.x）。
  width = Math.min(width, d.width)
  height = Math.min(height, d.height)

  const x = Math.min(Math.max(s.x, d.x), d.x + d.width - width)
  const y = Math.min(Math.max(s.y, d.y), d.y + d.height - height)

  return { x, y, width, height, maximized: s.maximized }
}
