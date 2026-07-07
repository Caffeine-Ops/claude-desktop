// utilityProcess 入口：全库增量构建（转换 execFileSync + 向量化模型加载都是重活，
// 绝不进 main——同 embedWorker 的隔离理由）。argv: [storeDir, outDir, nowMs, modelDir]
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildKbIndex } from '../core/kbBuild/build'
import { KB_MODEL_ID } from '../../shared/kbIndex'

// parentPort 类型注记同 embedWorker.ts（Electron 全局 ambient 声明，不能具名 import）
const parentPort = (process as typeof process & { parentPort: Electron.ParentPort }).parentPort

const [storeDir, outDir, nowArg, modelDir] = process.argv.slice(2) as [string, string, string, string]

async function run(): Promise<void> {
  // 模型缺失（打包裁剪/首启未就绪）→ 跳过向量化而非失败：BM25 与镜像先行，
  // embedWorker 对 stale 向量自动降级，模型就绪后下一轮构建补齐（spec §4 降级路径）。
  const modelReady = existsSync(join(modelDir, KB_MODEL_ID, 'onnx', 'model_quantized.onnx'))
  if (!modelReady) parentPort.postMessage({ type: 'log', line: 'kb-model 缺失，本轮跳过向量化' })
  await buildKbIndex({
    kbRoot: storeDir,
    outDir,
    now: Number(nowArg),
    // localModelPath 触发 embed.ts 的本地分支（KB_MODEL_ID 无 Xenova 前缀），与打包目录布局吻合
    vectors: modelReady ? { localModelPath: modelDir } : false,
    onProgress: (p) => parentPort.postMessage({ type: 'progress', ...p }),
    log: (line) => parentPort.postMessage({ type: 'log', line })
  })
  parentPort.postMessage({ type: 'done', ok: true })
}

run().catch((err) => parentPort.postMessage({ type: 'done', ok: false, error: String(err) }))
