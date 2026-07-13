/**
 * re-export shim——实现已迁往 electron/shared/messageMarkers.ts（2026-07-13，
 * 会话录制回放需要 main 侧编译器共用 marker 解析，理由见那边头注释）。
 * 保留本路径是为了既有消费方（filePreview.ts re-export、UserMessage、
 * RailSessionList、ThreadView 标题解析等）import 不变；新代码两边 import
 * 均可。注意 shared 版仍是零依赖纯模块，RailSessionList 的 SSR 约束不破。
 */
export * from '@desktop-shared/messageMarkers'
