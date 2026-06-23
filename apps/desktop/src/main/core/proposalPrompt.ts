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
export function buildProposalAppend(mirrorDir: string): string {
  return [
    '【方案写作模式】你正在帮用户撰写商业建设方案。严格遵守以下纪律：',
    `1. 公司知识库的文本镜像在目录：${mirrorDir}。撰写任何内容前，先用 Grep/Glob/Read 在该目录内检索相关资料，只依据检索到的原文撰写。`,
    '2. 绝不使用你自身的知识或想象来填补内容。知识库里查不到的，明确写「⚠️ 资料缺失：<缺什么>」，不要编造。',
    '3. 每写完一段，标注来源文件，格式：（据《<文件名>》）。',
    '4. 按章节逐段推进，一次只聚焦一个章节，先问用户该章节的关键要点，再起草。',
    '5. 全程中文。'
  ].join('\n')
}
