// kb-model 清单——prebundle-kb-model.mjs 与 verify-kb-model.mjs 的唯一事实源。
//
// 为什么单独一个 .mjs：
//   TS 侧的模型 id 事实源在 apps/desktop/src/shared/kbIndex.ts（KB_MODEL_ID），
//   但 .mjs 打包脚本在 electron-vite 编译之外跑，import 不了 TS。于是 .mjs 世界
//   自己收敛到本文件——改模型时【两处都要动】：shared/kbIndex.ts 的 KB_MODEL_ID
//   与这里的 MODEL_DIR_NAME/HF_REPO/SHA256。
//
// 为什么把目录名、HF 仓库、sha256 pin 收在一起：
//   旧实现里 prebundle 与 verify 各自内联同一批字面量。bump 模型时若只改了
//   prebundle，verify 仍校验旧目录旧 pin——照样绿灯，坏产物直通打包。现在两脚本
//   都从这一份常量推导路径与校验值，改一处即同时生效，错配不可能静默通过。

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/** 模型目录名（kb-model/<MODEL_DIR_NAME>/）。＝ shared/kbIndex.ts 的 KB_MODEL_ID。 */
export const MODEL_DIR_NAME = 'bge-small-zh-v1.5'

/** HuggingFace 仓库（远程拉取需 org 前缀）。 */
export const HF_REPO = `Xenova/${MODEL_DIR_NAME}`

// SHA256 pins — Task 4 smoke test 期间从 Xenova/bge-small-zh-v1.5 经
// @huggingface/transformers 缓存下载的文件哈希。
// bump 流程：重新下载新文件 → 算新哈希 → 更新此处（prebundle/verify 自动跟随）。
export const SHA256 = {
  'config.json': 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
  'tokenizer.json': '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
  'tokenizer_config.json': 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a',
  'onnx/model_quantized.onnx': '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
}

/** 体积下限（bytes）：0 字节/明显截断的文件先给出清晰报错，再谈 sha。 */
export const MIN_SIZE = {
  'config.json': 100,
  'tokenizer.json': 100_000,
  'tokenizer_config.json': 100,
  'onnx/model_quantized.onnx': 20_000_000,
}

/** 共享哈希 helper——原先两脚本各有一份字节相同的拷贝。 */
export async function sha256File(filePath) {
  const buf = await readFile(filePath)
  return createHash('sha256').update(buf).digest('hex')
}
