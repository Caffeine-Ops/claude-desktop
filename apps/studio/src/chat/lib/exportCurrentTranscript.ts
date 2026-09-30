import { tStatic, useI18n } from '../i18n'
import { useChatStore } from '../stores/chat'
import { useSessionTitleStore } from '../stores/sessionTitle'
import { chatHeaderTitle } from './chatTitle'
import { buildTranscriptMarkdown, transcriptFilename } from './exportTranscript'

/**
 * 「导出当前对话为 Markdown」的**唯一写手**（2026-09-30 抽出）。
 *
 * 两个入口共用它：ThreadView 顶栏 ··· 菜单的「导出对话…」，和菜单栏的
 * ⇧⌘E（经 SHELL_MENU_ACTION → chat/App.tsx 分发）。抽出来的理由是它有
 * 三条各自踩过坑的纪律，复制一份就是复制三个未来的 bug：
 *
 *  1. **标题走 chatHeaderTitle 的 restTitle**，不是 store 里的原始 title。
 *     原始 title 含斜杠命令前缀和 @绝对路径，顶栏是拆开渲染的——直接拿
 *     原始值会让导出文件的标题长出屏幕上根本没有的东西（2026-09-28 实锤）。
 *  2. **messages 用 getState() 现读**，不订阅。顶栏只有 46px 高，订阅整棵
 *     消息树会让它随每个流式 chunk 重渲染。
 *  3. **三态处理**：成功 → Finder 定位；用户取消 → 静默；失败 → main 那边
 *     已经弹了原生错误框，这里只补一行日志。菜单和快捷键都没有可驻留的
 *     消息位，这正是错误框必须由 main 弹的原因（#68）。
 *
 * 没有会话 / 没有消息时**静默不做事**并返回 false：菜单项恒亮不灰化是
 * 本轮的已知取舍（见 shared/menuCommands.ts），空会话按 ⇧⌘E 不该弹一个
 * 空文件的保存框。
 *
 * @returns 是否真的走到了「弹保存框」这一步（供调用方记日志，不表示写盘成功）
 */
export function exportCurrentTranscript(): boolean {
  const { messages } = useChatStore.getState()
  if (messages.length === 0) {
    console.warn('[exportTranscript] 当前没有可导出的对话，忽略')
    return false
  }

  const { restTitle } = chatHeaderTitle(
    useSessionTitleStore.getState().title,
    tStatic('chatHeaderUntitled')
  )
  const lang = useI18n.getState().lang
  const at = new Date()

  const markdown = buildTranscriptMarkdown(messages, { title: restTitle, exportedAt: at, lang })

  void window.chatApi
    .exportTranscriptMd({
      markdown,
      defaultFilename: transcriptFilename(restTitle, at, lang)
    })
    .then((r) => {
      if (!r.ok) {
        console.warn('[exportTranscript] exportTranscriptMd failed:', r.error)
        return
      }
      if (r.path) void window.chatApi.revealPath({ absPath: r.path })
    })
    .catch((err: unknown) => console.warn('[exportTranscript] exportTranscriptMd error:', err))

  return true
}
