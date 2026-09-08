import { useEffect, useMemo, useRef } from 'react'

import { collectSessionOutputs } from '../../../lib/sessionImages'
import {
  feedClearFresh,
  feedOnEmptyCandidates,
  feedOnGenerated,
  feedOnStat
} from '../../../lib/sessionOutputsFeed'
import { useChatStore } from '../../../stores/chat'
import { useSessionOutputsStore } from '../../../stores/sessionOutputs'
import { DELIVERABLE_PATH_RE } from './AssistantMessage'

/**
 * 会话产出物数据泵——渲染 null、在 ThreadView 里挂载一次。
 *
 * 前台会话 messages → collectSessionOutputs 一趟扫出候选 + 生成图判定 →
 * 候选变了就 statFiles 核实一批 → 结果经 lib/sessionOutputsFeed 的 reducer
 * 写进 useSessionOutputsStore。三条语义（基线何时登记 / 全新会话提前登记
 * 空基线 / fresh 与 images 不同拍时挂起）全在 reducer 里，这里只管接线。
 *
 * 为什么是独立的空组件而不是在 ThreadView 里直接 useEffect：它订阅 messages
 * （流式期间每个 delta 都变），挂在 ThreadView 上会把整个大组件一起重渲染；
 * 单独一个 null 组件重渲染的代价是一次 useMemo 扫描，别的什么都不动。
 */
export function SessionOutputsFeed(): null {
  const sessionId = useChatStore((s) => s.sessionId)
  const messages = useChatStore((s) => s.messages)
  const scan = useMemo(() => collectSessionOutputs(messages, DELIVERABLE_PATH_RE), [messages])
  // key 里带上「该路径被生成调用输出了几次」：同路径 --force 覆盖重生成时
  // 路径集合不变，靠这个计数让 key 变化、触发重新 stat（reducer 再按 mtime
  // 判出新版本）。发给 statFiles 的仍是纯路径列表。
  const candidatesKey = scan.candidates
    .map((p) => `${p}#${scan.emissions.get(p) ?? 0}`)
    .join('\n')
  const candidatePaths = scan.candidates
  // generated 走 ref 给 stat 回调用最新值；单独一个 effect 处理「generated 变了
  // 但候选没变」（路径先以正文出现、Bash 调用后来才 settled）——这时不会再
  // stat，images 要靠 feedOnGenerated 重算。
  const generatedRef = useRef(scan.generated)
  generatedRef.current = scan.generated
  const generatedKey = [...scan.generated].join('\n')

  useEffect(() => {
    if (!candidatesKey) {
      useSessionOutputsStore.setState((s) => feedOnEmptyCandidates(s, sessionId))
      return
    }
    let cancelled = false
    void window.chatApi
      .statFiles({ paths: candidatePaths })
      .then((r) => {
        if (cancelled) return
        useSessionOutputsStore.setState((s) =>
          feedOnStat(s, sessionId, r.infos, generatedRef.current)
        )
      })
      .catch(() => {
        /* transient IPC failure — keep the previous snapshot */
      })
    return () => {
      cancelled = true
    }
    // candidatePaths 由 candidatesKey 完全决定，不单独进依赖。
  }, [candidatesKey, sessionId])

  useEffect(() => {
    useSessionOutputsStore.setState((s) => feedOnGenerated(s, generatedRef.current))
  }, [generatedKey])

  // "刚新增"标记只活 2.6s（陪着行入场的强调条 + 触发按钮的提示环一起播完），
  // 到点自动清空——不清的话下一次任意重渲染都会把这批路径继续当"新"的。
  const freshlyAdded = useSessionOutputsStore((s) => s.freshlyAdded)
  useEffect(() => {
    if (freshlyAdded.size === 0) return
    const timer = window.setTimeout(
      () => useSessionOutputsStore.setState(feedClearFresh),
      2600
    )
    return () => window.clearTimeout(timer)
  }, [freshlyAdded])

  return null
}
