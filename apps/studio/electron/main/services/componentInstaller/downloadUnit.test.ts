import { describe, expect, test } from 'bun:test'
import { downloadWithMirrors, type SingleUrlDownloader } from './downloadUnit'

const noopSignal = new AbortController().signal

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
})
