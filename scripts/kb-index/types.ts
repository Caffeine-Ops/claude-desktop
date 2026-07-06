// 脚本内部类型入口：re-export 共享索引契约，供 kb-index 脚本群统一从此处引入，
// 避免各脚本直接使用相对 ../../apps/studio/... 的长路径。
export type { KbIndexFile, KbIndex } from '../../apps/studio/electron/shared/kbIndex.ts'
export type { ScanEntry } from './scan.ts'
