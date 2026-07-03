import { writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildKbManifestFiles } from './kb-index/manifest.ts'
import type { KbManifest } from '../apps/desktop/src/shared/kbManifest.ts'

// 与 build-kb-index.ts 同款的极简 argv 解析——不引依赖。
function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!
  throw new Error(`缺少参数 --${name}`)
}

const dir = arg('dir')
const kbId = arg('kb-id')
const name = arg('name')
const builtAtMs = Number(arg('now')) // 同 build 脚本规矩：时间戳外部传入，脚本不调 Date.now
if (!Number.isFinite(builtAtMs)) throw new Error('--now 必须是毫秒时间戳')
if (!existsSync(join(dir, 'index.json')))
  throw new Error(`${dir} 下没有 index.json——先跑 build-kb-index 再发布 manifest`)

const manifest: KbManifest = {
  schemaVersion: 1,
  kbId,
  name,
  builtAtMs,
  files: buildKbManifestFiles(dir)
}
// tmp+rename 原子落盘：客户端任何时刻读到的 manifest 都是完整 JSON，绝不半截。
// tmp 名点开头，walk 的 dotfile 跳过规则顺带保证它永远不会被收进下一份 manifest。
const tmp = join(dir, '.manifest.json.tmp')
writeFileSync(tmp, JSON.stringify(manifest), 'utf8')
renameSync(tmp, join(dir, 'manifest.json'))
console.log(`manifest.json → ${join(dir, 'manifest.json')}（${manifest.files.length} 文件）`)
