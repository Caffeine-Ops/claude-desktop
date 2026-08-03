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
import { randomBytes } from 'node:crypto'
import { basename, join } from 'node:path'

/**
 * 纯拼路径（可测）。文件名前缀 `gen-` 与提案侧同义，标明来源是 AI 生成；
 * 时间戳后再缀 6 位随机 hex（同目录 writingProject.ts 的 writeFileAtomic 同款
 * 做法）——两次生成落在同一毫秒时（并行 generateImage、或用户连点两次），纯
 * 时间戳会撞出同一个文件名，第二次 writeFile 用默认 flag `'w'` 直接截断覆盖
 * 第一张，两次 IPC 各自回同一个 path/relPath，第一张图零报错地永久丢失。随机
 * 后缀把这个概率压到可忽略，且不改变协议白名单判定（仍是 `/images/` 下的图片
 * 扩展名）。
 */
export function writingImagePathFor(projectDir: string, ext: string, ts: number): string {
  return join(projectDir, 'images', `gen-${ts}-${randomBytes(6).toString('hex')}.${ext}`)
}

/**
 * 正文里引用配图用的相对路径。恒为 `../images/<文件名>`——正文分节文件在
 * `<项目>/drafts/`，与 `images/` 是兄弟目录。写相对而非绝对，是为了整个项目
 * 文件夹搬走后正文里的引用仍然有效。
 */
export function writingImageRelPath(fileName: string): string {
  return `../images/${fileName}`
}

/**
 * 落盘：mkdir -p `<项目>/images/` 后写文件，返回绝对路径与相对路径。
 *
 * 只调一次 `writingImagePathFor` 并用 `basename(abs)` 派生 relPath 的文件名——
 * 不能像早期版本那样分别调用 `writingImagePathFor(...)` 和再拼一次
 * `` `gen-${ts}.${ext}` ``：后者拿不到前者内部生成的随机后缀，会算出两个不同的
 * 文件名，导致 `path` 与 `relPath` 指向两个不存在对应关系的文件（`relPath` 名
 * 义上要能在 `<项目>/drafts/` 下相对定位到 `path` 实际落盘的那个文件）。
 *
 * `mkdir({ recursive: true })` 这里只负责补 `images/` 这一层，不代表可以凭空
 * 造出整条 projectDir 路径——调用方（WRITING_IMAGE_GENERATE handler）在调用
 * 本函数前已经用 `statSync(projectDir).isDirectory()` 确认过 projectDir 本身
 * 存在，这里的 recursive 只是应对"项目存在但 images/ 还没建过"的正常首次生图。
 */
export async function writeWritingImage(
  projectDir: string,
  bytes: Buffer,
  ext = 'png',
  ts = Date.now()
): Promise<{ path: string; relPath: string }> {
  const abs = writingImagePathFor(projectDir, ext, ts)
  await mkdir(join(projectDir, 'images'), { recursive: true })
  await writeFile(abs, bytes)
  return { path: abs, relPath: writingImageRelPath(basename(abs)) }
}
