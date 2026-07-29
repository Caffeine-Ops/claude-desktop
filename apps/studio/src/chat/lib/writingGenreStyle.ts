import type { WritingGenre } from '@desktop-shared/writing'
import type { ProposalStyleConfig } from '@desktop-shared/proposalStyle'
import { cloneProposalStyle } from '@desktop-shared/proposalStyle'

/**
 * 体裁 → 导出/打印样式。基于 proposal 的 classic 模板改几个字段——**不新造一套样式体系**：
 * docx 生成器（markdownToDocxBuffer）只认 ProposalStyleConfig，另起炉灶等于把整条导出链重写。
 *
 * 一律 `brand: false`：品牌横幅是方案交付物的身份标识，用户自己的小说/周报印上去是错的。
 * 第一版不做样式弹窗（见 spec「明确不做」），四个预设即全部可选项。
 */
export function writingStyleFor(genre: WritingGenre): ProposalStyleConfig {
  const s = cloneProposalStyle('classic')
  s.brand = false
  switch (genre) {
    case 'short-story':
      s.name = '小说'
      s.body.font = '宋体'
      s.body.indentChars = 2
      s.lineMultiple = 1.5
      // 段后 0：中文小说靠首行缩进分段，再加段后距会松散成散文集。
      s.spaceAfterPt = 0
      break
    case 'article':
      s.name = '文章'
      s.body.font = '宋体'
      s.body.indentChars = 0
      s.lineMultiple = 1.6
      s.spaceAfterPt = 8
      break
    case 'workplace':
      s.name = '职场文档'
      s.body.font = '仿宋'
      s.body.indentChars = 0
      s.h1.font = '黑体'
      s.h2.font = '黑体'
      s.h3.font = '黑体'
      s.lineMultiple = 1.5
      s.spaceAfterPt = 6
      break
    case 'wechat':
      // 微信文案的正常出口是公众号 HTML，不是 Word。这套预设仅在用户仍点了「导出 Word」时兜底。
      s.name = '微信文案'
      s.body.font = '微软雅黑'
      s.body.indentChars = 0
      s.lineMultiple = 1.75
      s.spaceAfterPt = 10
      break
  }
  return s
}

/**
 * 体裁 → 纸面皮肤的 Tailwind 类串。屏显的观感与导出预设对齐（缩进、行距、字体家族），
 * 但不追求逐像素一致——那是「打印预览」tab 的职责，它渲染的是真 PDF。
 */
export function paperSkinClass(genre: WritingGenre): string {
  switch (genre) {
    case 'wechat':
      // 375px 手机宽 + 微信读感的行距
      return 'mx-auto w-[375px] px-4 py-6 text-[15px] leading-[1.75] font-sans'
    case 'short-story':
      return 'mx-auto w-[min(46rem,100%)] px-10 py-12 text-[15px] leading-[1.8] font-serif [&_p]:indent-[2em] [&_p]:my-0'
    case 'article':
      return 'mx-auto w-[min(46rem,100%)] px-10 py-12 text-[15px] leading-[1.7] font-serif [&_p]:my-3'
    case 'workplace':
      return 'mx-auto w-[min(46rem,100%)] px-10 py-12 text-[15px] leading-[1.6] [&_h1]:font-bold [&_h2]:font-bold [&_p]:my-2'
  }
}
