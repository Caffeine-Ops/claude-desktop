import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PROPOSAL_DRAFT_BEGIN,
  PROPOSAL_DRAFT_END,
  PROPOSAL_GAP_PREFIX,
  PROPOSAL_COVER_CONFIRM_HEADER,
  PROPOSAL_TOC_CONFIRM_HEADER
} from '../../shared/proposal'
import { resolveBundledSkillsPluginDir } from './skillsDir'

/**
 * 一个「待写产品」连同它在知识库镜像里的可用资料文件清单。
 *
 * 由 engine 侧 `proposalProductScopes()` 从 `readKbIndex()` 过滤构造：按
 * (productLine, product) 命中 index.json 的 files，把每个文件的 title +
 * mirrorPath 摘出来。`dir` 是该产品的镜像子目录绝对路径（<kbOutDir>/<线>/<品>）。
 *
 * 为什么把清单也带上：早先只把 `dir` 写进提示词，AI 不知道目录里有哪些文件，
 * 只能「Glob 探目录 → Grep 试探命中 → 逐个 Read」三步串行往返，每写一段都重来一遍，
 * 这是「写方案反复翻文件慢」的根因。索引产物里本就有精确的文件清单（title +
 * mirrorPath），直接列进提示词让 AI 一眼看到「这个产品有哪几个文件、各叫什么」，
 * 跳过探路阶段、直接 Read 命中。
 *
 * `files` 可能为空：index 未建好、或该产品在索引里没有命中文件。此时退回旧行为
 * （只给目录路径，让 AI 用 Grep/Glob 自查），功能不降级、只是少了加速。
 */
export interface ProposalProductScope {
  dir: string
  productLine: string
  product: string
  files: { title: string; mirrorPath: string; assets: string[] }[]
}

/**
 * 每个产品最多在提示词里列多少个文件。绝大多数产品只有几个到十几个文件，这个
 * 上限只是防御「某产品异常地塞了上百个文件」把提示词撑爆。超出时截断并提示 AI
 * 用 Glob 自查剩余——宁可少列也不让提示词无界膨胀（撑爆缓存断点又拖慢首字）。
 */
const MAX_FILES_PER_PRODUCT = 50

/**
 * 每个文件最多在提示词里列多少张图，防御异常多图把提示词撑爆；超出标注让 AI 知道还有更多。
 */
const MAX_IMAGES_PER_FILE = 12

/**
 * 读取方案写作方法论模板（skills/proposal-writer/references/append-template.md）。
 *
 * 为什么运行期读文件而不是 Vite `?raw` 编译期内联（设计 §5.3 修订）：`?raw` 是
 * Vite 专属语法，bun test 解析不了，会弄挂本目录全部 proposal 测试；而 skills/
 * 整树本就随包发布（tools/pack resources.ts）且 dev/bun test 下可经 cwd 候选回落
 * 仓库根，resolveBundledSkillsPluginDir 是现成解析器（engine 挂 plugin 用的同一个）。
 * 附带收益：dev 改模板对下一个 spawn 的会话即时生效，无需重启。
 *
 * 读不到就抛错（而不是回退空串）：方案会话没有纪律注入就等于放任编造——客户会
 * 据方案做采购决策，宁可当轮发送失败也不静默降级。这一依赖面与 skills plugin
 * 挂载、ppt-master 相同：skills 目录缺失时它们同样已经坏了。
 *
 * 每次调用都重读、不做模块级缓存：调用频率是「每次 spawn / 每次 grounding 补偿」
 * 量级，几 KB 的同步读开销可忽略；换来 dev 改模板即时生效。
 */
export function loadAppendTemplate(): string {
  const skillsDir = resolveBundledSkillsPluginDir()
  if (!skillsDir) {
    throw new Error(
      '写方案提示词模板不可用：找不到 skills 插件目录（.claude-plugin/plugin.json 缺失）'
    )
  }
  const path = join(skillsDir, 'proposal-writer', 'references', 'append-template.md')
  if (!existsSync(path)) {
    throw new Error(`写方案提示词模板不可用：${path} 不存在`)
  }
  const raw = readFileSync(path, 'utf8')
  // 模板文件末尾按 POSIX 惯例带一个换行，而旧实现 join('\n') 无尾换行——剥掉这
  // 一个字节以维持「渲染输出与旧实现逐字节一致」的快照不变量。只剥一个、不用
  // trimEnd：trimEnd 会连模板刻意保留的尾部空白一起吃掉。
  const template = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  // 在读入口校验、不在渲染后校验：渲染后模板里已经替换进了 KB_SCOPE 等运行期
  // 值，值里（比如 KB 文件标题）合法出现 `{{` 会被误杀成「残缺占位符」；读入口
  // 校验的是模板原文，此时占位符还是 `{{NAME}}` 字面量，不会有这层污染。
  assertWellFormedPlaceholders(template)
  return template
}

/**
 * 校验模板里所有 `{{` 都开启一个良构占位符（{{大写字母/数字/下划线}}）。
 * renderPromptTemplate 对「良构但未知」的占位符会抛错，但小写/残缺的写法
 * （{{kb_scope}}、{{X}）根本匹配不上正则、会静默漏进 prompt——契约测试守得住
 * 已提交的模板，守不住运行期直接改坏文件（loadAppendTemplate 每次重读、改动
 * 即生效）。这里把 fail-fast 延伸到运行期编辑场景：宁可当轮发送失败，也不让
 * 残缺占位符污染注入 AI 的写作纪律。
 */
export function assertWellFormedPlaceholders(template: string): void {
  const malformed = template.match(/\{\{(?![A-Z0-9_]+\}\})[^\n]{0,24}/)
  if (malformed) {
    throw new Error(`提示词模板含残缺占位符（应为 {{大写下划线}} 形态）：「${malformed[0]}…」`)
  }
}

/**
 * 极简占位符渲染：`{{NAME}}` → values[NAME]。用函数替换器有两层含义：
 * ① 值里出现 `$&` 等 String.replace 特殊序列时不被二次解释；
 * ② 值本身不会被再次扫描占位符（replace 语义如此）——KB 文件名里就算出现
 *   `{{...}}` 也只会原样落地，不存在注入放大。
 * 未知占位符抛错而不是留空：模板拼错字必须在测试期炸出来，不能静默漏进 prompt。
 */
export function renderPromptTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, name: string) => {
    const v = values[name]
    if (v === undefined) {
      throw new Error(`提示词模板占位符缺渲染值：{{${name}}}（检查模板与 buildProposalAppend 的 values 是否同步）`)
    }
    return v
  })
}

/**
 * 方案写作模式的系统提示词追加段（main-process side）。
 *
 * 底线：只用知识库、绝不臆想。这段文字会在「方案模式」的会话里拼到现有
 * 中文回复指令之后，作为 `systemPrompt.append` 的尾部传给 fusion-code 子进程。
 *
 * 为什么是「告知绝对路径 + 扩大可读范围」而不是改 cwd：
 *   会话的 cwd（engine.workspaceDir）是用户拖入的工作目录，在子进程 spawn 时
 *   烘焙、整个生命周期不可变（见 engine.ts 的不变量注释）。知识库镜像目录
 *   （userData/kb-index）不在 cwd 之下，所以我们走两条路让 AI 读到它：
 *     1. 把 mirrorDir 加进 SDK 的 `additionalDirectories`（扩大可读范围）；
 *     2. 在这段提示词里把 mirrorDir 的绝对路径写死告诉 AI（告知去哪儿检索）。
 *   两者缺一不可：只加可读目录而不告知路径，AI 不知道去哪找；只告知路径而
 *   不加可读目录，工具调用会被权限层挡在 cwd 外。
 *
 * 内容是纯函数、无副作用：同一组 (mirrorDir, products) 永远产出 bit 一致的字符串
 * （products 由调用方从同一份索引快照构造，索引不变则清单不变），落在 prompt
 * 尾部不影响上游 cache_control 断点（与 openSession 里中文 append 同理）。
 *
 * 2026-07-03 skill 化：方法论文本外置到 skills/proposal-writer/references/
 * append-template.md（改文案只改 markdown），协议字样在模板里是 {{占位符}}、
 * 渲染值取自 shared/proposal.ts（改协议只改常量，模板自动跟随）。输出与外置前
 * 逐字节一致，由 proposalPrompt.snapshot.test.ts 把关。
 */
export function buildProposalAppend(mirrorDir: string, products: ProposalProductScope[] = []): string {
  return renderPromptTemplate(loadAppendTemplate(), {
    KB_SCOPE: renderScopeBlock(mirrorDir, products),
    COVER_BEGIN: PROPOSAL_DRAFT_BEGIN.cover,
    COVER_END: PROPOSAL_DRAFT_END.cover,
    TOC_BEGIN: PROPOSAL_DRAFT_BEGIN.toc,
    TOC_END: PROPOSAL_DRAFT_END.toc,
    CONTENT_BEGIN: PROPOSAL_DRAFT_BEGIN.content,
    CONTENT_END: PROPOSAL_DRAFT_END.content,
    GAP_PREFIX: PROPOSAL_GAP_PREFIX,
    COVER_CONFIRM_HEADER: PROPOSAL_COVER_CONFIRM_HEADER,
    TOC_CONFIRM_HEADER: PROPOSAL_TOC_CONFIRM_HEADER
  })
}

/**
 * 渲染 {{KB_SCOPE}}：知识库镜像路径 + 产品文件清单（运行期数据，留在 TS 侧）。
 * 两个分支的文案是旧实现 `scope` 变量的原文，一字未动。
 */
function renderScopeBlock(mirrorDir: string, products: ProposalProductScope[]): string {
  return products.length > 0
    ? `1. 公司知识库的文本镜像在目录：${mirrorDir}。本次用户要写的产品及其可用资料文件【已为你列好】如下——**优先直接 Read 下面列出的文件取原文，不要再用 Glob 探目录、也不必逐个 Grep 试探**：\n${products
        .map((p) => renderProductBlock(p))
        .join('\n')}\n撰写任何内容前，先在上面清单里按文件标题判断该读哪些，直接 Read 取原文；只有清单里找不到的内容，才用 Grep/Glob 在对应产品目录内补查。只依据检索到的原文撰写。`
    : `1. 公司知识库的文本镜像在目录：${mirrorDir}。用户会在对话里说明要写哪些产品；撰写任何内容前，先用 Grep/Glob 在该镜像目录内定位对应产品，再 Read 检索原文，只依据检索到的原文撰写。`
}

/**
 * 渲染单个产品的「目录 + 文件清单」小块。文件多于上限时截断并标注，提示 AI 用
 * Glob 自查剩余。files 为空（索引未建/未命中）时只给目录路径，附一句让 AI 自查。
 */
function renderProductBlock(p: ProposalProductScope): string {
  const head = `   ▸ ${p.productLine} / ${p.product}（目录：${p.dir}）`
  if (p.files.length === 0) {
    return `${head}\n     （该产品暂无可用文件清单，请用 Grep/Glob 在上面目录内检索）`
  }
  const shown = p.files.slice(0, MAX_FILES_PER_PRODUCT)
  const lines = shown.map((f) => {
    // fileHead：单个文件的行（区别于上面产品级的 head），避免同名遮蔽看混。
    const fileHead = `     - 《${f.title}》 → ${f.mirrorPath}`
    if (!f.assets || f.assets.length === 0) return fileHead
    const imgs = f.assets.slice(0, MAX_IMAGES_PER_FILE).map((a) => `         · 图：${a}`)
    if (f.assets.length > MAX_IMAGES_PER_FILE) {
      imgs.push(`         · …（共 ${f.assets.length} 张图，上面只列前 ${MAX_IMAGES_PER_FILE} 张）`)
    }
    // 文件行 + 其名下可用图，缩进区分层级，让 AI 一眼看到「这个文件配了哪些图」。
    return `${fileHead}\n${imgs.join('\n')}`
  })
  if (p.files.length > MAX_FILES_PER_PRODUCT) {
    lines.push(
      `     - …（共 ${p.files.length} 个文件，上面只列了前 ${MAX_FILES_PER_PRODUCT} 个，其余请用 Glob 在该目录内自查）`
    )
  }
  return `${head}\n${lines.join('\n')}`
}
