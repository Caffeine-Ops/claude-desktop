// 嵌入模型下载清单——运行时首次下载器的唯一事实源，取代已退役的 scripts/kb-model-manifest.mjs。
// 模型 id 复用 shared/kbIndex.ts 的 KB_MODEL_ID，避免又一份漂移。P1 的 reranker 只需在
// KB_DOWNLOADABLE_MODELS 追加一项，下载器按列表循环即零改动复用。
import { KB_MODEL_ID } from '../../shared/kbIndex'

/** 单个待下载文件：相对模型目录根的路径 + sha256 pin + 真实字节数（进度分母 + 下载后精确尺寸校验）。 */
export interface KbModelFile {
  relPath: string
  sha256: string
  size: number
}

/**
 * 一个可下载模型。落盘到 <kbModelDir>/<dirName>/…；hfRepo 是 HuggingFace resolve 仓库（含 org 前缀）。
 * revision：钉死的版本。用 'main' + sha256 硬校验已能保证下到的字节正确（上游若变，sha256 会 loud
 * 报错而非静默给错数据）；**故意不再调 HF 的 /api/models 端点取最新 sha**——那个 API 调用正是
 * 2026-07-06 害死 CI kb-model 下载的元凶（resolve-cache 返回非法 URL）。有 HF 访问时可把 'main'
 * 换成具体 commit sha，彻底免疫上游变更。
 */
export interface KbDownloadableModel {
  dirName: string
  hfRepo: string
  revision: string
  files: KbModelFile[]
}

/** bge 嵌入模型的四个文件（sha256 来自原 manifest；size 为实测：本机 kb-model 下的真实字节数）。 */
const BGE_EMBED_FILES: KbModelFile[] = [
  { relPath: 'config.json', sha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f', size: 716 },
  { relPath: 'tokenizer.json', sha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26', size: 439125 },
  { relPath: 'tokenizer_config.json', sha256: 'e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a', size: 367 },
  { relPath: 'onnx/model_quantized.onnx', sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc', size: 24010842 },
]

/** 全部可下载模型。P1 reranker（bge-reranker-base ~100MB）追加为第二项即零改动复用下载器。 */
export const KB_DOWNLOADABLE_MODELS: KbDownloadableModel[] = [
  { dirName: KB_MODEL_ID, hfRepo: `Xenova/${KB_MODEL_ID}`, revision: 'main', files: BGE_EMBED_FILES },
]
