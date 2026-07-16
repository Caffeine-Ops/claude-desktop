// 多镜像下载原语：把「一串候选地址依次试」与「单地址 https 下载」拆开——前者纯编排、可单测，
// 后者是真实 node:https 逻辑，移植自 kbModelDownloader 的私有 downloadFile（保留跟随重定向 +
// 60s 无数据超时 + 出错显式 destroy 写句柄）。网络用 node:https 不用 fetch：环境常有 SSL-MITM
// 代理，node https 自动尊重 NODE_EXTRA_CA_CERTS。
import { createWriteStream } from 'node:fs'
import https from 'node:https'

const DOWNLOAD_TIMEOUT_MS = 60_000

export type SingleUrlDownloader = (
  url: string, dest: string, signal: AbortSignal, onBytes: (n: number) => void
) => Promise<void>

/**
 * 依次尝试 urls，第一个成功即返回；每个失败继续下一个；全失败抛最后一个错误。
 * signal 已 abort：立即抛，不尝试任何下载（避免明知取消还发请求）。
 */
export async function downloadWithMirrors(
  urls: string[], dest: string, signal: AbortSignal,
  onBytes: (n: number) => void, downloadOne: SingleUrlDownloader
): Promise<void> {
  if (signal.aborted) throw new Error('下载已取消')
  let lastErr: unknown = new Error(`无可用下载地址：${dest}`)
  let reported = 0 // 本次尝试已经报给 onBytes 的字节，换镜像时回滚
  for (const url of urls) {
    if (signal.aborted) throw new Error('下载已取消')
    if (reported > 0) { onBytes(-reported); reported = 0 } // 回滚上一个失败镜像已报的进度
    try {
      await downloadOne(url, dest, signal, (n) => { reported += n; onBytes(n) })
      return
    } catch (err) {
      lastErr = err // 记下继续试下一个镜像
    }
  }
  if (reported > 0) { onBytes(-reported); reported = 0 } // 全失败也回滚，不留幽灵进度
  throw lastErr
}

/** 真实单地址下载：跟随重定向、流式落盘、按块回调字节数、60s 无数据超时、abort 报错。 */
export const downloadOneUrl: SingleUrlDownloader = (url, dest, signal, onBytes) =>
  new Promise((resolve, reject) => {
    const follow = (u: string, remaining: number): void => {
      const req = https.get(u, { signal }, (res) => {
        const code = res.statusCode ?? 0
        const loc = res.headers.location
        if ([301, 302, 303, 307, 308].includes(code) && loc) {
          if (remaining <= 0) return reject(new Error(`Too many redirects for ${url}`))
          return follow(Array.isArray(loc) ? loc[0] : loc, remaining - 1)
        }
        if (code !== 200) return reject(new Error(`HTTP ${code} from ${u}`))
        const ws = createWriteStream(dest)
        res.on('data', (c: Buffer) => onBytes(c.length))
        res.pipe(ws)
        ws.on('finish', () => resolve())
        ws.on('error', (err) => { ws.destroy(); reject(err) })
        res.on('error', (err) => { ws.destroy(); reject(err) })
      })
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('下载超时（60s 无响应）')))
      req.on('error', reject)
    }
    follow(url, 10)
  })
