import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 「异步生成一帧预览」的公共生命周期。原本 WritingPreview / ProposalPreview 各抄了一份
 * 完全同源的实现，且其中四条机制都是踩了真 bug 才长出来的（两个文件的历史头注释记的是
 * 同一批事故）——留成两份拷贝意味着下次修第三个坑时极易只修一边。收在这里只剩一份：
 *
 *  1) **300ms 防抖**：内容成簇到来（一条消息 end 可能同时刷出多节 / 编辑态连续按键），
 *     合并成一帧再渲。**防抖窗口内不提前翻 loading**——否则成簇更新期间一直闪 spinner。
 *  2) **cancelled 闸门**：一次渲染要过多个 await，期间可能被更新的一帧取代。被取代的
 *     渲染整份丢弃，绝不触碰已经在显示的那一帧。
 *  3) **objectURL 原子替换**：换新 URL 前先 revoke 旧的，卸载时再兜一次，杜绝 blob 泄漏。
 *  4) **签名缓存**：签名没变就跳过重渲（来回切 tab 不重复生成）。
 *  5) **active 门控**：组件常驻但隐藏时（两个 DocPanel 都用 hidden 类而非条件卸载挂载
 *     预览，为的就是保住第 4 条的缓存）一律不空跑。
 *  6) **retry**：清掉缓存签名并自增 nonce，强制重跑一次同样的内容。
 *
 * 刻意**不**收进来的是「渲染管线」和「产出长什么样」——那两处两边真的不同（写作端微信体裁
 * 出内联 HTML、A4 体裁出 PDF；方案端要先把 mermaid 预渲成 PNG）。它们留在各自组件里，
 * 通过 render 回调注入。判据：只抽两边一模一样的部分，差异让调用方自己留着，否则这里会
 * 长成一片 `if (variant === …)` 的开关地狱。
 */

/** 预览的五个状态。ready 之后 frame 一定非 null。 */
export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

/**
 * 一帧渲染结果的最小约束。`objectUrl` 是本 hook 唯一认识、也唯一负责回收的字段——
 * 帧里其余内容（HTML 字符串、降级标记……）本 hook 一概不解释，原样交回调用方。
 * 不需要 objectURL 的帧（如内联 HTML）填 null，hook 会顺带把上一帧残留的 URL revoke 掉。
 */
export type PreviewFrame = { objectUrl?: string | null }

/** 防抖窗口：成簇变更通常间隔很短，300ms 足以等一簇落定。 */
const DEBOUNCE_MS = 300

export function usePreviewFrame<F extends PreviewFrame>({
  active,
  signature,
  render
}: {
  /** 当前是否真的在看这个预览。false 时一律不生成（组件常驻后台时不空跑）。 */
  active: boolean
  /**
   * 本帧内容的指纹。**值相同即跳过重渲**，故凡是会改变产出的输入都必须进签名
   * （方案端的样式模板、写作端的体裁）。`null` 表示「没有可预览的内容」→ empty 态。
   *
   * 调用方应当用 useMemo 算它：签名通常含整份 markdown，裸拼会在每次重渲时白复制一遍
   * 长字符串（原两份实现把拼接放在 effect 内部，天然只在触发时算一次，这里要靠 memo
   * 补回这个特性）。
   */
  signature: string | null
  /**
   * 真正的渲染管线，由调用方提供。`isCancelled()` 供长链路在每个 await 之后自查是否
   * 已被取代（可选——即便不查，hook 也会在拿到结果后把被取代的帧丢弃并回收其 objectURL）。
   */
  render: (isCancelled: () => boolean) => Promise<F>
}): {
  status: PreviewStatus
  errMsg: string
  /** 当前正在显示的那一帧。渲染新帧期间保持上一帧不变（配合第 1 条，不闪空白）。 */
  frame: F | null
  retry: () => void
} {
  const [status, setStatus] = useState<PreviewStatus>('idle')
  const [errMsg, setErrMsg] = useState('')
  const [frame, setFrame] = useState<F | null>(null)
  const [nonce, setNonce] = useState(0)
  // 上一次成功渲染的签名。
  const lastRendered = useRef<string | null>(null)
  // 当前 frame 持有的 objectURL。存 ref 而非只存 state，是为了在 revoke 时拿到确切的旧值。
  const urlRef = useRef<string | null>(null)

  // render 是调用方每次重渲都新建的闭包（捕获当帧的 markdown / 样式）。若把它写进下面
  // effect 的依赖数组，每次重渲都会重跑 effect → 死循环。存进 ref 只读最新一份：effect
  // 的触发权完全交给 signature，这正是「签名变了才重渲」这条语义应有的落点。
  const renderRef = useRef(render)
  renderRef.current = render

  const swapUrl = useCallback((next: string | null): void => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = next
  }, [])

  // 卸载时 revoke 残留 URL。
  useEffect(() => {
    return () => {
      swapUrl(null)
    }
  }, [swapUrl])

  useEffect(() => {
    if (!active) return
    if (signature === null) {
      lastRendered.current = null
      swapUrl(null)
      setFrame(null)
      setStatus('empty')
      return
    }
    if (signature === lastRendered.current) return

    let cancelled = false
    // 这之前不置 loading：保持上一帧（status 仍 ready），等内容落定后才翻 loading。
    const timer = window.setTimeout(() => {
      void (async () => {
        setStatus('loading')
        try {
          const next = await renderRef.current(() => cancelled)
          if (cancelled) {
            // 已被更新的一帧取代：整份丢弃。但若它已经建过 objectURL，必须在这里 revoke——
            // 否则这份 blob 谁都不指向、活到标签页关闭为止。原先两份实现靠「先查 cancelled
            // 再 createObjectURL」规避；抽成 hook 后 URL 的创建时机落在调用方的 render 内部，
            // 闸门只能后置，于是改成显式回收。
            if (next.objectUrl) URL.revokeObjectURL(next.objectUrl)
            return
          }
          swapUrl(next.objectUrl ?? null)
          setFrame(next)
          lastRendered.current = signature
          setStatus('ready')
        } catch (err) {
          if (cancelled) return
          setErrMsg(err instanceof Error ? err.message : String(err))
          setStatus('error')
        }
      })()
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [active, signature, nonce, swapUrl])

  const retry = useCallback((): void => {
    // 清掉缓存签名，否则 nonce 变了也会被「签名没变」那道闸拦下。
    lastRendered.current = null
    setNonce((n) => n + 1)
  }, [])

  return { status, errMsg, frame, retry }
}
