/**
 * 写作导出的默认文件名推导：取拼合后 markdown 第一个一级标题当默认名，取不到用「文稿」。
 *
 * 拆成独立纯函数（而非内联写在 WritingDocPanel.tsx 里）有两个理由：
 *  1) 可测——组件文件不在 bun test 的三个覆盖目录（electron/、src/chat/lib、src/chat/composer）内，
 *     inline 在组件里的逻辑永远测不到；这里单独落 src/chat/lib 就能补测试。
 *  2) `writingExport.ts`（main 侧）的 `sanitizeBaseName` 只负责净化文件名字符，不负责从 markdown
 *     里“取”标题——两件事职责不同，硬合一处会让净化函数也依赖 markdown 结构。
 *
 * 只认【文档级】一级标题——正则用 `m` 标志逐行匹配 `^#[ \t]+`，不管它在哪个体裁/哪一节里，
 * 因为 joinWritingSections 已经把全部节拼成一份完整 markdown，取"第一个"天然就是全篇的标题。
 *
 * **`#` 后必须用 `[ \t]+` 而不是 `\s+`**：`\s` 包含换行，若标题行 `#` 后只有空白就换行
 * （如 `'#    \n\n正文'`），`\s+` 会贪婪跨过空行把下一行「正文」吞进来当标题捕获组，
 * 而不是像预期那样捕获出一个空标题、触发「文稿」兜底——这是实现时被单元测试当场抓到的真实坑，
 * 不是纸上谈兵的边界情况。
 */
const H1_RE = /^#[ \t]+(.*)$/m

export function deriveWritingExportBaseName(markdown: string): string {
  const h1 = H1_RE.exec(markdown)?.[1]?.trim()
  return h1 && h1.length > 0 ? h1 : '文稿'
}
