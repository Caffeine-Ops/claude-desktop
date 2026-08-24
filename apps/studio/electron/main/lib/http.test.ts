import { describe, expect, test } from 'bun:test'
import { API_TIMEOUT_MS, HttpTimeoutError, fetchWithTimeout } from './http'

/**
 * 覆盖「网络请求必须有死线」这条防线。
 *
 * 背景：主进程里 230 处 fetch 只有 7 处设了超时，首启组件下载那处一旦卡住，
 * 用户看到的是全屏门永远转圈——没有错误、没有重试入口。这里锁住三件事：
 *   1. 成功路径行为不变（这是「补缺陷」不是「改行为」）；
 *   2. 死线覆盖到 body 读完，而不是只到响应头（半开连接是真实场景）；
 *   3. 调用方自己的 signal 不被吞掉，且取消不会被误报成超时。
 */

/** 永不 resolve 的 fetch：模拟连接卡死在 0 B/s。 */
const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject((init.signal as AbortSignal).reason)
    })
  })) as unknown as typeof fetch

describe('fetchWithTimeout', () => {
  test('成功路径：原样透传 Response，不干扰调用方', async () => {
    const fake = (async () => new Response('{"ok":true}', { status: 200 })) as unknown as typeof fetch
    const res = await fetchWithTimeout('https://x/api', undefined, { fetchImpl: fake })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('连接卡死：抛 HttpTimeoutError，消息是中文人话而非 "The operation was aborted"', async () => {
    const p = fetchWithTimeout('https://x/api', undefined, { timeoutMs: 10, fetchImpl: hangingFetch })
    await expect(p).rejects.toThrow(HttpTimeoutError)
    const err = await p.catch((e: unknown) => e as HttpTimeoutError)
    expect(err.message).toContain('超时')
    expect(err.message).toContain('https://x/api')
    expect(err.timeoutMs).toBe(10)
  })

  test('半开连接：响应头已到手但 body 读不动，死线依然生效', async () => {
    // 这是 kbSync 里那版 fetchWithTimeout 兜不住的场景——它在拿到 Response
    // 后就 clearTimeout 了，body 卡住便再无人看管。
    const stalled = ((_url: string, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(_c) {
              // 永远不 enqueue、不 close：headers 发了，body 装死。
              init?.signal?.addEventListener('abort', () => {
                _c.error((init.signal as AbortSignal).reason)
              })
            }
          }),
          { status: 200 }
        )
      )) as unknown as typeof fetch

    const res = await fetchWithTimeout('https://x/slow', undefined, { timeoutMs: 20, fetchImpl: stalled })
    expect(res.status).toBe(200) // 响应头正常到手
    await expect(res.text()).rejects.toThrow(HttpTimeoutError) // 读 body 时死线兜住
  })

  test('调用方自己的 signal 仍然生效，且取消不被误报成超时', async () => {
    const ctrl = new AbortController()
    const p = fetchWithTimeout('https://x/api', { signal: ctrl.signal }, {
      timeoutMs: 60_000,
      fetchImpl: hangingFetch
    })
    ctrl.abort(new Error('用户取消'))
    await expect(p).rejects.toThrow('用户取消')
    // 关键：不能因为包了一层就把用户主动取消说成「超时」
    await expect(p).rejects.not.toThrow(HttpTimeoutError)
  })

  test('fetchImpl 确实被使用（不会偷偷换回全局 fetch，代理行为不能被改掉）', async () => {
    let seenUrl = ''
    const spy = (async (u: string) => {
      seenUrl = u
      return new Response('ok')
    }) as unknown as typeof fetch
    await fetchWithTimeout('https://custom/impl', undefined, { fetchImpl: spy })
    expect(seenUrl).toBe('https://custom/impl')
  })

  test('init 里的其它字段原样透传', async () => {
    let seen: RequestInit | undefined
    const spy = (async (_u: string, init?: RequestInit) => {
      seen = init
      return new Response('ok')
    }) as unknown as typeof fetch
    await fetchWithTimeout('https://x/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}'
    }, { fetchImpl: spy })
    expect(seen?.method).toBe('POST')
    expect(seen?.body).toBe('{"a":1}')
    expect((seen?.headers as Record<string, string>)['content-type']).toBe('application/json')
  })

  test('默认档位存在且量级合理（防手滑把 15s 写成 15ms）', () => {
    expect(API_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
    expect(API_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })
})
