'use client'

/**
 * chatApi 链路探针页 —— Phase 2 的第一步（技术风险验证）。
 *
 * 三层递进验证 studio tab 内的完整聊天链路：
 *   1. window.chatApi 是否被 preload 注入（= 跑在壳内的 studio tab 里）
 *   2. 只读 IPC：getWorkspace / listSessions（验证 event.sender.id →
 *      getContextForSender → 本 tab 专属 ChatEngine 的路由）
 *   3. 全链路：newSession → onEvent 订阅 → send → 流式 chunk 回显
 *      （首次 send 触发 engine 的 lazy spawn，真正拉起 fusion-code 子进程）
 *
 * 聊天 UI 正式迁入后此页保留作最小链路自检，坏了先看这里再查大 UI。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatEvent } from '@desktop-shared/types'

export default function ChatProbe() {
  // null = 检测中；false = 浏览器直开（无 preload）；true = 壳内
  const [hostReady, setHostReady] = useState<boolean | null>(null)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [threadCount, setThreadCount] = useState<number | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [reply, setReply] = useState('')
  const [status, setStatus] = useState('')
  const unsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const api = window.chatApi
    if (!api) {
      setHostReady(false)
      return
    }
    setHostReady(true)
    void api.getWorkspace().then((ws) => setWorkspace(ws.path))
    void api.listSessions().then((r) => setThreadCount(r.threads.length))
    return () => {
      unsubRef.current?.()
    }
  }, [])

  const send = useCallback(async () => {
    const api = window.chatApi
    const text = input.trim()
    if (!api || !text) return
    try {
      let sid = sessionId
      if (!sid) {
        setStatus('创建会话…')
        const res = await api.newSession()
        sid = res.sessionId
        setSessionId(sid)
      }
      setReply('')
      // 重发前先退掉旧订阅，避免同一条流被叠加两次。
      unsubRef.current?.()
      unsubRef.current = api.onEvent(sid, (event: ChatEvent) => {
        if (event.type === 'chunk') {
          setReply((prev) => prev + event.delta)
        } else if (event.type === 'end') {
          setStatus('✅ 全链路打通（IPC → engine → fusion-code → 流式回传）')
        } else if (event.type === 'error') {
          setStatus(`❌ engine 报错：${event.error}`)
        }
      })
      setStatus('已发送，等待流式回复（首次会 spawn fusion-code，稍慢）…')
      await api.send({ sessionId: sid, text })
    } catch (err) {
      setStatus(`❌ 调用失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [input, sessionId])

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-4 p-8">
      <h1 className="text-xl font-semibold">chatApi 链路探针</h1>

      <section className="flex flex-col gap-1 text-sm">
        <p>
          宿主检测：
          {hostReady === null && '检测中…'}
          {hostReady === true && '✅ window.chatApi 已注入（壳内 studio tab）'}
          {hostReady === false && '❌ 未注入 —— 这是浏览器直开，请从桌面壳的 Studio 入口访问'}
        </p>
        {hostReady && (
          <>
            <p>工作区：{workspace ?? '读取中…'}</p>
            <p>历史会话数：{threadCount ?? '读取中…'}</p>
            <p>探针会话：{sessionId ?? '（发送第一条消息时创建）'}</p>
          </>
        )}
      </section>

      {hostReady && (
        <section className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void send()
              }}
              placeholder="发一条测试消息（会真实调用 AI）"
            />
            <button
              className="rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
              onClick={() => void send()}
            >
              发送
            </button>
          </div>
          {status && <p className="text-xs opacity-70">{status}</p>}
          {reply && (
            <pre className="whitespace-pre-wrap rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
              {reply}
            </pre>
          )}
        </section>
      )}
    </main>
  )
}
