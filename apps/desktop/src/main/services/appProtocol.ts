/**
 * `app://` 自定义协议 —— prod 下 Open Design web tab 的加载来源。
 *
 * 为什么不用 file:// 直读磁盘（这是本方案的核心理由，改之前务必读懂）：
 *
 *  1. **前端所有 API 调用都是相对路径** `fetch('/api/...')`（见 apps/web 的
 *     runtime/exports.ts、runtime/markdown.tsx 等几十处）。在 file:// 下相对路径
 *     会解析成 file:///api/...，永远到不了 daemon 的 127.0.0.1:7456，整个数据层断裂。
 *  2. **file:// 页面的 Origin 头是字符串 'null'**，而 daemon 的 origin 校验中间件
 *     （apps/daemon/src/server.ts）只放行两个只读 GET 路由给 Origin: null，其余 /api
 *     一律 403。聊天、导出、所有写操作全废。见 [[2026-05-23-daemon-origin校验拒跨源致web调api全403]]
 *  3. _next/ 资源是 /_next/... 绝对路径，file:// 下同样指向 file:///_next/... 而非磁盘。
 *
 * app:// 同时拿到 file:// 的好处（读磁盘、不占端口）又避开全部三个坑：
 *
 *  - 注册为 standard + secure scheme（见 index.ts 的 registerSchemesAsPrivileged），
 *    相对路径 fetch('/api/...') 解析成 app://open-design/api/...，被本 handler 拦下。
 *  - app://open-design 是个**真 origin**（不是 'null'）。把它加进 daemon 的
 *    OD_ALLOWED_ORIGINS 白名单（见 openDesignServices.ts），跨源 /api 即放行，
 *    daemon 的 null-origin 防护完全不用动。
 *  - 页面/静态资源（/、/_next/...、.svg…）→ 从磁盘 apps/web/out 读文件。
 *  - API 流量（/api、/artifacts、/frames）→ fetch 转发给 daemon，原样回传（含 SSE）。
 *
 * dev 模式**不走这里**：dev 仍用 next dev + localhost:3000 保留 HMR，本协议只在 prod
 * 注册并被 resolveWebTabUrl() 选中。
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { net, protocol } from 'electron'

import { DAEMON_PORT, resolveWebStaticDir } from './openDesignServices'

/** 自定义协议名。注意：必须与 index.ts registerSchemesAsPrivileged 里登记的一致。 */
export const APP_SCHEME = 'app'
/** web tab 的 host。app://open-design/ 是页面入口，也是 daemon 白名单里的 origin。 */
export const APP_HOST = 'open-design'
/** prod 下 web tab 加载的入口 URL。 */
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

const DAEMON_ORIGIN = `http://127.0.0.1:${DAEMON_PORT}`

/**
 * 需要反代到 daemon 的路径前缀。和 daemon 自己的 SPA fallback 排除表
 * （server.ts isStaticSpaFallbackRequest）保持一致：这些是动态数据/资源，
 * 不在静态产物 out/ 里，必须走 daemon。其余路径才当静态文件读盘。
 */
const DAEMON_PROXY_PREFIXES = ['/api', '/artifacts', '/frames']

function shouldProxyToDaemon(pathname: string): boolean {
  return DAEMON_PROXY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
}

/**
 * 把磁盘文件读成 Response。带路径逃逸防护：normalize 后必须仍在 staticDir 内，
 * 否则 app://open-design/../../etc/passwd 这类构造能读到产物目录外的文件。
 */
function fileResponse(staticDir: string, pathname: string): Response | null {
  // 去掉前导 /，拼到 staticDir 下，normalize 折叠 ../，再校验前缀。
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  const abs = normalize(join(staticDir, rel))
  // staticDir 末尾补 sep 再比，避免 /out 命中 /out-evil 这种前缀误判。
  if (abs !== staticDir && !abs.startsWith(staticDir + sep)) return null
  if (!existsSync(abs) || !statSync(abs).isFile()) return null

  // Web ReadableStream from the Node read stream — supportFetchAPI 协议要求
  // handler 返回标准 Response，Readable.toWeb 把 Node 流桥过去。
  const body = Readable.toWeb(createReadStream(abs)) as ReadableStream
  return new Response(body, {
    headers: { 'content-type': mimeFor(abs) }
  })
}

/**
 * 极简 MIME 表。只覆盖 next export 产物会出现的类型；其余交给浏览器嗅探
 * （desktop 内嵌、来源可信，不像公网 server 那样需要严格 X-Content-Type）。
 */
function mimeFor(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.ico':
      return 'image/x-icon'
    case '.woff2':
      return 'font/woff2'
    case '.woff':
      return 'font/woff'
    case '.map':
      return 'application/json; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

/**
 * 注册 app:// 协议 handler。app.whenReady() 之后调用一次。
 * registerSchemesAsPrivileged 必须**已经**在 ready 之前跑过（见 index.ts）。
 */
export function registerAppProtocol(): void {
  const staticDir = resolveWebStaticDir()

  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const pathname = url.pathname || '/'

    // ① API / 动态资源 → 反代 daemon。net.fetch 走 Electron 的网络栈，
    //    天然支持流式响应（/api/chat 的 SSE 不会被缓冲）。
    //
    //    关键：**剥掉 Origin（和 Host）头**再转发。daemon 的 origin 校验
    //    （origin-validation.ts / server.ts）只认 http:// / https://，看到
    //    Origin: app://open-design 会判跨源 → 403；而且 app:// 也没法加进它的
    //    OD_ALLOWED_ORIGINS 白名单（启动期就因非 http scheme 抛错崩溃）。
    //    去掉 Origin 后，daemon 把这当成可信的非浏览器请求放行
    //    （server.ts: `if (origin == null || origin === '') return next()`）——
    //    这本来就是事实：发请求的是 Electron 主进程，不是跨源浏览器页面。
    if (shouldProxyToDaemon(pathname)) {
      const target = `${DAEMON_ORIGIN}${pathname}${url.search}`
      const headers = new Headers(request.headers)
      headers.delete('origin')
      headers.delete('host')
      // duplex:'half' 让带 body 的 POST 能流式上传。
      return net.fetch(target, {
        method: request.method,
        headers,
        body: request.body,
        // @ts-expect-error duplex 是 fetch streaming 上传必需，类型未收录
        duplex: 'half',
        redirect: 'manual'
      })
    }

    // ② 静态文件命中 → 直接读盘。
    const direct = fileResponse(staticDir, pathname)
    if (direct) return direct

    // ③ SPA fallback：未知非资源路径回 index.html，让客户端 router 接管
    //    （对齐 daemon 的 registerStaticSpaFallback）。带扩展名的请求
    //    （.js/.css/缺失的资源）不 fallback，返回 404，避免把 HTML 当 JS 喂给浏览器。
    const looksLikeAsset = /\.[a-z0-9]+$/i.test(pathname)
    if (!looksLikeAsset) {
      const shell = fileResponse(staticDir, '/index.html')
      if (shell) return shell
    }

    return new Response('Not Found', { status: 404 })
  })
}
