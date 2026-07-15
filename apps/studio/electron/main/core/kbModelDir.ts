// kb 模型根目录的唯一解析器。原本 kbSemanticSearch.ts 与 kbBuildRunner.ts 各存一份私有
// modelDir()：打包分支返回 process.resourcesPath/kb-model——但正式安装包从不含 kb-model
// （extraResources / build.files 均无，prebundle-kb-model.mjs 是孤儿脚本，CI 自 2026-07-06
// 起亦跳过），导致生产语义检索永久降级 BM25。故统一改为可写的 userData，并由首次下载器填充。
import { app } from 'electron'
import { join } from 'node:path'

/**
 * 模型根目录。dev 与打包**统一**走 userData（可写、每用户独立）——
 * 打包后 resourcesPath 只读且从不含模型；dev 也走 userData 以与生产同路径，便于测首次下载。
 * 目录布局：<kbModelDir>/<KB_MODEL_ID>/{config.json,tokenizer.json,tokenizer_config.json,onnx/model_quantized.onnx}
 */
export function kbModelDir(): string {
  return join(app.getPath('userData'), 'kb-model')
}
