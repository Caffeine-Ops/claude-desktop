// 通用组件名册——「加一个可下载组件 = 往这里加一张档案卡」。P1a 只有 embed 一张（从既有
// kbModelManifest 派生，sha256/size 复用那份唯一事实源，绝不再抄一份防漂移）。
// P1b 会把 reranker/python-runtime/markitdown/soffice 追加进来。
import type { ComponentDescriptor } from '../../shared/componentDownload'
import { KB_MODEL_ID } from '../../shared/kbIndex'
import { KB_DOWNLOADABLE_MODELS } from './kbModelManifest'

export const EMBED_COMPONENT_ID = 'kb-embed'
export const MARKITDOWN_COMPONENT_ID = 'markitdown'
export const SOFFICE_COMPONENT_ID = 'soffice'

// embed 档案卡：把 KB_DOWNLOADABLE_MODELS[0]（bge 四个散文件）翻译成通用档案卡。
// destSubdir=KB_MODEL_ID，与现有 kbModelDir()/<KB_MODEL_ID>/ 布局一致；urls 用 HF resolve
// 地址（一串里先只放默认源，多镜像位就此留好）；readyCheck 判据同 kbBuildWorker.modelReady。
const embedModel = KB_DOWNLOADABLE_MODELS[0]
const embedDescriptor: ComponentDescriptor = {
  id: EMBED_COMPONENT_ID,
  title: '语义检索模型',
  description: 'bge 嵌入模型，启用向量语义检索（缺失时降级 BM25）',
  strategy: 'hosted-files',
  sizeEstimateBytes: embedModel.files.reduce((s, f) => s + f.size, 0),
  install: {
    kind: 'files',
    destSubdir: embedModel.dirName, // = KB_MODEL_ID
    readyCheck: `onnx/model_quantized.onnx`,
    files: embedModel.files.map((f) => ({
      relPath: f.relPath,
      sha256: f.sha256,
      size: f.size,
      urls: [`https://huggingface.co/${embedModel.hfRepo}/resolve/${embedModel.revision}/${f.relPath}`],
    })),
  },
}

// markitdown：pipx 装的 python 文档转换工具，导入 Office/PDF 文档进知识库时用；缺失时转换降级
// （丢内嵌图重试 → soffice 纯文本兜底）。安装编排走既有 kbTooling.installMarkitdown（pipx 优先）。
const markitdownDescriptor: ComponentDescriptor = {
  id: MARKITDOWN_COMPONENT_ID,
  title: '文档转换工具 markitdown',
  description: '把 Office / PDF 文档转成 Markdown 存进知识库；缺失时降级纯文本转换',
  strategy: 'pipx',
  sizeEstimateBytes: 0, // pipx 装、体积不定，UI 不显字节
  install: { kind: 'pipx', pkg: 'markitdown', probeCmd: 'markitdown' },
}

// soffice（LibreOffice）：我们装不了这种大办公套件，只探测本机有没有；没有就引导手动装。
// 它只作为 markitdown 之后的最后兜底纯文本转换用（见 kbBuild/convert.ts）。
const sofficeDescriptor: ComponentDescriptor = {
  id: SOFFICE_COMPONENT_ID,
  title: 'LibreOffice（soffice）',
  description: '文档转换的最后兜底；本机未安装时导入部分格式会失败，可选装',
  strategy: 'detect-only',
  sizeEstimateBytes: 0,
  install: { kind: 'detect-only', probeCmd: 'soffice', guideUrl: 'https://www.libreoffice.org/download/download/' },
}

export const COMPONENT_REGISTRY: ComponentDescriptor[] = [embedDescriptor, markitdownDescriptor, sofficeDescriptor]

export function getComponentDescriptor(id: string): ComponentDescriptor | undefined {
  return COMPONENT_REGISTRY.find((d) => d.id === id)
}

// 引用 KB_MODEL_ID 只为断言布局一致（destSubdir 必须等于它），避免将来 dirName 改了不自知。
if (embedModel.dirName !== KB_MODEL_ID) {
  throw new Error(`embed destSubdir(${embedModel.dirName}) 必须等于 KB_MODEL_ID(${KB_MODEL_ID})`)
}
