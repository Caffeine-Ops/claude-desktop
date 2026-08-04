/**
 * 「复制公众号 HTML」成功后的提示文案。拆成独立纯函数（而非内联在
 * `WritingDocPanel.copyWechat` 里）——组件文件不在 bun test 的三个覆盖目录
 * （electron/、src/chat/lib、src/chat/composer）内，inline 在组件里的逻辑永远测不到，
 * 而这条文案恰恰是终审 #4 要钉住的行为，必须能被测试独立验证。
 *
 * 【终审 #4：为什么原来的「已复制，可粘贴进公众号编辑器」是个坑】
 * `markdownToWechatHtml` 对正文里的 `![图说](../images/x.png)` 输出
 * `<img src="../images/gen-….png">`——`src` 原样保留正文里写的相对路径，这是 Task 6
 * 的既定设计（不改）。但 `copyWechat` 写进剪贴板的 text/html flavor 没有 base URL，
 * 公众号编辑器解析不到这个相对路径，粘贴后图片会被静默丢弃——用户拿到的绿色成功提示
 * 与实际结果（图全部丢失）完全对不上。公众号导出只对 `genre === 'wechat'` 开放，而
 * 微信文案正是本功能配图的主场景，这不是边角情况。
 *
 * 裁定只做最小收口：不做「内联 data: URI」也不移植 `export.py` 的 `copy_images`
 * （那是单独立项的事），只把提示文案从「掩盖问题的成功态」降级成「如实的已知限制」——
 * 目的是把静默错误变成用户看得见、能采取行动（去编辑器里手动传图）的已知限制。
 *
 * 样式回退（`styleFallback`）与配图丢失是两件独立的事，都可能同时发生——用一个数组
 * 收集全部提示语，都发生时拼在一句里，不让后出现的分支覆盖掉先出现的提示。
 */

/** 数一份 markdown 里 `![...](...)`（图片语法）出现的次数。
 *
 * 与 `electron/shared/proposal.ts` 的 `IMAGE_RE`（`/!\[([^\]]*)\]\(([^)]+)\)/g`）同一套
 * 取舍：不做 markdown AST 解析，图片语法足够简单、正则够用。这里没有直接 import 那份——
 * 它未导出，且「提案功能行为逐字不变」的红线不允许为了给写作复用而改动 proposal.ts。 */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/g

export function countMarkdownImages(markdown: string): number {
  return (markdown.match(MARKDOWN_IMAGE_RE) ?? []).length
}

export interface WechatCopyMsg {
  tone: 'ok' | 'muted'
  text: string
}

/**
 * @param markdown 已经喂给 `markdownToWechatHtml` 的那份正文——用来数配图张数。
 * @param styleFallback IPC 回的 `writingWechatHtml` 结果里的同名字段：样式文件没找到、
 *   用了内置兜底样式。
 */
export function buildWechatCopyMsg(markdown: string, styleFallback: boolean): WechatCopyMsg {
  const imageCount = countMarkdownImages(markdown)
  if (imageCount === 0) {
    // 没有配图：不受本次修复影响的分支，原样保留两条既有文案（终审只收口「有配图却
    // 静默丢失」这一种情况，别的分支不动，改动面越小越不容易引入新的回归）。
    return styleFallback
      ? { tone: 'muted', text: '已复制（样式文件未找到，用了内置样式）' }
      : { tone: 'ok', text: '已复制，可粘贴进公众号编辑器' }
  }
  const imageNote = `文中 ${imageCount} 张配图需要在编辑器里手动上传（相对路径粘贴后不显示）`
  const text = styleFallback
    ? `已复制（样式文件未找到，用了内置样式）；${imageNote}`
    : `已复制；${imageNote}`
  return { tone: 'muted', text }
}
