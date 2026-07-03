/**
 * 知识库远程同步的状态机（shared：main 产、preload 转、renderer 消费）。
 *
 * 为什么放 shared 而不是 main：终态由 runKbSync（main 进程引擎）生成，经 preload 的
 * contextBridge IPC 原样透传，最终由 renderer 的状态条渲染——三方共用同一份判别联合，
 * 任一处漏一个 state 变体 typecheck 当场抓到。本文件是纯类型、零 import（既进 node
 * tsconfig 也进 web tsconfig，不许带任何运行时/Node 依赖）。
 */
export type KbSyncStatus =
  | { state: 'idle' }
  | { state: 'syncing'; done: number; total: number }
  | { state: 'success'; atMs: number; builtAtMs: number }
  | { state: 'error'; message: string; failedCount: number }
