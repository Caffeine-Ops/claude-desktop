import { useEffect, useMemo, useRef } from 'react'
import hljs from 'highlight.js/lib/common'
import { X } from 'lucide-react'

import { useT } from '../../../i18n'
import {
  useActiveWorkflowRunId,
  useStreamingWorkflowArgsText,
  useStreamingWorkflowCallId,
  useToolCallTasks,
  useWorkflowScriptById
} from '../../../stores/chat'
import { parsePartialToolArgs } from '../../../stores/todos'
import { useWorkflowScriptPanelStore } from '../../../stores/workflowScript'
import { Button } from '@/src/components/ui/button'
import { escapeHtml } from './codeViewUtils'
import { WorkflowTaskList } from './WorkflowTaskTree'

/* ───────────────── Workflow script panel (left pane) ───────────────── */

/**
 * 右侧 Workflow 编排面板：AI 生成 Workflow tool call 的 `script` 参数时，
 * 这里实时铺开完整脚本（语法高亮 + 跟底滚动），替代 tool card 里那坨
 * 转义 JSON 的阅读体验；脚本定稿、workflow 开跑后面板不收——切到任务
 * 视图（与工具卡片同源的 per-agent 实时树，见 WorkflowTaskTree），直到
 * 全部 agent 终态才自动退出。完整生命周期：
 *
 *   1. 自动弹出（写脚本）—— 前台会话有 still-streaming 的 Workflow 调用
 *      (useStreamingWorkflowCallId)：面板出现，脚本随 delta 逐行长出。
 *   2. 保持打开（跑任务）—— args 定稿后流式信号消失，但该调用 spawn 的
 *      run 还在飞 (useActiveWorkflowRunId)：任务树顶到面板上半区实时
 *      跳动，脚本沉到下半区。
 *   3. 自动退出 —— 全部 agent 终态，面板收起。任一自动阶段用户点 ✕ =
 *      对这个 toolCallId 投否决票（dismissAuto），同一调用不再自动弹。
 *   4. 手动重开 —— ToolCallCard 里 Workflow 卡片的脚本入口
 *      (openManual) 按 toolCallId 捞 settled script + 最终任务树展示。
 *
 * 布局与 slides/proposal 分栏完全同构：chat 列收窄成持久化的
 * chatColWidth rail 在左，面板 flex-1 吃大头在右（代码要宽）。挂载与否
 * 由 ThreadView 决定（useWorkflowScriptPanelOpen），slides/proposal 分栏
 * 时禁用——右栏已被占用，三列太挤。
 */

/**
 * 从 script 源码里提取 meta.name 做面板标题的副标。流式早期 meta 块就
 * 在脚本开头，正则容忍单双引号；提不到就不显示（不猜）。
 */
function extractWorkflowName(script: string): string | null {
  const m = /name:\s*['"]([^'"]+)['"]/.exec(script)
  return m ? m[1]! : null
}

/**
 * 流式半开 JSON → script 字段当前文本。argsText 形如
 * `{"script": "export const meta = {\n  na…`（值还没闭合），交给
 * parsePartialToolArgs 闭合解析——它返回的对象里 script 已是反转义后的
 * 真实源码文本。解析失败（切在转义序列正中间等）返回 null，调用方沿用
 * 上一帧内容，画面不闪空。
 */
function scriptFromPartialArgs(argsText: string): string | null {
  const parsed = parsePartialToolArgs(argsText)
  if (parsed && typeof parsed === 'object') {
    const script = (parsed as Record<string, unknown>).script
    if (typeof script === 'string' && script.length > 0) return script
  }
  return null
}

/**
 * 面板该不该开 —— ThreadView 的分栏判定专用。刻意只订阅重渲染安全的
 * 信号：流式/运行中调用的 toolCallId（delta/tick 间恒定的原始值）、两个
 * 开关 id、settled script（引用稳定）。绝不碰 argsText——那是每 delta
 * 都变的文本，订了它整棵聊天列跟着每 delta 重渲染。
 *
 * 优先级与面板一致：写脚本中 > 任务运行中（均可被 ✕ 否决）> 手动打开。
 */
export function useWorkflowScriptPanelOpen(): boolean {
  const liveId = useStreamingWorkflowCallId()
  const runId = useActiveWorkflowRunId()
  const dismissedId = useWorkflowScriptPanelStore((s) => s.dismissedToolCallId)
  const manualId = useWorkflowScriptPanelStore((s) => s.manualToolCallId)
  const manualScript = useWorkflowScriptById(manualId)
  return (
    (liveId !== null && liveId !== dismissedId) ||
    (runId !== null && runId !== dismissedId) ||
    (manualId !== null && manualScript !== null)
  )
}

export function WorkflowScriptPanel(): React.JSX.Element | null {
  const t = useT()
  const liveId = useStreamingWorkflowCallId()
  const liveArgsText = useStreamingWorkflowArgsText()
  const runId = useActiveWorkflowRunId()
  const dismissedId = useWorkflowScriptPanelStore((s) => s.dismissedToolCallId)
  const manualId = useWorkflowScriptPanelStore((s) => s.manualToolCallId)
  const dismissAuto = useWorkflowScriptPanelStore((s) => s.dismissStreaming)
  const closeManual = useWorkflowScriptPanelStore((s) => s.closeManual)

  // 三个来源合成「面板正在展示哪个调用」。写脚本 > 跑任务 > 手动：AI 开
  // 写新脚本抢过画面（同 SlidesWorkspace 问题 tab 的自动聚焦逻辑）；写
  // 与跑同 id 时先走写分支，args 定稿自然滑入跑分支，画面无缝。
  const liveActive = liveId !== null && liveId !== dismissedId
  const runActive = !liveActive && runId !== null && runId !== dismissedId
  const shownId = liveActive ? liveId : runActive ? runId : manualId

  // settled 脚本（跑任务/手动两态）。写脚本态 args 未定稿查不到，传
  // null 省一趟 store walk。
  const settledScript = useWorkflowScriptById(liveActive ? null : shownId)
  // 该调用 spawn 的任务树——与工具卡片同一数据源（task_update 流）。
  const tasks = useToolCallTasks(shownId ?? undefined)

  // 流式半开 JSON 逐帧解析可能间歇失败（delta 切在转义序列正中间）；
  // ref 兜住上一帧成功值，失败帧沿用不闪空。新调用（id 变化）即作废。
  const lastGoodRef = useRef<{ id: string; script: string } | null>(null)
  let liveScript: string | null = null
  if (liveActive && liveArgsText !== null) {
    const parsed = scriptFromPartialArgs(liveArgsText)
    if (parsed !== null) {
      lastGoodRef.current = { id: liveId, script: parsed }
      liveScript = parsed
    } else if (lastGoodRef.current?.id === liveId) {
      liveScript = lastGoodRef.current.script
    }
  }

  // 流式早期 script 字段还没长出来时 script 为 null——面板照常挂载
  // （ThreadView 已分栏，空白列更糟），代码区显示等待态。跑任务态若
  // 调用是 scriptPath 形态（无内联脚本），任务树就是面板的全部内容。
  const streaming = liveActive
  const script = streaming ? liveScript : settledScript
  const visible =
    streaming || runActive || (manualId !== null && settledScript !== null)

  const name = useMemo(
    () => (script !== null ? extractWorkflowName(script) : null),
    [script]
  )

  // 语法高亮：脚本是纯 JS（Workflow 契约），语言写死不做探测（hljs 的
  // highlightAuto 是最贵路径，流式每 delta 一跑必卡，同 CodeFileView 的
  // detect:false 决策）。ignoreIllegals 让半截语句不炸高亮器。
  const { html, lineCount } = useMemo(() => {
    const text = script ?? ''
    let rendered: string
    try {
      rendered = hljs.highlight(text, {
        language: 'javascript',
        ignoreIllegals: true
      }).value
    } catch {
      rendered = escapeHtml(text)
    }
    return { html: rendered, lineCount: text.length === 0 ? 0 : text.split('\n').length }
  }, [script])

  // 流式跟底滚动：贴底时新行进来自动跟下去；用户往上滚（离底 >48px）即
  // 停手，交还阅读控制权——同聊天视口 autoScroll 的语义。atBottom 存
  // ref 不存 state（滚动事件高频，不值得重渲染）。
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  useEffect(() => {
    if (!streaming) return
    const el = scrollRef.current
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [script, streaming])

  if (!visible) return null

  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[4px] bg-card">
      {/* 顶栏 —— 46px 与 ChatHeader 同高同 hairline，分栏两根栏底边对齐
          成一条（同 SlidesWorkspace tab 栏的对齐纪律）。窗口拖拽由根
          layout 的 .window-drag-strip 统一负责（2026-07-08 收敛重构，
          见 globals.css），本栏不声明 drag；关闭按钮 no-drag 在 strip
          上挖洞。 */}
      <div className="flex h-[46px] shrink-0 select-none items-center gap-2 border-b border-border/55 px-3.5">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0 text-muted-foreground"
        >
          <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
        </svg>
        <span className="text-[13px] font-medium text-foreground">
          {t('workflowScriptPanelTitle')}
        </span>
        {name && (
          <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">
            {name}
          </span>
        )}
        {/* 状态区：写脚本=呼吸点+「正在编写」shimmer；跑任务=呼吸点+
            「正在执行」（done/total 计数在任务树自己的 header，不重复）；
            终态/手动=行数。 */}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11.5px] text-muted-foreground">
          {streaming || runActive ? (
            <>
              <span aria-hidden className="tc-breathe inline-block size-1.5 rounded-full bg-brand" />
              <span className="shimmer-text">
                {streaming ? t('workflowScriptWriting') : t('toolRunningHint')}
              </span>
            </>
          ) : (
            <span className="tabular-nums">
              {t('workflowScriptLines').replace('{count}', String(lineCount))}
            </span>
          )}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('workflowScriptClose')}
          className="size-7 shrink-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
          onClick={() => {
            // 自动阶段（写脚本/跑任务）关闭 = 否决该调用的后续自动展示；
            // 手动打开的直接清指针。
            if ((streaming || runActive) && shownId !== null) dismissAuto(shownId)
            else closeManual()
          }}
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* 任务区 —— 该调用 spawn 的 per-agent 实时树（与工具卡片同源，
          见 WorkflowTaskTree）。跑任务阶段是面板主角：占上半区自己滚动，
          脚本沉到下半区；无脚本（scriptPath 形态）时独占全高。 */}
      {tasks.length > 0 && (
        <div
          data-selectable="true"
          className={
            script !== null
              ? 'max-h-[55%] shrink-0 overflow-y-auto border-b border-border/55 px-4 py-3'
              : 'min-h-0 flex-1 overflow-y-auto px-4 py-3'
          }
        >
          <WorkflowTaskList tasks={tasks} />
        </div>
      )}

      {/* 代码区：行号 gutter + hljs 高亮，全高滚动（CodeFileView 的面板化
          变体——去掉 max-h 与渐隐 mask，面板自己就是阅读主体）。流式最
          早期 script 字段还没长出来（args 才写到 `{"scri`）→ 等待态；
          scriptPath 形态（无内联脚本）且任务树在场 → 上面的任务区独占，
          这里整个不渲染。 */}
      {script === null ? (
        tasks.length === 0 && (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12.5px] text-muted-foreground">
            <span aria-hidden className="tc-breathe inline-block size-1.5 rounded-full bg-brand" />
            <span className="tool-loading-dots">{t('workflowScriptPreparing')}</span>
          </div>
        )
      ) : (
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            atBottomRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}
          data-selectable="true"
          className="min-h-0 flex-1 overflow-auto"
        >
          <div className="flex min-w-fit font-mono text-[12px] leading-[1.6]">
            <pre
              aria-hidden
              className="sticky left-0 select-none whitespace-pre bg-card py-3 pl-4 pr-3 text-right tabular-nums text-muted-foreground/45"
            >
              {gutter}
            </pre>
            <pre
              className="flex-1 whitespace-pre py-3 pr-6 text-foreground/90 [font-feature-settings:'calt','tnum'] [hyphens:none]"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
