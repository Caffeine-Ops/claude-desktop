// 已下沉 @open-design/composer（三端共享核心，合并自 desktop/web 两份手工
// 复制分叉，2026-07-03）。本文件保留为转发 shim，让同目录引用零改动。
// 从根入口 re-export（desktop 的 moduleResolution:node 不认 exports subpath），
// 因此这里也会带出 suggestionPlugin 的符号——无害，shim 本就是过渡。
export * from '@open-design/composer'
