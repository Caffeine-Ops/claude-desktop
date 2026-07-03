import type { KbManifest, KbManifestFile } from '../../shared/kbManifest'

/**
 * 两份 manifest 的同步计划（纯函数，electron/fs 零依赖——bun test 直测）。
 *
 * index.json 恒排 toDownload 末位：它是镜像的「目录卡」，先落文件再落卡，
 * 中途断电/断网时旧 index 仍指向完整旧文件集，绝不出现悬空引用（spec ③）。
 * 「首次同步以磁盘为基准」不在这里做——引擎侧把磁盘扫描伪造成 base manifest
 * 后复用本函数（fs 依赖留在引擎，diff 保持纯）。
 */
export interface KbSyncPlan {
  toDownload: KbManifestFile[]
  toDelete: string[]
}

export function diffManifests(base: KbManifest | null, remote: KbManifest): KbSyncPlan {
  const baseByPath = new Map((base?.files ?? []).map((f) => [f.path, f]))
  const remotePaths = new Set(remote.files.map((f) => f.path))
  const toDownload = remote.files.filter((f) => baseByPath.get(f.path)?.sha1 !== f.sha1)
  toDownload.sort((a, b) =>
    a.path === 'index.json' ? 1 : b.path === 'index.json' ? -1 : a.path < b.path ? -1 : 1
  )
  const toDelete = [...baseByPath.keys()].filter((p) => !remotePaths.has(p))
  return { toDownload, toDelete }
}
