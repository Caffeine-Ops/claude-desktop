// MVP 写死一套通用建设方案骨架。进阶再按产品线分化/做成可配置。
export interface ProposalTemplate {
  key: string
  title: string
  sections: string[]
}

export const PROPOSAL_TEMPLATE: ProposalTemplate = {
  key: 'construction',
  title: '建设方案',
  sections: ['建设背景', '需求与现状分析', '系统目标与定位', '总体方案与架构', '系统功能', '建设价值与成效']
}
