import { describe, expect, test } from 'bun:test'

import { createImageDataUrlCache, imageCacheKey } from './imageDataUrlCache'

const file = (path: string, mtimeMs = 1, size = 10) => ({ path, mtimeMs, size })

describe('imageCacheKey', () => {
  test('键 = 路径 + mtime + size：同路径覆盖重生成后不命中旧缓存', () => {
    expect(imageCacheKey(file('/a.png', 1, 10))).not.toBe(imageCacheKey(file('/a.png', 2, 10)))
    expect(imageCacheKey(file('/a.png', 1, 10))).toBe(imageCacheKey(file('/a.png', 1, 10)))
  })
})

describe('createImageDataUrlCache.readFull', () => {
  test('同一 key 的并发读只发一次 IPC，结果共享', async () => {
    let calls = 0
    const cache = createImageDataUrlCache({
      readFull: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 5))
        return 'data:full'
      },
      readThumbs: async () => ({})
    })
    const f = file('/a.png')
    const [a, b] = await Promise.all([cache.readFull(f), cache.readFull(f)])
    expect(a).toBe('data:full')
    expect(b).toBe('data:full')
    expect(calls).toBe(1)
    // 已缓存：第三次读同步命中，不再发 IPC
    expect(cache.peekFull(f)).toBe('data:full')
    await cache.readFull(f)
    expect(calls).toBe(1)
  })

  test('读失败不缓存，下次还会再试', async () => {
    let calls = 0
    const cache = createImageDataUrlCache({
      readFull: async () => {
        calls++
        return calls === 1 ? null : 'data:ok'
      },
      readThumbs: async () => ({})
    })
    const f = file('/a.png')
    expect(await cache.readFull(f)).toBeNull()
    expect(await cache.readFull(f)).toBe('data:ok')
    expect(calls).toBe(2)
  })

  test('全分辨率缓存按总字节 FIFO 淘汰', async () => {
    const cache = createImageDataUrlCache({
      readFull: async (path) => 'x'.repeat(path.endsWith('big.png') ? 80 : 30),
      readThumbs: async () => ({}),
      fullBytesCap: 100
    })
    const a = file('/a.png'), b = file('/b.png'), big = file('/big.png')
    await cache.readFull(a) // 30
    await cache.readFull(b) // 60
    await cache.readFull(big) // 140 > 100 → 先踢 a（30），再踢 b（30）→ 80
    expect(cache.peekFull(a)).toBeUndefined()
    expect(cache.peekFull(b)).toBeUndefined()
    expect(cache.peekFull(big)).toBeDefined()
  })
})

describe('createImageDataUrlCache.ensureThumbs', () => {
  test('只拉缓存里没有的，按批上限分批，结果按 key 入缓存', async () => {
    const batches: string[][] = []
    const cache = createImageDataUrlCache({
      readFull: async () => null,
      readThumbs: async (paths) => {
        batches.push([...paths])
        return Object.fromEntries(paths.map((p) => [p, `thumb:${p}`]))
      },
      thumbBatch: 2
    })
    const files = [file('/1.png'), file('/2.png'), file('/3.png')]
    await cache.ensureThumbs(files)
    expect(batches).toEqual([['/1.png', '/2.png'], ['/3.png']])
    expect(cache.peekThumb(files[2])).toBe('thumb:/3.png')
    // 再来一次：全部命中，不发请求
    await cache.ensureThumbs(files)
    expect(batches.length).toBe(2)
  })

  test('读不出的路径缺席时不入缓存、不报错', async () => {
    const cache = createImageDataUrlCache({
      readFull: async () => null,
      readThumbs: async () => ({})
    })
    const f = file('/broken.png')
    await cache.ensureThumbs([f])
    expect(cache.peekThumb(f)).toBeUndefined()
  })
})

describe('注入的读取函数同步抛错', () => {
  test('readFull / readThumbs 同步 throw 也当失败处理，不向外抛', async () => {
    const cache = createImageDataUrlCache({
      readFull: () => {
        throw new TypeError('not a function')
      },
      readThumbs: () => {
        throw new TypeError('not a function')
      }
    })
    const f = file('/a.png')
    expect(await cache.readFull(f)).toBeNull()
    await cache.ensureThumbs([f])
    expect(cache.peekThumb(f)).toBeUndefined()
  })
})
