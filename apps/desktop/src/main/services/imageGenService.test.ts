import { describe, it, expect, mock, afterEach } from 'bun:test'
import {
  normalizeBaseUrl,
  buildModelList,
  generateImage,
  editImage
} from './imageGenService'

const CFG = { apiKey: 'k', baseURL: 'https://gw.example.com', model: 'gpt-image-2' }

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
})
