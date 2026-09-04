import type { ChatSendPayload } from '@desktop-shared/ipc-channels'

/**
 * 「回复中断 → 重试」的纯状态逻辑。
 *
 * 背景：主进程在网络断流 / 子进程崩溃 / 网关报错时只发一条 `{type:'error'}`，
 * 渲染层原本只把它落成消息级 status 渲染一张红卡片，用户想再来一次得把原话重打
 * 一遍（附件还得重挑）。这里把「最近一次发送的完整载荷」留在会话槽位里，出错时
 * 打个失败标记，Composer 顶部据此弹出重试条；重试 = 用原载荷原样再发一次。
 *
 * 为什么抽成纯函数而不直接写在 store 里：store（chat.ts）不在 bun test 的覆盖目录，
 * 而「什么时候该标记 / 重试要删哪条气泡」这几条判断恰好是最容易静默出错的地方
 * （删错气泡、没载荷也弹重试条）。放 src/chat/lib 才有测试兜底。
 *
 * 只关心槽位里这三个字段；泛型 S 让 store 的完整 PerSessionState 原样进出（不丢其余
 * 字段），消息只要求可选的 id（assistant-ui 的 ThreadMessageLike.id 是可选的）。
 */
export interface FailedTurnSlot {
  messages: { id?: string; content?: unknown }[]
  /** 最近一次 chatApi.send 的完整载荷（含图片 / 方案字段），null = 本会话还没发过。 */
  lastSentPayload: ChatSendPayload | null
  /** 最近一轮失败的 AI 消息 id 与错误文案，null = 没有待重试的失败。 */
  failedTurn: { messageId: string; error: string } | null
}

/**
 * 收到 error 事件时调用。没有可重发的载荷就不标记（比如刚 resume 一个会话、
 * 还没发过话就收到主进程的启动错误——那种情况重发也无从谈起，别弹一个空按钮）。
 * 同一条消息重复报错（SDK 的 assistant_error + result 二连）原地覆盖，不换引用。
 */
export function markTurnFailed<S extends FailedTurnSlot>(
  slot: S,
  messageId: string,
  error: string
): S {
  if (!slot.lastSentPayload) return slot
  const prev = slot.failedTurn
  if (prev && prev.messageId === messageId && prev.error === error) return slot
  return { ...slot, failedTurn: { messageId, error } }
}

/** 气泡里有没有已经跑过的工具调用（写文件、跑命令……这些副作用已经发生）。 */
function hasToolCalls(m: { content?: unknown }): boolean {
  return (
    Array.isArray(m.content) &&
    m.content.some((p) => typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'tool-call')
  )
}

/**
 * 用户点「重试」时调用：删掉那条失败的 AI 气泡（保留用户气泡，看起来是「同一句话
 * 再来一次」而不是重复刷屏）、清失败标记、交出原始载荷给发送管道。
 * 两个例外不删：① 失败气泡已经不在（切走再切回、历史从 JSONL 重载时它本就没落盘）；
 * ② 气泡里带工具调用——那些副作用（写文件 / 跑命令）已经真实发生，删掉卡片等于
 * 把发生过的事藏起来，重发后模型还可能再做一遍，用户必须看得见第一次做了什么。
 */
export function prepareRetry<S extends FailedTurnSlot>(
  slot: S
): { slot: S; payload: ChatSendPayload } | null {
  const { failedTurn, lastSentPayload } = slot
  if (!failedTurn || !lastSentPayload) return null
  const target = slot.messages.find((m) => m.id === failedTurn.messageId)
  const messages =
    target && !hasToolCalls(target)
      ? slot.messages.filter((m) => m.id !== failedTurn.messageId)
      : slot.messages
  return { slot: { ...slot, messages, failedTurn: null }, payload: lastSentPayload }
}
