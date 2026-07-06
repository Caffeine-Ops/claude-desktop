/**
 * 字符级文本 diff（选区改写审阅卡专用）。
 *
 * 「选区即改」的审阅卡要把「原文」与「改写后」并排给用户，但两段整块平铺时用户得肉眼
 * 逐字对比、猜到底改了哪几个字。本模块产出一份分段的 diff，供卡片在【原文块】里给被删片段
 * 打红删除线、在【改写后块】里给新增片段打绿高亮——一眼看出改动。
 *
 * 为什么字符级而不是词级：中文没有天然空格，词级要引分词库、边界不稳收益还差；字符级 LCS
 * 对中文最稳，几十行手写、零依赖。碎片问题（散落的公共「，」「的」把高亮打成一格一格）由
 * cleanupShortEqualities 吸附收口。
 */

export type DiffOp = 'equal' | 'delete' | 'insert'

export interface DiffSegment {
  op: DiffOp
  text: string
}

// O(n·m) 的 LCS DP 表在超长输入上会撑爆内存/卡 UI。字符积超过此上限就退化成
// 整块替换（全删 + 全增）而不是硬算。1.5M ≈ 1200×1200 字符——远超任何真实选区块，
// 又稳在卡顿阈值之下。
const MAX_PRODUCT = 1_500_000

// 长度 < 此值、且【两侧都被改动夹着】的公共片段读起来像雪花（两段改动之间夹一个没上色的
// 孤零「，」）。把它折进相邻改动里，让高亮保持成块。当前=2 → 只折长度为 1 的孤字。
const MIN_EQUAL_RUN = 2

/**
 * 求 before→after 的字符级 diff，返回按出现顺序排好的分段。
 *
 * - equal：两侧都有、原样保留的公共片段
 * - delete：只在 before 里（被删）
 * - insert：只在 after 里（新增）
 *
 * 渲染时：原文块取 equal+delete（delete 打删除线）、改写后块取 equal+insert（insert 打高亮）。
 */
export function diffChars(before: string, after: string): DiffSegment[] {
  if (before === after) return before ? [{ op: 'equal', text: before }] : []
  if (!before) return [{ op: 'insert', text: after }]
  if (!after) return [{ op: 'delete', text: before }]

  // 码点感知：Array.from 按 Unicode 码点切，避免把 emoji/生僻字的代理对劈成半个字符。
  const a = Array.from(before)
  const b = Array.from(after)
  const n = a.length
  const m = b.length

  if (n * m > MAX_PRODUCT) {
    return [
      { op: 'delete', text: before },
      { op: 'insert', text: after }
    ]
  }

  // LCS 长度 DP：dp[i][j] = a[i..]、b[j..] 的最长公共子序列长度。用一维 Int32Array 压平存，
  // 行宽 w=m+1，dp[i*w+j] 即二维的 [i][j]。
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }

  // 回溯成合并好的连续段（相邻同 op 就地拼接，别一字一段）。
  const raw: DiffSegment[] = []
  const push = (op: DiffOp, ch: string): void => {
    const last = raw[raw.length - 1]
    if (last && last.op === op) last.text += ch
    else raw.push({ op, text: ch })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', a[i])
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      // 往删除方向走不比往插入方向差 → 记删除（并列时偏删除，保证确定性）。
      push('delete', a[i])
      i++
    } else {
      push('insert', b[j])
      j++
    }
  }
  while (i < n) {
    push('delete', a[i])
    i++
  }
  while (j < m) {
    push('insert', b[j])
    j++
  }

  return cleanupShortEqualities(raw)
}

/**
 * 折掉「被改动夹着的过短公共片段」。这类孤字在原文块里会是一个没打删除线的岛、在改写后块里
 * 又是一个没上色的岛，读起来像雪花。把它同时当删除+新增（两块都视作「改动」），高亮就连成块。
 * 不动首/尾的公共片段（那是真·未改前后缀，别误伤）。
 */
function cleanupShortEqualities(segs: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = []
  const push = (op: DiffOp, text: string): void => {
    const last = out[out.length - 1]
    if (last && last.op === op) last.text += text
    else out.push({ op, text })
  }
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k]
    const prev = segs[k - 1]
    const next = segs[k + 1]
    const flanked = !!prev && !!next && prev.op !== 'equal' && next.op !== 'equal'
    if (seg.op === 'equal' && flanked && Array.from(seg.text).length < MIN_EQUAL_RUN) {
      push('delete', seg.text)
      push('insert', seg.text)
    } else {
      push(seg.op, seg.text)
    }
  }
  return out
}
