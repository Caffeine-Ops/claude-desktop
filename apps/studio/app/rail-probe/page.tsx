'use client'

/**
 * 临时验证页（verify skill 用，验证后删）：给 RailSessionList 注入假的
 * window.tabApi/chatApi，绕过「无 chatApi 渲染为空」守卫，让会话行真实
 * 渲染出来，以便点开 ··· 菜单验证重命名 Dialog / 删除 AlertDialog。
 */
import { useEffect, useState } from 'react'
import { RailSessionList } from '@/src/components/RailSessionList'

const FAKE = [
  { id: 's1', title: '纯白色纸张破洞视觉稿', updatedAt: Date.now() - 3600_000, turnCount: 4, firstPrompt: '纯白色纸张破洞视觉稿' },
  { id: 's2', title: '明天天气怎么样', updatedAt: Date.now() - 7200_000, turnCount: 2, firstPrompt: '明天天气怎么样' },
  { id: 's3', title: '电脑桌面整理脚本', updatedAt: Date.now() - 46800_000, turnCount: 6, firstPrompt: '电脑桌面整理脚本' },
]

export default function RailProbe() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const w = window as any
    w.chatApi = {
      onShellSessionSwitch: () => () => {},
    }
    w.tabApi = {
      listShellSessions: () => Promise.resolve({ threads: FAKE }),
      onShellSessionListChanged: () => () => {},
      switchShellSession: () => Promise.resolve(),
      renameShellSession: (a: any) => { console.log('[probe] rename', a); return Promise.resolve() },
      deleteShellSession: (a: any) => { console.log('[probe] delete', a); return Promise.resolve() },
    }
    setReady(true)
  }, [])
  if (!ready) return <div>loading probe…</div>
  return (
    <div style={{ width: 280, height: '100vh', borderRight: '1px solid #ddd', padding: 8 }} className="chat-app">
      <RailSessionList />
    </div>
  )
}
