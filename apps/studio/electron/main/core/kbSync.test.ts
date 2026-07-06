import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { runKbSync } from './kbSync'
import type { KbManifest } from '../../shared/kbManifest'

const sha1 = (s: string | Buffer): string => createHash('sha1').update(s).digest('hex')
const BASE_URL = 'http://kb.test'

let outDir: string, stateDir: string
beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'kb-out-'))
  stateDir = mkdtempSync(join(tmpdir(), 'kb-state-'))
})
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

/** bodies: posixPath → 内容。自动生成 manifest 与逐文件响应的 mock fetch。 */
function fixture(bodies: Record<string, string>): { manifest: KbManifest; fetchImpl: typeof fetch } {
  const manifest: KbManifest = {
    schemaVersion: 1,
    kbId: 'default',
    name: 'kb',
    builtAtMs: 42,
    files: Object.entries(bodies).map(([path, body]) => ({ path, sha1: sha1(body), size: body.length }))
  }
  const routes = new Map<string, string>()
  routes.set(`${BASE_URL}/kb/default/manifest.json`, JSON.stringify(manifest))
  for (const [path, body] of Object.entries(bodies)) {
    routes.set(`${BASE_URL}/kb/default/${path.split('/').map(encodeURIComponent).join('/')}`, body)
  }
  const fetchImpl = (async (url: unknown) => {
    const body = routes.get(String(url))
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(body, { status: 200 })
  }) as typeof fetch
  return { manifest, fetchImpl }
}

const deps = (fetchImpl: typeof fetch) => ({
  outDir,
  stateDir,
  remote: { baseUrl: BASE_URL, kbId: 'default' },
  nowMs: () => 1000,
  fetchImpl
})

describe('runKbSync 首次全量', () => {
  it('拉全量、内容落位、index.json 存在、基准 manifest 写入 stateDir', async () => {
    const { fetchImpl } = fixture({
      '01线/1品/方案.docx.md': '正文A',
      'assets/01线/1品/img-1.png': 'PNG',
      'index.json': '{"v":1}'
    })
    const st = await runKbSync(deps(fetchImpl))
    expect(st.state).toBe('success')
    expect(readFileSync(join(outDir, '01线/1品/方案.docx.md'), 'utf8')).toBe('正文A')
    expect(readFileSync(join(outDir, 'index.json'), 'utf8')).toBe('{"v":1}')
    expect(existsSync(join(stateDir, 'manifest.json'))).toBe(true)
  })
})

describe('runKbSync 增量与删除', () => {
  it('第二轮只动差异：改动重下、消失删除、未变不请求', async () => {
    const v1 = fixture({ '保留.md': '老', '要删.md': 'x', 'index.json': 'i1' })
    await runKbSync(deps(v1.fetchImpl))
    let fileRequests = 0
    const v2 = fixture({ '保留.md': '新', 'index.json': 'i2' })
    const counting = (async (url: unknown) => {
      if (!String(url).endsWith('manifest.json')) fileRequests++
      return v2.fetchImpl(url as never)
    }) as typeof fetch
    const st = await runKbSync(deps(counting))
    expect(st.state).toBe('success')
    expect(readFileSync(join(outDir, '保留.md'), 'utf8')).toBe('新')
    expect(existsSync(join(outDir, '要删.md'))).toBe(false)
    expect(fileRequests).toBe(2) // 保留.md + index.json，「要删.md」零请求
  })
})

describe('runKbSync 部分失败', () => {
  it('单文件 404 → error、index.json 不应用、基准不更新、成功文件留盘', async () => {
    const good = fixture({ '好.md': 'ok', '坏.md': 'bad', 'index.json': 'i1' })
    const broken = (async (url: unknown) => {
      if (String(url).includes(encodeURIComponent('坏.md'))) return new Response('', { status: 404 })
      return good.fetchImpl(url as never)
    }) as typeof fetch
    const st = await runKbSync(deps(broken))
    expect(st.state).toBe('error')
    expect(existsSync(join(outDir, 'index.json'))).toBe(false)
    expect(existsSync(join(stateDir, 'manifest.json'))).toBe(false)
    expect(readFileSync(join(outDir, '好.md'), 'utf8')).toBe('ok')
  })
  it('sha1 不符经重试仍不符 → 计失败，.part 不落位', async () => {
    const f = fixture({ '篡改.md': '真身', 'index.json': 'i' })
    const tampering = (async (url: unknown) => {
      if (String(url).includes(encodeURIComponent('篡改.md'))) return new Response('假货', { status: 200 })
      return f.fetchImpl(url as never)
    }) as typeof fetch
    const st = await runKbSync(deps(tampering))
    expect(st.state).toBe('error')
    expect(existsSync(join(outDir, '篡改.md'))).toBe(false)
  })
})

describe('runKbSync 首次对账（从本地构建切换）', () => {
  it('磁盘同内容文件零重下；多余文件被清', async () => {
    writeFileSync(join(outDir, '已有同内容.md'), '相同')
    writeFileSync(join(outDir, '本地残留.md'), '旧索引产物')
    const f = fixture({ '已有同内容.md': '相同', 'index.json': 'i' })
    let downloads = 0
    const counting = (async (url: unknown) => {
      if (!String(url).endsWith('manifest.json')) downloads++
      return f.fetchImpl(url as never)
    }) as typeof fetch
    const st = await runKbSync(deps(counting))
    expect(st.state).toBe('success')
    expect(downloads).toBe(1) // 只有 index.json
    expect(existsSync(join(outDir, '本地残留.md'))).toBe(false)
  })
})

describe('runKbSync 防线', () => {
  it('kbId 不匹配 → error，不发任何文件请求', async () => {
    const f = fixture({ 'a.md': 'x', 'index.json': 'i' })
    const st = await runKbSync({ ...deps(f.fetchImpl), remote: { baseUrl: BASE_URL, kbId: '别的团队' } })
    expect(st.state).toBe('error')
  })
  it('manifest 损坏 → error，镜像不动', async () => {
    const bad = (async () => new Response('{broken', { status: 200 })) as typeof fetch
    writeFileSync(join(outDir, '现有.md'), '在')
    const st = await runKbSync(deps(bad))
    expect(st.state).toBe('error')
    expect(readFileSync(join(outDir, '现有.md'), 'utf8')).toBe('在')
  })
  it('manifest 非 200 → error，镜像不动（同「manifest 损坏」的写盘前置断言写法）', async () => {
    const serverError = (async () => new Response('', { status: 500 })) as typeof fetch
    writeFileSync(join(outDir, '现有.md'), '在')
    const st = await runKbSync(deps(serverError))
    expect(st.state).toBe('error')
    expect(readFileSync(join(outDir, '现有.md'), 'utf8')).toBe('在')
  })
  it('磁盘不足预检 → error，零文件请求（statfsImpl 是为可测性开的最小 DI 口）', async () => {
    const f = fixture({ 'a.md': 'x', 'index.json': 'i' })
    let fileRequests = 0
    const counting = (async (url: unknown) => {
      if (!String(url).endsWith('manifest.json')) fileRequests++
      return f.fetchImpl(url as never)
    }) as typeof fetch
    const st = await runKbSync({
      ...deps(counting),
      statfsImpl: () => ({ bavail: 0, bsize: 1 })
    })
    expect(st.state).toBe('error')
    expect(fileRequests).toBe(0)
  })
  it('开工清扫 .part 残留', async () => {
    mkdirSync(join(outDir, 'x'), { recursive: true })
    writeFileSync(join(outDir, 'x/半截.md.part'), '')
    const f = fixture({ 'index.json': 'i' })
    await runKbSync(deps(f.fetchImpl))
    expect(existsSync(join(outDir, 'x/半截.md.part'))).toBe(false)
  })
  it('onStatus 收到 syncing 进度与终态 success', async () => {
    const f = fixture({ 'a.md': 'x', 'index.json': 'i' })
    const seen: string[] = []
    await runKbSync({ ...deps(f.fetchImpl), onStatus: (s) => seen.push(s.state) })
    expect(seen[0]).toBe('syncing')
    expect(seen.at(-1)).toBe('success')
  })
  it('onStatus 回调抛异常不击穿引擎——照常返回 success 且副作用完整', async () => {
    const f = fixture({ 'a.md': 'x', 'index.json': 'i' })
    const st = await runKbSync({
      ...deps(f.fetchImpl),
      onStatus: () => {
        throw new Error('渲染端炸了')
      }
    })
    expect(st.state).toBe('success')
    expect(readFileSync(join(outDir, 'index.json'), 'utf8')).toBe('i')
    expect(existsSync(join(stateDir, 'manifest.json'))).toBe(true)
  })
})
