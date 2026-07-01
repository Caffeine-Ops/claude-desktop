import { create } from 'zustand'
import {
  coerceProposalStyle,
  defaultProposalStyle,
  type ProposalStyleConfig
} from '@shared/proposalStyle'

/**
 * 方案 Word「样式模板」的渲染层状态。
 *
 * 这里只持有【已生效（committed）】的样式配置——导出弹窗（ProposalStyleModal）在本地
 * draft 上微调，点「导出」时才 setConfig 提交回来。编辑/预览面板（ProposalPreview）读
 * 本 store 的 committed 配置，故默认就是「经典正式」（DEFAULT_PROPOSAL_STYLE_KEY），
 * 一进来预览/导出即是好看的模板，而非 Word 裸默认。
 *
 * 跨会话持久化到 localStorage：用户选过的模板/微调下次启动仍在。方案草稿本身是会话级
 * （proposalStore.reset 会清），但样式偏好是跨文档的用户偏好，独立持久、不随 reset 清。
 */
// v2：标题层级字号档从 16/14/12 拉到 18/15/12（章节标题压不住满宽列表的观感修复，见
// proposalStyle 模板注释）。旧 v1 里若存过一份「默认 classic」，其 h1/h2 仍是旧的 16/14，coerce
// 只补缺字段、不会覆盖已存值，改模板常量对它无效。故升键：丢弃 v1 缓存、让所有人拿到新默认档位。
// 代价——曾在样式弹窗微调并应用过的用户，这些微调（字体/页边距等）会重置为新默认；权衡后取「保证
// 层级修复对所有人生效」。真需要旧微调可重新在弹窗里调一次。
const STORAGE_KEY = 'proposal-style-config-v2'

function loadPersisted(): ProposalStyleConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaultProposalStyle()
    // coerceProposalStyle 字段级补全：缺字段（旧 schema / 损坏）或非法枚举值逐项回退默认，
    // 绝不把半残配置 `as` 直用——否则缺 h1/margin/ol 会让 main 侧 docx 生成解引用 undefined
    // 抛错 / 产 NaN twips、导出 Word 直接失败（评审发现）。旧浅校验只看 templateKey/title/body。
    return coerceProposalStyle(JSON.parse(raw))
  } catch {
    // localStorage 不可用 / JSON 损坏 → 默认模板。
  }
  return defaultProposalStyle()
}

function persist(config: ProposalStyleConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // 持久化失败（隐私模式 / 配额）不致命：本次会话内存里仍生效。
  }
}

interface ProposalStyleState {
  config: ProposalStyleConfig
  /** 提交一份新的已生效配置（导出弹窗点「导出」/「应用」时调用），并持久化。 */
  setConfig: (config: ProposalStyleConfig) => void
}

export const useProposalStyleStore = create<ProposalStyleState>((set) => ({
  config: loadPersisted(),
  setConfig: (config) => {
    persist(config)
    set({ config })
  }
}))
