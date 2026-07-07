/**
 * 本地文件夹 → 托管库 的增量同步计划（纯函数，零 electron/fs 依赖，bun test 直测）。
 *
 * 单向语义：本地源文件夹是唯一真相，把托管库对齐成和它一样。
 *  - toCopy：源里「库中没有该 relPath」或「sha1 与索引记录不同」的文件（新增 + 内容改）。
 *  - toDelete：库里有、源里没有的 relPath（本地删了/改名了 → 库删旧的）。
 *
 * 改名/移动在这里天然表现为「toDelete 旧 relPath + toCopy 新 relPath」，无需单独识别。
 *
 * storeRelPaths 用磁盘真相（listStoreRelPaths），indexSha1ByRel 用索引记录的 sha1 做
 * 「变没变」判断（避免每次重算全库 sha1——源侧才算，库侧信任上次构建记的 sha1）：
 *  - 库有该文件但索引查不到 sha1（索引缺失/半写）→ get 返回 undefined ≠ 源 sha1 → 归 toCopy，
 *    宁可多拷一次也不漏更新（安全侧）。
 *  - 删除只遍历 storeRelPaths（磁盘），陈旧索引条目不会造成误删。
 */
export interface LocalSyncSourceFile {
  relPath: string
  sha1: string
  productLine: string
  product: string
  sourcePath: string
}

export interface LocalSyncPlan {
  toCopy: LocalSyncSourceFile[]
  toDelete: string[]
}

export function planLocalSync(
  source: readonly LocalSyncSourceFile[],
  storeRelPaths: ReadonlySet<string>,
  indexSha1ByRel: ReadonlyMap<string, string>
): LocalSyncPlan {
  const toCopy = source.filter(
    (s) => !storeRelPaths.has(s.relPath) || indexSha1ByRel.get(s.relPath) !== s.sha1
  )
  const srcRel = new Set(source.map((s) => s.relPath))
  const toDelete = [...storeRelPaths].filter((rel) => !srcRel.has(rel))
  return { toCopy, toDelete }
}
