import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test'
import {
  normalizeBaseUrl,
  buildModelList,
  generateImage,
  editImage,
  sniffImageExt,
  __setSleepForTest
} from './imageGenService'

const CFG = { apiKey: 'k', baseURL: 'https://gw.example.com', model: 'gpt-image-2' }

// 重试退避真等会让 502 用例慢 4.5~13.5 秒；测试里换成记录调用、立即 resolve。
let sleepCalls: number[] = []
beforeEach(() => {
  sleepCalls = []
  __setSleepForTest(async (ms) => {
    sleepCalls.push(ms)
  })
})

describe('normalizeBaseUrl', () => {
  it('域名补 /v1', () => {
    expect(normalizeBaseUrl('https://gw.example.com')).toBe('https://gw.example.com/v1')
  })
  it('已有 /v1 原样', () => {
    expect(normalizeBaseUrl('https://gw.example.com/v1/')).toBe('https://gw.example.com/v1')
  })
})

describe('buildModelList', () => {
  it('起始模型置顶 + 默认降级序列去重', () => {
    expect(buildModelList('gpt-image-2')).toEqual(['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1'])
  })
})

const okJson = (b64: string) =>
  new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200 })
const err502 = () => new Response('upstream', { status: 502 })

afterEach(() => {
  ;(globalThis.fetch as unknown) = undefined
})

describe('generateImage', () => {
  it('200 直接返回 b64 解码后的 Buffer', async () => {
    const b64 = Buffer.from('PNGDATA').toString('base64')
    globalThis.fetch = mock(async () => okJson(b64)) as unknown as typeof fetch
    const buf = await generateImage(CFG, { prompt: '一只鸭子' })
    expect(buf.toString()).toBe('PNGDATA')
  })

  it('首模型 502 → 降级到下一模型成功', async () => {
    const b64 = Buffer.from('OK').toString('base64')
    let n = 0
    globalThis.fetch = mock(async () => {
      n += 1
      // 第一模型 3 次都 502（MAX_ATTEMPTS_PER_MODEL），第二模型成功
      return n <= 3 ? err502() : okJson(b64)
    }) as unknown as typeof fetch
    const buf = await generateImage(CFG, { prompt: 'x' })
    expect(buf.toString()).toBe('OK')
  })

  it('所有模型都 5x → 抛错', async () => {
    globalThis.fetch = mock(async () => err502()) as unknown as typeof fetch
    await expect(generateImage(CFG, { prompt: 'x' })).rejects.toThrow(/都失败|5\d\d|failed/i)
  })

  it('5xx 重试间有线性退避（1.5s、3s——draw.js 原版语义，移植时曾丢失）', async () => {
    const b64 = Buffer.from('OK').toString('base64')
    let n = 0
    globalThis.fetch = mock(async () => {
      n += 1
      return n <= 2 ? err502() : okJson(b64)
    }) as unknown as typeof fetch
    await generateImage(CFG, { prompt: 'x' })
    expect(sleepCalls).toEqual([1500, 3000])
  })

  it('401 认证错 → 立即中止整条降级链（只发 1 个请求，不换模型重试）', async () => {
    let n = 0
    globalThis.fetch = mock(async () => {
      n += 1
      return new Response('unauthorized', { status: 401 })
    }) as unknown as typeof fetch
    await expect(generateImage(CFG, { prompt: 'x' })).rejects.toThrow(/认证失败/)
    expect(n).toBe(1)
    expect(sleepCalls).toEqual([])
  })

  it('400（如提示词违规）不重试但仍降级换模型（模型相关错误，与 401 区别对待）', async () => {
    const b64 = Buffer.from('OK').toString('base64')
    let n = 0
    globalThis.fetch = mock(async () => {
      n += 1
      return n === 1 ? new Response('bad prompt', { status: 400 }) : okJson(b64)
    }) as unknown as typeof fetch
    const buf = await generateImage(CFG, { prompt: 'x' })
    expect(buf.toString()).toBe('OK')
    expect(n).toBe(2)
  })
})

describe('sniffImageExt', () => {
  it('按魔数识别 png/jpg/gif/webp，未知返回 null', () => {
    expect(sniffImageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png')
    expect(sniffImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    expect(sniffImageExt(Buffer.from('GIF89a'))).toBe('gif')
    expect(sniffImageExt(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('webp')
    expect(sniffImageExt(Buffer.from('not an image'))).toBe(null)
    expect(sniffImageExt(Buffer.alloc(0))).toBe(null)
  })
})

describe('editImage', () => {
  it('走 multipart，200 返回 Buffer', async () => {
    const b64 = Buffer.from('EDITED').toString('base64')
    let sawMultipart = false
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      sawMultipart = init.body instanceof FormData
      return okJson(b64)
    }) as unknown as typeof fetch
    const buf = await editImage(CFG, {
      prompt: '换白底',
      sourceBytes: Buffer.from('SRC'),
      sourceMime: 'image/png'
    })
    expect(sawMultipart).toBe(true)
    expect(buf.toString()).toBe('EDITED')
  })

  it('multipart 文件名扩展名跟随 sourceMime（jpeg 源图 → source.jpg，不再硬编码 source.png）', async () => {
    const b64 = Buffer.from('EDITED').toString('base64')
    let fileName = ''
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData
      const file = form.get('image') as File
      fileName = file.name
      return okJson(b64)
    }) as unknown as typeof fetch
    await editImage(CFG, {
      prompt: '换白底',
      sourceBytes: Buffer.from('SRC'),
      sourceMime: 'image/jpeg'
    })
    expect(fileName).toBe('source.jpg')
  })
})
