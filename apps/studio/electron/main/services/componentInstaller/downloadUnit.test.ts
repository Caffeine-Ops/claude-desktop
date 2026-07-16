import { describe, expect, test } from 'bun:test'
import { downloadWithMirrors, resolveRedirectLocation, type SingleUrlDownloader } from './downloadUnit'

const noopSignal = new AbortController().signal

describe('resolveRedirectLocation（HF 相对重定向修复回归）', () => {
  test('相对路径用 base 解析成绝对（HF 返回 /api/resolve-cache/...）', () => {
    expect(resolveRedirectLocation('/api/resolve-cache/x', 'https://huggingface.co/Xenova/m/resolve/main/config.json'))
      .toBe('https://huggingface.co/api/resolve-cache/x')
  })
  test('本就绝对的地址原样返回（base 忽略）', () => {
    expect(resolveRedirectLocation('https://cdn-lfs.huggingface.co/y', 'https://huggingface.co/a/b'))
      .toBe('https://cdn-lfs.huggingface.co/y')
  })
  test('location 为数组时取第一个', () => {
    expect(resolveRedirectLocation(['/api/x'], 'https://huggingface.co/a')).toBe('https://huggingface.co/api/x')
  })
  test('非法 location 抛错（调用方 catch 转 reject，不崩）', () => {
    expect(() => resolveRedirectLocation('ht!tp://[bad', 'not-a-base')).toThrow()
  })
})

describe('downloadWithMirrors', () => {
  test('第一个地址成功即用，不再试后续', async () => {
    const tried: string[] = []
    const dl: SingleUrlDownloader = async (url) => { tried.push(url) }
    await downloadWithMirrors(['a', 'b'], '/tmp/x', noopSignal, () => {}, dl)
    expect(tried).toEqual(['a'])
  })
  test('第一个失败则回落第二个', async () => {
    const tried: string[] = []
    const dl: SingleUrlDownloader = async (url) => {
      tried.push(url); if (url === 'a') throw new Error('a down')
    }
    await downloadWithMirrors(['a', 'b'], '/tmp/x', noopSignal, () => {}, dl)
    expect(tried).toEqual(['a', 'b'])
  })
  test('全部失败抛错（含最后一个原因）', async () => {
    const dl: SingleUrlDownloader = async (url) => { throw new Error(`${url} down`) }
    await expect(downloadWithMirrors(['a', 'b'], '/tmp/x', noopSignal, () => {}, dl))
      .rejects.toThrow('b down')
  })
  test('signal 已 abort 时不尝试任何下载', async () => {
    const ac = new AbortController(); ac.abort()
    const tried: string[] = []
    const dl: SingleUrlDownloader = async (url) => { tried.push(url) }
    await expect(downloadWithMirrors(['a'], '/tmp/x', ac.signal, () => {}, dl)).rejects.toThrow()
    expect(tried).toEqual([])
  })
  test('换镜像回滚：首镜像已报字节被负增量冲销，净累计=成功镜像字节', async () => {
    const deltas: number[] = []
    const dl: SingleUrlDownloader = async (url, _dest, _sig, onBytes) => {
      if (url === 'a') { onBytes(300); throw new Error('a mid-fail') }
      onBytes(500)
    }
    await downloadWithMirrors(['a', 'b'], '/tmp/x', noopSignal, (n) => deltas.push(n), dl)
    expect(deltas).toContain(-300)
    expect(deltas.reduce((s, n) => s + n, 0)).toBe(500)
  })
  test('全镜像失败：所有已报字节都被回滚，净累计=0', async () => {
    const deltas: number[] = []
    const dl: SingleUrlDownloader = async (_url, _dest, _sig, onBytes) => {
      onBytes(200); throw new Error('down')
    }
    await expect(downloadWithMirrors(['a', 'b'], '/tmp/x', noopSignal, (n) => deltas.push(n), dl)).rejects.toThrow()
    expect(deltas.reduce((s, n) => s + n, 0)).toBe(0)
  })
})
