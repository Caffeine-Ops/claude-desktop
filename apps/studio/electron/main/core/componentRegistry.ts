// 通用组件名册——「加一个可下载组件 = 往这里加一张档案卡」。P1a 只有 embed 一张（从既有
// kbModelManifest 派生，sha256/size 复用那份唯一事实源，绝不再抄一份防漂移）。P1c 已加
// python-runtime；仅 reranker 待将来加。
import type { ComponentDescriptor } from '../../shared/componentDownload'
import { KB_MODEL_ID } from '../../shared/kbIndex'
import { KB_DOWNLOADABLE_MODELS } from './kbModelManifest'

export const EMBED_COMPONENT_ID = 'kb-embed'
export const MARKITDOWN_COMPONENT_ID = 'markitdown'
export const SOFFICE_COMPONENT_ID = 'soffice'
export const PYTHON_COMPONENT_ID = 'python-runtime'

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

// python-runtime:ppt-master 技能的运行基座,P1c 起从 CI 随包改为按需下载(spec
// 2026-07-17-p1c-python-runtime-on-demand-design.md)。版本钉的唯一事实源在这里——
// 钉 3.12 的原因(从 build.yml 已退役的 Bundle 步注释搬来):py3.14 下 PyMuPDF/Pillow/numpy
// 无预编译 wheel,pip 退化源码编译会极慢甚至失败;3.12 有成熟 cp312 wheel。
// install_only tarball 顶层是单个 python/ 目录(bin/、lib/ 在其下),stripComponents:1
// 剥掉它,解释器落 <destSubdir>/bin/python3(win 是 <destSubdir>/python.exe)——与
// resolveBundledPythonHome() 的解释器判据(cliDetect.ts)一致。
const PYTHON_STANDALONE_TAG = '20260510'
const PYTHON_STANDALONE_VERSION = '3.12.13'

// 三平台小表:平台差异(url/sha256/size/判据)全部封死在本文件,下游(installer/IPC/UI)
// 只见一张普通 archive 卡(用户拍板的「名册登记时三选一」方案)。sha256/size 来自该 release
// 官方 SHA256SUMS 与 GitHub API 实测(2026-07-17 取值),同 embed 卡 pin 校验和的做法。
const PYTHON_DISTS: Record<string, { dist: string; sha256: string; size: number }> = {
  'darwin-arm64': {
    dist: 'aarch64-apple-darwin',
    sha256: '5a30271f8d345a5b02b0c9e4e31e0f1e1455a8e4a04fba95cd9762472abc3b17',
    size: 25102827,
  },
  'darwin-x64': {
    dist: 'x86_64-apple-darwin',
    sha256: 'cd369e76973c3179bc578230d8615ab621968ed758c5e32f636eecef4ad79894',
    size: 24783117,
  },
  'win32-x64': {
    dist: 'x86_64-pc-windows-msvc',
    sha256: '346dfbcb95171dd6d1275e6f8cb2e656cc15cb054c399ae54db57bfad4b1a60f',
    size: 45962574,
  },
}

/** 平台三选一(纯函数,测试注入平台)。未知平台返回 undefined——名册随之不注册 python 卡,
 *  组件中心该行不出现、触发器查无此组件也不弹,与「CI 本就只打这三个平台」的现状一致。 */
export function pickPythonDist(platform: string, arch: string):
  { url: string; sha256: string; size: number; readyCheck: string; chmodExec: string[] } | undefined {
  const entry = PYTHON_DISTS[`${platform}-${arch}`]
  if (!entry) return undefined
  const asset = `cpython-${PYTHON_STANDALONE_VERSION}+${PYTHON_STANDALONE_TAG}-${entry.dist}-install_only.tar.gz`
  return {
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STANDALONE_TAG}/${asset}`,
    sha256: entry.sha256,
    size: entry.size,
    readyCheck: platform === 'win32' ? 'python.exe' : 'bin/python3',
    // win 无 unix 权限位不需要 chmod;installer 对空数组是 no-op
    chmodExec: platform === 'win32' ? [] : ['bin/python3'],
  }
}

const pythonDist = pickPythonDist(process.platform, process.arch)
const pythonDescriptor: ComponentDescriptor | null = pythonDist
  ? {
      id: PYTHON_COMPONENT_ID,
      title: 'Python 运行环境',
      description: '制作 PPT(ppt-master 技能)的运行基座;缺失时用系统 Python 兜底',
      strategy: 'hosted-files',
      sizeEstimateBytes: pythonDist.size,
      install: {
        kind: 'archive',
        destSubdir: 'python-runtime',
        format: 'tar.gz',
        stripComponents: 1,
        chmodExec: pythonDist.chmodExec,
        readyCheck: pythonDist.readyCheck,
        archive: { urls: [pythonDist.url], sha256: pythonDist.sha256, size: pythonDist.size },
      },
    }
  : null

export const COMPONENT_REGISTRY: ComponentDescriptor[] = [
  embedDescriptor, markitdownDescriptor, sofficeDescriptor,
  ...(pythonDescriptor ? [pythonDescriptor] : []),
]

export function getComponentDescriptor(id: string): ComponentDescriptor | undefined {
  return COMPONENT_REGISTRY.find((d) => d.id === id)
}

// 引用 KB_MODEL_ID 只为断言布局一致（destSubdir 必须等于它），避免将来 dirName 改了不自知。
if (embedModel.dirName !== KB_MODEL_ID) {
  throw new Error(`embed destSubdir(${embedModel.dirName}) 必须等于 KB_MODEL_ID(${KB_MODEL_ID})`)
}
