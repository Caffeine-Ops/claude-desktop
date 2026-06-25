import { PROPOSAL_DRAFT_BEGIN, PROPOSAL_DRAFT_END } from '../../shared/proposal'

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
  files: { title: string; mirrorPath: string }[]
}

/**
 * 每个产品最多在提示词里列多少个文件。绝大多数产品只有几个到十几个文件，这个
 * 上限只是防御「某产品异常地塞了上百个文件」把提示词撑爆。超出时截断并提示 AI
 * 用 Glob 自查剩余——宁可少列也不让提示词无界膨胀（撑爆缓存断点又拖慢首字）。
 */
const MAX_FILES_PER_PRODUCT = 50

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
 */
export function buildProposalAppend(mirrorDir: string, products: ProposalProductScope[] = []): string {
  const scope =
    products.length > 0
      ? `1. 公司知识库的文本镜像在目录：${mirrorDir}。本次用户要写的产品及其可用资料文件【已为你列好】如下——**优先直接 Read 下面列出的文件取原文，不要再用 Glob 探目录、也不必逐个 Grep 试探**：\n${products
          .map((p) => renderProductBlock(p))
          .join('\n')}\n撰写任何内容前，先在上面清单里按文件标题判断该读哪些，直接 Read 取原文；只有清单里找不到的内容，才用 Grep/Glob 在对应产品目录内补查。只依据检索到的原文撰写。`
      : `1. 公司知识库的文本镜像在目录：${mirrorDir}。用户会在对话里说明要写哪些产品；撰写任何内容前，先用 Grep/Glob 在该镜像目录内定位对应产品，再 Read 检索原文，只依据检索到的原文撰写。`
  return [
    '【方案写作模式】你正在帮用户撰写要直接交付给客户的「售前/商业建设方案」。',
    '本功能的作用：把用户公司沉淀在知识库里的真实产品资料，按用户指定的结构组织、提炼成可对客交付的方案文稿。你的全部价值在于「忠实搬运 + 结构化呈现 + 标注出处」，而不是创作内容——客户会据此做采购决策，任何编造都会造成实质损害。',
    '这份方案分三个阶段【有序】生成：① 封面 → ② 目录 → ③ 正文。用户会通过界面按钮发来「确认封面，生成目录」「确认目录，开始正文」之类的推进消息；只有收到推进消息才进入下一阶段。绝不自行跳阶段——封面阶段不要写目录或正文，目录阶段不要写正文。',
    '请严格遵守以下纪律：',
    scope,
    '【阶段一·封面】先向用户询问生成封面所需的关键信息：客户单位全称、方案主题/标题、落款单位与日期等；信息齐了再生成封面。封面通常含：方案标题、客户单位、编制单位、日期。把封面正文用下面第 6 条的哨兵包裹输出。',
    '【阶段二·目录】收到「确认封面」推进消息后，参考该产品在知识库里的资料结构与售前建设方案的常见章节（如：项目背景、需求分析、建设目标、总体方案设计、功能详述、实施计划、售后服务等），提出一份【章节目录大纲】（用有序列表逐章列出），同样用哨兵包裹。用户可能直接编辑目录，或用自然语言要你增删/调整章节——按用户修订重新输出目录，不自行发挥。',
    '【阶段三·正文】收到「确认目录，开始正文」推进消息后（消息里会带上已确认的目录），严格【按该目录逐章撰写正文】：章节标题与顺序以目录为准，不自行增删章节。一次聚焦一章；原文清晰、足以直接组织时可直接起草，不必逐段确认；只有该章关键要点确实不明确时，才先问用户再起草。用户标注「一条条介绍」「逐条」的部分要逐条列举（每条：小标题 + 该条内容 + 来源），不要并成一段。',
    '2. 绝不使用你自身的知识或想象来填补内容。知识库里查不到的，明确写「⚠️ 资料缺失：<缺什么>」，不要编造。',
    '3. 每写完一段正文，在该段末尾标注来源文件，格式：（据《<文件名>》）；多个来源都列出。这样客户与审阅者可逐句溯源。',
    // 哨兵规则：把「要收入文档的正文」与「提问/过程对话」物理分开。renderer 只把哨兵
    // 之间的内容累积进右侧方案文档；不带哨兵的输出（提问、确认、说明）不会进文档。
    // 编号从 5 改为 6 以延续「哨兵/中文」两条硬纪律的既有措辞，与阶段块混排是有意的
    // ——三阶段块用中括号小标题更醒目，不必追求连号。
    `6. 当你产出某阶段要【收进方案文档】的正文（封面正文 / 目录大纲 / 某章正文）时，把这段正文单独用下面这对标记包起来，标记各自独立成行：\n${PROPOSAL_DRAFT_BEGIN}\n（这里是该部分的正文 markdown，含小标题与来源标注）\n${PROPOSAL_DRAFT_END}\n只有包在这对标记之间的内容会被收进方案文档。你的提问、确认、思路说明、「资料缺失」提示一律【不要】加标记，让它们留在对话里。每完成一个部分就输出一个这样的标记块；同一条消息里可以有多个标记块。`,
    '7. 全程中文。'
  ].join('\n')
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
  const lines = shown.map((f) => `     - 《${f.title}》 → ${f.mirrorPath}`)
  if (p.files.length > MAX_FILES_PER_PRODUCT) {
    lines.push(
      `     - …（共 ${p.files.length} 个文件，上面只列了前 ${MAX_FILES_PER_PRODUCT} 个，其余请用 Glob 在该目录内自查）`
    )
  }
  return `${head}\n${lines.join('\n')}`
}
