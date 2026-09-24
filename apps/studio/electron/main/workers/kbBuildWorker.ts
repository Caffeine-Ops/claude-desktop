// utilityProcess 入口：全库增量构建（转换走 execFileSync，是重活，绝不进 main——同
// kbBuildWorker 之外几个 worker 的隔离理由）。argv: [storeDir, outDir, nowMs]
//
// 2026-09-24：第四个参数 modelDir 已随向量化栈一起删除。原先本文件先探测
// <modelDir>/<KB_MODEL_ID>/onnx/model_quantized.onnx 是否存在，据此决定 buildKbIndex 的
// vectors 选项传 { localModelPath } 还是 false（模型缺失就跳过向量化、只出镜像+索引）。
// 现在构建只有「扫描→转换→写 index.json」一条路，不再有向量化阶段。
import { buildKbIndex } from '../core/kbBuild/build'

// parentPort 类型注记（Electron 全局 ambient 声明，不能具名 import）
const parentPort = (process as typeof process & { parentPort: Electron.ParentPort }).parentPort

const [storeDir, outDir, nowArg] = process.argv.slice(2) as [string, string, string]

async function run(): Promise<void> {
  await buildKbIndex({
    kbRoot: storeDir,
    outDir,
    now: Number(nowArg),
    onProgress: (p) => parentPort.postMessage({ type: 'progress', ...p }),
    log: (line) => parentPort.postMessage({ type: 'log', line })
  })
  parentPort.postMessage({ type: 'done', ok: true })
}

run().catch((err) => parentPort.postMessage({ type: 'done', ok: false, error: String(err) }))
