/**
 * 写作配图落盘 helper：把 imageGenService 产出的 Buffer 存进**写作项目自己的**
 * `images/` 目录，返回绝对路径与正文用的相对路径。
 *
 * 与 proposalImageWriter（`electron/main/services/proposalImageWriter.ts`）的关键
 * 区别：提案的图落 `<userData>/proposal-drafts/`（app 内部数据区，落点靠
 * proposalDraftsRoot() 动态 import electron 才能定位），写作的图落用户磁盘上的项目
 * 目录本身（`projectDir` 由调用方传入，不依赖任何 electron API）。理由是写作项目
 * 本来就建在用户看得见的地方，图跟着项目走、整个文件夹搬到别处图也不丢，且纯命令行
 * 跑写作技能（不经 Electron）时落点也一致。
 *
 * 两个纯函数刻意不碰 fs、不 import electron：保持本模块对 `bun test` 可加载
 * （顶层 import electron 会在 bun 环境炸掉，同 proposalImageWriter 的约定）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 纯拼路径（可测）。文件名前缀 `gen-` 与提案侧同义，标明来源是 AI 生成。 */
export function writingImagePathFor(projectDir: string, ext: string, ts: number): string {
  return join(projectDir, 'images', `gen-${ts}.${ext}`)
}

/**
 * 正文里引用配图用的相对路径。恒为 `../images/<文件名>`——正文分节文件在
 * `<项目>/drafts/`，与 `images/` 是兄弟目录。写相对而非绝对，是为了整个项目
 * 文件夹搬走后正文里的引用仍然有效。
 */
export function writingImageRelPath(fileName: string): string {
  return `../images/${fileName}`
}

/** 落盘：mkdir -p `<项目>/images/` 后写文件，返回绝对路径与相对路径。 */
export async function writeWritingImage(
  projectDir: string,
  bytes: Buffer,
  ext = 'png',
  ts = Date.now()
): Promise<{ path: string; relPath: string }> {
  const abs = writingImagePathFor(projectDir, ext, ts)
  await mkdir(join(projectDir, 'images'), { recursive: true })
  await writeFile(abs, bytes)
  return { path: abs, relPath: writingImageRelPath(`gen-${ts}.${ext}`) }
}
