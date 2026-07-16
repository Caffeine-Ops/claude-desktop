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
 * 把重定向 location 解析成绝对 URL。HuggingFace 的 resolve 端点会返回**相对路径**重定向
 * （如 `/api/resolve-cache/...`）——直接喂 https.get 会抛 "Invalid URL"（2026-07-16 实机首下踩到）。
 * 用当前 URL 作 base 解析：相对→补全为绝对；本就绝对→原样返回。loc 可能是数组，取第一个。
 * 非法 location 会抛（调用方 catch 转 reject）。
 */
export function resolveRedirectLocation(loc: string | string[], base: string): string {
  return new URL(Array.isArray(loc) ? loc[0] : loc, base).toString()
}

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
      // https.get 可能同步抛 "Invalid URL"（u 非法/相对）——且这里的 follow 递归发生在响应
      // 回调（异步）里，不在 new Promise executor 的同步范围内，抛出去会变 uncaughtException、
      // Promise 永久挂起（下载卡死零字节，2026-07-16 实机首下踩到）。故整体 try/catch → reject。
      try {
        const req = https.get(u, { signal }, (res) => {
          const code = res.statusCode ?? 0
          const loc = res.headers.location
          if ([301, 302, 303, 307, 308].includes(code) && loc) {
            if (remaining <= 0) return reject(new Error(`Too many redirects for ${url}`))
            // 重定向 location 可能是相对路径（HF/CDN 常见）——用当前 URL 作 base 解析成绝对地址，
            // 否则 https.get(相对路径) 抛 Invalid URL。new URL 本身也可能抛，一并 catch。
            let next: string
            try {
              next = resolveRedirectLocation(loc, u)
            } catch {
              return reject(new Error(`重定向地址非法："${Array.isArray(loc) ? loc[0] : loc}"（来自 ${u}）`))
            }
            return follow(next, remaining - 1)
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
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    follow(url, 10)
  })
