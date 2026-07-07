import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_URI = /data:image\/(png|jpeg|jpg|gif|svg\+xml);base64,([A-Za-z0-9+/=]+)/g

export function extractDataUriImages(
  markdown: string,
  assetsDir: string
): { markdown: string; assets: string[] } {
  const assets: string[] = []
  let n = 0
  const out = markdown.replace(DATA_URI, (_m, fmt: string, b64: string) => {
    const ext = fmt === 'svg+xml' ? 'svg' : fmt === 'jpeg' ? 'jpg' : fmt
    if (assets.length === 0) mkdirSync(assetsDir, { recursive: true })
    const file = join(assetsDir, `img-${++n}.${ext}`)
    writeFileSync(file, Buffer.from(b64, 'base64'))
    assets.push(file)
    return file // 用绝对路径引用，app 侧再转相对/file://
  })
  return { markdown: out, assets }
}
