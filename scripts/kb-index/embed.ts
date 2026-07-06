import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline, env } from '@huggingface/transformers'
import { chunkTextWithOffsets } from '../../apps/desktop/src/main/core/proposalRetrieve.core.ts'
import type { KbIndexFile, VectorMeta, VectorStoreMeta } from '../../apps/desktop/src/shared/kbIndex.ts'

const DIM = 512
const MODEL_ID = 'bge-small-zh-v1.5'

/**
 * 对所有 ok 文件镜像 md 切【唯一权威分块表】并向量化，写 vectors.bin + vectors-meta.json。
 * 行号 i 三者对齐（向量第 i 行 ↔ meta.rows[i] ↔ chunk id i）。bun 跑，直接 import app 纯核。
 *
 * 为什么在这里 allowRemoteModels=true：离线构建脚本允许从缓存/远端拉模型；线上 app 侧
 * 的 embedWorker 才设 false，避免运行期联网（用户已打包的模型快照）。
 *
 * @param localModelPath 可选——指向已预下载的模型根目录（含 Xenova/bge-small-zh-v1.5/）。
 *   传入时进入纯本地模式（allowRemoteModels=false），用于无网络环境的测试/CI。
 *   不传时保持 allowRemoteModels=true，允许首次运行自动拉取并缓存模型。
 */
export async function buildVectors(
  files: KbIndexFile[],
  outDir: string,
  builtAtMs: number,
  localModelPath?: string
): Promise<void> {
  // 离线允许从本地缓存/远端取模型；线上 app 侧才 allowRemoteModels=false（见 embedWorker）。
  // 若调用方传入 localModelPath，切换到纯本地模式——适合没有网络的 CI / 测试环境。
  if (localModelPath) {
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = localModelPath
  } else {
    env.allowRemoteModels = true
  }
  const extractor = await pipeline('feature-extraction', `Xenova/${MODEL_ID}`, { dtype: 'q8' })

  const rows: VectorMeta[] = []
  const texts: string[] = []
  for (const f of files) {
    if (!f.ok) continue
    let content: string
    try { content = readFileSync(f.mirrorPath, 'utf8') } catch { continue }
    for (const c of chunkTextWithOffsets(content)) {
      rows.push({
        sourcePath: f.sourcePath, mirrorPath: f.mirrorPath,
        productLine: f.productLine, product: f.product, title: f.title,
        charStart: c.charStart, charEnd: c.charEnd,
        text: c.text, snippet: c.text.slice(0, 160)
      })
      texts.push(c.text)
    }
  }

  const vectors = new Float32Array(rows.length * DIM)
  // 逐条 embed（v4 也支持批，但逐条最稳；几千~几万条一次性离线跑可接受）。
  for (let i = 0; i < texts.length; i++) {
    const out = await extractor(texts[i], { pooling: 'mean', normalize: true })
    if ((out.data as Float32Array).length !== DIM) throw new Error(`embedding 维度 ${(out.data as Float32Array).length} ≠ ${DIM}——模型/dtype 配错`)
    vectors.set(out.data as Float32Array, i * DIM)
    if (i % 200 === 0) process.stdout.write(`\r向量化 ${i}/${texts.length}`)
  }

  writeFileSync(join(outDir, 'vectors.bin'), Buffer.from(vectors.buffer))
  const meta: VectorStoreMeta = { version: 2, dim: DIM, fingerprint: String(builtAtMs), rows }
  writeFileSync(join(outDir, 'vectors-meta.json'), JSON.stringify(meta), 'utf8')
  console.log(`\n向量化完成：${rows.length} chunk → vectors.bin + vectors-meta.json`)
}
