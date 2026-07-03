import type { NextConfig } from 'next'

// Daemon 端口约定与 apps/web/next.config.ts 一致：dev-all 启动器探测空闲端口后
// 用 OD_PORT 覆盖，这里读同一个 env，保证 /api 反代永远指向正确的 daemon 实例。
const DAEMON_PORT = Number(process.env.OD_PORT) || 7456
const DAEMON_ORIGIN = `http://127.0.0.1:${DAEMON_PORT}`

// 打包形态（Phase 4 定稿）：prod 走 static export，产物 out/ 由 Electron 的
// app://studio 协议直接读盘、/api 等由同一 handler 反代 daemon——与 apps/web
// 的 prod 模式完全同构（appProtocol.ts）。dev 保持 server 模式（rewrites 反代
// + HMR）。export 模式下 rewrites 不受支持，所以按模式二选一。
const isExport = process.env.NODE_ENV !== 'development'

const nextConfig: NextConfig = {
  // @open-design/ui 是 source-only 包（exports 直指 src/*.tsx，无 dist）——
  // 必须列进 transpilePackages 让 Next 用自己的管线编译其 TSX，同时让
  // Tailwind 扫描器直接看到源码里的类名（这正是该包选择 source-only 的原因，
  // 见 packages/ui/package.json 的 description）。
  transpilePackages: ['@open-design/ui'],

  ...(isExport
    ? {
        output: 'export' as const,
        // export 模式没有 image 优化服务；不关会构建报错。
        images: { unoptimized: true }
      }
    : {
        // dev：与 web 同款 daemon 反代——/api 与 /artifacts 转发给本机
        // daemon，页面用相对路径 fetch 即可。prod 下这层反代由 app://
        // handler 承担（见 appProtocol.ts）。
        async rewrites() {
          return [
            { source: '/api/:path*', destination: `${DAEMON_ORIGIN}/api/:path*` },
            { source: '/artifacts/:path*', destination: `${DAEMON_ORIGIN}/artifacts/:path*` }
          ]
        }
      })
}

export default nextConfig
