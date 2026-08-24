import { describe, expect, test } from 'bun:test'
import { BACKOFF_MS, backoffDelay, checkContentRange, planResume } from './downloadPlan'

/**
 * 断点续传的决策逻辑——worker 本体是子进程脚本（顶层就跑）没法直接单测，
 * 所以把这三段纯计算抽出来单独锁住。它们错了不会报错，只会**静默产出一个
 * 损坏的 49MB 文件**，然后在 sha256 那步以「校验失败」的面目出现——真因被
 * 掩盖，代价是整包白下一遍。
 */

describe('planResume：已有 .part 该怎么办', () => {
  test('没有残留 → 从头下', () => {
    expect(planResume(0, 49_000_000)).toEqual({ action: 'restart' })
  })

  test('字节已齐 → 跳过下载（上次是在校验/解压阶段挂的）', () => {
    expect(planResume(49_000_000, 49_000_000)).toEqual({ action: 'complete' })
  })

  test('比目标还长 → 从头下（换了产物或写坏了，续传只会拼出垃圾）', () => {
    expect(planResume(50_000_000, 49_000_000)).toEqual({ action: 'restart' })
  })

  test('残留 10MB → 回退 1MB 再续，覆盖掉可能的撕裂尾巴', () => {
    // 被杀掉的写流可能留下半个 chunk。直接从 statSync 的长度接着请求会悄悄
    // 产出损坏文件，且只有 sha256 能发现。回退 1MB 是很便宜的保险。
    expect(planResume(10 * 1024 * 1024, 49_000_000)).toEqual({
      action: 'resume',
      offset: 9 * 1024 * 1024
    })
  })

  test('残留不足 1MB → 回退量不能超过已有字节（否则 offset 变负数）', () => {
    expect(planResume(500 * 1024, 49_000_000)).toEqual({ action: 'restart' })
  })

  test('残留正好 1MB → 回退后归零，等价于从头', () => {
    expect(planResume(1024 * 1024, 49_000_000)).toEqual({ action: 'restart' })
  })

  test('目标大小未知（清单没给 size）→ 一律从头，不冒险续传', () => {
    // 没有 total 就无法校验服务器返回的分片是不是我们要的那段，
    // 续传等于闭眼拼接。
    expect(planResume(10 * 1024 * 1024, 0)).toEqual({ action: 'restart' })
  })
})

describe('checkContentRange：服务器给的 206 分片是不是我们要的那段', () => {
  test('完全匹配 → 通过', () => {
    expect(checkContentRange('bytes 1024-4095/4096', 1024, 4096).ok).toBe(true)
  })

  test('起点对不上 → 拒绝（有些中间层会返回 206 却给了另一段）', () => {
    const r = checkContentRange('bytes 2048-4095/4096', 1024, 4096)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('2048')
  })

  test('总长度对不上 → 拒绝（远端换了产物，清单已过期）', () => {
    expect(checkContentRange('bytes 1024-9999/99999', 1024, 4096).ok).toBe(false)
  })

  test('头缺失 → 拒绝，且理由说得出是「缺失」', () => {
    const r = checkContentRange(null, 1024, 4096)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('缺失')
  })

  test('头格式无法解析 → 拒绝而不是当成通过', () => {
    expect(checkContentRange('bytes */4096', 1024, 4096).ok).toBe(false)
  })

  test('大小写与多空格容错（HTTP 头大小写不敏感）', () => {
    expect(checkContentRange('Bytes  1024-4095/4096', 1024, 4096).ok).toBe(true)
  })
})

describe('backoffDelay：退避阶梯', () => {
  test('逐档递增，不是固定间隔', () => {
    const delays = [1, 2, 3, 4, 5].map(backoffDelay)
    expect(delays).toEqual(BACKOFF_MS)
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!)
    }
  })

  test('超出档位数量 → 停在最后一档，不越界拿到 undefined', () => {
    expect(backoffDelay(99)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]!)
  })

  test('attempt 从 1 起算；传 0 或负数也不该崩', () => {
    expect(backoffDelay(0)).toBe(BACKOFF_MS[0]!)
    expect(backoffDelay(-3)).toBe(BACKOFF_MS[0]!)
  })
})
