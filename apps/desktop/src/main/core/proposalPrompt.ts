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
 * 内容是纯函数、无副作用：同一个 mirrorDir 永远产出 bit 一致的字符串，落在
 * prompt 尾部不影响上游 cache_control 断点（与 openSession 里中文 append 同理）。
 */
export function buildProposalAppend(mirrorDir: string, productDirs: string[] = []): string {
  const scope =
    productDirs.length > 0
      ? `1. 公司知识库的文本镜像在目录：${mirrorDir}。本次用户要写的产品资料分别在：\n${productDirs
          .map((d) => `   - ${d}`)
          .join('\n')}\n撰写任何内容前，先用 Grep/Glob/Read 优先在这些产品目录内检索，只依据检索到的原文撰写。`
      : `1. 公司知识库的文本镜像在目录：${mirrorDir}。用户会在对话里说明要写哪些产品；撰写任何内容前，先用 Grep/Glob 在该镜像目录内定位对应产品，再 Read 检索原文，只依据检索到的原文撰写。`
  return [
    '【方案写作模式】你正在帮用户撰写商业建设方案。严格遵守以下纪律：',
    scope,
    '2. 绝不使用你自身的知识或想象来填补内容。知识库里查不到的，明确写「⚠️ 资料缺失：<缺什么>」，不要编造。',
    '3. 每写完一段，标注来源文件，格式：（据《<文件名>》）。',
    '4. 用户会用自然语言告诉你内容分哪几部分、各部分写什么、哪部分要「一条条介绍」。严格按用户给的部分与顺序组织，不自行增删章节；标注「一条条介绍」「逐条」的部分要逐条列举（每条：小标题 + 该条内容 + 来源），不要并成一段。',
    '5. 一次聚焦一个部分，先问用户该部分的关键要点，再起草。',
    '6. 全程中文。'
  ].join('\n')
}
