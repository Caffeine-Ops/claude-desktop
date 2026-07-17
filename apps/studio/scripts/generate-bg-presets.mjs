// 生成内置背景预设：无依赖确定性 PNG 编码器（zlib IDAT + CRC32）+ 对角渐变 + 光斑
// screen/tint 混合 + 抖动去 banding。固定 seed（纯数学，无 Math.random）——重跑本
// 脚本产出字节完全一致，可安全提交进 repo 而不担心 diff 噪音。
//
// 为什么构建期生成、PNG 落 public/bg-presets/ 而不是首次启动时在 main 进程生成到
// userData：预设变成纯静态资源，走现成的 app:// 协议服务，运行期零生成代码、零
// 首启失败面；随代码 review（生成参数变了、图跟着变，一个 PR 里看得见）。
//
// meta（accent/secondary/highlight/focus/safeSide/luminance）不是手填猜测值——
// 用真实的 analyzeBackground()（electron/shared/backgroundAnalysis.ts，纯函数、
// 与用户导入图走同一份算法）在生成的像素上跑一遍，写进 src/lib/backgroundArt/
// presets.ts。这样预设和用户主题的"配色建议""构图焦点"是同一套逻辑推出来的，
// 不会出现手填 hex 和图片实际主色对不上的漂移。
//
// 用法：bun scripts/generate-bg-presets.mjs
import { deflateSync } from 'node:zlib'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeBackground } from '../electron/shared/backgroundAnalysis.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const OUT_DIR = join(root, 'public', 'bg-presets')
const META_OUT = join(root, 'src', 'lib', 'backgroundArt', 'presets.ts')
const WIDTH = 1920
const HEIGHT = 1200
// Small independent bitmap for analyzeBackground — decoupled from output
// resolution so analysis stays cheap and matches how real imports are
// analyzed (electron/main/services/backgroundThemes.ts ANALYSIS_MAX_DIMENSION).
const ANALYSIS_DIMENSION = 96

// ---- tiny PNG encoder (RGB, filter 0, zlib IDAT) ----------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(width, height, rgb) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor RGB
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---- math helpers -----------------------------------------------------------

const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value)
const lerp = (a, b, t) => a + (b - a) * t
const smooth = (t) => t * t * (3 - 2 * t)

// Deterministic per-pixel dither (no RNG) so gradients avoid 8-bit banding.
function dither(x, y) {
  let h = (x * 374761393 + y * 668265263) >>> 0
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h / 4294967295 - 0.5
}

const hex = (value) => [
  Number.parseInt(value.slice(1, 3), 16),
  Number.parseInt(value.slice(3, 5), 16),
  Number.parseInt(value.slice(5, 7), 16)
]

// Screen blend keeps overlapping glows luminous instead of muddy on a dark
// base; "tint" lerps toward the glow color, the only way a glow stays
// visible on a light base.
const screen = (base, light) => 255 - ((255 - base) * (255 - light)) / 255

function renderRgbBuffer(spec, width, height) {
  const top = hex(spec.bg[0])
  const bottom = hex(spec.bg[1])
  const blend = spec.blend ?? 'screen'
  const lights = spec.lights.map((l) => ({ ...l, rgb: hex(l.color) }))
  const rgb = Buffer.alloc(width * height * 3)
  const aspect = width / height

  for (let y = 0; y < height; y += 1) {
    const v = y / (height - 1)
    for (let x = 0; x < width; x += 1) {
      const u = x / (width - 1)
      const t = clamp(u * 0.32 + v * 0.68, 0, 1)
      let r = lerp(top[0], bottom[0], t)
      let g = lerp(top[1], bottom[1], t)
      let b = lerp(top[2], bottom[2], t)

      for (const light of lights) {
        const dx = (u - light.x) * aspect
        const dy = v - light.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist >= light.r) continue
        const w = smooth(1 - dist / light.r) * light.intensity
        if (blend === 'tint') {
          r = lerp(r, light.rgb[0], w)
          g = lerp(g, light.rgb[1], w)
          b = lerp(b, light.rgb[2], w)
        } else {
          r = lerp(r, screen(r, light.rgb[0]), w)
          g = lerp(g, screen(g, light.rgb[1]), w)
          b = lerp(b, screen(b, light.rgb[2]), w)
        }
      }

      const d = dither(x, y) * 1.6
      const offset = (y * width + x) * 3
      rgb[offset] = clamp(Math.round(r + d), 0, 255)
      rgb[offset + 1] = clamp(Math.round(g + d), 0, 255)
      rgb[offset + 2] = clamp(Math.round(b + d), 0, 255)
    }
  }
  return rgb
}

function toRgba(rgb, width, height) {
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < width * height; i += 1, j += 3) {
    rgba[i * 4] = rgb[j]
    rgba[i * 4 + 1] = rgb[j + 1]
    rgba[i * 4 + 2] = rgb[j + 2]
    rgba[i * 4 + 3] = 255
  }
  return rgba
}

// ---- preset specs ------------------------------------------------------------
// 4 套抽象渐变，覆盖亮/暗/中性三档，呼应品牌绿一套——纯程序化，零照片/第三方素材/
// 肖像权风险。

const PRESETS = [
  {
    id: 'preset-dawn',
    name: '晨曦',
    bg: ['#fbead6', '#f2b48a'],
    lights: [{ x: 0.82, y: 0.18, r: 0.62, intensity: 0.55, color: '#fff2d6' }],
    blend: 'tint'
  },
  {
    id: 'preset-deep',
    name: '深夜',
    bg: ['#1a2338', '#05070d'],
    lights: [{ x: 0.14, y: 0.86, r: 0.68, intensity: 0.6, color: '#3a6bd6' }],
    blend: 'screen'
  },
  {
    id: 'preset-moss',
    name: '苔痕',
    bg: ['#233326', '#5b5347'],
    lights: [{ x: 0.5, y: 0.4, r: 0.7, intensity: 0.32, color: '#7fae82' }],
    blend: 'screen'
  },
  {
    id: 'preset-slate',
    name: '灰蓝',
    bg: ['#3c4652', '#6b7684'],
    lights: [
      { x: 0.24, y: 0.28, r: 0.5, intensity: 0.3, color: '#e7ecf2' },
      { x: 0.78, y: 0.72, r: 0.55, intensity: 0.24, color: '#c9d3de' }
    ],
    blend: 'tint'
  }
]

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  await mkdir(dirname(META_OUT), { recursive: true })

  const metas = []
  for (const spec of PRESETS) {
    const full = renderRgbBuffer(spec, WIDTH, HEIGHT)
    const png = encodePng(WIDTH, HEIGHT, full)
    await writeFile(join(OUT_DIR, `${spec.id}.png`), png)

    const analysisRgb = renderRgbBuffer(spec, ANALYSIS_DIMENSION, ANALYSIS_DIMENSION)
    const analysis = analyzeBackground({
      data: toRgba(analysisRgb, ANALYSIS_DIMENSION, ANALYSIS_DIMENSION),
      width: ANALYSIS_DIMENSION,
      height: ANALYSIS_DIMENSION,
      format: 'rgba'
    })

    metas.push({
      id: spec.id,
      name: spec.name,
      file: `/bg-presets/${spec.id}.png`,
      width: WIDTH,
      height: HEIGHT,
      luminance: Number(analysis.luminance.toFixed(4)),
      focus: { x: Number(analysis.focus.x.toFixed(4)), y: Number(analysis.focus.y.toFixed(4)) },
      safeSide: analysis.safeSide,
      palette: analysis.palette
    })
    console.log(`generated ${spec.id}.png  luminance=${analysis.luminance.toFixed(3)}  accent=${analysis.palette.accent}`)
  }

  await writePresetsFile(metas)
  console.log(`wrote ${META_OUT}`)
}

async function writePresetsFile(metas) {
  const entries = metas
    .map(
      (m) => `  {
    version: 1,
    id: ${JSON.stringify(m.id)},
    name: ${JSON.stringify(m.name)},
    file: ${JSON.stringify(m.file)},
    width: ${m.width},
    height: ${m.height},
    luminance: ${m.luminance},
    focus: { x: ${m.focus.x}, y: ${m.focus.y} },
    safeSide: ${JSON.stringify(m.safeSide)},
    palette: {
      accent: ${JSON.stringify(m.palette.accent)},
      secondary: ${JSON.stringify(m.palette.secondary)},
      highlight: ${JSON.stringify(m.palette.highlight)}
    },
    createdAt: 0
  }`
    )
    .join(',\n')

  const source = `// AUTO-GENERATED by scripts/generate-bg-presets.mjs — do not hand-edit.
// Re-run \`bun scripts/generate-bg-presets.mjs\` after changing PRESETS there;
// this file and public/bg-presets/*.png regenerate together, byte-identical
// on every re-run (deterministic renderer, no Math.random/Date.now in the
// pixel math). Each entry's palette/focus/luminance/safeSide came from
// running the real analyzeBackground() against the generated pixels — not
// hand-typed — so bundled presets and user-imported themes share one
// analysis path. \`file\` is a public/ root path (served over app://), not a
// bgasset:// URL — presets aren't user files.
import type { BackgroundThemeMeta } from '@desktop-shared/ipc-channels'

export const BACKGROUND_PRESETS: readonly BackgroundThemeMeta[] = [
${entries}
] as const
`
  await writeFile(META_OUT, source, 'utf8')
}

await main()
