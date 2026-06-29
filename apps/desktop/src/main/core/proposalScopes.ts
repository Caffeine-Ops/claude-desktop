import { join } from 'node:path'

import { kbOutDir, readKbIndex } from './kbIndexStore'
import type { ProposalProductScope } from './proposalPrompt'

/**
 * 由产品集构造检索 / grounding 用的 ProposalProductScope[]（产品镜像目录 + 各文件的
 * title / mirrorPath / assets）。
 *
 * 从 engine 的私有 proposalProductScopes 抽出共享：engine 的 send 热路径与「召回预览」只读
 * IPC（方案三）都走同一份 scope 构建，避免两边漂移。engine 那个私有方法现委托到这里。
 *
 * 空产品集直接短路、绝不读盘——readKbIndex() 每调用都 existsSync + readFileSync + JSON.parse
 * 整份索引；空集时 map 本就返回 []，提前返回省掉那次同步读盘/解析（评审发现 7：原本每次 spawn
 * 含普通非方案会话都白读一遍 index.json）。
 *
 * 主进程专用（kbIndexStore 间接依赖 electron app，故不可在 bun test 进程加载——本模块也因此
 * 不进单测，与 engine 同列）。
 */
export function buildProposalProductScopes(
  products: readonly { productLine: string; product: string }[]
): ProposalProductScope[] {
  if (products.length === 0) return []
  const root = kbOutDir()
  const index = readKbIndex()
  return products.map((p) => {
    const dir = join(root, p.productLine, p.product)
    const files =
      index?.files
        .filter((f) => f.ok && f.productLine === p.productLine && f.product === p.product)
        .map((f) => ({ title: f.title, mirrorPath: f.mirrorPath, assets: f.assets })) ?? []
    return { dir, productLine: p.productLine, product: p.product, files }
  })
}
