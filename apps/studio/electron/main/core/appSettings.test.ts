import { describe, it, expect } from 'bun:test'
import { normalize, normalizeImageApi } from './appSettingsNormalize'

describe('normalizeImageApi', () => {
  it('三字段齐全 → 原样', () => {
    expect(normalizeImageApi({ apiKey: 'k', baseURL: 'https://x', model: 'gpt-image-2' })).toEqual({
      apiKey: 'k',
      baseURL: 'https://x',
      model: 'gpt-image-2'
    })
  })
  it('model 缺省 → 填默认 gpt-image-2', () => {
    expect(normalizeImageApi({ apiKey: 'k', baseURL: 'https://x' })?.model).toBe('gpt-image-2')
  })
  it('非对象 → undefined', () => {
    expect(normalizeImageApi(null)).toBeUndefined()
    expect(normalizeImageApi('x')).toBeUndefined()
  })
  it('apiKey 非字符串 → undefined（视为未配置）', () => {
    expect(normalizeImageApi({ apiKey: 42, baseURL: 'https://x' })).toBeUndefined()
  })
})

describe('normalize — windowBounds（窗口大小位置记忆）', () => {
  const good = { x: 100, y: 100, width: 1400, height: 900, maximized: false }

  it('合法的窗口状态能存住', () => {
    // normalize 是**白名单式**的——不认识的键一律丢掉。所以新加字段必须在
    // 这里有分支，否则「存了但读不回来」，而且全程无报错。
    expect(normalize({ windowBounds: good } as never).windowBounds).toEqual(good)
  })

  it('maximized 为 true 时一并存住', () => {
    expect(
      normalize({ windowBounds: { ...good, maximized: true } } as never).windowBounds?.maximized
    ).toBe(true)
  })

  it('坏值整条丢掉，不污染其它设置', () => {
    // 半套坐标比没有更危险（会被当成合法值去夹取），所以一条坏就整条作废。
    const out = normalize({ cliBackend: 'system', windowBounds: { width: 1400 } } as never)
    expect(out.windowBounds).toBeUndefined()
    expect(out.cliBackend).toBe('system')
  })

  it('没有这个字段时不会凭空造一个出来', () => {
    expect(normalize({ cliBackend: 'bundled' }).windowBounds).toBeUndefined()
  })
})
