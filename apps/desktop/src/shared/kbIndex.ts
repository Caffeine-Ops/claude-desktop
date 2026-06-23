// 知识库索引产物契约。阶段 A 脚本产出、阶段 B app 消费，两端共享此文件。
export interface KbIndexFile {
  sourcePath: string
  mirrorPath: string
  productLine: string
  product: string
  title: string
  mtimeMs: number
  sha1: string
  assets: string[]
  ok: boolean
  error?: string
}

export interface KbIndex {
  version: 1
  kbRoot: string
  builtAtMs: number
  files: KbIndexFile[]
}
