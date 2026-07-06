import { describe, it, expect } from 'bun:test'
import { normalizeImageApi } from './appSettingsNormalize'

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
