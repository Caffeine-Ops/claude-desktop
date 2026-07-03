import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'
import type { KbManifestFile } from '../../apps/desktop/src/shared/kbManifest.ts'

/**
 * 遍历制品目录产出 manifest 文件清单。跳过：manifest.json 本身（先有鸡后有蛋）、
 * 一切点开头文件/目录（.DS_Store、.tmp 中转目录、备份 dotfile）、*.part（同步半成品）。
 * 路径统一 POSIX、按字典序排序——同一目录两次构建产出 byte 一致的 manifest，
 * 客户端才能拿 sha1 做稳定 diff。
 */
export function buildKbManifestFiles(rootDir: string): KbManifestFile[] {
  const out: KbManifestFile[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.') || name.endsWith('.part')) continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      const rel = relative(rootDir, full).split('\\').join('/')
      if (rel === 'manifest.json') continue
      out.push({
        path: rel,
        sha1: createHash('sha1').update(readFileSync(full)).digest('hex'),
        size: st.size
      })
    }
  }
  walk(rootDir)
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return out
}
