import { useChatStore } from '../stores/chat'
import { dispatchChatTurn } from './dispatchChatTurn'

/**
 * 从文件卡片的「添加到知识库」菜单项，程序化发起一条「把这个文件加进本地知识库」的对话。
 *
 * 为什么走对话而不是直接调 IPC：local-kb 的「读文件、写一句话概览、挑类别」由 agent 完成
 * （见 skills/local-kb/SKILL.md）——单文件添加要读内容，正是 agent 的活；应用侧的后台
 * 「更新知识库」（kbCatalogService，SDK 无头归类）只按文件名批量归类、不写概览，两条路
 * 互补。所以添加＝发一条 prompt 让 local-kb skill 接管：读这个文件 → 写一句概览 → 挑
 * 类别 → upsert 进 KB-INDEX.json（那份 json 就是知识库索引本身，schema 见
 * electron/shared/kbCatalog.ts）。
 *
 * 知识库是「一份全局 KB-INDEX.json 逐条 upsert」，不是「先选文件夹再扫」——所以这里只给
 * agent 这一个文件的绝对路径即可，它不需要"库根"。KB-INDEX.json 的位置由 skill 自己经
 * kbpath.mjs（读 main 注入的 CLAUDE_DESKTOP_KB_DIR）解析，前端不必知道。
 *
 * 复用 dispatchChatTurn（与 composer onNew / 方案阶段按钮同一条发送契约）：append 用户
 * 气泡 + 预翻转 spinner + chatApi.send + 失败兜底统一在一处。sessionId 取当前前台会话
 * （chat.sessionId）——文件卡片本就渲染在前台会话的消息流里，不存在会话漂移。
 */
export async function addFileToKb(absPath: string): Promise<void> {
  const chat = useChatStore.getState()
  const sid = chat.sessionId
  if (sid === null) {
    console.warn('[add-to-kb] 跳过：无前台会话')
    return
  }

  const name = absPath.split('/').pop() ?? absPath
  // 气泡显示给用户看的（自然语言）；prompt 是发给 agent 的指令（点名 skill + 给绝对路径）。
  // 两者分开：气泡友好，指令精确。
  const display = `把「${name}」添加到本地知识库`
  // 不点名具体索引文件：skill 自己按扩展名分流（图片 → KB-IMAGE-INDEX.json、
  // 其余 → KB-INDEX.json）并取对应域的类别集合，前端不重复这套判定。
  const prompt =
    `请用 local-kb 技能把这个文件添加到本地知识库：${absPath}\n` +
    `读取它的内容、写一句话概览、按 skill 规则选对应索引（文档/图片）和该域的类别` +
    `集合挑一个类别，upsert 进去，完成后告诉我该索引里现在有多少个文件。`

  await dispatchChatTurn({
    sessionId: sid,
    storeContent: [{ type: 'text', text: display }],
    logTag: '[add-to-kb]',
    payload: { sessionId: sid, text: prompt }
  })
}
