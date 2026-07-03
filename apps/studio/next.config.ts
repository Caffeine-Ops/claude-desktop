import type { NextConfig } from 'next'

// Daemon 端口约定与 apps/web/next.config.ts 一致：dev-all 启动器探测空闲端口后
// 用 OD_PORT 覆盖，这里读同一个 env，保证 /api 反代永远指向正确的 daemon 实例。
const DAEMON_PORT = Number(process.env.OD_PORT) || 7456
const DAEMON_ORIGIN = `http://127.0.0.1:${DAEMON_PORT}`

const nextConfig: NextConfig = {
  // @open-design/ui 是 source-only 包（exports 直指 src/*.tsx，无 dist）——
  // 必须列进 transpilePackages 让 Next 用自己的管线编译其 TSX，同时让
  // Tailwind 扫描器直接看到源码里的类名（这正是该包选择 source-only 的原因，
  // 见 packages/ui/package.json 的 description）。
  transpilePackages: ['@open-design/ui'],

  // 本应用只跑在 Electron 薄壳内（决策：放弃纯浏览器/od CLI 部署形态），
  // 因此不设 output: 'export'，保留 Next 全量能力。dev 下壳加载
  // http://localhost:3100；打包形态（standalone vs static export 回退）
  // 在聊天 UI 迁移完成后再定，这里刻意不提前锁死。
  async rewrites() {
    // 与 web 同款 daemon 反代：/api 与 /artifacts 转发给本机 daemon，
    // 让迁移过来的页面无需改 fetch 路径。
    return [
      { source: '/api/:path*', destination: `${DAEMON_ORIGIN}/api/:path*` },
      { source: '/artifacts/:path*', destination: `${DAEMON_ORIGIN}/artifacts/:path*` }
    ]
  }
}

export default nextConfig
